#!/usr/bin/env node
// OAR's own stdio MCP server. It gives the agents OAR launches without an
// in-process tool surface — Grok (ACP `mcpServers`) and the Copilot CLI
// extension engine (`--additional-mcp-config`) — the relay's real tools:
// `remote_relay` and `preview`, bound to the one conversation it was started
// for, so the relay's mention gate and approval apply exactly as they do for
// the Claude, Cursor and Copilot SDK workers.
//
// Hand-written on purpose (no MCP SDK dependency): JSON-RPC 2.0 as
// newline-delimited JSON on stdin/stdout. stdout carries protocol frames ONLY;
// every diagnostic goes to stderr.
//
//   node server/mcp/oar-mcp-server.mjs --conversation-id <id>
//
// The relay is found the way the session workers find it: the config at
// COPILOT_WEB_RELAY_CONFIG (else server/config.json) supplies the token and
// port, COPILOT_WEB_RELAY_SERVER_URL overrides the address.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createApiClient } from '../../shared/worker-runtime/api-client.mjs';
import { loadTokenFromConfig, resolveRelayServerUrl } from '../../shared/worker-runtime/config-loader.mjs';
import {
  PREVIEW_TOOL_DESCRIPTION,
  PREVIEW_TOOL_INPUT_SCHEMA,
  PREVIEW_TOOL_NAME,
  executePreviewTool,
} from '../../shared/preview-tool-core.mjs';
import {
  REMOTE_RELAY_CALL_FAILED,
  REMOTE_RELAY_TOOL_CALL_TIMEOUT_MS,
  REMOTE_RELAY_TOOL_DESCRIPTION,
  REMOTE_RELAY_TOOL_NAME,
  cloneRemoteRelayToolInputSchema,
  executeRemoteRelayTool,
  formatRemoteRelayToolResult,
  shouldRegisterRemoteRelayTool,
} from '../../shared/remote-relay-tool-core.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);

/** The server name hosts register it under (`oar`), and its `serverInfo.name`. */
export const OAR_MCP_SERVER_NAME = 'oar';
export const OAR_MCP_SERVER_SCRIPT_PATH = MODULE_PATH;

export const OAR_MCP_DEFAULT_PROTOCOL_VERSION = '2025-06-18';
// Everything this server speaks is the tools subset every revision shares, so
// a client's requested revision is echoed back when it is one of these.
export const OAR_MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

// A host may start MCP servers with a trimmed environment, so the variables
// that locate the relay travel explicitly with the launch. None is a secret:
// the token stays in the config file the path points at.
export const OAR_MCP_RELAY_ENV_KEYS = Object.freeze([
  'COPILOT_WEB_RELAY_CONFIG',
  'COPILOT_WEB_RELAY_SERVER_URL',
  'COPILOT_WEB_RELAY_ROOT',
  'COPILOT_WEB_RELAY_SERVER_DIR',
]);

// How long a host should let one tool call run (for hosts that take a
// per-server timeout, like the Copilot CLI whose default is 180 s).
export const OAR_MCP_TOOL_TIMEOUT_MS = REMOTE_RELAY_TOOL_CALL_TIMEOUT_MS;

// Progress heartbeats for a long call, sent only when the client asked for
// progress. Hosts that reset their timeout on progress keep waiting.
const DEFAULT_PROGRESS_INTERVAL_MS = 25_000;

// After the host closes stdin: how long a call still waiting on the relay may
// keep the process up before it is cut off.
const SHUTDOWN_GRACE_MS = 2_000;

const JSON_RPC = Object.freeze({
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
});

function toText(value) {
  return String(value ?? '').trim();
}

/**
 * The operator's kill switch: `OAR_MCP_SERVER=0|false|off|no` keeps this
 * server out of every session OAR launches (Grok falls back to its preview
 * instruction block, the extension engine starts without the extra config).
 */
