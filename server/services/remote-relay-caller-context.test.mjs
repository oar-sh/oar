import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { REMOTE_RELAY_ERROR_CODES as CODES } from '../../shared/remote-relay-contract.mjs';
import { DEFAULT_QUESTION_TIMEOUT_MS } from '../../shared/question-timeout.mjs';
import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import {
  createRemoteRelayCallerContext,
  formatRemoteRelayApprovalPrompt,
} from './remote-relay-caller-context.mjs';

const T0 = '2026-09-20T10:00:00.000Z';
const RELAY = Object.freeze({ id: 'rr_linux', name: 'linux-test', url: 'https://relay-b.example.test' });

function setup({ onSleep, ...options } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const repository = createRemoteRelayRepository(db);
  const emitted = [];
  const pushed = [];
  const logs = [];
  let sleeps = 0;
  let uuidCounter = 0;
  const context = createRemoteRelayCallerContext({
    db,
    repository,
    emit: (event, payload) => emitted.push({ event, payload }),
    notifyQuestion: (question) => pushed.push(question),
    uuid: () => `question-${++uuidCounter}`,
    now: () => new Date(T0),
    sleep: async () => {
      sleeps += 1;
      onSleep?.(sleeps);
    },
    logger: { log: (line) => logs.push(line), warn: (line) => logs.push(line) },
    ...options,
  });
  return { db, repository, context, emitted, pushed, logs, sleeps: () => sleeps };
}

