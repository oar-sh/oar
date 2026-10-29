'use strict';

import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  OAR_MCP_SERVER_NAME,
  OAR_MCP_SERVER_SCRIPT_PATH,
  OAR_MCP_TOOL_TIMEOUT_MS,
  buildOarMcpServerLaunch,
  isOarMcpServerDisabled,
} from '../mcp/oar-mcp-server.mjs';
import { WORKER_LOG_FILE_ENV } from '../../shared/worker-runtime/worker-log-file.mjs';
import {
  HOST_CLAUDE_SESSION_ENV_VARS,
  hostClaudeSessionUnsetStatement,
  withoutHostClaudeSessionVariables,
} from '../../shared/host-claude-session-env.mjs';
import { missingWorkingDirectoryError } from '../../shared/worker-runtime/working-directory.mjs';
import {
  describeSpawnEnvironment,
  envPathKey,
  readEnvValue,
  windowsCmdPath,
} from '../../shared/windows-system-tools.mjs';

export { isOarMcpServerDisabled };

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function parsePositiveInt(value) {
  const num = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function isPidAlive(pidValue) {
  const pid = Number(pidValue);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = String(error?.code || '').trim().toUpperCase();
    return code === 'EPERM';
  }
}

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

// ─── Which Node runs a worker ────────────────────────────────────────────────
//
// The relay's own Node by default: its absolute path works whatever PATH the
// relay was started with. A relay started by the Windows boot task found no
// `node` on that task's PATH, and every worker launch failed without a trace.
// COPILOT_WEB_RELAY_NODE still overrides it.

export function resolveWorkerNodeExecutable(env = {}, { execPath = process.execPath } = {}) {
  return normalizeText(env?.COPILOT_WEB_RELAY_NODE) || execPath;
}

function pathImplFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isPathLike(value) {
  return /[\\/]/.test(String(value || ''));
}

/** The folder of the worker's Node when it is a path, else null. */
export function resolveWorkerNodeDirectory(env = {}, { platform = process.platform, execPath = process.execPath } = {}) {
  const executable = resolveWorkerNodeExecutable(env, { execPath });
  const pathImpl = pathImplFor(platform);
  const candidate = isPathLike(executable) ? executable : execPath;
  if (!isPathLike(candidate)) return null;
  return pathImpl.dirname(candidate);
}

/**
 * The environment with the worker's Node folder at the END of PATH when it is
 * not on it yet. The CLIs a worker starts, and the commands its agent runs,
 * may call a bare `node`; appending only matters when PATH has none, and never
 * changes which one a PATH that has one picks.
 */
export function appendNodeDirectoryToPath(env = {}, nodeDirectory, { platform = process.platform } = {}) {
  const dir = normalizeText(nodeDirectory);
  if (!dir) return env;
  const pathImpl = pathImplFor(platform);
  const key = envPathKey(env, platform);
  const current = String(env?.[key] || '');
  const comparable = (entry) => {
    const trimmed = String(entry || '').trim().replace(/[\\/]+$/, '');
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  const wanted = comparable(dir);
  if (current.split(pathImpl.delimiter).some((entry) => comparable(entry) === wanted)) return env;
  const separator = current && !current.endsWith(pathImpl.delimiter) ? pathImpl.delimiter : '';
  return { ...env, [key]: `${current}${separator}${dir}` };
}

/**
 * Where `command` resolves to with this environment's PATH (and PATHEXT on
 * Windows), or null. A command with a folder part must be a file.
 */
export function locateExecutable(command, {
  env = {},
  platform = process.platform,
  fsImpl = fs,
} = {}) {
  const name = String(command || '').trim();
  if (!name) return null;
  const pathImpl = pathImplFor(platform);
  const isFile = (candidate) => {
    try { return fsImpl.statSync(candidate).isFile(); } catch { return false; }
  };
  const extensions = platform === 'win32' && !pathImpl.extname(name)
    ? (readEnvValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').map((ext) => ext.trim()).filter(Boolean)
    : [''];
  const names = extensions.map((ext) => `${name}${ext}`);
  if (extensions[0] !== '') names.push(name);
  if (isPathLike(name)) return names.find(isFile) || null;
  const dirs = readEnvValue(env, 'PATH').split(pathImpl.delimiter).map((dir) => dir.trim()).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = pathImpl.join(dir, candidate);
      if (isFile(full)) return full;
    }
  }
  return null;
}

