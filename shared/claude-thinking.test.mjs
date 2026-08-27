import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_THINKING_DISPLAY,
  DEFAULT_THINKING_ENABLED,
  THINKING_DISPLAY_MODES,
  formatThinkingLabel,
  parseThinkingEnabled,
  parseThinkingDisplay,
  resolveDeliveredThinking,
} from './claude-thinking.mjs';
import * as browserMirror from '../server/public/app/claude-thinking-options.mjs';

test('parseThinkingEnabled: only an explicit off is off; everything else is the relay default (on)', () => {
  assert.equal(DEFAULT_THINKING_ENABLED, true, 'copilot-remote enables thinking by default');
  assert.equal(parseThinkingEnabled(true), true);
  assert.equal(parseThinkingEnabled(1), true);
  assert.equal(parseThinkingEnabled('true'), true);
  assert.equal(parseThinkingEnabled('on'), true);
  assert.equal(parseThinkingEnabled(false), false);
  assert.equal(parseThinkingEnabled(0), false);
  assert.equal(parseThinkingEnabled('false'), false);
  assert.equal(parseThinkingEnabled('off'), false);
  // An unset column / absent field / junk must never silently disable
  // thinking — it reads as the default.
  assert.equal(parseThinkingEnabled(null), true, 'a NULL column means never set, not off');
  assert.equal(parseThinkingEnabled(undefined), true);
  assert.equal(parseThinkingEnabled(''), true);
  assert.equal(parseThinkingEnabled('nonsense'), true);
  assert.equal(parseThinkingEnabled(2), true);
});

test('parseThinkingDisplay defaults to summarized; nothing hides thinking by accident', () => {
  assert.equal(parseThinkingDisplay('summarized'), 'summarized');
  assert.equal(parseThinkingDisplay('omitted'), 'omitted');
  assert.equal(parseThinkingDisplay(' OMITTED '), 'omitted');
  // 'host' was a third state before the relay took a position; it must now
  // read as the default rather than as an unknown that hides thoughts.
  assert.equal(parseThinkingDisplay('host'), 'summarized');
  assert.equal(parseThinkingDisplay(null), DEFAULT_THINKING_DISPLAY);
  assert.equal(parseThinkingDisplay(undefined), DEFAULT_THINKING_DISPLAY);
  assert.equal(parseThinkingDisplay(''), DEFAULT_THINKING_DISPLAY);
  assert.equal(parseThinkingDisplay('junk'), DEFAULT_THINKING_DISPLAY);
  assert.equal(DEFAULT_THINKING_DISPLAY, 'summarized');
});

test('resolveDeliveredThinking: absent keys keep state, present keys replace it', () => {
  const off = { enabled: false, display: 'omitted' };
  // Older relay: no keys at all — keep what the worker had. Critically, an
  // explicit OFF must survive: re-defaulting it to on here would silently
  // re-enable thinking on every delivery from an older relay.
  assert.deepEqual(resolveDeliveredThinking(off, {}), { enabled: false, display: 'omitted' });
  assert.deepEqual(resolveDeliveredThinking(off, null), { enabled: false, display: 'omitted' });
  // Presence, not truthiness: an explicit `false` must not read as "absent".
  assert.deepEqual(
    resolveDeliveredThinking({ enabled: true, display: 'summarized' }, { thinkingEnabled: false }),
    { enabled: false, display: 'summarized' },
  );
  // Each key resolves independently.
  assert.deepEqual(
    resolveDeliveredThinking(off, { thinkingDisplay: 'summarized' }),
    { enabled: false, display: 'summarized' },
  );
  assert.deepEqual(
    resolveDeliveredThinking(off, { thinkingEnabled: true }),
    { enabled: true, display: 'omitted' },
  );
  // A fresh worker with no state resolves to the relay defaults.
  assert.deepEqual(resolveDeliveredThinking(null, null), { enabled: true, display: 'summarized' });
});

test('formatThinkingLabel names every state, and defaults to On + visible', () => {
  assert.equal(formatThinkingLabel({}), 'On · visible');
  assert.equal(formatThinkingLabel({ enabled: true, display: 'summarized' }), 'On · visible');
  assert.equal(formatThinkingLabel({ enabled: false, display: 'omitted' }), 'Off · hidden');
  assert.equal(formatThinkingLabel({ enabled: true, display: 'omitted' }), 'On · hidden');
});

test('the browser mirror stays identical to the shared module', () => {
  assert.deepEqual([...browserMirror.THINKING_DISPLAY_MODES], [...THINKING_DISPLAY_MODES]);
  assert.equal(browserMirror.DEFAULT_THINKING_DISPLAY, DEFAULT_THINKING_DISPLAY);
  const enabledSamples = [true, false, 1, 0, 'true', 'off', 'on', null, undefined, '', 'junk', 2];
  for (const sample of enabledSamples) {
    assert.equal(browserMirror.parseThinkingEnabled(sample), parseThinkingEnabled(sample), `enabled(${String(sample)})`);
  }
  const displaySamples = ['summarized', 'omitted', 'host', ' OMITTED ', null, undefined, '', 'junk'];
  assert.equal(browserMirror.DEFAULT_THINKING_ENABLED, DEFAULT_THINKING_ENABLED);
  for (const sample of displaySamples) {
    assert.equal(browserMirror.parseThinkingDisplay(sample), parseThinkingDisplay(sample), `display(${String(sample)})`);
  }
  for (const enabled of [true, false, null, undefined]) {
    for (const display of THINKING_DISPLAY_MODES) {
      assert.equal(
        browserMirror.formatThinkingLabel({ enabled, display }),
        formatThinkingLabel({ enabled, display }),
      );
    }
  }
});
