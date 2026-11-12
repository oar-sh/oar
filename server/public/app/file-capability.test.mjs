import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// The page side of file capabilities (`k`): file addresses in the document
// get one (asked for in one request), links get a new one before theirs
// runs out, and a failed media load gets a new one once.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.MutationObserver = dom.window.MutationObserver;

const {
  DEFERRED_FILE_SRC_ATTR,
  configureFileCapabilities,
  fileCapabilityKeyOf,
  fileSrcAttribute,
  hydrateFileCapabilities,
  installFileCapabilityPolicy,
  resetFileCapabilities,
  signFileUrls,
} = await import('./file-capability.mjs');

const clock = { now: 1_800_000_000_000 };
let minted = [];
let serial = 0;

function capabilityFor(expMs) {
  serial += 1;
  return `fc1.bs_test.${Math.floor(expMs / 1000).toString(36)}.${String(serial).padStart(43, 'm')}`;
}

function setup({ base = '' } = {}) {
  resetFileCapabilities();
  minted = [];
  configureFileCapabilities({
    base,
    now: () => clock.now,
    origin: () => 'http://localhost',
    mint: async (urls) => {
      minted.push(urls);
      const k = capabilityFor(clock.now + 10 * 60_000);
      return { urls: urls.map((url) => `${url}${url.includes('?') ? '&' : '?'}k=${k}`) };
    },
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
// The policy signs inserted elements from a mutation observer plus one batched mint: on a
// loaded host that can take longer than one short tick, so wait for the result, bounded.
async function settleUntil(done, timeoutMs = 3000) {
  const start = Date.now();
  await settle();
  while (!done() && Date.now() - start < timeoutMs) await settle();
}
const kOf = (url) => new URL(url, 'http://localhost').searchParams.get('k') || '';

test('only the two file-by-path routes of this origin are file addresses; the key leaves k, v and as out', () => {
  setup({ base: '/relay' });
  assert.equal(fileCapabilityKeyOf('/relay/api/drives/file?path=%2Fa.png&v=1&as=x.png&k=old'), '/relay/api/drives/file?path=%2Fa.png');
  assert.equal(fileCapabilityKeyOf('/relay/api/files/docs/a.png?conversationId=c1'), '/relay/api/files/docs/a.png?conversationId=c1');
  for (const other of ['/relay/api/upload/abc/content', '/relay/api/files-preview/a.md', 'https://example.invalid/api/drives/file?path=%2Fa', 'data:image/png;base64,AA', '']) {
    assert.equal(fileCapabilityKeyOf(other), '', other);
  }
});

test('many addresses, one request; a cached k is used until it runs low; force asks again', async () => {
  setup();
  const urls = ['/api/drives/file?path=%2Fa.png', '/api/files/b.png', '/api/drives/file?path=%2Fa.png&v=2', '/elsewhere.png'];
  const signed = await signFileUrls(urls);
  assert.equal(minted.length, 1);
  assert.deepEqual(minted[0], ['/api/drives/file?path=%2Fa.png', '/api/files/b.png']);
  assert.ok(kOf(signed[0]) && kOf(signed[1]));
  assert.equal(signed[2], `/api/drives/file?path=%2Fa.png&v=2&k=${kOf(signed[0])}`, 'the same file: the same k, the version kept');
  assert.equal(signed[3], '/elsewhere.png');
  await signFileUrls([urls[0]]);
  assert.equal(minted.length, 1, 'from the cache');
  clock.now += 9.5 * 60_000;
  await signFileUrls([urls[0]]);
  assert.equal(minted.length, 2, 'under a minute left: asked again');
  await signFileUrls([urls[0]], { force: true });
  assert.equal(minted.length, 3);
});

test('HTML for a media element: a cached k at once, else the address waits in data-oar-file-src', async () => {
  setup();
  assert.equal(fileSrcAttribute('/api/files/c.png'), `${DEFERRED_FILE_SRC_ATTR}="/api/files/c.png"`);
  const [signed] = await signFileUrls(['/api/files/c.png']);
  assert.equal(fileSrcAttribute('/api/files/c.png'), `src="${signed}"`);
  assert.equal(fileSrcAttribute('/api/upload/abc/content?x="1"'), 'src="/api/upload/abc/content?x=&quot;1&quot;"');
});

test('the policy: inserted media, links and the viewer\'s new-tab button get their k; links get a new one before theirs runs out', async () => {
  setup();
  const stop = installFileCapabilityPolicy({ documentRef: document, intervalMs: 60 * 60_000 });
  try {
    document.body.innerHTML = `
      <img ${DEFERRED_FILE_SRC_ATTR}="/api/drives/file?path=%2Fpic.png" alt="">
      <video src="/api/files/clip.mp4"></video>
      <a href="/api/files/doc.pdf" download="doc.pdf">Download</a>
      <button data-viewer-open-tab="/api/drives/file?path=%2Fdoc.pdf">Open in new tab</button>
      <img src="https://example.invalid/x.png" alt="">`;
    await settleUntil(() => !document.querySelector(`[${DEFERRED_FILE_SRC_ATTR}]`)
      && Boolean(kOf(document.querySelector('a').getAttribute('href'))));
    const img = document.querySelector('img');
    assert.equal(img.hasAttribute(DEFERRED_FILE_SRC_ATTR), false);
    assert.ok(kOf(img.getAttribute('src')), 'the image got its k');
    assert.ok(kOf(document.querySelector('video').getAttribute('src')));
    const link = document.querySelector('a');
    const firstK = kOf(link.getAttribute('href'));
    assert.ok(firstK);
    assert.ok(kOf(document.querySelector('button').getAttribute('data-viewer-open-tab')));
    assert.equal(document.querySelectorAll('img')[1].getAttribute('src'), 'https://example.invalid/x.png');
    assert.equal(minted.length, 1, 'one request for all of them');

    // Eight minutes on: the link is given a new k, the loaded media is left alone.
    const videoSrc = document.querySelector('video').getAttribute('src');
    clock.now += 8 * 60_000;
    await hydrateFileCapabilities(document.documentElement, { refreshLinks: true });
    const secondK = kOf(link.getAttribute('href'));
    assert.ok(secondK && secondK !== firstK, 'a fresh k on the link');
    assert.equal(document.querySelector('video').getAttribute('src'), videoSrc);
  } finally {
    stop();
    document.body.innerHTML = '';
  }
});

test('a failed media load gets a new k once (the page sees no error); a second failure soon after is passed on', async () => {
  setup();
  const stop = installFileCapabilityPolicy({ documentRef: document, intervalMs: 60 * 60_000 });
  try {
    const [signed] = await signFileUrls(['/api/files/gone-soon.png']);
    document.body.innerHTML = `<img src="${signed}" alt="">`;
    const img = document.querySelector('img');
    let seen = 0;
    img.addEventListener('error', () => { seen += 1; });
    const before = minted.length;
    img.dispatchEvent(new dom.window.Event('error'));
    await settle();
    assert.equal(seen, 0, 'held back while a new k is asked for');
    assert.equal(minted.length, before + 1);
    const again = img.getAttribute('src');
    assert.ok(kOf(again) && kOf(again) !== kOf(signed), 'a new k');
    img.dispatchEvent(new dom.window.Event('error'));
    await settle();
    assert.equal(seen, 1, 'the second failure is the page\'s');
  } finally {
    stop();
    document.body.innerHTML = '';
  }
});

test('without an answer (no session, offline) a deferred address stays deferred: nothing loads without k', async () => {
  resetFileCapabilities();
  configureFileCapabilities({ base: '', now: () => clock.now, origin: () => 'http://localhost', mint: async () => null });
  document.body.innerHTML = `<img ${DEFERRED_FILE_SRC_ATTR}="/api/files/x.png" alt="">`;
  await hydrateFileCapabilities(document.body);
  const img = document.querySelector('img');
  assert.equal(img.getAttribute('src'), null);
  assert.equal(img.getAttribute(DEFERRED_FILE_SRC_ATTR), '/api/files/x.png');
  document.body.innerHTML = '';
});

test('a reset (signed out, signed in anew) empties the cache: the next hydrate asks again, and a link still carrying an old k gets a new one', async () => {
  setup();
  const [signed] = await signFileUrls(['/api/files/kept.pdf']);
  const oldK = kOf(signed);
  assert.ok(oldK);
  document.body.innerHTML = `<a href="${signed}">Download</a><img ${DEFERRED_FILE_SRC_ATTR}="/api/files/kept.pdf" alt="">`;
  try {
    resetFileCapabilities();
    assert.equal(fileSrcAttribute('/api/files/kept.pdf'), `${DEFERRED_FILE_SRC_ATTR}="/api/files/kept.pdf"`, 'no old k handed out');
    const before = minted.length;
    await hydrateFileCapabilities(document.body);
    assert.equal(minted.length, before + 1, 'asked anew, in one request');
    const linkK = kOf(document.querySelector('a').getAttribute('href'));
    const imgK = kOf(document.querySelector('img').getAttribute('src'));
    assert.ok(linkK && linkK !== oldK, 'the link carries a new k');
    assert.ok(imgK && imgK !== oldK, 'the deferred image got a new k');
  } finally {
    document.body.innerHTML = '';
  }
});

test('an answer that arrives after a reset brings nothing: no k in the cache, the element stays deferred, the next ask mints fresh', async () => {
  setup();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const asked = [];
  configureFileCapabilities({
    mint: async (urls) => {
      asked.push(urls);
      await held;
      const k = capabilityFor(clock.now + 10 * 60_000);
      return { urls: urls.map((url) => `${url}?k=${k}`) };
    },
  });
  document.body.innerHTML = `<img ${DEFERRED_FILE_SRC_ATTR}="/api/files/late.png" alt="">`;
  try {
    const hydrating = hydrateFileCapabilities(document.body);
    const queued = signFileUrls(['/api/files/queued.png']);
    await settle();
    assert.equal(asked.length, 1, 'the request is on its way');
    resetFileCapabilities();
    release();
    await hydrating;
    const img = document.querySelector('img');
    assert.equal(img.getAttribute('src'), null, 'the old session\'s k is not put in the page');
    assert.equal(img.getAttribute(DEFERRED_FILE_SRC_ATTR), '/api/files/late.png');
    assert.deepEqual(await queued, ['/api/files/queued.png'], 'its answer is not used');
    assert.equal(fileSrcAttribute('/api/files/late.png'), `${DEFERRED_FILE_SRC_ATTR}="/api/files/late.png"`, 'nor kept in the cache');

    // A request queued and then dropped by a reset settles (without a k).
    configureFileCapabilities({ mint: async (urls) => { asked.push(urls); return null; } });
    const dropped = signFileUrls(['/api/files/dropped.png']);
    resetFileCapabilities();
    assert.deepEqual(await dropped, ['/api/files/dropped.png']);
    await settle();
    assert.equal(asked.length, 1, 'a dropped request is never sent');

    setup();
    await hydrateFileCapabilities(document.body);
    assert.equal(minted.length, 1, 'the next ask mints fresh');
    assert.ok(kOf(img.getAttribute('src')));
  } finally {
    document.body.innerHTML = '';
  }
});

test('another tab changes the proof key (signed out, or in anew): this page\'s k cache goes and its links get a new k', async () => {
  setup();
  const { SESSION_PROOF_STORAGE_KEY } = await import('./session-proof.mjs');
  const [signed] = await signFileUrls(['/api/files/shared.png']);
  const oldK = kOf(signed);
  document.body.innerHTML = `<a href="${signed}">Download</a>`;
  const stop = installFileCapabilityPolicy({ documentRef: document, intervalMs: 60 * 60_000 });
  const fire = (init) => window.dispatchEvent(new window.StorageEvent('storage', init));
  try {
    await settle();
    // Another key, or the same value written again: the cache stays.
    fire({ key: 'oar_something_else', oldValue: 'a', newValue: 'b' });
    fire({ key: SESSION_PROOF_STORAGE_KEY, oldValue: 'same', newValue: 'same' });
    assert.equal(fileSrcAttribute('/api/files/shared.png'), `src="${signed}"`);
    // The key changed in another tab.
    const before = minted.length;
    fire({ key: SESSION_PROOF_STORAGE_KEY, oldValue: 'before', newValue: 'after' });
    assert.equal(fileSrcAttribute('/api/files/shared.png'), `${DEFERRED_FILE_SRC_ATTR}="/api/files/shared.png"`, 'no old k handed out');
    await settleUntil(() => kOf(document.querySelector('a').getAttribute('href')) !== oldK);
    assert.equal(minted.length, before + 1);
    assert.notEqual(kOf(document.querySelector('a').getAttribute('href')), oldK, 'the link carries a new k');
    // Storage cleared in another tab (key null) counts too.
    const [again] = await signFileUrls(['/api/files/shared.png']);
    assert.equal(fileSrcAttribute('/api/files/shared.png'), `src="${again}"`);
    fire({ key: null });
    assert.equal(fileSrcAttribute('/api/files/shared.png'), `${DEFERRED_FILE_SRC_ATTR}="/api/files/shared.png"`);
  } finally {
    stop();
    document.body.innerHTML = '';
  }
  // Uninstalled: the listener is gone.
  const [kept] = await signFileUrls(['/api/files/shared.png']);
  fire({ key: SESSION_PROOF_STORAGE_KEY, oldValue: 'x', newValue: 'y' });
  assert.equal(fileSrcAttribute('/api/files/shared.png'), `src="${kept}"`);
});
