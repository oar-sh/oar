import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createRemoteRelayRegistry } from './remote-relay-registry-service.mjs';
import { RemoteRelayError } from './remote-relay-client.mjs';
import { applySchema } from '../db-schema.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import {
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_LIMITS,
  REMOTE_RELAY_SETTING_KEYS,
  REMOTE_RELAY_SOCKET_EVENT,
} from '../../shared/remote-relay-contract.mjs';

const OWN_TOKEN = 'o'.repeat(36);
const CUSTOM_TOKEN = 'c'.repeat(64);

function createSettingsStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    readSetting: (key) => (values.has(key) ? values.get(key) : null),
    writeSetting: (key, value) => {
      assert.equal(typeof value, 'string', 'settings are written as strings');
      values.set(key, value);
    },
  };
}

/** A client double: probe answers come from a per-URL table. */
function createFakeClient(answers = {}) {
  const probes = [];
  return {
    probes,
    answers,
    tokenFor: (relay) => (relay?.tokenMode === 'custom' ? relay.token : OWN_TOKEN),
    async probe(url, token, options) {
      probes.push({ url, token, options });
      const answer = answers[url];
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'function') return answer();
      if (!answer) throw new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.offline, 'not reachable (ECONNREFUSED)', { detail: 'ECONNREFUSED' });
      return answer;
    },
  };
}

function identity(overrides = {}) {
  return {
    relayId: 'relay-b-0002',
    name: 'linux-test',
    version: '0.9.4',
    platform: 'linux',
    publicUrl: 'https://relay-b.example.test',
    protocol: 1,
    inbound: true,
    ...overrides,
  };
}

function setup({ settings = {}, answers = {}, repository = null, selfName = 'win-test', clock } = {}) {
  const store = createSettingsStore(settings);
  const client = createFakeClient(answers);
  const events = [];
  const logs = [];
  let ids = 0;
  let tick = 0;
  const registry = createRemoteRelayRegistry({
    readSetting: store.readSetting,
    writeSetting: store.writeSetting,
    client,
    repository,
    getOwnToken: () => OWN_TOKEN,
    getSelfName: () => selfName,
    hostname: 'devbox',
    platform: 'win32',
    version: '0.9.4',
    now: clock || (() => new Date(Date.UTC(2026, 8, 20, 10, 0, tick++))),
    emit: (event, payload) => events.push({ event, payload }),
    logger: { warn: (line) => logs.push(String(line)) },
    randomUUID: () => `uuid-${++ids}`,
  });
  return { registry, store, client, events, logs };
}

test('the instance id is created once, stored as JSON and reused', () => {
  const { registry, store } = setup();
  const first = registry.instanceId();
  assert.equal(first, 'uuid-1');
  assert.equal(store.values.get(REMOTE_RELAY_SETTING_KEYS.instanceId), JSON.stringify('uuid-1'));
  assert.equal(registry.instanceId(), first);

  const legacy = setup({ settings: { [REMOTE_RELAY_SETTING_KEYS.instanceId]: 'relay-a-0001' } });
  assert.equal(legacy.registry.instanceId(), 'relay-a-0001', 'a bare string still reads');
});

test('the self name is the relay name, else the injected hostname', () => {
  assert.equal(setup().registry.selfName(), 'win-test');
  assert.equal(setup({ selfName: '' }).registry.selfName(), 'devbox');
});

test('selfIdentity reports the injected platform and version and the protocol', () => {
  const { registry } = setup({ settings: { [REMOTE_RELAY_SETTING_KEYS.publicUrl]: JSON.stringify('https://relay-a.example.test') } });
  assert.deepEqual(registry.selfIdentity(), {
    relayId: 'uuid-1',
    name: 'win-test',
    version: '0.9.4',
    platform: 'win32',
    publicUrl: 'https://relay-a.example.test',
    remoteRelays: { protocol: 1, inbound: true },
  });
});

