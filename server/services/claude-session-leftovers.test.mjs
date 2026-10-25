import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordClaudeCliStart, removeClaudeSessionLeftovers } from './claude-session-leftovers.mjs';

const STARTED = Date.parse('2026-10-25T08:00:00.000Z');

function withConfigDir(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-session-leftovers-'));
  const write = (relative, text = '') => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const register = (pid, sessionId, startedAt) => write(`sessions/${pid}.json`, JSON.stringify({ pid, sessionId, startedAt }));
  try {
    return run({ root, write, register, exists: (relative) => fs.existsSync(path.join(root, relative)) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a registration of the session whose process still runs stays, with its key and snapshot', () => withConfigDir(({ root, write, register, exists }) => {
  register(101, 'native-1', STARTED);
  write(`sessions/101.${'b'.repeat(64)}.key`);
  write(`shell-snapshots/snapshot-zsh-${STARTED + 100}-x1.sh`);
  const removed = removeClaudeSessionLeftovers({ configRoot: root, nativeSessionId: 'native-1', isPidAlive: () => true });
  assert.deepEqual(removed, []);
  assert.ok(exists('sessions/101.json') && exists(`sessions/101.${'b'.repeat(64)}.key`) && exists(`shell-snapshots/snapshot-zsh-${STARTED + 100}-x1.sh`));
}));

test('a snapshot in the start window of another registration too stays; one outside every window stays', () => withConfigDir(({ root, write, register, exists }) => {
  register(101, 'native-1', STARTED);
  register(202, 'native-2', STARTED + 30_000);
  write(`shell-snapshots/snapshot-bash-${STARTED + 40_000}-shared.sh`);
  write(`shell-snapshots/snapshot-bash-${STARTED + 3_600_000}-later.sh`);
  write('shell-snapshots/notes.txt');
  const removed = removeClaudeSessionLeftovers({ configRoot: root, nativeSessionId: 'native-1', isPidAlive: () => false });
  assert.deepEqual(removed.map((file) => path.relative(root, file)), [path.join('sessions', '101.json')]);
  assert.ok(exists(`shell-snapshots/snapshot-bash-${STARTED + 40_000}-shared.sh`));
  assert.ok(exists(`shell-snapshots/snapshot-bash-${STARTED + 3_600_000}-later.sh`));
  assert.ok(exists('sessions/202.json'), 'another session\'s dead registration is not this delete\'s');
}));

test('the project folder goes only when nothing but an empty memory folder is left', () => withConfigDir(({ root, write }) => {
  const project = (name) => path.join(root, 'projects', name);
  fs.mkdirSync(path.join(project('empty-memory'), 'memory'), { recursive: true });
  write('projects/kept-memory/memory/MEMORY.md', '- a note');
  write('projects/other-session/native-2.jsonl', '{}');
  write('projects/memory-file/memory', 'not a folder');
  fs.mkdirSync(project('bare'), { recursive: true });
  for (const name of ['empty-memory', 'kept-memory', 'other-session', 'memory-file', 'bare']) {
    removeClaudeSessionLeftovers({ configRoot: root, nativeSessionId: 'native-1', projectDirPath: project(name), isPidAlive: () => false });
  }
  assert.equal(fs.existsSync(project('empty-memory')), false);
  assert.equal(fs.existsSync(project('bare')), false);
  for (const name of ['kept-memory', 'other-session', 'memory-file']) assert.equal(fs.existsSync(project(name)), true, name);
  // A folder outside the config dir's projects is never touched.
  const outside = path.join(root, 'elsewhere');
  fs.mkdirSync(outside);
  removeClaudeSessionLeftovers({ configRoot: root, nativeSessionId: 'native-1', projectDirPath: outside });
  assert.equal(fs.existsSync(outside), true);
}));

test('a session id that is not a plain name, or no config dir, removes nothing', () => withConfigDir(({ root, write, exists }) => {
  write('session-env/x/file');
  assert.deepEqual(removeClaudeSessionLeftovers({ configRoot: root, nativeSessionId: '../session-env' }), []);
  assert.deepEqual(removeClaudeSessionLeftovers({ configRoot: '', nativeSessionId: 'x' }), []);
  assert.ok(exists('session-env/x/file'));
}));

test('after a worker restart the delete finds every CLI\'s snapshot: the relay recorded each start', () => withConfigDir(({ root, write, register, exists }) => {
  // The first CLI exited and took its registration with it, but left its
  // snapshot; the second, resumed CLI was killed by the delete's stop.
  const first = STARTED;
  const second = STARTED + 600_000;
  assert.equal(recordClaudeCliStart({ configRoot: root, nativeSessionId: 'native-1', startedAt: first }), true);
  assert.equal(recordClaudeCliStart({ configRoot: root, nativeSessionId: 'native-1', startedAt: second }), true);
  register(202, 'native-1', second + 400);
  write(`shell-snapshots/snapshot-bash-${first + 900}-first.sh`);
  write(`shell-snapshots/snapshot-bash-${second + 900}-second.sh`);
  removeClaudeSessionLeftovers({ configRoot: root, nativeSessionId: 'native-1', isPidAlive: () => false });
  assert.equal(exists(`shell-snapshots/snapshot-bash-${first + 900}-first.sh`), false, 'the first CLI\'s snapshot');
  assert.equal(exists(`shell-snapshots/snapshot-bash-${second + 900}-second.sh`), false, 'the second CLI\'s snapshot');
  // The session's record goes with it.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'oar-cli-starts.json'), 'utf8')).sessions, {});
}));

test('a snapshot in the window of another session\'s recorded start stays, even with no registration left', () => withConfigDir(({ root, write, register, exists }) => {
  register(101, 'native-1', STARTED);
  recordClaudeCliStart({ configRoot: root, nativeSessionId: 'native-1', startedAt: STARTED });
  // Another session's CLI started 30 s later and has exited: only the
  // relay's record of its start is left.
  recordClaudeCliStart({ configRoot: root, nativeSessionId: 'native-2', startedAt: STARTED + 30_000 });
  write(`shell-snapshots/snapshot-zsh-${STARTED + 30_500}-other.sh`);
  removeClaudeSessionLeftovers({ configRoot: root, nativeSessionId: 'native-1', isPidAlive: () => false });
  assert.ok(exists(`shell-snapshots/snapshot-zsh-${STARTED + 30_500}-other.sh`));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'oar-cli-starts.json'), 'utf8')).sessions, { 'native-2': [STARTED + 30_000] });
}));

test('a CLI start is recorded only for a plain session id and a real time, once per time', () => withConfigDir(({ root }) => {
  assert.equal(recordClaudeCliStart({ configRoot: root, nativeSessionId: '../x', startedAt: STARTED }), false);
  assert.equal(recordClaudeCliStart({ configRoot: root, nativeSessionId: 'native-1', startedAt: 'soon' }), false);
  assert.equal(recordClaudeCliStart({ configRoot: '', nativeSessionId: 'native-1', startedAt: STARTED }), false);
  recordClaudeCliStart({ configRoot: root, nativeSessionId: 'native-1', startedAt: STARTED });
  recordClaudeCliStart({ configRoot: root, nativeSessionId: 'native-1', startedAt: STARTED });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'oar-cli-starts.json'), 'utf8')).sessions, { 'native-1': [STARTED] });
}));
