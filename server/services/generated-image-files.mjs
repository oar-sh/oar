'use strict';

import fs from 'fs';

import { IMAGE_HEADER_BYTES, readImageHeader } from '../../shared/image-header.mjs';
import { resolveGeneratedImagePath } from './generated-image-cleanup-service.mjs';

// A generated image's attachment as GET /api/conversation/:id serves it: its
// absolute file on this relay (`generatedImage.path`) and its pixel size, so
// another relay's agent can name the file in a later send. The path is worked
// out on every read, never stored: checkouts and state folders move.

// PNG and WebP headers sit in the first bytes; a JPEG's frame header comes
// after its EXIF/ICC blocks, so only a JPEG that needs more reads further.
const FIRST_READ_BYTES = 4096;

// The conversation page is polled: a file read once is not read again while
// its size and time stay the same.
const HEADER_CACHE_MAX = 500;
const headerCache = new Map();

function readFirstBytes(filePath, length) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function imageHeaderOf(filePath, stat) {
  const cached = headerCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.header;
  const first = readFirstBytes(filePath, Math.min(FIRST_READ_BYTES, stat.size));
  let header = first ? readImageHeader(first) : null;
  if (!header && first && first[0] === 0xff && first[1] === 0xd8 && stat.size > first.length) {
    const more = readFirstBytes(filePath, Math.min(IMAGE_HEADER_BYTES, stat.size));
    header = more ? readImageHeader(more) : null;
  }
  if (headerCache.size >= HEADER_CACHE_MAX) headerCache.delete(headerCache.keys().next().value);
  headerCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, header });
  return header;
}

function positiveInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function withFile(attachment, root) {
  const { path: _stored, ...generatedImage } = attachment.generatedImage;
  const bare = { ...attachment, generatedImage };
  const filePath = resolveGeneratedImagePath({
    root,
    sessionId: generatedImage.sessionId,
    relativePath: generatedImage.relativePath,
  });
  if (!filePath) return bare;
  let stat = null;
  try {
    stat = fs.statSync(filePath, { throwIfNoEntry: false }) || null;
  } catch {}
  if (!stat?.isFile()) return bare;
  const width = positiveInt(attachment.width);
  const height = positiveInt(attachment.height);
  // New attachments carry their size; older ones are read.
  const header = width && height ? null : imageHeaderOf(filePath, stat);
  return {
    ...bare,
    ...(header ? { width: header.width, height: header.height } : {}),
    ...(!attachment.type && header?.mime ? { type: header.mime } : {}),
    generatedImage: { ...generatedImage, path: filePath },
  };
}

/**
 * `messages` with each generated-image attachment given its file path and
 * pixel size, when the file is there. Messages without one come back as they
 * are; a missing or unreadable file leaves the attachment without a path.
 * Never throws.
 */
export function withGeneratedImageFiles(messages, { resolveSessionStateRoot } = {}) {
  if (!Array.isArray(messages) || typeof resolveSessionStateRoot !== 'function') return messages;
  let root = '';
  try {
    root = String(resolveSessionStateRoot() || '').trim();
  } catch {}
  if (!root) return messages;
  return messages.map((message) => {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : null;
    if (!attachments || !attachments.some((entry) => entry?.generatedImage && typeof entry.generatedImage === 'object')) return message;
    return {
      ...message,
      attachments: attachments.map((entry) => {
        if (!entry?.generatedImage || typeof entry.generatedImage !== 'object') return entry;
        try {
          return withFile(entry, root);
        } catch {
          return entry;
        }
      }),
    };
  });
}
