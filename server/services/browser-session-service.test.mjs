import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  BROWSER_SESSION_ABSOLUTE_MS,
  BROWSER_SESSION_AUTH_METHODS,
  BROWSER_SESSION_IDLE_MS,
  BROWSER_SESSION_TOUCH_INTERVAL_MS,
  SIGNIN_CODE_TTL_MS,
  createBrowserSessionService,
  createSignInCodes,
  labelFromUserAgent,
} from './browser-session-service.mjs';
import { migrateBrowserSessions } from '../migrations/0041-browser-sessions.mjs';
import { hashOwnerToken } from '../../shared/relay-credentials.mjs';

// Yes/no on values that hold a credential: a failure never prints it.
const matchSecret = (value, pattern, message) => assert.ok(pattern.test(String(value)), message || `expected ${pattern}`);

// Browser sessions (agent auth §10, tests 14 and 15). Secrets are made at run
// time and never printed.

const DAY = 24 * 60 * 60 * 1000;
const quiet = { log() {}, warn() {} };
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

function makeDb() {
  const db = new Database(':memory:');
  migrateBrowserSessions(db);
  return db;
}

function makeService({ clock = { now: Date.parse('2026-11-01T00:00:00.000Z') }, db = makeDb(), ...options } = {}) {
  const service = createBrowserSessionService({ db, now: () => clock.now, logger: quiet, ...options });
  return { service, clock, db };
}

test('create: an oars1_ secret, only its hash stored; the row resolves from memory', () => {
  const { service, db } = makeService();
  const { secret, row } = service.create({ authMethod: 'token', userAgent: PHONE_UA, deviceId: 'dev-1', ip: '::ffff:192.0.2.4' });
  matchSecret(secret, /^oars1_[A-Za-z0-9_-]{43}$/);
  assert.match(row.id, /^bs_[A-Za-z0-9_-]{12}$/);
  assert.equal(row.label, 'Chrome on Android');
  const stored = db.prepare('SELECT * FROM browser_sessions').get();
  assert.equal(stored.secret_hash, hashOwnerToken(secret));
  assert.ok(!JSON.stringify(stored).includes(secret), 'the secret is not in the table');
  assert.equal(stored.auth_method, 'token');
  assert.equal(service.resolve(secret).id, row.id);
  assert.equal(service.resolve(`${secret.slice(0, -1)}${secret.at(-1) === 'A' ? 'B' : 'A'}`), null);
  assert.equal(service.resolve('not-a-session'), null);
  // A new service (a restart) loads the rows into its map.
  const again = createBrowserSessionService({ db, logger: quiet });
  assert.equal(again.resolve(secret).id, row.id);
});

