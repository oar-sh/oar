import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIGNIN_NOTICE_KEEP_MS,
  SIGNIN_NOTICE_MAX,
  SIGNIN_NOTICES_SETTING_KEY,
  SIGNIN_NOTICE_SOCKET_EVENT,
  createSignInNoticeService,
  signInNoticeEventId,
  signInNoticeRecipients,
} from './signin-notice-service.mjs';

// New sign-in notices (agent auth §13.2, 2d; §13.9): relay-wide, acked per
// viewer session, 20 at most for 7 days, snapshots of the label and address.

function row(id, { label = 'Chrome on Android', ip = '198.51.100.7', device = `dev-${id}`, ua = 'Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile' } = {}) {
  return { id, label, last_ip: ip, device_id: device, user_agent: ua };
}

function makeService({ settings = new Map(), clock = { now: Date.parse('2026-11-01T10:00:00.000Z') }, live = new Set() } = {}) {
  const emitted = [];
  const pushed = [];
  const order = [];
  const service = createSignInNoticeService({
    readSetting: (key) => settings.get(key) ?? null,
    writeSetting: (key, value) => settings.set(key, value),
    emitToPersonSockets: (event, payload, options) => { order.push('socket'); emitted.push({ event, payload, options }); return 1; },
    notifyPush: (notice) => { order.push('push'); pushed.push(notice); },
    isSessionLive: (id) => live.has(id),
    now: () => clock.now,
    logger: { log() {}, warn() {} },
  });
  return { service, settings, clock, live, emitted, pushed, order };
}

test('a sign-in is stored, pushed and sent to every other person socket at once', () => {
  const ctx = makeService({ live: new Set(['bs_new']) });
  const notice = ctx.service.record({ row: row('bs_new'), via: 'terminal' });
  assert.match(notice.id, /^signin-[A-Za-z0-9_-]+$/);
  assert.equal(notice.via, 'terminal');
  assert.equal(notice.viaLabel, 'the terminal');
  assert.equal(notice.address, '198.51.100.7');
  assert.equal(notice.signedOut, false);
  assert.deepEqual(ctx.order, ['push', 'socket']);
  assert.equal(ctx.pushed[0].noticeId, notice.id);
  assert.equal(ctx.pushed[0].deviceId, 'dev-bs_new');
  assert.equal(ctx.pushed[0].sessionId, 'bs_new');
  assert.deepEqual(ctx.emitted, [{ event: SIGNIN_NOTICE_SOCKET_EVENT, payload: { notice }, options: { exceptSessionId: 'bs_new' } }]);
  const stored = JSON.parse(ctx.settings.get(SIGNIN_NOTICES_SETTING_KEY));
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].ackedBy, []);
});

test('viewers: every session but the new one, including sessions made later; acks are per viewer', () => {
  const ctx = makeService();
  const notice = ctx.service.record({ row: row('bs_new'), via: 'code' });
  assert.deepEqual(ctx.service.listFor({ viewerSessionId: 'bs_new' }), [], 'not shown to the session it is about');
  assert.deepEqual(ctx.service.listFor({ viewerSessionId: 'bs_old' }).map((item) => item.id), [notice.id]);
  // A browser that signs in after the event still sees it (§13.9).
  ctx.clock.now += 60 * 60 * 1000;
  assert.deepEqual(ctx.service.listFor({ viewerSessionId: 'bs_later' }).map((item) => item.id), [notice.id]);
  // One viewer's dismiss hides it for that viewer only.
  assert.equal(ctx.service.ack(notice.id, 'bs_old'), 'ok');
  assert.deepEqual(ctx.service.listFor({ viewerSessionId: 'bs_old' }), []);
  assert.deepEqual(ctx.service.listFor({ viewerSessionId: 'bs_later' }).map((item) => item.id), [notice.id]);
  // The new session cannot hide it for the others either.
  assert.equal(ctx.service.ack(notice.id, 'bs_new'), 'ok');
  assert.deepEqual(ctx.service.listFor({ viewerSessionId: 'bs_later' }).map((item) => item.id), [notice.id]);
  // The owner token (no session): the relay-wide list, not dismissible.
  const relayWide = ctx.service.listFor({});
  assert.deepEqual(relayWide.map((item) => [item.id, item.dismissible]), [[notice.id, false]]);
  assert.equal(ctx.service.ack(notice.id, ''), 'not-found');
  assert.equal(ctx.service.ack('signin-nope', 'bs_old'), 'not-found');
  assert.equal(ctx.service.ack('rotate-after-upgrade', 'bs_old'), 'not-found');
});

