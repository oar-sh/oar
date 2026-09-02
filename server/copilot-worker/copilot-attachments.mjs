import fs from 'fs';

// Very large base64 payloads risk rejection by the runtime; larger images fall
// back to a file reference so the agent can read them from disk instead. Same
// threshold the Claude and Cursor workers use.
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
 * Build the `MessageOptions` payload for `session.send()` from a relay
 * message.
 *
 * Mirrors `buildCursorUserMessage` / `buildClaudeUserContent`: images small
 * enough to embed travel inline, everything else becomes a reference the
 * agent's file tools can open, and the server-provided
 * `attachmentPromptContext` is appended to the prompt. What differs is the
 * carrier — the Copilot SDK's `MessageOptions.attachments` is a typed union
 * rather than content blocks:
 *
 *   image, embeddable → `{ type: 'blob', data, mimeType, displayName }`
 *   image, too large  → `{ type: 'file', path, displayName }`
 *   any other file    → `{ type: 'file', path, displayName }`
 *
 * The note lines are kept even though the attachments are structured, because
 * they are what tells the model the absolute path of a file it may want to
 * re-read with its own tools — the same reason the siblings emit them.
 *
 * Text composition order (identical to the siblings): user text, note lines,
 * `attachmentPromptContext`, joined by blank lines.
 */
export function buildCopilotMessageOptions(message, {
  fsImpl = fs,
  maxInlineImageBytes = MAX_INLINE_IMAGE_BYTES,
} = {}) {
  const text = String(message?.text || '').trim();
  const input = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachments = [];
  const noteLines = [];

  for (const att of input) {
    if (!att || typeof att !== 'object') continue;
    const name = String(att.name || 'attachment').trim() || 'attachment';
    const mime = String(att.type || 'application/octet-stream').trim() || 'application/octet-stream';
    const filePath = String(att.path || '').trim();

    if (isImageAttachment(att)) {
      let blob = null;
      if (filePath && fsImpl.existsSync(filePath)) {
        try {
          const bytes = fsImpl.readFileSync(filePath);
          if (Buffer.isBuffer(bytes) && bytes.length && bytes.length <= maxInlineImageBytes) {
            blob = {
              data: bytes.toString('base64'),
              mimeType: mime.toLowerCase().startsWith('image/') ? mime.toLowerCase() : 'image/png',
            };
          }
        } catch {
          blob = null;
        }
      }
      if (!blob) blob = imageFromDataUrl(att);
      if (blob) {
        attachments.push({ type: 'blob', data: blob.data, mimeType: blob.mimeType, displayName: name });
        noteLines.push(`Attached image "${name}" (${mime}) is embedded in this message.`);
      } else if (filePath) {
        attachments.push({ type: 'file', path: filePath, displayName: name });
        noteLines.push(`Attached image "${name}" (${mime}): ${filePath}`);
      }
      continue;
    }

    if (filePath && fsImpl.existsSync(filePath)) {
      attachments.push({ type: 'file', path: filePath, displayName: name });
      noteLines.push(`Attached file "${name}" (${mime}): ${filePath}`);
    }
  }

  const attachmentPromptContext = String(message?.attachmentPromptContext || '').trim();
  const textParts = [text];
  if (noteLines.length) textParts.push(noteLines.join('\n'));
  if (attachmentPromptContext) textParts.push(attachmentPromptContext);
  return { prompt: textParts.filter(Boolean).join('\n\n'), attachments };
}