test('self settings default to inbound on and validate the public URL', () => {
  const { registry, store, events } = setup();
  assert.deepEqual(registry.getSelfSettings(), { publicUrl: '', inboundEnabled: true });

  const saved = registry.setSelfSettings({ publicUrl: 'https://relay-a.example.test/oar/index.html?token=abc#x', inboundEnabled: false });
  assert.deepEqual(saved, { ok: true, publicUrl: 'https://relay-a.example.test/oar', inboundEnabled: false });
  assert.equal(store.values.get(REMOTE_RELAY_SETTING_KEYS.publicUrl), JSON.stringify('https://relay-a.example.test/oar'), 'a pasted token is not kept');
  assert.equal(store.values.get(REMOTE_RELAY_SETTING_KEYS.inboundEnabled), 'false');
  assert.equal(registry.selfIdentity().remoteRelays.inbound, false);
  assert.equal(events.at(-1).event, REMOTE_RELAY_SOCKET_EVENT);

  assert.equal(registry.setSelfSettings({ publicUrl: 'http://relay-a.example.test' }).status, 400, 'public plain http is refused');
  assert.equal(registry.setSelfSettings({ publicUrl: 'notaurl::' }).ok, false);
  assert.equal(registry.setSelfSettings({ inboundEnabled: 'yes' }).status, 400);
  assert.equal(registry.getSelfSettings().publicUrl, 'https://relay-a.example.test/oar', 'a refused update changes nothing');

  assert.deepEqual(registry.setSelfSettings({ publicUrl: '' }), { ok: true, publicUrl: '', inboundEnabled: false });
  assert.equal(registry.selfIdentity().publicUrl, null);
  assert.equal(registry.setSelfSettings({ inboundEnabled: true }).inboundEnabled, true);
});

test('add stores full entries; listPublic hides tokens and adds host and http warning', () => {
  const { registry, store, events } = setup();
  const a = registry.add({ relayId: 'relay-b-0002', name: 'linux-test', url: 'https://relay-b.example.test/', token: CUSTOM_TOKEN });
  const b = registry.add({ name: 'lan-test', url: 'http://192.168.10.20:3333', tokenMode: 'own', permission: 'read' });
  assert.equal(a.id, 'rr_uuid-1');
  assert.equal(a.url, 'https://relay-b.example.test');
  assert.equal(a.tokenMode, 'custom');
  assert.equal(a.token, CUSTOM_TOKEN);
  assert.equal(a.permission, 'full', 'full is the default permission');
  assert.equal(a.addedBy, 'user');
  assert.equal(a.lastStatus, 'unknown');
  assert.equal(b.permission, 'read');
  assert.equal(b.token, undefined);

  assert.equal(registry.list().length, 2);
  assert.equal(registry.get(a.id).token, CUSTOM_TOKEN, 'server-internal reads keep the token');
  assert.equal(registry.get('missing'), null);

  const listed = registry.listPublic();
  assert.equal(JSON.stringify(listed).includes(CUSTOM_TOKEN), false);
  assert.equal(listed[0].host, 'relay-b.example.test');
  assert.equal(listed[0].httpWarning, null);
  assert.match(listed[1].httpWarning, /Plain http/);
  assert.equal(listed[0].token, undefined);

  assert.ok(store.values.get(REMOTE_RELAY_SETTING_KEYS.relays).includes(CUSTOM_TOKEN), 'the token is stored');
  assert.equal(events.length, 2);
  assert.equal(events.some(({ payload }) => JSON.stringify(payload).includes(CUSTOM_TOKEN)), false, 'events never carry a token');

  assert.throws(() => registry.add({ name: 'x', url: 'http://relay-a.example.test' }), { status: 400 });
});