test('expiry: idle past 30 days is gone (the row too); the absolute 400 days cannot be slid past', () => {
  const { service, clock, db } = makeService();
  const { secret, row } = service.create({ authMethod: 'token' });
  assert.equal(service.cookieMaxAgeSeconds(row), BROWSER_SESSION_IDLE_MS / 1000);
  clock.now += BROWSER_SESSION_IDLE_MS - 1000;
  assert.ok(service.resolve(secret), 'still valid just before 30 days idle');
  clock.now += 2000;
  assert.deepEqual(service.lookup(secret), { row: null, expired: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM browser_sessions').get().n, 0, 'the expired row went');

  // Used every 20 days, it still ends 400 days after it was made.
  const daily = makeService();
  const made = daily.service.create({ authMethod: 'token' });
  let current = made.row;
  for (let day = 20; day < 400; day += 20) {
    daily.clock.now += 20 * DAY;
    current = daily.service.resolve(made.secret);
    assert.ok(current, `alive on day ${day}`);
    current = daily.service.touch(current).row;
  }
  assert.ok(daily.service.cookieMaxAgeSeconds(current) <= 20 * DAY / 1000, 'Max-Age stops at the absolute expiry');
  daily.clock.now = Date.parse(made.row.created_at) + BROWSER_SESSION_ABSOLUTE_MS + 1;
  assert.equal(daily.service.resolve(made.secret), null);
});

test('touch writes at most every 10 minutes (force renews regardless)', () => {
  const { service, clock, db } = makeService();
  const { secret, row } = service.create({ authMethod: 'token', ip: '192.0.2.1' });
  const seen = () => db.prepare('SELECT last_seen_at, last_ip, expires_at FROM browser_sessions WHERE id = ?').get(row.id);
  clock.now += 60_000;
  assert.equal(service.touch(service.resolve(secret), { ip: '192.0.2.2' }).touched, false, 'one minute after sign-in: no write');
  assert.equal(seen().last_ip, '192.0.2.1');
  clock.now += BROWSER_SESSION_TOUCH_INTERVAL_MS;
  const touched = service.touch(service.resolve(secret), { ip: '192.0.2.2' });
  assert.equal(touched.touched, true);
  assert.equal(seen().last_ip, '192.0.2.2');
  assert.equal(seen().expires_at, new Date(clock.now + BROWSER_SESSION_IDLE_MS).toISOString(), 'the idle expiry slides');
  const written = seen().last_seen_at;
  clock.now += 5 * 60_000;
  assert.equal(service.touch(service.resolve(secret)).touched, false);
  assert.equal(seen().last_seen_at, written);
  assert.equal(service.touch(service.resolve(secret), { force: true }).touched, true);
});

test('at most 50 rows: a new one pushes out the one seen least recently', () => {
  const { service, clock } = makeService({ maxRows: 50 });
  const made = [];
  for (let index = 0; index < 50; index += 1) {
    clock.now += 1000;
    made.push(service.create({ authMethod: 'token', label: `b${index}` }));
  }
  // The first one is used again: the second is now the least recent.
  clock.now += BROWSER_SESSION_TOUCH_INTERVAL_MS + 1;
  service.touch(service.resolve(made[0].secret));
  clock.now += 1000;
  const extra = service.create({ authMethod: 'code' });
  assert.equal(service.list().length, 50);
  assert.ok(service.resolve(made[0].secret), 'the one used lately stays');
  assert.equal(service.resolve(made[1].secret), null, 'the least recently seen went');
  assert.ok(service.resolve(extra.secret));
});

test('rename, revoke, revokeAllExcept, hasLiveDevice; list marks the current one', () => {
  const { service } = makeService();
  const a = service.create({ authMethod: 'token', deviceId: 'phone' });
  const b = service.create({ authMethod: 'upgrade', deviceId: 'phone' });
  const c = service.create({ authMethod: 'code', deviceId: 'laptop' });
  assert.equal(service.rename(a.row.id, '  My phone  ').label, 'My phone');
  assert.equal(service.resolve(a.secret).label, 'My phone', 'the memory row follows');
  assert.equal(service.rename('bs_nope', 'x'), null);
  const listed = service.list({ currentId: b.row.id });
  assert.equal(listed.find((row) => row.id === b.row.id).current, true);
  assert.equal(listed.filter((row) => row.current).length, 1);
  assert.ok(listed.every((row) => !('secret_hash' in row) && !('secretHash' in row)), 'no hash in the API shape');

  assert.equal(service.revoke(a.row.id).id, a.row.id);
  assert.equal(service.resolve(a.secret), null);
  assert.equal(service.revoke(a.row.id), null);
  assert.equal(service.hasLiveDevice('phone'), true, 'b still has the phone');
  assert.equal(service.hasLiveDevice('phone', { exceptId: b.row.id }), false);
  const removed = service.revokeAllExcept(c.row.id);
  assert.deepEqual(removed.map((row) => row.id), [b.row.id]);
  assert.equal(service.hasLiveDevice('phone'), false);
  assert.ok(service.resolve(c.secret));
});

test('cleanup at boot and hourly removes expired rows', () => {
  const clock = { now: Date.parse('2026-11-01T00:00:00.000Z') };
  const db = makeDb();
  const first = createBrowserSessionService({ db, now: () => clock.now, logger: quiet });
  const old = first.create({ authMethod: 'token' });
  clock.now += 10 * DAY;
  const fresh = first.create({ authMethod: 'token' });
  clock.now += 25 * DAY;
  // A restart 35 days after the first sign-in: the boot cleanup takes it.
  const booted = createBrowserSessionService({ db, now: () => clock.now, logger: quiet });
  const stop = booted.startCleanup({ intervalMs: 3_600_000 });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM browser_sessions').get().n, 1);
    assert.equal(booted.resolve(old.secret), null);
    assert.ok(booted.resolve(fresh.secret));
  } finally {
    stop();
  }
});

test('labels from user agents', () => {
  assert.equal(labelFromUserAgent(PHONE_UA), 'Chrome on Android');
  assert.equal(labelFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari on iPhone');
  assert.equal(labelFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0'), 'Firefox on Windows');
  assert.equal(labelFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge on Windows');
  assert.equal(labelFromUserAgent(''), 'Browser');
});

test('sign-in codes: single use, expire after 10 minutes, kept as hashes only', () => {
  const clock = { now: 1_000_000 };
  const codes = createSignInCodes({ now: () => clock.now });
  const { code, expiresAt } = codes.mint();
  matchSecret(code, /^oarc1_[A-Za-z0-9_-]{43}$/);
  assert.equal(Date.parse(expiresAt), clock.now + SIGNIN_CODE_TTL_MS);
  assert.deepEqual(codes.consume(code), { ok: true, via: 'code' });
  assert.deepEqual(codes.consume(code), { ok: false, via: null }, 'single use');
  const late = codes.mint().code;
  clock.now += SIGNIN_CODE_TTL_MS + 1;
  assert.equal(codes.consume(late).ok, false, 'expired after 10 minutes');
  assert.equal(codes.consume('oarc1_made-up').ok, false);
  assert.equal(codes.consume('').ok, false);
  // A bounded number at a time: the oldest go first.
  const many = Array.from({ length: 25 }, () => codes.mint().code);
  assert.equal(codes.size(), 20);
  assert.equal(codes.consume(many[0]).ok, false);
  assert.equal(codes.consume(many.at(-1)).ok, true);
});

test('sign-in codes: mint({ via, minter }) keeps where a code was made; consume says it', () => {
  const codes = createSignInCodes();
  const terminal = codes.mint({ via: 'terminal', minter: 'terminal' });
  assert.equal(terminal.via, 'terminal');
  const settings = codes.mint({ via: 'code', minter: 'bs_one' });
  // An unknown via is a plain code.
  const odd = codes.mint({ via: 'passkey', minter: 'bs_two' });
  assert.equal(odd.via, 'code');
  assert.deepEqual(codes.consume(terminal.code), { ok: true, via: 'terminal' });
  assert.deepEqual(codes.consume(settings.code), { ok: true, via: 'code' });
  assert.deepEqual(codes.consume(odd.code), { ok: true, via: 'code' });
  assert.ok(BROWSER_SESSION_AUTH_METHODS.includes('terminal'), 'a terminal code signs in a session with auth_method terminal');
});

test('sign-in codes: a new code revokes the same minter\'s previous one, no one else\'s', () => {
  const codes = createSignInCodes();
  const first = codes.mint({ via: 'code', minter: 'bs_one' }).code;
  const other = codes.mint({ via: 'code', minter: 'bs_two' }).code;
  const second = codes.mint({ via: 'code', minter: 'bs_one' }).code;
  assert.equal(codes.consume(first).ok, false, 'the first code of bs_one is gone');
  assert.equal(codes.consume(other).ok, true, 'another browser\'s code stays');
  assert.equal(codes.consume(second).ok, true);
  // No minter: nothing is revoked.
  const a = codes.mint().code;
  const b = codes.mint().code;
  assert.equal(codes.consume(a).ok, true);
  assert.equal(codes.consume(b).ok, true);
});

test('sign-in codes: terminal codes are limited to 3 in 10 minutes; Settings codes are not', () => {
  const clock = { now: 5_000_000 };
  const codes = createSignInCodes({ now: () => clock.now });
  for (let i = 0; i < 3; i += 1) {
    assert.ok(codes.mint({ via: 'terminal', minter: 'terminal' }).code, `terminal code ${i + 1}`);
    clock.now += 60_000;
  }
  const refused = codes.mint({ via: 'terminal', minter: 'terminal' });
  assert.equal(refused.limited, true);
  assert.equal(refused.code, undefined, 'no code when limited');
  // The first of the three was minted 3 min ago: 7 min to wait.
  assert.equal(refused.retryAfterSeconds, 7 * 60);
  for (let i = 0; i < 5; i += 1) assert.ok(codes.mint({ via: 'code', minter: `bs_${i}` }).code);
  clock.now += 7 * 60_000;
  assert.ok(codes.mint({ via: 'terminal', minter: 'terminal' }).code, 'one more once the first left the window');
  assert.equal(codes.mint({ via: 'terminal', minter: 'terminal' }).limited, true);
});

test('the proof key: made once with the session, only its hash stored; a row without one never matches', () => {
  const { service, db } = makeService();
  const { secret, proof, row } = service.create({ authMethod: 'token' });
  matchSecret(proof, /^oark1_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(proof, secret);
  const stored = db.prepare('SELECT * FROM browser_sessions').get();
  assert.equal(stored.proof_hash, hashOwnerToken(proof));
  assert.ok(!JSON.stringify(stored).includes(proof), 'the key is not in the table');
  const live = service.resolve(secret);
  assert.equal(service.proofMatches(live, proof), true);
  assert.equal(service.proofMatches(live, `${proof.slice(0, -1)}${proof.at(-1) === 'A' ? 'B' : 'A'}`), false);
  assert.equal(service.proofMatches(live, ''), false);
  assert.equal(service.proofMatches(live, secret), false, 'the cookie secret is not the key');
  assert.ok(!('proof_hash' in service.formatRow(row)) && !('proofHash' in service.formatRow(row)), 'no hash in the API shape');
  // A row from before keys: '' matches nothing, and nothing makes one for it.
  db.prepare(`UPDATE browser_sessions SET proof_hash = '' WHERE id = ?`).run(row.id);
  const reloaded = createBrowserSessionService({ db, logger: quiet });
  assert.equal(reloaded.proofMatches(reloaded.resolve(secret), proof), false);
  assert.equal(typeof reloaded.issueProof, 'undefined');
});

test('touch stores a device id only on a row without one, throttled or not (an upgraded browser\'s page sends it once)', () => {
  const { service, db } = makeService();
  const { secret, row } = service.create({ authMethod: 'upgrade' });
  assert.equal(row.device_id, '');
  // Within the 10-minute throttle: no touch is written, the device id is.
  const outcome = service.touch(service.resolve(secret), { deviceId: 'dev-upgraded' });
  assert.equal(outcome.touched, false);
  assert.equal(service.resolve(secret).device_id, 'dev-upgraded');
  assert.equal(db.prepare('SELECT device_id FROM browser_sessions WHERE id = ?').get(row.id).device_id, 'dev-upgraded');
  service.touch(service.resolve(secret), { deviceId: 'dev-other', force: true });
  assert.equal(service.resolve(secret).device_id, 'dev-upgraded', 'a device id once set stays');
  assert.equal(service.hasLiveDevice('dev-upgraded'), true);
});

test('a session pushed out by the 50 or expired goes like a revoked one: onRemoved gets its rows', () => {
  const removed = [];
  const { service, clock } = makeService({ maxRows: 2, onRemoved: (rows, reason) => removed.push({ ids: rows.map((row) => row.id), devices: rows.map((row) => row.device_id), reason }) });
  const a = service.create({ authMethod: 'token', deviceId: 'phone-a' });
  clock.now += 1000;
  const b = service.create({ authMethod: 'token', deviceId: 'phone-b' });
  clock.now += 1000;
  service.create({ authMethod: 'token', deviceId: 'phone-c' });
  assert.deepEqual(removed, [{ ids: [a.row.id], devices: ['phone-a'], reason: 'cap' }]);
  // Idle past 30 days: the lookup that finds it expired removes it.
  clock.now += BROWSER_SESSION_IDLE_MS + 1;
  assert.equal(service.resolve(b.secret), null);
  assert.deepEqual(removed.at(-1), { ids: [b.row.id], devices: ['phone-b'], reason: 'expired' });
  // The hourly cleanup reports the rest.
  removed.length = 0;
  service.cleanupExpired();
  assert.equal(removed.length, 1);
  assert.equal(removed[0].reason, 'expired');
  assert.equal(removed[0].ids.length, 1);
  // A handler that throws does not stop the removal.
  service.setOnRemoved(() => { throw new Error('boom'); });
  const d = service.create({ authMethod: 'token' });
  clock.now += BROWSER_SESSION_IDLE_MS + 1;
  assert.equal(service.resolve(d.secret), null);
});
