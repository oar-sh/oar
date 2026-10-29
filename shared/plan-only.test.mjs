import test from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_ONLY_REFUSAL, planOnlyRefusesMode, resumeRelayMode } from './plan-only.mjs';

const APPROVE = 'Plan approved by the user. Do not implement. Finish only the plan-only steps you were given, then stop.';

test('a plan-only session refuses any named mode but plan, unknown ones included', () => {
  for (const mode of ['agent', 'ask', 'autopilot', 'AGENT', 'nonsense']) assert.equal(planOnlyRefusesMode(mode), true, mode);
  for (const mode of ['plan', ' Plan ', '', null, undefined]) assert.equal(planOnlyRefusesMode(mode), false, String(mode));
  assert.equal(PLAN_ONLY_REFUSAL.code, 'plan_only');
  assert.match(PLAN_ONLY_REFUSAL.error, /Clear planOnly first, or ask the user\./);
});

test('a cut turn resumes as it ran, except on a plan-only session', () => {
  assert.equal(resumeRelayMode({ relayMode: 'autopilot', text: 'build it' }), 'autopilot');
  assert.equal(resumeRelayMode({ relayMode: '', text: 'build it' }), 'agent');
  assert.equal(resumeRelayMode({ relayMode: 'agent', text: 'build it', planOnly: true }), 'plan');
  assert.equal(resumeRelayMode({ relayMode: 'plan', text: 'plan it', planOnly: true }), 'plan');
  // The "Approve plan" turn: its exact line and its agent mode.
  assert.equal(resumeRelayMode({ relayMode: 'agent', text: APPROVE, planOnly: true }), 'agent');
  assert.equal(resumeRelayMode({ relayMode: 'agent', text: `  ${APPROVE}\n`, planOnly: true }), 'agent');
});

test('the approve line alone does not make an agent resume', () => {
  // Pasted by the owner in plan mode: stays plan.
  assert.equal(resumeRelayMode({ relayMode: 'plan', text: APPROVE, planOnly: true }), 'plan');
  // In another writing mode (autopilot, ask): not the board's turn.
  assert.equal(resumeRelayMode({ relayMode: 'autopilot', text: APPROVE, planOnly: true }), 'plan');
  assert.equal(resumeRelayMode({ relayMode: 'ask', text: APPROVE, planOnly: true }), 'plan');
  // A NULL mode runs as agent, but it is not the board's row (that one stores agent).
  assert.equal(resumeRelayMode({ relayMode: null, text: APPROVE, planOnly: true }), 'plan');
  // Agent mode with any other text, the line quoted inside more text included.
  assert.equal(resumeRelayMode({ relayMode: 'agent', text: `Note: ${APPROVE}`, planOnly: true }), 'plan');
  assert.equal(resumeRelayMode({ relayMode: 'agent', text: 'Plan approved by the user.', planOnly: true }), 'plan');
});