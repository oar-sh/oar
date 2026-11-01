// Back and forward through sessions, and back closing what is open first.
//
// Each session switch is one history entry, marked with the conversation's
// id and shown as `?conv=<id>` in the address. Above the session entry each
// open overlay (the phone's sidebar, the ⚙ panel, the ︙ menu, a modal)
// holds one entry of its own, and back closes the top one first. On a phone
// the visit's first session has a "list" entry beneath it: back onto it
// opens the session list. In the installed app the back guard's floor lies
// beneath all of it (back-guard.mjs).
//
// Every entry written here carries its place in the stack, so a pop tells
// back from forward. An entry that leads nowhere any more (an overlay closed
// since, a deleted conversation) is stepped over in the same direction.
// The viewers (file viewer, sub-agent viewer, task console) keep their own
// entries and listeners (viewer-history.mjs); here their entries only close
// the overlays that lay above them.
//
// History is written in one place, `settle()`, once the changes of a tick
// have landed. A switch made from an open overlay replaces that overlay's
// entry rather than popping it first, and whatever does need a pop waits for
// it before it writes again: a pushState right after back() would land
// beneath the pop.
//
// Forward history survives an overlay: one opened while sessions lie ahead
// (back was pressed) takes no entry, since a push would drop them. Back then
// lands on the entry below, closes the overlay and goes forward again, so it
// still only closes the overlay. At the visit's base nothing of ours lies
// below (back would leave the app), so there the overlay takes its entry and
// what lay ahead goes, as before.
//
// Until the app has shown a session (or said that none is open) the address
// may still hold a link it has not read yet (`?conv=`, `push_conv`): entries
// written meanwhile keep the address as it is.
//
// No DOM here: history, location, timers and the app's callbacks come in.

import {
  BACK_GUARD_APP,
  BACK_GUARD_FLOOR,
  FIRST_INTERACTION_EVENTS,
  HISTORY_POSITION,
  VISIT_BASE,
  VISIT_LAID,
  inheritedVisitMarks,
} from './back-guard.mjs';

export const SESSION_ENTRY = 'oarConv';
export const LIST_ENTRY = 'oarList';
export const OVERLAY_ENTRY = 'oarOverlay';
export const SESSION_PARAM = 'conv';
const PUSH_PARAM = 'push_conv';
// A pop of our own that never answers (it should within a frame or two)
// stops holding up the writes after this long.
export const OWN_POP_FALLBACK_MS = 1500;

/**
 * What an entry is: 'floor' (the back guard's), 'overlay', 'list',
 * 'session', 'other' (a viewer's entry, the guard's bare app entry) or
 * 'none' (no state: the page's first entry before anything was written).
 */
export function entryKind(state) {
  if (!state || typeof state !== 'object') return 'none';
  if (state[BACK_GUARD_FLOOR]) return 'floor';
  if (state[OVERLAY_ENTRY]) return 'overlay';
  if (state[LIST_ENTRY]) return 'list';
  if (Object.prototype.hasOwnProperty.call(state, SESSION_ENTRY)) return 'session';
  return Object.keys(state).length ? 'other' : 'none';
}

function positionOf(state) {
  const value = state?.[HISTORY_POSITION];
  return Number.isFinite(value) ? value : undefined;
}

