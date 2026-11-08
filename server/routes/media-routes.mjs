import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { createMediaRepository, decodeMediaCursor, encodeMediaCursor, MEDIA_SOURCES } from '../repositories/media-repository.mjs';
import { fileVersionToken, serveFileWithRangeSupport } from '../services/file-serving.mjs';
import { DATA_IMAGE_MAGIC as IMAGE_MAGIC, findDataImage, isPseudoFileSystemPath } from '../services/media-extract.mjs';
import { sniffMimeType } from '../services/mime-sniffer.mjs';
import { createMediaIndexService } from '../services/media-index-service.mjs';
import { applySafeServedContentHeaders } from '../services/safe-served-content.mjs';

// The media gallery: the 🧠 Media tab of a session and the global Media view.
// Owner only: every route sits behind `auth`; there is no shared-view or
// remote-relay counterpart. Files are served by index id only, so a file
// reaches the gallery only when a message really referenced it, and its
// stored path is checked again on every request.

const CONTENT_ADDRESSED_CACHE = 'private, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'private, no-cache';
const DRIVES_TTL_MS = 60_000;
const MAX_PAGE_ROUNDS = 5;
// A file system call on a stored path that takes longer (an offline network
// drive) counts as a missing file.
const FS_TIMEOUT_MS = 1500;
const SERVABLE_TTL_MS = 60_000;
const SERVABLE_CACHE_MAX = 5000;
// The JS realpath, not the native one: on Windows the native one turns a
// mapped drive letter into its UNC path, which the drive check refuses.
const realpathKeepingDrives = promisify(fs.realpath);
const openFile = promisify(fs.open);
const fstatFile = promisify(fs.fstat);
const readFile = promisify(fs.read);
const closeFile = (fd) => fs.close(fd, () => {});
// O_NOFOLLOW where the platform has it: the checked path cannot become a link
// between the check and the open.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

/** The promise's value, or allback after ms; onLate(value) gets a value that came too late. */
function withTimeout(promise, ms, fallback, onLate = () => {}) {
  let timedOut = false;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve(fallback);
    }, ms);
    timer.unref?.();
    Promise.resolve(promise).then((value) => {
      clearTimeout(timer);
      if (timedOut) onLate(value);
      else resolve(value);
    }, () => {
      clearTimeout(timer);
      if (!timedOut) resolve(fallback);
    });
  });
}

/**
 * The type to serve a local picture or video as, from its first bytes; '' when
 * the bytes are not the kind its name promised (a text file renamed .png, an
 * executable named .mp4): such a file is not served at all.
 */
export function sniffLocalMediaType(head, { mediaKind, mime }) {
  const sniffed = sniffMimeType(head);
  if (mediaKind === 'image') {
    if (sniffed.startsWith('image/')) return sniffed;
    if (mime === 'image/svg+xml') {
      const text = head.toString('utf8').replace(/^﻿/, '').trimStart().slice(0, 256).toLowerCase();
      if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return 'image/svg+xml';
    }
    return '';
  }
  if (mediaKind === 'video') {
    if (sniffed.startsWith('video/')) return sniffed;
    if (head.length > 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm';
    if (head.length > 8 && head.subarray(4, 8).toString('latin1') === 'ftyp') return mime || 'video/mp4';
    return '';
  }
  return '';
}

async function readHead(fd, length = 512) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await readFile(fd, buffer, 0, length, 0);
  return buffer.subarray(0, bytesRead);
}

