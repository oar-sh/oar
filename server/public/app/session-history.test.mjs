import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GONE_STORAGE_KEY,
  LIST_ENTRY,
  OVERLAY_ENTRY,
  OWN_POP_FALLBACK_MS,
  SESSION_ENTRY,
  armVisitBaseOnFirstInteraction,
  createGoneList,
  createOverlayWatch,
  createSessionHistory,
  entryKind,
  sessionUrl,
} from './session-history.mjs';
import { BACK_GUARD_APP, BACK_GUARD_FLOOR, installBackGuard } from './back-guard.mjs';
import { consumeConversationDeepLink } from './conversation-deep-link.mjs';
import { createViewerHistory, VIEWER_HISTORY_MARK } from './viewer-history.mjs';

const ORIGIN = 'https://relay.example.test';

// A browser's session history: entries with state and URL, an index, and
// traversals (back, forward, go) that land later, as the browser's do, and
// then fire popstate. Back below the first entry leaves the page.
function fakeBrowser(startUrl = '/') {
  const entries = [{ state: null, url: startUrl }];
  let index = 0;
  let left = 0;
  const traversals = [];
  const listeners = [];
  const history = {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    pushState(state, _title, url) {
      entries.splice(index + 1);
      entries.push({ state: structuredClone(state), url: url ?? entries[index].url });
      index += 1;
    },
    replaceState(state, _title, url) {
      entries[index] = { state: structuredClone(state), url: url ?? entries[index].url };
    },
    back() { traversals.push(-1); },
    forward() { traversals.push(1); },
    go(delta) { traversals.push(delta); },
  };
  const location = { get href() { return `${ORIGIN}${entries[index].url}`; } };
  return {
    history,
    location,
    entries,
    get index() { return index; },
    get url() { return entries[index].url; },
    get left() { return left; },
    onPopState(fn) { listeners.push(fn); },
    /** Lands the queued traversals; true when one landed or left. */
    flush() {
      let moved = false;
      while (traversals.length) {
        const delta = traversals.shift();
        const target = index + delta;
        moved = true;
        if (target < 0) { left += 1; continue; }
        if (target >= entries.length) continue;
        index = target;
        for (const fn of [...listeners]) fn();
      }
      return moved;
    },
  };
}

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = [];
  return {
    schedule: (fn, ms) => { seq += 1; pending.push({ id: seq, fn, at: now + ms }); return seq; },
    cancel: (id) => { const at = pending.findIndex((timer) => timer.id === id); if (at >= 0) pending.splice(at, 1); },
    runDue() {
      let ran = false;
      for (;;) {
        pending.sort((a, b) => a.at - b.at || a.id - b.id);
        const timer = pending[0];
        if (!timer || timer.at > now) return ran;
        pending.shift();
        timer.fn();
        ran = true;
      }
    },
    advance(ms) { now += ms; },
  };
}

const TITLES = {
  'conv-otter': 'Otter migration notes',
  'conv-heron': 'Heron nesting survey',
  'conv-lynx': 'Lynx camera traps',
  'conv-badger': 'Badger sett map',
};

