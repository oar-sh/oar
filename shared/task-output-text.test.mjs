import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_TASK_STALL_MINUTES,
  TASK_OUTPUT_LIMITS,
  ansiToSegments,
  cleanTaskOutput,
  createLineFolder,
  foldTaskOutput,
  normalizeTaskOutputKind,
  normalizeTaskOutputPath,
  parseRunnerSummary,
  parseTaskStallMinutesUpdate,
  readTaskStallMinutesSetting,
  scrubSecrets,
  scrubTaskOutput,
  stallMinutes,
  stripControlKeepSgr,
  stripSgr,
} from './task-output-text.mjs';

// Credential-shaped values are put together at run time: the hygiene scan
// refuses token shapes in the source.
const fake = (...parts) => parts.join('');
const GH_TOKEN = fake('gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789');

const fixture = (name) => readFileSync(new URL(`./fixtures/task-output/${name}`, import.meta.url), 'utf8');
const linesOf = (text) => foldTaskOutput(cleanTaskOutput(text));
const before = (text, marker) => {
  const at = text.indexOf(marker);
  assert.ok(at > 0, `marker ${JSON.stringify(marker)} is in the fixture`);
  return text.slice(0, at);
};

// ─── Control codes ───────────────────────────────────────────────────────────

test('control stripping keeps SGR and drops every other escape', () => {
  const input = 'a\x1b[31mred\x1b[0m\x1b]0;window title\x07b\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\'
    + '\x1b[2K\x1b[1A\x1b[?25l\x1b(Bc\x1b7d\x1b=e\x00f\x08g\x9bh\x7fi\tj\r\nk';
  assert.equal(stripControlKeepSgr(input), 'a\x1b[31mred\x1b[0mblinkcdefghi\tj\r\nk');
});

test('control stripping leaves plain text untouched and drops a cut-off escape', () => {
  assert.equal(stripControlKeepSgr('plain line\n'), 'plain line\n');
  assert.equal(stripControlKeepSgr('tail\x1b'), 'tail');
  assert.equal(stripControlKeepSgr('osc\x1b]0;never ends'), 'osc');
  assert.equal(stripControlKeepSgr('\x1b[38;5;208mamber\x1b[39m'), '\x1b[38;5;208mamber\x1b[39m');
  assert.equal(stripSgr('\x1b[1m\x1b[32mok\x1b[39m\x1b[22m'), 'ok');
});

// ─── Folder ──────────────────────────────────────────────────────────────────

test('a carriage-return redraw collapses to its final state', () => {
  const folder = createLineFolder();
  const result = folder.feed('downloading 10%\rdownloading 55%\rdownloading 100%\ndone\n');
  assert.deepEqual(result.lines, [{ text: 'downloading 100%', count: 1 }, { text: 'done', count: 1 }]);
  assert.equal(result.partial, '');
});

test('CRLF is a newline, and a CR at the end of a feed waits for the next one', () => {
  const folder = createLineFolder();
  assert.deepEqual(folder.feed('first\r\nsecond\r').lines, [{ text: 'first', count: 1 }]);
  assert.equal(folder.feed('').partial, 'second');
  const next = folder.feed('\nthird 1/3\r');
  assert.deepEqual(next.lines.map((line) => line.text), ['first', 'second']);
  assert.equal(next.partial, 'third 1/3');
  assert.equal(folder.feed('third 3/3').partial, 'third 3/3');
});

test('adjacent identical lines fold into one with a count, across feeds', () => {
  const folder = createLineFolder();
  folder.feed('waiting for port\nwaiting for ');
  const result = folder.feed('port\nwaiting for port\nready\nwaiting for port\n');
  assert.deepEqual(result.lines, [
    { text: 'waiting for port', count: 3 },
    { text: 'ready', count: 1 },
    { text: 'waiting for port', count: 1 },
  ]);
});

test('changedFrom names the first line a feed added or bumped', () => {
  const folder = createLineFolder();
  assert.equal(folder.feed('one\ntwo\n').changedFrom, 0);
  assert.equal(folder.feed('two\n').changedFrom, 1);
  assert.equal(folder.feed('three\n').changedFrom, 2);
  assert.equal(folder.feed('par').changedFrom, 3);
  const ended = folder.end();
  assert.equal(ended.changedFrom, 3);
  assert.deepEqual(ended.lines.at(-1), { text: 'par', count: 1 });
  assert.equal(ended.partial, '');
});

