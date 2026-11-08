import { apiFetch } from './api-client.js';
import {
  MEDIA_PAGE_SIZE,
  MEDIA_TEXT,
  formatMediaDate,
  formatMediaSize,
  groupByMonth,
  mediaFileIcon,
  mediaHref,
  mediaQuery,
  mediaSourceBadge,
  mediaViewerGallery,
} from './media-gallery-model.mjs';
import { BASE, showTransientRelayNotice } from './store.js';

// The media gallery in the style of a messenger's shared media: a Media tab
// (a square grid of pictures and videos under month headers) and a Files tab
// (a list). Mounted twice: in the 🧠 modal for one session, and as the global
// Media view with filters. A tap opens the file viewer over the whole
// gallery; swiping past the last loaded tile loads the next page.

const SEARCH_DEBOUNCE_MS = 300;
// Empty pages (all their files missing) asked for in a row before stopping.
const MAX_EMPTY_PAGES = 20;
// While the index fills for older messages: how often the count is asked.
const INDEXING_POLL_MS = 4000;
// Tiles that failed (the relay was away) loaded again at once after a reconnect.
const MAX_RETRY_IN_FLIGHT = 4;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('data-')) node.setAttribute(key, value === true ? '' : String(value));
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

// The viewer lies under the summary modal by default; opened from inside it,
// it is lifted (.over-summary) until it closes.
function raiseViewerUntilClosed() {
  const modal = document.getElementById('file-preview-modal');
  if (!modal || modal.classList.contains('over-summary')) return;
  modal.classList.add('over-summary');
  let seenOpen = false;
  const observer = new MutationObserver(() => {
    const open = modal.classList.contains('visible');
    if (open) seenOpen = true;
    else if (seenOpen) {
      modal.classList.remove('over-summary');
      observer.disconnect();
    }
  });
  observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
}

// The address of a tile's picture or video asked for again: the relay's own
// routes get a retry number (a fresh address, so the browser fetches it
// again; the relay ignores it), anything else is set anew.
function retryAddress(url, attempt) {
  const value = String(url || '');
  if (!value.startsWith(`${BASE}/api/`)) return value;
  const hash = value.indexOf('#');
  const head = hash === -1 ? value : value.slice(0, hash);
  const fragment = hash === -1 ? '' : value.slice(hash);
  return `${head}${head.includes('?') ? '&' : '?'}retry=${attempt}${fragment}`;
}

function inView(node) {
  const box = node.getBoundingClientRect();
  return box.bottom > 0 && box.right > 0 && box.top < window.innerHeight && box.left < window.innerWidth && box.width > 0;
}

function tileFor(item, index) {
  const href = mediaHref(item, BASE);
  const title = [formatMediaDate(item.timestamp), item.conversationTitle].filter(Boolean).join(' · ');
  const tile = el('button', {
    type: 'button',
    class: `media-tile${item.archived ? ' media-tile-archived' : ''}`,
    'data-media-index': index,
    title,
    'aria-label': item.alt || item.name || MEDIA_TEXT.title,
  });
  if (item.mediaKind === 'video') {
    // The address is set when the tile comes into view (videoObserver): a
    // video's metadata is a request of its own, unlike a lazy picture.
    tile.append(el('video', { 'data-src': `${href}#t=0.1`, preload: 'metadata', muted: true, playsInline: true, tabIndex: -1 }));
    tile.append(el('span', { class: 'media-tile-play', 'aria-hidden': 'true', text: '▶' }));
  } else {
    const img = el('img', { src: href, alt: item.alt || '', loading: 'lazy', decoding: 'async' });
    if (item.remoteUrl) img.referrerPolicy = 'no-referrer';
    tile.append(img);
  }
  const badge = mediaSourceBadge(item).split(' ')[0] + (item.remoteUrl ? ` ${MEDIA_TEXT.remote}` : '');
  tile.append(el('span', { class: 'media-tile-badge', 'aria-hidden': 'true', text: badge }));
  return tile;
}

