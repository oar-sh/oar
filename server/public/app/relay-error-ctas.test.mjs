import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  relayErrorCodeFromText,
  relayErrorCtaActions,
  relayErrorCtaActionsForCode,
} from './relay-error-ctas.mjs';

// The chat text these read is produced by buildTerminalFailureTextForChat()
// (messages-routes.mjs); the samples below keep its exact shape.
const CLI_MISSING = 'Grok CLI was not found on PATH. Install it from Settings → Providers → Grok. '
  + 'Error code: relay.grok-cli-missing. Retry the message. If this keeps failing, restart the relay and include the error code.';
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
