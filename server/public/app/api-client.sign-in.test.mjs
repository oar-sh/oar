import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// The client's sign-in plumbing (agent auth §4.4, §4.6): the token or a
// sign-in code goes to POST /api/auth/session once, the browser session lives
// in the HttpOnly cookie, and a 401 later opens the sign-in gate. A made-up
// placeholder stands in for a credential; it is never printed.

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const {
  addRemoteRelay,
  announceDeviceId,
  apiFetch,
  apiFetchOrThrow,
  dismissRemoteRelayRefusalNotice,
  loadRemoteRelays,
  onSignedOut,
  relayRequestUrl,
  removeRemoteRelay,
  repairRemoteRelay,
  reportSignedOut,
  revokeRemoteRelayKey,
  setNetworkRequestsEnabled,
  updateConversationPreferences,
  uploadAttachment,
  verifyExistingSession,
  verifyToken,
} = await import('./api-client.js');
const { DEVICE_ID, authHeaders } = await import('./store.js');
const { SESSION_PROOF_STORAGE_KEY, getSessionProof, isOwnImageUrl, sessionProofHeaders } = await import('./session-proof.mjs');

const PLACEHOLDER = 'placeholder-credential';
// Made-up proof keys of the right shape; compared, never printed.
const KEY_A = `oark1_${'a'.repeat(43)}`;
const KEY_B = `oark1_${'b'.repeat(43)}`;
const PROOF = 'X-OAR-Session-Proof';

function setKey(value) {
  if (value) localStorage.setItem(SESSION_PROOF_STORAGE_KEY, value);
  else localStorage.removeItem(SESSION_PROOF_STORAGE_KEY);
}


function recordingFetch(answers) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', headers: { ...(options.headers || {}) }, body: options.body, credentials: options.credentials });
    const next = answers.shift() || { status: 500, body: {} };
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body, clone() { return this; } };
  };
  return { calls, impl };
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

test('verifyToken exchanges the token at POST /api/auth/session, keeps the session key it answers with, then reads the status with the key', async () => {
  setKey('');
  const { calls, impl } = recordingFetch([
    { status: 200, body: { session: { id: 'bs_x', label: 'Chrome on Windows' }, proof: KEY_A } },
    { status: 200, body: { cliOnline: true } },
  ]);
  const result = await withFetch(impl, () => verifyToken(PLACEHOLDER));
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/api/auth/session');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].credentials, 'same-origin');
  assert.ok(calls[0].headers.Authorization === `Bearer ${PLACEHOLDER}`, 'the token goes as Bearer to the exchange');
  assert.deepEqual(JSON.parse(calls[0].body), { deviceId: DEVICE_ID });
  assert.equal(calls[1].url, '/api/status');
  assert.equal(calls[1].headers.Authorization, undefined, 'the status call carries no token');
  assert.ok(calls[1].headers[PROOF] === KEY_A, 'the status call carries the session key');
  assert.ok(getSessionProof() === KEY_A, 'the key is kept for this origin');
  assert.ok(localStorage.getItem(SESSION_PROOF_STORAGE_KEY) === KEY_A);
  assert.equal(localStorage.getItem('copilot_auth_token'), null);
  assert.equal(sessionStorage.getItem('copilot_auth_token'), null);
  assert.ok(!JSON.stringify({ ...localStorage }).includes(PLACEHOLDER), 'the token is stored nowhere');
});

test('a wrong token stops at the exchange with its status', async () => {
  setKey('');
  const { calls, impl } = recordingFetch([{ status: 401, body: { error: 'Invalid token' } }]);
  const result = await withFetch(impl, () => verifyToken(PLACEHOLDER));
  assert.deepEqual({ ok: result.ok, status: result.status }, { ok: false, status: 401 });
  assert.equal(calls.length, 1);
  assert.equal(getSessionProof(), '');
});

