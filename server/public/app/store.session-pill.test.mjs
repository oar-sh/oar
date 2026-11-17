import test from 'node:test';
import assert from 'node:assert/strict';

// updateSessionPill: the chat title's tooltip names the chat's own provider,
// not "Copilot" for every chat, and keeps the SDK session id for the copy.
//
// store.js touches window/document at import time — the same browser-global
// stub the other store-importing suites install, plus the title elements.
const elements = {
  'chat-title': { dataset: {}, title: '' },
  'chat-title-session-usage': { textContent: '', hidden: true },
};
globalThis.window = {
  location: { pathname: '/' },
  innerHeight: 0,
  addEventListener() {},
};
globalThis.document = {
  documentElement: { clientHeight: 0 },
  addEventListener() {},
  getElementById(id) { return elements[id] || null; },
};
globalThis.sessionStorage = { getItem() { return ''; }, setItem() {} };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

const { updateSessionPill } = await import('./store.js');
const title = elements['chat-title'];

test('the tooltip names a Claude chat\'s session as Claude\'s', () => {
  updateSessionPill({ id: 'conv-claude', runtimeProviderType: 'claude' }, { sdkSessionId: 'sess-claude-1' });
  assert.equal(title.title, 'Claude session sess-claude-1 (click to copy)');
  assert.equal(title.dataset.sdkSessionId, 'sess-claude-1');
  assert.equal(title.dataset.copilotSessionId, undefined);
  // The copy toast reads the provider from here.
  assert.equal(title.dataset.sdkSessionProvider, 'claude');
});

test('a Copilot chat still reads "Copilot session"', () => {
  updateSessionPill({ id: 'conv-copilot', runtime_provider_type: 'github', sdk_session_id: 'sess-copilot-1' }, null);
  assert.equal(title.title, 'Copilot session sess-copilot-1 (click to copy)');
  assert.equal(title.dataset.sdkSessionId, 'sess-copilot-1');
});

test('a chat whose provider is unknown gets no provider word', () => {
  updateSessionPill({ id: 'conv-unknown' }, { sdk_session_id: 'sess-unknown-1' });
  assert.equal(title.title, 'Session sess-unknown-1 (click to copy)');
  updateSessionPill({ id: 'conv-new', runtimeProviderType: 'something-new' }, { sdkSessionId: 'sess-new-1' });
  assert.equal(title.title, 'Session sess-new-1 (click to copy)');
});

test('without a session id the tooltip and the copy id are cleared', () => {
  updateSessionPill({ id: 'conv-claude', runtimeProviderType: 'claude' }, { sdkSessionId: 'sess-claude-2' });
  updateSessionPill({ id: 'conv-empty', runtimeProviderType: 'claude' }, null);
  assert.equal(title.title, '');
  assert.equal(title.dataset.sdkSessionId, undefined);
  assert.equal(title.dataset.sdkSessionProvider, undefined);
});
