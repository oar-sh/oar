import { createHash } from 'node:crypto';
import path from 'node:path';

// Finds the pictures, videos and attached files of one stored message, for
// the media gallery index. Pure: no file system and no database. Sources:
//   - messages.attachments JSON (uploads, @file: references, generated
//     images, legacy inline data URLs);
//   - markdown images `![alt](target)` in messages.text, the way agents embed
//     pictures (local paths, the relay's own file routes, http(s), raster
//     data:image URIs). Code spans and fenced code blocks are skipped, as the
//     chat renderer shows them as code.
// Every item gets an identity key so the gallery can show a picture once even
// when many messages carry it.

const IMAGE_EXTENSIONS = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'],
  ['webp', 'image/webp'], ['avif', 'image/avif'], ['bmp', 'image/bmp'], ['svg', 'image/svg+xml'],
  ['ico', 'image/x-icon'],
]);
const VIDEO_EXTENSIONS = new Map([
  ['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['webm', 'video/webm'], ['mov', 'video/quicktime'],
]);
const AUDIO_EXTENSIONS = new Map([
  ['mp3', 'audio/mpeg'], ['m4a', 'audio/mp4'], ['ogg', 'audio/ogg'], ['opus', 'audio/ogg'],
  ['wav', 'audio/wav'], ['flac', 'audio/flac'],
]);
const RASTER_DATA_IMAGE = /^data:(image\/(?:avif|gif|jpe?g|png|webp));base64,/i;
const MAX_TEXT_ITEMS = 200;

export const MEDIA_ORIGINS = Object.freeze(['upload', 'reference', 'generated', 'embedded']);
export const MEDIA_LOCATOR_KINDS = Object.freeze([
  'upload_sha', 'legacy_data_url', 'generated', 'local_path', 'remote_url', 'data_uri',
]);

function extensionOf(value) {
  const clean = String(value || '').split(/[?#]/, 1)[0];
  const base = clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function baseNameOf(value) {
  const clean = String(value || '').split(/[?#]/, 1)[0].replace(/[\\/]+$/, '');
  const base = clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1);
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

export function mediaKindForMime(mime) {
  const value = String(mime || '').toLowerCase().split(';', 1)[0].trim();
  if (value.startsWith('image/')) return 'image';
  if (value.startsWith('video/')) return 'video';
  if (value.startsWith('audio/')) return 'audio';
  if (value === 'application/pdf') return 'pdf';
  return 'other';
}

export function mimeForExtension(ext) {
  const value = String(ext || '').toLowerCase();
  return IMAGE_EXTENSIONS.get(value)
    || VIDEO_EXTENSIONS.get(value)
    || AUDIO_EXTENSIONS.get(value)
    || (value === 'pdf' ? 'application/pdf' : '');
}

export function mediaCategoryForKind(kind) {
  return kind === 'image' || kind === 'video' ? 'media' : 'file';
}

// Bump when extraction rules change: the index re-reads every message.
// 2: a data image must start with the bytes of the type it declares.
export const MEDIA_EXTRACTOR_VERSION = 2;

// What a data image's bytes must start with (the type the URI declares).
export const DATA_IMAGE_MAGIC = Object.freeze({
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/avif': (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp',
});

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/** Strict base64 (no whitespace), checked with a character loop, not a regex over the whole string. */
export function isStrictBase64(payload) {
  const value = String(payload || '');
  if (!value || value.length % 4 !== 0) return false;
  let padding = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 61) { // '='
      padding += 1;
      if (padding > 2 || i < value.length - 2) return false;
      continue;
    }
    if (padding) return false;
    const ok = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47;
    if (!ok) return false;
  }
  return true;
}

/** The identity key of a data URI payload (base64 text, no whitespace). */
export function dataPayloadIdentityKey(payload) {
  return `data:${sha256Hex(payload)}`;
}

/**
 * Normalizes an absolute local path for the given platform; '' when it is not
 * one. Never percent-decodes: a real file may be named `100%.png`. (The drive
 * helpers decode, for paths that arrive URL-encoded; callers here decode a
 * markdown target once themselves.)
 */
export function normalizeLocalMediaPath(rawPath, platform = process.platform) {
  const value = String(rawPath || '').trim();
  if (!value || value.includes('\0')) return '';
  if (platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(value)) return '';
    const normalized = path.win32.normalize(value.replace(/\//g, '\\').replace(/\\+/g, '\\'));
    if (!/^[A-Za-z]:\\/.test(normalized)) return '';
    const rest = normalized.slice(3).replace(/^\\+/, '').replace(/\\+$/, '');
    return rest ? `${normalized[0].toUpperCase()}:\\${rest}` : '';
  }
  if (!value.startsWith('/')) return '';
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (!normalized.startsWith('/') || normalized === '/') return '';
  return normalized.replace(/\/+$/, '');
}

/** Decodes a markdown target once, as the chat does after marked encoded it; the raw text when it is not valid encoding. */
function decodeTargetOnce(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function localPathIdentityKey(normalizedPath, platform = process.platform) {
  return `path:${platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath}`;
}

/** `relPath` is already decoded. */
function resolveWorkspaceRelative(relPath, workspaceRoot, platform) {
  const root = normalizeLocalMediaPath(workspaceRoot, platform);
  if (!root) return '';
  const decoded = String(relPath || '');
  if (!decoded || decoded.includes('\0')) return '';
  const api = platform === 'win32' ? path.win32 : path.posix;
  const joined = api.normalize(api.join(root, decoded.replace(/[\\/]+/g, api.sep)));
  const rootWithSep = root.endsWith(api.sep) ? root : `${root}${api.sep}`;
  const inside = platform === 'win32'
    ? joined.toLowerCase().startsWith(rootWithSep.toLowerCase())
    : joined.startsWith(rootWithSep);
  return inside ? normalizeLocalMediaPath(joined, platform) : '';
}

/** Linux pseudo file systems are never media, even when an agent names them. */
export function isPseudoFileSystemPath(normalizedPath, platform = process.platform) {
  return platform !== 'win32' && /^\/(?:proc|sys|dev)(?:\/|$)/.test(String(normalizedPath || ''));
}

function localItem({ normalizedPath, platform, origin, alt = '', name = '', mime = '', sizeBytes = null, textOnly = false }) {
  if (isPseudoFileSystemPath(normalizedPath, platform)) return null;
  const ext = extensionOf(normalizedPath);
  const extMime = mimeForExtension(ext);
  const resolvedMime = String(mime || '').trim() || extMime;
  const kind = mediaKindForMime(resolvedMime);
  // An embedded target must look like a picture or a video, as the chat only
  // shows those as media; attachments may be any file (Files tab).
  if (textOnly && kind !== 'image' && kind !== 'video') return null;
  return {
    origin,
    locatorKind: 'local_path',
    locator: normalizedPath,
    identityKey: localPathIdentityKey(normalizedPath, platform),
    category: mediaCategoryForKind(kind),
    mediaKind: kind,
    mime: resolvedMime || null,
    name: name || baseNameOf(normalizedPath),
    alt: alt || null,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
  };
}

function uploadShaItem({ sha, name, mime, sizeBytes, alt = '', origin = 'upload' }) {
  const kind = mediaKindForMime(mime || mimeForExtension(extensionOf(name)));
  return {
    origin,
    locatorKind: 'upload_sha',
    locator: sha,
    identityKey: `sha:${sha}`,
    category: mediaCategoryForKind(kind),
    mediaKind: kind,
    mime: mime || mimeForExtension(extensionOf(name)) || null,
    name: name || null,
    alt: alt || null,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
  };
}

function dataUriItem(uri, { origin, locatorKind, alt = '', name = '' }) {
  const match = RASTER_DATA_IMAGE.exec(uri);
  if (!match) return null;
  const mime = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  const payload = uri.slice(match[0].length).replace(/\s+/g, '');
  if (!isStrictBase64(payload)) return null;
  // The first bytes only (24 characters decode to 18): the type it declares.
  const head = Buffer.from(payload.slice(0, 24), 'base64');
  if (!DATA_IMAGE_MAGIC[mime.replace('image/jpg', 'image/jpeg')]?.(head)) return null;
  const sub = mime.slice('image/'.length).replace('jpeg', 'jpg');
  return {
    origin,
    locatorKind,
    locator: '',
    identityKey: dataPayloadIdentityKey(payload),
    category: 'media',
    mediaKind: 'image',
    mime,
    name: name || `image.${sub}`,
    alt: alt || null,
    sizeBytes: Math.floor((payload.length * 3) / 4) - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0),
  };
}

function generatedItem(entry, { conversationId, messageId }) {
  const info = entry.generatedImage && typeof entry.generatedImage === 'object' ? entry.generatedImage : {};
  const conv = String(info.conversationId || conversationId || '');
  const msg = String(info.messageId || messageId || '');
  const imageId = String(info.imageId || '');
  const contentUrl = typeof entry.contentUrl === 'string' ? entry.contentUrl.trim() : '';
  const identity = imageId ? `gen:${conv}/${msg}/${imageId}` : (contentUrl ? `gen:${contentUrl}` : '');
  if (!identity) return null;
  const mime = String(entry.type || '').trim() || mimeForExtension(extensionOf(info.relativePath || entry.name));
  const kind = mediaKindForMime(mime) === 'other' ? 'image' : mediaKindForMime(mime);
  return {
    origin: 'generated',
    locatorKind: 'generated',
    locator: JSON.stringify({
      conversationId: conv,
      messageId: msg,
      imageId,
      sessionId: info.sessionId ? String(info.sessionId) : '',
      relativePath: info.relativePath ? String(info.relativePath) : '',
      contentUrl,
    }),
    identityKey: identity,
    category: mediaCategoryForKind(kind),
    mediaKind: kind,
    mime: mime || null,
    name: entry.name ? String(entry.name) : null,
    alt: null,
    sizeBytes: Number.isFinite(entry.size) ? entry.size : null,
  };
}

function parseAttachmentList(attachments) {
  if (Array.isArray(attachments)) return attachments;
  if (typeof attachments !== 'string' || !attachments.trim()) return [];
  try {
    const parsed = JSON.parse(attachments);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function attachmentItem(entry, context) {
  if (!entry || typeof entry !== 'object') return null;
  const name = entry.name ? String(entry.name) : '';
  const mime = entry.type ? String(entry.type) : '';
  const size = Number(entry.size);
  const sizeBytes = Number.isFinite(size) && size > 0 ? size : null;
  // Generated images are recognized by their shape, not by one route, so new
  // kinds of generated pictures show up without gallery changes.
  if (entry.generatedImage && typeof entry.generatedImage === 'object') {
    return generatedItem(entry, context);
  }
  const sha = typeof entry.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : '';
  if (/^[a-f0-9]{64}$/.test(sha)) {
    return uploadShaItem({ sha, name, mime, sizeBytes });
  }
  if (typeof entry.dataUrl === 'string' && entry.dataUrl.startsWith('data:')) {
    return dataUriItem(entry.dataUrl, { origin: 'upload', locatorKind: 'legacy_data_url', name });
  }
  if (typeof entry.path === 'string' && entry.path.trim()) {
    const normalizedPath = normalizeLocalMediaPath(entry.path, context.platform);
    if (!normalizedPath) return null;
    return localItem({
      normalizedPath,
      platform: context.platform,
      origin: 'reference',
      name,
      mime,
      sizeBytes,
    });
  }
  return null;
}

// --- markdown scanning ------------------------------------------------------

const ESCAPABLE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;

function stripCode(text) {
  const lines = String(text || '').split('\n');
  const kept = [];
  let fence = null;
  for (const line of lines) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !line.slice(open[0].length).trim()) {
        fence = null;
      }
      kept.push('');
      continue;
    }
    if (open && !(open[1][0] === '`' && line.slice(open[0].length).includes('`'))) {
      fence = open[1];
      kept.push('');
      continue;
    }
    kept.push(line);
  }
  return blankCodeSpans(kept.join('\n'));
}

// Inline code spans: a run of N backticks up to the next run of exactly N.
// Linear: the runs are listed once and each opener looks up the next run of
// its length through a per-length cursor (a regex here backtracks badly on
// text with many unmatched backticks).
function blankCodeSpans(text) {
  const runs = [];
  for (let i = text.indexOf('`'); i >= 0; i = text.indexOf('`', i)) {
    let j = i;
    while (text[j] === '`') j += 1;
    runs.push({ start: i, length: j - i });
    i = j;
  }
  if (runs.length < 2) return text;
  const byLength = new Map();
  runs.forEach((run, index) => {
    if (!byLength.has(run.length)) byLength.set(run.length, []);
    byLength.get(run.length).push(index);
  });
  const cursor = new Map();
  // Spans to blank, then the text put together from slices: a character
  // array of a multi-megabyte message (a pasted data image) cost ~100 ms.
  const spans = [];
  let index = 0;
  while (index < runs.length) {
    const run = runs[index];
    const list = byLength.get(run.length);
    let pos = cursor.get(run.length) || 0;
    while (pos < list.length && list[pos] <= index) pos += 1;
    cursor.set(run.length, pos);
    if (pos >= list.length) {
      index += 1;
      continue;
    }
    const closeIndex = list[pos];
    const close = runs[closeIndex];
    spans.push([run.start, close.start + close.length]);
    index = closeIndex + 1;
  }
  if (!spans.length) return text;
  const parts = [];
  let at = 0;
  for (const [start, end] of spans) {
    parts.push(text.slice(at, start), text.slice(start, end).replace(/[^\n]/g, ' '));
    at = end;
  }
  parts.push(text.slice(at));
  return parts.join('');
}

const MAX_ALT_SCAN = 600;
const MAX_TARGET_LENGTH = 8192;
const MAX_DATA_URI_LENGTH = 28 * 1024 * 1024; // about 20 MB of image bytes
const STOP_CHARS = /[\s()\\]/g;

function findClosingBracket(text, start) {
  let depth = 0;
  const limit = Math.min(text.length, start + MAX_ALT_SCAN);
  for (let i = start; i < limit; i += 1) {
    const ch = text[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      if (depth === 0) return i;
      depth -= 1;
    } else if (ch === '\n' && text[i + 1] === '\n') {
      return -1;
    }
  }
  return -1;
}

function parseDestination(text, start) {
  let i = start;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) i += 1;
  if (text[i] === '<') {
    const end = text.indexOf('>', i + 1);
    if (end < 0) return null;
    const dest = text.slice(i + 1, end);
    if (dest.includes('\n') || dest.includes('<')) return null;
    return { dest, end: end + 1 };
  }
  const maxLength = text.startsWith('data:', i) ? MAX_DATA_URI_LENGTH : MAX_TARGET_LENGTH;
  // A data URI holds no space, bracket or backslash: its end is found with one
  // native search instead of a step per character (a 3 MB image took ~90 ms).
  if (maxLength === MAX_DATA_URI_LENGTH) {
    STOP_CHARS.lastIndex = i;
    const stop = STOP_CHARS.exec(text);
    const end = stop ? stop.index : text.length;
    if (!stop || stop[0] === ')' || /\s/.test(stop[0])) {
      if (end === i) return null;
      // Resume where the step-by-step scan would have stopped (i + max + 1),
      // not at the next separator, which may lie inside a following image.
      if (end - i > maxLength) return { overflow: true, end: Math.min(end, i + maxLength + 1) };
      return { dest: text.slice(i, end), end };
    }
  }
  let depth = 0;
  let j = i;
  const limit = Math.min(text.length, i + maxLength + 1);
  for (; j < limit; j += 1) {
    const ch = text[j];
    if (ch === '\\' && j + 1 < text.length) { j += 1; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || /\s/.test(ch)) break;
  }
  if (j === i) return null;
  // Too long to be a target: the scan resumes after it, so text without
  // whitespace is not scanned again and again from every `![`.
  if (j - i > maxLength) return { overflow: true, end: j };
  return { dest: text.slice(i, j), end: j };
}

function skipTitleAndClose(text, start) {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (text[i] === ')') return i + 1;
  const quote = text[i];
  const closer = quote === '(' ? ')' : quote;
  if (quote !== '"' && quote !== "'" && quote !== '(') return -1;
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === '\\') { j += 1; continue; }
    if (text[j] === closer) {
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k += 1;
      return text[k] === ')' ? k + 1 : -1;
    }
  }
  return -1;
}

/** Inline markdown images `![alt](dest "title")` outside code, in order. */
export function findMarkdownImages(text) {
  const source = stripCode(text);
  const found = [];
  let index = source.indexOf('![');
  let nextClose = -1;
  while (index >= 0 && found.length < MAX_TEXT_ITEMS) {
    // Jump over openers that cannot reach a `]` within the alt scan limit.
    if (nextClose < index + 2) {
      nextClose = source.indexOf(']', index + 2);
      if (nextClose < 0) break;
    }
    if (nextClose - index > MAX_ALT_SCAN) {
      index = source.indexOf('![', nextClose - MAX_ALT_SCAN);
      continue;
    }
    if (index > 0 && source[index - 1] === '\\') {
      index = source.indexOf('![', index + 2);
      continue;
    }
    const close = findClosingBracket(source, index + 2);
    if (close < 0 || source[close + 1] !== '(') {
      index = source.indexOf('![', index + 2);
      continue;
    }
    const destination = parseDestination(source, close + 2);
    if (destination?.overflow) {
      index = source.indexOf('![', destination.end);
      continue;
    }
    const end = destination ? skipTitleAndClose(source, destination.end) : -1;
    if (!destination || end < 0) {
      index = source.indexOf('![', index + 2);
      continue;
    }
    found.push({
      alt: source.slice(index + 2, close).replace(ESCAPABLE, '$1').trim(),
      target: destination.dest.replace(ESCAPABLE, '$1').trim(),
    });
    index = source.indexOf('![', end);
  }
  return found;
}

function appRoutePath(target) {
  if (!target.startsWith('/api/')) return null;
  try {
    return new URL(target, 'http://relay.invalid');
  } catch {
    return null;
  }
}

function embeddedItem({ alt, target }, context) {
  const value = String(target || '').trim();
  if (!value) return null;
  if (/^data:/i.test(value)) {
    return dataUriItem(value, { origin: 'embedded', locatorKind: 'data_uri', alt });
  }
  if (/^https?:\/\//i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const href = url.href;
    const extMime = mimeForExtension(extensionOf(url.pathname));
    const kind = mediaKindForMime(extMime) === 'video' ? 'video' : 'image';
    return {
      origin: 'embedded',
      locatorKind: 'remote_url',
      locator: href,
      identityKey: `url:${href}`,
      category: 'media',
      mediaKind: kind,
      mime: extMime || null,
      name: baseNameOf(url.pathname) || url.hostname,
      alt: alt || null,
      sizeBytes: null,
    };
  }
  const route = appRoutePath(value);
  if (route) {
    if (route.pathname === '/api/drives/file') {
      const normalizedPath = normalizeLocalMediaPath(route.searchParams.get('path') || '', context.platform);
      return normalizedPath
        ? localItem({ normalizedPath, platform: context.platform, origin: 'embedded', alt, textOnly: true })
        : null;
    }
    if (route.pathname.startsWith('/api/files/')) {
      // Each segment of the route is URL-encoded once.
      const relative = route.pathname.slice('/api/files/'.length).split('/').map(decodeTargetOnce).join('/');
      const normalizedPath = resolveWorkspaceRelative(relative, context.workspaceRoot, context.platform);
      return normalizedPath
        ? localItem({ normalizedPath, platform: context.platform, origin: 'embedded', alt, textOnly: true })
        : null;
    }
    const upload = /^\/api\/upload\/([a-f0-9]{64})\/content$/i.exec(route.pathname);
    if (upload) {
      const sha = upload[1].toLowerCase();
      const item = uploadShaItem({ sha, name: alt || sha.slice(0, 12), mime: '', sizeBytes: null, alt, origin: 'embedded' });
      // Unknown type: the gallery shows the tile as a picture, as chat does.
      if (item.mediaKind === 'other') Object.assign(item, { mediaKind: 'image', category: 'media' });
      return item;
    }
    const generated = /^\/api\/generated-image\/([^/]+)\/([^/]+)\/([^/]+)\/content$/.exec(route.pathname);
    if (generated) {
      return {
        ...generatedItem({ contentUrl: route.pathname, generatedImage: {
          conversationId: decodeURIComponent(generated[1]),
          messageId: decodeURIComponent(generated[2]),
          imageId: decodeURIComponent(generated[3]),
        } }, context),
        origin: 'embedded',
        alt: alt || null,
      };
    }
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) {
    return null; // file:, javascript:, blob:, mailto: … — the chat drops them too
  }
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/')) {
    const normalizedPath = normalizeLocalMediaPath(decodeTargetOnce(value), context.platform);
    return normalizedPath
      ? localItem({ normalizedPath, platform: context.platform, origin: 'embedded', alt, textOnly: true })
      : null;
  }
  if (value.startsWith('\\') || value.startsWith('#') || value.startsWith('?')) return null;
  const normalizedPath = resolveWorkspaceRelative(decodeTargetOnce(value).replace(/^\.\//, ''), context.workspaceRoot, context.platform);
  return normalizedPath
    ? localItem({ normalizedPath, platform: context.platform, origin: 'embedded', alt, textOnly: true })
    : null;
}

/**
 * The data image of a message with the given identity, for serving it:
 * `{ mime, payload }` or null. Looked up by identity, not by position, so a
 * message edited since it was indexed never serves a different picture.
 */
export function findDataImage({ text = '', attachments = null } = {}, identityKey) {
  const wanted = String(identityKey || '');
  if (!wanted.startsWith('data:')) return null;
  const candidates = [];
  for (const entry of parseAttachmentList(attachments)) {
    if (entry && typeof entry.dataUrl === 'string') candidates.push(entry.dataUrl);
  }
  for (const image of findMarkdownImages(text)) {
    if (/^data:/i.test(image.target)) candidates.push(image.target);
  }
  for (const uri of candidates) {
    const match = RASTER_DATA_IMAGE.exec(uri);
    if (!match) continue;
    const payload = uri.slice(match[0].length).replace(/\s+/g, '');
    if (isStrictBase64(payload) && dataPayloadIdentityKey(payload) === wanted) {
      return { mime: match[1].toLowerCase().replace('image/jpg', 'image/jpeg'), payload };
    }
  }
  return null;
}

/**
 * Items of one message, in a stable order (attachments first, then the
 * markdown images of the text). `ordinal` is the position in that order.
 */
export function extractMediaFromMessage({
  role = '',
  text = '',
  attachments = null,
  conversationId = '',
  messageId = '',
  workspaceRoot = '',
  platform = process.platform,
} = {}) {
  const context = { conversationId, messageId, workspaceRoot, platform, role };
  const items = [];
  for (const entry of parseAttachmentList(attachments)) {
    const item = attachmentItem(entry, context);
    if (item) items.push(item);
  }
  for (const image of findMarkdownImages(text)) {
    const item = embeddedItem(image, context);
    if (item) items.push(item);
  }
  return items.map((item, ordinal) => ({ ordinal, ...item }));
}
