import fs from 'fs';
import path from 'path';
import { fileVersionToken, serveFileWithRangeSupport, withFileVersion } from '../services/file-serving.mjs';
import { FILE_CAPABILITY_REQUEST_KEY, withFileCapability } from '../services/file-capability.mjs';
import { validateEntryName } from '../services/explorer-entry-name.mjs';
import { countEntries, createDirectory, removeEntry, renameEntry } from '../services/explorer-mutations.mjs';
import { principalOf } from '../services/relay-principal.mjs';
import { AUTH_ERROR_CODES, AUTH_FILE_CAPABILITY_MESSAGE, FILE_PROTECTED_MESSAGE } from '../../shared/relay-route-policy.mjs';

// The file, repository and drive routes: a workspace file by path and its
// preview, the file capabilities for them, the repository tree and the
// drives and session-root listings, and the explorer's changes (new folder,
// rename, delete).

// Preview kinds whose bytes travel in the preview JSON; media and PDF are
// fetched by the browser from the raw URL instead.
const TEXT_PREVIEW_KINDS = new Set(['markdown', 'code', 'text']);

// The path a `{*splat}` route matched: express 5 hands it over as its
// decoded segments, or not at all when the path ends at the slash.
export function splatPath(req) {
  const splat = req.params?.splat;
  return Array.isArray(splat) ? splat.join('/') : String(splat || '');
}

