// GET /api/drives/file and /api/files/* with a browser session: the cookie
// alone reads no file, a file capability (`k`) from POST
// /api/files/capability opens its one file (Range included) for its session
// while both last, and the relay's secrets, database and config are refused
// to everyone. Real relay-auth, real browser sessions, the real handlers.
// Every credential is made at run time and never printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';

import { captureRoutes, makeRouteDeps } from './messages-routes-test-harness.mjs';
import { createAuthFailureLockout, createRelayAuth } from '../services/relay-auth.mjs';
import { createOwnerSecretStore } from '../services/owner-secret-store.mjs';
import { createBrowserSessionService, createSignInCodes } from '../services/browser-session-service.mjs';
import { createLocalRequestCheck } from '../services/request-boundary.mjs';
import { createFileCapabilities, FILE_CAPABILITY_TTL_MS, parseFileCapability, withFileCapability } from '../services/file-capability.mjs';
import { createProtectedRelayFiles } from '../services/relay-protected-files.mjs';
import { normalizeDriveAbsolutePath, normalizeLinuxAbsolutePath, toDriveWebPath } from '../services/drives-path-helpers.mjs';
import { migrateBrowserSessions } from '../migrations/0041-browser-sessions.mjs';

const COOKIE = 'copilot_auth';
const PROOF = 'X-OAR-Session-Proof';
const OWNER_TOKEN = crypto.randomUUID();
const PICTURE = Buffer.from(Array.from({ length: 300 }, (_, index) => index % 256));
const quiet = { log() {}, warn() {} };

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(/;\s*/)) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const key = part.slice(0, idx).trim();
      if (!(key in out)) out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

function appendSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? [].concat(existing, value) : value);
}

function readMeta(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return { kind: 'missing' }; }
  if (!stat.isFile()) return { kind: 'dir' };
  return { kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs, contentType: filePath.endsWith('.png') ? 'image/png' : 'text/plain' };
}

// The files below are real files in the host's temp folder, so by default the
// routes serve them as this host's relay would: drive paths and the drive
// list on Windows, POSIX paths elsewhere.
const HOST_PLATFORM = process.platform; // host-platform: real temp files are served

