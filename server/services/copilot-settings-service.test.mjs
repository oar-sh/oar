import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { makeRouteDeps, recordingStmts } from '../routes/messages-routes-test-harness.mjs';
import {
  COPILOT_ENABLED_SETTING_KEY,
  copilotEnabledFromStmts,
  createCopilotCliDetector,
  isCopilotProviderType,
  copilotSettingsPayload,
  parseCopilotEnabledSetting,
  parseCopilotSettingsUpdateRequest,
  readCopilotEnabled,
  writeCopilotEnabled,
} from './copilot-settings-service.mjs';

const NOW = new Date('2026-11-16T22:30:00.000Z');

function settingsStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    readSetting: (key) => values.get(key) ?? '',
    writeSetting: (key, value, stamp) => {
      writes.push({ key, value, stamp });
      values.set(key, value);
    },
  };
}

test('the key is copilot_enabled; stored text reads as true, false or unset', () => {
  assert.equal(COPILOT_ENABLED_SETTING_KEY, 'copilot_enabled');
  assert.equal(parseCopilotEnabledSetting('true'), true);
  assert.equal(parseCopilotEnabledSetting(' FALSE '), false);
  assert.equal(parseCopilotEnabledSetting(''), null);
  assert.equal(parseCopilotEnabledSetting(null), null);
  assert.equal(parseCopilotEnabledSetting('yes'), null);
});

test('a stored value wins; the detector is never asked and nothing is written', () => {
  for (const [stored, expected] of [['true', true], ['false', false]]) {
    const store = settingsStore({ copilot_enabled: stored });
    let asked = 0;
    assert.equal(readCopilotEnabled({ ...store, detectCli: () => { asked += 1; return !expected; } }), expected);
    assert.equal(asked, 0);
    assert.deepEqual(store.writes, []);
  }
});

test('unset without a detector reads as on and writes nothing', () => {
  const store = settingsStore();
  assert.equal(readCopilotEnabled(store), true);
  assert.equal(readCopilotEnabled({ readSetting: store.readSetting }), true);
  assert.deepEqual(store.writes, []);
});

test('unset with a detector: detected once, written, never flipped by a later detection', () => {
  const found = settingsStore();
  let calls = 0;
  const detectFound = () => { calls += 1; return true; };
  assert.equal(readCopilotEnabled({ ...found, detectCli: detectFound, now: () => NOW }), true);
  assert.deepEqual(found.writes, [{ key: 'copilot_enabled', value: 'true', stamp: NOW.toISOString() }]);
  assert.equal(readCopilotEnabled({ ...found, detectCli: () => false }), true, 'detection never flips it');
  assert.equal(calls, 1);
  assert.equal(found.writes.length, 1);

  const missing = settingsStore();
  assert.equal(readCopilotEnabled({ ...missing, detectCli: () => null, now: () => NOW }), false);
  assert.deepEqual(missing.writes, [{ key: 'copilot_enabled', value: 'false', stamp: NOW.toISOString() }]);
});

test('a detector that throws counts as not found; an unreadable setting counts as unset', () => {
  const store = settingsStore();
  assert.equal(readCopilotEnabled({ ...store, detectCli: () => { throw new Error('ENOENT'); } }), false);
  assert.equal(store.values.get('copilot_enabled'), 'false');
  assert.equal(readCopilotEnabled({ readSetting: () => { throw new Error('locked'); } }), true);
});

test('writeCopilotEnabled stores the user\'s choice', () => {
  const store = settingsStore({ copilot_enabled: 'true' });
  assert.equal(writeCopilotEnabled({ writeSetting: store.writeSetting, enabled: false, now: () => NOW }), false);
  assert.equal(store.values.get('copilot_enabled'), 'false');
  assert.equal(writeCopilotEnabled({ writeSetting: store.writeSetting, enabled: true, now: () => NOW }), true);
  assert.equal(store.values.get('copilot_enabled'), 'true');
  assert.throws(() => writeCopilotEnabled({ enabled: true }), /cannot be saved/);
});

