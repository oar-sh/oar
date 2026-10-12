import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createSubagentTimelineService } from './subagent-timeline-service.mjs';
import { createSubagentRecordRetention, prunedTimelineEntry } from './subagent-record-retention.mjs';

// The retention sweep on the real schema: what is stripped (tool inputs and
// results of finished runs past the age), what is kept (everything else, and
// every entry of a run still running), batching, the setting off.

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const DONE_RUN = 'toolu_fixture_done';
const RUNNING_RUN = 'toolu_fixture_running';

function makeFixture({ retentionDays = 90, batchSize = 2000 } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'Widget work', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES ('q-1', 'conv-1', 'seed', 'done', '2026-01-01T00:00:00Z')`).run();
  const stmts = createQuestionRepository(db);
  stmts.insertSubagentRun.run(DONE_RUN, 'q-1', 'conv-1', null, 'Survey the widget parser', 'completed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  stmts.insertSubagentRun.run(RUNNING_RUN, 'q-1', 'conv-1', null, 'Watch the widget build', 'running', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  const timeline = createSubagentTimelineService({ db, stmts, now: () => iso(NOW) });
  const write = (runId, entries) => timeline.applyEntries(stmts.getSubagentRun.get(runId), entries);
  const age = (runId, daysOld) => db.prepare(`UPDATE subagent_timeline SET updated_at = ? WHERE run_id = ?`).run(iso(NOW - daysOld * DAY), runId);
  const rows = (runId) => db.prepare(`SELECT seq, kind, text, metadata_json, pruned_at FROM subagent_timeline WHERE run_id = ? ORDER BY seq`).all(runId)
    .map((row) => ({ ...row, metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null }));
  const settings = { days: retentionDays };
  const logs = [];
  let yields = 0;
  const retention = createSubagentRecordRetention({
    db,
    getRetentionDays: () => settings.days,
    now: () => NOW,
    batchSize,
    yieldToLoop: async () => { yields += 1; },
    log: (line) => logs.push(line),
  });
  return { db, write, age, rows, retention, settings, logs, yields: () => yields };
}

const RECORD = [
  { key: 'w:1', kind: 'thought', text: 'The parser needs a look first.' },
  { key: 'w:2', kind: 'tool_call', toolName: 'Bash', toolUseId: 'toolu_fixture_bash_1', text: JSON.stringify({ command: 'grep -rn widget /home/dev/widget/src', description: 'Find the widgets' }) },
  { key: 'w:3', kind: 'tool_result', toolUseId: 'toolu_fixture_bash_1', text: 'src/widget.js:12: export function widget() {}\n'.repeat(20), metadata: { isError: true } },
  { key: 'w:4', kind: 'text', text: 'Twelve widgets, all exported.' },
  { key: 'w:5', kind: 'note', text: 'Agent finished.' },
  { key: 'w:6', kind: 'child', toolUseId: 'toolu_fixture_child', text: 'Check the fixtures' },
];

test('a finished run past the age keeps its story and loses its tool inputs and output', async () => {
  const { write, age, rows, retention, logs } = makeFixture();
  write(DONE_RUN, RECORD);
  age(DONE_RUN, 91);
  const before = rows(DONE_RUN);
  const result = await retention.sweep();
  assert.equal(result.pruned, 2);
  const after = rows(DONE_RUN);
  for (const index of [0, 3, 4, 5]) {
    assert.equal(after[index].text, before[index].text, `${after[index].kind} kept`);
    assert.equal(after[index].pruned_at, null);
  }
  const [call, output] = [after[1], after[2]];
  assert.equal(call.text, 'grep -rn widget /home/dev/widget/src', 'the call keeps its one line');
  assert.deepEqual(call.metadata, { pruned: true, prunedAt: iso(NOW), originalChars: before[1].text.length, retentionDays: 90 });
  assert.equal(output.text, '');
  assert.equal(output.metadata.isError, true, 'what the result was stays');
  assert.equal(output.metadata.originalChars, before[2].text.length);
  assert.equal(output.pruned_at, iso(NOW));
  assert.equal(result.freedChars, before[1].text.length - call.text.length + before[2].text.length);
  assert.match(logs.at(-1), /^SUBAGENT RETENTION stripped 2 tool entries \(\d+ chars\) older than 90 d in 1 batch, \d+ ms$/);

  // A second sweep finds nothing.
  assert.equal((await retention.sweep()).pruned, 0);
  assert.match(logs.at(-1), /nothing older than 90 d/);
});

test('entries younger than the setting stay whole', async () => {
  const { write, age, rows, retention, settings } = makeFixture();
  write(DONE_RUN, RECORD);
  age(DONE_RUN, 20);
  assert.equal((await retention.sweep()).pruned, 0);
  settings.days = 14;
  assert.equal((await retention.sweep()).pruned, 2);
  assert.equal(rows(DONE_RUN)[1].metadata.retentionDays, 14);
});

test('a run still running keeps its whole record, however old', async () => {
  const { write, age, rows, retention } = makeFixture();
  write(RUNNING_RUN, RECORD);
  age(RUNNING_RUN, 400);
  assert.equal((await retention.sweep()).pruned, 0);
  assert.ok(rows(RUNNING_RUN).every((row) => row.pruned_at === null));
});

test('off means no sweep at all', async () => {
  const { write, age, rows, retention, logs } = makeFixture({ retentionDays: 0 });
  write(DONE_RUN, RECORD);
  age(DONE_RUN, 400);
  const result = await retention.sweep();
  assert.equal(result.skipped, 'off');
  assert.ok(rows(DONE_RUN).every((row) => row.pruned_at === null));
  assert.equal(logs.length, 0);
});

test('the sweep works in batches and lets the relay breathe between them', async () => {
  const { write, age, rows, retention, yields } = makeFixture({ batchSize: 3 });
  const entries = [];
  for (let index = 0; index < 8; index += 1) {
    entries.push({ key: `c:${index}`, kind: 'tool_call', toolName: 'Read', text: JSON.stringify({ file_path: `/home/dev/widget/part-${index}.js` }) });
  }
  write(DONE_RUN, entries);
  age(DONE_RUN, 100);
  const result = await retention.sweep();
  assert.equal(result.pruned, 8);
  assert.equal(result.batches, 3);
  assert.equal(yields(), 2);
  assert.deepEqual(rows(DONE_RUN).map((row) => row.text), entries.map((_, index) => `/home/dev/widget/part-${index}.js`));
});

test('one sweep at a time', async () => {
  const { write, age, retention } = makeFixture();
  write(DONE_RUN, RECORD);
  age(DONE_RUN, 100);
  const [first, second] = [retention.sweep(), retention.sweep()];
  assert.equal(first, second);
  assert.equal((await first).pruned, 2);
});

test('the candidate query uses the partial index', () => {
  const { db } = makeFixture();
  const plan = db.prepare(`EXPLAIN QUERY PLAN
    SELECT t.id FROM subagent_timeline t
    WHERE t.pruned_at IS NULL AND t.kind IN ('tool_call', 'tool_result') AND t.updated_at < '2026-01-01'
    ORDER BY t.updated_at LIMIT 10`).all().map((row) => row.detail).join(' | ');
  assert.match(plan, /idx_subagent_timeline_prunable/);
});

test('a database without the pruned marker is left alone', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE subagent_timeline (id INTEGER PRIMARY KEY, kind TEXT, text TEXT, updated_at TEXT)`);
  const retention = createSubagentRecordRetention({ db, getRetentionDays: () => 7, log: () => {} });
  assert.equal((await retention.sweep()).skipped, 'unsupported');
});

test('a stripped entry is rebuilt from its row alone', () => {
  const call = prunedTimelineEntry({ kind: 'tool_call', text: 'Tool (glob): src/**/widget*.js\nmore', metadata_json: null }, { prunedAt: 'T', retentionDays: 7 });
  assert.equal(call.text, 'Tool (glob): src/**/widget*.js');
  const result = prunedTimelineEntry({ kind: 'tool_result', text: 'x'.repeat(10), metadata_json: '{"cut":9000}' }, { prunedAt: 'T', retentionDays: 7 });
  assert.deepEqual(JSON.parse(result.metadataJson), { cut: 9000, pruned: true, prunedAt: 'T', originalChars: 10, retentionDays: 7 });
  assert.equal(result.freedChars, 10);
});
