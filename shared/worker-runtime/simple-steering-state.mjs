/**
 * The heartbeat steering snapshot of a worker that runs one delivered message
 * at a time and never steers into a running turn: the Cursor, Grok and Claude
 * cloud workers. They send it for the release fields, which tell the relay
 * whether it may stop this worker and launch a fresh one now (its recycle
 * after a deploy), the same fields the Claude and Copilot SDK workers send.
 *
 * `supported: false` keeps the composer as it was for these kinds: it offers
 * mid-turn steering only to a worker that says `supported: true`, and reads
 * neither the hold nor the cancellable ids of one that does not.
 *
 * - `activeAttempt`: the runner's `getActiveQueueAttempt()` (`{ id, attemptId }`
 *   or null), the row the running turn owns.
 * - `turnActive`: the runner's own word that a turn runs (`isTurnActive()`),
 *   for a turn whose row has no id to show.
 * - `backgroundTaskCount`: live background work that ends with the worker
 *   (Grok's terminals).
 *
 * A turn holds the release ('turn'), then live background work ('background').
 */
export function buildSimpleSteeringState({ activeAttempt = null, turnActive = false, backgroundTaskCount = 0 } = {}) {
  const messageId = String(activeAttempt?.id || '').trim() || null;
  const turn = turnActive === true || Boolean(messageId);
  const tasks = Number(backgroundTaskCount);
  const liveTasks = Number.isInteger(tasks) && tasks > 0 ? tasks : 0;
  const releaseHold = turn ? 'turn' : (liveTasks > 0 ? 'background' : null);
  return {
    turnActive: turn,
    canSteer: false,
    holdReason: null,
    messageId,
    supported: false,
    cancellableIds: [],
    releasable: !releaseHold,
    releaseHold,
    backgroundTaskCount: liveTasks,
  };
}
