import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';

import crypto from 'node:crypto';

import { applySchema } from '../db-schema.mjs';
import { registerMediaRoutes } from './media-routes.mjs';
import { createMediaRepository } from '../repositories/media-repository.mjs';
import { createProtectedRelayFiles } from '../services/relay-protected-files.mjs';
import { createMediaTags, deriveMediaTagKey } from '../services/media-tag.mjs';
import { createAuthFailureLockout, createRelayAuth } from '../services/relay-auth.mjs';
import { createBrowserSessionService, createSignInCodes } from '../services/browser-session-service.mjs';
import { createLocalRequestCheck } from '../services/request-boundary.mjs';
import { migrateBrowserSessions } from '../migrations/0041-browser-sessions.mjs';

// Real files on disk under a temp folder, so the paths have the host's shape.
const hostPlatform = process.platform; // host-platform: served files are real files of this machine
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SHA = 'c'.repeat(64);

function isoAt(minute) {
  return new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString();
}

async function startRelay(t, { authorized = true, isProtectedFile, auth = null, mount = null, spies = null } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'media-routes-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'uploads'));
  const file = (name, bytes = PNG) => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, bytes);
    return target;
  };
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  const app = express();
  mount?.(app);
  // `spies` counts every look-up and file call the routes make.
  const count = (name, fn) => (...args) => {
    if (spies) spies[name] = (spies[name] || 0) + 1;
    return fn(...args);
  };
  const repository = createMediaRepository(db);
  const routes = registerMediaRoutes(app, {
    auth: auth || ((_req, res, next) => (authorized ? next() : res.status(401).json({ error: 'Unauthorized' }))),
    db,
    uploadPathForSha: count('uploadPathForSha', (sha) => path.join(dir, 'uploads', sha)),
    platform: hostPlatform,
    startIndexer: false,
    repository: { ...repository, getMediaItem: count('getMediaItem', (id) => repository.getMediaItem(id)) },
    isProtectedFile: count('isProtectedFile', (filePath) => (isProtectedFile ? isProtectedFile(dir, filePath) : false)),
    resolveGeneratedImagePath: count('resolveGeneratedImagePath', () => null),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (url, init) => fetch(`${base}${url}`, init);
  const json = async (url) => {
    const response = await get(url);
    return { status: response.status, body: await response.json() };
  };
  const addConversation = (id, { title = 'Fixture session', archived = 0, status = 'active' } = {}) => {
    db.prepare(`INSERT INTO conversations (id, title, archived, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, title, archived, status, isoAt(0), isoAt(0));
  };
  const addMessage = (id, conv, { role = 'assistant', text = '', attachments = null, minute = 1, kind = null } = {}) => {
    db.prepare(`INSERT INTO messages (id, conversation_id, role, text, attachments, timestamp, kind) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, conv, role, text, attachments ? JSON.stringify(attachments) : null, isoAt(minute), kind);
  };
  const md = (target) => `![shot](${target.replace(/\\/g, '/')})`;
  // The route's address for an id, with its tag (what the listing hands out).
  const contentUrl = (id) => routes.mediaTags.contentUrlFor(id);
  return { db, dir, file, get, json, addConversation, addMessage, md, routes, contentUrl };
}

test('a session gallery lists each picture once at its newest message, newest first', async (t) => {
  const relay = await startRelay(t);
  const a = relay.file('a.png');
  const b = relay.file('b.png');
  relay.addConversation('c1');
  relay.addMessage('m1', 'c1', { text: `${relay.md(a)} ${relay.md(b)}`, minute: 1 });
  relay.addMessage('m2', 'c1', { text: `again ${relay.md(a)}`, minute: 2 });
  relay.addMessage('m3', 'c1', { role: 'user', minute: 3, attachments: [{ name: 'u.png', type: 'image/png', size: PNG.length, sha256: SHA }] });
  fs.writeFileSync(path.join(relay.dir, 'uploads', SHA), PNG);

  const { status, body } = await relay.json('/api/media?conversationId=c1');
  assert.equal(status, 200);
  assert.deepEqual(body.items.map((item) => [item.messageId, item.name, item.occurrences, item.sender, item.origin]), [
    ['m3', 'u.png', 1, 'me', 'upload'],
    ['m2', 'a.png', 2, 'agent', 'embedded'],
    ['m1', 'b.png', 1, 'agent', 'embedded'],
  ]);
  assert.equal(body.items[0].contentUrl, `/api/upload/${SHA}/content`);
  assert.match(body.items[1].contentUrl, /^\/api\/media\/\d+\/content\?t=[A-Za-z0-9_-]{22}$/);
  assert.equal(body.items[1].path, path.resolve(a));
  assert.equal(body.nextCursor, null);
  assert.deepEqual(body.indexing, { pending: 0 });
});

test('pages follow a cursor without repeating older copies; a bad cursor is refused', async (t) => {
  const relay = await startRelay(t);
  relay.addConversation('c1');
  const files = ['p0', 'p1', 'p2', 'p3', 'p4'].map((name) => relay.file(`${name}.png`));
  files.forEach((file, index) => relay.addMessage(`m${index}`, 'c1', { text: relay.md(file), minute: index + 1 }));
  relay.addMessage('m9', 'c1', { text: relay.md(files[4]), minute: 20 }); // p4 again, newest
  const seen = [];
  let cursor = '';
  for (let round = 0; round < 5; round += 1) {
    const { body } = await relay.json(`/api/media?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
    seen.push(...body.items.map((item) => item.name));
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  assert.deepEqual(seen, ['p4.png', 'p3.png', 'p2.png', 'p1.png', 'p0.png']);
  assert.equal((await relay.json('/api/media?cursor=nonsense')).status, 400);
});

test('missing files are left out and counted; remote and data images stay', async (t) => {
  const relay = await startRelay(t);
  relay.addConversation('c1');
  const kept = relay.file('kept.png');
  const gone = relay.file('gone.png');
  const dataUri = `data:image/png;base64,${PNG.toString('base64')}`;
  relay.addMessage('m1', 'c1', { text: `${relay.md(kept)} ${relay.md(gone)} ![r](https://images.example.test/r.jpg) ![d](${dataUri})` });
  fs.rmSync(gone);
  const { body } = await relay.json('/api/media');
  assert.deepEqual(body.items.map((item) => item.name).sort(), ['image.png', 'kept.png', 'r.jpg']);
  assert.equal(body.missingHidden, 1);
  const remote = body.items.find((item) => item.name === 'r.jpg');
  assert.equal(remote.remoteUrl, 'https://images.example.test/r.jpg');
  assert.equal(remote.contentUrl, null);
});

test('filters: source, archived, search, deleted sessions; Files is its own category', async (t) => {
  const relay = await startRelay(t);
  relay.addConversation('live', { title: 'Garden planning' });
  relay.addConversation('old', { title: 'Old ideas', archived: 1 });
  relay.addConversation('dead', { title: 'Removed', status: 'deleted' });
  const a = relay.file('agent.png');
  const m = relay.file('mine.png');
  const e = relay.file('event.png');
  const o = relay.file('old 100%_x.png');
  relay.addMessage('m1', 'live', { text: relay.md(a) });
  relay.addMessage('m2', 'live', { role: 'user', text: relay.md(m) });
  relay.addMessage('m3', 'live', { role: 'user', kind: 'relay_event', text: relay.md(e) });
  relay.addMessage('m4', 'old', { text: `![x](<${o.replace(/\\/g, '/')}>)` });
  relay.addMessage('m5', 'dead', { text: relay.md(a) });
  relay.addMessage('m6', 'live', { role: 'user', attachments: [{ name: 'notes.pdf', type: 'application/pdf', size: 3, sha256: 'd'.repeat(64) }] });
  fs.writeFileSync(path.join(relay.dir, 'uploads', 'd'.repeat(64)), 'pdf');
  const names = async (query) => (await relay.json(`/api/media?${query}`)).body.items.map((item) => item.name).sort();

  assert.deepEqual(await names(''), ['agent.png', 'event.png', 'mine.png', 'old 100%_x.png']);
  assert.deepEqual(await names('source=mine'), ['mine.png']);
  assert.deepEqual(await names('source=agent'), ['agent.png', 'event.png', 'old 100%_x.png']);
  assert.deepEqual(await names('source=generated'), []);
  assert.deepEqual(await names('archived=hide'), ['agent.png', 'event.png', 'mine.png']);
  assert.deepEqual(await names('q=garden'), ['agent.png', 'event.png', 'mine.png']);
  assert.deepEqual(await names('q=100%25_'), ['old 100%_x.png'], 'wildcards in the search are literal');
  assert.deepEqual(await names('q=%25%25'), [], 'a literal %% does not match everything');
  assert.deepEqual(await names('category=file'), ['notes.pdf']);
  const counts = (await relay.json('/api/media/counts?conversationId=live')).body;
  assert.deepEqual(counts, { media: 3, file: 1, pending: 0 });
  const facets = (await relay.json('/api/media/facets')).body;
  assert.deepEqual(facets.sessions.map((row) => [row.id, row.archived]).sort(), [['live', false], ['old', true]]);
  assert.deepEqual(facets.providers, ['github']);
});

test('a deleted session: its pictures are not listed, counted or offered as a filter', async (t) => {
  const relay = await startRelay(t);
  relay.addConversation('kept', { title: 'Kept session' });
  relay.addConversation('gone', { title: 'Deleted session' });
  relay.addMessage('k1', 'kept', { text: relay.md(relay.file('kept.png')) });
  relay.addMessage('g1', 'gone', { text: relay.md(relay.file('gone-only.png')) });
  assert.equal((await relay.json('/api/media')).body.items.length, 2);
  // The tombstone a delete writes first; the rows go with the hard delete.
  relay.db.prepare(`UPDATE conversations SET status = 'deleted' WHERE id = 'gone'`).run();
  assert.deepEqual((await relay.json('/api/media')).body.items.map((item) => item.name), ['kept.png']);
  assert.deepEqual((await relay.json('/api/media/counts')).body, { media: 1, file: 0, pending: 0 });
  assert.deepEqual((await relay.json('/api/media/facets')).body.sessions.map((row) => row.id), ['kept']);
  assert.deepEqual((await relay.json('/api/media?conversationId=gone')).body.items, []);
  relay.db.prepare(`DELETE FROM conversations WHERE id = 'gone'`).run();
  assert.equal(relay.db.prepare(`SELECT COUNT(*) AS n FROM media_items WHERE conversation_id = 'gone'`).get().n, 0);
});

test('content: local files revalidate with a 304; uploads stay content-addressed; ranges work', async (t) => {
  const relay = await startRelay(t);
  relay.addConversation('c1');
  const a = relay.file('clip.png', Buffer.concat([PNG, Buffer.alloc(100, 1)]));
  relay.addMessage('m1', 'c1', { text: relay.md(a) });
  const [item] = (await relay.json('/api/media')).body.items;
  const first = await relay.get(item.contentUrl);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  assert.equal(first.headers.get('content-type'), 'image/png');
  assert.equal(first.headers.get('x-content-type-options'), 'nosniff');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  assert.equal(Buffer.from(await first.arrayBuffer()).length, PNG.length + 100);
  const again = await relay.get(item.contentUrl, { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  const part = await relay.get(item.contentUrl, { headers: { Range: 'bytes=0-3' } });
  assert.equal(part.status, 206);
  assert.equal(Buffer.from(await part.arrayBuffer()).toString('latin1'), PNG.subarray(0, 4).toString('latin1'));
});

test('content: data images are decoded, checked and cached by identity', async (t) => {
  const relay = await startRelay(t);
  relay.addConversation('c1');
  relay.addMessage('m1', 'c1', { text: `![d](data:image/png;base64,${PNG.toString('base64')})` });
  relay.addMessage('m2', 'c1', { text: `![fake](data:image/png;base64,${Buffer.from('not a png at all').toString('base64')})` });
  const items = (await relay.json('/api/media')).body.items;
  const good = items.find((item) => item.messageId === 'm1');
  assert.equal(items.find((item) => item.messageId === 'm2'), undefined, 'bytes that are not the declared type are not indexed');
  const response = await relay.get(good.contentUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  // The message changed before the index caught up: the old id serves nothing else.
  relay.db.exec(`DROP TRIGGER media_index_on_update`);
  relay.db.prepare(`UPDATE messages SET text = 'gone' WHERE id = 'm1'`).run();
  assert.equal((await relay.get(good.contentUrl)).status, 404);
});

test('content: ids only, never a path from the request; stored paths are re-checked', async (t) => {
  const relay = await startRelay(t);
  relay.addConversation('c1');
  relay.addMessage('m1', 'c1', { text: 'none' });
  for (const url of ['/api/media/abc/content', '/api/media/1.5/content', '/api/media/-1/content', `/api/media/${'9'.repeat(20)}/content`]) {
    assert.equal((await relay.get(url)).status, 400, url);
  }
  assert.equal((await relay.get(relay.contentUrl(424242))).status, 404);
  const insert = relay.db.prepare(`INSERT INTO media_items (message_id, conversation_id, ordinal, role, sender, origin, locator_kind, locator,
    identity_key, category, media_kind, mime, name, message_ts) VALUES ('m1', 'c1', ?, 'assistant', 'agent', 'embedded', ?, ?, ?, 'media', 'image', 'image/png', 'x.png', ?)`);
  const real = relay.file('real.png');
  const sneaky = [
    `${relay.dir}${path.sep}..${path.sep}${path.basename(relay.dir)}${path.sep}real.png`,
    `${real}\0.png`,
    'relative/real.png',
    '/proc/self/environ',
    '\\\\server\\share\\real.png',
  ];
  sneaky.forEach((locator, index) => insert.run(10 + index, 'local_path', locator, `path:${index}`, isoAt(1)));
  insert.run(20, 'remote_url', 'https://images.example.test/r.png', 'url:r', isoAt(1));
  insert.run(21, 'upload_sha', '../../etc/passwd', 'sha:x', isoAt(1));
  const ids = relay.db.prepare(`SELECT id FROM media_items ORDER BY ordinal`).all().map((row) => row.id);
  for (const id of ids) {
    assert.equal((await relay.get(relay.contentUrl(id))).status, 404, `item ${id}`);
  }
});

test('Windows: a stored path on a drive the relay does not list is hidden and not served', { skip: process.platform !== 'win32' }, async (t) => {
  const relay = await startRelay(t);
  relay.addConversation('c1');
  relay.addMessage('m1', 'c1', { text: relay.md(relay.file('a.png')) });
  const app = express();
  let listings = 0;
  const windowsRoutes = registerMediaRoutes(app, {
    auth: (_req, _res, next) => next(),
    db: relay.db,
    uploadPathForSha: () => '',
    platform: 'win32',
    startIndexer: false,
    fetchBrowsableDrives: (callback) => {
      listings += 1;
      callback(null, [{ rootAbsolute: 'Q:\\' }]);
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = await (await fetch(`${base}/api/media`)).json();
  assert.deepEqual(body.items, []);
  assert.equal(body.missingHidden, 1);
  const id = relay.db.prepare(`SELECT id FROM media_items`).get().id;
  assert.equal((await fetch(`${base}${windowsRoutes.mediaTags.contentUrlFor(id)}`)).status, 404);
  assert.equal(listings, 1, 'the drive list is cached');
});

test('content: a local picture must be what its name says; a local file of another kind is not served here', async (t) => {
  const relay = await startRelay(t);
  relay.addConversation('c1');
  const fake = relay.file('fake.png', Buffer.from('#!/bin/sh\necho not a picture\n'));
  const exe = relay.file('movie.mp4', Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]));
  const svg = relay.file('logo.svg', Buffer.from('﻿  <svg xmlns="http://www.w3.org/2000/svg"></svg>'));
  const doc = relay.file('notes.txt', Buffer.from('plain notes'));
  relay.addMessage('m1', 'c1', { text: `${relay.md(fake)} ${relay.md(exe)} ${relay.md(svg)}` });
  relay.addMessage('m2', 'c1', { role: 'user', attachments: [{ name: 'notes.txt', type: 'text/plain', path: doc, source: 'reference' }] });
  const listed = (await relay.json('/api/media')).body;
  const byName = Object.fromEntries(listed.items.map((item) => [item.name, item]));
  // Tiles that could not be served are not listed: counted as not shown.
  assert.deepEqual(Object.keys(byName), ['logo.svg']);
  assert.equal(listed.missingHidden, 2);
  const idOf = (name) => relay.db.prepare(`SELECT id FROM media_items WHERE name = ?`).get(name).id;
  assert.equal((await relay.get(relay.contentUrl(idOf('fake.png')))).status, 404);
  assert.equal((await relay.get(relay.contentUrl(idOf('movie.mp4')))).status, 404);
  const logo = await relay.get(byName['logo.svg'].contentUrl);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/svg+xml');
  assert.equal(logo.headers.get('x-content-type-options'), 'nosniff');
  assert.match(logo.headers.get('content-security-policy') || '', /sandbox/);
  // An attached text file by path: not listed, not served (it opens by path, with a file capability).
  const files = (await relay.json('/api/media?category=file')).body;
  assert.deepEqual(files.items, []);
  assert.equal(files.missingHidden, 1);
  assert.equal((await relay.get(relay.contentUrl(idOf('notes.txt')))).status, 404);
});

test('content: a link is followed only to a target that passes the same checks', { skip: process.platform === 'win32' }, async (t) => {
  const relay = await startRelay(t);
  relay.addConversation('c1');
  const real = relay.file('real.png');
  fs.symlinkSync(real, path.join(relay.dir, 'link.png'));
  fs.symlinkSync('/proc/self/environ', path.join(relay.dir, 'env.png'));
  relay.addMessage('m1', 'c1', { text: `${relay.md(path.join(relay.dir, 'link.png'))} ${relay.md(path.join(relay.dir, 'env.png'))}` });
  const items = (await relay.json('/api/media')).body.items;
  const byName = Object.fromEntries(items.map((item) => [item.name, item]));
  assert.equal((await relay.get(byName['link.png'].contentUrl)).status, 200);
  const env = relay.db.prepare(`SELECT id FROM media_items WHERE name = 'env.png'`).get();
  assert.equal((await relay.get(relay.contentUrl(env.id))).status, 404);
});

test('content: the relay\'s own secrets and database are never served, even when a message names them', async (t) => {
  // The relay's data folder sits in the temp folder; its secrets file and
  // database are named by an attached-file reference and by a picture link.
  const relay = await startRelay(t, {
    isProtectedFile: (dir, filePath) => createProtectedRelayFiles({
      dataDir: path.join(dir, 'data'),
      configPath: path.join(dir, 'config.json'),
      files: () => [path.join(dir, 'data', 'oar.db')],
    }).isProtected(filePath),
  });
  fs.mkdirSync(path.join(relay.dir, 'data'));
  const secrets = relay.file(path.join('data', 'relay-secrets.json'), Buffer.from('{"fixture":true}'));
  const database = relay.file(path.join('data', 'oar.db'), PNG);
  const notes = relay.file('notes.txt', Buffer.from('plain notes'));
  relay.addConversation('c1');
  relay.addMessage('m1', 'c1', {
    role: 'user',
    attachments: [
      { name: 'relay-secrets.json', type: 'application/json', path: secrets, source: 'reference' },
      { name: 'notes.txt', type: 'text/plain', path: notes, source: 'reference' },
    ],
  });
  // A picture link to the database (whose bytes here look like a picture):
  // refused for being the database, not for its bytes.
  const viaLink = process.platform !== 'win32'; // host-platform: symlinks need no privilege off Windows
  if (viaLink) {
    fs.symlinkSync(database, path.join(relay.dir, 'db.png'));
    relay.addMessage('m2', 'c1', { text: relay.md(path.join(relay.dir, 'db.png')) });
  }
  // Attached files by path are not served here at all (a picture or a video only).
  const files = (await relay.json('/api/media?category=file')).body;
  assert.deepEqual(files.items, []);
  assert.equal(files.missingHidden, 2);
  const idOf = (name) => relay.db.prepare(`SELECT id FROM media_items WHERE name = ?`).get(name).id;
  if (viaLink) assert.deepEqual((await relay.json('/api/media')).body.items, []);
  if (viaLink) {
    const response = await relay.get(relay.contentUrl(idOf('db.png')));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'FILE_PROTECTED');
  }
  for (const name of ['relay-secrets.json', 'notes.txt']) {
    assert.equal((await relay.get(relay.contentUrl(idOf(name)))).status, 404, name);
  }
});

test('content: an id opens nothing without its tag, whoever asks; nothing is looked up before the tag is checked', async (t) => {
  // Real relay-auth and browser sessions: GET /api/media/:id/content goes on
  // the cookie alone (no proof key), so the tag is all that stands between
  // a replayed cookie and every id. Every credential is made here and never printed.
  const ownerToken = crypto.randomUUID();
  const sessionsDb = new Database(':memory:');
  migrateBrowserSessions(sessionsDb);
  const sessions = createBrowserSessionService({ db: sessionsDb, logger: { log() {}, warn() {} } });
  const relayAuth = createRelayAuth({
    app: null,
    verifyOwnerToken: (value) => value === ownerToken,
    browserSessions: sessions,
    signInCodes: createSignInCodes(),
    cookieName: 'copilot_auth',
    parseCookies: () => ({}),
    appendSetCookie: (res, value) => {
      const existing = res.getHeader('Set-Cookie');
      res.setHeader('Set-Cookie', existing ? [].concat(existing, value) : value);
    },
    localRequestCheck: createLocalRequestCheck(),
    lockout: createAuthFailureLockout(),
    logger: { log() {}, warn() {} },
  });
  const spies = {};
  const relay = await startRelay(t, {
    auth: relayAuth.auth,
    spies,
    mount: (app) => {
      app.use(express.json());
      app.post('/api/auth/session', relayAuth.signIn);
    },
  });
  relay.addConversation('c1');
  const names = ['n1.png', 'n2.png', 'n3.png', 'n4.png'];
  relay.addMessage('m1', 'c1', { text: names.map((name) => relay.md(relay.file(name))).join(' ') });
  const signIn = await relay.get('/api/auth/session', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ deviceId: crypto.randomUUID() }),
  });
  assert.equal(signIn.status, 200);
  const cookie = (signIn.headers.getSetCookie().find((line) => line.startsWith('copilot_auth=')) || '').split(';')[0];
  const { proof } = await signIn.json();
  const asCookie = { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } };
  const asPage = { headers: { Cookie: cookie, 'X-OAR-Session-Proof': proof, 'Sec-Fetch-Site': 'same-origin' } };
  const asOwner = { headers: { Authorization: `Bearer ${ownerToken}` } };

  const listed = await relay.get('/api/media', asPage);
  assert.equal(listed.status, 200);
  const items = (await listed.json()).items;
  assert.equal(items.length, names.length);
  const ids = relay.db.prepare(`SELECT id FROM media_items ORDER BY id`).all().map((row) => row.id);
  for (const item of items) assert.ok(item.contentUrl === relay.contentUrl(item.id), 'every address carries its tag');
  const tagOf = (id) => new URL(relay.contentUrl(id), 'http://relay.invalid').searchParams.get('t');

  // Sequential ids with the cookie alone, without a tag or with a wrong one:
  // 404, as for an id that does not exist; the owner token and the page too.
  for (const key of Object.keys(spies)) delete spies[key];
  const last = Math.max(...ids);
  const wrong = 'A'.repeat(22);
  for (let id = 1; id <= last + 2; id += 1) {
    for (const suffix of ['', '?t=', `?t=${wrong}`, `?t=${tagOf(id).slice(0, 21)}`, `?t=${tagOf(id)}x`]) {
      for (const as of [asCookie, asPage, asOwner]) {
        assert.equal((await relay.get(`/api/media/${id}/content${suffix}`, as)).status, 404, `${id}${suffix ? ' with a bad tag' : ' without a tag'}`);
      }
    }
    // The tag of id n opens neither n + 1 nor n - 1.
    for (const other of [id - 1, id + 1]) {
      if (other < 1) continue;
      assert.equal((await relay.get(`/api/media/${other}/content?t=${tagOf(id)}`, asCookie)).status, 404, `tag of ${id} on ${other}`);
    }
  }
  assert.deepEqual(spies, {}, 'no look-up and no file call before the tag is checked');

  // With its tag, each one opens on the cookie alone.
  for (const id of ids) {
    const response = await relay.get(relay.contentUrl(id), asCookie);
    assert.equal(response.status, 200, `id ${id}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  }
  assert.equal(spies.getMediaItem, ids.length);
  // The tag is stable (the browser may keep the picture) and its own:
  // another key (an agentKey rotated) makes other tags.
  assert.equal(relay.contentUrl(ids[0]), relay.contentUrl(ids[0]));
  const rotated = createMediaTags({ getKey: () => deriveMediaTagKey(crypto.randomBytes(32)) });
  assert.notEqual(rotated.contentUrlFor(ids[0]), relay.contentUrl(ids[0]));
  assert.equal((await relay.get(rotated.contentUrlFor(ids[0]), asCookie)).status, 404);
});

test('content of a deleted session is gone; every route needs the relay login', async (t) => {
  const relay = await startRelay(t);
  relay.addConversation('c1');
  relay.addMessage('m1', 'c1', { text: relay.md(relay.file('a.png')) });
  const [item] = (await relay.json('/api/media')).body.items;
  relay.db.prepare(`UPDATE conversations SET status = 'deleted' WHERE id = 'c1'`).run();
  assert.equal((await relay.get(item.contentUrl)).status, 404);

  const locked = await startRelay(t, { authorized: false });
  for (const url of ['/api/media', '/api/media/counts', '/api/media/facets', '/api/media/1/content']) {
    assert.equal((await locked.get(url)).status, 401, url);
  }
});
