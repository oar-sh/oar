import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { ensurePlanUsageSchema } from './plan-usage-service.mjs';
import {
  collectAboutTotals,
  createAboutService,
  readGitCommit,
  readInstalledPackageVersion,
  resolveBuildCommit,
} from './about-service.mjs';

const COMMIT_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const COMMIT_B = '0123456789abcdef0123456789abcdef01234567';

function fixtureDb() {
  const db = new Database(':memory:');
  applySchema(db);
  ensurePlanUsageSchema(db);
  const addConversation = db.prepare(`INSERT INTO conversations (id, title, archived, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  const bind = db.prepare(`INSERT INTO runtime_sessions (id, conversation_id, runtime_key, provider_type, created_at, last_used_at) VALUES (?, ?, 'key', ?, ?, ?)`);
  const addMessage = db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp, executed_provider) VALUES (?, ?, ?, 'text', ?, ?)`);
  const at = '2026-03-02T10:00:00.000Z';
  addConversation.run('conv-fixture-report', 'report builder', 0, 'active', '2026-02-01T09:00:00.000Z', at);
  addConversation.run('conv-fixture-export', 'export tool', 1, 'active', '2026-02-10T09:00:00.000Z', at);
  addConversation.run('conv-fixture-plain', 'plain chat', 0, 'active', '2026-02-20T09:00:00.000Z', at);
  addConversation.run('conv-fixture-gone', 'deleted chat', 0, 'deleted', '2026-01-01T09:00:00.000Z', at);
  bind.run('rs-1', 'conv-fixture-report', 'claude', at, at);
  bind.run('rs-2', 'conv-fixture-export', 'cursor', at, at);
  let n = 0;
  const message = (conversationId, role, executedProvider = null) => addMessage.run(`m-${n += 1}`, conversationId, role, at, executedProvider);
  // Claude conversation: three turns, one of them run by Copilot.
  for (let i = 0; i < 3; i += 1) message('conv-fixture-report', 'user');
  message('conv-fixture-report', 'assistant');
  message('conv-fixture-report', 'assistant', 'claude');
  message('conv-fixture-report', 'assistant', 'github');
  // Cursor conversation: two turns.
  message('conv-fixture-export', 'user');
  message('conv-fixture-export', 'assistant');
  message('conv-fixture-export', 'assistant');
  // No binding: Copilot.
  message('conv-fixture-plain', 'user');
  message('conv-fixture-plain', 'assistant');
  message('conv-fixture-plain', 'assistant');
  return db;
}

test('the totals count conversations, messages and turns by the provider that ran them', async () => {
  const db = fixtureDb();
  let yields = 0;
  const totals = await collectAboutTotals(db, { chunkRows: 2, yieldToLoop: async () => { yields += 1; }, nowIso: () => 'now' });
  assert.deepEqual(totals.conversations, { total: 3, archived: 1, firstCreatedAt: '2026-02-01T09:00:00.000Z' });
  assert.equal(totals.messages, 12);
  assert.equal(totals.turns, 7);
  assert.deepEqual(totals.turnsByProvider, [
    { id: 'github', turns: 3 },
    { id: 'claude', turns: 2 },
    { id: 'cursor', turns: 2 },
  ]);
  assert.equal(totals.computedAt, 'now');
  // 12 rows in ranges of 2: the walk yields between every range.
  assert.ok(yields >= 5, `yielded ${yields} times`);
  // The same answer in one range.
  const single = await collectAboutTotals(db, { chunkRows: 1000, yieldToLoop: async () => {} });
  assert.equal(single.messages, 12);
  assert.deepEqual(single.turnsByProvider, totals.turnsByProvider);
});

test('an empty database has zero totals and no first conversation', async () => {
  const db = new Database(':memory:');
  applySchema(db);
  const totals = await collectAboutTotals(db, { yieldToLoop: async () => {} });
  assert.deepEqual(totals.conversations, { total: 0, archived: 0, firstCreatedAt: null });
  assert.equal(totals.messages, 0);
  assert.equal(totals.turns, 0);
  assert.deepEqual(totals.turnsByProvider, []);
  assert.deepEqual(totals.usage, {}, 'nothing stored, nothing reported');
});