test('"Got it": several notices acked for one viewer in one write, the others still see them; never a viewer\'s own', () => {
  const ctx = makeService();
  const ids = ['bs_a', 'bs_b', 'bs_c'].map((id) => ctx.service.record({ row: row(id), via: 'token' }).id);
  assert.equal(ctx.service.listFor({ viewerSessionId: 'bs_viewer' }).length, 3);
  let writes = 0;
  const set = ctx.settings.set.bind(ctx.settings);
  ctx.settings.set = (key, value) => { writes += 1; return set(key, value); };
  assert.equal(ctx.service.ackMany([...ids.slice(0, 2), 'signin-nope', 'rotate-after-upgrade'], 'bs_viewer'), 2);
  assert.equal(writes, 1, 'one write');
  ctx.settings.set = set;
  assert.deepEqual(ctx.service.listFor({ viewerSessionId: 'bs_viewer' }).map((item) => item.id), [ids[2]]);
  assert.equal(ctx.service.listFor({ viewerSessionId: 'bs_other' }).length, 3);
  // Its own sign-in is never in a viewer's list, acked or not.
  assert.deepEqual(ctx.service.listFor({ viewerSessionId: 'bs_c' }).map((item) => item.id), [ids[1], ids[0]]);
  assert.equal(ctx.service.ackMany(ids, ''), 0, 'no viewer, nothing');
  assert.equal(ctx.service.ackMany([], 'bs_viewer'), 0);
  assert.equal(ctx.service.ackMany('signin-x', 'bs_viewer'), 0);
});

test('at most 20, newest first; gone after 7 days', () => {
  const ctx = makeService();
  const ids = [];
  for (let i = 0; i < SIGNIN_NOTICE_MAX + 5; i += 1) {
    ids.push(ctx.service.record({ row: row(`bs_${i}`), via: 'token' }).id);
    ctx.clock.now += 1000;
  }
  const listed = ctx.service.listFor({ viewerSessionId: 'bs_viewer' }).map((item) => item.id);
  assert.equal(listed.length, SIGNIN_NOTICE_MAX);
  assert.deepEqual(listed, ids.slice(5).reverse());
  ctx.clock.now += SIGNIN_NOTICE_KEEP_MS;
  assert.deepEqual(ctx.service.listFor({ viewerSessionId: 'bs_viewer' }), []);
  // The next write drops the expired ones from the setting too.
  ctx.service.record({ row: row('bs_fresh'), via: 'token' });
  assert.equal(JSON.parse(ctx.settings.get(SIGNIN_NOTICES_SETTING_KEY)).length, 1);
});

test('over the cap: done-with notices go first, a signed-in terminal sign-in never goes', () => {
  const live = new Set();
  const ctx = makeService({ live });
  const record = (id, via) => {
    live.add(id);
    const notice = ctx.service.record({ row: row(id), via });
    ctx.clock.now += 1000;
    return notice.id;
  };
  const terminal = record('bs_terminal', 'terminal');
  // The terminal session dismisses its own notice: that makes it no less kept.
  assert.equal(ctx.service.ack(terminal, 'bs_terminal'), 'ok');
  const dismissed = record('bs_seen', 'code');
  ctx.service.ack(dismissed, 'bs_phone');
  const gone = record('bs_gone', 'token');
  live.delete('bs_gone');
  const links = [];
  for (let i = 0; i < SIGNIN_NOTICE_MAX - 3; i += 1) links.push(record(`bs_link_${i}`, 'code'));
  const ids = () => ctx.service.listFor({ viewerSessionId: 'bs_viewer' }).map((item) => item.id);
  assert.equal(ids().length, SIGNIN_NOTICE_MAX);
  // One over: the one some browser dismissed goes, not the older terminal one.
  links.push(record('bs_link_a', 'code'));
  assert.ok(!ids().includes(dismissed));
  assert.ok(ids().includes(gone));
  // Then the signed-out one.
  links.push(record('bs_link_b', 'code'));
  assert.ok(!ids().includes(gone));
  // Then the oldest sign-in link, never the terminal one: a flood of links
  // from that session cannot push it out.
  for (let i = 0; i < SIGNIN_NOTICE_MAX * 2; i += 1) links.push(record(`bs_flood_${i}`, 'code'));
  const listed = ids();
  assert.equal(listed.length, SIGNIN_NOTICE_MAX);
  assert.ok(listed.includes(terminal), 'the terminal notice is still listed');
  assert.deepEqual(listed.slice(0, SIGNIN_NOTICE_MAX - 1), links.slice(-(SIGNIN_NOTICE_MAX - 1)).reverse());
  // Signed out, it goes like any other.
  live.delete('bs_terminal');
  record('bs_after', 'code');
  assert.ok(!ids().includes(terminal));
  // Only terminal sign-ins, all signed in: the list grows past the cap
  // rather than drop one, and the new one is kept.
  const many = makeService({ live: new Set(Array.from({ length: SIGNIN_NOTICE_MAX + 2 }, (_, i) => `bs_t${i}`)) });
  for (let i = 0; i < SIGNIN_NOTICE_MAX + 2; i += 1) many.service.record({ row: row(`bs_t${i}`), via: 'terminal' });
  assert.equal(many.service.listFor({ viewerSessionId: 'bs_viewer' }).length, SIGNIN_NOTICE_MAX + 2);
});

