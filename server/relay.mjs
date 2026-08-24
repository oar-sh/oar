/**
 * relay.mjs — standalone Copilot SDK relay
 *
 * Spawns its own Copilot CLI process, polls the web server for pending
 * messages, processes each with sendAndWait(), and posts responses back.
 * On Windows, foreground mode prefers a stable Windows Terminal window name so
 * repeated launches reuse the same visible window instead of creating new ones.
 *
 * Usage:
 *   node relay.mjs                        # hidden CLI subprocess (default off Windows)
 *   node relay.mjs --foreground           # visible terminal window
 *   node relay.mjs --hidden               # force hidden stdio fallback
 *   node relay.mjs --token <newtoken>     # override auth token
 */

import { fileURLToPath } from 'url';
import { createConnection } from 'net';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { resolveStartupWorkspaceRoot } from './workspace-root.mjs';
import { resolveInstalledCopilotPaths } from './copilot-sdk-runtime.mjs';
import { isLegacyRelayProviderType } from '../shared/provider-routing.mjs';
import {
  buildWindowsTerminalForegroundArgs,
  buildWindowsTerminalWindowName,
} from './windows-terminal-launcher.mjs';
import { isValidModelId, normalizeModelIdCandidate } from '../shared/model-id.mjs';
import {
  extractModelDescriptors,
  normalizeContextLimitTokens,
} from '../shared/model-descriptors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const FORCE_HIDDEN = args.includes('--hidden') || args.includes('--stdio');
const FOREGROUND = !FORCE_HIDDEN && (args.includes('--foreground') || process.platform === 'win32');
const VERBOSE = args.includes('--quiet') ? false : true;
const tokenArgIdx = args.indexOf('--token');
const TOKEN_OVERRIDE = tokenArgIdx !== -1 ? args[tokenArgIdx + 1] : null;
const portArgIdx = args.indexOf('--port');
const PORT_OVERRIDE = portArgIdx !== -1 ? args[portArgIdx + 1] : null;

// ─── Config ────────────────────────────────────────────────────────────────────
const configPath = process.env.COPILOT_WEB_RELAY_CONFIG
  ? path.resolve(String(process.env.COPILOT_WEB_RELAY_CONFIG))
  : path.join(__dirname, 'config.json');
