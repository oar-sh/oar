import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createConversationGroupRepository } from '../repositories/conversation-group-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { buildCompactSummary, createConversationCompactionService } from './conversation-compaction-service.mjs';

const NOW = '2026-11-17T09:00:00.000Z';
const SOURCE = 'conv-fixture-source';
const TARGET = 'conv-fixture-target';
const REPO_URL = 'https://github.com/example-org/example-repo';

// Every provider switched on and set up; a test turns one off.
function readySettings() {
  return {
    copilot: true,
    openai: { configured: true, enabled: true },
    claude: { enabled: true },
    claudeApi: { configured: true, enabled: true },
    cap: { reached: false },
    cloud: { enabled: true },
    cursor: { configured: true },
    grok: { enabled: true },
    deepseek: { configured: true, enabled: true },
  };
}

// The runtime's binding as far as a fresh conversation goes: the provider
// named, its model, and the Copilot backstop (server-runtime.mjs,
// ensureRuntimeSessionBinding).
function createBinding(stmts, settings, calls) {
  let counter = 0;
  return (conversationId, model, nowIso, sdkSessionId, options = {}) => {
    calls.push({ conversationId, model, sdkSessionId, options });
    const providerType = String(options.providerType || '').trim().toLowerCase() || 'github';
    if (options.assignConfiguredProvider && providerType === 'github' && settings.copilot !== true) {
      throw Object.assign(new Error('Copilot is switched off on this relay, so no Copilot chat was started.'), { code: 'COPILOT_NOT_ENABLED' });
    }
    const providerModel = providerType === 'github' ? null : (String(options.providerModel || model || '').trim() || null);
    counter += 1;
    const id = `runtime-fixture-${counter}`;
    stmts.insertRuntimeSession.run(id, conversationId, 'isolated', id, model || null, nowIso, nowIso, sdkSessionId || null, providerType, providerModel);
    return stmts.getRuntimeSessionById.get(id);
  };
}

function setup({ settings = readySettings(), binding = null } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  // The runtime's statements are these repositories together.
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const conversationGroups = createConversationGroupRepository(db);
  const bindingCalls = [];
  const carried = [];
  const service = createConversationCompactionService({
    db,
    stmts,
    conversationGroups,
    ensureRuntimeSessionBinding: binding || createBinding(stmts, settings, bindingCalls),
    isCopilotEnabled: () => settings.copilot,
    getOpenAIProviderSettings: () => settings.openai,
    getClaudeProviderSettings: () => settings.claude,
    getClaudeApiProviderSettings: () => settings.claudeApi,
    getClaudeApiCapState: () => {
      if (settings.cap instanceof Error) throw settings.cap;
      return settings.cap;
    },
    getClaudeCloudProviderSettings: () => settings.cloud,
    getCursorProviderSettings: () => settings.cursor,
    getGrokProviderSettings: () => settings.grok,
    getDeepSeekProviderSettings: () => settings.deepseek,
    getRelayScheduleService: () => ({ carryToCompacted: (from, to) => carried.push(['schedules', from, to]) }),
    getRelayAskService: () => ({ carryToCompacted: (from, to) => carried.push(['asks', from, to]) }),
    getRemoteRelayRegistry: () => ({ carryLoopGuardOff: (from, to) => carried.push(['loop-guard', from, to]) }),
    now: () => NOW,
    newId: () => TARGET,
  });
  return { db, stmts, conversationGroups, service, settings, bindingCalls, carried };
}

