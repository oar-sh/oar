import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// The live bubble's tool lines under the "Tool lines shown" setting, on the
// real page in JSDOM through the real poll path (restoreInFlightThinking):
// each agent keeps its own newest lines, a sub-agent at the cap says "50+
// steps", and a changed setting trims or refills on the next poll even when
// the payload is the same.

const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
  const timer = nativeSetInterval(...args);
  timer?.unref?.();
  return timer;
};

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLDetailsElement = window.HTMLDetailsElement;
globalThis.NodeFilter = window.NodeFilter;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.CSS = { escape: (value) => String(value).replace(/["\\]/g, '\\$&') };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const store = await import('./store.js');
const view = await import('./conversation-view.js');
const { LIVE_ACTIVITY_CAP_STORAGE_KEY } = await import('./live-activity-cap.mjs');

const convId = 'conv-live-cap';
store.conversations[convId] = { id: convId, title: 'Map the widget code', runtimeProviderType: 'claude' };
store.setCurrentConv(convId);

const RUN = 'toolu_fixture_explore';
function inFlight(messageId) {
  const activities = [];
  for (let n = 1; n <= 60; n += 1) {
    if (n % 10 === 1) activities.push({ text: `Tool (view): src/widget-main-${(n - 1) / 10 + 1}.js`, subagentRunId: null });
    activities.push({ text: `Tool (grep): widget-part-${n}`, subagentRunId: RUN });
  }
  return {
    messageId,
    status: 'processing',
    mode: 'agent',
    activities,
    thoughts: [],
    streamEvents: [],
    subagentRuns: [{ subagentRunId: RUN, messageId, displayName: 'Explore the widget code', status: 'running' }],
  };
}

const mainRows = () => document.querySelectorAll('#thinking-activity > .thinking-activity-item');
const subRows = () => document.querySelectorAll(`.subagent-bubble[data-subagent-run-id="${RUN}"] .subagent-activity > .subagent-activity-item`);
const subSummary = () => document.querySelector(`.subagent-bubble[data-subagent-run-id="${RUN}"] .subagent-bubble-summary`)?.textContent || '';

test('each agent keeps its own newest lines; a full sub-agent bubble says "50+ steps"', () => {
  localStorage.removeItem(LIVE_ACTIVITY_CAP_STORAGE_KEY);
  view.removeThinking();
  view.restoreInFlightThinking(inFlight('turn-cap-1'), false);
  assert.equal(mainRows().length, 6, 'every main line');
  assert.equal(subRows().length, 50, 'the sub-agent\'s newest 50');
  assert.match(subRows()[0].textContent, /widget-part-11$/);
  assert.match(subSummary(), /^50\+ steps · /);
});

test('a changed cap trims, then refills, on the next poll with the same payload', () => {
  localStorage.removeItem(LIVE_ACTIVITY_CAP_STORAGE_KEY);
  view.removeThinking();
  const payload = inFlight('turn-cap-2');
  view.restoreInFlightThinking(payload, false);
  assert.equal(subRows().length, 50);

  localStorage.setItem(LIVE_ACTIVITY_CAP_STORAGE_KEY, '10');
  view.restoreInFlightThinking(payload, false);
  assert.equal(subRows().length, 10, 'trimmed at once');
  assert.equal(mainRows().length, 6);
  assert.match(subSummary(), /^10\+ steps · /);

  localStorage.setItem(LIVE_ACTIVITY_CAP_STORAGE_KEY, '0');
  view.restoreInFlightThinking(payload, false);
  assert.equal(subRows().length, 60, 'refilled from the payload');
  assert.match(subSummary(), /^60 steps · /, 'no limit: the plain count');
  localStorage.removeItem(LIVE_ACTIVITY_CAP_STORAGE_KEY);
});
