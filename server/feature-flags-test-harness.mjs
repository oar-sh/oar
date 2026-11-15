// A new conversation's bootstrap starts its worker through the supervisor
// before it answers. This one launches nothing and reports a
// ready worker; `ensured` lists the session ids it was asked for.
export function fakeSessionWorkerSupervisor() {
  const ensured = [];
  return {
    ensured,
    clearRestartSchedule() {},
    async ensureWorker(sdkSessionId) {
      ensured.push(sdkSessionId);
      return { ok: true, worker: { sdkSessionId, status: 'ready' } };
    },
    getWorkerState: () => null,
    getLifecycleState: () => null,
    markIdle() {},
    snapshot: () => null,
  };
}
