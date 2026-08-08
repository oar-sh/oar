import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { createSessionRepository } from './repositories/session-repository.mjs';

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

test('runtime_sessions migration adds the cursor_agent_id column', () => {
  const migrationSource = sliceBetween(
    'const runtimeSessionColumns = db.prepare(`PRAGMA table_info(runtime_sessions)`)',
    'const conversationColumns = ',
  );
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

const BASE_SCHEMA = `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY, title TEXT, title_source TEXT, archived INTEGER NOT NULL DEFAULT 0,
    compacted_into TEXT, compacted_from TEXT, sdk_session_id TEXT, preferred_relay_mode TEXT,
    preferred_model TEXT, preferred_reasoning_effort TEXT, configured_workspace_root_path TEXT,
    runtime_workspace_root_path TEXT, draft_text TEXT, draft_updated_at TEXT,
    draft_updated_by_client_id TEXT, summary_seed TEXT, seed_pending INTEGER,
    status TEXT NOT NULL DEFAULT 'active', created_at TEXT, updated_at TEXT
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, text TEXT, model TEXT, mode TEXT,
    attachments TEXT, timestamp TEXT, model_requested TEXT, model_actual TEXT, model_origin TEXT
  );
  CREATE TABLE queue (
    id TEXT PRIMARY KEY, conversation_id TEXT, runtime_session_id TEXT, is_new_conversation INTEGER,
    model TEXT, model_variant_id TEXT, reasoning_effort TEXT, relay_mode TEXT, text TEXT,
    attachments TEXT, status TEXT, timestamp TEXT, retry_count INTEGER, next_attempt_at TEXT,
    processing_at TEXT, response TEXT, response_message_id TEXT
  );
  CREATE TABLE deleted_sdk_sessions (sdk_session_id TEXT PRIMARY KEY, deleted_at TEXT);
  CREATE TABLE recent_workspace_roots (path_key TEXT PRIMARY KEY, path TEXT NOT NULL, last_seen_at TEXT NOT NULL);
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  CREATE TABLE sdk_delete_requests (
    sdk_session_id TEXT PRIMARY KEY, conversation_id TEXT, status TEXT, requested_at TEXT,
    updated_at TEXT, processing_at TEXT, retry_count INTEGER, next_attempt_at TEXT, last_error TEXT
  );
  CREATE TABLE sdk_session_imports (
    sdk_session_id TEXT PRIMARY KEY, conversation_id TEXT, status TEXT, attempt_count INTEGER,
    started_at TEXT, completed_at TEXT, source_started_at TEXT, source_modified_at TEXT,
    updated_at TEXT, last_error TEXT
  );
  CREATE TABLE conversation_shares (
    token TEXT PRIMARY KEY, conversation_id TEXT, created_at TEXT, last_accessed_at TEXT, revoked_at TEXT
  );
`;

function runtimeSessionsSchema({ withCursorAgentId }) {
  return `
    CREATE TABLE runtime_sessions (
      id TEXT PRIMARY KEY, conversation_id TEXT UNIQUE, strategy TEXT, runtime_key TEXT,
      model TEXT, status TEXT, created_at TEXT, last_used_at TEXT, sdk_session_id TEXT,
      provider_type TEXT NOT NULL DEFAULT 'github', provider_model TEXT
      ${withCursorAgentId ? ', cursor_agent_id TEXT' : ''}
    );
  `;
}

function newDb({ withCursorAgentId }) {
  const db = new Database(':memory:');
  db.exec(BASE_SCHEMA);
  db.exec(runtimeSessionsSchema({ withCursorAgentId }));
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
