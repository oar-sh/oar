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
  PREVIEW_REDACT_MIN_HEX,
  previewLogId,
  redactPreviewTokens,
  validatePreviewTarget,
} from './preview-registry-service.mjs';
import { createMemoryPreviewStore } from './preview-store.mjs';

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

// ─── Redaction for shared transcripts ───────────────────────────────────────

const REDACT_TOKEN = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const OTHER_REDACT_TOKEN = '9a8b7c6d5e4f30211203f4e5d6c7b8a9';
const REMOVED = '[preview link removed]';

test('redaction removes a whole preview path, also percent-encoded and in any case', () => {
  const redact = (text) => redactPreviewTokens(text);
  assert.equal(redact(`https://p.example.com/test_${REDACT_TOKEN}/a.html`), `https://p.example.com/${REMOVED}/a.html`);
  assert.equal(redact(`/TEST_${REDACT_TOKEN.toUpperCase()}/`), `/${REMOVED}/`);
  assert.equal(redact(`/test%5F${REDACT_TOKEN}/`), `/${REMOVED}/`);
  assert.equal(redact(`/test%5f${REDACT_TOKEN}/`), `/${REMOVED}/`);
  assert.equal(redact(`/test%255F${REDACT_TOKEN}/`), `/${REMOVED}/`);
});

test('redaction removes a preview path cut short, whatever follows it', () => {
  const redact = (text) => redactPreviewTokens(text);
  for (let length = PREVIEW_REDACT_MIN_HEX; length < 32; length += 1) {
    const piece = REDACT_TOKEN.slice(0, length);
    for (const after of ['', '\n', '\n\n_The turn was interrupted._', '"', '")', ').', '.', '… more', '...', ' [truncated]', '`', '</a>', '\\n']) {
      assert.equal(redact(`see https://p.example.com/test_${piece}${after}`), `see https://p.example.com/${REMOVED}${after}`, `${length} + ${JSON.stringify(after)}`);
      assert.equal(redact(`see /test%5F${piece}${after}`), `see /${REMOVED}${after}`, `encoded, ${length} + ${JSON.stringify(after)}`);
    }
  }
  // Below the minimum the text stays: at most seven characters of a token.
  for (let length = 0; length < PREVIEW_REDACT_MIN_HEX; length += 1) {
    const text = `see https://p.example.com/test_${REDACT_TOKEN.slice(0, length)}`;
    assert.equal(redact(text), text);
    assert.equal(redact(`${text}\n\n_note_`), `${text}\n\n_note_`);
  }
  assert.equal(PREVIEW_REDACT_MIN_HEX, 8);
});

test('redaction removes a token glued to more hex, as a path and bare', () => {
  const redact = (text) => redactPreviewTokens(text, { tokens: [REDACT_TOKEN] });
  assert.equal(redact(`test_${REDACT_TOKEN}a`), REMOVED);
  assert.equal(redact(`test_${REDACT_TOKEN}0123 next`), `${REMOVED} next`);
  assert.equal(redactPreviewTokens(`test_${REDACT_TOKEN}0`), REMOVED, 'also without knowing the token');
  assert.equal(redact(`%2F${REDACT_TOKEN}`), `%2F${REMOVED}`);
  assert.equal(redact(`%22${REDACT_TOKEN}%22`), `%22${REMOVED}%22`);
  assert.equal(redact(`"${REDACT_TOKEN}"`), `"${REMOVED}"`);
  assert.equal(redact(`7${REDACT_TOKEN}`), `7${REMOVED}`);
  assert.equal(redact(`${REDACT_TOKEN}a`), `${REMOVED}a`);
});

test('redaction removes a known token and its pieces from eight characters on', () => {
  const redact = (text) => redactPreviewTokens(text, { tokens: [REDACT_TOKEN, OTHER_REDACT_TOKEN] });
  assert.equal(redact(`token ${REDACT_TOKEN}.`), `token ${REMOVED}.`);
  assert.equal(redact(`| ${OTHER_REDACT_TOKEN} | api |`), `| ${REMOVED} | api |`);
  assert.equal(redact(`{"token":"${REDACT_TOKEN.slice(0, 8)}`), `{"token":"${REMOVED}`);
  assert.equal(redact(`{"token":"${REDACT_TOKEN.slice(0, 31)}"} and on`), `{"token":"${REMOVED}"} and on`);
  assert.equal(redact(`${REDACT_TOKEN.slice(24)}/index.html`), `${REMOVED}/index.html`);
  assert.equal(redact(`${REDACT_TOKEN.slice(1)}/index.html`), `${REMOVED}/index.html`);
  // Too short to be worth a guess, and too common in ordinary text.
  assert.equal(redact(`ends in ${REDACT_TOKEN.slice(0, 7)}`), `ends in ${REDACT_TOKEN.slice(0, 7)}`);
  assert.equal(redact(`${REDACT_TOKEN.slice(25)} starts it`), `${REDACT_TOKEN.slice(25)} starts it`);
});

test('redaction leaves ordinary names and hex alone', () => {
  const redact = (text) => redactPreviewTokens(text, { tokens: [REDACT_TOKEN] });
  for (const text of [
    'Fixed test_add',
    'pytest_',
    'run pytest_ then test_1',
    'TEST_DB',
    'export TEST_DB=1',
    'now run test_cafe',
    'functions named test_',
    'see test_add... for more',
    'test_feedbac',
    'def test_decode(): ...',
    'latest_build passed; contest_1 too...',
    'checksum 00112233445566778899aabbccddeeff',
    'commit 4f5a6b7c8d9e landed',
    'npm test',
  ]) assert.equal(redact(text), text);
  // What is left of the price: eight or more hex digits right after test_.
  assert.equal(redact('ran test_deadbeef twice'), `ran ${REMOVED} twice`);
});

