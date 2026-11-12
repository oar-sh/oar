#!/usr/bin/env node
// A stand-in for the Claude session worker, for
// tests/agent-sdk-first-chat.spec.mjs. The relay launches it through
// COPILOT_WEB_RELAY_CLAUDE_WORKER_PATH exactly as it launches the real one
// (`node <script> --session-id <id>`); the file name ends in
// `-session-worker` so the relay's process lookup finds it, as it finds every
// node worker.
//
// It loads no SDK and asks no model. It records what it was launched with
// (the agent SDK folder above all) into `worker-records/` beside the relay's
// config.json (the test relay's state root), then speaks the worker contracts
// of shared/worker-runtime: the socket link, the heartbeat, and one canned
// reply per delivered message.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBuildId } from '../../shared/build-id.mjs';
import { createApiClient } from '../../shared/worker-runtime/api-client.mjs';
import { createHeartbeatController } from '../../shared/worker-runtime/heartbeat.mjs';
import { createWorkerWebSocketLink } from '../../shared/worker-runtime/worker-websocket-link.mjs';

// The spec looks for this prefix (it does not import this file: importing it
// would run it).
const STAND_IN_REPLY_PREFIX = 'Stand-in worker reply:';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Never more than this: a run that lost its relay does not leave it behind.
const MAX_LIFE_MS = 5 * 60_000;

function sessionIdArg(argv = process.argv) {
  const at = argv.indexOf('--session-id');
  if (at >= 0 && argv[at + 1]) return String(argv[at + 1]).trim();
  return String(process.env.SESSION_ID || '').trim();
}

function readConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

const sessionId = sessionIdArg();
const configPath = String(process.env.COPILOT_WEB_RELAY_CONFIG || '').trim();
if (!sessionId || !configPath) {
  console.error('claude stand-in worker: needs --session-id and COPILOT_WEB_RELAY_CONFIG');
  process.exit(2);
}

const recordsDir = path.join(path.dirname(configPath), 'worker-records');
fs.mkdirSync(recordsDir, { recursive: true });
const sdkDir = String(process.env.OAR_AGENT_SDK_DIR_CLAUDE || '').trim() || null;
const recordFile = path.join(recordsDir, `${process.pid}.json`);
const record = {
  pid: process.pid,
  sessionId,
  kind: String(process.env.COPILOT_WEB_RELAY_WORKER_KIND || '').trim() || null,
  sdkDir,
  sdkEntryPresent: sdkDir ? fs.existsSync(path.join(sdkDir, 'entry.mjs')) : false,
  sdkMarkerPresent: sdkDir ? fs.existsSync(path.join(sdkDir, 'oar-sdk.json')) : false,
  startedAt: new Date().toISOString(),
  replies: [],
};
writeJson(recordFile, record);

const config = readConfig(configPath);
const serverUrl = `http://127.0.0.1:${Number(config.port) || 3333}`;
// The agent token the relay gives every session (the config holds no token).
const token = String(process.env.OAR_AGENT_TOKEN || '').trim();
const buildId = resolveBuildId(repoRoot).id;
const workerKind = record.kind || 'claude';
const log = (...parts) => console.log(`[claude stand-in ${new Date().toISOString()}]`, ...parts);

const api = createApiClient({
  serverUrl,
  token,
  getHeaders: () => ({
    'X-Relay-Process-Pid': String(process.pid),
    'X-Relay-Parent-Pid': String(process.ppid),
    'X-Relay-Session-Id': sessionId,
    'X-Relay-Conversation-Id': sessionId,
  }),
});

let activeMessageId = null;

async function answer(pending) {
  const message = pending?.message || pending;
  if (!message?.id) return false;
  activeMessageId = message.id;
  try {
    const text = `${STAND_IN_REPLY_PREFIX} ${String(message.text || '').trim()}`;
    const attempt = message.attemptId ? { attemptId: message.attemptId } : {};
    await api('POST', '/api/stream', {
      messageId: message.id,
      conversationId: message.conversationId,
      mode: message.relayMode || 'agent',
      text,
      done: true,
      ...attempt,
    }).catch(() => {});
    await api('POST', '/api/response', {
      messageId: message.id,
      conversationId: message.conversationId,
      text,
      model: message.providerModel || message.model || null,
      modelOrigin: 'manual',
      ...attempt,
    });
    record.replies.push({ messageId: message.id, text });
    writeJson(recordFile, record);
    log('answered', message.id);
    return true;
  } catch (error) {
    log('answer failed', error?.message || String(error));
    await api('POST', '/api/requeue', { messageId: message.id, ...(message.attemptId ? { attemptId: message.attemptId } : {}) }).catch(() => {});
    return false;
  } finally {
    activeMessageId = null;
  }
}

let heartbeatTimer = null;
const heartbeat = createHeartbeatController({
  api,
  buildId,
  workerKind,
  pollMs: 5_000,
  getSessionReady: () => true,
  getHeartbeatTimer: () => heartbeatTimer,
  setHeartbeatTimer: (timer) => { heartbeatTimer = timer; },
  getActiveQueueMessageId: () => activeMessageId,
});

const link = createWorkerWebSocketLink({
  serverUrl,
  token,
  dbg: log,
  buildId,
  workerKind,
  getSessionReady: () => true,
  getSessionId: () => sessionId,
  getPid: () => process.pid,
  onDeliver: (pending) => answer(pending),
});

function shutdown(reason) {
  log(`stopping (${reason})`);
  try { link.stop(); } catch {}
  try { heartbeat.stopHeartbeat(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
setTimeout(() => shutdown('max life'), MAX_LIFE_MS).unref();

log(`session=${sessionId.slice(0, 8)} server=${serverUrl} sdk=${sdkDir || 'none'}`);
heartbeat.startHeartbeat();
link.start();
