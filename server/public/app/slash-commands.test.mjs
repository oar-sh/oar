import test from 'node:test';
import assert from 'node:assert/strict';

import * as registry from './slash-commands.mjs';

const { SLASH_COMMANDS, completionsFor, matchesKnownCommand } = registry;

const TOKEN_A = 'a1b2c3d4' + 'e'.repeat(24);
const TOKEN_B = 'a1ffffff' + 'e'.repeat(24);

const PREVIEWS = [
  { token: TOKEN_A, label: 'demo page', conversationId: 'conv-mine' },
  { token: TOKEN_B, label: 'other app', conversationId: 'conv-other' },
];

function complete(text, opts = {}) {
  return completionsFor(text, text.length, { previews: PREVIEWS, conversationId: 'conv-mine', ...opts });
}

// ─── command level ────────────────────────────────────────────────────────────

test('"/" lists every command with descriptions', () => {
  const result = complete('/');
  assert.equal(result.items.length, SLASH_COMMANDS.length);
  assert.deepEqual(result.items.map((item) => item.insert), ['/compact', '/preview']);
  assert.equal(result.items.every((item) => item.description.length > 0), true);
  assert.deepEqual(result.replaceRange, [0, 1]);
});

test('a prefix narrows commands and the replace range spans the whole head', () => {
  const result = complete('/pre');
  assert.deepEqual(result.items.map((item) => item.insert), ['/preview']);
  assert.deepEqual(result.replaceRange, [0, 4]);
});

test('an unmatched command prefix closes the menu', () => {
  assert.equal(complete('/xyz'), null);
});

// ─── position-0 gating ────────────────────────────────────────────────────────

test('a slash anywhere but position 0 never opens the menu', () => {
  assert.equal(complete(' /pre'), null);
  assert.equal(complete('see /preview'), null);
  assert.equal(complete('a\n/pre'), null);
  assert.equal(complete(''), null);
});

test('a newline before the caret closes the menu even with a leading slash', () => {
  const text = '/preview 5173\nsecond line';
  assert.equal(completionsFor(text, text.length, {}), null);
});

// ─── subcommand level ─────────────────────────────────────────────────────────

test('"/preview " offers subcommands plus display-only shape hints', () => {
  const result = complete('/preview ');
  assert.deepEqual(
    result.items.map((item) => [item.kind, item.display]),
    [
      ['subcommand', 'list'],
      ['subcommand', 'close'],
      ['hint', '<port>'],
      ['hint', '<dir>'],
    ],
  );
  assert.equal(result.items.find((item) => item.kind === 'hint').insert, null);
  assert.deepEqual(result.replaceRange, [9, 9]);
});

test('typing a subcommand prefix drops the hints and narrows', () => {
  const result = complete('/preview c');
  assert.deepEqual(result.items.map((item) => item.insert), ['close']);
  assert.deepEqual(result.replaceRange, [9, 10]);
});

test('"/compact " has nothing to offer', () => {
  assert.equal(complete('/compact '), null);
});

// ─── dynamic tokens ───────────────────────────────────────────────────────────

test('"/preview close " lists live tokens, this conversation first', () => {
  const result = complete('/preview close ');
  assert.deepEqual(result.items.map((item) => item.insert), [TOKEN_A, TOKEN_B]);
  assert.equal(result.items[0].display, TOKEN_A.slice(0, 8));
  assert.equal(result.items[0].description, 'demo page');
  assert.match(result.items[1].description, /other app · session conv-oth/);
});

test('a token prefix filters and full-range replacement covers the typed part', () => {
  const result = complete('/preview close a1f');
  assert.deepEqual(result.items.map((item) => item.insert), [TOKEN_B]);
  assert.deepEqual(result.replaceRange, [15, 18]);
});

test('no live previews or no match → menu closes', () => {
  assert.equal(complete('/preview close ', { previews: [] }), null);
  assert.equal(complete('/preview close zz'), null);
});

test('"/preview list " offers nothing further', () => {
  assert.equal(complete('/preview list '), null);
});

// ─── caret position ───────────────────────────────────────────────────────────

test('completion follows the caret, not the end of the string', () => {
  // Caret after "/pre" while the rest of an older draft trails behind it.
  const text = '/pre 5173 label';
  const result = completionsFor(text, 4, { previews: [] });
  assert.deepEqual(result.items.map((item) => item.insert), ['/preview']);
  assert.deepEqual(result.replaceRange, [0, 4]);
});

// ─── typo guard predicate ─────────────────────────────────────────────────────

test('matchesKnownCommand accepts exact commands only', () => {
  assert.equal(matchesKnownCommand('/compact'), true);
  assert.equal(matchesKnownCommand('/preview 5173 label'), true);
  assert.equal(matchesKnownCommand('/PREVIEW list'), true);
  // A prefix the user never completed is exactly the typo being guarded.
  assert.equal(matchesKnownCommand('/pre'), false);
  assert.equal(matchesKnownCommand('/previwe 5173'), false);
  assert.equal(matchesKnownCommand('not /preview'), false);
  assert.equal(matchesKnownCommand(''), false);
});

// ─── unknown-command guard ────────────────────────────────────────────────────

test('guard warns once, then lets the identical text through within the window', () => {
  const { evaluateUnknownCommandGuard } = registry;
  const first = evaluateUnknownCommandGuard('/previwe 5173', { slot: null, now: 1000 });
  assert.equal(first.warn, true);
  assert.match(first.notice, /Unknown command \/previwe/);
  assert.deepEqual(first.slot, { text: '/previwe 5173', at: 1000 });

  const second = evaluateUnknownCommandGuard('/previwe 5173', { slot: first.slot, now: 5000 });
  assert.deepEqual(second, { warn: false, slot: null });
});

test('guard re-arms after the window and on edited text', () => {
  const { evaluateUnknownCommandGuard } = registry;
  const slot = { text: '/previwe', at: 1000 };
  assert.equal(evaluateUnknownCommandGuard('/previwe', { slot, now: 9500 }).warn, true);
  assert.equal(evaluateUnknownCommandGuard('/previwe 5173', { slot, now: 2000 }).warn, true);
});

test('guard ignores known commands, prose, multi-line, and attachment sends', () => {
  const { evaluateUnknownCommandGuard } = registry;
  for (const [text, opts] of [
    ['/preview 5173', {}],
    ['/compact', {}],
    ['hello world', {}],
    ['/etc/hosts is broken\nsecond line', {}],
    ['/previwe', { hasAttachments: true }],
  ]) {
    const result = evaluateUnknownCommandGuard(text, { slot: null, now: 1000, ...opts });
    assert.deepEqual(result, { warn: false, slot: null }, `${JSON.stringify(text)} must pass`);
  }
});
