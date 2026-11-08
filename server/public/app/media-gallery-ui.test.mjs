import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// The gallery renders into the real page (index.html carries its CSS), with
// the API and the file viewer injected; jsdom runs no page scripts.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const { mountMediaGallery } = await import('./media-gallery-ui.js');

const item = (id, extra = {}) => ({
  id,
  conversationId: 'c1',
  conversationTitle: 'Garden plans',
  messageId: `m${id}`,
  sender: 'agent',
  origin: 'embedded',
  mediaKind: 'image',
  mime: 'image/png',
  name: `p${id}.png`,
  alt: `picture ${id}`,
  timestamp: '2026-10-15T10:00:00.000Z',
  occurrences: 1,
  contentUrl: `/api/media/${id}/content`,
  remoteUrl: null,
  path: `/srv/demo/p${id}.png`,
  archived: false,
  ...extra,
});

function fakeApi(pages) {
  const calls = [];
  return {
    calls,
    fetchJson: async (url) => {
      calls.push(url);
      if (url.startsWith('/api/media/facets')) return { sessions: [{ id: 'c1', title: 'Garden plans', archived: false, count: 3 }], providers: ['claude', 'github'] };
      const params = new URL(url, 'http://x').searchParams;
      const key = `${params.get('category')}:${params.get('cursor') || ''}`;
      return pages[key] || { items: [], nextCursor: null, missingHidden: 0, indexing: { pending: 0 } };
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the Media tab is a grid under month headers; tiles are lazy pictures or videos with a badge', async () => {
  const host = document.createElement('div');
  const api = fakeApi({
    'media:': {
      items: [
        item(1, { timestamp: '2026-11-02T10:00:00.000Z', sender: 'me' }),
        item(2, { mediaKind: 'video', mime: 'video/mp4', name: 'clip.mp4' }),
        item(3, { origin: 'generated', archived: true }),
        item(4, { contentUrl: null, remoteUrl: 'https://images.example.test/r.jpg', path: null }),
      ],
      nextCursor: null,
      missingHidden: 2,
      indexing: { pending: 0 },
    },
  });
  const gallery = mountMediaGallery(host, { conversationId: 'c1', fetchJson: api.fetchJson, observe: false });
  await gallery.firstPage;
  assert.match(api.calls[0], /^\/api\/media\?category=media&conversationId=c1&limit=60$/);
  const months = [...host.querySelectorAll('.media-month')];
  assert.deepEqual(months.map((node) => node.dataset.mediaMonth), ['2026-11', '2026-10']);
  assert.equal(months[0].querySelector('.media-month-label').textContent, 'November 2026');
  const tiles = [...host.querySelectorAll('.media-tile')];
  assert.equal(tiles.length, 4);
  const img = tiles[0].querySelector('img');
  assert.equal(img.getAttribute('loading'), 'lazy');
  assert.equal(img.getAttribute('decoding'), 'async');
  assert.equal(img.getAttribute('src'), '/api/media/1/content');
  assert.equal(tiles[0].querySelector('.media-tile-badge').textContent, '👤');
  assert.equal(tiles[1].querySelector('video').getAttribute('preload'), 'metadata');
  assert.ok(tiles[1].querySelector('.media-tile-play'));
  assert.equal(tiles[2].querySelector('.media-tile-badge').textContent, '✨');
  assert.ok(tiles[2].classList.contains('media-tile-archived'));
  assert.equal(tiles[3].querySelector('img').getAttribute('src'), 'https://images.example.test/r.jpg');
  assert.equal(tiles[3].querySelector('img').referrerPolicy, 'no-referrer');
  assert.match(host.querySelector('.media-gallery-status').textContent, /2 missing files are not shown\./);
  assert.equal(host.querySelector('.media-gallery-filters'), null, 'a session gallery has no filters');
});

test('pages append into the month already shown; the Files tab is a list', async () => {
  const host = document.createElement('div');
  const api = fakeApi({
    'media:': { items: [item(1), item(2)], nextCursor: 'next1', missingHidden: 0, indexing: { pending: 12 } },
    'media:next1': { items: [item(3)], nextCursor: null, missingHidden: 0, indexing: { pending: 0 } },
    'file:': { items: [item(9, { mediaKind: 'pdf', mime: 'application/pdf', name: 'notes.pdf', sizeBytes: 2048 })], nextCursor: null, missingHidden: 0, indexing: { pending: 0 } },
  });
  const gallery = mountMediaGallery(host, { fetchJson: api.fetchJson, observe: false });
  await gallery.firstPage;
  assert.match(host.querySelector('.media-gallery-status').textContent, /Indexing older messages… \(12 left\)/);
  assert.equal(host.querySelector('.media-gallery-more').hidden, false);
  host.querySelector('.media-gallery-more').click();
  await gallery.state.loading;
  assert.equal(host.querySelectorAll('.media-month').length, 1, 'the same month grows');
  assert.equal(host.querySelectorAll('.media-tile').length, 3);
  assert.equal(host.querySelector('.media-gallery-more').hidden, true);

  host.querySelector('[data-media-category="file"]').click();
  await gallery.state.loading;
  await settle();
  const row = host.querySelector('.media-file-row');
  assert.equal(row.querySelector('.media-file-icon').textContent, '📄');
  assert.equal(row.querySelector('.media-file-name').textContent, 'notes.pdf');
  assert.match(row.querySelector('.media-file-meta').textContent, /^2\.0 KB · /);
  assert.equal(host.querySelector('[data-media-category="file"]').getAttribute('aria-selected'), 'true');
});

test('the global gallery has filters; each change asks again from the first page', async () => {
  const host = document.createElement('div');
  const api = fakeApi({});
  const gallery = mountMediaGallery(host, { global: true, fetchJson: api.fetchJson, observe: false });
  await gallery.firstPage;
  await settle();
  const filters = host.querySelector('.media-gallery-filters');
  assert.deepEqual([...filters.querySelectorAll('[data-media-filter="provider"] option')].map((o) => o.value), ['', 'claude', 'github']);
  filters.querySelector('[data-media-source="generated"]').click();
  await gallery.state.loading;
  const provider = filters.querySelector('[data-media-filter="provider"]');
  provider.value = 'claude';
  provider.dispatchEvent(new window.Event('change', { bubbles: true }));
  await gallery.state.loading;
  const archived = filters.querySelector('[data-media-filter="archived"]');
  archived.checked = true;
  archived.dispatchEvent(new window.Event('change', { bubbles: true }));
  await gallery.state.loading;
  const listCalls = api.calls.filter((url) => url.startsWith('/api/media?'));
  assert.equal(listCalls.at(-1), '/api/media?category=media&source=generated&provider=claude&archived=hide&limit=60');
  assert.match(host.querySelector('.media-gallery-status').textContent, /Nothing matches these filters\./);
});

test('the page CSS: square tiles, 3 columns on a phone, sticky month headers, the global view hides the composer', () => {
  assert.match(indexHtml, /\.media-grid \{\s*display: grid;\s*grid-template-columns: repeat\(auto-fill, minmax\(calc\(140px \* var\(--ui-scale\)\), 1fr\)\);\s*gap: 2px;/);
  assert.match(indexHtml, /@media \(max-width: 680px\) \{\s*\.media-grid \{ grid-template-columns: repeat\(3, 1fr\); \}/);
  assert.match(indexHtml, /\.media-tile \{[^}]*aspect-ratio: 1;/);
  assert.match(indexHtml, /\.media-tile img,\s*\.media-tile video \{[^}]*object-fit: cover;/);
  assert.match(indexHtml, /\.media-month-label \{[^}]*position: sticky;/);
  assert.match(indexHtml, /body\.media-view-active #input-area \{ display: none; \}/);
});

test('a tap opens the viewer over the gallery; Open in session leaves through the caller', async () => {
  const host = document.createElement('div');
  const api = fakeApi({ 'media:': { items: [item(1), item(2)], nextCursor: 'more', missingHidden: 0, indexing: { pending: 0 } } });
  const opened = [];
  let closed = 0;
  const left = [];
  const gallery = mountMediaGallery(host, {
    fetchJson: api.fetchJson,
    observe: false,
    onOpenInSession: (media) => left.push(media.messageId),
    viewer: async () => ({
      openGalleryItem: async (viewerItem, viewerGallery) => opened.push({ viewerItem, viewerGallery }),
      closeFilePreview: () => { closed += 1; },
    }),
  });
  await gallery.firstPage;
  host.querySelectorAll('.media-tile')[1].click();
  await settle();
  await settle();
  assert.equal(opened.length, 1);
  const { viewerItem, viewerGallery } = opened[0];
  assert.equal(viewerItem.href, '/api/media/2/content');
  assert.equal(viewerGallery.index, 1);
  assert.equal(viewerGallery.hasMore, true);
  const actions = viewerGallery.describe(viewerItem).actions;
  await actions.find((action) => action.id === 'open-in-session').run();
  assert.equal(closed, 1);
  assert.deepEqual(left, ['m2']);
});

test('pages that come back empty while more follow are skipped over, so older pictures still show', async () => {
  const host = document.createElement('div');
  const pages = { 'media:': { items: [], nextCursor: 'c1', missingHidden: 60, indexing: { pending: 0 } } };
  for (let i = 1; i < 6; i += 1) pages[`media:c${i}`] = { items: [], nextCursor: `c${i + 1}`, missingHidden: 60, indexing: { pending: 0 } };
  pages['media:c6'] = { items: [item(70), item(71)], nextCursor: null, missingHidden: 0, indexing: { pending: 0 } };
  const api = fakeApi(pages);
  const gallery = mountMediaGallery(host, { fetchJson: api.fetchJson, observe: false });
  await gallery.firstPage;
  assert.equal(host.querySelectorAll('.media-tile').length, 2);
  assert.equal(api.calls.filter((url) => url.startsWith('/api/media?')).length, 7);
  assert.match(host.querySelector('.media-gallery-status').textContent, /360 missing files are not shown\./);
});

test('a video tile gets its address only when it comes into view', async () => {
  const observed = [];
  const RealObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; observed.push(this); this.targets = []; }
    observe(target) { this.targets.push(target); }
    unobserve(target) { this.targets = this.targets.filter((node) => node !== target); }
    disconnect() { this.targets = []; }
  };
  try {
    const host = document.createElement('div');
    const api = fakeApi({ 'media:': { items: [item(1, { mediaKind: 'video', mime: 'video/mp4', name: 'clip.mp4' })], nextCursor: null, missingHidden: 0, indexing: { pending: 0 } } });
    const gallery = mountMediaGallery(host, { fetchJson: api.fetchJson, observe: true });
    await gallery.firstPage;
    const video = host.querySelector('.media-tile video');
    assert.equal(video.getAttribute('src'), null, 'nothing is fetched before it is in view');
    const videoObserver = observed.find((observer) => observer.targets.includes(video));
    videoObserver.callback([{ isIntersecting: true, target: video }]);
    assert.equal(video.getAttribute('src'), '/api/media/1/content#t=0.1');
    gallery.destroy();
    assert.deepEqual(videoObserver.targets, [], 'destroy lets go of the tiles');
  } finally {
    globalThis.IntersectionObserver = RealObserver;
  }
});

test('while older messages are indexed the count is asked again; once done the gallery loads again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // setTimeout is mocked here: the turns of the event loop come from setImmediate.
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const host = document.createElement('div');
  let pending = 30;
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.startsWith('/api/media/counts')) return { media: 1, file: 0, pending };
    return { items: [item(1)], nextCursor: null, missingHidden: 0, indexing: { pending } };
  };
  const gallery = mountMediaGallery(host, { conversationId: 'c1', fetchJson, observe: false });
  await gallery.firstPage;
  assert.match(host.querySelector('.media-gallery-status').textContent, /Indexing older messages… \(30 left\)/);
  pending = 12;
  t.mock.timers.tick(4000);
  await settle();
  await settle();
  assert.match(host.querySelector('.media-gallery-status').textContent, /\(12 left\)/);
  assert.equal(calls.at(-1), '/api/media/counts?conversationId=c1');
  pending = 0;
  t.mock.timers.tick(4000);
  await settle();
  await settle();
  await gallery.state.loading;
  assert.equal(calls.filter((url) => url.startsWith('/api/media?')).length, 2, 'loaded again once indexed');
  assert.doesNotMatch(host.querySelector('.media-gallery-status').textContent, /Indexing/);
  gallery.destroy();
});
test('after a reconnect the failed tiles in view load again, four at a time, once', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const items = Array.from({ length: 7 }, (_, i) => item(i + 1));
  const api = fakeApi({ 'media:': { items, nextCursor: null, missingHidden: 0, indexing: { pending: 0 } } });
  const gallery = mountMediaGallery(host, { fetchJson: api.fetchJson, observe: false });
  await gallery.firstPage;
  const imgs = [...host.querySelectorAll('.media-tile img')];
  // Tiles 1-6 are on the screen, tile 7 below it.
  const realBox = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function box() {
    const index = imgs.indexOf(this.querySelector?.('img'));
    const top = index === 6 ? 5000 : 10;
    return { top, bottom: top + 100, left: 0, right: 100, width: 100, height: 100 };
  };
  try {
    for (const img of imgs) img.dispatchEvent(new window.Event('error'));
    assert.equal(host.querySelectorAll('.media-tile-failed').length, 7);
    window.dispatchEvent(new window.CustomEvent('oar:relay-connected'));
    const retried = () => imgs.filter((img) => /retry=1$/.test(img.getAttribute('src') || '')).length;
    assert.equal(retried(), 4, 'four in flight');
    imgs[0].dispatchEvent(new window.Event('load'));
    imgs[1].dispatchEvent(new window.Event('error'));
    assert.equal(retried(), 6, 'the next ones start as others settle');
    assert.equal(imgs[6].getAttribute('src'), '/api/media/7/content', 'a tile out of view is left for later');
    assert.ok(imgs[1].closest('.media-tile').classList.contains('media-tile-failed'), 'failed again: it waits');
    assert.ok(!imgs[0].closest('.media-tile').classList.contains('media-tile-failed'));
    for (const img of imgs.slice(2, 6)) img.dispatchEvent(new window.Event('load'));
    assert.equal(imgs[6].getAttribute('src'), '/api/media/7/content', 'all settled: the tile out of view was never asked for');
    // The next reconnect tries what is still failed and in view, with a new number.
    window.dispatchEvent(new window.CustomEvent('oar:relay-connected'));
    assert.equal(imgs[1].getAttribute('src'), '/api/media/2/content?retry=2');
    imgs[1].dispatchEvent(new window.Event('load'));
    // Failed again before the gallery goes: a reconnect after destroy leaves it alone.
    imgs[2].dispatchEvent(new window.Event('error'));
    const before = imgs[2].getAttribute('src');
    gallery.destroy();
    window.dispatchEvent(new window.CustomEvent('oar:relay-connected'));
    assert.equal(imgs[2].getAttribute('src'), before, 'a destroyed gallery no longer listens');
  } finally {
    window.Element.prototype.getBoundingClientRect = realBox;
    host.remove();
  }
});
async function failedGallery(count) {
  const host = document.createElement('div');
  document.body.append(host);
  const items = Array.from({ length: count }, (_, i) => item(i + 1));
  const api = fakeApi({ 'media:': { items, nextCursor: null, missingHidden: 0, indexing: { pending: 0 } } });
  const gallery = mountMediaGallery(host, { fetchJson: api.fetchJson, observe: false });
  await gallery.firstPage;
  const imgs = [...host.querySelectorAll('.media-tile img')];
  for (const img of imgs) img.dispatchEvent(new window.Event('error'));
  const retried = () => imgs.filter((img) => /retry=\d+$/.test(img.getAttribute('src') || '')).length;
  return { host, gallery, imgs, retried };
}

function allInView(run) {
  const realBox = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = () => ({ top: 10, bottom: 110, left: 0, right: 100, width: 100, height: 100 });
  return Promise.resolve().then(run).finally(() => { window.Element.prototype.getBoundingClientRect = realBox; });
}

test('a reconnect flap does not start a second pass over the tiles the first one still holds', () => allInView(async () => {
  const { host, gallery, retried } = await failedGallery(7);
  window.dispatchEvent(new window.CustomEvent('oar:relay-connected'));
  window.dispatchEvent(new window.CustomEvent('oar:relay-connected'));
  window.dispatchEvent(new window.CustomEvent('oar:relay-connected'));
  assert.equal(retried(), 4, 'still four in flight, not four per reconnect');
  gallery.destroy();
  host.remove();
}));

test('destroy stops a running pass: settling tiles start no more loads', () => allInView(async () => {
  const { host, gallery, imgs, retried } = await failedGallery(7);
  window.dispatchEvent(new window.CustomEvent('oar:relay-connected'));
  assert.equal(retried(), 4);
  gallery.destroy();
  for (const img of imgs.slice(0, 4)) img.dispatchEvent(new window.Event('load'));
  assert.equal(retried(), 4, 'no tile was asked for after destroy');
  host.remove();
}));