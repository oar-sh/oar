import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { REMOTE_RELAY_ERROR_CODES as CODES } from '../../shared/remote-relay-contract.mjs';
import { RELAY_SCHEDULE_LIMITS, RELAY_SCHEDULE_MESSAGE_KIND } from '../../shared/relay-schedules.mjs';
import { executeRemoteRelayTool } from '../../shared/remote-relay-tool-core.mjs';
import { REMOTE_RELAY_LIMITS } from '../../shared/remote-relay-contract.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import { createRemoteRelayCallerContext, formatRemoteRelayApprovalPrompt } from './remote-relay-caller-context.mjs';
import { createRemoteRelayDispatcher } from './remote-relay-dispatcher.mjs';
import { createRelayScheduleService } from './relay-schedule-service.mjs';

// remote_relay schedule / list_schedules / unschedule through the dispatcher,
// on this relay's real schedule service (an in-memory database).

const CALLER = 'conv-fixture-caller';
const WORKER = 'conv-fixture-worker';
const READER = Object.freeze({ id: 'rr_reader', relayId: 'relay-reader-id', name: 'reader-test', url: 'https://relay-b.example.test', permission: 'read', lastStatus: 'online' });
const PROMPTER = Object.freeze({ id: 'rr_prompter', relayId: 'relay-prompter-id', name: 'prompter-test', url: 'https://relay-c.example.test', permission: 'prompt', lastStatus: 'online' });
// Locked here, but an agent there once wrote to these conversations: open by contact only.
const THIRD = Object.freeze({ id: 'rr_third', relayId: 'relay-third-id', name: 'third-test', url: 'https://relay-d.example.test', permission: 'full', lastStatus: 'online' });
const RELAYS = [READER, PROMPTER, THIRD];

function createRegistry() {
  return {
    list: () => RELAYS,
    resolve(name) {
      const relay = RELAYS.find((entry) => entry.name === String(name || '').replace(/^@/, '').toLowerCase());
      return relay ? { relay } : { error: 'unknown', names: RELAYS.map((entry) => entry.name) };
    },
    selfIdentity: () => ({ relayId: 'relay-self-id', name: 'win-test', version: '0.9.16', publicUrl: 'https://relay-a.example.test' }),
    selfName: () => 'win-test',
  };
}

function setup({ mode = 'agent', withService = true, approve = true, resolveConversationId = (id) => id, realCaller = false } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const at = new Date(Date.now() - 60_000).toISOString();
  for (const [id, title] of [[CALLER, 'Coordinator'], [WORKER, 'Night review']]) {
    db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(id, title, at, at);
  }
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  // The dispatcher's clock (its per-minute limits), moved by the tests.
  const clock = { now: Date.now() };
  // The id of the user's latest own message, per conversation: the loop guard counts from it.
  const humans = new Map();
  let dispatcher = null;
  const service = createRelayScheduleService({
    db,
    stmts,
    admitFiring: (entry) => dispatcher.admitScheduledFiring(entry),
    logger: { log() {}, warn() {} },
  });
  service.start();
  const approvals = [];
  const events = [];
  const remoteCalls = [];
  const callerContext = realCaller ? createRemoteRelayCallerContext({ db, repository: createRemoteRelayRepository(db), logger: { log() {}, warn() {} } }) : null;
  dispatcher = createRemoteRelayDispatcher({
    registry: createRegistry(),
    client: { request: async (...args) => { remoteCalls.push(args); return {}; } },
    localClient: { request: async () => ({}) },
    getAgentSessionsSettings: () => ({ enabled: true, maxWaitSeconds: 600 }),
    repository: {
      hasUnlock: (conversationId, relayId) => relayId === READER.id || relayId === PROMPTER.id,
      hasContactFrom: (conversationId, instanceId) => instanceId === THIRD.relayId,
      latestHumanMessageId: (conversationId) => humans.get(conversationId) || null,
    },
    getCallerContext: callerContext
      ? async (conversationId) => callerContext.getCallerContext(conversationId)
      : async (conversationId) => ({ conversationId, title: 'Coordinator', provider: 'claude', mode, processingRowId: 'q-1', hops: 0 }),
    requestApproval: async (request) => {
      approvals.push(request);
      return approve;
    },
    now: () => clock.now,
    emitStatusEvent: (event) => events.push(event),
    logger: { log() {}, warn() {} },
    resolveConversationId,
    ...(withService ? { relaySchedules: service } : {}),
  });
  const run = (action, args = {}, conversationId = CALLER) => dispatcher.dispatch({ conversationId, action, args });
  return { db, service, dispatcher, run, approvals, events, remoteCalls, clock, humans };
}

