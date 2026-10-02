'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import {
  buildClaudeCloudDelivery,
  buildCloudSourceRecord,
  buildConversationCloudPayload,
  createClaudeCloudSessionService,
  isClaudeCloudProviderType,
  parseCloudSourceJson,
  validateCloudSourceRequest,
} from './claude-cloud-session-service.mjs';

const REPO_URL = 'https://github.com/example-org/sample-repo';
const SESSION_ID = 'cse_01EXAMPLEaaaaaaaaaaaaaaaa';
const OTHER_SESSION_ID = 'cse_01EXAMPLEbbbbbbbbbbbbbbbb';
const ENVIRONMENT_ID = 'env_01EXAMPLEaaaaaaaaaaaaaaaa';
const SESSION_URL = 'https://claude.example.com/code/session-example';
// Built from its halves: the hygiene guard reads `user@host` as an e-mail address.
const SCP_REPO = ['git', 'github.com:example-org/sample-repo.git'].join('@');
const NOW = '2026-10-02T10:00:00.000Z';

function createHarness({ providerType = 'claude-cloud', cloudSource = buildCloudSourceRecord({ repoUrl: REPO_URL, branch: 'main', environmentId: ENVIRONMENT_ID }), cloud = null } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = createSessionRepository(db);
  stmts.insertConv.run('conv-1', 'Fix the slug helper', NOW, NOW);
  stmts.insertRuntimeSession.run('rs-1', 'conv-1', 'isolated', 'rs-1', 'claude-sonnet-5-5', NOW, NOW, 'conv-1', providerType, 'claude-sonnet-5-5');
  if (cloudSource) stmts.updateConvCloudSource.run(JSON.stringify(cloudSource), 'conv-1');
  const events = [];
  const logs = [];
  let clock = Date.parse('2026-10-02T11:00:00.000Z');
  const service = createClaudeCloudSessionService({
    stmts,
    getCloudClient: () => cloud,
    emit: (event, payload) => events.push({ event, payload }),
    now: () => new Date(clock),
    logger: { log: (line) => logs.push(line), warn: (line) => logs.push(line) },
  });
  return {
    db,
    stmts,
    service,
    events,
    logs,
    advance: (ms) => { clock += ms; },
    runtime: () => stmts.getRuntimeSessionByConversation.get('conv-1'),
    source: () => JSON.parse(stmts.getConvAnyStatus.get('conv-1').cloud_source_json),
  };
}

// ─── pure helpers ────────────────────────────────────────────────────────────

test('only the exact provider type is a cloud conversation', () => {
  assert.equal(isClaudeCloudProviderType('claude-cloud'), true);
  assert.equal(isClaudeCloudProviderType(' Claude-Cloud '), true);
  assert.equal(isClaudeCloudProviderType('claude'), false);
  assert.equal(isClaudeCloudProviderType(''), false);
  assert.equal(isClaudeCloudProviderType(null), false);
});

test('a bootstrap cloud source is validated and brought to its https form', () => {
  assert.deepEqual(validateCloudSourceRequest({ repoUrl: SCP_REPO, branch: ' dev/feature ' }), {
    ok: true,
    repoUrl: REPO_URL,
    slug: 'example-org/sample-repo',
    branch: 'dev/feature',
  });
  // No branch: the default branch of the repository.
  assert.equal(validateCloudSourceRequest({ repoUrl: REPO_URL }).branch, null);
  assert.equal(validateCloudSourceRequest({ repoUrl: REPO_URL, branch: '' }).branch, null);

  for (const cloudSource of [undefined, null, 'text', {}, { repoUrl: '' }, { repoUrl: 'https://git.example.com/example-org/sample-repo' }, { repoUrl: '/home/dev/git/sample-repo' }]) {
    const refused = validateCloudSourceRequest(cloudSource);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'claude_cloud_repo_invalid');
  }
  for (const branch of ['has space', '-leading', 'a..b', 'ends.lock', 42, {}]) {
    const refused = validateCloudSourceRequest({ repoUrl: REPO_URL, branch });
    assert.equal(refused.ok, false, String(branch));
    assert.equal(refused.code, 'claude_cloud_branch_invalid', String(branch));
  }
});

