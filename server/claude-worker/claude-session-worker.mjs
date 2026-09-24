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
} from '../../shared/worker-runtime/config-loader.mjs';
import { createApiClient } from '../../shared/worker-runtime/api-client.mjs';
import { createWorkerWebSocketLink } from '../../shared/worker-runtime/worker-websocket-link.mjs';
import { createHeartbeatController } from '../../shared/worker-runtime/heartbeat.mjs';
import { createControlPoller } from '../../shared/control-poller.mjs';
import { resolveDeliveredAutoCompactWindow } from '../../shared/auto-compact-window.mjs';
import { resolveDeliveredThinking } from '../../shared/claude-thinking.mjs';
import { installWorkerCrashGuard } from '../../shared/worker-crash-guard.mjs';
import { createClaudeSessionRunner } from './claude-session-process.mjs';
import { createRunnerLinkBridge, failSettlingRowsOnShutdown } from './claude-worker-link-wiring.mjs';

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
  // How long background tasks alone may keep the CLI process alive (0 = no
  // limit). Seeded from the environment; refreshed from every delivery payload
  // so the settings slider applies without a worker restart.
  let backgroundTaskTimeoutMs = Number(process.env.CLAUDE_RELAY_BACKGROUND_TASK_TIMEOUT_MS) || 0;
  // Per-conversation auto-compact window (token count, null = Auto); arrives
  // piggybacked on each queue delivery, like the timeouts above.
  let autoCompactWindow = null;
  // Per-conversation thinking control ({enabled: bool|null, display}); same
  // piggyback. enabled null = host default; display defaults to 'summarized'
  // (today's behavior — visible thought bubbles).
  let thinking = resolveDeliveredThinking(null, null);

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
    abortAckNote: 'claude query aborted',
    // Backgrounded subagents are SDK tasks; their relay run id is the
    // spawning tool_use id, which maps to a stoppable task id. (Late-bound:
    // controls only poll while a turn is live, well after turnRunner exists.)
    onAbortSubagent: (subagentRunId) => turnRunner.stopBackgroundTaskByToolUseId(subagentRunId),
    dbg,
  });
  const linkBridge = createRunnerLinkBridge();
  const turnRunner = createClaudeSessionRunner({
    api,
    sdkSessionId,
    cwd,
    defaultModel,
    controlPoller,
    pathToClaudeCodeExecutable,
    idleShutdownMs: Number(process.env.CLAUDE_RELAY_IDLE_SHUTDOWN_MS) > 0
      ? Number(process.env.CLAUDE_RELAY_IDLE_SHUTDOWN_MS)
      : undefined,
    // 0 disables the watchdog (matching the background-task timeout's
    // 0 = no-limit convention); unset/invalid falls back to the default.
    pendingDeliveredTimeoutMs: (() => {
      const raw = String(process.env.CLAUDE_RELAY_PENDING_DELIVERED_TIMEOUT_MS || '').trim();
      const parsed = Number(raw);
      return raw !== '' && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    })(),
    getBackgroundTaskTimeoutMs: () => backgroundTaskTimeoutMs,
    getAutoCompactWindow: () => autoCompactWindow,
    getThinking: () => thinking,
    onDeliveryReadinessChange: (ready) => linkBridge.onDeliveryReadinessChange(ready),
    canHandBackHeldDelivery: () => linkBridge.canHandBackHeldDelivery(),
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
    // The runner reports { id, attemptId } entries; the heartbeat's claim
    // payload is id-only (its String() coercion would mangle an object), while
    // the crash guard below takes the entries whole so its requeues stay
    // fenced to this attempt.
    getActiveQueueMessageIds: () => turnRunner.getActiveQueueMessageIds().map((entry) => entry.id),
    // Composer steering snapshot; ~10s worst-case latency is fine because the
    // client covers the instant case (open question card) from its own state.
    getSteeringState: () => turnRunner.steeringState(),
    // Consumed rows the runner could not fail itself; the relay fails them.
    getSettleFailed: () => turnRunner.getSettleFailed(),
    onSettleFailedHandled: (ids) => turnRunner.acknowledgeSettleFailed(ids),
  });

  const wsLink = createWorkerWebSocketLink({
    serverUrl,
    token,
    dbg,
    getSessionReady: () => true,
    // Mid-turn steering: while a turn is running and the runner can absorb
    // another message into it, the link keeps signalling readiness, so a
    // message sent while Claude is thinking is pushed into the live turn
    // instead of waiting for the result (docs/plans/2026-09-19-claude-mid-
    // turn-steering.md).
    getSteeringReady: () => turnRunner.canAcceptSteering(),
    // A hold (open question card, compaction, adoption) suppresses readiness
    // even between deliveries — a delivery drawn into it is only handed back.
    getDeliveryHeld: () => turnRunner.isDeliveryHeld(),
    getSessionId: () => sdkSessionId,
    getPid: () => process.pid,
    onDeliver: async (pending, reason) => {
      dbg('queue.deliver received', `reason=${reason}`, `msgId=${pending?.message?.id || 'none'}`);
      const deliveredTimeout = Number(pending?.settings?.backgroundTaskTimeoutMs);
      if (Number.isFinite(deliveredTimeout) && deliveredTimeout >= 0) {
        backgroundTaskTimeoutMs = deliveredTimeout;
      }
      // Absent (an older relay) leaves the last known value alone; an explicit
      // null is the user choosing Auto and must clear the pin.
      autoCompactWindow = resolveDeliveredAutoCompactWindow(autoCompactWindow, pending?.settings);
      // Same presence semantics as the window: absent keys (an older relay)
      // keep the last known state; an explicit null on thinkingEnabled is the
      // user choosing Host default.
      thinking = resolveDeliveredThinking(thinking, pending?.settings);
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
        const taskId = String(control?.taskId || '').trim();
        dbg('stop background task control', taskId);
        await turnRunner.stopBackgroundTask(taskId);
        return;
      }
      dbg('unknown worker control ignored', type || '(none)');
    },
  });
  linkBridge.attach(wsLink);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    dbg(`shutting down (${signal})`);
    try { wsLink.stop(); } catch {}
    try { heartbeat.stopHeartbeat(); } catch {}
    try { controlPoller.stop(); } catch {}
    // Consumed steers still settling must fail, not be left for dead-worker
    // recovery to requeue and run twice (same 2 s cap as the crash guard).
    try {
      const failed = await failSettlingRowsOnShutdown({ api, runner: turnRunner, timeoutMs: 2_000 });
      if (failed) dbg(`failed ${failed} settling row(s) before exit`);
    } catch {}
    // Hard-close the persistent CLI process; a worker teardown cannot save
    // its background tasks, and the orphan-notification replay on the next
    // resume reports whatever they left behind.
    try { turnRunner.shutdown({ graceful: false }); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  installWorkerCrashGuard({
    api,
    workerName: 'claude-session-worker',
    getActiveQueueMessageIds: () => turnRunner.getActiveQueueMessageIds(),
    onBeforeExit: () => { try { turnRunner.shutdown({ graceful: false }); } catch {} },
  });

  dbg(`starting session=${sdkSessionId.slice(0, 8)} server=${serverUrl} cwd=${cwd} model=${defaultModel || 'default'}`);
  heartbeat.startHeartbeat();
  wsLink.start();
}

main().catch((error) => {
  console.error('claude-session-worker fatal:', error?.stack || error?.message || error);
  process.exit(1);
});