/** Make a schedule due now and let it come due. */
function fireNow(db, service, scheduleId) {
  db.prepare(`UPDATE relay_schedules SET next_fire_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), scheduleId);
  return service.fireIfDue(scheduleId);
}

function scheduledMessages(db, conversationId) {
  return db.prepare(`SELECT id, text, origin_json FROM messages WHERE conversation_id = ? AND kind = ? ORDER BY timestamp ASC, rowid ASC`)
    .all(conversationId, RELAY_SCHEDULE_MESSAGE_KIND);
}

test('schedule for the own conversation: relay "this" by default, no card even in ask mode, listed and ended', async () => {
  const { run, approvals, events, service } = setup({ mode: 'ask' });
  const created = await run('schedule', { text: 'Run the sweep.', every_minutes: 30, title: 'Sweep' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.relay, 'win-test');
  assert.match(created.body.schedule_id, /^sch_[0-9a-f]{12}$/);
  assert.equal(created.body.schedule.session.id, CALLER);
  assert.equal(created.body.schedule.everyMinutes, 30);
  assert.equal(created.body.schedule.once, false);
  assert.match(created.body.summary, /^schedule → win-test: every 30 min, next .* \(sch_/);
  assert.match(created.body.note, /"\[relay schedule"; .* approves nothing/);
  assert.equal(approvals.length, 0, 'scheduling itself asks nobody');
  assert.equal(events.length, 0, 'not a write');

  const listed = await run('list_schedules');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.schedules.map((schedule) => schedule.id), [created.body.schedule_id]);
  assert.match(listed.body.summary, /: 1 active$/);

  const ended = await run('unschedule', { schedule_id: created.body.schedule_id });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.schedule.endReason, 'unscheduled');
  assert.deepEqual(service.listActive(), []);
  const again = await run('list_schedules');
  assert.match(again.body.note, /ended within the last hour/);
});

test('a schedule for another session is a write: the card in ask mode names when and what, a No creates nothing', async () => {
  const denied = setup({ mode: 'ask', approve: false });
  const refused = await denied.run('schedule', { session: WORKER, text: 'Review the night\'s runs.', every_minutes: 1440, title: 'Night review' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, CODES.approvalDenied);
  assert.equal(denied.approvals.length, 1);
  assert.equal(denied.approvals[0].action, 'schedule');
  assert.equal(denied.service.listActive().length, 0);
  const card = formatRemoteRelayApprovalPrompt({ relay: denied.approvals[0].relay, action: 'schedule', args: denied.approvals[0].args });
  assert.match(card, /^Allow the agent to schedule a prompt on this relay \(session conv-fix\)\?/);
  assert.match(card, /“Night review” · Every 1440 min/);
  assert.match(card, /“Review the night's runs\.”/);

  const allowed = setup({ mode: 'ask' });
  const created = await allowed.run('schedule', { session: WORKER, text: 'Review.', every_minutes: 60 });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(created.body.schedule.setBy, { id: CALLER, title: 'Coordinator' });
  assert.match(created.body.summary, /^schedule → win-test session conv-fix: every 60 min/);
  // The other side lists it too, and may end it.
  const theirs = await allowed.run('list_schedules', {}, WORKER);
  assert.deepEqual(theirs.body.schedules.map((schedule) => schedule.id), [created.body.schedule_id]);
  // In agent mode there is no card, but the write is audited.
  const agentMode = setup();
  assert.equal((await agentMode.run('schedule', { session: WORKER, text: 'x', every_minutes: 5 })).status, 200);
  assert.equal(agentMode.approvals.length, 0);
  assert.equal(agentMode.events.at(-1).action, 'schedule');
  assert.equal(agentMode.events.at(-1).ok, true);
});

test('naming the own conversation as session is still the own schedule', async () => {
  const { run, approvals } = setup({ mode: 'plan' });
  const created = await run('schedule', { session: CALLER, text: 'Me.', at: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.schedule.once, true);
  assert.equal(created.body.schedule.setBy, undefined);
  assert.equal(approvals.length, 0);
});

test('a session named by its SDK session id is the conversation it belongs to', async () => {
  const ids = { 'sdk-fixture-worker': WORKER, 'sdk-fixture-caller': CALLER };
  const { run, approvals } = setup({ mode: 'ask', resolveConversationId: (id) => ids[id] || id });
  const other = await run('schedule', { session: 'sdk-fixture-worker', text: 'x', every_minutes: 5 });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.equal(other.body.schedule.session.id, WORKER);
  assert.equal(approvals.length, 1);
  const own = await run('schedule', { session: 'sdk-fixture-caller', text: 'y', every_minutes: 5 });
  assert.equal(own.body.schedule.session.id, CALLER);
  assert.equal(approvals.length, 1, 'its own conversation asks nobody');
});

test('refusals: unknown session, another conversation\'s schedule, the cap, a paired relay, no service', async () => {
  const { run, service, remoteCalls } = setup();
  const missing = await run('schedule', { session: 'conv-fixture-missing', text: 'x', every_minutes: 5 });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, CODES.notFound);

  const theirs = service.create({ conversationId: WORKER, createdBy: WORKER, text: 'mine', everyMinutes: 5 });
  const notMine = await run('unschedule', { schedule_id: theirs.id });
  assert.equal(notMine.status, 404);
  assert.equal(service.get(theirs.id).endedAt, undefined);

  for (let i = 0; i < RELAY_SCHEDULE_LIMITS.perConversation; i += 1) {
    service.create({ conversationId: CALLER, createdBy: CALLER, text: `t${i}`, everyMinutes: 5 });
  }
  const capped = await run('schedule', { text: 'one more', every_minutes: 5 });
  assert.equal(capped.status, 409);
  assert.equal(capped.body.code, CODES.scheduleLimit);

  // A paired relay keeps its own: refused before anything is sent there.
  const paired = await run('schedule', { relay: 'prompter-test', text: 'x', every_minutes: 5 });
  assert.equal(paired.status, 400);
  assert.equal(paired.body.code, CODES.unsupported);
  assert.match(paired.body.error, /use relay "this"/);
  // A paired relay that only lets agents read: a schedule for another session needs "prompt".
  const reader = await run('schedule', { relay: 'reader-test', session: 'conv-remote', text: 'x', every_minutes: 5 });
  assert.equal(reader.status, 403);
  assert.equal(reader.body.code, CODES.forbidden);
  assert.match(reader.body.error, /schedule needs "prompt"/);
  assert.equal(remoteCalls.length, 0);

  const bare = setup({ withService: false });
  const off = await bare.run('list_schedules');
  assert.equal(off.status, 503);
  assert.equal(off.body.code, CODES.unsupported);
});

test('through the worker\'s tool: the checked arguments pass the relay\'s check again and the prompt fires later', async () => {
  const { dispatcher, db, service } = setup();
  const result = await executeRemoteRelayTool({ action: 'schedule', text: 'Health check.', every_minutes: 5, once: true, title: 'Health' }, {
    conversationId: CALLER,
    api: async (_method, _path, body) => (await dispatcher.dispatch(body)).body,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.schedule.once, true);
  // Due: it fires into the conversation as the relay's message.
  db.prepare(`UPDATE relay_schedules SET next_fire_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), result.schedule_id);
  assert.equal(service.fireIfDue(result.schedule_id).fired, true);
  const message = db.prepare(`SELECT text FROM messages WHERE conversation_id = ? AND kind = ?`).get(CALLER, RELAY_SCHEDULE_MESSAGE_KIND);
  assert.match(message.text, new RegExp(`^\\[relay schedule ${result.schedule_id} "Health" · automated message from OAR`));
});

