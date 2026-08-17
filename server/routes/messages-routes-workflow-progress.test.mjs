import test from 'node:test';
import assert from 'node:assert/strict';

import { registerMessagesRoutes, sanitizeWorkflowProgress } from './messages-routes.mjs';

// Pins for the workflow-progress digest ingest (docs/plans/workflow-progress-tree.md,
// Phase 2): POST /api/background-tasks must pass a structurally sanitized
// workflowProgress through to the stored/broadcast row, and must never reject
// a publish because of the field — flat rows keep working untouched.

function validDigest() {
  return {
    runId: 'wf_d8a3315d-fd5',
    workflowName: 'review-and-verify',
    status: 'running',
    agentCount: 7,
    totalTokens: 321000,
    durationMs: 927637,
    phases: [
      { index: 0, title: 'Review' },
      { index: 1, title: 'Verify' },
    ],
    logs: ['4 raw findings from 3 reviewers, verifying each...'],
    agents: [
      {
        index: 0,
        label: 'review:edge-cases-data',
        phaseIndex: 0,
        phaseTitle: 'Review',
        model: 'claude-sonnet-5',
        state: 'done',
        attempt: 1,
        lastToolName: 'Read',
        tokens: 62200,
        toolCalls: 27,
        durationMs: 260000,
        startedAt: 1755400000000,
      },
      {
        index: 1,
        label: 'verify:finding-2',
        phaseIndex: 1,
        phaseTitle: 'Verify',
        model: null,
        state: 'running',
        attempt: null,
        lastToolName: null,
        tokens: null,
        toolCalls: null,
        durationMs: null,
        startedAt: null,
      },
    ],
    agentsOmitted: 0,
  };
}

test('sanitizeWorkflowProgress passes a valid digest through intact', () => {
  const digest = validDigest();
  assert.deepEqual(sanitizeWorkflowProgress(digest), digest);
});

test('sanitizeWorkflowProgress clamps oversized strings at every level', () => {
  const digest = validDigest();
  digest.runId = 'r'.repeat(500);
  digest.workflowName = ` ${'w'.repeat(500)} `;
  digest.status = 's'.repeat(500);
  digest.phases[0].title = 'p'.repeat(500);
  digest.logs = ['l'.repeat(5000)];
  digest.agents[0].label = 'a'.repeat(500);
  digest.agents[0].phaseTitle = 't'.repeat(500);
  digest.agents[0].model = 'm'.repeat(500);
  digest.agents[0].state = 'x'.repeat(500);
  digest.agents[0].lastToolName = 'n'.repeat(500);
  const out = sanitizeWorkflowProgress(digest);
  assert.equal(out.runId, 'r'.repeat(64));
  assert.equal(out.workflowName, 'w'.repeat(120));
  assert.equal(out.status, 's'.repeat(32));
  assert.equal(out.phases[0].title, 'p'.repeat(120));
  assert.equal(out.logs[0], 'l'.repeat(300));
  assert.equal(out.agents[0].label, 'a'.repeat(160));
  assert.equal(out.agents[0].phaseTitle, 't'.repeat(120));
  assert.equal(out.agents[0].model, 'm'.repeat(80));
  assert.equal(out.agents[0].state, 'x'.repeat(32));
  assert.equal(out.agents[0].lastToolName, 'n'.repeat(160));
});

test('sanitizeWorkflowProgress caps agents at 100 preserving order and counts the overflow as omitted', () => {
  const digest = validDigest();
  digest.agents = Array.from({ length: 150 }, (_, i) => ({ index: i, label: `agent-${i}`, state: 'queued' }));
  digest.agentsOmitted = 3;
  const out = sanitizeWorkflowProgress(digest);
  assert.equal(out.agents.length, 100);
  assert.equal(out.agents[0].label, 'agent-0');
  assert.equal(out.agents[99].label, 'agent-99');
  assert.deepEqual(out.agents.map((agent) => agent.index), Array.from({ length: 100 }, (_, i) => i));
  assert.equal(out.agentsOmitted, 53); // 3 reported by the worker + 50 dropped here
});

test('sanitizeWorkflowProgress caps phases at 50 and logs at 5', () => {
  const digest = validDigest();
  digest.phases = Array.from({ length: 80 }, (_, i) => ({ index: i, title: `phase-${i}` }));
  digest.logs = Array.from({ length: 40 }, (_, i) => `log-${i}`);
  const out = sanitizeWorkflowProgress(digest);
  assert.equal(out.phases.length, 50);
  assert.equal(out.phases[49].title, 'phase-49');
  assert.deepEqual(out.logs, ['log-0', 'log-1', 'log-2', 'log-3', 'log-4']);
});

