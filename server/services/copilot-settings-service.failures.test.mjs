import test from 'node:test';
import assert from 'node:assert/strict';

// The Copilot switch when its database steps fail. The two states belong to
// the process, so each test loads its own copy of the module.
let copies = 0;
const freshModule = () => import(`./copilot-settings-service.mjs?failures=${copies += 1}`);

function store(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    readSetting: (key) => values.get(key) ?? '',
    writeSetting: (key, value) => { writes.push([key, value]); values.set(key, value); },
  };
}

test('migration 0043 failed: an unset switch reads off, with or without a detector, and nothing is detected or written', async () => {
  const { noteCopilotSwitchMigrationFailed, readCopilotEnabled, copilotEnabledFromStmts } = await freshModule();
  noteCopilotSwitchMigrationFailed();
  const settings = store();
  let detections = 0;
  const detectCli = () => { detections += 1; return true; };
  for (let read = 0; read < 3; read += 1) {
    assert.equal(readCopilotEnabled({ ...settings, detectCli }), false);
    assert.equal(readCopilotEnabled({ ...settings }), false, 'no detector: off too');
  }
  assert.equal(detections, 0);
  assert.deepEqual(settings.writes, []);
  // The route modules read through their statements: the same answer.
  const upserts = [];
  const stmts = { getAppSetting: { get: () => undefined }, upsertAppSetting: { run: (...args) => upserts.push(args) } };
  assert.equal(copilotEnabledFromStmts(stmts, { detectCli }), false);
  assert.deepEqual(upserts, []);
});

test('migration 0043 failed: a switch set by hand (or before) reads as stored', async () => {
  const { noteCopilotSwitchMigrationFailed, readCopilotEnabled, writeCopilotEnabled } = await freshModule();
  noteCopilotSwitchMigrationFailed();
  const settings = store();
  writeCopilotEnabled({ writeSetting: settings.writeSetting, enabled: true });
  assert.equal(readCopilotEnabled({ ...settings, detectCli: () => false }), true);
  assert.equal(readCopilotEnabled({ ...store({ copilot_enabled: 'false' }), detectCli: () => true }), false);
});

test('without a failed migration nothing changes: detected once and written', async () => {
  const { readCopilotEnabled } = await freshModule();
  const settings = store();
  assert.equal(readCopilotEnabled({ ...settings, detectCli: () => true }), true);
  assert.deepEqual(settings.writes, [['copilot_enabled', 'true']]);
});

test('a detected switch that cannot be written: the read answers it, never throws, warns once, and tries again later', async () => {
  const { readCopilotEnabled, copilotEnabledFromStmts } = await freshModule();
  const warnings = [];
  let attempts = 0;
  const failing = {
    readSetting: () => '',
    writeSetting: () => { attempts += 1; throw new Error('attempt to write a readonly database'); },
    warn: (line) => warnings.push(line),
  };
  assert.equal(readCopilotEnabled({ ...failing, detectCli: () => false }), false);
  assert.equal(readCopilotEnabled({ ...failing, detectCli: () => true }), true);
  assert.equal(attempts, 2, 'each read tries the write again');
  assert.deepEqual(warnings, [
    '[copilot] the Copilot switch could not be saved (attempt to write a readonly database): Copilot is off for now, as detected, and the next start decides it again',
  ]);
  // Through the statements a route reads with: no throw either.
  const stmts = { getAppSetting: { get: () => undefined }, upsertAppSetting: { run: () => { throw new Error('SQLITE_BUSY'); } } };
  assert.equal(copilotEnabledFromStmts(stmts, { detectCli: () => true }), true);
  // A warn that throws is no throw of the read.
  const { readCopilotEnabled: readAgain } = await freshModule();
  assert.equal(readAgain({ ...failing, warn: () => { throw new Error('closed'); }, detectCli: () => true }), true);
});