test('redaction takes time in proportion to the text, also on long runs of blanks', () => {
  const tokens = Array.from({ length: 16 }, (_, index) => `${index.toString(16)}f1e2d3c4b5a69788796a5b4c3d2e1f`.padEnd(32, '0'));
  const timed = (value) => {
    const startedAt = process.hrtime.bigint();
    const out = redactPreviewTokens(value, { tokens });
    return { out, ms: Number(process.hrtime.bigint() - startedAt) / 1e6 };
  };
  const tail = tokens[3].slice(12);
  for (const [name, text, expected] of [
    ['blanks', ' '.repeat(200_000), ' '.repeat(200_000)],
    ['text, then newlines', `some text${'\n'.repeat(200_000)}`, `some text${'\n'.repeat(200_000)}`],
    ['blanks, then the end of a token', `${' \n\t'.repeat(66_000)}${tail}/x`, `${' \n\t'.repeat(66_000)}${REMOVED}/x`],
    ['blanks between words', 'word     '.repeat(22_000), 'word     '.repeat(22_000)],
    ['an unfinished prefix, repeated', 'test%2525'.repeat(22_000), 'test%2525'.repeat(22_000)],
    ['hex only', '0f1e2d3'.repeat(28_000), '0f1e2d3'.repeat(28_000)],
  ]) {
    const { out, ms } = timed(text);
    assert.equal(out, expected, name);
    assert.ok(ms < 1_000, `${name}: ${Math.round(ms)} ms for ${text.length} characters`);
  }
  // A payload of several megabytes: many strings, long and short.
  const line = `tool output 0123abcd test_add  \n   \n /test_${tokens[5]}/a.css ${tokens[7]}\n`;
  const payload = {
    messages: Array.from({ length: 400 }, (_, index) => ({
      id: `m-${index}`,
      text: line.repeat(120),
      activities: [{ text: ' '.repeat(5_000) }, { text: `${'\n'.repeat(5_000)}${tokens[1].slice(20)}` }],
    })),
  };
  const size = JSON.stringify(payload).length;
  assert.ok(size > 6_000_000, `the payload has ${size} characters`);
  const { out, ms } = timed(payload);
  assert.ok(ms < 5_000, `${Math.round(ms)} ms for ${size} characters`);
  const body = JSON.stringify(out);
  for (const token of tokens) assert.ok(!body.includes(token.slice(0, 8)) && !body.includes(token.slice(20)));
  assert.ok(body.includes('test_add'));
});

// ─── Persistence and restore ────────────────────────────────────────────────

function captureLogger() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    warn: (line) => lines.push(String(line)),
  };
}

function persistedRegistry({ store, config = enabledConfig(), hostBootId = 'linux:boot-1', ...rest } = {}) {
  return createPreviewRegistry({
    config,
    randomBytes: fakeRandomBytes(),
    store,
    hostBootId,
    checkConversation: () => true,
    checkStaticRoot: (rootDir) => ({ ok: true, rootDir }),
    logger: captureLogger(),
    ...rest,
  });
}

test('a restarted registry restores every preview under its old token and link', () => {
  const store = createMemoryPreviewStore();
  const first = persistedRegistry({ store, now: () => 1_000 });
  const port = first.create({ conversationId: 'conv-1', port: 5173, label: 'web app' }).preview;
  const site = first.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site', label: 'site' }).preview;
  assert.equal(store.list().length, 2);

  const second = persistedRegistry({ store, randomBytes: fakeRandomBytes(50) });
  assert.deepEqual(second.list().map((entry) => [entry.token, entry.url, entry.mode, entry.label, entry.createdAt]), [
    [port.token, port.url, 'port', 'web app', 1_000],
    [site.token, site.url, 'static', 'site', 1_000],
  ]);
  assert.equal(second.resolve(site.token).rootDir, '/home/dev/site');
  assert.equal(second.resolve(port.token).targetPort, 5173);
  assert.equal(second.get(port.token).online, null);
  assert.equal(second.get(site.token).online, true);
});

test('restored links follow a changed public address', () => {
  const store = createMemoryPreviewStore();
  const { preview } = persistedRegistry({ store }).createStatic({ rootDir: '/home/dev/site' });
  const moved = persistedRegistry({
    store,
    config: enabledConfig({ publicBaseUrl: 'https://previews.example.org/' }),
  });
  assert.equal(moved.get(preview.token).url, `https://previews.example.org/test_${preview.token}/`);
});

test('with the lane off nothing is restored or served and the rows stay', () => {
  const store = createMemoryPreviewStore();
  const { preview } = persistedRegistry({ store }).createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site' });
  const off = persistedRegistry({ store, config: normalizePreviewsConfig({}, { relayPort: 3333 }) });
  assert.equal(off.size, 0);
  assert.equal(off.resolve(preview.token), null);
  assert.equal(store.list().length, 1);
  const on = persistedRegistry({ store });
  assert.equal(on.resolve(preview.token).token, preview.token);
});

test('close and closeForConversation remove the stored rows', () => {
  const store = createMemoryPreviewStore();
  const registry = persistedRegistry({ store });
  const a = registry.create({ conversationId: 'conv-1', port: 5001 }).preview;
  registry.create({ conversationId: 'conv-2', port: 5002 });
  // A row of conv-2 this runtime never loaded (written by another boot).
  store.insert({ token: 'f'.repeat(32), mode: 'static', conversationId: 'conv-2', label: 'old', rootDir: '/home/dev/old', createdAt: 1 });
  assert.equal(registry.close(a.token).ok, true);
  assert.equal(registry.closeForConversation('conv-2'), 1);
  assert.deepEqual(store.list(), []);
});