export function isOarMcpServerDisabled(env = {}) {
  return /^(0|false|off|no)$/i.test(String(env?.OAR_MCP_SERVER || '').trim());
}

/** `--conversation-id <id>` or `--conversation-id=<id>`; '' when absent. */
export function parseConversationIdArg(argv = []) {
  const args = Array.isArray(argv) ? argv.map((arg) => String(arg ?? '')) : [];
  const index = args.indexOf('--conversation-id');
  if (index !== -1) return toText(args[index + 1]);
  const inline = args.find((arg) => arg.startsWith('--conversation-id='));
  return inline ? toText(inline.slice('--conversation-id='.length)) : '';
}

/**
 * How to start this server for one conversation: `{ command, args, env }`,
 * the neutral shape the Grok ACP wiring and the Copilot extension-engine
 * config are built from. `env` holds only the relay-locating variables that
 * are set in `env`.
 */
export function buildOarMcpServerLaunch({
  nodePath = process.execPath,
  conversationId = '',
  env = process.env,
  scriptPath = MODULE_PATH,
} = {}) {
  const id = toText(conversationId);
  if (!id) throw new Error('oar-mcp-server: a conversation id is required');
  const command = toText(nodePath);
  if (!command) throw new Error('oar-mcp-server: a node executable is required');
  const launchEnv = {};
  for (const key of OAR_MCP_RELAY_ENV_KEYS) {
    const value = toText(env?.[key]);
    if (value) launchEnv[key] = value;
  }
  return { command, args: [toText(scriptPath), '--conversation-id', id], env: launchEnv };
}

