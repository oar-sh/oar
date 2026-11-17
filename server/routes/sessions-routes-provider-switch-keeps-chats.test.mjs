import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';

// No chat moves when a provider is switched off or loses its key: an empty,
// never-sent chat keeps its provider. The runtime's
// rebind (reconcileUnstartedConversationProviders) is handed in as a spy and
// must never be called; the answers carry no `reconciliation`.

const off = (extra = {}) => ({ ok: true, configured: false, enabled: false, model: 'm-1', models: [], ...extra });

function createHarness() {
  const routes = new Map();
  const register = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  const app = { get: register('GET'), post: register('POST'), patch: register('PATCH'), put: register('PUT'), delete: register('DELETE') };
  const rebinds = [];
  const events = [];
  const serviceStub = (removedFlags) => ({
    update: () => ({ ok: true, ...removedFlags, settings: {} }),
    describe: () => ({ configured: false, enabled: false, model: '', models: [] }),
    refreshModels: async () => ({ ok: true, models: [] }),
    getSettings: () => ({ configured: false, enabled: false, model: '', models: [] }),
  });
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit: (event, payload) => events.push({ event, payload }) },
    db: { prepare: () => ({ run() {}, get: () => null, all: () => [] }), transaction: (fn) => (...args) => fn(...args) },
    stmts: {},
    getModelCatalogState: () => ({ models: [], reasoningByModel: {}, providersByModel: {}, modelMetadataByModel: {} }),
    reconcileUnstartedConversationProviders: async (args) => {
      rebinds.push(args);
      return { updatedUnstartedConversations: 1, skippedStartedConversations: 0, skippedActiveQueueConversations: 0, failedConversations: [] };
    },
    setOpenAIProviderSettings: () => off(),
    setClaudeProviderSettings: () => off(),
    setGrokProviderSettings: () => off(),
    setCursorProviderSettings: () => off(),
    deepseekSettingsService: serviceStub({ removed: true }),
    claudeApiSettingsService: serviceStub({ removed: true, disabled: true }),
  });
  const post = async (routePath, body) => {
    const captured = { status: 200, body: null };
    const res = { setHeader() {}, status(code) { captured.status = code; return res; }, json(payload) { captured.body = payload; return res; } };
    await routes.get(`POST ${routePath}`)({ headers: {}, query: {}, params: {}, body }, res);
    return captured;
  };
  return { post, rebinds, events };
}

const CASES = [
  ['OpenAI key removed', '/api/settings/openai', { remove: true, model: 'gpt-4o' }, 'openai_settings_updated'],
  ['Claude switched off', '/api/settings/claude', { enabled: false }, 'claude_settings_updated'],
  ['Grok switched off', '/api/settings/grok', { enabled: false }, 'grok_settings_updated'],
  ['Grok switched on', '/api/settings/grok', { enabled: true }, 'grok_settings_updated'],
  ['Cursor key removed', '/api/settings/cursor', { remove: true }, 'cursor_settings_updated'],
  ['DeepSeek key removed', '/api/settings/deepseek', { remove: true }, 'deepseek_settings_updated'],
  ['Claude API switched off', '/api/settings/claude-api', { enabled: false }, 'claude_api_settings_updated'],
  ['Claude API key removed', '/api/settings/claude-api', { remove: true }, 'claude_api_settings_updated'],
];

for (const [label, routePath, body, event] of CASES) {
  test(`${label}: no chat is moved, and the answer carries no reconciliation`, async () => {
    const { post, rebinds, events } = createHarness();
    const response = await post(routePath, body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(rebinds, []);
    assert.equal('reconciliation' in response.body, false);
    assert.doesNotMatch(String(response.body.warning || ''), /could not switch provider/);
    const announced = events.find((entry) => entry.event === event);
    assert.ok(announced, `${event} is emitted`);
    assert.equal('reconciliation' in announced.payload, false);
  });
}