test('usage totals sum what the providers reported and leave the others out', async () => {
  const db = fixtureDb();
  const at = '2026-03-02T10:00:00.000Z';
  db.prepare(`INSERT INTO message_usage_snapshots (response_message_id, conversation_id, premium_delta_used, captured_at) VALUES (?, ?, ?, ?)`).run('m-4', 'conv-fixture-report', 1, at);
  db.prepare(`INSERT INTO message_usage_snapshots (response_message_id, conversation_id, premium_delta_used, captured_at) VALUES (?, ?, ?, ?)`).run('m-6', 'conv-fixture-report', 0.33, at);
  db.prepare(`INSERT INTO message_usage_snapshots (response_message_id, conversation_id, premium_delta_used, captured_at) VALUES (?, ?, ?, ?)`).run('m-11', 'conv-fixture-plain', 0, at);
  const cycle = db.prepare(`INSERT INTO cursor_usage_cycle_totals (cycle_key, pool, raw_cost_cents, charged_cents, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, run_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  cycle.run('2026-02', 'included', 150, 0, 1000, 200, 50, 10, 1260, 3, at);
  cycle.run('2026-03', 'on-demand', 50, 25, 500, 100, 0, 0, 600, 1, at);
  db.prepare(`UPDATE runtime_sessions SET claude_cloud_cost_usd = ? WHERE id = ?`).run(0.42, 'rs-1');
  const { usage } = await collectAboutTotals(db, { yieldToLoop: async () => {} });
  assert.deepEqual(usage.github, { premiumRequests: 1.33, turns: 2 });
  assert.deepEqual(usage.cursor, {
    inputTokens: 1500,
    outputTokens: 300,
    cacheReadTokens: 50,
    cacheWriteTokens: 10,
    totalTokens: 1860,
    runs: 4,
    rawCostUsd: 2,
    chargedUsd: 0.25,
  });
  assert.deepEqual(usage['claude-cloud'], { costUsd: 0.42, sessions: 1 });
  assert.equal(usage.grok, undefined, 'Grok stored nothing');
});

function fakeFs(files) {
  return {
    readFileSync(filePath) {
      if (Object.hasOwn(files, filePath)) return files[filePath];
      const error = new Error(`ENOENT: ${filePath}`);
      error.code = 'ENOENT';
      throw error;
    },
  };
}

// Both path flavours run on every machine: a linked worktree's gitdir is
// resolved, and on Windows that puts a drive letter in front of a rooted path.
for (const [flavour, pathImpl, demoRoot, gitdirOf] of [
  ['posix', path.posix, '/home/dev', (dir) => dir],
  // Git for Windows writes the gitdir pointer with forward slashes.
  ['win32', path.win32, 'C:\\Users\\dev', (dir) => dir.replaceAll('\\', '/')],
]) {
  test(`the commit is read from the checkout without running git (${flavour})`, () => {
    const read = (root, files) => readGitCommit(root, { fsImpl: fakeFs(files), pathImpl });
    const root = pathImpl.join(demoRoot, 'demo');
    const gitDir = pathImpl.join(root, '.git');
    const packedRefs = pathImpl.join(gitDir, 'packed-refs');
    // A branch with a loose ref.
    assert.equal(read(root, {
      [pathImpl.join(gitDir, 'HEAD')]: 'ref: refs/heads/main\n',
      [pathImpl.join(gitDir, 'refs', 'heads', 'main')]: `${COMMIT_A}\n`,
    }), COMMIT_A);
    // A packed ref.
    assert.equal(read(root, {
      [pathImpl.join(gitDir, 'HEAD')]: 'ref: refs/heads/feature/export\n',
      [packedRefs]: `# pack-refs with: peeled fully-peeled sorted\n${COMMIT_B} refs/heads/feature/export\n`,
    }), COMMIT_B);
    // A detached HEAD.
    assert.equal(read(root, { [pathImpl.join(gitDir, 'HEAD')]: `${COMMIT_B.toUpperCase()}\n` }), COMMIT_B);
    // A linked worktree: .git is a file, the branch ref is in the common dir.
    const linkedRoot = pathImpl.join(demoRoot, 'demo-wt');
    const linkedGitDir = pathImpl.join(gitDir, 'worktrees', 'demo-wt');
    assert.equal(read(linkedRoot, {
      [pathImpl.join(linkedRoot, '.git')]: `gitdir: ${gitdirOf(linkedGitDir)}\n`,
      [pathImpl.join(linkedGitDir, 'HEAD')]: 'ref: refs/heads/feature/export\n',
      [pathImpl.join(linkedGitDir, 'commondir')]: '../..\n',
      [pathImpl.join(gitDir, 'refs', 'heads', 'feature', 'export')]: `${COMMIT_A}\n`,
    }), COMMIT_A);
    // No checkout, or a ref that does not resolve.
    assert.equal(read(root, {}), null);
    assert.equal(read(root, { [pathImpl.join(gitDir, 'HEAD')]: 'ref: refs/heads/missing\n' }), null);
  });
}

