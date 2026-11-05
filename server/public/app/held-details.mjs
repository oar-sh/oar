// The live poll's diet: the page polls its conversation every 900 ms, and a
// finished reply's tool lines and thoughts do not change, so the poll names
// the replies whose details it already holds and the relay leaves those out.
// Pure: the relay's route uses the param side, the page the store side.
//
// The param (`heldDetails`) is `id~version,id~version,…`: an assistant
// message id and the version of its details the page holds. The version
// (`detailsVersion` on every assistant message of a full payload) changes
// with any row that arrives or changes after the turn (a late sub-agent
// line, a thought update, a history rebuild), and the relay then sends the
// details again. A held message comes back as `detailsHeld: true` with empty
// `activities` and `thoughts`, which the page fills from its store.

export const HELD_DETAILS_MAX_IDS = 200;
export const HELD_DETAILS_MAX_BYTES = 8 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// The shape of a held reply's activities and thoughts. Bump it whenever the
// relay changes how those arrays are built for a finished reply (a cap, a
// sanitiser, a new field): every page then holds a stale version and gets
// each reply in full once.
export const HELD_DETAILS_SHAPE = 's1';
// `s1.<tool rows>.<their highest row id>.<thought rows>.<their highest row
// id>.<fingerprint of the thoughts' text and done>`. Anything else (a version
// from before this form) is dropped, so the reply goes out in full.
const VERSION_PATTERN = /^s\d{1,3}\.\d{1,12}\.\d{1,15}\.\d{1,12}\.\d{1,15}\.[0-9a-f]{8}$/;

const nonNegative = (value) => Math.max(0, Math.trunc(Number(value) || 0));

/**
 * A finished reply's details version. Tool rows are only ever inserted, so
 * their count and highest row id see every change. A thought row is updated
 * in place as its text streams in and when it is done, so the thoughts also
 * carry a fingerprint of their content (`thoughtFingerprint`).
 */
export function detailsVersion({ activityCount = 0, activityMaxRowId = 0, thoughtCount = 0, thoughtMaxRowId = 0, thoughtHash = '00000000' } = {}) {
  const hash = /^[0-9a-f]{8}$/.test(String(thoughtHash)) ? String(thoughtHash) : '00000000';
  return [HELD_DETAILS_SHAPE, nonNegative(activityCount), nonNegative(activityMaxRowId), nonNegative(thoughtCount), nonNegative(thoughtMaxRowId), hash].join('.');
}

/**
 * The fingerprint of one reply's thought rows: FNV-1a (32 bit) over each
 * row's id, done and text, in row id order. Any change to a thought's text or
 * done changes it, two in the same millisecond included.
 */
