import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.HTMLDetailsElement = dom.window.HTMLDetailsElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const { renderSuspendHostModalBody } = await import('./action-confirmations.js');

test('idle: plain confirm with the 30 second note', () => {
  const html = renderSuspendHostModalBody({ state: { status: 'idle', pending: false }, blockers: [] });
  assert.match(html, /30 seconds/);
  assert.match(html, /onclick="confirmSuspendHost\(\)"/);
  assert.match(html, /💤 Suspend host</);
  assert.doesNotMatch(html, /suspend-host-blockers/);
});

test('busy: per-session list and the "when idle" button', () => {
  const html = renderSuspendHostModalBody({
    state: { status: 'idle', pending: false },
    blockers: [
      { kind: 'turn', title: 'sidebar polish', detail: 'turn running' },
      { kind: 'background', title: 'report builder', detail: '1 background agent: export the PDF' },
      { kind: 'ci', title: 'example-org/demo', detail: 'CI on feature/export (in_progress)' },
    ],
  });
  assert.match(html, /Agents are still active/);
  assert.match(html, /<li>sidebar polish — turn running<\/li>/);
  assert.match(html, /<li>report builder — 1 background agent: export the PDF<\/li>/);
  assert.match(html, /CI in example-org\/demo/);
  assert.match(html, /2 minutes of quiet/);
  assert.match(html, /💤 Suspend when idle</);
});

test('already queued: shows blockers and a cancel button instead of confirm', () => {
  const html = renderSuspendHostModalBody({
    state: { status: 'queued', pending: true, blockers: [] },
    blockers: [{ kind: 'turn', title: 'report builder', detail: 'turn running' }],
  });
  assert.match(html, /already queued/);
  assert.match(html, /onclick="cancelQueuedHostSuspend\(\)"/);
  assert.doesNotMatch(html, /confirmSuspendHost/);
});

test('countdown: shows the remaining time', () => {
  const html = renderSuspendHostModalBody({
    state: { status: 'countdown', pending: true, fireAt: new Date(Date.now() + 20_000).toISOString() },
    blockers: [],
  });
  assert.match(html, /suspends in <strong>0:(19|20)<\/strong>/);
});

test('unsupported platform: no confirm at all', () => {
  const html = renderSuspendHostModalBody({ supported: false });
  assert.match(html, /only available when the relay runs on Windows/);
  assert.doesNotMatch(html, /confirmSuspendHost/);
});

test('escapes blocker text', () => {
  const html = renderSuspendHostModalBody({ blockers: [{ kind: 'turn', title: '<img src=x>', detail: 'turn running' }] });
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;img src=x&gt;/);
});