// The app as the session history sees it: openConversation, the overlays
// (whose closing the page's observer reports a moment later) and the
// phone's sidebar, which is an overlay too.
function setup({ startUrl = '/', initial = 'conv-otter', guard = false, phone = false, lay = guard || phone } = {}) {
  const browser = fakeBrowser(startUrl);
  const timers = fakeTimers();
  const gone = new Set();
  const app = { conv: null, title: 'Base', opens: [], floorHits: 0 };
  const overlays = new Map();
  const later = (fn) => timers.schedule(fn, 0);
  let sessionHistory;

  function overlay(name) {
    if (overlays.has(name)) return overlays.get(name);
    const entry = {
      name,
      open: false,
      isOpen: () => entry.open,
      /** Opened by the user: the observer reports it. */
      show() { entry.open = true; later(() => sessionHistory.overlayOpened({ name, isOpen: entry.isOpen, close: entry.close })); },
      /** Closed by the ×, a tap outside, Escape. */
      hide() { if (!entry.open) return; entry.open = false; later(() => sessionHistory.overlayClosed(name)); },
      /** What back calls. */
      close() { entry.hide(); },
    };
    overlays.set(name, entry);
    return entry;
  }
  const sidebar = overlay('sidebar');

  function openConversation(id, mode = 'push') {
    app.opens.push(id);
    app.conv = id;
    sessionHistory.shown(id, { mode });
    sidebar.hide(); // openConversation closes the sidebar
  }

  sessionHistory = createSessionHistory({
    history: browser.history,
    location: browser.location,
    open: (id) => openConversation(id, 'none'),
    isGone: (id) => gone.has(id),
    onList: () => sidebar.show(),
    onLeaveList: () => sidebar.hide(),
    setTitle: (id) => { app.title = id ? TITLES[id] : 'Base'; },
    schedule: timers.schedule,
    cancel: timers.cancel,
    loadId: 'load1',
  });
  browser.onPopState(() => sessionHistory.onPopState());
  let backGuard = null;

  const run = () => {
    for (let guardRounds = 0; guardRounds < 100; guardRounds += 1) {
      const ran = timers.runDue();
      const moved = browser.flush();
      if (!ran && !moved) return;
    }
    throw new Error('history never settled');
  };
  const back = () => { browser.history.back(); run(); };
  const forward = () => { browser.history.forward(); run(); };
  const open = (id) => { openConversation(id); run(); };

  if (initial) openConversation(initial, 'replace');
  run();
  if (lay) {
    // The first touch: the guard first, then the base.
    if (guard) {
      backGuard = installBackGuard({
        history: browser.history,
        onFloor: () => { app.floorHits += 1; },
        entryAgain: () => sessionHistory.entryAgain(),
      });
      browser.onPopState(() => backGuard.onPopState());
    }
    sessionHistory.layBase({ phone });
    run();
  }
  const kinds = () => browser.entries.map((entry) => entryKind(entry.state));
  return { browser, timers, app, gone, overlay, sidebar, sessionHistory, run, back, forward, open, openConversation, kinds };
}

test('A, B, C: back, back, forward walk the path; the address and title follow', () => {
  const t = setup();
  assert.equal(t.browser.url, '/?conv=conv-otter');
  assert.equal(t.browser.entries.length, 1, 'the first session replaces the page entry');
  t.open('conv-heron');
  t.open('conv-lynx');
  assert.equal(t.browser.entries.length, 3);
  assert.equal(t.browser.url, '/?conv=conv-lynx');
  assert.equal(t.app.title, 'Lynx camera traps');

  t.back();
  assert.equal(t.app.conv, 'conv-heron');
  assert.equal(t.browser.url, '/?conv=conv-heron');
  assert.equal(t.app.title, 'Heron nesting survey');
  t.back();
  assert.equal(t.app.conv, 'conv-otter');
  t.forward();
  assert.equal(t.app.conv, 'conv-heron');
  assert.equal(t.browser.entries.length, 3, 'walking pushes nothing');
  assert.deepEqual(t.app.opens, ['conv-otter', 'conv-heron', 'conv-lynx', 'conv-heron', 'conv-otter', 'conv-heron']);

  // A switch from the middle drops what lay ahead, as a browser does.
  t.open('conv-badger');
  assert.equal(t.browser.entries.length, 3);
  t.back();
  assert.equal(t.app.conv, 'conv-heron');
});

test('reopening the session on screen adds no entry', () => {
  const t = setup();
  t.open('conv-heron');
  t.open('conv-heron');
  t.openConversation('conv-heron', 'push');
  t.run();
  assert.equal(t.browser.entries.length, 2);
  // There and back before anything was written: nothing either.
  t.openConversation('conv-lynx');
  t.openConversation('conv-heron');
  t.run();
  assert.equal(t.browser.entries.length, 2);
  assert.equal(t.browser.url, '/?conv=conv-heron');
});

test('a load with ?conv keeps it, and other parameters, in the address', () => {
  const t = setup({ startUrl: '/oar/?theme=dark&conv=conv-heron#end', initial: null });
  const id = consumeConversationDeepLink({ location: t.browser.location, history: t.browser.history, title: 'OAR' });
  assert.equal(id, 'conv-heron');
  t.openConversation(id, 'replace');
  t.run();
  assert.equal(t.browser.entries.length, 1);
  assert.equal(t.browser.url, '/oar/?theme=dark&conv=conv-heron#end');
  assert.equal(t.browser.history.state[SESSION_ENTRY], 'conv-heron');
});

test('a load with push_conv consumes it and shows ?conv instead', () => {
  const t = setup({ startUrl: '/?push_conv=conv-lynx', initial: null });
  const id = consumeConversationDeepLink({ location: t.browser.location, history: t.browser.history, title: 'OAR' });
  assert.equal(t.browser.url, '/?conv=conv-lynx');
  t.openConversation(id, 'replace');
  t.run();
  assert.equal(t.browser.entries.length, 1, 'the notification\'s session pushes nothing');
  assert.equal(t.browser.url, '/?conv=conv-lynx');
  t.open('conv-otter');
  t.back();
  assert.equal(t.app.conv, 'conv-lynx');
});

