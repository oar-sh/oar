import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPreviewRegistry,
  createPreviewToken,
  isLoopbackHost,
  isPreviewToken,
  normalizePreviewsConfig,
  parsePreviewPath,
  previewBasePath,
  validatePreviewTarget,
} from './preview-registry-service.mjs';

const RELAY_HOSTNAMES = ['relay.example.com', 'localhost'];

function enabledConfig(overrides = {}) {
  return normalizePreviewsConfig({
    enabled: true,
    publicBaseUrl: 'https://preview.example.com',
    ...overrides,
  }, {
    env: {},
    relayPort: 3333,
    relayHostnames: RELAY_HOSTNAMES,
    reservedPorts: [4445],
  });
}

// Deterministic token source: sequential bytes so assertions can name the token.
function fakeRandomBytes(seed = 1) {
  let counter = seed;
  return (size) => {
    const buf = Buffer.alloc(size, 0);
    buf.writeUInt8(counter & 0xff, size - 1);
    counter += 1;
    return buf;
  };
}

test('normalizePreviewsConfig defaults the listener port to relay port + 1', () => {
  const config = enabledConfig();
  assert.deepEqual(config.errors, []);
  assert.equal(config.enabled, true);
  assert.equal(config.port, 3334);
  assert.equal(config.bindHost, '127.0.0.1');
  assert.equal(config.publicBaseUrl, 'https://preview.example.com');
});

test('normalizePreviewsConfig strips a trailing slash from publicBaseUrl', () => {
  const config = enabledConfig({ publicBaseUrl: 'https://preview.example.com/' });
  assert.equal(config.publicBaseUrl, 'https://preview.example.com');
});

test('normalizePreviewsConfig stays disabled without erroring when not requested', () => {
  const config = normalizePreviewsConfig({}, { relayPort: 3333, relayHostnames: RELAY_HOSTNAMES });
  assert.equal(config.enabled, false);
  assert.equal(config.requested, false);
  assert.deepEqual(config.errors, []);
});

test('interlock: publicBaseUrl is required when the lane is enabled', () => {
  const config = normalizePreviewsConfig({ enabled: true }, {
    env: {}, relayPort: 3333, relayHostnames: RELAY_HOSTNAMES,
  });
  assert.equal(config.enabled, false);
  assert.equal(config.requested, true);
  assert.match(config.errors.join(' '), /publicBaseUrl is required/);
});

test('interlock: publicBaseUrl sharing the relay hostname is refused', () => {
  // Same hostname on a different port still shares cookies — the port is not a
  // boundary, which is exactly the mistake this interlock exists to catch.
  const config = enabledConfig({ publicBaseUrl: 'https://relay.example.com:8443' });
  assert.equal(config.enabled, false);
  assert.match(config.errors.join(' '), /different hostname than the relay/);
});

test('interlock: listener port colliding with a relay port is refused', () => {
  for (const port of [3333, 4445]) {
    const config = enabledConfig({ port });
    assert.equal(config.enabled, false, `port ${port} should be refused`);
    assert.match(config.errors.join(' '), /collides with a relay port/);
  }
});

test('interlock: a non-loopback bind needs the explicit override', () => {
  const blocked = enabledConfig({ bindHost: '0.0.0.0' });
  assert.equal(blocked.enabled, false);
  assert.match(blocked.errors.join(' '), /not loopback/);

  const allowed = enabledConfig({ bindHost: '0.0.0.0', allowPublicBind: true });
  assert.deepEqual(allowed.errors, []);
  assert.equal(allowed.enabled, true);
});

test('normalizePreviewsConfig allows port 0 as an explicit ephemeral opt-in', () => {
  const config = enabledConfig({ port: 0 });
  assert.deepEqual(config.errors, []);
  assert.equal(config.port, 0);
  // An ephemeral listener port is not known yet, so it cannot be denied as a target.
  assert.deepEqual(config.deniedTargetPorts.sort(), [3333, 4445]);
});

test('normalizePreviewsConfig denies the relay, CLI and listener ports as targets', () => {
  const config = enabledConfig();
  assert.deepEqual(config.deniedTargetPorts.sort((a, b) => a - b), [3333, 3334, 4445]);
});

test('env overrides win over the config block', () => {
  const config = normalizePreviewsConfig({ enabled: false, publicBaseUrl: 'https://ignored.example.com' }, {
    env: {
      COPILOT_PREVIEWS_ENABLED: 'true',
      COPILOT_PREVIEWS_PORT: '4100',
      COPILOT_PREVIEWS_PUBLIC_BASE_URL: 'https://preview.example.com',
      COPILOT_PREVIEWS_ALLOWED_TARGET_HOSTS: '10.1.2.3, 10.1.2.4',
    },
    relayPort: 3333,
    relayHostnames: RELAY_HOSTNAMES,
  });
  assert.deepEqual(config.errors, []);
  assert.equal(config.port, 4100);
  assert.equal(config.publicBaseUrl, 'https://preview.example.com');
  assert.deepEqual(config.allowedTargetHosts, ['10.1.2.3', '10.1.2.4']);
});

