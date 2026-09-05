import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  UPDATE_AUTO_CHECK_SETTING_KEY,
  createUpdateCheckService,
  isUpdateCheckKilled,
  resolveUpdateManifestUrl,
} from './update-check-service.mjs';

function settingsStore(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    readSetting: (key) => rows.get(key) || '',
    writeSetting: (key, value) => rows.set(key, String(value)),
  };
}

function manifestResponse({ stable = '0.9.2', beta = null, schemaVersion = 1, critical = false, etag = '"m1"' } = {}) {
  const channels = { stable: { version: stable, notesUrl: 'https://example.invalid/notes', publishedAt: '2026-09-05T00:00:00Z', critical } };
  if (beta) channels.beta = { version: beta, notesUrl: 'https://example.invalid/beta', publishedAt: '2026-09-05T00:00:00Z', critical };
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'etag' ? etag : null) },
    json: async () => ({ schemaVersion, channels }),
  };
}

function createService(store, overrides = {}) {
  return createUpdateCheckService({
    runningVersion: '0.9.1',
    installMethod: 'npm-global',
    manifestUrl: 'https://example.invalid/latest.json',
    readSetting: store.readSetting,
    writeSetting: store.writeSetting,
    setTimeoutImpl: () => null,
    clearTimeoutImpl: () => {},
    randomImpl: () => 0.5,
    nowImpl: () => Date.parse('2026-09-05T12:00:00Z'),
    logger: { warn: () => {} },
    ...overrides,
  });
}

test('the kill switch and manifest URL override read from env', () => {
  assert.equal(isUpdateCheckKilled({ OAR_NO_UPDATE_CHECK: '1' }), true);
  assert.equal(isUpdateCheckKilled({ OAR_NO_UPDATE_CHECK: '' }), false);
  assert.equal(isUpdateCheckKilled({}), false);
  assert.equal(resolveUpdateManifestUrl({ OAR_UPDATE_MANIFEST_URL: 'http://127.0.0.1:9/x.json' }), 'http://127.0.0.1:9/x.json');
  assert.match(resolveUpdateManifestUrl({}), /^https:\/\/oar\.sh\//);
});

test('auto-check is opt-in: default snapshot is disabled and startIfEnabled stays quiet', () => {
  const store = settingsStore();
  let fetches = 0;
  const service = createService(store, { fetchImpl: async () => { fetches += 1; return manifestResponse(); } });
  assert.equal(service.getSnapshot().autoCheckEnabled, false);
  assert.equal(service.startIfEnabled(), false);
  assert.equal(fetches, 0, 'no opt-in, no network traffic');
});

test('a successful check stores the result, etag, and reports availability', async () => {
  const store = settingsStore();
  const service = createService(store, { fetchImpl: async () => manifestResponse({ stable: '0.9.2' }) });
  const snapshot = await service.checkNow();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.version, '0.9.2');
  assert.equal(snapshot.notesUrl, 'https://example.invalid/notes');
  assert.equal(snapshot.dismissed, false);
  assert.equal(store.rows.get('update_check_etag'), '"m1"');
  assert.ok(snapshot.lastCheckedAt);
});

test('an equal or older manifest version is not an update', async () => {
  const store = settingsStore();
  const service = createService(store, { fetchImpl: async () => manifestResponse({ stable: '0.9.1' }) });
  const snapshot = await service.checkNow();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.version, null);
});

test('a beta running version follows the beta channel', async () => {
  const store = settingsStore();
  const service = createService(store, {
    runningVersion: '0.9.1-beta.1',
    fetchImpl: async () => manifestResponse({ stable: '0.9.1', beta: '0.9.1-beta.3' }),
  });
  const snapshot = await service.checkNow();
  assert.equal(snapshot.channel, 'beta');
  assert.equal(snapshot.version, '0.9.1-beta.3');
});

test('network failures, HTTP errors, and garbage are all silent', async () => {
  const store = settingsStore();
  for (const fetchImpl of [
    async () => { throw new Error('boom'); },
    async () => ({ ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) }),
    async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error('bad json'); } }),
  ]) {
    const service = createService(store, { fetchImpl });
    const snapshot = await service.checkNow();
    assert.equal(snapshot.available, false);
  }
});