test('sanitizeWorkflowProgress returns null for wrong-typed top-level values', () => {
  assert.equal(sanitizeWorkflowProgress(undefined), null);
  assert.equal(sanitizeWorkflowProgress(null), null);
  assert.equal(sanitizeWorkflowProgress('a string digest'), null);
  assert.equal(sanitizeWorkflowProgress(42), null);
  assert.equal(sanitizeWorkflowProgress(true), null);
  assert.equal(sanitizeWorkflowProgress([{ runId: 'x' }]), null);
});

test('sanitizeWorkflowProgress returns null when agents and phases are both empty or junk', () => {
  assert.equal(sanitizeWorkflowProgress({ runId: 'wf_1', status: 'running', agents: [], phases: [] }), null);
  assert.equal(sanitizeWorkflowProgress({ runId: 'wf_1' }), null);
  // Deep junk: arrays of non-objects contribute no entries.
  assert.equal(sanitizeWorkflowProgress({
    runId: 'wf_1',
    agents: ['not-an-agent', 7, null, [{ label: 'nested' }]],
    phases: 'Review,Verify',
  }), null);
});

test('sanitizeWorkflowProgress strips unknown fields at every level', () => {
  const digest = validDigest();
  digest.script = 'workflow(...)'; // multi-KB field the digest must never carry
  digest.result = { verdict: 'ok' };
  digest.phases[0].promptPreview = 'p'.repeat(1000);
  digest.agents[0].resultPreview = 'r'.repeat(1000);
  digest.agents[0].agentId = 'agent-abc';
  const out = sanitizeWorkflowProgress(digest);
  assert.deepEqual(out, validDigest());
  assert.equal('script' in out, false);
  assert.equal('promptPreview' in out.phases[0], false);
  assert.equal('resultPreview' in out.agents[0], false);
  assert.equal('agentId' in out.agents[0], false);
});

test('sanitizeWorkflowProgress nulls wrong-typed fields instead of failing the digest', () => {
  const out = sanitizeWorkflowProgress({
    runId: { nested: true },
    workflowName: ['review'],
    status: 'running',
    agentCount: 'seven',
    totalTokens: Infinity,
    durationMs: 'about an hour',
    phases: [{ index: 'zero', title: 42 }],
    logs: [{ line: 'object log' }, 'kept'],
    agents: [{
      index: NaN,
      label: 'ok-agent',
      phaseIndex: '0',
      phaseTitle: false,
      model: {},
      state: 'running',
      attempt: 'second',
      lastToolName: ['Read'],
      tokens: -Infinity,
      toolCalls: '27',
      durationMs: true,
      startedAt: 'yesterday',
    }],
    agentsOmitted: -5,
  });
  assert.equal(out.runId, null);
  assert.equal(out.workflowName, null);
  assert.equal(out.status, 'running');
  assert.equal(out.agentCount, null);
  assert.equal(out.totalTokens, null);
  assert.equal(out.durationMs, null);
  assert.deepEqual(out.phases, [{ index: null, title: '42' }]);
  assert.deepEqual(out.logs, ['kept']);
  assert.deepEqual(out.agents, [{
    index: null,
    label: 'ok-agent',
    phaseIndex: 0, // numeric strings coerce via Number()
    phaseTitle: null,
    model: null,
    state: 'running',
    attempt: null,
    lastToolName: null,
    tokens: null,
    toolCalls: 27,
    durationMs: null,
    startedAt: null,
  }]);
  assert.equal(out.agentsOmitted, 0); // negative counts clamp to 0
});

// --- route-level: POST /api/background-tasks ---

