#!/usr/bin/env node
// Copilot SDK session worker: a per-conversation Node process that speaks the
// same relay contracts as every other worker (worker WebSocket, heartbeat,
// control polling, activity channels) but executes turns through the Copilot
// SDK's headless runtime instead of the `copilot` TUI under a PTY.
//
// Dormant until phase 3 registers a worker kind for it. Run it by hand against
// a live relay with:
//
//   COPILOT_WEB_RELAY_CONFIG=server/config.json \
//   COPILOT_WORKSPACE_ROOT=/path/to/workspace \
//   COPILOT_SDK_PATH=~/.cache/copilot/pkg/linux-x64/<version>/copilot-sdk \
//   node server/copilot-worker/copilot-sdk-session-worker.mjs --session-id <sdk-session-id>
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
import { installWorkerCrashGuard } from '../../shared/worker-crash-guard.mjs';
import {
  createWorkerDebug,
  parseSessionIdArg,
  readOptionalMs,
} from '../../shared/worker-bootstrap.mjs';
import { createCopilotSdkSessionRunner } from './copilot-sdk-session-process.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_MS = 10_000;

const dbg = createWorkerDebug('copilot-sdk-worker');

async function main() {
  const sdkSessionId = parseSessionIdArg();
  if (!sdkSessionId) {
    console.error('copilot-sdk-session-worker: missing --session-id');
    process.exit(2);
  }

  const configPath = String(process.env.COPILOT_WEB_RELAY_CONFIG || '').trim()
    || path.resolve(__dirname, '..', 'config.json');
  // Two reads of the same small file. Collapsing them to one would mean
  // re-implementing `resolveRelayServerUrl`'s env override, host
  // normalisation and port defaulting inside this worker — a live contract
  // duplicated to save a 1 KB read at process start. Not worth it; the
  // extension helper stays the single source of the relay URL.
  const serverUrl = resolveRelayServerUrl({ configPath });
  const token = loadTokenFromConfig(configPath);
  const cwd = String(process.env.COPILOT_WORKSPACE_ROOT || '').trim() || process.cwd();
  const defaultModel = String(process.env.COPILOT_RELAY_MODEL || '').trim();

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

  const controlPoller = createControlPoller({
    api,
    sdkSessionId,
    abortAckNote: 'copilot session aborted',
    dbg,
  });
  const turnRunner = createCopilotSdkSessionRunner({
    api,
    sdkSessionId,
    cwd,
    defaultModel,
    controlPoller,
    idleShutdownMs: readOptionalMs('COPILOT_SDK_RELAY_IDLE_SHUTDOWN_MS'),
    turnStallTimeoutMs: readOptionalMs('COPILOT_SDK_RELAY_TURN_STALL_TIMEOUT_MS'),
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
    getActiveQueueMessageIds: () => turnRunner.getActiveQueueMessageIds(),
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
    onControl: (control) => {
      // Background-task controls have no Copilot SDK equivalent yet: the
      // runtime's `session.background_tasks_changed` carries an empty payload
      // (23 of them fire during a single bash call), so there is no task id to
      // stop. Logged rather than silently dropped.
      dbg('worker control ignored (unsupported by the SDK worker)', String(control?.type || '(none)'));
    },
  });

  const shutdown = async (signal) => {
    dbg(`shutting down (${signal})`);
    try { wsLink.stop(); } catch {}
    try { heartbeat.stopHeartbeat(); } catch {}
    try { controlPoller.stop(); } catch {}
    // Bounded, like the Cursor worker: stopping the runtime is an RPC, and a
    // hung stop must never make the process ignore the supervisor's SIGTERM.
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
  installWorkerCrashGuard({
    api,
    workerName: 'copilot-sdk-session-worker',
    getActiveQueueMessageIds: () => turnRunner.getActiveQueueMessageIds(),
  });

  dbg(`starting session=${sdkSessionId.slice(0, 8)} server=${serverUrl} cwd=${cwd} model=${defaultModel || 'default'}`);
  heartbeat.startHeartbeat();
  wsLink.start();
}

main().catch((error) => {
  console.error('copilot-sdk-session-worker fatal:', error?.stack || error?.message || error);
  process.exit(1);
});
