import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTerminalFailureText, resolveTerminalFailurePayload } from './messages-routes.mjs';

const NOTE = 'No tool output was returned for a required function call. Error code: relay.missing-tool-output. '
  + 'IDs: functionCallId=call_abc123. Retry the message. Details: no tool output found for function call call_abc123';

test('a failure a sender reported as text is still read', () => {
  const parsed = parseTerminalFailureText(NOTE);
  assert.equal(parsed?.stableCode, 'relay.missing-tool-output');
  assert.equal(parsed.message, 'No tool output was returned for a required function call.');
  assert.equal(parsed.functionCallId, 'call_abc123');
  assert.equal(resolveTerminalFailurePayload({ text: NOTE })?.stableCode, 'relay.missing-tool-output');
});

test('a reply that quotes a failure note is a reply, not a failure', () => {
  const report = [
    '# Report on the lantern survey',
    '',
    '| Test | Observed | Result |',
    '|---|---|---|',
    '| d. Failure note | The note read: "The turn failed. Error code: relay.copilot-turn-error. Send the message again." | pass |',
    '| e. Harbour ledger | checked | pass |',
    '',
    'Everything after the quoted note belongs to the reply as well.',
  ].join('\n');
  assert.equal(parseTerminalFailureText(report), null);
  assert.equal(resolveTerminalFailurePayload({ text: report }), null);
});

test('a note that is quoted, in code or far down a long paragraph is not taken for the turn\'s own', () => {
  for (const text of [
    'The relay showed "Error code: relay.turn-aborted" under the stopped turn.',
    'The relay showed `Error code: relay.turn-aborted` under the stopped turn.',
    '> Error code: relay.turn-aborted',
    '- the stopped turn carries Error code: relay.turn-aborted',
    `${'The survey went through every ledger of the harbour. '.repeat(14)}Error code: relay.turn-aborted.`,
    'First line of a reply.\nSecond line with Error code: relay.turn-aborted.',
  ]) {
    assert.equal(parseTerminalFailureText(text), null, text.slice(0, 60));
  }
});

test('a record of the failure still decides, whatever the text says', () => {
  const resolved = resolveTerminalFailurePayload({
    text: 'Line one.\nLine two.',
    terminalError: { code: 'turn-error', stableCode: 'copilot.turn-error', message: 'The runtime exited.' },
  });
  assert.equal(resolved?.terminal, true);
  assert.match(String(resolved.stableCode), /turn-error/);
});

test('a failure known from its text alone says so, a reported one does not', () => {
  assert.equal(resolveTerminalFailurePayload({ text: NOTE })?.fromText, true);
  for (const payload of [
    { text: NOTE, terminalError: { code: 'turn-error', message: 'The runtime exited.' } },
    { text: NOTE, terminal: true },
    { text: NOTE, errorCode: 'missing-tool-output' },
  ]) {
    assert.equal(resolveTerminalFailurePayload(payload)?.fromText, undefined, JSON.stringify(Object.keys(payload)));
  }
});