test('resolve matches a name or URL host case-insensitively and requires uniqueness', () => {
  const { registry } = setup();
  const linux = registry.add({ name: 'linux-test', url: 'https://relay-b.example.test' });
  registry.add({ name: 'win-test', url: 'https://relay-a.example.test' });
  assert.equal(registry.resolve('linux-test').relay.id, linux.id);
  assert.equal(registry.resolve('LINUX-TEST').relay.id, linux.id);
  assert.equal(registry.resolve('@linux-test').relay.id, linux.id);
  assert.equal(registry.resolve('relay-b.example.test').relay.id, linux.id);
  assert.equal(registry.resolve('https://relay-b.example.test/').relay.id, linux.id);
  assert.equal(registry.resolve('linux-test').relay.token, undefined);

  assert.deepEqual(registry.resolve('mac-test'), { error: 'unknown', names: ['linux-test', 'win-test'] });
  assert.deepEqual(registry.resolve(''), { error: 'unknown', names: ['linux-test', 'win-test'] });

  registry.add({ name: 'linux-test', url: 'https://relay-c.example.test' });
  assert.deepEqual(registry.resolve('linux-test'), { error: 'ambiguous', names: ['linux-test', 'linux-test'] });
  assert.equal(registry.resolve('relay-c.example.test').relay.url, 'https://relay-c.example.test', 'the host still resolves');

  // An agent may name a relay by an address host, which is no chat mention alias.
  const lan = registry.add({ name: 'lan-test', url: 'http://192.168.10.20:3333' });
  assert.equal(registry.resolve('192.168.10.20').relay.id, lan.id);
  assert.equal(registry.resolve('http://192.168.10.20:3333/').relay.id, lan.id);
});

test('update validates permission, URL and token changes', () => {
  const { registry, events } = setup();
  const entry = registry.add({ name: 'linux-test', url: 'https://relay-b.example.test' });
  const before = events.length;

  const permission = registry.update(entry.id, { permission: 'READ' });
  assert.equal(permission.ok, true);
  assert.equal(permission.relay.permission, 'read');
  assert.equal(events.length, before + 1);

  assert.equal(registry.update(entry.id, { permission: 'admin' }).status, 400, 'a typo never widens to full');
  assert.equal(registry.update(entry.id, { url: 'http://relay-b.example.test' }).status, 400);
  assert.equal(registry.update(entry.id, { tokenMode: 'custom' }).status, 400, 'custom needs a token');
  assert.equal(registry.update(entry.id, { tokenMode: 'shared' }).status, 400);
  assert.equal(registry.update('missing', { permission: 'read' }).status, 404);

  const moved = registry.update(entry.id, { url: 'https://relay-b.example.test/oar/?token=zzz' });
  assert.equal(moved.relay.url, 'https://relay-b.example.test/oar');
  assert.equal(moved.relay.lastStatus, 'unknown');

  const custom = registry.update(entry.id, { token: CUSTOM_TOKEN });
  assert.equal(custom.relay.tokenMode, 'custom');
  assert.equal(custom.relay.token, undefined, 'the answer is public');
  assert.equal(registry.get(entry.id).token, CUSTOM_TOKEN);

  const own = registry.update(entry.id, { tokenMode: 'own' });
  assert.equal(own.relay.tokenMode, 'own');
  assert.equal(registry.get(entry.id).token, undefined, 'switching to own drops the stored token');

  const quiet = events.length;
  assert.equal(registry.update(entry.id, { permission: 'read', tokenMode: 'own' }).ok, true);
  assert.equal(events.length, quiet, 'a no-op update emits nothing');
});