export function registerFileRoutes(app, deps, shared) {
  const {
    auth,
    MAX_REPO_TREE_NODES,
    MAX_WORKSPACE_PREVIEW_BYTES,
    remotePath,
    parseBooleanQueryFlag,
    fetchBrowsableDrives,
    fetchWorkspaceDirectoryEntries,
    fetchDriveDirectoryEntries,
    mapDriveDirectoryEntry,
    driveDisplayName,
    normalizeDriveAbsolutePath,
    driveRootFromAbsolutePath,
    toDriveWebPath,
    normalizeLinuxAbsolutePath,
    fetchLinuxDirectoryEntries,
    mapLinuxDirectoryEntry,
    readWorkspaceFileMeta,
    // The cache readWorkspaceFileMeta fills. The routes drop an entry when a
    // read shows it is out of date, and the preview routes before every read.
    workspaceFileMetaCache,
    resolveWorkspaceFilePath,
    normalizeWorkspaceRelativePath,
    previewLanguageForWorkspaceFile,
    readWorkspaceFilePreviewBuffer,
    isLikelyBinaryPreviewBuffer,
    isLikelyTextContentType,
    workspacePreviewKindForMeta,
    workspaceContentType,
    resolveConversationWorkspaceState,
  } = deps;
  const {
    fileCapabilities,
    resolveWorkspaceFileTargetPath,
    filePlatform,
    protectedRelayFiles,
    isProtectedRelayFile,
  } = shared;

  function resolveConversationWorkspaceScope(req) {
    const conversationId = String(
      req?.query?.conversationId
      || req?.query?.conversation_id
      || req?.headers?.['x-conversation-id']
      || '',
    ).trim();
    const sdkSessionId = String(
      req?.query?.sdkSessionId
      || req?.query?.sdk_session_id
      || req?.headers?.['x-sdk-session-id']
      || '',
    ).trim();
    if (!conversationId && !sdkSessionId) return null;
    return { conversationId, sdkSessionId };
  }

  function resolveScopedWorkspaceRootPath(req) {
    if (typeof resolveConversationWorkspaceState !== 'function') return null;
    const scope = resolveConversationWorkspaceScope(req);
    if (!scope) return null;
    const state = resolveConversationWorkspaceState(scope);
    const rootPath = String(state?.currentWorkspaceRootPath || '').trim();
    return rootPath || null;
  }

  function scopedWorkspaceQuerySuffix(req) {
    const scope = resolveConversationWorkspaceScope(req);
    if (!scope) return '';
    const params = new URLSearchParams();
    if (scope.conversationId) params.set('conversationId', scope.conversationId);
    if (scope.sdkSessionId) params.set('sdkSessionId', scope.sdkSessionId);
    const text = params.toString();
    return text ? `?${text}` : '';
  }

  function refuseFileCapability(res) {
    res.status(403).json({ error: AUTH_FILE_CAPABILITY_MESSAGE, code: AUTH_ERROR_CODES.fileCapability });
    return true;
  }

  /**
   * First thing a file route does for a request `auth` let in on a file
   * capability: its MAC against the path the request asks for, absolute and
   * normalized as a string (`targetOf()`, which reads nothing from the disk;
   * '' for a path the route would refuse). A wrong one gets 403
   * AUTH_FILE_CAPABILITY whatever the path (missing, a link, the relay's
   * own files): no link is resolved, no file looked at and no drive listed
   * before it. A right one is marked on the request for that path, which
   * file-serving.mjs checks again. True when refused; false without a
   * capability (the request carries the proof key or a Bearer).
   */
  function fileCapabilityRefused(req, res, targetOf) {
    const capability = req?.[FILE_CAPABILITY_REQUEST_KEY];
    if (!capability) return false;
    let target = '';
    try { target = String((typeof targetOf === 'function' ? targetOf() : targetOf) || ''); } catch { target = ''; }
    let checked = null;
    try { checked = target ? fileCapabilities?.verify?.(capability.k, { filePath: target, sessionIds: capability.sessionIds }) : null; } catch { checked = null; }
    if (!checked?.ok) return refuseFileCapability(res);
    capability.verified = true;
    capability.verifiedPath = target;
    return false;
  }

  /**
   * Before a file route reads `filePath`, after its path checks: 403 for the
   * relay's own secrets, database and config, whoever asks; the check
   * resolves links, so the file a verified capability's path really is gets
   * looked at too. A request on a capability must be about the path it was
   * verified for. True when refused.
   */
  function fileAccessRefused(req, res, filePath) {
    const capability = req?.[FILE_CAPABILITY_REQUEST_KEY];
    if (capability && (capability.verified !== true || capability.verifiedPath !== filePath)) return refuseFileCapability(res);
    if (isProtectedRelayFile(filePath)) {
      res.status(403).json({ error: FILE_PROTECTED_MESSAGE, code: AUTH_ERROR_CODES.protectedFile });
      return true;
    }
    return false;
  }

  // The absolute path GET /api/drives/file or /api/files/* resolves for a
  // relative address of either (with or without the relay's base path), as
  // the routes themselves resolve it; '' for anything else.
  function fileRoutePathOf(rawUrl) {
    const text = String(rawUrl || '').trim();
    if (!text.startsWith('/') || text.startsWith('//') || text.length > 4096) return '';
    let parsed = null;
    try { parsed = new URL(text, 'http://relay.invalid'); } catch { return ''; }
    const base = String(remotePath || '').replace(/\/+$/, '');
    let appPath = parsed.pathname;
    if (base && (appPath === base || appPath.startsWith(`${base}/`))) appPath = appPath.slice(base.length);
    if (appPath === '/api/drives/file') {
      return driveFileTargetPath(String(parsed.searchParams.get('path') || '').trim());
    }
    if (appPath.startsWith('/api/files/')) {
      let requestedPath = '';
      try {
        requestedPath = appPath.slice('/api/files/'.length).split('/').map((segment) => decodeURIComponent(segment)).join('/').trim();
      } catch {
        return '';
      }
      const query = Object.fromEntries(parsed.searchParams.entries());
      const rootOverride = resolveScopedWorkspaceRootPath({ query, headers: {} });
      // Only for a path the route would serve (a link out of the workspace
      // is not one); signed as the string the route checks it against.
      if (!resolveWorkspaceFilePath(requestedPath, rootOverride)) return '';
      return resolveWorkspaceFileTargetPath(requestedPath, rootOverride) || '';
    }
    return '';
  }

  // The absolute path GET /api/drives/file is asked for, normalized as a
  // string; '' for one it refuses on its face.
  function driveFileTargetPath(requestedPath) {
    return (filePlatform === 'win32' ? normalizeDriveAbsolutePath(requestedPath) : normalizeLinuxAbsolutePath(requestedPath)) || '';
  }

  // File capabilities for the page's native loads (an <img>, a <video>, a
  // download, a PDF in a new tab): `{ urls: [...] }`, relative addresses of
  // GET /api/drives/file or /api/files/*, gives back `{ urls, expiresAt }`,
  // each address with its `k` (null for one that names no file the routes
  // would serve). Only a browser session gets capabilities; the owner token
  // gets the addresses back as they are (its Bearer reads them).
  const FILE_CAPABILITY_MAX_URLS = 200;
  app.post('/api/files/capability', auth, (req, res) => {
    const urls = Array.isArray(req.body?.urls) ? req.body.urls : null;
    if (!urls || urls.length > FILE_CAPABILITY_MAX_URLS || urls.some((url) => typeof url !== 'string')) {
      return res.status(400).json({ error: `urls: a list of at most ${FILE_CAPABILITY_MAX_URLS} addresses` });
    }
    const principal = principalOf(req);
    res.setHeader('Cache-Control', 'no-store');
    if (principal?.kind !== 'browser') {
      return res.json({ urls: urls.map((url) => (fileRoutePathOf(url) ? url : null)), expiresAt: null });
    }
    let expiresAtMs = null;
    const signed = urls.map((url) => {
      const filePath = fileRoutePathOf(url);
      if (!filePath || isProtectedRelayFile(filePath)) return null;
      const made = fileCapabilities?.mint?.({ sessionId: principal.sessionId, filePath });
      if (!made?.k) return null;
      expiresAtMs = expiresAtMs === null ? made.expiresAtMs : Math.min(expiresAtMs, made.expiresAtMs);
      return withFileCapability(url, made.k);
    });
    return res.json({ urls: signed, expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString() });
  });

  app.get('/api/files/{*splat}', auth, (req, res) => {
    const requestedPath = splatPath(req).trim();
    const rootOverride = resolveScopedWorkspaceRootPath(req);
    // A capability first, then the path checks (a link out of the
    // workspace): no 400-or-403 difference for a wrong `k`.
    if (fileCapabilityRefused(req, res, () => resolveWorkspaceFileTargetPath(requestedPath, rootOverride))) return;
    const filePath = resolveWorkspaceFilePath(requestedPath, rootOverride);
    if (!filePath) return res.status(400).json({ error: 'Invalid file path' });
    if (fileAccessRefused(req, res, filePath)) return;

    let meta = null;
    try {
      meta = readWorkspaceFileMeta(filePath);
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
    }

    if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
    if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

    serveFileWithRangeSupport(req, res, filePath, meta, {
      safeName: path.basename(filePath).replace(/"/g, ''),
      cacheDelete: (p) => workspaceFileMetaCache.delete(p),
    });
  });

  app.get('/api/files-preview/{*splat}', auth, (req, res) => {
    const requestedPath = splatPath(req).trim();
    const normalizedPath = normalizeWorkspaceRelativePath(requestedPath);
    const rootOverride = resolveScopedWorkspaceRootPath(req);
    const filePath = resolveWorkspaceFilePath(requestedPath, rootOverride);
    if (!filePath || !normalizedPath) return res.status(400).json({ error: 'Invalid file path' });
    if (fileAccessRefused(req, res, filePath)) return;

    // The preview carries the version the download link is built from, so
    // it reads the file's metadata fresh, not from the short-lived cache.
    workspaceFileMetaCache.delete(filePath);
    let meta = null;
    try {
      meta = readWorkspaceFileMeta(filePath);
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
    }

    if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
    if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

    const size = Number(meta.size || 0);
    const contentType = meta.contentType || workspaceContentType(filePath);
    const language = previewLanguageForWorkspaceFile(filePath);

    let previewBuffer = Buffer.alloc(0);
    try {
      previewBuffer = readWorkspaceFilePreviewBuffer(filePath, size);
    } catch (error) {
      workspaceFileMetaCache.delete(filePath);
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return res.status(404).json({ error: 'File not found' });
      }
      return res.status(500).json({ error: 'Failed to read file' });
    }

    const truncated = size > MAX_WORKSPACE_PREVIEW_BYTES;
    const contentBuffer = truncated
      ? previewBuffer.subarray(0, Math.min(previewBuffer.length, MAX_WORKSPACE_PREVIEW_BYTES))
      : previewBuffer;

    const likelyBinaryType = contentType === 'application/pdf'
      || contentType === 'application/octet-stream';
    const likelyBinaryBytes = isLikelyBinaryPreviewBuffer(contentBuffer);
    const likelyTextType = isLikelyTextContentType(contentType);

    let kind = workspacePreviewKindForMeta(filePath, contentType);
    if ((kind === 'markdown' || kind === 'code' || kind === 'text') && likelyBinaryType) {
      kind = 'binary';
    } else if ((kind === 'markdown' || kind === 'code' || kind === 'text') && (!likelyTextType && likelyBinaryBytes)) {
      kind = 'binary';
    }

    const normalizedWebPath = normalizedPath.replace(/\\/g, '/');
    const scopeSuffix = scopedWorkspaceQuerySuffix(req);
    const payload = {
      ok: true,
      path: normalizedWebPath,
      name: path.basename(filePath),
      kind,
      language,
      contentType,
      size,
      truncated,
      previewBytes: contentBuffer.length,
      mtimeMs: meta.mtimeMs ?? null,
      version: fileVersionToken(meta),
      rawUrl: withFileVersion(`${remotePath}/api/files/${normalizedWebPath.split('/').map((part) => encodeURIComponent(part)).join('/')}${scopeSuffix}`, fileVersionToken(meta)),
    };

    if (TEXT_PREVIEW_KINDS.has(kind)) {
      payload.content = contentBuffer.toString('utf8');
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
  });

  app.get('/api/repo/tree', auth, (req, res) => {
    const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
    const includeHeavy = parseBooleanQueryFlag(req.query.includeHeavy, false);
    const rootOverride = resolveScopedWorkspaceRootPath(req);
    fetchWorkspaceDirectoryEntries('', {
      includeHidden,
      includeHeavy,
      rootPath: rootOverride,
    }, (listErr, payload) => {
      if (listErr) return res.status(Number(listErr?.statusCode) || 500).json({ error: listErr?.message || 'Failed to load repository tree' });
      const root = payload?.node || {
        path: '',
        name: 'repo',
        type: 'dir',
        children: [],
        childrenLoaded: true,
        lazy: false,
      };
      const childCount = Array.isArray(root.children) ? root.children.length : 0;
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        root,
        rootPath: payload?.rootPath || rootOverride || null,
        rootName: payload?.rootName || String(root?.name || 'repo'),
        includeHidden,
        includeHeavy,
        nodeCount: childCount + 1,
        maxNodes: MAX_REPO_TREE_NODES,
        truncated: false,
      });
    });
  });

  app.get('/api/repo/list', auth, (req, res) => {
    const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
    const includeHeavy = parseBooleanQueryFlag(req.query.includeHeavy, false);
    const requestedPath = String(req.query.path || '').trim();
    const rootOverride = resolveScopedWorkspaceRootPath(req);
    fetchWorkspaceDirectoryEntries(requestedPath, {
      includeHidden,
      includeHeavy,
      rootPath: rootOverride,
    }, (listErr, payload) => {
      if (listErr) return res.status(Number(listErr?.statusCode) || 500).json({ error: listErr?.message || 'Failed to list repository directory' });
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        node: payload?.node || null,
        rootPath: payload?.rootPath || rootOverride || null,
        rootName: payload?.rootName || null,
        includeHidden,
        includeHeavy,
      });
    });
  });

  app.get('/api/drives/roots', auth, (req, res) => {
    if (filePlatform !== 'win32') {
      return fetchLinuxDirectoryEntries('/', { includeHidden: false }, (listErr, entries) => {
        if (listErr) return res.status(500).json({ error: listErr.message || 'Failed to enumerate Linux root' });
        const children = entries.map(mapLinuxDirectoryEntry).filter((entry) => !!entry?.path);
        const root = {
          path: '/',
          name: '/',
          type: 'dir',
          children,
          childrenLoaded: true,
          lazy: false,
        };
        res.setHeader('Cache-Control', 'no-store');
        return res.json({
          ok: true,
          root,
          nodeCount: children.length + 1,
          truncated: false,
          maxNodes: children.length + 1,
          includeHidden: false,
          includeHeavy: false,
          rootName: 'Linux Root',
        });
      });
    }
    fetchBrowsableDrives((err, drives) => {
      if (err) return res.status(500).json({ error: err.message || 'Failed to enumerate drives' });
      const root = {
        path: '',
        name: 'Drives',
        type: 'dir',
        children: drives.map((drive) => ({
          path: drive.webPath,
          name: driveDisplayName(drive),
          type: 'dir',
          driveType: drive.driveType,
          label: drive.label || '',
          sizeBytes: drive.sizeBytes,
          freeBytes: drive.freeBytes,
          children: [],
          lazy: true,
          childrenLoaded: false,
        })),
        childrenLoaded: true,
      };
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        root,
        nodeCount: root.children.length + 1,
        truncated: false,
        maxNodes: root.children.length + 1,
        includeHidden: false,
        includeHeavy: false,
        rootName: 'Drives',
        driveTypes: ['fixed', 'removable'],
      });
    });
  });

  app.get('/api/drives/list', auth, (req, res) => {
    const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
    const requestedPath = String(req.query.path || '').trim();

    if (filePlatform !== 'win32') {
      const absolutePath = normalizeLinuxAbsolutePath(requestedPath);
      if (!absolutePath) return res.status(400).json({ error: 'Invalid Linux path' });

      let stat = null;
      try {
        stat = fs.statSync(absolutePath);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return res.status(404).json({ error: 'Path not found' });
        return res.status(500).json({ error: error?.message || 'Failed to read path metadata' });
      }
      if (!stat.isDirectory()) return res.status(400).json({ error: 'Path must reference a directory' });

      return fetchLinuxDirectoryEntries(absolutePath, { includeHidden }, (listErr, entries) => {
        if (listErr) return res.status(500).json({ error: listErr.message || 'Failed to list directory' });
        const children = entries.map(mapLinuxDirectoryEntry).filter((entry) => !!entry?.path);
        const node = {
          path: absolutePath,
          name: absolutePath === '/' ? '/' : (path.basename(absolutePath) || absolutePath),
          type: 'dir',
          children,
          childrenLoaded: true,
        };
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ ok: true, node, includeHidden });
      });
    }

    fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const absolutePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(absolutePath).toUpperCase();
      if (!absolutePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive path' });
      }

      let stat = null;
      try {
        stat = fs.statSync(absolutePath);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return res.status(404).json({ error: 'Path not found' });
        return res.status(500).json({ error: error?.message || 'Failed to read path metadata' });
      }
      if (!stat.isDirectory()) return res.status(400).json({ error: 'Path must reference a directory' });

      fetchDriveDirectoryEntries(absolutePath, { includeHidden }, (listErr, entries) => {
        if (listErr) return res.status(500).json({ error: listErr.message || 'Failed to list directory' });
        const children = entries
          .map(mapDriveDirectoryEntry)
          .filter((entry) => {
            if (!entry?.path) return false;
            const entryRoot = driveRootFromAbsolutePath(entry.path).toUpperCase();
            return allowedRoots.has(entryRoot);
          });
        const driveMeta = drives.find((drive) => drive.rootAbsolute.toUpperCase() === rootAbsolute);
        const nodePath = toDriveWebPath(absolutePath);
        const node = {
          path: nodePath,
          name: absolutePath.length <= 3 ? driveDisplayName(driveMeta) : (path.win32.basename(absolutePath) || nodePath),
          type: 'dir',
          driveType: driveMeta?.driveType || null,
          label: driveMeta?.label || '',
          children,
          childrenLoaded: true,
        };
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          ok: true,
          node,
          includeHidden,
        });
      });
    });
  });

  // The Session root of the explorer, listed the way `/api/drives/list` lists a
  // directory but with two differences that only make sense for a session:
  //
  //  - a not-yet-created root is an empty folder, not a 404. The Claude Agent
  //    SDK creates `<nativeSessionId>/` lazily, the first time the session
  //    writes a subagent or tool-result file, so a young session legitimately
  //    has a root path that has no directory behind it yet.
  //  - the sibling `<nativeSessionId>.jsonl` transcript is listed as a child.
  //    It lives one level up, in the project directory, which is not browsable
  //    on its own because it holds every session for the workspace.
  //
  // The transcript is derived from the requested path rather than accepted from
  // the client, so this endpoint reaches nothing `/api/drives/list` would not.
  app.get('/api/session-root/list', auth, (req, res) => {
    const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
    const requestedPath = String(req.query.path || '').trim();

    function transcriptChild(absolutePath, mapEntry, basename) {
      const transcriptPath = `${absolutePath}.jsonl`;
      let stat = null;
      try {
        stat = fs.statSync(transcriptPath);
      } catch {
        return null;
      }
      if (!stat.isFile()) return null;
      return mapEntry({
        name: basename(transcriptPath),
        fullPath: transcriptPath,
        type: 'file',
        size: stat.size,
        mtime: stat.mtime ? stat.mtime.toISOString() : null,
      });
    }

    function directoryState(absolutePath) {
      try {
        return fs.statSync(absolutePath).isDirectory() ? 'dir' : 'other';
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing';
        return 'error';
      }
    }

    if (filePlatform !== 'win32') {
      const absolutePath = normalizeLinuxAbsolutePath(requestedPath);
      if (!absolutePath) return res.status(400).json({ error: 'Invalid Linux path' });

      const state = directoryState(absolutePath);
      if (state === 'error') return res.status(500).json({ error: 'Failed to read session root metadata' });
      if (state === 'other') return res.status(400).json({ error: 'Session root must reference a directory' });

      const respond = (children) => {
        const transcript = transcriptChild(absolutePath, mapLinuxDirectoryEntry, path.posix.basename);
        const node = {
          path: absolutePath,
          name: path.posix.basename(absolutePath) || absolutePath,
          type: 'dir',
          children: transcript ? [...children, transcript] : children,
          childrenLoaded: true,
          lazy: false,
        };
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ ok: true, node, includeHidden, exists: state === 'dir' });
      };

      if (state === 'missing') return respond([]);
      return fetchLinuxDirectoryEntries(absolutePath, { includeHidden }, (listErr, entries) => {
        if (listErr) return res.status(500).json({ error: listErr.message || 'Failed to list session root' });
        return respond(entries.map(mapLinuxDirectoryEntry).filter((entry) => !!entry?.path));
      });
    }

    return fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const absolutePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(absolutePath).toUpperCase();
      if (!absolutePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive path' });
      }

      const state = directoryState(absolutePath);
      if (state === 'error') return res.status(500).json({ error: 'Failed to read session root metadata' });
      if (state === 'other') return res.status(400).json({ error: 'Session root must reference a directory' });

      const respond = (children) => {
        const transcript = transcriptChild(absolutePath, mapDriveDirectoryEntry, path.win32.basename);
        const nodePath = toDriveWebPath(absolutePath);
        const node = {
          path: nodePath,
          name: path.win32.basename(absolutePath) || nodePath,
          type: 'dir',
          children: transcript ? [...children, transcript] : children,
          childrenLoaded: true,
          lazy: false,
        };
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ ok: true, node, includeHidden, exists: state === 'dir' });
      };

      if (state === 'missing') return respond([]);
      return fetchDriveDirectoryEntries(absolutePath, { includeHidden }, (listErr, entries) => {
        if (listErr) return res.status(500).json({ error: listErr.message || 'Failed to list session root' });
        return respond(entries
          .map(mapDriveDirectoryEntry)
          .filter((entry) => {
            if (!entry?.path) return false;
            return allowedRoots.has(driveRootFromAbsolutePath(entry.path).toUpperCase());
          }));
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Explorer changes: new folder, rename, delete. Two routes per operation,
  // one for the conversation's workspace (relative paths, resolved exactly like
  // `/api/files/*`) and one for the drives and session roots (absolute paths,
  // checked exactly like `/api/drives/list`). Each write route therefore
  // reaches nothing its listing route would not show.
  // ---------------------------------------------------------------------------

  function workspaceWebPath(relativePath) {
    return String(relativePath || '').split(path.sep).join('/');
  }

  // Resolve a workspace entry from a request body: `{ absolutePath, relative }`
  // or `null` after answering the request with the error.
  function resolveWorkspaceMutationTarget(req, res, rawRelativePath) {
    const relative = normalizeWorkspaceRelativePath(rawRelativePath);
    if (!relative) {
      res.status(400).json({ error: 'Invalid path' });
      return null;
    }
    const absolutePath = resolveWorkspaceFilePath(relative, resolveScopedWorkspaceRootPath(req));
    if (!absolutePath) {
      res.status(400).json({ error: 'Invalid path' });
      return null;
    }
    return { absolutePath, relative };
  }

  // Resolve an absolute drives/session path from a request body and hand it
  // on, with the function that turns an absolute path into the explorer's
  // path form for the answer. Answers the request itself on a bad path.
  function withDriveMutationTarget(req, res, rawPath, { allowRoot = false } = {}, next) {
    const requestedPath = String(rawPath || '').trim();
    if (filePlatform !== 'win32') {
      const absolutePath = normalizeLinuxAbsolutePath(requestedPath);
      if (!absolutePath) return res.status(400).json({ error: 'Invalid Linux path' });
      if (absolutePath === '/' && !allowRoot) return res.status(400).json({ error: 'The root folder cannot be changed' });
      return next(absolutePath, (value) => value);
    }
    return fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const absolutePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(absolutePath).toUpperCase();
      if (!absolutePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive path' });
      }
      if (absolutePath.toUpperCase() === rootAbsolute && !allowRoot) {
        return res.status(400).json({ error: 'A drive root cannot be changed' });
      }
      return next(absolutePath, toDriveWebPath);
    });
  }

  function validatedName(res, rawName) {
    const check = validateEntryName(rawName);
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return null;
    }
    return check.name;
  }

  // The relay's own secrets, database and config, and any folder holding
  // them, are never created, renamed, moved or deleted here, whoever asks.
  function mutationRefused(res, ...targets) {
    const refused = targets.some((target) => {
      try { return protectedRelayFiles?.touchesProtected?.(target) === true; } catch { return true; }
    });
    if (refused) res.status(403).json({ error: FILE_PROTECTED_MESSAGE, code: AUTH_ERROR_CODES.protectedFile });
    return refused;
  }

  function sendMutationResult(res, result, extra = {}) {
    if (!result?.ok) {
      const status = Number(result?.statusCode) || 500;
      // An unexpected failure is logged with its message (the protected files
      // were refused before any change was tried, so it names none of them).
      if (status >= 500) console.warn(`[explorer] ${res.req?.path || 'change'} failed (${status}): ${result?.error || 'no message'}`);
      return res.status(status).json({ error: result?.error || 'Request failed' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, ...extra });
  }

  app.post('/api/repo/mkdir', auth, (req, res) => {
    const name = validatedName(res, req.body?.name);
    if (!name) return;
    const parentRelative = normalizeWorkspaceRelativePath(req.body?.path);
    if (String(req.body?.path || '').trim() && !parentRelative) return res.status(400).json({ error: 'Invalid path' });
    const target = resolveWorkspaceMutationTarget(req, res, parentRelative ? `${workspaceWebPath(parentRelative)}/${name}` : name);
    if (!target) return;
    if (mutationRefused(res, target.absolutePath)) return;
    return sendMutationResult(res, createDirectory(target.absolutePath), { path: workspaceWebPath(target.relative) });
  });

  app.post('/api/repo/rename', auth, (req, res) => {
    const newName = validatedName(res, req.body?.newName);
    if (!newName) return;
    const source = resolveWorkspaceMutationTarget(req, res, req.body?.path);
    if (!source) return;
    const parentWeb = workspaceWebPath(path.dirname(source.relative));
    const destinationWeb = parentWeb && parentWeb !== '.' ? `${parentWeb}/${newName}` : newName;
    // The destination goes through the same resolver: a new name can never
    // leave the workspace or land on the root.
    const destination = resolveWorkspaceMutationTarget(req, res, destinationWeb);
    if (!destination) return;
    if (mutationRefused(res, source.absolutePath, destination.absolutePath)) return;
    return sendMutationResult(res, renameEntry(source.absolutePath, newName), { path: workspaceWebPath(destination.relative) });
  });

  app.post('/api/repo/delete', auth, (req, res) => {
    const target = resolveWorkspaceMutationTarget(req, res, req.body?.path);
    if (!target) return;
    if (mutationRefused(res, target.absolutePath)) return;
    if (req.body?.dryRun === true) {
      const counted = countEntries(target.absolutePath);
      return sendMutationResult(res, counted, counted.ok ? { kind: counted.kind, files: counted.files, dirs: counted.dirs, capped: counted.capped } : {});
    }
    return sendMutationResult(res, removeEntry(target.absolutePath));
  });

  app.post('/api/drives/mkdir', auth, (req, res) => {
    const name = validatedName(res, req.body?.name);
    if (!name) return;
    withDriveMutationTarget(req, res, req.body?.path, { allowRoot: true }, (parentAbsolute, webPathOf) => {
      const targetAbsolute = path.join(parentAbsolute, name);
      if (mutationRefused(res, targetAbsolute)) return;
      return sendMutationResult(res, createDirectory(targetAbsolute), { path: webPathOf(targetAbsolute) });
    });
  });

  app.post('/api/drives/rename', auth, (req, res) => {
    const newName = validatedName(res, req.body?.newName);
    if (!newName) return;
    withDriveMutationTarget(req, res, req.body?.path, {}, (sourceAbsolute, webPathOf) => {
      if (mutationRefused(res, sourceAbsolute, path.join(path.dirname(sourceAbsolute), newName))) return;
      const result = renameEntry(sourceAbsolute, newName);
      return sendMutationResult(res, result, result.ok ? { path: webPathOf(result.path) } : {});
    });
  });

  app.post('/api/drives/delete', auth, (req, res) => {
    withDriveMutationTarget(req, res, req.body?.path, {}, (targetAbsolute) => {
      if (mutationRefused(res, targetAbsolute)) return;
      if (req.body?.dryRun === true) {
        const counted = countEntries(targetAbsolute);
        return sendMutationResult(res, counted, counted.ok ? { kind: counted.kind, files: counted.files, dirs: counted.dirs, capped: counted.capped } : {});
      }
      return sendMutationResult(res, removeEntry(targetAbsolute));
    });
  });

  app.get('/api/drives/file', auth, (req, res) => {
    const requestedPath = String(req.query.path || '').trim();
    // A capability first: before the path checks, the disk and the drive list.
    if (fileCapabilityRefused(req, res, () => driveFileTargetPath(requestedPath))) return;

    if (filePlatform !== 'win32') {
      const filePath = normalizeLinuxAbsolutePath(requestedPath);
      if (!filePath) return res.status(400).json({ error: 'Invalid Linux file path' });
      if (fileAccessRefused(req, res, filePath)) return;

      let meta = null;
      try {
        meta = readWorkspaceFileMeta(filePath);
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
      }

      if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
      if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

      return serveFileWithRangeSupport(req, res, filePath, meta, {
        safeName: path.basename(filePath).replace(/"/g, ''),
        cacheDelete: (p) => workspaceFileMetaCache.delete(p),
      });
    }

    fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const filePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(filePath).toUpperCase();
      if (!filePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive file path' });
      }
      if (fileAccessRefused(req, res, filePath)) return;

      let meta = null;
      try {
        meta = readWorkspaceFileMeta(filePath);
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
      }

      if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
      if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

      serveFileWithRangeSupport(req, res, filePath, meta, {
        safeName: path.win32.basename(filePath).replace(/"/g, ''),
        cacheDelete: (p) => workspaceFileMetaCache.delete(p),
      });
    });
  });

  app.get('/api/drives/files-preview', auth, (req, res) => {
    const requestedPath = String(req.query.path || '').trim();

    if (filePlatform !== 'win32') {
      const filePath = normalizeLinuxAbsolutePath(requestedPath);
      if (!filePath) return res.status(400).json({ error: 'Invalid Linux file path' });
      if (fileAccessRefused(req, res, filePath)) return;

      // Fresh metadata: the download link's version comes from this answer.
      workspaceFileMetaCache.delete(filePath);
      let meta = null;
      try {
        meta = readWorkspaceFileMeta(filePath);
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
      }

      if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
      if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

      const size = Number(meta.size || 0);
      const contentType = meta.contentType || workspaceContentType(filePath);
      const language = previewLanguageForWorkspaceFile(filePath);

      let previewBuffer = Buffer.alloc(0);
      try {
        previewBuffer = readWorkspaceFilePreviewBuffer(filePath, size);
      } catch (error) {
        workspaceFileMetaCache.delete(filePath);
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return res.status(404).json({ error: 'File not found' });
        }
        return res.status(500).json({ error: 'Failed to read file' });
      }

      const truncated = size > MAX_WORKSPACE_PREVIEW_BYTES;
      const contentBuffer = truncated
        ? previewBuffer.subarray(0, Math.min(previewBuffer.length, MAX_WORKSPACE_PREVIEW_BYTES))
        : previewBuffer;

      const likelyBinaryType = contentType === 'application/pdf' || contentType === 'application/octet-stream';
      const likelyBinaryBytes = isLikelyBinaryPreviewBuffer(contentBuffer);
      const likelyTextType = isLikelyTextContentType(contentType);

      let kind = workspacePreviewKindForMeta(filePath, contentType);
      if ((kind === 'markdown' || kind === 'code' || kind === 'text') && likelyBinaryType) {
        kind = 'binary';
      } else if ((kind === 'markdown' || kind === 'code' || kind === 'text') && (!likelyTextType && likelyBinaryBytes)) {
        kind = 'binary';
      }

      const payload = {
        ok: true,
        path: filePath,
        name: path.basename(filePath),
        kind,
        language,
        contentType,
        size,
        truncated,
        previewBytes: contentBuffer.length,
        mtimeMs: meta.mtimeMs ?? null,
        version: fileVersionToken(meta),
        rawUrl: withFileVersion(`${remotePath}/api/drives/file?path=${encodeURIComponent(filePath)}`, fileVersionToken(meta)),
      };

      if (TEXT_PREVIEW_KINDS.has(kind)) {
        payload.content = contentBuffer.toString('utf8');
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.json(payload);
    }

    fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const filePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(filePath).toUpperCase();
      if (!filePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive file path' });
      }
      if (fileAccessRefused(req, res, filePath)) return;

      // Fresh metadata: the download link's version comes from this answer.
      workspaceFileMetaCache.delete(filePath);
      let meta = null;
      try {
        meta = readWorkspaceFileMeta(filePath);
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
      }

      if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
      if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

      const size = Number(meta.size || 0);
      const contentType = meta.contentType || workspaceContentType(filePath);
      const language = previewLanguageForWorkspaceFile(filePath);

      let previewBuffer = Buffer.alloc(0);
      try {
        previewBuffer = readWorkspaceFilePreviewBuffer(filePath, size);
      } catch (error) {
        workspaceFileMetaCache.delete(filePath);
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return res.status(404).json({ error: 'File not found' });
        }
        return res.status(500).json({ error: 'Failed to read file' });
      }

      const truncated = size > MAX_WORKSPACE_PREVIEW_BYTES;
      const contentBuffer = truncated
        ? previewBuffer.subarray(0, Math.min(previewBuffer.length, MAX_WORKSPACE_PREVIEW_BYTES))
        : previewBuffer;

      const likelyBinaryType = contentType === 'application/pdf'
        || contentType === 'application/octet-stream';
      const likelyBinaryBytes = isLikelyBinaryPreviewBuffer(contentBuffer);
      const likelyTextType = isLikelyTextContentType(contentType);

      let kind = workspacePreviewKindForMeta(filePath, contentType);
      if ((kind === 'markdown' || kind === 'code' || kind === 'text') && likelyBinaryType) {
        kind = 'binary';
      } else if ((kind === 'markdown' || kind === 'code' || kind === 'text') && (!likelyTextType && likelyBinaryBytes)) {
        kind = 'binary';
      }

      const normalizedWebPath = toDriveWebPath(filePath);
      const payload = {
        ok: true,
        path: normalizedWebPath,
        name: path.win32.basename(filePath),
        kind,
        language,
        contentType,
        size,
        truncated,
        previewBytes: contentBuffer.length,
        mtimeMs: meta.mtimeMs ?? null,
        version: fileVersionToken(meta),
        rawUrl: withFileVersion(`${remotePath}/api/drives/file?path=${encodeURIComponent(normalizedWebPath)}`, fileVersionToken(meta)),
      };

      if (TEXT_PREVIEW_KINDS.has(kind)) {
        payload.content = contentBuffer.toString('utf8');
      }

      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    });
  });
}
