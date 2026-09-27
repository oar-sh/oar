// Links that open one conversation when the app loads:
//   ?push_conv=<id>  a notification tap (sw.js opens a fresh window with it)
//   ?conv=<id>       a link from another relay's provenance badge
//                    (remoteConversationUrl in shared/remote-relay-contract.mjs)
// Both are consumed once and stripped from the address bar, so a reload does
// not jump back to that conversation.

export const CONVERSATION_DEEP_LINK_PARAMS = Object.freeze(['push_conv', 'conv']);

/**
 * Reads the conversation a URL asks for. `cleanedPath` is the URL to put back
 * in the address bar (path + remaining query + hash), or null when the URL
 * carried none of the parameters and needs no rewrite.
 */
export function readConversationDeepLink(href) {
  let url;
  try {
    url = new URL(String(href || ''));
  } catch {
    return { conversationId: '', cleanedPath: null };
  }
  let conversationId = '';
  let found = false;
  for (const param of CONVERSATION_DEEP_LINK_PARAMS) {
    if (!url.searchParams.has(param)) continue;
    found = true;
    const value = String(url.searchParams.get(param) || '').trim();
    if (!conversationId && value) conversationId = value;
    url.searchParams.delete(param);
  }
  return {
    conversationId,
    cleanedPath: found ? `${url.pathname}${url.search}${url.hash}` : null,
  };
}

/** Reads and strips the deep link from the current location. */
export function consumeConversationDeepLink({ location = window.location, history = window.history, title = document.title } = {}) {
  const { conversationId, cleanedPath } = readConversationDeepLink(location?.href);
  if (cleanedPath !== null) history?.replaceState?.(null, title, cleanedPath);
  return conversationId;
}
