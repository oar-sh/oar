import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_BILLING_CACHE_WARNING,
  CLAUDE_BILLING_CAP_TEXT,
  CLAUDE_BILLING_TOGGLE_OPTIONS,
  claudeBillingPendingText,
  claudeBillingSwitchedText,
  claudeBillingToggleModel,
} from './claude-billing-toggle.mjs';

const KEY_READY = { configured: true, enabled: true };

// What the relay's billingState() answers (claude-billing-switch-service.mjs).
function billing(provider, { allowed = true, reason = null, code = null, pending = null } = {}) {
  return {
    provider,
    pending,
    switchedAt: null,
    switchedBy: null,
    switchable: { to: provider === 'claude' ? 'claude-api' : 'claude', allowed, code, reason },
  };
}

function pressed(model) {
  return model.options.filter((option) => option.pressed).map((option) => option.value);
}

test('the two sides are the subscription and the API key, in that order', () => {
  assert.deepEqual(CLAUDE_BILLING_TOGGLE_OPTIONS.map((option) => [option.value, option.label]), [
    ['claude', 'Subscription'],
    ['claude-api', 'API key'],
  ]);
});

test('a subscription chat shows the toggle only while Claude API is on with a key', () => {
  const on = claudeBillingToggleModel({ providerType: 'claude', billing: billing('claude'), claudeApi: KEY_READY });
  assert.equal(on.visible, true);
  assert.equal(on.current, 'claude');
  assert.deepEqual(pressed(on), ['claude']);
  assert.equal(on.options.find((option) => option.value === 'claude-api').available, true);
  for (const claudeApi of [null, { configured: false, enabled: false }, { configured: true, enabled: false }]) {
    assert.equal(claudeBillingToggleModel({ providerType: 'claude', billing: billing('claude'), claudeApi }).visible, false);
  }
});

test('a chat on the key keeps the toggle after Claude API is switched off, to move back', () => {
  const model = claudeBillingToggleModel({
    providerType: 'claude-api',
    billing: billing('claude-api'),
    claudeApi: { configured: true, enabled: false },
  });
  assert.equal(model.visible, true);
  assert.deepEqual(pressed(model), ['claude-api']);
  assert.equal(model.options.find((option) => option.value === 'claude').available, true);
});

test('no toggle for other providers, or before the relay said the billing', () => {
  for (const providerType of ['github', 'openai', 'deepseek', 'claude-cloud', 'cursor', '']) {
    assert.equal(claudeBillingToggleModel({ providerType, billing: billing('claude'), claudeApi: KEY_READY }).visible, false, providerType);
  }
  // An older relay's payload has no billing.
  assert.equal(claudeBillingToggleModel({ providerType: 'claude', billing: null, claudeApi: KEY_READY }).visible, false);
});

test('a refused switch keeps its side unavailable with the relay\'s reason', () => {
  const reason = 'claude-opus-9 is not in the Claude API model list. Pick a model it has, then switch.';
  const model = claudeBillingToggleModel({
    providerType: 'claude',
    billing: billing('claude', { allowed: false, code: 'CLAUDE_BILLING_MODEL_UNAVAILABLE', reason }),
    claudeApi: KEY_READY,
  });
  const apiKey = model.options.find((option) => option.value === 'claude-api');
  assert.equal(apiKey.available, false);
  assert.equal(apiKey.reason, reason);
  // The side it is on is never "unavailable".
  assert.equal(model.options.find((option) => option.value === 'claude').available, true);
  // A refusal with no words still says something.
  const silent = claudeBillingToggleModel({ providerType: 'claude', billing: billing('claude', { allowed: false }), claudeApi: KEY_READY });
  assert.match(silent.options[1].reason, /does not allow/);
});

test('the relay\'s billing wins over a stale provider on the page', () => {
  const model = claudeBillingToggleModel({ providerType: 'claude', billing: billing('claude-api'), claudeApi: KEY_READY });
  assert.equal(model.current, 'claude-api');
  assert.deepEqual(pressed(model), ['claude-api']);
});

test('a switch on its way blocks the other side and says so', () => {
  const model = claudeBillingToggleModel({ providerType: 'claude', billing: billing('claude'), claudeApi: KEY_READY, inFlight: true });
  assert.equal(model.status, 'Switching…');
  assert.equal(model.statusKind, 'pending');
  assert.equal(model.options[1].available, false);
});