test('remove deletes the entry and forgets its unlocks', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const repository = createRemoteRelayRepository(db);
  const { registry, events } = setup({ repository });
  const linux = registry.add({ name: 'linux-test', url: 'https://relay-b.example.test' });
  const win = registry.add({ name: 'win-test', url: 'https://relay-a.example.test' });
  repository.recordUnlock('c-1', linux.id, 'm-1');
  repository.recordUnlock('c-1', win.id, 'm-1');

  assert.deepEqual(registry.remove(linux.id), { ok: true });
  assert.deepEqual(registry.list().map((entry) => entry.id), [win.id]);
  assert.equal(repository.hasUnlock('c-1', linux.id), false);
  assert.equal(repository.hasUnlock('c-1', win.id), true);
  assert.equal(events.at(-1).payload.relays.length, 1);
  assert.equal(registry.remove(linux.id).status, 404);
});

test('upsertFromPairing adds a pairing entry and dedupes by relayId, then by URL', () => {
  const { registry, logs } = setup();
  const created = registry.upsertFromPairing({ relayId: 'relay-b-0002', name: 'linux-test', url: 'https://relay-b.example.test/', token: CUSTOM_TOKEN, protocol: 1 });
  assert.equal(created.addedBy, 'pairing');
  assert.equal(created.permission, 'full');
  assert.equal(created.tokenMode, 'custom');
  assert.equal(created.token, CUSTOM_TOKEN, 'a new entry takes the offered token');
  assert.equal(created.url, 'https://relay-b.example.test');
  assert.equal(created.protocol, 1);

  registry.update(created.id, { permission: 'prompt' });
  const renamed = registry.upsertFromPairing({ relayId: 'relay-b-0002', name: 'linux-renamed', url: 'https://relay-b.example.test', token: CUSTOM_TOKEN });
  assert.equal(renamed.id, created.id, 'same relayId updates the entry');
  assert.equal(renamed.name, 'linux-renamed', 'what the relay says about itself is refreshed');
  assert.equal(renamed.permission, 'prompt', 'the user-chosen permission is kept');
  assert.deepEqual(logs, [], 'the same address and token change nothing to report');

  const userAdded = registry.add({ name: 'win-test', url: 'https://relay-a.example.test' });
  const byUrl = registry.upsertFromPairing({ relayId: 'relay-a-0001', name: 'win-test', url: 'https://relay-a.example.test' });
  assert.equal(byUrl.id, userAdded.id, 'a relay without relayId yet is matched by URL');
  assert.equal(byUrl.relayId, 'relay-a-0001');
  assert.equal(byUrl.addedBy, 'user', 'who added it first is kept');
  assert.equal(registry.list().length, 2);
});

test('upsertFromPairing never rewrites a known entry\'s address or token', () => {
  const { registry, logs, events } = setup();
  const known = registry.upsertFromPairing({ relayId: 'relay-b-0002', name: 'linux-test', url: 'https://relay-b.example.test', token: CUSTOM_TOKEN });

  const moved = registry.upsertFromPairing({ relayId: 'relay-b-0002', name: 'linux-test', url: 'https://relay-b2.example.test' });
  assert.equal(moved.id, known.id);
  assert.equal(moved.url, 'https://relay-b.example.test', 'the stored address stays');
  assert.equal(moved.tokenMode, 'custom', 'the stored token stays');
  assert.equal(registry.get(known.id).token, CUSTOM_TOKEN);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /pairing from "linux-test" offered a different address https:\/\/relay-b2\.example\.test \(kept https:\/\/relay-b\.example\.test\) and a different token \(kept the stored one\)/);

  const otherToken = 'x'.repeat(48);
  registry.upsertFromPairing({ relayId: 'relay-b-0002', name: 'linux-test', url: 'https://relay-b.example.test', token: otherToken });
  assert.equal(registry.get(known.id).token, CUSTOM_TOKEN);
  assert.match(logs[1], /offered a different token \(kept the stored one\)/);
  const recorded = JSON.stringify({ logs, events });
  assert.ok(!recorded.includes(CUSTOM_TOKEN) && !recorded.includes(otherToken), 'no token in logs or events');

  const own = registry.add({ name: 'win-test', url: 'https://relay-a.example.test' });
  registry.upsertFromPairing({ relayId: 'relay-a-0001', name: 'win-test', url: 'https://relay-a.example.test', token: otherToken });
  assert.equal(registry.get(own.id).tokenMode, 'own', 'an entry on our own token stays on it');
  assert.equal(registry.get(own.id).token, undefined);
});

