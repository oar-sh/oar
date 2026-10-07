// Serving a file from disk so that what arrives is the file as it is now:
// one open, one fstat, and length, validators and bytes all from that handle.
// The headers tell every cache on the way, the browser's and a CDN's alike,
// to keep nothing.

import fs from 'node:fs';
import path from 'node:path';

import { applySafeServedContentHeaders } from './safe-served-content.mjs';

/**
 * A short token that changes whenever the file's bytes may have changed
 * (modification time or size). It goes into download URLs as `v=…`: the
 * server ignores it, and a changed file gets a URL nothing has seen before.
 */
export function fileVersionToken({ mtimeMs, size } = {}) {
  const modified = Math.floor(Number(mtimeMs));
  const bytes = Number(size);
  if (!Number.isFinite(modified) || !Number.isFinite(bytes) || modified < 0 || bytes < 0) return '';
  return `${modified.toString(36)}-${Math.floor(bytes).toString(36)}`;
}

/**
 * `Cache-Control` speaks to browsers and to proxies that honour it. The two
 * CDN headers bind the edge itself: Cloudflare obeys them ahead of
 * `Cache-Control` and of a "cache everything" rule that would otherwise
 * override the origin's wish.
 */
export function applyNoStoreHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  applyCdnNoStoreHeaders(res);
}

export function applyCdnNoStoreHeaders(res) {
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
}

/**
 * The name a download is saved under, when the client asks for one (`as=…`).
 * Accepted only as a plain file name with the real file's extension, so the
 * request cannot change what kind of file the browser believes it gets.
 */
export function downloadNameOverride(requested, realName) {
  const wanted = String(requested || '').trim();
  if (!wanted || wanted.length > 200) return '';
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(wanted) || wanted === '.' || wanted === '..') return '';
  const realExt = path.extname(String(realName || '')).toLowerCase();
  if (path.extname(wanted).toLowerCase() !== realExt) return '';
  return wanted;
}

function appendUrlParam(url, key, value) {
  if (!value) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}

/** `url` with the file's version token appended, or unchanged when there is none. */
export function withFileVersion(url, version) {
  return appendUrlParam(String(url || ''), 'v', String(version || ''));
}

/**
 * `cacheControl` replaces the no-store default for content whose URL names
 * its bytes (an upload addressed by its hash): such an answer may be kept.
 */
export function serveFileWithRangeSupport(req, res, filePath, meta, { safeName, cacheDelete = null, fsImpl = fs, cacheControl = '' } = {}) {
  const realName = safeName || path.basename(filePath).replace(/"/g, '');
  const name = downloadNameOverride(req.query?.as, realName) || realName;
  const rangeHeader = req.headers['range'];

  const fail = (error) => {
    if (cacheDelete) cacheDelete(filePath);
    if (res.headersSent) { res.destroy(error); return; }
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EISDIR') {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.status(500).json({ error: 'Failed to read file' });
  };

  // The caller's `meta` may be a moment old (it is cached). Size, validators
  // and bytes all come from this one handle instead: a length taken from an
  // older stat cut a file that had just grown down to its previous size.
  let fd = null;
  let stat = null;
  try {
    fd = fsImpl.openSync(filePath, 'r');
    stat = fsImpl.fstatSync(fd);
  } catch (error) {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch {} }
    fail(error);
    return;
  }
  const closeFd = () => { try { fsImpl.closeSync(fd); } catch {} };
  if (!stat.isFile()) {
    closeFd();
    fail(Object.assign(new Error('Not a file'), { code: 'EISDIR' }));
    return;
  }
  const fileSize = Number(stat.size || 0);

  // From here until the stream owns the handle, any throw (a header value
  // `setHeader` refuses, say) must close the handle, or every such request
  // would leak one.
  let start = 0;
  let end = fileSize - 1;
  try {
    res.setHeader('Accept-Ranges', 'bytes');
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);
    else applyNoStoreHeaders(res);
    // Validators cost nothing next to no-store, and they let a client or a
    // person with curl see which version of the file an answer carries.
    const version = fileVersionToken({ mtimeMs: stat.mtimeMs, size: fileSize });
    if (version) res.setHeader('ETag', `W/"${version}"`);
    if (Number.isFinite(stat.mtimeMs)) res.setHeader('Last-Modified', new Date(stat.mtimeMs).toUTCString());
    // Neutralize browser-executable types (HTML/SVG/XML), force nosniff, and
    // sandbox the response so a worker-written workspace file can't run as script
    // on this origin. Media stays inline for preview; everything else downloads.
    applySafeServedContentHeaders(res, meta?.contentType, { fileName: name });

    if (rangeHeader) {
      const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      const from = match ? parseInt(match[1], 10) : NaN;
      const to = match && match[2] ? parseInt(match[2], 10) : fileSize - 1;
      if (!match || from > to || from >= fileSize || to >= fileSize) {
        closeFd();
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        res.status(416).end();
        return;
      }
      start = from;
      end = to;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.status(206);
    }
    res.setHeader('Content-Length', String(Math.max(0, end - start + 1)));
  } catch (error) {
    closeFd();
    fail(error);
    return;
  }
  if (end - start + 1 <= 0) {
    closeFd();
    res.end();
    return;
  }
  // Bounded to the size just read, so a file that grows while it is sent
  // still yields exactly the announced number of bytes.
  const stream = fsImpl.createReadStream(null, { fd, start, end, autoClose: true });
  stream.on('error', fail);
  // A client that goes away mid-download would otherwise leave the handle open.
  res.on?.('close', () => stream.destroy());
  stream.pipe(res);
}