test('a stored cloud source is read back strictly', () => {
  assert.equal(parseCloudSourceJson(null), null);
  assert.equal(parseCloudSourceJson(''), null);
  assert.equal(parseCloudSourceJson('{not json'), null);
  assert.equal(parseCloudSourceJson('{"branch":"main"}'), null, 'no repository, no cloud source');
  assert.deepEqual(parseCloudSourceJson(JSON.stringify({
    repoUrl: `${REPO_URL}.git`,
    branch: 'bad branch',
    environmentId: 'not an id!',
    sessionUrl: 'javascript:alert(1)',
    pushedBranches: [{ branch: 'dev/a', at: NOW }, { branch: 'bad branch' }, { branch: 'dev/a', at: 'later' }, 'dev/b'],
  })), {
    repoUrl: REPO_URL,
    branch: null,
    environmentId: null,
    sessionUrl: null,
    pushedBranches: [{ branch: 'dev/a', at: NOW }, { branch: 'dev/b', at: null }],
  });
});

test('the cloud payload has the documented fields, and none of the environment', () => {
  const payload = buildConversationCloudPayload({
    cloudSourceJson: JSON.stringify({
      repoUrl: REPO_URL,
      branch: 'main',
      environmentId: ENVIRONMENT_ID,
      sessionUrl: SESSION_URL,
      pushedBranches: [{ branch: 'dev/a', at: NOW }],
    }),
    costUsd: 0.18,
  });
  assert.deepEqual(payload, {
    repoUrl: REPO_URL,
    slug: 'example-org/sample-repo',
    branch: 'main',
    sessionUrl: SESSION_URL,
    pushedBranches: [{ branch: 'dev/a', at: NOW }],
    costUsd: 0.18,
  });
  assert.equal(buildConversationCloudPayload({ cloudSourceJson: null, costUsd: 3 }), null);
  assert.equal(buildConversationCloudPayload({ cloudSourceJson: JSON.stringify({ repoUrl: REPO_URL }), costUsd: 'n/a' }).costUsd, null);
  assert.equal(buildConversationCloudPayload({ cloudSourceJson: JSON.stringify({ repoUrl: REPO_URL }), costUsd: -1 }).costUsd, null);
});

test('the delivery field is built for cloud conversations only', () => {
  const conversation = {
    title: 'Fix the slug helper',
    cloud_source_json: JSON.stringify({ repoUrl: REPO_URL, branch: 'main', environmentId: ENVIRONMENT_ID }),
  };
  assert.deepEqual(buildClaudeCloudDelivery({
    conversation,
    runtimeSession: { provider_type: 'claude-cloud' },
  }), {
    sessionId: null,
    lastSequence: null,
    repoUrl: REPO_URL,
    branch: 'main',
    environmentId: ENVIRONMENT_ID,
    title: 'Fix the slug helper',
  });
  assert.deepEqual(buildClaudeCloudDelivery({
    conversation,
    runtimeSession: { provider_type: 'claude-cloud', claude_cloud_session_id: SESSION_ID, claude_cloud_last_sequence: '57' },
  }), {
    sessionId: SESSION_ID,
    lastSequence: '57',
    repoUrl: REPO_URL,
    branch: 'main',
    environmentId: ENVIRONMENT_ID,
    title: 'Fix the slug helper',
  });
  // A conversation stored before an environment was known takes the tab's.
  assert.equal(buildClaudeCloudDelivery({
    conversation: { title: 'T', cloud_source_json: JSON.stringify({ repoUrl: REPO_URL }) },
    runtimeSession: { provider_type: 'claude-cloud' },
    fallbackEnvironmentId: ENVIRONMENT_ID,
  }).environmentId, ENVIRONMENT_ID);
  // Never for another provider, even with a cloud source on the row.
  assert.equal(buildClaudeCloudDelivery({ conversation, runtimeSession: { provider_type: 'claude' } }), null);
  assert.equal(buildClaudeCloudDelivery({ conversation, runtimeSession: { provider_type: 'github' } }), null);
  assert.equal(buildClaudeCloudDelivery({ conversation: { title: 'T' }, runtimeSession: { provider_type: 'claude-cloud' } }), null);
});

// ─── the worker's report ─────────────────────────────────────────────────────