// `filePlatform`: the platform the file routes serve paths of ('win32'
// runs their Windows half here, with `drives` as the drive list; by default
// the drive of the temp folder on Windows, none elsewhere).
async function startRelay(t, { filePlatform = HOST_PLATFORM, drives = null } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oar-file-cap-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const driveList = drives ?? (HOST_PLATFORM === 'win32' ? [{ rootAbsolute: path.win32.parse(dir).root.toUpperCase() }] : []);
  const dataDir = path.join(dir, 'data');
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ authToken: OWNER_TOKEN }));
  const store = createOwnerSecretStore({ dataDir, logger: quiet });
  store.bootstrap({ config: JSON.parse(fs.readFileSync(configPath, 'utf8')), configPath });
  const dbPath = path.join(dataDir, 'oar.db');
  fs.writeFileSync(dbPath, 'database bytes');
  fs.writeFileSync(`${dbPath}-wal`, 'wal bytes');
  fs.writeFileSync(path.join(workspace, 'pic.png'), PICTURE);
  fs.writeFileSync(path.join(workspace, 'other.txt'), 'another file');
  // Links into the data folder from the workspace: a symlink and a hard link.
  fs.symlinkSync(path.join(dataDir, 'relay-secrets.json'), path.join(workspace, 'secrets-link.json'));
  fs.linkSync(dbPath, path.join(workspace, 'innocent.bin'));
  fs.linkSync(path.join(dataDir, 'relay-secrets.json'), path.join(workspace, 'notes.json'));

  const clock = { now: Date.now() };
  const db = new Database(':memory:');
  migrateBrowserSessions(db);
  const sessions = createBrowserSessionService({ db, now: () => clock.now, logger: quiet });
  const relayAuth = createRelayAuth({
    app: null,
    verifyOwnerToken: (value) => store.verifyOwnerToken(value),
    verifyAgentToken: (value) => store.verifyAgentToken(value),
    browserSessions: sessions,
    signInCodes: createSignInCodes({ now: () => clock.now }),
    cookieName: COOKIE,
    parseCookies,
    appendSetCookie,
    localRequestCheck: createLocalRequestCheck(),
    lockout: createAuthFailureLockout(),
    logger: quiet,
    nowMs: () => clock.now,
  });
  const fileCapabilities = createFileCapabilities({
    getKey: () => store.fileCapabilityKey(),
    getSession: (id) => sessions.get(id),
    nowMs: () => clock.now,
  });
  const protectedFiles = createProtectedRelayFiles({
    dataDir,
    configPath,
    files: () => [dbPath, `${dbPath}-wal`, `${dbPath}-shm`],
  });
  // Every look at the disk or the drive list a file route makes, counted.
  const spies = { isProtected: 0, realPath: 0, readMeta: 0, drives: 0 };
  const protectedRelayFiles = {
    isProtected: (filePath) => { spies.isProtected += 1; return protectedFiles.isProtected(filePath); },
    containsProtected: (dirPath) => protectedFiles.containsProtected(dirPath),
    touchesProtected: (target) => protectedFiles.touchesProtected(target),
  };
  // A workspace path as a string; the relay's resolveWorkspaceFilePath also
  // resolves its links (counted here as `realPath`, the path kept as is).
  const workspaceTarget = (requested) => {
    const target = path.resolve(workspace, String(requested || ''));
    return target.startsWith(`${workspace}${path.sep}`) ? target : null;
  };
  const routes = captureRoutes(makeRouteDeps({
    fileCapabilities,
    protectedRelayFiles,
    filePlatform,
    fetchBrowsableDrives: (callback) => { spies.drives += 1; callback(null, driveList); },
    remotePath: '',
    normalizeLinuxAbsolutePath,
    normalizeDriveAbsolutePath,
    driveRootFromAbsolutePath: (filePath) => (normalizeDriveAbsolutePath(filePath) ? `${normalizeDriveAbsolutePath(filePath).slice(0, 1)}:\\` : ''),
    // The relay's own: a drive change answers with the drive path it made.
    toDriveWebPath,
    readWorkspaceFileMeta: (filePath) => { spies.readMeta += 1; return readMeta(filePath); },
    workspaceFileMetaCache: new Map(),
    normalizeWorkspaceRelativePath: (value) => String(value || '').replace(/^\/+/, ''),
    resolveWorkspaceFileTargetPath: workspaceTarget,
    resolveWorkspaceFilePath: (requested) => {
      spies.realPath += 1;
      return workspaceTarget(requested);
    },
  }));
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.post('/api/auth/session', relayAuth.signIn);
  const mutationRoutes = ['/api/drives/mkdir', '/api/drives/rename', '/api/drives/delete', '/api/repo/mkdir', '/api/repo/rename', '/api/repo/delete'];
  for (const key of ['GET /api/drives/file', 'GET /api/files/{*splat}', 'POST /api/files/capability', ...mutationRoutes.map((route) => `POST ${route}`)]) {
    const [method, routePath] = key.split(' ');
    const handler = routes.get(key);
    assert.equal(typeof handler, 'function', key);
    app[method.toLowerCase()](routePath, relayAuth.auth, handler);
  }
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, { method = 'GET', headers = {}, body } = {}) => fetch(`${base}${route}`, {
    method,
    headers: { 'Sec-Fetch-Site': 'same-origin', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  async function signIn() {
    const response = await call('/api/auth/session', { method: 'POST', headers: { Authorization: `Bearer ${OWNER_TOKEN}` }, body: { deviceId: crypto.randomUUID() } });
    const answer = await response.json();
    const cookie = (response.headers.getSetCookie().filter((line) => line.startsWith(`${COOKIE}=`)).at(-1) || '').split(';')[0];
    assert.equal(response.status, 200);
    return { cookie, proof: answer.proof, id: answer.session.id };
  }
  async function mint(session, urls, headers = { Cookie: session.cookie, [PROOF]: session.proof }) {
    const response = await call('/api/files/capability', { method: 'POST', headers, body: { urls } });
    return { status: response.status, body: await response.json() };
  }
  // The string a drive path is signed and checked as on this relay.
  const targetOf = (filePath) => (filePlatform === 'win32' ? normalizeDriveAbsolutePath(filePath) : normalizeLinuxAbsolutePath(filePath));
  return { dataDir, workspace, configPath, dbPath, store, sessions, clock, call, signIn, mint, spies, targetOf };
}

const driveUrl = (filePath) => `/api/drives/file?path=${encodeURIComponent(filePath)}`;
const kOf = (url) => new URL(url, 'http://x').searchParams.get('k') || '';
const codeOf = async (response) => (await response.json()).code;

test('the cookie alone reads no file by path: 403 AUTH_SESSION_PROOF on both routes', async (t) => {
  const relay = await startRelay(t);
  const session = await relay.signIn();
  const picture = path.join(relay.workspace, 'pic.png');
  for (const route of [driveUrl(picture), '/api/files/pic.png', driveUrl(path.join(relay.dataDir, 'relay-secrets.json'))]) {
    const response = await relay.call(route, { headers: { Cookie: session.cookie } });
    assert.equal(response.status, 403, route);
    assert.equal(await codeOf(response), 'AUTH_SESSION_PROOF', route);
  }
  // With the key the page reads it (its own fetches).
  const withKey = await relay.call(driveUrl(picture), { headers: { Cookie: session.cookie, [PROOF]: session.proof } });
  assert.equal(withKey.status, 200);
});

test('a capability opens its one file with the cookie, a Range request too; not another file, not without the cookie', async (t) => {
  const relay = await startRelay(t);
  const session = await relay.signIn();
  const picture = path.join(relay.workspace, 'pic.png');
  const asked = [driveUrl(picture), '/api/files/pic.png?v=abc', '/elsewhere/x.png', 'https://example.invalid/api/drives/file?path=%2Fetc%2Fhostname'];
  const minted = await relay.mint(session, asked);
  assert.equal(minted.status, 200);
  const [drive, workspace, other, foreign] = minted.body.urls;
  assert.equal(other, null);
  assert.equal(foreign, null);
  assert.ok(drive.startsWith(`${driveUrl(picture)}&k=`), 'the address as asked, with its k');
  assert.ok(workspace.startsWith('/api/files/pic.png?v=abc&k='));
  const parsed = parseFileCapability(kOf(drive));
  assert.equal(parsed.sessionId, session.id);
  const expiresAt = Date.parse(minted.body.expiresAt);
  assert.ok(expiresAt > relay.clock.now && expiresAt <= relay.clock.now + FILE_CAPABILITY_TTL_MS, 'at most 10 minutes');

  for (const url of [drive, workspace]) {
    const full = await relay.call(url, { headers: { Cookie: session.cookie } });
    assert.equal(full.status, 200, url);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), PICTURE);
    const range = await relay.call(url, { headers: { Cookie: session.cookie, Range: 'bytes=10-19' } });
    assert.equal(range.status, 206, url);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), PICTURE.subarray(10, 20));
    // A download name or a version beside it changes nothing.
    assert.equal((await relay.call(`${url}&as=pic%20(1).png`, { headers: { Cookie: session.cookie } })).status, 200);
  }
  // The same k on another file: 403.
  const moved = withFileCapability(driveUrl(path.join(relay.workspace, 'other.txt')), kOf(drive));
  const wrongFile = await relay.call(moved, { headers: { Cookie: session.cookie } });
  assert.equal(wrongFile.status, 403);
  assert.equal(await codeOf(wrongFile), 'AUTH_FILE_CAPABILITY');
  const otherRoute = await relay.call(withFileCapability('/api/files/other.txt', kOf(workspace)), { headers: { Cookie: session.cookie } });
  assert.equal(otherRoute.status, 403);
  // Without a cookie, or with another session's cookie: no.
  assert.equal((await relay.call(drive)).status, 401);
  const second = await relay.signIn();
  const foreignCookie = await relay.call(drive, { headers: { Cookie: second.cookie } });
  assert.equal(foreignCookie.status, 403);
  assert.equal(await codeOf(foreignCookie), 'AUTH_FILE_CAPABILITY');
  // A forged or altered k: no.
  const mac = kOf(drive).split('.').at(-1);
  const flipped = `${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`;
  const forged = withFileCapability(driveUrl(picture), kOf(drive).replace(mac, flipped));
  assert.equal((await relay.call(forged, { headers: { Cookie: session.cookie } })).status, 403);
  // A k on a route that takes none: the proof key is still needed.
  assert.equal((await relay.call(`/api/files/capability?k=${encodeURIComponent(kOf(drive))}`, { method: 'POST', headers: { Cookie: session.cookie }, body: { urls: [] } })).status, 403);
});