test('isLoopbackHost covers the whole 127/8 block and IPv6 loopback', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']) {
    assert.equal(isLoopbackHost(host), true, `${host} should be loopback`);
  }
  for (const host of ['10.0.0.5', '169.254.169.254', 'example.com', '128.0.0.1', '']) {
    assert.equal(isLoopbackHost(host), false, `${host} should not be loopback`);
  }
});

test('tokens are 128-bit lowercase hex and validate exactly', () => {
  const token = createPreviewToken();
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.equal(isPreviewToken(token), true);
  assert.equal(isPreviewToken(token.toUpperCase()), false);
  assert.equal(isPreviewToken(`${token}a`), false);
  assert.equal(isPreviewToken(token.slice(0, 31)), false);
});

test('parsePreviewPath splits token from upstream path', () => {
  const token = 'a'.repeat(32);
  assert.deepEqual(parsePreviewPath(`/test_${token}/assets/app.js`), {
    token, upstreamPath: '/assets/app.js', query: '',
  });
  assert.deepEqual(parsePreviewPath(`/test_${token}/`), {
    token, upstreamPath: '/', query: '',
  });
  assert.deepEqual(parsePreviewPath(`/test_${token}/api?x=1&y=2`), {
    token, upstreamPath: '/api?x=1&y=2', query: '?x=1&y=2',
  });
});

test('parsePreviewPath flags a bare prefix for the trailing-slash redirect', () => {
  const token = 'b'.repeat(32);
  assert.deepEqual(parsePreviewPath(`/test_${token}`), { token, upstreamPath: null, query: '' });
});

test('parsePreviewPath rejects non-preview and malformed paths', () => {
  for (const input of [
    '/',
    '/api/conversations',
    '/index.html',
    '/test_short',
    `/test_${'a'.repeat(33)}/`,
    `/test_${'A'.repeat(32)}/`,
    `test_${'a'.repeat(32)}/`,
    '',
  ]) {
    assert.equal(parsePreviewPath(input), null, `${input} should not parse`);
  }
});

test('parsePreviewPath does not treat a token in the query as a preview path', () => {
  assert.equal(parsePreviewPath(`/api/x?next=/test_${'a'.repeat(32)}/`), null);
});

test('validatePreviewTarget accepts loopback ports and normalizes localhost', () => {
  const result = validatePreviewTarget({ host: 'localhost', port: 5173 }, enabledConfig());
  assert.deepEqual(result, { ok: true, host: '127.0.0.1', port: 5173 });
});

test('validatePreviewTarget refuses relay-owned ports', () => {
  const config = enabledConfig();
  for (const port of [3333, 3334, 4445]) {
    const result = validatePreviewTarget({ host: '127.0.0.1', port }, config);
    assert.equal(result.ok, false, `port ${port} should be refused`);
    assert.match(result.error, /belongs to the relay/);
  }
});

test('validatePreviewTarget refuses privileged ports and non-loopback hosts', () => {
  const config = enabledConfig();
  assert.equal(validatePreviewTarget({ port: 80 }, config).ok, false);
  assert.equal(validatePreviewTarget({ port: 0 }, config).ok, false);
  assert.equal(validatePreviewTarget({ port: 70000 }, config).ok, false);
  assert.equal(validatePreviewTarget({ port: 'nope' }, config).ok, false);

  const lan = validatePreviewTarget({ host: '10.1.2.3', port: 5173 }, config);
  assert.equal(lan.ok, false);
  assert.match(lan.error, /not in previews\.allowedTargetHosts/);

  const metadata = validatePreviewTarget({ host: '169.254.169.254', port: 8080 }, config);
  assert.equal(metadata.ok, false);
});

test('validatePreviewTarget honours the configured host allowlist', () => {
  const config = enabledConfig({ allowedTargetHosts: ['10.1.2.3'] });
  assert.deepEqual(
    validatePreviewTarget({ host: '10.1.2.3', port: 8787 }, config),
    { ok: true, host: '10.1.2.3', port: 8787 },
  );
  assert.equal(validatePreviewTarget({ host: '10.1.2.9', port: 8787 }, config).ok, false);
});

test('registry create returns a public URL built from the base path', () => {
  const registry = createPreviewRegistry({
    config: enabledConfig(),
    now: () => 1000,
    randomBytes: fakeRandomBytes(),
  });
  const created = registry.create({ conversationId: 'conv-1', port: 5173, label: 'web app' });
  assert.equal(created.ok, true);
  assert.equal(created.preview.url, `https://preview.example.com${previewBasePath(created.preview.token)}`);
  assert.equal(created.preview.basePath, `/test_${created.preview.token}/`);
  assert.equal(created.preview.targetHost, '127.0.0.1');
  assert.equal(created.preview.online, null);
  assert.equal(created.preview.label, 'web app');
});

test('registry labels an unlabelled preview with its port', () => {
  const registry = createPreviewRegistry({ config: enabledConfig(), randomBytes: fakeRandomBytes() });
  const created = registry.create({ port: 5173 });
  assert.equal(created.preview.label, 'localhost:5173');
});

