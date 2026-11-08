'use strict';

// The images a send names by path (`imagePaths` of POST /api/message: a
// relay_tool send or create_session with `images`), read on this relay.
//
// A path is allowed when its real path lies in the session's folder, or is
// exactly a generated image of a session on this relay:
// <session-state root>/<session>/generated-images/<conversation>/<message>/img-NN.<ext>,
// of a conversation that is not deleted. The relay's own data (data dir,
// upload dirs, database and config files) and the rest of the session-state
// root are never read, even inside the session's folder. Every check runs
// before anything is stored: one refused path refuses the whole send.
//
// A hard link is a file of its own to these rules: one in the session's
// folder to a file elsewhere (the database, say) passes the path checks, as
// the path is all the relay sees. What stops it is the content: only PNG,
// JPEG and WebP bytes are ever attached, and only to the model.

import crypto from 'crypto';
import fsDefault from 'fs';
import path from 'path';

import { IMAGE_HEADER_BYTES, readImageHeader } from '../../shared/image-header.mjs';
import { OPENAI_IMAGE_LIMITS } from '../../shared/openai-image-options.mjs';

export { IMAGE_INPUT_REFUSED_CODE } from '../../shared/openai-image-options.mjs';

// The largest attached image OpenAI is sent: a side, and the pixels in all.
export const IMAGE_INPUT_EDGE_MAX = 16384;
export const IMAGE_INPUT_PIXELS_MAX = 64 * 1000 * 1000;
const PATH_CHARS_MAX = 4096;
// Paths one send may name before the duplicates go.
export const IMAGE_INPUT_PATHS_MAX = 16;
const READ_CHUNK_BYTES = 1024 * 1024;
// PNG chunks read for an acTL before the first IDAT.
const PNG_CHUNKS_SCANNED_MAX = 1024;

const WIN32_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i;
const STORAGE_SEGMENT = /^[A-Za-z0-9_-]{1,96}$/;
const GENERATED_IMAGE_FILE = /^img-\d{2}\.(?:png|jpe?g|webp)$/i;

function shown(raw) {
  const text = String(raw ?? '');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function refused(error) {
  return { ok: false, error };
}

function isCaseInsensitive(platform) {
  return platform === 'win32' || platform === 'darwin';
}

/**
 * Whether `raw` has the shape of an absolute local file path on `platform`,
 * before anything touches the disk: `{ ok:true }` or `{ ok:false, error }`.
 * Network and device paths (\\host, //host, \\?\, \\.\) are refused, since
 * merely opening one can hand out the relay's credentials; on win32 also
 * alternate data streams, segments that end in a dot or a space, and
 * reserved device names (CON, NUL.png, COM1, …).
 */
export function checkImageInputPathShape(raw, { platform = process.platform } = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > PATH_CHARS_MAX || raw.includes('\0')) {
    return refused('an image path is empty, too long or not a path');
  }
  const win32 = platform === 'win32';
  if (/^[\\/]{2}/.test(raw)) return refused(`"${shown(raw)}" is a network or device path`);
  if (win32) {
    if (!/^[A-Za-z]:[\\/]/.test(raw)) return refused(`"${shown(raw)}" is not an absolute path on this relay (C:\\… on Windows)`);
    if (raw.indexOf(':', 2) !== -1) return refused(`"${shown(raw)}" names an alternate data stream`);
  } else if (!path.posix.isAbsolute(raw)) {
    return refused(`"${shown(raw)}" is not an absolute path on this relay`);
  }
  const segments = raw.split(win32 ? /[\\/]/ : '/').slice(win32 ? 1 : 0).filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return refused(`"${shown(raw)}" has . or .. segments; give the full path`);
  }
  if (win32) {
    if (segments.some((segment) => /[. ]$/.test(segment))) {
      return refused(`"${shown(raw)}" has a name that ends in a dot or a space`);
    }
    if (segments.some((segment) => WIN32_RESERVED_NAME.test(segment.split('.')[0].trimEnd()))) {
      return refused(`"${shown(raw)}" names a reserved device`);
    }
  }
  return { ok: true };
}