test('verifyExistingSession with a key: the cookie and the key first; signed out, a link credential (token or ?signin= code) is exchanged', async () => {
  setKey(KEY_A);
  const cookieOnly = recordingFetch([{ status: 200, body: {} }]);
  assert.equal((await withFetch(cookieOnly.impl, () => verifyExistingSession(PLACEHOLDER))).ok, true);
  assert.equal(cookieOnly.calls.length, 1, 'a working session needs no exchange');
  assert.ok(cookieOnly.calls[0].headers[PROOF] === KEY_A);

  for (const refusal of [{ status: 401, body: { code: 'AUTH_SIGNED_OUT' } }, { status: 403, body: { code: 'AUTH_SESSION_PROOF' } }]) {
    setKey(KEY_A);
    const exchanged = recordingFetch([refusal, { status: 200, body: { session: { id: 'bs_y' }, proof: KEY_B } }, { status: 200, body: {} }]);
    const result = await withFetch(exchanged.impl, () => verifyExistingSession(PLACEHOLDER));
    assert.equal(result.ok, true);
    assert.equal(result.source, 'token');
    assert.deepEqual(exchanged.calls.map((call) => `${call.method} ${call.url}`), ['GET /api/status', 'POST /api/auth/session', 'GET /api/status']);
    assert.ok(exchanged.calls[2].headers[PROOF] === KEY_B, 'the new key from then on');
    assert.equal(exchanged.calls[1].body.includes('oark1_'), false, 'the key is never in a body');
  }

  setKey(KEY_A);
  const signedOut = recordingFetch([{ status: 401, body: { code: 'AUTH_SIGNED_OUT' } }]);
  const none = await withFetch(signedOut.impl, () => verifyExistingSession(''));
  assert.equal(none.status, 401);
  assert.equal(none.payload.code, 'AUTH_SIGNED_OUT', 'the gate can say why');
});

test('a sign-in link\'s code (Settings, or the terminal\'s oar url --sign-in) at start: exchanged once as Bearer, its session key kept and sent from then on', async () => {
  // A made-up code of the right shape; compared, never printed.
  const CODE = `oarc1_${'c'.repeat(43)}`;
  for (const before of ['', KEY_A]) {
    // No key yet (a new browser), or a key of a session gone (signed out).
    setKey(before);
    const answers = before ? [{ status: 401, body: { code: 'AUTH_SIGNED_OUT' } }] : [];
    const { calls, impl } = recordingFetch([...answers, { status: 200, body: { session: { id: 'bs_code' }, proof: KEY_B } }, { status: 200, body: {} }]);
    const result = await withFetch(impl, () => verifyExistingSession(CODE));
    assert.equal(result.ok, true);
    const exchange = calls.find((call) => call.url === '/api/auth/session');
    assert.ok(exchange && exchange.headers.Authorization === `Bearer ${CODE}`, 'the code goes as Bearer, once');
    assert.equal(calls.filter((call) => call.url === '/api/auth/session').length, 1);
    assert.ok(calls.at(-1).headers[PROOF] === KEY_B, 'the status call carries the new key');
    assert.ok(getSessionProof() === KEY_B, 'the key is kept for this origin');
    assert.ok(!JSON.stringify({ ...localStorage }).includes(CODE), 'the code is stored nowhere');
  }
});

test('no key: an old browser\'s cookie is traded once at the sign-in route (no Bearer) for a session and a key; a session cookie without its key stays signed out', async () => {
  setKey('');
  const upgraded = recordingFetch([{ status: 200, body: { session: { id: 'bs_old' }, proof: KEY_A } }, { status: 200, body: {} }]);
  const result = await withFetch(upgraded.impl, () => verifyExistingSession(''));
  assert.equal(result.ok, true);
  assert.deepEqual(upgraded.calls.map((call) => `${call.method} ${call.url}`), ['POST /api/auth/session', 'GET /api/status']);
  assert.equal(upgraded.calls[0].headers.Authorization, undefined);
  assert.equal(upgraded.calls[0].headers[PROOF], undefined);
  assert.ok(upgraded.calls[1].headers[PROOF] === KEY_A);
  assert.ok(getSessionProof() === KEY_A);

  setKey('');
  const lost = recordingFetch([{ status: 403, body: { code: 'AUTH_SESSION_PROOF' } }]);
  const refused = await withFetch(lost.impl, () => verifyExistingSession(''));
  assert.equal(refused.ok, false);
  assert.equal(refused.payload.code, 'AUTH_SESSION_PROOF', 'the gate says this browser was signed out');
  assert.equal(lost.calls.length, 1);
  assert.equal(getSessionProof(), '', 'no key made for a cookie alone');
});

