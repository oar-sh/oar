// The window of messages the page showed for each recently viewed
// conversation, with the payload it came in, in memory for this page load
// only. Switching back to one of them draws it at once from here, where the
// reader left it, older pages included; the fresh answer the switch asks for
// is merged into it when it arrives. The window follows the page: pages of
// older or newer history and the socket's live rows are added to it, and it
// is cut down to the retention cap when the reader leaves the conversation
// (conversation-window-retention.mjs).
// The live parts of a payload (a turn in flight, its state, tasks, draft,
// usage pause) are left out of the copy a read hands out: they are out of
// date the moment the payload is stored, and the fresh answer and the socket
// set them.

import { mergeTailPage, trimMessageWindow } from './transcript-reading-anchor.mjs';

/** Conversations kept; the least recently used goes first. */
export const CONVERSATION_PAYLOAD_CACHE_LIMIT = 8;

// Fields of a conversation payload that describe the moment it was read, not
// the transcript. A cached copy without them cannot end a turn, start the
// thinking bubble, or bring back a draft or a task list that has changed.
const LIVE_PAYLOAD_FIELDS = [
  'inFlight',
  'activeTurn',
  'sessionState',
  'backgroundTasks',
  'endedBackgroundTasks',
  'usageLimitPause',
  'draftText',
  'draftAttachments',
  'draftUpdatedAt',
  'draftUpdatedByClientId',
  'previews',
];

// What the payload said about its own page; a read describes the kept
// window instead.
const PAGE_FIELDS = ['pageInfo', 'hasMoreHistory', 'historyCursor', 'historyNewestMessageId'];

function normalizeId(conversationId) {
  return String(conversationId || '').trim();
}

function messageIdOf(message) {
  return String(message?.id || '').trim();
}

function clonePayload(value) {
  try {
    return structuredClone(value);
  } catch {
    // A payload is plain JSON; this is only reached by an odd value in it.
    return JSON.parse(JSON.stringify(value));
  }
}

/** True when the payload is a window with newer messages left unloaded. */
export function payloadHasMoreNewer(response) {
  if (!response || typeof response !== 'object') return false;
  if (typeof response.hasMoreNewer === 'boolean') return response.hasMoreNewer;
  const pageInfo = response.pageInfo && typeof response.pageInfo === 'object' ? response.pageInfo : null;
  return !!pageInfo?.hasMoreNewer;
}

/** True when the payload has older messages left unloaded; read as renderMessages reads it. */
export function payloadHasMoreOlder(response) {
  if (!response || typeof response !== 'object') return false;
  if (typeof response.hasMoreOlder === 'boolean') return response.hasMoreOlder;
  if (typeof response.hasMoreHistory === 'boolean') return response.hasMoreHistory;
  const pageInfo = response.pageInfo && typeof response.pageInfo === 'object' ? response.pageInfo : null;
  return !!pageInfo?.hasMoreOlder || !!pageInfo?.hasMore;
}

function isCacheable(response) {
  return !!response && typeof response === 'object' && Array.isArray(response.messages);
}

function cursorOf(message, direction) {
  if (!message) return null;
  const id = messageIdOf(message);
  const timestamp = String(message.timestamp || '').trim() || null;
  return direction === 'older'
    ? { beforeMessageId: id, beforeTimestamp: timestamp }
    : { afterMessageId: id, afterTimestamp: timestamp };
}