test('a line is cut at 4,000 characters, also while it is still open', () => {
  const folder = createLineFolder();
  const long = 'x'.repeat(TASK_OUTPUT_LIMITS.lineCharsMax + 500);
  assert.equal(folder.feed(long).partial.length, TASK_OUTPUT_LIMITS.lineCharsMax);
  const result = folder.feed(`${long}\nshort\n`);
  assert.equal(result.lines[0].text.length, TASK_OUTPUT_LIMITS.lineCharsMax);
  assert.equal(result.lines[1].text, 'short');
});

test('foldTaskOutput marks colour lines and the open partial line', () => {
  assert.deepEqual(foldTaskOutput('\x1b[32mok\x1b[39m\nok\nok\nrunning'), [
    { text: '\x1b[32mok\x1b[39m', count: 1, ansi: true },
    { text: 'ok', count: 2, ansi: false },
    { text: 'running', count: 1, ansi: false, partial: true },
  ]);
});

// ─── Colours ─────────────────────────────────────────────────────────────────

test('SGR becomes segments: 16 colours, styles and reset', () => {
  assert.deepEqual(ansiToSegments('a\x1b[1;31mb\x1b[22;4;3;2mc\x1b[0md\x1b[97;104me'), [
    { text: 'a', fg: null, bg: null, bold: false, dim: false, italic: false, underline: false },
    { text: 'b', fg: 1, bg: null, bold: true, dim: false, italic: false, underline: false },
    { text: 'c', fg: 1, bg: null, bold: false, dim: true, italic: true, underline: true },
    { text: 'd', fg: null, bg: null, bold: false, dim: false, italic: false, underline: false },
    { text: 'e', fg: 15, bg: 12, bold: false, dim: false, italic: false, underline: false },
  ]);
});

test('256-colour and truecolor map to the nearest of the 16', () => {
  const [orange] = ansiToSegments('\x1b[38;5;196mx');
  assert.equal(orange.fg, 9);
  const [grey] = ansiToSegments('\x1b[38;5;244mx');
  assert.equal(grey.fg, 8);
  const [green] = ansiToSegments('\x1b[38;2;10;200;20;48;2;0;0;230mx');
  assert.equal(green.fg, 2);
  assert.equal(green.bg, 4);
  // A cut-off extended colour changes nothing and does not throw.
  assert.equal(ansiToSegments('\x1b[38;5mx')[0].fg, null);
});

test('adjacent text with the same style is one segment, and other escapes vanish', () => {
  assert.deepEqual(ansiToSegments('\x1b[33ma\x1b[33mb\x1b[2Kc').map((segment) => segment.text), ['abc']);
  assert.deepEqual(ansiToSegments(''), []);
});

// ─── Secrets ─────────────────────────────────────────────────────────────────

test('scrubSecrets keeps the CLI helpers\' rules (eager generic token rule)', () => {
  assert.equal(scrubSecrets('code ABCD-1234 here', 'ABCD-1234'), 'code [redacted] here');
  assert.equal(scrubSecrets('key sk-ant-xyz'), 'key [redacted]');
  assert.equal(scrubSecrets(`id ${'a'.repeat(32)}`), 'id [redacted]');
  assert.equal(scrubSecrets(null), '');
});

test('scrubTaskOutput removes the known credential shapes', () => {
  const cases = [
    [`export GITHUB_TOKEN=${GH_TOKEN}`, 'export GITHUB_TOKEN=[redacted]'],
    [`using ${GH_TOKEN} now`, 'using ghp_[redacted] now'],
    [`pat ${fake('github', '_pat_', '11ABCDEFG0123456789_abcdefghijk')}`, 'pat github_pat_[redacted]'],
    [`key ${fake('sk', '-proj-', 'AbCdEfGhIjKlMnOpQr12')}`, 'key sk-[redacted]'],
    [`slack ${fake('xo', 'xb-', '1234567890-abcdefghij')}`, 'slack xoxb-[redacted]'],
    [`aws ${fake('AK', 'IA', 'ABCDEFGHIJKLMNOP')} done`, 'aws AKIA[redacted] done'],
    ['curl -H "Authorization: Bearer abc.def.ghi123456"', 'curl -H "Authorization: Bearer [redacted]"'],
    ['git clone https://builder:s3cr3tpass@git.example.test/repo.git', 'git clone https://builder:[redacted]@git.example.test/repo.git'],
    ['DB_PASSWORD="hunter22" npm start', 'DB_PASSWORD="[redacted]" npm start'],
    ['{"api_key": "q1w2e3r4t5"}', '{"api_key": "[redacted]"}'],
    ['password: swordfish', 'password: [redacted]'],
    ['blob aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z end', 'blob [redacted] end'],
    [fake('-----BEGIN RSA PRIVATE', ' KEY-----\nMIIEow\n-----END RSA PRIVATE', ' KEY-----'), '[redacted private key]'],
  ];
  for (const [input, expected] of cases) assert.equal(scrubTaskOutput(input), expected, input);
});