test('an overlay takes one entry and back closes it, staying on the session', () => {
  const t = setup();
  t.open('conv-heron');
  const panel = t.overlay('composer-settings');
  panel.show();
  t.run();
  assert.equal(t.browser.entries.length, 3);
  assert.ok(t.browser.history.state[OVERLAY_ENTRY]);
  assert.equal(t.browser.url, '/?conv=conv-heron', 'an overlay leaves the address alone');
  t.back();
  assert.equal(panel.open, false);
  assert.equal(t.app.conv, 'conv-heron');
  assert.equal(t.browser.index, 1);
  t.back();
  assert.equal(t.app.conv, 'conv-otter');
});

test('an overlay closed by its ×: the entry goes, and the next back switches the session', () => {
  const t = setup();
  t.open('conv-heron');
  const modal = t.overlay('summary-modal');
  modal.show();
  t.run();
  modal.hide();
  t.run();
  assert.equal(t.browser.index, 1);
  assert.equal(t.browser.history.state[SESSION_ENTRY], 'conv-heron');
  assert.equal(t.app.conv, 'conv-heron', 'our own pop opens nothing');
  // Forward onto the closed overlay's entry leads nowhere: it bounces back.
  t.forward();
  assert.equal(t.browser.index, 1);
  assert.equal(modal.open, false);
  t.back();
  assert.equal(t.app.conv, 'conv-otter');
});

test('nested overlays unwind one per back, top first', () => {
  const t = setup();
  t.open('conv-heron');
  const search = t.overlay('message-search-modal');
  const settings = t.overlay('settings-modal');
  search.show();
  t.run();
  settings.show();
  t.run();
  assert.equal(t.browser.entries.length, 4);
  t.back();
  assert.deepEqual([search.open, settings.open], [true, false]);
  t.back();
  assert.deepEqual([search.open, settings.open], [false, false]);
  assert.equal(t.app.conv, 'conv-heron');
  t.back();
  assert.equal(t.app.conv, 'conv-otter');
});

test('an overlay that hands over to another (︙ menu to Settings) gives it its entry', () => {
  const t = setup();
  const menu = t.overlay('chat-actions-menu');
  const settings = t.overlay('settings-modal');
  menu.show();
  t.run();
  assert.equal(t.browser.entries.length, 2);
  menu.hide();
  settings.show();
  t.run();
  assert.equal(t.browser.entries.length, 2, 'replaced, not stacked');
  t.back();
  assert.equal(settings.open, false);
  assert.equal(t.browser.index, 0);
});

test('closing an overlay below another one keeps the upper one\'s entry on top', () => {
  const t = setup();
  const repo = t.overlay('repo-browser-modal');
  const summary = t.overlay('summary-modal');
  repo.show();
  t.run();
  summary.show();
  t.run();
  repo.hide();
  t.run();
  assert.equal(t.browser.entries.length >= 2, true);
  assert.equal(t.browser.index, 1, 'one entry above the session, the open one\'s');
  t.back();
  assert.equal(summary.open, false);
  assert.equal(t.browser.index, 0);
});

test('a switch from an open overlay takes the overlay\'s entry: no pop, no stray entry', () => {
  const t = setup();
  const newChat = t.overlay('new-conversation-model-modal');
  newChat.show();
  t.run();
  newChat.hide();
  t.open('conv-badger');
  assert.equal(t.browser.entries.length, 2);
  assert.equal(t.browser.history.state[SESSION_ENTRY], 'conv-badger');
  t.back();
  assert.equal(t.app.conv, 'conv-otter');
});

test('a switch from two open overlays pops the upper one first, then takes the lower one\'s entry', () => {
  const t = setup();
  const summary = t.overlay('summary-modal');
  const settings = t.overlay('settings-modal');
  summary.show();
  t.run();
  settings.show();
  t.run();
  summary.hide();
  settings.hide();
  t.open('conv-lynx');
  assert.equal(t.browser.index, 1);
  assert.equal(t.browser.history.state[SESSION_ENTRY], 'conv-lynx');
  t.back();
  assert.equal(t.app.conv, 'conv-otter');
});

