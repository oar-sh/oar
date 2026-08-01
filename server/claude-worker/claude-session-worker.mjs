#!/usr/bin/env node
// Claude session worker: a per-conversation Node process that speaks the same
// relay contracts as the Copilot CLI workers (worker WebSocket, heartbeat,
// control polling, activity channels) but executes turns through the Claude
// Agent SDK using the host machine's logged-in Claude credentials.
import path from 'path';
import { fileURLToPath } from 'url';

import {
  loadTokenFromConfig,
  resolveRelayServerUrl,
} from '../../.github/extensions/web-relay/runtime/config-loader.mjs';
import { createApiClient } from '../../.github/extensions/web-relay/runtime/api-client.mjs';
import { createWorkerWebSocketLink } from '../../.github/extensions/web-relay/runtime/worker-websocket-link.mjs';
import { createHeartbeatController } from '../../.github/extensions/web-relay/polling/heartbeat.mjs';
import { createControlPoller } from './control-poller.mjs';
import { createClaudeTurnRunner } from './claude-turn-runner.mjs';

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
  console.log(`[claude-worker ${timestamp}]`, ...parts);
}

async function main() {
  const sdkSessionId = parseSessionIdArg();
  if (!sdkSessionId) {
    console.error('claude-session-worker: missing --session-id');
    process.exit(2);
  }

  const configPath = String(process.env.COPILOT_WEB_RELAY_CONFIG || '').trim()
    || path.resolve(__dirname, '..', 'config.json');
  const serverUrl = resolveRelayServerUrl({ configPath });
  const token = loadTokenFromConfig(configPath);
  const cwd = String(process.env.COPILOT_WORKSPACE_ROOT || '').trim() || process.cwd();
  const defaultModel = String(process.env.CLAUDE_RELAY_MODEL || '').trim();
  const pathToClaudeCodeExecutable = String(process.env.CLAUDE_CODE_EXECUTABLE || '').trim();

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

  const controlPoller = createControlPoller({ api, sdkSessionId, dbg });
  const turnRunner = createClaudeTurnRunner({
    api,
    sdkSessionId,
    cwd,
    defaultModel,
    controlPoller,
    pathToClaudeCodeExecutable,
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

  const shutdown = (signal) => {
    dbg(`shutting down (${signal})`);
    try { wsLink.stop(); } catch {}
    try { heartbeat.stopHeartbeat(); } catch {}
    try { controlPoller.stop(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  dbg(`starting session=${sdkSessionId.slice(0, 8)} server=${serverUrl} cwd=${cwd} model=${defaultModel || 'default'}`);
  heartbeat.startHeartbeat();
  wsLink.start();
}

main().catch((error) => {
  console.error('claude-session-worker fatal:', error?.stack || error?.message || error);
  process.exit(1);
});