test('scrubTaskOutput leaves ordinary test output alone', () => {
  const ordinary = [
    'test_rounds_bearing_to_the_nearest_whole_degree PASSED',
    'commit 0123456789abcdef0123456789abcdef01234567',
    'src/components/compass-needle-rotation.test.ts (12 tests) 8ms',
    'max_tokens=4096 temperature=0.2',
    'GIT_AUTHOR_NAME=Ann token: null',
    'Tests  2 failed | 412 passed (414)',
  ];
  for (const line of ordinary) assert.equal(scrubTaskOutput(line), line);
});

test('scrubTaskOutput keeps the colour codes around a secret intact', () => {
  assert.equal(
    scrubTaskOutput(`\x1b[2mtoken=\x1b[22m\x1b[33m${GH_TOKEN}\x1b[39m`),
    '\x1b[2mtoken=\x1b[22m\x1b[33mghp_[redacted]\x1b[39m',
  );
});

// ─── Runners: final summaries on real output ─────────────────────────────────

test('node:test spec reporter, plain and coloured', () => {
  for (const name of ['node-test-spec.txt', 'node-test-spec-color.txt']) {
    const lines = linesOf(fixture(name));
    const result = parseRunnerSummary(lines);
    assert.equal(result.runner, 'node:test', name);
    assert.deepEqual([result.passed, result.failed, result.skipped, result.final], [1, 1, 0, true], name);
    assert.match(stripSgr(lines[result.firstFailureLine].text), /^✖ lantern dims at dawn/);
  }
});

test('node:test TAP reporter', () => {
  const lines = linesOf(fixture('node-test-tap.txt'));
  const result = parseRunnerSummary(lines);
  assert.deepEqual([result.runner, result.passed, result.failed, result.final], ['node:test', 1, 1, true]);
  assert.equal(lines[result.firstFailureLine].text, 'not ok 2 - lantern dims at dawn');
});

test('Playwright list, line and dot reporters', () => {
  for (const name of ['playwright-list.txt', 'playwright-list-color.txt', 'playwright-line.txt', 'playwright-dot.txt']) {
    const lines = linesOf(fixture(name));
    const result = parseRunnerSummary(lines);
    assert.equal(result.runner, 'playwright', name);
    assert.deepEqual([result.passed, result.failed, result.final], [1, 1, true], name);
    assert.match(stripSgr(lines[result.firstFailureLine].text), /^ {2}1\) harbor\.spec\.mjs:3:1 › harbor bell rings twice/, name);
  }
});

test('vitest, jest and pytest summaries', () => {
  for (const [name, runner, detail] of [
    ['vitest.txt', 'vitest', /^ FAIL {2}src\/bearing\.test\.ts > bearing > rounds/],
    ['jest.txt', 'jest', /^ {2}● bearing › rounds/],
    ['pytest.txt', 'pytest', /^_+ test_rounds_to_degree _+$/],
  ]) {
    const lines = linesOf(fixture(name));
    const result = parseRunnerSummary(lines);
    assert.equal(result.runner, runner, name);
    assert.deepEqual([result.passed, result.failed, result.skipped, result.final], [412, 2, 0, true], name);
    assert.match(lines[result.firstFailureLine].text, detail, name);
  }
});

test('turbo task summary (pnpm running turbo)', () => {
  const result = parseRunnerSummary(linesOf(fixture('turbo.txt')));
  assert.deepEqual([result.runner, result.passed, result.failed, result.final], ['turbo', 3, 1, true]);
  assert.deepEqual(parseRunnerSummary([' Tasks:    3 successful, 1 failed, 4 total']).failed, 1);
});

// ─── Runners: counting while the run goes on ─────────────────────────────────