function readConfig(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function parsePort(value, fallback = 3333) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

const config = readConfig(configPath);
const SERVER_PORT = parsePort(PORT_OVERRIDE, parsePort(config.port, 3333));
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const TOKEN = TOKEN_OVERRIDE || config.authToken || '';
const RUNTIME_SESSION_POLICY = 'conversation-bound';
const launchWorkspaceRoot = resolveStartupWorkspaceRoot(__dirname);

// ─── Copilot path auto-detection ─────────────────────────────────────────────
let installedCopilotPaths;
try {
  installedCopilotPaths = resolveInstalledCopilotPaths({ config });
} catch (error) {
  console.error(`[relay] ERROR ${error.message}`);
  process.exit(1);
}
const { sdkPath: SDK_PATH, cliPath: CLI_PATH } = installedCopilotPaths;
const NODE_PATH = process.env.COPILOT_WEB_RELAY_NODE || process.execPath;
const CLI_PORT  = config.cliPort || 4445;
const foregroundWindowName = buildWindowsTerminalWindowName(launchWorkspaceRoot);

function ts() {
  const now = new Date();
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('-');
}
function log(...a) { console.log(`[relay ${ts()}]`, ...a); }
function err(...a) { console.error(`[relay ${ts()}] ERROR`, ...a); }
function vlog(...a) { if (VERBOSE) log(...a); }

function logTextBlock(title, text) {
  if (!VERBOSE) return;
  const divider = '-'.repeat(26);
  console.log(`[relay ${ts()}] ${divider} ${title} ${divider}`);
  console.log(String(text || ''));
  console.log(`[relay ${ts()}] ${'-'.repeat(60)}`);
}

function escapeXmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildAttachmentSystemReminder(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  const lines = [
    '<system_reminder>',
    'Attached files:',
  ];
  for (let idx = 0; idx < attachments.length; idx++) {
    const att = attachments[idx];
    if (!att || typeof att !== 'object') continue;
    const name = escapeXmlText(String(att.name || '').trim() || `attachment-${idx + 1}`);
    const mime = escapeXmlText(String(att.type || '').trim() || 'application/octet-stream');
    const rawSize = Number(att.size);
    const size = Number.isFinite(rawSize) && rawSize >= 0 ? Math.round(rawSize) : 0;
    const filePath = String(att.path || '').trim();

    lines.push(`- File ${idx + 1}: "${name}"`);
    if (filePath) lines.push(`  Path: ${escapeXmlText(filePath)}`);
    lines.push(`  MIME: ${mime}`);
    lines.push(`  Size: ${size} bytes`);
  }
  lines.push('</system_reminder>');
  return lines.join('\n');
}

function redactAttachmentPathsFromPrompt(text) {
  return String(text || '').replace(/^(\s*Path:\s*).+$/gim, '$1[REDACTED_PATH]');
}

function buildPrompt(msg) {
  const text = String(msg?.text || '').trim();
  const attachmentPromptContext = String(msg?.attachmentPromptContext || '').trim();
  const attachments = Array.isArray(msg?.attachments) ? msg.attachments : [];
  if (!attachments.length) return text;
  const systemReminderBlock = attachmentPromptContext || buildAttachmentSystemReminder(attachments);
  if (text && systemReminderBlock) return `${text}\n\n${systemReminderBlock}`;
  return text || systemReminderBlock;
}

function extractBase64FromDataUrl(dataUrl) {
  const value = String(dataUrl || '').trim();
  if (!value.startsWith('data:')) return '';
  const commaIdx = value.indexOf(',');
  if (commaIdx < 0) return '';
  const metadata = value.slice(0, commaIdx).toLowerCase();
  if (!metadata.includes(';base64')) return '';
  return value.slice(commaIdx + 1).trim();
}

function buildSdkAttachments(msg) {
  const attachments = Array.isArray(msg?.attachments) ? msg.attachments : [];
  const out = [];
  for (const att of attachments) {
    if (!att || typeof att !== 'object') continue;
    const mimeType = String(att.type || '').trim().toLowerCase();
    if (!mimeType.startsWith('image/')) continue;
    const displayName = String(att.name || '').trim() || 'image';

    const filePath = String(att.path || '').trim();
    if (filePath) {
      out.push({
        type: 'file',
        path: filePath,
        displayName,
      });
      continue;
    }

    const data = extractBase64FromDataUrl(att.dataUrl);
    if (!data) continue;
    out.push({
      type: 'blob',
      data,
      mimeType,
      displayName,
    });
  }
  return out;
}

function collectTextCandidates(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) out.push(text);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextCandidates(item, out);
    return out;
  }
  if (typeof value === 'object') {
    collectTextCandidates(value.text, out);
    collectTextCandidates(value.content, out);
    collectTextCandidates(value.output_text, out);
    collectTextCandidates(value.outputText, out);
    collectTextCandidates(value.summary, out);
    collectTextCandidates(value.message, out);
    collectTextCandidates(value.result, out);
    collectTextCandidates(value.response, out);
    collectTextCandidates(value.output, out);
    collectTextCandidates(value.answer, out);
    collectTextCandidates(value.finalText, out);
    collectTextCandidates(value.final_text, out);
  }
  return out;
}

/**
 * Deep-scans a response envelope for a specific named tool call and returns a field from its input.
 * Used to extract `task_complete({ summary })` from the response when the agent ends via tool.
 */
