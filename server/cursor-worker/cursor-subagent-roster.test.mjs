import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCursorSubagentAgents,
  cursorSubagentName,
  cursorSubagentRosterFingerprint,
} from './cursor-subagent-roster.mjs';

test('subagent names dash the model id so the live-probed form is used', () => {
  assert.equal(cursorSubagentName('grok-4.5'), 'grok-4-5');
  assert.equal(cursorSubagentName('composer-2.5'), 'composer-2-5');
  assert.equal(cursorSubagentName('claude-opus-5'), 'claude-opus-5');
  assert.equal(cursorSubagentName('  GPT-5.6-Luna '), 'gpt-5-6-luna');
  assert.equal(cursorSubagentName(''), '');
});

test('each enabled model becomes a subagent pinned to that model id', () => {
  const agents = buildCursorSubagentAgents(['grok-4.5', 'claude-opus-5']);

  assert.deepEqual(Object.keys(agents), ['grok-4-5', 'claude-opus-5']);
  assert.deepEqual(agents['grok-4-5'].model, { id: 'grok-4.5' });
  assert.deepEqual(agents['claude-opus-5'].model, { id: 'claude-opus-5' });
  // No `params`: the SDK drops them converting to its runtime custom-subagent
  // shape, so pinning an effort tier is not expressible here.
  assert.equal(Object.keys(agents['grok-4-5'].model).length, 1);
  for (const definition of Object.values(agents)) {
    assert.equal(typeof definition.description, 'string');
    assert.equal(typeof definition.prompt, 'string');
  }
});

test('descriptions carry the undashed model id so a catalog-spelled request still matches', () => {
  const agents = buildCursorSubagentAgents(['grok-4.5']);
  assert.match(agents['grok-4-5'].description, /grok-4\.5/);
  assert.match(agents['grok-4-5'].prompt, /grok-4\.5/);
});

test('routing aliases are not pinnable and are dropped', () => {
  const agents = buildCursorSubagentAgents(['default', 'auto', 'AUTO', 'grok-4.5']);
  assert.deepEqual(Object.keys(agents), ['grok-4-5']);
});

test('unsafe, empty, and non-array input yields an empty roster', () => {
  assert.deepEqual(buildCursorSubagentAgents(['bad model !!', '', '   ']), {});
  assert.deepEqual(buildCursorSubagentAgents([]), {});
  assert.deepEqual(buildCursorSubagentAgents(null), {});
  assert.deepEqual(buildCursorSubagentAgents(undefined), {});
});

test('names that collapse onto each other keep the first model only', () => {
  const agents = buildCursorSubagentAgents(['gpt-5.4', 'gpt-5-4']);
  assert.deepEqual(Object.keys(agents), ['gpt-5-4']);
  assert.deepEqual(agents['gpt-5-4'].model, { id: 'gpt-5.4' });
});

test('roster order follows the caller so the fingerprint is a function of input', () => {
  assert.deepEqual(
    Object.keys(buildCursorSubagentAgents(['claude-opus-5', 'grok-4.5'])),
    ['claude-opus-5', 'grok-4-5'],
  );
});

test('fingerprint tracks the usable models and ignores dropped entries', () => {
  const base = cursorSubagentRosterFingerprint(['grok-4.5', 'claude-opus-5']);
  assert.equal(base, cursorSubagentRosterFingerprint(['grok-4.5', 'default', 'claude-opus-5']));
  assert.equal(base, cursorSubagentRosterFingerprint(['grok-4.5', 'bad model !!', 'claude-opus-5']));
  assert.notEqual(base, cursorSubagentRosterFingerprint(['grok-4.5']));
  // Order is part of the identity: a reordered roster rebuilds the handle,
  // which is cheap, rather than risking a stale menu.
  assert.notEqual(base, cursorSubagentRosterFingerprint(['claude-opus-5', 'grok-4.5']));
  assert.equal(cursorSubagentRosterFingerprint([]), '');
  assert.equal(cursorSubagentRosterFingerprint(null), '');
});
