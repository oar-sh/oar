import test from 'node:test';
import assert from 'node:assert/strict';

import { FAILURE_NOTE_LEAD_MAX, isFailureNoteText, matchFailureNote } from './failure-note-text.mjs';

test('a note of the relay is known by its shape', () => {
  const note = 'System note: the turn failed (the runtime exited). Error code: relay.copilot-turn-error. Send the message again to retry.';
  assert.deepEqual(matchFailureNote(note), {
    stableCode: 'relay.copilot-turn-error',
    index: note.indexOf('Error code'),
    lead: 'System note: the turn failed (the runtime exited). ',
  });
  assert.equal(isFailureNoteText('  Relay timeout. ERROR CODE: relay.Turn-Aborted  '), true);
});

test('a reply that talks about a note is a reply', () => {
  for (const text of [
    '',
    'All five lanterns were checked and none failed.',
    'The note read "Error code: relay.turn-aborted" and nothing else.',
    'The note read `Error code: relay.turn-aborted`.',
    '| d | the note had Error code: relay.turn-aborted | pass |',
    '> Error code: relay.turn-aborted',
    '## Error code: relay.turn-aborted',
    '3. the stopped turn carries Error code: relay.turn-aborted',
    'Report on the harbour ledger.\n\nThe failed turn showed Error code: relay.turn-aborted.',
    `${'x'.repeat(FAILURE_NOTE_LEAD_MAX + 1)} Error code: relay.turn-aborted.`,
  ]) {
    assert.equal(isFailureNoteText(text), false, text.slice(0, 50));
  }
});

test('the browser mirror in relay-error-ctas.mjs agrees with this module', async () => {
  const { relayErrorCodeFromText } = await import('../server/public/app/relay-error-ctas.mjs');
  const samples = [
    'System note: the turn failed (the runtime exited). Error code: relay.copilot-turn-error. Send the message again to retry.',
    '  Relay timeout. ERROR CODE: relay.Turn-Aborted  ',
    'The note read "Error code: relay.turn-aborted" and nothing else.',
    'The note read `Error code: relay.grok-cli-missing`.',
    '| d | the note had Error code: relay.turn-aborted | pass |',
    '> Error code: relay.turn-aborted',
    '## Error code: relay.turn-aborted',
    '3. the stopped turn carries Error code: relay.turn-aborted',
    'Report on the harbour ledger.\n\nThe failed turn showed Error code: relay.grok-cli-missing.',
    `${'x'.repeat(FAILURE_NOTE_LEAD_MAX + 1)} Error code: relay.turn-aborted.`,
    'nothing here',
  ];
  for (const text of samples) {
    const note = matchFailureNote(text);
    assert.equal(relayErrorCodeFromText(text), note ? note.stableCode.replace(/^relay\./, '') : '', text.slice(0, 50));
  }
});
