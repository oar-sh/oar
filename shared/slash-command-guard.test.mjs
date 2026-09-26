import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SLASH_COMMAND_GUARD,
  stripSlashCommandGuard,
  stripSlashCommandGuardContent,
  withSlashCommandGuard,
  withSlashCommandGuardContent,
} from './slash-command-guard.mjs';
import { stripSteerNote, withSteerNote, withSteerNoteContent } from './steer-note.mjs';

// The Claude CLI's own test for a prompt: the string, or its LAST text block,
// trimmed, starts with "/" (its trim() is JavaScript's, which keeps U+200B).
function cliReadsAsCommand(content) {
  if (typeof content === 'string') return content.trim().startsWith('/');
  const last = Array.isArray(content) ? content.at(-1) : null;
  return last?.type === 'text' && typeof last.text === 'string' && last.text.trim().startsWith('/');
}

test('the guard is a zero-width space JavaScript trim() keeps', () => {
  assert.equal(SLASH_COMMAND_GUARD, '\u200B');
  assert.equal(`${SLASH_COMMAND_GUARD}/x`.trim(), `${SLASH_COMMAND_GUARD}/x`);
});

test('text the CLI would run as a slash command gets the guard; anything else is untouched', () => {
  assert.equal(withSlashCommandGuard('/help what is 3 + 4?'), `${SLASH_COMMAND_GUARD}/help what is 3 + 4?`);
  assert.equal(cliReadsAsCommand(withSlashCommandGuard('/help what is 3 + 4?')), false);
  assert.equal(withSlashCommandGuard('  /x'), `${SLASH_COMMAND_GUARD}  /x`);
  assert.equal(cliReadsAsCommand(withSlashCommandGuard('  /x')), false);
  assert.equal(withSlashCommandGuard('plain text'), 'plain text');
  assert.equal(withSlashCommandGuard('see /tmp and C:/git'), 'see /tmp and C:/git');
  assert.equal(withSlashCommandGuard(''), '');
  // Idempotent: a guarded text no longer reads as a command.
  const once = withSlashCommandGuard('/x');
  assert.equal(withSlashCommandGuard(once), once);
});

test('content blocks: every text block that reads as a command is guarded, nothing is mutated', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const content = [{ type: 'text', text: '/describe this' }, image];
  const guarded = withSlashCommandGuardContent(content);
  assert.deepEqual(guarded, [{ type: 'text', text: `${SLASH_COMMAND_GUARD}/describe this` }, image]);
  assert.equal(content[0].text, '/describe this', 'the input is not mutated');
  const lastText = [image, { type: 'text', text: '/x' }];
  assert.equal(cliReadsAsCommand(lastText), true);
  assert.equal(cliReadsAsCommand(withSlashCommandGuardContent(lastText)), false);
  // Nothing to guard: the very same array comes back.
  const plain = [{ type: 'text', text: 'hello' }, image];
  assert.equal(withSlashCommandGuardContent(plain), plain);
  assert.equal(withSlashCommandGuardContent('/x'), `${SLASH_COMMAND_GUARD}/x`);
  assert.equal(withSlashCommandGuardContent(null), null);
});

test('a steered prompt needs no guard: the steer note already leads, so the guard leaves it exactly as noted', () => {
  const noted = withSteerNoteContent([{ type: 'text', text: '/review this' }]);
  assert.equal(withSlashCommandGuardContent(noted), noted);
  assert.equal(withSlashCommandGuard(withSteerNote('/review this')), withSteerNote('/review this'));
});

test('stripping gives back exactly the user text, and composes with the steer-note strip', () => {
  assert.equal(stripSlashCommandGuard(withSlashCommandGuard('/help me')), '/help me');
  assert.equal(stripSlashCommandGuard('/help me'), '/help me');
  assert.equal(stripSlashCommandGuard('plain'), 'plain');
  // Only a guard standing in front of a "/" is the relay's.
  assert.equal(stripSlashCommandGuard(`${SLASH_COMMAND_GUARD}hello`), `${SLASH_COMMAND_GUARD}hello`);
  assert.equal(stripSlashCommandGuard(`a ${SLASH_COMMAND_GUARD}/x`), `a ${SLASH_COMMAND_GUARD}/x`);
  assert.equal(stripSlashCommandGuard(null), '');
  assert.deepEqual(
    stripSlashCommandGuardContent(withSlashCommandGuardContent([{ type: 'text', text: '/x' }])),
    [{ type: 'text', text: '/x' }],
  );
  assert.equal(stripSteerNote(stripSlashCommandGuard(withSteerNote('/x'))), '/x');
});
