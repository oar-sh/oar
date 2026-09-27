#!/usr/bin/env node
// Land the current topic branch on main as ONE commit:
//
//   npm run land -- -m "Subject line" [--body-file notes.txt] [--dry-run]
//
// main is the only permanent branch and the only one the public repository
// receives. A topic branch lives on the private remote while it is worked on;
// landing squashes it, so its intermediate commits (fix-ups, experiments, a
// leak and its clean-up) never enter public history, and deleting the branch
// afterwards really does get rid of them.
//
// What it does, in order:
//   1. checks: on a topic branch, clean working tree, branch sits on top of
//      the current public main (rebase first if main moved);
//   2. gates: hygiene guard, unit suite, end-to-end suite. All three must
//      pass on exactly the tree that is about to be published;
//   3. builds the squashed commit with `git commit-tree` from the branch's
//      tree, so the working tree is never touched. The relay usually runs
//      from this checkout and serves files straight from disk;
//   4. pushes it to the public main, mirrors main to the private remote;
//   5. switches this checkout to main (same tree, so no file changes) and
//      deletes the topic branch locally and on the private remote.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildIdentityHeaderPatterns, buildPublishPatterns } from './hygiene-patterns.mjs';

export const PUBLIC_REMOTE = 'origin';
export const WORK_REMOTE = 'work';
export const MAIN = 'main';

export const DEFAULT_GATES = Object.freeze([
  { name: 'hygiene guard', command: 'node --test server/test-hygiene.test.mjs' },
  { name: 'unit suite', command: 'npm test' },
  { name: 'end-to-end suite', command: 'npm run test:e2e', skippableBy: 'skipE2e' },
]);

export class LandError extends Error {}

export function parseLandArgs(argv) {
  const args = { message: '', bodyFile: '', dryRun: false, skipE2e: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-m' || arg === '--message') { args.message = String(argv[i + 1] ?? ''); i += 1; }
    else if (arg.startsWith('--message=')) args.message = arg.slice('--message='.length);
    else if (arg === '--body-file') { args.bodyFile = String(argv[i + 1] ?? ''); i += 1; }
    else if (arg.startsWith('--body-file=')) args.bodyFile = arg.slice('--body-file='.length);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--skip-e2e') args.skipE2e = true;
    else if (arg === '-h' || arg === '--help') args.help = true;
    else throw new LandError(`unknown argument: ${arg}`);
  }
  return args;
}

/** Subject, blank line, body. The subject is one line and must not be empty. */
export function buildCommitMessage({ message = '', body = '' } = {}) {
  const lines = String(message || '').replace(/\r\n/g, '\n').split('\n');
  const subject = (lines.shift() || '').trim();
  if (!subject) throw new LandError('a commit subject is required: -m "What this change does"');
  const rest = [lines.join('\n').trim(), String(body || '').replace(/\r\n/g, '\n').trim()].filter(Boolean).join('\n\n');
  return rest ? `${subject}\n\n${rest}\n` : `${subject}\n`;
}

/**
 * Path of the worktree that has `ref` checked out, other than `self`.
 * Input is the output of `git worktree list --porcelain`.
 */
