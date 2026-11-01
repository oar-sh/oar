/**
 * The Grok worker's heartbeat steering snapshot, from its turn runner
 * (grok-turn-runner.mjs). A module of its own so it can be tested: the worker
 * main runs at import.
 *
 * A turn holds the release, then any open terminal: it dies with the worker.
 * Counted from the terminal's start (`openTerminalCount`), not from when it
 * becomes a panel row (`backgroundTaskIds`, after a 2 s grace), so a command
 * started just before a recycle sweep still holds it.
 */
import { buildSimpleSteeringState } from '../../shared/worker-runtime/simple-steering-state.mjs';

export function buildGrokSteeringState(turnRunner) {
  const open = Number(turnRunner.openTerminalCount?.()) || 0;
  // The live ids are open terminals too; the larger count wins should the two
  // ever disagree.
  const listed = turnRunner.backgroundTaskIds?.().length || 0;
  return buildSimpleSteeringState({
    activeAttempt: turnRunner.getActiveQueueAttempt(),
    turnActive: turnRunner.isTurnActive(),
    backgroundTaskCount: Math.max(open, listed),
  });
}
