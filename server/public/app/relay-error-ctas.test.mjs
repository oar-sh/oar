import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  START_ON_SUBSCRIPTION_ACTION,
  newChatClaudeApiRefusalActions,
  relayErrorCodeFromText,
  relayErrorCtaActions,
  relayErrorCtaActionsForCode,
} from './relay-error-ctas.mjs';

// The chat text these read is produced by buildTerminalFailureTextForChat()
// (messages-routes.mjs); the samples below keep its exact shape.
const CLI_MISSING = 'Grok CLI was not found on PATH. Install it from Settings → Providers → Grok. '
  + 'Error code: relay.grok-cli-missing. Send the message again to retry. If this keeps failing, include the error code when you report it.';
const AUTH_FAILED = 'Grok authentication failed. Sign in from Settings → Providers → Grok. '
  + 'Error code: relay.grok-authentication-failed. Retry the message.';

test('the stable code is read out of the rendered failure text', () => {
  assert.equal(relayErrorCodeFromText(CLI_MISSING), 'grok-cli-missing');
  assert.equal(relayErrorCodeFromText(AUTH_FAILED), 'grok-authentication-failed');
  assert.equal(relayErrorCodeFromText('just a normal answer'), '');
  assert.equal(relayErrorCodeFromText(null), '');
});

test('a missing Grok CLI offers the install and the deep link', () => {
  assert.deepEqual(
    relayErrorCtaActions(CLI_MISSING).map((item) => [item.action, item.label]),
    [['install-grok-cli', 'Install Grok CLI'], ['open-grok-settings', 'Grok settings']],
  );
});

test('a Grok auth failure offers the sign-in', () => {
  assert.deepEqual(
    relayErrorCtaActions(AUTH_FAILED).map((item) => item.action),
    ['sign-in-to-grok', 'open-grok-settings'],
  );
});

test('an unknown code has no CTA rather than a guessed one', () => {
  assert.deepEqual(relayErrorCtaActions('Error code: relay.grok-turn-error. Retry the message.'), []);
  assert.deepEqual(relayErrorCtaActions(''), []);
  assert.deepEqual(relayErrorCtaActions(undefined), []);
});

test('the code lookup tolerates the relay. prefix and casing', () => {
  assert.equal(relayErrorCtaActionsForCode('relay.grok-cli-missing').length, 2);
  assert.equal(relayErrorCtaActionsForCode('GROK-CLI-MISSING').length, 2);
  assert.equal(relayErrorCtaActionsForCode('claude-authentication-failed')[0].action, 'open-claude-settings');
  for (const code of ['claude-billing-error', 'claude-oauth-org-not-allowed', 'claude-account-on-hold', 'claude-verification-required', 'claude-account-access']) {
    assert.deepEqual(relayErrorCtaActionsForCode(code).map((item) => item.action), ['open-claude-settings'], code);
  }
  assert.deepEqual(relayErrorCtaActionsForCode('claude-rate-limit'), []);
  assert.deepEqual(relayErrorCtaActionsForCode('nope'), []);
});

test('the table is frozen so a caller cannot mutate another bubble\'s actions', () => {
  const actions = relayErrorCtaActions(CLI_MISSING);
  assert.throws(() => actions.push({ action: 'x', label: 'x' }), TypeError);
  assert.equal(relayErrorCtaActions(CLI_MISSING).length, 2);
});

test('the bubble renders the CTA for owners only, escaped, and routes the click', () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL('./conversation-view.js', import.meta.url)),
    'utf8',
  );
  assert.match(source, /!IS_SHARED_VIEW && msg\.role === 'assistant'\s*\)\s*\?\s*relayErrorCtaActions\(msg\.text\)/);
  assert.match(source, /data-action="relay-error-cta" data-cta="\$\{escHtml\(item\.action\)\}"/);
  assert.match(source, /runRelayErrorCta\(String\(btn\.dataset\.cta \|\| ''\)\)/);
  // The install CTA opens the confirm sheet — never a bare curl | bash from a
  // chat bubble — and lands on the panel that shows the streamed log.
  assert.match(source, /openSettingsModal\('providers', 'grok'\);\s*\n\s*\/\/[^\n]*\n\s*void confirmCliInstall\('grok', 'install'\)/);
  assert.match(source, /void startGrokSignIn\(\)/);
  assert.match(source, /openSettingsModal\('providers', 'claude'\)/);
});