test('a port preview comes back only in the same host boot; a static one always', () => {
  const store = createMemoryPreviewStore();
  const first = persistedRegistry({ store, hostBootId: 'linux:boot-1' });
  const port = first.create({ conversationId: 'conv-1', port: 5173 }).preview;
  const site = first.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site' }).preview;

  const logger = captureLogger();
  const rebooted = persistedRegistry({ store, hostBootId: 'linux:boot-2', logger });
  assert.deepEqual(rebooted.list().map((entry) => entry.token), [site.token]);
  assert.deepEqual(store.list().map((entry) => entry.token), [site.token]);
  assert.ok(logger.lines.some((line) => line.includes(previewLogId(port.token)) && line.includes('earlier host boot')));
});

test('restore re-validates each row and drops the ones that fail, without logging tokens', () => {
  const store = createMemoryPreviewStore();
  const first = persistedRegistry({ store });
  const gone = first.createStatic({ conversationId: 'conv-gone', rootDir: '/home/dev/a' }).preview;
  const outside = first.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/outside' }).preview;
  const linked = first.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/link' }).preview;
  const relayPort = first.create({ conversationId: 'conv-1', port: 5005 }).preview;
  const loose = first.createStatic({ rootDir: '/home/dev/loose' }).preview;

  const logger = captureLogger();
  const seenConversations = [];
  const restored = persistedRegistry({
    store,
    // The relay now owns port 5005.
    config: normalizePreviewsConfig({ enabled: true, publicBaseUrl: 'https://preview.example.com' }, {
      env: {}, relayPort: 3333, relayHostnames: RELAY_HOSTNAMES, reservedPorts: [5005],
    }),
    checkConversation: (id) => id !== 'conv-gone',
    checkStaticRoot: (rootDir, conversationId) => {
      seenConversations.push(conversationId);
      if (rootDir === '/home/dev/outside') return { ok: false, error: 'dir must live inside the workspace root' };
      if (rootDir === '/home/dev/link') return { ok: true, rootDir: '/home/dev/real' };
      return { ok: true, rootDir };
    },
    logger,
  });
  assert.deepEqual(restored.list().map((entry) => entry.token).sort(), [linked.token, loose.token].sort());
  assert.equal(restored.get(linked.token).rootDir, '/home/dev/real');
  assert.ok(seenConversations.includes(null), 'a preview without a conversation is checked against the server-wide root');
  assert.deepEqual(store.list().map((entry) => entry.token).sort(), [linked.token, loose.token].sort());
  const output = logger.lines.join('\n');
  for (const dropped of [gone, outside, relayPort]) {
    assert.ok(output.includes(previewLogId(dropped.token)));
    assert.ok(!output.includes(dropped.token), 'a log line carries the token');
  }
  assert.match(output, /conversation no longer exists/);
  assert.match(output, /workspace root/);
  assert.match(output, /belongs to the relay/);
});

test('the same conversation and target get the existing preview back', () => {
  const store = createMemoryPreviewStore();
  const registry = persistedRegistry({ store, config: enabledConfig({ maxLive: 2 }) });
  const port = registry.create({ conversationId: 'conv-1', port: 5173, label: 'first' });
  const again = registry.create({ conversationId: 'conv-1', host: 'localhost', port: 5173, label: 'second' });
  assert.equal(again.ok, true);
  assert.equal(again.existing, true);
  assert.equal(again.preview.token, port.preview.token);
  assert.equal(again.preview.label, 'first');

  const site = registry.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site' });
  // At the limit now, but the same target still answers with its link.
  const siteAgain = registry.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site' });
  assert.equal(siteAgain.existing, true);
  assert.equal(siteAgain.preview.token, site.preview.token);
  assert.equal(registry.size, 2);
  assert.equal(store.list().length, 2);
  assert.equal(registry.create({ conversationId: 'conv-2', port: 5173 }).status, 429);
});

test('same target in another conversation or without one is a separate preview', () => {
  const registry = persistedRegistry({ store: createMemoryPreviewStore() });
  const a = registry.create({ conversationId: 'conv-1', port: 5173 }).preview;
  const b = registry.create({ conversationId: 'conv-2', port: 5173 }).preview;
  const c = registry.create({ port: 5173 }).preview;
  const d = registry.create({ port: 5173 });
  assert.equal(new Set([a.token, b.token, c.token]).size, 3);
  assert.equal(d.existing, true);
  assert.equal(d.preview.token, c.token);
  assert.equal(registry.create({ conversationId: 'conv-1', port: 5174 }).existing, undefined);
});

test('the limit error names the oldest previews and how to close them', () => {
  let clock = 0;
  const registry = persistedRegistry({
    store: createMemoryPreviewStore(),
    config: enabledConfig({ maxLive: 2 }),
    now: () => clock,
  });
  const site = registry.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site', label: 'docs' }).preview;
  clock = 30 * 60_000;
  registry.create({ conversationId: 'conv-1', port: 5173, label: 'web app' });
  registry.recordHit(site.token, clock);
  clock = 3 * 3_600_000;
  const refused = registry.create({ conversationId: 'conv-1', port: 5174 });
  assert.equal(refused.status, 429);
  assert.match(refused.error, /max 2/);
  assert.match(refused.error, /"docs" \(folder site, published 3 h ago, last opened 3 h ago\)/);
  assert.match(refused.error, /"web app" \(port 5173, published 3 h ago, never opened\)/);
  assert.match(refused.error, /Settings → Previews/);
  assert.match(refused.error, /DELETE \/api\/previews\/:token/);
  assert.ok(!refused.error.includes(site.token));
});

