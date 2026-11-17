// scripts/server-runtime-source-readers.mjs on made-up test files: which
// names hold the runtime's text (by scope), how an assertion is classed, and
// when an absence counts as anchored.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { blankComments } from './js-scan.mjs';
import { READERS_DOC, buildReport, classifyAssertion, patternOf, readerAssertions } from './server-runtime-source-readers.mjs';

// The doc follows the tree: a test that starts or stops reading the runtime,
// or moves its assertions, needs `node scripts/server-runtime-source-readers.mjs --write`.
test('docs/server-runtime-source-readers.md matches the tree', () => {
  const current = fs.readFileSync(READERS_DOC, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const fresh = buildReport().split('\n');
  const first = current.findIndex((line, index) => line !== fresh[index]);
  const at = first === -1 && current.length !== fresh.length ? Math.min(current.length, fresh.length) : first;
  assert.equal(at, -1, `the doc is out of date from line ${at + 1} (doc: ${JSON.stringify(current[at])}, now: ${JSON.stringify(fresh[at])}); run node scripts/server-runtime-source-readers.mjs --write`);
});

const RUNTIME = [
  "import x from 'y';",
  '// ─── Config ─────────────────',
  'function loadConfig() {',
  '  return readConfig();',
  '}',
  '// ─── Start ──────────────────',
  'httpServer.listen(port);',
].join('\n');

const READER = [
  "const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8');",
  'function sliceBetween(start, end) {',
  '  const from = runtimeSource.indexOf(start);',
  "  assert.notEqual(from, -1, 'missing');",
  '  return runtimeSource.slice(from, runtimeSource.indexOf(end, from));',
  '}',
  "test('config', () => {",
  "  const body = sliceBetween('function loadConfig() {', '\\n}');",
  '  assert.match(body, /readConfig\\(\\)/);',
  '  assert.doesNotMatch(body, /writeConfig/);',
  "  // const fake = 'not code';",
  '  assert.doesNotMatch(runtimeSource, /oldName/);',
  '});',
  "test('another file', () => {",
  "  const runtimeSource = fs.readFileSync('other.mjs', 'utf8');",
  '  assert.doesNotMatch(runtimeSource, /x/);',
  '  assert.match(/const fake = 1/.source, /fake/);',
  '});',
  "test('start', () => {",
  '  assert.ok(runtimeSource.includes(\'httpServer.listen(\'));',
  '  assert.ok(!runtimeSource.includes(\'app.listen(\'));',
  '});',
].join('\n');

test('readerAssertions: the runtime\'s names by scope, kinds, sections and anchors', () => {
  const found = readerAssertions(READER, RUNTIME).map(({ line, kind, target, section, anchor }) => ({ line, kind, target, section, anchor }));
  assert.deepEqual(found, [
    { line: 9, kind: 'presence', target: 'body', section: 'Config', anchor: undefined },
    { line: 10, kind: 'absence', target: 'body', section: 'Config', anchor: 'slice' },
    { line: 12, kind: 'absence', target: 'runtimeSource', section: '(whole file)', anchor: 'none' },
    { line: 20, kind: 'presence', target: 'runtimeSource', section: 'Start', anchor: undefined },
    { line: 21, kind: 'absence', target: 'runtimeSource', section: '(whole file)', anchor: 'same test (line 20)' },
  ]);
});

test('readerAssertions: null for a file that only names the runtime', () => {
  assert.equal(readerAssertions("// as server-runtime.mjs does it\nassert.ok(true);\n", RUNTIME), null);
});

test('classifyAssertion', () => {
  assert.equal(classifyAssertion('doesNotMatch', ['source', '/x/']), 'absence');
  assert.equal(classifyAssertion('match', ['source', '/x/']), 'presence');
  assert.equal(classifyAssertion('ok', ["!source.includes('x')"]), 'absence');
  assert.equal(classifyAssertion('ok', ["source.includes('x')"]), 'presence');
  assert.equal(classifyAssertion('ok', ["a < source.indexOf('x')"]), 'other');
  assert.equal(classifyAssertion('equal', ["source.includes('x')", 'false']), 'absence');
  assert.equal(classifyAssertion('notEqual', ['start', '-1'], "source.indexOf('x')"), 'presence');
  assert.equal(classifyAssertion('equal', ['count', '3']), 'other');
});

test('patternOf takes a regex literal, else the first string', () => {
  assert.deepEqual(patternOf(['source', '/a\\/b[/]c/m']), { kind: 'regex', text: 'a\\/b[/]c', flags: 'm' });
  assert.deepEqual(patternOf(["source.includes('it\\'s')"]), { kind: 'string', text: "it's" });
});

test('blankComments keeps offsets and leaves regex literals that hold // alone', () => {
  const source = "const a = /https?:\\/\\//; // note\nconst b = 'x'; /* c */";
  const blanked = blankComments(source);
  assert.equal(blanked.length, source.length);
  assert.match(blanked, /const a = \/https\?:\\\/\\\/\/;\s+\nconst b = 'x';\s+$/);
  assert.equal(blankComments(source, { literals: true }).slice(0, 24), `const a = /${' '.repeat(11)}/;`);
});