// navigator.locks for one test: one holder at a time, the others in order.
async function withLocks(fn) {
  const requests = [];
  let tail = Promise.resolve();
  const locks = {
    request(name, work) {
      requests.push(name);
      const run = tail.then(() => work());
      tail = run.catch(() => {});
      return run;
    },
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true, writable: true });
  try {
    return await fn(requests);
  } finally {
    Object.defineProperty(globalThis, 'navigator', original);
  }
}

test('tabs that start together after the update trade the old cookie once (the Web Lock); the tab that waited finds the key', async () => {
  setKey('');
  const { calls, impl } = recordingFetch([
    { status: 200, body: { session: { id: 'bs_old' }, proof: KEY_A } },
    { status: 200, body: {} },
    { status: 200, body: {} },
  ]);
  await withLocks(async (requests) => {
    const [first, second] = await withFetch(impl, () => Promise.all([verifyExistingSession(''), verifyExistingSession('')]));
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(requests, ['oar-sign-in', 'oar-sign-in']);
  });
  assert.equal(calls.filter((call) => call.url === '/api/auth/session').length, 1, 'one trade, so one row');
  assert.ok(calls.filter((call) => call.url === '/api/status').every((call) => call.headers[PROOF] === KEY_A));
});

test('a trade answered 409 AUTH_UPGRADE_PENDING (another tab, no lock): the key that tab stores is used, no second trade; when none comes, the trade runs again', async () => {
  setKey('');
  const waited = recordingFetch([
    { status: 409, body: { code: 'AUTH_UPGRADE_PENDING', retryAfterSeconds: 5 } },
    { status: 200, body: {} },
  ]);
  setTimeout(() => setKey(KEY_B), 150);
  const result = await withFetch(waited.impl, () => verifyExistingSession(''));
  assert.equal(result.ok, true);
  assert.deepEqual(waited.calls.map((call) => `${call.method} ${call.url}`), ['POST /api/auth/session', 'GET /api/status']);
  assert.ok(waited.calls[1].headers[PROOF] === KEY_B);

  setKey('');
  const lost = recordingFetch([
    { status: 409, body: { code: 'AUTH_UPGRADE_PENDING', retryAfterSeconds: 0.2 } },
    { status: 200, body: { session: { id: 'bs_again' }, proof: KEY_A } },
    { status: 200, body: {} },
  ]);
  const again = await withFetch(lost.impl, () => verifyExistingSession(''));
  assert.equal(again.ok, true);
  assert.deepEqual(lost.calls.map((call) => `${call.method} ${call.url}`), ['POST /api/auth/session', 'POST /api/auth/session', 'GET /api/status']);
  assert.ok(getSessionProof() === KEY_A);
});