test('last use is written at most once per interval and flushed on shutdown', () => {
  const store = createMemoryPreviewStore();
  const touches = [];
  const original = store.touch;
  store.touch = (token, at) => { touches.push(at); return original(token, at); };
  const registry = persistedRegistry({ store, hitPersistIntervalMs: 60_000 });
  const { preview } = registry.createStatic({ rootDir: '/home/dev/site' });
  for (const at of [1_000, 2_000, 3_000, 61_000, 62_000]) registry.recordHit(preview.token, at);
  assert.deepEqual(touches, [1_000, 61_000]);
  assert.equal(registry.get(preview.token).lastHitAt, 62_000);
  registry.flushHits();
  registry.flushHits();
  assert.deepEqual(touches, [1_000, 61_000, 62_000]);
  assert.equal(persistedRegistry({ store }).get(preview.token).lastHitAt, 62_000);
});

// A store whose writes throw while `failing` is set, as a locked database does.
function flakyStore() {
  const inner = createMemoryPreviewStore();
  const state = { failing: false, calls: [], args: [] };
  const wrap = (name) => (...args) => {
    state.calls.push(name);
    state.args.push(args);
    if (state.failing) throw new Error('database is locked');
    return inner[name](...args);
  };
  return {
    state,
    available: true,
    list: () => inner.list(),
    insert: wrap('insert'),
    remove: wrap('remove'),
    removeForConversation: wrap('removeForConversation'),
    touch: wrap('touch'),
  };
}

test('a failing store never breaks create or close, and its writes are retried until they land', () => {
  const store = flakyStore();
  const logger = captureLogger();
  const registry = persistedRegistry({ store, logger });
  store.state.failing = true;
  const created = registry.create({ conversationId: 'conv-1', port: 5173 });
  assert.equal(created.ok, true);
  assert.deepEqual(store.list(), [], 'the insert did not land');
  assert.equal(registry.pendingWriteCount, 1);
  registry.retryPendingWrites();
  registry.retryPendingWrites();
  assert.equal(logger.lines.filter((line) => line.includes('store insert failed')).length, 1, 'one warning, not one per retry');

  store.state.failing = false;
  assert.equal(registry.retryPendingWrites(), 0);
  assert.deepEqual(store.list().map((row) => row.token), [created.preview.token]);
  assert.equal(registry.pendingWriteCount, 0);
  assert.equal(persistedRegistry({ store }).get(created.preview.token).targetPort, 5173,
    'a preview whose first insert failed still survives a restart');
});

test('a close whose delete failed does not come back after a restart', () => {
  const store = flakyStore();
  const registry = persistedRegistry({ store });
  const { preview } = registry.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site' });
  const other = registry.createStatic({ conversationId: 'conv-2', rootDir: '/home/dev/other' }).preview;
  store.state.failing = true;
  assert.equal(registry.close(preview.token).ok, true);
  assert.equal(registry.closeForConversation('conv-2'), 1);
  assert.equal(registry.resolve(preview.token), null);
  assert.equal(store.list().length, 2, 'both deletes failed');

  store.state.failing = false;
  // Shutdown flushes the pending deletes with the held-back hits.
  registry.flushHits();
  assert.deepEqual(store.list(), []);
  const restarted = persistedRegistry({ store });
  assert.equal(restarted.resolve(preview.token), null);
  assert.equal(restarted.resolve(other.token), null);
});

test('an insert that failed and a close after it converge on no row', () => {
  const store = flakyStore();
  const registry = persistedRegistry({ store });
  store.state.failing = true;
  const { preview } = registry.create({ conversationId: 'conv-1', port: 5173 });
  store.state.failing = false;
  registry.close(preview.token);
  registry.retryPendingWrites();
  assert.deepEqual(store.list(), []);
  assert.equal(registry.pendingWriteCount, 0);
});

test('a failed last-use write is retried on the next attempt, not lost and not repeated per request', () => {
  const store = flakyStore();
  const registry = persistedRegistry({ store, hitPersistIntervalMs: 60_000 });
  const { preview } = registry.createStatic({ rootDir: '/home/dev/site' });
  store.state.failing = true;
  store.state.calls.length = 0;
  for (const at of [1_000, 2_000, 3_000]) registry.recordHit(preview.token, at);
  assert.deepEqual(store.state.calls, ['touch'], 'one attempt per interval, also while failing');
  store.state.failing = false;
  registry.flushHits();
  assert.equal(store.list()[0].lastHitAt, 3_000);
});

test('a check that throws keeps the row instead of deleting it', () => {
  const store = createMemoryPreviewStore();
  const first = persistedRegistry({ store });
  const site = first.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site' }).preview;
  const port = first.create({ conversationId: 'conv-1', port: 5173 }).preview;
  const other = first.createStatic({ conversationId: 'conv-2', rootDir: '/home/dev/other' }).preview;

  const logger = captureLogger();
  const locked = persistedRegistry({
    store,
    logger,
    checkConversation: (id) => {
      if (id === 'conv-1') throw new Error('database is locked');
      return true;
    },
    checkStaticRoot: () => ({ ok: false, error: 'Directory not found: /home/dev/other (EACCES)', transient: true }),
  });
  assert.equal(locked.size, 0);
  assert.equal(store.list().length, 3, 'no row was deleted');
  const output = logger.lines.join('\n');
  assert.match(output, /kept and checked again: conversation check failed: database is locked/);
  assert.match(output, /kept and checked again: Directory not found/);
  assert.match(output, /kept 3 to check again/);
  for (const entry of [site, port, other]) assert.ok(!output.includes(entry.token));

  const throwing = persistedRegistry({ store, checkStaticRoot: () => { throw new Error('EMFILE'); } });
  assert.deepEqual(throwing.list().filter((entry) => !entry.unverified).map((entry) => entry.token), [port.token]);
  assert.equal(throwing.keptCount, 2);
  assert.equal(store.list().length, 3);

  const next = persistedRegistry({ store });
  assert.equal(next.size, 3);
});