test('a viewer\'s entry on top: back closes the viewer, then the overlay, then switches', () => {
  const t = setup();
  t.open('conv-heron');
  let viewerClosed = 0;
  const viewer = createViewerHistory({ history: t.browser.history, onBack: () => { viewerClosed += 1; } });
  t.browser.onPopState(() => viewer.onPopState());
  const repo = t.overlay('repo-browser-modal');
  repo.show();
  t.run();
  viewer.opened();
  assert.equal(t.browser.history.state[VIEWER_HISTORY_MARK], true);
  t.back();
  assert.equal(viewerClosed, 1);
  assert.equal(repo.open, true, 'the overlay below the viewer stays');
  t.back();
  assert.equal(repo.open, false);
  assert.equal(t.app.conv, 'conv-heron');
  t.back();
  assert.equal(t.app.conv, 'conv-otter');
  assert.equal(viewerClosed, 1);
});

test('a dialog over the viewer closed by its ×: the viewer stays open', () => {
  const t = setup();
  let viewerClosed = 0;
  const viewer = createViewerHistory({ history: t.browser.history, onBack: () => { viewerClosed += 1; } });
  t.browser.onPopState(() => viewer.onPopState());
  viewer.opened();
  const summary = t.overlay('summary-modal');
  summary.show();
  t.run();
  summary.hide();
  t.run();
  assert.equal(viewerClosed, 0);
  assert.equal(t.browser.history.state[VIEWER_HISTORY_MARK], true);
  t.back();
  assert.equal(viewerClosed, 1);
  assert.equal(t.app.conv, 'conv-otter');
});

test('a viewer closed by hand leaves the session alone', () => {
  const t = setup();
  t.open('conv-heron');
  const viewer = createViewerHistory({ history: t.browser.history, onBack: () => {} });
  t.browser.onPopState(() => viewer.onPopState());
  viewer.opened();
  viewer.closed();
  t.run();
  assert.equal(t.app.conv, 'conv-heron');
  assert.deepEqual(t.app.opens, ['conv-otter', 'conv-heron']);
});

test('phone, installed app: back from the first session opens the list, then the floor holds once', () => {
  const t = setup({ guard: true, phone: true });
  assert.deepEqual(t.kinds(), ['floor', 'list', 'session']);
  assert.equal(t.browser.history.state[BACK_GUARD_APP], true, 'the session entries carry the app mark on');
  t.open('conv-heron');
  t.back();
  assert.equal(t.app.conv, 'conv-otter');
  assert.equal(t.sidebar.open, false);
  t.back();
  assert.equal(t.sidebar.open, true, 'back at the first session opens the session list');
  assert.equal(t.app.conv, 'conv-otter');
  assert.equal(t.browser.entries.length, 4, 'the sidebar opened for the list takes no entry of its own');

  t.back();
  assert.equal(t.app.floorHits, 1, 'then the guard: "press back again to close"');
  assert.equal(t.browser.left, 0);
  assert.equal(entryKind(t.browser.history.state), 'list', 'the list goes back up above the floor');
  assert.equal(t.sidebar.open, true);

  // Choosing a session from there pushes as normal.
  t.open('conv-lynx');
  assert.equal(t.sidebar.open, false);
  assert.deepEqual(t.kinds(), ['floor', 'list', 'session']);
  t.back();
  assert.equal(t.sidebar.open, true);
});

test('phone, browser tab: list beneath the first session, and the next back leaves', () => {
  const t = setup({ phone: true });
  assert.deepEqual(t.kinds(), ['list', 'session']);
  t.back();
  assert.equal(t.sidebar.open, true);
  t.back();
  assert.equal(t.browser.left, 1);
});

test('phone: the sidebar opened by hand is an overlay; a session picked from it takes its entry', () => {
  const t = setup({ phone: true });
  t.sidebar.show();
  t.run();
  assert.deepEqual(t.kinds(), ['list', 'session', 'overlay']);
  t.back();
  assert.equal(t.sidebar.open, false);
  assert.equal(t.app.conv, 'conv-otter');
  t.sidebar.show();
  t.run();
  t.open('conv-heron');
  assert.deepEqual(t.kinds(), ['list', 'session', 'session']);
  assert.equal(t.sidebar.open, false);
  t.back();
  assert.equal(t.app.conv, 'conv-otter');
  t.back();
  assert.equal(t.sidebar.open, true);
});

test('phone: the list closed by hand goes forward to the session it came from', () => {
  const t = setup({ phone: true });
  t.back();
  assert.equal(t.sidebar.open, true);
  t.sidebar.hide();
  t.run();
  assert.equal(entryKind(t.browser.history.state), 'session');
  assert.equal(t.sessionHistory.atList, false);
  t.back();
  assert.equal(t.sidebar.open, true, 'and back opens it again');
});

