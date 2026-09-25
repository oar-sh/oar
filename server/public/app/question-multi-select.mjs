// Multi-select question cards: the pure rules the card renderer and its
// submit path share, kept DOM-free so they are unit-testable.
//
// A provider marks a question as multi-select in the card's `context`
// (Claude's AskUserQuestion carries `multiSelect: true`; the Copilot worker
// infers it from the question text since its ask_user tool has no flag — see
// shared/question-multi-select.mjs). The card then offers checkmarks instead
// of one-shot buttons, and the answer is the selected labels joined with ", "
// — plus whatever the user typed as an extra answer — which is the string
// Claude Code's own multi-select UI produces.

/** Whether a relay question should render checkmarks rather than one-shot buttons. */
export function isMultiSelectQuestion(question) {
  if (!question || typeof question !== 'object') return false;
  const choices = Array.isArray(question.choices) ? question.choices : [];
  if (choices.length < 2) return false;
  return question?.context?.multiSelect === true;
}

/**
 * The answer string for a multi-select card: the selected labels in offer
 * order, then the free-text answer (if any) as one more item. Empty when
 * nothing was selected or typed.
 */
export function composeMultiSelectAnswer(selectedLabels, freeText = '') {
  const labels = (Array.isArray(selectedLabels) ? selectedLabels : [])
    .map((label) => String(label ?? '').trim())
    .filter(Boolean)
    .filter((label, index, all) => all.indexOf(label) === index);
  const extra = String(freeText ?? '').trim();
  if (extra && !labels.includes(extra)) labels.push(extra);
  return labels.join(', ');
}
