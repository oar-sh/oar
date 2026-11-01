// Links that open one conversation when the app loads:
//   ?push_conv=<id>  a notification tap (sw.js opens a fresh window with it)
//   ?conv=<id>       the address of the session on screen (session-history.mjs):
//                    a reload, a copied link, another relay's provenance badge
//                    (remoteConversationUrl in shared/remote-relay-contract.mjs)
// `push_conv` is consumed once and becomes `conv`; `conv` stays in the
// address bar, so a reload opens the same conversation.

export const CONVERSATION_DEEP_LINK_PARAMS = Object.freeze(['push_conv', 'conv']);

/**
 * Reads the conversation a URL asks for. `cleanedPath` is the URL to put back
 * in the address bar (path + query with `conv=<id>` + hash), or null when the
 * URL needs no rewrite.
 */
export function readConversationDeepLink(href) {
  let url;
  try {
    url = new URL(String(href || ''));
  } catch {
    return { conversationId: '', cleanedPath: null };
  }
  let conversationId = '';
  for (const param of CONVERSATION_DEEP_LINK_PARAMS) {
    if (!url.searchParams.has(param)) continue;
    const value = String(url.searchParams.get(param) || '').trim();
    if (!conversationId && value) conversationId = value;
  }
  const before = `${url.pathname}${url.search}${url.hash}`;
  url.searchParams.delete('push_conv');
  if (conversationId) url.searchParams.set('conv', conversationId);
  else url.searchParams.delete('conv');
  const after = `${url.pathname}${url.search}${url.hash}`;
  return {
    conversationId,
    cleanedPath: after === before ? null : after,
  };
}

/** Reads the deep link from the current location and settles the address on `?conv=`. */
export function consumeConversationDeepLink({ location = window.location, history = window.history, title = document.title } = {}) {
  const { conversationId, cleanedPath } = readConversationDeepLink(location?.href);
  // The entry keeps its state: the back guard and the session history mark it.
  if (cleanedPath !== null) history?.replaceState?.(history?.state ?? null, title, cleanedPath);
  return conversationId;
}
