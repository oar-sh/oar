import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import * as mirror from './task-output-text.mjs';
import * as shared from '../../../shared/task-output-text.mjs';

// The browser cannot import shared/, so task-output-text.mjs is a hand-kept
// copy of the folder, the colour segments and the stall minutes. These
// assertions fail the moment either side changes without the other.

const fixturesDir = new URL('../../../shared/fixtures/task-output/', import.meta.url);
const fixtures = readdirSync(fixturesDir)
  .filter((name) => name.endsWith('.txt'))
  .map((name) => ({ name, text: readFileSync(new URL(name, fixturesDir), 'utf8') }));

const SAMPLES = [
  'plain line\nsecond line\n',
  'progress 10%\rprogress 50%\rprogress 100%\ndone\n',
  'same\nsame\nsame\nother\nsame\n',
  'windows\r\nline\r\nends\r\n',
  'open line without newline',
  'trailing cr waits\r',
  '\x1b[32m✓ green\x1b[0m and \x1b[1;31mbold red\x1b[0m\n',
  '\x1b[38;5;196mpalette\x1b[39m \x1b[48;2;10;200;30mtrue\x1b[49m\n',
  '\x1b]0;window title\x07\x1b[2Kcleared \x1b[3mitalic\x1b[23m\n',
  `${'x'.repeat(4100)}\n`,
  '',
];

function feedInPieces(folderFactory, text, size) {
  const folder = folderFactory();
  let result = folder.feed('');
  for (let at = 0; at < text.length; at += size) result = folder.feed(text.slice(at, at + size));
  return { lines: result.lines.map((line) => ({ ...line })), partial: result.partial };
}

test('the folder agrees with the shared one, whole and fed in pieces', () => {
  for (const { name, text } of [...SAMPLES.map((text, index) => ({ name: `sample ${index}`, text })), ...fixtures]) {
    for (const size of [1, 3, 7, 64, text.length || 1]) {
      assert.deepEqual(
        feedInPieces(mirror.createLineFolder, text, size),
        feedInPieces(shared.createLineFolder, text, size),
        `${name}, pieces of ${size}`,
      );
    }
  }
});

test('the folder reports where a feed changed things and closes the open line, as the shared one does', () => {
  const ours = mirror.createLineFolder();
  const theirs = shared.createLineFolder();
  for (const piece of ['a\n', 'a\n', 'b\nc', '\rd\n', 'tail']) {
    const left = ours.feed(piece);
    const right = theirs.feed(piece);
    assert.equal(left.changedFrom, right.changedFrom, JSON.stringify(piece));
    assert.equal(left.partial, right.partial);
  }
  assert.deepEqual(ours.end().lines.map((line) => ({ ...line })), theirs.end().lines.map((line) => ({ ...line })));
});

test('the colour segments agree with the shared ones', () => {
  const lines = [...SAMPLES, ...fixtures.flatMap(({ text }) => text.split('\n'))];
  for (const line of lines) {
    assert.deepEqual(mirror.ansiToSegments(line), shared.ansiToSegments(line), JSON.stringify(line.slice(0, 80)));
  }
});

test('control stripping agrees with the shared one', () => {
  for (const text of [...SAMPLES, '\x07bell\x1b7saved\x1b(Bcharset\x9bc1', '\x1b]8;;https://example.invalid\x1b\\link\x1b]8;;\x1b\\']) {
    assert.equal(mirror.stripControlKeepSgr(text), shared.stripControlKeepSgr(text), JSON.stringify(text));
  }
});

test('stall minutes agree with the shared ones', () => {
  const now = Date.parse('2026-03-04T05:06:07Z');
  for (const value of [now, now - 59_000, now - 60_000, now - 12.5 * 60_000, new Date(now - 3 * 60_000).toISOString(), null, '', 0, 'nonsense', now + 60_000]) {
    assert.equal(mirror.stallMinutes(value, now), shared.stallMinutes(value, now), String(value));
  }
});

test('the line cut matches the shared limit', () => {
  assert.equal(mirror.TASK_OUTPUT_LINE_CHARS_MAX, shared.TASK_OUTPUT_LIMITS.lineCharsMax);
});
