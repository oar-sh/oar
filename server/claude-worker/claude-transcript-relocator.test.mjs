import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { relocateClaudeTranscriptForCwd } from './claude-transcript-relocator.mjs';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

function makeWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-relocator-'));
  const configDir = path.join(base, 'config');
  const projectsDir = path.join(configDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  return {
    base,
    projectsDir,
    env: { CLAUDE_CONFIG_DIR: configDir },
    // `homedir` must not fall back to the real home, or the scan would reach
    // whatever sessions the developer's machine happens to hold.
    homedir: () => path.join(base, 'home'),
    dir(name) {
      const dirPath = path.join(base, name);
      fs.mkdirSync(dirPath, { recursive: true });
      return dirPath;
    },
    projectDirFor(workspaceRoot) {
      return path.join(this.projectsDir, fs.realpathSync(workspaceRoot).replace(/[^a-zA-Z0-9]/g, '-'));
    },
    seedTranscript(workspaceRoot, { text = 'history', sessionId = SESSION_ID } = {}) {
      const projectDir = this.projectDirFor(workspaceRoot);
      fs.mkdirSync(projectDir, { recursive: true });
      const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
      fs.writeFileSync(transcriptPath, `${JSON.stringify({ text })}\n`);
      return { projectDir, transcriptPath };
    },
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function relocate(workspace, { cwd, nativeSessionId = SESSION_ID } = {}) {
  return relocateClaudeTranscriptForCwd({
    nativeSessionId,
    cwd,
    env: workspace.env,
    homedir: workspace.homedir,
  });
}

test('moves the transcript into the project directory of the new workspace root', (t) => {
  const workspace = makeWorkspace();
  t.after(() => workspace.cleanup());
  const oldRoot = workspace.dir('old-root');
  const newRoot = workspace.dir('new-root');
  const seeded = workspace.seedTranscript(oldRoot);

  const result = relocate(workspace, { cwd: newRoot });

  assert.equal(result.status, 'moved');
  const movedPath = path.join(workspace.projectDirFor(newRoot), `${SESSION_ID}.jsonl`);
  assert.equal(result.to, movedPath);
  assert.equal(fs.readFileSync(movedPath, 'utf8'), `${JSON.stringify({ text: 'history' })}\n`);
  // Moved, not copied: a leftover would be resumed with stale history the next
  // time the conversation switches back to the old root.
  assert.equal(fs.existsSync(seeded.transcriptPath), false);
});

test('brings the sibling session directory along with the transcript', (t) => {
  const workspace = makeWorkspace();
  t.after(() => workspace.cleanup());
  const oldRoot = workspace.dir('old-root');
  const newRoot = workspace.dir('new-root');
  const seeded = workspace.seedTranscript(oldRoot);
  const sessionDir = path.join(seeded.projectDir, SESSION_ID);
  fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'subagents', 'agent-1.jsonl'), 'subagent\n');

  assert.equal(relocate(workspace, { cwd: newRoot }).status, 'moved');

  const movedSubagent = path.join(workspace.projectDirFor(newRoot), SESSION_ID, 'subagents', 'agent-1.jsonl');
  assert.equal(fs.readFileSync(movedSubagent, 'utf8'), 'subagent\n');
  assert.equal(fs.existsSync(sessionDir), false);
});

test('merges into an existing session directory and clears the old anchor', (t) => {
  const workspace = makeWorkspace();
  t.after(() => workspace.cleanup());
  const oldRoot = workspace.dir('old-root');
  const newRoot = workspace.dir('new-root');
  const seeded = workspace.seedTranscript(oldRoot);
  const oldSessionDir = path.join(seeded.projectDir, SESSION_ID);
  fs.mkdirSync(oldSessionDir, { recursive: true });
  fs.writeFileSync(path.join(oldSessionDir, 'old-only.jsonl'), 'old\n');
  fs.writeFileSync(path.join(oldSessionDir, 'shared.jsonl'), 'old\n');
  const newSessionDir = path.join(workspace.projectDirFor(newRoot), SESSION_ID);
  fs.mkdirSync(newSessionDir, { recursive: true });
  fs.writeFileSync(path.join(newSessionDir, 'shared.jsonl'), 'new\n');

  assert.equal(relocate(workspace, { cwd: newRoot }).status, 'moved');

  assert.equal(fs.readFileSync(path.join(newSessionDir, 'old-only.jsonl'), 'utf8'), 'old\n');
  assert.equal(fs.readFileSync(path.join(newSessionDir, 'shared.jsonl'), 'utf8'), 'new\n');
  // A surviving `<id>/` would keep anchoring the session to the old project dir.
  assert.equal(fs.existsSync(oldSessionDir), false);
});

test('is a no-op when the transcript already lives under the current root', (t) => {
  const workspace = makeWorkspace();
  t.after(() => workspace.cleanup());
  const root = workspace.dir('root');
  const seeded = workspace.seedTranscript(root);

  const result = relocate(workspace, { cwd: root });

  assert.equal(result.status, 'present');
  assert.equal(fs.existsSync(seeded.transcriptPath), true);
});

test('resolves symlinked workspace roots the way the CLI does', (t) => {
  const workspace = makeWorkspace();
  t.after(() => workspace.cleanup());
  const oldRoot = workspace.dir('old-root');
  const realRoot = workspace.dir('real-root');
  const linkedRoot = path.join(workspace.base, 'linked-root');
  try {
    fs.symlinkSync(realRoot, linkedRoot, 'junction');
  } catch {
    // Unprivileged Windows hosts cannot create links; the behaviour under test
    // does not exist there either.
    t.skip('symlinks unavailable on this host');
    return;
  }
  workspace.seedTranscript(oldRoot);

  const result = relocate(workspace, { cwd: linkedRoot });

  assert.equal(result.status, 'moved');
  assert.equal(result.to, path.join(workspace.projectDirFor(realRoot), `${SESSION_ID}.jsonl`));
});

test('reports a miss instead of throwing when no transcript exists anywhere', (t) => {
  const workspace = makeWorkspace();
  t.after(() => workspace.cleanup());
  const root = workspace.dir('root');

  const result = relocate(workspace, { cwd: root });

  assert.equal(result.status, 'missing');
  assert.equal(fs.existsSync(path.join(workspace.projectDirFor(root), `${SESSION_ID}.jsonl`)), false);
});

test('picks the most recently written transcript when several copies exist', (t) => {
  const workspace = makeWorkspace();
  t.after(() => workspace.cleanup());
  const staleRoot = workspace.dir('stale-root');
  const freshRoot = workspace.dir('fresh-root');
  const newRoot = workspace.dir('new-root');
  const stale = workspace.seedTranscript(staleRoot, { text: 'stale' });
  const fresh = workspace.seedTranscript(freshRoot, { text: 'fresh' });
  fs.utimesSync(stale.transcriptPath, new Date(1_000_000), new Date(1_000_000));
  fs.utimesSync(fresh.transcriptPath, new Date(2_000_000), new Date(2_000_000));

  const result = relocate(workspace, { cwd: newRoot });

  assert.equal(result.status, 'moved');
  assert.equal(fs.readFileSync(result.to, 'utf8'), `${JSON.stringify({ text: 'fresh' })}\n`);
});

test('refuses session ids that would escape the projects directory', (t) => {
  const workspace = makeWorkspace();
  t.after(() => workspace.cleanup());
  const root = workspace.dir('root');

  for (const nativeSessionId of ['../escape', 'a/b', '', '   ']) {
    assert.equal(relocate(workspace, { cwd: root, nativeSessionId }).status, 'skipped');
  }
});
