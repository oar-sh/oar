import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// The tabs render into the real summary modal of index.html; jsdom runs no
// page scripts, the API is injected.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const bootstrapSource = await readFile(fileURLToPath(new URL('./bootstrap.js', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const store = await import('./store.js');
const tabs = await import('./context-media-tab.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function render(conversationId, fetchJson) {
  store.renderSummaryModalContent({
    title: 'Context usage',
    bodyHtml: tabs.wrapContextBody('<p class="ctx-body">usage table</p>', conversationId),
    kind: 'context',
  });
  tabs.afterContextRender({ fetchJson });
}

test('🧠 opens on Context; Media is a tab with the session count', async () => {
  store.openSummaryModal({ title: 'Context usage', bodyHtml: '', kind: 'context' });
  tabs.initContextTabs();
  tabs.resetContextTab('conv-a');
  const asked = [];
  render('conv-a', async (url) => {
    asked.push(url);
    return { media: 7, file: 2, pending: 0 };
  });
  await settle();
  const body = document.getElementById('summary-modal-body');
  assert.deepEqual([...body.querySelectorAll('[data-context-tab]')].map((node) => [node.dataset.contextTab, node.getAttribute('aria-selected')]), [
    ['context', 'true'],
    ['media', 'false'],
  ]);
  assert.equal(body.querySelector('[data-context-panel="context"]').hidden, false);
  assert.equal(body.querySelector('[data-context-panel="media"]').hidden, true);
  assert.equal(body.querySelector('.ctx-body').textContent, 'usage table');
  assert.equal(body.querySelector('[data-context-media-count]').textContent, '7');
  assert.deepEqual(asked, ['/api/media/counts?conversationId=conv-a']);

  // A refresh re-renders the body: the count is kept, not asked again.
  render('conv-a', async (url) => {
    asked.push(url);
    return { media: 9 };
  });
  await settle();
  assert.equal(body.querySelector('[data-context-media-count]').textContent, '7');
  assert.equal(asked.length, 1);
});

test('choosing Media shows the gallery panel and keeps the choice across a refresh; a fresh open starts on Context', async () => {
  const body = document.getElementById('summary-modal-body');
  body.querySelector('[data-context-tab="media"]').click();
  assert.equal(body.querySelector('[data-context-panel="media"]').hidden, false);
  assert.equal(body.querySelector('[data-context-panel="context"]').hidden, true);
  assert.ok(body.querySelector('[data-context-panel="media"] .media-gallery[data-scope="session"]'), 'the session gallery is mounted');
  render('conv-a', async () => ({ media: 7 }));
  assert.equal(body.querySelector('[data-context-tab="media"]').getAttribute('aria-selected'), 'true');
  assert.ok(body.querySelector('[data-context-panel="media"] .media-gallery'), 'mounted again after the re-render');

  tabs.resetContextTab('conv-b');
  render('conv-b', async () => ({ media: 0 }));
  await settle();
  assert.equal(body.querySelector('[data-context-tab="context"]').getAttribute('aria-selected'), 'true');
  assert.equal(body.querySelector('[data-context-media-count]').textContent, '0');
});

test('without a conversation there are no tabs', () => {
  assert.equal(tabs.wrapContextBody('<p>x</p>', ''), '<p>x</p>');
});

test('bootstrap wraps the Context body and starts each open on Context', () => {
  assert.match(bootstrapSource, /const bodyHtml = wrapContextBody\(contextHtml, settingsConversationId\);/);
  assert.match(bootstrapSource, /setSummaryModalLeaveHandler\('context', \(\) => \{\s*commitAutoCompactDraft\(\);\s*leaveContextTab\(\);\s*\}\);\s*afterContextRender\(\);/);
  assert.match(bootstrapSource, /async function showContext\(\) \{[\s\S]*?initContextTabs\(\);\s*resetContextTab\(convId\);[\s\S]*?openSummaryModal\(/);
  assert.doesNotMatch(bootstrapSource, /function renderUsageReport[\s\S]{0,400}initContextTabs/, 'bound when 🧠 opens, not with the usage dialog');
});

test('one gallery per open: a re-render keeps it, leaving the modal destroys it', async () => {
  store.openSummaryModal({ title: 'Context usage', bodyHtml: '', kind: 'context' });
  tabs.resetContextTab('conv-s');
  const fetchJson = async (url) => (url.startsWith('/api/media/counts')
    ? { media: 1, file: 0, pending: 0 }
    : { items: [], nextCursor: null, missingHidden: 0, indexing: { pending: 0 } });
  render('conv-s', fetchJson);
  const body = document.getElementById('summary-modal-body');
  body.querySelector('[data-context-tab="media"]').click();
  const first = body.querySelector('[data-context-panel="media"] .media-gallery');
  assert.ok(first);
  render('conv-s', fetchJson);
  assert.equal(body.querySelector('[data-context-panel="media"] .media-gallery'), first, 'the same gallery, moved into the new panel');
  const kept = tabs.contextTabState().gallery;
  let destroyed = 0;
  const destroy = kept.destroy;
  kept.destroy = () => { destroyed += 1; destroy(); };
  tabs.leaveContextTab();
  assert.equal(destroyed, 1);
  assert.equal(tabs.contextTabState().gallery, null);
});