function extractToolCallInput(value, toolName, field, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractToolCallInput(item, toolName, field, depth + 1);
      if (found) return found;
    }
    return null;
  }
  // Check if this node is the target tool call
  const name = value.name || value.tool || value.function_name || value.toolName || value.tool_name;
  if (name === toolName) {
    const input = value.input || value.arguments || value.params || value.args || {};
    if (input && typeof input === 'object') {
      const text = input[field];
      if (text && typeof text === 'string' && text.trim()) return text.trim();
    }
  }
  // Recurse into common envelope container keys only (avoids traversing arbitrary tool inputs)
  const CONTAINER_KEYS = ['data', 'output', 'content', 'tool_calls', 'calls', 'items',
                          'results', 'steps', 'turns', 'messages', 'events'];
  for (const key of CONTAINER_KEYS) {
    const child = value[key];
    if (child !== undefined && child !== null) {
      const found = extractToolCallInput(child, toolName, field, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractFinalText(finalEvent) {
  // task_complete({ summary }) is explicitly the agent's closing message — highest priority.
  const taskSummary = extractToolCallInput(finalEvent, 'task_complete', 'summary');
  if (taskSummary) return taskSummary;

  const candidates = [];
  collectTextCandidates(finalEvent?.data?.content, candidates);
  collectTextCandidates(finalEvent?.data?.text, candidates);
  collectTextCandidates(finalEvent?.data?.output_text, candidates);
  collectTextCandidates(finalEvent?.data?.outputText, candidates);
  collectTextCandidates(finalEvent?.data?.summary, candidates);
  collectTextCandidates(finalEvent?.data?.message, candidates);
  collectTextCandidates(finalEvent?.data?.result, candidates);
  collectTextCandidates(finalEvent?.data?.response, candidates);
  collectTextCandidates(finalEvent?.data?.output, candidates);
  collectTextCandidates(finalEvent?.data?.answer, candidates);
  collectTextCandidates(finalEvent?.data?.finalText, candidates);
  collectTextCandidates(finalEvent?.data?.final_text, candidates);
  collectTextCandidates(finalEvent?.content, candidates);
  collectTextCandidates(finalEvent?.text, candidates);
  collectTextCandidates(finalEvent?.output_text, candidates);
  collectTextCandidates(finalEvent?.outputText, candidates);
  collectTextCandidates(finalEvent?.summary, candidates);
  collectTextCandidates(finalEvent?.message, candidates);
  collectTextCandidates(finalEvent?.result, candidates);
  collectTextCandidates(finalEvent?.response, candidates);
  collectTextCandidates(finalEvent?.output, candidates);
  collectTextCandidates(finalEvent?.answer, candidates);
  collectTextCandidates(finalEvent?.finalText, candidates);
  collectTextCandidates(finalEvent?.final_text, candidates);
  return candidates.find((value) => typeof value === 'string' && value.trim()) || '';
}

function buildFallbackAssistantText(activityText = '') {
  const hint = String(activityText || '').trim();
  const parts = [
    "I couldn't capture a direct assistant reply, but the turn completed.",
    "This can happen when the answer is routed through a tool or sub-agent instead of the main text channel.",
  ];
  if (hint) parts.push(`Latest activity seen: ${hint}`);
  else parts.push("Ask again for a final summary if you want a cleaner reply.");
  return parts.join(' ');
}

async function apiJson(method, pathName, body = undefined, { auth = false, allow404 = false } = {}) {
  const started = Date.now();
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${SERVER_URL}${pathName}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    err(`HTTP ${method} ${pathName} failed after ${Date.now() - started}ms: ${e.message}`);
    throw e;
  }

  const elapsed = Date.now() - started;
  const isOk = response.ok || (allow404 && response.status === 404);
  vlog(`HTTP ${method} ${pathName} -> ${response.status} in ${elapsed}ms`);

  if (!isOk) {
    const errText = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} ${pathName} ${errText}`.trim());
  }

  return response.json();
}

// ─── Session Map ───────────────────────────────────────────────────────────────
// Keyed by conversation+model so each model can maintain its own session state.
const sessions = new Map();

let client = null;
let clientReady = false;
let lastModelSnapshotMs = 0;
const MODEL_SNAPSHOT_MIN_INTERVAL_MS = 30_000;
const cachedModelMetadataById = new Map();

const MODEL_ALIAS_CANDIDATES = {
  'sonnet-4.6': ['sonnet-4.6', 'claude-sonnet-4.6', 'claude-sonnet-4-6', 'anthropic/claude-sonnet-4.6'],
  'haiku-4.5': ['haiku-4.5', 'claude-haiku-4.5', 'claude-haiku-4-5', 'anthropic/claude-haiku-4.5'],
  'sonnet-4.5': ['sonnet-4.5', 'claude-sonnet-4.5', 'claude-sonnet-4-5', 'anthropic/claude-sonnet-4.5'],
  'gpt-5.4': ['gpt-5.4', 'openai/gpt-5.4'],
  'codex-5.3': ['codex-5.3', 'codex-5', 'gpt-codex-5', 'openai/codex-5.3'],
  'gpt-5.4-mini': ['gpt-5.4-mini', 'gpt-5-mini', 'openai/gpt-5.4-mini'],
};

// ─── Foreground CLI Window ─────────────────────────────────────────────────────
/**
 * Spawns the Copilot CLI in a visible terminal window using TCP server mode.
 * Returns { tcpConnectionToken } so the relay can connect via cliUrl.
 */
function waitForProcessSpawn(command, commandArgs, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, options);
    let settled = false;
    child.once('spawn', () => {
      settled = true;
      resolve(child);
    });
    child.once('error', (error) => {
      if (settled) return;
      reject(error);
    });
  });
}

async function spawnForegroundCliViaPowerShell(tcpConnectionToken, port) {
  const nodeArgs = [
    CLI_PATH,
    '--headless',
    '--no-auto-update',
    '--log-level', 'debug',
    '--port', String(port),
  ].join(' ');

  const psCommand = `$env:COPILOT_CONNECTION_TOKEN='${tcpConnectionToken}'; & '${NODE_PATH}' ${nodeArgs}`;
  const child = await waitForProcessSpawn('powershell.exe', [
    '-NoExit',
    '-Command',
    psCommand,
  ], {
    detached: true,
    stdio: 'ignore',
    windowStyle: 'Normal',
  });
  child.unref?.();
  return child;
}

async function spawnForegroundCli() {
  const tcpConnectionToken = randomUUID();
  const port = CLI_PORT;

  if (process.platform === 'win32') {
    const wtArgs = buildWindowsTerminalForegroundArgs({
      workspaceRoot: launchWorkspaceRoot,
      windowName: foregroundWindowName,
      title: 'Copilot Relay',
      commandPath: NODE_PATH,
      commandArgs: [
        CLI_PATH,
        '--headless',
        '--no-auto-update',
        '--log-level', 'debug',
        '--port', String(port),
      ],
    });

    try {
      log(`Spawning visible CLI in Windows Terminal window ${foregroundWindowName} on port ${port}...`);
      const child = await waitForProcessSpawn('wt.exe', wtArgs, {
        cwd: launchWorkspaceRoot,
        env: {
          ...process.env,
          COPILOT_WORKSPACE_ROOT: launchWorkspaceRoot,
          COPILOT_CONNECTION_TOKEN: tcpConnectionToken,
        },
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref?.();
    } catch (error) {
      log(`Windows Terminal launch failed (${error?.message || String(error)}); falling back to PowerShell window`);
      await spawnForegroundCliViaPowerShell(tcpConnectionToken, port);
    }
  } else {
    throw new Error(
      'Foreground CLI spawn is currently Windows-only in standalone relay mode. '
      + 'Use hidden mode (default) on Linux/macOS.'
    );
  }

  // Wait up to 20s for the CLI to open its TCP port
  log(`Waiting for CLI to listen on port ${port}...`);
  const ready = await waitForPort(port, 20_000);
  if (!ready) throw new Error(`CLI did not open port ${port} within 20s`);

  log(`CLI is listening on port ${port} ✓`);
  return { tcpConnectionToken, port };
}

function waitForPort(port, timeoutMs) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    function attempt() {
      const sock = createConnection({ port, host: '127.0.0.1' });
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(attempt, 500);
      });
    }
    attempt();
  });
}

export function buildCopilotClientOptions({
  foreground = false,
  tcpInfo = null,
  cliPath = CLI_PATH,
  launchRoot = launchWorkspaceRoot,
} = {}) {
  if (foreground && tcpInfo) {
    return {
      connection: {
        kind: 'uri',
        url: `localhost:${tcpInfo.port}`,
        connectionToken: tcpInfo.tcpConnectionToken,
      },
    };
  }

  return {
    connection: {
      kind: 'stdio',
      path: cliPath,
    },
    useLoggedInUser: true,
    logLevel: 'debug',
    workingDirectory: launchRoot,
  };
}

// ─── Client Init ──────────────────────────────────────────────────────────────
async function initClient(CopilotClient) {
  log('Initialising Copilot SDK client...');

  let clientOptions;

  if (FOREGROUND) {
    let tcpInfo;
    try {
      tcpInfo = await spawnForegroundCli();
    } catch (e) {
      err(`Foreground CLI failed (${e.message}), falling back to hidden mode`);
    }

    if (tcpInfo) {
      clientOptions = buildCopilotClientOptions({ foreground: true, tcpInfo });
      log(`Connecting to foreground CLI at localhost:${tcpInfo.port}`);
    }
  }

  // Default: hidden subprocess via stdio
  if (!clientOptions) {
    clientOptions = buildCopilotClientOptions();
    if (FOREGROUND) log('Using hidden CLI (foreground spawn failed)');
  }

  vlog('Copilot client options:', {
    mode: clientOptions.connection?.kind === 'uri' ? 'foreground-tcp' : 'hidden-stdio',
    logLevel: clientOptions.logLevel || 'n/a',
    cwd: clientOptions.workingDirectory || launchWorkspaceRoot,
  });

  client = new CopilotClient(clientOptions);
  await client.start();
  clientReady = true;
  log(`Copilot SDK client ready ✓  (mode: ${FOREGROUND && clientOptions.connection?.kind === 'uri' ? 'foreground TCP' : 'hidden stdio'})`);
}

function sessionKey(runtimeSessionId, convId) {
  const runtime = String(runtimeSessionId || '').trim();
  if (runtime) return runtime;
  const conversation = String(convId || '').trim();
  if (!conversation) return '__fallback__';
  return `conv:${conversation}`;
}

async function getOrCreateSession(runtimeSessionId, convId, requestedModel, approveAll) {
  const key = sessionKey(runtimeSessionId, convId);
  if (sessions.has(key)) {
    return sessions.get(key);
  }

  const targetModel = String(requestedModel || config.model || '').trim();
  log(`Creating new session for conversation ${String(convId || 'unknown').slice(0, 8)} runtime=${key.slice(0, 12)}${targetModel ? ` model=${targetModel}` : ''}...`);

  const sessionConfig = {
    onPermissionRequest: approveAll,
    // Dispatch ask_user calls to the per-turn handler registered in processNext.
    onUserInputRequest: (request) => {
      if (!activeUserInputHandler) throw new Error('ask_user called but no handler is active for this turn');
      return activeUserInputHandler(request);
    },
  };
  if (targetModel) sessionConfig.model = targetModel;
  const session = await client.createSession(sessionConfig);

  sessions.set(key, session);

  const actualModel = await getCurrentModelId(session);
  if (targetModel && actualModel && canonicalModelId(actualModel) !== canonicalModelId(targetModel)) {
    // A silent fallback here answers the turn with a model the user never
    // picked (and shows the requested one in the UI). Fail the turn instead;
    // the session must not be reused either, or every retry lands on it.
    sessions.delete(key);
    try {
      await session.dispose?.();
    } catch (_) {}
    throw new Error(`Copilot session started with model "${actualModel}" instead of requested "${targetModel}"; refusing to run the turn on a substituted model`);
  }

  log(`Session created: ${session.sessionId.slice(0, 8)} key=${key.slice(0, 12)}${actualModel ? ` model=${actualModel}` : ''}`);

  // Tell the server this SDK session is an execution vehicle for an existing
  // conversation, so the session-state import sweep does not resurrect it as
  // a stand-alone "shadow" conversation. Best effort: older servers without
  // the endpoint just 404.
  const linkedConversationId = String(convId || '').trim();
  if (linkedConversationId) {
    try {
      await apiJson('POST', '/api/relay-session-link', {
        conversationId: linkedConversationId,
        sdkSessionId: session.sessionId,
      }, { auth: true });
    } catch (e) {
      vlog(`relay-session-link report failed: ${e.message}`);
    }
  }
  return session;
}

function normalizeModelId(modelInfo) {
  if (!modelInfo) return null;
  if (typeof modelInfo === 'string') {
    const candidate = normalizeModelIdCandidate(modelInfo);
    return isValidModelId(candidate) ? candidate : null;
  }
  const candidate = normalizeModelIdCandidate(modelInfo.modelId || modelInfo.id || modelInfo.model || null);
  return isValidModelId(candidate) ? candidate : null;
}

function canonicalModelId(id) {
  return String(id || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function appendDescriptorsWithPriority(raw, found, priority) {
  const descriptors = [];
  extractModelDescriptors(raw, descriptors);
  for (const descriptor of descriptors) {
    found.push({ ...descriptor, __priority: priority });
  }
}

async function getAvailableModels(session) {
  const modelApi = session?.rpc?.model;
  const sendRequest = session?.connection?.sendRequest;
  if (!modelApi && typeof sendRequest !== 'function' && !client?.listModels) {
    if (!cachedModelMetadataById.size) return [];
    return [...cachedModelMetadataById.values()];
  }

  const found = [];
  if (typeof client?.listModels === 'function') {
    try {
      const raw = await client.listModels();
      appendDescriptorsWithPriority(raw, found, 4);
    } catch (_) {
      // Fall through to session-scoped model APIs.
    }
  }
  if (typeof sendRequest === 'function') {
    try {
      const raw = await sendRequest.call(session.connection, 'models.list', {});
      appendDescriptorsWithPriority(raw, found, 3);
    } catch (_) {
      // Ignore and try session-scoped listing.
    }
  }
  if (typeof modelApi?.list === 'function') {
    try {
      const raw = await modelApi.list.call(modelApi, { skipCache: true });
      appendDescriptorsWithPriority(raw, found, 2);
    } catch (_) {
      // Compatibility fallbacks below.
    }
  }
  if (modelApi) {
    for (const fnName of ['getAvailable', 'available', 'getAll', 'list']) {
      const fn = modelApi[fnName];
      if (typeof fn !== 'function') continue;
      try {
        const raw = await fn.call(modelApi);
        appendDescriptorsWithPriority(raw, found, 1);
      } catch (_) {
        // Ignore; we'll still try alias-based switching below.
      }
    }
  }
  found.sort((a, b) => Number(b?.__priority || 0) - Number(a?.__priority || 0));

  const byModelId = new Map();
  for (const entry of found) {
    const modelId = normalizeModelIdCandidate(entry?.modelId);
    if (!isValidModelId(modelId)) continue;
    const existing = byModelId.get(modelId);
    const cached = cachedModelMetadataById.get(modelId);
    byModelId.set(modelId, {
      modelId,
      contextLimitTokens: existing?.contextLimitTokens
        ?? normalizeContextLimitTokens(entry?.contextLimitTokens)
        ?? cached?.contextLimitTokens
        ?? null,
      longContextLimitTokens: existing?.longContextLimitTokens
        ?? normalizeContextLimitTokens(entry?.longContextLimitTokens)
        ?? cached?.longContextLimitTokens
        ?? null,
      pricing: existing?.pricing || entry?.pricing || cached?.pricing || null,
    });
  }
  const models = byModelId.size ? [...byModelId.values()] : [...cachedModelMetadataById.values()];
  for (const entry of models) cachedModelMetadataById.set(entry.modelId, entry);
  return models;
}

async function getAvailableModelIds(session) {
  const models = await getAvailableModels(session);
  return models.map((entry) => entry.modelId);
}

function buildRequestedModelCandidates(requested) {
  const key = String(requested || '').trim();
  if (!key) return [];
  const aliasList = MODEL_ALIAS_CANDIDATES[key] || MODEL_ALIAS_CANDIDATES[key.toLowerCase()] || [];
  return [...new Set([key, ...aliasList])];
}

function resolveRequestedModelId(requested, availableIds) {
  const candidates = buildRequestedModelCandidates(requested);
  if (!candidates.length) return null;
  if (!availableIds.length) return candidates[0];

  const byCanonical = new Map(availableIds.map((id) => [canonicalModelId(id), id]));
  for (const candidate of candidates) {
    const exact = availableIds.find((id) => id === candidate);
    if (exact) return exact;
    const canon = byCanonical.get(canonicalModelId(candidate));
    if (canon) return canon;
  }
  return candidates[0];
}

async function getCurrentModelId(session) {
  try {
    const modelInfo = await session.rpc.model.getCurrent();
    return normalizeModelId(modelInfo);
  } catch {
    return null;
  }
}

async function publishModelSnapshot(session, reason = 'standalone-relay', force = false) {
  const now = Date.now();
  if (!force && (now - lastModelSnapshotMs) < MODEL_SNAPSHOT_MIN_INTERVAL_MS) return;
  lastModelSnapshotMs = now;
  try {
    const currentModel = await getCurrentModelId(session);
    const availableModels = await getAvailableModels(session);
    const modelIds = availableModels.map((entry) => entry.modelId);
    const contextLimitsByModel = Object.fromEntries(
      availableModels
        .filter((entry) => entry.contextLimitTokens !== null)
        .map((entry) => [entry.modelId, entry.contextLimitTokens]),
    );
    const modelMetadataByModel = Object.fromEntries(
      availableModels.map((entry) => [entry.modelId, {
        defaultContextLimitTokens: entry.contextLimitTokens,
        longContextLimitTokens: entry.longContextLimitTokens,
        pricing: entry.pricing,
      }]),
    );
    await apiJson('POST', '/api/models/snapshot', {
      source: `standalone-relay:${reason}`,
      models: modelIds,
      contextLimitsByModel,
      modelMetadataByModel,
      currentModel: currentModel || null,
      defaultModel: currentModel || modelIds[0] || null,
      error: null,
    }, { auth: true });
    vlog(`Published model snapshot (${reason}) models=${modelIds.length} contextLimits=${Object.keys(contextLimitsByModel).length} current=${currentModel || 'unknown'}`);
  } catch (e) {
    try {
      await apiJson('POST', '/api/models/snapshot', {
        source: `standalone-relay:${reason}`,
        models: [],
        contextLimitsByModel: {},
        currentModel: null,
        defaultModel: null,
        error: e?.message || String(e),
      }, { auth: true });
    } catch (_) {}
    vlog(`Model snapshot publish failed (${reason}): ${e?.message || String(e)}`);
  }
}

async function setModelForMessage(session, model, contextTier = 'default') {
  const requested = String(model || '').trim();
  if (!requested) return;

  const current = await getCurrentModelId(session);
  if (canonicalModelId(current) === canonicalModelId(requested) && contextTier === 'default') return;

  const availableModels = await getAvailableModelIds(session);
  if (VERBOSE && availableModels.length) {
    vlog(`Available models: ${availableModels.join(', ')}`);
  }
  const targetModel = resolveRequestedModelId(requested, availableModels);
  if (!targetModel) return;

  vlog(`Model switch requested=${requested} resolved=${targetModel} current=${current || 'unknown'}`);

  const attempts = [
    () => session.rpc.model.switchTo({ modelId: targetModel, contextTier }),
    () => session.rpc.model.setCurrent(targetModel),
    () => session.rpc.model.setCurrent({ modelId: targetModel, contextTier }),
    () => session.rpc.model.setCurrent({ model: targetModel }),
    () => session.rpc.model.set(targetModel),
    () => session.rpc.model.set({ modelId: targetModel }),
    () => session.rpc.model.set({ model: targetModel }),
  ];

  for (const attempt of attempts) {
    try {
      await attempt();
      const after = await getCurrentModelId(session);
      if (canonicalModelId(after) === canonicalModelId(requested) || canonicalModelId(after) === canonicalModelId(targetModel)) {
        log(`Switched model to ${after || targetModel} (requested ${requested})`);
        return;
      }
    } catch (_) {
      // Continue trying alternate call signatures.
    }
  }

  err(`Unable to set requested model "${requested}" (resolved as "${targetModel}"); continuing with current model "${current || 'unknown'}"`);
}

// ─── ask_user / Relay Question Bridge ─────────────────────────────────────────
// Guarded by `busy` — only one turn active at a time, so one handler slot is enough.
let activeUserInputHandler = null;

/**
 * Called by the SDK when the agent invokes the ask_user tool.
 * Posts the question to the web relay, polls until answered, and returns the answer.
 */
async function relayUserInputQuestion(msg, request) {
  const { question, choices, allowFreeform } = request;
  log(`ask_user question for msg ${msg.id.slice(0, 8)}: "${String(question || '').slice(0, 80)}"`);

  let questionData;
  try {
    const body = {
      queueId: msg.id,
      messageId: msg.id,
      conversationId: msg.conversationId,
      prompt: question,
      choices: Array.isArray(choices) ? choices : [],
      allowFreeform: typeof allowFreeform === 'boolean' ? allowFreeform : true,
    };
    const result = await apiJson('POST', '/api/relay-question', body, { auth: true });
    questionData = result.question;
  } catch (e) {
    err(`Failed to post ask_user question to relay: ${e.message}`);
    throw new Error(`ask_user relay failed: ${e.message}`);
  }

  const questionId = questionData.id;
  log(`ask_user question ${questionId.slice(0, 8)} posted — waiting for web answer...`);

  const POLL_MS = 2000;
  const MAX_WAIT_MS = 10 * 60 * 1000; // 10 min
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    let q;
    try {
      const result = await apiJson('GET', `/api/relay-question/${questionId}`, undefined, { auth: true });
      q = result.question;
    } catch (e) {
      vlog(`Poll for question ${questionId.slice(0, 8)} failed: ${e.message}`);
      continue;
    }

    if (q.status === 'answered') {
      log(`ask_user question ${questionId.slice(0, 8)} answered: "${String(q.answer || '').slice(0, 80)}"`);
      return q.answer || '';
    }
    if (q.status === 'timed_out') {
      throw new Error('ask_user question timed out waiting for web answer');
    }
  }

  throw new Error('ask_user question exceeded max wait time');
}

// ─── Main Poll Loop ────────────────────────────────────────────────────────────
let busy = false;

async function processNext(approveAll) {
  if (busy || !clientReady) return;

  let data;
  try {
    data = await apiJson('GET', '/api/pending', undefined, { auth: true });
  } catch (e) {
    err(`Pending poll failed: ${e.message}`);
    return;
  }

  const msg = data.message;
  if (!msg) return;

  // Messages from conversations bound to a session-worker provider must never
  // execute here: this relay runs on the Copilot plan, and model ids like
  // claude-opus-5 exist on both sides, so a stolen turn would silently bill
  // the wrong plan under the wrong provider label. The server-side dequeue
  // already filters these; this guard covers a server that predates it.
  // openai is allowed through because routing-disabled installs still run
  // OpenAI BYOK conversations here. Note this process is launched by hand with
  // plain env, so such a turn does execute on the Copilot plan and is reported
  // as a mismatch by the provenance check in /api/response. The eligible set
  // is shared with findPendingForLegacyRelay via shared/provider-routing.mjs,
  // so both sides derive from one constant.
  const msgProviderType = String(msg.providerType || '').trim().toLowerCase();
  if (!isLegacyRelayProviderType(msgProviderType)) {
    err(`Refusing msg ${msg.id.slice(0, 8)}: it belongs to provider "${msgProviderType}", not the Copilot relay`);
    try {
      // The distinct code keeps the row's retry budget and backoff untouched:
      // this is a routing refusal, not a delivery failure — the owner worker
      // must be able to claim it immediately.
      await apiJson('POST', '/api/requeue', { messageId: msg.id, code: 'relay.provider-mismatch' }, { auth: true });
    } catch (_) {}
    return;
  }

  busy = true;
  const started = Date.now();
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const sdkAttachments = buildSdkAttachments(msg);
  const prompt = buildPrompt(msg);
  const promptForLog = redactAttachmentPathsFromPrompt(prompt);
  log(`Processing msg ${msg.id.slice(0, 8)} conv=${msg.conversationId.slice(0, 8)} rs=${String(msg.runtimeSessionId || 'none').slice(0, 8)} model=${msg.model || 'default'}${msg.reasoningEffort ? ` effort=${msg.reasoningEffort}` : ''} len=${(msg.text || '').length}${attachments.length ? ` attachments=${attachments.length}` : ''}`);
  logTextBlock(`PROMPT ${msg.id.slice(0, 8)}`, promptForLog);

  try {
    const session = await getOrCreateSession(msg.runtimeSessionId, msg.conversationId, msg.model, approveAll);
    // A cached session keeps the model it was created with; without this a
    // second message on the same conversation with a different model silently
    // executed on the old one (the switch helper existed but had no caller).
    await setModelForMessage(session, msg.model);
    await publishModelSnapshot(session, 'process-message');

    activeUserInputHandler = (request) => relayUserInputQuestion(msg, request);
    let response;
    try {
      const messageOptions = sdkAttachments.length ? { prompt, attachments: sdkAttachments } : { prompt };
      if (msg.reasoningEffort && String(msg.reasoningEffort || '').trim().toLowerCase() !== 'none') {
        messageOptions.reasoningEffort = String(msg.reasoningEffort || '').trim();
      }
      response = await session.sendAndWait(messageOptions, 300_000);
    } finally {
      activeUserInputHandler = null;
    }
    vlog(`sendAndWait completed in ${Date.now() - started}ms for ${msg.id.slice(0, 8)}`);

    const extracted = extractFinalText(response);
    const text = extracted || buildFallbackAssistantText();
    if (!extracted) {
      // Log raw envelope whenever we fall back so we can improve extraction later
      try {
        log(`Fallback used for msg ${msg.id.slice(0, 8)}. Raw envelope:`, JSON.stringify(response, null, 2).slice(0, 2000));
      } catch {
        log(`Fallback used for msg ${msg.id.slice(0, 8)}. Raw envelope: [unserializable]`);
      }
    }
    const model = await getCurrentModelId(session);
    log(`Response ready (${text.length} chars, model=${model ?? 'unknown'}) for msg ${msg.id.slice(0, 8)}`);
    logTextBlock(`RESPONSE ${msg.id.slice(0, 8)}`, text);
    if (VERBOSE && extracted) {
      try {
        vlog('Raw response envelope:', JSON.stringify(response, null, 2));
      } catch {
        vlog('Raw response envelope: [unserializable]');
      }
    }

    await apiJson('POST', '/api/response', { messageId: msg.id, conversationId: msg.conversationId, text, model }, { auth: true });
  } catch (e) {
    err(`Failed to process msg ${msg.id.slice(0, 8)}:`, e.message);
    try {
      await apiJson('POST', '/api/requeue', { messageId: msg.id }, { auth: true });
    } catch (_) {}
  } finally {
    busy = false;
  }
}

// ─── Heartbeat ─────────────────────────────────────────────────────────────────
async function heartbeat() {
  try {
    await apiJson('POST', '/api/heartbeat', undefined, { auth: true });
  } catch (e) {
    err(`Heartbeat failed: ${e.message}`);
  }
}

// ─── Startup ───────────────────────────────────────────────────────────────────
async function main() {
  log(`Starting relay... (foreground=${FOREGROUND}, verbose=${VERBOSE}, token=${TOKEN_OVERRIDE ? 'overridden' : 'from config'}, sessionPolicy=${RUNTIME_SESSION_POLICY})`);
  vlog(`Server URL: ${SERVER_URL}`);

  let CopilotClient, approveAll;
  try {
    const sdk = await import(`file:///${SDK_PATH}`);
    CopilotClient = sdk.CopilotClient;
    approveAll = sdk.approveAll;
    if (!CopilotClient) throw new Error('CopilotClient not found in SDK exports');
    log('SDK loaded ✓');
  } catch (e) {
    err('Failed to load Copilot SDK:', e.message);
    process.exit(1);
  }

  try {
    await initClient(CopilotClient);
  } catch (e) {
    err('Failed to start Copilot client:', e.message);
    process.exit(1);
  }

  setInterval(() => processNext(approveAll), 2000);
  setInterval(heartbeat, 5000);
  heartbeat();
  try {
    const bootSession = await getOrCreateSession('__relay_model_probe__', '__relay_model_probe__', null, approveAll);
    await publishModelSnapshot(bootSession, 'startup', true);
  } catch (e) {
    vlog(`Startup model snapshot skipped: ${e?.message || String(e)}`);
  }

  log('Relay running. Polling for messages every 2s.');
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (executedPath && executedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { err('Fatal:', e); process.exit(1); });

  // Keep the process alive through unhandled rejections (e.g. from SDK internals)
  process.on('unhandledRejection', (reason) => {
    err('Unhandled rejection (relay will keep running):', reason);
  });
  process.on('uncaughtException', (e) => {
    err('Uncaught exception (relay will keep running):', e.message, e.stack);
  });
}

export { readConfig, parsePort };
