import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_ACCOUNT_GUIDANCE,
  CLAUDE_MODEL_GUIDANCE,
  CLAUDE_SIGN_IN_GUIDANCE,
  classifyClaudeResultFailure,
} from './claude-turn-failure.mjs';
import {
  makeApiStub,
  fakeTurn,
  initMessage,
  baseMessage,
  makeRunner,
  settled,
} from './claude-session-test-harness.mjs';

// The CLI's own wording for a subscription its organisation (or an unpaid
// plan) no longer covers.
const ORG_DISABLED_TEXT = 'Your organization has disabled Claude subscription access for Claude Code · '
  + 'Use an Anthropic API key instead, or ask your admin to enable access';

function refusedResult(overrides = {}) {
  return { text: 'refused', isError: true, subtype: 'success', assistantError: '', apiErrorStatus: null, terminalReason: '', ...overrides };
}

test('a refused turn is never coded by its subtype', () => {
  for (const result of [
    refusedResult(),
    refusedResult({ assistantError: 'rate_limit', apiErrorStatus: 429, terminalReason: 'api_error' }),
    refusedResult({ assistantError: 'unknown' }),
    refusedResult({ text: ORG_DISABLED_TEXT }),
    refusedResult({ subtype: '' }),
  ]) {
    const failure = classifyClaudeResultFailure(result);
    assert.doesNotMatch(failure.code, /success|unknown/, JSON.stringify(result));
    assert.equal(failure.stableCode, `claude.${failure.code}`);
  }
});

test('the assistant message names the failure', () => {
  const cases = [
    ['billing_error', CLAUDE_ACCOUNT_GUIDANCE],
    ['oauth_org_not_allowed', CLAUDE_ACCOUNT_GUIDANCE],
    ['account_on_hold', CLAUDE_ACCOUNT_GUIDANCE],
    ['verification_required', CLAUDE_ACCOUNT_GUIDANCE],
    ['authentication_failed', CLAUDE_SIGN_IN_GUIDANCE],
    ['model_not_found', CLAUDE_MODEL_GUIDANCE],
    ['invalid_request', null],
    ['overloaded', null],
    ['server_error', null],
    ['max_output_tokens', null],
  ];
  for (const [assistantError, guidance] of cases) {
    const failure = classifyClaudeResultFailure(refusedResult({ assistantError, terminalReason: 'api_error' }));
    assert.equal(failure.code, assistantError);
    assert.equal(failure.guidance, guidance, assistantError);
  }
});

test('a rate limit gets its code and the relay\'s default advice', () => {
  const failure = classifyClaudeResultFailure(
    refusedResult({ assistantError: 'rate_limit', apiErrorStatus: 429, terminalReason: 'api_error' }),
  );
  assert.equal(failure.stableCode, 'claude.rate_limit');
  assert.equal(failure.guidance, null);
  assert.equal(classifyClaudeResultFailure(refusedResult({ apiErrorStatus: 429 })).code, 'rate_limit');
});

test('the status names the failure where the assistant message does not', () => {
  assert.equal(classifyClaudeResultFailure(refusedResult({ apiErrorStatus: 401 })).code, 'authentication_failed');
  assert.equal(classifyClaudeResultFailure(refusedResult({ apiErrorStatus: 402 })).code, 'billing_error');
  assert.equal(classifyClaudeResultFailure(refusedResult({ apiErrorStatus: 529 })).code, 'overloaded');
  assert.equal(classifyClaudeResultFailure(refusedResult({ apiErrorStatus: 500 })).code, 'api-error');
  assert.equal(classifyClaudeResultFailure(refusedResult({ assistantError: 'unknown' })).code, 'api-error');
  assert.equal(classifyClaudeResultFailure(refusedResult({ terminalReason: 'api_error' })).code, 'api-error');
});