test('registry refuses to create when the lane is disabled', () => {
  const registry = createPreviewRegistry({ config: normalizePreviewsConfig({}, { relayPort: 3333 }) });
  const created = registry.create({ port: 5173 });
  assert.equal(created.ok, false);
  assert.equal(created.status, 503);
});

test('registry enforces maxLive', () => {
  const registry = createPreviewRegistry({
    config: enabledConfig({ maxLive: 2 }),
    randomBytes: fakeRandomBytes(),
  });
  assert.equal(registry.create({ port: 5001 }).ok, true);
  assert.equal(registry.create({ port: 5002 }).ok, true);
  const third = registry.create({ port: 5003 });
  assert.equal(third.ok, false);
  assert.equal(third.status, 429);
  assert.equal(registry.size, 2);
});

test('registry resolve returns the entry only for a live, policy-valid token', () => {
  const registry = createPreviewRegistry({ config: enabledConfig(), randomBytes: fakeRandomBytes() });
  const { preview } = registry.create({ port: 5173 });
  assert.equal(registry.resolve(preview.token).targetPort, 5173);
  assert.equal(registry.resolve('c'.repeat(32)), null);
  assert.equal(registry.resolve('not-a-token'), null);

  registry.close(preview.token);
  assert.equal(registry.resolve(preview.token), null);
});

test('registry close is idempotent and reports unknown tokens', () => {
  const registry = createPreviewRegistry({ config: enabledConfig(), randomBytes: fakeRandomBytes() });
  const { preview } = registry.create({ port: 5173 });
  assert.equal(registry.close(preview.token).ok, true);
  const second = registry.close(preview.token);
  assert.equal(second.ok, false);
  assert.equal(second.status, 404);
});

test('registry lists globally and per conversation, oldest first', () => {
  let clock = 100;
  const registry = createPreviewRegistry({
    config: enabledConfig(),
    now: () => (clock += 10),
    randomBytes: fakeRandomBytes(),
  });
  const a = registry.create({ conversationId: 'conv-1', port: 5001 }).preview;
  const b = registry.create({ conversationId: 'conv-2', port: 5002 }).preview;
  const c = registry.create({ conversationId: 'conv-1', port: 5003 }).preview;

  assert.deepEqual(registry.list().map((entry) => entry.token), [a.token, b.token, c.token]);
  assert.deepEqual(registry.listForConversation('conv-1').map((e) => e.targetPort), [5001, 5003]);
  assert.deepEqual(registry.listForConversation('conv-2').map((e) => e.targetPort), [5002]);
  assert.deepEqual(registry.listForConversation(''), []);
});

test('registry closeForConversation drops only that conversation', () => {
  const registry = createPreviewRegistry({ config: enabledConfig(), randomBytes: fakeRandomBytes() });
  registry.create({ conversationId: 'conv-1', port: 5001 });
  registry.create({ conversationId: 'conv-2', port: 5002 });
  assert.equal(registry.closeForConversation('conv-1'), 1);
  assert.deepEqual(registry.list().map((entry) => entry.conversationId), ['conv-2']);
});

test('markHealth emits only on transitions', () => {
  const changes = [];
  const registry = createPreviewRegistry({
    config: enabledConfig(),
    now: () => 500,
    randomBytes: fakeRandomBytes(),
    onChange: (event) => changes.push(event.reason),
  });
  const { preview } = registry.create({ port: 5173 });
  assert.deepEqual(changes, ['created']);

  assert.equal(registry.markHealth(preview.token, true), true);
  assert.equal(registry.markHealth(preview.token, true), false);
  assert.equal(registry.markHealth(preview.token, false), true);
  assert.deepEqual(changes, ['created', 'health', 'health']);
  assert.equal(registry.get(preview.token).online, false);
  assert.equal(registry.get(preview.token).lastSeenOnline, 500);

  assert.equal(registry.markHealth('d'.repeat(32), true), false);
});

test('recordHit counts requests without emitting change events', () => {
  const changes = [];
  const registry = createPreviewRegistry({
    config: enabledConfig(),
    randomBytes: fakeRandomBytes(),
    onChange: (event) => changes.push(event.reason),
  });
  const { preview } = registry.create({ port: 5173 });
  registry.recordHit(preview.token);
  registry.recordHit(preview.token);
  registry.recordHit('e'.repeat(32));
  assert.equal(registry.get(preview.token).hits, 2);
  assert.deepEqual(changes, ['created']);
});

test('a throwing onChange never breaks the registry', () => {
  const registry = createPreviewRegistry({
    config: enabledConfig(),
    randomBytes: fakeRandomBytes(),
    onChange: () => { throw new Error('listener exploded'); },
  });
  const created = registry.create({ port: 5173 });
  assert.equal(created.ok, true);
  assert.equal(registry.close(created.preview.token).ok, true);
});

test('clear drops everything', () => {
  const registry = createPreviewRegistry({ config: enabledConfig(), randomBytes: fakeRandomBytes() });
  registry.create({ port: 5001 });
  registry.create({ port: 5002 });
  registry.clear();
  assert.equal(registry.size, 0);
  assert.deepEqual(registry.list(), []);
});
