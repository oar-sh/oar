// Whether a choice question reads as "pick several" — for providers whose
// ask-user tool has no multi-select flag (Copilot's `ask_user`; Claude's
// AskUserQuestion carries `multiSelect: true` itself). The card then offers
// checkmarks instead of one-shot buttons and answers with the selected labels
// joined by ", ". Conservative on purpose: an ordinary "which one?" keeps its
// buttons, because a wrongly multi-select card costs the user a second click
// while a wrongly single-select one forces them into the free-text field.
export function looksLikeMultiSelectQuestion(questionText, choices = []) {
  if (!Array.isArray(choices) || choices.length < 2) return false;
  const text = String(questionText || '');
  return /\ball that apply\b/i.test(text)
    || /\bmulti-?select\b/i.test(text)
    || /\b(select|choose|pick|check|tick|enable|turn on)\b[^.!?\n]{0,40}\b(all|multiple|several|any number|one or more|as many|more than one)\b/i.test(text)
    || /\bmultiple (choices|options|selections|answers)\b/i.test(text)
    || /\bone or more\b/i.test(text);
}
