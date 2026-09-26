import test from 'node:test';
import assert from 'node:assert/strict';

import { stripRelayPromptContext } from './relay-prompt-sanitizer.mjs';

test('stripRelayPromptContext removes relay marker after current_datetime block', () => {
  const input = [
    '<current_datetime>2026-07-05T15:00:07.419+00:00</current_datetime>',
    '',
    '[Relay mode: agent] Explain test strategy',
  ].join('\n');
  const output = stripRelayPromptContext(input, 'agent');
  assert.equal(output, 'Explain test strategy');
});

test('stripRelayPromptContext removes relay marker after system_reminder block', () => {
  const input = [
    '<system_reminder>',
    '<sql_tables>Available tables: todos, todo_deps</sql_tables>',
    '</system_reminder>',
    '',
    '[Relay mode: plan] Draft a concise plan',
  ].join('\n');
  const output = stripRelayPromptContext(input, 'plan');
  assert.equal(output, 'Draft a concise plan');
});

test('stripRelayPromptContext keeps normal user text untouched', () => {
  const output = stripRelayPromptContext('Just a plain user message', 'agent');
  assert.equal(output, 'Just a plain user message');
});

test('stripRelayPromptContext drops the injected media-embed guidance block verbatim', async () => {
  const { renderMediaEmbedInstructionBlock } = await import('../../shared/media-embed-instructions.mjs');
  const input = `${renderMediaEmbedInstructionBlock()}\n\n[Relay mode: agent] hello`;
  const output = stripRelayPromptContext(input, 'agent');
  assert.equal(output, 'hello');
});

test('a steered message\'s hidden note is stripped, with or without a mode marker before it', () => {
  const note = '[Sent while you were still working on my previous message. If that request is not finished yet, finish it too; do not drop it unless this message says so.]';
  assert.equal(stripRelayPromptContext(`${note}\n\nalso do X`), 'also do X');
  assert.equal(stripRelayPromptContext(`[Relay mode: agent] ${note}\n\nalso do X`, 'agent'), 'also do X');
  // A note on its own (an attachment-only steer) is not turned into nothing.
  assert.equal(stripRelayPromptContext(note), note);
  // Text that merely quotes it later is left alone.
  assert.equal(stripRelayPromptContext(`see ${note}`), `see ${note}`);
});

test('the slash-command guard the Claude worker puts in front of a "/x" is stripped', async () => {
  const { SLASH_COMMAND_GUARD, withSlashCommandGuard } = await import('../../shared/slash-command-guard.mjs');
  assert.equal(stripRelayPromptContext(withSlashCommandGuard('/help what is 3 + 4?')), '/help what is 3 + 4?');
  assert.equal(stripRelayPromptContext(`[Relay mode: agent] ${SLASH_COMMAND_GUARD}/x`, 'agent'), '/x');
  // A zero-width space not guarding a "/" is the user's own text.
  assert.equal(stripRelayPromptContext(`${SLASH_COMMAND_GUARD}hello`), `${SLASH_COMMAND_GUARD}hello`);
  assert.equal(stripRelayPromptContext('/review this'), '/review this');
});
