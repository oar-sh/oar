import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NEW_CHAT_PROVIDER_STORAGE_KEY,
  newChatProviderOptions,
  preselectedNewChatProvider,
  readLastNewChatProvider,
  rememberNewChatProvider,
} from './new-chat-providers.mjs';

const on = { enabled: true };
const off = { enabled: false };
const values = (options) => options.map((option) => option.value);

function memoryStorage() {
  const map = new Map();
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)) };
}

test('Copilot is listed by its switch; a payload without `enabled`, or none, reads as on', () => {
  assert.deepEqual(values(newChatProviderOptions({ copilot: { enabled: true } })), ['github']);
  assert.deepEqual(values(newChatProviderOptions({ copilot: { engine: 'sdk' } })), ['github']);
  assert.deepEqual(values(newChatProviderOptions({ copilot: null })), ['github']);
  assert.deepEqual(values(newChatProviderOptions({ copilot: off })), []);
});

test('every provider that is on, in a fixed order; Copilot is not forced in', () => {
  const all = newChatProviderOptions({
    copilot: on, openai: on, claude: on, claudeApi: on, claudeCloud: on, cursor: on, grok: on, deepseek: on,
  });
  assert.deepEqual(values(all), ['github', 'openai', 'openai-image', 'claude', 'claude-api', 'claude-cloud', 'cursor', 'grok', 'deepseek']);
  assert.deepEqual(all.find((option) => option.value === 'claude'), { value: 'claude', label: 'Claude SDK' });
  // Copilot off and only Claude on.
  assert.deepEqual(values(newChatProviderOptions({ copilot: off, claude: on, grok: off })), ['claude']);
  // Only a strict true counts for the others.
  assert.deepEqual(values(newChatProviderOptions({ copilot: off, claude: { enabled: 'true' } })), []);
});

test('the preselection is the last used while it is listed, else the first; none with no provider', () => {
  const options = newChatProviderOptions({ copilot: on, claude: on, grok: on });
  assert.equal(preselectedNewChatProvider(options, 'grok'), 'grok');
  assert.equal(preselectedNewChatProvider(options, 'cursor'), 'github', 'a provider switched off since');
  assert.equal(preselectedNewChatProvider(options, ''), 'github');
  assert.equal(preselectedNewChatProvider(newChatProviderOptions({ copilot: off, claude: on }), 'github'), 'claude');
  assert.equal(preselectedNewChatProvider([], 'claude'), '');
});

test('the last used provider is kept per browser', () => {
  const storage = memoryStorage();
  assert.equal(readLastNewChatProvider(storage), '');
  rememberNewChatProvider('claude', storage);
  assert.equal(storage.getItem(NEW_CHAT_PROVIDER_STORAGE_KEY), 'claude');
  assert.equal(readLastNewChatProvider(storage), 'claude');
  rememberNewChatProvider('', storage);
  assert.equal(readLastNewChatProvider(storage), 'claude', 'nothing to keep: unchanged');
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(readLastNewChatProvider(broken), '');
  assert.doesNotThrow(() => rememberNewChatProvider('grok', broken));
});
