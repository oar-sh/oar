import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeAttributionSettings,
  claudeAttributionModelLabel,
  claudeAttributionTrailer,
  normalizeClaudeAttributionMode,
  resolveClaudeAttributionMode,
  resolveDeliveredAttribution,
  sameClaudeAttribution,
  OAR_PR_ATTRIBUTION,
} from './claude-attribution.mjs';

test('model ids become the names the trailer should carry', () => {
  assert.equal(claudeAttributionModelLabel('claude-fable-5-1[1m]'), 'Claude Fable 5.1');
  assert.equal(claudeAttributionModelLabel('claude-fable-5-1'), 'Claude Fable 5.1');
  assert.equal(claudeAttributionModelLabel('claude-opus-5-5[1m]'), 'Claude Opus 5.5');
  assert.equal(claudeAttributionModelLabel('claude-opus-5[1m]'), 'Claude Opus 5');
  assert.equal(claudeAttributionModelLabel('claude-sonnet-5'), 'Claude Sonnet 5');
  assert.equal(claudeAttributionModelLabel('claude-haiku-4-5-20251001'), 'Claude Haiku 4.5');
  assert.equal(claudeAttributionModelLabel('CLAUDE-SONNET-4-6'), 'Claude Sonnet 4.6');
  // Unknown shapes are used as they are, minus the tier suffix.
  assert.equal(claudeAttributionModelLabel('claude-newfamily-7[1m]'), 'claude-newfamily-7');
  assert.equal(claudeAttributionModelLabel('something-else'), 'something-else');
  assert.equal(claudeAttributionModelLabel(''), 'Claude');
});

test('the trailer is a git trailer with the identity in the name part', () => {
  assert.equal(
    claudeAttributionTrailer('Claude Fable 5.1'),
    'Co-authored-by: Open Agent Relay (Claude Fable 5.1) <no-reply@oar.sh>',
  );
  assert.match(claudeAttributionTrailer(''), /^Co-authored-by: Open Agent Relay \(Claude\) <no-reply@oar\.sh>$/);
});

test('modes normalise and the folder override wins over the provider setting', () => {
  assert.equal(normalizeClaudeAttributionMode(' OAR '), 'oar');
  assert.equal(normalizeClaudeAttributionMode('vanilla'), 'vanilla');
  assert.equal(normalizeClaudeAttributionMode('off'), 'off');
  assert.equal(normalizeClaudeAttributionMode('none'), null);
  assert.equal(normalizeClaudeAttributionMode(undefined), null);
  assert.equal(resolveClaudeAttributionMode({}), 'oar');
  assert.equal(resolveClaudeAttributionMode({ providerMode: 'off' }), 'off');
  assert.equal(resolveClaudeAttributionMode({ providerMode: 'off', folderMode: 'vanilla' }), 'vanilla');
  assert.equal(resolveClaudeAttributionMode({ providerMode: 'junk', folderMode: 'junk' }), 'oar');
});

test('the three modes build the three settings shapes, always as objects', () => {
  assert.deepEqual(buildClaudeAttributionSettings({ mode: 'oar', modelId: 'claude-opus-5-5[1m]' }), {
    commit: 'Co-authored-by: Open Agent Relay (Claude Opus 5.5) <no-reply@oar.sh>',
    pr: OAR_PR_ATTRIBUTION,
    sessionUrl: false,
  });
  assert.deepEqual(buildClaudeAttributionSettings({ mode: 'oar', modelLabel: 'Claude Fable 5.1' }).commit,
    'Co-authored-by: Open Agent Relay (Claude Fable 5.1) <no-reply@oar.sh>');
  assert.deepEqual(buildClaudeAttributionSettings({ mode: 'off' }), { commit: '', pr: '', sessionUrl: false });
  assert.equal(buildClaudeAttributionSettings({ mode: 'vanilla', modelId: 'claude-sonnet-5' }), null);
  assert.equal(buildClaudeAttributionSettings({ mode: 'bogus' }).commit.includes('Open Agent Relay'), true, 'unknown → default (oar)');
});

test('a delivery replaces the attribution only when it names it', () => {
  const oar = buildClaudeAttributionSettings({ mode: 'oar', modelId: 'claude-sonnet-5' });
  assert.equal(resolveDeliveredAttribution(null, null), null);
  assert.deepEqual(resolveDeliveredAttribution(null, { attribution: oar }), oar);
  assert.deepEqual(resolveDeliveredAttribution(oar, { autoCompactWindow: 1 }), oar, 'absent key keeps the value');
  assert.equal(resolveDeliveredAttribution(oar, { attribution: null }), null, 'explicit null is vanilla');
  assert.deepEqual(resolveDeliveredAttribution(oar, { attribution: 'junk' }), oar, 'junk is ignored');
  assert.deepEqual(resolveDeliveredAttribution(null, { attribution: { commit: 'x' } }), { commit: 'x', pr: '', sessionUrl: false });
});

test('sameClaudeAttribution compares by meaning', () => {
  const a = buildClaudeAttributionSettings({ mode: 'oar', modelId: 'claude-sonnet-5' });
  const b = buildClaudeAttributionSettings({ mode: 'oar', modelId: 'claude-sonnet-5' });
  const c = buildClaudeAttributionSettings({ mode: 'oar', modelId: 'claude-opus-5-5' });
  assert.equal(sameClaudeAttribution(a, b), true);
  assert.equal(sameClaudeAttribution(a, c), false);
  assert.equal(sameClaudeAttribution(null, null), true);
  assert.equal(sameClaudeAttribution(a, null), false);
  assert.equal(sameClaudeAttribution({ commit: '', pr: '', sessionUrl: false }, buildClaudeAttributionSettings({ mode: 'off' })), true);
});
