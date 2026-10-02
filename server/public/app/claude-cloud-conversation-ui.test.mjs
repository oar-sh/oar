import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// A Claude Cloud conversation on the real index.html in JSDOM: the cloud line
// above the composer, the header line, the controls that are taken away, the
// image-only attach button — and that a conversation of any other provider
// gets all of it back exactly as it was.
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
globalThis.HTMLAnchorElement = window.HTMLAnchorElement;
globalThis.HTMLDetailsElement = window.HTMLDetailsElement;
globalThis.NodeFilter = window.NodeFilter;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.CSS = { escape: (value) => String(value).replace(/["\\]/g, '\\$&') };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
const opened = [];
window.open = (url, target) => {
  opened.push([String(url), target]);
  return {};
};

const store = await import('./store.js');
const cloudUi = await import('./claude-cloud-conversation-ui.js');
const { syncChatHeaderWorkspaceLabel } = await import('./cwd-picker.js');
const { conversations, setCurrentConv } = store;

const REPO_URL = 'https://github.com/example-org/sample-repo';
const SESSION_URL = 'https://claude.ai/code/session_01EXAMPLEaaaaaaaaaaaaaaaa';
const el = (id) => document.getElementById(id);
const lineTexts = () => [...el('cloud-session-line').querySelectorAll('.cloud-line-item')].map((node) => node.textContent);
const lineLinks = () => [...el('cloud-session-line').querySelectorAll('a')].map((node) => node.getAttribute('href'));

function show(id) {
  setCurrentConv(id);
  cloudUi.syncClaudeCloudConversationUi();
  syncChatHeaderWorkspaceLabel();
}

conversations['conv-cloud'] = {
  id: 'conv-cloud',
  title: 'Cloud chat',
  runtimeProviderType: 'claude-cloud',
  runtimeProviderModel: 'claude-sonnet-5-5',
  // platform-agnostic: a display value here, never resolved as a path.
  currentWorkspaceRootPath: '/home/dev/sample-repo',
  cloud: { repoUrl: REPO_URL, slug: 'example-org/sample-repo', branch: 'main', sessionUrl: null, pushedBranches: [], costUsd: null },
};
conversations['conv-local'] = {
  id: 'conv-local',
  title: 'Local chat',
  runtimeProviderType: 'claude',
  // platform-agnostic: a display value here, never resolved as a path.
  currentWorkspaceRootPath: '/home/dev/sample-repo',
  cloud: null,
};

test('the markup ships with every cloud element hidden', () => {
  assert.equal(el('cloud-session-line').hasAttribute('hidden'), true);
  assert.equal(el('chat-menu-open-cloud-session').hasAttribute('hidden'), true);
  assert.equal(el('image-input').hasAttribute('accept'), false);
  assert.equal(document.body.classList.contains('claude-cloud-conversation'), false);
});

test('a cloud conversation shows its repository and loses what does not apply', () => {
  show('conv-cloud');
  assert.equal(cloudUi.isCurrentConversationClaudeCloud(), true);
  assert.equal(document.body.classList.contains('claude-cloud-conversation'), true);
  assert.equal(el('cloud-session-line').hidden, false);
  assert.deepEqual(lineTexts(), ['☁ example-org/sample-repo', 'main']);
  assert.deepEqual(lineLinks(), [REPO_URL]);
  // No working directory on the relay host to change, no session to open yet.
  assert.equal(el('chat-menu-change-cwd').hidden, true);
  assert.equal(el('chat-menu-open-cloud-session').hidden, true);
  assert.equal(el('image-input').getAttribute('accept'), 'image/jpeg,image/png,image/gif,image/webp');
  assert.match(el('attach-btn').title, /^Attach image \(Claude Cloud chats take images only/);
  // The header names the repository, not the local folder the fields came from.
  assert.equal(el('chat-title-cwd').hidden, false);
  assert.equal(el('chat-title-cwd').textContent, '☁ example-org/sample-repo · main');
  assert.equal(el('chat-title-cwd').title, REPO_URL);
});

test('a claude_cloud_session event adds the session link, the pushed branches and the cost', () => {
  const lineBefore = el('cloud-session-line').firstElementChild;
  assert.equal(cloudUi.applyClaudeCloudSessionEvent({
    conversationId: 'conv-cloud',
    cloud: {
      repoUrl: REPO_URL,
      slug: 'example-org/sample-repo',
      branch: 'main',
      sessionUrl: SESSION_URL,
      pushedBranches: [{ branch: 'claude/fix-slugify', at: '2026-10-02T10:00:00.000Z' }],
      costUsd: 0.18,
    },
  }), true);
  assert.deepEqual(lineTexts(), ['☁ example-org/sample-repo', 'main', 'claude.ai ↗', '⇡ claude/fix-slugify', '$0.18']);
  assert.deepEqual(lineLinks(), [REPO_URL, SESSION_URL, `${REPO_URL}/compare/main...claude/fix-slugify`]);
  for (const link of el('cloud-session-line').querySelectorAll('a')) {
    assert.equal(link.getAttribute('target'), '_blank');
    assert.equal(link.getAttribute('rel'), 'noopener');
  }
  assert.notEqual(el('cloud-session-line').firstElementChild, lineBefore, 'the line was redrawn for the new state');
  assert.equal(el('chat-menu-open-cloud-session').hidden, false);

  // Syncing again with nothing new (every list render does) keeps the nodes:
  // a link must not be replaced under the finger that is tapping it.
  const stable = el('cloud-session-line').firstElementChild;
  cloudUi.syncClaudeCloudConversationUi();
  assert.equal(el('cloud-session-line').firstElementChild, stable);
});

test('the menu entry opens the session on claude.ai', () => {
  opened.length = 0;
  assert.equal(cloudUi.openCurrentCloudSession(), true);
  assert.deepEqual(opened, [[SESSION_URL, '_blank']]);
});

test('an event for another conversation updates its record and leaves the screen alone', () => {
  conversations['conv-cloud-2'] = { id: 'conv-cloud-2', runtimeProviderType: 'claude-cloud', cloud: { repoUrl: 'https://github.com/example-org/other-repo' } };
  const before = el('cloud-session-line').innerHTML;
  assert.equal(cloudUi.applyClaudeCloudSessionEvent({ conversationId: 'conv-cloud-2', cloud: { costUsd: 1.5 } }), true);
  assert.deepEqual(conversations['conv-cloud-2'].cloud, { repoUrl: 'https://github.com/example-org/other-repo', costUsd: 1.5 });
  assert.equal(el('cloud-session-line').innerHTML, before);
  // Unknown conversation, or no id at all: nothing to apply.
  assert.equal(cloudUi.applyClaudeCloudSessionEvent({ conversationId: 'conv-missing', cloud: {} }), false);
  assert.equal(cloudUi.applyClaudeCloudSessionEvent(null), false);
});

test('switching to a local conversation gives everything back', () => {
  show('conv-local');
  assert.equal(cloudUi.isCurrentConversationClaudeCloud(), false);
  assert.equal(document.body.classList.contains('claude-cloud-conversation'), false);
  assert.equal(el('cloud-session-line').hidden, true);
  assert.equal(el('cloud-session-line').innerHTML, '');
  assert.equal(el('chat-menu-change-cwd').hidden, false);
  assert.equal(el('chat-menu-open-cloud-session').hidden, true);
  assert.equal(el('image-input').hasAttribute('accept'), false);
  assert.equal(el('attach-btn').title, 'Attach file');
  assert.equal(el('chat-title-cwd').textContent, '/home/dev/sample-repo');
  opened.length = 0;
  assert.equal(cloudUi.openCurrentCloudSession(), false);
  assert.deepEqual(opened, []);
});

test('an entry another owner had hidden is not brought back by leaving a cloud chat', () => {
  const changeCwd = el('chat-menu-change-cwd');
  changeCwd.hidden = true;
  show('conv-cloud');
  assert.equal(changeCwd.hidden, true);
  show('conv-local');
  assert.equal(changeCwd.hidden, true, 'it was hidden before the cloud chat and stays hidden after it');
  changeCwd.hidden = false;
});

test('a cloud conversation from a relay without the cloud field shows no line', () => {
  conversations['conv-cloud-bare'] = { id: 'conv-cloud-bare', runtimeProviderType: 'claude-cloud' };
  show('conv-cloud-bare');
  assert.equal(document.body.classList.contains('claude-cloud-conversation'), true);
  assert.equal(el('cloud-session-line').hidden, true);
  assert.equal(el('chat-title-cwd').hidden, true);
  assert.equal(el('chat-menu-open-cloud-session').hidden, true);
  show(null);
  assert.equal(document.body.classList.contains('claude-cloud-conversation'), false);
});
