import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createQuestionRepository, nextTurnSeq } from './question-repository.mjs';

// One order across a turn's thoughts and tool lines (migration 0038): the
// number is shared by both tables, given on a row's first write, kept by a
// thought's updates, and never handed out twice, even to two connections.

function makeDb(file = ':memory:') {
  const db = new Database(file);
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-fixture', 'Widget cache plan', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  return db;
}

const at = (n) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;

function addActivity(db, repo, queueId, text, n, subagentRunId = null) {
  return db.transaction(() => {
    const turnSeq = repo.nextTurnSeq(queueId);
    repo.insertActivity.run(queueId, null, 'conv-fixture', 'agent', text, at(n), subagentRunId, null, turnSeq);
    return turnSeq;
  }).immediate();
}

function addThought(db, repo, queueId, reasoningId, text, n) {
  return db.transaction(() => {
    const known = repo.getThoughtByQueueAndReasoning.get(queueId, reasoningId);
    if (known) {
      repo.updateThoughtByQueueAndReasoning.run(null, 'conv-fixture', 'agent', text, 0, at(n), null, queueId, reasoningId);
      return known.turn_seq;
    }
    const turnSeq = repo.nextTurnSeq(queueId);
    repo.insertThought.run(queueId, null, 'conv-fixture', 'agent', reasoningId, n, text, 0, at(n), null, turnSeq);
    return turnSeq;
  }).immediate();
}

test('the number runs across both tables, per queue message, from 1', () => {
  const db = makeDb();
  const repo = createQuestionRepository(db);
  assert.equal(repo.hasTurnSeq, true);
  assert.equal(nextTurnSeq(db, 'q-a'), 1);

  assert.equal(addThought(db, repo, 'q-a', 'r-1', 'The widget cache needs a cap', 1), 1);
  assert.equal(addActivity(db, repo, 'q-a', 'Tool (view): cache.js', 2), 2);
  assert.equal(addThought(db, repo, 'q-a', 'r-2', 'Eviction drops the oldest', 3), 3);
  assert.equal(addActivity(db, repo, 'q-a', 'Tool (grep): evict', 4, 'toolu_fixture_sub'), 4, 'a sub-agent row takes a number too');
  assert.equal(addActivity(db, repo, 'q-b', 'Tool (view): other.js', 5), 1, 'another turn counts on its own');
  assert.equal(nextTurnSeq(db, 'q-a'), 5);

  assert.deepEqual(repo.listActivityByQueueMessage.all('q-a').map((row) => row.turn_seq), [2, 4]);
  assert.deepEqual(repo.listThoughtsByQueueMessage.all('q-a').map((row) => row.turn_seq), [1, 3]);
});

test('a thought update keeps the number of its first chunk', () => {
  const db = makeDb();
  const repo = createQuestionRepository(db);
  assert.equal(addThought(db, repo, 'q-a', 'r-1', 'Reading', 1), 1);
  assert.equal(addActivity(db, repo, 'q-a', 'Tool (view): a.js', 2), 2);
  assert.equal(addThought(db, repo, 'q-a', 'r-1', 'Reading the eviction code', 3), 1);
  assert.equal(repo.getThoughtByQueueAndReasoning.get('q-a', 'r-1').turn_seq, 1);
  assert.equal(nextTurnSeq(db, 'q-a'), 3);
});

test('rows written without a number (a history rebuild, old rows) do not disturb the count', () => {
  const db = makeDb();
  const repo = createQuestionRepository(db);
  // A caller that leaves turn_seq out (the arity before 0038) writes null.
  repo.insertActivity.run('q-a', null, 'conv-fixture', 'agent', 'Tool (view): old.js', at(1), null, null);
  repo.insertThought.run('q-a', null, 'conv-fixture', 'agent', 'r-old', 1, 'Old thought', 1, at(2), null);
  assert.equal(repo.listActivityByQueueMessage.get('q-a').turn_seq, null);
  assert.equal(nextTurnSeq(db, 'q-a'), 1);
});