test('check records identity; a rename keeps the id and the unlocks', async () => {
  const db = new Database(':memory:');
  applySchema(db);
  const repository = createRemoteRelayRepository(db);
  const answers = { 'https://relay-b.example.test': identity() };
  const { registry, client, events } = setup({ answers, repository });
  const entry = registry.add({ name: 'relay-b.example.test', url: 'https://relay-b.example.test', token: CUSTOM_TOKEN });
  repository.recordUnlock('c-1', entry.id, 'm-1');

  const checked = await registry.check(entry.id);
  assert.equal(client.probes[0].token, CUSTOM_TOKEN, 'the probe uses the entry token');
  assert.equal(checked.lastStatus, 'online');
  assert.equal(checked.name, 'linux-test');
  assert.equal(checked.relayId, 'relay-b-0002');
  assert.equal(checked.version, '0.9.4');
  assert.equal(checked.platform, 'linux');
  assert.equal(checked.protocol, 1);
  assert.ok(checked.lastSeenAt);
  assert.equal(checked.token, undefined);

  answers['https://relay-b.example.test'] = identity({ name: 'linux-renamed', version: '0.9.5' });
  const eventsBefore = events.length;
  const renamed = await registry.check(entry.id);
  assert.equal(renamed.id, entry.id);
  assert.equal(renamed.name, 'linux-renamed');
  assert.equal(registry.resolve('linux-renamed').relay.id, entry.id, 'the new name resolves');
  assert.equal(registry.resolve('linux-test').error, 'unknown', 'the old name no longer does');
  assert.equal(repository.hasUnlock('c-1', entry.id), true, 'unlocks are keyed by id');
  assert.equal(events.length, eventsBefore + 1);

  const quiet = events.length;
  await registry.check(entry.id);
  assert.equal(events.length, quiet, 'an unchanged remote emits nothing (lastSeenAt aside)');
  assert.equal(await registry.check('missing'), null);
});

test('check maps failures to a status and keeps the entry', async () => {
  const answers = {};
  const { registry } = setup({ answers });
  const entry = registry.add({ name: 'linux-test', url: 'https://relay-b.example.test' });
  // The row already names the relay, and a probe only knows the host: the
  // stored text keeps the predicate.
  const cases = [
    [new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.offline, 'Relay "relay-b.example.test" is not reachable (timed out after 10 s)'), 'offline', 'Not reachable (timed out after 10 s)'],
    [new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.unauthorized, 'Relay "linux-test" rejected the token (401)', { status: 401 }), 'unauthorized', 'Rejected the token (401)'],
    [new RemoteRelayError('REMOTE_RELAY_HTTP_530', 'Relay "linux-test" answered HTTP 530', { status: 530 }), 'offline', 'Answered HTTP 530'],
    [new RemoteRelayError('REMOTE_RELAY_HTTP_500', 'The remote relay answered HTTP 500: boom', { status: 500 }), 'error', 'Answered HTTP 500: boom'],
    [new Error('socket hang up'), 'error', 'socket hang up'],
  ];
  for (const [error, status, lastError] of cases) {
    answers['https://relay-b.example.test'] = error;
    const checked = await registry.check(entry.id);
    assert.equal(checked.lastStatus, status, error.code);
    assert.equal(checked.lastError, lastError);
  }
  answers['https://relay-b.example.test'] = identity();
  const back = await registry.check(entry.id);
  assert.equal(back.lastStatus, 'online');
  assert.equal(back.lastError, null);
});