export function resolveOpenAIWireApi(model = '') {
  const normalized = String(model || '').trim().toLowerCase().replace(/^openai\//, '');
  if (
    normalized.startsWith('gpt-5')
    || normalized.startsWith('codex-')
    || normalized === 'o1'
    || normalized.startsWith('o1-')
    || normalized === 'o3'
    || normalized.startsWith('o3-')
    || normalized.startsWith('o4-')
  ) {
    return 'responses';
  }
  return 'completions';
}

export function applyOpenAIProviderEnvironment(env = {}, {
  enabled = false,
  apiKey = '',
  model = '',
  baseUrl = 'https://api.openai.com/v1',
  wireApi = '',
} = {}) {
  const next = { ...env };
  for (const key of [
    'COPILOT_PROVIDER_TYPE',
    'COPILOT_PROVIDER_BASE_URL',
    'COPILOT_PROVIDER_API_KEY',
    'COPILOT_PROVIDER_WIRE_API',
    'COPILOT_MODEL',
  ]) {
    delete next[key];
  }
  if (!enabled) return next;
  const normalizedApiKey = normalizeText(apiKey);
  const normalizedModel = normalizeText(model);
  if (!normalizedApiKey) throw new Error('openai-api-key-not-configured');
  if (!normalizedModel) throw new Error('openai-model-not-configured');
  next.COPILOT_PROVIDER_TYPE = 'openai';
  next.COPILOT_PROVIDER_BASE_URL = normalizeText(baseUrl) || 'https://api.openai.com/v1';
  next.COPILOT_PROVIDER_API_KEY = normalizedApiKey;
  next.COPILOT_PROVIDER_WIRE_API = normalizeText(wireApi) || resolveOpenAIWireApi(normalizedModel);
  next.COPILOT_MODEL = normalizedModel;
  return next;
}

/**
 * The worker kind an environment names, or `copilot` (the extension engine,
 * which is the absence of a kind) for anything unrecognised.
 *
 * Validated against `NODE_WORKER_DESCRIPTORS` rather than a parallel list of
 * kind names: a new node worker is then one descriptor entry, and there is no
 * second place that can be forgotten and silently route the new kind back to
 * the Copilot CLI. Referenced lazily — this is only ever called at request
 * time, long after the descriptor table is initialised.
 */
export function resolveWorkerKind(env = {}) {
  const kind = String(env?.COPILOT_WEB_RELAY_WORKER_KIND || '').trim().toLowerCase();
  return Object.hasOwn(NODE_WORKER_DESCRIPTORS, kind) ? kind : 'copilot';
}

export function applyClaudeProviderEnvironment(env = {}, {
  enabled = false,
  model = '',
} = {}) {
  const next = { ...env };
  // Only clear the worker kind this provider owns so clear chains stay
  // order-independent when multiple provider appliers run back to back.
  if (resolveWorkerKind(next) === 'claude') delete next.COPILOT_WEB_RELAY_WORKER_KIND;
  delete next.CLAUDE_RELAY_MODEL;
  if (!enabled) return next;
  // The Claude worker authenticates through the host's logged-in Claude
  // credentials, so no API key flows through the environment here.
  next.COPILOT_WEB_RELAY_WORKER_KIND = 'claude';
  const normalizedModel = normalizeText(model);
  if (normalizedModel) next.CLAUDE_RELAY_MODEL = normalizedModel;
  return next;
}

export function applyCursorProviderEnvironment(env = {}, {
  enabled = false,
  model = '',
  apiKey = '',
  // The relay's resolved, absolute data dir: the worker keeps its agent stores
  // there, and must not resolve a relative one or the config's own again.
  dataDir = '',
} = {}) {
  const next = { ...env };
  if (resolveWorkerKind(next) === 'cursor') delete next.COPILOT_WEB_RELAY_WORKER_KIND;
  delete next.CURSOR_RELAY_MODEL;
  delete next.CURSOR_API_KEY;
  if (!enabled) return next;
  const normalizedApiKey = normalizeText(apiKey);
  if (!normalizedApiKey) throw new Error('cursor-api-key-not-configured');
  next.COPILOT_WEB_RELAY_WORKER_KIND = 'cursor';
  next.CURSOR_API_KEY = normalizedApiKey;
  const normalizedModel = normalizeText(model);
  if (normalizedModel) next.CURSOR_RELAY_MODEL = normalizedModel;
  const normalizedDataDir = normalizeText(dataDir);
  if (normalizedDataDir) next.COPILOT_WEB_RELAY_DATA_DIR = path.resolve(normalizedDataDir);
  return next;
}

export function applyGrokProviderEnvironment(env = {}, {
  enabled = false,
  model = '',
  command = '',
} = {}) {
  const next = { ...env };
  // Host-login provider (like Claude): no API key is required in the relay.
  if (resolveWorkerKind(next) === 'grok') delete next.COPILOT_WEB_RELAY_WORKER_KIND;
  delete next.GROK_RELAY_MODEL;
  delete next.GROK_CLI_COMMAND;
  if (!enabled) return next;
  next.COPILOT_WEB_RELAY_WORKER_KIND = 'grok';
  const normalizedModel = normalizeText(model);
  if (normalizedModel) next.GROK_RELAY_MODEL = normalizedModel;
  const normalizedCommand = normalizeText(command);
  if (normalizedCommand) next.GROK_CLI_COMMAND = normalizedCommand;
  return next;
}

export function applyClaudeCloudProviderEnvironment(env = {}, {
  enabled = false,
  model = '',
} = {}) {
  const next = { ...env };
  if (resolveWorkerKind(next) === 'claude-cloud') delete next.COPILOT_WEB_RELAY_WORKER_KIND;
  delete next.CLAUDE_CLOUD_RELAY_MODEL;
  if (!enabled) return next;
  // No credential is added here: the worker reads the Claude CLI's login
  // itself. A relay that runs on CLAUDE_CODE_OAUTH_TOKEN instead has it in its
  // own environment; workerSecretEnvVarsFor hands that to the cloud worker.
  next.COPILOT_WEB_RELAY_WORKER_KIND = 'claude-cloud';
  const normalizedModel = normalizeText(model);
  if (normalizedModel) next.CLAUDE_CLOUD_RELAY_MODEL = normalizedModel;
  return next;
}

/**
 * DeepSeek: the Claude worker's runner against DeepSeek's Anthropic-compatible
 * endpoint (server/deepseek-worker/). The key travels as DEEPSEEK_API_KEY,
 * through the secret file under tmux, and becomes the CLI's bearer token
 * only inside its spawn environment (deepseek-claude-backend.mjs). The worker
 * keeps its Claude Code state in a directory of its own, which holds no
 * Claude login.
 */
export function applyDeepSeekProviderEnvironment(env = {}, {
  enabled = false,
  model = '',
  apiKey = '',
  baseUrl = '',
  configDir = '',
} = {}) {
  const next = { ...env };
  if (resolveWorkerKind(next) === 'deepseek') delete next.COPILOT_WEB_RELAY_WORKER_KIND;
  delete next.DEEPSEEK_RELAY_MODEL;
  delete next.DEEPSEEK_API_KEY;
  delete next.DEEPSEEK_BASE_URL;
  delete next.DEEPSEEK_CLAUDE_CONFIG_DIR;
  if (!enabled) return next;
  const normalizedApiKey = normalizeText(apiKey);
  if (!normalizedApiKey) throw new Error('deepseek-api-key-not-configured');
  const normalizedConfigDir = normalizeText(configDir);
  if (!normalizedConfigDir) throw new Error('deepseek-config-dir-not-configured');
  next.COPILOT_WEB_RELAY_WORKER_KIND = 'deepseek';
  next.DEEPSEEK_API_KEY = normalizedApiKey;
  next.DEEPSEEK_CLAUDE_CONFIG_DIR = path.resolve(normalizedConfigDir);
  const normalizedModel = normalizeText(model);
  if (normalizedModel) next.DEEPSEEK_RELAY_MODEL = normalizedModel;
  const normalizedBaseUrl = normalizeText(baseUrl);
  if (normalizedBaseUrl) next.DEEPSEEK_BASE_URL = normalizedBaseUrl;
  return next;
}

/**
 * Claude API: the Claude worker's runner on an API key from the Claude
 * Console instead of the host's subscription login
 * (server/claude-api-worker/). The key travels as OAR_CLAUDE_API_KEY, through
 * the secret file under tmux, and becomes the CLI's ANTHROPIC_API_KEY only
 * inside its spawn environment (claude-api-backend.mjs). The worker shares the
 * host's Claude Code state directory with the Claude provider: transcripts,
 * resume and task output are found where a Claude chat's are.
 */
export function applyClaudeApiProviderEnvironment(env = {}, {
  enabled = false,
  model = '',
  apiKey = '',
} = {}) {
  const next = { ...env };
  if (resolveWorkerKind(next) === 'claude-api') delete next.COPILOT_WEB_RELAY_WORKER_KIND;
  delete next.CLAUDE_API_RELAY_MODEL;
  delete next.OAR_CLAUDE_API_KEY;
  if (!enabled) return next;
  const normalizedApiKey = normalizeText(apiKey);
  if (!normalizedApiKey) throw new Error('claude-api-key-not-configured');
  next.COPILOT_WEB_RELAY_WORKER_KIND = 'claude-api';
  next.OAR_CLAUDE_API_KEY = normalizedApiKey;
  const normalizedModel = normalizeText(model);
  if (normalizedModel) next.CLAUDE_API_RELAY_MODEL = normalizedModel;
  return next;
}

/**
 * The Copilot SDK engine: the same `github`/`openai` providers the extension
 * serves, run as a plain Node worker against the CLI's headless runtime.
 *
 * Unlike the other appliers this one configures no credentials of its own. The
 * SDK worker authenticates exactly like the TUI does (the host's `copilot`
 * login), and the one path it needs — `COPILOT_SDK_PATH` — is already resolved
 * once into the base launch environment for every session, extension or SDK.
 * (It needs no CLI executable: the runtime entry point is derived from the SDK
 * bundle's own version directory, so the two can never drift apart.) This
 * applier's whole job is selecting the worker kind and handing over the model.
 *
 * BYOK is deliberately NOT re-implemented here: an `openai` session is composed
 * as `applyCopilotSdkProviderEnvironment(applyOpenAIProviderEnvironment(...))`,
 * so one OpenAI configuration drives both engines and the secret-env-file
 * plumbing for `COPILOT_PROVIDER_API_KEY` is untouched. The SDK worker reads
 * that family in-process (`copilot-byok-provider.mjs`) because the runtime
 * ignores it for SDK-created sessions.
 *
 * `COPILOT_SDK_PATH` is required rather than optional: it is resolved from the
 * installed CLI's own bundle, so its absence means there is no CLI to run and
 * failing here names the problem instead of spawning a worker that dies on its
 * first import.
 */
export function applyCopilotSdkProviderEnvironment(env = {}, {
  enabled = false,
  model = '',
} = {}) {
  const next = { ...env };
  // Only clear the worker kind this provider owns so clear chains stay
  // order-independent when multiple provider appliers run back to back.
  if (resolveWorkerKind(next) === 'copilot-sdk') delete next.COPILOT_WEB_RELAY_WORKER_KIND;
  delete next.COPILOT_RELAY_MODEL;
  if (!enabled) return next;
  if (!normalizeText(next.COPILOT_SDK_PATH)) throw new Error('copilot-sdk-path-not-resolved');
  next.COPILOT_WEB_RELAY_WORKER_KIND = 'copilot-sdk';
  const normalizedModel = normalizeText(model);
  if (normalizedModel) next.COPILOT_RELAY_MODEL = normalizedModel;
  return next;
}

/**
 * Why the Copilot SDK engine cannot be selected right now, or null when it can.
 *
 * The engine toggle is a promise the UI makes on the relay's behalf ("new
 * Copilot conversations run headless"), and there are two ways to save it and
 * have precisely nothing happen — both invisible from the settings panel, and
 * both indistinguishable from the feature simply not working:
 *
 *  - `COPILOT_SDK_PATH` never resolved. The worker's very first act is to
 *    import the SDK from it, so every conversation would die on spawn.
 *  - Session-worker routing is off. No worker of any node kind is ever spawned,
 *    so the setting is a no-op while the panel asserts the opposite.
 *
 * Refusing the save with the reason is strictly better than accepting it: the
 * user finds out at the moment they can still act on it.
 */
export function copilotSdkEngineUnavailableReason({ env = {}, routingEnabled = false } = {}) {
  if (!normalizeText(env?.COPILOT_SDK_PATH)) {
    // Worth spelling out: the launch environment is built ONCE at boot, so
    // installing the CLI now and re-saving without a restart fails identically.
    return 'The Copilot SDK was not found when the relay started (COPILOT_SDK_PATH did not resolve). '
      + 'Install or upgrade the GitHub Copilot CLI, then restart the relay — the launch environment is '
      + 'snapshotted at startup, so a CLI installed since then is not visible yet.';
  }
  if (routingEnabled !== true) {
    return 'The SDK engine requires session worker routing, which is disabled on this relay '
      + '(SESSION_WORKER_ROUTING_ENABLED). With routing off no SDK worker is ever spawned, so the engine '
      + 'setting would have no effect.';
  }
  return null;
}

export function isClaudeWorkerEnvironment(env = {}) {
  return String(env?.COPILOT_WEB_RELAY_WORKER_KIND || '').trim().toLowerCase() === 'claude';
}

export function isCursorWorkerEnvironment(env = {}) {
  return resolveWorkerKind(env) === 'cursor';
}

export function isGrokWorkerEnvironment(env = {}) {
  return resolveWorkerKind(env) === 'grok';
}

export function isClaudeCloudWorkerEnvironment(env = {}) {
  return resolveWorkerKind(env) === 'claude-cloud';
}

export function isDeepSeekWorkerEnvironment(env = {}) {
  return resolveWorkerKind(env) === 'deepseek';
}

export function isClaudeApiWorkerEnvironment(env = {}) {
  return resolveWorkerKind(env) === 'claude-api';
}

export function isCopilotSdkWorkerEnvironment(env = {}) {
  return resolveWorkerKind(env) === 'copilot-sdk';
}

export function resolveClaudeWorkerScriptPath(env = {}) {
  const explicit = normalizeText(env?.COPILOT_WEB_RELAY_CLAUDE_WORKER_PATH);
  if (explicit) return explicit;
  const repoRoot = normalizeText(env?.COPILOT_WEB_RELAY_ROOT);
  if (repoRoot) return path.join(repoRoot, 'server', 'claude-worker', 'claude-session-worker.mjs');
  const serverDir = normalizeText(env?.COPILOT_WEB_RELAY_SERVER_DIR);
  if (serverDir) return path.join(serverDir, 'claude-worker', 'claude-session-worker.mjs');
  return path.join(process.cwd(), 'server', 'claude-worker', 'claude-session-worker.mjs');
}

export function resolveCursorWorkerScriptPath(env = {}) {
  const explicit = normalizeText(env?.COPILOT_WEB_RELAY_CURSOR_WORKER_PATH);
  if (explicit) return explicit;
  const repoRoot = normalizeText(env?.COPILOT_WEB_RELAY_ROOT);
  if (repoRoot) return path.join(repoRoot, 'server', 'cursor-worker', 'cursor-session-worker.mjs');
  const serverDir = normalizeText(env?.COPILOT_WEB_RELAY_SERVER_DIR);
  if (serverDir) return path.join(serverDir, 'cursor-worker', 'cursor-session-worker.mjs');
  return path.join(process.cwd(), 'server', 'cursor-worker', 'cursor-session-worker.mjs');
}

export function resolveGrokWorkerScriptPath(env = {}) {
  const explicit = normalizeText(env?.COPILOT_WEB_RELAY_GROK_WORKER_PATH);
  if (explicit) return explicit;
  const repoRoot = normalizeText(env?.COPILOT_WEB_RELAY_ROOT);
  if (repoRoot) return path.join(repoRoot, 'server', 'grok-worker', 'grok-session-worker.mjs');
  const serverDir = normalizeText(env?.COPILOT_WEB_RELAY_SERVER_DIR);
  if (serverDir) return path.join(serverDir, 'grok-worker', 'grok-session-worker.mjs');
  return path.join(process.cwd(), 'server', 'grok-worker', 'grok-session-worker.mjs');
}

export function resolveClaudeCloudWorkerScriptPath(env = {}) {
  const explicit = normalizeText(env?.COPILOT_WEB_RELAY_CLAUDE_CLOUD_WORKER_PATH);
  if (explicit) return explicit;
  const repoRoot = normalizeText(env?.COPILOT_WEB_RELAY_ROOT);
  if (repoRoot) return path.join(repoRoot, 'server', 'claude-cloud-worker', 'claude-cloud-session-worker.mjs');
  const serverDir = normalizeText(env?.COPILOT_WEB_RELAY_SERVER_DIR);
  if (serverDir) return path.join(serverDir, 'claude-cloud-worker', 'claude-cloud-session-worker.mjs');
  return path.join(process.cwd(), 'server', 'claude-cloud-worker', 'claude-cloud-session-worker.mjs');
}

export function resolveDeepSeekWorkerScriptPath(env = {}) {
  const explicit = normalizeText(env?.COPILOT_WEB_RELAY_DEEPSEEK_WORKER_PATH);
  if (explicit) return explicit;
  const repoRoot = normalizeText(env?.COPILOT_WEB_RELAY_ROOT);
  if (repoRoot) return path.join(repoRoot, 'server', 'deepseek-worker', 'deepseek-session-worker.mjs');
  const serverDir = normalizeText(env?.COPILOT_WEB_RELAY_SERVER_DIR);
  if (serverDir) return path.join(serverDir, 'deepseek-worker', 'deepseek-session-worker.mjs');
  return path.join(process.cwd(), 'server', 'deepseek-worker', 'deepseek-session-worker.mjs');
}

export function resolveClaudeApiWorkerScriptPath(env = {}) {
  const explicit = normalizeText(env?.COPILOT_WEB_RELAY_CLAUDE_API_WORKER_PATH);
  if (explicit) return explicit;
  const repoRoot = normalizeText(env?.COPILOT_WEB_RELAY_ROOT);
  if (repoRoot) return path.join(repoRoot, 'server', 'claude-api-worker', 'claude-api-session-worker.mjs');
  const serverDir = normalizeText(env?.COPILOT_WEB_RELAY_SERVER_DIR);
  if (serverDir) return path.join(serverDir, 'claude-api-worker', 'claude-api-session-worker.mjs');
  return path.join(process.cwd(), 'server', 'claude-api-worker', 'claude-api-session-worker.mjs');
}

export function resolveCopilotSdkWorkerScriptPath(env = {}) {
  const explicit = normalizeText(env?.COPILOT_WEB_RELAY_COPILOT_SDK_WORKER_PATH);
  if (explicit) return explicit;
  const repoRoot = normalizeText(env?.COPILOT_WEB_RELAY_ROOT);
  if (repoRoot) return path.join(repoRoot, 'server', 'copilot-worker', 'copilot-sdk-session-worker.mjs');
  const serverDir = normalizeText(env?.COPILOT_WEB_RELAY_SERVER_DIR);
  if (serverDir) return path.join(serverDir, 'copilot-worker', 'copilot-sdk-session-worker.mjs');
  return path.join(process.cwd(), 'server', 'copilot-worker', 'copilot-sdk-session-worker.mjs');
}

// Workers that run as plain Node processes (no CLI, no pseudo-TTY). The
// `copilot` kind is intentionally absent: that is the extension engine, whose
// launch path (the real TUI under a `script` pseudo-TTY) must stay exactly
// as-is. `copilot-sdk` is the SAME provider on the headless SDK engine, and it
// belongs here with Claude/Cursor/Grok. `claude-cloud` is a provider of its
// own: its worker follows a session in Anthropic's cloud and runs no CLI.
const NODE_WORKER_DESCRIPTORS = Object.freeze({
  claude: Object.freeze({ resolveScriptPath: resolveClaudeWorkerScriptPath, windowsTitle: 'Claude Worker' }),
  cursor: Object.freeze({ resolveScriptPath: resolveCursorWorkerScriptPath, windowsTitle: 'Cursor Worker' }),
  grok: Object.freeze({ resolveScriptPath: resolveGrokWorkerScriptPath, windowsTitle: 'Grok Worker' }),
  'claude-cloud': Object.freeze({
    resolveScriptPath: resolveClaudeCloudWorkerScriptPath,
    windowsTitle: 'Claude Cloud Worker',
  }),
  'copilot-sdk': Object.freeze({
    resolveScriptPath: resolveCopilotSdkWorkerScriptPath,
    windowsTitle: 'Copilot SDK Worker',
  }),
  deepseek: Object.freeze({ resolveScriptPath: resolveDeepSeekWorkerScriptPath, windowsTitle: 'DeepSeek Worker' }),
  'claude-api': Object.freeze({
    resolveScriptPath: resolveClaudeApiWorkerScriptPath,
    windowsTitle: 'Claude API Worker',
  }),
});

function resolveNodeWorkerDescriptor(env = {}) {
  const descriptor = NODE_WORKER_DESCRIPTORS[resolveWorkerKind(env)];
  if (!descriptor) return null;
  return {
    scriptPath: descriptor.resolveScriptPath(env),
    windowsTitle: descriptor.windowsTitle,
  };
}

function buildPosixWorkerLaunchCommand(targetSessionId, env = {}, extraCliArgs = []) {
  const nodeWorker = resolveNodeWorkerDescriptor(env);
  if (nodeWorker) {
    const nodeExecutable = resolveWorkerNodeExecutable(env);
    return `${shellQuote(nodeExecutable)} ${shellQuote(nodeWorker.scriptPath)} --session-id ${shellQuote(targetSessionId)}`;
  }
  const cliExecutable = normalizeText(env?.COPILOT_WEB_RELAY_CLI_EXECUTABLE)
    || normalizeText(env?.COPILOT_CLI_EXECUTABLE)
    || normalizeText(env?.COPILOT_CLI_PATH)
    || 'copilot';
  const extra = (Array.isArray(extraCliArgs) ? extraCliArgs : []).map((arg) => ` ${shellQuote(arg)}`).join('');
  return `${shellQuote(cliExecutable)} --allow-all --session-id ${shellQuote(targetSessionId)}${extra}`;
}

// ─── The OAR MCP server for the extension engine ─────────────────────────────
//
// The Copilot CLI takes extra MCP servers per run through
// `--additional-mcp-config <json>`, where `<json>` may be `@<file>` (CLI
// 1.0.83 `--help`: "JSON string or file path (prefix with @)"; the file is
// read as UTF-8 and merged over ~/.copilot/mcp-config.json for that run
// only). The config goes to a file rather than inline: the argument then
// crosses cmd.exe/`start` on Windows and `sh -lc` + `script -c` on the tmux
// path as one plain path, with no JSON to escape through two shells.
//
// Server entry shape (the CLI's own `copilot mcp add` writes the same):
// `{ type: 'local', command, args, env, tools: ['*'], timeout }`. `timeout` is
// the per-call limit in ms; without it the CLI cuts a tool call off at 180 s,
// shorter than one relay_tool wait.

export function resolveOarMcpServerScriptPath(env = {}, { pathImpl = path } = {}) {
  const repoRoot = normalizeText(env?.COPILOT_WEB_RELAY_ROOT);
  if (repoRoot) return pathImpl.join(repoRoot, 'server', 'mcp', 'oar-mcp-server.mjs');
  const serverDir = normalizeText(env?.COPILOT_WEB_RELAY_SERVER_DIR);
  if (serverDir) return pathImpl.join(serverDir, 'mcp', 'oar-mcp-server.mjs');
  return OAR_MCP_SERVER_SCRIPT_PATH;
}

/** The `--additional-mcp-config` document for one extension-engine session. */
export function buildCopilotOarMcpConfig(targetSessionId, env = {}, {
  nodePath = normalizeText(env?.COPILOT_WEB_RELAY_NODE) || process.execPath,
  pathImpl = path,
} = {}) {
  const launch = buildOarMcpServerLaunch({
    nodePath,
    conversationId: targetSessionId,
    env,
    scriptPath: resolveOarMcpServerScriptPath(env, { pathImpl }),
  });
  return {
    mcpServers: {
      [OAR_MCP_SERVER_NAME]: {
        type: 'local',
        command: launch.command,
        args: launch.args,
        env: launch.env,
        tools: ['*'],
        timeout: OAR_MCP_TOOL_TIMEOUT_MS,
      },
    },
  };
}

/**
 * Writes the session's MCP config next to its worker log and returns the file
 * path, or null — best-effort like the log itself: a session that cannot get
 * the file still starts, just without the OAR tools. No secrets go in: the
 * server reads the token from the relay config the file points at.
 */
export function prepareOarMcpConfigFile(targetSessionId, launchEnv = {}, {
  fsImpl = fs,
  pathImpl = path,
  nodePath = undefined,
} = {}) {
  if (isOarMcpServerDisabled(launchEnv)) return null;
  try {
    const config = buildCopilotOarMcpConfig(targetSessionId, launchEnv, {
      pathImpl,
      ...(nodePath ? { nodePath } : {}),
    });
    const baseDir = resolveWorkerLogDir(launchEnv, { pathImpl });
    fsImpl.mkdirSync(baseDir, { recursive: true });
    const filePath = pathImpl.join(baseDir, `worker-${safeWorkerFileId(targetSessionId)}.mcp.json`);
    fsImpl.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return filePath;
  } catch {
    return null;
  }
}

function oarMcpCliArgs(configFilePath) {
  const filePath = normalizeText(configFilePath);
  return filePath ? ['--additional-mcp-config', `@${filePath}`] : [];
}

export function normalizeTmuxSessionName(targetSessionId) {
  const text = String(targetSessionId || '').trim();
  if (!text) throw new Error('missing-target-session-id');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error(`invalid-tmux-session-name:${text}`);
  }
  return text;
}