test('a DeepSeek key or balance failure links to its settings and to the top-up page', () => {
  const balance = 'The DeepSeek account balance is used up. Error code: relay.deepseek-balance. Top it up, then send the message again.';
  assert.deepEqual(
    relayErrorCtaActions(balance).map((item) => item.action),
    ['open-deepseek-top-up', 'open-deepseek-settings'],
  );
  assert.deepEqual(
    relayErrorCtaActionsForCode('deepseek-api-key').map((item) => item.action),
    ['open-deepseek-settings'],
  );
});

test('a Claude API row that failed closed offers the tab and the subscription', () => {
  // The claim's note (server-runtime.mjs handleClaudeBillingFence), as it ends.
  const notConfigured = 'Claude API has no key, so this turn did not run. Switch this chat to the subscription, or set Claude API up in '
    + 'Settings → Providers → Claude API, then send the message again. Error code: relay.claude-api-not-configured.';
  assert.deepEqual(
    relayErrorCtaActions(notConfigured).map((item) => [item.action, item.label]),
    [['open-claude-api-settings', 'Claude API settings'], ['switch-claude-billing-to-subscription', 'Switch to subscription']],
  );
  // The cap's note: the cap field, or the subscription. The code is built
  // as the claim builds it (relay.<CODE lowercased, _ → ->).
  assert.deepEqual(
    relayErrorCtaActionsForCode('relay.CLAUDE_API_CAP_REACHED'.toLowerCase().replace(/_/g, '-')).map((item) => [item.action, item.label]),
    [['open-claude-api-cap', 'Claude API settings'], ['switch-claude-billing-to-subscription', 'Switch to subscription']],
  );
});

test('each Claude API refusal links where it is fixed', () => {
  const actions = (code) => relayErrorCtaActionsForCode(code).map((item) => item.action);
  assert.deepEqual(actions('claude-api-key'), ['open-claude-api-settings']);
  assert.deepEqual(actions('claude-api-key-source'), ['open-claude-api-settings']);
  assert.deepEqual(actions('claude-api-credit'), ['open-claude-api-billing', 'open-claude-api-settings']);
  assert.deepEqual(relayErrorCtaActionsForCode('claude-api-credit').map((item) => item.label), ['Add funds', 'Claude API settings']);
  assert.deepEqual(actions('claude-api-billing'), ['open-claude-api-billing']);
  assert.deepEqual(actions('claude-api-spend-limit'), ['open-claude-api-limits']);
  assert.deepEqual(actions('claude-api-rate-limit'), ['open-claude-api-limits']);
  // The subscription's own codes keep the Claude tab.
  assert.deepEqual(actions('claude-billing-error'), ['open-claude-settings']);
});

test('every Claude API action has a handler in the transcript', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('./conversation-view.js', import.meta.url)), 'utf8');
  assert.match(source, /cta === 'open-claude-api-settings'\) openSettingsModal\('providers', 'claude-api'\)/);
  assert.match(source, /cta === 'open-claude-api-billing'\) window\.open\(CLAUDE_API_BILLING_URL/);
  assert.match(source, /cta === 'open-claude-api-cap'\) \{\s+openSettingsModal\('providers', 'claude-api'\);\s+focusClaudeApiCapInput\(\);/);
  assert.match(source, /cta === 'open-claude-api-limits'\) window\.open\(CLAUDE_API_LIMITS_URL/);
  assert.match(source, /cta === 'switch-claude-billing-to-subscription' && currentConvId\) void switchClaudeBilling\(currentConvId, 'claude'\)/);
});

