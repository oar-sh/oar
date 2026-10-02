import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_SESSIONS_DEFAULT_LIMITS,
  AGENT_SESSIONS_DEFAULT_WAIT_SECONDS,
  AGENT_SESSIONS_SOCKET_EVENT,
  agentSessionsSavedText,
  agentSessionsViewModel,
  clampWaitSeconds,
  classifyAgentSessionsLoad,
  formatWaitMinutesLabel,
  normalizeAgentSessionsLimits,
  normalizeAgentSessionsSettings,
} from './agent-sessions-settings.mjs';

const LIMITS = { minWaitSeconds: 120, maxWaitSeconds: 3600, stepSeconds: 60 };
const SETTINGS = { enabled: true, maxWaitSeconds: 600, limits: LIMITS, maxActiveSessions: 4 };

test('the socket event and the defaults are the ones the relay documents', () => {
  assert.equal(AGENT_SESSIONS_SOCKET_EVENT, 'agent_sessions_settings_updated');
  assert.equal(AGENT_SESSIONS_DEFAULT_WAIT_SECONDS, 600);
  assert.deepEqual({ ...AGENT_SESSIONS_DEFAULT_LIMITS }, LIMITS);
});

test('seconds read as minutes', () => {
  assert.equal(formatWaitMinutesLabel(600), '10 min');
  assert.equal(formatWaitMinutesLabel(120), '2 min');
  assert.equal(formatWaitMinutesLabel(3600), '60 min');
  assert.equal(formatWaitMinutesLabel('900'), '15 min');
  // A step below a minute still gets a truthful label.
  assert.equal(formatWaitMinutesLabel(150), '2.5 min');
  assert.equal(formatWaitMinutesLabel(100), '1.7 min');
  for (const value of [null, undefined, '', 'soon', 0, -60, NaN, true]) {
    assert.equal(formatWaitMinutesLabel(value), '');
  }
});

test('a wait is clamped to the limits and lands on a step', () => {
  assert.equal(clampWaitSeconds(600, LIMITS), 600);
  assert.equal(clampWaitSeconds('1800', LIMITS), 1800);
  assert.equal(clampWaitSeconds(30, LIMITS), 120);
  assert.equal(clampWaitSeconds(99999, LIMITS), 3600);
  assert.equal(clampWaitSeconds(629, LIMITS), 600);
  assert.equal(clampWaitSeconds(631, LIMITS), 660);
  // Steps count from the minimum, as a range input does.
  assert.equal(clampWaitSeconds(200, { minWaitSeconds: 90, maxWaitSeconds: 600, stepSeconds: 60 }), 210);
  // A maximum off the grid is never overshot.
  assert.equal(clampWaitSeconds(1000, { minWaitSeconds: 100, maxWaitSeconds: 250, stepSeconds: 100 }), 200);
  // Not a number: the fallback, clamped the same way.
  assert.equal(clampWaitSeconds('', LIMITS, 900), 900);
  assert.equal(clampWaitSeconds(undefined, LIMITS), 600);
  assert.equal(clampWaitSeconds(null, LIMITS, 30), 120);
  // No limits yet: the documented defaults.
  assert.equal(clampWaitSeconds(7200), 3600);
  assert.equal(clampWaitSeconds(10, null), 120);
});

test('unusable limits fall back to the defaults', () => {
  assert.deepEqual(normalizeAgentSessionsLimits(null), LIMITS);
  assert.deepEqual(normalizeAgentSessionsLimits({ minWaitSeconds: 'x', maxWaitSeconds: -5, stepSeconds: 0 }), LIMITS);
  assert.deepEqual(
    normalizeAgentSessionsLimits({ minWaitSeconds: 60, maxWaitSeconds: 1800, stepSeconds: 30 }),
    { minWaitSeconds: 60, maxWaitSeconds: 1800, stepSeconds: 30 },
  );
  // A maximum below the minimum would make a slider that cannot move.
  assert.deepEqual(
    normalizeAgentSessionsLimits({ minWaitSeconds: 600, maxWaitSeconds: 300, stepSeconds: 60 }),
    { minWaitSeconds: 600, maxWaitSeconds: 600, stepSeconds: 60 },
  );
});

