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
}) {
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
      const body = {
        ...(activeQueueMessageId ? { activeQueueMessageId } : {}),
        ...(activeQueueMessageIds.length ? { activeQueueMessageIds } : {}),
        ...(steering && typeof steering === "object" ? { steering } : {}),
      };
      await api("POST", "/api/heartbeat", body);
      return true;
    } catch {
      return false;
    }
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
    const timer = getHeartbeatTimer();
    if (!timer) return;
    clearInterval(timer);
    setHeartbeatTimer(null);
  }

  return {
    pulseHeartbeat,
    startHeartbeat,
    stopHeartbeat,
  };
}