function realPathOf(fs, value) {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    return fs.realpathSync.native(text);
  } catch {
    return null;
  }
}

function makePathKey(platform) {
  return (value) => (isCaseInsensitive(platform) ? String(value).toLowerCase() : String(value));
}

/** The parts of `real` below `root` (both real paths), or null when it is not inside. */
function partsBelow(real, root, key, sep) {
  const a = key(real);
  const b = key(root);
  if (a === b) return [];
  const prefix = b.endsWith(sep) ? b : `${b}${sep}`;
  if (!a.startsWith(prefix)) return null;
  return real.slice(prefix.length).split(sep);
}

/**
 * The roots one send's paths are checked against, resolved once: the
 * session's folder, the session-state root, and the relay's own folders and
 * files. A root that does not resolve allows nothing (no fail-open).
 */
export function resolveImageInputRoots({
  cwd = '',
  sessionStateRoot = '',
  deniedDirs = [],
  deniedFiles = [],
  fs = fsDefault,
} = {}) {
  return {
    cwd: realPathOf(fs, cwd),
    cwdShown: String(cwd || '').trim(),
    sessionStateRoot: realPathOf(fs, sessionStateRoot),
    deniedDirs: (Array.isArray(deniedDirs) ? deniedDirs : []).map((dir) => realPathOf(fs, dir)).filter(Boolean),
    deniedFiles: (Array.isArray(deniedFiles) ? deniedFiles : [])
      .map((file) => realPathOf(fs, file) || (String(file || '').trim() ? path.resolve(String(file)) : null))
      .filter(Boolean),
  };
}

/**
 * Where an image path may be read from: `{ ok:true, realPath, source }`
 * (`source` 'cwd' or 'generated') or `{ ok:false, error }`. The path and the
 * roots are real paths; `isLiveConversation(id)` says whether a conversation
 * exists and is not deleted.
 */
export function resolveImageInputPath(raw, roots, {
  isLiveConversation = () => false,
  platform = process.platform,
  fs = fsDefault,
} = {}) {
  const shape = checkImageInputPathShape(raw, { platform });
  if (!shape.ok) return shape;
  const key = makePathKey(platform);
  const sep = platform === 'win32' ? '\\' : path.sep;
  const outside = () => refused(`"${shown(raw)}" is outside this session's folder${roots?.cwdShown ? ` (${shown(roots.cwdShown)})` : ''} and is no image this relay generated`);
  const realPath = realPathOf(fs, raw);
  // Outside the roots a missing file reads like any other path there, so
  // the answer tells nothing of what exists on this relay.
  if (!realPath) return namedInsideRoots(raw, roots, { platform, key, sep }) ? refused(`"${shown(raw)}" was not found on this relay`) : outside();
  // The file the checks below are about: the read compares its descriptor
  // with it, so a folder swapped for a link in between is caught.
  let identity = null;
  try {
    const stat = fs.statSync(realPath, { bigint: true });
    identity = { dev: stat.dev, ino: stat.ino };
  } catch {
    return refused(`"${shown(raw)}" was not found on this relay`);
  }

  if (roots?.sessionStateRoot) {
    const parts = partsBelow(realPath, roots.sessionStateRoot, key, sep);
    if (parts) {
      const [session, folder, conversationId, messageId, file, ...rest] = parts;
      const shaped = parts.length === 5 && !rest.length
        && STORAGE_SEGMENT.test(session)
        && key(folder) === 'generated-images'
        && STORAGE_SEGMENT.test(conversationId)
        && STORAGE_SEGMENT.test(messageId)
        && GENERATED_IMAGE_FILE.test(file);
      if (!shaped) {
        return refused(`"${shown(raw)}" is in this relay's session-state folder, where only the generated images (…/generated-images/<conversation>/<message>/img-NN.png) can be attached`);
      }
      if (!isLiveConversation(conversationId)) {
        return refused(`"${shown(raw)}" is a generated image of a session that is gone from this relay`);
      }
      return { ok: true, realPath, source: 'generated', identity };
    }
  }
  const own = (roots?.deniedDirs || []).some((dir) => partsBelow(realPath, dir, key, sep))
    || (roots?.deniedFiles || []).some((file) => key(file) === key(realPath));
  if (own) return refused(`"${shown(raw)}" is in this relay's own data (data, uploads, database or config), which is never attached`);
  if (roots?.cwd && partsBelow(realPath, roots.cwd, key, sep)) return { ok: true, realPath, source: 'cwd', identity };
  return outside();
}