test('New Chat answers a refused Claude API start with the settings and the same chat on the subscription', () => {
  // The bootstrap's 409 codes, as the relay sends them.
  assert.deepEqual(
    newChatClaudeApiRefusalActions('CLAUDE_API_CAP_REACHED', { subscriptionOffered: true }).map((item) => [item.action, item.label]),
    [['open-claude-api-cap', 'Claude API settings'], [START_ON_SUBSCRIPTION_ACTION, 'Start on subscription']],
  );
  assert.deepEqual(
    newChatClaudeApiRefusalActions('CLAUDE_API_NOT_CONFIGURED', { subscriptionOffered: true }).map((item) => item.action),
    ['open-claude-api-settings', START_ON_SUBSCRIPTION_ACTION],
  );
  // Without the Claude provider in New Chat there is no subscription to start on.
  assert.deepEqual(
    newChatClaudeApiRefusalActions('CLAUDE_API_CAP_REACHED').map((item) => item.action),
    ['open-claude-api-cap'],
  );
  assert.deepEqual(newChatClaudeApiRefusalActions('SOMETHING_ELSE', { subscriptionOffered: true }), []);
  const source = fs.readFileSync(fileURLToPath(new URL('./journal-view.js', import.meta.url)), 'utf8');
  assert.match(source, /newChatClaudeApiRefusalActions\(error\?\.payload\?\.code, \{\s+subscriptionOffered: newConversationProviderOffered\('claude'\),/);
  assert.match(source, /item\.action === START_ON_SUBSCRIPTION_ACTION\) \{\s+void startNewConversationOnSubscription\(model\);/);
  assert.match(source, /providerSelect\.value = 'claude';\s+await populateNewConversationModelSelect\('claude'\);/);
  const html = fs.readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  assert.match(html, /<div id="new-conversation-refusal" class="new-conversation-setup-note new-conversation-refusal" role="alert" hidden><\/div>/);
});

test('Start on subscription keeps the effort the user chose when the Claude list offers it', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('./journal-view.js', import.meta.url)), 'utf8');
  const start = source.indexOf('async function startNewConversationOnSubscription(');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  const readAt = body.indexOf("const effort = String(document.getElementById('new-conversation-reasoning-select')?.value || '')");
  const rebuildAt = body.indexOf("await populateNewConversationModelSelect('claude');");
  const restoreAt = body.indexOf('reasoningSelect.value = effort;');
  assert.ok(readAt !== -1 && rebuildAt !== -1 && restoreAt !== -1, 'reads, rebuilds and restores the effort');
  assert.ok(readAt < rebuildAt && rebuildAt < restoreAt, 'the effort is read before the lists are rebuilt and set after');
  assert.match(body, /Array\.from\(reasoningSelect\.options\)\.some\(\(option\) => option\.value === effort\)/);
});

test('the stop note of a self-started turn on the key keeps its buttons with 5 + 5 long task labels', async () => {
  const { buildClaudeApiStopNoteText } = await import('../../routes/messages-routes.mjs');
  const tasks = (kind) => Array.from({ length: 5 }, (_, i) => ({ label: `npm run watch -- --flag-${kind}${i} ${'x'.repeat(80)}` }));
  for (const [code, error, actions] of [
    ['CLAUDE_API_CAP_REACHED', "This month's Claude API spend ($123.45 of $100.00) has reached its cap. This turn did not run.", ['open-claude-api-cap', 'switch-claude-billing-to-subscription']],
    ['CLAUDE_API_NOT_CONFIGURED', 'Claude API is switched off, so this turn did not run.', ['open-claude-api-settings', 'switch-claude-billing-to-subscription']],
  ]) {
    const text = buildClaudeApiStopNoteText({ refusal: { code, error }, tasks: { stopped: tasks('s'), unreached: tasks('u') } });
    assert.deepEqual(relayErrorCtaActions(text).map((item) => item.action), actions, code);
  }
});

test('New Chat brings its refusal note into view: the dialog body scrolls on a phone', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('./journal-view.js', import.meta.url)), 'utf8');
  assert.match(source, /note\.hidden = false;\n\s+\/\/ The modal's body scrolls: on a phone the note lands below the fold\.\n\s+note\.scrollIntoView\?\.\(\{ block: 'nearest' \}\);/);
});