test('a row whose token is not in canonical form is dropped by the value it is stored under', () => {
  const removed = [];
  const upper = 'A'.repeat(32);
  const store = {
    list: () => [
      { token: upper, mode: 'static', conversationId: null, label: 'hand written', rootDir: '/home/dev/site', createdAt: 1 },
      { token: ` ${'c'.repeat(32)}`, mode: 'static', conversationId: null, label: 'padded', rootDir: '/home/dev/site', createdAt: 1 },
    ],
    insert: () => true,
    remove: (token) => { removed.push(token); return true; },
    removeForConversation: () => 0,
    touch: () => true,
  };
  const registry = persistedRegistry({ store });
  assert.equal(registry.size, 0);
  assert.deepEqual(removed, [upper, ` ${'c'.repeat(32)}`]);
  assert.equal(registry.resolve('a'.repeat(32)), null);
});

test('restoring a port row refreshes its stored boot id', () => {
  const store = createMemoryPreviewStore();
  const tolerant = (a, b) => Math.abs(Number(String(a).split(':')[1]) - Number(String(b).split(':')[1])) <= 120;
  const first = persistedRegistry({ store, hostBootId: 'boottime:1000', isSameHostBoot: tolerant });
  const { preview } = first.create({ conversationId: 'conv-1', port: 5173 });
  // Each restart reads the boot time again, a little off each time; measured
  // against the first value the drift would add up past the tolerance.
  persistedRegistry({ store, hostBootId: 'boottime:1100', isSameHostBoot: tolerant });
  assert.equal(store.list()[0].hostBootId, 'boottime:1100');
  const third = persistedRegistry({ store, hostBootId: 'boottime:1200', isSameHostBoot: tolerant });
  assert.equal(third.get(preview.token).targetPort, 5173);
  assert.equal(store.list()[0].hostBootId, 'boottime:1200');
});

test('an unchanged restore writes nothing', () => {
  const store = flakyStore();
  const first = persistedRegistry({ store });
  first.create({ conversationId: 'conv-1', port: 5173 });
  first.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site' });
  store.state.calls.length = 0;
  assert.equal(persistedRegistry({ store }).size, 2);
  assert.deepEqual(store.state.calls, []);
});

test('the limit error asks to close as many as it takes when more are live than the limit', () => {
  const store = createMemoryPreviewStore();
  const wide = persistedRegistry({ store, config: enabledConfig({ maxLive: 4 }) });
  for (const port of [5001, 5002, 5003, 5004]) wide.create({ conversationId: 'conv-1', port });
  const lowered = persistedRegistry({ store, config: enabledConfig({ maxLive: 2 }) });
  assert.equal(lowered.size, 4, 'every stored preview comes back');
  const refused = lowered.create({ conversationId: 'conv-1', port: 5005 });
  assert.equal(refused.status, 429);
  assert.match(refused.error, /Close 3 in Settings/);
});

// ─── Rows a restore could not judge ─────────────────────────────────────────

// A store with `count` folder previews of conversation conv-1, and a folder
// check that answers with an fs error while `state.failing` is set.
function keptFixture({ count = 1, ...rest } = {}) {
  const store = createMemoryPreviewStore();
  const first = persistedRegistry({ store, now: () => 1_000 });
  const previews = [];
  for (let index = 0; index < count; index += 1) {
    previews.push(first.createStatic({ conversationId: 'conv-1', rootDir: `/home/dev/site-${index}`, label: `site ${index}` }).preview);
  }
  const state = { failing: true, error: 'Directory not readable (EIO)', at: 10_000, changes: [] };
  const logger = captureLogger();
  const registry = persistedRegistry({
    store,
    logger,
    now: () => state.at,
    onChange: (change) => state.changes.push(change),
    checkStaticRoot: (rootDir) => (state.failing ? { ok: false, error: state.error, transient: true } : { ok: true, rootDir }),
    ...rest,
  });
  return { store, registry, previews, state, logger };
}

test('a kept row is not served, but listed as unverified and closable', () => {
  const { store, registry, previews: [site] } = keptFixture();
  assert.equal(registry.size, 0);
  assert.equal(registry.keptCount, 1);
  assert.equal(registry.resolve(site.token), null);
  assert.equal(registry.get(site.token), null);
  assert.deepEqual(registry.list(), [{
    ...site, online: false, lastSeenOnline: null, hits: 0, unverified: true,
  }]);
  assert.deepEqual(registry.listForConversation('conv-1').map((entry) => entry.token), [site.token]);

  const closed = registry.close(site.token);
  assert.equal(closed.ok, true);
  assert.equal(closed.preview.token, site.token);
  assert.deepEqual(store.list(), [], 'the row went with the close');
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.close(site.token).status, 404);
  assert.equal(persistedRegistry({ store }).size, 0, 'it does not come back at the next start');
});

test('a kept row is checked again and comes back under its link once the check answers', () => {
  const { store, registry, previews: [site], state, logger } = keptFixture();
  assert.equal(registry.recheckKeptRows(), 1);
  assert.equal(registry.resolve(site.token), null);
  assert.equal(logger.lines.filter((line) => line.includes('kept and checked again')).length, 1, 'logged once, not per check');

  state.failing = false;
  state.changes.length = 0;
  assert.equal(registry.recheckKeptRows(), 0);
  assert.equal(registry.resolve(site.token).rootDir, '/home/dev/site-0');
  assert.equal(registry.get(site.token).url, site.url);
  assert.equal(registry.get(site.token).createdAt, 1_000);
  assert.equal(registry.get(site.token).unverified, undefined);
  assert.equal(state.changes.length, 1, 'the clients hear of it');
  assert.equal(store.list().length, 1);
  assert.ok(!logger.lines.join('\n').includes(site.token));
});

