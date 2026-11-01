/**
 * The Cursor worker's heartbeat steering snapshot, from its turn runner
 * (cursor-turn-runner.mjs). A module of its own so it can be tested: the
 * worker main runs at import.
 *
 * Only a turn holds the release. The Cursor SDK tells the runner of no work
 * that outlives a run: whether a sub-agent or a background shell can keep
 * running after the run's result is not something its types say, and the
 * runner sees neither of them, so there is no background count to send. The
 * relay's quiet rule (10 minutes without a delivery or a turn end) covers
 * what the SDK does not say.
 */
import { buildSimpleSteeringState } from '../../shared/worker-runtime/simple-steering-state.mjs';

export function buildCursorSteeringState(turnRunner) {
  return buildSimpleSteeringState({
    activeAttempt: turnRunner.getActiveQueueAttempt(),
    turnActive: turnRunner.isTurnActive(),
  });
}