test('the waiting state names what the worker swap waits for', () => {
  assert.equal(claudeBillingPendingText({ to: 'claude-api', waitingFor: 'turn' }), 'Moves to the API key after the running turn.');
  assert.equal(claudeBillingPendingText({ to: 'claude', waitingFor: 'question' }), 'Moves to the subscription once the open question is answered.');
  assert.equal(claudeBillingPendingText({ to: 'claude-api', waitingFor: 'compaction' }), 'Moves to the API key after the compaction.');
  assert.equal(claudeBillingPendingText({ to: 'claude-api', waitingFor: 'background', backgroundTaskCount: 1 }), 'Moves to the API key once 1 background task finishes.');
  assert.equal(claudeBillingPendingText({ to: 'claude-api', waitingFor: 'background', backgroundTaskCount: 3 }), 'Moves to the API key once 3 background tasks finish.');
  assert.equal(claudeBillingPendingText({ to: 'claude-api', waitingFor: 'background' }), 'Moves to the API key once the background tasks finish.');
  assert.match(claudeBillingPendingText({ to: 'claude', waitingFor: 'stop' }), /has not stopped yet, retrying/);
  assert.equal(claudeBillingPendingText({ to: 'claude-api', swapping: true }), 'Restarting on the API key…');
  assert.equal(claudeBillingPendingText(null), '');
  const model = claudeBillingToggleModel({
    providerType: 'claude-api',
    billing: billing('claude-api', { pending: { to: 'claude-api', waitingFor: 'turn', backgroundTaskCount: 0, swapping: false } }),
    claudeApi: KEY_READY,
  });
  assert.equal(model.status, 'Moves to the API key after the running turn.');
  assert.equal(model.statusKind, 'pending');
});

test('a chat just moved to the key warns about the first turn\'s cache', () => {
  const model = claudeBillingToggleModel({ providerType: 'claude-api', billing: billing('claude-api'), claudeApi: KEY_READY, warnCache: true });
  assert.equal(model.status, CLAUDE_BILLING_CACHE_WARNING);
  assert.equal(model.statusKind, 'warning');
  assert.match(CLAUDE_BILLING_CACHE_WARNING, /no prompt cache and costs more/);
  // Not on the subscription side, and a pending swap is said first.
  assert.equal(claudeBillingToggleModel({ providerType: 'claude', billing: billing('claude'), claudeApi: KEY_READY, warnCache: true }).status, '');
  const pending = claudeBillingToggleModel({
    providerType: 'claude-api',
    billing: billing('claude-api', { pending: { to: 'claude-api', waitingFor: 'turn' } }),
    claudeApi: KEY_READY,
    warnCache: true,
  });
  assert.equal(pending.statusKind, 'pending');
});

test('the notice after a switch says when it applies, and the cache cost on the key', () => {
  // The words of the transcript's note (buildClaudeBillingNoteText): "from the next turn".
  assert.equal(claudeBillingSwitchedText('claude-api'), `This chat runs on the API key from the next turn. ${CLAUDE_BILLING_CACHE_WARNING}`);
  assert.equal(claudeBillingSwitchedText('claude'), 'This chat runs on the subscription from the next turn.');
});

test('a refusal for Claude API being off is stale once the tab has switched it on', () => {
  const offBilling = billing('claude', {
    allowed: false,
    code: 'CLAUDE_API_NOT_CONFIGURED',
    reason: 'Claude API is switched off. Switch it on in Settings → Providers → Claude API.',
  });
  const model = claudeBillingToggleModel({ providerType: 'claude', billing: offBilling, claudeApi: KEY_READY });
  assert.equal(model.options[1].available, true);
  // Any other refusal stands.
  const capBilling = billing('claude', { allowed: false, code: 'CLAUDE_API_CAP_REACHED', reason: 'The cap is reached.' });
  assert.equal(claudeBillingToggleModel({ providerType: 'claude', billing: capBilling, claudeApi: KEY_READY }).options[1].available, false);
});

test('at the Claude API cap a subscription chat says so on the toggle, and the key side is closed', () => {
  const capBilling = billing('claude', { allowed: false, code: 'CLAUDE_API_CAP_REACHED', reason: "This month's Claude API spend has reached the cap." });
  const model = claudeBillingToggleModel({ providerType: 'claude', billing: capBilling, claudeApi: KEY_READY });
  assert.equal(model.visible, true);
  assert.equal(model.status, CLAUDE_BILLING_CAP_TEXT);
  assert.equal(model.statusKind, 'warning');
  assert.equal(model.options[1].available, false);
  assert.match(model.options[1].reason, /reached the cap/);
  // A chat on the key can always move back to the subscription.
  const onKey = claudeBillingToggleModel({ providerType: 'claude-api', billing: billing('claude-api'), claudeApi: KEY_READY });
  assert.equal(onKey.options[0].available, true);
});

test('a side the relay refused to this page stays closed, even for "Claude API is off"', () => {
  const refused = billing('claude', { allowed: false, code: 'CLAUDE_API_NOT_CONFIGURED', reason: 'Claude API has no key.' });
  refused.switchable.refused = true;
  const model = claudeBillingToggleModel({ providerType: 'claude', billing: refused, claudeApi: KEY_READY });
  assert.equal(model.options[1].available, false);
  assert.equal(model.options[1].reason, 'Claude API has no key.');
});
