import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard: test files must never contain personal data, machine fingerprints, or
// secrets. Fixtures use fictional values ("C:\\Users\\dev", "user@example.com",
// fake tokens). Machine-specific patterns are derived from the running host at
// runtime so this guard works on any machine without embedding anyone's data.

const SELF = path.resolve(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(path.dirname(SELF), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'logs', 'uploads', 'test-results', 'playwright-report']);
const TEST_FILE_RE = /\.(test|spec)\.mjs$/;

function collectTestFiles(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectTestFiles(full, out);
    } else if (TEST_FILE_RE.test(entry.name) && path.resolve(full) !== SELF) {
      out.push(full);
    }
  }
  return out;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The host identity is read at runtime, so on a generic Linux box (containers, CI
// images, VPS builds) it collides with the very fixtures this file mandates: a user
// named `dev` flags every `/home/dev`, and a host named `test` matches essentially
// every line of every test file. These identities carry no personal information, so
// deriving a pattern from them is all false positive and no protection.
const GENERIC_IDENTITIES = new Set([
  'admin', 'administrator', 'builder', 'ci', 'debian', 'dev', 'developer', 'docker',
  'example', 'foo', 'guest', 'host', 'localhost', 'node', 'root', 'runner', 'server',
  'test', 'tester', 'ubuntu', 'user', 'vagrant', 'worker',
]);

function isGenericIdentity(value) {
  return GENERIC_IDENTITIES.has(String(value || '').trim().toLowerCase());
}

function buildFingerprintPatterns() {
  const patterns = [];
  let username = '';
  try { username = String(os.userInfo().username || '').trim(); } catch {}
  if (username.length >= 5 && !isGenericIdentity(username)) {
    patterns.push({
      label: `local username in a home path (${username})`,
      re: new RegExp(String.raw`[\\/]+(?:Users|home)[\\/]+` + escapeRegExp(username) + String.raw`\b`, 'i'),
    });
  }
  const homedir = String(os.homedir() || '').trim();
  // `/home/dev` is 9 chars and would otherwise flag the documented fixture.
  const homedirLeaf = homedir.split(/[\\/]+/).filter(Boolean).pop() || '';
  if (homedir.length >= 8 && !isGenericIdentity(homedirLeaf)) {
    const flexibleSlashes = escapeRegExp(homedir).replace(/\\\\/g, String.raw`[\\/]+`);
    patterns.push({ label: 'local home directory path', re: new RegExp(flexibleSlashes, 'i') });
  }
  const hostname = String(os.hostname() || '').trim();
  if (hostname.length >= 6 && !isGenericIdentity(hostname)) {
    // Anchored to a host position (URL authority, email domain, explicit host=/host:)
    // rather than a bare word match, which would hit the hostname inside ordinary prose.
    patterns.push({
      label: `local hostname (${hostname})`,
      re: new RegExp(String.raw`(?:https?://|ssh://|@|\bhosts?\s*[=:]\s*['"\`]?)[A-Za-z0-9.-]*\b`
        + escapeRegExp(hostname) + String.raw`\b`, 'i'),
    });
  }
  return patterns;
}

const SECRET_PATTERNS = [
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: 'OpenAI-style API key', re: /\bsk-[A-Za-z0-9_-]{24,}/ },
  { label: 'Slack token', re: /\bxox[abpors]-[A-Za-z0-9-]{10,}/ },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

// Email addresses are allowed only on clearly fictional/reserved domains.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL_RE = /@(?:(?:[A-Za-z0-9-]+\.)*example\.(?:com|org|net|test)|[A-Za-z0-9.-]*\.example|test\.invalid|localhost)$/i;

test('test files contain no personal data, machine fingerprints, or secrets', () => {
  const files = collectTestFiles(repoRoot);
  assert.ok(files.length > 50, `Expected to scan many test files, found ${files.length} — glob walk is broken`);

  const fingerprintPatterns = buildFingerprintPatterns();
  const violations = [];

  for (const file of files) {
    const relPath = path.relative(repoRoot, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const { label, re } of [...fingerprintPatterns, ...SECRET_PATTERNS]) {
        if (re.test(line)) violations.push(`${relPath}:${idx + 1} — ${label}`);
      }
      for (const match of line.match(EMAIL_RE) || []) {
        if (!ALLOWED_EMAIL_RE.test(match)) {
          violations.push(`${relPath}:${idx + 1} — non-fictional email address (${match})`);
        }
      }
    });
  }

  assert.deepEqual(violations, [],
    `Test files must use fictional data (e.g. C:\\Users\\dev, user@example.com, fake tokens). Violations:\n${violations.join('\n')}`);
});

