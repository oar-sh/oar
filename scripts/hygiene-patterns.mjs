// What counts as a leak: machine fingerprints, the host's GitHub account,
// names from the local private denylist, and secrets. One definition, used by
// the suite guard (server/test-hygiene.test.mjs, over the files in the working
// tree) and by the pre-push hook (scripts/pre-push.mjs, over the commits that
// are about to be published).
//
// Everything machine-specific is read at runtime, so no file in the repository
// ever has to embed anyone's data to be able to look for it.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The host identity is read at runtime, so on a generic Linux box (containers, CI
// images, VPS builds) it collides with the very fixtures this file mandates: a user
// named `dev` flags every `/home/dev`, and a host named `test` matches essentially
// every line of every test file. These identities carry no personal information, so
// deriving a pattern from them is all false positive and no protection.
export const GENERIC_IDENTITIES = new Set([
  'admin', 'administrator', 'builder', 'ci', 'debian', 'dev', 'developer', 'docker',
  'example', 'foo', 'guest', 'host', 'localhost', 'node', 'root', 'runner', 'server',
  'test', 'tester', 'ubuntu', 'user', 'vagrant', 'worker',
]);

export function isGenericIdentity(value) {
  return GENERIC_IDENTITIES.has(String(value || '').trim().toLowerCase());
}

// Private/LAN suffixes: a host under one of these is somebody's machine, never
// a public documentation domain, so the hostname may be the LEADING label
// there. Under a public TLD it must be the whole authority or a dotted suffix.
const PRIVATE_TLDS = String.raw`(?:local|lan|home|internal|localdomain|localhost)`;

// The GitHub account(s) the host's `gh` CLI is signed in to, read from its
// local hosts.yml (no network). A fixture naming the maintainer's own account
// leaks which repositories exist behind it: a CI-blocker fixture once read
// "<login>/<private repo>", copied from what a real relay showed.
export function readGitHubLogins(env = process.env) {
  const dirs = [
    env.GH_CONFIG_DIR,
    env.XDG_CONFIG_HOME && path.join(env.XDG_CONFIG_HOME, 'gh'),
    env.APPDATA && path.join(env.APPDATA, 'GitHub CLI'),
    path.join(os.homedir(), '.config', 'gh'),
  ].filter(Boolean);
  const logins = new Set();
  for (const dir of dirs) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, 'hosts.yml'), 'utf8'); } catch { continue; }
    for (const match of text.matchAll(/^\s*user:\s*["']?([A-Za-z0-9-]+)["']?\s*$/gm)) logins.add(match[1]);
  }
  return [...logins];
}

// The identity is a parameter, defaulted to the running host, so the patterns
// can be exercised against synthetic identities in a test rather than only
// against whatever machine happens to run the suite.
export function readHostIdentity() {
  let username = '';
  try { username = String(os.userInfo().username || '').trim(); } catch {}
  return {
    username,
    homedir: String(os.homedir() || '').trim(),
    hostname: String(os.hostname() || '').trim(),
    githubLogins: readGitHubLogins(),
  };
}

/** Where the local denylist lives for this checkout, or '' when git cannot say. */
export function resolveLocalDenylistPath({ env = process.env, repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const explicit = String(env.OAR_HYGIENE_DENYLIST || '').trim();
  if (explicit) return explicit;
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.resolve(repoRoot, commonDir, 'info', 'hygiene-denylist');
  } catch {
    return '';
  }
}

// Private names no machine property reveals — other projects, their ticket
// ids, personal domains — listed in an UNTRACKED file, so the list itself is
// never published: `.git/info/hygiene-denylist` (git's common dir, shared by
// every worktree) or the file OAR_HYGIENE_DENYLIST names. One entry per line,
// `#` starts a comment; entries match case-insensitively as whole words.
export function readLocalDenylist(env = process.env, repoRoot = DEFAULT_REPO_ROOT) {
  const file = resolveLocalDenylistPath({ env, repoRoot });
  if (!file) return [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split(/\r?\n/).map((line) => line.replace(/#.*/, '').trim()).filter(Boolean);
}

// Word-ish boundaries that still see a name inside a path, slug or domain:
// `/name`, `name-wt` and `relay.name.tld` match, `names` and `rename` do not.
export function wholeWordPattern(value) {
  return new RegExp(String.raw`(?<![A-Za-z0-9_])` + escapeRegExp(value) + String.raw`(?![A-Za-z0-9_])`, 'i');
}

export function buildDenylistPatterns(entries = readLocalDenylist()) {
  return entries.map((entry) => ({
    label: `name from the local hygiene denylist (${entry})`,
    re: wholeWordPattern(entry),
  }));
}

export function buildFingerprintPatterns(identity = readHostIdentity()) {
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
  patterns.push(...buildAccountPatterns(identity));
  return patterns;
}

// Unlike a bare username (see FINGERPRINT_CASES in the suite guard), the gh
// login is an account that owns repositories, so it is flagged wherever it
// appears; fixtures use `example-org/...`.
export function buildAccountPatterns(identity = readHostIdentity()) {
  const patterns = [];
  for (const login of identity.githubLogins || []) {
    const name = String(login || '').trim();
    if (name.length < 3 || isGenericIdentity(name)) continue;
    patterns.push({ label: `GitHub account of this host's gh login (${name})`, re: wholeWordPattern(name) });
  }
  return patterns;
}

export const SECRET_PATTERNS = [
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: 'OpenAI-style API key', re: /\bsk-[A-Za-z0-9_-]{24,}/ },
  { label: 'Slack token', re: /\bxox[abpors]-[A-Za-z0-9-]{10,}/ },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/**
 * Private NAMES only: the denylist and the gh account. This is the set applied
 * to the hygiene files themselves. Those files have to spell out example
 * secrets and fingerprints to test the patterns, so they are exempt from
 * those, but nothing excuses a real project name or account in them. Their
 * own examples are invented and match no real list.
 */
export function buildPrivateNamePatterns({
  identity = readHostIdentity(),
  denylist = readLocalDenylist(),
} = {}) {
  return [...buildDenylistPatterns(denylist), ...buildAccountPatterns(identity)];
}

/**
 * What an author or committer header must not contain. Denylist only: the gh
 * account is expected there (a noreply address carries the login).
 */
export function buildIdentityHeaderPatterns({ denylist = readLocalDenylist() } = {}) {
  return buildDenylistPatterns(denylist);
}

/** Every pattern a published line must not match, for this host and checkout. */
export function buildPublishPatterns({
  identity = readHostIdentity(),
  denylist = readLocalDenylist(),
} = {}) {
  return [...buildFingerprintPatterns(identity), ...buildDenylistPatterns(denylist), ...SECRET_PATTERNS];
}
