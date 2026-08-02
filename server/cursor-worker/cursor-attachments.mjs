import fs from 'fs';

// Very large base64 image payloads risk rejection; larger images fall back to
// a path reference so the agent can read them from disk instead.
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

function isImageAttachment(att) {
  return String(att?.type || '').toLowerCase().startsWith('image/');
}

function imageFromDataUrl(att) {
  const dataUrl = String(att?.dataUrl || '').trim();
  if (!dataUrl.startsWith('data:')) return null;
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;
  const mimeType = String(match[1] || '').trim().toLowerCase();
  const data = String(match[2] || '').trim();
  if (!mimeType.startsWith('image/') || !data) return null;
  return { data, mimeType };
}

/**
 * Build the `{ text, images }` payload for `agent.send()` from a relay
 * message. Mirrors the Claude worker's attachment handling: images small
 * enough to embed become base64 `{ data, mimeType }` entries; everything else
 * (non-images, oversized or unreadable images) becomes a prompt note line with
 * the absolute path so the agent's file tools can open it directly.
 *
 * Text composition order: user text, note lines, server-provided
 * `attachmentPromptContext`, joined by blank lines.
 */
export function buildCursorUserMessage(message, {
  fsImpl = fs,
  maxInlineImageBytes = MAX_INLINE_IMAGE_BYTES,
} = {}) {
  const text = String(message?.text || '').trim();
  const input = Array.isArray(message?.attachments) ? message.attachments : [];
  const images = [];
  const noteLines = [];

  for (const att of input) {
    if (!att || typeof att !== 'object') continue;
    const name = String(att.name || 'attachment').trim() || 'attachment';
    const mime = String(att.type || 'application/octet-stream').trim() || 'application/octet-stream';
    const filePath = String(att.path || '').trim();

    if (isImageAttachment(att)) {
      let embedded = false;
      if (filePath && fsImpl.existsSync(filePath)) {
        try {
          const bytes = fsImpl.readFileSync(filePath);
          if (Buffer.isBuffer(bytes) && bytes.length && bytes.length <= maxInlineImageBytes) {
            images.push({
              data: bytes.toString('base64'),
              mimeType: mime.toLowerCase().startsWith('image/') ? mime.toLowerCase() : 'image/png',
            });
            embedded = true;
          }
        } catch {
          embedded = false;
        }
      }
      if (!embedded) {
        const fromDataUrl = imageFromDataUrl(att);
        if (fromDataUrl) {
          images.push(fromDataUrl);
          embedded = true;
        }
      }
      if (embedded) {
        noteLines.push(`Attached image "${name}" (${mime}) is embedded in this message.`);
      } else if (filePath) {
        noteLines.push(`Attached image "${name}" (${mime}): ${filePath}`);
      }
      continue;
    }

    if (filePath && fsImpl.existsSync(filePath)) {
      noteLines.push(`Attached file "${name}" (${mime}): ${filePath}`);
    }
  }

  const attachmentPromptContext = String(message?.attachmentPromptContext || '').trim();
  const textParts = [text];
  if (noteLines.length) textParts.push(noteLines.join('\n'));
  if (attachmentPromptContext) textParts.push(attachmentPromptContext);
  return { text: textParts.filter(Boolean).join('\n\n'), images };
}
