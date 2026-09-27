// Throwaway git repositories for the script tests: a working clone with a
// "public" and a "private" bare remote beside it, all under the OS temp dir.
// No hooks path is configured in them, so pushes inside a test are never
// gated by the real pre-push hook.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function gitIn(cwd) {
  return (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function hasGit() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

export function createSandbox({ withWorkRemote = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-git-sandbox-'));
  const publicDir = path.join(root, 'public.git');
  const workDir = path.join(root, 'work.git');
  const repo = path.join(root, 'checkout');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', publicDir]);
  if (withWorkRemote) execFileSync('git', ['init', '--bare', '-q', '-b', 'main', workDir]);

  const git = gitIn(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Dev');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('remote', 'add', 'origin', publicDir);
  if (withWorkRemote) git('remote', 'add', 'work', workDir);

  const write = (rel, text) => {
    const file = path.join(repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const commit = (rel, text, subject) => {
    write(rel, text);
    git('add', '-A');
    git('commit', '-q', '-m', subject);
    return git('rev-parse', 'HEAD');
  };

  commit('README.md', 'demo\n', 'Start the demo project');
  git('push', '-q', 'origin', 'main');
  if (withWorkRemote) git('push', '-q', 'work', 'main');

  return {
    root,
    repo,
    publicDir,
    workDir,
    git,
    write,
    commit,
    remoteGit: (dir) => gitIn(dir),
    cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} },
  };
}
