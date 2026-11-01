import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  HEADER_PRIORITY_ACTIONS,
  HEADER_PRIORITY_ACTION_KEYS,
  HEADER_PRIORITY_MENU_IDS,
  HEADER_BANNER_MAX_SHARE,
  HEADER_BANNER_OWN_ROW_QUERY,
  fitHeaderPriorityActions,
  headerPriorityMenuIdsFor,
  headerReservedWidth,
  notifyHeaderActionsChanged,
  resolveHeaderActionAvailability,
  resolveQuestionBannerMode,
} from './header-priority-actions.mjs';
import { CHAT_ACTIONS_MENU_ENTRY_IDS, CHAT_ACTIONS_MENU_TWIN_IDS } from './chat-actions-menu-state.mjs';

const ALL = Object.fromEntries(HEADER_PRIORITY_ACTION_KEYS.map((key) => [key, true]));
const WIDTHS = Object.fromEntries(HEADER_PRIORITY_ACTION_KEYS.map((key) => [key, 30]));

test('the priority order is pins, hidden, search, context, usage, theme, fullscreen', () => {
  assert.deepEqual(HEADER_PRIORITY_ACTION_KEYS, ['pins', 'hidden', 'search', 'context', 'usage', 'theme', 'fullscreen']);
  assert.deepEqual(HEADER_PRIORITY_ACTIONS.map((action) => action.inlineId), [
    'pinned-messages-btn', 'hidden-messages-btn', 'message-search-btn', 'context-btn', 'usage-btn', 'theme-toggle-btn', 'fullscreen-btn',
  ]);
});

test('the twins are the ︙ menu resolver\'s twins, and entries it decides', () => {
  assert.deepEqual([...HEADER_PRIORITY_MENU_IDS].sort(), [...CHAT_ACTIONS_MENU_TWIN_IDS].sort());
  for (const id of HEADER_PRIORITY_MENU_IDS) assert.ok(CHAT_ACTIONS_MENU_ENTRY_IDS.includes(id), id);
});

test('everything fits: every available action sits inline', () => {
  const fit = fitHeaderPriorityActions({ widths: WIDTHS, gap: 6, available: 1000, availability: ALL });
  assert.deepEqual(fit, { inline: HEADER_PRIORITY_ACTION_KEYS, menu: [], unavailable: [], used: 7 * 36 });
});

test('the lowest priorities overflow first, and nothing after an overflow comes back', () => {
  // Three buttons of 30 + 6 fit in 108; the fourth does not.
  const fit = fitHeaderPriorityActions({ widths: WIDTHS, gap: 6, available: 108, availability: ALL });
  assert.deepEqual(fit.inline, ['pins', 'hidden', 'search']);
  assert.deepEqual(fit.menu, ['context', 'usage', 'theme', 'fullscreen']);
  // A narrow later action that would fit still goes to the menu after the first overflow.
  const widths = { ...WIDTHS, context: 80, usage: 1 };
  const strict = fitHeaderPriorityActions({ widths, gap: 0, available: 100, availability: ALL });
  assert.deepEqual(strict.inline, ['pins', 'hidden', 'search']);
  assert.deepEqual(strict.menu, ['context', 'usage', 'theme', 'fullscreen']);
});

test('an action that exactly fills the room still fits', () => {
  const fit = fitHeaderPriorityActions({ widths: WIDTHS, gap: 0, available: 60, availability: ALL });
  assert.deepEqual(fit.inline, ['pins', 'hidden']);
});

test('no room: every available action goes into the menu', () => {
  for (const available of [0, -40]) {
    const fit = fitHeaderPriorityActions({ widths: WIDTHS, gap: 4, available, availability: ALL });
    assert.deepEqual(fit.inline, []);
    assert.deepEqual(fit.menu, HEADER_PRIORITY_ACTION_KEYS);
  }
});

test('an unmeasurable header puts every available action into the menu', () => {
  for (const available of [undefined, NaN, Infinity, 'wide']) {
    const fit = fitHeaderPriorityActions({ widths: WIDTHS, available, availability: { search: true, theme: true } });
    assert.deepEqual(fit.inline, [], String(available));
    assert.deepEqual(fit.menu, ['search', 'theme'], String(available));
  }
});

test('an unavailable action takes no room and never shows in the menu', () => {
  const availability = { ...ALL, pins: false, hidden: false, fullscreen: false };
  const fit = fitHeaderPriorityActions({ widths: WIDTHS, gap: 0, available: 90, availability });
  assert.deepEqual(fit.inline, ['search', 'context', 'usage']);
  assert.deepEqual(fit.menu, ['theme']);
  assert.deepEqual(fit.unavailable, ['pins', 'hidden', 'fullscreen']);
});

test('a wider pins button (with its count) is measured as it is', () => {
  const fit = fitHeaderPriorityActions({ widths: { ...WIDTHS, pins: 52 }, gap: 4, available: 100, availability: ALL });
  // 56 + 34 = 90 fits; + 34 = 124 does not.
  assert.deepEqual(fit.inline, ['pins', 'hidden']);
});

