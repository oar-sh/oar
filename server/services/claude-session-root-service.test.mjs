import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  claudeProjectDirSlug,
  createClaudeSessionRootResolver,
  resolveClaudeProjectsRoots,
} from './claude-session-root-service.mjs';

const NATIVE_ID = '11111111-2222-4333-8444-555555555555';

function makeConfigDir() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-root-'));
  const projectsRoot = path.join(configDir, 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  return { configDir, projectsRoot };
}

function makeResolver(configDir, overrides = {}) {
  return createClaudeSessionRootResolver({
    env: { CLAUDE_CONFIG_DIR: configDir },
    homedir: () => '',
    ...overrides,
  });
}

test('the project slug matches the directories the SDK actually writes', () => {
  assert.equal(claudeProjectDirSlug('/home/dev/git/copilot-remote'), '-home-dev-git-copilot-remote');
  assert.equal(claudeProjectDirSlug('/tmp'), '-tmp');
});

test('an over-long workspace path is truncated with a stable hash suffix', () => {
  const cwd = `/home/${'a'.repeat(300)}`;
  const slug = claudeProjectDirSlug(cwd);
  assert.equal(slug.slice(0, 200), cwd.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200));
  assert.match(slug.slice(200), /^-[0-9a-z]+$/);
  assert.equal(slug, claudeProjectDirSlug(cwd));
});

test('both the configured root and the home root are probed, deduped', () => {
  const roots = resolveClaudeProjectsRoots({
    env: { CLAUDE_CONFIG_DIR: '/custom/claude' },
    homedir: () => '/home/dev',
    path: path.posix,
  });
  assert.deepEqual(roots, ['/custom/claude/projects', '/home/dev/.claude/projects']);

  const deduped = resolveClaudeProjectsRoots({
    env: { CLAUDE_CONFIG_DIR: '/home/dev/.claude' },
    homedir: () => '/home/dev',
    path: path.posix,
  });
  assert.deepEqual(deduped, ['/home/dev/.claude/projects']);
});

test('the session directory is found from the workspace root without scanning', () => {
  const { configDir, projectsRoot } = makeConfigDir();
  const workspaceRootPath = '/home/dev/git/copilot-remote';
  const projectDir = path.join(projectsRoot, claudeProjectDirSlug(workspaceRootPath));
  fs.mkdirSync(path.join(projectDir, NATIVE_ID, 'subagents'), { recursive: true });

  let readdirCalls = 0;
  const countingFs = { ...fs, readdirSync: (...args) => { readdirCalls += 1; return fs.readdirSync(...args); } };
  const { resolveClaudeSessionRoot } = makeResolver(configDir, { fs: countingFs });

  assert.deepEqual(resolveClaudeSessionRoot({ claudeNativeSessionId: NATIVE_ID, workspaceRootPath }), {
    sessionRootPath: path.join(projectDir, NATIVE_ID),
    sessionRootName: 'Session',
    projectDirPath: projectDir,
    transcriptPath: '',
    sessionRootExists: true,
  });
  assert.equal(readdirCalls, 0, 'the slug fast path should not scan');
});

test('a transcript with no session directory still resolves, flagged as not yet created', () => {
  const { configDir, projectsRoot } = makeConfigDir();
  const workspaceRootPath = '/home/dev/git/copilot-remote';
  const projectDir = path.join(projectsRoot, claudeProjectDirSlug(workspaceRootPath));
  fs.mkdirSync(projectDir, { recursive: true });
  // The transcript exists from the first turn; the per-session folder only
  // appears once the session writes subagent or tool-result files. The project
  // dir is never offered as a stand-in — it holds every session for this
  // workspace.
  const transcriptPath = path.join(projectDir, `${NATIVE_ID}.jsonl`);
  fs.writeFileSync(transcriptPath, '{}\n');

  const { resolveClaudeSessionRoot } = makeResolver(configDir);
  assert.deepEqual(resolveClaudeSessionRoot({ claudeNativeSessionId: NATIVE_ID, workspaceRootPath }), {
    sessionRootPath: path.join(projectDir, NATIVE_ID),
    sessionRootName: 'Session',
    projectDirPath: projectDir,
    transcriptPath,
    sessionRootExists: false,
  });
});