test('the state takes the payload and keeps what a partial one leaves out', () => {
  assert.deepEqual(normalizeAgentSessionsSettings(SETTINGS), SETTINGS);
  // The POST answer's extra fields are not state.
  assert.deepEqual(normalizeAgentSessionsSettings({ ok: true, status: 200, ...SETTINGS }), SETTINGS);
  assert.deepEqual(normalizeAgentSessionsSettings({ enabled: false }, SETTINGS), { ...SETTINGS, enabled: false });
  assert.deepEqual(normalizeAgentSessionsSettings({ maxWaitSeconds: 1200 }, SETTINGS), { ...SETTINGS, maxWaitSeconds: 1200 });
  // The first payload without the rest: off, and the documented defaults.
  assert.deepEqual(normalizeAgentSessionsSettings({}), {
    enabled: false,
    maxWaitSeconds: 600,
    limits: LIMITS,
    maxActiveSessions: null,
  });
  // Only `true` switches it on.
  assert.equal(normalizeAgentSessionsSettings({ enabled: 'yes' }).enabled, false);
  for (const payload of [null, undefined, 'x', 7, []]) {
    assert.equal(normalizeAgentSessionsSettings(payload, SETTINGS), SETTINGS);
    assert.equal(normalizeAgentSessionsSettings(payload), null);
  }
});

test('a 404 means an older relay, anything else that fails is only a failed read', () => {
  assert.equal(classifyAgentSessionsLoad({ ok: true, status: 200, ...SETTINGS }), 'loaded');
  assert.equal(classifyAgentSessionsLoad({ ok: true, status: 200, ...SETTINGS, enabled: false }), 'loaded');
  assert.equal(classifyAgentSessionsLoad({ ok: false, status: 404, error: 'Request failed (404)' }), 'unsupported');
  // A 200 that is not the settings (a catch-all answered) is no newer relay either.
  assert.equal(classifyAgentSessionsLoad({ ok: true, status: 200 }), 'unsupported');
  assert.equal(classifyAgentSessionsLoad({ ok: false, status: 500, error: 'boom' }), 'failed');
  assert.equal(classifyAgentSessionsLoad({ ok: false, status: 401, error: 'Unauthorized' }), 'failed');
  assert.equal(classifyAgentSessionsLoad({ ok: false, status: 0, code: 'NETWORK', error: 'offline' }), 'failed');
  // Network requests paused.
  assert.equal(classifyAgentSessionsLoad(null), 'failed');
});

test('the section is hidden until the relay answers, and for good on an older relay', () => {
  assert.equal(agentSessionsViewModel().hidden, true);
  assert.equal(agentSessionsViewModel({ unsupported: true }).hidden, true);
  assert.equal(agentSessionsViewModel({ settings: SETTINGS, unsupported: true }).hidden, true);
  assert.equal(agentSessionsViewModel({ settings: SETTINGS }).hidden, false);
  // The first read failed: shown, but nothing can be changed.
  const failed = agentSessionsViewModel({ loadFailed: true });
  assert.equal(failed.hidden, false);
  assert.equal(failed.toggle.checked, false);
  assert.equal(failed.toggle.disabled, true);
  assert.equal(failed.slider.disabled, true);
  assert.equal(failed.capText, '');
});

test('the slider takes range, step and value from the settings and is off with the switch', () => {
  const on = agentSessionsViewModel({ settings: SETTINGS });
  assert.deepEqual(on.toggle, { checked: true, disabled: false });
  assert.deepEqual(on.slider, { min: 120, max: 3600, step: 60, value: 600, label: '10 min', disabled: false });
  assert.equal(on.capText, 'At most 4 of them work at the same time per conversation.');

  const off = agentSessionsViewModel({ settings: { ...SETTINGS, enabled: false, maxWaitSeconds: 1800 } });
  assert.deepEqual(off.toggle, { checked: false, disabled: false });
  // The wait limit also applies to paired relays, so it stays adjustable.
  assert.equal(off.slider.disabled, false);
  // Still showing what is stored.
  assert.equal(off.slider.value, 1800);
  assert.equal(off.slider.label, '30 min');

  const saving = agentSessionsViewModel({ settings: SETTINGS, saving: true });
  assert.equal(saving.toggle.disabled, true);
  assert.equal(saving.slider.disabled, true);

  const other = agentSessionsViewModel({
    settings: { enabled: true, maxWaitSeconds: 300, limits: { minWaitSeconds: 60, maxWaitSeconds: 900, stepSeconds: 30 }, maxActiveSessions: null },
  });
  assert.deepEqual(other.slider, { min: 60, max: 900, step: 30, value: 300, label: '5 min', disabled: false });
  assert.equal(other.capText, '');
});

test('the status line says what was saved', () => {
  assert.equal(agentSessionsSavedText('enabled', SETTINGS), 'Agents may start and use sessions on this relay now.');
  assert.equal(
    agentSessionsSavedText('enabled', { ...SETTINGS, enabled: false }),
    'Agents can no longer start or use sessions on this relay.',
  );
  assert.equal(
    agentSessionsSavedText('maxWaitSeconds', { ...SETTINGS, maxWaitSeconds: 1500 }),
    'Agents may wait up to 25 min per tool call.',
  );
});
