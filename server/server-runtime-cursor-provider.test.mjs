import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { createSessionRepository } from './repositories/session-repository.mjs';
import { applySchema } from './db-schema.mjs';

// server-runtime.mjs boots a live server on import, so these tests inspect the
// source as text instead of importing it.
const sourcePath = fileURLToPath(new URL('./server-runtime.mjs', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `expected server-runtime.mjs to contain ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `expected ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

test('cursor provider constants pin the composer default', () => {
  assert.match(source, /const DEFAULT_CURSOR_MODEL = 'composer-2\.5';/);
  assert.match(source, /const DEFAULT_CURSOR_MODELS = \['composer-2\.5'\];/);
});

test('cursor discovery records whether a model can actually turn reasoning off', () => {
  const detectSource = sliceBetween(
    'function cursorEntrySupportsReasoningOff(entry) {',
    '\nfunction cursorEntryEffortLevels(',
  );
  // Must mirror resolveCursorReasoningParams: 'thinking' or an explicit 'none'
  // effort value are the only ways the SDK can be told to stop reasoning.
  const detect = new Function(`${detectSource}\nreturn cursorEntrySupportsReasoningOff;`)();
  assert.equal(detect({ parameters: [{ id: 'thinking', values: [] }] }), true);
  assert.equal(detect({ parameters: [{ id: 'reasoning', values: [{ value: 'none' }, { value: 'low' }] }] }), true);
  assert.equal(detect({ parameters: [{ id: 'effort', values: ['low', 'high'] }] }), false);
  assert.equal(detect({ parameters: [] }), false);
  assert.equal(detect({}), false);

  const discoverySource = sliceBetween('async function refreshCursorProviderModels(', '\nfunction readGrokModelListSetting(');
  assert.match(discoverySource, /reasoningOffByModel\[modelId\.toLowerCase\(\)\] = cursorEntrySupportsReasoningOff\(entry\);/);
  assert.match(discoverySource, /CURSOR_MODEL_REASONING_OFF_SETTING_KEY, JSON\.stringify\(reasoningOffByModel\)/);
});

test('runtime_sessions migration adds the cursor_agent_id column', () => {
  // The schema/migration block moved verbatim to db-schema.mjs.
  const dbSchemaSource = fs
    .readFileSync(fileURLToPath(new URL('./db-schema.mjs', import.meta.url)), 'utf8')
    .replace(/\r\n/g, '\n');
  const start = dbSchemaSource.indexOf('const runtimeSessionColumns = db.prepare(`PRAGMA table_info(runtime_sessions)`)');
  assert.notEqual(start, -1, 'expected db-schema.mjs to contain the runtime_sessions migration');
  const end = dbSchemaSource.indexOf('const conversationColumns = ', start);
  assert.notEqual(end, -1, 'expected conversations migration after runtime_sessions migration');
  const migrationSource = dbSchemaSource.slice(start, end);
  assert.match(migrationSource, /if \(!runtimeSessionColumns\.includes\('cursor_agent_id'\)\) \{/);
  assert.match(migrationSource, /ALTER TABLE runtime_sessions ADD COLUMN cursor_agent_id TEXT/);
});

test('worker launch env binds cursor sessions with the stored API key', () => {
  const launchSource = sliceBetween(
    'function buildSessionWorkerLaunchEnvForSession(',
    '\nconst relayCliLauncherService',
  );
  assert.match(launchSource, /if \(providerType === 'cursor'\) \{/);
  assert.match(launchSource, /applyCursorProviderEnvironment\(cleared, \{/);
  assert.match(launchSource, /apiKey: cursorSettings\.apiKey,/);
});

test('provider reconciliation manages cursor conversations', () => {
  const reconcileSource = sliceBetween(
    'async function reconcileUnstartedConversationProviders(',
    '\nasync function rebindUnstartedOpenAIConversationModel(',
  );
  assert.match(reconcileSource, /\['claude', 'cursor', 'grok'\]\.includes\(normalizedProvider\)/);
  assert.match(reconcileSource, /cursor: DEFAULT_CURSOR_MODEL,/);
  assert.match(
    reconcileSource,
    /currentProvider === 'cursor'\s*\?\s*getCursorProviderSettings\(\)\.configured === true/,
    'rollback must only restore a cursor binding while the key is still configured',
  );
});

test('runtime session binding honors an explicit cursor provider type', () => {
  const bindingSource = sliceBetween(
    'function ensureRuntimeSessionBinding(',
    '\nfunction bootstrapRuntimeSessionBindings(',
  );
  assert.match(bindingSource, /normalizedRequestedProviderType === 'cursor'\s*\?\s*'cursor'/);
  assert.match(bindingSource, /resolvedProviderType === 'cursor'/);
});

test('shared route deps export the cursor settings trio', () => {
  const depsSource = sliceBetween(
    'const sharedRouteDeps = {',
    '\nregisterMessagesRoutes(app, sharedRouteDeps);',
  );
  assert.match(depsSource, /\n  getCursorProviderSettings,\n  setCursorProviderSettings,\n  refreshCursorProviderModels,\n/);
});

test('cursor model discovery is timeout-guarded around @cursor/sdk', () => {
  const refreshSource = sliceBetween(
    'async function refreshCursorProviderModels(',
    '\nconst DEFAULT_CONFIG',
  );
  assert.match(refreshSource, /await import\('@cursor\/sdk'\)/);
  assert.match(refreshSource, /CURSOR_MODEL_DISCOVERY_TIMEOUT_MS/);
  assert.match(source, /const CURSOR_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;/);
});

test('cursor model discovery persists per-model effort tiers', () => {
  const refreshSource = sliceBetween(
    'async function refreshCursorProviderModels(',
    '\nconst DEFAULT_CONFIG',
  );
  assert.match(refreshSource, /cursorEntryEffortLevels\(entry\)/);
  assert.match(refreshSource, /CURSOR_MODEL_EFFORTS_SETTING_KEY, JSON\.stringify\(effortsByModel\)/);
  assert.match(source, /const CURSOR_MODEL_EFFORTS_SETTING_KEY = 'cursor_model_efforts';/);
});

test('cursorEntryEffortLevels maps effort/reasoning params into composer tiers', () => {
  // The mapper is pure, so evaluate its source directly against live-shaped
  // models.list entries rather than asserting on its text.
  const mapperSource = sliceBetween(
    'function cursorEntryEffortLevels(entry) {',
    '\nasync function refreshCursorProviderModels(',
  );
  const cursorEntryEffortLevels = new Function(
    'CURSOR_EFFORT_LEVELS',
    `${mapperSource}\nreturn cursorEntryEffortLevels;`,
  )(new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']));

  assert.deepEqual(cursorEntryEffortLevels({
    id: 'gpt-5.4',
    parameters: [
      { id: 'context', values: [{ value: '272k' }] },
      { id: 'reasoning', values: [{ value: 'none' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'extra-high' }] },
    ],
  }), ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(cursorEntryEffortLevels({
    id: 'claude-opus-5',
    parameters: [
      { id: 'thinking', values: [{ value: 'false' }, { value: 'true' }] },
      { id: 'effort', values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }, { value: 'max' }] },
    ],
  }), ['low', 'medium', 'high', 'xhigh', 'max']);
  // Values with no composer tier (e.g. 'minimal') drop instead of remapping.
  assert.deepEqual(cursorEntryEffortLevels({
    id: 'gemini-3.6-flash',
    parameters: [{ id: 'effort', values: [{ value: 'minimal' }, { value: 'low' }, { value: 'high' }] }],
  }), ['low', 'high']);
  assert.deepEqual(cursorEntryEffortLevels({ id: 'composer-2.5', parameters: [{ id: 'fast', values: [{ value: 'true' }] }] }), []);
  assert.deepEqual(cursorEntryEffortLevels({ id: 'plain' }), []);
  assert.deepEqual(cursorEntryEffortLevels('string-entry'), []);
});

test('cursor settings expose per-model efforts with a none-first ladder', () => {
  const settingsSource = sliceBetween(
    'function getCursorProviderSettings() {',
    '\nfunction setCursorProviderSettings(',
  );
  assert.match(settingsSource, /readCursorModelEffortsSetting\(\)/);
  assert.match(settingsSource, /effortsByModel\[key\] = \['none',[\s\S]*?discoveredEfforts\.filter\([\s\S]*?!== 'none'/);
  // Key rotation and removal both invalidate the discovered efforts.
  const updateSource = sliceBetween(
    'function setCursorProviderSettings(',
    '\nconst CURSOR_MODEL_DISCOVERY_TIMEOUT_MS',
  );
  const effortDeletes = updateSource.match(/stmts\.deleteAppSetting\.run\(CURSOR_MODEL_EFFORTS_SETTING_KEY\);/g) || [];
  assert.equal(effortDeletes.length, 2);
});

test('cursor settings honor the Select Models enabled subset', () => {
  assert.match(source, /const CURSOR_ENABLED_MODELS_SETTING_KEY = 'cursor_enabled_models';/);
  const settingsSource = sliceBetween(
    'function getCursorProviderSettings() {',
    '\nfunction setCursorProviderSettings(',
  );
  // The enabled subset is filtered against the discovered list, and an empty
  // selection falls back to every available model (mirrors Claude).
  assert.match(settingsSource, /isSafeCursorModelId\(modelId\) && availableSet\.has\(modelId\)/);
  assert.match(settingsSource, /\.\.\.\(enabledSelection\.length \? enabledSelection : availableModels\),/);
  assert.match(settingsSource, /availableModels,[\s\S]{0,80}?enabledModels: resolvedModels,/);
  const updateSource = sliceBetween(
    'function setCursorProviderSettings(',
    '\nconst CURSOR_MODEL_DISCOVERY_TIMEOUT_MS',
  );
  assert.match(updateSource, /CURSOR_ENABLED_MODELS_SETTING_KEY, JSON\.stringify\(normalizedEnabledModels\)/);
  // Key removal clears the subset along with the discovered models.
  assert.match(updateSource, /stmts\.deleteAppSetting\.run\(CURSOR_ENABLED_MODELS_SETTING_KEY\);\n\s*stmts\.deleteAppSetting\.run\(CURSOR_MODEL_EFFORTS_SETTING_KEY\);/);
});

test('shared route deps export the cursor session-root resolver', () => {
  const depsSource = sliceBetween(
    'const sharedRouteDeps = {',
    '\nregisterMessagesRoutes(app, sharedRouteDeps);',
  );
  assert.match(depsSource, /resolveCursorSessionRoot: cursorSessionRootResolver\.resolveCursorSessionRoot,/);
});

// ─── updateRuntimeSessionCursorAgentId column gating ─────────────────────────

function newDb({ withCursorAgentId }) {
  const db = new Database(':memory:');
  applySchema(db);
  if (!withCursorAgentId) {
    // The real schema always has cursor_agent_id; this variant deliberately
    // recreates the pre-migration runtime_sessions shape so the repository's
    // column gating (updateRuntimeSessionCursorAgentId === null) is testable.
    db.exec(`
      DROP TABLE runtime_sessions;
      CREATE TABLE runtime_sessions (
        id TEXT PRIMARY KEY, conversation_id TEXT UNIQUE, strategy TEXT, runtime_key TEXT,
        model TEXT, status TEXT, created_at TEXT, last_used_at TEXT, sdk_session_id TEXT,
        provider_type TEXT NOT NULL DEFAULT 'github', provider_model TEXT
      );
    `);
  }
  return db;
}

test('updateRuntimeSessionCursorAgentId persists the agent id when the column exists', () => {
  const db = newDb({ withCursorAgentId: true });
  const stmts = createSessionRepository(db);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at, configured_workspace_root_path) VALUES (?, ?, ?, ?, ?)`)
    .run('conv-cursor-1', 'Cursor conversation', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '/home/dev');
  stmts.insertRuntimeSession.run(
    'rs-cursor-1', 'conv-cursor-1', 'isolated', 'rs-cursor-1', 'composer-2.5',
    '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', null, 'cursor', 'composer-2.5',
  );

  stmts.updateRuntimeSessionCursorAgentId.run('agent-abc-123', '2026-08-01T00:05:00.000Z', 'conv-cursor-1');

  const row = stmts.getRuntimeSessionByConversation.get('conv-cursor-1');
  assert.equal(row.cursor_agent_id, 'agent-abc-123');
  assert.equal(row.last_used_at, '2026-08-01T00:05:00.000Z');
  db.close();
});

test('updateRuntimeSessionCursorAgentId is null when the column is absent', () => {
  const db = newDb({ withCursorAgentId: false });
  const stmts = createSessionRepository(db);
  assert.equal(stmts.updateRuntimeSessionCursorAgentId, null);
  db.close();
});