test('a session with neither a transcript nor a directory does not resolve', () => {
  const { configDir, projectsRoot } = makeConfigDir();
  const workspaceRootPath = '/home/dev/git/copilot-remote';
  fs.mkdirSync(path.join(projectsRoot, claudeProjectDirSlug(workspaceRootPath)), { recursive: true });

  const { resolveClaudeSessionRoot } = makeResolver(configDir);
  assert.equal(resolveClaudeSessionRoot({ claudeNativeSessionId: NATIVE_ID, workspaceRootPath }), null);
});

test('a directory appearing later is reported without re-scanning, from the cached project dir', () => {
  const { configDir, projectsRoot } = makeConfigDir();
  const workspaceRootPath = '/home/dev/git/copilot-remote';
  const projectDir = path.join(projectsRoot, claudeProjectDirSlug(workspaceRootPath));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${NATIVE_ID}.jsonl`), '{}\n');

  let readdirCalls = 0;
  const countingFs = { ...fs, readdirSync: (...args) => { readdirCalls += 1; return fs.readdirSync(...args); } };
  const { resolveClaudeSessionRoot } = makeResolver(configDir, { fs: countingFs });
  const args = { claudeNativeSessionId: NATIVE_ID, workspaceRootPath };

  assert.equal(resolveClaudeSessionRoot(args)?.sessionRootExists, false);
  fs.mkdirSync(path.join(projectDir, NATIVE_ID, 'subagents'), { recursive: true });
  assert.equal(resolveClaudeSessionRoot(args)?.sessionRootExists, true);
  assert.equal(readdirCalls, 0);
});

test('a stale or missing workspace hint falls back to a bounded scan', () => {
  const { configDir, projectsRoot } = makeConfigDir();
  const decoyDir = path.join(projectsRoot, '-home-dev-git-other');
  fs.mkdirSync(path.join(decoyDir, 'some-other-session'), { recursive: true });
  const realDir = path.join(projectsRoot, '-home-dev-git-copilot-remote-worktree');
  fs.mkdirSync(realDir, { recursive: true });
  // Transcript-only, so the scan has to match on the same anchors the fast path does.
  fs.writeFileSync(path.join(realDir, `${NATIVE_ID}.jsonl`), '{}\n');

  const { resolveClaudeSessionRoot } = makeResolver(configDir);
  assert.equal(
    resolveClaudeSessionRoot({ claudeNativeSessionId: NATIVE_ID, workspaceRootPath: '' })?.sessionRootPath,
    path.join(realDir, NATIVE_ID),
  );
  assert.equal(
    resolveClaudeSessionRoot({ claudeNativeSessionId: NATIVE_ID, workspaceRootPath: '/wrong/path' })?.sessionRootPath,
    path.join(realDir, NATIVE_ID),
  );
});

test('a malformed session id is rejected before any filesystem access', () => {
  const { configDir } = makeConfigDir();
  let touched = false;
  const guardedFs = {
    statSync: () => { touched = true; throw new Error('should not be called'); },
    readdirSync: () => { touched = true; throw new Error('should not be called'); },
  };
  const { resolveClaudeSessionRoot } = makeResolver(configDir, { fs: guardedFs });

  for (const badId of ['', '../../etc', 'a/b', '.hidden', 'a'.repeat(200)]) {
    assert.equal(resolveClaudeSessionRoot({ claudeNativeSessionId: badId, workspaceRootPath: '/x' }), null);
  }
  assert.equal(touched, false);
});

test('a session directory created later is picked up once the miss expires', () => {
  const { configDir, projectsRoot } = makeConfigDir();
  const workspaceRootPath = '/home/dev/git/copilot-remote';
  const projectDir = path.join(projectsRoot, claudeProjectDirSlug(workspaceRootPath));
  fs.mkdirSync(projectDir, { recursive: true });

  let clock = 1_000;
  const { resolveClaudeSessionRoot } = makeResolver(configDir, { now: () => clock, missTtlMs: 5_000 });
  const args = { claudeNativeSessionId: NATIVE_ID, workspaceRootPath };

  assert.equal(resolveClaudeSessionRoot(args), null);
  fs.mkdirSync(path.join(projectDir, NATIVE_ID), { recursive: true });
  clock += 6_000;
  assert.equal(resolveClaudeSessionRoot(args)?.sessionRootPath, path.join(projectDir, NATIVE_ID));
});

test('a resolved session survives in cache but is re-probed, not assumed', () => {
  const { configDir, projectsRoot } = makeConfigDir();
  const workspaceRootPath = '/home/dev/git/copilot-remote';
  const projectDir = path.join(projectsRoot, claudeProjectDirSlug(workspaceRootPath));
  const sessionDir = path.join(projectDir, NATIVE_ID);
  fs.mkdirSync(sessionDir, { recursive: true });

  const { resolveClaudeSessionRoot } = makeResolver(configDir);
  const args = { claudeNativeSessionId: NATIVE_ID, workspaceRootPath };
  assert.equal(resolveClaudeSessionRoot(args)?.sessionRootPath, sessionDir);

  fs.rmSync(sessionDir, { recursive: true });
  assert.equal(resolveClaudeSessionRoot(args), null);
});

test('a deleted transcript drops a session that still has a directory only if both are gone', () => {
  const { configDir, projectsRoot } = makeConfigDir();
  const workspaceRootPath = '/home/dev/git/copilot-remote';
  const projectDir = path.join(projectsRoot, claudeProjectDirSlug(workspaceRootPath));
  const sessionDir = path.join(projectDir, NATIVE_ID);
  const transcriptPath = path.join(projectDir, `${NATIVE_ID}.jsonl`);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(transcriptPath, '{}\n');

  const { resolveClaudeSessionRoot } = makeResolver(configDir);
  const args = { claudeNativeSessionId: NATIVE_ID, workspaceRootPath };
  assert.equal(resolveClaudeSessionRoot(args)?.transcriptPath, transcriptPath);

  fs.rmSync(transcriptPath);
  const afterTranscriptGone = resolveClaudeSessionRoot(args);
  assert.equal(afterTranscriptGone?.sessionRootPath, sessionDir);
  assert.equal(afterTranscriptGone?.transcriptPath, '');

  fs.rmSync(sessionDir, { recursive: true });
  assert.equal(resolveClaudeSessionRoot(args), null);
});

test('repeated misses do not rescan the projects root on every poll', () => {
  const { configDir } = makeConfigDir();
  let readdirCalls = 0;
  const countingFs = { ...fs, readdirSync: (...args) => { readdirCalls += 1; return fs.readdirSync(...args); } };
  let clock = 1_000;
  const { resolveClaudeSessionRoot } = makeResolver(configDir, {
    fs: countingFs,
    now: () => clock,
    missTtlMs: 5_000,
  });
  const args = { claudeNativeSessionId: NATIVE_ID, workspaceRootPath: '/home/dev/git/copilot-remote' };

  assert.equal(resolveClaudeSessionRoot(args), null);
  assert.equal(readdirCalls, 1);
  clock += 900;
  assert.equal(resolveClaudeSessionRoot(args), null);
  assert.equal(readdirCalls, 1, 'a poll inside the miss TTL must not rescan');
  clock += 5_000;
  assert.equal(resolveClaudeSessionRoot(args), null);
  assert.equal(readdirCalls, 2);
});

test('the project-directory scan is bounded', () => {
  const { configDir, projectsRoot } = makeConfigDir();
  for (let index = 0; index < 12; index += 1) {
    fs.mkdirSync(path.join(projectsRoot, `project-${String(index).padStart(2, '0')}`), { recursive: true });
  }
  fs.mkdirSync(path.join(projectsRoot, 'zz-last-project', NATIVE_ID), { recursive: true });

  const { resolveClaudeSessionRoot } = makeResolver(configDir, { maxProjectDirsScanned: 5 });
  assert.equal(resolveClaudeSessionRoot({ claudeNativeSessionId: NATIVE_ID, workspaceRootPath: '' }), null);
});

test('a missing projects root resolves to null instead of throwing', () => {
  const { resolveClaudeSessionRoot } = makeResolver(path.join(os.tmpdir(), 'claude-config-does-not-exist'));
  assert.equal(resolveClaudeSessionRoot({ claudeNativeSessionId: NATIVE_ID, workspaceRootPath: '/x' }), null);
});