test('a 403 AUTH_COOKIE_UPGRADE on an API call is no sign-out: the old cookie is traded quietly and the call goes again with the key', async () => {
  const seen = [];
  onSignedOut((url) => seen.push(url));
  try {
    setKey('');
    const { calls, impl } = recordingFetch([
      { status: 403, body: { code: 'AUTH_COOKIE_UPGRADE' } },
      { status: 200, body: { session: { id: 'bs_old' }, proof: KEY_A } },
      { status: 200, body: { conversations: [] } },
    ]);
    assert.deepEqual(await withFetch(impl, () => apiFetch('/api/conversations')), { conversations: [] });
    assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ['GET /api/conversations', 'POST /api/auth/session', 'GET /api/conversations']);
    assert.equal(calls[1].headers.Authorization, undefined, 'the trade sends no token');
    assert.ok(calls[2].headers[PROOF] === KEY_A);
    assert.ok(getSessionProof() === KEY_A);

    // apiFetchOrThrow the same; a key this page sent with the old cookie is no key of its: dropped, traded anew.
    const write = recordingFetch([
      { status: 403, body: { code: 'AUTH_COOKIE_UPGRADE' } },
      { status: 200, body: { session: { id: 'bs_old2' }, proof: KEY_B } },
      { status: 200, body: { saved: true } },
    ]);
    assert.deepEqual(await withFetch(write.impl, () => apiFetchOrThrow('/api/settings/openai', { method: 'POST', body: '{}' })), { saved: true });
    assert.deepEqual(write.calls.map((call) => `${call.method} ${call.url}`), ['POST /api/settings/openai', 'POST /api/auth/session', 'POST /api/settings/openai']);
    assert.equal(write.calls[1].headers[PROOF], undefined);
    assert.ok(write.calls[2].headers[PROOF] === KEY_B);
    assert.deepEqual(seen, [], 'the sign-in page never opens');

    // A trade the relay refuses as signed out (the token was replaced) opens the gate.
    setKey('');
    const refused = recordingFetch([
      { status: 403, body: { code: 'AUTH_COOKIE_UPGRADE' } },
      { status: 401, body: { code: 'AUTH_SIGNED_OUT' } },
    ]);
    assert.equal(await withFetch(refused.impl, () => apiFetch('/api/conversations')), null);
    assert.equal(refused.calls.length, 2);
    assert.deepEqual(seen, ['/api/conversations']);
  } finally {
    onSignedOut(null);
  }
});

test('every API request carries the key: authHeaders, apiFetch, uploads; a sign-in answer\'s key is never handed to callers', async () => {
  setKey(KEY_A);
  assert.ok(authHeaders('/api/conversations')[PROOF] === KEY_A);
  const { calls, impl } = recordingFetch([{ status: 200, body: {} }, { status: 200, body: { ok: true } }]);
  await withFetch(impl, async () => {
    await apiFetch('/api/conversations');
    await uploadAttachment({ file: new dom.window.Blob(['x']), name: 'a.txt', type: 'text/plain' });
  });
  assert.ok(calls.every((call) => call.headers[PROOF] === KEY_A), 'both requests carry the key');
  setKey('');
  assert.equal(authHeaders('/api/conversations')[PROOF], undefined);
});

test('the key goes to this relay\'s own /api only: never to another origin, a path outside /api, or a call without an address', async () => {
  setKey(KEY_A);
  try {
    // This relay's API, relative or absolute: the key.
    for (const url of ['/api/status', 'http://localhost/api/upload/abc/content', '/api/x/../conversations']) {
      assert.ok(sessionProofHeaders(url)[PROOF] === KEY_A, url);
      assert.ok(authHeaders(url)[PROOF] === KEY_A, url);
    }
    // Anything else: nothing (no URL at all fails closed).
    const elsewhere = [
      undefined,
      '',
      'http://localhost:5173/x.png',
      'http://localhost:5173/api/status',
      '//localhost:5173/api/status',
      'https://localhost/api/status',
      'http://127.0.0.1/api/status',
      '/x.png',
      '/api',
      '/apix/status',
      '/api/../x.png',
      '/app/main.js',
      'data:image/png;base64,AAAA',
      'blob:http://localhost/0d7c6a0e',
    ];
    for (const url of elsewhere) {
      assert.deepEqual(sessionProofHeaders(url), {}, String(url));
      assert.deepEqual(authHeaders(url), {}, String(url));
    }
    // A base path: its /api only. platform-agnostic: URL paths, never file paths.
    assert.ok(sessionProofHeaders('/oar/api/status', '/oar')[PROOF] === KEY_A);
    assert.deepEqual(sessionProofHeaders('/api/status', '/oar'), {});
    assert.deepEqual(sessionProofHeaders('/other/api/status', '/oar'), {});
  } finally {
    setKey('');
  }
});

