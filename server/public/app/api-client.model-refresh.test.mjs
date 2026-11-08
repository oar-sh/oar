import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const {
  loadModelRefreshSettings,
  markModelsSeen,
  saveEnabledModelVariants,
  updateClaudeApiSettings,
  updateClaudeSettings,
  updateCursorSettings,
  updateDeepSeekSettings,
  updateGrokSettings,
  updateModelRefreshSettings,
  updateOpenAISettings,
} = await import('./api-client.js');

// What the Select Models save, the seen mark and Settings › General › Models
// send. The model ids are invented.
async function sent(call) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  try {
    await call();
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(requests.length, 1);
  return requests[0];
}

test('the OpenAI selection names no model, so the default model stays', async () => {
  const request = await sent(() => updateOpenAISettings({ enabledModels: ['gpt-9-mini', 'gpt-9-pro'], autoEnableNew: false }));
  assert.match(request.url, /\/api\/settings\/openai$/);
  assert.deepEqual(request.body, { apiKey: '', remove: false, enabledModels: ['gpt-9-mini', 'gpt-9-pro'], autoEnableNew: false });
  // The Settings tab still names its model, an empty one as gpt-4o.
  assert.equal((await sent(() => updateOpenAISettings({ model: 'gpt-9-mini', enabled: true }))).body.model, 'gpt-9-mini');
  assert.equal((await sent(() => updateOpenAISettings({ model: '', remove: true }))).body.model, 'gpt-4o');
});

test('a provider save carries its switch only when it is named', async () => {
  assert.deepEqual((await sent(() => updateCursorSettings({ enabledModels: ['composer-3'], autoEnableNew: true }))).body, {
    apiKey: '', remove: false, enabledModels: ['composer-3'], autoEnableNew: true,
  });
  assert.equal('autoEnableNew' in (await sent(() => updateCursorSettings({ enabledModels: ['composer-3'] }))).body, false);
});

test('Copilot\'s PATCH sends the selection and the switch, or the switch alone', async () => {
  const both = await sent(() => saveEnabledModelVariants(['gpt-9-mini', ' '], { autoEnableNew: false }));
  assert.equal(both.method, 'PATCH');
  assert.match(both.url, /\/api\/model-variants$/);
  assert.deepEqual(both.body, { enabledVariantIds: ['gpt-9-mini'], autoEnableNew: false });
  assert.deepEqual((await sent(() => saveEnabledModelVariants(null, { autoEnableNew: true }))).body, { autoEnableNew: true });
  assert.deepEqual((await sent(() => saveEnabledModelVariants(['gpt-9-mini']))).body, { enabledVariantIds: ['gpt-9-mini'] });
});

test('a save names the rows it showed, only when given a list', async () => {
  assert.deepEqual((await sent(() => saveEnabledModelVariants(['gpt-9-mini'], {
    autoEnableNew: true,
    shownVariantIds: ['gpt-9-mini', ' gpt-9-pro ', ''],
  }))).body, { enabledVariantIds: ['gpt-9-mini'], shownVariantIds: ['gpt-9-mini', 'gpt-9-pro'], autoEnableNew: true });
  assert.equal('shownVariantIds' in (await sent(() => saveEnabledModelVariants(null, { autoEnableNew: true, shownVariantIds: 'gpt-9' }))).body, false);
  for (const [name, call] of [
    ['cursor', updateCursorSettings],
    ['openai', updateOpenAISettings],
    ['claude', updateClaudeSettings],
    ['grok', updateGrokSettings],
    ['deepseek', updateDeepSeekSettings],
    ['claude-api', updateClaudeApiSettings],
  ]) {
    const request = await sent(() => call({ enabledModels: ['model-a'], shownModels: ['model-a', 'model-b'] }));
    assert.match(request.url, new RegExp(`/api/settings/${name}$`));
    assert.deepEqual(request.body.shownModels, ['model-a', 'model-b'], name);
    assert.equal('shownModels' in (await sent(() => call({ enabledModels: ['model-a'] }))).body, false, name);
  }
});

test('opening Select Models posts the seen mark; the Models section reads and posts its settings', async () => {
  const seen = await sent(() => markModelsSeen());
  assert.equal(seen.method, 'POST');
  assert.match(seen.url, /\/api\/model-variants\/seen$/);
  const load = await sent(() => loadModelRefreshSettings());
  assert.equal(load.method, 'GET');
  assert.match(load.url, /\/api\/model-refresh-settings$/);
  const post = await sent(() => updateModelRefreshSettings({ auto: false, intervalHours: '72', excluded: ['grok', ''] }));
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.body, { auto: false, intervalHours: 72, excluded: ['grok'] });
  assert.deepEqual((await sent(() => updateModelRefreshSettings({ excluded: [] }))).body, { excluded: [] });
});