test('desktop, installed app: the floor lies under the first session and swallows one back', () => {
  const t = setup({ guard: true });
  assert.deepEqual(t.kinds(), ['floor', 'session']);
  t.open('conv-heron');
  t.back();
  t.back();
  assert.equal(t.app.floorHits, 1);
  assert.equal(t.browser.left, 0);
  assert.equal(t.browser.history.state[SESSION_ENTRY], 'conv-otter');
  assert.equal(t.browser.url, '/?conv=conv-otter');
  assert.equal(t.browser.history.state[BACK_GUARD_FLOOR], undefined);
});

test('a reload lays nothing again and writes nothing for the session already in the address', () => {
  const t = setup({ guard: true, phone: true });
  t.open('conv-heron');
  const before = structuredClone(t.browser.entries);
  // The page again, on the same history.
  const reloaded = createSessionHistory({ history: t.browser.history, location: t.browser.location, schedule: t.timers.schedule, cancel: t.timers.cancel });
  assert.equal(installBackGuard({ history: t.browser.history }) !== null, true);
  reloaded.shown('conv-heron', { mode: 'replace' });
  t.run();
  assert.equal(reloaded.layBase({ phone: true }), false);
  assert.deepEqual(t.browser.entries, before);
});

test('a reload on an overlay\'s entry: the session takes that entry over, nothing is pushed', () => {
  const t = setup();
  t.open('conv-heron');
  t.overlay('settings-modal').show();
  t.run();
  const length = t.browser.entries.length;
  const reloaded = createSessionHistory({ history: t.browser.history, location: t.browser.location, schedule: t.timers.schedule, cancel: t.timers.cancel });
  reloaded.shown('conv-heron', { mode: 'replace' });
  t.run();
  assert.equal(t.browser.entries.length, length);
  assert.equal(entryKind(t.browser.history.state), 'session');
  assert.equal(t.browser.history.state[SESSION_ENTRY], 'conv-heron');
});

test('a deleted session is stepped over, back and forward; never stuck', () => {
  const t = setup();
  t.open('conv-heron');
  t.open('conv-lynx');
  t.gone.add('conv-heron');
  t.back();
  assert.equal(t.app.conv, 'conv-otter', 'back skips the deleted one');
  t.forward();
  assert.equal(t.app.conv, 'conv-lynx', 'and so does forward');
  assert.equal(t.app.opens.includes('conv-heron'), true);
  assert.equal(t.app.opens.filter((id) => id === 'conv-heron').length, 1, 'never opened again');
});

test('the open session deleted: its entry empties; back steps over it, the next open replaces it', () => {
  const t = setup();
  t.open('conv-heron');
  t.gone.add('conv-heron');
  t.app.conv = null;
  t.sessionHistory.shown(null, { mode: 'replace' });
  t.run();
  assert.equal(t.browser.url, '/');
  assert.equal(t.browser.history.state[SESSION_ENTRY], null);
  assert.equal(t.app.title, 'Base');
  t.open('conv-lynx');
  assert.equal(t.browser.entries.length, 2, 'nothing to go back to: replaced');
  t.back();
  assert.equal(t.app.conv, 'conv-otter');
  t.forward();
  assert.equal(t.app.conv, 'conv-lynx');
});

test('a deleted session at the top, reached by forward, bounces back', () => {
  const t = setup();
  t.open('conv-heron');
  t.back();
  t.gone.add('conv-heron');
  t.forward();
  assert.equal(t.app.conv, 'conv-otter');
  assert.equal(t.browser.index, 0);
});

test('a pop of our own that never answers stops holding up history', () => {
  const t = setup();
  const summary = t.overlay('summary-modal');
  summary.show();
  t.run();
  const go = t.browser.history.go;
  t.browser.history.go = () => {}; // swallowed
  summary.hide();
  t.run();
  t.browser.history.go = go;
  t.open('conv-heron');
  assert.equal(t.browser.history.state[OVERLAY_ENTRY] !== undefined, true, 'held while the pop is awaited');
  t.timers.advance(OWN_POP_FALLBACK_MS);
  t.run();
  assert.equal(t.browser.history.state[SESSION_ENTRY], 'conv-heron');
  // Nothing is popped again on a guess; the entry left behind is stepped over.
  assert.equal(t.browser.entries.length, 3);
  t.back();
  assert.equal(t.app.conv, 'conv-otter');
  assert.equal(t.browser.index, 0);
});