test('runs still going are counted from their per-test marks', () => {
  for (const [name, marker, runner, passed, failed] of [
    ['node-test-spec.txt', 'ℹ tests', 'node:test', 1, 1],
    ['node-test-tap.txt', '1..2', 'node:test', 1, 1],
    ['playwright-list.txt', '  1) ', 'playwright', 1, 1],
    ['vitest.txt', '⎯⎯⎯⎯⎯⎯⎯ Failed', 'vitest', 412, 2],
    ['jest.txt', 'Test Suites', 'jest', 0, 2],
    ['pytest.txt', '====== FAILURES', 'pytest', 412, 2],
  ]) {
    const lines = linesOf(before(fixture(name), marker));
    const result = parseRunnerSummary(lines);
    assert.equal(result.runner, runner, name);
    assert.equal(result.final, false, name);
    assert.deepEqual([result.passed, result.failed], [passed, failed], name);
    assert.ok(Number.isInteger(result.firstFailureLine), name);
  }
});

test('a folded repeat counts every time', () => {
  const result = parseRunnerSummary([
    { text: 'TAP version 13', count: 1 },
    { text: 'ok 1 - spins', count: 3 },
    { text: 'not ok 2 - stops', count: 1 },
  ]);
  assert.deepEqual([result.runner, result.passed, result.failed, result.firstFailureLine], ['node:test', 3, 1, 2]);
});

test('logs of no known runner have no summary, build checkmarks included', () => {
  assert.equal(parseRunnerSummary(['vite v5.0.0 building for production...', '✓ 123 modules transformed.', '✓ built in 2.1s']), null);
  assert.equal(parseRunnerSummary(''), null);
  assert.equal(parseRunnerSummary(['server listening on :8080', 'GET /health 200']), null);
});

// ─── Stall and setting ───────────────────────────────────────────────────────

test('stall minutes', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.equal(stallMinutes(now - 12.5 * 60_000, now), 12);
  assert.equal(stallMinutes(new Date(now - 60_000).toISOString(), now), 1);
  assert.equal(stallMinutes(now + 5_000, now), 0);
  assert.equal(stallMinutes(null, now), null);
  assert.equal(stallMinutes('not a time', now), null);
});

test('the stall setting: default 10, clamped to 1–120', () => {
  assert.equal(DEFAULT_TASK_STALL_MINUTES, 10);
  assert.equal(readTaskStallMinutesSetting(null), 10);
  assert.equal(readTaskStallMinutesSetting(''), 10);
  assert.equal(readTaskStallMinutesSetting('25'), 25);
  assert.equal(readTaskStallMinutesSetting('0'), 1);
  assert.equal(readTaskStallMinutesSetting('500'), 120);
  assert.deepEqual(parseTaskStallMinutesUpdate('7.4'), { ok: true, minutes: 7 });
  assert.equal(parseTaskStallMinutesUpdate('soon').ok, false);
  assert.equal(parseTaskStallMinutesUpdate(undefined).ok, false);
});

// ─── Output paths ────────────────────────────────────────────────────────────

test('output paths: absolute, capped, no NUL; the kind follows the path', () => {
  assert.equal(normalizeTaskOutputPath('/tmp/oar-task-output/s1/t1.log'), '/tmp/oar-task-output/s1/t1.log');
  // platform-agnostic: a string check, the same on every host.
  assert.equal(normalizeTaskOutputPath('C:\\Users\\dev\\AppData\\Local\\Temp\\t1.log'), 'C:\\Users\\dev\\AppData\\Local\\Temp\\t1.log'); // platform-agnostic: string check
  assert.equal(normalizeTaskOutputPath('relative/t1.log'), '');
  assert.equal(normalizeTaskOutputPath(`/${'a'.repeat(1024)}`), '');
  assert.equal(normalizeTaskOutputPath('/tmp/a\0b'), '');
  assert.equal(normalizeTaskOutputPath(42), '');
  assert.equal(normalizeTaskOutputKind(undefined, '/tmp/x.log'), 'file');
  assert.equal(normalizeTaskOutputKind('', ''), 'none');
  assert.equal(normalizeTaskOutputKind('SPOOL', '/tmp/x.log'), 'spool');
  assert.equal(normalizeTaskOutputKind('snapshot', ''), 'snapshot');
  assert.equal(normalizeTaskOutputKind('weird', ''), 'none');
});
