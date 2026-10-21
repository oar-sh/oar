// Browser mirror of questionAcceptsFreeText in shared/question-answer-rule.mjs
// (the relay's answer route applies the same rule). The browser cannot import
// shared/ (only server/public is served), so this is a hand-kept copy;
// question-answer-rule.test.mjs asserts it behaves exactly like the original.

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
