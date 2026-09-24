// Title filtering for the conversation sidebar. Kept DOM-free so it can be unit
// tested; journal-view.js touches window/document at module scope and cannot be
// imported from node:test.

// NFC first so a decomposed "é" (e + U+0301, as some IMEs and pasted text
// produce) matches a precomposed one. Case folding is toLocaleLowerCase only, so
// multi-char folds are a known limit: "ß" does not match "SS".
function foldForMatch(text) {
  return String(text ?? '').normalize('NFC').toLocaleLowerCase();
}

export function normalizeConversationFilter(text) {
  return foldForMatch(text).trim();
}

export function conversationMatchesFilter(conversation, normalizedFilter) {
  if (!normalizedFilter) return true;
  return foldForMatch(conversation?.title).includes(normalizedFilter);
}

export function filterConversations(conversations, filterText) {
  const list = Array.isArray(conversations) ? conversations : [];
  const normalized = normalizeConversationFilter(filterText);
  if (!normalized) return list;
  return list.filter((conversation) => conversationMatchesFilter(conversation, normalized));
}

export function describeFilterMatchCount(count) {
  const n = Math.max(0, Number(count) || 0);
  if (n === 0) return 'No conversations match';
  return n === 1 ? '1 conversation matches' : `${n} conversations match`;
}

function cursorKey(state) {
  try {
    return JSON.stringify(state?.nextCursor ?? null);
  } catch {
    return '';
  }
}

// While a filter is active the sidebar has to search conversations that only
// exist on unloaded pages, so pull every remaining page through the loader.
// shouldContinue() is checked before each page so clearing the filter (or
// switching it) aborts the drain. loadMore() resolving falsy is ambiguous:
// - the loader is busy (a boundary-check load/prefetch is in flight): wait it
//   out without spending idle retries, so the drain does not give up while the
//   list is still loading. busyRetries caps a genuinely stuck fetch.
// - a reset bumped the loader version mid-fetch, or the fetch failed: retry,
//   but stop after maxIdleRetries consecutive no-progress attempts so a failing
//   endpoint is not hammered forever.
// An advanced cursor counts as progress even when the page was empty.
export async function drainRemainingPages(loader, shouldContinue = () => true, {
  retryDelayMs = 200,
  maxIdleRetries = 10,
  maxBusyRetries = 300,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!loader || typeof loader.loadMore !== 'function' || typeof loader.getState !== 'function') {
    return false;
  }
  let loadedAnything = false;
  let idleRetries = 0;
  let busyRetries = 0;
  while (loader.getState().hasMore && shouldContinue()) {
    const cursorBefore = cursorKey(loader.getState());
    const loaded = await loader.loadMore();
    const state = loader.getState();
    if (loaded) loadedAnything = true;
    if (loaded || cursorKey(state) !== cursorBefore) {
      idleRetries = 0;
      busyRetries = 0;
      continue;
    }
    if (state.isLoading || state.isPrefetching) {
      busyRetries += 1;
      if (busyRetries > maxBusyRetries) break;
    } else {
      idleRetries += 1;
      if (idleRetries > maxIdleRetries) break;
    }
    await delay(retryDelayMs);
  }
  return loadedAnything;
}
