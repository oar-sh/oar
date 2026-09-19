// Title filtering for the conversation sidebar. Kept DOM-free so it can be unit
// tested; journal-view.js touches window/document at module scope and cannot be
// imported from node:test.

export function normalizeConversationFilter(text) {
  return String(text ?? '').trim().toLowerCase();
}

export function conversationMatchesFilter(conversation, normalizedFilter) {
  if (!normalizedFilter) return true;
  const title = String(conversation?.title ?? '').toLowerCase();
  return title.includes(normalizedFilter);
}

export function filterConversations(conversations, filterText) {
  const list = Array.isArray(conversations) ? conversations : [];
  const normalized = normalizeConversationFilter(filterText);
  if (!normalized) return list;
  return list.filter((conversation) => conversationMatchesFilter(conversation, normalized));
}

// While a filter is active the sidebar has to search conversations that only
// exist on unloaded pages, so pull every remaining page through the loader.
// shouldContinue() is checked before each page so clearing the filter (or
// switching it) aborts the drain. loadMore() resolving falsy is ambiguous: the
// loader also returns false when a boundary-check load/prefetch is already in
// flight, or when a reset bumped its version mid-fetch — so retry (bounded)
// instead of treating the first false as terminal, but give up after
// maxIdleRetries consecutive no-progress attempts so a failing endpoint is not
// hammered forever.
export async function drainRemainingPages(loader, shouldContinue = () => true, {
  retryDelayMs = 200,
  maxIdleRetries = 10,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!loader || typeof loader.loadMore !== 'function' || typeof loader.getState !== 'function') {
    return false;
  }
  let loadedAnything = false;
  let idleRetries = 0;
  while (loader.getState().hasMore && shouldContinue()) {
    const loaded = await loader.loadMore();
    if (loaded) {
      loadedAnything = true;
      idleRetries = 0;
      continue;
    }
    idleRetries += 1;
    if (idleRetries > maxIdleRetries) break;
    await delay(retryDelayMs);
  }
  return loadedAnything;
}
