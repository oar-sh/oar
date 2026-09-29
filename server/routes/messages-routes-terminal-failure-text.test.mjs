import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTerminalFailureTextForChat,
  parseTerminalFailureText,
  resolveTerminalFailurePayload,
} from './messages-routes.mjs';
import { classifyClaudeResultFailure } from '../claude-worker/claude-turn-failure.mjs';

const DEFAULT_GUIDANCE = 'Send the message again to retry. If this keeps failing, include the error code when you report it.';

test('a failure without advice of its own gets the default, which asks for no relay restart', () => {
  const text = buildTerminalFailureTextForChat({ code: 'turn-error', stableCode: 'claude.turn-error', message: 'The turn failed.' });
  assert.equal(text, `The turn failed. Error code: relay.turn-error. ${DEFAULT_GUIDANCE}`);
  assert.doesNotMatch(buildTerminalFailureTextForChat(null), /restart/i);
  assert.match(buildTerminalFailureTextForChat(null), /Error code: relay\.unknown-terminal\./);
  assert.doesNotMatch(buildTerminalFailureTextForChat({ code: 'x', guidance: null }), /restart/i);
});

test('a failure keeps the advice its worker gave', () => {
  const text = buildTerminalFailureTextForChat({ code: 'stalled', message: 'The turn went quiet.', guidance: 'Send the message again to retry.' });
  assert.equal(text, 'The turn went quiet. Error code: relay.stalled. Send the message again to retry.');
});

test('a Claude turn the account refused reads as an account failure', () => {
  const refusal = 'Your organization has disabled Claude subscription access for Claude Code · '
    + 'Use an Anthropic API key instead, or ask your admin to enable access';
  const terminalError = {
    kind: 'claude-turn-failed',
    ...classifyClaudeResultFailure({ text: refusal, isError: true, subtype: 'success', assistantError: 'oauth_org_not_allowed' }),
    message: refusal,
  };
  const failure = resolveTerminalFailurePayload({ text: refusal, terminalError }, { fallbackText: refusal });
  const text = buildTerminalFailureTextForChat(failure, refusal);
  assert.match(text, /Error code: relay\.claude-oauth-org-not-allowed\./);
  assert.match(text, /Check the Claude account the relay host is signed in to/);
  assert.match(text, /Settings → Providers → Claude/);
  assert.doesNotMatch(text, /claude-success|restart the relay|Retry the message/i);
  assert.equal(parseTerminalFailureText(text)?.stableCode, 'relay.claude-oauth-org-not-allowed');
});

test('a plain failed Claude turn reads as a turn error with the default advice', () => {
  const terminalError = {
    kind: 'claude-turn-failed',
    ...classifyClaudeResultFailure({ text: 'It broke.', isError: true, subtype: 'success' }),
    message: 'It broke.',
  };
  const failure = resolveTerminalFailurePayload({ text: 'It broke.', terminalError }, { fallbackText: 'It broke.' });
  assert.equal(
    buildTerminalFailureTextForChat(failure, 'It broke.'),
    `It broke. Error code: relay.claude-turn-error. ${DEFAULT_GUIDANCE}`,
  );
});