export function thoughtFingerprint(rows) {
  let hash = 0x811c9dc5;
  const mix = (text) => {
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  const ordered = [...(Array.isArray(rows) ? rows : [])].sort((a, b) => Number(a?.rowid) - Number(b?.rowid));
  for (const row of ordered) mix(`${nonNegative(row?.rowid)}\u0001${Number(row?.done) ? 1 : 0}\u0001${String(row?.text ?? '')}\u0002`);
  return hash.toString(16).padStart(8, '0');
}

/**
 * The relay's reading of the param: a Map id → version, or null when it
 * names nothing usable or is too big (over 8 KB or 200 entries: the poll
 * then gets the full payload). Entries that are not `id~version` with an id
 * of [A-Za-z0-9_-]{1,64} are dropped.
 */
export function parseHeldDetailsParam(raw) {
  if (raw === undefined || raw === null) return null;
  const text = Array.isArray(raw) ? '' : String(raw);
  if (!text || text.length > HELD_DETAILS_MAX_BYTES) return null;
  const parts = text.split(',');
  if (parts.length > HELD_DETAILS_MAX_IDS) return null;
  const held = new Map();
  for (const part of parts) {
    const at = part.indexOf('~');
    if (at <= 0) continue;
    const id = part.slice(0, at);
    const version = part.slice(at + 1);
    if (!ID_PATTERN.test(id) || !VERSION_PATTERN.test(version)) continue;
    held.set(id, version);
  }
  return held.size ? held : null;
}

/**
 * The page's side: what it holds of one open conversation's finished
 * replies. Filled only from conversation payloads fetched over HTTP (never
 * from a socket's reply: the turn-end fallback carries the live list, not
 * the finished one), and only with what it is shown.
 */
export function createHeldDetailsStore() {
  let conversationId = '';
  // id → { version, activities, thoughts }, in the payload's message order.
  let held = new Map();
  // A poll whose answer named a reply the page does not hold is dropped; the
  // next poll goes without the param. Two such drops in a row and the param
  // stays off until the next full load.
  let fullNext = false;
  let disabled = false;
  let dropStreak = 0;

  function forConversation(id) {
    const key = String(id || '');
    if (key !== conversationId) {
      conversationId = key;
      held = new Map();
      fullNext = false;
      disabled = false;
      dropStreak = 0;
    }
  }

  function record(messages) {
    for (const message of Array.isArray(messages) ? messages : []) {
      if (message?.role !== 'assistant' || message.detailsHeld) continue;
      const id = String(message.id || '');
      const version = String(message.detailsVersion || '');
      if (!ID_PATTERN.test(id) || !VERSION_PATTERN.test(version)) continue;
      held.delete(id);
      held.set(id, {
        version,
        activities: Array.isArray(message.activities) ? message.activities : [],
        thoughts: Array.isArray(message.thoughts) ? message.thoughts : [],
      });
    }
  }

  return {
    /**
     * A payload was applied. `full`: a load of the whole window (opening,
     * reconnecting, a reload), which replaces what is held; otherwise (a
     * poll, a page of older history) its replies are added. `shownIds`, when
     * given, is every message on screen now: entries for others go.
     */
    noteApplied(id, payload, { full = false, shownIds = null } = {}) {
      forConversation(id);
      if (full) {
        held = new Map();
        fullNext = false;
        disabled = false;
        dropStreak = 0;
      }
      record(payload?.messages);
      if (shownIds) {
        const shown = new Set(Array.from(shownIds, (value) => String(value)));
        for (const key of [...held.keys()]) if (!shown.has(key)) held.delete(key);
      }
    },

    /** The param for the next poll of `id`, or '' to ask for everything. */
    param(id) {
      forConversation(id);
      if (fullNext) {
        fullNext = false;
        return '';
      }
      if (disabled || !held.size) return '';
      // The newest first, as many as fit in 8 KB and 200 entries.
      const parts = [];
      let bytes = 0;
      for (const [key, entry] of [...held.entries()].reverse()) {
        const part = `${key}~${entry.version}`;
        if (parts.length >= HELD_DETAILS_MAX_IDS || bytes + part.length + 1 > HELD_DETAILS_MAX_BYTES) break;
        parts.push(part);
        bytes += part.length + 1;
      }
      return parts.join(',');
    },

    /**
     * Fill the held replies of a poll's answer from the store, in place.
     * Returns false (the answer must be dropped) when it names one the store
     * does not hold.
     */
    restore(id, payload) {
      forConversation(id);
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      const missing = messages.some((message) => message?.detailsHeld && !held.has(String(message.id || '')));
      if (missing) {
        dropStreak += 1;
        if (dropStreak >= 2) disabled = true;
        else fullNext = true;
        return false;
      }
      let restored = 0;
      for (const message of messages) {
        if (!message?.detailsHeld) continue;
        const entry = held.get(String(message.id));
        message.activities = entry.activities;
        message.thoughts = entry.thoughts;
        message.detailsVersion = entry.version;
        delete message.detailsHeld;
        restored += 1;
      }
      // Only a poll the store answered for ends a run of drops; the full
      // poll after a drop does not.
      if (restored) dropStreak = 0;
      return true;
    },

    /** For tests and the page's own checks. */
    size() { return held.size; },
    has(messageId) { return held.has(String(messageId || '')); },
  };
}