export function isTmuxAvailable({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform === 'win32') return false;
  try {
    execFileSyncImpl('tmux', ['-V'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function tmuxSessionExists(sessionName, {
  execFileSyncImpl = execFileSync,
} = {}) {
  try {
    execFileSyncImpl('tmux', ['has-session', '-t', sessionName], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function killTmuxSession(sessionName, {
  execFileSyncImpl = execFileSync,
} = {}) {
  if (!tmuxSessionExists(sessionName, { execFileSyncImpl })) return false;
  try {
    execFileSyncImpl('tmux', ['kill-session', '-t', sessionName], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function getTmuxPanePid(sessionName, {
  execFileSyncImpl = execFileSync,
} = {}) {
  try {
    const output = execFileSyncImpl('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_pid}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const firstLine = String(output || '').trim().split(/\r?\n/).find(Boolean) || '';
    return parsePositiveInt(firstLine);
  } catch {
    return null;
  }
}

export const WORKER_SECRET_ENV_VARS = Object.freeze([
  'COPILOT_PROVIDER_API_KEY',
  'CURSOR_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'DEEPSEEK_API_KEY',
  'OAR_CLAUDE_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]);

// Secrets that are not every worker's: each entry names the kinds that get
// it, and every other kind has it taken out of its launch environment on
// every path (withoutForeignWorkerSecrets), and out of the tmux shell
// (buildTmuxWorkerShellCommand). A secret with no entry is every kind's.
//
// - The two API keys without an entry are put into the launch environment by
//   their own provider's applier and cleared for every other one.
// - The Claude login token sits in the relay's own environment (a relay run on
//   CLAUDE_CODE_OAUTH_TOKEN instead of the CLI's credentials file), so it
//   would otherwise travel with every launch. Only the two workers of the
//   host's own Claude account get it: the Claude Cloud worker's client reads
//   the login from there exactly as the relay's does (credentials.mjs), and
//   the Claude worker's CLI prefers it to the credentials file.
// - The DeepSeek key is put there by its own applier, but the same name could
//   also sit in the relay's environment (a shell that exports it); it is the
//   DeepSeek worker's alone either way.
// - The Claude API key is the Claude API worker's alone, the same way. It
//   travels under a name of the relay's (OAR_CLAUDE_API_KEY), never as
//   ANTHROPIC_API_KEY: the worker's CLI is the only process that gets it under
//   that name (claude-api-backend.mjs), and a host's ANTHROPIC_API_KEY stays
//   what it is below, no worker's.
// - A host's ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are no worker's (an
//   empty list): Claude Code prefers either to the Claude login, so a Claude
//   chat would run, and be billed, on a key nobody chose for it, and every
//   other kind has no use for them. A key a provider saves in the relay's
//   settings goes to its own kind under a name of its own, with an entry
//   here naming that kind alone.
const WORKER_SECRET_ENV_VAR_KINDS = Object.freeze({
  CLAUDE_CODE_OAUTH_TOKEN: Object.freeze(['claude', 'claude-cloud']),
  DEEPSEEK_API_KEY: Object.freeze(['deepseek']),
  OAR_CLAUDE_API_KEY: Object.freeze(['claude-api']),
  ANTHROPIC_API_KEY: Object.freeze([]),
  ANTHROPIC_AUTH_TOKEN: Object.freeze([]),
});

/**
 * The secret variables the worker of this launch environment is handed, and
 * only through the secret env file: never as a tmux `export`, never in the
 * environment tmux itself is started with.
 */
export function workerSecretEnvVarsFor(env = {}) {
  const kind = resolveWorkerKind(env);
  return WORKER_SECRET_ENV_VARS.filter((key) => {
    const kinds = WORKER_SECRET_ENV_VAR_KINDS[key];
    return !kinds || kinds.includes(kind);
  });
}

/**
 * The launch environment without the secrets that are another kind's. They
 * would otherwise reach the worker on the detached and Windows paths, which
 * hand the environment over as it is, and under tmux through the environment
 * a tmux server started by the launch keeps as its global one.
 */
export function withoutForeignWorkerSecrets(env = {}) {
  const own = new Set(workerSecretEnvVarsFor(env));
  const next = { ...env };
  for (const key of WORKER_SECRET_ENV_VARS) {
    if (!own.has(key)) delete next[key];
  }
  return next;
}

// The host Claude Code session's variables (a relay started from inside a
// Claude Code session) are dropped from every launch path, for every kind:
// the names and families are in shared/host-claude-session-env.mjs, with
// what stays and why. Under tmux the worker's command unsets them again, by
// family too, from whatever the tmux server's environment holds
// (buildTmuxWorkerShellCommand).
export { HOST_CLAUDE_SESSION_ENV_VARS, withoutHostClaudeSessionVariables };

export function createWorkerSecretEnvFile(env = {}, {
  fsImpl = fs,
  tempRoot = os.tmpdir(),
} = {}) {
  const secretLines = [];
  for (const key of workerSecretEnvVarsFor(env)) {
    const value = String(env?.[key] || '').trim();
    if (!value) continue;
    secretLines.push(`export ${key}=${shellQuote(value)}\n`);
  }
  if (!secretLines.length) return null;
  const directoryPath = fsImpl.mkdtempSync(path.join(tempRoot, 'copilot-relay-worker-'));
  fsImpl.chmodSync(directoryPath, 0o700);
  const filePath = path.join(directoryPath, 'provider.env');
  fsImpl.writeFileSync(
    filePath,
    secretLines.join(''),
    { encoding: 'utf8', mode: 0o600 },
  );
  fsImpl.chmodSync(filePath, 0o600);
  return {
    filePath,
    cleanup() {
      fsImpl.rmSync(filePath, { force: true });
      fsImpl.rmdirSync(directoryPath);
    },
  };
}

/**
 * Where a worker's stdout/stderr land. Before this existed workers ran with
 * their output discarded (`stdio: 'ignore'` / bare tmux exec), so a crash
 * left zero forensic trail — the failure mode that made the 2026-08-11
 * incident undiagnosable. Best-effort by design: a log problem must never
 * block a worker spawn. Naive rotation: >10 MB rolls to `<file>.1`, checked
 * at each launch on every platform.
 */
function resolveWorkerLogDir(launchEnv = {}, { pathImpl = path } = {}) {
  const explicitDir = normalizeText(launchEnv?.COPILOT_WEB_RELAY_LOG_DIR);
  const serverDir = normalizeText(launchEnv?.COPILOT_WEB_RELAY_SERVER_DIR);
  // `new URL(...).pathname` yields '/C:/git/...' on Windows, which pathImpl.join
  // then mangles into '\C:\git\...'; fileURLToPath decodes it to a real host path.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return explicitDir
    || (serverDir ? pathImpl.join(serverDir, 'logs') : pathImpl.join(moduleDir, '..', 'logs'));
}

function safeWorkerFileId(targetSessionId) {
  return String(targetSessionId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'worker';
}

export function prepareWorkerLogFile(targetSessionId, launchEnv = {}, {
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  try {
    const baseDir = resolveWorkerLogDir(launchEnv, { pathImpl });
    fsImpl.mkdirSync(baseDir, { recursive: true });
    const safeId = safeWorkerFileId(targetSessionId);
    const logPath = pathImpl.join(baseDir, `worker-${safeId}.log`);
    try {
      const stats = fsImpl.statSync(logPath);
      if (stats.size > 10 * 1024 * 1024) fsImpl.renameSync(logPath, `${logPath}.1`);
    } catch {}
    return logPath;
  } catch {
    return null;
  }
}

// What a tmux worker is handed as `export`s in its own shell command. These
// are the values of one launch (the kind of worker, its model, its folder),
// so they never go into the environment tmux itself is started with: a tmux
// server started by a launch keeps that as its global environment, and every
// later session on the server would inherit the first launch's values where
// its own command exports none (launchSessionCli takes them out).
export const TMUX_WORKER_EXPORTED_ENV_VARS = Object.freeze([
  'COPILOT_ALLOW_ALL',
  'GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS',
  'COPILOT_WEB_RELAY_ROOT',
  'COPILOT_WEB_RELAY_SERVER_DIR',
  'COPILOT_WEB_RELAY_CONFIG',
  'COPILOT_WEB_RELAY_TOOLS',
  'COPILOT_WEB_RELAY_LOG_DIR',
  // The Cursor worker keeps its agent stores in the relay's data dir
  // (applyCursorProviderEnvironment).
  'COPILOT_WEB_RELAY_DATA_DIR',
  'COPILOT_WEB_RELAY_CLI_EXECUTABLE',
  'COPILOT_WEB_RELAY_EXTENSION_BOOTSTRAP_PATH',
  'COPILOT_SDK_PATH',
  'EXTENSION_PATH',
  'COPILOT_PROVIDER_TYPE',
  'COPILOT_PROVIDER_BASE_URL',
  'COPILOT_PROVIDER_WIRE_API',
  'COPILOT_MODEL',
  'COPILOT_WEB_RELAY_WORKER_KIND',
  // The SDK worker's own model and BYOK context overrides. `COPILOT_MODEL`
  // above is the extension engine's model variable and is read by the CLI's
  // startup layer; the SDK worker takes its default model from
  // `COPILOT_RELAY_MODEL`, matching every other Node worker's
  // `*_RELAY_MODEL`. Without it here the model would silently drop to the
  // runtime default on the tmux path while working on the detached path,
  // which inherits the whole environment.
  'COPILOT_RELAY_MODEL',
  'COPILOT_PROVIDER_MAX_PROMPT_TOKENS',
  'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS',
  // Without this the tmux path would fall back to ~/.claude while the relay
  // (and the detached spawn path, which inherits the full environment) uses
  // the override — worker and relay would read different config roots.
  'CLAUDE_CONFIG_DIR',
  // Same divergence, one variable over: the relay binds a resolved `claude`
  // binary onto its own environment (cli-install-service.mjs §4.3), and the
  // detached path inherits it for free. Without it here a bound binary would
  // be silently dropped on the tmux path and the worker would fall back to
  // whatever `claude` PATH happens to resolve — exactly the failure mode
  // CLAUDE_CONFIG_DIR above was added for. GROK_CLI_COMMAND, its Grok
  // counterpart, has always been on this list.
  'CLAUDE_CODE_EXECUTABLE',
  'CLAUDE_RELAY_MODEL',
  // The Claude Cloud worker's model. Its login is not listed here: the
  // worker reads the CLI's credentials file (CLAUDE_CONFIG_DIR above tells
  // it where), and a relay-level CLAUDE_CODE_OAUTH_TOKEN is a secret
  // (workerSecretEnvVarsFor), so it comes through the secret file.
  'CLAUDE_CLOUD_RELAY_MODEL',
  // Tests point the relay's cloud client at a fake API on this machine;
  // the worker's client has to follow, or the relay would talk to the fake
  // and its worker to the real API. Not a secret, and harmless as a value:
  // shared/claude-cloud/base-url.mjs ignores everything but a loopback URL.
  'OAR_CLAUDE_CLOUD_API_BASE_URL',
  'CURSOR_RELAY_MODEL',
  'CURSOR_AGENT_STORE_DIR',
  // The DeepSeek worker's model, endpoint and Claude Code state directory.
  // Its key is a secret (workerSecretEnvVarsFor) and comes through the file.
  'DEEPSEEK_RELAY_MODEL',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_CLAUDE_CONFIG_DIR',
  // The Claude API worker's model; its key comes through the file like
  // DeepSeek's. Tests point the worker's CLI at a fake Anthropic API on this
  // machine the way they point the cloud client (shared/anthropic-api.mjs
  // takes a loopback URL only, and so does the worker).
  'CLAUDE_API_RELAY_MODEL',
  'OAR_ANTHROPIC_API_BASE_URL',
  'GROK_RELAY_MODEL',
  'GROK_CLI_COMMAND',
  'GROK_ALWAYS_APPROVE',
  // The OAR MCP server kill switch (the Grok worker reads it too), and the
  // extension engine's "it is attached" marker.
  'OAR_MCP_SERVER',
  'OAR_MCP_SERVER_ATTACHED',
  'SESSION_ID',
  'COPILOT_WORKSPACE_ROOT',
  'INIT_CWD',
]);

export function buildTmuxWorkerShellCommand(targetSessionId, env = {}, {
  secretEnvFilePath = '',
  workerLogPath = '',
  // Extension engine only: appended to the CLI command, each shell-quoted
  // (and quoted again with it for `script -c`).
  extraCliArgs = [],
} = {}) {
  const launchEnv = {
    ...env,
    SESSION_ID: String(targetSessionId || '').trim() || String(env?.SESSION_ID || '').trim(),
  };
  const hasSecretEnvValue = workerSecretEnvVarsFor(launchEnv)
    .some((key) => String(launchEnv[key] || '').trim());
  const normalizedSecretEnvFilePath = String(secretEnvFilePath || '').trim();
  if (hasSecretEnvValue && !normalizedSecretEnvFilePath) {
    throw new Error('worker-secret-env-file-required');
  }
  const exports = [];
  const exported = new Set();
  for (const key of TMUX_WORKER_EXPORTED_ENV_VARS) {
    const value = String(launchEnv?.[key] || '').trim();
    if (!value) continue;
    exports.push(`${key}=${shellQuote(value)}`);
    exported.add(key);
  }
  // A new tmux session starts from the server's global environment, which is
  // the environment the server was started with: tmux takes the environment
  // of `new-session` only when it starts the server. So the cleaning of that
  // environment (launchSessionCli) reaches a worker only on the first launch;
  // a server that was started from inside a Claude Code session, or by an
  // older relay, hands every later worker the host session's variables and
  // the first launch's values. The command therefore unsets, before anything
  // else, the host session's variables and every per-launch variable this
  // launch exports no value for (unset of an absent name is a no-op in sh).
  // With them the worker log file a relay started from inside a worker
  // session inherited, and every secret this launch carries no value for —
  // other kinds' and its own alike — which a tmux server started from a shell
  // that exports them keeps: names only. The worker's own secrets come
  // through the secret file alone, sourced after the unset, so a key the
  // launch does carry is restored from there. A second statement then unsets
  // every variable of the host session's families the shell holds, names a
  // fixed list would miss included.
  const ownSecrets = new Set(workerSecretEnvVarsFor(launchEnv));
  const unset = [
    ...HOST_CLAUDE_SESSION_ENV_VARS,
    WORKER_LOG_FILE_ENV,
    ...TMUX_WORKER_EXPORTED_ENV_VARS.filter((key) => !exported.has(key)),
    ...WORKER_SECRET_ENV_VARS.filter((key) => !ownSecrets.has(key) || !String(launchEnv?.[key] ?? '').trim()),
  ];
  // `sh -lc` builds PATH from the login profile, not from the relay's; the
  // relay's Node folder goes at its end when it is not on it (see
  // appendNodeDirectoryToPath).
  const statements = [`unset ${unset.join(' ')};`, hostClaudeSessionUnsetStatement(), ...exports.map((entry) => `export ${entry};`)];
  const nodeDirectory = resolveWorkerNodeDirectory(launchEnv);
  if (nodeDirectory) {
    const quotedDir = shellQuote(nodeDirectory);
    statements.push(`case ":$PATH:" in *:${quotedDir}:*) ;; *) PATH="$PATH:"${quotedDir};; esac; export PATH;`);
  }
  const prefix = statements.length ? `${statements.join(' ')} ` : '';
  const secretPrefix = normalizedSecretEnvFilePath
    ? `. ${shellQuote(normalizedSecretEnvFilePath)} || exit $?; rm -f ${shellQuote(normalizedSecretEnvFilePath)}; rmdir ${shellQuote(path.dirname(normalizedSecretEnvFilePath))}; `
    : '';
  const workerCommand = buildPosixWorkerLaunchCommand(targetSessionId, launchEnv, extraCliArgs);
  if (resolveNodeWorkerDescriptor(launchEnv)) {
    // Node workers (Claude, Cursor, Grok) are plain processes; no pseudo-TTY
    // needed. Their output is teed to the worker log so a crash leaves a
    // trail (the Copilot CLI keeps its own logs and draws a TUI, so it is
    // deliberately not teed).
    const teeSuffix = String(workerLogPath || '').trim()
      ? ` >> ${shellQuote(workerLogPath)} 2>&1`
      : '';
    return `${prefix}${secretPrefix}exec ${workerCommand}${teeSuffix}`;
  }
  // Use script to create a pseudo-TTY without GH_FORCE_TTY so the CLI routes
  // ask_user requests through the SDK's onUserInputRequest handler instead of
  // drawing terminal prompts.
  return `${prefix}${secretPrefix}exec script -q -c ${shellQuote(workerCommand)} /dev/null`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How a spawned child ended, filled in as it happens. */
function watchChildExit(child) {
  const state = { tracked: typeof child?.on === 'function', exited: false, code: null, signal: null, error: null };
  if (!state.tracked) return state;
  try {
    // A listener also keeps a failed spawn's 'error' from going unhandled.
    child.on('error', (error) => { state.error = error; });
    child.on('exit', (code, signal) => {
      state.exited = true;
      state.code = code;
      state.signal = signal;
    });
  } catch {
    state.tracked = false;
  }
  return state;
}

/**
 * Why `cmd /c start <program>` did not start the worker, or null when nothing
 * says it failed. Exported for the tests.
 */
export function describeWindowsStartFailure(state, { spawnCommand = 'cmd.exe', program = 'node' } = {}) {
  if (!state?.tracked) return null;
  if (state.error) {
    return `worker-spawn-failed: could not run ${spawnCommand} (${state.error.code || state.error.message || 'error'})`;
  }
  if (!state.exited) {
    return `worker-spawn-failed: Windows could not start ${program} (start did not return; it may be showing an error dialog)`;
  }
  if (state.code !== 0) {
    const how = state.code === null || state.code === undefined ? `signal ${state.signal || 'unknown'}` : `exit code ${state.code}`;
    return `worker-spawn-failed: Windows could not start ${program} (start ended with ${how})`;
  }
  return null;
}

/**
 * A spawn whose folder is gone fails with ENOENT (or ENOTDIR), which reads as
 * a missing program (`node`, `cmd.exe`). Asked only after a spawn failed: the folder
 * is named instead, or null when it is there. Exported for the tests.
 * (A tmux launch never gets here: `new-session -c` falls back to the home
 * folder, and the worker reports the folder on the turn.)
 */
export function describeLaunchFolderFailure(state, folder, { check = missingWorkingDirectoryError } = {}) {
  if (state?.error?.code !== 'ENOENT' && state?.error?.code !== 'ENOTDIR') return null;
  const missing = check(folder);
  return missing ? `worker-spawn-failed: ${missing.message}` : null;
}

function buildWorkerLaunchEnv({ processCwd, workspaceRoot, env = process.env } = {}) {
  const launchProcessCwd = String(processCwd || '').trim();
  const launchWorkspaceRoot = String(workspaceRoot || '').trim() || launchProcessCwd;
  if (!launchProcessCwd && !launchWorkspaceRoot) return env;
  const launchEnv = {
    ...env,
    COPILOT_ALLOW_ALL: 'true',
    GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'true',
    ...(launchWorkspaceRoot ? {
      COPILOT_WORKSPACE_ROOT: launchWorkspaceRoot,
      INIT_CWD: launchWorkspaceRoot,
    } : {}),
    ...(launchProcessCwd ? { PWD: launchProcessCwd } : {}),
  };
  // COPILOT_ALLOW_ALL matches the --allow-all launch flag and lets headless
  // workers pass folder trust before extension activation. The global wrapper
  // handles outside-package workers and defers to the project extension inside
  // this package, so workers must not force both.
  delete launchEnv.COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION;
  return launchEnv;
}

export async function launchSessionCli({
  targetSessionId,
  cwd,
  processCwd = '',
  workspaceRoot = '',
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  execFileSyncImpl = execFileSync,
  processInspector = null,
  tmuxPollAttempts = 4,
  tmuxPollDelayMs = 200,
  detachedPollAttempts = 10,
  detachedPollDelayMs = 200,
  // win32: how much longer a `start` still running after the polls gets to
  // return before the launch counts as failed (a busy boot can be slow).
  windowsStartGraceMs = 3_000,
  allowProcessReuse = true,
  createSecretEnvFileImpl = createWorkerSecretEnvFile,
  // Extension engine: writes the session's OAR MCP config, returns its path
  // (or null to launch without it).
  prepareOarMcpConfigImpl = prepareOarMcpConfigFile,
  // Windows console launch: resolves (and rotates) the worker log the worker
  // then writes itself; returns its path or null.
  prepareWorkerLogFileImpl = prepareWorkerLogFile,
  // Told when the process list could not be read (the error); the launch
  // goes on without it.
  onProcessListError = null,
  // Where a launch that went wrong explains itself (one line per call).
  log = null,
  locateExecutableImpl = locateExecutable,
  // Asked after a failed spawn whether its folder is gone (the error, or null).
  checkWorkingDirectoryImpl = missingWorkingDirectoryError,
  // Under a systemd user service: puts the worker in a scope of its own
  // (worker-scope.mjs). None: the worker starts as it is.
  workerScope = null,
} = {}) {
  const target = String(targetSessionId || '').trim();
  if (!target) throw new Error('missing-target-session-id');

  // On win32 the process list comes from PowerShell and can be unreadable for
  // a reason that has nothing to do with this session (2026-10-01: a control
  // byte in another process's command line, for an hour). A launch is not
  // stopped by that: an unreadable list counts as "no process found".
  // The asynchronous finder reads the list off the relay's thread (shared
  // between concurrent callers, cached for a moment); `fresh` is for the poll
  // that waits for the process this launch just started.
  const findLiveProcess = async ({ fresh = false } = {}) => {
    if (typeof processInspector?.findProcessForSessionAsync !== 'function') return null;
    try {
      return (await processInspector.findProcessForSessionAsync(target, { fresh })) || null;
    } catch (error) {
      try { onProcessListError?.(error); } catch {}
      return null;
    }
  };

  // Kill switch for test/e2e servers: a relay started with this env var must
  // never spawn real session workers (Copilot CLI clients or Claude workers).
  if (String(env?.COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN || '').trim()) {
    throw new Error('cli-spawn-disabled');
  }

  if (allowProcessReuse) {
    const liveProcess = await findLiveProcess();
    const liveProcessPid = parsePositiveInt(liveProcess?.processId);
    if (liveProcessPid && isPidAlive(liveProcessPid)) {
      return {
        pid: liveProcessPid,
        reused: true,
        launchMode: platform === 'win32' ? 'detached' : 'existing',
        tmuxSessionName: null,
      };
    }
  }

  const launchWorkspaceRoot = String(workspaceRoot || cwd || process.cwd());
  const launchProcessCwd = String(processCwd || cwd || process.cwd());
  const launchEnv = buildWorkerLaunchEnv({
    processCwd: launchProcessCwd,
    workspaceRoot: launchWorkspaceRoot,
    env,
  });
  // Every path below starts from this environment, so a secret that is not
  // this kind's, and the host Claude Code session's variables, are gone
  // before any of them sees it.
  const launchSessionEnv = withoutHostClaudeSessionVariables(withoutForeignWorkerSecrets({
    ...appendNodeDirectoryToPath(launchEnv, resolveWorkerNodeDirectory(launchEnv, { platform }), { platform }),
    SESSION_ID: target,
  }));
  const explain = (message) => {
    try { log?.(`worker launcher: session=${target.slice(0, 8)} ${message}`); } catch {}
  };
  const spawnEnvironmentText = () => describeSpawnEnvironment(launchSessionEnv, platform);
  // Set per launch below, never inherited: a relay started from inside a
  // worker session would otherwise hand its workers that session's log.
  delete launchSessionEnv[WORKER_LOG_FILE_ENV];
  // The extension engine gets the OAR MCP server (relay_tool + preview) the
  // node workers carry in-process; every launch path appends the same args.
  const extensionCliArgs = resolveNodeWorkerDescriptor(launchSessionEnv)
    ? []
    : oarMcpCliArgs(prepareOarMcpConfigImpl(target, launchSessionEnv));
  // Tells the in-CLI web-relay extension that `preview` is a real tool in this
  // session, so its prompt context need not teach the HTTP fallback.
  if (extensionCliArgs.length) launchSessionEnv.OAR_MCP_SERVER_ATTACHED = '1';

  // A Node that is not there fails loudly here instead of quietly later (on
  // Windows, `start` shows its error in a dialog no one may be able to see).
  if (resolveNodeWorkerDescriptor(launchSessionEnv)) {
    const nodeExecutable = resolveWorkerNodeExecutable(launchSessionEnv);
    if (!locateExecutableImpl(nodeExecutable, { env: launchSessionEnv, platform })) {
      const overridden = Boolean(normalizeText(launchSessionEnv.COPILOT_WEB_RELAY_NODE));
      explain(`cannot start: Node "${nodeExecutable}"${overridden ? ' (COPILOT_WEB_RELAY_NODE)' : ''} was not found; ${spawnEnvironmentText()}`);
      throw new Error(`worker-node-not-found: ${nodeExecutable}${overridden ? ' (set by COPILOT_WEB_RELAY_NODE)' : ''}`);
    }
  }

  if (isTmuxAvailable({ platform, execFileSyncImpl })) {
    const sessionName = normalizeTmuxSessionName(target);
    const tmuxEnv = { ...launchSessionEnv };
    delete tmuxEnv.TMUX;
    delete tmuxEnv.TMUX_PANE;
    // No secret is in the environment tmux is started with (a tmux server
    // started by this call would keep it as its global one): this kind's go
    // through the secret file, the others are already gone. Nor is anything
    // of this launch alone (worker kind, model, folder): the shell command
    // exports those per session.
    for (const key of WORKER_SECRET_ENV_VARS) delete tmuxEnv[key];
    for (const key of TMUX_WORKER_EXPORTED_ENV_VARS) delete tmuxEnv[key];
    delete tmuxEnv.PWD;
    if (allowProcessReuse) {
      const existingPanePid = getTmuxPanePid(sessionName, { execFileSyncImpl });
      if (existingPanePid && isPidAlive(existingPanePid)) {
        return {
          pid: existingPanePid,
          reused: true,
          launchMode: 'tmux',
          tmuxSessionName: sessionName,
        };
      }
    }
    killTmuxSession(sessionName, { execFileSyncImpl });
    const secretEnvFile = createSecretEnvFileImpl(launchSessionEnv);
    const tmuxWorkerLogPath = resolveNodeWorkerDescriptor(launchSessionEnv)
      ? prepareWorkerLogFile(target, launchSessionEnv)
      : null;
    try {
      const tmuxArgs = [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-c',
        launchProcessCwd,
        'sh',
        '-lc',
        buildTmuxWorkerShellCommand(target, launchSessionEnv, {
          secretEnvFilePath: secretEnvFile?.filePath,
          workerLogPath: tmuxWorkerLogPath || '',
          extraCliArgs: extensionCliArgs,
        }),
      ];
      // A tmux server this call starts is in the worker's own scope.
      const tmuxLaunch = workerScope ? workerScope.wrap('tmux', tmuxArgs) : { command: 'tmux', args: tmuxArgs };
      execFileSyncImpl(tmuxLaunch.command, tmuxLaunch.args, {
        env: tmuxEnv,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (error) {
      secretEnvFile?.cleanup?.();
      throw error;
    }
    const attempts = Math.max(1, Number(tmuxPollAttempts) || 1);
    for (let index = 0; index < attempts; index += 1) {
      await sleep(Math.max(50, Number(tmuxPollDelayMs) || 200));
      const processMatch = await findLiveProcess({ fresh: true });
      if (processMatch?.processId) {
        return {
          pid: Number(processMatch.processId),
          reused: false,
          launchMode: 'tmux',
          tmuxSessionName: sessionName,
        };
      }
      const panePid = getTmuxPanePid(sessionName, { execFileSyncImpl });
      if (panePid && isPidAlive(panePid)) {
        return {
          pid: panePid,
          reused: false,
          launchMode: 'tmux',
          tmuxSessionName: sessionName,
        };
      }
    }
    throw new Error('worker-spawn-unhealthy:tmux-pane-missing');
  }

  const nodeWorker = resolveNodeWorkerDescriptor(launchSessionEnv);
  const nodeWorkerExecutable = resolveWorkerNodeExecutable(launchSessionEnv);
  const posixCliExecutable = normalizeText(launchSessionEnv.COPILOT_WEB_RELAY_CLI_EXECUTABLE)
    || normalizeText(launchSessionEnv.COPILOT_CLI_EXECUTABLE)
    || normalizeText(launchSessionEnv.COPILOT_CLI_PATH)
    || 'copilot';
  // win32: Node quotes every argument that holds a space or a tab, so
  // `start "<title>" "C:\Program Files\nodejs\node.exe" ...` reaches cmd.exe
  // with the title and the path each in one piece; `/s` strips nothing here
  // because the line after `/c` starts with `start`, not a quote. The title
  // always holds a space, so `start` never mistakes the program for it.
  const spawnCommand = platform === 'win32'
    ? windowsCmdPath({ env: launchSessionEnv })
    : (nodeWorker ? nodeWorkerExecutable : posixCliExecutable);
  const startedProgram = nodeWorker ? nodeWorkerExecutable : (platform === 'win32' ? 'gh' : posixCliExecutable);
  const spawnArgs = platform === 'win32'
    ? (nodeWorker
      ? [
        '/d',
        '/s',
        '/c',
        'start',
        `${nodeWorker.windowsTitle} ${target.slice(0, 8)}`,
        nodeWorkerExecutable,
        nodeWorker.scriptPath,
        '--session-id',
        target,
      ]
      : [
        '/d',
        '/s',
        '/c',
        'start',
        `Copilot Worker ${target.slice(0, 8)}`,
        'gh',
        'copilot',
        '--',
        '--allow-all',
        '--session-id',
        target,
        ...extensionCliArgs,
      ])
    : (nodeWorker
      ? [nodeWorker.scriptPath, '--session-id', target]
      : ['--allow-all', '--session-id', target, ...extensionCliArgs]);
  // POSIX node workers tee stdout/stderr into the worker log (a crash must
  // leave a trail). On win32 the `start` intermediary opens its own console,
  // so fd inheritance cannot reach the worker, and a shell redirect would
  // leave its window empty: the worker is told the file and copies its own
  // output into it (shared/worker-runtime/worker-log-file.mjs). Only the path
  // travels; nothing of the environment or command line is written to the log.
  let detachedStdio = 'ignore';
  if (platform === 'win32' && nodeWorker) {
    const workerLogPath = prepareWorkerLogFileImpl(target, launchSessionEnv);
    if (workerLogPath) launchSessionEnv[WORKER_LOG_FILE_ENV] = workerLogPath;
  }
  if (platform !== 'win32' && nodeWorker) {
    const workerLogPath = prepareWorkerLogFile(target, launchSessionEnv);
    if (workerLogPath) {
      try {
        const logFd = fs.openSync(workerLogPath, 'a');
        detachedStdio = ['ignore', logFd, logFd];
      } catch {
        detachedStdio = 'ignore';
      }
    }
  }
  // POSIX: in a scope of its own under a systemd user service; the process
  // id is still the worker's.
  const detachedLaunch = platform !== 'win32' && workerScope ? workerScope.wrap(spawnCommand, spawnArgs) : { command: spawnCommand, args: spawnArgs };
  const child = spawnImpl(detachedLaunch.command, detachedLaunch.args, {
    cwd: launchProcessCwd,
    env: launchSessionEnv,
    detached: true,
    stdio: detachedStdio,
    windowsHide: platform !== 'win32',
  });
  const childState = watchChildExit(child);
  child.unref?.();
  if (Array.isArray(detachedStdio) && typeof detachedStdio[1] === 'number') {
    // The child inherited the descriptor; the parent's copy must not leak.
    try { fs.closeSync(detachedStdio[1]); } catch {}
  }
  if (platform === 'win32') {
    const attempts = Math.max(1, Number(detachedPollAttempts) || 1);
    for (let index = 0; index < attempts; index += 1) {
      await sleep(Math.max(50, Number(detachedPollDelayMs) || 200));
      const processMatch = await findLiveProcess({ fresh: true });
      const processPid = parsePositiveInt(processMatch?.processId);
      if (processPid && isPidAlive(processPid)) {
        return {
          pid: processPid,
          reused: false,
          launchMode: 'console',
          tmuxSessionName: null,
          child,
        };
      }
      if (childState.error || (childState.exited && childState.code !== 0)) break;
    }
    const graceUntil = Date.now() + Math.max(0, Number(windowsStartGraceMs) || 0);
    while (childState.tracked && !childState.exited && !childState.error && Date.now() < graceUntil) {
      await sleep(50);
    }
    // `cmd /c start` returns at once when the program started. Still running,
    // or ended with an error, means it did not: name the program, and log the
    // command and the PATH it was looked up on.
    const failure = describeLaunchFolderFailure(childState, launchProcessCwd, { check: checkWorkingDirectoryImpl })
      || describeWindowsStartFailure(childState, { spawnCommand, program: startedProgram });
    if (failure) {
      if (childState.tracked && !childState.exited) {
        try { child.kill?.(); } catch {}
      }
      explain(`${failure}; command: ${spawnCommand} ${spawnArgs.join(' ')}; ${spawnEnvironmentText()}`);
      throw new Error(failure);
    }
    explain(`no worker process seen after ${attempts} check${attempts === 1 ? '' : 's'}; it may still report in. program: ${startedProgram}; ${spawnEnvironmentText()}`);
    return {
      pid: null,
      reused: false,
      launchMode: 'console',
      tmuxSessionName: null,
      child,
    };
  }
  const pid = parsePositiveInt(child?.pid);
  if (!pid) {
    // A failed spawn reports its error on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
    const reason = childState.error?.code || childState.error?.message || '';
    const folderFailure = describeLaunchFolderFailure(childState, launchProcessCwd, { check: checkWorkingDirectoryImpl });
    if (folderFailure) {
      explain(`could not start ${spawnCommand}: ${folderFailure}`);
      throw new Error(folderFailure);
    }
    explain(`could not start ${spawnCommand}${reason ? ` (${reason})` : ''}; ${spawnEnvironmentText()}`);
    throw new Error(`worker-spawn-unhealthy:missing-pid${reason ? ` (${spawnCommand}: ${reason})` : ''}`);
  }
  return {
    pid,
    reused: false,
    launchMode: 'detached',
    tmuxSessionName: null,
    child,
  };
}
