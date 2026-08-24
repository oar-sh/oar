'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8');
const launchSource = fs.readFileSync(path.join(__dirname, 'services', 'session-worker-launch-service.mjs'), 'utf8');
const dbSchemaSource = fs.readFileSync(path.join(__dirname, 'db-schema.mjs'), 'utf8');
const sessionsSource = fs.readFileSync(path.join(__dirname, 'routes', 'sessions-routes.mjs'), 'utf8');
const messagesSource = fs.readFileSync(path.join(__dirname, 'routes', 'messages-routes.mjs'), 'utf8');

test('launch service recognizes grok worker kind and script path', () => {
  assert.match(launchSource, /kind === 'claude' \|\| kind === 'cursor' \|\| kind === 'grok'/);
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
  assert.match(runtimeSource, /managedProvider = \['claude', 'cursor', 'grok'\]/);
});

test('sessions-routes bootstrap and settings accept grok', () => {
  assert.match(sessionsSource, /buildModelCatalogWithGrokProvider/);
  assert.match(sessionsSource, /parseGrokSettingsUpdateRequest/);
  assert.match(sessionsSource, /\/api\/settings\/grok/);
  assert.match(sessionsSource, /useGrokProvider/);
  assert.match(sessionsSource, /GROK_NOT_CONFIGURED/);
  assert.match(sessionsSource, /normalized === 'grok'/);
  assert.match(sessionsSource, /grokModels:/);
});

test('messages-routes dequeue and native session route support grok', () => {
  assert.match(messagesSource, /grokNativeSessionId/);
  assert.match(messagesSource, /\/api\/grok-native-session/);
  assert.match(messagesSource, /runtimeUsesGrok/);
  assert.match(messagesSource, /updateRuntimeSessionGrokNativeSessionId/);
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