test('a missing or bad width counts as zero', () => {
  const fit = fitHeaderPriorityActions({ widths: { pins: 'x', hidden: -3 }, gap: 0, available: 0, availability: { pins: true, hidden: true } });
  assert.deepEqual(fit.inline, ['pins', 'hidden']);
});

test('availability: counts decide pins and hidden, pwa-install decides fullscreen', () => {
  assert.deepEqual(resolveHeaderActionAvailability({}), {
    pins: false, hidden: false, search: true, context: true, usage: true, theme: true, fullscreen: false,
  });
  const busy = resolveHeaderActionAvailability({ pinCount: 3, hiddenCount: 1, fullscreenAvailable: true });
  assert.equal(busy.pins, true);
  assert.equal(busy.hidden, true);
  assert.equal(busy.fullscreen, true);
  assert.equal(resolveHeaderActionAvailability({ pinCount: '0' }).pins, false);
});

test('availability: the shared view offers Day/Night only', () => {
  const shared = resolveHeaderActionAvailability({ sharedMode: true, pinCount: 4, hiddenCount: 2, fullscreenAvailable: true });
  assert.deepEqual(Object.keys(shared).filter((key) => shared[key]), ['theme']);
});

test('menu ids follow the priority order, whatever order the keys come in', () => {
  assert.deepEqual(headerPriorityMenuIdsFor(['theme', 'pins']), ['chat-menu-pins', 'chat-menu-theme-toggle']);
  assert.deepEqual(headerPriorityMenuIdsFor([]), []);
  assert.deepEqual(headerPriorityMenuIdsFor(null), []);
  assert.deepEqual(headerPriorityMenuIdsFor(['nope']), []);
});

test('reserved width: padding, ☰, the title minimum, ︙, the banner and the gaps between them', () => {
  const header = { padding: 16, titleMin: 98, toggle: 28, menu: 28, gap: 6 };
  // Title, actions and ☰: two gaps.
  assert.equal(headerReservedWidth(header), 16 + 98 + 28 + 28 + 2 * 6);
  // The banner on the first row (a wide screen): its width and one more gap.
  assert.equal(headerReservedWidth({ ...header, banner: 240 }), 16 + 98 + 28 + 28 + 240 + 3 * 6);
  // No ☰ (the shared view), no gap for it.
  assert.equal(headerReservedWidth({ ...header, toggle: 0 }), 16 + 98 + 28 + 6);
});

test('reserved width: on a phone the banner has its own row and reserves nothing', () => {
  const header = { padding: 16, titleMin: 98, toggle: 28, menu: 28, gap: 6 };
  const phone = headerReservedWidth({ ...header, banner: 330, bannerOwnRow: true });
  assert.equal(phone, headerReservedWidth(header));
  // The 360px phone with a pin and a question: the actions keep the row's
  // room, so the fit does not empty the header into ︙ for a banner that is
  // not on that row.
  const widths = { pins: 40, search: 28, context: 28, usage: 28, theme: 28, fullscreen: 28 };
  const availability = { ...ALL, hidden: false };
  const withBanner = fitHeaderPriorityActions({ widths, gap: 4, available: 360 - phone, availability });
  const without = fitHeaderPriorityActions({ widths, gap: 4, available: 360 - headerReservedWidth(header), availability });
  assert.deepEqual(withBanner, without);
  assert.ok(withBanner.inline.length > 0);
  // Had it been reserved, nothing would have fit.
  const reserved = fitHeaderPriorityActions({ widths, gap: 4, available: 360 - headerReservedWidth({ ...header, banner: 330 }), availability });
  assert.deepEqual(reserved.inline, []);
  // The query is the phone header's breakpoint.
  assert.equal(HEADER_BANNER_OWN_ROW_QUERY, '(max-width: 680px)');
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /@media \(max-width: 680px\) \{/);
});

test('used: the width the inline actions take, their gaps included', () => {
  // Three of 30 + 6 fit in 108; the overflowed ones spend nothing.
  assert.equal(fitHeaderPriorityActions({ widths: WIDTHS, gap: 6, available: 108, availability: ALL }).used, 108);
  assert.equal(fitHeaderPriorityActions({ widths: WIDTHS, gap: 6, available: 20, availability: ALL }).used, 0);
  assert.equal(fitHeaderPriorityActions({ widths: WIDTHS, gap: 6, available: NaN, availability: ALL }).used, 0);
});

test('a long question banner never pushes the actions: only its chip is reserved', () => {
  // A 900px header on a phone on its side: ☰, ︙, the title's 8rem, four
  // actions, and a banner whose whole text is 520px but whose chip is 44px.
  const header = { padding: 12, titleMin: 128, toggle: 28, menu: 28, gap: 6 };
  const widths = { search: 28, context: 28, usage: 28, theme: 28 };
  const availability = { search: true, context: true, usage: true, theme: true };
  const withChip = fitHeaderPriorityActions({ widths, gap: 4, available: 900 - headerReservedWidth({ ...header, banner: 44 }), availability });
  assert.deepEqual(withChip.inline, ['search', 'context', 'usage', 'theme']);
  // At 300px the chip still takes its place, and the actions give way to it.
  const narrow = fitHeaderPriorityActions({ widths, gap: 4, available: 300 - headerReservedWidth({ ...header, banner: 44 }), availability });
  assert.ok(narrow.menu.length > 0);
  assert.ok(narrow.used <= 300 - headerReservedWidth({ ...header, banner: 44 }));
});

