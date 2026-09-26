// Keeps a "/x" message the relay delivers to the Claude CLI plain text.
//
// The relay itself runs only /compact and /preview as commands, and neither
// reaches a worker as text: the composer (and the /api/message route, for
// /compact) intercept them. Any other "/x" the composer sends only after its
// warn-once guard ("press send again to send as text"), and the API accepts
// it as-is — so it must reach the model as the text the user typed. The Claude
// CLI, however, runs a prompt as a slash command when the string, or its LAST
// text block trimmed, starts with "/". Between turns that ran "/help what is
// 3 + 4?" as the CLI's /help (a `local_command` with "isn't available in this
// environment" as its output): the model never saw the question, and the
// relay attributed the next turn's reply to that row (live, 2026-09-26).
//
// The guard is a zero-width space in front of the "/". JavaScript's trim()
// does not strip U+200B, so neither the CLI's command check nor its queue's
// "is this a command" check fires, and the message is handled exactly like
// any other plain-text prompt (live probe, CLI 2.1.283: no local_command, the
// model answered the question, the transcript keeps the character). The
// relay stores and shows the user's own text; only the CLI sees the guard.
//
// A steered message needs none: the steer note (shared/steer-note.mjs) already
// leads its text, so the guard only applies where the text itself starts
// with "/".
//
// Not the SDK's per-message `client_composed: true`: that suppresses the
// dispatch too (same probe), but older CLIs ignore the field, it also turns
// off `@path` expansion and drops part of the turn-start context for that
// message (the probe lost the token-budget reminder), and per the CLI bundle
// its queue still classifies the text by the leading "/" (e.g. never merges
// it with other queued prompts) — the guard makes it plain text everywhere.

export const SLASH_COMMAND_GUARD = '\u200B';

function readsAsSlashCommand(text) {
  return typeof text === 'string' && text.trim().startsWith('/');
}

/** Prefix the guard when the CLI would read the text as a slash command. */
export function withSlashCommandGuard(text) {
  return readsAsSlashCommand(text) ? `${SLASH_COMMAND_GUARD}${text}` : text;
}

/**
 * The guard applied to Claude user content: a string, or every text block of a
 * content-block array (the CLI inspects the last block; guarding each keeps
 * that true whatever the block order). Returns the input itself when nothing
 * needed a guard; never mutates it.
 */
export function withSlashCommandGuardContent(content) {
  if (typeof content === 'string') return withSlashCommandGuard(content);
  if (!Array.isArray(content)) return content;
  if (!content.some((block) => block?.type === 'text' && readsAsSlashCommand(block.text))) return content;
  return content.map((block) => (block?.type === 'text' && readsAsSlashCommand(block.text)
    ? { ...block, text: withSlashCommandGuard(block.text) }
    : block));
}

/**
 * The user's own text from a guarded prompt: the leading guard is dropped only
 * where it stands in front of a "/", so other text is returned unchanged.
 */
export function stripSlashCommandGuard(text) {
  const value = String(text ?? '');
  return value.startsWith(SLASH_COMMAND_GUARD) && readsAsSlashCommand(value.slice(SLASH_COMMAND_GUARD.length))
    ? value.slice(SLASH_COMMAND_GUARD.length)
    : value;
}

/** stripSlashCommandGuard over a string or each text block of a content array. */
export function stripSlashCommandGuardContent(content) {
  if (typeof content === 'string') return stripSlashCommandGuard(content);
  if (!Array.isArray(content)) return content;
  return content.map((block) => (block?.type === 'text' && typeof block.text === 'string'
    ? { ...block, text: stripSlashCommandGuard(block.text) }
    : block));
}
