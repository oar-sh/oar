import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REMOTE_RELAY_NO_CREDENTIAL_TOKEN, createRemoteRelayRegistry } from './remote-relay-registry-service.mjs';
import { RemoteRelayError, createRemoteRelayClient } from './remote-relay-client.mjs';
import { createOwnerSecretStore } from './owner-secret-store.mjs';
import { applySchema } from '../db-schema.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import {
  AGENT_SESSIONS_SOCKET_EVENT,
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

function setup({ settings = {}, answers = {}, repository = null, selfName = 'win-test', clock, onRemove } = {}) {
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
    getSelfName: () => selfName,
    hostname: 'devbox',
    platform: 'win32',
    version: '0.9.4',
    now: clock || (() => new Date(Date.UTC(2026, 8, 20, 10, 0, tick++))),
    emit: (event, payload) => events.push({ event, payload }),
    logger: { warn: (line) => logs.push(String(line)) },
    randomUUID: () => `uuid-${++ids}`,
    ...(onRemove ? { onRemove } : {}),
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

test('the owner\'s self block names the default, and a relay-name change is announced', () => {
  const { registry, events } = setup();
  assert.equal(registry.selfPayload().name, 'win-test');
  assert.equal(registry.selfPayload().defaultName, 'devbox');
  assert.equal('defaultName' in registry.selfIdentity(), false, 'other relays never see it');
  registry.notifySelfChanged();
  assert.equal(events.at(-1).event, REMOTE_RELAY_SOCKET_EVENT);
  assert.equal(events.at(-1).payload.self.defaultName, 'devbox');
});

test('selfIdentity reports the injected platform and version, the protocol and that it takes images', () => {
  const { registry } = setup({ settings: { [REMOTE_RELAY_SETTING_KEYS.publicUrl]: JSON.stringify('https://relay-a.example.test') } });
  assert.deepEqual(registry.selfIdentity(), {
    relayId: 'uuid-1',
    name: 'win-test',
    version: '0.9.4',
    platform: 'win32',
    publicUrl: 'https://relay-a.example.test',
    remoteRelays: { protocol: 2, inbound: true, imageInputs: true, peerKeys: true, inboundKeys: true },
    capabilities: { answerLink: true },
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
  assert.equal(own.relay.tokenMode, 'none', 'own (this relay\'s token) is never sent any more: none');
  assert.equal(registry.get(entry.id).token, undefined, 'switching to own drops the stored token');

  const quiet = events.length;
  assert.equal(registry.update(entry.id, { permission: 'read', tokenMode: 'own' }).ok, true);
  assert.equal(events.length, quiet, 'a no-op update emits nothing');
});

test('remove deletes the entry, forgets its unlocks and watch approvals, and hands the entry on', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const repository = createRemoteRelayRepository(db);
  const removed = [];
  const { registry, events } = setup({ repository, onRemove: (entry) => removed.push(entry) });
  const linux = registry.add({ name: 'linux-test', url: 'https://relay-b.example.test', token: 'fixture-token-b' });
  const win = registry.add({ name: 'win-test', url: 'https://relay-a.example.test' });
  repository.recordUnlock('c-1', linux.id, 'm-1');
  repository.recordUnlock('c-1', `${linux.id}:watch`, 'm-1');
  repository.recordUnlock('c-1', win.id, 'm-1');

  assert.deepEqual(registry.remove(linux.id), { ok: true });
  assert.deepEqual(registry.list().map((entry) => entry.id), [win.id]);
  assert.equal(repository.hasUnlock('c-1', linux.id), false);
  assert.equal(repository.hasUnlock('c-1', `${linux.id}:watch`), false);
  // The event link still needs the address and token to say goodbye.
  assert.deepEqual([removed.length, removed[0].id, removed[0].url, removed[0].token], [1, linux.id, 'https://relay-b.example.test', 'fixture-token-b']);
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
  assert.equal(registry.get(own.id).tokenMode, 'none', 'an entry with no token stays without one');
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

test('check keeps whether the relay\'s page answers `?answer=` (answerLink), and drops it after a downgrade', async () => {
  const answers = { 'https://relay-b.example.test': identity({ answerLink: true }) };
  const { registry } = setup({ answers });
  const entry = registry.add({ name: 'linux-test', url: 'https://relay-b.example.test', token: CUSTOM_TOKEN });
  assert.equal(entry.answerLink, undefined);
  assert.equal((await registry.check(entry.id)).answerLink, true);
  assert.equal(registry.listPublic()[0].answerLink, true);
  answers['https://relay-b.example.test'] = identity({ answerLink: false });
  assert.equal((await registry.check(entry.id)).answerLink, undefined);
  assert.equal(registry.listPublic()[0].answerLink, undefined);
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

test('agent sessions are off by default, wait 600 s at most, and say so in one shape', () => {
  const { registry, events } = setup();
  assert.deepEqual(registry.getAgentSessionsSettings(), {
    enabled: false,
    maxWaitSeconds: 600,
    limits: { minWaitSeconds: 120, maxWaitSeconds: 3600, stepSeconds: 60 },
    maxActiveSessions: 4,
  });
  assert.deepEqual(events, [], 'reading emits nothing');
});

test('agent sessions settings are stored as JSON values and announced with the read shape', () => {
  const { registry, store, events } = setup();
  const saved = registry.setAgentSessionsSettings({ enabled: true, maxWaitSeconds: 1800 });
  assert.equal(saved.ok, true);
  assert.equal(saved.enabled, true);
  assert.equal(saved.maxWaitSeconds, 1800);
  assert.equal(store.values.get(REMOTE_RELAY_SETTING_KEYS.agentSessionsEnabled), 'true');
  assert.equal(store.values.get(REMOTE_RELAY_SETTING_KEYS.maxWaitSeconds), '1800');
  assert.deepEqual(events, [{ event: AGENT_SESSIONS_SOCKET_EVENT, payload: registry.getAgentSessionsSettings() }]);
  assert.equal('ok' in events[0].payload, false, 'the event carries the GET shape');

  // One field at a time; the other keeps its value.
  assert.equal(registry.setAgentSessionsSettings({ enabled: false }).maxWaitSeconds, 1800);
  assert.equal(registry.setAgentSessionsSettings({ maxWaitSeconds: 120 }).enabled, false);
  assert.equal(events.length, 3);
});

test('agent sessions settings refuse values outside the range or off the step, and store nothing', () => {
  const { registry, store, events } = setup();
  for (const patch of [
    { enabled: 'true' },
    { maxWaitSeconds: 119 },
    { maxWaitSeconds: 3601 },
    { maxWaitSeconds: 150 },
    { maxWaitSeconds: '600' },
    { maxWaitSeconds: Number.NaN },
    { enabled: true, maxWaitSeconds: 1 },
  ]) {
    const refused = registry.setAgentSessionsSettings(patch);
    assert.equal(refused.ok, false, JSON.stringify(patch));
    assert.equal(refused.status, 400);
    assert.match(refused.error, /enabled must be|maxWaitSeconds must be/);
  }
  assert.equal(store.values.size, 0);
  assert.deepEqual(events, []);
});

test('a stored wait outside the range reads as the nearest bound, a broken one as the default', () => {
  const read = (value) => setup({ settings: { [REMOTE_RELAY_SETTING_KEYS.maxWaitSeconds]: value } }).registry.getAgentSessionsSettings().maxWaitSeconds;
  assert.equal(read('9000'), 3600);
  assert.equal(read('30'), 120);
  assert.equal(read('"soon"'), 600);
  assert.equal(read('900'), 900);
  const on = (value) => setup({ settings: { [REMOTE_RELAY_SETTING_KEYS.agentSessionsEnabled]: value } }).registry.getAgentSessionsSettings().enabled;
  assert.equal(on('true'), true);
  assert.equal(on('false'), false);
  assert.equal(on('"maybe"'), false, 'anything but a clear yes is off');
});

test('moving the owner token out of the config: every `own` entry keeps that token as its own, once', () => {
  // `own` entries come from before this version only.
  const legacy = [{ id: 'rr_legacy-own', url: 'https://relay-b.example.test', name: 'linux-test', tokenMode: 'own' }];
  const { registry, events } = setup({ settings: { [REMOTE_RELAY_SETTING_KEYS.relays]: JSON.stringify(legacy) } });
  const own = registry.get('rr_legacy-own');
  const custom = registry.add({ url: 'https://relay-c.example.test', name: 'mac-test', token: CUSTOM_TOKEN });
  const tokenless = registry.add({ url: 'https://relay-d.example.test', name: 'lan-test' });
  assert.equal(registry.get(own.id).tokenMode, 'own');
  assert.equal(registry.get(tokenless.id).tokenMode, 'none', 'a new entry without a token is none, never own');
  const before = events.length;
  assert.equal(registry.convertOwnEntries(OWN_TOKEN), 1);
  assert.deepEqual({ mode: registry.get(own.id).tokenMode, token: registry.get(own.id).token }, { mode: 'custom', token: OWN_TOKEN });
  assert.equal(registry.get(custom.id).token, CUSTOM_TOKEN, 'an entry with its own token is left alone');
  assert.deepEqual({ mode: registry.get(tokenless.id).tokenMode, token: registry.get(tokenless.id).token }, { mode: 'none', token: undefined }, 'a tokenless entry never gets the owner token');
  assert.ok(events.length > before, 'the change is announced');
  assert.equal(JSON.stringify(registry.listPublic()).includes(OWN_TOKEN), false, 'never in a payload');
  assert.equal(registry.convertOwnEntries(OWN_TOKEN), 0, 'nothing left to convert');
  assert.equal(registry.convertOwnEntries(''), 0);
});

test('the migration boot never gives the owner token to a keyed, one-way, inbound-only or introduced entry', () => {
  const PEER_KEY = `oarp1_${'k'.repeat(43)}`;
  // A `peer` entry whose key was lost reads as none, never as own.
  const stored = [{ id: 'rr_lost-key', url: 'https://relay-e.example.test', name: 'lost-key-test', relayId: 'relay-e-0005', tokenMode: 'peer' }];
  const { registry } = setup({ settings: { [REMOTE_RELAY_SETTING_KEYS.relays]: JSON.stringify(stored) } });
  const oneWay = registry.add({ url: 'https://relay-b.example.test', name: 'linux-test', relayId: 'relay-b-0002', tokenMode: 'peer', peerToken: PEER_KEY, peerTokenSeq: 1, peerInboundOnly: true });
  const { entry: holder } = registry.upsertInboundHolder({ relayId: 'relay-c-0003', name: 'mac-test', protocol: 2 });
  const introduced = registry.upsertFromPairing({ relayId: 'relay-d-0004', name: 'lan-test', url: 'https://relay-d.example.test', protocol: 2 });
  const adopted = registry.upsertInboundHolder({ relayId: 'relay-f-0006', name: 'adopted-test' }).entry;
  registry.adoptInboundHolder(adopted.id, { url: 'https://relay-f.example.test', tokenMode: 'none', addedBy: 'user' });
  assert.deepEqual(
    [oneWay.id, holder.id, introduced.id, adopted.id, 'rr_lost-key'].map((id) => registry.get(id).tokenMode),
    ['peer', 'none', 'none', 'none', 'none'],
  );
  assert.equal(registry.convertOwnEntries(OWN_TOKEN), 0);
  for (const entry of registry.listAll()) {
    assert.notEqual(entry.token, OWN_TOKEN, entry.name);
    assert.notEqual(createRemoteRelayClient({ fetchImpl: async () => { throw new Error('no network'); } }).tokenFor(entry), OWN_TOKEN, entry.name);
  }
  assert.ok(registry.get(oneWay.id).peerToken === PEER_KEY, 'the one-way key is kept');
});

// ─── FIXTURE: OAR 0.9.26's token selection, copied from release commit 86a3db6e ───
// server/services/remote-relay-registry-service.mjs (readList + normalizeEntry,
// reduced to the fields that pick the token) and remote-relay-client.mjs
// (tokenFor). Kept as it shipped; do not "fix" it: it is what a relay
// downgraded to 0.9.26 runs over the entries this version stored.
function v0926NormalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const toText = (value) => (typeof value === 'string' ? value.trim() : '');
  const id = toText(raw.id);
  const url = toText(raw.url).replace(/\/+$/, '');
  if (!id || !url) return null;
  const token = toText(raw.token);
  const tokenMode = raw.tokenMode === 'custom' && token ? 'custom' : 'own';
  return { id, url, tokenMode, ...(tokenMode === 'custom' ? { token } : {}) };
}
function v0926TokenFor(relay, getOwnToken) {
  const toText = (value) => (typeof value === 'string' ? value.trim() : '');
  return relay?.tokenMode === 'custom'
    ? toText(relay?.token)
    : toText(getOwnToken?.());
}
// ─── end of fixture ───

test('downgrade: OAR 0.9.26 reading what this version stored never picks its owner token for a keyed, one-way, tokenless or inbound-only entry', () => {
  const PEER_KEY = `oarp1_${'k'.repeat(43)}`;
  const { registry, store } = setup();
  const keyed = registry.add({ url: 'https://relay-b.example.test', name: 'linux-test', relayId: 'relay-b-0002', tokenMode: 'custom', token: CUSTOM_TOKEN, protocol: 2 });
  // The key worked: the token held for it is dropped (noteHeldKeyWorked).
  registry.patchPeerFields(keyed.id, { tokenMode: 'peer', token: undefined, peerToken: PEER_KEY, peerTokenSeq: 1 });
  const oneWay = registry.add({ url: 'https://relay-c.example.test', name: 'mac-test', relayId: 'relay-c-0003', tokenMode: 'peer', peerToken: PEER_KEY, peerTokenSeq: 1, peerInboundOnly: true });
  const introduced = registry.upsertFromPairing({ relayId: 'relay-d-0004', name: 'lan-test', url: 'https://relay-d.example.test', protocol: 2 });
  const { entry: holder } = registry.upsertInboundHolder({ relayId: 'relay-e-0005', name: 'inbound-test', protocol: 2 });
  const older = registry.add({ url: 'https://relay-f.example.test', name: 'old-test', relayId: 'relay-f-0006', tokenMode: 'custom', token: CUSTOM_TOKEN });
  assert.deepEqual(
    [keyed.id, oneWay.id, introduced.id, holder.id, older.id].map((id) => registry.get(id).tokenMode),
    ['peer', 'peer', 'none', 'none', 'custom'],
  );

  const stored = JSON.parse(store.values.get(REMOTE_RELAY_SETTING_KEYS.relays));
  const picked = stored.map(v0926NormalizeEntry).filter(Boolean).map((entry) => [entry.id, v0926TokenFor(entry, () => OWN_TOKEN)]);
  assert.equal(picked.some(([, token]) => token === OWN_TOKEN), false, 'never the owner token');
  assert.equal(new Set(picked.map(([id]) => id)).has(holder.id), false, 'an inbound-only entry (no address) is dropped by 0.9.26');
  assert.deepEqual(Object.fromEntries(picked), {
    [keyed.id]: REMOTE_RELAY_NO_CREDENTIAL_TOKEN,
    [oneWay.id]: REMOTE_RELAY_NO_CREDENTIAL_TOKEN,
    [introduced.id]: REMOTE_RELAY_NO_CREDENTIAL_TOKEN,
    [older.id]: CUSTOM_TOKEN,
  });

  // This version reads the placeholder back as no credential: modes and keys
  // survive a restart, and the placeholder is never sent or shown.
  const reread = setup({ settings: { [REMOTE_RELAY_SETTING_KEYS.relays]: store.values.get(REMOTE_RELAY_SETTING_KEYS.relays) } }).registry;
  assert.deepEqual(
    [keyed.id, oneWay.id, introduced.id, holder.id, older.id].map((id) => reread.get(id).tokenMode),
    ['peer', 'peer', 'none', 'none', 'custom'],
  );
  const client = createRemoteRelayClient({ fetchImpl: async () => { throw new Error('no network'); } });
  for (const entry of reread.listAll()) {
    assert.notEqual(entry.token, REMOTE_RELAY_NO_CREDENTIAL_TOKEN, entry.name);
    assert.notEqual(client.tokenFor(entry), REMOTE_RELAY_NO_CREDENTIAL_TOKEN, entry.name);
  }
  assert.equal(client.tokenFor(reread.get(keyed.id)), PEER_KEY);
  assert.equal(client.tokenFor(reread.get(introduced.id)), '');
  assert.equal(JSON.stringify(reread.listPublic()).includes(REMOTE_RELAY_NO_CREDENTIAL_TOKEN), false);

  // An entry 0.9.26 wrote back (its own fields only: no `credential`, no key)
  // reads as no credential, never as own.
  const rewritten = stored.map(v0926NormalizeEntry).filter(Boolean);
  const after = setup({ settings: { [REMOTE_RELAY_SETTING_KEYS.relays]: JSON.stringify(rewritten) } }).registry;
  assert.deepEqual(after.listAll().map((entry) => [entry.id, entry.tokenMode]).sort(), [
    [keyed.id, 'none'], [oneWay.id, 'none'], [introduced.id, 'none'], [older.id, 'custom'],
  ].sort());
});

test('an inbound-only entry: no address, never called, listed apart; it becomes a normal entry in place, and a listed relay gets none', async () => {
  const { registry, client, events } = setup();
  const { entry: holder, created } = registry.upsertInboundHolder({ relayId: 'relay-c-0003', name: 'mac-test', protocol: 2, version: '0.9.27' });
  assert.equal(created, true);
  assert.deepEqual([holder.inboundOnly, holder.url, holder.tokenMode, holder.name], [true, '', 'none', 'mac-test']);
  assert.equal(events.at(-1).event, REMOTE_RELAY_SOCKET_EVENT);
  assert.deepEqual(events.at(-1).payload.inbound.map((item) => item.id), [holder.id]);
  assert.deepEqual(events.at(-1).payload.relays, []);
  // Not among the relays this relay calls, resolves or probes.
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(registry.listPublic(), []);
  assert.deepEqual(registry.listAll().map((entry) => entry.id), [holder.id]);
  assert.equal(registry.resolve('mac-test').error, 'unknown');
  assert.equal(await registry.checkAll(), false);
  await registry.check(holder.id);
  assert.deepEqual(client.probes, []);
  const [row] = registry.listInboundPublic();
  assert.deepEqual([row.inboundOnly, row.host, row.httpWarning], [true, '', null]);
  // Nothing to edit; the owner token never becomes its token.
  assert.equal(registry.update(holder.id, { permission: 'read' }).status, 409);
  assert.equal(registry.convertOwnEntries(OWN_TOKEN), 0);
  assert.equal(registry.get(holder.id).token, undefined);
  // Asked again: the same entry, refreshed.
  const again = registry.upsertInboundHolder({ relayId: 'relay-c-0003', name: 'mac-test-2' });
  assert.deepEqual([again.created, again.entry.id, again.entry.name], [false, holder.id, 'mac-test-2']);
  // A relay listed both ways gets no inbound-only entry.
  const listed = registry.add({ url: 'https://relay-b.example.test', name: 'linux-test', relayId: 'relay-b-0002', token: CUSTOM_TOKEN });
  assert.throws(() => registry.upsertInboundHolder({ relayId: 'relay-b-0002' }), (error) => error.status === 409);
  assert.equal(registry.listAll().length, 2);
  // Its introduction (pairing back) makes the same entry a normal one,
  // unconfirmed until probed, with its keys and epoch moved on.
  registry.patchPeerFields(holder.id, { peerKeys: [{ hash: 'a'.repeat(64), seq: 1, issuedAt: '2026-09-20T10:00:00.000Z', confirmedAt: '2026-09-20T10:00:01.000Z' }], everKeyed: true, keyRelayId: 'relay-c-0003' });
  const adopted = registry.upsertFromPairing({ relayId: 'relay-c-0003', name: 'mac-test', url: 'https://relay-c.example.test', protocol: 2 });
  assert.equal(adopted.id, holder.id);
  assert.deepEqual([adopted.inboundOnly, adopted.url, adopted.addedBy, adopted.unconfirmed, adopted.peerKeys.length, adopted.epoch, adopted.everKeyed], [undefined, 'https://relay-c.example.test', 'pairing', true, 0, 1, false]);
  assert.deepEqual(registry.list().map((entry) => entry.id).sort(), [listed.id, holder.id].sort());
  assert.deepEqual(registry.listInboundPublic(), []);
  // A stored inbound-only entry without a relay id is dropped on read.
  const broken = setup({ settings: { [REMOTE_RELAY_SETTING_KEYS.relays]: JSON.stringify([{ id: 'rr_x', inboundOnly: true, name: 'no-id' }]) } });
  assert.deepEqual(broken.registry.listAll(), []);
});

test('a boot that did not move the token out of the config converts nothing and sends nothing to a tokenless relay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-registry-convert-'));
  const quiet = { log() {}, warn() {} };
  try {
    const configPath = path.join(dir, 'config.json');
    const dataDir = path.join(dir, 'data');
    const first = crypto.randomUUID();
    fs.writeFileSync(configPath, JSON.stringify({ authToken: first }));
    createOwnerSecretStore({ dataDir, logger: quiet }).bootstrap({ config: { authToken: first }, configPath });

    // Later boots that know a plain token: one put back into the config, and
    // a --token on the command line.
    const reappeared = crypto.randomUUID();
    const handEdit = createOwnerSecretStore({ dataDir, logger: quiet });
    assert.equal(handEdit.bootstrap({ config: { authToken: reappeared }, configPath }).change, 'config-reappeared');
    const argv = createOwnerSecretStore({ dataDir, logger: quiet });
    argv.bootstrap({ config: {}, configPath, argvToken: crypto.randomUUID() });

    for (const store of [handEdit, argv]) {
      const { registry } = setup();
      const tokenless = registry.add({ url: 'https://relay-b.example.test', name: 'linux-test' });
      assert.equal(store.migratedOwnerToken(), '', 'only the migration boot hands the token to the pairing conversion');
      assert.equal(registry.convertOwnEntries(store.migratedOwnerToken()), 0);
      const stored = registry.get(tokenless.id);
      assert.deepEqual({ mode: stored.tokenMode, token: stored.token }, { mode: 'none', token: undefined });
      assert.equal(createRemoteRelayClient({ fetchImpl: async () => { throw new Error('no network'); } }).tokenFor(stored), '', 'nothing is sent');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