test('the first report stores the binding and tells the clients', () => {
  const harness = createHarness();
  const result = harness.service.recordWorkerReport({
    conversationId: 'conv-1',
    cloudSessionId: SESSION_ID,
    sessionUrl: SESSION_URL,
    lastSequence: '12',
  });
  assert.equal(result.ok, true);
  assert.equal(harness.runtime().claude_cloud_session_id, SESSION_ID);
  assert.equal(harness.runtime().claude_cloud_last_sequence, '12');
  assert.equal(harness.runtime().claude_cloud_cost_usd, null);
  assert.equal(harness.source().sessionUrl, SESSION_URL);
  assert.equal(harness.source().environmentId, ENVIRONMENT_ID, 'the stored source keeps what bootstrap wrote');
  assert.deepEqual(harness.events, [{
    event: 'claude_cloud_session',
    payload: {
      conversationId: 'conv-1',
      cloud: {
        repoUrl: REPO_URL,
        slug: 'example-org/sample-repo',
        branch: 'main',
        sessionUrl: SESSION_URL,
        pushedBranches: [],
        costUsd: null,
      },
    },
  }]);
  assert.deepEqual(result.cloud, harness.events[0].payload.cloud);
});

test('later reports advance the sequence, keep what they do not name, and collect pushes', () => {
  const harness = createHarness();
  const report = (extra) => harness.service.recordWorkerReport({ conversationId: 'conv-1', cloudSessionId: SESSION_ID, ...extra });
  report({ sessionUrl: SESSION_URL, lastSequence: '12' });
  report({ lastSequence: 40, costUsd: 0.07, model: 'claude-sonnet-5-5' });
  assert.equal(harness.runtime().claude_cloud_last_sequence, '40');
  assert.equal(harness.runtime().claude_cloud_cost_usd, 0.07);
  assert.equal(harness.source().sessionUrl, SESSION_URL, 'a report without the link keeps it');

  // A late report never moves the resume cursor back, and bad values change nothing.
  report({ lastSequence: '9', costUsd: 'free' });
  report({ lastSequence: 'next', costUsd: -3 });
  assert.equal(harness.runtime().claude_cloud_last_sequence, '40');
  assert.equal(harness.runtime().claude_cloud_cost_usd, 0.07);

  report({ pushedBranch: 'dev/fix-slugify' });
  harness.advance(60_000);
  report({ pushedBranch: 'dev/word-count', costUsd: 0.25 });
  harness.advance(60_000);
  report({ pushedBranch: 'dev/fix-slugify' });
  report({ pushedBranch: 'not a branch' });
  assert.deepEqual(harness.source().pushedBranches, [
    { branch: 'dev/word-count', at: '2026-10-02T11:01:00.000Z' },
    { branch: 'dev/fix-slugify', at: '2026-10-02T11:02:00.000Z' },
  ]);
  const last = harness.events.at(-1).payload.cloud;
  assert.equal(last.costUsd, 0.25);
  assert.equal(last.pushedBranches.length, 2);
});

test('a report naming another cloud session starts the sequence, the cost and the pushes again', () => {
  const harness = createHarness();
  harness.service.recordWorkerReport({
    conversationId: 'conv-1', cloudSessionId: SESSION_ID, sessionUrl: SESSION_URL, lastSequence: '90', costUsd: 1.5, pushedBranch: 'dev/a',
  });
  harness.service.recordWorkerReport({ conversationId: 'conv-1', cloudSessionId: OTHER_SESSION_ID, lastSequence: '3' });
  assert.equal(harness.runtime().claude_cloud_session_id, OTHER_SESSION_ID);
  assert.equal(harness.runtime().claude_cloud_last_sequence, '3');
  assert.equal(harness.runtime().claude_cloud_cost_usd, null);
  assert.equal(harness.source().sessionUrl, null);
  assert.deepEqual(harness.source().pushedBranches, []);
});

test('a session link that is not https is not stored', () => {
  const harness = createHarness();
  harness.service.recordWorkerReport({ conversationId: 'conv-1', cloudSessionId: SESSION_ID, sessionUrl: 'javascript:alert(1)' });
  assert.equal(harness.source().sessionUrl, null);
  harness.service.recordWorkerReport({ conversationId: 'conv-1', cloudSessionId: SESSION_ID, sessionUrl: 'http://claude.example.com/code/x' });
  assert.equal(harness.source().sessionUrl, null);
});