test('the loop guard counts a schedule into another session like a send: past the limit the user is asked', async () => {
  const limit = REMOTE_RELAY_LIMITS.agentPromptsBeforeAsking;
  const denied = setup({ approve: false });
  const soon = () => new Date(Date.now() + 3_600_000).toISOString();
  for (let i = 0; i < limit; i += 1) {
    const made = await denied.run('schedule', { session: WORKER, text: `check ${i}`, at: soon() });
    assert.equal(made.status, 200, `${i}: ${JSON.stringify(made.body)}`);
    // Ended again so the per-conversation cap stays out of the way; that is no prompt.
    assert.equal((await denied.run('unschedule', { schedule_id: made.body.schedule_id })).status, 200);
    denied.clock.now += 7_000; // under the write limit per minute
  }
  assert.equal(denied.approvals.length, 0, 'no card while under the limit');
  const refused = await denied.run('schedule', { session: WORKER, text: 'one more', at: soon() });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, CODES.approvalDenied);
  assert.equal(denied.approvals.length, 1);
  assert.equal(denied.approvals[0].agentPrompts, limit);
  assert.equal(denied.approvals[0].action, 'schedule');
  assert.equal(denied.service.listActive().length, 0, 'nothing was scheduled');
  // Its own conversation prompts nobody else: never counted, never asked.
  assert.equal((await denied.run('schedule', { text: 'mine', at: soon() })).status, 200);
  assert.equal(denied.approvals.length, 1);

  // Allowed on the card: the count starts again.
  const allowed = setup();
  for (let i = 0; i < limit; i += 1) {
    const made = await allowed.run('schedule', { session: WORKER, text: `check ${i}`, at: soon() });
    await allowed.run('unschedule', { schedule_id: made.body.schedule_id });
    allowed.clock.now += 7_000;
  }
  assert.equal((await allowed.run('schedule', { session: WORKER, text: 'asked', at: soon() })).status, 200);
  assert.equal(allowed.approvals.length, 1);
});

