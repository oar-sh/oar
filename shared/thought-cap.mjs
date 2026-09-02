// The per-thought character cap shared by every worker's reasoning channel.
//
// A single reasoning block can run to hundreds of kilobytes; the relay stores
// and re-broadcasts every thought update, so an uncapped thought turns one
// verbose turn into a transport problem. 16 KiB is the cap the Copilot
// extension's reasoning-stream bridge has used since it shipped, and the
// worker normalizers copied it verbatim — this is that one definition.
export const MAX_THOUGHT_CHARS = 16 * 1024;

export function capThought(text) {
  const value = String(text || '');
  return value.length <= MAX_THOUGHT_CHARS ? value : value.slice(0, MAX_THOUGHT_CHARS);
}
