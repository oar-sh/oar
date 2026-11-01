import test from 'node:test';
import assert from 'node:assert/strict';

import {
  composerBillingPill,
  composerSettingsLabelParts,
  composerSettingsLabelText,
} from './composer-settings-label.mjs';

const base = {
  model: 'Opus 5.5',
  effort: 'high',
  effortValue: 'high',
  mode: 'Autopilot',
  tier: '200K',
  tierValue: 'default',
};

test('model, effort and mode, in that order; Autopilot reads Auto', () => {
  assert.equal(composerSettingsLabelText(base), 'Opus 5.5 · high · Auto');
});

test('the lock goes in front of the model, only when locked', () => {
  assert.equal(composerSettingsLabelText({ ...base, locked: true }), '🔒 Opus 5.5 · high · Auto');
  const parts = composerSettingsLabelParts({ ...base, locked: true });
  assert.deepEqual(parts.map((part) => part.field), ['model', 'effort', 'mode']);
  assert.equal(parts[0].text, 'Opus 5.5', 'the part keeps the bare model text');
  assert.equal(parts[0].locked, true);
});

test('the context window shows only when it is not the default', () => {
  assert.equal(
    composerSettingsLabelText({ ...base, locked: true, tier: '1M', tierValue: 'long_context' }),
    '🔒 Opus 5.5 · high · Auto · 1M',
  );
  assert.equal(composerSettingsLabelText({ ...base, tier: 'auto', tierValue: 'auto' }), 'Opus 5.5 · high · Auto');
  assert.equal(
    composerSettingsLabelText({ ...base, tier: '1024x1024', tierValue: '1024x1024' }),
    'Opus 5.5 · high · Auto · 1024x1024',
  );
});

test('an unavailable effort is left out', () => {
  assert.equal(composerSettingsLabelText({ ...base, effort: 'Unavailable', effortValue: '' }), 'Opus 5.5 · Auto');
  assert.equal(composerSettingsLabelText({ ...base, effort: 'Unavailable' }), 'Opus 5.5 · Auto');
  assert.equal(composerSettingsLabelText({ ...base, effort: '', effortValue: '' }), 'Opus 5.5 · Auto');
  assert.equal(composerSettingsLabelText({ ...base, effort: 'none', effortValue: 'none' }), 'Opus 5.5 · none · Auto');
});

test('a cloud chat shows only the model', () => {
  assert.equal(
    composerSettingsLabelText({ ...base, cloud: true, tier: '1M', tierValue: 'long_context' }),
    'Opus 5.5',
  );
});

test('hidden fields are left out and whitespace is folded', () => {
  assert.equal(
    composerSettingsLabelText({ ...base, model: '  Sonnet\n 5 ', hidden: { mode: true } }),
    'Sonnet 5 · high',
  );
  assert.equal(composerSettingsLabelText({}), '');
});

test('parts name their field for the panel', () => {
  const parts = composerSettingsLabelParts({ ...base, tier: '1M', tierValue: 'long_context' });
  assert.deepEqual(parts.map((part) => [part.field, part.text]), [
    ['model', 'Opus 5.5'],
    ['effort', 'high'],
    ['mode', 'Auto'],
    ['tier', '1M'],
  ]);
  assert.equal(composerSettingsLabelText(parts), 'Opus 5.5 · high · Auto · 1M');
});

test('the billing pill follows the toggle', () => {
  assert.deepEqual(composerBillingPill({ toggleVisible: true, billing: 'claude' }), { visible: true, billing: 'claude', text: 'Subscription' });
  assert.deepEqual(composerBillingPill({ toggleVisible: true, billing: 'claude-api' }), { visible: true, billing: 'claude-api', text: 'API key' });
  assert.equal(composerBillingPill({ toggleVisible: false, billing: 'claude' }).visible, false);
  assert.equal(composerBillingPill({ toggleVisible: true, billing: '' }).visible, false);
  assert.equal(composerBillingPill().visible, false);
});
