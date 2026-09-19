// Mid-turn steering: a message sent while a Claude turn was running is pushed
// into the live turn, the interrupted reply settles with kind='absorbed', and
// the rest of the turn (with the final reply) lands on the steered message's
// own row. The transcript renders those rows as ONE flow — absorbed reply,
// steered user bubble, continuing reply — by classing the trio here.
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
      // A user row is steered iff the row above it is an absorbed reply.
      const previous = previousMessageNode(node);
      const steered = !!previous
        && previous.classList.contains('assistant')
        && previous.classList.contains(ABSORBED_MSG_CLASS);
      changes += setClass(node, STEERED_MSG_CLASS, steered);
      continue;
    }
    if (node.classList.contains('assistant')) {
      // The reply continuing a steered message keeps the group together.
      const previous = previousMessageNode(node);
      const continues = !!previous
        && previous.classList.contains('user')
        && previous.classList.contains(STEERED_MSG_CLASS);
      changes += setClass(node, STEERED_CONTINUATION_CLASS, continues);
    }
  }
  return changes;
}