test('the base is laid at the first touch or key, once', () => {
  const listeners = new Map();
  const target = {
    addEventListener(name, fn) { listeners.set(name, [...(listeners.get(name) || []), fn]); },
    removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter((f) => f !== fn)); },
    fire(name) { for (const fn of [...(listeners.get(name) || [])]) fn(); },
  };
  const calls = [];
  const armed = armVisitBaseOnFirstInteraction({ target, sessionHistory: { layBase: (options) => calls.push(options) }, isPhone: () => true });
  assert.equal(armed.armed, false);
  target.fire('touchstart');
  target.fire('keydown');
  assert.deepEqual(calls, [{ phone: true }]);
  assert.equal(armed.armed, true);
});

test('the overlay watch reports closings before openings', () => {
  const state = { menu: true, settings: false };
  const events = [];
  const watch = createOverlayWatch({
    overlays: [
      { name: 'settings', isOpen: () => state.settings },
      { name: 'menu', isOpen: () => state.menu },
    ],
    onOpened: (overlay) => events.push(`open ${overlay.name}`),
    onClosed: (name) => events.push(`close ${name}`),
  });
  state.menu = false;
  state.settings = true;
  watch.check();
  watch.check();
  assert.deepEqual(events, ['close menu', 'open settings']);
});

test('entry kinds and session addresses', () => {
  assert.equal(entryKind(null), 'none');
  assert.equal(entryKind({ [BACK_GUARD_FLOOR]: true, [SESSION_ENTRY]: 'conv-otter' }), 'floor');
  assert.equal(entryKind({ [LIST_ENTRY]: true }), 'list');
  assert.equal(entryKind({ [VIEWER_HISTORY_MARK]: true }), 'other');
  assert.equal(entryKind({ [SESSION_ENTRY]: null }), 'session');
  assert.equal(sessionUrl(`${ORIGIN}/oar/?push_conv=conv-otter&theme=dark#end`, 'conv-heron'), '/oar/?theme=dark&conv=conv-heron#end');
  assert.equal(sessionUrl(`${ORIGIN}/?conv=conv-otter`, null), '/');
});

// ─── A link not read yet ─────────────────────────────────────────────────────

test('a touch before anything is shown (the login, the load) keeps ?conv and push_conv in the address', () => {
  for (const { phone, guard } of [{ phone: false, guard: false }, { phone: true, guard: false }, { phone: false, guard: true }]) {
    for (const startUrl of ['/?conv=conv-heron', '/oar/?push_conv=conv-heron']) {
      const label = `${startUrl} phone=${phone} guard=${guard}`;
      const t = setup({ startUrl, initial: null, phone, guard, lay: true });
      assert.equal(t.browser.url, startUrl, `${label}: the base keeps the address`);
      const id = consumeConversationDeepLink({ location: t.browser.location, history: t.browser.history, title: 'OAR' });
      assert.equal(id, 'conv-heron', label);
      t.openConversation(id, 'replace');
      t.run();
      assert.equal(t.browser.url, startUrl.startsWith('/oar/') ? '/oar/?conv=conv-heron' : '/?conv=conv-heron', label);
      assert.equal(t.browser.history.state[SESSION_ENTRY], 'conv-heron', label);
      const expected = [...(guard ? ['floor'] : []), ...(phone ? ['list'] : []), 'session'];
      assert.deepEqual(t.kinds(), expected, `${label}: nothing extra`);
    }
  }
});

test('the floor answered before anything is shown keeps the address too', () => {
  const t = setup({ startUrl: '/?conv=conv-heron', initial: null, guard: true });
  t.back();
  assert.equal(t.app.floorHits, 1);
  assert.equal(t.browser.url, '/?conv=conv-heron');
});

// ─── A session the relay does not know ──────────────────────────────────────

test('back onto a session the relay does not know steps on past it, both ways', () => {
  const t = setup({ lay: true });
  t.open('conv-heron');
  t.open('conv-lynx');
  // Deleted on another device: back opens it, and the relay answers 404.
  t.back();
  assert.equal(t.app.conv, 'conv-heron');
  t.gone.add('conv-heron');
  assert.equal(t.sessionHistory.missing('conv-heron'), true);
  t.run();
  assert.equal(t.app.conv, 'conv-otter', 'back goes on to the one before');
  t.forward();
  assert.equal(t.app.conv, 'conv-lynx', 'forward steps over it as well');
  assert.equal(t.app.opens.filter((id) => id === 'conv-heron').length, 2, 'opened once by the pop, never after');
});

