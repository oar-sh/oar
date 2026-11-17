import test from 'node:test';
import assert from 'node:assert/strict';

import { firstEnabledProviderTab } from './settings-tabs.js';

// A first-time visitor's provider sub-tab: the first provider that is on,
// Copilot by its switch; Copilot's tab while none is.

test('Copilot on (or not known yet) leads, as on every relay from before the switch', () => {
  assert.equal(firstEnabledProviderTab({ ready: ['claude', 'github'], copilot: 'ready' }), 'copilot');
  assert.equal(firstEnabledProviderTab({ ready: ['claude'], copilot: 'unknown' }), 'copilot');
});

test('Copilot off: the first provider that is on, in strip order', () => {
  assert.equal(firstEnabledProviderTab({ ready: ['grok', 'claude'], copilot: 'off' }), 'claude');
  assert.equal(firstEnabledProviderTab({ ready: ['deepseek'], copilot: 'off' }), 'deepseek');
});

test('nothing on: Copilot\'s tab, where its switch and CLI install are', () => {
  assert.equal(firstEnabledProviderTab({ ready: [], copilot: 'off' }), 'copilot');
  assert.equal(firstEnabledProviderTab(null), 'copilot');
});