function readPackageVersion() {
  try {
    const packagePath = path.resolve(path.dirname(MODULE_PATH), '..', '..', 'package.json');
    return toText(JSON.parse(fs.readFileSync(packagePath, 'utf8'))?.version) || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function toolDefinitions({ remoteRelay }) {
  return [
    ...(remoteRelay ? [{
      name: REMOTE_RELAY_TOOL_NAME,
      description: REMOTE_RELAY_TOOL_DESCRIPTION,
      inputSchema: cloneRemoteRelayToolInputSchema(),
    }] : []),
    {
      name: PREVIEW_TOOL_NAME,
      description: PREVIEW_TOOL_DESCRIPTION,
      inputSchema: JSON.parse(JSON.stringify(PREVIEW_TOOL_INPUT_SCHEMA)),
    },
  ];
}

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

/**
 * The protocol core, transport-free: feed it parsed JSON-RPC messages
 * (`handleMessage`) or raw lines (`handleLine`) and it answers through `send`.
 * `remoteRelay` is the registration decision — a boolean or a promise of one;
 * the tool list waits for it, `initialize` and `ping` do not.
 */
export function createOarMcpServer({
  api,
  conversationId = '',
  remoteRelay = false,
  version = '0.0.0',
  send = () => {},
  log = () => {},
  progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS,
} = {}) {
  const conversation = toText(conversationId);
  const remoteRelayDecision = Promise.resolve(remoteRelay).then((value) => value === true, () => false);
  const inflight = new Map();

  function reply(id, result) {
    return { jsonrpc: '2.0', id, result };
  }

  function fail(id, code, message, data) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
  }

  async function listTools() {
    return toolDefinitions({ remoteRelay: await remoteRelayDecision });
  }

  async function runTool(name, args, signal) {
    if (name === REMOTE_RELAY_TOOL_NAME) {
      const result = await executeRemoteRelayTool(args, { api, conversationId: conversation, signal });
      return formatRemoteRelayToolResult(result);
    }
    const result = await executePreviewTool(args, { api, conversationId: conversation });
    return JSON.stringify(result);
  }

  function startProgress(progressToken) {
    if (progressToken === undefined || progressToken === null || !(Number(progressIntervalMs) > 0)) return () => {};
    let progress = 0;
    const timer = setInterval(() => {
      progress += 1;
      send({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken, progress, message: 'Still waiting for the relay…' },
      });
    }, progressIntervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async function callTool(id, params) {
    const name = toText(params?.name);
    const tools = await listTools();
    if (!tools.some((tool) => tool.name === name)) {
      return fail(id, JSON_RPC.invalidParams, `Unknown tool: ${name || '(none)'}`);
    }
    const args = params?.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? params.arguments
      : {};
    const entry = { cancelled: false, controller: new AbortController() };
    const key = requestKey(id);
    inflight.set(key, entry);
    const stopProgress = startProgress(params?._meta?.progressToken);
    try {
      const text = await runTool(name, args, entry.controller.signal);
      return entry.cancelled ? null : reply(id, { content: [{ type: 'text', text }] });
    } catch (error) {
      // The cores never throw by contract; this is the belt to their braces,
      // and still an answer the model can read rather than a protocol error.
      const message = error?.message || String(error);
      log(`tool ${name} failed: ${message}`);
      if (entry.cancelled) return null;
      return reply(id, {
        content: [{ type: 'text', text: formatRemoteRelayToolResult({ ok: false, code: REMOTE_RELAY_CALL_FAILED, error: message }) }],
        isError: true,
      });
    } finally {
      stopProgress();
      inflight.delete(key);
    }
  }

  async function handleRequest(message) {
    const { id, method, params } = message;
    switch (method) {
      case 'initialize': {
        const requested = toText(params?.protocolVersion);
        const protocolVersion = OAR_MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : OAR_MCP_DEFAULT_PROTOCOL_VERSION;
        return reply(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: OAR_MCP_SERVER_NAME, version },
        });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: await listTools() });
      case 'tools/call':
        return callTool(id, params);
      default:
        return fail(id, JSON_RPC.methodNotFound, `Method not found: ${method}`);
    }
  }

  // A cancelled call gets no answer (the spec's rule), and its relay request is
  // aborted: the relay then withdraws an open approval card and stops waiting
  // on the remote instead of working for nobody.
  function cancel(entry) {
    entry.cancelled = true;
    entry.controller.abort();
  }

  function handleNotification(message) {
    if (message.method === 'notifications/cancelled') {
      const entry = inflight.get(requestKey(message.params?.requestId));
      if (entry) cancel(entry);
    }
    // notifications/initialized and everything else need no answer.
  }

  /** Cancels every call still running (the host went away); returns how many. */
  function cancelAll() {
    let count = 0;
    for (const entry of inflight.values()) {
      if (entry.cancelled) continue;
      cancel(entry);
      count += 1;
    }
    return count;
  }

  /** One parsed message → its response, or null when none is due. */
  async function handleMessage(message) {
    if (Array.isArray(message)) {
      // Batches (2025-03-26): answer what needs answering, as one array.
      if (message.length === 0) return fail(null, JSON_RPC.invalidRequest, 'Empty batch');
      const responses = (await Promise.all(message.map((entry) => handleMessage(entry)))).filter(Boolean);
      return responses.length ? responses : null;
    }
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return fail(message?.id, JSON_RPC.invalidRequest, 'Invalid Request');
    }
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method !== 'string') {
      // A response to a request this server never sends: nothing to do.
      if (hasId && ('result' in message || 'error' in message)) return null;
      return fail(message.id, JSON_RPC.invalidRequest, 'Invalid Request');
    }
    if (!hasId) {
      handleNotification(message);
      return null;
    }
    try {
      return await handleRequest(message);
    } catch (error) {
      log(`${message.method} failed: ${error?.message || error}`);
      return fail(message.id, JSON_RPC.internalError, error?.message || 'Internal error');
    }
  }

  /** One raw stdin line; answers are sent as they are ready (ids correlate). */
  async function handleLine(line) {
    const text = String(line ?? '').trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      send(fail(null, JSON_RPC.parseError, 'Parse error'));
      return;
    }
    const response = await handleMessage(message);
    if (response) send(response);
  }

  return { handleLine, handleMessage, listTools, cancelAll };
}

