#!/usr/bin/env node
// git pre-push hook body (scripts/git-hooks/pre-push execs this).
//
// Two jobs, both about what becomes public:
//
//  1. The public repository only ever receives `main` and tags. Topic branches
//     go to the private working remote, where deleting a branch really does
//     get rid of it. On a public host a deleted branch's commits stay
//     fetchable by hash, so a leak pushed there cannot be taken back.
//  2. Nothing leaves with a leak in it: the suite's hygiene guard runs over
//     the working tree, and for the public remote the commits being pushed
//     (their messages and added lines) are scanned with the same patterns.
//
// git calls the hook with `<remote name> <remote url>` and feeds one line per
// ref on stdin: `<local ref> <local sha> <remote ref> <remote sha>`.
// Escape hatches are environment variables, never flags an agent might add by
// habit: OAR_ALLOW_PUBLIC_BRANCH=1, OAR_ALLOW_PUBLIC_REWRITE=1.

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildPublishPatterns } from './hygiene-patterns.mjs';

const ZERO_SHA_RE = /^0+$/;
const DEFAULT_PUBLIC_REMOTE_RE = /github\.com[:/]+oar-sh\/oar(?:\.git)?\/?$/i;
const PUBLIC_BRANCHES = new Set(['refs/heads/main']);
// Never scanned: the lockfile is machine-written noise, and the two hygiene
// files carry the synthetic names their own tests look for.
const SCAN_SKIP_FILES = new Set(['package-lock.json', 'server/test-hygiene.test.mjs', 'scripts/pre-push.test.mjs']);

export function parseRefLines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
    return { localRef, localSha, remoteRef, remoteSha };
  }).filter((ref) => ref.remoteRef && ref.localSha);
}

export function isPublicRemote(url, env = process.env) {
  const custom = String(env.OAR_PUBLIC_REMOTE_RE || '').trim();
  const re = custom ? new RegExp(custom, 'i') : DEFAULT_PUBLIC_REMOTE_RE;
  return re.test(String(url || '').trim());
}

export function isDeletion(ref) {
  return ZERO_SHA_RE.test(String(ref?.localSha || ''));
}

/**
 * Which refs may go to the public remote. `isAncestor(a, b)` answers whether
 * commit a is an ancestor of b; it is injected so the rules are testable
 * without a repository.
 */
export function evaluatePublicRefs(refs, { env = process.env, isAncestor = () => true } = {}) {
  const violations = [];
  for (const ref of refs) {
    // Deleting is always fine: that is how old public branches get retired.
    if (isDeletion(ref)) continue;
    const name = String(ref.remoteRef || '');
    if (name.startsWith('refs/tags/')) continue;
    if (!PUBLIC_BRANCHES.has(name)) {
      if (env.OAR_ALLOW_PUBLIC_BRANCH === '1') continue;
      violations.push(
        `${name}: only main and tags go to the public repository. Push topic branches to the `
        + 'private remote (`git push work <branch>`); land finished work with `npm run land`.',
      );
      continue;
    }
    const isNew = ZERO_SHA_RE.test(String(ref.remoteSha || ''));
    if (!isNew && !isAncestor(ref.remoteSha, ref.localSha) && env.OAR_ALLOW_PUBLIC_REWRITE !== '1') {
      violations.push(`${name}: this push would rewrite published history (not a fast-forward).`);
    }
  }
  return violations;
}

/**
 * Scan `git log -p` output: commit messages and added lines. Returns
 * `{ commit, file, line, label }` records; `file` is null for a message line.
 */