function makeDeps() {
  const stmts = new Proxy({}, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      obj[prop] = { run: () => ({ changes: 1 }), get: () => null, all: () => [] };
      return obj[prop];
    },
  });
  const emitted = [];
  const stored = [];
  const deps = {
    auth: (_req, _res, next) => next(),
    uuidv4: () => 'test-uuid',
    ts: () => '12:00:00',
    db: {
      transaction: (fn) => (...args) => fn(...args),
      prepare: () => ({ run: () => ({ changes: 1 }), get: () => null, all: () => [] }),
    },
    stmts,
    io: { emit: (event, payload) => emitted.push({ event, payload }) },
    touchCli: () => {},
    normalizeRelayMode: (value) => String(value || '').trim().toLowerCase() || null,
    DEFAULT_RELAY_MODE: 'default',
    DEFAULT_MODEL: 'gpt-5',
    MAX_UPLOAD_BYTES: 1024 * 1024,
    normalizeAttachments: () => [],
    collectReferenceAttachmentsFromText: () => ({ attachments: [] }),
    mergeMessageAttachments: (left, right) => [...(left || []), ...(right || [])],
    resolveRequestedModel: () => ({ ok: false, error: 'unsupported', available: [] }),
    getOpenAIProviderSettings: () => ({ configured: false, enabled: false, model: '', models: [] }),
    getCursorProviderSettings: () => ({ enabled: false, model: '', models: [] }),
    featureFlags: {},
    relayBridgeOwnerService: {
      normalizeIdentity: (raw) => {
        const sessionId = String(raw?.sessionId || '').trim();
        return sessionId ? { sessionId } : null;
      },
    },
    readSessionTranscriptMessages: () => [],
    resolveSessionStateRoot: () => '/tmp',
    ensureSessionId: () => 'session-1',
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    relayThoughtsForResponse: () => [],
    relayThoughtsForQueueMessage: () => [],
    sanitizeActivityText: (value) => String(value || ''),
    hydrateAttachment: (attachment) => attachment,
    parseAttachments: () => [],
    inFlightStateForConversation: () => null,
    emitToClientsExceptSessionId: () => {},
    queueCounts: () => ({ pendingCount: 0, processingCount: 0 }),
    backgroundTaskStore: {
      replace: (conversationId, tasks) => stored.push({ conversationId, tasks }),
      get: () => [],
    },
    sessionWorkerRegistry: null,
    sessionWorkerSupervisor: null,
    pushDispatchService: null,
    runtimeState: {},
    config: {},
  };
  return { deps, emitted, stored };
}

async function invokeBackgroundTasks(body) {
  const { deps, emitted, stored } = makeDeps();
  let handler = null;
  const app = {
    post(registeredPath, ...handlers) {
      if (registeredPath === '/api/background-tasks') handler = handlers[handlers.length - 1];
    },
    get() {}, patch() {}, delete() {}, put() {}, use() {},
  };
  registerMessagesRoutes(app, deps);
  assert.ok(handler, '/api/background-tasks should be registered');
  const captured = { status: 200, body: null };
  const res = {
    setHeader() {},
    status(code) { captured.status = code; return res; },
    json(payload) { captured.body = payload; return res; },
  };
  await handler({ body, headers: {}, query: {} }, res);
  return { captured, emitted, stored };
}

test('POST /api/background-tasks carries a sanitized workflowProgress into the store and broadcast', async () => {
  const digest = validDigest();
  digest.script = 'workflow(...)'; // unknown field must not survive ingest
  const { captured, emitted, stored } = await invokeBackgroundTasks({
    conversationId: 'conv-1',
    tasks: [{
      taskId: 'wic26ymi4',
      taskType: 'local_workflow',
      description: 'Ultracode workflow',
      totalTokens: 321000,
      workflowProgress: digest,
    }],
  });
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, { ok: true, count: 1 });
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].tasks[0].workflowProgress, validDigest());
  const broadcast = emitted.find((entry) => entry.event === 'background_tasks');
  assert.ok(broadcast, 'background_tasks must be broadcast');
  assert.deepEqual(broadcast.payload.tasks[0].workflowProgress, validDigest());
});

// --- route-level: POST /api/response with workflowRuns (Phase 4: the
// "Finished background task" card persisted with the summarizing message) ---

function recordingStmts(explicit = {}) {
  const calls = [];
  const target = { ...explicit };
  const stmts = new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      const recorder = {
        run: (...args) => { calls.push({ stmt: String(prop), args }); return { changes: 1 }; },
        get: () => null,
        all: () => [],
      };
      obj[prop] = recorder;
      return recorder;
    },
  });
  return { calls, stmts };
}

async function invokeResponse(body) {
  const { calls, stmts } = recordingStmts({
    findQById: {
      get: () => ({ id: 'q-1', conversation_id: 'conv-1', status: 'processing', relay_mode: 'agent', model: 'claude-sonnet-5', retry_count: 0 }),
    },
    getRuntimeSessionByConversation: { get: () => ({ provider_type: 'claude' }) },
    getConvAnyStatus: { get: () => ({ id: 'conv-1', status: 'active', sdk_session_id: 'conv-1' }) },
    findPendingQuestionByMessage: { get: () => null },
    findRecentlyAnsweredQuestionByMessage: { get: () => null },
  });
  const { deps, emitted } = makeDeps();
  deps.stmts = stmts;
  let uuidCounter = 0;
  deps.uuidv4 = () => `uuid-${++uuidCounter}`;
  let handler = null;
  const app = {
    post(registeredPath, ...handlers) {
      if (registeredPath === '/api/response') handler = handlers[handlers.length - 1];
    },
    get() {}, patch() {}, delete() {}, put() {}, use() {},
  };
  registerMessagesRoutes(app, deps);
  assert.ok(handler, '/api/response should be registered');
  const captured = { status: 200, body: null };
  const res = {
    setHeader() {},
    status(code) { captured.status = code; return res; },
    json(payload) { captured.body = payload; return res; },
  };
  await handler({ body, headers: {}, query: {} }, res);
  return { captured, calls, emitted };
}