/** Whether `raw`, as written, names a place under the session's folder or the session-state root. */
function namedInsideRoots(raw, roots, { platform, key, sep }) {
  const flavour = platform === 'win32' ? path.win32 : path.posix;
  const named = flavour.normalize(raw);
  return [roots?.cwd, roots?.cwdShown, roots?.sessionStateRoot]
    .filter(Boolean)
    .some((root) => partsBelow(named, flavour.normalize(root), key, sep) !== null);
}

function u32be(bytes, at) {
  return ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
}

/** Whether a PNG has an acTL chunk before its first IDAT (an animated PNG). */
function isAnimatedPng(bytes) {
  let at = 8;
  for (let count = 0; count < PNG_CHUNKS_SCANNED_MAX && at + 8 <= bytes.length; count += 1) {
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    at += 12 + u32be(bytes, at);
  }
  return false;
}

/** Whether a WebP is an extended one with its animation flag set. */
function isAnimatedWebp(bytes) {
  return bytes.length > 20
    && String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) === 'VP8X'
    && (bytes[20] & 0x02) !== 0;
}

/**
 * What an attached image is, from its first bytes: `{ ok:true, mime, width,
 * height }` for a still PNG, JPEG or WebP within the size caps, else
 * `{ ok:false, error }` naming `label`. The type comes from the bytes, never
 * from the name.
 */
export function sniffImageInput(bytes, label = 'the image') {
  const head = bytes.subarray(0, IMAGE_HEADER_BYTES);
  const header = readImageHeader(head);
  if (!header) return refused(`"${shown(label)}" is not a PNG, JPEG or WebP image`);
  if ((header.mime === 'image/png' && isAnimatedPng(head)) || (header.mime === 'image/webp' && isAnimatedWebp(head))) {
    return refused(`"${shown(label)}" is an animated image; only still images can be attached`);
  }
  if (header.width > IMAGE_INPUT_EDGE_MAX || header.height > IMAGE_INPUT_EDGE_MAX || header.width * header.height > IMAGE_INPUT_PIXELS_MAX) {
    return refused(`"${shown(label)}" is ${header.width}x${header.height} pixels; an attached image has at most ${IMAGE_INPUT_EDGE_MAX} pixels a side and 64 megapixels`);
  }
  return { ok: true, ...header };
}

/**
 * The bytes of one resolved image: opened once (on POSIX without following
 * a link and without blocking on a FIFO), checked as a regular file of
 * 1 byte to `maxBytes` that is still the file the path resolved to, and
 * read from that descriptor in a bounded loop. `{ ok:true, bytes }` or
 * `{ ok:false, error }`.
 *
 * O_NOFOLLOW guards the last part of the path only. So the descriptor's file
 * is compared with `identity` (dev and inode the checks were made on, from
 * resolveImageInputPath), and the path is resolved again after the open and
 * must still be `realPath`: a parent folder swapped for a link in between
 * fails one of the two.
 *
 * Platform note: Windows has no O_NOFOLLOW; there the file id comparison and
 * the second resolve are the guard.
 */
