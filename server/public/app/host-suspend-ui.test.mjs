import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Renders against the real index.html so the banner/menu ids stay honest.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const ui = await import('./host-suspend-ui.js');

test.beforeEach(() => ui.__resetHostSuspendUiForTests());

test('formatCountdown renders m:ss and clamps at zero', () => {
  const now = Date.parse('2026-09-27T00:00:00Z');
  assert.equal(ui.formatCountdown('2026-09-27T00:00:27Z', now), '0:27');
  assert.equal(ui.formatCountdown('2026-09-27T00:02:00Z', now), '2:00');
  assert.equal(ui.formatCountdown('2026-09-26T23:59:00Z', now), '0:00');
  assert.equal(ui.formatCountdown(null, now), null);
});

test('describeHostSuspendBlocker reads as a session line', () => {
  assert.equal(ui.describeHostSuspendBlocker({ kind: 'turn', title: 'sidebar polish', detail: 'turn running' }), 'sidebar polish — turn running');
  assert.equal(ui.describeHostSuspendBlocker({ kind: 'background', title: 'report builder', detail: '1 background agent: export' }), 'report builder — 1 background agent: export');
  assert.match(ui.describeHostSuspendBlocker({ kind: 'ci', title: 'example-org/demo', detail: 'CI on main (in_progress)' }), /^CI in example-org\/demo — CI on main/);
  assert.equal(ui.describeHostSuspendBlocker({ kind: 'ci-checking', detail: 'Checking CI state of 1 workspace' }), 'Checking CI state of 1 workspace');
});

test('banner text: queued lists the first two blockers, countdown shows the clock', () => {
  const queued = { status: 'queued', blockers: [
    { kind: 'turn', title: 'a', detail: 'turn running' },
    { kind: 'turn', title: 'b', detail: 'turn running' },
    { kind: 'turn', title: 'c', detail: 'turn running' },
  ] };
  assert.equal(ui.hostSuspendBannerText(queued), '💤 Suspend queued — waiting for: a — turn running; b — turn running; +1 more');
  const now = Date.parse('2026-09-27T00:00:00Z');
  assert.equal(ui.hostSuspendBannerText({ status: 'countdown', fireAt: '2026-09-27T00:00:30Z' }, now), '💤 Everything is idle — suspending host in 0:30');
  assert.equal(ui.hostSuspendBannerText({ status: 'idle' }), '');
});

test('relay shutdown banner text counts the turns it waits for', () => {
  assert.equal(
    ui.relayShutdownBannerText({ status: 'queued', action: 'restart', queue: { pendingCount: 1, processingCount: 2, parkedCount: 0 } }),
    '🌄 Relay restart queued — waiting for 3 turns to finish',
  );
  assert.equal(ui.relayShutdownBannerText({ status: 'shutting_down', action: 'restart' }), '🌄 Relay restarting now…');
  assert.equal(ui.relayShutdownBannerText({ status: 'idle' }), '');
});

test('applyHostSuspendState shows the banner with a Cancel button and flips the menu label', () => {
  ui.applyHostSuspendState({ status: 'queued', blockers: [{ kind: 'turn', title: 'report builder', detail: 'turn running' }] });
  const banner = document.getElementById('pending-action-banner');
  assert.ok(banner.classList.contains('visible'));
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /Suspend queued — waiting for: report builder — turn running/);
  assert.ok(banner.querySelector('.pending-action-cancel'));
  assert.equal(document.getElementById('chat-menu-suspend-host').textContent, '💤 Suspend pending…');

  ui.applyHostSuspendState({ status: 'idle', blockers: [] });
  assert.equal(banner.classList.contains('visible'), false);
  assert.equal(banner.hidden, true);
  assert.equal(document.getElementById('chat-menu-suspend-host').textContent, '💤 Suspend host');
});

test('a queued relay restart gets its own row and menu label; both rows coexist', () => {
  ui.applyHostSuspendState({ status: 'countdown', fireAt: new Date(Date.now() + 25_000).toISOString(), blockers: [] });
  ui.applyRelayShutdownState({ status: 'queued', action: 'restart', queue: { pendingCount: 0, processingCount: 1, parkedCount: 0 } });
  const rows = document.querySelectorAll('#pending-action-banner .pending-action-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.pending, 'host-suspend');
  assert.equal(rows[1].dataset.pending, 'relay-shutdown');
  assert.equal(document.getElementById('chat-menu-restart-relay').textContent, '🌄 Restart pending…');
  ui.applyRelayShutdownState({ status: 'idle' });
  assert.equal(document.getElementById('chat-menu-restart-relay').textContent, '🌄 Restart web relay');
});

test('applyPendingActionsFromStatus reads both states off a /api/status payload', () => {
  ui.applyPendingActionsFromStatus({
    pendingCount: 0, processingCount: 2, parkedCount: 0,
    hostSuspend: { status: 'queued', blockers: [] },
    relayShutdown: { status: 'queued', action: 'restart' },
  });
  assert.equal(ui.isHostSuspendPending(), true);
  assert.equal(ui.isRelayShutdownPending(), true);
  assert.equal(ui.getRelayShutdownState().queue.processingCount, 2);
});