/**
 * The stdio process: parse the arguments, reach the relay like a worker does,
 * decide whether `remote_relay` is listed (asked once, at startup), then serve
 * until stdin closes. Returns the server, or null after a startup failure.
 */
export async function runOarMcpServer({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  createApiClientImpl = createApiClient,
  shouldRegisterRemoteRelayToolImpl = shouldRegisterRemoteRelayTool,
  exit = (code) => process.exit(code),
} = {}) {
  const log = (message) => {
    try {
      stderr.write(`[oar-mcp ${new Date().toISOString()}] ${message}\n`);
    } catch {
      // stderr gone: nothing else to tell.
    }
  };
  const conversationId = parseConversationIdArg(argv);
  if (!conversationId) {
    log('missing --conversation-id <id>; this server serves exactly one conversation');
    exit(2);
    return null;
  }

  let api;
  try {
    const configPath = toText(env?.COPILOT_WEB_RELAY_CONFIG)
      || path.resolve(path.dirname(MODULE_PATH), '..', 'config.json');
    const serverUrl = resolveRelayServerUrl({ configPath, env });
    const token = loadTokenFromConfig(configPath);
    api = createApiClientImpl({
      serverUrl,
      token,
      // The conversation this server is bound to, named the way the workers
      // name theirs. No pid headers: this process is not a session worker and
      // must never be taken for one.
      getHeaders: () => ({
        'X-Relay-Session-Id': conversationId,
        'X-Relay-Conversation-Id': conversationId,
      }),
    });
  } catch (error) {
    log(`cannot reach the relay: ${error?.message || error}`);
    exit(1);
    return null;
  }

  let closed = false;
  const send = (message) => {
    if (closed) return;
    try {
      stdout.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      log(`stdout write failed: ${error?.message || error}`);
    }
  };
  const server = createOarMcpServer({
    api,
    conversationId,
    remoteRelay: Promise.resolve()
      .then(() => shouldRegisterRemoteRelayToolImpl({ api }))
      .then((enabled) => {
        log(`serving conversation ${conversationId.slice(0, 8)}; remote_relay ${enabled ? 'on' : 'off'}`);
        return enabled;
      }),
    version: readPackageVersion(),
    send,
    log,
  });

  const lines = readline.createInterface({ input: stdin, crlfDelay: Infinity });
  // The host ends the session by closing stdin (or by vanishing: EPIPE). The
  // process then leaves through the event loop rather than process.exit():
  // on Windows an exit in the instant a fetch settles trips a libuv assertion
  // (src\win\async.c, `!(handle->flags & UV_HANDLE_CLOSING)`) and dies with
  // 0xC0000409. Calls still waiting on the relay are cancelled (nobody is
  // left to read their answer, and the relay should stop working for them),
  // which empties the loop; the grace timer is the backstop.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    closed = true;
    const cancelled = server.cancelAll();
    if (cancelled) log(`host hung up: cancelled ${cancelled} call(s) still waiting on the relay`);
    lines.close();
    const timer = setTimeout(() => exit(0), SHUTDOWN_GRACE_MS);
    timer.unref?.();
  };
  stdout.on?.('error', (error) => {
    log(`stdout closed: ${error?.message || error}`);
    shutdown();
  });
  lines.on('line', (line) => {
    server.handleLine(line).catch((error) => log(`message handling failed: ${error?.message || error}`));
  });
  lines.on('close', shutdown);
  return server;
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const normalize = (value) => {
      const resolved = fs.realpathSync(path.resolve(value));
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return normalize(entry) === normalize(MODULE_PATH);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runOarMcpServer().catch((error) => {
    process.stderr.write(`oar-mcp-server fatal: ${error?.stack || error?.message || error}\n`);
    process.exit(1);
  });
}