function seedConversation(db, {
  id = 'c-1',
  title = 'report builder',
  preferredMode = 'ask',
  provider = 'claude',
  providerModel = 'claude-sonnet-5',
  preferredEffort = null,
} = {}) {
  db.prepare(`
    INSERT INTO conversations (id, title, preferred_relay_mode, preferred_reasoning_effort, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, title, preferredMode, preferredEffort, T0, T0);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, provider_model, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`rs-${id}`, id, `sdk-${id}`, `key-${id}`, providerModel, provider, providerModel, T0, T0);
}

function seedTurn(db, {
  id,
  conversationId = 'c-1',
  status = 'processing',
  mode = 'plan',
  model = 'claude-sonnet-5[1m]',
  processingAt = '2026-09-20T09:59:00.000Z',
  attemptId = `attempt-${id}`,
  owner = 'sdk-c-1',
  text = 'please check linux-test',
  effort = null,
} = {}) {
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, ?, 'user', ?, ?)`)
    .run(id, conversationId, text, processingAt);
  db.prepare(`
    INSERT INTO queue (id, conversation_id, model, reasoning_effort, relay_mode, text, status, timestamp, processing_at, owner_sdk_session_id, attempt_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, conversationId, model, effort, mode, text, status, processingAt, status === 'processing' ? processingAt : null, owner, attemptId);
}

/** A background continuation turn: a processing queue row with no user message behind it. */
function seedContinuation(db, { id, conversationId = 'c-1', at = '2026-09-20T09:58:00.000Z' } = {}) {
  db.prepare(`
    INSERT INTO queue (id, conversation_id, model, relay_mode, text, status, timestamp, processing_at, owner_sdk_session_id, attempt_id, kind)
    VALUES (?, ?, 'claude-sonnet-5', 'agent', '[background continuation]', 'processing', ?, ?, 'sdk-c-1', ?, 'continuation')
  `).run(id, conversationId, at, at, `attempt-${id}`);
}

function questionRow(db, id) {
  return db.prepare(`SELECT * FROM relay_questions WHERE id = ?`).get(id);
}

// ─── getCallerContext ────────────────────────────────────────────────────────

test('the caller context comes from the live turn, the runtime binding and the conversation', () => {
  const { db, context } = setup();
  seedConversation(db);
  seedTurn(db, { id: 'q-1' });
  assert.deepEqual(context.getCallerContext('c-1'), {
    conversationId: 'c-1',
    title: 'report builder',
    provider: 'claude',
    model: 'claude-sonnet-5[1m]',
    effort: '',
    mode: 'plan',
    processingRowId: 'q-1',
    attemptId: 'attempt-q-1',
    userMessageId: 'q-1',
    hops: 0,
    originRelayIds: [],
  });
});

test('the effort is the live turn\'s, else the one the conversation prefers', () => {
  const live = setup();
  seedConversation(live.db, { preferredEffort: 'low' });
  seedTurn(live.db, { id: 'q-1', effort: 'XHigh' });
  assert.equal(live.context.getCallerContext('c-1').effort, 'xhigh', 'the turn in flight decides');

  const continued = setup();
  seedConversation(continued.db, { preferredEffort: 'medium' });
  seedContinuation(continued.db, { id: 'q-cont' });
  assert.equal(continued.context.getCallerContext('c-1').effort, 'medium', 'a turn without an effort of its own');

  const offTurn = setup();
  seedConversation(offTurn.db, { preferredEffort: 'ultracode' });
  seedTurn(offTurn.db, { id: 'q-old', status: 'done', effort: 'high' });
  assert.equal(offTurn.context.getCallerContext('c-1').effort, 'ultracode', 'a finished turn says nothing about the next');

  const unknown = setup();
  seedConversation(unknown.db);
  assert.equal(unknown.context.getCallerContext('c-1').effort, '');
  assert.equal(unknown.context.getCallerContext('c-missing').effort, '');
});

test('hops come from the origin of the message behind the turn, the highest of a steered pair', () => {
  const { db, repository, context } = setup();
  seedConversation(db);
  seedTurn(db, { id: 'q-1' });
  repository.setMessageOrigin('q-1', { relayId: 'relay-a', relayName: 'win-test', hops: 1 });
  assert.equal(context.getCallerContext('c-1').hops, 1);

  seedTurn(db, { id: 'q-2', processingAt: '2026-09-20T09:59:30.000Z' });
  repository.setMessageOrigin('q-2', { relayId: 'relay-a', relayName: 'win-test', hops: 2 });
  const caller = context.getCallerContext('c-1');
  assert.equal(caller.processingRowId, 'q-1', 'without output the oldest processing row is the live turn');
  assert.equal(caller.hops, 2, 'a folded agent prompt counts too');
  assert.deepEqual(caller.originRelayIds, ['relay-a'], 'one relay, named once');
});

test('the relays a turn\'s prompts came from are named: none for the user\'s own words', () => {
  const { db, repository, context } = setup();
  seedConversation(db);
  seedTurn(db, { id: 'q-1' });
  assert.deepEqual(context.getCallerContext('c-1').originRelayIds, []);

  // An agent's prompt folded into the user's turn, then one from another relay.
  seedTurn(db, { id: 'q-2', processingAt: '2026-09-20T09:59:30.000Z' });
  repository.setMessageOrigin('q-2', { relayId: 'relay-a', relayName: 'win-test', hops: 1 });
  assert.deepEqual(context.getCallerContext('c-1').originRelayIds, ['relay-a']);
  seedTurn(db, { id: 'q-3', processingAt: '2026-09-20T09:59:40.000Z' });
  repository.setMessageOrigin('q-3', { relayId: 'relay-b', relayName: 'spare-test', hops: 2 });
  assert.deepEqual(context.getCallerContext('c-1').originRelayIds, ['relay-a', 'relay-b']);
});

test('a background continuation counts the hops of the turn it continues', () => {
  const { db, repository, context } = setup();
  seedConversation(db);
  // Another relay's agent started a turn here (hop 1); it left background work.
  seedTurn(db, { id: 'q-agent', status: 'done', processingAt: '2026-09-20T09:50:00.000Z' });
  repository.setMessageOrigin('q-agent', { relayId: 'relay-a', relayName: 'win-test', hops: 1 });
  seedContinuation(db, { id: 'q-cont', at: '2026-09-20T09:58:00.000Z' });
  const caller = context.getCallerContext('c-1');
  assert.equal(caller.processingRowId, 'q-cont');
  assert.equal(caller.hops, 1, 'the continuation does not reset the count to 0');

  // Messages queued after the continuation started do not change its count.
  seedTurn(db, { id: 'q-later', status: 'pending', processingAt: '2026-09-20T09:59:00.000Z' });
  repository.setMessageOrigin('q-later', { relayId: 'relay-a', relayName: 'win-test', hops: 2 });
  assert.equal(context.getCallerContext('c-1').hops, 1);

  // A human message before the continuation: it continues the human's turn.
  const human = setup();
  seedConversation(human.db);
  seedTurn(human.db, { id: 'q-agent', status: 'done', processingAt: '2026-09-20T09:50:00.000Z' });
  human.repository.setMessageOrigin('q-agent', { relayId: 'relay-a', relayName: 'win-test', hops: 1 });
  seedTurn(human.db, { id: 'q-human', status: 'done', processingAt: '2026-09-20T09:55:00.000Z' });
  seedContinuation(human.db, { id: 'q-cont', at: '2026-09-20T09:58:00.000Z' });
  assert.equal(human.context.getCallerContext('c-1').hops, 0);
});

test('an agent prompt queued behind a human turn does not count against that turn', () => {
  const { db, repository, context } = setup();
  seedConversation(db);
  seedTurn(db, { id: 'q-human' });
  seedTurn(db, { id: 'q-queued', status: 'pending', processingAt: '2026-09-20T09:59:30.000Z' });
  repository.setMessageOrigin('q-queued', { relayId: 'relay-a', relayName: 'win-test', hops: 2 });
  assert.equal(context.getCallerContext('c-1').hops, 0);
});

test('off-turn, the conversation preferences and the latest user message decide', () => {
  const { db, repository, context } = setup();
  seedConversation(db, { preferredMode: 'autopilot', provider: 'github', providerModel: '' });
  db.prepare(`UPDATE runtime_sessions SET model = 'gpt-5.6-luna' WHERE conversation_id = 'c-1'`).run();
  seedTurn(db, { id: 'q-old', status: 'done', processingAt: '2026-09-20T09:00:00.000Z' });
  repository.setMessageOrigin('q-old', { relayId: 'relay-a', relayName: 'win-test', hops: 1 });
  const caller = context.getCallerContext('c-1');
  assert.equal(caller.processingRowId, null);
  assert.equal(caller.userMessageId, null);
  assert.equal(caller.mode, 'autopilot');
  assert.equal(caller.provider, 'github');
  assert.equal(caller.model, 'gpt-5.6-luna');
  assert.equal(caller.hops, 1);

  const unknown = context.getCallerContext('c-missing');
  assert.equal(unknown.provider, 'github');
  assert.equal(unknown.mode, 'agent');
  assert.equal(unknown.hops, 0);
});

test('the live turn is the processing row with the newest output, or the runtime\'s pick', () => {
  const { db, context } = setup();
  seedConversation(db);
  seedTurn(db, { id: 'q-1', mode: 'plan' });
  seedTurn(db, { id: 'q-2', mode: 'agent', processingAt: '2026-09-20T09:59:30.000Z' });
  db.prepare(`
    INSERT INTO relay_stream_events (queue_message_id, conversation_id, relay_mode, seq, text, done, created_at)
    VALUES ('q-2', 'c-1', 'agent', 1, 'working', 0, '2026-09-20T09:59:50.000Z')
  `).run();
  const caller = context.getCallerContext('c-1');
  assert.equal(caller.processingRowId, 'q-2');
  assert.equal(caller.mode, 'agent');

  const injected = setup({ resolveLiveTurnQueueRow: () => ({ id: 'q-1' }) });
  seedConversation(injected.db);
  seedTurn(injected.db, { id: 'q-1' });
  seedTurn(injected.db, { id: 'q-2', processingAt: '2026-09-20T09:59:30.000Z' });
  assert.equal(injected.context.getCallerContext('c-1').processingRowId, 'q-1');
});

// ─── requestApproval ─────────────────────────────────────────────────────────

test('approval puts an Allow / Deny card on the calling turn and resolves on Allow', async () => {
  let harness;
  harness = setup({
    onSleep: () => {
      harness.db.prepare(`UPDATE relay_questions SET status = 'answered', answer = 'Allow' WHERE id = 'question-1'`).run();
    },
  });
  const { db, context, emitted, pushed, logs } = harness;
  seedConversation(db);
  seedTurn(db, { id: 'q-1' });
  const caller = context.getCallerContext('c-1');
  const result = await context.requestApproval({
    conversationId: 'c-1',
    callerContext: caller,
    relay: RELAY,
    action: 'send',
    args: { session: 'conv-remote-1', text: 'Rebuild the sidebar polish widgets' },
  });
  assert.deepEqual(result, { approved: true });

  const row = questionRow(db, 'question-1');
  assert.equal(row.queue_id, 'q-1');
  assert.equal(row.message_id, 'q-1');
  assert.equal(row.conversation_id, 'c-1');
  assert.equal(row.relay_mode, 'plan');
  assert.equal(row.sdk_session_id, 'sdk-c-1');
  assert.equal(row.attempt_id, 'attempt-q-1');
  assert.equal(row.owner_worker_id, null);
  assert.deepEqual(JSON.parse(row.choices), ['Allow', 'Deny']);
  assert.equal(row.prompt, 'Allow the agent to send a prompt on relay "linux-test" (session conv-rem)?\n\nMode: plan\n\n“Rebuild the sidebar polish widgets”');
  const envelope = JSON.parse(row.request);
  assert.equal(envelope.allowFreeform, false);
  assert.equal(envelope.context.header, 'Remote relay');
  assert.equal(envelope.context.source, 'remote_relay');
  assert.equal(envelope.context.queueMessageId, 'q-1');
  assert.equal(envelope.context.relayMode, 'plan');
  assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), DEFAULT_QUESTION_TIMEOUT_MS);

  assert.equal(emitted[0].event, 'relay_question');
  assert.equal(emitted[0].payload.question.id, 'question-1');
  assert.equal(pushed.length, 1);
  assert.match(logs[0], /approval question conv=c-1 send linux-test/);
  assert.ok(!logs.join('\n').includes('sidebar polish widgets'), 'the prompt text stays out of the log');
});

test('a pending approval card exempts the turn from stale recovery', async () => {
  let harness;
  let listedWhilePending;
  const stale = { inactiveBefore: '2026-09-20T11:00:00.000Z', ceilingBefore: null };
  harness = setup({
    onSleep: () => {
      listedWhilePending = createMessageRepository(harness.db).listRecoverableProcessing.all(stale).map((row) => row.id);
      harness.db.prepare(`UPDATE relay_questions SET status = 'answered', answer = 'Deny' WHERE id = 'question-1'`).run();
    },
  });
  seedConversation(harness.db);
  seedTurn(harness.db, { id: 'q-1' });
  const messages = createMessageRepository(harness.db);
  assert.deepEqual(messages.listRecoverableProcessing.all(stale).map((row) => row.id), ['q-1']);
  const result = await harness.context.requestApproval({
    conversationId: 'c-1',
    callerContext: harness.context.getCallerContext('c-1'),
    relay: RELAY,
    action: 'stop',
    args: { session: 'conv-remote-1' },
  });
  assert.deepEqual(listedWhilePending, [], 'not recoverable while the card is open');
  assert.deepEqual(result, { approved: false }, 'Deny');
});

test('a timed-out or cancelled card denies, and so does any answer but Allow', async () => {
  for (const [status, answer, pattern] of [
    ['timed_out', null, /timed out/],
    ['cancelled', null, /cancelled/],
    ['answered', 'allow it I guess', null],
  ]) {
    let harness;
    harness = setup({
      onSleep: () => {
        harness.db.prepare(`UPDATE relay_questions SET status = ?, answer = ? WHERE id = 'question-1'`).run(status, answer);
      },
    });
    seedConversation(harness.db);
    seedTurn(harness.db, { id: 'q-1' });
    const result = await harness.context.requestApproval({
      conversationId: 'c-1',
      callerContext: harness.context.getCallerContext('c-1'),
      relay: RELAY,
      action: 'archive',
      args: { session: 'conv-remote-1' },
    });
    assert.equal(result.approved, false, status);
    if (pattern) assert.match(result.error, pattern);
  }
});

test('without a running turn the approval fails closed and creates no card', async () => {
  const { db, context } = setup();
  seedConversation(db);
  const offTurn = await context.requestApproval({
    conversationId: 'c-1',
    callerContext: context.getCallerContext('c-1'),
    relay: RELAY,
    action: 'send',
    args: { session: 'conv-remote-1', text: 'hi' },
  });
  assert.equal(offTurn.approved, false);
  assert.equal(offTurn.code, CODES.noTurn);

  seedTurn(db, { id: 'q-done', status: 'done' });
  const finished = await context.requestApproval({
    conversationId: 'c-1',
    callerContext: { processingRowId: 'q-done' },
    relay: RELAY,
    action: 'send',
    args: {},
  });
  assert.equal(finished.code, CODES.noTurn, 'a row that is no longer processing is not a turn');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM relay_questions`).get().n, 0);
});

