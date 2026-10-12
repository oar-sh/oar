import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import {
  createSubagentTimelineService,
  mapSubagentRunHeader,
  sanitizeRunHeaderPatch,
  sanitizeTimelineEntry,
  TRUNCATED_NOTE_KEY,
} from './subagent-timeline-service.mjs';
import { SUBAGENT_TIMELINE_MAX_ENTRIES, SUBAGENT_TOOL_RESULT_MAX_CHARS } from '../../shared/subagent-timeline.mjs';

const RUN = 'toolu_fixture_alpha';
const CHILD = 'toolu_fixture_beta';

function makeFixture() {
  const db = new Database(':memory:');
  applySchema(db);
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'Widget work', '2026-10-10T10:00:00Z', '2026-10-10T10:00:00Z')`).run();
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES ('q-1', 'conv-1', 'seed', 'processing', '2026-10-10T10:00:00Z')`).run();
  const stmts = createQuestionRepository(db);
  stmts.insertSubagentRun.run(RUN, 'q-1', 'conv-1', null, 'Survey the widget parser', 'running', '2026-10-10T10:00:01Z', '2026-10-10T10:00:01Z');
  let tick = 0;
  const now = () => new Date(Date.parse('2026-10-10T10:00:02Z') + (tick += 1) * 1000).toISOString();
  const service = createSubagentTimelineService({ db, stmts, now });
  const run = () => stmts.getSubagentRun.get(RUN);
  return { db, stmts, service, run };
}

test('new keys take the next seq and a known key updates its entry in place', () => {
  const { service, run } = makeFixture();
  const first = service.applyEntries(run(), [
    { key: 'w1:1', kind: 'thought', text: 'Looking at the parser', done: false },
    { key: 'w1:2', kind: 'tool_call', toolName: 'Read', toolUseId: 'toolu_read_1', text: '{"file_path":"/home/dev/widget/parser.js"}' },
  ]);
  assert.deepEqual(first.entries.map((entry) => [entry.seq, entry.kind, entry.done]), [[1, 'thought', false], [2, 'tool_call', true]]);
  assert.equal(first.entries[1].toolName, 'Read');

  const update = service.applyEntries(run(), [{ key: 'w1:1', kind: 'thought', text: 'Looking at the parser and its tests', done: true }]);
  assert.deepEqual(update.entries.map((entry) => [entry.seq, entry.text, entry.done]), [[1, 'Looking at the parser and its tests', true]]);

  // A closed entry never reopens.
  service.applyEntries(run(), [{ key: 'w1:1', kind: 'thought', text: 'late partial', done: false }]);
  const page = service.readTimeline(run());
  assert.deepEqual(page.entries.map((entry) => [entry.seq, entry.done]), [[1, true], [2, true]]);
});

test('reading after a seq returns later entries and every entry still open', () => {
  const { service, run } = makeFixture();
  service.applyEntries(run(), [
    { key: 'a', kind: 'text', text: 'Draft', done: false },
    { key: 'b', kind: 'tool_call', text: '{}' },
    { key: 'c', kind: 'tool_result', text: 'ok' },
  ]);
  const page = service.readTimeline(run(), { afterSeq: 2 });
  assert.deepEqual(page.entries.map((entry) => entry.seq), [1, 3]);
  assert.equal(page.nextAfter, 3);
  assert.equal(page.complete, true);

  const limited = service.readTimeline(run(), { afterSeq: 0, limit: 2 });
  assert.equal(limited.entries.length, 2);
  assert.equal(limited.complete, false);
  assert.equal(limited.nextAfter, 2);
});

test('a tool result is cut to 4 KB and the original length is kept', () => {
  const { service, run } = makeFixture();
  const long = 'x'.repeat(SUBAGENT_TOOL_RESULT_MAX_CHARS + 500);
  const { entries } = service.applyEntries(run(), [{ key: 'r', kind: 'tool_result', text: long }]);
  assert.equal(entries[0].text.length, SUBAGENT_TOOL_RESULT_MAX_CHARS);
  assert.equal(entries[0].metadata.cut, SUBAGENT_TOOL_RESULT_MAX_CHARS + 500);
});

