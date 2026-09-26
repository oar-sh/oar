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
      const body = {
        ...(activeQueueMessageId ? { activeQueueMessageId } : {}),
        ...(activeQueueMessageIds.length ? { activeQueueMessageIds } : {}),
        ...(steering && typeof steering === "object" ? { steering } : {}),
        ...(settleFailed.length ? { settleFailed } : {}),
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
