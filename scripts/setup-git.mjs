#!/usr/bin/env node
// One-time git setup for a checkout: `npm run setup:git [-- --work-url <url>]`.
//
//  - core.hooksPath -> scripts/git-hooks, so the pre-push hook is active here
//    and in every worktree of this repository (the setting is per repository);
//  - a private working remote named `work`, and `git push` aimed at it by
//    default, so a bare `git push` of a topic branch can never go public;
//  - an empty local hygiene denylist, if there is none yet.
//
// Idempotent: run it again whenever in doubt. It never touches `origin`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildIdentityHeaderPatterns, readLocalDenylist, resolveLocalDenylistPath } from './hygiene-patterns.mjs';

export const WORK_REMOTE = 'work';
export const HOOKS_PATH = 'scripts/git-hooks';

const DENYLIST_STUB = [
  '# Local and untracked: private names the hygiene guard and the pre-push hook',
  '# must never see in anything git publishes. One entry per line, matched',
  '# case-insensitively as whole words. Add your other projects, their ticket',
  '# prefixes and personal domains. See DEVELOPING.md, "Test authoring rules".',
  '',
].join('\n');

export function parseSetupArgs(argv) {
  const args = { workUrl: '', email: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--work-url') { args.workUrl = String(argv[i + 1] || '').trim(); i += 1; }
    else if (argv[i].startsWith('--work-url=')) args.workUrl = argv[i].slice('--work-url='.length).trim();
    else if (argv[i] === '--email') { args.email = String(argv[i + 1] || '').trim(); i += 1; }
    else if (argv[i].startsWith('--email=')) args.email = argv[i].slice('--email='.length).trim();
  }
  return args;
}

export function setupGit({ cwd, workUrl = '', email = '', env = process.env, log = console.log } = {}) {
  const git = (args, { allowFail = false } = {}) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      if (allowFail) return null;
      throw error;
    }
  };
  const report = { hooksPath: HOOKS_PATH, workRemote: null, pushDefault: null, denylist: null, warnings: [] };

  git(['config', 'core.hooksPath', HOOKS_PATH]);
  log(`hooks:     core.hooksPath = ${HOOKS_PATH}`);

  const existing = git(['remote', 'get-url', WORK_REMOTE], { allowFail: true });
  if (existing) {
    report.workRemote = existing;
    if (workUrl && workUrl !== existing) {
      git(['remote', 'set-url', WORK_REMOTE, workUrl]);
      report.workRemote = workUrl;
    }
  } else if (workUrl) {
    git(['remote', 'add', WORK_REMOTE, workUrl]);
    report.workRemote = workUrl;
  }
  if (report.workRemote) {
    git(['config', 'remote.pushDefault', WORK_REMOTE]);
    git(['config', 'push.default', 'current']);
    report.pushDefault = WORK_REMOTE;
    log(`remote:    ${WORK_REMOTE} is set; a bare "git push" goes there`);
  } else {
    report.warnings.push(
      `no private remote named "${WORK_REMOTE}". Create a PRIVATE repository and run `
      + '`npm run setup:git -- --work-url <its url>`. Until then topic branches cannot be pushed anywhere.',
    );
  }

  const denylistPath = resolveLocalDenylistPath({ env, repoRoot: cwd });
  if (denylistPath) {
    if (!fs.existsSync(denylistPath)) {
      fs.mkdirSync(path.dirname(denylistPath), { recursive: true });
      fs.writeFileSync(denylistPath, DENYLIST_STUB);
      report.warnings.push('created an EMPTY hygiene denylist; add your private names to it (path printed above).');
    }
    report.denylist = denylistPath;
    log(`denylist:  ${path.relative(cwd, denylistPath) || denylistPath}`);
  }

  // The author and committer headers are published with every commit. Set for
  // this repository only; the global identity is left alone.
  if (email) {
    git(['config', '--local', 'user.email', email]);
    log('identity:  user.email set for this repository');
  }
  const identity = `${git(['config', 'user.name'], { allowFail: true }) || ''} <${git(['config', 'user.email'], { allowFail: true }) || ''}>`;
  const denylist = readLocalDenylist(env, cwd);
  report.identityClean = !buildIdentityHeaderPatterns({ denylist }).some(({ re }) => re.test(identity));
  if (!report.identityClean) {
    report.warnings.push(
      'the git identity of this checkout matches the hygiene denylist, and it is published in every commit header. '
      + 'Set a neutral one for this repository: node scripts/setup-git.mjs --email "<id>+<login>@users.noreply.github.com"',
    );
  }

  for (const warning of report.warnings) log(`WARNING:   ${warning}`);
  return report;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { workUrl, email } = parseSetupArgs(process.argv.slice(2));
  setupGit({ cwd: repoRoot, workUrl, email });
}