test('past the per-run limit one note marks the cut and later new entries are dropped', () => {
  const { service, run, db } = makeFixture();
  const batch = Array.from({ length: SUBAGENT_TIMELINE_MAX_ENTRIES }, (_, index) => ({ key: `k${index}`, kind: 'tool_call', text: `{"n":${index}}` }));
  service.applyEntries(run(), batch);
  const over = service.applyEntries(run(), [{ key: 'extra-1', kind: 'tool_call', text: '{}' }, { key: 'extra-2', kind: 'tool_call', text: '{}' }]);
  assert.equal(over.truncated, true);
  assert.equal(over.entries.length, 1);
  assert.equal(over.entries[0].kind, 'note');
  assert.equal(run().truncated, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM subagent_timeline WHERE run_id = ?`).get(RUN).n, SUBAGENT_TIMELINE_MAX_ENTRIES + 1);
  assert.ok(db.prepare(`SELECT 1 FROM subagent_timeline WHERE run_id = ? AND entry_key = ?`).get(RUN, TRUNCATED_NOTE_KEY));
  // An entry already kept may still be updated.
  const update = service.applyEntries(run(), [{ key: 'k5', kind: 'tool_call', text: '{"n":"five"}' }]);
  assert.equal(update.entries[0].text, '{"n":"five"}');
});

test('unknown kinds and entries without a key are not stored', () => {
  assert.equal(sanitizeTimelineEntry({ key: 'a', kind: 'shell', text: 'x' }), null);
  assert.equal(sanitizeTimelineEntry({ kind: 'text', text: 'x' }), null);
  assert.equal(sanitizeTimelineEntry(null), null);
});

test('a header patch fills the run, keeps what it does not name, and stamps the end once', () => {
  const { service, stmts } = makeFixture();
  service.applyHeader(RUN, sanitizeRunHeaderPatch({ model: 'claude-fixture-model', subagentType: 'general-purpose', background: true, timelineOwner: 'worker' }));
  service.applyHeader(RUN, sanitizeRunHeaderPatch({ totalTokens: 1234, timelineOwner: 'relay' }));
  let row = stmts.getSubagentRun.get(RUN);
  assert.equal(row.model, 'claude-fixture-model');
  assert.equal(row.subagent_type, 'general-purpose');
  assert.equal(row.total_tokens, 1234);
  assert.equal(row.background, 1);
  assert.equal(row.timeline_owner, 'worker', 'the owner is claimed once');
  assert.equal(row.completed_at, null);

  service.applyHeader(RUN, sanitizeRunHeaderPatch({ status: 'stopped' }));
  row = stmts.getSubagentRun.get(RUN);
  assert.equal(row.status, 'cancelled');
  assert.ok(row.completed_at);
  const header = mapSubagentRunHeader(row, { stoppable: false });
  assert.equal(header.background, true);
  assert.equal(header.totalTokens, 1234);
  assert.equal(header.subagentType, 'general-purpose');
});

test('an empty header patch is nothing to write', () => {
  assert.equal(sanitizeRunHeaderPatch({}), null);
  assert.equal(sanitizeRunHeaderPatch({ model: '  ', background: false }), null);
});

test('frames are mirrored for runs no worker writes itself, never for worker-owned ones', () => {
  const { service, stmts } = makeFixture();
  const mirrored = service.mirrorFrame({ runId: RUN, kind: 'thought', key: 'thought:r1', text: 'Plan the change', done: false });
  assert.equal(mirrored.entries[0].kind, 'thought');
  const again = service.mirrorFrame({ runId: RUN, kind: 'thought', key: 'thought:r1', text: 'Plan the change carefully', done: true });
  assert.equal(again.entries[0].seq, mirrored.entries[0].seq);

  service.applyHeader(RUN, sanitizeRunHeaderPatch({ timelineOwner: 'worker' }));
  assert.equal(service.mirrorFrame({ runId: RUN, kind: 'text', key: 'stream', text: 'hello' }), null);
  assert.equal(service.mirrorFrame({ runId: 'toolu_unknown', kind: 'text', key: 'stream', text: 'hello' }), null);
  assert.equal(stmts.countTimelineEntries.get(RUN).cnt, 1);
});

test('a run without timeline rows is served from what it recorded before, oldest first', () => {
  const { service, stmts, run } = makeFixture();
  stmts.insertThought.run('q-1', null, 'conv-1', 'agent', 'r-1', 1, 'Old thought', 1, '2026-10-10T10:00:03Z', RUN);
  stmts.insertActivity.run('q-1', null, 'conv-1', 'agent', 'Tool (Grep): widget', '2026-10-10T10:00:04Z', RUN, null);
  stmts.insertStreamEvent.run('q-1', null, 'conv-1', 'agent', 1, 'Old reply', 1, '2026-10-10T10:00:05Z', RUN);
  const page = service.readTimeline(run());
  assert.equal(page.run.legacy, true);
  assert.deepEqual(page.entries.map((entry) => [entry.seq, entry.kind, entry.text]), [
    [1, 'thought', 'Old thought'],
    [2, 'tool_call', 'Tool (Grep): widget'],
    [3, 'text', 'Old reply'],
  ]);
  assert.equal(page.entries[1].toolName, 'Grep');
});

test('child runs travel with their parent page', () => {
  const { service, stmts, run } = makeFixture();
  stmts.insertSubagentRun.run(CHILD, 'q-1', 'conv-1', RUN, 'Check the fixtures', 'running', '2026-10-10T10:00:06Z', '2026-10-10T10:00:06Z');
  const page = service.readTimeline(run(), { isStoppable: (row) => row.id === CHILD });
  assert.deepEqual(page.children.map((child) => [child.subagentRunId, child.displayName, child.stoppable]), [[CHILD, 'Check the fixtures', true]]);
  assert.equal(page.run.stoppable, false);
});

test('timeline rows go with their conversation', () => {
  const { db, service, run } = makeFixture();
  service.applyEntries(run(), [{ key: 'a', kind: 'text', text: 'x' }]);
  db.prepare(`DELETE FROM conversations WHERE id = 'conv-1'`).run();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM subagent_timeline`).get().n, 0);
});

test('run lists carry the header columns', () => {
  const { stmts, service } = makeFixture();
  service.applyHeader(RUN, sanitizeRunHeaderPatch({ model: 'claude-fixture-model' }));
  const [row] = stmts.listSubagentRunsByQueueMessage.all('q-1');
  assert.equal(row.model, 'claude-fixture-model');
  const [running] = stmts.listRunningSubagentRunsByQueueMessage.all('q-1');
  assert.equal(running.background, 0);
});