test('an address that answers with our own relayId is flagged, not trusted', async () => {
  const { registry } = setup({ answers: { 'https://relay-a.example.test': identity({ relayId: 'uuid-1', name: 'win-test' }) } });
  registry.instanceId();
  const entry = registry.add({ name: 'loop', url: 'https://relay-a.example.test' });
  const checked = await registry.check(entry.id);
  assert.equal(checked.lastStatus, 'error');
  assert.match(checked.lastError, /itself/);
  assert.equal(checked.name, 'loop');
  assert.equal(checked.relayId, null);
});

test('the health loop checks every remote on an unref-ed interval and emits once per change', async () => {
  const answers = {
    'https://relay-a.example.test': identity({ relayId: 'relay-a-0001', name: 'win-test', platform: 'win32' }),
    'https://relay-b.example.test': identity(),
  };
  const store = createSettingsStore();
  const client = createFakeClient(answers);
  const events = [];
  const timers = [];
  let cleared = null;
  let ids = 0;
  const registry = createRemoteRelayRegistry({
    ...store,
    client,
    getSelfName: () => 'self-test',
    hostname: 'devbox',
    platform: 'linux',
    version: '0.9.4',
    emit: (event, payload) => events.push({ event, payload }),
    logger: { warn() {} },
    randomUUID: () => `uuid-${++ids}`,
    setIntervalImpl: (fn, ms) => {
      const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl: (timer) => { cleared = timer; },
  });
  registry.add({ name: 'relay-a.example.test', url: 'https://relay-a.example.test' });
  registry.add({ name: 'relay-b.example.test', url: 'https://relay-b.example.test', token: CUSTOM_TOKEN });
  events.length = 0;

  registry.startHealthLoop({ immediate: false });
  registry.startHealthLoop({ immediate: false });
  assert.equal(timers.length, 1, 'starting twice keeps one interval');
  assert.equal(timers[0].ms, REMOTE_RELAY_LIMITS.healthIntervalMs);
  assert.equal(timers[0].unrefCalled, true);
  assert.equal(registry.healthLoopRunning, true);

  timers[0].fn();
  await registry.checkAll();
  assert.equal(client.probes.length, 2);
  assert.ok(client.probes.every((probe) => probe.options.timeoutMs === 10_000), 'health checks use the 10 s budget');
  assert.equal(events.length, 1, 'one event for the whole pass');
  assert.deepEqual(events[0].payload.relays.map((relay) => [relay.name, relay.lastStatus]), [['win-test', 'online'], ['linux-test', 'online']]);
  assert.equal(events[0].payload.self.name, 'self-test');
  assert.equal(JSON.stringify(events).includes(CUSTOM_TOKEN), false);

  await registry.checkAll();
  assert.equal(events.length, 1, 'nothing changed, nothing emitted');

  answers['https://relay-b.example.test'] = new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.offline, 'not reachable');
  await registry.checkAll();
  assert.equal(events.length, 2);
  assert.equal(events[1].payload.relays[1].lastStatus, 'offline');

  registry.stopHealthLoop();
  assert.equal(cleared, timers[0]);
  assert.equal(registry.healthLoopRunning, false);
});

test('the health loop runs a first pass immediately by default', async () => {
  const store = createSettingsStore({
    [REMOTE_RELAY_SETTING_KEYS.relays]: JSON.stringify([{ id: 'rr_1', name: 'linux-test', url: 'https://relay-b.example.test' }]),
  });
  const client = createFakeClient({ 'https://relay-b.example.test': identity() });
  const registry = createRemoteRelayRegistry({
    ...store,
    client,
    logger: { warn() {} },
    randomUUID: () => 'uuid-self',
    setIntervalImpl: (fn) => ({ fn }),
    clearIntervalImpl: () => {},
  });
  registry.startHealthLoop();
  await registry.checkAll();
  assert.equal(client.probes.length, 1, 'the in-flight first pass is shared, not repeated');
  assert.equal(registry.get('rr_1').lastStatus, 'online');
  registry.stopHealthLoop();
});