test('a kept row whose check answers no is dropped by that answer', () => {
  const { store, registry, state } = keptFixture({ checkConversation: () => !state.gone });
  state.gone = true;
  assert.equal(registry.recheckKeptRows(), 0);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(registry.list(), []);
});

test('a row that stays unjudgeable past the bound is dropped and logged', () => {
  const { store, registry, previews: [site], state, logger } = keptFixture({ keptRowMaxAgeMs: 60_000 });
  state.at += 59_000;
  assert.equal(registry.recheckKeptRows(), 1);
  assert.equal(store.list().length, 1);
  state.at += 1_000;
  state.error = 'Directory not readable (EACCES)';
  assert.equal(registry.recheckKeptRows(), 0);
  assert.equal(registry.close(site.token).status, 404, 'gone from the registry at once');
  // The row itself goes with the next retry of pending writes.
  assert.equal(registry.pendingWriteCount, 1);
  assert.equal(registry.retryPendingWrites(), 0);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(registry.list(), []);
  const output = logger.lines.join('\n');
  assert.match(output, /dropped [0-9a-f]{8} "site 0": could not be checked for 1 min \(Directory not readable \(EACCES\)\)/);
  assert.ok(!output.includes(site.token));
  assert.equal(persistedRegistry({ store }).size, 0);
});

test('registering the target of a kept row brings it back with its link, not a second one', () => {
  const { store, registry, previews: [site] } = keptFixture();
  const again = registry.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site-0', label: 'another label' });
  assert.equal(again.ok, true);
  assert.equal(again.existing, true);
  assert.equal(again.preview.token, site.token);
  assert.equal(again.preview.url, site.url);
  assert.equal(again.preview.label, 'site 0');
  assert.equal(again.preview.createdAt, 1_000);
  assert.equal(registry.keptCount, 0);
  assert.equal(registry.resolve(site.token).rootDir, '/home/dev/site-0');
  assert.deepEqual(store.list().map((row) => row.token), [site.token]);
  assert.equal(persistedRegistry({ store }).size, 1, 'one link at the next start');
});

