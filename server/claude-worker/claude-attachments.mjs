import fs from 'fs';

// Anthropic rejects very large base64 image blocks; larger images fall back to
// a path reference so Claude can Read them from disk instead.
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

// The Anthropic image content block accepts exactly these media types; an
// svg/bmp/heic block is a 400 that fails the whole turn, so anything else
// falls back to a path reference like an oversized image.
export const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

function isImageAttachment(att) {
  return String(att?.type || '').toLowerCase().startsWith('image/');
}

function isEmbeddableImageMediaType(mediaType) {
  return ANTHROPIC_IMAGE_MEDIA_TYPES.has(String(mediaType || '').trim().toLowerCase());
}

function imageBlockFromDataUrl(att, maxInlineImageBytes) {
  const dataUrl = String(att?.dataUrl || '').trim();
  if (!dataUrl.startsWith('data:')) return null;
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;
  const mediaType = String(match[1] || '').trim().toLowerCase();
  const data = String(match[2] || '').trim();
  if (!isEmbeddableImageMediaType(mediaType) || !data) return null;
  // The same size guard as the file-read branch: base64 is 4/3 the raw size,
  // and an oversized data URL would defeat the cap the guard exists for.
  if (Math.floor((data.length * 3) / 4) > maxInlineImageBytes) return null;
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data },
  };
}

/**
 * Map hydrated relay attachments to Anthropic user-message content.
 *
 * Returns `{ imageBlocks, noteLines }`:
 * - `imageBlocks` are Anthropic `image` content blocks (base64) for images
 *   small enough to embed inline.
 * - `noteLines` are prompt text lines describing every attachment, including
 *   absolute paths so Claude's Read tool can open non-image files (and
 *   oversized images) directly.
 */
export function buildClaudeAttachmentContent(rawAttachments, {
  fsImpl = fs,
  maxInlineImageBytes = MAX_INLINE_IMAGE_BYTES,
} = {}) {
  const input = Array.isArray(rawAttachments) ? rawAttachments : [];
  const imageBlocks = [];
  const noteLines = [];
  for (const att of input) {
    if (!att || typeof att !== 'object') continue;
    const name = String(att.name || 'attachment').trim() || 'attachment';
    const mime = String(att.type || 'application/octet-stream').trim() || 'application/octet-stream';
    const filePath = String(att.path || '').trim();

    if (isImageAttachment(att)) {
      let embedded = false;
      // Only media types the Anthropic image block accepts are embedded;
      // everything else (svg, bmp, heic, …) would 400 the whole turn and
      // falls back to a path reference instead.
      if (filePath && isEmbeddableImageMediaType(mime) && fsImpl.existsSync(filePath)) {
        try {
          const bytes = fsImpl.readFileSync(filePath);
          if (Buffer.isBuffer(bytes) && bytes.length && bytes.length <= maxInlineImageBytes) {
            imageBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mime.toLowerCase(),
                data: bytes.toString('base64'),
              },
            });
            embedded = true;
          }
        } catch {
          embedded = false;
        }
      }
      if (!embedded) {
        const blockFromDataUrl = imageBlockFromDataUrl(att, maxInlineImageBytes);
        if (blockFromDataUrl) {
          imageBlocks.push(blockFromDataUrl);
          embedded = true;
        }
      }
      if (embedded) {
        noteLines.push(`Attached image "${name}" (${mime}) is embedded in this message.`);
      } else if (filePath) {
        noteLines.push(`Attached image "${name}" (${mime}): ${filePath}`);
      } else {
        noteLines.push(`Attached image "${name}" (${mime}) could not be embedded or resolved to a readable path.`);
      }
      continue;
    }

    if (filePath && fsImpl.existsSync(filePath)) {
      noteLines.push(`Attached file "${name}" (${mime}): ${filePath}`);
    } else {
      // A file whose hydration failed must still be visible to the model —
      // silently dropping it reads as "the user attached nothing".
      noteLines.push(`Attached file "${name}" (${mime}) could not be resolved to a readable path.`);
    }
  }
  return { imageBlocks, noteLines };
}

/**
 * Build the full Anthropic user-message content array for a relay message.
 * Text first (user text + attachment notes + server-provided attachment
 * context), then inline image blocks.
 */
export function buildClaudeUserContent(message, { fsImpl = fs, maxInlineImageBytes = MAX_INLINE_IMAGE_BYTES } = {}) {
  const text = String(message?.text || '').trim();
  const { imageBlocks, noteLines } = buildClaudeAttachmentContent(message?.attachments, { fsImpl, maxInlineImageBytes });
  const attachmentPromptContext = String(message?.attachmentPromptContext || '').trim();
  const textParts = [text];
  if (noteLines.length) textParts.push(noteLines.join('\n'));
  if (attachmentPromptContext) textParts.push(attachmentPromptContext);
  const combinedText = textParts.filter(Boolean).join('\n\n');
  const content = [];
  if (combinedText) content.push({ type: 'text', text: combinedText });
  content.push(...imageBlocks);
  if (!content.length) content.push({ type: 'text', text: '' });
  return content;
}