test('an expired capability, or one whose session was signed out, is refused', async (t) => {
  const relay = await startRelay(t);
  const session = await relay.signIn();
  const picture = path.join(relay.workspace, 'pic.png');
  const [url] = (await relay.mint(session, [driveUrl(picture)])).body.urls;
  assert.equal((await relay.call(url, { headers: { Cookie: session.cookie } })).status, 200);
  relay.clock.now += FILE_CAPABILITY_TTL_MS + 1_000;
  const expired = await relay.call(url, { headers: { Cookie: session.cookie } });
  assert.equal(expired.status, 403);
  assert.equal(await codeOf(expired), 'AUTH_FILE_CAPABILITY');
  // A fresh one works; after sign-out it does not (the cookie is no session any more either).
  const [fresh] = (await relay.mint(session, [driveUrl(picture)])).body.urls;
  assert.equal((await relay.call(fresh, { headers: { Cookie: session.cookie } })).status, 200);
  relay.sessions.revoke(session.id);
  const signedOut = await relay.call(fresh, { headers: { Cookie: session.cookie } });
  assert.ok(signedOut.status === 401 || signedOut.status === 403, `signed out: ${signedOut.status}`);
});

test('the relay\'s secrets, database and config are refused to everyone, a valid capability and the owner token included', async (t) => {
  const relay = await startRelay(t);
  const session = await relay.signIn();
  const owner = { Authorization: `Bearer ${OWNER_TOKEN}` };
  const agent = { Authorization: `Bearer ${relay.store.mintAgentToken({ kind: 's', subject: 'conv-1' })}` };
  const refused = [
    path.join(relay.dataDir, 'relay-secrets.json'),
    relay.dbPath,
    `${relay.dbPath}-wal`,
    relay.configPath,
    path.join(relay.workspace, 'secrets-link.json'),
    path.join(relay.workspace, 'innocent.bin'),
  ];
  for (const filePath of refused) {
    for (const headers of [owner, agent, { Cookie: session.cookie, [PROOF]: session.proof }]) {
      const response = await relay.call(driveUrl(filePath), { headers });
      assert.equal(response.status, 403, filePath);
      assert.equal(await codeOf(response), 'FILE_PROTECTED', filePath);
    }
  }
  // No capability is made for them; one made by hand for them is refused too.
  const minted = await relay.mint(session, refused.map(driveUrl));
  assert.deepEqual(minted.body.urls, refused.map(() => null));
  const caps = createFileCapabilities({ getKey: () => relay.store.fileCapabilityKey(), getSession: (id) => relay.sessions.get(id), nowMs: () => relay.clock.now });
  const handMade = caps.mint({ sessionId: session.id, filePath: relay.targetOf(relay.dbPath) });
  const response = await relay.call(withFileCapability(driveUrl(relay.dbPath), handMade.k), { headers: { Cookie: session.cookie } });
  assert.equal(response.status, 403);
  assert.equal(await codeOf(response), 'FILE_PROTECTED');
  assert.equal((await relay.call('/api/files/secrets-link.json', { headers: owner })).status, 403);
  // Any other file still reads with the owner token and an agent token.
  assert.equal((await relay.call(driveUrl(path.join(relay.workspace, 'pic.png')), { headers: owner })).status, 200);
  assert.equal((await relay.call('/api/files/pic.png', { headers: agent })).status, 200);
});

