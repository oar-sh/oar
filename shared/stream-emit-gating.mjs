// The single emit-gating rule every worker's stream channel uses.
//
// Mirrors the gating the Copilot extension's stream publisher applies, so
// `relay_stream` traffic stays comparable across providers and engines: a
// conversation run on Claude, Cursor, Grok or Copilot produces the same shape
// of incremental updates for the same prose. It was copied byte-for-byte into
// four normalizers before it lived here; keep it in one place so a change to
// the flood control lands everywhere at once.
//
// Returns true when `nextText` is worth publishing given the last text that
// was published:
//   - never publish empty text;
//   - always publish the first text;
//   - never re-publish identical text;
//   - publish once 24+ new characters accumulated, or on a sentence/line
//     boundary, or whenever the text shrank or was rewritten.
export function shouldEmitStreamUpdate(nextText, previousText) {
  const next = String(nextText || '');
  const prev = String(previousText || '');
  if (!next) return false;
  if (!prev) return true;
  if (next === prev) return false;
  const delta = next.length - prev.length;
  if (delta >= 24) return true;
  if (delta > 0 && /[\n.!?:)]$/.test(next)) return true;
  if (delta <= 0) return true;
  return false;
}