test('forward onto an unknown session at the top bounces back', () => {
  const t = setup({ lay: true });
  t.open('conv-heron');
  t.back();
  t.forward();
  assert.equal(t.sessionHistory.missing('conv-heron'), true);
  t.run();
  assert.equal(t.app.conv, 'conv-otter');
  assert.equal(t.browser.index, 0);
});

test('an unknown session not reached by a pop is the caller\'s to clear: the address drops it', () => {
  const t = setup({ startUrl: '/?conv=conv-ghost', initial: null });
  const id = consumeConversationDeepLink({ location: t.browser.location, history: t.browser.history, title: 'OAR' });
  t.openConversation(id, 'replace');
  t.run();
  assert.equal(t.sessionHistory.missing('conv-ghost'), false, 'a load is not a pop');
  t.app.conv = null;
  t.sessionHistory.shown(null, { mode: 'replace' });
  t.run();
  assert.equal(t.browser.url, '/');
  assert.equal(t.browser.entries.length, 1);
  assert.equal(t.app.title, 'Base');
});

test('back onto an unknown session at the visit\'s base does not step out of the app', () => {
  const t = setup({ lay: true });
  t.open('conv-heron');
  t.back();
  assert.equal(t.app.conv, 'conv-otter');
  assert.equal(t.sessionHistory.missing('conv-otter'), false, 'nothing of ours lies below');
  t.run();
  assert.equal(t.browser.left, 0);
});

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

test('the gone list outlives a reload of the tab, and stays bounded', () => {
  const storage = memoryStorage();
  const first = createGoneList({ storage });
  first.add('conv-heron');
  first.add(' conv-lynx ');
  first.add('');
  const again = createGoneList({ storage });
  assert.equal(again.has('conv-heron'), true);
  assert.equal(again.has('conv-lynx'), true);
  assert.equal(again.has('conv-otter'), false);
  assert.deepEqual(JSON.parse(storage.values.get(GONE_STORAGE_KEY)), ['conv-heron', 'conv-lynx']);

  const small = createGoneList({ storage: memoryStorage(), limit: 2 });
  for (const id of ['conv-otter', 'conv-heron', 'conv-lynx']) small.add(id);
  assert.equal(small.has('conv-otter'), false, 'the oldest goes first');
  assert.equal(small.has('conv-lynx'), true);

  // Storage that is broken or refuses: in memory only, nothing thrown.
  const broken = createGoneList({ storage: { getItem: () => '{not json', setItem: () => { throw new Error('quota'); } } });
  broken.add('conv-badger');
  assert.equal(broken.has('conv-badger'), true);
  assert.equal(createGoneList().has('conv-badger'), false);
});