test('an account refusal is recognised by its words alone', () => {
  const access = classifyClaudeResultFailure(refusedResult({ text: ORG_DISABLED_TEXT }));
  assert.equal(access.stableCode, 'claude.account-access');
  assert.equal(access.guidance, CLAUDE_ACCOUNT_GUIDANCE);

  const billing = classifyClaudeResultFailure(refusedResult({ text: 'Credit balance is too low' }));
  assert.equal(billing.code, 'billing_error');
  assert.equal(billing.guidance, CLAUDE_ACCOUNT_GUIDANCE);

  const signIn = classifyClaudeResultFailure(refusedResult({ text: 'Invalid API key · Please run /login' }));
  assert.equal(signIn.code, 'authentication_failed');
  assert.equal(signIn.guidance, CLAUDE_SIGN_IN_GUIDANCE);
});

test('a turn that stopped early keeps the subtype as its code', () => {
  const failure = classifyClaudeResultFailure(refusedResult({ text: '', subtype: 'error_max_turns', terminalReason: 'max_turns' }));
  assert.equal(failure.stableCode, 'claude.error_max_turns');
  assert.equal(failure.guidance, null);
});

test('a failed turn that names nothing is a turn error', () => {
  assert.equal(classifyClaudeResultFailure(refusedResult()).stableCode, 'claude.turn-error');
  assert.equal(classifyClaudeResultFailure(refusedResult({ terminalReason: 'completed' })).code, 'turn-error');
  assert.equal(classifyClaudeResultFailure(refusedResult({ terminalReason: 'prompt_too_long' })).code, 'prompt_too_long');
  assert.equal(classifyClaudeResultFailure().code, 'turn-error');
});

test('no advice tells the user to retry an account failure or to restart the relay', () => {
  for (const guidance of [CLAUDE_ACCOUNT_GUIDANCE, CLAUDE_SIGN_IN_GUIDANCE, CLAUDE_MODEL_GUIDANCE]) {
    assert.doesNotMatch(guidance, /restart/i);
    assert.doesNotMatch(guidance, /^(retry|send the message again)/i);
  }
  assert.match(CLAUDE_ACCOUNT_GUIDANCE, /Settings → Providers → Claude/);
  assert.match(CLAUDE_SIGN_IN_GUIDANCE, /Settings → Providers → Claude → Relogin/);
});

test('a turn the account refuses reaches the relay with an account code and advice', async () => {
  const stub = makeApiStub();
  const runner = makeRunner({
    stub,
    startImpl: () => fakeTurn([
      initMessage('native-1'),
      {
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'oauth_org_not_allowed',
        message: { id: 'msg-refused', model: '<synthetic>', content: [{ type: 'text', text: ORG_DISABLED_TEXT }] },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 403,
        terminal_reason: 'api_error',
        result: ORG_DISABLED_TEXT,
        session_id: 'native-1',
        num_turns: 1,
        duration_api_ms: 0,
      },
    ]),
  });

  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage } }), true);
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  const { terminalError } = response.body;
  assert.equal(terminalError.kind, 'claude-turn-failed');
  assert.equal(terminalError.code, 'oauth_org_not_allowed');
  assert.equal(terminalError.stableCode, 'claude.oauth_org_not_allowed');
  assert.equal(terminalError.message, ORG_DISABLED_TEXT);
  assert.equal(terminalError.guidance, CLAUDE_ACCOUNT_GUIDANCE);
  await settled(runner);
});

test('a plain failed turn reaches the relay as a turn error without advice of its own', async () => {
  const stub = makeApiStub();
  const runner = makeRunner({
    stub,
    startImpl: () => fakeTurn([
      initMessage('native-1'),
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'The turn could not be completed.',
        session_id: 'native-1',
        num_turns: 1,
        duration_api_ms: 12,
      },
    ]),
  });

  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage } }), true);
  const { terminalError } = stub.calls.find((call) => call.routePath === '/api/response').body;
  assert.equal(terminalError.stableCode, 'claude.turn-error');
  assert.equal(terminalError.guidance, null);
  await settled(runner);
});
