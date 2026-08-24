import test from 'node:test';
import assert from 'node:assert/strict';

import {
  firstDefinedPreference,
  normalizePreferenceValue,
  resolveComposerReasoningEffort,
  resolveConversationComposerSelection,
} from './conversation-preferences.mjs';

test('blank preferences fall through to the next source', () => {
  assert.equal(firstDefinedPreference('', '   ', 'agent'), 'agent');
  assert.equal(firstDefinedPreference(null, undefined, ''), '');
  assert.equal(normalizePreferenceValue('  grok-4.5 '), 'grok-4.5');
  assert.equal(normalizePreferenceValue(null), '');
});

test('a preferred model wins over the currently selected one', () => {
  const selection = resolveConversationComposerSelection({
    preferredRelayMode: 'plan',
    preferredModel: 'grok-4.5',
    selectedMode: 'agent',
    selectedModel: 'claude-opus-5',
    supportedModes: ['agent', 'plan'],
    supportedModels: ['grok-4.5', 'composer-2.5'],
  });
  assert.equal(selection.mode, 'plan');
  assert.equal(selection.model, 'grok-4.5');
});

test('a case-variant preferred model resolves to the catalog entry', () => {
  const selection = resolveConversationComposerSelection({
    preferredModel: 'grok-4.5',
    supportedModels: ['composer-2.5', 'Grok-4.5'],
  });
  assert.equal(selection.model, 'Grok-4.5');
});

test('the conversation effort outranks whatever the previous chat left selected', () => {
  assert.equal(resolveComposerReasoningEffort({
    preferredEffort: 'high',
    storedEffort: 'low',
    currentEffort: 'low',
    supportedEfforts: ['none', 'low', 'medium', 'high'],
  }), 'high');
});

test('an unsupported effort falls through to storage, then to the current value', () => {
  assert.equal(resolveComposerReasoningEffort({
    preferredEffort: 'max',
    storedEffort: 'medium',
    currentEffort: 'low',
    supportedEfforts: ['none', 'low', 'medium'],
  }), 'medium');
  assert.equal(resolveComposerReasoningEffort({
    preferredEffort: 'max',
    storedEffort: 'xhigh',
    currentEffort: 'low',
    supportedEfforts: ['none', 'low'],
  }), 'low');
});

test('with nothing usable the first non-off tier is chosen', () => {
  assert.equal(resolveComposerReasoningEffort({ supportedEfforts: ['none', 'low', 'high'] }), 'low');
  assert.equal(resolveComposerReasoningEffort({ supportedEfforts: ['none'] }), 'none');
  assert.equal(resolveComposerReasoningEffort({ supportedEfforts: [] }), '');
});

test('ultracode follows a preference but is never the fallback tier', () => {
  const claudeLadder = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
  assert.equal(resolveComposerReasoningEffort({
    preferredEffort: 'ultracode',
    supportedEfforts: claudeLadder,
  }), 'ultracode');
  // Nothing stored: the expensive top rung must not be a silent default.
  assert.equal(resolveComposerReasoningEffort({ supportedEfforts: claudeLadder }), 'low');
  // Model switch to a non-xhigh model drops the remembered ultracode cleanly.
  assert.equal(resolveComposerReasoningEffort({
    preferredEffort: 'ultracode',
    supportedEfforts: ['none', 'low', 'medium', 'high'],
  }), 'low');
});