/** The address of a session entry: `?conv=<id>` set (or gone), `push_conv` gone, the rest kept. */
export function sessionUrl(href, conversationId) {
  let url;
  try {
    url = new URL(String(href || ''));
  } catch {
    return undefined;
  }
  url.searchParams.delete(PUSH_PARAM);
  if (conversationId) url.searchParams.set(SESSION_PARAM, conversationId);
  else url.searchParams.delete(SESSION_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

export const GONE_STORAGE_KEY = 'oar_gone_conversations';
const GONE_LIMIT = 200;

/**
 * The conversations found gone on this tab (deleted, or never there), kept
 * in the tab's sessionStorage: its history outlives a reload, so must the
 * knowledge that some of its entries lead nowhere. The newest `limit` stay.
 */
export function createGoneList({ storage = null, key = GONE_STORAGE_KEY, limit = GONE_LIMIT } = {}) {
  const ids = new Set();
  try {
    const stored = JSON.parse(storage?.getItem?.(key) || '[]');
    if (Array.isArray(stored)) {
      for (const id of stored) if (typeof id === 'string' && id.trim()) ids.add(id.trim());
    }
  } catch {}
  return {
    has: (id) => ids.has(String(id || '').trim()),
    add(id) {
      const value = String(id || '').trim();
      if (!value) return;
      ids.delete(value);
      ids.add(value);
      while (ids.size > limit) ids.delete(ids.values().next().value);
      try {
        storage?.setItem?.(key, JSON.stringify([...ids]));
      } catch {}
    },
  };
}

/**
 * Reports overlays opening and closing from a list of
 * `{ name, isOpen(), close() }`; `check()` runs on every DOM change that may
 * have touched one. Closings are reported before openings, so an overlay
 * that hands over to another (the ︙ menu opening Settings) gives up its
 * entry to the next one.
 */
export function createOverlayWatch({ overlays = [], onOpened = () => {}, onClosed = () => {} } = {}) {
  const isOpen = (overlay) => {
    try {
      return overlay.isOpen() === true;
    } catch {
      return false;
    }
  };
  const known = new Map(overlays.map((overlay) => [overlay.name, isOpen(overlay)]));
  return {
    check() {
      const opened = [];
      const closed = [];
      for (const overlay of overlays) {
        const now = isOpen(overlay);
        if (now === known.get(overlay.name)) continue;
        known.set(overlay.name, now);
        (now ? opened : closed).push(overlay);
      }
      for (const overlay of closed) onClosed(overlay.name);
      for (const overlay of opened) onOpened(overlay);
    },
  };
}

/**
 * `open(id)` opens a session for a pop (without writing history again; the
 * app answers with `shown(id, { mode: 'none' })`). `isGone(id)` names a
 * deleted session. `onList()` / `onLeaveList()` open and close the session
 * list. `setTitle(id)` names the current entry (Chrome's long-press back
 * list shows it). `listOverlay` is the overlay that the list entry stands
 * for (the phone's sidebar): it takes no entry of its own while there.
 */
export function createSessionHistory({
  history,
  location = null,
  open = () => {},
  isGone = () => false,
  onList = () => {},
  onLeaveList = () => {},
  setTitle = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  listOverlay = 'sidebar',
  loadId = Math.random().toString(36).slice(2, 8),
} = {}) {
  const start = history.state && typeof history.state === 'object' ? history.state : {};
  let sticky = inheritedVisitMarks(start);
  let lastPos = positionOf(start);
  // The top of the stack as far as we know: forward from there leads nowhere.
  let highestPos = lastPos;
  // The highest session or list entry in the stack: above the current
  // position, there is forward history an overlay's push would drop.
  let sessionTop = ['session', 'list'].includes(entryKind(start)) ? lastPos : undefined;
  // The visit's lowest own entry (back-guard.mjs, VISIT_BASE).
  let basePos = Number.isFinite(sticky[VISIT_BASE]) ? sticky[VISIT_BASE] : undefined;
  let conv = null;
  // Nothing shown yet: the address may hold a link not read yet.
  let shownOnce = false;
  // The session the last back or forward opened, and which way it went.
  let popped = null;
  let pending = null; // { conv, mode: 'push' | 'replace' } not written yet
  // Open overlays, in the order they opened: { key, name, close, isOpen, unentered }.
  // `unentered`: opened above forward history, it took no entry (see the top).
  let overlays = [];
  let written = []; // our overlay entries above the session entry: { key, pos }
  let atList = false;
  let listForward = false; // the session entry we came back from lies ahead
  let awaitingPop = false;
  let fallback = null;
  let settleQueued = false;
  let counter = 0;

  const here = () => positionOf(history.state) ?? lastPos ?? 0;
  const urlFor = (id) => (!id && !shownOnce ? undefined : sessionUrl(location?.href, id));
  const sessionFields = (id, pos) => ({ [SESSION_ENTRY]: id || null, [HISTORY_POSITION]: pos });
  const overlayFields = (key, pos) => ({ [OVERLAY_ENTRY]: key, [HISTORY_POSITION]: pos });
  const entried = () => overlays.filter((overlay) => !overlay.unentered);

  function noteOwnEntry(pos) {
    if (pos === undefined) return;
    sessionTop = Math.max(sessionTop ?? pos, pos);
  }

  function write(method, fields, url) {
    const state = { ...sticky, ...fields };
    if (url === undefined) history[method](state, '');
    else history[method](state, '', url);
    lastPos = state[HISTORY_POSITION];
    highestPos = method === 'pushState' ? lastPos : Math.max(highestPos ?? lastPos, lastPos);
    // A push drops everything above it.
    if (method === 'pushState' && sessionTop !== undefined && sessionTop >= lastPos) sessionTop = lastPos - 1;
    if (['session', 'list'].includes(entryKind(fields))) noteOwnEntry(lastPos);
  }

  function callClose(overlay) {
    try {
      overlay.close?.();
    } catch {}
  }

  /**
   * Closes `closing` (the top one first). One that stays open (a "discard?"
   * answered no) is open again as far as history goes, and takes an entry.
   */
  function closeAll(closing) {
    for (const overlay of closing) callClose(overlay);
    const stayed = closing.filter((overlay) => {
      try {
        return overlay.isOpen?.() === true;
      } catch {
        return false;
      }
    });
    if (!stayed.length) return;
    for (const overlay of stayed.reverse()) overlays.push({ ...overlay, unentered: false });
    requestSettle();
  }

  /** Closes every open overlay from `index` up, the top one first. */
  function closeFrom(index) {
    const closing = overlays.slice(index).reverse();
    overlays = overlays.slice(0, index);
    closeAll(closing);
  }

  /** Closes the overlays whose entries lay above position `pos`. */
  function closeAbove(pos) {
    if (pos === undefined) return;
    const above = new Set(written.filter((entry) => entry.pos > pos).map((entry) => entry.key));
    written = written.filter((entry) => entry.pos <= pos);
    const closing = overlays.filter((overlay) => above.has(overlay.key)).reverse();
    overlays = overlays.filter((overlay) => !above.has(overlay.key));
    closeAll(closing);
  }

  /**
   * An overlay opening now may take no entry: sessions lie ahead, and below
   * the session on screen lies one of ours to land on (see the top).
   */
  function mayLeaveEntryOut() {
    if (awaitingPop || pending || written.length || atList || entried().length) return false;
    if (entryKind(history.state) !== 'session') return false;
    const pos = here();
    return sessionTop !== undefined && sessionTop > pos && basePos !== undefined && pos > basePos;
  }

  /** Steps over a dead entry; forward at the top of the stack bounces back instead. */
  function step(direction, pos) {
    if (direction < 0) history.back();
    else if (direction > 0 && pos !== undefined && pos >= (highestPos ?? pos)) history.back();
    else if (direction > 0) history.forward();
  }

  function requestSettle() {
    if (settleQueued) return;
    settleQueued = true;
    schedule(() => {
      settleQueued = false;
      settle();
    }, 0);
  }

  /** A traversal of our own: its pop opens nothing, and writes wait for it. */
  function traverse(delta) {
    awaitingPop = true;
    fallback = schedule(() => {
      fallback = null;
      if (!awaitingPop) return;
      awaitingPop = false;
      // Never pop again on a guess (a late pop and a second one would
      // overshoot): what we meant to pop stays behind, stepped over later.
      written = [];
      settle();
    }, OWN_POP_FALLBACK_MS);
    history.go(delta);
  }

  function popBy(count) {
    traverse(-count);
  }

  function resync() {
    const pos = positionOf(history.state);
    if (pos === undefined) return;
    lastPos = pos;
    written = written.filter((entry) => entry.pos <= pos);
  }

  function settle() {
    if (awaitingPop) return;
    // An overlay the page shows closed, though no one has said so yet.
    overlays = overlays.filter((overlay) => typeof overlay.isOpen !== 'function' || overlay.isOpen() !== false);
    const top = history.state;
    const topKind = entryKind(top);
    // Ours can only be taken out while the top one is current; under
    // someone else's entry they stay behind, stepped over later.
    if (written.length && !(topKind === 'overlay' && top[OVERLAY_ENTRY] === written[written.length - 1].key)) {
      written = [];
    }
    if (pending) {
      const target = pending.conv;
      const above = written.length;
      if (pending.mode === 'replace' && !above && topKind === 'list') {
        // A reload on the list entry: the list stays, the session is shown.
        pending = null;
        atList = true;
        setTitle(target);
      } else if (!above && topKind === 'session' && (top[SESSION_ENTRY] || null) === target) {
        pending = null; // there and back before anything was written
        setTitle(target);
      } else {
        // An overlay entry on top that is not ours any more (a reload on it) is replaced too.
        const replace = pending.mode === 'replace' && (above > 0 || topKind === 'session' || topKind === 'none' || topKind === 'overlay');
        if (replace && above) return popBy(above);
        if (!replace && above > 1) return popBy(above - 1);
        pending = null;
        if (replace) {
          write('replaceState', sessionFields(target, here()), urlFor(target));
        } else if (above === 1) {
          // Chosen from an open overlay: the session takes the overlay's entry.
          write('replaceState', sessionFields(target, written[0].pos), urlFor(target));
          written = [];
        } else {
          write('pushState', sessionFields(target, here() + 1), urlFor(target));
        }
        setTitle(target);
      }
    }
    // Only the overlays that take an entry are written.
    const withEntry = entried();
    let common = 0;
    while (common < written.length && common < withEntry.length && written[common].key === withEntry[common].key) common += 1;
    const extra = written.length - common;
    const add = withEntry.length - common;
    if (extra > 1 || (extra === 1 && add === 0)) return popBy(add ? extra - 1 : extra);
    for (let index = common; index < withEntry.length; index += 1) {
      const { key } = withEntry[index];
      if (index < written.length) {
        // The top entry belonged to an overlay that just closed: the next one takes it.
        const { pos } = written[index];
        write('replaceState', overlayFields(key, pos));
        written[index] = { key, pos };
      } else {
        const pos = here() + 1;
        write('pushState', overlayFields(key, pos));
        written.push({ key, pos });
      }
    }
    return undefined;
  }

  return {
    get conversation() { return conv; },
    get atList() { return atList; },
    get openOverlays() { return overlays.map((overlay) => overlay.name); },

    /**
     * The app shows `id`. `mode`: 'push' (a switch), 'replace' (the page's
     * first session, a compaction's successor, nothing open any more) or
     * 'none' (a pop opened it: history is there already).
     */
    shown(id, { mode = 'push' } = {}) {
      const next = String(id || '').trim() || null;
      shownOnce = true;
      if (mode === 'none') {
        conv = next;
        setTitle(next);
        return;
      }
      if (next === conv) return;
      const replace = mode === 'replace' || pending?.mode === 'replace' || !conv;
      conv = next;
      popped = null;
      atList = false;
      listForward = false;
      pending = { conv: next, mode: replace ? 'replace' : 'push' };
      requestSettle();
    },

    /**
     * The relay says `id` does not exist (any more). True when back or
     * forward led onto it: history steps on past it the same way, and the
     * next pop opens what lies there. False otherwise: the app clears the
     * view, and with it the entry (`shown(null, { mode: 'replace' })`).
     */
    missing(id) {
      const value = String(id || '').trim();
      if (!value || conv !== value || popped?.id !== value || awaitingPop) return false;
      const top = history.state;
      if (entryKind(top) !== 'session' || top[SESSION_ENTRY] !== value) return false;
      const pos = positionOf(top);
      const { direction } = popped;
      // Back past the visit's lowest own entry would leave the app.
      if (!direction || (direction < 0 && !(pos !== undefined && basePos !== undefined && pos > basePos))) return false;
      popped = null;
      conv = null;
      pending = null;
      closeFrom(0);
      written = [];
      step(direction, pos);
      return true;
    },

    /**
     * `{ name, close(), isOpen() }` opened: it takes one entry, or none above
     * forward history (see the top).
     */
    overlayOpened(overlay) {
      if (!overlay?.name) return;
      if (atList && overlay.name === listOverlay) return;
      if (overlays.some((open) => open.name === overlay.name)) return;
      counter += 1;
      const unentered = mayLeaveEntryOut();
      overlays.push({ key: `${loadId}.${counter}`, name: overlay.name, close: overlay.close, isOpen: overlay.isOpen, unentered });
      if (!unentered) requestSettle();
    },

    /** An overlay closed by other means than back: its entry goes. */
    overlayClosed(name) {
      if (atList && name === listOverlay) {
        // The list closed by hand: back where we came from, if that lies ahead.
        if (listForward) {
          listForward = false;
          history.forward();
        }
        return;
      }
      const before = overlays.length;
      overlays = overlays.filter((overlay) => overlay.name !== name);
      if (overlays.length !== before) requestSettle();
    },

    /** Feed every popstate here. */
    onPopState() {
      const state = history.state;
      const kind = entryKind(state);
      const pos = positionOf(state);
      if (awaitingPop) {
        awaitingPop = false;
        if (fallback !== null) cancel(fallback);
        fallback = null;
        resync();
        settle();
        return;
      }
      const direction = pos === undefined || lastPos === undefined ? 0 : Math.sign(pos - lastPos);
      if (pos !== undefined) {
        lastPos = pos;
        highestPos = Math.max(highestPos ?? pos, pos);
      }
      if (kind === 'session' || kind === 'list') noteOwnEntry(pos);
      if (direction < 0 && !written.length && (kind === 'session' || kind === 'list') && overlays.some((overlay) => overlay.unentered)) {
        // Back with an overlay open that took no entry: it closes, and
        // history goes forward again to the session it lay over, keeping
        // what lies ahead.
        closeFrom(0);
        traverse(1);
        return;
      }
      if (kind === 'overlay') {
        const at = overlays.findIndex((overlay) => overlay.key === state[OVERLAY_ENTRY]);
        if (at >= 0) {
          closeFrom(at + 1);
          written = written.filter((entry) => entry.pos <= pos);
          return;
        }
        // Its overlay closed since (or a reload came between): step over it.
        closeAbove(pos);
        step(direction, pos);
        return;
      }
      if (kind === 'other') {
        closeAbove(pos);
        return;
      }
      if (kind === 'none') return;
      closeFrom(0);
      written = [];
      if (kind === 'floor') return; // the back guard answers
      if (kind === 'list') {
        if (direction < 0) listForward = true;
        if (!atList) {
          atList = true;
          onList();
        }
        return;
      }
      const wasAtList = atList;
      atList = false;
      listForward = false;
      const target = state[SESSION_ENTRY] || null;
      if (!target || isGone(target)) {
        step(direction, pos);
        return;
      }
      if (target !== conv) {
        conv = target;
        pending = null;
        popped = { id: target, direction };
        setTitle(target);
        open(target);
        return;
      }
      if (wasAtList) onLeaveList();
    },

    /**
     * At the visit's first touch or key, after the back guard: on a phone a
     * list entry beneath the session entry; everywhere the mark that the
     * base is laid, so a reload lays nothing again.
     */
    layBase({ phone = false } = {}) {
      const top = history.state && typeof history.state === 'object' ? history.state : {};
      if (top[VISIT_LAID] || sticky[VISIT_LAID]) return false;
      const kind = entryKind(top);
      if (kind === 'overlay' || kind === 'list' || kind === 'floor') return false;
      // Of the others, only the bare app entry the back guard just pushed.
      if (kind === 'other' && !top[BACK_GUARD_APP]) return false;
      if (!awaitingPop && pending) settle();
      if (awaitingPop) return false;
      const pos = positionOf(top) ?? (lastPos === undefined ? 0 : lastPos + 1);
      sticky = { ...sticky, ...inheritedVisitMarks(top), [VISIT_LAID]: phone ? 'list' : 'plain', [VISIT_BASE]: pos };
      basePos = pos;
      written = [];
      if (phone) {
        write('replaceState', { [LIST_ENTRY]: true, [HISTORY_POSITION]: pos });
        write('pushState', sessionFields(conv, pos + 1), urlFor(conv));
      } else {
        write('replaceState', sessionFields(conv, pos), urlFor(conv));
      }
      setTitle(conv);
      return true;
    },

    /** The entry the back guard pushes again above its floor. */
    entryAgain() {
      const pos = (positionOf(history.state) ?? lastPos ?? 0) + 1;
      closeFrom(0);
      written = [];
      lastPos = pos;
      highestPos = pos;
      sessionTop = pos;
      // Pushed again right above the floor: the visit's lowest own entry.
      basePos = pos;
      sticky = { ...sticky, [VISIT_BASE]: pos };
      if (sticky[VISIT_LAID] === 'list') {
        listForward = false;
        if (!atList) {
          atList = true;
          onList();
        }
        return { state: { ...sticky, [LIST_ENTRY]: true, [HISTORY_POSITION]: pos } };
      }
      atList = false;
      return { state: { ...sticky, ...sessionFields(conv, pos) }, url: urlFor(conv) };
    },
  };
}

/** Lays the visit's base at the first touch or key (see back-guard.mjs for why not earlier). */
export function armVisitBaseOnFirstInteraction({ target, sessionHistory, isPhone = () => false } = {}) {
  if (!target || !sessionHistory) return null;
  const state = { armed: false };
  const arm = () => {
    for (const eventName of FIRST_INTERACTION_EVENTS) target.removeEventListener(eventName, arm, true);
    if (state.armed) return;
    state.armed = true;
    sessionHistory.layBase({ phone: isPhone() });
  };
  for (const eventName of FIRST_INTERACTION_EVENTS) target.addEventListener(eventName, arm, true);
  return { get armed() { return state.armed; } };
}
