// The files a viewer can move between without being closed: the files of
// the folder a file was opened from, in the order the browser shows them.
// An index into that list is the open file; neighbours are the files on
// either side, and the list never wraps.

/**
 * A gallery over a folder listing (`children` as the repo browser holds
 * them; directories are skipped). `null` when the opened file is not in the
 * list or has no neighbours — a viewer without a gallery shows one file.
 */
export function galleryFromFolder(children, openedPath, { source = 'workspace' } = {}) {
  const items = (Array.isArray(children) ? children : [])
    .filter((child) => child && child.type !== 'dir' && String(child.path || ''))
    .map((child) => ({ path: String(child.path), name: String(child.name || '') }));
  const index = items.findIndex((item) => item.path === String(openedPath || ''));
  if (index === -1 || items.length < 2) return null;
  return { source: String(source || 'workspace'), items, index };
}

/** The index `delta` steps away, or -1 past either end. */
export function galleryNeighborIndex(gallery, delta) {
  if (!gallery || !Array.isArray(gallery.items)) return -1;
  const next = Number(gallery.index) + Number(delta);
  return Number.isInteger(next) && next >= 0 && next < gallery.items.length ? next : -1;
}

/** The same gallery, open at another index. */
export function galleryAt(gallery, index) {
  if (!gallery || index < 0 || index >= gallery.items.length) return null;
  return { ...gallery, index };
}

export function galleryPositionLabel(gallery) {
  if (!gallery || !Array.isArray(gallery.items) || !gallery.items.length) return '';
  return `${gallery.index + 1} / ${gallery.items.length}${galleryHasMore(gallery) ? '+' : ''}`;
}

// A paged gallery (the media gallery) knows only the pages loaded so far:
// `hasMore` says more items follow and `loadMore()` fetches the next page
// as `{ items, hasMore }`. Stepping past the last loaded item loads it.

export function galleryHasMore(gallery) {
  return Boolean(gallery && gallery.hasMore && typeof gallery.loadMore === 'function');
}

/** Whether a step of `delta` can land somewhere: a neighbour, or a page still to load. */
export function galleryCanStep(gallery, delta) {
  if (galleryNeighborIndex(gallery, delta) !== -1) return true;
  return Number(delta) > 0 && galleryHasMore(gallery) && Number(gallery.index) === gallery.items.length - 1;
}

/** The gallery with a loaded page appended (items it already has are not added twice). */
export function extendGallery(gallery, page) {
  if (!gallery) return null;
  const known = new Set(gallery.items.map((item) => item.key).filter(Boolean));
  const added = (Array.isArray(page?.items) ? page.items : []).filter((item) => !item?.key || !known.has(item.key));
  return { ...gallery, items: [...gallery.items, ...added], hasMore: Boolean(page?.hasMore) && added.length > 0 };
}

/** The items on either side of the open one, nearest first. */
export function galleryNeighbors(gallery) {
  const out = [];
  for (const delta of [1, -1]) {
    const index = galleryNeighborIndex(gallery, delta);
    if (index !== -1) out.push(gallery.items[index]);
  }
  return out;
}