function fileRowFor(item, index) {
  const meta = [formatMediaSize(item.sizeBytes), formatMediaDate(item.timestamp), item.conversationTitle].filter(Boolean).join(' · ');
  return el('button', { type: 'button', class: 'media-file-row', 'data-media-index': index }, [
    el('span', { class: 'media-file-icon', 'aria-hidden': 'true', text: mediaFileIcon(item) }),
    el('span', { class: 'media-file-text' }, [
      el('span', { class: 'media-file-name', text: item.name || item.alt || '' }),
      el('span', { class: 'media-file-meta', text: meta }),
    ]),
  ]);
}

/**
 * Mounts a gallery into `host`. `conversationId` scopes it to one session
 * (the 🧠 tab); `global` adds the filters. `onOpenInSession(item)` leaves the
 * surrounding view before the conversation opens at the message.
 */
export function mountMediaGallery(host, {
  conversationId = '',
  global = false,
  onOpenInSession = null,
  fetchJson = (url) => apiFetch(url),
  observe = typeof IntersectionObserver === 'function',
  // The file viewer, loaded when a tile is first opened.
  viewer = () => import('./attachments-view.js'),
  // Opened from a modal (the 🧠 Media tab): the viewer goes above it.
  raiseViewer = false,
} = {}) {
  const state = {
    category: 'media',
    source: 'all',
    provider: '',
    sessionId: '',
    hideArchived: false,
    q: '',
    items: [],
    cursor: '',
    hasMore: true,
    loading: null,
    generation: 0,
    missing: 0,
    pending: 0,
    failed: false,
  };
  let observer = null;
  let videoObserver = null;
  let searchTimer = null;
  let indexingTimer = null;

  const root = el('div', { class: 'media-gallery', 'data-scope': global ? 'global' : 'session' });
  const tabs = el('div', { class: 'media-gallery-tabs', role: 'tablist' });
  for (const [category, label] of [['media', MEDIA_TEXT.tabMedia], ['file', MEDIA_TEXT.tabFiles]]) {
    tabs.append(el('button', {
      type: 'button',
      class: 'media-gallery-tab',
      role: 'tab',
      'data-media-category': category,
      'aria-selected': String(category === state.category),
      text: label,
    }));
  }
  root.append(tabs);

  let filters = null;
  if (global) {
    filters = el('div', { class: 'media-gallery-filters' });
    const chips = el('div', { class: 'media-gallery-chips', role: 'group', 'aria-label': MEDIA_TEXT.sourceLabel });
    for (const [source, label] of [['all', MEDIA_TEXT.sourceAll], ['mine', MEDIA_TEXT.sourceMine], ['agent', MEDIA_TEXT.sourceAgent], ['generated', MEDIA_TEXT.sourceGenerated]]) {
      chips.append(el('button', { type: 'button', class: 'media-gallery-chip', 'data-media-source': source, 'aria-pressed': String(source === state.source), text: label }));
    }
    const provider = el('select', { class: 'media-gallery-select', 'data-media-filter': 'provider', 'aria-label': MEDIA_TEXT.providerLabel }, [el('option', { value: '', text: MEDIA_TEXT.allProviders })]);
    const session = el('select', { class: 'media-gallery-select', 'data-media-filter': 'session', 'aria-label': MEDIA_TEXT.sessionLabel }, [el('option', { value: '', text: MEDIA_TEXT.allSessions })]);
    const archived = el('label', { class: 'media-gallery-toggle' }, [
      el('input', { type: 'checkbox', 'data-media-filter': 'archived' }),
      el('span', { text: MEDIA_TEXT.hideArchived }),
    ]);
    const search = el('input', { type: 'search', class: 'media-gallery-search', 'data-media-filter': 'q', placeholder: MEDIA_TEXT.search, 'aria-label': MEDIA_TEXT.search });
    filters.append(chips, provider, session, archived, search);
    root.append(filters);
  }

  const status = el('div', { class: 'media-gallery-status', 'aria-live': 'polite' });
  const body = el('div', { class: 'media-gallery-body' });
  const more = el('button', { type: 'button', class: 'media-gallery-more', hidden: true, text: MEDIA_TEXT.loadMore });
  const sentinel = el('div', { class: 'media-gallery-sentinel', 'aria-hidden': 'true' });
  root.append(status, body, more, sentinel);
  host.replaceChildren(root);

  function query(cursor = '') {
    return mediaQuery({
      category: state.category,
      conversationId: conversationId || state.sessionId,
      source: global ? state.source : 'all',
      provider: global ? state.provider : '',
      hideArchived: global && state.hideArchived,
      q: global ? state.q : '',
      cursor,
      limit: MEDIA_PAGE_SIZE,
    });
  }

  function filtered() {
    return global && (state.source !== 'all' || state.provider || state.sessionId || state.hideArchived || state.q);
  }

  function renderStatus() {
    const lines = [];
    if (state.failed) lines.push(MEDIA_TEXT.failed);
    else if (!state.items.length && state.loading) lines.push(MEDIA_TEXT.loading);
    else if (!state.items.length && !state.hasMore) {
      lines.push(filtered() ? MEDIA_TEXT.emptyFiltered : state.category === 'file' ? MEDIA_TEXT.emptyFiles : MEDIA_TEXT.emptyMedia);
    }
    if (state.pending > 0) lines.push(MEDIA_TEXT.indexing(state.pending));
    if (state.missing > 0 && !state.hasMore) lines.push(MEDIA_TEXT.missing(state.missing));
    status.replaceChildren(...lines.map((line) => el('p', { text: line })));
    more.hidden = !state.hasMore || Boolean(state.loading) || !state.items.length;
  }

  // Appends rows of the page that just arrived; a month already shown grows.
  function appendItems(startIndex, items) {
    if (state.category === 'file') {
      let list = body.querySelector('.media-file-list');
      if (!list) {
        list = el('div', { class: 'media-file-list' });
        body.append(list);
      }
      items.forEach((item, offset) => list.append(fileRowFor(item, startIndex + offset)));
      return;
    }
    let index = startIndex;
    for (const section of groupByMonth(items)) {
      let grid = body.lastElementChild?.dataset?.mediaMonth === section.key
        ? body.lastElementChild.querySelector('.media-grid')
        : null;
      if (!grid) {
        grid = el('div', { class: 'media-grid' });
        body.append(el('section', { class: 'media-month', 'data-media-month': section.key }, [
          el('h3', { class: 'media-month-label', text: section.label }),
          grid,
        ]));
      }
      for (const item of section.items) {
        const tile = tileFor(item, index++);
        grid.append(tile);
        const video = tile.querySelector('video[data-src]');
        if (video && videoObserver) videoObserver.observe(video);
        else if (video) video.src = video.dataset.src;
      }
    }
  }

  /** Loads the next page; resolves `{ items, hasMore }` of that page. */
  function loadNextPage() {
    if (state.loading) return state.loading;
    if (!state.hasMore) return Promise.resolve({ items: [], hasMore: false });
    const generation = state.generation;
    state.failed = false;
    state.loading = (async () => {
      // A page can come back empty while more follow (every file on it was
      // missing): the next one is asked for at once, up to a bound, so a
      // gallery whose newest files are all gone still shows the older ones.
      for (let round = 0; round < MAX_EMPTY_PAGES; round += 1) {
        let page = null;
        try {
          page = await fetchJson(`/api/media?${query(state.cursor)}`);
        } catch {
          page = null;
        }
        if (generation !== state.generation) return { items: [], hasMore: false };
        if (!page || !Array.isArray(page.items)) {
          state.loading = null;
          state.failed = true;
          renderStatus();
          return { items: [], hasMore: false };
        }
        const start = state.items.length;
        state.items.push(...page.items);
        state.cursor = page.nextCursor || '';
        state.hasMore = Boolean(page.nextCursor);
        state.missing += Number(page.missingHidden) || 0;
        state.pending = Number(page.indexing?.pending) || 0;
        appendItems(start, page.items);
        if (page.items.length || !state.hasMore) {
          state.loading = null;
          renderStatus();
          watchIndexing();
          return { items: page.items, hasMore: state.hasMore };
        }
      }
      state.loading = null;
      renderStatus();
      return { items: [], hasMore: state.hasMore };
    })();
    renderStatus();
    return state.loading;
  }

  // While older messages are still being indexed: the count is asked again
  // every few seconds (which moves the indexing on too), and the gallery loads
  // again once the index is complete.
  function watchIndexing() {
    if (indexingTimer || state.pending <= 0) return;
    const generation = state.generation;
    indexingTimer = setTimeout(async () => {
      indexingTimer = null;
      if (generation !== state.generation) return;
      const scope = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : '';
      const counts = await Promise.resolve(fetchJson(`/api/media/counts${scope}`)).catch(() => null);
      if (generation !== state.generation) return;
      const pending = Number(counts?.pending) || 0;
      if (pending > 0) {
        state.pending = pending;
        renderStatus();
        watchIndexing();
        return;
      }
      state.pending = 0;
      void reset();
    }, INDEXING_POLL_MS);
  }

  function reset() {
    state.generation += 1;
    clearTimeout(indexingTimer);
    indexingTimer = null;
    state.loading = null;
    state.items = [];
    state.cursor = '';
    state.hasMore = true;
    state.missing = 0;
    state.failed = false;
    body.replaceChildren();
    renderStatus();
    return loadNextPage();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showTransientRelayNotice(MEDIA_TEXT.copied, 1500);
    } catch {
      showTransientRelayNotice(MEDIA_TEXT.copyFailed, 2500);
    }
  }

  async function openItem(index) {
    const items = state.items.slice();
    const item = items[index];
    if (!item) return;
    const { closeFilePreview, openGalleryItem } = await viewer();
    // The viewer gets what the grid has beyond its own list: the grid may have
    // loaded the next page itself meanwhile (its end came into view).
    let given = items.length;
    const loadMore = async () => {
      if (state.items.length <= given && state.hasMore) await loadNextPage();
      const fresh = state.items.slice(given);
      given = state.items.length;
      return { items: fresh, hasMore: state.hasMore };
    };
    const gallery = mediaViewerGallery(items, index, {
      base: BASE,
      hasMore: state.hasMore || state.items.length > items.length,
      loadMore,
      openInSession: (media) => {
        closeFilePreview();
        onOpenInSession?.(media);
      },
      copyText,
    });
    if (raiseViewer) raiseViewerUntilClosed();
    await openGalleryItem(gallery.items[index], gallery);
  }

  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const tab = target?.closest('[data-media-category]');
    if (tab) {
      const category = tab.getAttribute('data-media-category');
      if (category === state.category) return;
      state.category = category;
      tabs.querySelectorAll('[data-media-category]').forEach((node) => {
        node.setAttribute('aria-selected', String(node === tab));
      });
      void reset();
      return;
    }
    const chip = target?.closest('[data-media-source]');
    if (chip) {
      state.source = chip.getAttribute('data-media-source');
      filters.querySelectorAll('[data-media-source]').forEach((node) => node.setAttribute('aria-pressed', String(node === chip)));
      void reset();
      return;
    }
    if (target?.closest('.media-gallery-more')) {
      void loadNextPage();
      return;
    }
    const tile = target?.closest('[data-media-index]');
    if (tile) void openItem(Number(tile.getAttribute('data-media-index')));
  });

  root.addEventListener('change', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const filter = target?.getAttribute('data-media-filter');
    if (filter === 'provider') state.provider = target.value;
    else if (filter === 'session') state.sessionId = target.value;
    else if (filter === 'archived') state.hideArchived = target.checked;
    else return;
    void reset();
  });

  root.addEventListener('input', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.getAttribute('data-media-filter') !== 'q') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = target.value;
      void reset();
    }, SEARCH_DEBOUNCE_MS);
  });

  // A picture or video that failed (the relay was away) marks its tile; after
  // a reconnect the failed tiles in view are asked for once more, a few at a
  // time. A tile that fails again waits for the next reconnect: no loop.
  let retryAttempt = 0;
  const onMediaEvent = (event) => {
    const media = event.target;
    if (media?.tagName !== 'IMG' && media?.tagName !== 'VIDEO') return;
    const tile = media.closest('.media-tile');
    if (!tile) return;
    tile.classList.toggle('media-tile-failed', event.type === 'error');
  };
  for (const type of ['error', 'load', 'loadeddata']) root.addEventListener(type, onMediaEvent, true);

  function retryFailedTiles() {
    const failed = [...root.querySelectorAll('.media-tile-failed')].filter(inView);
    if (!failed.length) return;
    retryAttempt += 1;
    // The whole pass is taken at once: a reconnect right after this one finds
    // none of these tiles still marked, so passes never overlap.
    for (const tile of failed) tile.classList.remove('media-tile-failed');
    const generation = state.generation;
    let next = 0;
    let inFlight = 0;
    const pump = () => {
      // A gallery destroyed or reloaded since: its tiles are asked for no more.
      if (generation !== state.generation) return;
      while (inFlight < MAX_RETRY_IN_FLIGHT && next < failed.length) {
        const media = failed[next].querySelector('img, video');
        next += 1;
        if (!media) continue;
        inFlight += 1;
        const settled = () => {
          media.removeEventListener('load', settled);
          media.removeEventListener('loadeddata', settled);
          media.removeEventListener('error', settled);
          inFlight -= 1;
          pump();
        };
        media.addEventListener('load', settled);
        media.addEventListener('loadeddata', settled);
        media.addEventListener('error', settled);
        const base = media.dataset.baseSrc || media.getAttribute('src') || media.dataset.src || '';
        media.dataset.baseSrc = base;
        media.removeAttribute('src');
        media.setAttribute('src', retryAddress(base, retryAttempt));
      }
    };
    pump();
  }
  window.addEventListener('oar:relay-connected', retryFailedTiles);
  async function loadFacets() {
    if (!global) return;
    const facets = await fetchJson('/api/media/facets').catch(() => null);
    if (!facets) return;
    const provider = filters.querySelector('[data-media-filter="provider"]');
    for (const name of facets.providers || []) provider.append(el('option', { value: name, text: name }));
    const session = filters.querySelector('[data-media-filter="session"]');
    for (const row of facets.sessions || []) {
      session.append(el('option', { value: row.id, text: `${row.title || row.id}${row.archived ? ` (${MEDIA_TEXT.archived})` : ''} · ${row.count}` }));
    }
  }

  if (observe) {
    videoObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.src = entry.target.dataset.src;
        entry.target.removeAttribute('data-src');
        videoObserver.unobserve(entry.target);
      }
    }, { rootMargin: '200px 0px' });
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && state.hasMore && !state.loading && state.items.length) {
        void loadNextPage();
      }
    }, { rootMargin: '600px 0px' });
    observer.observe(sentinel);
  }

  void loadFacets();
  const firstPage = reset();

  return {
    root,
    firstPage,
    openItem,
    retryFailedTiles,
    loadNextPage,
    reload: reset,
    state,
    destroy() {
      state.generation += 1;
      observer?.disconnect();
      videoObserver?.disconnect();
      window.removeEventListener('oar:relay-connected', retryFailedTiles);
      clearTimeout(searchTimer);
      clearTimeout(indexingTimer);
      indexingTimer = null;
    },
  };
}