test('parseCopilotSettingsUpdateRequest takes a boolean enabled only', () => {
  assert.deepEqual(parseCopilotSettingsUpdateRequest({ enabled: false }), { ok: true, enabled: false });
  assert.deepEqual(parseCopilotSettingsUpdateRequest({ enabled: true, engine: 'cli' }), { ok: true, enabled: true });
  assert.equal(parseCopilotSettingsUpdateRequest({}).ok, false);
  assert.equal(parseCopilotSettingsUpdateRequest({ enabled: 'false' }).ok, false);
  assert.equal(parseCopilotSettingsUpdateRequest(null).ok, false);
});

test('copilotSettingsPayload keeps the engine fields and adds enabled and cliFound', () => {
  assert.deepEqual(copilotSettingsPayload(), { engine: 'sdk', engines: ['sdk'], enabled: true, cliFound: false });
  assert.deepEqual(
    copilotSettingsPayload({ engine: 'sdk', engines: ['sdk'], enabled: false, cliFound: true }),
    { engine: 'sdk', engines: ['sdk'], enabled: false, cliFound: true },
  );
});

test('route side: the harness stand-ins read Copilot on and write nothing', () => {
  assert.equal(copilotEnabledFromStmts(makeRouteDeps().stmts), true);
  assert.equal(copilotEnabledFromStmts(undefined), true);
  const { calls, stmts } = recordingStmts();
  assert.equal(copilotEnabledFromStmts(stmts), true);
  assert.deepEqual(calls, []);
});

test('route side: an applySchema database reads on without a detector and keeps the key unset', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = createSessionRepository(db);
  assert.equal(copilotEnabledFromStmts(stmts), true);
  assert.equal(stmts.getAppSetting.get('copilot_enabled'), undefined);
});

test('route side: with a detector, two reads ask it once and write once', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = createSessionRepository(db);
  let calls = 0;
  const detectCli = () => { calls += 1; return false; };
  assert.equal(copilotEnabledFromStmts(stmts, { detectCli, now: () => NOW }), false);
  assert.equal(copilotEnabledFromStmts(stmts, { detectCli }), false);
  assert.equal(calls, 1);
  assert.deepEqual({ ...stmts.getAppSetting.get('copilot_enabled') }, { key: 'copilot_enabled', value: 'false', updated_at: NOW.toISOString() });
  stmts.upsertAppSetting.run('copilot_enabled', 'true', NOW.toISOString());
  assert.equal(copilotEnabledFromStmts(stmts, { detectCli }), true);
});

test('the CLI detector: installed paths are found; a resolver that throws (no CLI) or none is not', () => {
  const found = createCopilotCliDetector({ resolveInstalledPaths: () => ({ sdkPath: '/opt/copilot/sdk/index.js', cliPath: '/opt/copilot/app.js', version: '1.0.9' }) });
  assert.equal(found(), true);
  const missing = createCopilotCliDetector({ resolveInstalledPaths: () => { throw Object.assign(new Error('Copilot SDK not found'), { code: 'COPILOT_SDK_NOT_FOUND' }); } });
  assert.equal(missing(), false);
  assert.equal(createCopilotCliDetector()(), false);
});

test('a host with the CLI: a new database reads Copilot on, written once, and cliFound is true', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = createSessionRepository(db);
  let resolves = 0;
  const detectCli = createCopilotCliDetector({ resolveInstalledPaths: () => { resolves += 1; return { sdkPath: '/x', cliPath: '/y' }; } });
  assert.equal(copilotEnabledFromStmts(stmts, { detectCli }), true);
  assert.equal(copilotEnabledFromStmts(stmts, { detectCli }), true);
  assert.equal(resolves, 1, 'two reads, one detection');
  assert.equal(stmts.getAppSetting.get('copilot_enabled').value, 'true');
  assert.equal(copilotSettingsPayload({ enabled: true, cliFound: detectCli() }).cliFound, true);
});

test('a Copilot chat is provider github or none; an OpenAI chat (same worker, own switch) is not', () => {
  for (const type of ['github', 'GitHub', '', null, undefined]) assert.equal(isCopilotProviderType(type), true, String(type));
  for (const type of ['openai', 'openai-image', 'claude', 'claude-api', 'cursor', 'grok', 'deepseek', 'claude-cloud']) {
    assert.equal(isCopilotProviderType(type), false, type);
  }
});