/** The pageInfo of a kept window, in the relay's shape, so the loaders page on from its edges. */
export function windowPageInfo(messages, { hasMoreOlder = false, hasMoreNewer = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const first = list[0] || null;
  const last = list[list.length - 1] || null;
  return {
    hasMore: !!hasMoreOlder,
    hasMoreOlder: !!hasMoreOlder,
    hasMoreNewer: !!hasMoreNewer,
    nextCursor: cursorOf(first, 'older'),
    olderCursor: cursorOf(first, 'older'),
    newerCursor: cursorOf(last, 'newer'),
  };
}

function windowPayload(entry) {
  const transcriptOnly = { ...entry.payload };
  for (const field of LIVE_PAYLOAD_FIELDS) delete transcriptOnly[field];
  for (const field of PAGE_FIELDS) delete transcriptOnly[field];
  const flags = { hasMoreOlder: entry.hasMoreOlder, hasMoreNewer: entry.hasMoreNewer };
  return {
    ...transcriptOnly,
    messages: entry.messages,
    ...flags,
    pageInfo: windowPageInfo(entry.messages, flags),
  };
}

/**
 * The copy of a payload the cache hands out, without its live fields, or
 * null when it must not be kept. The live fields are left out before the
 * clone: a turn in flight can carry thousands of thought rows nobody reads.
 */
export function cacheablePayload(response) {
  if (!isCacheable(response)) return null;
  return clonePayload(windowPayload(entryFor(response)));
}

function entryFor(response) {
  return {
    payload: response,
    messages: response.messages,
    hasMoreOlder: payloadHasMoreOlder(response),
    hasMoreNewer: payloadHasMoreNewer(response),
  };
}

// The messages of `incoming` whose ids the window lacks, in their order.
function unseen(entry, incoming) {
  const known = new Set(entry.messages.map(messageIdOf).filter(Boolean));
  return (Array.isArray(incoming) ? incoming : []).filter((message) => {
    const id = messageIdOf(message);
    if (!message || !id || known.has(id)) return false;
    known.add(id);
    return true;
  });
}

/**
 * A reload of the end of the conversation on screen (the live poll, a view
 * refresh) merged into the window the page holds, or null when the plain
 * render of the answer is right. The relay caps a page at 100 messages: with
 * more loaded, a render of the answer would cut the page and the kept window
 * down to it. Merged only when both the window and the answer reach the end,
 * the window holds more than the answer, and the two meet (mergeTailPage).
 * `mergeFrom` is the window as it is on the page, `payload` the answer with
 * the merged window as its messages and the window's edges.
 * `windowPredatesPage`: no live row reached the window while the answer was
 * on its way (see mergeTailPage), so a newer window row the answer lacks was
 * deleted, not brought by the socket after the read.
 */
export function mergeReloadIntoWindow(kept, response, { windowPredatesPage = false } = {}) {
  if (!kept || !Array.isArray(kept.messages) || !isCacheable(response)) return null;
  if (kept.hasMoreNewer || payloadHasMoreNewer(response)) return null;
  if (kept.messages.length <= response.messages.length) return null;
  const merged = mergeTailPage(kept.messages, response.messages, {
    pageHasMoreOlder: payloadHasMoreOlder(response),
    windowPredatesPage,
  });
  if (!merged) return null;
  const flags = { hasMoreOlder: !!kept.hasMoreOlder, hasMoreNewer: false };
  return {
    mergeFrom: kept.messages,
    payload: {
      ...response,
      messages: merged.messages,
      ...flags,
      pageInfo: windowPageInfo(merged.messages, flags),
    },
  };
}

export function createConversationPayloadCache({ limit = CONVERSATION_PAYLOAD_CACHE_LIMIT } = {}) {
  const maxEntries = Math.max(1, Math.trunc(Number(limit) || CONVERSATION_PAYLOAD_CACHE_LIMIT));
  // A Map keeps insertion order: the first key is the least recently used.
  const entries = new Map();

  function forget(conversationId) {
    const id = normalizeId(conversationId);
    if (!id) return false;
    return entries.delete(id);
  }

  /**
   * Keeps the payload just applied for the conversation: its messages are the
   * window the page shows. A payload that may not be kept drops the older one
   * too: the page no longer shows it.
   * Only a reference is kept: this runs on every apply, the live poll during
   * a turn included, and a fresh payload from the relay is not changed once
   * it is on the page. The copy is made on read, when a switch needs it; the
   * window's own changes below make new arrays and never touch the payload.
   */
  function remember(conversationId, response) {
    const id = normalizeId(conversationId);
    if (!id) return false;
    entries.delete(id);
    if (!isCacheable(response)) return false;
    entries.set(id, entryFor(response));
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
    return true;
  }

  // Changes to a window do not count as use: a conversation still open is
  // the most recently used anyway, and one read last keeps its place.
  function entryOf(conversationId) {
    return entries.get(normalizeId(conversationId)) || null;
  }

  /** An older page was put above the window. */
  function addOlder(conversationId, messages, { hasMoreOlder = false } = {}) {
    const entry = entryOf(conversationId);
    if (!entry) return false;
    entry.messages = [...unseen(entry, messages), ...entry.messages];
    entry.hasMoreOlder = !!hasMoreOlder;
    return true;
  }

  /** A newer page was put below the window. */
  function addNewer(conversationId, messages, { hasMoreNewer = false } = {}) {
    const entry = entryOf(conversationId);
    if (!entry) return false;
    entry.messages = [...entry.messages, ...unseen(entry, messages)];
    entry.hasMoreNewer = !!hasMoreNewer;
    return true;
  }

  /**
   * A live row from the socket: it replaces the message with its id, or joins
   * the end of a window that is the end of the conversation. A window in the
   * middle of the history leaves it to the newer pages.
   */
  function upsertMessage(conversationId, message) {
    const entry = entryOf(conversationId);
    const messageId = messageIdOf(message);
    if (!entry || !messageId) return false;
    const index = entry.messages.findIndex((item) => messageIdOf(item) === messageId);
    if (index >= 0) {
      entry.messages = entry.messages.map((item, at) => (at === index ? message : item));
      return true;
    }
    if (entry.hasMoreNewer) return false;
    entry.messages = [...entry.messages, message];
    return true;
  }

  /** The window no longer meets the end of the conversation (more was written than one page holds). */
  function detachFromTail(conversationId) {
    const entry = entryOf(conversationId);
    if (!entry) return false;
    entry.hasMoreNewer = true;
    return true;
  }

  /**
   * Cuts the window down to `cap` messages around the reader's place
   * (trimMessageWindow). True when rows were dropped.
   */
  function trim(conversationId, { cap = Infinity, anchorMessageId = '', atTail = false } = {}) {
    const entry = entryOf(conversationId);
    if (!entry) return false;
    const next = trimMessageWindow(entry.messages, {
      cap,
      anchorMessageId,
      atTail,
      hasMoreOlder: entry.hasMoreOlder,
      hasMoreNewer: entry.hasMoreNewer,
    });
    if (!next.trimmed) return false;
    entry.messages = next.messages;
    entry.hasMoreOlder = next.hasMoreOlder;
    entry.hasMoreNewer = next.hasMoreNewer;
    return true;
  }

  /** `anchorOf(id)` gives the reader's place in each kept conversation. */
  function trimAll(cap, anchorOf = () => null, { except = '' } = {}) {
    const skip = normalizeId(except);
    let trimmed = 0;
    for (const id of [...entries.keys()]) {
      if (id === skip) continue;
      const anchor = anchorOf(id) || null;
      if (trim(id, { cap, anchorMessageId: anchor?.messageId || '', atTail: anchor?.atTail === true })) trimmed += 1;
    }
    return trimmed;
  }

  /**
   * A copy of the kept window without its live fields (the caller may change
   * it), or null. Its messages are the window, its pageInfo and flags
   * describe the window's edges.
   */
  function read(conversationId) {
    const id = normalizeId(conversationId);
    if (!id || !entries.has(id)) return null;
    const entry = entries.get(id);
    entries.delete(id);
    entries.set(id, entry);
    return clonePayload(windowPayload(entry));
  }

  function has(conversationId) {
    return entries.has(normalizeId(conversationId));
  }

  /**
   * The window as it is, uncopied, without counting as use: for a reload of
   * the conversation on screen, which reads it on every poll. The caller must
   * not change it (the window's own changes make new arrays, so a held
   * reference stays as it was read).
   */
  function peekWindow(conversationId) {
    const entry = entryOf(conversationId);
    if (!entry) return null;
    return { messages: entry.messages, hasMoreOlder: entry.hasMoreOlder, hasMoreNewer: entry.hasMoreNewer };
  }

  /** How many messages the window holds (0 when none is kept). */
  function windowSize(conversationId) {
    return entryOf(conversationId)?.messages.length || 0;
  }

  function clear() {
    entries.clear();
  }

  return {
    remember,
    addOlder,
    addNewer,
    upsertMessage,
    detachFromTail,
    trim,
    trimAll,
    read,
    peekWindow,
    forget,
    has,
    windowSize,
    clear,
    keys: () => [...entries.keys()],
    get size() {
      return entries.size;
    },
  };
}

// The page's one cache: the conversation views write and read it, the socket
// handlers drop entries the relay has changed.
export const conversationPayloadCache = createConversationPayloadCache();