function parseGeneratedLocator(locator) {
  try {
    const value = JSON.parse(locator);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function generatedFromMessage(attachments, imageId) {
  let list = [];
  try {
    list = JSON.parse(attachments || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const entry = list.find((item) => item?.generatedImage && String(item.generatedImage.imageId || '') === String(imageId || ''));
  return entry?.generatedImage || null;
}

export function registerMediaRoutes(app, {
  auth,
  db,
  uploadPathForSha,
  fetchBrowsableDrives = null,
  resolveGeneratedImagePath = () => null,
  platform = process.platform,
  repository = createMediaRepository(db),
  indexService = createMediaIndexService({ db, repository, platform }),
  startIndexer = true,
  now = () => Date.now(),
} = {}) {
  let drivesCache = null;

  // Windows: the drive roots a stored path may live on, cached a minute
  // (listing them starts a process).
  function allowedDriveRoots() {
    if (platform !== 'win32' || typeof fetchBrowsableDrives !== 'function') return Promise.resolve(null);
    if (drivesCache && now() - drivesCache.at < DRIVES_TTL_MS) return Promise.resolve(drivesCache.roots);
    return new Promise((resolve) => {
      fetchBrowsableDrives((error, drives) => {
        if (error || !Array.isArray(drives)) return resolve(new Set());
        const roots = new Set(drives.map((drive) => String(drive.rootAbsolute || '').toUpperCase()).filter(Boolean));
        drivesCache = { at: now(), roots };
        resolve(roots);
      });
    });
  }

  /** The stored path when it is still a path this relay serves; '' otherwise. Never decodes. */
  async function servableLocalPath(locator) {
    const value = String(locator || '');
    if (!value || value.includes('\0')) return '';
    if (platform === 'win32') {
      if (!/^[A-Z]:\\/.test(value) || path.win32.normalize(value) !== value) return '';
      const roots = await allowedDriveRoots();
      if (roots && !roots.has(value.slice(0, 3).toUpperCase())) return '';
      return value;
    }
    if (!value.startsWith('/') || path.posix.normalize(value) !== value) return '';
    if (isPseudoFileSystemPath(value, platform)) return '';
    return value;
  }

  function generatedPath(item) {
    let info = parseGeneratedLocator(item.locator);
    if (!info.relativePath || !info.sessionId) {
      // Embedded by its route only: the attachment of the message it names.
      const message = info.messageId ? db.prepare(`SELECT attachments FROM messages WHERE id = ? AND conversation_id = ?`)
        .get(info.messageId, info.conversationId) : null;
      info = { ...info, ...(generatedFromMessage(message?.attachments, info.imageId) || {}) };
    }
    if (!info.relativePath || !info.sessionId) return '';
    return resolveGeneratedImagePath({ sessionId: info.sessionId, relativePath: info.relativePath }) || '';
  }

  /** The file behind an item, for the presence check and for serving; null when it has none (remote, data). */
  async function filePathFor(item) {
    switch (item.locatorKind) {
      case 'local_path': return (await servableLocalPath(item.locator)) || '';
      case 'upload_sha': return /^[a-f0-9]{64}$/.test(item.locator) ? String(uploadPathForSha(item.locator) || '') : '';
      case 'generated': return generatedPath(item);
      default: return null;
    }
  }

  function clientItem(item) {
    const out = {
      id: item.id,
      conversationId: item.conversationId,
      conversationTitle: item.conversationTitle,
      archived: item.archived,
      provider: item.provider,
      messageId: item.messageId,
      sender: item.sender,
      origin: item.origin,
      mediaKind: item.mediaKind,
      mime: item.mime,
      name: item.name,
      alt: item.alt,
      sizeBytes: item.sizeBytes,
      timestamp: item.timestamp,
      occurrences: item.occurrences,
      contentUrl: null,
      remoteUrl: null,
      path: null,
    };
    if (item.locatorKind === 'remote_url') out.remoteUrl = item.locator;
    else if (item.locatorKind === 'upload_sha') out.contentUrl = `/api/upload/${item.locator}/content`;
    else out.contentUrl = `/api/media/${item.id}/content`;
    if (item.locatorKind === 'local_path') out.path = item.locator;
    return out;
  }

  /**
   * Opens the file of an item when it may be served: the stored path passes
   * the checks, so does its real path (a link is followed only to a target
   * that passes them too), it is a regular file, and a local picture or video
   * is what its name says. One descriptor from the open on: the checks, the
   * first bytes and the bytes sent are of the same file. `null` when it may
   * not be served (or a call on the drive took too long); the caller closes
   * `fd`.
   */
  async function openServable(item) {
    let filePath = await filePathFor(item);
    if (!filePath) return null;
    if (item.locatorKind === 'local_path') {
      const real = await withTimeout(realpathKeepingDrives(filePath), FS_TIMEOUT_MS, '');
      filePath = real ? await servableLocalPath(real) : '';
      if (!filePath) return null;
    }
    const fd = await withTimeout(openFile(filePath, OPEN_FLAGS), FS_TIMEOUT_MS, null, closeFile);
    if (fd === null || fd === undefined) return null;
    try {
      const stat = await withTimeout(fstatFile(fd), FS_TIMEOUT_MS, null);
      if (!stat?.isFile()) throw new Error('not a file');
      let contentType = item.mime || 'application/octet-stream';
      if (item.locatorKind === 'local_path' && item.category === 'media') {
        contentType = sniffLocalMediaType(await readHead(fd), item);
        if (!contentType) throw new Error('not a picture or video');
      }
      return { fd, filePath, stat, contentType, contentAddressed: item.locatorKind !== 'local_path' };
    } catch {
      closeFile(fd);
      return null;
    }
  }

  // Whether a tile can be served, asked for every listed item with a file;
  // kept a minute per item and file version of the stored path.
  const servable = new Map();
  async function present(item) {
    if (item.locatorKind === 'remote_url') return true;
    if (item.locatorKind === 'data_uri' || item.locatorKind === 'legacy_data_url') return true;
    const key = `${item.id}:${item.locator}`;
    const cached = servable.get(key);
    if (cached && now() - cached.at < SERVABLE_TTL_MS) return cached.ok;
    const opened = await openServable(item);
    if (opened) closeFile(opened.fd);
    servable.delete(key);
    servable.set(key, { ok: Boolean(opened), at: now() });
    while (servable.size > SERVABLE_CACHE_MAX) servable.delete(servable.keys().next().value);
    return Boolean(opened);
  }

  function readFilters(query) {
    const source = MEDIA_SOURCES.includes(String(query.source || '')) ? String(query.source) : 'all';
    return {
      category: query.category === 'file' ? 'file' : 'media',
      conversationId: String(query.conversationId || '').trim() || null,
      source,
      provider: String(query.provider || '').trim() || null,
      archived: query.archived === 'hide' ? 'hide' : 'include',
      q: String(query.q || '').trim(),
    };
  }

  app.get('/api/media', auth, async (req, res) => {
    try {
      const indexing = indexService.drainForRequest();
      const filters = readFilters(req.query || {});
      const limit = Math.max(1, Math.min(120, Number.parseInt(String(req.query?.limit || '60'), 10) || 60));
      let cursor = decodeMediaCursor(req.query?.cursor);
      if (req.query?.cursor && !cursor) return res.status(400).json({ error: 'Invalid cursor' });
      const items = [];
      let missingHidden = 0;
      let nextCursor = null;
      // Missing files are left out; the page refills from the next rows.
      for (let round = 0; round < MAX_PAGE_ROUNDS && items.length < limit; round += 1) {
        const rows = repository.listMedia({ ...filters, cursor, limit });
        for (const row of rows) {
          if (items.length >= limit) break;
          if (await present(row)) items.push(clientItem(row));
          else missingHidden += 1;
          cursor = { timestamp: row.timestamp, id: row.id };
        }
        nextCursor = rows.length === limit ? encodeMediaCursor(cursor) : null;
        if (!nextCursor) break;
      }
      res.json({ items, nextCursor, missingHidden, indexing: { pending: indexing.pending } });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to list media' });
    }
  });

  app.get('/api/media/counts', auth, (req, res) => {
    try {
      const indexing = indexService.drainForRequest();
      const conversationId = String(req.query?.conversationId || '').trim() || null;
      res.json({ ...repository.countMedia({ conversationId }), pending: indexing.pending });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to count media' });
    }
  });

  app.get('/api/media/facets', auth, (req, res) => {
    try {
      indexService.drainForRequest();
      res.json(repository.mediaFacets());
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to list media filters' });
    }
  });

  app.get('/api/media/:id/content', auth, async (req, res) => {
    const raw = String(req.params.id || '');
    if (!/^\d{1,15}$/.test(raw)) return res.status(400).json({ error: 'Invalid media id' });
    const item = repository.getMediaItem(Number(raw));
    if (!item) return res.status(404).json({ error: 'Not found' });
    try {
      if (item.locatorKind === 'data_uri' || item.locatorKind === 'legacy_data_url') {
        const found = findDataImage({ text: item.text, attachments: item.attachments }, item.identityKey);
        const bytes = found ? Buffer.from(found.payload, 'base64') : null;
        if (!bytes || !IMAGE_MAGIC[found.mime]?.(bytes)) return res.status(404).json({ error: 'Not found' });
        const etag = `"${item.identityKey.slice('data:'.length, 'data:'.length + 32)}"`;
        res.setHeader('Cache-Control', CONTENT_ADDRESSED_CACHE);
        res.setHeader('ETag', etag);
        if (req.headers['if-none-match'] === etag) return res.status(304).end();
        applySafeServedContentHeaders(res, found.mime, { fileName: item.name || 'image' });
        res.setHeader('Content-Length', String(bytes.length));
        return res.end(bytes);
      }
      const opened = await openServable(item);
      if (!opened) return res.status(404).json({ error: 'Not found' });
      const { fd, filePath, stat, contentType, contentAddressed } = opened;
      const version = fileVersionToken({ mtimeMs: stat.mtimeMs, size: stat.size });
      if (!contentAddressed && version && req.headers['if-none-match'] === `W/"${version}"`) {
        closeFile(fd);
        res.setHeader('Cache-Control', REVALIDATE_CACHE);
        res.setHeader('ETag', `W/"${version}"`);
        return res.status(304).end();
      }
      const safeName = String(item.name || path.basename(filePath)).replace(/"/g, '');
      // Sent from the descriptor the checks were made on.
      const fromOpenFile = {
        openSync: () => fd,
        fstatSync: (handle) => fs.fstatSync(handle),
        closeSync: (handle) => fs.closeSync(handle),
        createReadStream: (target, options) => fs.createReadStream(target, options),
      };
      return serveFileWithRangeSupport(req, res, filePath, { contentType }, {
        safeName,
        cacheControl: contentAddressed ? CONTENT_ADDRESSED_CACHE : REVALIDATE_CACHE,
        fsImpl: fromOpenFile,
      });
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: error?.message || 'Failed to read media' });
    }
  });

  if (startIndexer) indexService.start();
  return { repository, indexService };
}