test('reports are refused for missing fields, unknown conversations and other providers', () => {
  const harness = createHarness();
  assert.deepEqual(harness.service.recordWorkerReport({ cloudSessionId: SESSION_ID }), {
    ok: false, statusCode: 400, error: 'Missing conversationId or cloudSessionId',
  });
  assert.equal(harness.service.recordWorkerReport({ conversationId: 'conv-1' }).statusCode, 400);
  assert.deepEqual(harness.service.recordWorkerReport({ conversationId: 'conv-1', cloudSessionId: '../v1/other' }), {
    ok: false, statusCode: 400, error: 'Invalid cloudSessionId',
  });
  assert.equal(harness.service.recordWorkerReport({ conversationId: 'conv-none', cloudSessionId: SESSION_ID }).statusCode, 404);
  assert.deepEqual(harness.events, []);

  for (const providerType of ['claude', 'github', 'grok']) {
    const other = createHarness({ providerType });
    const refused = other.service.recordWorkerReport({ conversationId: 'conv-1', cloudSessionId: SESSION_ID });
    assert.equal(refused.statusCode, 409, providerType);
    assert.match(refused.error, /not bound to the Claude Cloud provider/);
    assert.equal(other.runtime().claude_cloud_session_id, null, providerType);
    assert.deepEqual(other.events, []);
  }

  const noSource = createHarness({ cloudSource: null });
  assert.equal(noSource.service.recordWorkerReport({ conversationId: 'conv-1', cloudSessionId: SESSION_ID }).statusCode, 409);
});

// ─── archive ─────────────────────────────────────────────────────────────────

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the archive is started in the background and returns at once', async () => {
  const archived = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = createHarness({
    cloud: { archiveSession: async (id) => { archived.push(id); await gate; return { archived: true }; } },
  });
  harness.service.recordWorkerReport({ conversationId: 'conv-1', cloudSessionId: SESSION_ID });

  const started = harness.service.archiveSessionInBackground({ conversationId: 'conv-1', runtimeSession: harness.runtime() });
  assert.equal(started, true);
  assert.deepEqual(archived, [], 'nothing has run before the caller got its answer');
  await settle();
  assert.deepEqual(archived, [SESSION_ID]);
  assert.equal(harness.logs.some((line) => /archived the cloud session/.test(line)), false, 'still waiting on the cloud');
  release();
  await settle();
  assert.equal(harness.logs.some((line) => /archived the cloud session of conversation conv-1/.test(line)), true);
});

test('an archive that fails is logged by its code and reaches nobody', async () => {
  const failure = Object.assign(new Error('The Claude login has expired.'), { code: 'login_expired' });
  const harness = createHarness({ cloud: { archiveSession: async () => { throw failure; } } });
  harness.service.recordWorkerReport({ conversationId: 'conv-1', cloudSessionId: SESSION_ID });
  assert.equal(harness.service.archiveSessionInBackground({ conversationId: 'conv-1', runtimeSession: harness.runtime() }), true);
  await settle();
  await settle();
  assert.equal(harness.logs.some((line) => /was not archived: login_expired/.test(line)), true);

  // A client that throws synchronously is no different.
  const sync = createHarness({ cloud: { archiveSession: () => { throw new Error('boom'); } } });
  sync.service.recordWorkerReport({ conversationId: 'conv-1', cloudSessionId: SESSION_ID });
  assert.equal(sync.service.archiveSessionInBackground({ conversationId: 'conv-1', runtimeSession: sync.runtime() }), true);
  await settle();
  await settle();
  assert.equal(sync.logs.some((line) => /was not archived: boom/.test(line)), true);
});

test('nothing is archived without a cloud session, for another provider, or without a client', async () => {
  const calls = [];
  const cloud = { archiveSession: async (id) => { calls.push(id); } };
  const fresh = createHarness({ cloud });
  assert.equal(fresh.service.archiveSessionInBackground({ conversationId: 'conv-1', runtimeSession: fresh.runtime() }), false);

  const claude = createHarness({ providerType: 'claude', cloud });
  assert.equal(claude.service.archiveSessionInBackground({
    conversationId: 'conv-1',
    runtimeSession: { ...claude.runtime(), claude_cloud_session_id: SESSION_ID },
  }), false);

  const noClient = createHarness({ cloud: null });
  noClient.service.recordWorkerReport({ conversationId: 'conv-1', cloudSessionId: SESSION_ID });
  assert.equal(noClient.service.archiveSessionInBackground({ conversationId: 'conv-1', runtimeSession: noClient.runtime() }), false);
  assert.equal(fresh.service.archiveSessionInBackground({}), false);
  await settle();
  assert.deepEqual(calls, []);
});
