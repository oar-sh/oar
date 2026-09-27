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

// Remote relays: the mention hint rides in the queued prompt only, and any
// displayed copy of that prompt (a transcript) must drop it. The header line
// another relay writes on an agent's prompt is the agent's to read: the server
// keeps it (POST /api/message runs this sanitizer on incoming text, and the
// stored text must still carry it); the browser hides it when the message has
// an origin.
test('the remote relay mention hint is stripped wherever the prompt is displayed', async () => {
  const { formatRemoteRelayMentionHint } = await import('./remote-relay-inbound.mjs');
  const hint = formatRemoteRelayMentionHint([{ relayId: 'r-linux', name: 'linux-test', online: true, version: '0.9.4' }]);
  assert.equal(stripRelayPromptContext(`ask @linux-test for the numbers\n\n${hint}`, 'agent'), 'ask @linux-test for the numbers');
  assert.equal(
    stripRelayPromptContext(`[Relay mode: agent] ask @linux-test for the numbers\n\n${hint}`, 'agent'),
    'ask @linux-test for the numbers',
  );
});

test('the header line of a remote agent\'s prompt survives, alone or behind a mode marker', async () => {
  const { withRemotePromptHeader, formatRemotePromptHeader } = await import('../../shared/remote-relay-contract.mjs');
  const origin = { relayName: 'win-test', conversationTitle: 'report builder', model: 'claude-sonnet-5' };
  const text = withRemotePromptHeader('summarise the sidebar polish work', origin);
  assert.equal(stripRelayPromptContext(text, 'agent'), text);
  assert.equal(stripRelayPromptContext(`[Relay mode: agent] ${text}`, 'agent'), text);
  assert.ok(stripRelayPromptContext(text).startsWith(`${formatRemotePromptHeader(origin)}\n\n`));
});

test('the slash-command guard the Claude worker puts in front of a "/x" is stripped', async () => {
  const { SLASH_COMMAND_GUARD, withSlashCommandGuard } = await import('../../shared/slash-command-guard.mjs');
  assert.equal(stripRelayPromptContext(withSlashCommandGuard('/help what is 3 + 4?')), '/help what is 3 + 4?');
  assert.equal(stripRelayPromptContext(`[Relay mode: agent] ${SLASH_COMMAND_GUARD}/x`, 'agent'), '/x');
  // A zero-width space not guarding a "/" is the user's own text.
  assert.equal(stripRelayPromptContext(`${SLASH_COMMAND_GUARD}hello`), `${SLASH_COMMAND_GUARD}hello`);
  assert.equal(stripRelayPromptContext('/review this'), '/review this');
});
