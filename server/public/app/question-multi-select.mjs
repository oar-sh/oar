// Multi-select question cards: the pure rules the card renderer and its
// submit path share, kept DOM-free so they are unit-testable.
//
// Two card hints ride the question's `context` (kept by the relay's
// services/relay-question-context.mjs allow-list):
//  - `multiSelect: true` — several answers are allowed. Claude states this on
//    every AskUserQuestion question; Copilot models declare it through the
//    relay's own `ask_user` (`multi_select`), and the worker falls back to the
//    wording ("select all that apply").
//  - `allowMultiSelect: true` — the provider cannot always tell (Copilot), so
//    the card offers a "Select several" switch. Claude cards never carry it:
//    they follow Claude's flag strictly (Simon, 2026-09-25).
// A multi-select card offers checkmarks and one "Reply with selection"; the
// answer is the selected labels joined with ", " — plus whatever the user
// typed as an extra answer — which is Claude's own multi-select answer format.

function choiceCount(question) {
  return Array.isArray(question?.choices) ? question.choices.length : 0;
}

/** Whether the card offers the "Select several" switch. */
export function offersMultiSelectToggle(question) {
  if (!question || typeof question !== 'object') return false;
  return choiceCount(question) >= 2 && question?.context?.allowMultiSelect === true;
}

/**
 * Whether the card renders checkmarks. `override` is the user's switch
 * position for this card (true/false), or undefined while untouched — then the
 * provider's flag decides. The switch only counts on cards that offer it.
 */
export function isMultiSelectQuestion(question, override = undefined) {
  if (!question || typeof question !== 'object') return false;
  if (choiceCount(question) < 2) return false;
  if (typeof override === 'boolean' && offersMultiSelectToggle(question)) return override;
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