test('an installed package falls back to a gitHead stamp, and to nothing', () => {
  const root = path.join(path.sep, 'home', 'dev', 'install');
  assert.equal(resolveBuildCommit(root, { fsImpl: fakeFs({
    [path.join(root, 'package.json')]: JSON.stringify({ version: '1.2.3', gitHead: COMMIT_B }),
  }) }), COMMIT_B);
  assert.equal(resolveBuildCommit(root, { fsImpl: fakeFs({
    [path.join(root, 'package.json')]: JSON.stringify({ version: '1.2.3' }),
  }) }), null);
  assert.equal(readInstalledPackageVersion(root, '@cursor/sdk', { fsImpl: fakeFs({
    [path.join(root, 'node_modules', '@cursor', 'sdk', 'package.json')]: JSON.stringify({ version: '1.0.36' }),
  }) }), '1.0.36');
  assert.equal(readInstalledPackageVersion(root, '@cursor/sdk', { fsImpl: fakeFs({}) }), null);
});

function aboutService(overrides = {}) {
  const db = overrides.db || fixtureDb();
  let clock = Date.parse('2026-03-02T12:00:00.000Z');
  let collected = 0;
  const service = createAboutService({
    db,
    version: '1.2.3',
    commit: COMMIT_A,
    installMethod: 'git-checkout',
    startedAt: '2026-03-02T11:00:00.000Z',
    getProviderSettings: () => ({
      github: { enabled: true, engine: 'extension' },
      openai: { enabled: false },
      claude: { enabled: true },
      cursor: { enabled: true },
      grok: { enabled: false },
    }),
    getCachedCliProviders: () => ({
      copilot: { installed: true, version: '1.0.82', checkedAt: '2026-03-02T11:30:00.000Z' },
      claude: { installed: true, version: '2.1.251', checkedAt: '2026-03-02T11:30:00.000Z' },
      grok: { installed: false, version: null, checkedAt: null },
    }),
    isRelayCliOnline: () => true,
    listWorkers: () => [
      { conversationId: 'conv-fixture-report', status: 'ready', pid: 101 },
      { conversationId: 'conv-fixture-report', status: 'exited', pid: 102 },
      { conversationId: 'conv-fixture-export', status: 'processing', pid: 999 },
      { conversationId: null, status: 'starting', pid: 103 },
    ],
    isPidAlive: (pid) => pid !== 999,
    sdkVersions: { github: '1.0.17', claude: '0.3.292', cursor: '1.0.36' },
    getUpdateState: () => null,
    now: () => clock,
    collectTotals: async (database) => {
      collected += 1;
      return collectAboutTotals(database, { yieldToLoop: async () => {} });
    },
    ...overrides,
  });
  return { service, db, advance: (ms) => { clock += ms; }, collected: () => collected };
}

test('describe lists the enabled providers with versions and state', async () => {
  const { service } = aboutService();
  const about = await service.describe();
  assert.equal(about.version, '1.2.3');
  assert.equal(about.commit, COMMIT_A);
  assert.equal(about.startedAt, '2026-03-02T11:00:00.000Z');
  assert.equal(about.uptimeSeconds, 3600);
  assert.deepEqual(about.providers.map((row) => row.id), ['github', 'claude', 'cursor']);
  const [copilot, claude, cursor] = about.providers;
  assert.deepEqual(
    { engine: copilot.engine, cli: copilot.cliVersion, sdk: copilot.sdkVersion, state: copilot.state },
    { engine: 'extension', cli: '1.0.82', sdk: null, state: 'online' },
    'the extension engine runs in the relay CLI, not on the SDK',
  );
  assert.deepEqual(
    { cli: claude.cliVersion, sdk: claude.sdkVersion, state: claude.state, running: claude.runningWorkers },
    { cli: '2.1.251', sdk: '0.3.292', state: 'online', running: 1 },
  );
  assert.deepEqual(
    { cli: cursor.cliVersion, sdk: cursor.sdkVersion, state: cursor.state, running: cursor.runningWorkers },
    { cli: null, sdk: '1.0.36', state: 'idle', running: 0 },
    'a worker whose process is gone does not count',
  );
  assert.equal(about.relay.runningWorkers, 2, 'the Claude worker and the unassigned one');
  assert.equal(about.relay.uptimeSeconds, 3600);
  assert.equal(about.stats.conversations, 3);
  assert.equal(about.stats.firstConversationAt, '2026-02-01T09:00:00.000Z');
  assert.equal(about.stats.turns, 7);
  assert.deepEqual(about.stats.turnsByProvider.map((row) => row.label), ['GitHub Copilot', 'Claude Code', 'Cursor']);
});

