#!/usr/bin/env node
// Grok session worker: a per-conversation Node process that speaks the same
// relay contracts as the Claude/Cursor workers but executes turns through the
// Grok CLI ACP surface (grok agent stdio).
import path from 'path';
import { fileURLToPath } from 'url';

import {
  loadTokenFromConfig,
  resolveRelayServerUrl,
} from '../../shared/worker-runtime/config-loader.mjs';
import { createApiClient } from '../../shared/worker-runtime/api-client.mjs';
import { createWorkerWebSocketLink } from '../../shared/worker-runtime/worker-websocket-link.mjs';
import { createHeartbeatController } from '../../shared/worker-runtime/heartbeat.mjs';
import { installWorkerLogFile } from '../../shared/worker-runtime/worker-log-file.mjs';
import { createControlPoller } from '../../shared/control-poller.mjs';
import { installWorkerCrashGuard } from '../../shared/worker-crash-guard.mjs';
import { createGrokTurnRunner } from './grok-turn-runner.mjs';
import { createGrokTaskPublisher } from './grok-background-tasks.mjs';

// Windows console launch: the launcher names the worker log, this copies
// stdout/stderr into it. A no-op wherever the launcher redirects instead.
installWorkerLogFile();

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
  console.log(`[grok-worker ${timestamp}]`, ...parts);
}

async function main() {
  const sdkSessionId = parseSessionIdArg();
  if (!sdkSessionId) {
    console.error('grok-session-worker: missing --session-id');
    process.exit(2);
  }

  const configPath = String(process.env.COPILOT_WEB_RELAY_CONFIG || '').trim()
    || path.resolve(__dirname, '..', 'config.json');
  const serverUrl = resolveRelayServerUrl({ configPath });
  const token = loadTokenFromConfig(configPath);
  const cwd = String(process.env.COPILOT_WORKSPACE_ROOT || '').trim() || process.cwd();
  const defaultModel = String(process.env.GROK_RELAY_MODEL || '').trim();
  const command = String(process.env.GROK_CLI_COMMAND || process.env.GROK_COMMAND || 'grok').trim() || 'grok';
  const alwaysApprove = String(process.env.GROK_ALWAYS_APPROVE || '1').trim() !== '0';

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
    abortAckNote: 'grok run cancelled',
    dbg,
  });
  // Late-bound: the heartbeat controller is built after the runner.
  let heartbeat = null;
  // The agent's terminals, published as background tasks with a console
  // (spooled output), a Stop and a settle notice.
  const taskPublisher = createGrokTaskPublisher({
    api,
    sdkSessionId,
    onBackgroundTaskSetStale: () => heartbeat?.requestPulse(),
    dbg,
  });
  const turnRunner = createGrokTurnRunner({
    api,
    sdkSessionId,
    cwd,
    defaultModel,
    command,
    alwaysApprove,
    controlPoller,
    taskPublisher,
    dbg,
  });

  let heartbeatTimer = null;
  heartbeat = createHeartbeatController({
    api,
    pollMs: HEARTBEAT_MS,
    getSessionReady: () => true,
    getHeartbeatTimer: () => heartbeatTimer,
    setHeartbeatTimer: (timer) => { heartbeatTimer = timer; },
    getActiveQueueMessageId: () => turnRunner.getActiveQueueMessageId(),
    // The relay holds the task set in memory only: the live terminal ids
    // ride every beat, and a relay that is out of step asks for the set again.
    getBackgroundTaskIds: () => turnRunner.backgroundTaskIds(),
    onResyncBackgroundTasks: () => turnRunner.resyncBackgroundTasks(),
    onAnswered: () => turnRunner.flushKeptTaskSettles(),
  });

  const wsLink = createWorkerWebSocketLink({
    serverUrl,
    token,
    dbg,
    getSessionReady: () => true,
    // A relay that just (re)started learns of the terminals from the digest
    // on the next beat; ask for it now.
    onServerHello: () => heartbeat.requestPulse(),
    getSessionId: () => sdkSessionId,
    getPid: () => process.pid,
    onDeliver: async (pending, reason) => {
      dbg('queue.deliver received', `reason=${reason}`, `msgId=${pending?.message?.id || 'none'}`);
      const deliveredCeiling = Number(pending?.settings?.turnCeilingMs);
      if (Number.isFinite(deliveredCeiling) && deliveredCeiling >= 0) {
        turnRunner.setTurnCeilingMs?.(deliveredCeiling);
      }
      try {
        return await turnRunner.handlePendingPayload(pending);
      } catch (error) {
        dbg('turn handling failed', error?.message || String(error));
        return false;
      }
    },
    onControl: async (control) => {
      const type = String(control?.type || '').trim();
      if (type === 'stop_background_task') {
        // The panel's Stop on a terminal row: kill its process.
        const taskId = String(control?.taskId || '').trim();
        dbg('stop background task control', taskId);
        turnRunner.stopBackgroundTask(taskId);
        return;
      }
      dbg('unknown worker control ignored', type || '(none)');
    },
  });

  const shutdown = async (signal) => {
    dbg(`shutting down (${signal})`);
    try { wsLink.stop(); } catch {}
    try { heartbeat.stopHeartbeat(); } catch {}
    try { controlPoller.stop(); } catch {}
    try { taskPublisher.close(); } catch {}
    // Bounded: a hung ACP agent teardown must never leave the process
    // ignoring the supervisor's SIGTERM.
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
    workerName: 'grok-session-worker',
    getActiveQueueMessageIds: () => [turnRunner.getActiveQueueAttempt()],
  });

  dbg(`starting session=${sdkSessionId.slice(0, 8)} server=${serverUrl} cwd=${cwd} model=${defaultModel || 'default'}`);
  heartbeat.startHeartbeat();
  wsLink.start();
}

main().catch((error) => {
  console.error('grok-session-worker fatal:', error?.stack || error?.message || error);
  process.exit(1);
});
