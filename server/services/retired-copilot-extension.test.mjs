import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanUpCopilotWrapperAtStart, retiredCopilotEngineLine } from './retired-copilot-extension.mjs';

const settings = (rows) => (key) => (key in rows ? rows[key] : null);

test('a stored copilot_engine=extension is named in one line that says what runs instead', () => {
  const read = [];
  const line = retiredCopilotEngineLine({ readSetting: (key) => { read.push(key); return 'extension'; } });
  assert.equal(line, 'the Copilot Extension engine is gone, Copilot runs on the SDK worker; ignoring copilot_engine=extension (app setting)');
  assert.deepEqual(read, ['copilot_engine'], 'read once, and nothing else');
  assert.equal(retiredCopilotEngineLine({ readSetting: settings({ copilot_engine: ' Extension ' }) }), line);
});

test('no line for the sdk engine, another value, no stored value, or a table that cannot be read', () => {
  for (const value of ['sdk', 'SDK', '', 'extensions', 'something-else', null, undefined, 0]) {
    assert.equal(retiredCopilotEngineLine({ readSetting: settings({ copilot_engine: value }) }), null, String(value));
  }
  assert.equal(retiredCopilotEngineLine({ readSetting: settings({}) }), null);
  assert.equal(retiredCopilotEngineLine({ readSetting: () => { throw new Error('no such table: app_settings'); } }), null);
  assert.equal(retiredCopilotEngineLine({}), null);
  assert.equal(retiredCopilotEngineLine(), null);
});

function cleanUp(remove) {
  const lines = [];
  const result = cleanUpCopilotWrapperAtStart({ remove, log: (line) => lines.push(line) });
  return { result, lines };
}

test('a removed wrapper is logged with its path', () => {
  const removed = { status: 'removed', path: '/home/dev/.copilot/extensions/web-relay/extension.mjs' };
  const { result, lines } = cleanUp(() => removed);
  assert.equal(result, removed);
  assert.deepEqual(lines, ['removed the Copilot CLI extension wrapper of an earlier version: /home/dev/.copilot/extensions/web-relay/extension.mjs']);
});

test('a wrapper that could not be removed is logged with the error and what follows from it', () => {
  const wrapper = '/home/dev/.copilot/extensions/web-relay/extension.mjs';
  assert.deepEqual(cleanUp(() => ({ status: 'failed', path: wrapper, error: new Error('EACCES: permission denied') })).lines, [
    `could not remove the Copilot CLI extension wrapper of an earlier version ${wrapper}: EACCES: permission denied; the Copilot CLI may report an extension that fails to load until the file is deleted`,
  ]);
  // A remover that throws does not stop the start either.
  const thrown = cleanUp(() => { throw new Error('homedir unavailable'); });
  assert.equal(thrown.result.status, 'failed');
  assert.deepEqual(thrown.lines, [
    'could not remove the Copilot CLI extension wrapper of an earlier version: homedir unavailable; the Copilot CLI may report an extension that fails to load until the file is deleted',
  ]);
});

test('nothing is logged for a wrapper that is absent, not a generated one, or still in use', () => {
  for (const status of ['absent', 'foreign', 'in-use']) {
    const { result, lines } = cleanUp(() => ({ status, path: '/home/dev/.copilot/extensions/web-relay/extension.mjs' }));
    assert.equal(result.status, status);
    assert.deepEqual(lines, []);
  }
  assert.deepEqual(cleanUp(null), { result: null, lines: [] });
});

test('a log that throws does not reach the caller', () => {
  assert.doesNotThrow(() => cleanUpCopilotWrapperAtStart({
    remove: () => ({ status: 'removed', path: '/home/dev/.copilot/extensions/web-relay/extension.mjs' }),
    log: () => { throw new Error('stream closed'); },
  }));
});
