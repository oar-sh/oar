import test from 'node:test';
import assert from 'node:assert/strict';

import {
  firstDefinedPreference,
  nearestSupportedReasoningEffort,
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

test('the fallback tier is the lowest by rung, whatever order the list comes in', () => {
  assert.equal(resolveComposerReasoningEffort({ supportedEfforts: ['high', 'medium', 'none', 'low'] }), 'low');
  assert.equal(resolveComposerReasoningEffort({ supportedEfforts: ['max', 'xhigh'] }), 'xhigh');
  // Off-ladder names (image qualities) keep the list's own order.
  assert.equal(resolveComposerReasoningEffort({ supportedEfforts: ['auto', 'low', 'high'] }), 'auto');
});

test('a caller\'s own fallback replaces the default when no candidate matches', () => {
  assert.equal(nearestSupportedReasoningEffort(['ultracode'], ['none', 'low', 'high'], { fallback: '' }), '');
  assert.equal(nearestSupportedReasoningEffort([], ['none', 'low'], { fallback: 'none' }), 'none');
  // A candidate that clamps still wins over it.
  assert.equal(nearestSupportedReasoningEffort(['max'], ['none', 'low', 'high'], { fallback: '' }), 'high');
});

test('a dropped rung clamps to the highest supported level below it', () => {
  const miniLadder = ['none', 'low', 'medium', 'high', 'xhigh'];
  // gpt-5.6-terra@max → gpt-5.4-mini (no max): xhigh, not the floor.
  assert.equal(resolveComposerReasoningEffort({
    storedEffort: 'max',
    currentEffort: 'max',
    supportedEfforts: miniLadder,
  }), 'xhigh');
  assert.equal(resolveComposerReasoningEffort({
    preferredEffort: 'xhigh',
    supportedEfforts: ['minimal', 'low', 'medium', 'high'],
  }), 'high');
  // 'none' never counts as "below": high → gemini's minimal/low/medium/high keeps high,
  // and low on a model whose ladder is none+medium+high goes UP to medium.
  assert.equal(resolveComposerReasoningEffort({
    preferredEffort: 'low',
    supportedEfforts: ['none', 'medium', 'high'],
  }), 'medium');
  // A remembered 'minimal' on a model whose floor is low lands on low.
  assert.equal(resolveComposerReasoningEffort({
    preferredEffort: 'minimal',
    supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
  }), 'low');
  // 'minimal' is an ordinary rung when the model has it.
  assert.equal(resolveComposerReasoningEffort({
    preferredEffort: 'minimal',
    supportedEfforts: ['minimal', 'low', 'medium', 'high'],
  }), 'minimal');
  assert.equal(resolveComposerReasoningEffort({
    preferredEffort: 'none',
    supportedEfforts: ['minimal', 'low', 'medium', 'high'],
  }), 'minimal', 'a remembered off-switch on a model without one takes the floor');
  assert.equal(resolveComposerReasoningEffort({
    preferredEffort: 'none',
    supportedEfforts: ['none', 'low'],
  }), 'none', 'exact matches still win, including none');
  // Off-ladder values only ever match exactly.
  assert.equal(resolveComposerReasoningEffort({
    preferredEffort: 'hd',
    supportedEfforts: ['low', 'medium', 'high'],
  }), 'low');
});

test('the higher-priority candidate is clamped before a lower one is consulted', () => {
  // Conversation says max (unsupported), the DOM still shows low: the
  // conversation's own tier, clamped, beats what the last chat left behind.
  assert.equal(resolveComposerReasoningEffort({
    preferredEffort: 'max',
    currentEffort: 'low',
    supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
  }), 'xhigh');
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
