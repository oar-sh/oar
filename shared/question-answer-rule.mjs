// What an answer to a question card means, in one place. The relay's answer
// route (a card that takes no typed text accepts only its choices), the card
// view (no reply box on such a card; server/public/app/question-answer-rule.mjs
// is its browser copy) and every reader of an approve / deny
// card (OAR's own remote-relay approvals, Claude Cloud's and Copilot's
// permission cards) apply the same rule: an answer is a choice when it equals
// the choice's label trimmed and in any case.

function answerKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** The card's own label for `answer`, or null when it is none of `choices`. */
export function matchQuestionChoice(answer, choices) {
  const key = answerKey(answer);
  if (!key || !Array.isArray(choices)) return null;
  for (const choice of choices) {
    const label = String(choice ?? '').trim();
    if (label && answerKey(label) === key) return label;
  }
  return null;
}

/**
 * An approve / deny card's answer: 'approve' for its approve choice, 'deny'
 * for its deny choice, null for anything else. A caller decides what null
 * means for its card; it is never the user's plain Deny.
 */
export function readApprovalAnswer(answer, { approve, deny }) {
  const key = answerKey(answer);
  if (!key) return null;
  if (key === answerKey(approve)) return 'approve';
  if (key === answerKey(deny)) return 'deny';
  return null;
}

/**
 * Whether a card takes typed text. A card with choices takes it only when it
 * says so (`allowFreeform: true`); a missing flag counts as false there, as
 * the create route and the relay's question rows read it. Without choices a
 * card always does: it could not be answered otherwise.
 */
export function questionAcceptsFreeText(question) {
  const choices = Array.isArray(question?.choices) ? question.choices : [];
  return question?.allowFreeform === true || choices.length === 0;
}

/**
 * The answer a card that takes no typed text accepts, as the card's labels:
 * one choice, or on a multi-select card several, ", "-joined the way the card
 * sends them. null when the answer is not made of the card's choices.
 */
export function closedQuestionAnswer({ choices, multiSelect = false } = {}, answer) {
  const single = matchQuestionChoice(answer, choices);
  if (single || !multiSelect) return single;
  const labels = [];
  for (const part of String(answer ?? '').split(',')) {
    const label = matchQuestionChoice(part, choices);
    if (!label) return null;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.length ? labels.join(', ') : null;
}
