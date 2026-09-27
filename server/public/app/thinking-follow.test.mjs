import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div id="messages"></div><textarea id="input"></textarea></body>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const follow = await import('./thinking-follow.js');

let convId = 'conv-a';
follow.initThinkingFollow({ getCurrentConversationId: () => convId });

test.beforeEach(() => {
  follow.__resetThinkingFollowForTests();
  follow.installThinkingFollowScrollGuards(document.getElementById('messages'));
  convId = 'conv-a';
});

test('modes are remembered per conversation and toggle off when pressed again', () => {
  assert.equal(follow.getThinkingFollowMode(), null);
  assert.equal(follow.toggleThinkingFollowMode('conv-a', 'thoughts'), 'thoughts');
  assert.equal(follow.toggleThinkingFollowMode('conv-a', 'stream'), 'stream');
  assert.equal(follow.toggleThinkingFollowMode('conv-a', 'stream'), null);
  follow.setThinkingFollowMode('conv-a', 'tools');
  convId = 'conv-b';
  assert.equal(follow.getThinkingFollowMode(), null, 'other chat starts unarmed');
  follow.setThinkingFollowMode('conv-b', 'thoughts');
  convId = 'conv-a';
  assert.equal(follow.getThinkingFollowMode(), 'tools', 'switching back restores the mode');
  assert.equal(follow.setThinkingFollowMode('conv-a', 'bogus'), null);
});

test('computeFollowScrollTop pins the target bottom 16px above the pane bottom and clamps', () => {
  // Pane 500px tall at y=100; target bottom currently at y=900 in the viewport.
  const next = follow.computeFollowScrollTop({ scrollTop: 200, clientHeight: 500, scrollHeight: 5000, scrollerTop: 100, targetBottom: 900 });
  // target bottom in scroller = 800; desired = 484; move by +316.
  assert.equal(next, 516);
  assert.equal(follow.computeFollowScrollTop({ scrollTop: 0, clientHeight: 500, scrollHeight: 600, scrollerTop: 0, targetBottom: 4000 }), 100, 'clamped to max');
  assert.equal(follow.computeFollowScrollTop({ scrollTop: 50, clientHeight: 500, scrollHeight: 600, scrollerTop: 0, targetBottom: 10 }), 0, 'clamped to zero');
});

test('button markup marks the armed mode with aria-pressed and the sync keeps it current', () => {
  const html = follow.renderThinkingFollowButtonsHtml('stream');
  assert.match(html, /data-follow="thoughts" aria-pressed="false"/);
  assert.match(html, /data-follow="stream" aria-pressed="true"/);
  assert.match(html, /🛠️/);
  const host = document.createElement('div');
  host.innerHTML = html;
  follow.syncThinkingFollowButtons(host, 'tools');
  assert.equal(host.querySelector('[data-follow="tools"]').getAttribute('aria-pressed'), 'true');
  assert.equal(host.querySelector('[data-follow="stream"]').classList.contains('active'), false);
});

test('a wheel in the pane disarms; typing scroll keys in the composer does not', () => {
  const pane = document.getElementById('messages');
  follow.setThinkingFollowMode('conv-a', 'thoughts');
  const composer = document.getElementById('input');
  composer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
  assert.equal(follow.getThinkingFollowMode(), 'thoughts', 'composer keys leave it armed');
  document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
  assert.equal(follow.getThinkingFollowMode(), null, 'pane scroll key disarms');
  follow.setThinkingFollowMode('conv-a', 'tools');
  pane.dispatchEvent(new dom.window.Event('wheel', { bubbles: true }));
  assert.equal(follow.getThinkingFollowMode(), null, 'wheel disarms');
});

test('conversation-view wires the group next to Stop and routes Stop through a confirm', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('./conversation-view.js', import.meta.url)), 'utf8');
  assert.match(source, /<div class="thinking-bubble-header">\$\{stopBtnHtml\}\$\{followBtnsHtml\}<\/div>/, 'Stop left, follow buttons right');
  assert.match(source, /if \(action === 'stop-turn' && messageId\) \{[\s\S]*?openStopTurnConfirmation\(currentConvId, messageId\);/);
  assert.match(source, /if \(action === 'follow-thinking'\)/);
  assert.match(source, /kind: 'stop-turn'/);
  assert.match(source, /unobserveThinkingBubble\(\);\s*document\.getElementById\('thinking-indicator'\)\?\.remove\(\);/);
});
