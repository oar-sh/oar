import { backgroundTaskDigest } from "./background-task-digest.mjs";

export function createHeartbeatController({
  api,
  pollMs,
  getSessionReady,
  getHeartbeatTimer,
  setHeartbeatTimer,
  getActiveQueueMessageId,
  // Optional: every queue message the worker currently owns work for (a
  // persistent-process worker can hold a running turn, a delivered message
  // queued behind it, and a background continuation at once). Each reported
  // id gets its owner lease refreshed; unreported owned rows are recovered.
  getActiveQueueMessageIds,
  // Optional: the worker's steering snapshot ({turnActive, canSteer,
  // holdReason}) for the composer. Workers that do not steer leave it unset
  // and the heartbeat body is unchanged.
  getSteeringState,
  // Optional: rows the worker gave up settling ([{id, attemptId,
  // terminalError}]); the relay fails them and names them back in
  // `settleFailedHandled`, which `onSettleFailedHandled` receives.
  getSettleFailed,
  onSettleFailedHandled = () => {},
  // Optional: the ids of the worker's live background tasks (an array, empty
  // for none). The body then carries their digest, and a relay whose own set
  // for this worker differs (it restarted, or a post was lost) answers
  // `resyncBackgroundTasks`: `onResyncBackgroundTasks` publishes the full
  // set again. It is asked again by every beat until the sets agree, so a
  // failed publish needs no retry of its own. Workers that publish no task
  // sets leave both unset; the relay reads a missing digest as no opinion.
  getBackgroundTaskIds,
  onResyncBackgroundTasks = () => {},
  // Optional: called after every beat the relay answered, for work that
  // waits for a reachable relay (posts kept after a failure).
  onAnswered = () => {},
  // requestPulse's window: one turn transition can flip the steering
  // snapshot several times in quick succession, and each flip only needs to
  // reach the relay once.
  pulseCoalesceMs = 300,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  let requestedPulseTimer = null;

  async function pulseHeartbeat() {
    if (!getSessionReady()) return false;
    try {
      const activeQueueMessageId = typeof getActiveQueueMessageId === "function"
        ? String(getActiveQueueMessageId() || "").trim()
        : "";
      const activeQueueMessageIds = typeof getActiveQueueMessageIds === "function"
        ? (getActiveQueueMessageIds() || []).map((id) => String(id || "").trim()).filter(Boolean)
        : [];
      const steering = typeof getSteeringState === "function"
        ? getSteeringState()
        : null;
      const settleFailed = typeof getSettleFailed === "function"
        ? (getSettleFailed() || []).filter((entry) => entry && String(entry.id || "").trim())
        : [];
      const backgroundTaskIds = typeof getBackgroundTaskIds === "function"
        ? getBackgroundTaskIds()
        : null;
      const body = {
        ...(activeQueueMessageId ? { activeQueueMessageId } : {}),
        ...(activeQueueMessageIds.length ? { activeQueueMessageIds } : {}),
        ...(steering && typeof steering === "object" ? { steering } : {}),
        ...(settleFailed.length ? { settleFailed } : {}),
        ...(Array.isArray(backgroundTaskIds) ? { backgroundTasks: backgroundTaskDigest(backgroundTaskIds) } : {}),
      };
      const response = await api("POST", "/api/heartbeat", body);
      // Failed by the relay, or skipped because this worker has no claim on
      // the row: either way the worker releases it.
      const handled = [
        ...(Array.isArray(response?.settleFailedHandled) ? response.settleFailedHandled : []),
        ...(Array.isArray(response?.settleFailedSkipped) ? response.settleFailedSkipped : []),
      ];
      if (handled.length) {
        try { onSettleFailedHandled(handled); } catch {}
      }
      // Kept posts first: an end the relay has not heard of yet goes before
      // the set that no longer lists the task.
      try { await onAnswered(); } catch {}
      if (response?.resyncBackgroundTasks === true) {
        try { await onResyncBackgroundTasks(); } catch {}
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * An out-of-cycle pulse for state the relay should see before the next
   * periodic one (the composer's steering snapshot, a relay that just came
   * up). Requests inside one window share a single pulse, sent at its end so
   * it carries the settled state.
   */
  function requestPulse() {
    if (requestedPulseTimer) return;
    requestedPulseTimer = setTimeoutImpl(() => {
      requestedPulseTimer = null;
      void pulseHeartbeat();
    }, pulseCoalesceMs);
    requestedPulseTimer?.unref?.();
  }

  function startHeartbeat() {
    if (getHeartbeatTimer()) return;
    void pulseHeartbeat();
    const timer = setInterval(() => {
      void pulseHeartbeat();
    }, pollMs);
    setHeartbeatTimer(timer);
  }

  function stopHeartbeat() {
    if (requestedPulseTimer) {
      clearTimeoutImpl(requestedPulseTimer);
      requestedPulseTimer = null;
    }
    const timer = getHeartbeatTimer();
    if (!timer) return;
    clearInterval(timer);
    setHeartbeatTimer(null);
  }

  return {
    pulseHeartbeat,
    requestPulse,
    startHeartbeat,
    stopHeartbeat,
  };
}