test('a 304 keeps the cached result and refreshes the check timestamp', async () => {
  const store = settingsStore();
  let requests = [];
  const service = createService(store, {
    fetchImpl: async (url, options) => {
      requests.push(options.headers['If-None-Match'] || null);
      if (requests.length === 1) return manifestResponse({ etag: '"m7"' });
      return { ok: false, status: 304, headers: { get: () => null }, json: async () => ({}) };
    },
  });
  await service.checkNow();
  const second = await service.checkNow();
  assert.deepEqual(requests, [null, '"m7"'], 'the stored etag rides If-None-Match');
  assert.equal(second.available, true, 'cached result survives a 304');
});

test('an orphaned etag without a cached result is not revalidated', async () => {
  const store = settingsStore({ update_check_etag: '"orphan"' });
  const requests = [];
  const service = createService(store, {
    fetchImpl: async (url, options) => {
      requests.push(options.headers['If-None-Match'] || null);
      return manifestResponse();
    },
  });
  const snapshot = await service.checkNow();
  assert.deepEqual(requests, [null], 'no If-None-Match — a 304 would report nothing forever');
  assert.equal(snapshot.available, true);
});

test('an unknown schemaVersion stops checking and warns exactly once', async () => {
  const store = settingsStore();
  const warnings = [];
  const service = createService(store, {
    fetchImpl: async () => manifestResponse({ schemaVersion: 2 }),
    logger: { warn: (message) => warnings.push(message) },
  });
  await service.checkNow();
  await service.checkNow();
  const snapshot = service.getSnapshot();
  assert.equal(snapshot.schemaUnsupported, true);
  assert.equal(snapshot.available, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /schemaVersion/);
});

test('dismissal is per-version and refused for critical updates', async () => {
  const store = settingsStore();
  const service = createService(store, { fetchImpl: async () => manifestResponse({ stable: '0.9.2' }) });
  await service.checkNow();
  assert.equal(service.dismissVersion('0.8.0').ok, false, 'version mismatch refused');
  assert.equal(service.dismissVersion('0.9.2').ok, true);
  assert.equal(service.getSnapshot().dismissed, true);

  const criticalStore = settingsStore();
  const criticalService = createService(criticalStore, { fetchImpl: async () => manifestResponse({ stable: '0.9.3', critical: true }) });
  await criticalService.checkNow();
  const refused = criticalService.dismissVersion('0.9.3');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /critical/);
  assert.equal(criticalService.getSnapshot().dismissed, false);
});

test('setAutoCheck opts in, checks immediately, and arms the jittered timer', async () => {
  const store = settingsStore();
  const delays = [];
  let fetches = 0;
  const service = createService(store, {
    fetchImpl: async () => { fetches += 1; return manifestResponse(); },
    setTimeoutImpl: (fn, delay) => { delays.push(delay); return { unref: () => {} }; },
    randomImpl: () => 1, // max jitter
  });
  service.setAutoCheck(true);
  assert.equal(store.rows.get(UPDATE_AUTO_CHECK_SETTING_KEY), '1');
  await service.checkNow();
  assert.ok(fetches >= 1);
  assert.equal(delays[0], 13 * 3_600_000, 'interval + full positive jitter');

  service.setAutoCheck(false);
  assert.equal(store.rows.get(UPDATE_AUTO_CHECK_SETTING_KEY), '0');
});

test('jitter stays inside ±1h of the 12h interval', () => {
  for (const [random, expected] of [[0, 11 * 3_600_000], [1, 13 * 3_600_000], [0.5, 12 * 3_600_000]]) {
    const delays = [];
    const store = settingsStore({ [UPDATE_AUTO_CHECK_SETTING_KEY]: '1' });
    const service = createService(store, {
      fetchImpl: async () => manifestResponse(),
      setTimeoutImpl: (fn, delay) => { delays.push(delay); return { unref: () => {} }; },
      randomImpl: () => random,
    });
    service.startIfEnabled();
    assert.equal(delays[0], expected);
  }
});

test('the etag flow works against a real HTTP server', async () => {
  const body = JSON.stringify({
    schemaVersion: 1,
    channels: { stable: { version: '0.9.5', notesUrl: 'n', publishedAt: 'p', critical: false } },
  });
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.headers['if-none-match'] || null);
    if (req.headers['if-none-match'] === '"live-1"') {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.setHeader('ETag', '"live-1"');
    res.setHeader('Content-Type', 'application/json');
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/latest.json`;
  try {
    const store = settingsStore();
    const service = createService(store, { manifestUrl: url, fetchImpl: globalThis.fetch });
    const first = await service.checkNow();
    const second = await service.checkNow();
    assert.equal(first.available, true);
    assert.equal(second.available, true);
    assert.deepEqual(hits, [null, '"live-1"']);
  } finally {
    // undici's keep-alive pool would otherwise hold the socket and hang close.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
