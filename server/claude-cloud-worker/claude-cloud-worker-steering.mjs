/**
 * The heartbeat steering snapshot of the Claude Cloud worker. It steers
 * nothing (`supported: false`, so the composer offers no mid-turn steering and
 * reads neither the hold nor the cancellable ids); it is sent for the release
 * fields, which tell the relay whether it may stop this worker and launch a
 * fresh one now (its recycle after a deploy).
 *
 * The rule is the runner's (`releaseHold()` in claude-cloud-session-process.mjs):
 * not while a turn runs here, not while a turn that ended here without its
 * `result` may still run in the cloud, and not while the cloud session's last
 * known status is not idle. The generic snapshot of the other small mains
 * (shared/worker-runtime/simple-steering-state.mjs) knows only the turn; the
 * cloud session can be busy with no relay turn at all.
 *
 * `runner` is the object createClaudeCloudSessionRunner returns.
 */
export function buildClaudeCloudSteeringState(runner) {
  const attempt = runner?.getActiveQueueAttempt?.() || null;
  const messageId = String(attempt?.id || '').trim() || null;
  const turnActive = runner?.isTurnActive?.() === true || Boolean(messageId);
  // A runner without the hold function still never says yes mid-turn.
  const hold = String(runner?.releaseHold?.() || '').trim() || (turnActive ? 'turn' : '');
  return {
    turnActive,
    canSteer: false,
    holdReason: null,
    messageId,
    supported: false,
    cancellableIds: [],
    releasable: !hold,
    releaseHold: hold || null,
    backgroundTaskCount: 0,
  };
}
