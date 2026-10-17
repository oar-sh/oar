import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const {
  apiFetchOrThrow,
  cancelRelayRestart,
  loadWindowsAutostartSetting,
  readableServerError,
  relaunchSessionWorkerWithWorkspaceRoot,
  requestQueueEmpty,
  requestRelayRestart,
} = await import('./api-client.js');

function answer(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  });
}

async function withFetch(fetchImpl, fn) {
  const original = globalThis.fetch;
  const originalError = console.error;
  globalThis.fetch = fetchImpl;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    console.error = originalError;
  }
}

test('a failed request throws the server\'s own reason', async () => {
  await withFetch(answer(409, { error: 'worker-spawn-failed: Windows could not start node' }), async () => {
    await assert.rejects(apiFetchOrThrow('/api/x'), /^Error: worker-spawn-failed: Windows could not start node$/);
  });
});

test('without a reason in the body the HTTP status is named', async () => {
  await withFetch(answer(502, new Error('not json')), async () => {
    await assert.rejects(apiFetchOrThrow('/api/x'), /^Error: The relay answered HTTP 502\.$/);
  });
});

test('a request that never reaches the relay says so', async () => {
  const timeout = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
  await withFetch(async () => { throw timeout; }, async () => {
    await assert.rejects(apiFetchOrThrow('/api/x'), /did not answer in time/);
  });
  await withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
    await assert.rejects(apiFetchOrThrow('/api/x'), /could not be reached \(Failed to fetch\)/);
  });
});

test('a good answer is returned as apiFetch returns it', async () => {
  await withFetch(answer(200, { supported: true, mode: 'boot' }), async () => {
    assert.deepEqual(await loadWindowsAutostartSetting(), { supported: true, mode: 'boot' });
  });
});

test('the server text is cut to one plain line of bounded length', () => {
  assert.equal(readableServerError('line one\nline\u0007two\t '), 'line one line two');
  const long = readableServerError('x'.repeat(1000));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('…'));
  assert.equal(readableServerError(null), '');
});

test('the CWD relaunch reports why it failed and waits longer than a plain request', async () => {
  let signal = null;
  await withFetch(async (_url, options) => {
    signal = options.signal;
    return answer(409, { ok: false, code: 'relaunch-failed', error: 'worker-node-not-found: /home/dev/gone/node' })();
  }, async () => {
    await assert.rejects(
      relaunchSessionWorkerWithWorkspaceRoot('conv-1', '/home/dev/repo', 'key-1'),
      /^Error: worker-node-not-found: \/home\/dev\/gone\/node$/,
    );
  });
  assert.ok(signal, 'a timeout signal is set');
});

test('the error carries the HTTP status, or 0 when no answer arrived', async () => {
  await withFetch(answer(403, { error: 'Forbidden' }), async () => {
    await assert.rejects(apiFetchOrThrow('/api/x'), (error) => error.status === 403 && error.message === 'Forbidden');
  });
  await withFetch(async () => { throw new TypeError('Failed to fetch'); }, async () => {
    await assert.rejects(apiFetchOrThrow('/api/x'), (error) => error.status === 0);
  });
});

test('restart, cancel restart and empty queue throw on a refusal instead of returning null', async () => {
  for (const call of [requestRelayRestart, cancelRelayRestart, requestQueueEmpty]) {
    await withFetch(answer(403, { error: 'Refused by the proxy in front of the relay' }), async () => {
      await assert.rejects(call(), (error) => error.status === 403 && /proxy in front/.test(error.message));
    });
  }
  await withFetch(answer(200, { ok: true, accepted: true }), async () => {
    assert.deepEqual(await requestRelayRestart(), { ok: true, accepted: true });
  });
});
