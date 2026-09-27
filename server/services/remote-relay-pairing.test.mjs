import test from 'node:test';
import assert from 'node:assert/strict';

import { createRemoteRelayPairing } from './remote-relay-pairing.mjs';
import { createRemoteRelayRegistry } from './remote-relay-registry-service.mjs';
import { RemoteRelayError } from './remote-relay-client.mjs';
import { REMOTE_RELAY_ERROR_CODES, REMOTE_RELAY_SETTING_KEYS } from '../../shared/remote-relay-contract.mjs';

const OWN_TOKEN = 'o'.repeat(36);
const OTHER_TOKEN = 'p'.repeat(64);
const LINK_TOKEN = 'l'.repeat(40);
const OWN_ID = 'relay-self-0001';

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

/**
 * A client double. `probe` answers per URL (an Error is thrown); `request`
 * records the call and answers with `requestAnswer` (an Error is thrown).
 */
function createFakeClient({ probeAnswers = {}, requestAnswer = { ok: true, relayId: 'relay-b-0002', name: 'linux-test' } } = {}) {
  const probes = [];
  const requests = [];
  return {
    probes,
    requests,
    probeAnswers,
    setRequestAnswer(value) { requestAnswer = value; },
    tokenFor: (relay) => (relay?.tokenMode === 'custom' ? relay.token : OWN_TOKEN),
    async probe(url, token, options) {
      probes.push({ url, token, options });
      const answer = probeAnswers[url];
      if (answer instanceof Error) throw answer;
      if (!answer) throw new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.offline, `Relay "${new URL(url).hostname}" is not reachable (ECONNREFUSED)`);
      return answer;
    },
    async request(relay, method, path, options = {}) {
      requests.push({ relay, method, path, options, token: this.tokenFor(relay) });
      if (requestAnswer instanceof Error) throw requestAnswer;
      return requestAnswer;
    },
  };
}

function setup({ settings = {}, probeAnswers, requestAnswer } = {}) {
  const values = new Map(Object.entries({
    [REMOTE_RELAY_SETTING_KEYS.instanceId]: JSON.stringify(OWN_ID),
    ...settings,
  }));
  const client = createFakeClient({ probeAnswers, requestAnswer });
  const events = [];
  let ids = 0;
  const registry = createRemoteRelayRegistry({
    readSetting: (key) => values.get(key) ?? null,
    writeSetting: (key, value) => values.set(key, value),
    client,
    getSelfName: () => 'win-test',
    hostname: 'devbox',
    platform: 'win32',
    version: '0.9.4',
    emit: (event, payload) => events.push({ event, payload }),
    logger: { warn() {} },
    randomUUID: () => `uuid-${++ids}`,
  });
  const pairing = createRemoteRelayPairing({ registry, client, getOwnToken: () => OWN_TOKEN });
  return { pairing, registry, client, values, events };
}

const withPublicUrl = { [REMOTE_RELAY_SETTING_KEYS.publicUrl]: JSON.stringify('https://relay-a.example.test') };

