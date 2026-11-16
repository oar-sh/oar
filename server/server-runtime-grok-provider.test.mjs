'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWorkerKind } from './services/session-worker-launch-service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8');
const launchSource = fs.readFileSync(path.join(__dirname, 'services', 'session-worker-launch-service.mjs'), 'utf8');
const dbSchemaSource = fs.readFileSync(path.join(__dirname, 'db-schema.mjs'), 'utf8');
const sessionsSource = fs.readFileSync(path.join(__dirname, 'routes', 'sessions-routes.mjs'), 'utf8');
const settingsSource = fs.readFileSync(path.join(__dirname, 'routes', 'settings-routes.mjs'), 'utf8');
const bootstrapSource = fs.readFileSync(path.join(__dirname, 'routes', 'conversation-bootstrap-routes.mjs'), 'utf8');
const intakeSource = fs.readFileSync(path.join(__dirname, 'routes', 'messages-intake-routes.mjs'), 'utf8');
const workerReportSource = fs.readFileSync(path.join(__dirname, 'routes', 'messages-worker-report-routes.mjs'), 'utf8');
const workerClaimSource = fs.readFileSync(path.join(__dirname, 'routes', 'messages-worker-claim-routes.mjs'), 'utf8');

test('launch service recognizes grok worker kind and script path', () => {
  // The kind list used to be spelled out inside resolveWorkerKind; it is now
  // derived from the descriptor table asserted below, so this checks the
  // BEHAVIOUR rather than a literal that no longer exists.
  assert.equal(resolveWorkerKind({ COPILOT_WEB_RELAY_WORKER_KIND: 'grok' }), 'grok');
  assert.match(launchSource, /export function applyGrokProviderEnvironment/);
  assert.match(launchSource, /grok: Object\.freeze\(\{ resolveScriptPath: resolveGrokWorkerScriptPath/);
  assert.match(launchSource, /GROK_RELAY_MODEL/);
});

test('server-runtime exposes grok settings and launch binding', () => {
  assert.match(runtimeSource, /function getGrokProviderSettings\(/);
  assert.match(runtimeSource, /function setGrokProviderSettings\(/);
  assert.match(runtimeSource, /async function refreshGrokProviderModels\(/);
  assert.match(runtimeSource, /providerType === 'grok'/);
  assert.match(runtimeSource, /getGrokProviderSettings,/);
  // The schema/migration block (including the grok_native_session_id column)
  // moved verbatim to db-schema.mjs.
  assert.match(dbSchemaSource, /grok_native_session_id/);
  assert.match(runtimeSource, /managedProvider = \['claude', 'cursor', 'grok', 'deepseek', 'claude-api'\]/);
});

test('sessions-routes bootstrap and settings accept grok', () => {
  assert.match(sessionsSource, /buildModelCatalogWithGrokProvider/);
  assert.match(settingsSource, /parseGrokSettingsUpdateRequest/);
  assert.match(settingsSource, /\/api\/settings\/grok/);
  assert.match(bootstrapSource, /useGrokProvider/);
  assert.match(bootstrapSource, /GROK_NOT_CONFIGURED/);
  assert.match(bootstrapSource, /normalized === 'grok'/);
  assert.match(sessionsSource, /grokModels:/);
});

test('messages-routes dequeue and native session route support grok', () => {
  assert.match(workerClaimSource, /grokNativeSessionId/);
  assert.match(workerReportSource, /\/api\/grok-native-session/);
  assert.match(intakeSource, /runtimeUsesGrok/);
  assert.match(workerReportSource, /updateRuntimeSessionGrokNativeSessionId/);
});

test('grok worker package entrypoints exist', () => {
  const workerDir = path.join(__dirname, 'grok-worker');
  for (const name of [
    'acp-client.mjs',
    'sdk-message-normalizer.mjs',
    'grok-sdk-adapter.mjs',
    'grok-turn-runner.mjs',
    'grok-session-worker.mjs',
  ]) {
    assert.equal(fs.existsSync(path.join(workerDir, name)), true, name);
  }
});