test('an abandoned tool call withdraws its card', async () => {
  const controller = new AbortController();
  let harness;
  harness = setup({ onSleep: () => controller.abort() });
  seedConversation(harness.db);
  seedTurn(harness.db, { id: 'q-1' });
  const result = await harness.context.requestApproval({
    conversationId: 'c-1',
    callerContext: harness.context.getCallerContext('c-1'),
    relay: RELAY,
    action: 'create_session',
    args: { text: 'Start the report builder' },
    signal: controller.signal,
  });
  assert.equal(result.approved, false);
  assert.equal(questionRow(harness.db, 'question-1').status, 'timed_out');
  assert.equal(harness.emitted.at(-1).event, 'relay_question_updated');
  assert.equal(harness.emitted.at(-1).payload.question.status, 'timed_out');
});

test('the card text names the action, the relay and what would be sent', () => {
  assert.equal(
    formatRemoteRelayApprovalPrompt({ relay: RELAY, action: 'answer_question', args: { choices: ['Dark'], answer: 'and hurry' } }),
    'Allow the agent to answer a question on relay "linux-test"?\n\nAnswer: “Dark, and hurry”',
  );
  assert.equal(
    formatRemoteRelayApprovalPrompt({ relay: RELAY, action: 'stop', args: { session: 'abcdef123456' } }),
    'Allow the agent to stop the running turn on relay "linux-test" (session abcdef12)?',
  );
  assert.equal(
    formatRemoteRelayApprovalPrompt({ relay: RELAY, action: 'stop', args: {}, agentPrompts: 30 }),
    'The agent has sent 30 prompts to agents on other relays since your last message. Let it go on?\n\n'
      + 'Allow the agent to stop the running turn on relay "linux-test"?',
  );
  const long = formatRemoteRelayApprovalPrompt({ relay: RELAY, action: 'create_session', args: { text: 'w'.repeat(500) } });
  assert.ok(long.includes(`“${'w'.repeat(199)}…”`), 'the first 200 characters');
});