test('the Copilot SDK engine reports the SDK and its workers', async () => {
  const { service } = aboutService({
    getProviderSettings: () => ({ github: { enabled: true, engine: 'sdk' } }),
    isRelayCliOnline: () => false,
    listWorkers: () => [],
  });
  const [copilot] = (await service.describe()).providers;
  assert.deepEqual(
    { engine: copilot.engine, sdk: copilot.sdkVersion, state: copilot.state },
    { engine: 'sdk', sdk: '1.0.17', state: 'idle' },
  );
});

test('the totals are kept for a minute and read once for concurrent callers', async () => {
  const { service, db, advance, collected } = aboutService();
  await Promise.all([service.describe(), service.describe()]);
  assert.equal(collected(), 1);
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m-new', 'conv-fixture-plain', 'assistant', 'later', '2026-03-02T12:00:00.000Z')`).run();
  advance(30_000);
  assert.equal((await service.describe()).stats.turns, 7, 'still the cached totals');
  assert.equal(collected(), 1);
  advance(31_000);
  assert.equal((await service.describe()).stats.turns, 8);
  assert.equal(collected(), 2);
});

test('update facts show only while the opt-in check is on', async () => {
  const state = (check, checkKilled = false) => () => ({ runningVersion: '1.2.3', checkKilled, check });
  const off = await aboutService({ getUpdateState: state({ autoCheckEnabled: false, available: true, version: '1.3.0', notesUrl: 'https://example.test/notes' }) }).service.describe();
  assert.deepEqual(off.update, { checkEnabled: false, checkKilled: false, available: false, latestVersion: null, notesUrl: null, lastCheckedAt: null });
  const on = await aboutService({ getUpdateState: state({ autoCheckEnabled: true, available: true, version: '1.3.0', notesUrl: 'https://example.test/notes', lastCheckedAt: '2026-03-02T08:00:00.000Z' }) }).service.describe();
  assert.deepEqual(on.update, { checkEnabled: true, checkKilled: false, available: true, latestVersion: '1.3.0', notesUrl: 'https://example.test/notes', lastCheckedAt: '2026-03-02T08:00:00.000Z' });
  const current = await aboutService({ getUpdateState: state({ autoCheckEnabled: true, available: false, version: null, lastCheckedAt: '2026-03-02T08:00:00.000Z' }) }).service.describe();
  assert.equal(current.update.available, false);
  assert.equal(current.update.lastCheckedAt, '2026-03-02T08:00:00.000Z');
  const killed = await aboutService({ getUpdateState: () => ({ checkKilled: true, check: null }) }).service.describe();
  assert.equal(killed.update.checkEnabled, false);
  assert.equal(killed.update.checkKilled, true);
});

test('the database size counts the database file and its WAL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-about-'));
  try {
    const dbPath = path.join(dir, 'relay.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    applySchema(db);
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-fixture-size', 'size', '2026-03-02T10:00:00.000Z', '2026-03-02T10:00:00.000Z')`).run();
    const { service } = aboutService({ db, dbPath });
    const { relay } = await service.describe();
    const expectedFile = fs.statSync(dbPath).size;
    const expectedWal = fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0;
    assert.equal(relay.dbFileBytes, expectedFile);
    assert.equal(relay.walBytes, expectedWal);
    assert.equal(relay.dbBytes, expectedFile + expectedWal);
    assert.ok(relay.dbBytes > 0);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
