#!/usr/bin/env node
// Copilot SDK session worker: a per-conversation Node process that speaks the
// same relay contracts as every other worker (worker WebSocket, heartbeat,
// control polling, activity channels) but executes turns through the Copilot
// SDK's headless runtime instead of the `copilot` TUI under a PTY.
//
// Run it by hand against a live relay with:
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
} from '../../shared/worker-runtime/config-loader.mjs';
import { createApiClient } from '../../shared/worker-runtime/api-client.mjs';
import { createWorkerWebSocketLink } from '../../shared/worker-runtime/worker-websocket-link.mjs';
import { createHeartbeatController } from '../../shared/worker-runtime/heartbeat.mjs';
import {
  createRunnerLinkBridge,
  failSettlingRowsOnShutdown,
} from '../../shared/worker-runtime/runner-link-wiring.mjs';
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
    // A subagent lane's Stop. Lanes are keyed on the envelope agentId, which
    // is also the runtime's task id, so `rpc.tasks.cancel` is tried; the
    // runtime refuses ids it does not track (then the control answers "not
    // supported" and the whole-turn Stop remains). Background agents have no
    // lane — their Stop is the task panel's. (Late-bound: controls only poll
    // while a turn is live.)
    onAbortSubagent: (subagentRunId) => turnRunner.stopBackgroundTask(subagentRunId),
    dbg,
  });
  // The relay's *Background task timeout* slider (0 = unlimited) rides every
  // delivery payload, exactly as for the Claude worker: background agents and
  // shells now have cards and a Stop, so the slider governs them too and a cap
  // expiry CANCELS them rather than forgetting them. The env var is an
  // emergency override only.
  const backgroundTaskTimeoutOverrideMs = readOptionalMs('COPILOT_SDK_RELAY_BACKGROUND_TASK_TIMEOUT_MS');
  let backgroundTaskTimeoutMs = backgroundTaskTimeoutOverrideMs ?? 0;
  // The runner reports every flip of its delivery gate; the bridge turns them
  // into the link's worker.unready / worker.ready frames, so a message queued
  // while a question card is open is held in the relay queue and steers into
  // the resumed turn one round trip after the answer.
  const linkBridge = createRunnerLinkBridge();
  const turnRunner = createCopilotSdkSessionRunner({
    api,
    sdkSessionId,
    cwd,
    defaultModel,
    controlPoller,
    idleShutdownMs: readOptionalMs('COPILOT_SDK_RELAY_IDLE_SHUTDOWN_MS'),
    turnStallTimeoutMs: readOptionalMs('COPILOT_SDK_RELAY_TURN_STALL_TIMEOUT_MS'),
    // How long a deferred model switch may wait for its drain before the
    // explicit selection fails the row (default 10s).
    modelSwitchTimeoutMs: readOptionalMs('COPILOT_SDK_RELAY_MODEL_SWITCH_TIMEOUT_MS'),
    getBackgroundTaskTimeoutMs: () => backgroundTaskTimeoutMs,
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
    // The composer's steering snapshot (Steer / Queue + the hold reason, the
    // un-steerable rows) and the consumed steers whose settle the runner gave
    // up on — the relay fails those itself, never re-running them.
    getSteeringState: () => turnRunner.steeringState(),
    getSettleFailed: () => turnRunner.getSettleFailed(),
    onSettleFailedHandled: (ids) => turnRunner.acknowledgeSettleFailed(ids),
  });

  const wsLink = createWorkerWebSocketLink({
    serverUrl,
    token,
    dbg,
    getSessionReady: () => true,
    getSessionId: () => sdkSessionId,
    getPid: () => process.pid,
    // Mid-turn steering opt-in: the link keeps signalling readiness while a
    // delivery is in flight as long as the runner can absorb another message
    // into the live turn, and withdraws it while the runner holds.
    getSteeringReady: () => turnRunner.canAcceptSteering(),
    getDeliveryHeld: () => turnRunner.isDeliveryHeld(),
    onDeliver: async (pending, reason) => {
      dbg('queue.deliver received', `reason=${reason}`, `msgId=${pending?.message?.id || 'none'}`);
      // Slider changes reach a running worker on its next delivery; an
      // explicit env override pins the value regardless.
      const deliveredTimeout = Number(pending?.settings?.backgroundTaskTimeoutMs);
      if (backgroundTaskTimeoutOverrideMs === undefined && Number.isFinite(deliveredTimeout) && deliveredTimeout >= 0) {
        backgroundTaskTimeoutMs = deliveredTimeout;
      }
      try {
        return await turnRunner.handlePendingPayload(pending);
      } catch (error) {
        dbg('turn handling failed', error?.message || String(error));
        return false;
      }
    },
    onControl: (control) => {
      const type = String(control?.type || '').trim();
      if (type === 'cancel_pushed_message') {
        // Un-steer: pull a pushed-but-unconsumed message back out of the
        // runtime's queue and cancel its row.
        void turnRunner.cancelPushedMessage(control?.messageId).catch((error) => {
          dbg('un-steer failed', error?.message || String(error));
        });
        return;
      }
      if (type === 'stop_background_task') {
        // The task panel's per-card Stop → rpc.tasks.cancel.
        const taskId = String(control?.taskId || '').trim();
        dbg('stop background task control', taskId);
        void turnRunner.stopBackgroundTask(taskId).catch((error) => {
          dbg('stop background task failed', error?.message || String(error));
        });
        return;
      }
      dbg('worker control ignored (unsupported by the SDK worker)', type || '(none)');
    },
  });
  linkBridge.attach(wsLink);

  const shutdown = async (signal) => {
    dbg(`shutting down (${signal})`);
    try { wsLink.stop(); } catch {}
    try { heartbeat.stopHeartbeat(); } catch {}
    try { controlPoller.stop(); } catch {}
    // Rows whose prompt the runtime consumed and whose settle marker has not
    // landed are failed terminally, never left for dead-worker recovery to
    // requeue (that would run the prompt twice). Bounded.
    try { await failSettlingRowsOnShutdown({ api, runner: turnRunner }); } catch {}
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