test('POST /api/response persists sanitized workflowRuns with the assistant message and broadcasts them', async () => {
  const digest = validDigest();
  digest.script = 'workflow(...)'; // unknown field must not survive ingest
  const { captured, calls, emitted } = await invokeResponse({
    messageId: 'q-1',
    conversationId: 'conv-1',
    text: 'The workflow finished.',
    model: 'claude-sonnet-5',
    mode: 'agent',
    workflowRuns: [digest, 'garbage', { runId: 'wf_junk' }],
  });
  assert.equal(captured.status, 200);
  assert.equal(captured.body.ok, true);
  const inserts = calls.filter((call) => call.stmt === 'insertWorkflowRun');
  assert.equal(inserts.length, 1, 'junk entries drop; only the sanitized digest persists');
  const [id, responseMessageId, conversationId, runIndex, digestJson] = inserts[0].args;
  assert.match(String(id), /^wfr_uuid-/);
  const responseInsert = calls.find((call) => call.stmt === 'insertMsg');
  assert.equal(responseMessageId, responseInsert.args[0], 'rows key on the new assistant message id');
  assert.equal(conversationId, 'conv-1');
  assert.equal(runIndex, 0);
  assert.deepEqual(JSON.parse(digestJson), validDigest(), 'the stored digest is the sanitized contract');
  const broadcast = emitted.find((entry) => entry.event === 'assistant_message');
  assert.ok(broadcast, 'assistant_message must be broadcast');
  assert.deepEqual(broadcast.payload.message.workflowRuns, [validDigest()], 'live clients get the cards without a reload');
});

test('POST /api/response caps workflowRuns at 5 and tolerates a junk field entirely', async () => {
  const many = Array.from({ length: 8 }, (_, i) => {
    const digest = validDigest();
    digest.runId = `wf_${i + 1}`;
    return digest;
  });
  const capped = await invokeResponse({
    messageId: 'q-1', conversationId: 'conv-1', text: 'done', model: 'claude-sonnet-5', mode: 'agent',
    workflowRuns: many,
  });
  const cappedInserts = capped.calls.filter((call) => call.stmt === 'insertWorkflowRun');
  assert.equal(cappedInserts.length, 5);
  assert.deepEqual(cappedInserts.map((call) => call.args[3]), [0, 1, 2, 3, 4], 'run_index preserves array order');
  assert.deepEqual(
    cappedInserts.map((call) => JSON.parse(call.args[4]).runId),
    ['wf_1', 'wf_2', 'wf_3', 'wf_4', 'wf_5'],
  );

  const junk = await invokeResponse({
    messageId: 'q-1', conversationId: 'conv-1', text: 'done', model: 'claude-sonnet-5', mode: 'agent',
    workflowRuns: 'not-an-array',
  });
  assert.equal(junk.captured.status, 200, 'a junk workflowRuns field never fails the response');
  assert.equal(junk.calls.filter((call) => call.stmt === 'insertWorkflowRun').length, 0);
  const broadcast = junk.emitted.find((entry) => entry.event === 'assistant_message');
  assert.equal(broadcast.payload.message.workflowRuns, undefined, 'no empty field on the broadcast');
});

test('POST /api/background-tasks leaves flat rows untouched and never 400s on a garbage digest', async () => {
  const { captured, emitted, stored } = await invokeBackgroundTasks({
    conversationId: 'conv-1',
    tasks: [
      { taskId: 'flat-1', taskType: 'local_bash', description: 'npm test' },
      { taskId: 'junk-1', taskType: 'local_workflow', description: 'bad digest', workflowProgress: 'garbage' },
    ],
  });
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, { ok: true, count: 2 });
  const rows = stored[0].tasks;
  assert.equal(rows[0].taskId, 'flat-1');
  assert.equal(rows[0].workflowProgress, undefined);
  assert.equal(rows[1].workflowProgress, undefined);
  // JSON serialization (socket broadcast / conversation payload) drops the key entirely.
  const serialized = JSON.parse(JSON.stringify(emitted.find((entry) => entry.event === 'background_tasks').payload));
  assert.equal('workflowProgress' in serialized.tasks[0], false);
  assert.equal('workflowProgress' in serialized.tasks[1], false);
});