test('banner mode: hidden, its own row, the chip on a phone on its side', () => {
  assert.equal(resolveQuestionBannerMode({ visible: false, room: 900, fullMin: 100 }), 'hidden');
  assert.equal(resolveQuestionBannerMode({ visible: true, ownRow: true, room: 0, fullMin: 100 }), 'row');
  // Own row wins over a phone on its side narrower than 680px.
  assert.equal(resolveQuestionBannerMode({ visible: true, ownRow: true, phoneLandscape: true, room: 0 }), 'row');
  // On its side the chip, however much room is left.
  assert.equal(resolveQuestionBannerMode({ visible: true, phoneLandscape: true, room: 900, contentWidth: 900, fullMin: 100 }), 'compact');
});

test('banner mode: the whole text while "❓ N open questions" fits, else the chip', () => {
  const base = { visible: true, contentWidth: 1000, fullMin: 140 };
  assert.equal(resolveQuestionBannerMode({ ...base, room: 400 }), 'full');
  assert.equal(resolveQuestionBannerMode({ ...base, room: 140 }), 'full');
  assert.equal(resolveQuestionBannerMode({ ...base, room: 139 }), 'compact');
  // The 40 % cap counts: a 300px header leaves it 120px at most.
  assert.equal(HEADER_BANNER_MAX_SHARE, 0.4);
  assert.equal(resolveQuestionBannerMode({ ...base, contentWidth: 300, room: 260 }), 'compact');
  // Unmeasured: the chip (what the fit reserved).
  assert.equal(resolveQuestionBannerMode({ ...base, room: NaN }), 'compact');
  assert.equal(resolveQuestionBannerMode({ visible: true, room: 50 }), 'full');
});

test('banner mode: its own row where not even the chip fits on the first row', () => {
  const base = { visible: true, contentWidth: 300, fullMin: 140, compact: 56 };
  // ☰, the title's minimum and ︙ leave the chip 55px of its 56: a row of its own.
  assert.equal(resolveQuestionBannerMode({ ...base, room: 55 }), 'row');
  assert.equal(resolveQuestionBannerMode({ ...base, room: -40 }), 'row');
  // Exactly its width: the chip stays on the first row.
  assert.equal(resolveQuestionBannerMode({ ...base, room: 56 }), 'compact');
  // A phone on its side keeps the chip; an unmeasured room is the chip.
  assert.equal(resolveQuestionBannerMode({ ...base, phoneLandscape: true, room: 10 }), 'compact');
  assert.equal(resolveQuestionBannerMode({ ...base, room: NaN }), 'compact');
  // And the CSS that puts it there on a wide screen.
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /#pending-question-banner\[data-own-row\] \{[^}]*order: 2;[^}]*max-width: 100%;/);
  assert.match(html, /#chat-header:has\(> #pending-question-banner\[data-own-row\]\) \{ flex-wrap: wrap;/);
});

test('the markup puts the banner between the title and the actions; the CSS caps it at 40 %', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const title = html.indexOf('<div id="chat-title-wrap">');
  const banner = html.indexOf('<button id="pending-question-banner"');
  const actions = html.indexOf('<div id="chat-header-actions">');
  assert.ok(title > 0 && banner > title && actions > banner, 'title, banner, actions');
  const rule = html.match(/\n {2}#pending-question-banner \{([^}]*)\}/);
  assert.ok(rule, 'the banner rule');
  assert.match(rule[1], /max-width: 40%;/);
  assert.match(html, /#pending-question-banner\[data-compact\] \.pending-question-full \{ display: none; \}/);
});

test('reserved width: junk counts as 0', () => {
  assert.equal(headerReservedWidth({ padding: Number.NaN, titleMin: -5, toggle: 'x', banner: undefined, menu: null, gap: Infinity }), 0);
  assert.equal(headerReservedWidth(), 0);
});

test('the change notice is a no-op outside a browser', () => {
  assert.doesNotThrow(() => notifyHeaderActionsChanged());
});

test('the markup has every header button, every twin, and the vertical ︙', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const action of HEADER_PRIORITY_ACTIONS) {
    assert.match(html, new RegExp(`<button id="${action.inlineId}" class="header-icon-btn`), action.inlineId);
    assert.match(html, new RegExp(`<button id="${action.menuId}" class="chat-actions-menu-item`), action.menuId);
  }
  assert.match(html, /<button id="chat-actions-menu-btn"[^>]*>︙<\/button>/);
  // Inside #chat-header-actions, in priority order, before the ︙ menu.
  const start = html.indexOf('<div id="chat-header-actions">');
  const menu = html.indexOf('<div id="chat-actions-menu-wrap">', start);
  const positions = HEADER_PRIORITY_ACTIONS.map((action) => html.indexOf(`<button id="${action.inlineId}"`, start));
  for (const position of positions) assert.ok(position > start && position < menu);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});
