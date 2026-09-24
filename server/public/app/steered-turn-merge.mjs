// Mid-turn steering: a message sent while a Claude turn was running is pushed
// into the live turn. Three settle shapes reach the transcript:
// - handoff: the interrupted reply settles with kind='absorbed', and the rest
//   of the turn (with the final reply) lands on the steered message's own row.
//   Those rows render as ONE flow — absorbed reply, steered user bubble,
//   continuing reply.
// - fold: the CLI answered the steer inside the running turn; its row settles
//   with a kind='folded' stub, a compact marker under its own user message.
//   It never merges forward — the next message is an ordinary turn.
// - stopped: the steer was pushed into a turn the user then stopped, so it
//   went unanswered (kind='stopped', a marker with Resend).
// The steered user message of a fold or stop is still classed as steered.
//
// One idempotent DOM pass, same contract as syncTranscriptSeparators: every
// insertion path (full render, live append, prepended history page) re-runs it,
// so classes heal when the pair arrives across two loads and un-apply when a
// re-render drops the absorbed marker. Kept DOM-only and import-light so it is
// jsdom-testable (conversation-view.js touches window at module scope).
import { SEPARATOR_CLASS } from './transcript-separators.mjs';

export const ABSORBED_MSG_CLASS = 'msg-absorbed';
export const STEERED_MSG_CLASS = 'msg-steered';
export const STEERED_CONTINUATION_CLASS = 'msg-steered-continuation';
export const FOLDED_MSG_CLASS = 'msg-folded';
export const STEER_STOPPED_MSG_CLASS = 'msg-steer-stopped';

/** The assistant row kinds that are settle markers of a steer, not replies. */
export const STEER_MARKER_CLASS_BY_KIND = Object.freeze({
  folded: FOLDED_MSG_CLASS,
  stopped: STEER_STOPPED_MSG_CLASS,
});

function isSteerMarker(node) {
  return !!node?.classList
    && node.classList.contains('assistant')
    && (node.classList.contains(FOLDED_MSG_CLASS) || node.classList.contains(STEER_STOPPED_MSG_CLASS));
}

/**
 * The `.msg` row above, refusing to cross a separator row: a steering pair is
 * seconds apart, so a day or compaction break between two rows proves they are
 * NOT that pair, and pulling them together across it would look broken.
 */
function previousMessageNode(node) {
  for (let prev = node?.previousElementSibling; prev; prev = prev.previousElementSibling) {
    if (prev.classList?.contains(SEPARATOR_CLASS)) return null;
    if (prev.classList?.contains('msg')) return prev;
  }
  return null;
}

/** The `.msg` row below, refusing to cross a separator row. */
function nextMessageNode(node) {
  for (let next = node?.nextElementSibling; next; next = next.nextElementSibling) {
    if (next.classList?.contains(SEPARATOR_CLASS)) return null;
    if (next.classList?.contains('msg')) return next;
  }
  return null;
}

function setClass(node, className, on) {
  if (!node?.classList) return 0;
  if (node.classList.contains(className) === on) return 0;
  node.classList.toggle(className, on);
  return 1;
}

/**
 * Sync the merge classes over the container's rows. Returns the number of
 * class changes (0 = the pass was a no-op), which the tests assert on.
 */
export function syncSteeredTurnMerge(container) {
  if (!container || !container.children) return 0;
  let changes = 0;
  for (const node of container.children) {
    if (!node.classList?.contains('msg')) continue;
    if (node.classList.contains('user')) {
      // A user row is steered iff the row above it is an absorbed reply, or
      // its own settle marker (fold/stop) sits right below it.
      const previous = previousMessageNode(node);
      const steered = (!!previous
        && previous.classList.contains('assistant')
        && previous.classList.contains(ABSORBED_MSG_CLASS))
        || isSteerMarker(nextMessageNode(node));
      changes += setClass(node, STEERED_MSG_CLASS, steered);
      continue;
    }
    if (node.classList.contains('assistant')) {
      // The reply continuing a steered message keeps the group together. A
      // settle marker is not a reply: it keeps its own compact styling.
      const previous = previousMessageNode(node);
      const continues = !isSteerMarker(node)
        && !!previous
        && previous.classList.contains('user')
        && previous.classList.contains(STEERED_MSG_CLASS);
      changes += setClass(node, STEERED_CONTINUATION_CLASS, continues);
    }
  }
  return changes;
}