test('kept rows count towards the limit, and registering their folders again adds none', () => {
  const { store, registry, previews } = keptFixture({ count: 8 });
  assert.equal(registry.keptCount, 8);
  const ninth = registry.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/ninth' });
  assert.equal(ninth.ok, false);
  assert.equal(ninth.status, 429);
  assert.match(ninth.error, /Oldest: "site 0" \(folder site-0/);
  for (const preview of previews) {
    const again = registry.createStatic({ conversationId: 'conv-1', rootDir: preview.rootDir });
    assert.equal(again.preview.token, preview.token);
  }
  assert.equal(store.list().length, 8);
  assert.equal(persistedRegistry({ store }).size, 8, 'eight live at the next start, not sixteen');
});

test('a kept port row of an earlier host boot is not revived by a new registration', () => {
  const store = createMemoryPreviewStore();
  const old = persistedRegistry({ store, hostBootId: 'linux:boot-1' }).create({ conversationId: 'conv-1', port: 5173 }).preview;
  const boot = { locked: true };
  const registry = persistedRegistry({
    store,
    hostBootId: 'linux:boot-2',
    randomBytes: fakeRandomBytes(7),
    checkConversation: () => { if (boot.locked) throw new Error('database is locked'); return true; },
  });
  assert.equal(registry.keptCount, 1);
  boot.locked = false;
  const fresh = registry.create({ conversationId: 'conv-1', port: 5173 });
  assert.equal(fresh.ok, true);
  assert.notEqual(fresh.preview.token, old.token);
  assert.equal(registry.resolve(old.token), null);
  assert.deepEqual(store.list().map((row) => row.token), [fresh.preview.token]);
});

test('deleting the conversation closes its kept rows too', () => {
  const { store, registry } = keptFixture({ count: 2 });
  assert.equal(registry.closeForConversation('conv-1'), 2);
  assert.equal(registry.keptCount, 0);
  assert.deepEqual(store.list(), []);
});

test('a recheck stops at the first row that still cannot be judged, and takes the rows in turn', () => {
  const checked = [];
  const fixture = keptFixture({
    count: 3,
    checkStaticRoot: (rootDir) => {
      checked.push(rootDir.split('/').pop());
      return { ok: false, error: 'EIO', transient: true };
    },
  });
  checked.length = 0;
  fixture.registry.recheckKeptRows();
  fixture.registry.recheckKeptRows();
  fixture.registry.recheckKeptRows();
  fixture.registry.recheckKeptRows();
  assert.deepEqual(checked, ['site-0', 'site-1', 'site-2', 'site-0']);
  assert.equal(fixture.registry.keptCount, 3);
});

test('a sweep on a locked database waits once, also with rows past the bound', () => {
  // Every store call and every conversation check stands for one wait on
  // the lock here.
  const inner = createMemoryPreviewStore();
  const first = persistedRegistry({ store: inner, now: () => 1_000 });
  for (let index = 0; index < 4; index += 1) first.createStatic({ conversationId: 'conv-1', rootDir: `/home/dev/site-${index}` });
  const state = { locked: true, waits: 0, at: 10_000 };
  const guard = (name) => (...args) => {
    if (state.locked) { state.waits += 1; throw new Error('database is locked'); }
    return inner[name](...args);
  };
  const store = { list: () => inner.list(), insert: guard('insert'), remove: guard('remove'), removeForConversation: guard('removeForConversation'), touch: guard('touch') };
  const registry = persistedRegistry({
    store,
    now: () => state.at,
    keptRowMaxAgeMs: 60_000,
    checkConversation: () => {
      if (state.locked) { state.waits += 1; throw new Error('database is locked'); }
      return true;
    },
  });
  assert.equal(registry.keptCount, 4);

  state.at += 120_000;
  state.waits = 0;
  registry.maintain();
  assert.equal(state.waits, 1, 'one check, then the pass ends; the row past the bound is not deleted in it');
  assert.equal(registry.keptCount, 3);
  assert.equal(registry.pendingWriteCount, 1);

  state.waits = 0;
  registry.maintain();
  assert.equal(state.waits, 1, 'the failed delete ends the sweep before any check');
  assert.equal(registry.keptCount, 3);

  // A store that fails while the checks answer: the pass ends at the write.
  const answered = [];
  const boot = { checking: false };
  const writes = persistedRegistry({
    store,
    checkConversation: (id) => {
      if (!boot.checking) throw new Error('database is locked');
      answered.push(id);
      return false;
    },
  });
  assert.equal(writes.keptCount, 4);
  boot.checking = true;
  state.waits = 0;
  writes.recheckKeptRows();
  assert.equal(state.waits, 1);
  assert.equal(answered.length, 1, 'no further row is checked after the delete failed');

  state.locked = false;
  registry.maintain();
  registry.maintain();
  assert.equal(registry.keptCount, 0);
  assert.equal(registry.pendingWriteCount, 0);
});

test('a kept row whose conversation is gone is not revived by registering its target', () => {
  const { store, registry, previews: [site], state, logger } = keptFixture({
    randomBytes: fakeRandomBytes(9),
    checkConversation: () => !state.deleted,
  });
  state.deleted = true;
  const again = registry.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site-0' });
  assert.equal(again.ok, true);
  assert.notEqual(again.preview.token, site.token, 'the old link stays dead');
  assert.notEqual(again.existing, true);
  assert.equal(registry.resolve(site.token), null);
  assert.equal(registry.keptCount, 0);
  assert.deepEqual(store.list().map((row) => row.token), [again.preview.token]);
  assert.match(logger.lines.join('\n'), /not restored [0-9a-f]{8} "site 0": its conversation no longer exists/);
});

test('a kept row whose conversation cannot be checked is neither revived nor doubled', () => {
  const { store, registry, previews: [site], state } = keptFixture({
    checkConversation: () => { if (state.locked) throw new Error('database is locked'); return true; },
  });
  state.locked = true;
  const refused = registry.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site-0' });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 503);
  assert.equal(registry.keptCount, 1);
  assert.equal(store.list().length, 1, 'no second link');
  state.locked = false;
  const again = registry.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site-0' });
  assert.equal(again.preview.token, site.token);
});

test('knownTokens names every live and kept preview, and the stored ones while the lane is off', () => {
  const { store, registry, previews: [site] } = keptFixture({ randomBytes: fakeRandomBytes(5) });
  const live = registry.create({ conversationId: 'conv-2', port: 5173 }).preview;
  assert.deepEqual(registry.knownTokens().sort(), [site.token, live.token].sort());
  const off = persistedRegistry({ store, config: normalizePreviewsConfig({}, { relayPort: 3333, relayHostnames: RELAY_HOSTNAMES }) });
  assert.equal(off.size, 0);
  assert.deepEqual(off.knownTokens().sort(), [site.token, live.token].sort());
});

test('knownTokens keeps naming a preview whose row is still stored', () => {
  // A closed preview whose delete failed.
  const store = flakyStore();
  const registry = persistedRegistry({ store });
  const closed = registry.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/a' }).preview;
  const deleted = registry.createStatic({ conversationId: 'conv-2', rootDir: '/home/dev/b' }).preview;
  store.state.failing = true;
  registry.close(closed.token);
  registry.closeForConversation('conv-2');
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(registry.knownTokens().sort(), [closed.token, deleted.token].sort());
  registry.retryPendingWrites();
  assert.deepEqual(registry.knownTokens().sort(), [closed.token, deleted.token].sort());
  store.state.failing = false;
  registry.retryPendingWrites();
  assert.deepEqual(registry.knownTokens(), [], 'not once the deletes have landed');

  // A kept row past its bound, its delete still queued.
  const inner = createMemoryPreviewStore();
  const site = persistedRegistry({ store: inner, now: () => 1_000 }).createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site' }).preview;
  const state = { locked: true, at: 10_000 };
  const late = persistedRegistry({
    store: { ...inner, remove: (token) => { if (state.locked) throw new Error('database is locked'); return inner.remove(token); } },
    now: () => state.at,
    keptRowMaxAgeMs: 60_000,
    checkStaticRoot: () => ({ ok: false, error: 'EIO', transient: true }),
  });
  state.at += 60_000;
  late.maintain();
  late.maintain();
  assert.equal(late.keptCount, 0);
  assert.equal(inner.list().length, 1, 'the row is still stored');
  assert.deepEqual(late.knownTokens(), [site.token]);
  state.locked = false;
  late.maintain();
  assert.deepEqual(inner.list(), []);
  assert.deepEqual(late.knownTokens(), []);
});

test('with the lane off a failed read of the stored previews is never taken for no tokens', () => {
  const inner = createMemoryPreviewStore();
  const site = persistedRegistry({ store: inner }).createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site' }).preview;
  const state = { failing: true };
  const logger = captureLogger();
  const off = persistedRegistry({
    store: { ...inner, list: () => { if (state.failing) throw new Error('database is locked'); return inner.list(); } },
    config: normalizePreviewsConfig({}, { relayPort: 3333, relayHostnames: RELAY_HOSTNAMES }),
    logger,
  });
  assert.throws(() => off.knownTokens(), /could not be read/, 'nothing was read yet: no list to share with');
  assert.throws(() => off.knownTokens(), /could not be read/);
  state.failing = false;
  assert.deepEqual(off.knownTokens(), [site.token]);
  state.failing = true;
  assert.deepEqual(off.knownTokens(), [site.token], 'the last list that was read stays in use');
  assert.deepEqual(off.knownTokens(), [site.token]);
  assert.equal(logger.lines.filter((line) => line.includes('could not be read for redaction')).length, 2, 'logged once per outage');
  assert.ok(!logger.lines.join('\n').includes(site.token));
});

// ─── Failed store writes: bounded retries ───────────────────────────────────

test('a retry pass stops at the first write that fails again, and the writes take turns', () => {
  const store = flakyStore();
  const registry = persistedRegistry({ store });
  const kept = ['a', 'b', 'c'].map((name) => registry.createStatic({ conversationId: 'conv-1', rootDir: `/home/dev/${name}` }).preview);
  store.state.failing = true;
  for (const preview of kept) registry.close(preview.token);
  assert.equal(registry.pendingWriteCount, 3);

  store.state.calls.length = 0;
  assert.equal(registry.retryPendingWrites(), 3);
  assert.deepEqual(store.state.calls, ['remove'], 'one attempt per pass while the store fails, not one per pending write');
  registry.retryPendingWrites();
  registry.retryPendingWrites();
  assert.deepEqual(store.state.args.slice(-3).map(([token]) => token), kept.map((preview) => preview.token),
    'each pass tried another write');

  store.state.failing = false;
  assert.equal(registry.retryPendingWrites(), 0);
  assert.deepEqual(store.list(), []);
});

test('the shutdown flush gives up at the first write that fails', () => {
  const store = flakyStore();
  const registry = persistedRegistry({ store });
  const previews = ['a', 'b', 'c'].map((name) => registry.createStatic({ rootDir: `/home/dev/${name}` }).preview);
  for (const preview of previews) registry.recordHit(preview.token, 1_000);
  for (const preview of previews) registry.recordHit(preview.token, 2_000);
  store.state.failing = true;
  store.state.calls.length = 0;
  registry.flushHits();
  assert.deepEqual(store.state.calls, ['touch'], 'one failed last-use write ends the flush');

  registry.close(previews[0].token);
  registry.close(previews[1].token);
  store.state.calls.length = 0;
  registry.flushHits();
  assert.deepEqual(store.state.calls, ['remove'], 'a failed retry ends it before any last-use write');

  store.state.failing = false;
  registry.flushHits();
  assert.deepEqual(store.list().map((row) => [row.token, row.lastHitAt]), [[previews[2].token, 2_000]]);
});

test('the shutdown flush runs under the store\'s short wait on a locked database', () => {
  const store = flakyStore();
  const waits = [];
  store.withBusyTimeout = (ms, run) => { waits.push(ms); return run(); };
  const registry = persistedRegistry({ store });
  registry.flushHits();
  assert.equal(waits.length, 1);
  assert.ok(waits[0] <= 500, 'well under the two seconds a shutdown may take');
});

test('create and close cycles on a failing store leave nothing pending', () => {
  const store = flakyStore();
  const registry = persistedRegistry({ store, randomBytes: fakeRandomBytes(1) });
  store.state.failing = true;
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const created = registry.create({ conversationId: 'conv-1', port: 5173 });
    assert.equal(registry.pendingWriteCount, 1);
    registry.close(created.preview.token);
    assert.equal(registry.pendingWriteCount, 0, 'a row that never landed needs no delete');
  }
  assert.ok(!store.state.calls.includes('remove'));
  // Eight live ones whose inserts failed: one entry each, whatever is retried.
  for (let port = 5001; port <= 5008; port += 1) registry.create({ conversationId: 'conv-1', port });
  for (let pass = 0; pass < 20; pass += 1) registry.retryPendingWrites();
  assert.equal(registry.pendingWriteCount, 8);
  store.state.failing = false;
  assert.equal(registry.retryPendingWrites(), 0);
  assert.equal(store.list().length, 8);
});