test('apiFetch and apiFetchOrThrow send nothing to an address that leaves this relay (//host, /\\host, an absolute URL)', async () => {
  setKey(KEY_A);
  try {
    const { calls, impl } = recordingFetch([]);
    await withFetch(impl, async () => {
      for (const url of ['//localhost:5173/api/status', '/\\localhost:5173/api/status', '/\t/localhost:5173/api/status', 'http://localhost:5173/api/status', 'api/status', undefined]) {
        assert.equal(await apiFetch(url), null, String(url));
        await assert.rejects(() => apiFetchOrThrow(url), (error) => error.status === 0, String(url));
      }
    });
    assert.equal(calls.length, 0, 'no request went out');
    assert.equal(relayRequestUrl('/api/status'), '/api/status');
    assert.equal(relayRequestUrl('//evil.example/api/status'), '');
  } finally {
    setKey('');
  }
});

test('a picture the marker editor may fetch: this origin or inline; another address (an agent\'s server on another port) is never fetched', () => {
  for (const url of ['/api/upload/abc/content', 'http://localhost/api/generated/1.png', 'blob:http://localhost/0d7c6a0e', 'data:image/png;base64,AAAA']) {
    assert.equal(isOwnImageUrl(url), true, url);
  }
  for (const url of ['http://localhost:5173/x.png', '//localhost:5173/x.png', 'https://images.example/x.png', 'blob:http://localhost:5173/0d7c6a0e', 'data:text/html,hi', '', undefined]) {
    assert.equal(isOwnImageUrl(url), false, String(url));
  }
});

test('a 401, or a 403 AUTH_SESSION_PROOF, tells the app this browser is signed out (and drops the dead key); another 403 does not', async () => {
  const seen = [];
  onSignedOut((url) => seen.push(url));
  try {
    setKey(KEY_A);
    const { impl } = recordingFetch([
      { status: 401, body: { code: 'AUTH_SIGNED_OUT' } },
      { status: 403, body: { code: 'AUTH_PERSON_REQUIRED' } },
      { status: 403, body: { code: 'AUTH_SESSION_PROOF' } },
    ]);
    await withFetch(impl, async () => {
      assert.equal(await apiFetch('/api/conversations'), null);
      setKey(KEY_A);
      assert.equal(await apiFetch('/api/settings/openai', { method: 'POST', body: '{}' }), null);
      assert.ok(getSessionProof() === KEY_A, 'an ordinary 403 keeps the key');
      assert.equal(await apiFetch('/api/status'), null);
    });
    assert.deepEqual(seen, ['/api/conversations', '/api/status']);
    assert.equal(getSessionProof(), '');
  } finally {
    onSignedOut(null);
  }
});

test('signing this browser out drops its key; the device id is announced once with the key, never without one', async () => {
  setKey(KEY_A);
  reportSignedOut('bye');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(getSessionProof(), '');

  const none = recordingFetch([]);
  assert.equal(await withFetch(none.impl, () => announceDeviceId()), false);
  assert.equal(none.calls.length, 0);

  setKey(KEY_A);
  const renewal = recordingFetch([{ status: 200, body: { session: { id: 'bs_z' }, renewed: true } }]);
  assert.equal(await withFetch(renewal.impl, () => announceDeviceId()), true);
  assert.deepEqual(renewal.calls.map((call) => `${call.method} ${call.url}`), ['POST /api/auth/session']);
  assert.ok(renewal.calls[0].headers[PROOF] === KEY_A);
  assert.equal(renewal.calls[0].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(renewal.calls[0].body), { deviceId: DEVICE_ID });
  assert.ok(getSessionProof() === KEY_A, 'a renewal keeps the key');
});