test('each firing into another session counts for the conversation that set it; past the limit it is held until the user writes', async () => {
  const { run, db, service, dispatcher, humans } = setup();
  const limit = REMOTE_RELAY_LIMITS.agentPromptsBeforeAsking;
  const made = await run('schedule', { session: WORKER, text: 'Check in.', every_minutes: 5 });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.match(made.body.note, /counts as one of your prompts to other agents/);
  // Setting it was the first prompt; every firing is one more.
  assert.equal(fireNow(db, service, made.body.schedule_id).fired, true);
  for (let i = 2; i < limit; i += 1) assert.equal(dispatcher.admitScheduledFiring({ createdBy: CALLER }), true);
  db.prepare(`UPDATE queue SET status = 'done'`).run();
  assert.equal(scheduledMessages(db, WORKER).length, 1);

  // The limit is reached: the firing is held, nothing is queued.
  const held = fireNow(db, service, made.body.schedule_id);
  assert.equal(held.held, true);
  assert.equal(held.fired, false);
  assert.equal(scheduledMessages(db, WORKER).length, 1);
  assert.equal(service.get(made.body.schedule_id).heldForApproval, true);
  const listed = await run('list_schedules');
  assert.equal(listed.body.schedules[0].heldForApproval, true);
  // Another conversation's own schedules are not held by it.
  const theirs = service.create({ conversationId: WORKER, createdBy: WORKER, text: 'own', everyMinutes: 5 });
  assert.equal(fireNow(db, service, theirs.id).fired, true);
  assert.equal(service.fireIfDue(made.body.schedule_id).held, true, 'still held');

  // The user writes in the conversation that set it: it goes, once.
  humans.set(CALLER, 'm-user-wrote');
  const went = service.fireIfDue(made.body.schedule_id);
  assert.equal(went.fired, true);
  assert.equal(service.get(made.body.schedule_id).heldForApproval, undefined);
  assert.equal(scheduledMessages(db, WORKER).length, 3);
});

test('a schedule set by a turn acting on a hop-2 prompt passes the hops on: the fired turn cannot reach a third relay', async () => {
  const { run, db, service } = setup({ realCaller: true });
  const at = new Date(Date.now() - 30_000).toISOString();
  // The coordinator acts on a prompt that crossed two relays already.
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp, origin_json) VALUES ('m-hop2', ?, 'user', 'go on', ?, ?)`)
    .run(CALLER, at, JSON.stringify({ kind: 'agent', relayId: PROMPTER.relayId, relayName: PROMPTER.name, conversationId: 'conv-remote', hops: 2 }));
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, processing_at) VALUES ('m-hop2', ?, 'go on', 'processing', ?, ?)`).run(CALLER, at, at);
  const own = await run('schedule', { text: 'Carry on.', every_minutes: 5 });
  const other = await run('schedule', { session: WORKER, text: 'Look.', every_minutes: 5 });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(other.status, 200, JSON.stringify(other.body));
  db.prepare(`UPDATE queue SET status = 'done' WHERE id = 'm-hop2'`).run();

  assert.equal(fireNow(db, service, own.body.schedule_id).fired, true);
  assert.equal(fireNow(db, service, other.body.schedule_id).fired, true);
  const [ownMessage] = scheduledMessages(db, CALLER);
  const [otherMessage] = scheduledMessages(db, WORKER);
  assert.equal(JSON.parse(ownMessage.origin_json).hops, 2, 'the own schedule carries the prompt it acted on');
  assert.equal(JSON.parse(ownMessage.origin_json).relayId, PROMPTER.relayId);
  assert.equal(JSON.parse(otherMessage.origin_json).hops, 2, 'the other session gets what a send would carry');
  assert.equal(JSON.parse(otherMessage.origin_json).local, true);

  // The fired turns run: neither may pass a prompt on to a third relay.
  const fresh = new Date().toISOString();
  for (const [conversationId, message] of [[CALLER, ownMessage], [WORKER, otherMessage]]) {
    db.prepare(`UPDATE queue SET status = 'processing', processing_at = ? WHERE id = ?`).run(fresh, message.id);
    const refused = await run('send', { relay: THIRD.name, session: 'conv-far', text: 'pass it on', wait_seconds: 0 }, conversationId);
    assert.equal(refused.status, 403, `${conversationId}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, CODES.hopLimit);
  }
});

test('a schedule set on the user\'s own words carries no provenance', async () => {
  const { run, db, service } = setup({ realCaller: true });
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m-own', ?, 'user', 'set it up', ?)`).run(CALLER, new Date().toISOString());
  const own = await run('schedule', { text: 'Sweep.', every_minutes: 5 });
  assert.equal(fireNow(db, service, own.body.schedule_id).fired, true);
  assert.equal(scheduledMessages(db, CALLER)[0].origin_json, null);
});