test('the capability route: a browser session with its key; not the cookie alone, not an agent; the owner token gets the addresses back as they are', async (t) => {
  const relay = await startRelay(t);
  const session = await relay.signIn();
  const urls = [driveUrl(path.join(relay.workspace, 'pic.png'))];
  const cookieOnly = await relay.mint(session, urls, { Cookie: session.cookie });
  assert.equal(cookieOnly.status, 403);
  assert.equal(cookieOnly.body.code, 'AUTH_SESSION_PROOF');
  const agent = await relay.mint(session, urls, { Authorization: `Bearer ${relay.store.mintAgentToken({ kind: 's', subject: 'conv-1' })}` });
  assert.equal(agent.status, 403);
  assert.equal(agent.body.code, 'AUTH_PERSON_REQUIRED');
  const owner = await relay.mint(session, urls, { Authorization: `Bearer ${OWNER_TOKEN}` });
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.body, { urls, expiresAt: null });
  assert.equal((await relay.mint(session, 'nope')).status, 400);
  assert.equal((await relay.mint(session, Array.from({ length: 201 }, () => urls[0]))).status, 400);
});

test('the explorer changes: the relay\'s own files, and folders holding them, are not created, renamed, moved or deleted by anyone', async (t) => {
  const relay = await startRelay(t);
  const session = await relay.signIn();
  const stateDir = path.dirname(relay.dataDir);
  const secrets = path.join(relay.dataDir, 'relay-secrets.json');
  // A plain file and folders inside the data folder, one holding a database copy.
  fs.writeFileSync(path.join(relay.dataDir, 'notes.txt'), 'notes');
  fs.mkdirSync(path.join(relay.dataDir, 'old', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(relay.dataDir, 'old', 'deeper', 'copy.db'), 'database copy');
  fs.mkdirSync(path.join(relay.dataDir, 'plain'));
  // In the workspace: a folder that is a link to the state folder.
  fs.symlinkSync(stateDir, path.join(relay.workspace, 'state'));
  const principals = {
    owner: { Authorization: `Bearer ${OWNER_TOKEN}` },
    agent: { Authorization: `Bearer ${relay.store.mintAgentToken({ kind: 's', subject: 'conv-1' })}` },
    browser: { Cookie: session.cookie, [PROOF]: session.proof },
  };
  const refused = [
    // rename: the file, onto a protected name (existing or not), the folders holding them
    ['/api/drives/rename', { path: secrets, newName: 'gone.json' }],
    ['/api/drives/rename', { path: relay.dbPath, newName: 'gone.db' }],
    ['/api/drives/rename', { path: relay.configPath, newName: 'gone.json' }],
    ['/api/drives/rename', { path: path.join(relay.dataDir, 'notes.txt'), newName: 'relay-secrets.json' }],
    ['/api/drives/rename', { path: path.join(relay.dataDir, 'notes.txt'), newName: 'oar.db-journal' }],
    ['/api/drives/rename', { path: relay.dataDir, newName: 'elsewhere' }],
    ['/api/drives/rename', { path: stateDir, newName: 'elsewhere' }],
    // delete: the files, a dry run too, and the folders holding them
    ['/api/drives/delete', { path: secrets }],
    ['/api/drives/delete', { path: `${relay.dbPath}-wal` }],
    ['/api/drives/delete', { path: relay.configPath }],
    ['/api/drives/delete', { path: relay.dataDir }],
    ['/api/drives/delete', { path: relay.dataDir, dryRun: true }],
    ['/api/drives/delete', { path: stateDir }],
    ['/api/drives/delete', { path: path.join(relay.dataDir, 'old') }],
    // new folder where a protected file belongs
    ['/api/drives/mkdir', { path: relay.dataDir, name: 'oar.db-shm' }],
    ['/api/drives/mkdir', { path: relay.dataDir, name: 'relay-previous.json' }],
    // the workspace routes: a hard link to the database, a link to the state folder
    ['/api/repo/delete', { path: 'innocent.bin' }],
    ['/api/repo/rename', { path: 'secrets-link.json', newName: 'other-name.json' }],
    ['/api/repo/delete', { path: 'state' }],
    ['/api/repo/rename', { path: 'state', newName: 'moved' }],
    ['/api/repo/mkdir', { path: 'state/data', name: 'copilot.db' }],
  ];
  for (const [who, headers] of Object.entries(principals)) {
    for (const [route, body] of refused) {
      const response = await relay.call(route, { method: 'POST', headers, body });
      const label = `${who} ${route} ${JSON.stringify(body)}`;
      assert.equal(response.status, 403, label);
      assert.equal(await codeOf(response), 'FILE_PROTECTED', label);
    }
  }
  for (const kept of [secrets, relay.dbPath, `${relay.dbPath}-wal`, relay.configPath, path.join(relay.dataDir, 'notes.txt'), path.join(relay.dataDir, 'old', 'deeper', 'copy.db'), path.join(relay.workspace, 'innocent.bin')]) {
    assert.ok(fs.existsSync(kept), kept);
  }
  for (const absent of ['oar.db-shm', 'relay-previous.json', 'oar.db-journal']) {
    assert.ok(!fs.existsSync(path.join(relay.dataDir, absent)), absent);
  }
  // Everything else still changes, for each of them.
  const allowed = [
    ['/api/drives/rename', { path: path.join(relay.dataDir, 'notes.txt'), newName: 'notes-2.txt' }],
    ['/api/drives/delete', { path: path.join(relay.dataDir, 'plain') }],
    ['/api/repo/mkdir', { name: 'made' }],
  ];
  for (const [route, body] of allowed) {
    const response = await relay.call(route, { method: 'POST', headers: principals.owner, body });
    assert.equal(response.status, 200, `${route} ${JSON.stringify(body)}`);
  }
  assert.equal((await relay.call('/api/repo/rename', { method: 'POST', headers: principals.agent, body: { path: 'made', newName: 'made-2' } })).status, 200);
  assert.equal((await relay.call('/api/repo/delete', { method: 'POST', headers: principals.browser, body: { path: 'made-2' } })).status, 200);
  assert.ok(!fs.existsSync(path.join(relay.dataDir, 'plain')));
});

test('a wrong k gets the same 403 AUTH_FILE_CAPABILITY whatever the path, before any link is resolved, any file looked at or any drive listed', async (t) => {
  const relay = await startRelay(t);
  const session = await relay.signIn();
  const second = await relay.signIn();
  const [good] = (await relay.mint(session, [driveUrl(path.join(relay.workspace, 'pic.png'))])).body.urls;
  const parsed = parseFileCapability(kOf(good));
  const exp = parsed.expSeconds.toString(36);
  // Made-up capabilities: never printed, only sent.
  const junk = {
    garbage: 'junk',
    wrongMac: `fc1.${session.id}.${exp}.${'A'.repeat(43)}`,
    otherFile: kOf(good),
    otherSession: `fc1.${second.id}.${exp}.${parsed.mac}`,
    expired: `fc1.${session.id}.${(Math.floor(relay.clock.now / 1000) - 60).toString(36)}.${parsed.mac}`,
    tooLong: `fc1.${session.id}.${(Math.floor(relay.clock.now / 1000) + 86400).toString(36)}.${parsed.mac}`,
  };
  const targets = [
    driveUrl(path.join(relay.dataDir, 'relay-secrets.json')),
    driveUrl(path.join(relay.workspace, 'notes.json')), // a hard link to the secrets
    driveUrl(path.join(relay.workspace, 'innocent.bin')), // a hard link to the database
    driveUrl(path.join(relay.workspace, 'missing.png')),
    driveUrl(relay.dataDir),
    `/api/drives/file?path=${encodeURIComponent('relative/x.png')}`,
    '/api/files/notes.json',
    '/api/files/secrets-link.json', // a link out of the workspace
    '/api/files/missing.png',
  ];
  for (const key of Object.keys(relay.spies)) relay.spies[key] = 0;
  let first = null;
  for (const [kind, k] of Object.entries(junk)) {
    for (const target of targets) {
      const response = await relay.call(withFileCapability(target, k), { headers: { Cookie: session.cookie, 'Sec-Fetch-Site': 'cross-site' } });
      const body = await response.json();
      const label = `${kind} on ${target}`;
      assert.equal(response.status, 403, label);
      assert.equal(body.code, 'AUTH_FILE_CAPABILITY', label);
      first ??= body;
      assert.deepEqual(body, first, `the same answer: ${label}`);
    }
  }
  assert.deepEqual(relay.spies, { isProtected: 0, realPath: 0, readMeta: 0, drives: 0 }, 'nothing looked at before the capability');
  // The right k still reads its file; its real path is looked at after the check.
  assert.equal((await relay.call(good, { headers: { Cookie: session.cookie } })).status, 200);
  assert.ok(relay.spies.isProtected >= 1 && relay.spies.readMeta >= 1);
});

test('Windows half: a wrong k is refused before the drive list; a right one lists the drives after its check', async (t) => {
  // filePlatform 'win32' runs the route's Windows half on any host.
  const relay = await startRelay(t, { filePlatform: 'win32', drives: [{ rootAbsolute: 'C:\\' }] });
  const session = await relay.signIn();
  const asked = driveUrl('C:\\Users\\dev\\pic.png');
  const [good] = (await relay.mint(session, [asked])).body.urls;
  assert.ok(good, 'a capability for a drive path');
  const parsed = parseFileCapability(kOf(good));
  const wrongMac = `fc1.${session.id}.${parsed.expSeconds.toString(36)}.${'A'.repeat(43)}`;
  for (const key of Object.keys(relay.spies)) relay.spies[key] = 0;
  for (const target of [driveUrl('C:\\Users\\dev\\pic.png'), driveUrl('Q:\\elsewhere\\x.png'), driveUrl('not a path')]) {
    for (const k of ['junk', wrongMac, kOf(good)]) {
      if (k === kOf(good) && target === asked) continue;
      const response = await relay.call(withFileCapability(target, k), { headers: { Cookie: session.cookie } });
      assert.equal(response.status, 403, target);
      assert.equal(await codeOf(response), 'AUTH_FILE_CAPABILITY', target);
    }
  }
  assert.deepEqual(relay.spies, { isProtected: 0, realPath: 0, readMeta: 0, drives: 0 });
  // The right one: checked, then the drive list, then the disk (no such file here).
  const response = await relay.call(good, { headers: { Cookie: session.cookie } });
  assert.equal(response.status, 404);
  assert.equal(relay.spies.drives, 1);
});

test('Windows half: one canonical path per file, whichever way the address writes it; UNC and relative paths get no capability', async (t) => {
  // filePlatform 'win32' runs the route's Windows half on any host.
  const relay = await startRelay(t, { filePlatform: 'win32', drives: [{ rootAbsolute: 'C:\\' }] });
  const session = await relay.signIn();
  const forms = ['C:\\Users\\dev\\pic.png', 'c:\\Users\\dev\\pic.png', 'C:/Users/dev/pic.png', 'C:\\Users\\\\dev\\.\\pic.png', 'C:\\Users\\dev\\x\\..\\pic.png'];
  const minted = await relay.mint(session, [...forms.map(driveUrl), driveUrl('\\\\server\\share\\pic.png'), driveUrl('Users\\dev\\pic.png'), driveUrl('C:')]);
  assert.equal(minted.status, 200);
  const urls = minted.body.urls;
  for (const [index, url] of urls.slice(0, forms.length).entries()) assert.ok(url, forms[index]);
  assert.equal(urls[forms.length], null, 'a UNC path');
  assert.equal(urls[forms.length + 1], null, 'a relative path');
  assert.ok(urls[forms.length + 2], 'a drive alone is its root');
  // Every form's k opens every other form of the same file (past the check,
  // the drive list and on to the disk: no such file here), and no other file.
  for (const url of urls.slice(0, forms.length)) {
    for (const form of forms) {
      const response = await relay.call(withFileCapability(driveUrl(form), kOf(url)), { headers: { Cookie: session.cookie } });
      assert.equal(response.status, 404, `${form} with the k of ${url}`);
    }
    for (const other of ['C:\\Users\\dev\\other.png', 'C:\\Users\\dev', 'D:\\Users\\dev\\pic.png', '\\\\server\\share\\pic.png']) {
      const response = await relay.call(withFileCapability(driveUrl(other), kOf(url)), { headers: { Cookie: session.cookie } });
      assert.equal(response.status, 403, other);
      assert.equal(await codeOf(response), 'AUTH_FILE_CAPABILITY', other);
    }
  }
  // `C:` and `C:\\` are one path (a folder: past the check, then refused as no file).
  const root = await relay.call(withFileCapability(driveUrl('C:\\'), kOf(urls[forms.length + 2])), { headers: { Cookie: session.cookie } });
  assert.notEqual(root.status, 403);
});

test('Windows half: a drive rename that succeeds answers 200, its JSON from the route itself', { skip: HOST_PLATFORM === 'win32' && 'on Windows the explorer-changes test above renames a real drive file' }, async (t) => {
  // filePlatform 'win32' runs the route's Windows half here. On this host a
  // drive path is one file name in the folder the process runs in, so the
  // test runs in a scratch folder of its own.
  const relay = await startRelay(t, { filePlatform: 'win32', drives: [{ rootAbsolute: 'C:\\' }] });
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oar-file-cap-cwd-')));
  const before = process.cwd();
  process.chdir(scratch);
  t.after(() => {
    process.chdir(before);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  fs.writeFileSync('C:\\Users\\dev\\notes.txt', 'notes');
  const response = await relay.call('/api/drives/rename', { method: 'POST', headers: { Authorization: `Bearer ${OWNER_TOKEN}` }, body: { path: 'C:\\Users\\dev\\notes.txt', newName: 'notes-2.txt' } });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.ok(fs.existsSync(path.join(scratch, 'notes-2.txt')));
});
