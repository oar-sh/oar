'use strict';

import fs from 'fs';
import path from 'path';

// Static mode for the preview lane: "show me this file/build output" without a
// dev server. The lane serves a registered directory in-process — a request
// handler, not a child process, so the "relay never spawns or supervises
// servers" rule stands.
//
// Everything here is jail-first. The registered root is realpath-resolved and
// must sit inside the conversation's workspace root at registration; every
// request re-resolves and re-checks containment, so a symlink created after
// registration cannot walk out either.

// A static preview shows a build output, not the whole working tree. Dotfile
// segments (.git, .env, .ssh, …) are denied wholesale; these extensions and
// name patterns catch key material living outside dot-directories.
const DENIED_EXTENSIONS = new Set(['.pem', '.key']);
const DENIED_NAME_RE = /^id_(rsa|ed25519|ecdsa|dsa)/i;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function toText(value) {
  return String(value ?? '').trim();
}

function isWithin(childPath, parentPath, pathImpl = path) {
  const relative = pathImpl.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !pathImpl.isAbsolute(relative));
}

export function contentTypeForFile(filePath) {
  return CONTENT_TYPES[path.extname(String(filePath || '')).toLowerCase()]
    || 'application/octet-stream';
}

export function isDeniedName(fileName) {
  const name = toText(fileName);
  if (!name) return true;
  if (name.startsWith('.')) return true;
  if (DENIED_EXTENSIONS.has(path.extname(name).toLowerCase())) return true;
  return DENIED_NAME_RE.test(name);
}

/**
 * Registration-time jail: resolve `dir` (absolute, or relative to the
 * workspace root), realpath it, and require it to live inside the workspace
 * root's realpath. Returns `{ ok, rootDir }` or `{ ok:false, error }` with a
 * message that names exactly what was refused.
 */
export function validateStaticRoot(dir, { workspaceRoot, fsImpl = fs, pathImpl = path } = {}) {
  const dirInput = toText(dir);
  if (!dirInput) return { ok: false, error: 'Missing dir' };
  const workspaceInput = toText(workspaceRoot);
  if (!workspaceInput) {
    return { ok: false, error: 'No workspace root is known for this conversation; static previews need one to scope what may be served' };
  }

  let workspaceReal;
  try {
    workspaceReal = fsImpl.realpathSync(pathImpl.resolve(workspaceInput));
  } catch {
    return { ok: false, error: `Workspace root does not exist: ${workspaceInput}` };
  }

  const resolved = pathImpl.resolve(workspaceReal, dirInput);
  let rootReal;
  try {
    rootReal = fsImpl.realpathSync(resolved);
  } catch {
    return { ok: false, error: `Directory not found: ${dirInput}` };
  }
  let stats;
  try {
    stats = fsImpl.statSync(rootReal);
  } catch {
    return { ok: false, error: `Directory not found: ${dirInput}` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, error: `Not a directory: ${dirInput}` };
  }
  if (!isWithin(rootReal, workspaceReal, pathImpl)) {
    return { ok: false, error: `dir must live inside the workspace root (${workspaceReal})` };
  }
  return { ok: true, rootDir: rootReal };
}

/**
 * Request-time resolution inside a registered root. Returns one of:
 *  { kind:'file', filePath, contentType, size }
 *  { kind:'redirect', location }   — directory hit without a trailing slash
 *  { kind:'not-found' }
 */
export function resolveStaticFile(rootDir, upstreamPath, { fsImpl = fs, pathImpl = path } = {}) {
  const root = toText(rootDir);
  if (!root) return { kind: 'not-found' };

  const [rawPath] = toText(upstreamPath || '/').split('?');
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { kind: 'not-found' };
  }
  // NUL would truncate paths at the fs layer; nothing legitimate contains it.
  if (decoded.includes('\0')) return { kind: 'not-found' };

  const segments = decoded.split('/').filter(Boolean);
  for (const segment of segments) {
    // Traversal is refused on the raw segments BEFORE any fs resolution, so a
    // `..` can never even be handed to path.join; dotfiles ride the same check.
    if (segment === '..' || segment === '.') return { kind: 'not-found' };
    if (isDeniedName(segment)) return { kind: 'not-found' };
  }

  const joined = pathImpl.join(root, ...segments);
  if (!isWithin(joined, root, pathImpl)) return { kind: 'not-found' };

  // realpath catches symlinks pointing outside the root — including ones
  // created after registration.
  let real;
  try {
    real = fsImpl.realpathSync(joined);
  } catch {
    return { kind: 'not-found' };
  }
  if (!isWithin(real, root, pathImpl)) return { kind: 'not-found' };

  let stats;
  try {
    stats = fsImpl.statSync(real);
  } catch {
    return { kind: 'not-found' };
  }

  if (stats.isDirectory()) {
    // A directory URL without the trailing slash would make the browser
    // resolve relative assets against the parent — redirect like the lane
    // does for the bare token path.
    if (segments.length > 0 && !decoded.endsWith('/')) {
      return { kind: 'redirect', location: `${decoded}/` };
    }
    const indexPath = pathImpl.join(real, 'index.html');
    let indexStats;
    try {
      indexStats = fsImpl.statSync(indexPath);
    } catch {
      return { kind: 'not-found' };
    }
    if (!indexStats.isFile()) return { kind: 'not-found' };
    return {
      kind: 'file',
      filePath: indexPath,
      contentType: contentTypeForFile(indexPath),
      size: indexStats.size,
    };
  }

  if (!stats.isFile()) return { kind: 'not-found' };
  return {
    kind: 'file',
    filePath: real,
    contentType: contentTypeForFile(real),
    size: stats.size,
  };
}

/**
 * Streams a resolved static request onto an http response. `sendNotFound` is
 * the lane's shared 404 page so static and proxy misses look identical.
 */
export function serveStaticPreview(entry, upstreamPath, req, res, {
  fsImpl = fs,
  pathImpl = path,
  sendNotFound = () => {},
} = {}) {
  const resolved = resolveStaticFile(entry.rootDir, upstreamPath, { fsImpl, pathImpl });

  if (resolved.kind === 'redirect') {
    const basePrefix = entry.basePath.replace(/\/$/, '');
    res.writeHead(301, { location: `${basePrefix}${resolved.location}`, 'cache-control': 'no-store' });
    res.end();
    return;
  }
  if (resolved.kind !== 'file') {
    sendNotFound(res);
    return;
  }

  const headers = {
    'content-type': resolved.contentType,
    'content-length': resolved.size,
    // Static previews exist for iteration; a cached stale index defeats them.
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow, noarchive',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  const stream = fsImpl.createReadStream(resolved.filePath);
  stream.on('error', () => { try { res.destroy(); } catch {} });
  res.on('close', () => { try { stream.destroy(); } catch {} });
  stream.pipe(res);
}
