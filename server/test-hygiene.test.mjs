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

function buildFingerprintPatterns() {
  const patterns = [];
  let username = '';
  try { username = String(os.userInfo().username || '').trim(); } catch {}
  if (username.length >= 3) {
    patterns.push({
      label: `local username in a home path (${username})`,
      re: new RegExp(String.raw`[\\/]+(?:Users|home)[\\/]+` + escapeRegExp(username) + String.raw`\b`, 'i'),
    });
  }
  const homedir = String(os.homedir() || '').trim();
  if (homedir.length >= 8) {
    const flexibleSlashes = escapeRegExp(homedir).replace(/\\\\/g, String.raw`[\\/]+`);
    patterns.push({ label: 'local home directory path', re: new RegExp(flexibleSlashes, 'i') });
  }
  const hostname = String(os.hostname() || '').trim();
  if (hostname.length >= 4) {
    patterns.push({ label: `local hostname (${hostname})`, re: new RegExp(String.raw`\b` + escapeRegExp(hostname) + String.raw`\b`, 'i') });
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
