import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Renders against the real index.html, like host-suspend-ui.test.mjs.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const ui = await import('./relay-restart-ui.js');

test.beforeEach(() => ui.__resetRelayRestartUiForTests());

const NOW = Date.parse('2026-10-19T08:12:00Z');
const QUEUED = {
  status: 'queued',
  action: 'restart',
  restart: true,
  requestedAt: '2026-10-19T08:00:00Z',
  waitingSince: '2026-10-19T08:00:00Z',
  maxWaitMs: 30 * 60_000,
  holdsNewTurns: true,
  question: null,
  queue: { pendingCount: 2, processingCount: 3, parkedCount: 0 },
  waitingFor: [
    { conversationId: 'c1', title: 'sidebar polish', turns: 1 },
    { conversationId: 'c2', title: 'report builder', turns: 2 },
  ],
  held: { count: 2, conversations: [{ conversationId: 'c3', title: 'notes', count: 2 }] },
  backgroundTasks: [
    { conversationId: 'c4', title: 'nightly export', count: 1, detail: '1 background agent: export', survives: true },
  ],
  survival: { action: 'restart', workersSurvive: true, summary: 'Session workers are separate processes and keep running through a relay restart.' },
};

test('formatWaited and the waited line', () => {
  assert.equal(ui.formatWaited(20_000), 'less than a minute');
  assert.equal(ui.formatWaited(12 * 60_000), '12 min');
  assert.equal(ui.formatWaited(65 * 60_000), '1 h 5 min');
  assert.equal(ui.formatWaited(120 * 60_000), '2 h');
  assert.equal(ui.formatMaxWait(0), 'no limit');
  assert.equal(ui.relayRestartWaitedText(QUEUED, NOW), 'waited 12 min of 30 min');
  assert.equal(ui.relayRestartWaitedText({ ...QUEUED, maxWaitMs: 0 }, NOW), 'waited 12 min, no time limit');
  assert.equal(ui.relayRestartWaitedText({ status: 'idle' }, NOW), '');
});

