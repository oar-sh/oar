#!/usr/bin/env node
// Cursor session worker: a per-conversation Node process that speaks the same
// relay contracts as the Copilot CLI workers (worker WebSocket, heartbeat,
// control polling, activity channels) but executes turns through the Cursor
// SDK using an API key from the environment.
import path from 'path';
import { fileURLToPath } from 'url';

import {
  loadTokenFromConfig,
  resolveRelayServerUrl,
} from '../../.github/extensions/web-relay/runtime/config-loader.mjs';
import { createApiClient } from '../../.github/extensions/web-relay/runtime/api-client.mjs';
import { createWorkerWebSocketLink } from '../../.github/extensions/web-relay/runtime/worker-websocket-link.mjs';
import { createHeartbeatController } from '../../.github/extensions/web-relay/polling/heartbeat.mjs';
import { createControlPoller } from '../../shared/control-poller.mjs';
import { createCursorTurnRunner } from './cursor-turn-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_MS = 10_000;

function parseSessionIdArg(argv = process.argv) {
  const index = argv.indexOf('--session-id');
  if (index !== -1 && argv[index + 1]) return String(argv[index + 1]).trim();
  const inline = argv.find((arg) => String(arg || '').startsWith('--session-id='));
  if (inline) return String(inline.split('=')[1] || '').trim();
  return String(process.env.SESSION_ID || '').trim();
}

function dbg(...parts) {
  const timestamp = new Date().toISOString();
  console.log(`[cursor-worker ${timestamp}]`, ...parts);
}

async function main() {
  const sdkSessionId = parseSessionIdArg();
  if (!sdkSessionId) {
    console.error('cursor-session-worker: missing --session-id');
    process.exit(2);
  }

  const configPath = String(process.env.COPILOT_WEB_RELAY_CONFIG || '').trim()
    || path.resolve(__dirname, '..', 'config.json');
  const serverUrl = resolveRelayServerUrl({ configPath });
  const token = loadTokenFromConfig(configPath);
  const cwd = String(process.env.COPILOT_WORKSPACE_ROOT || '').trim() || process.cwd();
  const defaultModel = String(process.env.CURSOR_RELAY_MODEL || '').trim();
  const apiKey = String(process.env.CURSOR_API_KEY || '').trim();
  if (!apiKey) {
    // Not fatal: the first turn surfaces cursor.authentication_failed with a
    // renewal hint, which is more visible to the user than a dead worker.
    console.warn('cursor-session-worker: CURSOR_API_KEY is not set; turns will fail until it is provided');
  }
  const storeDir = String(process.env.CURSOR_AGENT_STORE_DIR || '').trim()
    || path.resolve(__dirname, '..', 'data', 'cursor-agents');

  const api = createApiClient({
    serverUrl,
    token,
    getHeaders: () => ({
      'X-Relay-Process-Pid': String(process.pid),
      'X-Relay-Parent-Pid': String(process.ppid),
      'X-Relay-Session-Id': sdkSessionId,
      'X-Relay-Conversation-Id': sdkSessionId,
    }),
  });

  const controlPoller = createControlPoller({ api, sdkSessionId, abortAckNote: 'cursor run cancelled', dbg });
  const turnRunner = createCursorTurnRunner({
    api,
    sdkSessionId,
    cwd,
    defaultModel,
    apiKey,
    storeDir,
    controlPoller,
    dbg,
  });

  let heartbeatTimer = null;
  const heartbeat = createHeartbeatController({
    api,
    pollMs: HEARTBEAT_MS,
    getSessionReady: () => true,
    getHeartbeatTimer: () => heartbeatTimer,
    setHeartbeatTimer: (timer) => { heartbeatTimer = timer; },
    getActiveQueueMessageId: () => turnRunner.getActiveQueueMessageId(),
  });

  const wsLink = createWorkerWebSocketLink({
    serverUrl,
    token,
    dbg,
    getSessionReady: () => true,
    getSessionId: () => sdkSessionId,
    getPid: () => process.pid,
    onDeliver: async (pending, reason) => {
      dbg('queue.deliver received', `reason=${reason}`, `msgId=${pending?.message?.id || 'none'}`);
      try {
        return await turnRunner.handlePendingPayload(pending);
      } catch (error) {
        dbg('turn handling failed', error?.message || String(error));
        return false;
      }
    },
  });

  const shutdown = async (signal) => {
    dbg(`shutting down (${signal})`);
    try { wsLink.stop(); } catch {}
    try { heartbeat.stopHeartbeat(); } catch {}
    try { controlPoller.stop(); } catch {}
    // The agent handle owns a SQLite store; close it before exiting — but
    // bounded: a dispose that hangs must never leave the process ignoring the
    // supervisor's SIGTERM (the exit path has to be as reliable as the Claude
    // worker's synchronous one).
    try {
      await Promise.race([
        turnRunner.dispose(),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 3_000);
          timer.unref?.();
        }),
      ]);
    } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });

  dbg(`starting session=${sdkSessionId.slice(0, 8)} server=${serverUrl} cwd=${cwd} model=${defaultModel || 'default'}`);
  heartbeat.startHeartbeat();
  wsLink.start();
}

main().catch((error) => {
  console.error('cursor-session-worker fatal:', error?.stack || error?.message || error);
  process.exit(1);
});