test('Settings → Relays and the Inbox send the session key with the cookie, never a token', async () => {
  setKey(KEY_A);
  const ok = { status: 200, body: { ok: true } };
  const { calls, impl } = recordingFetch([ok, ok, ok, ok, ok, ok, ok]);
  await withFetch(impl, async () => {
    await loadRemoteRelays();
    await addRemoteRelay({ url: 'https://relay-b.example.test', pairBack: false });
    await repairRemoteRelay('rr_one');
    await revokeRemoteRelayKey('rr_one');
    await dismissRemoteRelayRefusalNotice('rr_one');
    await removeRemoteRelay('rr_one');
    await apiFetch('/api/inbox');
  });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'GET /api/remote-relays',
    'POST /api/remote-relays',
    'POST /api/remote-relays/rr_one/repair',
    'POST /api/remote-relays/rr_one/revoke-key',
    'POST /api/remote-relays/rr_one/refusal-notice/dismiss',
    'DELETE /api/remote-relays/rr_one',
    'GET /api/inbox',
  ]);
  for (const call of calls) {
    assert.ok(call.headers[PROOF] === KEY_A, `${call.method} ${call.url} carries the key`);
    assert.equal(call.headers.Authorization, undefined, `${call.method} ${call.url} carries no token`);
  }
});

test('the page\'s outbox keeps a queued send refused for this browser\'s sign-in (401, 403 AUTH_SESSION_PROOF or AUTH_COOKIE_UPGRADE); other 4xx finish it', async () => {
  const { isFinalResponse } = await import('./sync-outbox.mjs');
  const answer = (status, body = {}) => {
    const response = { ok: status >= 200 && status < 300, status, json: async () => body, clone: () => response };
    return response;
  };
  for (const kept of [answer(401, { code: 'AUTH_SIGNED_OUT' }), answer(403, { code: 'AUTH_SESSION_PROOF' }), answer(403, { code: 'AUTH_COOKIE_UPGRADE' }), answer(408), answer(429), answer(502), null]) {
    assert.equal(await isFinalResponse(kept), false, String(kept?.status));
  }
  for (const finished of [answer(200), answer(400), answer(403, { code: 'AUTH_CROSS_SITE' }), answer(403), answer(409, { code: 'DUPLICATE_MESSAGE_ID' })]) {
    assert.equal(await isFinalResponse(finished), true, String(finished.status));
  }
});