test('the card says how the remote turn would run: mode, provider, model and folder', () => {
  const caller = { mode: 'plan', provider: 'claude', model: 'claude-sonnet-5' };
  assert.equal(
    formatRemoteRelayApprovalPrompt({
      relay: RELAY,
      action: 'create_session',
      args: { text: 'Build the export', provider: 'openai', model: 'gpt-4o', mode: 'autopilot', cwd: '/home/dev/other' },
      caller,
    }),
    'Allow the agent to start a new session on relay "linux-test"?\n\n'
      + 'Mode: autopilot · Provider: openai · Model: gpt-4o · Folder: /home/dev/other\n\n'
      + '“Build the export”',
  );
  assert.equal(
    formatRemoteRelayApprovalPrompt({ relay: RELAY, action: 'create_session', args: { text: 'Build the export' }, caller }),
    'Allow the agent to start a new session on relay "linux-test"?\n\nMode: plan · Provider: claude\n\n“Build the export”',
    'the defaults the dispatcher applies: the caller\'s mode and provider',
  );
  assert.match(
    formatRemoteRelayApprovalPrompt({ relay: RELAY, action: 'create_session', args: { text: 'x' }, caller: { provider: 'copilot-ish' } }),
    /\n\nProvider: github\n\n/,
    'an unknown caller provider falls back like the dispatcher does',
  );
  assert.equal(
    formatRemoteRelayApprovalPrompt({ relay: RELAY, action: 'send', args: { session: 'conv-remote-1', text: 'Run it', mode: 'autopilot', model: 'claude-opus-5' }, caller }),
    'Allow the agent to send a prompt on relay "linux-test" (session conv-rem)?\n\nMode: autopilot · Model: claude-opus-5\n\n“Run it”',
  );
  assert.equal(
    formatRemoteRelayApprovalPrompt({ relay: RELAY, action: 'stop', args: { session: 'abcdef123456', mode: 'autopilot' }, caller }),
    'Allow the agent to stop the running turn on relay "linux-test" (session abcdef12)?',
    'no turn details for actions that start no turn',
  );
});