test('a pasted web-client link is normalised and its ?token= becomes the candidate token', async () => {
  const { pairing, registry, client } = setup({
    probeAnswers: { 'https://relay-b.example.test/oar': identity() },
  });
  const result = await pairing.addFromLink({
    url: `relay-b.example.test/oar/index.html?token=${LINK_TOKEN}&push_conv=c-9#top`,
    pairBack: false,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(client.probes.map(({ url, token }) => ({ url, token })), [{ url: 'https://relay-b.example.test/oar', token: LINK_TOKEN }]);
  assert.equal(result.relay.url, 'https://relay-b.example.test/oar');
  assert.equal(result.relay.name, 'linux-test');
  assert.equal(result.relay.lastStatus, 'online');
  assert.equal(result.relay.addedBy, 'user');
  assert.equal(result.relay.tokenMode, 'custom');
  assert.equal(result.relay.token, undefined, 'the answer never carries a token');
  assert.equal(result.pairedBack, false);
  assert.equal(result.updated, false);
  assert.equal(registry.list()[0].token, LINK_TOKEN);
  assert.equal(JSON.stringify(result).includes(LINK_TOKEN), false);
});

test('token order: explicit field, then the link token, then our own token', async () => {
  const probeAnswers = { 'https://relay-b.example.test': identity() };
  const explicit = setup({ probeAnswers });
  await explicit.pairing.addFromLink({ url: `https://relay-b.example.test/?token=${LINK_TOKEN}`, token: OTHER_TOKEN, pairBack: false });
  assert.equal(explicit.client.probes[0].token, OTHER_TOKEN);
  assert.equal(explicit.registry.list()[0].token, OTHER_TOKEN);

  const own = setup({ probeAnswers });
  const result = await own.pairing.addFromLink({ url: 'https://relay-b.example.test', pairBack: false });
  assert.equal(own.client.probes[0].token, OWN_TOKEN);
  assert.equal(result.relay.tokenMode, 'own', 'our own token working there means own mode');
  assert.equal(own.registry.list()[0].token, undefined, 'and nothing is stored');

  const sameAsOwn = setup({ probeAnswers });
  await sameAsOwn.pairing.addFromLink({ url: 'https://relay-b.example.test', token: OWN_TOKEN, pairBack: false });
  assert.equal(sameAsOwn.registry.list()[0].tokenMode, 'own');
});

test('an invalid or plain-http public address is refused before any probe', async () => {
  const { pairing, client } = setup();
  const empty = await pairing.addFromLink({ url: '' });
  assert.equal(empty.ok, false);
  assert.equal(empty.status, 400);
  const plain = await pairing.addFromLink({ url: 'http://relay-b.example.test' });
  assert.equal(plain.status, 400);
  assert.match(plain.error, /http/);
  assert.equal(client.probes.length, 0);
});

test('a 401 asks for the token and saves nothing', async () => {
  const { pairing, registry } = setup({
    probeAnswers: { 'https://relay-b.example.test': new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.unauthorized, 'rejected the token (401)', { status: 401 }) },
  });
  const result = await pairing.addFromLink({ url: 'https://relay-b.example.test' });
  assert.equal(result.ok, false);
  assert.equal(result.needsToken, true);
  assert.equal(result.status, 200);
  assert.equal(registry.list().length, 0);
});

test('an unreachable relay is a 502 and saves nothing', async () => {
  const { pairing, registry } = setup();
  const result = await pairing.addFromLink({ url: 'https://relay-b.example.test' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.equal(result.code, REMOTE_RELAY_ERROR_CODES.offline);
  assert.equal(registry.list().length, 0);
});

test('adding this relay itself is refused', async () => {
  const { pairing, registry } = setup({
    probeAnswers: { 'https://relay-a.example.test': identity({ relayId: OWN_ID, name: 'win-test' }) },
  });
  const result = await pairing.addFromLink({ url: 'https://relay-a.example.test' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, 'SELF');
  assert.equal(registry.list().length, 0);
});

test('the same relay under a second URL updates the entry instead of duplicating it', async () => {
  const { pairing, registry } = setup({
    probeAnswers: {
      'https://relay-b.example.test': identity(),
      'https://relay-b2.example.test': identity({ name: 'linux-renamed' }),
    },
  });
  const first = await pairing.addFromLink({ url: 'https://relay-b.example.test', token: OTHER_TOKEN, pairBack: false });
  registry.update(first.relay.id, { permission: 'read' });
  const second = await pairing.addFromLink({ url: 'https://relay-b2.example.test', pairBack: false });
  assert.equal(second.ok, true);
  assert.equal(second.updated, true);
  assert.equal(second.relay.id, first.relay.id);
  assert.equal(second.relay.url, 'https://relay-b2.example.test');
  assert.equal(second.relay.name, 'linux-renamed');
  assert.equal(second.relay.permission, 'read', 'the chosen permission survives');
  assert.equal(second.relay.tokenMode, 'own', 'the token that just worked is the one kept');
  assert.equal(registry.list().length, 1);
});

test('an older relay (protocol 0) is deduplicated by URL and never paired back', async () => {
  const legacy = identity({ relayId: null, protocol: 0, publicUrl: null });
  const { pairing, registry, client } = setup({ settings: withPublicUrl, probeAnswers: { 'https://relay-b.example.test': legacy } });
  const first = await pairing.addFromLink({ url: 'https://relay-b.example.test' });
  assert.equal(first.ok, true);
  assert.equal(first.pairedBack, false);
  assert.match(first.pairBackError, /older OAR/);
  const again = await pairing.addFromLink({ url: 'https://relay-b.example.test/' });
  assert.equal(again.relay.id, first.relay.id);
  assert.equal(registry.list().length, 1);
  assert.equal(client.requests.length, 0);
});

test('pair-back introduces this relay without a token when ours worked there', async () => {
  const { pairing, client } = setup({ settings: withPublicUrl, probeAnswers: { 'https://relay-b.example.test': identity() } });
  const result = await pairing.addFromLink({ url: 'https://relay-b.example.test' });
  assert.equal(result.pairedBack, true);
  assert.equal(result.pairBackError, undefined);
  assert.equal(client.requests.length, 1);
  const [call] = client.requests;
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/api/remote-relays/pair');
  assert.equal(call.relay.url, 'https://relay-b.example.test');
  assert.equal(call.token, OWN_TOKEN, 'the call itself uses the token that worked');
  assert.deepEqual(call.options.body, {
    relayId: OWN_ID,
    name: 'win-test',
    url: 'https://relay-a.example.test',
    protocol: 1,
  });
});

test('pair-back sends our token only when the remote needed a different one', async () => {
  const { pairing, client } = setup({ settings: withPublicUrl, probeAnswers: { 'https://relay-b.example.test': identity() } });
  const result = await pairing.addFromLink({ url: 'https://relay-b.example.test', token: OTHER_TOKEN });
  assert.equal(result.pairedBack, true);
  const [call] = client.requests;
  assert.equal(call.token, OTHER_TOKEN, 'the remote is called with its own token');
  assert.equal(call.options.body.token, OWN_TOKEN, 'and told which token reaches us');
  assert.equal(JSON.stringify(result).includes(OWN_TOKEN), false);
  assert.equal(JSON.stringify(result).includes(OTHER_TOKEN), false);
});

test('pair-back is skipped without a public URL or when not requested', async () => {
  const noUrl = setup({ probeAnswers: { 'https://relay-b.example.test': identity() } });
  const skipped = await noUrl.pairing.addFromLink({ url: 'https://relay-b.example.test' });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.pairedBack, false);
  assert.match(skipped.pairBackError, /public URL/);
  assert.equal(noUrl.client.requests.length, 0);

  const off = setup({ settings: withPublicUrl, probeAnswers: { 'https://relay-b.example.test': identity() } });
  const notAsked = await off.pairing.addFromLink({ url: 'https://relay-b.example.test', pairBack: false });
  assert.equal(notAsked.pairedBack, false);
  assert.equal(notAsked.pairBackError, undefined);
  assert.equal(off.client.requests.length, 0);
});

test('a failed pair-back is reported and the entry stays', async () => {
  const { pairing, registry } = setup({
    settings: withPublicUrl,
    probeAnswers: { 'https://relay-b.example.test': identity() },
    requestAnswer: new RemoteRelayError('REMOTE_RELAY_HTTP_500', 'Relay "linux-test" answered HTTP 500: boom', { status: 500 }),
  });
  const result = await pairing.addFromLink({ url: 'https://relay-b.example.test' });
  assert.equal(result.ok, true);
  assert.equal(result.pairedBack, false);
  assert.match(result.pairBackError, /HTTP 500/);
  assert.equal(registry.list().length, 1);
});

test('selfUrl becomes the public URL once, when it passes the policy, and enables pair-back', async () => {
  const probeAnswers = { 'https://relay-b.example.test': identity(), 'https://relay-c.example.test': identity({ relayId: 'relay-c-0003', name: 'mac-test' }) };
  const { pairing, registry, client } = setup({ probeAnswers });
  const result = await pairing.addFromLink({ url: 'https://relay-b.example.test', selfUrl: 'https://relay-a.example.test/oar/?token=zzz' });
  assert.equal(registry.getSelfSettings().publicUrl, 'https://relay-a.example.test/oar');
  assert.equal(result.pairedBack, true);
  assert.equal(client.requests[0].options.body.url, 'https://relay-a.example.test/oar');

  await pairing.addFromLink({ url: 'https://relay-c.example.test', selfUrl: 'https://relay-z.example.test' });
  assert.equal(registry.getSelfSettings().publicUrl, 'https://relay-a.example.test/oar', 'an existing public URL is never overwritten');

  const refused = setup({ probeAnswers });
  await refused.pairing.addFromLink({ url: 'https://relay-b.example.test', selfUrl: 'http://relay-a.example.test' });
  assert.equal(refused.registry.getSelfSettings().publicUrl, '', 'a public plain-http origin is not adopted');
});

test('a private-network http relay is added with a warning', async () => {
  const { pairing } = setup({ probeAnswers: { 'http://192.168.10.20:3333': identity() } });
  const result = await pairing.addFromLink({ url: 'http://192.168.10.20:3333', pairBack: false });
  assert.equal(result.ok, true);
  assert.match(result.warning, /Plain http/);
  assert.match(result.relay.httpWarning, /Plain http/);
});

test('acceptPairing validates the introduction', async () => {
  const { pairing, registry } = setup();
  assert.equal((await pairing.acceptPairing({ url: 'https://relay-b.example.test' })).status, 400, 'relayId is required');
  assert.equal((await pairing.acceptPairing({ relayId: 'relay-b-0002', url: 'http://relay-b.example.test' })).status, 400);
  assert.equal((await pairing.acceptPairing({ relayId: 'relay-b-0002' })).status, 400, 'a URL is required');
  const self = await pairing.acceptPairing({ relayId: OWN_ID, url: 'https://relay-b.example.test' });
  assert.equal(self.status, 400);
  assert.equal(self.code, 'SELF');
  assert.equal(registry.list().length, 0);
});

test('acceptPairing stores the token for that remote only and never echoes it', async () => {
  const { pairing, registry, client, events } = setup({ probeAnswers: { 'https://relay-b.example.test': identity() } });
  const result = await pairing.acceptPairing({
    relayId: 'relay-b-0002',
    name: 'linux-test',
    url: 'https://relay-b.example.test/',
    protocol: 1,
    token: OTHER_TOKEN,
  });
  assert.deepEqual(result, { ok: true, relayId: OWN_ID, name: 'win-test' });
  const [entry] = registry.list();
  assert.equal(entry.addedBy, 'pairing');
  assert.equal(entry.permission, 'full');
  assert.equal(entry.tokenMode, 'custom');
  assert.equal(entry.token, OTHER_TOKEN);
  assert.equal(entry.lastStatus, 'online', 'reachability was verified');
  assert.equal(client.probes[0].token, OTHER_TOKEN);
  assert.equal(client.probes[0].options.timeoutMs, 5_000, 'the check stays inside the caller\'s request budget');
  assert.equal(JSON.stringify(events).includes(OTHER_TOKEN), false);

  const again = await pairing.acceptPairing({ relayId: 'relay-b-0002', name: 'linux-test', url: 'https://relay-b2.example.test' });
  assert.equal(again.ok, true);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0].url, 'https://relay-b.example.test', 'a known relay keeps its stored address');
  assert.equal(registry.list()[0].tokenMode, 'custom', 'and its stored token');
  assert.equal(registry.list()[0].token, OTHER_TOKEN);
});

test('acceptPairing of a new relay without a token uses this relay\'s own token for it', async () => {
  const { pairing, registry } = setup({ probeAnswers: { 'https://relay-b.example.test': identity() } });
  const result = await pairing.acceptPairing({ relayId: 'relay-b-0002', name: 'linux-test', url: 'https://relay-b.example.test', protocol: 1 });
  assert.equal(result.ok, true);
  const [entry] = registry.list();
  assert.equal(entry.tokenMode, 'own');
  assert.equal(entry.token, undefined);
  assert.equal(entry.protocol, 1);
});

test('acceptPairing keeps an unreachable relay, marked offline', async () => {
  const { pairing, registry } = setup();
  const result = await pairing.acceptPairing({ relayId: 'relay-b-0002', name: 'linux-test', url: 'https://relay-b.example.test' });
  assert.equal(result.ok, true);
  const [entry] = registry.list();
  assert.equal(entry.lastStatus, 'offline');
  assert.equal(entry.name, 'linux-test');
});
