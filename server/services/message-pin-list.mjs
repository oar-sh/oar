'use strict';

// The list of pinned messages a conversation carries: one short plain-text
// preview per pin, so the browser can show the list without loading (or
// rendering markdown for) messages outside its history page.

import { stripRelayPromptContext } from './relay-prompt-sanitizer.mjs';

export const MESSAGE_PIN_LIMIT = 100;
export const PIN_PREVIEW_MAX_LENGTH = 160;

function countAttachments(raw) {
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw !== 'string' || !raw) return 0;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

// Light on purpose: enough that a heading, a list or a link reads as a line of
// text. Single * and _ stay, they are more often part of a name than emphasis.
export function buildPinPreview(text, mode = '') {
  const plain = String(stripRelayPromptContext(String(text || ''), mode) || '')
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt) => (alt ? `🖼 ${alt}` : '🖼'))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // By code point, so an emoji at the cut is dropped whole.
  const points = Array.from(plain);
  if (points.length <= PIN_PREVIEW_MAX_LENGTH) return plain;
  return `${points.slice(0, PIN_PREVIEW_MAX_LENGTH - 1).join('').trimEnd()}…`;
}

export function buildPinList(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => String(row?.id || '').trim() && row?.pinned_at)
    .map((row) => ({
      messageId: String(row.id).trim(),
      role: String(row.role || '').trim(),
      preview: buildPinPreview(row.text, row.mode),
      timestamp: row.timestamp || null,
      pinnedAt: row.pinned_at,
      attachmentCount: countAttachments(row.attachments),
      hiddenFromShares: Number(row.hidden_from_shares || 0) === 1,
    }));
}