// Guard: the suite must produce the same result on Windows and POSIX. Tests
// therefore must not branch on the host OS implicitly — inject the platform
// into the code under test ('win32', 'linux') instead. `process.platform` is
// allowed in a test file only:
//   - inside an explicit `skip` option, so the test is *reported as skipped*
//     on the other OS rather than failing there, or
//   - on a line carrying a `host-platform:` comment explaining why real host
//     behavior (fs semantics, path helpers) is genuinely under test.
const HOST_PLATFORM_ALLOWED_RE = /\bskip\b|host-platform:/;

test('tests reference process.platform only behind a skip option or a host-platform note', () => {
  const files = collectTestFiles(repoRoot);
  const violations = [];

  for (const file of files) {
    const relPath = path.relative(repoRoot, file);
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, idx) => {
      const code = line.split('//')[0]; // a mention inside a comment is fine
      if (code.includes('process.platform') && !HOST_PLATFORM_ALLOWED_RE.test(line)) {
        violations.push(`${relPath}:${idx + 1} — ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, [],
    'Tests must inject the platform into the code under test instead of reading the host OS. '
    + 'If host behavior is genuinely required, gate the test with `{ skip: process.platform !== \'<os>\' }` '
    + `or annotate the line with a \`host-platform:\` comment. Violations:\n${violations.join('\n')}`);
});

// Guard: the companion to the one above. That guard catches a test that *reads*
// the host OS; this one catches a test that silently *assumes* it — win32-only
// path shapes asserted with no statement of which platform is meant. Both of the
// specs that only ever passed on Windows (a `cd U:\` resolution asserted through
// the host's native `path`, and a drives-explorer case asserting drive-letter
// roots against an API that answers '/' on POSIX) were invisible to the guard
// above, because neither mentioned `process.platform` at all.
//
// A win32-only path shape is either a string literal with a drive-letter prefix
// ("C:\\dev") or a regex asserting that shape (/^[A-Za-z]:$/).
const WIN32_PATH_LITERAL_RE = /['"`][A-Za-z]:\\/;
// A character class holding a letter range, immediately followed by ':' —
// /^[A-Za-z]:$/, /^[a-zA-Z]:\\/ and friends.
const WIN32_PATH_REGEX_RE = /\[[^\]]*[A-Za-z]-[A-Za-z][^\]]*\]:/;

// A file using those shapes must declare, once, how it handles the platform:
//   - names 'win32'/`path.win32` — the platform is injected into the code under
//     test, so the win32 half runs everywhere (the preferred form),
//   - gates with `skip` — reported as skipped on the other OS, not failed,
//   - carries a `host-platform:` note — real host behavior is under test, or
//   - carries a `platform-agnostic:` note — the code under test treats the path
//     as an opaque string, so the literal's shape never reaches path semantics.
const WIN32_SHAPE_DECLARED_RE = /win32|\bskip\b|host-platform:|platform-agnostic:/;

test('tests asserting win32 path shapes declare how they handle the platform', () => {
  const files = collectTestFiles(repoRoot);
  const violations = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (WIN32_SHAPE_DECLARED_RE.test(source)) continue;
    const relPath = path.relative(repoRoot, file);
    source.split(/\r?\n/).forEach((line, idx) => {
      const code = line.split('//')[0]; // a mention inside a comment is fine
      if (WIN32_PATH_LITERAL_RE.test(code) || WIN32_PATH_REGEX_RE.test(code)) {
        violations.push(`${relPath}:${idx + 1} — ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(violations, [],
    'Tests asserting win32 path shapes must say which platform they mean: inject the platform into '
    + 'the code under test (preferred), gate with `{ skip: process.platform !== \'win32\' }`, or annotate '
    + `with a \`host-platform:\` / \`platform-agnostic:\` note. Violations:\n${violations.join('\n')}`);
});

// Guard: the POSIX mirror of the two above. Those catch a test that *reads* or
// *assumes* Windows; nothing caught the reverse, which is exactly how both recent
// Windows-only failures landed. The shape: a test hands a POSIX base dir to a
// service, the service joins onto it with the host's native `path`, and the test
// asserts the POSIX result. Green on Linux (where most commits are written), red on
// Windows, where path.join('/var/log/relay', 'w.log') yields '\var\log\relay\w.log'.
//
// The signature is deliberately narrow, so this stays signal and not ceremony:
// within a single test block, an assertion expects a string literal that strictly
// *extends* a POSIX literal the same block passed in. That extension is the join,
// and a hardcoded separator in it is correct on only one platform. A bare POSIX
// literal that is merely passed through as an opaque string is not flagged.
const POSIX_LITERAL_RE = /['"`](\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]*)['"`]/g;
const ASSERT_LINE_RE = /^\s*assert\./;
const POSIX_JOIN_DECLARED_RE = /path\.posix|path\.win32|\bwin32\b|\bskip\b|host-platform:|platform-agnostic:/;

function collectTestBlocks(lines) {
  const blocks = [];
  let current = null;
  lines.forEach((line, idx) => {
    if (/^\s*test\s*\(/.test(line)) {
      current = [];
      blocks.push(current);
    }
    if (current) current.push([line, idx]);
  });
  return blocks;
}

function posixLiteralsOn(line) {
  const code = line.split('//')[0]; // a mention inside a comment is fine
  const found = [];
  let match;
  POSIX_LITERAL_RE.lastIndex = 0;
  while ((match = POSIX_LITERAL_RE.exec(code)) !== null) {
    found.push(match[1].replace(/\/$/, ''));
  }
  return found;
}

test('tests asserting a joined POSIX path declare how they handle the platform', () => {
  const files = collectTestFiles(repoRoot);
  const violations = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (POSIX_JOIN_DECLARED_RE.test(source)) continue;
    const relPath = path.relative(repoRoot, file);

    for (const block of collectTestBlocks(source.split(/\r?\n/))) {
      const inputs = new Set();
      for (const [line] of block) {
        if (ASSERT_LINE_RE.test(line)) continue;
        for (const literal of posixLiteralsOn(line)) inputs.add(literal);
      }
      for (const [line, idx] of block) {
        if (!ASSERT_LINE_RE.test(line)) continue;
        for (const expected of posixLiteralsOn(line)) {
          const base = [...inputs].find((input) => (
            input.length > 1 && expected !== input && expected.startsWith(`${input}/`)
          ));
          if (base) {
            violations.push(`${relPath}:${idx + 1} — expects '${expected}' joined onto '${base}'`);
            break;
          }
        }
      }
    }
  }

  assert.deepEqual(violations, [],
    'A test that asserts a path built by joining onto a POSIX base dir passes only on POSIX. '
    + 'Inject the path module into the code under test (`pathImpl: path.posix`, the preferred form — '
    + 'see claude-session-root-service), build the expectation with the same host `path` API, or annotate '
    + `with a \`platform-agnostic:\` note if the value never reaches path semantics. Violations:\n${violations.join('\n')}`);
});