test('a refusal reported with the key it carried drops the stored key only when it is still that one', async () => {
  const seen = [];
  onSignedOut((url) => seen.push(url));
  try {
    // Another tab stored KEY_B after the refused handshake sent KEY_A: it stays.
    setKey(KEY_B);
    reportSignedOut('', { sentProof: KEY_A });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(getSessionProof() === KEY_B, 'a newer key stays');
    // The refused key itself goes.
    reportSignedOut('', { sentProof: KEY_B });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(getSessionProof(), '');
    // No key sent: nothing stored is dropped.
    setKey(KEY_A);
    reportSignedOut('', { sentProof: '' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(getSessionProof() === KEY_A);
    assert.equal(seen.length, 3, 'each one opens the sign-in gate');
  } finally {
    onSignedOut(null);
    setKey('');
  }
});

test('signing out (on purpose, or a 401 / 403 AUTH_SESSION_PROOF) and signing in as a new session forget the file capabilities (k) made for the session before', async () => {
  const { configureFileCapabilities, fileSrcAttribute, resetFileCapabilities, signFileUrls } = await import('./file-capability.mjs');
  let mints = 0;
  let serial = 0;
  const expiry = Math.floor((Date.now() + 10 * 60_000) / 1000).toString(36);
  configureFileCapabilities({
    base: '',
    origin: () => 'http://localhost',
    mint: async (urls) => {
      mints += 1;
      serial += 1;
      return { urls: urls.map((url) => `${url}?k=fc1.bs_test.${expiry}.${String(serial).padStart(43, 'm')}`) };
    },
  });
  const FILE = '/api/files/report.pdf';
  const deferred = `data-oar-file-src="${FILE}"`;
  const cached = async () => {
    const before = mints;
    await signFileUrls([FILE]);
    return mints === before;
  };
  const seen = [];
  onSignedOut((url) => seen.push(url));
  try {
    resetFileCapabilities();
    setKey(KEY_A);
    await signFileUrls([FILE]);
    assert.equal(await cached(), true, 'a k is cached for the session');

    // "Sign out this browser" (and "Sign it out" on this very browser).
    reportSignedOut('bye');
    assert.equal(fileSrcAttribute(FILE), deferred, 'no k of the old session is handed out');
    assert.equal(await cached(), false, 'the next ask mints fresh');

    // A refusal reported by the socket with the key it carried.
    reportSignedOut('', { sentProof: KEY_A });
    assert.equal(fileSrcAttribute(FILE), deferred);
    assert.equal(await cached(), false);

    // A 401 on an API call.
    setKey(KEY_A);
    const refused = recordingFetch([{ status: 401, body: { code: 'AUTH_SIGNED_OUT' } }]);
    await withFetch(refused.impl, () => apiFetch('/api/conversations'));
    assert.equal(fileSrcAttribute(FILE), deferred);
    assert.equal(await cached(), false);

    // A sign-in that stores a new key: a new session, so the cache starts empty.
    const signIn = recordingFetch([
      { status: 200, body: { session: { id: 'bs_n' }, proof: KEY_B } },
      { status: 200, body: { cliOnline: true } },
    ]);
    assert.equal((await withFetch(signIn.impl, () => verifyToken(PLACEHOLDER))).ok, true);
    assert.ok(getSessionProof() === KEY_B);
    assert.equal(fileSrcAttribute(FILE), deferred, 'nothing from before the sign-in');
    assert.equal(await cached(), false, 'minted fresh for the new session');

    // A renewal of the same session (no key, or the same key) keeps them.
    const renewal = recordingFetch([{ status: 200, body: { session: { id: 'bs_n' }, proof: KEY_B } }]);
    assert.equal(await withFetch(renewal.impl, () => announceDeviceId()), true);
    assert.equal(await cached(), true, 'the same session: the cache stays');
    assert.equal(seen.length, 3, 'each sign-out opened the sign-in gate');
  } finally {
    onSignedOut(null);
    setKey('');
    resetFileCapabilities();
    configureFileCapabilities({ mint: null });
  }
});

// A save made in `pagehide` (the context modal's window slider) is a
// keepalive request: the browser keeps it only when fetch() is called before
// the handler returns. Nothing may be awaited before it: no renewal, no
// storage read, no lock, not even a resolved promise.
test('a keepalive request is started synchronously, with the session key, even with network work paused', async () => {
  setKey(KEY_A);
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, options = {}) => {
    calls.push({ url: String(url), keepalive: options.keepalive, headers: { ...(options.headers || {}) } });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }), clone() { return this; } });
  };
  setNetworkRequestsEnabled(false);
  try {
    const viaPreferences = updateConversationPreferences('conv-closing', { autoCompactWindow: 300000 }, { keepalive: true });
    assert.equal(calls.length, 1, 'fetch was called before the first await');
    const viaApiFetch = apiFetch('/api/conversation/conv-closing/preferences', { method: 'PATCH', body: '{}', keepalive: true });
    assert.equal(calls.length, 2, 'apiFetch calls fetch before the first await');
    for (const call of calls) {
      assert.equal(call.url, '/api/conversation/conv-closing/preferences');
      assert.equal(call.keepalive, true);
      assert.ok(call.headers[PROOF] === KEY_A, 'the session key goes with it');
    }
    await Promise.all([viaPreferences, viaApiFetch]);
    // A request without keepalive is not sent while network work is paused.
    assert.equal(await apiFetch('/api/conversations'), null);
    assert.equal(calls.length, 2);
  } finally {
    setNetworkRequestsEnabled(true);
    globalThis.fetch = original;
    setKey('');
  }
});