test('the row links the sessions it waits for, says new messages are held and lists background tasks', () => {
  const opened = [];
  const row = ui.renderRelayRestartRow(QUEUED, { nowMs: NOW, handlers: { onOpen: (id) => opened.push(id) } });
  assert.equal(row.dataset.pending, 'relay-shutdown');
  assert.equal(row.querySelector('.pending-action-text').textContent, '🌄 Relay restart queued — waiting for 2 sessions');
  assert.equal(row.querySelector('.relay-restart-waited').textContent, '· waited 12 min of 30 min');
  const links = [...row.querySelectorAll('.relay-restart-waiting-for .relay-restart-session-link')];
  assert.deepEqual(links.map((link) => link.textContent), ['sidebar polish', 'report builder']);
  assert.match(row.querySelector('.relay-restart-waiting-for').textContent, /report builder \(2 turns\)/);
  links[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(opened, ['c2']);
  assert.equal(row.querySelector('.relay-restart-held').textContent, 'New messages are held until the restart: 2 messages waiting.');
  assert.match(row.querySelector('.relay-restart-background').textContent, /nightly export — 1 background agent: export \(keeps running\)/);
  const buttons = [...row.querySelectorAll('button')].map((btn) => btn.textContent);
  assert.deepEqual(buttons, ['Restart now', 'Cancel restart']);
});

test('the question: Restart now, Keep waiting (another period) and Cancel', () => {
  const calls = [];
  const asking = { ...QUEUED, question: { askedAt: '2026-10-19T08:30:00Z' } };
  const row = ui.renderRelayRestartRow(asking, {
    nowMs: NOW,
    handlers: {
      onRestartNow: () => calls.push('now'),
      onKeepWaiting: () => calls.push('keep'),
      onCancel: () => calls.push('cancel'),
    },
  });
  assert.equal(row.dataset.asking, '1');
  assert.match(row.querySelector('.pending-action-text').textContent, /has waited 30 min for 2 sessions — restart now, keep waiting or cancel\?/);
  const buttons = [...row.querySelectorAll('button')];
  assert.deepEqual(buttons.map((btn) => btn.textContent), ['Restart now', 'Keep waiting (30 min)', 'Cancel restart']);
  for (const btn of buttons) btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(calls, ['now', 'keep', 'cancel']);
});

test('a restarting row has no buttons', () => {
  const row = ui.renderRelayRestartRow({ status: 'shutting_down', action: 'restart' }, { nowMs: NOW });
  assert.equal(row.querySelectorAll('button').length, 0);
  assert.equal(row.textContent, '🌄 Relay restarting now…');
});

test('waited labels update in place', () => {
  const root = document.createElement('div');
  root.appendChild(ui.renderRelayRestartRow(QUEUED, { nowMs: NOW }));
  ui.refreshRelayRestartWaitedLabels(QUEUED, NOW + 5 * 60_000, root);
  assert.equal(root.querySelector('.relay-restart-waited').textContent, '· waited 17 min of 30 min');
});

test('the confirmation: running turns get "when idle" and "now", background tasks say whether they survive', () => {
  const html = ui.renderRestartConfirmBody(QUEUED, { maxWaitMs: 30 * 60_000 });
  assert.match(html, /waits until these running turns end/);
  assert.match(html, /<strong>sidebar polish<\/strong>/);
  assert.match(html, /<strong>report builder<\/strong> \(2 turns\)/);
  assert.match(html, /new messages are held \(2 messages already waiting\)/);
  assert.match(html, /After 30 min the banner asks/);
  assert.match(html, /These background tasks keep running:/);
  assert.match(html, /nightly export<\/strong> — 1 background agent: export/);
  assert.match(html, /onclick="confirmRestartWebRelay\(\)">🌄 Restart when idle</);
  assert.match(html, /onclick="confirmRestartRelayNow\(\)">Restart now</);

  const idle = ui.renderRestartConfirmBody({ waitingFor: [], held: { count: 0 }, backgroundTasks: [] });
  assert.match(idle, /Nothing is running: the relay restarts at once/);
  assert.match(idle, /🌄 Restart web relay</);
  assert.doesNotMatch(idle, /confirmRestartRelayNow/);
});

test('restart now names the sessions it does not wait for; tasks that stop are listed first', () => {
  const html = ui.renderRestartNowBody(QUEUED);
  assert.match(html, /Restart now without waiting for 2 sessions/);
  assert.match(html, /workers keep running and report back/);
  const stopping = ui.renderRestartNowBody({
    ...QUEUED,
    survival: { workersSurvive: false, summary: 'The relay runs as a systemd service' },
    backgroundTasks: [
      { title: 'nightly export', detail: '1 background agent: export', survives: false },
      { title: 'cloud chat', detail: '1 background agent: build', survives: true },
    ],
  }, { action: 'shutdown' });
  assert.match(stopping, /Shut down now may cut off 2 sessions/);
  assert.match(stopping, /These background tasks may stop:[\s\S]*nightly export[\s\S]*These background tasks keep running:[\s\S]*cloud chat/);
  assert.match(stopping, /systemd service/);
  const queued = ui.renderRestartNowBody(QUEUED, { offerCancel: true });
  assert.match(queued, /onclick="cancelQueuedRelayRestart\(\)">Cancel restart</);
});

test('describeRestartBackgroundTask reads as a session line with its fate', () => {
  assert.equal(ui.describeRestartBackgroundTask({ title: 'a', detail: '2 background agents: x; y', survives: true }), 'a — 2 background agents: x; y (keeps running)');
  assert.equal(ui.describeRestartBackgroundTask({ title: 'b', count: 1, survives: false }), 'b — 1 background task (may stop)');
});

test('a task held since the last restart reads as not yet confirmed', () => {
  const held = { title: 'soak', detail: '1 task not yet confirmed since the last relay restart: npm run soak', survives: null };
  assert.equal(ui.describeRestartBackgroundTask(held), 'soak — 1 task not yet confirmed since the last relay restart: npm run soak (not yet confirmed)');
  const row = ui.renderRelayRestartRow({ ...QUEUED, backgroundTasks: [held] }, { nowMs: NOW });
  assert.match(row.querySelector('.relay-restart-background').textContent, /\(not yet confirmed\)/);
  const html = ui.renderRestartConfirmBody({ ...QUEUED, backgroundTasks: [held] });
  assert.match(html, /Not yet confirmed by their worker since the last relay restart/);
  assert.doesNotMatch(html, /These background tasks keep running/);
});

test('restart now on a queued shutdown sends a shutdown, naming the request it was shown', async () => {
  const sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    sent.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true, accepted: true, status: 'shutting_down' }) };
  };
  const shutdown = { ...QUEUED, action: 'shutdown', restart: false };
  ui.openRestartNowConfirmation(shutdown);
  assert.match(document.getElementById('summary-modal-body').innerHTML, /Shut down now/);
  await ui.confirmRestartRelayNow();
  const post = sent.find((entry) => entry.body?.immediate);
  assert.ok(post, 'an immediate request went out');
  assert.equal(post.body.restart, false);
  assert.equal(post.body.expectRequestedAt, QUEUED.requestedAt);
  assert.equal(post.body.reason, 'manual-shutdown-now');
});

test('a dialog shown for a queued request closes once that request is gone', () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, ...QUEUED }) });
  ui.openRestartNowConfirmation(QUEUED);
  const modal = document.getElementById('summary-modal');
  assert.ok(modal.classList.contains('visible'));
  ui.noteRelayRestartStateForDialogs(QUEUED);
  assert.ok(modal.classList.contains('visible'), 'the same request: stays');
  ui.noteRelayRestartStateForDialogs({ status: 'idle' });
  assert.equal(modal.classList.contains('visible'), false);
});