export function findWorktreeHolding(porcelain, ref, self = '') {
  const same = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
  let current = '';
  for (const line of String(porcelain || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
    else if (line.trim() === `branch ${ref}` && current && !(self && same(current, self))) return current;
  }
  return '';
}

export function findMessageLeaks(text, patterns) {
  const hits = [];
  for (const line of String(text || '').split('\n')) {
    for (const { label, re } of patterns) if (re.test(line)) hits.push(label);
  }
  return [...new Set(hits)];
}

function makeGit(cwd) {
  return (args, { allowFail = false, input = undefined } = {}) => {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        input,
        maxBuffer: 64 * 1024 * 1024,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (error) {
      if (allowFail) return null;
      const detail = String(error?.stderr || error?.message || error).trim().split('\n').slice(-3).join(' ');
      throw new LandError(`git ${args.slice(0, 2).join(' ')} failed: ${detail}`);
    }
  };
}

function defaultRunGate(gate, { cwd, log }) {
  log(`\n── gate: ${gate.name} (${gate.command})`);
  const result = spawnSync(gate.command, { cwd, shell: true, stdio: 'inherit' });
  return result.status === 0;
}

/**
 * The whole landing. Everything with an outside effect is injectable, so the
 * tests drive it against throwaway repositories with no gates and no network.
 */
export function land({
  cwd,
  message = '',
  body = '',
  dryRun = false,
  skipE2e = false,
  gates = DEFAULT_GATES,
  runGate = defaultRunGate,
  patterns = null,
  identityPatterns = null,
  publicRemote = PUBLIC_REMOTE,
  workRemote = WORK_REMOTE,
  log = console.log,
} = {}) {
  const git = makeGit(cwd);

  // 1. checks
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') throw new LandError('detached HEAD: check out the topic branch you want to land.');
  if (branch === MAIN) throw new LandError(`you are on ${MAIN}; work happens on a topic branch (git switch -c dev/<topic>).`);
  if (git(['status', '--porcelain'])) {
    throw new LandError('the working tree has uncommitted changes; commit them on the branch first, so the gates test exactly what lands.');
  }
  // Landing ends by switching this checkout to main. git refuses that while
  // another worktree has main checked out, and by then the commit would be
  // published already. Say so before anything runs.
  const elsewhere = findWorktreeHolding(git(['worktree', 'list', '--porcelain']), `refs/heads/${MAIN}`, git(['rev-parse', '--show-toplevel']));
  if (elsewhere) {
    throw new LandError(
      `${MAIN} is checked out in another worktree (${elsewhere}). Land from that checkout instead: `
      + `commit and push here, then run "git switch ${branch}" and the landing there.`,
    );
  }
  const commitMessage = buildCommitMessage({ message, body });
  const leaks = findMessageLeaks(commitMessage, patterns || buildPublishPatterns());
  if (leaks.length) throw new LandError(`the commit message contains private or machine-specific text: ${leaks.join('; ')}`);
  // The squashed commit is authored and committed by whoever git is
  // configured as here, and those headers are published with it.
  const identity = `${git(['config', 'user.name'], { allowFail: true }) || ''} <${git(['config', 'user.email'], { allowFail: true }) || ''}>`;
  if (findMessageLeaks(identity, identityPatterns || buildIdentityHeaderPatterns()).length) {
    throw new LandError(
      'the git identity of this checkout contains a name from the hygiene denylist, and it would be published in the commit header. '
      + 'Set a neutral one for this repository: node scripts/setup-git.mjs --email "<id>+<login>@users.noreply.github.com"',
    );
  }

  git(['fetch', '--quiet', publicRemote, MAIN]);
  const base = git(['rev-parse', `${publicRemote}/${MAIN}`]);
  const tip = git(['rev-parse', 'HEAD']);
  if (git(['merge-base', base, tip], { allowFail: true }) !== base) {
    throw new LandError(`${branch} does not sit on the current ${publicRemote}/${MAIN}; run "git rebase ${publicRemote}/${MAIN}" and re-test.`);
  }
  const ahead = Number(git(['rev-list', '--count', `${base}..${tip}`]));
  if (!ahead) throw new LandError(`${branch} has no commits on top of ${MAIN}; nothing to land.`);
  const tree = git(['rev-parse', `${tip}^{tree}`]);
  if (tree === git(['rev-parse', `${base}^{tree}`])) throw new LandError(`${branch} changes nothing compared to ${MAIN}.`);
  log(`landing ${branch}: ${ahead} commit${ahead === 1 ? '' : 's'} squashed onto ${MAIN} (${base.slice(0, 7)})`);

  // 2. gates
  for (const gate of gates) {
    if (gate.skippableBy === 'skipE2e' && skipE2e) { log(`\n── gate: ${gate.name} SKIPPED (--skip-e2e)`); continue; }
    if (!runGate(gate, { cwd, log })) throw new LandError(`gate failed: ${gate.name}. Nothing was landed.`);
  }
  if (git(['status', '--porcelain'])) {
    throw new LandError('the gates left changes in the working tree; inspect them before landing.');
  }

  // 3. squash, without touching the working tree
  const squashed = git(['commit-tree', tree, '-p', base, '-F', '-'], { input: commitMessage });
  log(`\nsquashed commit ${squashed.slice(0, 7)}: ${commitMessage.split('\n')[0]}`);
  if (dryRun) {
    log('dry run: nothing pushed, no branch changed.');
    return { branch, base, squashed, pushed: false };
  }

  // 4. publish
  git(['push', publicRemote, `${squashed}:refs/heads/${MAIN}`]);
  log(`pushed to ${publicRemote}/${MAIN}`);
  const hasWork = git(['remote', 'get-url', workRemote], { allowFail: true });
  if (hasWork) {
    if (git(['push', '--force', workRemote, `${squashed}:refs/heads/${MAIN}`], { allowFail: true }) === null) {
      log(`note: could not mirror ${MAIN} to ${workRemote}; push it by hand later.`);
    }
  }

  // 5. move this checkout to main and retire the branch
  git(['update-ref', `refs/heads/${MAIN}`, squashed]);
  git(['checkout', '--quiet', MAIN]);
  git(['branch', '--quiet', '-D', branch]);
  if (hasWork && git(['ls-remote', '--heads', workRemote, branch], { allowFail: true })) {
    if (git(['push', '--quiet', workRemote, '--delete', branch], { allowFail: true }) === null) {
      log(`note: could not delete ${branch} on ${workRemote}; delete it by hand.`);
    } else {
      log(`deleted ${branch} on ${workRemote}`);
    }
  }
  log(`done: this checkout is on ${MAIN} at ${squashed.slice(0, 7)}.`);
  return { branch, base, squashed, pushed: true };
}

const USAGE = `Usage: npm run land -- -m "Subject line" [--body-file <file>] [--dry-run] [--skip-e2e]

Lands the current topic branch on main as one squashed commit. Runs the
hygiene guard, the unit suite and the end-to-end suite first.
--skip-e2e is for changes that cannot affect the app (docs only), and only
when the user agreed to it.`;

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const args = parseLandArgs(process.argv.slice(2));
    if (args.help) { console.log(USAGE); process.exit(0); }
    const body = args.bodyFile ? fs.readFileSync(path.resolve(process.cwd(), args.bodyFile), 'utf8') : '';
    land({ cwd: repoRoot, message: args.message, body, dryRun: args.dryRun, skipE2e: args.skipE2e });
  } catch (error) {
    if (error instanceof LandError) {
      console.error(`land: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