test('the label and address are snapshots: a later rename does not change the notice; signedOut follows the session', () => {
  const ctx = makeService({ live: new Set(['bs_new']) });
  const made = row('bs_new', { label: 'Firefox on Linux', ip: '203.0.113.40' });
  ctx.service.record({ row: made, via: 'terminal' });
  made.label = 'My phone';
  made.last_ip = '192.0.2.1';
  const [notice] = ctx.service.listFor({ viewerSessionId: 'bs_old' });
  assert.equal(notice.label, 'Firefox on Linux');
  assert.equal(notice.address, '203.0.113.40');
  assert.equal(notice.signedOut, false);
  ctx.live.delete('bs_new');
  assert.equal(ctx.service.listFor({ viewerSessionId: 'bs_old' })[0].signedOut, true);
});

test('restart-persistent: a new service on the same settings sees the notices and the acks', () => {
  const first = makeService();
  const notice = first.service.record({ row: row('bs_new'), via: 'code' });
  first.service.ack(notice.id, 'bs_a');
  const second = makeService({ settings: first.settings, clock: first.clock });
  assert.deepEqual(second.service.listFor({ viewerSessionId: 'bs_a' }), []);
  assert.deepEqual(second.service.listFor({ viewerSessionId: 'bs_b' }).map((item) => item.id), [notice.id]);
});

test('a failing push, socket or store never stops the others', () => {
  const pushed = [];
  const service = createSignInNoticeService({
    readSetting: () => 'not json',
    writeSetting: () => { throw new Error('disk full'); },
    emitToPersonSockets: () => { throw new Error('socket'); },
    notifyPush: (notice) => { pushed.push(notice.id); throw new Error('push'); },
    logger: { log() {}, warn() {} },
  });
  const notice = service.record({ row: row('bs_new'), via: 'token' });
  assert.ok(notice);
  assert.equal(pushed.length, 1);
  assert.equal(service.record({ row: null, via: 'token' }), null);
});

test('signInNoticeEventId takes signin-<id> only', () => {
  assert.equal(signInNoticeEventId('signin-AbC_1-2'), 'AbC_1-2');
  assert.equal(signInNoticeEventId('signin-'), '');
  assert.equal(signInNoticeEventId('signin-a/b'), '');
  assert.equal(signInNoticeEventId('changed-outside'), '');
});

test('recipients: the owner token\'s and proof-checked browser sockets only, never the new session\'s own, an agent\'s or an untagged one', () => {
  const socket = (name, data) => ({ name, data });
  const sockets = [
    socket('owner', { principal: { kind: 'owner', via: 'bearer' }, browserSessionId: null }),
    socket('laptop', { principal: { kind: 'browser', sessionId: 'bs_laptop', via: 'cookie' }, browserSessionId: 'bs_laptop' }),
    socket('new', { principal: { kind: 'browser', sessionId: 'bs_new', via: 'cookie' }, browserSessionId: 'bs_new' }),
    // A handshake that never passed (no principal), or one tagged for another session.
    socket('untagged', { browserSessionId: 'bs_laptop' }),
    socket('mismatch', { principal: { kind: 'browser', sessionId: 'bs_other' }, browserSessionId: 'bs_laptop' }),
    socket('agent', { principal: { kind: 'agent', agentKind: 'c' }, browserSessionId: null }),
    socket('peer', { principal: { kind: 'peer', entryId: 'r-1' }, browserSessionId: null }),
    socket('bare', {}),
  ];
  assert.deepEqual(signInNoticeRecipients(sockets, { exceptSessionId: 'bs_new' }).map((entry) => entry.name), ['owner', 'laptop']);
  assert.deepEqual(signInNoticeRecipients(sockets).map((entry) => entry.name), ['owner', 'laptop', 'new']);
  assert.deepEqual(signInNoticeRecipients(null), []);
  // A live Map's values() iterator works the same.
  assert.equal(signInNoticeRecipients(new Map(sockets.map((entry) => [entry.name, entry])).values(), { exceptSessionId: 'bs_new' }).length, 2);
});
