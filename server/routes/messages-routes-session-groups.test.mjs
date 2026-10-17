import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import { makeRouteDeps as baseRouteDeps, captureRoutes, invokeRoute } from './messages-routes-test-harness.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import { createConversationGroupRepository } from '../repositories/conversation-group-repository.mjs';
import { applySchema } from '../db-schema.mjs';

// "Stop all running" on a session group: one abort_turn control per member
// with a live turn, a stop for every stoppable background task, the
// unstoppable ones listed; the single cancel-turn route keeps working on
// the same code. Against the REAL schema. Titles are fictional.

const NOW = '2026-10-13T10:00:00.000Z';
const agentHeaders = { 'x-oar-remote-origin': 'relay-id-win', 'x-oar-remote-hops': '1' };

function boot() {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = {
    ...createSessionRepository(db),
    ...createMessageRepository(db),
    ...createQuestionRepository(db),
  };
  const insertConversation = db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`);
  const insertRuntime = db.prepare(`INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, status, created_at, last_used_at) VALUES (?, ?, ?, 'isolated', ?, 'gpt-5.4-mini', 'active', ?, ?)`);
  const conversation = (id, title) => {
    insertConversation.run(id, title, id, NOW, NOW);
    insertRuntime.run(`rs-${id}`, id, id, `runtime-key-${id}`, NOW, NOW);
  };
  conversation('conv-lead', 'Release lead');
  conversation('conv-busy', 'Tests pass');
  conversation('conv-idle', 'Docs pass');
  conversation('conv-tasks', 'Build pass');
  conversation('conv-alone', 'Lone chat');
  // A live turn in one member, owned by its worker.
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, owner_sdk_session_id) VALUES ('q-busy', 'conv-busy', 'run the tests', 'processing', ?, 'conv-busy')`).run(NOW);
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, owner_sdk_session_id) VALUES ('q-alone', 'conv-alone', 'unrelated', 'processing', ?, 'conv-alone')`).run(NOW);
  const conversationGroups = createConversationGroupRepository(db);
  const group = conversationGroups.createGroup({ parentConversationId: 'conv-lead', conversationIds: ['conv-busy', 'conv-idle', 'conv-tasks'] }, NOW);
  const repository = createRemoteRelayRepository(db);
  const remoteRelayInbound = {
    repository,
    listRelays: () => [],
    selfNames: () => ['linux-test'],
    inboundEnabled: () => true,
    recordUnlock: () => false,
    describeRelay: () => null,
  };
  const controls = [];
  // The runtime's store shape: what the publish route keeps per key.
  const tasksByKey = new Map();
  const backgroundTaskStore = {
    replace: (key, tasks) => { tasksByKey.set(String(key), Array.isArray(tasks) ? tasks : []); },
    get: (key) => tasksByKey.get(String(key)) || [],
  };
  const fx = { sendWorkerControlResult: true };
  const deps = baseRouteDeps({
    db,
    stmts,
    io: { emit() {}, volatile: { emit() {} } },
    uuidv4: () => crypto.randomUUID(),
    ts: () => NOW,
    ensureSessionId: () => 'client-1',
    DEFAULT_RELAY_MODE: 'agent',
    configuredConversationSessionMode: 'isolated',
    collectReferenceAttachmentsFromText: () => ({ attachments: [], skipped: 0 }),
    attachmentSummary: () => '',
    parseAttachments: () => [],
    hydrateAttachment: (value) => value,
    linkUploadReferences: () => {},
    maybeApplyWorkspaceRootFromMessage: () => ({ attempted: false, changed: false }),
    ensureRuntimeSessionBinding: (conversationId) => stmts.getRuntimeSessionByConversation.get(conversationId) || null,
    getOrCreateConversation: (id) => stmts.getConv.get(id),
    workspaceRootPayload: () => ({}),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0 }),
    emitToClientsExceptSessionId: () => {},
    sanitizeActivityText: (value) => String(value || '').trim(),
    relayActivityForResponse: () => [],
    addMsIso: (ms) => new Date(Date.now() + Math.max(0, Number(ms) || 0)).toISOString(),
    computeRetryDelayMs: () => 0,
    relayBridgeOwnerService: { normalizeIdentity: ({ sessionId } = {}) => (sessionId ? { sessionId: String(sessionId) } : null) },
    runtimeState: { featureFlags: {} },
    backgroundTaskStore,
    sendWorkerControl: (sessionId, control) => { controls.push([sessionId, control]); return fx.sendWorkerControlResult; },
    remoteRelayInbound,
    conversationGroups,
  });
  const routes = captureRoutes(deps);
  const post = (routePath, body = {}, { headers = {}, params = {} } = {}) => invokeRoute(routes, 'POST', routePath, { body, headers, params });
  const controlRows = () => db.prepare(`SELECT conversation_id, queue_message_id, type FROM relay_control_requests ORDER BY conversation_id`).all();
  Object.assign(fx, { db, group, post, controls, controlRows, tasksByKey });
  return fx;
}

test('stop all running: a turn stop per live turn, a stop per stoppable task, the rest listed', async () => {
  const fx = boot();
  // The tasks arrive as a worker publishes them, through the same route.
  const published = await fx.post('/api/background-tasks', {
    conversationId: 'conv-tasks',
    tasks: [
      { taskId: 'task-shell', taskType: 'shell', description: 'npm test', startedAt: Date.now() },
      { taskId: 'task-detached', taskType: 'shell', description: 'tail -f', startedAt: Date.now(), stoppable: false },
    ],
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.deepEqual(fx.tasksByKey.get('conv-tasks').map((task) => [task.taskId, task.stoppable]), [['task-shell', true], ['task-detached', false]]);
  const stopped = await fx.post('/api/conversation-groups/:id/stop', { clientId: 'client-1' }, { params: { id: fx.group.id } });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.deepEqual(stopped.body.turns, [{ id: 'conv-busy', messageId: 'q-busy' }]);
  assert.deepEqual(stopped.body.tasks, [{ id: 'conv-tasks', taskId: 'task-shell' }]);
  assert.deepEqual(stopped.body.unstoppable, [{ id: 'conv-tasks', taskId: 'task-detached', reason: 'no-stop' }]);
  assert.deepEqual(fx.controls, [['conv-tasks', { type: 'stop_background_task', taskId: 'task-shell' }]]);
  // One abort control, for the member's turn only: the lone chat's turn is untouched.
  assert.deepEqual(fx.controlRows(), [{ conversation_id: 'conv-busy', queue_message_id: 'q-busy', type: 'abort_turn' }]);

  // A second call finds the stop already requested and adds nothing.
  const again = await fx.post('/api/conversation-groups/:id/stop', {}, { params: { id: fx.group.id } });
  assert.deepEqual(again.body.turns, [{ id: 'conv-busy', messageId: 'q-busy' }]);
  assert.equal(fx.controlRows().length, 1);
});

test('the single cancel-turn route still queues a stop, and the group stop refuses other relays and unknown groups', async () => {
  const fx = boot();
  const single = await fx.post('/api/conversation/:conversationId/cancel-turn', {}, { params: { conversationId: 'conv-alone' } });
  assert.equal(single.status, 200);
  assert.equal(single.body.acknowledgement, 'stop-queued');
  assert.equal(single.body.activeMessageId, 'q-alone');
  const idle = await fx.post('/api/conversation/:conversationId/cancel-turn', {}, { params: { conversationId: 'conv-idle' } });
  assert.equal(idle.body.acknowledgement, 'no-active-turn');
  const unknown = await fx.post('/api/conversation/:conversationId/cancel-turn', {}, { params: { conversationId: 'conv-missing' } });
  assert.equal(unknown.status, 404);

  const refused = await fx.post('/api/conversation-groups/:id/stop', {}, { params: { id: fx.group.id }, headers: agentHeaders });
  assert.equal(refused.status, 403);
  const missing = await fx.post('/api/conversation-groups/:id/stop', {}, { params: { id: 'grp_missing' } });
  assert.equal(missing.status, 404);
});

test('a task whose worker is not connected is listed under what could not be stopped', async () => {
  const fx = boot();
  fx.sendWorkerControlResult = false;
  await fx.post('/api/background-tasks', { conversationId: 'conv-tasks', tasks: [{ taskId: 'task-shell', taskType: 'shell', description: 'npm test', startedAt: Date.now() }] });
  const stopped = await fx.post('/api/conversation-groups/:id/stop', {}, { params: { id: fx.group.id } });
  assert.deepEqual(stopped.body.tasks, []);
  assert.deepEqual(stopped.body.unstoppable, [{ id: 'conv-tasks', taskId: 'task-shell', reason: 'worker-not-connected' }]);
});