test('after a reload, back steps over a session found gone before it', () => {
  const browser = fakeBrowser('/');
  const timers = fakeTimers();
  const run = () => {
    for (let round = 0; round < 50; round += 1) {
      const ran = timers.runDue();
      const moved = browser.flush();
      if (!ran && !moved) return;
    }
  };
  const before = createSessionHistory({ history: browser.history, location: browser.location, schedule: timers.schedule, cancel: timers.cancel });
  before.shown('conv-otter', { mode: 'replace' });
  run();
  before.layBase();
  for (const id of ['conv-heron', 'conv-lynx']) {
    before.shown(id);
    run();
  }
  const storage = memoryStorage();
  createGoneList({ storage }).add('conv-heron');

  // The page again, on the same history and the same tab's storage.
  const gone = createGoneList({ storage });
  const opened = [];
  const reloaded = createSessionHistory({
    history: browser.history,
    location: browser.location,
    isGone: gone.has,
    open: (id) => { opened.push(id); reloaded.shown(id, { mode: 'none' }); },
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  browser.onPopState(() => reloaded.onPopState());
  reloaded.shown('conv-lynx', { mode: 'replace' });
  run();
  browser.history.back();
  run();
  assert.deepEqual(opened, ['conv-otter']);
  assert.equal(browser.index, 0);
});

// ─── Forward history and overlays ───────────────────────────────────────────

test('an overlay opened with sessions ahead takes no entry: Esc, then forward still leads on', () => {
  const t = setup({ lay: true });
  t.open('conv-heron');
  t.open('conv-lynx');
  t.back();
  assert.equal(t.app.conv, 'conv-heron');
  const menu = t.overlay('chat-actions-menu');
  menu.show();
  t.run();
  assert.equal(t.browser.entries.length, 3, 'nothing pushed over what lies ahead');
  assert.deepEqual(t.sessionHistory.openOverlays, ['chat-actions-menu']);
  menu.hide();
  t.run();
  t.forward();
  assert.equal(t.app.conv, 'conv-lynx');
});

test('back with such an overlay open closes it, stays, and keeps forward', () => {
  const t = setup({ lay: true });
  t.open('conv-heron');
  t.open('conv-lynx');
  t.back();
  const menu = t.overlay('chat-actions-menu');
  const settings = t.overlay('settings-modal');
  menu.show();
  t.run();
  // ︙ hands over to Settings.
  menu.hide();
  settings.show();
  t.run();
  t.back();
  assert.equal(settings.open, false);
  assert.equal(t.app.conv, 'conv-heron', 'the session underneath stays');
  assert.equal(t.browser.index, 1);
  assert.deepEqual(t.app.opens, ['conv-otter', 'conv-heron', 'conv-lynx', 'conv-heron'], 'the one below was never opened');
  t.forward();
  assert.equal(t.app.conv, 'conv-lynx');
  t.back();
  t.back();
  assert.equal(t.app.conv, 'conv-otter', 'and back walks on as before');
});

test('phone: the sidebar opened with sessions ahead closes on back; forward still leads on', () => {
  const t = setup({ phone: true });
  t.open('conv-heron');
  t.back();
  t.sidebar.show();
  t.run();
  assert.deepEqual(t.kinds(), ['list', 'session', 'session']);
  t.back();
  assert.equal(t.sidebar.open, false);
  assert.equal(t.app.conv, 'conv-otter');
  assert.equal(t.sessionHistory.atList, false);
  t.forward();
  assert.equal(t.app.conv, 'conv-heron');
});

test('at the visit\'s base an overlay still takes its entry: back must not leave the app', () => {
  const t = setup({ lay: true });
  t.open('conv-heron');
  t.back();
  const menu = t.overlay('chat-actions-menu');
  menu.show();
  t.run();
  assert.deepEqual(t.kinds(), ['session', 'overlay']);
  t.back();
  assert.equal(menu.open, false);
  assert.equal(t.app.conv, 'conv-otter');
  assert.equal(t.browser.left, 0);
});

test('a session switch from such an overlay drops what lay ahead, as any switch does', () => {
  const t = setup({ lay: true });
  t.open('conv-heron');
  t.open('conv-lynx');
  t.back();
  const menu = t.overlay('chat-actions-menu');
  menu.show();
  t.run();
  menu.hide();
  t.open('conv-badger');
  assert.equal(t.browser.entries.length, 3);
  assert.equal(t.browser.history.state[SESSION_ENTRY], 'conv-badger');
  t.back();
  assert.equal(t.app.conv, 'conv-heron');
});

test('an overlay that refuses to close on back (a discard question answered no) takes an entry again', () => {
  const t = setup();
  t.open('conv-heron');
  const annotate = t.overlay('image-annotate-modal');
  annotate.close = () => {}; // stays open
  annotate.show();
  t.run();
  t.back();
  assert.equal(annotate.open, true);
  assert.equal(entryKind(t.browser.history.state), 'overlay', 'back again closes it, not the session');
  assert.equal(t.app.conv, 'conv-heron');
});

// ─── The Inbox ──────────────────────────────────────────────────────────────

test('the Inbox is an overlay: back leaves it for the session; a jump from it takes its entry', () => {
  const t = setup();
  t.open('conv-heron');
  const inbox = t.overlay('inbox');
  inbox.show();
  t.run();
  assert.equal(t.browser.entries.length, 3);
  t.back();
  assert.equal(inbox.open, false);
  assert.equal(t.app.conv, 'conv-heron');
  // Opened again, and a card's session opened from it.
  inbox.show();
  t.run();
  inbox.hide();
  t.open('conv-lynx');
  assert.equal(t.browser.entries.length, 3, 'the jump takes the Inbox\'s entry');
  t.back();
  assert.equal(t.app.conv, 'conv-heron');
});

test('the jump to a waiting question replaces: repeated jumps add no entry', () => {
  const t = setup({ initial: null });
  for (const id of ['conv-heron', 'conv-lynx', 'conv-badger']) {
    t.openConversation(id, 'replace');
    t.run();
  }
  assert.equal(t.browser.entries.length, 1);
  assert.equal(t.browser.history.state[SESSION_ENTRY], 'conv-badger');
});
