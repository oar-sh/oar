import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createShareRepository } from '../repositories/share-repository.mjs';
import {
  SHARE_OPEN_IDLE_MS,
  SHARE_OPEN_RELOAD_DEDUPE_MS,
  createShareAccessLog,
  normalizeViewerIp,
  readShareRequestViewer,
} from './share-access-log-service.mjs';

const VIEWER = { ip: '203.0.113.10', userAgent: 'FixtureBrowser/1.0', country: '' };

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-a', 'Report builder', '2026-10-01', '2026-10-01')`).run();
  const repository = createShareRepository(db);
  const { share } = repository.getOrCreateShare('conv-a', () => 'c'.repeat(64), '2026-10-01T09:00:00.000Z');
  let clock = Date.parse('2026-10-16T10:00:00.000Z');
  const now = () => clock;
  const advance = (ms) => { clock += ms; };
  const log = createShareAccessLog({ repository, now });
  const count = () => db.prepare(`SELECT COUNT(*) AS n FROM conversation_share_opens`).get().n;
  return { db, repository, share, log, advance, count, now };
}

test('polls keep a reader counted once; a long pause starts a new open', () => {
  const fx = setup();
  assert.equal(fx.log.noteFetch({ share: fx.share, viewer: VIEWER, opened: true }).recorded, true);
  // Twenty minutes of 900 ms polls.
  for (let elapsed = 0; elapsed < 20 * 60_000; elapsed += 900) {
    fx.advance(900);
    assert.equal(fx.log.noteFetch({ share: fx.share, viewer: VIEWER }).opened, false);
  }
  assert.equal(fx.count(), 1);
  // The tab slept in the background; its first poll after the pause is an open.
  fx.advance(SHARE_OPEN_IDLE_MS + 1);
  assert.equal(fx.log.noteFetch({ share: fx.share, viewer: VIEWER }).recorded, true);
  assert.equal(fx.count(), 2);
});

test('a reload counts as a new open, unless it comes within the dedupe window', () => {
  const fx = setup();
  fx.log.noteFetch({ share: fx.share, viewer: VIEWER, opened: true });
  fx.advance(SHARE_OPEN_RELOAD_DEDUPE_MS - 1);
  assert.equal(fx.log.noteFetch({ share: fx.share, viewer: VIEWER, opened: true }).opened, false);
  fx.advance(SHARE_OPEN_RELOAD_DEDUPE_MS + 1);
  assert.equal(fx.log.noteFetch({ share: fx.share, viewer: VIEWER, opened: true }).opened, true);
  assert.equal(fx.count(), 2);
});

test('a client that never sends the flag is still logged once', () => {
  const fx = setup();
  assert.equal(fx.log.noteFetch({ share: fx.share, viewer: VIEWER }).recorded, true);
  fx.advance(900);
  assert.equal(fx.log.noteFetch({ share: fx.share, viewer: VIEWER }).recorded, false);
  assert.equal(fx.count(), 1);
});

test('after a restart the last logged open stands in for the polls it missed', () => {
  const fx = setup();
  fx.log.noteFetch({ share: fx.share, viewer: VIEWER, opened: true });
  fx.advance(5 * 60_000);
  // A fresh service: nothing in memory.
  const restarted = createShareAccessLog({ repository: fx.repository, now: fx.now });
  assert.equal(restarted.noteFetch({ share: fx.share, viewer: VIEWER }).opened, false);
  assert.equal(fx.count(), 1);
});

test('the viewer key is keyed, stable, and tells browsers and addresses apart', () => {
  const fx = setup();
  const key = fx.log.viewerKeyFor(VIEWER.ip, VIEWER.userAgent);
  assert.match(key, /^[a-f0-9]{32}$/);
  assert.equal(fx.log.viewerKeyFor(VIEWER.ip, VIEWER.userAgent), key);
  assert.notEqual(fx.log.viewerKeyFor(VIEWER.ip, 'OtherBrowser/2.0'), key);
  assert.notEqual(fx.log.viewerKeyFor('192.0.2.44', VIEWER.userAgent), key);
  // The key depends on the relay's secret, not on the address alone.
  const otherDb = setup();
  assert.notEqual(otherDb.log.viewerKeyFor(VIEWER.ip, VIEWER.userAgent), key);
});

test('storeIp false keeps the address out of the row', () => {
  const fx = setup();
  fx.log.noteFetch({ share: fx.share, viewer: { ...VIEWER, country: 'DE' }, opened: true, storeIp: false });
  const row = fx.db.prepare(`SELECT ip, country, user_agent FROM conversation_share_opens`).get();
  assert.deepEqual({ ...row }, { ip: null, country: 'DE', user_agent: VIEWER.userAgent });
});

test('a request viewer: trusted address, cleaned user agent, country only through a trusted peer', () => {
  const trustLoopback = { get: (name) => (name === 'trust proxy fn' ? (address) => address === '127.0.0.1' : undefined) };
  const viaProxy = readShareRequestViewer({
    ip: '::ffff:203.0.113.7',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'user-agent': `Fixture\nBrowser ${'x'.repeat(600)}`, 'cf-ipcountry': 'nl' },
    app: trustLoopback,
  });
  assert.equal(viaProxy.ip, '203.0.113.7');
  assert.equal(viaProxy.country, 'NL');
  assert.equal(viaProxy.userAgent.length, 512);
  assert.ok(!viaProxy.userAgent.includes('\n'));
  const direct = readShareRequestViewer({
    ip: '198.51.100.3',
    socket: { remoteAddress: '198.51.100.3' },
    headers: { 'cf-ipcountry': 'NL' },
    app: trustLoopback,
  });
  assert.equal(direct.country, '');
  assert.equal(direct.userAgent, '');
  assert.equal(normalizeViewerIp('2001:db8::1'), '2001:db8::1');
});