test('two connections inserting into one turn never get the same number', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-turn-seq-'));
  try {
    const file = path.join(dir, 'fixture.db');
    const first = makeDb(file);
    const second = new Database(file);
    second.pragma('busy_timeout = 2000');
    const repoA = createQuestionRepository(first);
    const repoB = createQuestionRepository(second);
    const numbers = [];
    for (let n = 1; n <= 20; n += 1) {
      // Interleaved writers: tool lines from one, thoughts (new and updated)
      // from the other.
      numbers.push(addActivity(first, repoA, 'q-shared', `Tool (view): part-${n}.js`, n));
      numbers.push(addThought(second, repoB, 'q-shared', `r-${n % 7}`, `Thought ${n}`, n));
    }
    const given = [
      ...first.prepare(`SELECT turn_seq FROM relay_activity WHERE queue_message_id = 'q-shared'`).all(),
      ...first.prepare(`SELECT turn_seq FROM relay_thought WHERE queue_message_id = 'q-shared'`).all(),
    ].map((row) => row.turn_seq).sort((a, b) => a - b);
    assert.equal(new Set(given).size, given.length, 'no number twice');
    assert.deepEqual(given, Array.from({ length: given.length }, (_, index) => index + 1), 'no gaps');
    assert.equal(given.length, 20 + 7, '20 tool lines, 7 thoughts (updates keep theirs)');
    first.close();
    second.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two threads writing to one turn at the same time never get the same number', async () => {
  const { Worker } = await import('node:worker_threads');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-turn-seq-'));
  try {
    const file = path.join(dir, 'fixture.db');
    makeDb(file).close();
    const repoUrl = new URL('./question-repository.mjs', import.meta.url).href;
    // Each thread writes 60 rows as fast as it can; the two race for the
    // write lock the whole time.
    const source = `
      import { workerData, parentPort } from 'node:worker_threads';
      const { default: Database } = await import(workerData.sqliteUrl);
      const { createQuestionRepository } = await import(workerData.repoUrl);
      const db = new Database(workerData.file);
      db.pragma('busy_timeout = 5000');
      const repo = createQuestionRepository(db);
      for (let n = 0; n < 60; n += 1) {
        db.transaction(() => {
          const turnSeq = repo.nextTurnSeq('q-race');
          if (workerData.kind === 'activity') {
            repo.insertActivity.run('q-race', null, 'conv-fixture', 'agent', 'Tool (view): w' + n, new Date().toISOString(), null, null, turnSeq);
          } else {
            repo.insertThought.run('q-race', null, 'conv-fixture', 'agent', 'r-' + n, n + 1, 'Thought ' + n, 1, new Date().toISOString(), null, turnSeq);
          }
        }).immediate();
      }
      db.close();
      parentPort.postMessage('done');
    `;
    const run = (kind) => new Promise((resolve, reject) => {
      const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), { workerData: { file, repoUrl, sqliteUrl: import.meta.resolve('better-sqlite3'), kind } });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    await Promise.all([run('activity'), run('thought')]);
    const db = new Database(file);
    const given = [
      ...db.prepare(`SELECT turn_seq FROM relay_activity WHERE queue_message_id = 'q-race'`).all(),
      ...db.prepare(`SELECT turn_seq FROM relay_thought WHERE queue_message_id = 'q-race'`).all(),
    ].map((row) => row.turn_seq).sort((a, b) => a - b);
    db.close();
    assert.equal(given.length, 120);
    assert.deepEqual(given, Array.from({ length: 120 }, (_, index) => index + 1), 'each number once, no gaps');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without the column (0038 failed) the repository still works, without numbers', () => {
  const db = makeDb();
  for (const table of ['relay_activity', 'relay_thought']) {
    db.exec(`DROP INDEX idx_${table}_queue_turn_seq`);
    db.exec(`ALTER TABLE ${table} DROP COLUMN turn_seq`);
  }
  const repo = createQuestionRepository(db);
  assert.equal(repo.hasTurnSeq, false);
  assert.equal(repo.nextTurnSeq('q-a'), null);
  repo.insertActivity.run('q-a', null, 'conv-fixture', 'agent', 'Tool (view): a.js', at(1), null, null, null);
  repo.insertThought.run('q-a', null, 'conv-fixture', 'agent', 'r-1', 1, 'Thinking', 0, at(2), null, null);
  assert.deepEqual(Object.keys(repo.listActivityByQueueMessage.get('q-a')).sort(), ['metadata_json', 'subagent_run_id', 'text']);
  assert.equal(repo.listThoughtsByQueueMessage.get('q-a').turn_seq, undefined);
  assert.equal(repo.getThoughtByQueueAndReasoning.get('q-a', 'r-1').turn_seq, undefined);
});