test('a conversation delete carried out late leaves a preview registered since', () => {
  const store = flakyStore();
  const registry = persistedRegistry({ store });
  const before = registry.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site' }).preview;
  store.state.failing = true;
  assert.equal(registry.closeForConversation('conv-1'), 1);
  assert.equal(store.list().length, 1, 'the delete failed');
  // The same conversation id again (a restored conversation), same folder.
  store.state.failing = false;
  const after = registry.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site' }).preview;
  assert.notEqual(after.token, before.token);
  assert.equal(store.list().length, 2);

  assert.equal(registry.retryPendingWrites(), 0);
  assert.deepEqual(store.list().map((row) => row.token), [after.token], 'only what was there when the delete was asked for went');
  assert.equal(registry.resolve(after.token).rootDir, '/home/dev/site');
  assert.equal(persistedRegistry({ store }).resolve(after.token).rootDir, '/home/dev/site');
});

test('a late conversation delete also spares a preview whose own insert is still pending', () => {
  const store = flakyStore();
  const registry = persistedRegistry({ store });
  registry.createStatic({ conversationId: 'conv-1', rootDir: '/home/dev/site' });
  store.state.failing = true;
  registry.closeForConversation('conv-1');
  const after = registry.create({ conversationId: 'conv-1', port: 5173 }).preview;
  store.state.failing = false;
  assert.equal(registry.retryPendingWrites(), 0);
  assert.deepEqual(store.list().map((row) => row.token), [after.token]);
});
