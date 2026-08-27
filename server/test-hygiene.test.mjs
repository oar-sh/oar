import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
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

// Everything git actually publishes, so the sweep matches what a clone would
// receive: gitignored working files (server/config.json, docs/plans/, logs)
// are excluded for free, and nothing untracked can trip a guard the pusher
// never sees. Binary blobs are skipped — a regex cannot read a screenshot,
// which is a real blind spot worth naming rather than papering over: images
// have to be reviewed by eye before they are committed.
const TEXT_FILE_RE = /\.(mjs|js|cjs|ts|json|md|html|css|svg|yml|yaml|sh|ps1|webmanifest)$/i;

// Returns null — not an empty list — when git cannot answer (no git on PATH,
// a source export with no .git, a sandbox that blocks subprocesses). The
// caller skips in that case instead of failing: an empty list would otherwise
// read as "the walk is broken" on a machine that is merely missing git. There
// is deliberately no filesystem-walk fallback — the ignore list is exactly
// what keeps the local `server/config.json` (which holds a real relay token)
// out of this scan, so a walk that ignored it would fail on every dev machine.
function collectTrackedTextFiles() {
  let listed = '';
  try {
    listed = execFileSync('git', ['ls-files', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  return listed.split('\0')
    .filter((rel) => rel && TEXT_FILE_RE.test(rel) && rel !== 'package-lock.json')
    .map((rel) => path.join(repoRoot, rel))
    .filter((full) => path.resolve(full) !== SELF && fs.existsSync(full));
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

// Private/LAN suffixes: a host under one of these is somebody's machine, never
// a public documentation domain, so the hostname may be the LEADING label
// there. Under a public TLD it must be the whole authority or a dotted suffix.
const PRIVATE_TLDS = String.raw`(?:local|lan|home|internal|localdomain|localhost)`;

// The identity is a parameter, defaulted to the running host, so the patterns
// can be exercised against synthetic identities in a test rather than only
// against whatever machine happens to run the suite.
function readHostIdentity() {
  let username = '';
  try { username = String(os.userInfo().username || '').trim(); } catch {}
  return {
    username,
    homedir: String(os.homedir() || '').trim(),
    hostname: String(os.hostname() || '').trim(),
  };
}

function buildFingerprintPatterns(identity = readHostIdentity()) {
  const patterns = [];
  const username = String(identity.username || '').trim();
  if (username.length >= 5 && !isGenericIdentity(username)) {
    patterns.push({
      label: `local username in a home path (${username})`,
      re: new RegExp(String.raw`[\\/]+(?:Users|home)[\\/]+` + escapeRegExp(username) + String.raw`\b`, 'i'),
    });
  }
  const homedir = String(identity.homedir || '').trim();
  // `/home/dev` is 9 chars and would otherwise flag the documented fixture.
  const homedirLeaf = homedir.split(/[\\/]+/).filter(Boolean).pop() || '';
  if (homedir.length >= 8 && !isGenericIdentity(homedirLeaf)) {
    const flexibleSlashes = escapeRegExp(homedir).replace(/\\\\/g, String.raw`[\\/]+`);
    patterns.push({ label: 'local home directory path', re: new RegExp(flexibleSlashes, 'i') });
  }
  const hostname = String(identity.hostname || '').trim();
  if (hostname.length >= 6 && !isGenericIdentity(hostname)) {
    // The hostname must be the WHOLE authority, or a whole dotted suffix of it
    // ("relay.<hostname>"), never a bare substring. The looser form matched any
    // domain that merely contained the hostname as a label, so a contributor
    // whose machine is named `claude` or `github` failed this guard on
    // `https://code.claude.com` / `https://github.com/...` — an ordinary
    // documentation URL flagged purely because of what their laptop is called.
    // Positions: URL authority, email domain, and explicit host=/host: config.
    const host = escapeRegExp(hostname);
    const labels = String.raw`(?:[A-Za-z0-9_-]+\.)*`;
    // Anything that can legally terminate a host: port, path, query, quote,
    // whitespace, or end of line. The mail form excludes '/' so an npm scope
    // (`@cursor/sdk`) is not read as an address at `cursor`.
    const hostEnd = String.raw`(?=[:/?#\s"'\`,)\]]|$)`;
    const mailEnd = String.raw`(?=[:\s"'\`,)\]>]|$)`;
    const self = String.raw`(?:${labels}${host}|${host}\.${PRIVATE_TLDS})`;
    patterns.push({
      label: `local hostname (${hostname})`,
      re: new RegExp(
        String.raw`(?:(?:https?|ssh)://(?:[^/\s@]*@)?${self}${hostEnd}`
        + String.raw`|@${self}${mailEnd}`
        + String.raw`|\bhosts?\s*[=:]\s*['"\`]?${self}${hostEnd})`,
        'i',
      ),
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

// Guard: the companion to the first test, widened from test files to
// EVERYTHING GIT PUBLISHES. The original guard only covered `*.test.mjs`, on
// the reasoning that fixtures are where fake data belongs — but a credential
// or a home path does not care which file it lands in, and `docs/`,
// `server/public/`, and the worker sources were all unscanned.
//
// Only machine fingerprints and secrets are checked here, NOT emails: the
// author's name in LICENSE and the project's own GitHub URL in README are
// deliberate publication, not leakage, and a repo-wide email rule would have
// to allowlist them one by one until it meant nothing.
//
// A home path stays a violation in source even when the account name is
// itself harmless (this project's author uses a pseudonym): the value being
// kept out is the machine layout plus whoever's account name the next
// contributor happens to have. Screenshots are a separate matter — they are
// content, reviewed by eye, and not scanned here.
test('tracked files contain no machine fingerprints or secrets', (t) => {
  const files = collectTrackedTextFiles();
  if (files === null) {
    // No git here (source export, no git on PATH, subprocesses blocked). Report
    // it as skipped rather than failed: this guard protects what git publishes,
    // and where git cannot answer there is nothing to publish.
    t.skip('git ls-files unavailable — cannot determine the published file set');
    return;
  }
  assert.ok(files.length > 100, `Expected to scan the tracked tree, found ${files.length} — git ls-files walk is broken`);

  const fingerprintPatterns = buildFingerprintPatterns();
  const violations = [];

  for (const file of files) {
    const relPath = path.relative(repoRoot, file);
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { continue; }
    lines.forEach((line, idx) => {
      for (const { label, re } of [...fingerprintPatterns, ...SECRET_PATTERNS]) {
        if (re.test(line)) violations.push(`${relPath}:${idx + 1} — ${label}`);
      }
    });
  }

  assert.deepEqual(violations, [],
    'Committed files must not carry the author\'s machine identity or any credential. '
    + `Use the documented fixtures (C:\\Users\\dev, /home/dev, fake tokens). Violations:\n${violations.join('\n')}`);
});

// Guard for the guards above: the fingerprint patterns are derived from
// whoever's machine runs the suite, so their correctness cannot be judged from
// a single host. These cases feed SYNTHETIC identities through the same
// builder, pinning both halves of the contract on every machine:
//   - real machine identity is still caught, and
//   - ordinary content is never flagged just because of what a laptop is named.
// The second half is the one that broke: the first version of the widened scan
// matched the hostname as a bare substring, so a contributor whose machine was
// called `claude` or `github` failed on this project's own doc URLs.
const FINGERPRINT_CASES = [
  // [identity, line, shouldFlag, why]
  [{ hostname: 'claude' }, 'see https://code.claude.com/docs', false, 'public doc URL vs a machine named claude'],
  [{ hostname: 'github' }, 'git clone https://github.com/owner/repo', false, 'repo URL vs a machine named github'],
  [{ hostname: 'cursor' }, 'import x from "@cursor/sdk"', false, 'npm scope is not an email host'],
  [{ hostname: 'anthropic' }, 'https://api.anthropic.com/v1', false, 'api domain vs a machine named anthropic'],
  [{ hostname: 'bigbox9' }, 'the bigbox9 machine is fast', false, 'bare prose mention'],
  [{ hostname: 'bigbox9' }, 'https://bigbox9.local:3333/api', true, 'LAN FQDN of the running host'],
  [{ hostname: 'bigbox9' }, 'mail me at ops@bigbox9.local', true, 'email at the running host'],
  [{ hostname: 'bigbox9' }, 'host: bigbox9', true, 'explicit host assignment'],
  [{ hostname: 'relay.example9' }, 'ssh://deploy@edge.relay.example9:22/srv', true, 'ssh authority under the host domain'],
  // Generic identities are skipped entirely, or the documented fixtures would
  // flag on any throwaway container.
  [{ hostname: 'localhost' }, 'http://localhost:3333/api', false, 'generic hostname is not a fingerprint'],
  [{ username: 'dev', homedir: '/home/dev' }, 'const cwd = "/home/dev/project";', false, 'documented fixture user'],
  [{ username: 'ubuntu', homedir: '/home/ubuntu' }, '/home/ubuntu/app', false, 'generic cloud-image user'],
  // A real account name, in the shapes that actually leak.
  [{ username: 'jklassen', homedir: '/home/jklassen' }, 'path: /home/jklassen/notes', true, 'POSIX home path'],
  [{ username: 'jklassen', homedir: 'C:\\Users\\jklassen' }, 'C:/Users/jklassen/repo', true, 'Windows home path, either slash'],
  [{ username: 'jklassen' }, 'jklassen reviewed the change', false, 'a name outside a home path is not a machine fingerprint'],
];

test('fingerprint patterns behave the same on any user or machine', () => {
  const failures = [];
  for (const [identity, line, shouldFlag, why] of FINGERPRINT_CASES) {
    const patterns = buildFingerprintPatterns({ username: '', homedir: '', hostname: '', ...identity });
    const flagged = patterns.some(({ re }) => re.test(line));
    if (flagged !== shouldFlag) {
      failures.push(`${JSON.stringify(identity)} + ${JSON.stringify(line)} -> ${flagged}, expected ${shouldFlag} (${why})`);
    }
  }
  assert.deepEqual(failures, [],
    `The fingerprint patterns must not depend on who runs the suite:\n${failures.join('\n')}`);
});

// Known, accepted gap, pinned so it is a decision rather than a surprise: when
// the hostname is the leading label of a PUBLIC domain, it is indistinguishable
// from `github.com` on a laptop named `github`, so it is not flagged. The cases
// that actually identify a machine — whole authority, dotted suffix, LAN FQDN —
// are covered above.
test('a public domain sharing the hostname label is deliberately not flagged', () => {
  const patterns = buildFingerprintPatterns({ username: '', homedir: '', hostname: 'bigbox9' });
  assert.equal(patterns.some(({ re }) => re.test('https://bigbox9.com/blog')), false);
  assert.equal(patterns.some(({ re }) => re.test('https://bigbox9')), true, 'the bare authority still flags');
});