export function readImageInputFile(realPath, {
  label = realPath,
  maxBytes = OPENAI_IMAGE_LIMITS.inputImageBytesMax,
  identity = null,
  platform = process.platform,
  fs = fsDefault,
} = {}) {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  const flags = platform === 'win32' ? O_RDONLY : (O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  const megabytes = Math.round(maxBytes / (1024 * 1024));
  let fd = null;
  try {
    try {
      fd = fs.openSync(realPath, flags);
    } catch {
      return refused(`"${shown(label)}" could not be opened`);
    }
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile()) return refused(`"${shown(label)}" is not a regular file`);
    if (opened.size <= 0n) return refused(`"${shown(label)}" is empty`);
    if (opened.size > BigInt(maxBytes)) return refused(`"${shown(label)}" is larger than ${megabytes} MB`);
    let expected = identity;
    if (!expected) {
      try {
        const stat = fs.statSync(realPath, { bigint: true });
        expected = { dev: stat.dev, ino: stat.ino };
      } catch {}
    }
    const key = makePathKey(platform);
    const again = realPathOf(fs, realPath);
    // The path once more, after the open: a folder swapped for a link before
    // the checks and back after the open passes the two tests above (the
    // checks saw the swapped file too), but not this one.
    let after = null;
    try {
      after = fs.statSync(realPath, { bigint: true });
    } catch {}
    if (!expected || expected.dev !== opened.dev || expected.ino !== opened.ino || !again || key(again) !== key(realPath)
      || !after || after.dev !== opened.dev || after.ino !== opened.ino || !descriptorPathMatches(fs, fd, realPath, key, platform)) {
      return refused(`"${shown(label)}" changed while it was read`);
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      chunks.push(read === chunk.length ? chunk : chunk.subarray(0, read));
      total += read;
    }
    if (total > maxBytes) return refused(`"${shown(label)}" is larger than ${megabytes} MB`);
    if (total === 0) return refused(`"${shown(label)}" is empty`);
    return { ok: true, bytes: Buffer.concat(chunks, total) };
  } catch {
    return refused(`"${shown(label)}" could not be read`);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * Where the descriptor itself points, on Linux: /proc/self/fd/<fd> names the
 * file it opened, whatever the path did since. Elsewhere, and on a Linux
 * without a readable /proc (a container that hides it, say), this check
 * passes (fails open) and the file-id checks stand alone.
 */
function descriptorPathMatches(fs, fd, realPath, key, platform) {
  if (platform !== 'linux') return true;
  let target = null;
  try {
    target = fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return true;
  }
  return key(target) === key(realPath);
}

/**
 * Every image of one send, all or nothing: `{ ok:true, images, dropped }`
 * with `images` in the order named (the first is the base of an edit), each
 * `{ realPath, source, name, bytes, sha256, mime, width, height }`, the same
 * file named twice (also through a link) and the same bytes under two names
 * kept once (`dropped` counts those); or `{ ok:false, error }` for the first
 * path refused. Nothing is stored here.
 */
export function resolveImageInputs(rawPaths, {
  roots,
  isLiveConversation,
  maxBytes = OPENAI_IMAGE_LIMITS.inputImageBytesMax,
  platform = process.platform,
  fs = fsDefault,
} = {}) {
  const list = Array.isArray(rawPaths) ? rawPaths : [];
  if (list.length > IMAGE_INPUT_PATHS_MAX) return refused(`at most ${IMAGE_INPUT_PATHS_MAX} image paths per send`);
  const key = makePathKey(platform);
  const resolved = [];
  const seenPaths = new Set();
  for (const raw of list) {
    const place = resolveImageInputPath(raw, roots, { isLiveConversation, platform, fs });
    if (!place.ok) return place;
    const pathKey = key(place.realPath);
    if (seenPaths.has(pathKey)) continue;
    seenPaths.add(pathKey);
    resolved.push({ raw, ...place });
  }
  const images = [];
  const seenHashes = new Set();
  for (const entry of resolved) {
    const file = readImageInputFile(entry.realPath, { label: entry.raw, maxBytes, identity: entry.identity, platform, fs });
    if (!file.ok) return file;
    const kind = sniffImageInput(file.bytes, entry.raw);
    if (!kind.ok) return kind;
    const sha256 = crypto.createHash('sha256').update(file.bytes).digest('hex');
    if (seenHashes.has(sha256)) continue;
    seenHashes.add(sha256);
    images.push({
      realPath: entry.realPath,
      source: entry.source,
      name: path.basename(entry.realPath),
      bytes: file.bytes,
      sha256,
      mime: kind.mime,
      width: kind.width,
      height: kind.height,
    });
  }
  return { ok: true, images, dropped: list.length - images.length };
}
