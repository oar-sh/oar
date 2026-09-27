import test from 'node:test';
import assert from 'node:assert/strict';

import { stripRelayPromptContext, stripRemoteRelayDisplayArtifacts } from './relay-prompt-sanitizer.mjs';
import { withRemotePromptHeader } from '../../../shared/remote-relay-contract.mjs';

const ORIGIN = {
  kind: 'agent',
  relayId: 'relay-a',
  relayName: 'win-test',
  relayUrl: 'https://relay-a.example.test',
  conversationId: 'conv-a',
  conversationTitle: 'report builder',
  provider: 'claude',
  model: 'claude-sonnet-5',
  hops: 1,
};
const MENTION_HINT = '<system_reminder>The user mentioned the remote OAR relay "linux-test" (online, OAR 0.9.4). Use the remote_relay tool for work there.</system_reminder>';

test('browser stripRelayPromptContext handles datetime and system reminder wrappers', () => {
  const input = [
    '<current_datetime>2026-07-05T15:00:07.419+00:00</current_datetime>',
    '<system_reminder><sql_tables>Available tables: todos</sql_tables></system_reminder>',
    '[Relay mode: ask] Ask clarifying questions first',
  ].join('\n');
  const output = stripRelayPromptContext(input, 'ask');
  assert.equal(output, 'Ask clarifying questions first');
});

test('browser stripRelayPromptContext drops a leading media-embed guidance block', () => {
  const input = [
    '## Embedding media in replies',
    '',
    'To show the user an image, video, or audio clip inline in a reply, write a markdown image whose target is the absolute path.',
    '',
    '[Relay mode: ask] Prioritize clarification questions before implementation work.',
    '',
    'hello',
  ].join('\n');
  const output = stripRelayPromptContext(input, 'ask');
  assert.doesNotMatch(output, /Embedding media in replies/);
  assert.doesNotMatch(output, /^\[Relay mode/);
  assert.match(output, /hello$/);
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
  // The browser copy cannot import shared/, so it matches the guard itself;
  // this pins it to the same character the worker sends.
  const { SLASH_COMMAND_GUARD, withSlashCommandGuard } = await import('../../../shared/slash-command-guard.mjs');
  assert.equal(stripRelayPromptContext(withSlashCommandGuard('/help what is 3 + 4?')), '/help what is 3 + 4?');
  assert.equal(stripRelayPromptContext(`[Relay mode: agent] ${SLASH_COMMAND_GUARD}/x`, 'agent'), '/x');
  assert.equal(stripRelayPromptContext(`${SLASH_COMMAND_GUARD}hello`), `${SLASH_COMMAND_GUARD}hello`);
  assert.equal(stripRelayPromptContext('/review this'), '/review this');
});

test('the remote prompt header is hidden only on a message that carries origin', () => {
  const stored = withRemotePromptHeader('run the suite and report back', ORIGIN);
  assert.equal(stripRelayPromptContext(stored, 'agent', { origin: ORIGIN }), 'run the suite and report back');
  // No origin: a human who pasted such a line sees it as typed.
  assert.equal(stripRelayPromptContext(stored, 'agent'), stored);
  assert.equal(stripRelayPromptContext(stored, 'agent', {}), stored);
  // Behind a mode marker (a runtime-stored prompt) and behind a steer note.
  const note = '[Sent while you were still working on my previous message. If that request is not finished yet, finish it too; do not drop it unless this message says so.]';
  assert.equal(stripRelayPromptContext(`[Relay mode: agent] ${stored}`, 'agent', { origin: ORIGIN }), 'run the suite and report back');
  assert.equal(stripRelayPromptContext(`${note}\n\n${stored}`, '', { origin: ORIGIN }), 'run the suite and report back');
  // A header with nothing after it is not turned into nothing.
  assert.match(stripRelayPromptContext('[Remote prompt from an agent on relay "win-test" · acting for the user]', '', { origin: ORIGIN }), /^\[Remote prompt/);
});

test('the mention hint never reaches a bubble', () => {
  assert.equal(stripRelayPromptContext(`ask @linux-test to run it\n\n${MENTION_HINT}`, 'agent'), 'ask @linux-test to run it');
  assert.equal(stripRemoteRelayDisplayArtifacts(`ask @linux-test to run it\n\n${MENTION_HINT}`), 'ask @linux-test to run it');
});

test('display cleanup leaves ordinary text alone', () => {
  const stored = withRemotePromptHeader('run the suite', ORIGIN);
  assert.equal(stripRemoteRelayDisplayArtifacts(stored, { origin: ORIGIN }), 'run the suite');
  assert.equal(stripRemoteRelayDisplayArtifacts(stored), stored);
  for (const text of ['', '  indented\ntext  ', 'see <system_reminder>other</system_reminder>', '@linux-test hi']) {
    assert.equal(stripRemoteRelayDisplayArtifacts(text), text);
    assert.equal(stripRemoteRelayDisplayArtifacts(text, { origin: ORIGIN }), text);
  }
});
