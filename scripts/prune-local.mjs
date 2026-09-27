#!/usr/bin/env node
// Remove commits from THIS clone that no branch, tag or stash needs any more:
//
//   node scripts/prune-local.mjs                 # list what would go, delete nothing
//   node scripts/prune-local.mjs --list out.txt  # same, and write the list to a file
//   node scripts/prune-local.mjs --apply         # delete them
//
// Why this exists: after a history rewrite the old commits stay in every clone
// that ever had them, held by the reflogs. The obvious recipe,
// `git reflog expire --expire=now --all && git gc --prune=now`, also empties
// the STASH reflog. Every stash but the newest lives only in that reflog, so
// they vanish from `git stash list` and are deleted by the gc that follows.
// This script expires every reflog except the stash's, in this worktree and in
// every other worktree of the repository, and only then collects.
//
// What goes for good with --apply: rewritten and rebased-away commits, commits
// of deleted branches, and stashes that were dropped earlier. What stays:
// everything reachable from a branch, a tag, a remote-tracking ref, a worktree
// HEAD or a stash that is still listed.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STASH_REF = 'refs/stash';

export function parsePruneArgs(argv) {
  const args = { apply: false, list: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--list') { args.list = String(argv[i + 1] ?? ''); i += 1; }
    else if (arg.startsWith('--list=')) args.list = arg.slice('--list='.length);
    else if (arg === '-h' || arg === '--help') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function makeGit(cwd) {
  return (args, { allowFail = false } = {}) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      if (allowFail) return null;
      throw error;
    }
  };
}

/** Paths of all worktrees of the repository, this one first. */
export function listWorktrees(git) {
  const out = git(['worktree', 'list', '--porcelain']) || '';
  return out.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
}

/** Commits the listed stashes need: the stash commits and everything behind them. */
function stashHeldCommits(git) {
  const entries = (git(['reflog', 'show', '--format=%H', STASH_REF], { allowFail: true }) || '')
    .split(/\r?\n/).filter(Boolean);
  if (!entries.length) return new Set();
  const held = git(['rev-list', ...entries]) || '';
  return new Set(held.split(/\r?\n/).filter(Boolean));
}

/**
 * Commits that would be deleted: unreachable once every reflog except the
 * stash's is gone. Newest first.
 */
export function findPruneCandidates({ cwd }) {
  const git = makeGit(cwd);
  // fsck reports problems on stderr and may exit non-zero on a dangling
  // object; the list on stdout is what matters here.
  let fsck = '';
  try {
    fsck = execFileSync('git', ['fsck', '--unreachable', '--no-reflogs', '--no-progress'], {
      cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    fsck = String(error?.stdout || '');
  }
  const kept = stashHeldCommits(git);
  // Another worktree's HEAD may be detached on a commit no branch holds.
  for (const worktree of listWorktrees(git)) {
    const head = makeGit(worktree)(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true });
    if (head) kept.add(head);
  }
  const hashes = fsck.split(/\r?\n/)
    .map((line) => line.match(/^unreachable commit ([0-9a-f]{40})/)?.[1])
    .filter((hash) => hash && !kept.has(hash));
  return hashes.map((hash) => {
    const [short, date, subject] = (git(['log', '-1', '--format=%h%x09%cd%x09%s', '--date=short', hash]) || '').split('\t');
    return { hash, short, date, subject: subject || '' };
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function formatCandidates(candidates) {
  return candidates.map((c) => `${c.short}  ${c.date}  ${c.subject}`).join('\n');
}

/** Every ref with a reflog in `worktree`, except the stash. */
function reflogTargets(git) {
  const refs = (git(['for-each-ref', '--format=%(refname)']) || '').split(/\r?\n/).filter(Boolean);
  return ['HEAD', ...refs].filter((ref) => ref !== STASH_REF);
}

export function pruneLocal({ cwd, apply = false, log = console.log } = {}) {
  const git = makeGit(cwd);
  const stashesBefore = (git(['stash', 'list'], { allowFail: true }) || '').split(/\r?\n/).filter(Boolean);
  const candidates = findPruneCandidates({ cwd });
  if (!apply) return { applied: false, candidates, stashes: stashesBefore.length };

  for (const worktree of listWorktrees(git)) {
    const inWorktree = makeGit(worktree);
    for (const ref of reflogTargets(inWorktree)) {
      inWorktree(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', ref], { allowFail: true });
    }
  }
  git(['gc', '--prune=now', '--quiet']);

  const stashesAfter = (git(['stash', 'list'], { allowFail: true }) || '').split(/\r?\n/).filter(Boolean);
  if (stashesAfter.length !== stashesBefore.length) {
    throw new Error(`stash count changed from ${stashesBefore.length} to ${stashesAfter.length}; inspect the repository before doing anything else.`);
  }
  const left = candidates.filter((c) => git(['cat-file', '-e', `${c.hash}^{commit}`], { allowFail: true }) !== null);
  log(`pruned ${candidates.length - left.length} of ${candidates.length} commits; ${stashesAfter.length} stash${stashesAfter.length === 1 ? '' : 'es'} kept.`);
  return { applied: true, candidates, left, stashes: stashesAfter.length };
}

const USAGE = `Usage: node scripts/prune-local.mjs [--list <file>] [--apply]

Without --apply nothing is deleted: the commits that would go are listed.
With --apply every reflog except the stash's is expired, in all worktrees,
and the unreachable commits are collected. This cannot be undone.`;

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = parsePruneArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }
  const result = pruneLocal({ cwd: repoRoot, apply: args.apply });
  const listing = formatCandidates(result.candidates);
  if (args.list) {
    fs.writeFileSync(path.resolve(process.cwd(), args.list), `${listing}\n`);
    console.log(`list written to ${args.list}`);
  } else if (listing) {
    console.log(listing);
  }
  if (!result.applied) {
    console.log(`\n${result.candidates.length} commits would be deleted; ${result.stashes} stash${result.stashes === 1 ? '' : 'es'} would be kept. Nothing was changed. Re-run with --apply to delete.`);
  }
}