function seedSource(ctx, {
  runtime = { provider_type: 'github', model: 'gpt-5.1', provider_model: null },
  preferredModel = 'model-fixture-pref',
  preferredEffort = 'high',
  relayMode = 'agent',
  planOnly = 0,
  cloudSource = null,
} = {}) {
  const { db } = ctx;
  db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, preferred_relay_mode, preferred_model, preferred_reasoning_effort, plan_only, cloud_source_json, created_at, updated_at)
    VALUES (?, 'Release checklist', 'sdk-fixture-source', ?, ?, ?, ?, ?, ?, ?)
  `).run(SOURCE, relayMode, preferredModel, preferredEffort, planOnly, cloudSource ? JSON.stringify(cloudSource) : null, NOW, NOW);
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('msg-fixture-1', ?, 'user', 'Please check the release notes.', ?)`).run(SOURCE, NOW);
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('msg-fixture-2', ?, 'assistant', 'The notes are ready.', '2026-11-17T09:01:00.000Z')`).run(SOURCE);
  if (runtime) {
    db.prepare(`
      INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, created_at, last_used_at,
        claude_cloud_session_id, claude_cloud_last_sequence, claude_cloud_cost_usd, claude_native_session_id, cursor_agent_id, grok_native_session_id)
      VALUES ('runtime-fixture-source', ?, 'sdk-fixture-source', 'isolated', 'runtime-fixture-source', ?, ?, ?, ?, ?,
        'cloud_fixture_session', '42', 1.5, 'native-fixture', 'agent-fixture', 'grok-fixture')
    `).run(SOURCE, runtime.model ?? null, runtime.provider_type ?? 'github', runtime.provider_model ?? null, NOW, NOW);
  }
}

const conversation = (ctx, id) => ctx.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
const runtimeOf = (ctx, id) => ctx.db.prepare('SELECT * FROM runtime_sessions WHERE conversation_id = ?').get(id);
const conversationCount = (ctx) => ctx.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n;

// The source exactly as it was, and nothing new: no conversation, no runtime
// row, no carry after the commit.
function assertUntouched(ctx, before) {
  assert.deepEqual(conversation(ctx, SOURCE), before.conversation);
  assert.deepEqual(runtimeOf(ctx, SOURCE), before.runtime);
  assert.equal(conversation(ctx, TARGET), undefined);
  assert.equal(runtimeOf(ctx, TARGET), undefined);
  assert.equal(conversationCount(ctx), before.count);
  assert.deepEqual(ctx.carried, []);
}

function snapshot(ctx) {
  return { conversation: conversation(ctx, SOURCE), runtime: runtimeOf(ctx, SOURCE), count: conversationCount(ctx) };
}

const PROVIDER_KINDS = [
  { name: 'Copilot', runtime: { provider_type: 'github', model: 'gpt-5.1', provider_model: null } },
  { name: 'OpenAI', runtime: { provider_type: 'openai', model: 'gpt-5.1', provider_model: 'gpt-5.1-codex' } },
  { name: 'OpenAI image', runtime: { provider_type: 'openai', model: 'gpt-image-2', provider_model: 'gpt-image-2' } },
  { name: 'Claude subscription', runtime: { provider_type: 'claude', model: 'claude-opus-5-5', provider_model: 'claude-opus-5-5' } },
  { name: 'Claude API', runtime: { provider_type: 'claude-api', model: 'claude-sonnet-5-5', provider_model: 'claude-sonnet-5-5' } },
  { name: 'Cursor', runtime: { provider_type: 'cursor', model: 'cursor-fixture-model', provider_model: 'cursor-fixture-model' } },
  { name: 'Grok', runtime: { provider_type: 'grok', model: 'grok-fixture-model', provider_model: 'grok-fixture-model' } },
  { name: 'DeepSeek', runtime: { provider_type: 'deepseek', model: 'deepseek-fixture-model', provider_model: 'deepseek-fixture-model' } },
  { name: 'Claude Cloud', runtime: { provider_type: 'claude-cloud', model: 'claude-opus-5-5', provider_model: 'claude-opus-5-5' }, cloudSource: { repoUrl: REPO_URL, branch: 'main', environmentId: 'env_fixture' } },
];

for (const kind of PROVIDER_KINDS) {
  test(`a ${kind.name} chat compacts into a chat on the same provider, model and effort, with no session ids`, () => {
    const ctx = setup();
    seedSource(ctx, { runtime: kind.runtime, cloudSource: kind.cloudSource || null });
    const result = ctx.service.createCompactedConversation(SOURCE);
    assert.equal(result.targetConversationId, TARGET);
    assert.equal(result.ok, undefined, 'the success shape is unchanged');
    const target = runtimeOf(ctx, TARGET);
    assert.equal(result.runtimeSessionId, target.id);
    assert.equal(target.provider_type, kind.runtime.provider_type);
    assert.equal(target.provider_model, kind.runtime.provider_model);
    assert.equal(target.model, kind.runtime.model);
    for (const column of ['sdk_session_id', 'claude_cloud_session_id', 'claude_cloud_last_sequence', 'claude_cloud_cost_usd', 'claude_native_session_id', 'cursor_agent_id', 'grok_native_session_id']) {
      assert.equal(target[column], null, `${column} is not copied`);
    }
    assert.notEqual(target.id, 'runtime-fixture-source');
    const created = conversation(ctx, TARGET);
    assert.equal(created.preferred_model, 'model-fixture-pref');
    assert.equal(created.preferred_reasoning_effort, 'high');
    assert.equal(created.sdk_session_id, null);
    assert.equal(created.compacted_from, SOURCE);
    assert.equal(created.seed_pending, 1);
    assert.equal(conversation(ctx, SOURCE).archived, 1);
    assert.equal(conversation(ctx, SOURCE).compacted_into, TARGET);
    assert.deepEqual(ctx.bindingCalls.map((call) => [call.options.assignConfiguredProvider, call.options.providerType, call.sdkSessionId]),
      [[true, kind.runtime.provider_type, null]]);
    assert.deepEqual(ctx.carried.map(([what]) => what), ['schedules', 'asks', 'loop-guard']);
  });
}

test('a Claude Cloud chat carries a fresh source record and names its pushed branches in the seed', () => {
  const ctx = setup();
  seedSource(ctx, {
    runtime: { provider_type: 'claude-cloud', model: 'claude-opus-5-5', provider_model: 'claude-opus-5-5' },
    cloudSource: {
      repoUrl: REPO_URL,
      branch: 'release',
      environmentId: 'env_fixture',
      sessionUrl: 'https://claude.ai/code/session_fixture',
      pushedBranches: [{ branch: 'claude/fix-notes', at: NOW }, { branch: 'claude/fix-links', at: NOW }],
    },
  });
  const result = ctx.service.createCompactedConversation(SOURCE);
  assert.deepEqual(JSON.parse(conversation(ctx, TARGET).cloud_source_json), {
    repoUrl: REPO_URL,
    branch: 'release',
    environmentId: 'env_fixture',
    sessionUrl: null,
    pushedBranches: [],
  });
  assert.match(result.summarySeed, /\nBranches the earlier cloud session pushed: claude\/fix-notes, claude\/fix-links\n/);
  assert.equal(result.summarySeed.match(/claude\/fix-notes/g).length, 1, 'one line, names only');
  assert.doesNotMatch(result.summarySeed, /session_fixture/);
});

test('a Claude Cloud chat without a usable source record is refused as one that cannot be compacted', () => {
  for (const cloudSource of [null, { repoUrl: 'not a repository' }]) {
    const ctx = setup();
    seedSource(ctx, { runtime: { provider_type: 'claude-cloud', model: 'claude-opus-5-5', provider_model: 'claude-opus-5-5' }, cloudSource });
    const before = snapshot(ctx);
    const refused = ctx.service.createCompactedConversation(SOURCE);
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 409);
    assert.equal(refused.code, 'COMPACT_NOT_SUPPORTED');
    assert.equal(refused.provider, 'claude-cloud');
    assertUntouched(ctx, before);
  }
});

test('while Copilot is off a Copilot chat is refused, and OpenAI and Claude chats do not land on Copilot', () => {
  const settings = { ...readySettings(), copilot: false };
  const off = setup({ settings });
  seedSource(off);
  const before = snapshot(off);
  const refused = off.service.createCompactedConversation(SOURCE);
  assert.deepEqual(
    { ok: refused.ok, status: refused.status, code: refused.code, provider: refused.provider },
    { ok: false, status: 409, code: 'COPILOT_SWITCHED_OFF', provider: 'github' },
  );
  assert.match(refused.error, /Copilot is switched off on this relay, so this chat was not compacted\. Nothing was changed\. Switch it on in Settings → Providers → Copilot\./);
  assertUntouched(off, before);
  assert.deepEqual(off.bindingCalls, [], 'refused by the check, before the binding');

  for (const runtime of [
    { provider_type: 'openai', model: 'gpt-5.1', provider_model: 'gpt-5.1' },
    { provider_type: 'claude', model: 'claude-opus-5-5', provider_model: 'claude-opus-5-5' },
  ]) {
    const ctx = setup({ settings });
    seedSource(ctx, { runtime });
    ctx.service.createCompactedConversation(SOURCE);
    assert.equal(runtimeOf(ctx, TARGET).provider_type, runtime.provider_type);
  }
});

const OFF_CASES = [
  { name: 'OpenAI without a key', runtime: { provider_type: 'openai', model: 'gpt-5.1' }, off: { openai: { configured: false, enabled: false } }, code: 'OPENAI_NOT_CONFIGURED', text: /OpenAI has no API key/ },
  { name: 'Claude switched off', runtime: { provider_type: 'claude', model: 'claude-opus-5-5' }, off: { claude: { enabled: false } }, code: 'CLAUDE_NOT_CONFIGURED', text: /Claude is not switched on/ },
  { name: 'Claude API without a key', runtime: { provider_type: 'claude-api', model: 'claude-sonnet-5-5' }, off: { claudeApi: { configured: false, enabled: false } }, code: 'CLAUDE_API_NOT_CONFIGURED', text: /Claude API has no key/ },
  { name: 'Claude API switched off', runtime: { provider_type: 'claude-api', model: 'claude-sonnet-5-5' }, off: { claudeApi: { configured: true, enabled: false } }, code: 'CLAUDE_API_NOT_CONFIGURED', text: /Claude API is switched off/ },
  { name: 'Claude API at its cap', runtime: { provider_type: 'claude-api', model: 'claude-sonnet-5-5' }, off: { cap: { reached: true } }, code: 'CLAUDE_API_CAP_REACHED', text: /reached its cap\. This chat was not compacted\. Nothing was changed\. Switch the chat to the Claude subscription first/ },
  { name: 'Claude API with a cap that cannot be read', runtime: { provider_type: 'claude-api', model: 'claude-sonnet-5-5' }, off: { cap: new Error('totals unreadable') }, code: 'CLAUDE_API_CAP_REACHED', text: /Claude subscription/ },
  { name: 'Claude Cloud switched off', runtime: { provider_type: 'claude-cloud', model: 'claude-opus-5-5' }, cloudSource: { repoUrl: REPO_URL }, off: { cloud: { enabled: false } }, code: 'claude_cloud_disabled', text: /Claude Cloud is not enabled/ },
  { name: 'Cursor without a key', runtime: { provider_type: 'cursor', model: 'cursor-fixture-model' }, off: { cursor: { configured: false } }, code: 'CURSOR_NOT_CONFIGURED', text: /Cursor has no API key/ },
  { name: 'Grok switched off', runtime: { provider_type: 'grok', model: 'grok-fixture-model' }, off: { grok: { enabled: false } }, code: 'GROK_NOT_CONFIGURED', text: /Grok is not switched on/ },
  { name: 'DeepSeek without a key', runtime: { provider_type: 'deepseek', model: 'deepseek-fixture-model' }, off: { deepseek: { configured: false, enabled: false } }, code: 'DEEPSEEK_NOT_CONFIGURED', text: /DeepSeek has no API key/ },
  { name: 'DeepSeek switched off', runtime: { provider_type: 'deepseek', model: 'deepseek-fixture-model' }, off: { deepseek: { configured: true, enabled: false } }, code: 'DEEPSEEK_NOT_CONFIGURED', text: /DeepSeek is switched off/ },
  { name: 'an unknown provider', runtime: { provider_type: 'provider-fixture-unknown', model: 'model-fixture' }, off: {}, code: 'COMPACT_NOT_SUPPORTED', text: /cannot be compacted/ },
];

for (const entry of OFF_CASES) {
  test(`${entry.name}: the compact is refused with ${entry.code}, nothing created, nothing moved`, () => {
    const ctx = setup({ settings: { ...readySettings(), ...entry.off } });
    seedSource(ctx, { runtime: entry.runtime, cloudSource: entry.cloudSource || null, planOnly: 1, relayMode: 'plan' });
    // A session group the source heads: it must stay as it is.
    const group = ctx.conversationGroups.createGroup({ name: 'Fixture group', conversationIds: [SOURCE] }, NOW);
    const before = snapshot(ctx);
    const refused = ctx.service.createCompactedConversation(SOURCE);
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 409);
    assert.equal(refused.code, entry.code);
    assert.equal(refused.provider, entry.runtime.provider_type);
    assert.match(refused.error, entry.text);
    assert.match(refused.error, /Nothing was changed\./);
    assertUntouched(ctx, before);
    assert.deepEqual(ctx.conversationGroups.membersOf(group.id).map((member) => member.id), [SOURCE]);
    assert.deepEqual(ctx.bindingCalls, [], 'refused before the transaction');
  });
}

test('a chat with no runtime row is Copilot\'s: bound to Copilot while it is on, refused while it is off', () => {
  const on = setup();
  seedSource(on, { runtime: null });
  on.service.createCompactedConversation(SOURCE);
  assert.equal(runtimeOf(on, TARGET).provider_type, 'github');
  assert.equal(runtimeOf(on, TARGET).model, null);

  const off = setup({ settings: { ...readySettings(), copilot: false } });
  seedSource(off, { runtime: null });
  const before = snapshot(off);
  assert.equal(off.service.createCompactedConversation(SOURCE).code, 'COPILOT_SWITCHED_OFF');
  assertUntouched(off, before);
});

test('a model the provider no longer lists is kept as it is', () => {
  const ctx = setup();
  seedSource(ctx, {
    runtime: { provider_type: 'cursor', model: 'cursor-retired-model', provider_model: 'cursor-retired-model' },
    preferredModel: 'cursor-retired-model',
    preferredEffort: 'xhigh',
  });
  ctx.service.createCompactedConversation(SOURCE);
  assert.equal(runtimeOf(ctx, TARGET).provider_model, 'cursor-retired-model');
  assert.equal(runtimeOf(ctx, TARGET).model, 'cursor-retired-model');
  assert.equal(conversation(ctx, TARGET).preferred_model, 'cursor-retired-model');
  assert.equal(conversation(ctx, TARGET).preferred_reasoning_effort, 'xhigh');
});

test('a pending billing swap: the check and the new chat follow the billing the row already names', () => {
  // The swap wrote `claude` while the old worker on the key still runs.
  const ctx = setup({ settings: { ...readySettings(), claudeApi: { configured: true, enabled: false } } });
  seedSource(ctx, { runtime: { provider_type: 'claude', model: 'claude-opus-5-5', provider_model: 'claude-opus-5-5' } });
  ctx.service.createCompactedConversation(SOURCE);
  assert.equal(runtimeOf(ctx, TARGET).provider_type, 'claude');

  // The other way: on its way to the key, with Claude API switched off.
  const toKey = setup({ settings: { ...readySettings(), claudeApi: { configured: true, enabled: false } } });
  seedSource(toKey, { runtime: { provider_type: 'claude-api', model: 'claude-opus-5-5', provider_model: 'claude-opus-5-5' } });
  assert.equal(toKey.service.createCompactedConversation(SOURCE).code, 'CLAUDE_API_NOT_CONFIGURED');
});

test('plan-only and the session group go along; the relay mode is not reset', () => {
  const ctx = setup();
  seedSource(ctx, { planOnly: 1, relayMode: 'plan' });
  const group = ctx.conversationGroups.createGroup({ name: 'Fixture group', conversationIds: [SOURCE] }, NOW);
  ctx.service.createCompactedConversation(SOURCE);
  const created = conversation(ctx, TARGET);
  assert.equal(created.plan_only, 1);
  assert.equal(created.preferred_relay_mode, 'plan');
  assert.equal(created.preferred_model, 'model-fixture-pref');
  assert.equal(created.group_id, group.id);
  assert.deepEqual(ctx.conversationGroups.membersOf(group.id).map((member) => member.id).sort(), [SOURCE, TARGET].sort());
});

test('a binding that throws inside the transaction rolls everything back', () => {
  // The Copilot backstop: turned into the refusal.
  const settings = readySettings();
  const copilotOff = setup({
    settings,
    binding: () => { throw Object.assign(new Error('Copilot is switched off on this relay, so no Copilot chat was started.'), { code: 'COPILOT_NOT_ENABLED' }); },
  });
  seedSource(copilotOff, { planOnly: 1, relayMode: 'plan' });
  const group = copilotOff.conversationGroups.createGroup({ name: 'Fixture group', conversationIds: [SOURCE] }, NOW);
  const before = snapshot(copilotOff);
  const refused = copilotOff.service.createCompactedConversation(SOURCE);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
  assert.equal(refused.code, 'COPILOT_SWITCHED_OFF');
  assertUntouched(copilotOff, before);
  assert.deepEqual(copilotOff.conversationGroups.membersOf(group.id).map((member) => member.id), [SOURCE]);

  // Any other failure is not a refusal: it is thrown, after the same rollback.
  const broken = setup({ binding: () => { throw new Error('disk fixture failure'); } });
  seedSource(broken);
  const brokenBefore = snapshot(broken);
  assert.throws(() => broken.service.createCompactedConversation(SOURCE), /disk fixture failure/);
  assertUntouched(broken, brokenBefore);
});

test('an unknown conversation answers null', () => {
  const ctx = setup();
  assert.equal(ctx.service.createCompactedConversation('conv-fixture-missing'), null);
});

test('the summary seed is unchanged for a chat that pushed no branches', () => {
  const seed = buildCompactSummary({ title: 'Release checklist' }, [
    { role: 'assistant', text: 'The notes are ready.' },
    { role: 'user', text: 'Please   check the release notes.' },
  ]);
  assert.equal(seed, [
    'Conversation title: Release checklist',
    'Carry-over summary (latest turns first in source, normalized below):',
    '- User: Please check the release notes.',
    '- Assistant: The notes are ready.',
  ].join('\n'));
  assert.equal(buildCompactSummary({ title: '' }, []).split('\n').at(-1), '- No prior text messages were available.');
});