export function scanLogOutput(text, patterns) {
  const findings = [];
  let commit = '';
  let file = null;
  let inMessage = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const commitMatch = raw.match(/^commit ([0-9a-f]{7,40})\b/);
    if (commitMatch) { commit = commitMatch[1].slice(0, 7); file = null; inMessage = true; continue; }
    const fileMatch = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) { file = fileMatch[2]; inMessage = false; continue; }
    let candidate = null;
    if (inMessage) {
      // Header lines carry the identity every commit has anyway.
      if (/^(Author|AuthorDate|Commit|CommitDate|Date|Merge):/.test(raw)) continue;
      candidate = raw;
    } else if (raw.startsWith('+') && !raw.startsWith('+++')) {
      if (file && SCAN_SKIP_FILES.has(file)) continue;
      candidate = raw.slice(1);
    }
    if (candidate === null) continue;
    for (const { label, re } of patterns) {
      if (re.test(candidate)) findings.push({ commit, file: inMessage ? null : file, line: candidate.trim().slice(0, 120), label });
    }
  }
  return findings;
}

function git(args, { cwd } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function scanPushedCommits(refs, { remoteName, cwd, patterns }) {
  const findings = [];
  for (const ref of refs) {
    if (isDeletion(ref)) continue;
    const range = ZERO_SHA_RE.test(String(ref.remoteSha || ''))
      ? [ref.localSha, '--not', `--remotes=${remoteName}`]
      : [`${ref.remoteSha}..${ref.localSha}`];
    let log = '';
    try {
      log = git(['log', '-p', '-U0', '--no-color', '--format=commit %H%n%B', ...range], { cwd });
    } catch (error) {
      findings.push({ commit: '', file: null, line: String(error?.message || error).split('\n')[0], label: 'could not read the commits being pushed' });
      continue;
    }
    for (const finding of scanLogOutput(log, patterns)) findings.push({ ...finding, ref: ref.remoteRef });
  }
  return findings;
}

export function runPrePush({
  remoteName,
  remoteUrl,
  stdin,
  cwd = process.cwd(),
  env = process.env,
  log = (line) => process.stderr.write(`${line}\n`),
  runHygieneGuard = defaultHygieneGuard,
  patterns = null,
} = {}) {
  const refs = parseRefLines(stdin);
  const pushed = refs.filter((ref) => !isDeletion(ref));
  if (!pushed.length) return 0; // deletions only: nothing is being published
  const publicRemote = isPublicRemote(remoteUrl, env);

  if (publicRemote) {
    const violations = evaluatePublicRefs(refs, {
      env,
      isAncestor: (older, newer) => {
        try { git(['merge-base', '--is-ancestor', older, newer], { cwd }); return true; } catch { return false; }
      },
    });
    if (violations.length) {
      log(`pre-push: refusing to push to the public remote "${remoteName}":`);
      for (const violation of violations) log(`  - ${violation}`);
      return 1;
    }
  }

  if (!runHygieneGuard({ cwd, log })) {
    log('pre-push: the hygiene guard failed; nothing was pushed. Fix the files named above.');
    return 1;
  }

  if (publicRemote) {
    const findings = scanPushedCommits(pushed, { remoteName, cwd, patterns: patterns || buildPublishPatterns() });
    if (findings.length) {
      log('pre-push: the commits being published contain private or machine-specific text:');
      for (const f of findings.slice(0, 40)) {
        log(`  - ${f.commit} ${f.file || '(commit message)'} — ${f.label}`);
      }
      if (findings.length > 40) log(`  … and ${findings.length - 40} more`);
      log('Rewrite those commits (or land a squashed commit with `npm run land`) before publishing.');
      return 1;
    }
  }
  return 0;
}

function defaultHygieneGuard({ cwd, log }) {
  const result = spawnSync(process.execPath, ['--test', 'server/test-hygiene.test.mjs'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return true;
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  for (const line of output.split(/\r?\n/)) {
    if (/Violations:| — |^✖|AssertionError/.test(line)) log(`  ${line.trim()}`);
  }
  return false;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const [remoteName = '', remoteUrl = ''] = process.argv.slice(2);
  const stdin = await readStdin();
  process.exit(runPrePush({ remoteName, remoteUrl, stdin, cwd: repoRoot }));
}
