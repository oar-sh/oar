import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REMOTE_PROMPT_HEADER_PATTERN,
  REMOTE_RELAY_ERROR_CODES as CODES,
  REMOTE_RELAY_LIMITS,
} from '../../shared/remote-relay-contract.mjs';
import { RemoteRelayError, createRemoteRelayClient } from './remote-relay-client.mjs';
import {
  REMOTE_RELAY_INTERNAL_ERROR_CODE,
  createRemoteRelayDispatcher,
  settleRemoteReply,
} from './remote-relay-dispatcher.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const LINUX = Object.freeze({
  id: 'rr_linux',
  relayId: 'relay-linux-id',
  name: 'linux-test',
  url: 'https://relay-b.example.test',
  tokenMode: 'own',
  permission: 'full',
  lastStatus: 'online',
  version: '0.9.4',
  protocol: 1,
});
const SPARE = Object.freeze({
  id: 'rr_spare',
  relayId: 'relay-spare-id',
  name: 'spare-test',
  url: 'https://relay-c.example.test',
  tokenMode: 'own',
  permission: 'read',
  lastStatus: 'offline',
  version: '0.9.3',
  protocol: 1,
});

const PROMPT = 'Please rebuild the sidebar polish widgets and report back';

function hostOf(url) {
  return new URL(url).hostname;
}

function createRegistry(relays) {
  return {
    list: () => relays,
    resolve(nameOrAlias) {
      const query = String(nameOrAlias || '').replace(/^@/, '').toLowerCase();
      const matches = relays.filter((relay) => relay.name.toLowerCase() === query || hostOf(relay.url) === query);
      if (matches.length === 1) return { relay: matches[0] };
      if (matches.length > 1) return { error: 'ambiguous', names: matches.map((relay) => relay.name) };
      return { error: 'unknown', names: relays.map((relay) => relay.name) };
    },
    selfIdentity: () => ({
      relayId: 'relay-self-id',
      name: 'win-test',
      version: '0.9.4',
      platform: 'linux',
      publicUrl: 'https://relay-a.example.test',
      remoteRelays: { protocol: 1, inbound: true },
    }),
    selfName: () => 'win-test',
  };
}

function remoteError(code, message, status = null, remoteBody = null) {
  return new RemoteRelayError(code, message, { status, remoteBody, remoteError: remoteBody?.error || null });
}

/**
 * A remote relay's API, reduced to what the dispatcher reads and writes.
 * `onRead(conv, query, count)` runs before each transcript read that waits
 * for a reply (afterMessageId), so a test can script a turn's progress.
 */
function createFakeRemote() {
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 8, 20, 10, 0, 0) + (tick++) * 1000).toISOString();
  const remote = {
    calls: [],
    conversations: new Map(),
    questions: new Map(),
    failures: new Map(),
    onRead: null,
    onMessage: null,
    duplicateNext: false,
    readCounts: new Map(),
    identity: {
      relayId: 'relay-linux-id',
      name: 'linux-test',
      version: '0.9.4',
      platform: 'linux',
      publicUrl: 'https://relay-b.example.test',
      remoteRelays: { protocol: 1, inbound: true },
    },
    status: {
      version: '0.9.4',
      platform: 'linux',
      defaultModel: 'gpt-5.6-luna',
      supportedRelayModes: ['plan', 'ask', 'agent', 'autopilot'],
      defaultRelayMode: 'agent',
      workspaceRootPath: '/home/dev/work',
      defaultSessionWorkspaceRootPath: '/home/dev/work/default',
      recentWorkspaceRoots: ['/home/dev/work', '/home/dev/other'],
      pendingCount: 0,
      processingCount: 0,
      parkedCount: 0,
      sessionWorker: { workers: [] },
    },
    models: {
      models: ['gpt-5.6-luna', 'claude-sonnet-5', 'composer-2.5', 'gpt-4o'],
      defaultModel: 'gpt-5.6-luna',
      currentModel: 'gpt-5.6-luna',
      providersByModel: {
        'claude-sonnet-5': ['github-copilot', 'claude'],
        'composer-2.5': ['cursor'],
        'gpt-4o': ['openai-byok'],
      },
    },
    settings: {
      claude: { configured: true, enabled: true, model: 'claude-sonnet-5', models: ['claude-sonnet-5', 'claude-opus-5'], availableModels: [] },
      cursor: { configured: false, enabled: false, model: 'composer-2.5', models: [], availableModels: [] },
      grok: { configured: false, enabled: false, model: 'grok-4.5', models: [], availableModels: [] },
      openai: { configured: true, enabled: true, model: 'gpt-4o' },
      copilot: { engine: 'sdk', engines: ['extension', 'sdk'] },
    },
    // The efforts the remote's model takes (null: it takes any), and whether a
    // route refuses another one (as the OpenAI provider does) or falls back to
    // its default (as the other providers do).
    efforts: { supported: null, strictBootstrap: false, strictMessage: false },
    stamp,

    resolveEffort(relay, requested, { strict, withCode }) {
      const supported = remote.efforts.supported;
      const effort = String(requested || '').trim().toLowerCase();
      if (!supported) return effort;
      const fallback = supported.includes('none') ? 'none' : supported[0];
      if (!effort || supported.includes(effort)) return effort || fallback;
      if (!strict) return fallback;
      const error = `Reasoning effort "${effort}" is not supported`;
      throw remoteError(`${CODES.httpPrefix}400`, `Relay "${relay.name}" answered HTTP 400: ${error}`, 400, {
        ...(withCode ? { ok: false, code: 'REASONING_EFFORT_UNSUPPORTED' } : {}),
        error,
        supportedReasoningEfforts: [...supported],
      });
    },
    addConversation(input) {
      const conv = {
        provider: 'claude',
        model: 'claude-sonnet-5',
        mode: 'agent',
        cwd: '/home/dev/work',
        messages: [],
        inFlight: null,
        activeTurn: false,
        reportActiveTurn: true,
        archived: false,
        updatedAt: stamp(),
        ...input,
      };
      remote.conversations.set(conv.id, conv);
      return conv;
    },
    addMessage(convId, message) {
      const conv = remote.conversations.get(convId);
      const row = { timestamp: stamp(), activities: [], ...message };
      conv.messages.push(row);
      conv.updatedAt = row.timestamp;
      return row;
    },
    reply(convId, { sourceMessageId, text = 'All widgets rebuilt.', kind, model = 'claude-sonnet-5', id } = {}) {
      return remote.addMessage(convId, {
        id: id || `reply-${tick}`,
        role: 'assistant',
        text,
        model,
        sourceMessageId,
        ...(kind ? { kind } : {}),
      });
    },
    addQuestion(question) {
      const row = {
        status: 'pending',
        choices: [],
        context: null,
        allowFreeform: true,
        requestSchema: null,
        sdkSessionId: 'sdk-remote-1',
        messageId: 'm-asked',
        expiresAt: '2026-09-20T18:00:00.000Z',
        ...question,
      };
      remote.questions.set(row.id, row);
      return row;
    },
    fail(method, path, error) {
      remote.failures.set(`${method} ${path}`, error);
    },
    callsTo(method, path) {
      return remote.calls.filter((entry) => entry.method === method && entry.path === path);
    },

    async request(relay, method, path, { body, query = {}, hops } = {}) {
      remote.calls.push({ relay: relay.name, method, path, body, query, hops });
      const failure = remote.failures.get(`${method} ${path}`);
      if (failure) throw failure;
      const notFound = () => remoteError(CODES.notFound, `Relay "${relay.name}": not found`, 404);

      if (method === 'GET' && path === '/api/relay/identity') return remote.identity;
      if (method === 'GET' && path === '/api/status') return remote.status;
      if (method === 'GET' && path === '/api/models') return remote.models;
      const settingsMatch = /^\/api\/settings\/([\w-]+)$/.exec(path);
      if (method === 'GET' && settingsMatch) {
        const settings = remote.settings[settingsMatch[1]];
        if (!settings) throw notFound();
        return settings;
      }

      if (method === 'GET' && path === '/api/conversations') {
        const ordered = [...remote.conversations.values()]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
        let start = 0;
        if (query.beforeConversationId) {
          start = ordered.findIndex((conv) => conv.id === query.beforeConversationId) + 1;
        }
        const limit = Number(query.limit) || 40;
        const rows = ordered.slice(start, start + limit);
        const last = rows[rows.length - 1];
        return {
          conversations: rows.map((conv) => ({
            id: conv.id,
            title: conv.title,
            activeTurn: conv.activeTurn === true,
            runtimeProviderType: conv.provider,
            runtimeProviderModel: conv.model,
            runtimeModel: conv.model,
            updatedAt: conv.updatedAt,
            messageCount: conv.messages.length,
            currentWorkspaceRootPath: conv.cwd,
            ...(conv.origin ? { origin: conv.origin } : {}),
          })),
          pageInfo: {
            hasMore: start + limit < ordered.length,
            nextCursor: last ? { beforeConversationId: last.id, beforeUpdatedAt: last.updatedAt } : null,
          },
        };
      }

      const convMatch = /^\/api\/conversation\/([^/]+)(\/[\w-]+)?$/.exec(path);
      if (convMatch && convMatch[1] !== 'bootstrap') {
        const conv = remote.conversations.get(decodeURIComponent(convMatch[1]));
        if (!conv) throw notFound();
        const suffix = convMatch[2] || '';
        if (method === 'GET' && !suffix) {
          if (query.afterMessageId) {
            const count = (remote.readCounts.get(conv.id) || 0) + 1;
            remote.readCounts.set(conv.id, count);
            remote.onRead?.(conv, query, count);
          }
          const limit = Number(query.limit) || 20;
          let page;
          if (query.afterMessageId) {
            const index = conv.messages.findIndex((row) => row.id === query.afterMessageId);
            page = index < 0 ? [] : conv.messages.slice(index + 1, index + 1 + limit);
          } else if (query.aroundMessageId) {
            page = conv.messages.filter((row) => row.id === query.aroundMessageId);
          } else {
            const end = query.beforeMessageId
              ? conv.messages.findIndex((row) => row.id === query.beforeMessageId)
              : conv.messages.length;
            page = conv.messages.slice(Math.max(0, end - limit), end);
          }
          const firstIndex = page.length ? conv.messages.indexOf(page[0]) : -1;
          return {
            id: conv.id,
            title: conv.title,
            archived: conv.archived,
            currentWorkspaceRootPath: conv.cwd,
            runtimeSession: { providerType: conv.provider, providerModel: conv.model, model: conv.model },
            preferredModel: conv.model,
            preferredRelayMode: conv.mode,
            preferredReasoningEffort: conv.effort || '',
            inFlight: conv.inFlight,
            ...(conv.reportActiveTurn ? { activeTurn: conv.activeTurn } : {}),
            ...(conv.origin ? { origin: conv.origin } : {}),
            backgroundTasks: conv.backgroundTasks || [],
            messages: page,
            pageInfo: {
              hasMoreOlder: firstIndex > 0,
              olderCursor: page.length ? { beforeMessageId: page[0].id, beforeTimestamp: page[0].timestamp } : null,
            },
          };
        }
        if (method === 'POST' && suffix === '/cancel-turn') {
          if (!conv.inFlight) return { ok: true, queued: false, acknowledgement: 'no-active-turn', activeMessageId: null };
          return { ok: true, queued: true, acknowledgement: 'stop-queued', activeMessageId: conv.inFlight.messageId };
        }
        if (method === 'POST' && suffix === '/archive') {
          conv.archived = true;
          return { ok: true };
        }
      }

      if (method === 'POST' && path === '/api/conversation/bootstrap') {
        const effort = remote.resolveEffort(relay, body.reasoningEffort, { strict: remote.efforts.strictBootstrap, withCode: true });
        const id = `conv-new-${remote.conversations.size + 1}`;
        remote.addConversation({
          id,
          title: body.title,
          provider: body.providerType,
          model: body.model,
          mode: body.relayMode,
          effort,
          origin: body.origin,
        });
        return {
          ok: true,
          conversationId: id,
          selectedModel: body.model,
          selectedProviderType: body.providerType,
          preferredRelayMode: body.relayMode,
          preferredReasoningEffort: effort,
        };
      }

      if (method === 'POST' && path === '/api/message') {
        const conv = remote.conversations.get(body.conversationId);
        if (!conv) throw notFound();
        if (remote.duplicateNext) {
          remote.duplicateNext = false;
          return { ok: true, duplicate: true, duplicateOfMessageId: 'm-earlier', conversationId: conv.id };
        }
        // The real route refuses a messageId it already stored.
        if (conv.messages.some((row) => row.id === body.messageId)) {
          throw remoteError(`${CODES.httpPrefix}409`, `Relay "${relay.name}" answered HTTP 409: Message already exists`, 409, {
            error: 'Message already exists',
            code: 'DUPLICATE_MESSAGE_ID',
            messageId: body.messageId,
            conversationId: conv.id,
          });
        }
        // The message route sends its effort refusal without a code.
        const effort = remote.resolveEffort(relay, body.reasoningEffort, { strict: remote.efforts.strictMessage, withCode: false });
        remote.addMessage(conv.id, {
          id: body.messageId,
          role: 'user',
          text: body.text,
          model: body.model,
          mode: body.relayMode,
          effort,
          origin: body.origin,
        });
        conv.activeTurn = true;
        remote.onMessage?.(conv, body);
        return { ok: true, messageId: body.messageId, conversationId: conv.id, selectedReasoningEffort: effort || null };
      }

      if (method === 'GET' && path === '/api/relay-questions') {
        return {
          questions: [...remote.questions.values()].filter((question) => question.status === query.status
            && (!query.conversationId || question.conversationId === query.conversationId)),
        };
      }
      const questionMatch = /^\/api\/relay-question\/([^/]+)(\/answer)?$/.exec(path);
      if (questionMatch) {
        const question = remote.questions.get(decodeURIComponent(questionMatch[1]));
        if (!question) throw notFound();
        if (method === 'GET' && !questionMatch[2]) return { question };
        if (method === 'POST' && questionMatch[2]) {
          if ((question.sdkSessionId || null) !== (body.sdk_session_id || null)) {
            throw remoteError(`${CODES.httpPrefix}403`, 'Relay answered HTTP 403: session mismatch', 403, { error: 'session mismatch' });
          }
          question.status = 'answered';
          question.answer = body.answer ?? JSON.stringify(body.structuredAnswer);
          return { ok: true, question };
        }
      }
      throw notFound();
    },
  };
  return remote;
}

function setup({
  relays = [LINUX, SPARE],
  unlocked = ['rr_linux', 'rr_spare'],
  // Relays (by instance id) whose agents wrote to conversation c-1.
  contacts = [],
  // `{ latest }`: the id of the user's latest own message in c-1.
  humans = { latest: null },
  caller = {},
  requestApproval,
  remote = createFakeRemote(),
  getCallerContext,
  resolveConversationId,
} = {}) {
  const unlocks = new Set(unlocked.map((relayId) => `c-1:${relayId}`));
  const repository = {
    hasUnlock: (conversationId, relayId) => unlocks.has(`${conversationId}:${relayId}`),
    hasContactFrom: (conversationId, instanceId) => conversationId === 'c-1' && contacts.includes(instanceId),
    latestHumanMessageId: () => humans.latest,
  };
  const logs = [];
  const events = [];
  const approvals = [];
  const sleeps = [];
  const clock = { now: Date.parse('2026-09-20T10:00:00.000Z') };
  let uuidCounter = 0;
  const dispatcher = createRemoteRelayDispatcher({
    registry: createRegistry(relays),
    client: { request: (...args) => remote.request(...args) },
    repository,
    getCallerContext: getCallerContext || (async (conversationId) => ({
      conversationId,
      title: 'report builder',
      provider: 'claude',
      model: 'claude-sonnet-5',
      mode: 'agent',
      processingRowId: 'q-1',
      userMessageId: 'q-1',
      hops: 0,
      ...caller,
    })),
    requestApproval: requestApproval || (async (request) => {
      approvals.push(request);
      return true;
    }),
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
    logger: { log: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)) },
    emitStatusEvent: (event) => events.push(event),
    pollIntervalMs: 2000,
    randomUUID: () => `m-sent-${++uuidCounter}`,
    ...(resolveConversationId ? { resolveConversationId } : {}),
  });
  const run = (action, args = {}, conversationId = 'c-1') => dispatcher.dispatch({ conversationId, action, args });
  return { remote, dispatcher, run, logs, events, approvals, sleeps, clock, unlocks };
}

function withSession(remote, overrides = {}) {
  remote.addConversation({ id: 'conv-1', title: 'sidebar polish', ...overrides });
  remote.addMessage('conv-1', { id: 'm-old-user', role: 'user', text: 'Earlier question' });
  remote.addMessage('conv-1', { id: 'm-old-reply', role: 'assistant', text: 'Earlier answer', sourceMessageId: 'm-old-user', model: 'claude-sonnet-5' });
  return remote.conversations.get('conv-1');
}

// ─── Validation, list_relays, resolution ─────────────────────────────────────

test('invalid input and a missing conversation id answer 400 before anything else', async () => {
  const { run, dispatcher, remote } = setup();
  const unknown = await run('explode', { relay: 'linux-test' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, CODES.invalidInput);

  const noText = await run('send', { relay: 'linux-test', session: 'conv-1' });
  assert.equal(noText.status, 400);
  assert.match(noText.body.error, /needs text/);

  const noConversation = await dispatcher.dispatch({ action: 'list_relays', args: {} });
  assert.equal(noConversation.status, 400);
  assert.match(noConversation.body.error, /conversationId/);
  assert.equal(remote.calls.length, 0);
});

test('list_relays needs no unlock and reports each relay with its unlock state', async () => {
  const { run, remote } = setup({ unlocked: ['rr_linux'] });
  const result = await run('list_relays');
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.deepEqual(result.body.self, { name: 'win-test' });
  assert.deepEqual(result.body.relays, [
    { name: 'linux-test', url: 'https://relay-b.example.test', online: true, version: '0.9.4', permission: 'full', unlocked: true },
    { name: 'spare-test', url: 'https://relay-c.example.test', online: false, version: '0.9.3', permission: 'read', unlocked: false },
  ]);
  assert.match(result.body.hint, /@name/);
  assert.match(result.body.summary, /2 relays, 1 unlocked/);
  assert.equal(remote.calls.length, 0, 'list_relays is local only');
  assert.ok(!JSON.stringify(result.body).includes('token'));
});

test('an unknown or ambiguous relay answers REMOTE_RELAY_UNKNOWN with the known names', async () => {
  const { run } = setup();
  const unknown = await run('relay_info', { relay: 'nowhere' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, CODES.unknown);
  assert.deepEqual(unknown.body.relays, ['linux-test', 'spare-test']);
  assert.match(unknown.body.error, /linux-test, spare-test/);

  const twins = [LINUX, { ...SPARE, name: 'linux-test' }];
  const ambiguous = await setup({ relays: twins }).run('relay_info', { relay: 'linux-test' });
  assert.equal(ambiguous.status, 404);
  assert.match(ambiguous.body.error, /several relays/);
});

test('a relay the conversation has not mentioned is locked', async () => {
  const { run, remote, logs, events } = setup({ unlocked: [] });
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, CODES.locked);
  assert.equal(
    result.body.error,
    'Relay "linux-test" is locked in this conversation. Ask the user to mention @linux-test (or its name) in a message to allow work there.',
  );
  assert.equal(remote.calls.length, 0);
  assert.equal(logs.length, 1, 'a refused write action is still logged');
  assert.match(logs[0], /^\[remote-relays\] send linux-test conv-1 → REMOTE_RELAY_LOCKED/);
  assert.equal(events[0].result, CODES.locked);
  assert.equal(events[0].ok, false);
});

test('a call named by SDK session id is mapped to its conversation before the gate', async () => {
  const seen = [];
  const { run, dispatcher } = setup({
    resolveConversationId: (id) => (id === 'sdk-legacy-1' ? 'c-1' : id),
    getCallerContext: async (conversationId) => {
      seen.push(conversationId);
      return { conversationId, title: 'report builder', provider: 'claude', model: 'claude-sonnet-5', mode: 'agent', processingRowId: 'q-1', userMessageId: 'q-1', hops: 0 };
    },
  });
  const listed = await run('list_relays', {}, 'sdk-legacy-1');
  assert.equal(listed.body.relays[0].unlocked, true, 'the unlock of c-1 applies');
  const result = await run('relay_info', { relay: 'linux-test' }, 'sdk-legacy-1');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(seen, ['c-1']);
  assert.equal(dispatcher.inflight('sdk-legacy-1'), 0);
});

test('without unlock storage every relay stays locked', async () => {
  const remote = createFakeRemote();
  const dispatcher = createRemoteRelayDispatcher({
    registry: createRegistry([LINUX]),
    client: { request: (...args) => remote.request(...args) },
    repository: null,
    logger: { log() {}, warn() {} },
  });
  const listed = await dispatcher.dispatch({ conversationId: 'c-1', action: 'list_relays', args: {} });
  assert.equal(listed.body.relays[0].unlocked, false);
  const refused = await dispatcher.dispatch({ conversationId: 'c-1', action: 'relay_info', args: { relay: 'linux-test' } });
  assert.equal(refused.body.code, CODES.locked);
  assert.equal(remote.calls.length, 0);
});

test('the permission level limits actions: read refuses send, prompt refuses create_session', async () => {
  const readOnly = setup({ relays: [{ ...LINUX, permission: 'read' }] });
  withSession(readOnly.remote);
  const refused = await readOnly.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, CODES.forbidden);
  assert.equal(refused.body.permission, 'read');
  assert.match(refused.body.error, /permission "read"/);
  const read = await readOnly.run('read_session', { relay: 'linux-test', session: 'conv-1' });
  assert.equal(read.status, 200);

  const promptOnly = setup({ relays: [{ ...LINUX, permission: 'prompt' }] });
  const noCreate = await promptOnly.run('create_session', { relay: 'linux-test', text: PROMPT });
  assert.equal(noCreate.status, 403);
  assert.match(noCreate.body.error, /create_session needs "full"/);
  assert.equal(promptOnly.remote.calls.length, 0);
});

// ─── Hops, rate limits, approval, in-flight ──────────────────────────────────

test('the hop count grows by one per relay', async () => {
  const forwarded = setup({ caller: { hops: 1 } });
  withSession(forwarded.remote);
  const ok = await forwarded.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });
  assert.equal(ok.status, 200);
  const post = forwarded.remote.callsTo('POST', '/api/message')[0];
  assert.equal(post.hops, 2);
  assert.equal(post.body.origin.hops, 2);
  assert.ok(forwarded.remote.calls.every((entry) => entry.hops === 2), 'every call carries the outgoing hop count');
});

test('a relay the user unlocked stays in reach whatever prompts arrive', async () => {
  // The turn acts on a prompt that crossed two relays already, from a relay
  // that is not the one being called.
  const { run, remote } = setup({
    unlocked: ['rr_linux'],
    caller: { hops: REMOTE_RELAY_LIMITS.hopLimit, originRelayIds: [SPARE.relayId] },
  });
  withSession(remote);
  const sent = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(remote.callsTo('POST', '/api/message')[0].hops, REMOTE_RELAY_LIMITS.hopLimit + 1);
});

test('the relay a prompt came from is open without a mention and may always be answered', async () => {
  const { run, remote } = setup({
    unlocked: [],
    contacts: [LINUX.relayId],
    caller: { hops: REMOTE_RELAY_LIMITS.hopLimit + 3, originRelayIds: [LINUX.relayId] },
  });
  withSession(remote);
  const listed = await run('list_relays');
  assert.deepEqual(listed.body.relays.map((relay) => relay.unlocked), [true, false]);
  const sent = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  // The relay that never wrote here stays locked.
  const other = await run('relay_info', { relay: 'spare-test' });
  assert.equal(other.body.code, CODES.locked);
});

test('the hop limit stops a prompt on its way to a third relay, and reading is never limited', async () => {
  // linux-test wrote to this conversation earlier, so it is open; the turn
  // acts on a prompt from spare-test that crossed two relays.
  const { run, remote } = setup({
    relays: [LINUX, { ...SPARE, permission: 'full' }],
    unlocked: [],
    contacts: [LINUX.relayId, SPARE.relayId],
    caller: { hops: REMOTE_RELAY_LIMITS.hopLimit, originRelayIds: [SPARE.relayId] },
  });
  withSession(remote);
  const refused = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, CODES.hopLimit);
  assert.match(refused.body.error, /mentioning @linux-test/);
  assert.equal(remote.callsTo('POST', '/api/message').length, 0);

  const read = await run('read_session', { relay: 'linux-test', session: 'conv-1' });
  assert.equal(read.status, 200, JSON.stringify(read.body));

  // Prompts from two relays in one turn: answering one of them passes the
  // other's words on.
  const mixed = setup({
    unlocked: [],
    contacts: [LINUX.relayId],
    caller: { hops: REMOTE_RELAY_LIMITS.hopLimit, originRelayIds: [LINUX.relayId, SPARE.relayId] },
  });
  withSession(mixed.remote);
  const alsoRefused = await mixed.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });
  assert.equal(alsoRefused.body.code, CODES.hopLimit);
});

test('after 30 prompts to other agents without a word from the user, the user is asked', async () => {
  const humans = { latest: 'm-human-1' };
  const { run, remote, approvals, clock } = setup({ humans });
  withSession(remote);
  const send = async () => {
    clock.now += 61_000; // stay clear of the per-minute limits
    return run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });
  };
  for (let index = 0; index < REMOTE_RELAY_LIMITS.agentPromptsBeforeAsking; index += 1) {
    assert.equal((await send()).status, 200);
  }
  assert.equal(approvals.length, 0, 'agent mode asks for nothing until the count is reached');
  // Reading does not count and is not asked for.
  assert.equal((await run('read_session', { relay: 'linux-test', session: 'conv-1' })).status, 200);
  assert.equal(approvals.length, 0);

  assert.equal((await send()).status, 200);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].agentPrompts, REMOTE_RELAY_LIMITS.agentPromptsBeforeAsking);
  // Allowed: the count starts again.
  assert.equal((await send()).status, 200);
  assert.equal(approvals.length, 1);
});

test('a message from the user starts the count of agent prompts again, and a Deny refuses', async () => {
  const humans = { latest: 'm-human-1' };
  const denied = [];
  const { run, remote, clock } = setup({
    humans,
    requestApproval: async (request) => {
      denied.push(request);
      return { approved: false };
    },
  });
  withSession(remote);
  const send = async () => {
    clock.now += 61_000;
    return run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });
  };
  for (let index = 0; index < REMOTE_RELAY_LIMITS.agentPromptsBeforeAsking; index += 1) await send();
  const refused = await send();
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, CODES.approvalDenied);
  assert.match(refused.body.error, /did not allow more/);
  assert.equal(denied.length, 1);
  const posted = remote.callsTo('POST', '/api/message').length;
  assert.equal(posted, REMOTE_RELAY_LIMITS.agentPromptsBeforeAsking);

  humans.latest = 'm-human-2';
  assert.equal((await send()).status, 200);
  assert.equal(denied.length, 1, 'no card after the user wrote');
});

test('writes are limited to 10 a minute per conversation, calls to 60', async () => {
  const { run, clock, remote } = setup();
  withSession(remote);
  for (let index = 0; index < REMOTE_RELAY_LIMITS.writesPerMinute; index += 1) {
    const result = await run('stop', { relay: 'linux-test', session: 'conv-1' });
    assert.equal(result.status, 200, `write ${index + 1}`);
    clock.now += 1000;
  }
  const limited = await run('stop', { relay: 'linux-test', session: 'conv-1' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, CODES.rateLimited);
  assert.equal(limited.body.retryAfterSeconds, 50);
  const otherConversation = await run('list_sessions', { relay: 'linux-test' });
  assert.equal(otherConversation.status, 200, 'reads still pass under the write limit');

  clock.now += 60_000;
  assert.equal((await run('stop', { relay: 'linux-test', session: 'conv-1' })).status, 200, 'the window slides');

  const reads = setup();
  withSession(reads.remote);
  for (let index = 0; index < REMOTE_RELAY_LIMITS.callsPerMinute; index += 1) {
    assert.equal((await reads.run('list_sessions', { relay: 'linux-test' })).status, 200);
  }
  const tooMany = await reads.run('list_sessions', { relay: 'linux-test' });
  assert.equal(tooMany.status, 429);
  const elsewhere = await reads.dispatcher.dispatch({ conversationId: 'c-2', action: 'list_relays', args: {} });
  assert.equal(elsewhere.status, 200);
});

test('ask and plan mode put write actions behind the approval card; reads never ask', async () => {
  const { run, approvals, remote } = setup({ caller: { mode: 'ask' } });
  withSession(remote);
  const read = await run('read_session', { relay: 'linux-test', session: 'conv-1' });
  assert.equal(read.status, 200);
  assert.equal(approvals.length, 0);

  const sent = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });
  assert.equal(sent.status, 200);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].action, 'send');
  assert.equal(approvals[0].conversationId, 'c-1');
  assert.deepEqual(approvals[0].relay, { id: 'rr_linux', name: 'linux-test', url: 'https://relay-b.example.test' });
  assert.equal(approvals[0].args.text, PROMPT);
  assert.equal(approvals[0].callerContext.processingRowId, 'q-1');
  assert.match(approvals[0].summary, /^send → linux-test session conv-1/);

  const agentMode = setup({ caller: { mode: 'agent' } });
  withSession(agentMode.remote);
  await agentMode.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });
  assert.equal(agentMode.approvals.length, 0, 'agent mode does not ask');
});

test('a denied or impossible approval refuses the write without touching the remote', async () => {
  const denied = setup({ caller: { mode: 'plan' }, requestApproval: async () => false });
  withSession(denied.remote);
  const result = await denied.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, CODES.approvalDenied);
  assert.equal(denied.remote.calls.length, 0);
  assert.match(denied.logs[0], /send linux-test conv-1 → REMOTE_RELAY_APPROVAL_DENIED/);

  const offTurn = setup({
    caller: { mode: 'ask', processingRowId: null },
    requestApproval: async () => ({ approved: false, code: CODES.noTurn, error: 'no running turn' }),
  });
  const noTurn = await offTurn.run('archive', { relay: 'linux-test', session: 'conv-1' });
  assert.equal(noTurn.status, 403);
  assert.equal(noTurn.body.code, CODES.noTurn);
  assert.equal(noTurn.body.error, 'no running turn');

  const allowed = setup({ caller: { mode: 'ask' }, requestApproval: async () => ({ approved: true }) });
  withSession(allowed.remote);
  assert.equal((await allowed.run('archive', { relay: 'linux-test', session: 'conv-1' })).status, 200);
});

test('the in-flight count covers the approval wait and drops back afterwards', async () => {
  let release;
  const decision = new Promise((resolve) => { release = resolve; });
  let asked;
  const asking = new Promise((resolve) => { asked = resolve; });
  const { dispatcher, remote } = setup({
    caller: { mode: 'ask' },
    requestApproval: async () => {
      asked();
      return decision;
    },
  });
  withSession(remote);
  assert.equal(dispatcher.inflight('c-1'), 0);
  const pending = dispatcher.dispatch({ conversationId: 'c-1', action: 'stop', args: { relay: 'linux-test', session: 'conv-1' } });
  await asking;
  assert.equal(dispatcher.inflight('c-1'), 1);
  assert.equal(dispatcher.inflight('c-2'), 0);
  release(true);
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(dispatcher.inflight('c-1'), 0);
});

// ─── send / wait: reply detection ────────────────────────────────────────────

test('send queues a prompt with the header and origin, then returns the reply', async () => {
  const { run, remote, sleeps } = setup({ caller: { mode: 'autopilot' } });
  withSession(remote);
  remote.onRead = (conv, query, count) => {
    if (count === 3) {
      remote.reply('conv-1', { sourceMessageId: query.afterMessageId, text: 'All widgets rebuilt.' });
      conv.activeTurn = false;
    }
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.relay, 'linux-test');
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.session, 'conv-1');
  assert.equal(result.body.message_id, 'm-sent-1');
  assert.equal(result.body.reply.text, 'All widgets rebuilt.');
  assert.equal(result.body.reply.model, 'claude-sonnet-5');
  assert.equal(result.body.openUrl, 'https://relay-b.example.test/?conv=conv-1');
  assert.equal(result.body.summary, 'send → linux-test session conv-1: done');
  assert.deepEqual(sleeps, [2000, 2000]);

  const post = remote.callsTo('POST', '/api/message')[0].body;
  assert.equal(post.conversationId, 'conv-1');
  assert.equal(post.messageId, 'm-sent-1');
  assert.match(post.text, REMOTE_PROMPT_HEADER_PATTERN);
  assert.ok(post.text.endsWith(`\n\n${PROMPT}`));
  assert.match(post.text, /relay "win-test" · session "report builder" · claude-sonnet-5 · acting for the user/);
  assert.deepEqual(post.origin, {
    kind: 'agent',
    relayId: 'relay-self-id',
    relayName: 'win-test',
    relayUrl: 'https://relay-a.example.test',
    conversationId: 'c-1',
    conversationTitle: 'report builder',
    provider: 'claude',
    model: 'claude-sonnet-5',
    hops: 1,
  });
  assert.equal(post.model, 'claude-sonnet-5', 'the session keeps the model it already uses');
  assert.equal(post.relayMode, 'autopilot', 'the caller\'s mode by default');
});

test('send with wait_seconds 0 only queues; a duplicate is reported as such', async () => {
  const { run, remote } = setup();
  withSession(remote);
  const queued = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0, model: 'claude-opus-5', mode: 'plan' });
  assert.equal(queued.body.status, 'queued');
  assert.equal(queued.body.message_id, 'm-sent-1');
  assert.equal(remote.readCounts.get('conv-1'), undefined, 'no polling');
  const post = remote.callsTo('POST', '/api/message')[0].body;
  assert.equal(post.model, 'claude-opus-5');
  assert.equal(post.relayMode, 'plan');

  remote.duplicateNext = true;
  const duplicate = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(duplicate.body.status, 'duplicate');
  assert.equal(duplicate.body.message_id, 'm-earlier');
  assert.match(duplicate.body.note, /identical message/);
});

test('if_busy "fail" refuses a session with a turn in flight', async () => {
  const { run, remote } = setup();
  withSession(remote, { inFlight: { messageId: 'm-old-user', status: 'processing', streamEvents: [], activities: [] } });
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, if_busy: 'fail' });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, CODES.busy);
  assert.equal(result.body.progress.turnMessageId, 'm-old-user');
  assert.equal(remote.callsTo('POST', '/api/message').length, 0);
  const queued = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });
  assert.equal(queued.body.status, 'queued', 'the default queues (steers) instead');
});

test('a folded steer settles with the reply of the turn it joined', async () => {
  const { run, remote } = setup();
  withSession(remote, { inFlight: { messageId: 'm-old-user', streamEvents: [], activities: [] } });
  remote.onRead = (conv, query, count) => {
    if (count === 1) remote.reply('conv-1', { sourceMessageId: query.afterMessageId, kind: 'folded', text: '_(Handled together…)_' });
    if (count === 2) {
      remote.reply('conv-1', { sourceMessageId: 'm-old-user', text: 'Covered both requests.' });
      conv.inFlight = null;
      conv.activeTurn = false;
    }
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.reply.text, 'Covered both requests.');
  assert.equal(result.body.reply.folded, true);
  assert.match(result.body.note, /steered into the turn/);
});

test('a message answered in a background turn settles with that turn’s reply, never with the marker', async () => {
  // The remote published the answer on a continuation row and closed the
  // message afterwards with a marker that points at it. The marker tells a
  // human to resend: handed over as the reply, it would make the calling
  // agent run the prompt a second time.
  const { run, remote } = setup();
  withSession(remote);
  remote.onRead = (conv, query, count) => {
    if (count === 1) remote.reply('conv-1', { kind: 'continuation', text: 'The export now covers CSV and PDF.' });
    if (count === 2) {
      remote.reply('conv-1', {
        sourceMessageId: query.afterMessageId,
        kind: 'answered-elsewhere',
        text: '_(Answered in the reply marked “background continuation” next to this message. Resend the message if that reply does not answer it.)_',
      });
      conv.activeTurn = false;
    }
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.reply.text, 'The export now covers CSV and PDF.');
  assert.equal(result.body.reply.answeredElsewhere, true);
  assert.match(result.body.note, /published the answer to this message as a background turn/);
  assert.equal(JSON.stringify(result.body).includes('Resend'), false, 'the pointer text reaches no caller');
});

test('settleRemoteReply resolves an answered-elsewhere marker to the continuation reply before it', () => {
  const marker = { id: 'r-marker', role: 'assistant', sourceMessageId: 'm-1', kind: 'answered-elsewhere', text: '_(Answered in the reply marked…)_' };
  const settled = settleRemoteReply([
    { id: 'r-older', role: 'assistant', kind: 'continuation', text: 'An earlier background report.' },
    { id: 'r-plain', role: 'assistant', sourceMessageId: 'm-0', text: 'Someone else\'s answer.' },
    { id: 'r-answer', role: 'assistant', kind: 'continuation', text: 'The answer.' },
    { id: 'r-stub', role: 'assistant', sourceMessageId: 'm-0b', kind: 'folded', text: 'stub' },
    marker,
    { id: 'r-later', role: 'assistant', kind: 'continuation', text: 'A later background report.' },
  ], 'm-1');
  assert.equal(settled.status, 'done');
  assert.equal(settled.reply.messageId, 'r-answer', 'the nearest continuation reply before the marker');
  assert.equal(settled.reply.text, 'The answer.');

  // Nothing to point at: done, without a reply, and no hint to send again.
  const bare = settleRemoteReply([
    { id: 'r-plain', role: 'assistant', sourceMessageId: 'm-0', text: 'Someone else\'s answer.' },
    marker,
    { id: 'r-later', role: 'assistant', kind: 'continuation', text: 'A later background report.' },
  ], 'm-1');
  assert.equal(bare.status, 'done');
  assert.equal(bare.reply, undefined);
  assert.match(bare.note, /read_session/);
  assert.match(bare.note, /Do not send the message again/);

  const failed = settleRemoteReply([
    { id: 'r-answer', role: 'assistant', kind: 'continuation', text: 'The Grok CLI is not installed. Error code: relay.grok-cli-missing. Install it on the relay host.' },
    marker,
  ], 'm-1');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reply.messageId, 'r-answer');
});

test('an interim reply with background work waits for the follow-up and returns it', async () => {
  const { run, remote } = setup();
  withSession(remote);
  remote.onRead = (conv, query, count) => {
    if (count === 1) {
      remote.reply('conv-1', { sourceMessageId: query.afterMessageId, text: 'Started the sleep loop in the background.' });
      conv.backgroundTasks = [{ taskId: 'task-1', description: 'sleep loop', status: 'running' }];
    }
    if (count === 3) {
      // The task reported back: a follow-up turn answered for real.
      remote.reply('conv-1', { kind: 'continuation', text: 'DONE-LONG 10:07' });
      conv.backgroundTasks = [];
      conv.activeTurn = false;
    }
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.reply.text, 'DONE-LONG 10:07');
  assert.equal(result.body.reply.followUp, true);
  assert.equal(result.body.firstReply.text, 'Started the sleep loop in the background.');
  assert.match(result.body.note, /background/);
});

test('a follow-up turn in flight counts as work even when no background task was published', async () => {
  // Seen live: the agent answered "waiting for my translator", then went on in
  // a turn of its own (subagents, no published background task).
  const { run, remote } = setup();
  withSession(remote);
  remote.onRead = (conv, query, count) => {
    if (count === 1) {
      remote.reply('conv-1', { sourceMessageId: query.afterMessageId, text: 'One translator has not reported back yet.' });
      conv.inFlight = { messageId: 'cont-row-1', streamEvents: [{ seq: 1, text: 'Running the checks' }], activities: [] };
      conv.activeTurn = true;
    }
    if (count === 4) {
      remote.reply('conv-1', { kind: 'continuation', text: 'All five pages are deployed.' });
      conv.inFlight = null;
      conv.activeTurn = false;
    }
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.reply.text, 'All five pages are deployed.');
  assert.equal(result.body.firstReply.text, 'One translator has not reported back yet.');
});

test('a turn still in flight for the sent message itself is not taken for a follow-up', async () => {
  const { run, remote } = setup();
  withSession(remote);
  remote.onRead = (conv, query, count) => {
    if (count === 1) {
      remote.reply('conv-1', { sourceMessageId: query.afterMessageId, text: 'Here is the summary.' });
      // The reply is saved a moment before the relay clears the turn.
      conv.inFlight = { messageId: query.afterMessageId, streamEvents: [], activities: [] };
    }
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.reply.text, 'Here is the summary.');
  assert.equal(result.body.firstReply, undefined);
});

test('a quiet moment between two follow-up turns is not the end of the background work', async () => {
  const { run, remote } = setup();
  withSession(remote);
  remote.onRead = (conv, query, count) => {
    if (count === 1) {
      remote.reply('conv-1', { sourceMessageId: query.afterMessageId, text: 'Started sleep 1 of 2 in the background.' });
      conv.backgroundTasks = [{ taskId: 'task-1', description: 'sleep 1', status: 'running' }];
    }
    if (count === 3) {
      // Sleep 1 ended: its follow-up turn answered, and the next task is not
      // published yet: for a moment nothing looks busy.
      remote.reply('conv-1', { kind: 'continuation', text: 'Sleep 2 started.' });
      conv.backgroundTasks = [];
      conv.activeTurn = false;
    }
    if (count === 5) conv.backgroundTasks = [{ taskId: 'task-2', description: 'sleep 2', status: 'running' }];
    if (count === 9) {
      remote.reply('conv-1', { kind: 'continuation', text: 'DONE-LONG 10:12' });
      conv.backgroundTasks = [];
    }
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 600 });
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.reply.text, 'DONE-LONG 10:12');
  assert.equal(result.body.firstReply.text, 'Started sleep 1 of 2 in the background.');
});

test('background work that outlasts the wait comes back as running with the interim reply', async () => {
  const { run, remote } = setup();
  withSession(remote);
  remote.onRead = (conv, query, count) => {
    if (count === 1) {
      remote.reply('conv-1', { sourceMessageId: query.afterMessageId, text: 'Started the sleep loop in the background.' });
      conv.backgroundTasks = [{ taskId: 'task-1', description: 'sleep loop', status: 'running' }];
    }
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 10 });
  assert.equal(result.body.status, 'running');
  assert.equal(result.body.reply.text, 'Started the sleep loop in the background.');
  assert.deepEqual(result.body.background, { tasks: 1, running: ['sleep loop'] });
  assert.match(result.body.note, /call wait/i);

  // A later wait on the same message picks up the follow-up.
  const conv = remote.conversations.get('conv-1');
  remote.reply('conv-1', { kind: 'continuation', text: 'DONE-LONG 10:09' });
  conv.backgroundTasks = [];
  conv.activeTurn = false;
  const later = await run('wait', { relay: 'linux-test', session: 'conv-1', message_id: result.body.message_id });
  assert.equal(later.body.status, 'done');
  assert.equal(later.body.reply.text, 'DONE-LONG 10:09');
});

test('a later user message ends the follow-up: the reply to this message stands', async () => {
  const { run, remote } = setup();
  withSession(remote);
  remote.onRead = (conv, query, count) => {
    if (count === 1) {
      remote.reply('conv-1', { sourceMessageId: query.afterMessageId, text: 'Here is the summary.' });
      remote.addMessage('conv-1', { id: 'm-someone-else', role: 'user', text: 'next question' });
      conv.inFlight = { messageId: 'm-someone-else', streamEvents: [], activities: [] };
      conv.activeTurn = true;
    }
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.reply.text, 'Here is the summary.');
  assert.equal(result.body.firstReply, undefined);
});

test('an absorbed reply counts as the answer and says the turn continued', async () => {
  const { run, remote } = setup();
  withSession(remote);
  remote.onRead = (conv, query) => {
    remote.reply('conv-1', { sourceMessageId: query.afterMessageId, kind: 'absorbed', text: 'First half of the answer.' });
    remote.onRead = null;
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.reply.absorbed, true);
  assert.equal(result.body.reply.text, 'First half of the answer.');
  assert.match(result.body.note, /continued/);
});

test('stopped, failed and cancelled turns settle with their own status', async () => {
  const stopped = setup();
  withSession(stopped.remote);
  stopped.remote.onRead = (conv, query) => {
    stopped.remote.reply('conv-1', { sourceMessageId: query.afterMessageId, kind: 'stopped', text: '_(Stopped with the turn — not answered.)_' });
    stopped.remote.onRead = null;
  };
  assert.equal((await stopped.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT })).body.status, 'stopped');

  const failed = setup();
  withSession(failed.remote);
  failed.remote.onRead = (conv, query) => {
    failed.remote.reply('conv-1', {
      sourceMessageId: query.afterMessageId,
      text: 'The Grok CLI is not installed. Error code: relay.grok-cli-missing. Install it on the relay host.',
    });
    failed.remote.onRead = null;
  };
  const failure = await failed.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(failure.body.status, 'failed');
  assert.match(failure.body.reply.text, /relay\.grok-cli-missing/);

  const cancelled = setup();
  withSession(cancelled.remote);
  cancelled.remote.onRead = (conv) => { conv.activeTurn = false; };
  const gone = await cancelled.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(gone.body.status, 'cancelled');
  assert.equal(cancelled.remote.readCounts.get('conv-1'), 2, 'idle is confirmed by a second read');
  assert.deepEqual(
    cancelled.remote.callsTo('GET', '/api/conversation/conv-1').filter((entry) => entry.query.afterMessageId).map((entry) => entry.query.limit),
    [30, 100],
    'the confirming read looks further',
  );
  assert.deepEqual(cancelled.sleeps, []);
});

test('without activeTurn in the payload, idleness comes from the relay-wide queue counts', async () => {
  const { run, remote } = setup();
  withSession(remote, { reportActiveTurn: false });
  remote.status.pendingCount = 1;
  remote.onRead = (conv, query, count) => {
    if (count === 2) remote.status.pendingCount = 0;
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(result.body.status, 'cancelled');
  assert.equal(remote.readCounts.get('conv-1'), 3, 'a pending row is not mistaken for a cancelled one');
  assert.ok(remote.callsTo('GET', '/api/status').length >= 2);
});

test('a pending remote question stops the wait with waiting_for_answer', async () => {
  const { run, remote } = setup();
  withSession(remote);
  remote.onRead = (conv, query) => {
    conv.inFlight = { messageId: query.afterMessageId, streamEvents: [{ seq: 1, text: 'Checking the layout', subagentRunId: null }], activities: [] };
    remote.addQuestion({
      id: 'question-1',
      conversationId: 'conv-1',
      prompt: 'Which theme should the sidebar use?',
      choices: ['Light', 'Dark'],
      context: { header: 'Theme', multiSelect: false },
      allowFreeform: false,
      messageId: query.afterMessageId,
    });
    remote.onRead = null;
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(result.body.status, 'waiting_for_answer');
  assert.deepEqual(result.body.pendingQuestions, [{
    id: 'question-1',
    question: 'Which theme should the sidebar use?',
    header: 'Theme',
    options: ['Light', 'Dark'],
    multiSelect: false,
    allowFreeform: false,
    message_id: 'm-sent-1',
    expiresAt: '2026-09-20T18:00:00.000Z',
  }]);
  assert.equal(result.body.progress.status, 'running');
  assert.equal(result.body.progress.text, 'Checking the layout');
  assert.match(result.body.summary, /waiting_for_answer, 1 question pending/);
});

test('a turn still running at the deadline returns a progress snapshot', async () => {
  const { run, remote, clock } = setup();
  withSession(remote);
  const longText = `${'x'.repeat(900)}END`;
  remote.onMessage = (conv, body) => {
    conv.inFlight = {
      messageId: body.messageId,
      processingAt: '2026-09-20T10:00:05.000Z',
      streamEvents: [
        { seq: 1, text: longText, subagentRunId: null },
        { seq: 2, text: 'subagent chatter', subagentRunId: 'sub-1' },
      ],
      activities: ['one', 'two', 'three', 'four', 'five', 'six'].map((text) => ({ text: `Tool: ${text}` })),
    };
  };
  const started = clock.now;
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 6 });
  assert.equal(result.body.status, 'running');
  assert.equal(clock.now - started, 6000);
  assert.equal(remote.readCounts.get('conv-1'), 4);
  const progress = result.body.progress;
  assert.equal(progress.status, 'running');
  assert.equal(progress.text.length, 600);
  assert.ok(progress.text.startsWith('…') && progress.text.endsWith('END'), 'the newest stream text, main thread only');
  assert.deepEqual(progress.activities, ['Tool: two', 'Tool: three', 'Tool: four', 'Tool: five', 'Tool: six']);
  assert.match(result.body.note, /Call wait/);
});

test('wait follows an earlier message and refuses one the session does not have', async () => {
  const { run, remote } = setup();
  withSession(remote);
  remote.addMessage('conv-1', { id: 'm-mine', role: 'user', text: 'status?' });
  remote.onRead = (conv, query, count) => {
    if (count === 2) remote.reply('conv-1', { sourceMessageId: 'm-mine', text: 'All green.' });
  };
  const result = await run('wait', { relay: 'linux-test', session: 'conv-1', message_id: 'm-mine', wait_seconds: 30 });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.reply.text, 'All green.');
  assert.equal(result.body.summary, 'wait → linux-test session conv-1: done');

  const missing = await run('wait', { relay: 'linux-test', session: 'conv-1', message_id: 'm-nope' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, CODES.notFound);
  assert.match(missing.body.error, /m-nope/);
});

test('a reply far behind its message is found, not mistaken for a cancellation', async () => {
  const { run, remote } = setup();
  withSession(remote);
  // A busy session: 150 rows land after the prompt before its reply does.
  remote.onMessage = (conv, body) => {
    for (let index = 0; index < 75; index += 1) {
      remote.addMessage('conv-1', { id: `m-busy-${index}`, role: 'user', text: `status ${index}?` });
      remote.reply('conv-1', { id: `r-busy-${index}`, sourceMessageId: `m-busy-${index}`, text: 'All green.' });
    }
    remote.reply('conv-1', { id: 'r-mine', sourceMessageId: body.messageId, text: 'All widgets rebuilt.' });
    conv.activeTurn = false;
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.reply.messageId, 'r-mine');
  const reads = remote.callsTo('GET', '/api/conversation/conv-1').filter((entry) => entry.query.afterMessageId);
  assert.deepEqual(reads.map((entry) => [entry.query.afterMessageId, entry.query.limit]), [
    ['m-sent-1', 30],
    ['r-busy-14', 100],
    ['r-busy-64', 100],
  ], 'full pages are followed by the pages after them');
});

test('while the remote turn runs, only the first read looks past a full page', async () => {
  const { run, remote } = setup();
  withSession(remote);
  remote.onMessage = (conv, body) => {
    for (let index = 0; index < 40; index += 1) {
      remote.addMessage('conv-1', { id: `m-steer-${index}`, role: 'user', text: `also ${index}` });
    }
    conv.inFlight = { messageId: body.messageId, streamEvents: [], activities: [] };
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 4 });
  assert.equal(result.body.status, 'running');
  const reads = remote.callsTo('GET', '/api/conversation/conv-1').filter((entry) => entry.query.afterMessageId);
  assert.deepEqual(reads.map((entry) => [entry.query.afterMessageId, entry.query.limit]), [
    ['m-sent-1', 30],
    ['m-steer-29', 100],
    ['m-sent-1', 30],
    ['m-sent-1', 30],
  ]);
});

test('a late wait past more rows than it reads says so instead of "cancelled"', async () => {
  const { run, remote } = setup();
  withSession(remote);
  remote.addMessage('conv-1', { id: 'm-mine', role: 'user', text: 'status?' });
  for (let index = 0; index < 1100; index += 1) {
    remote.addMessage('conv-1', { id: `m-busy-${String(index).padStart(4, '0')}`, role: 'user', text: `note ${index}` });
  }
  const result = await run('wait', { relay: 'linux-test', session: 'conv-1', message_id: 'm-mine', wait_seconds: 30 });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'done');
  assert.match(result.body.note, /no reply to this message was found in the 1000 messages after it; use read_session/);
  assert.equal(result.body.reply, undefined);
});

test('a failed read after the prompt was queued keeps the handle: queued or running, never a bare error', async () => {
  const offline = remoteError(CODES.offline, 'Relay "linux-test" is not reachable (timed out after 15 s)');

  const queued = setup();
  withSession(queued.remote);
  queued.remote.onRead = () => { throw offline; };
  const sent = await queued.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.ok, true);
  assert.equal(sent.body.status, 'queued');
  assert.equal(sent.body.session, 'conv-1');
  assert.equal(sent.body.message_id, 'm-sent-1');
  assert.equal(sent.body.note, 'The wait failed (REMOTE_RELAY_OFFLINE): the prompt was queued; call wait with this session and message_id to keep waiting. Do not send it again.');
  assert.equal(queued.remote.callsTo('POST', '/api/message').length, 1);

  const running = setup();
  withSession(running.remote);
  running.remote.onMessage = (conv, body) => {
    conv.inFlight = { messageId: body.messageId, streamEvents: [{ seq: 1, text: 'Rebuilding' }], activities: [] };
  };
  running.remote.onRead = (conv, query, count) => {
    if (count === 2) throw remoteError(`${CODES.httpPrefix}502`, 'Relay "linux-test" answered HTTP 502', 502);
  };
  const busy = await running.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(busy.body.status, 'running');
  assert.equal(busy.body.progress.text, 'Rebuilding');
  assert.match(busy.body.note, /^The wait failed \(REMOTE_RELAY_HTTP_502\)/);

  const created = setup();
  created.remote.onRead = () => { throw offline; };
  const fresh = await created.run('create_session', { relay: 'linux-test', text: PROMPT });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.status, 'queued');
  assert.equal(fresh.body.session, 'conv-new-1', 'the new session is named, so the agent does not create another');
  assert.equal(fresh.body.message_id, 'm-sent-1');
  assert.equal(created.remote.callsTo('POST', '/api/conversation/bootstrap').length, 1);
});

test('a send whose connection fails is replayed once with the same messageId', async () => {
  const offline = () => remoteError(CODES.offline, 'Relay "linux-test" is not reachable (ECONNRESET)');
  const failPosts = (remote, count) => {
    const request = remote.request;
    let posts = 0;
    remote.request = async (relay, method, path, options = {}) => {
      if (method === 'POST' && path === '/api/message' && ++posts <= count) {
        remote.calls.push({ relay: relay.name, method, path, body: options.body, query: {}, hops: options.hops, failed: true });
        throw offline();
      }
      return request(relay, method, path, options);
    };
  };

  // Lost before it arrived: the replay queues it.
  const lost = setup();
  withSession(lost.remote);
  failPosts(lost.remote, 1);
  const replayed = await lost.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });
  assert.equal(replayed.body.status, 'queued');
  const posts = lost.remote.callsTo('POST', '/api/message');
  assert.deepEqual(posts.map((entry) => entry.body.messageId), ['m-sent-1', 'm-sent-1']);
  assert.equal(lost.remote.conversations.get('conv-1').messages.filter((row) => row.id === 'm-sent-1').length, 1);

  // Arrived, but the answer was lost: the replay's 409 DUPLICATE_MESSAGE_ID counts as sent.
  const landed = setup();
  withSession(landed.remote);
  let dropped = false;
  landed.remote.onMessage = () => {
    if (!dropped) {
      dropped = true;
      throw offline();
    }
  };
  const confirmed = await landed.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.status, 'queued');
  assert.equal(confirmed.body.message_id, 'm-sent-1');
  assert.equal(landed.remote.callsTo('POST', '/api/message').length, 2);
  assert.equal(landed.remote.conversations.get('conv-1').messages.filter((row) => row.id === 'm-sent-1').length, 1);

  // Both attempts fail: unknown, so the error names the session and message.
  const down = setup();
  withSession(down.remote);
  failPosts(down.remote, 2);
  const unknown = await down.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(unknown.status, 502);
  assert.equal(unknown.body.code, CODES.offline);
  assert.equal(unknown.body.session, 'conv-1');
  assert.equal(unknown.body.message_id, 'm-sent-1');
  assert.match(unknown.body.error, /may or may not have been queued/);
  assert.match(unknown.body.note, /Call wait with this session and message_id/);
  assert.equal(down.remote.callsTo('POST', '/api/message').length, 2, 'one replay only');

  // A refusal is an answer: no replay.
  const closed = setup();
  withSession(closed.remote);
  closed.remote.fail('POST', '/api/message', remoteError(CODES.inboundDisabled, 'Relay "linux-test" does not accept prompts from other relays\' agents', 403));
  const refused = await closed.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.equal(refused.status, 403);
  assert.equal(closed.remote.callsTo('POST', '/api/message').length, 1);
});

test('only a reply that opens with the relay\'s failure text is a failure', () => {
  const failure = 'The Grok CLI is not installed. Error code: relay.grok-cli-missing. Install it on the relay host.';
  const settle = (text) => settleRemoteReply([{ role: 'assistant', sourceMessageId: 'm-1', text }], 'm-1').status;
  assert.equal(settle(failure), 'failed');
  assert.equal(settle('Relay recovery limit reached after 5 attempts (stale-recovery). Send it again to retry.'), 'failed');
  assert.equal(settle('Relay timeout after 3 attempts. Message was skipped to keep the queue moving.'), 'failed');
  assert.equal(settle(`Found the cause.\n\nThe log said:\n\n> ${failure}\n\nI installed the CLI; the suite passes now.`), 'done');
  assert.equal(settle(`${'All checks pass. '.repeat(40)}An earlier run ended with Error code: relay.grok-cli-missing. That is fixed.`), 'done');
  assert.equal(settle('The text "error code: relay.grok-cli-missing" appears when the CLI is absent.'), 'done');
  assert.equal(settle('I will retry. Relay timeout after 3 attempts was the last message.'), 'done');
});

test('settleRemoteReply keeps waiting while a fold has no reply yet', () => {
  assert.equal(settleRemoteReply([], 'm-1'), null);
  assert.deepEqual(settleRemoteReply([{ role: 'assistant', sourceMessageId: 'm-1', kind: 'folded', text: 'stub' }], 'm-1'), { foldedWithoutReply: true });
  const settled = settleRemoteReply([
    { id: 'r-other', role: 'assistant', sourceMessageId: 'm-0', kind: 'folded', text: 'someone else\'s stub' },
    { id: 'r-own', role: 'assistant', sourceMessageId: 'm-1', text: 'Mine.' },
  ], 'm-1');
  assert.equal(settled.status, 'done');
  assert.equal(settled.reply.messageId, 'r-own');
  const long = settleRemoteReply([{ role: 'assistant', sourceMessageId: 'm-1', text: 'y'.repeat(20_000) }], 'm-1');
  assert.equal(long.reply.truncated, true);
  assert.ok(long.reply.text.length <= REMOTE_RELAY_LIMITS.perMessageChars * 2);
});

// ─── create_session ──────────────────────────────────────────────────────────

test('create_session mirrors the caller: provider, model and mode', async () => {
  const { run, remote } = setup({ caller: { mode: 'autopilot', model: 'claude-sonnet-5[1m]' } });
  remote.onRead = (conv, query) => {
    remote.reply(conv.id, { sourceMessageId: query.afterMessageId, text: 'Started.' });
    remote.onRead = null;
  };
  const result = await run('create_session', {
    relay: 'linux-test',
    text: 'Build the report builder export\nwith CSV and PDF',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'done');
  assert.equal(result.body.session, 'conv-new-1');
  assert.equal(result.body.provider, 'claude');
  assert.equal(result.body.model, 'claude-sonnet-5', 'the long-context id maps onto the base model the remote offers');
  assert.equal(result.body.modelSource, 'same as this session');
  assert.equal(result.body.mode, 'autopilot');
  assert.equal(result.body.title, 'Build the report builder export');
  assert.equal(result.body.openUrl, 'https://relay-b.example.test/?conv=conv-new-1');
  assert.equal(result.body.reply.text, 'Started.');

  const bootstrap = remote.callsTo('POST', '/api/conversation/bootstrap')[0].body;
  assert.equal(bootstrap.providerType, 'claude');
  assert.equal(bootstrap.model, 'claude-sonnet-5');
  assert.equal(bootstrap.relayMode, 'autopilot');
  assert.equal(bootstrap.origin.relayName, 'win-test');
  assert.equal(bootstrap.cwd, undefined, 'the remote\'s default workspace');
  const post = remote.callsTo('POST', '/api/message')[0].body;
  assert.equal(post.conversationId, 'conv-new-1');
  assert.equal(post.model, 'claude-sonnet-5');
  assert.match(post.text, REMOTE_PROMPT_HEADER_PATTERN);
});

test('create_session falls back to the remote default model and honours explicit choices', async () => {
  const fallback = setup({ caller: { provider: 'github', model: 'gpt-9-unknown' } });
  const result = await fallback.run('create_session', { relay: 'linux-test', text: PROMPT, wait_seconds: 0 });
  assert.equal(result.body.status, 'queued');
  assert.equal(result.body.provider, 'github');
  assert.equal(result.body.model, 'gpt-5.6-luna', '/api/status defaultModel for github');
  assert.equal(result.body.modelSource, 'remote default');
  assert.match(result.body.modelNote, /does not offer gpt-9-unknown/);

  const explicit = setup();
  const chosen = await explicit.run('create_session', {
    relay: 'linux-test',
    text: PROMPT,
    provider: 'openai',
    model: 'gpt-4o',
    mode: 'ask',
    cwd: '/home/dev/other',
    title: 'sidebar polish',
    wait_seconds: 0,
  });
  assert.equal(chosen.status, 200);
  const bootstrap = explicit.remote.callsTo('POST', '/api/conversation/bootstrap')[0].body;
  assert.deepEqual(
    { providerType: bootstrap.providerType, model: bootstrap.model, relayMode: bootstrap.relayMode, cwd: bootstrap.cwd, title: bootstrap.title },
    { providerType: 'openai', model: 'gpt-4o', relayMode: 'ask', cwd: '/home/dev/other', title: 'sidebar polish' },
  );
  assert.equal(chosen.body.modelSource, 'requested');
});

test('create_session refuses a provider the remote lacks and lists the ones it has', async () => {
  const { run, remote } = setup({ caller: { provider: 'cursor', model: 'composer-2.5' } });
  const result = await run('create_session', { relay: 'linux-test', text: PROMPT });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, CODES.providerUnavailable);
  assert.deepEqual(result.body.providers, ['github', 'openai', 'claude']);
  assert.match(result.body.error, /no cursor provider/);
  assert.equal(remote.callsTo('POST', '/api/conversation/bootstrap').length, 0);
});

// ─── Reasoning effort ────────────────────────────────────────────────────────

const CREATE = Object.freeze({ relay: 'linux-test', text: PROMPT, wait_seconds: 0 });
const SEND = Object.freeze({ relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });

function effortsSent(remote) {
  return {
    bootstrap: remote.callsTo('POST', '/api/conversation/bootstrap').map((entry) => entry.body.reasoningEffort),
    message: remote.callsTo('POST', '/api/message').map((entry) => entry.body.reasoningEffort),
  };
}

test('create_session passes an explicit effort to the bootstrap and to the first prompt', async () => {
  const { run, remote } = setup({ caller: { effort: 'low' } });
  const result = await run('create_session', { ...CREATE, model: 'claude-opus-5', effort: 'medium' });
  assert.equal(result.status, 200);
  assert.deepEqual(effortsSent(remote), { bootstrap: ['medium'], message: ['medium'] });
  assert.equal(result.body.model, 'claude-opus-5');
  assert.equal(result.body.effort, 'medium');
  assert.equal(result.body.effortSource, 'requested');
  assert.equal(result.body.note, undefined);
  assert.equal(remote.conversations.get('conv-new-1').effort, 'medium');
});

test('create_session mirrors the caller\'s effort when the agent names none', async () => {
  const mirrored = setup({ caller: { effort: 'high' } });
  const result = await mirrored.run('create_session', CREATE);
  assert.deepEqual(effortsSent(mirrored.remote), { bootstrap: ['high'], message: ['high'] });
  assert.equal(result.body.effort, 'high');
  assert.equal(result.body.effortSource, 'same as this session');
  assert.equal(result.body.note, undefined);

  // Neither side knows an effort: nothing is sent, the remote decides.
  const unknown = setup();
  const plain = await unknown.run('create_session', CREATE);
  assert.deepEqual(effortsSent(unknown.remote), { bootstrap: [undefined], message: [undefined] });
  assert.equal(plain.body.effort, null);
  assert.equal(plain.body.effortSource, 'remote default');
  assert.equal(plain.body.note, undefined);
});

test('create_session leaves out a caller effort the remote does not list for the model', async () => {
  const { run, remote } = setup({ caller: { effort: 'ultracode' } });
  remote.models.reasoningByProvider = { claude: { 'claude-sonnet-5': ['none', 'low', 'medium', 'high'] } };
  remote.efforts.supported = ['none', 'low', 'medium', 'high'];
  const result = await run('create_session', CREATE);
  assert.equal(result.status, 200);
  assert.equal(effortsSent(remote).bootstrap[0], undefined, 'not sent: the remote would not take it');
  assert.equal(effortsSent(remote).message[0], 'none', 'the first prompt runs with the effort the session was bound to');
  assert.equal(result.body.effort, 'none');
  assert.equal(result.body.effortSource, 'remote default');
  assert.match(result.body.note, /does not offer this session's effort "ultracode" \(it takes: none, low, medium, high\)/);
});

test('a mirrored effort the remote refuses is dropped: one retry without it, and a note', async () => {
  const { run, remote } = setup({ caller: { provider: 'openai', model: 'gpt-4o', effort: 'xhigh' } });
  remote.efforts = { supported: ['low', 'medium', 'high'], strictBootstrap: true, strictMessage: true };
  const result = await run('create_session', CREATE);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.status, 'queued');
  assert.deepEqual(effortsSent(remote).bootstrap, ['xhigh', undefined], 'asked again once, without the effort');
  assert.equal(remote.conversations.size, 1, 'the refused bootstrap created nothing');
  assert.deepEqual(effortsSent(remote).message, ['low'], 'the effort the remote bound instead');
  assert.equal(result.body.effort, 'low');
  assert.equal(result.body.effortSource, 'remote default');
  assert.match(result.body.note, /refused this session's effort "xhigh" \(it takes: low, medium, high\)/);
  assert.match(result.body.note, /started without it/);
});

test('a mirrored effort refused only by the message route is dropped there, and the wait note is kept', async () => {
  const { run, remote } = setup({ caller: { effort: 'max' } });
  // The bootstrap takes the effort as it comes; the message route refuses it.
  const original = remote.request;
  remote.request = async (relay, method, path, options = {}) => {
    const message = method === 'POST' && path === '/api/message';
    remote.efforts = { supported: message ? ['none', 'low'] : null, strictBootstrap: false, strictMessage: true };
    return original(relay, method, path, options);
  };
  remote.onRead = (conv) => { conv.inFlight = { messageId: 'm-sent-2', streamEvents: [], activities: [] }; };
  const result = await run('create_session', { ...CREATE, wait_seconds: 1 });
  assert.equal(result.status, 200);
  assert.deepEqual(effortsSent(remote), { bootstrap: ['max'], message: ['max', undefined] });
  assert.equal(remote.conversations.size, 1);
  assert.equal(result.body.message_id, 'm-sent-2', 'the refused prompt was never stored');
  assert.equal(result.body.status, 'running');
  assert.equal(result.body.effort, 'none');
  assert.equal(result.body.effortSource, 'remote default');
  assert.match(result.body.note, /^Relay "linux-test" refused effort "max" \(it takes: none, low\); sent again without it/);
  assert.match(result.body.note, /Not finished yet\. Call wait/, 'the outcome\'s own note follows');
});

test('an explicit effort the remote refuses comes back as its error, with the efforts it takes', async () => {
  const { run, remote, events } = setup({ caller: { effort: 'low' } });
  remote.efforts = { supported: ['low', 'medium', 'high'], strictBootstrap: true, strictMessage: true };
  const result = await run('create_session', { ...CREATE, provider: 'openai', model: 'gpt-4o', effort: 'ultracode' });
  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, `${CODES.httpPrefix}400`);
  assert.equal(result.body.remoteCode, 'REASONING_EFFORT_UNSUPPORTED');
  assert.deepEqual(result.body.supportedEfforts, ['low', 'medium', 'high']);
  assert.match(result.body.error, /Reasoning effort "ultracode" is not supported/);
  assert.deepEqual(effortsSent(remote), { bootstrap: ['ultracode'], message: [] }, 'no retry, no fallback to the caller\'s effort');
  assert.equal(remote.conversations.size, 0);
  assert.equal(events.at(-1).ok, false);

  // The message route refuses without a code; the list still comes through.
  const sending = setup();
  withSession(sending.remote, { provider: 'openai', model: 'gpt-4o' });
  sending.remote.efforts = { supported: ['low', 'medium', 'high'], strictBootstrap: true, strictMessage: true };
  const refused = await sending.run('send', { ...SEND, effort: 'max' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, `${CODES.httpPrefix}400`);
  assert.equal(refused.body.remoteCode, undefined);
  assert.deepEqual(refused.body.supportedEfforts, ['low', 'medium', 'high']);
  assert.deepEqual(effortsSent(sending.remote).message, ['max']);
  assert.equal(sending.remote.conversations.get('conv-1').messages.length, 2, 'nothing was queued');
});

test('an explicit effort refused after the session was created names that session', async () => {
  const { run, remote } = setup();
  // The bootstrap takes the effort as it comes; the message route refuses it.
  const original = remote.request;
  remote.request = async (relay, method, path, options = {}) => {
    const message = method === 'POST' && path === '/api/message';
    remote.efforts = { supported: message ? ['none', 'low'] : null, strictBootstrap: false, strictMessage: true };
    return original(relay, method, path, options);
  };
  const result = await run('create_session', { ...CREATE, effort: 'high' });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, `${CODES.httpPrefix}400`);
  assert.equal(result.body.session, 'conv-new-1');
  assert.equal(result.body.openUrl, 'https://relay-b.example.test/?conv=conv-new-1');
  assert.deepEqual(result.body.supportedEfforts, ['none', 'low']);
  assert.match(result.body.error, /The session was created, but the prompt was not queued\./);
  assert.match(result.body.note, /do not create another session/);
  assert.deepEqual(effortsSent(remote), { bootstrap: ['high'], message: ['high'] });
});

test('an effort the remote replaces without refusing is reported as the one the turn runs with', async () => {
  const { run, remote } = setup();
  remote.efforts = { supported: ['none', 'low', 'medium', 'high'], strictBootstrap: false, strictMessage: false };
  const created = await run('create_session', { ...CREATE, effort: 'max' });
  assert.equal(created.status, 200);
  assert.deepEqual(effortsSent(remote), { bootstrap: ['max'], message: ['none'] });
  assert.equal(created.body.effort, 'none');
  assert.equal(created.body.effortSource, 'remote default');
  assert.match(created.body.note, /does not offer effort "max" for this model; the turn runs with "none"/);

  const sent = await run('send', { ...SEND, session: 'conv-new-1', effort: 'xhigh' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.effort, 'none');
  assert.equal(sent.body.effortSource, 'remote default');
  assert.match(sent.body.note, /does not offer effort "xhigh"/);
});

test('send without an effort sends none, and never the caller\'s', async () => {
  const { run, remote } = setup({ caller: { effort: 'high' } });
  withSession(remote);
  const result = await run('send', SEND);
  assert.equal(result.status, 200);
  const post = remote.callsTo('POST', '/api/message')[0].body;
  assert.equal('reasoningEffort' in post, false);
  assert.equal('effort' in result.body, false);
  assert.equal('effortSource' in result.body, false);
  assert.equal(result.body.note, undefined);
});

test('send passes an explicit effort, and otherwise the one the remote session is set to', async () => {
  const explicit = setup({ caller: { effort: 'low' } });
  withSession(explicit.remote, { effort: 'high' });
  const chosen = await explicit.run('send', { ...SEND, effort: 'medium' });
  assert.deepEqual(effortsSent(explicit.remote).message, ['medium']);
  assert.equal(chosen.body.effort, 'medium');
  assert.equal(chosen.body.effortSource, 'requested');

  const own = setup({ caller: { effort: 'low' } });
  withSession(own.remote, { effort: 'high' });
  const kept = await own.run('send', SEND);
  assert.deepEqual(effortsSent(own.remote).message, ['high'], 'the session keeps its own effort');
  assert.equal(kept.body.effort, 'high');
  assert.equal(kept.body.effortSource, 'remote default');

  // The session's own effort does not fit the model this prompt switches to.
  const switched = setup();
  withSession(switched.remote, { effort: 'max' });
  switched.remote.efforts = { supported: ['none', 'low', 'medium'], strictBootstrap: true, strictMessage: true };
  const retried = await switched.run('send', { ...SEND, model: 'claude-opus-5' });
  assert.equal(retried.status, 200);
  assert.deepEqual(effortsSent(switched.remote).message, ['max', undefined]);
  assert.equal(retried.body.effort, 'none');
  assert.match(retried.body.note, /refused effort "max"/);
});

// ─── relay_info, list_sessions, read_session ─────────────────────────────────

test('relay_info lists the efforts of each provider\'s models, grouped and capped', async () => {
  const { run, remote } = setup();
  const many = Array.from({ length: 45 }, (_, index) => `claude-lab-${index + 1}`);
  remote.settings.claude.models = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-5', ...many];
  remote.models.reasoningByModel = {
    'gpt-5.6-luna': ['low', 'medium', 'high'],
    // Copilot's view of a model the Claude provider serves too.
    'claude-sonnet-5': ['low', 'high'],
    'gpt-4o': ['none'],
  };
  remote.models.reasoningByProvider = {
    claude: {
      'claude-sonnet-5': ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
      'claude-opus-5': ['None', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
      'claude-haiku-5': ['none', 'not a level!', ...Array.from({ length: 20 }, (_, index) => `level-${index + 1}`)],
      ...Object.fromEntries(many.map((model) => [model, ['none', 'low']])),
    },
    openai: { 'gpt-4o': [] },
  };
  const result = await run('relay_info', { relay: 'linux-test' });
  assert.equal(result.status, 200);
  const byName = Object.fromEntries(result.body.providers.map((entry) => [entry.provider, entry]));
  assert.deepEqual(byName.github.efforts, [
    { efforts: ['low', 'medium', 'high'], models: ['gpt-5.6-luna'] },
    { efforts: ['low', 'high'], models: ['claude-sonnet-5'] },
  ]);
  assert.deepEqual(byName.claude.efforts[0], {
    efforts: ['none', 'low'],
    models: many.slice(0, 40),
    more: 5,
  });
  assert.deepEqual(byName.claude.efforts[1], {
    efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
    models: ['claude-sonnet-5', 'claude-opus-5'],
  });
  assert.equal(byName.claude.efforts[2].efforts.length, 12, 'a long list is capped');
  assert.equal(byName.claude.efforts[2].efforts.includes('not a level!'), false);
  assert.deepEqual(byName.openai.efforts, [{ efforts: ['none'], models: ['gpt-4o'] }], 'falls back to reasoningByModel');
  assert.equal('efforts' in byName.cursor, false, 'a provider that is not set up lists nothing');
  assert.ok(JSON.stringify(result.body).length < 6000, 'the result stays small');
});

test('relay_info describes providers, workspaces and modes, tolerating missing routes', async () => {
  const { run, remote } = setup();
  delete remote.settings.grok;
  remote.fail('GET', '/api/relay/identity', remoteError(CODES.notFound, 'not found', 404));
  const result = await run('relay_info', { relay: 'linux-test' });
  assert.equal(result.status, 200);
  assert.equal(result.body.version, '0.9.4');
  assert.equal(result.body.platform, 'linux');
  assert.equal(result.body.protocol, 0, 'no identity route: an older relay');
  const byName = Object.fromEntries(result.body.providers.map((entry) => [entry.provider, entry]));
  assert.deepEqual(Object.keys(byName), ['github', 'openai', 'claude', 'cursor', 'grok', 'claude-cloud']);
  assert.deepEqual(byName['claude-cloud'], { provider: 'claude-cloud', configured: false, defaultModel: null, models: [] },
    'a relay without the Claude Cloud settings route has no such provider');
  assert.deepEqual(byName.github, {
    provider: 'github',
    configured: true,
    defaultModel: 'gpt-5.6-luna',
    models: ['gpt-5.6-luna', 'claude-sonnet-5'],
    engine: 'sdk',
  });
  assert.deepEqual(byName.claude.models, ['claude-sonnet-5', 'claude-opus-5']);
  assert.deepEqual(byName.openai, { provider: 'openai', configured: true, defaultModel: 'gpt-4o', models: ['gpt-4o'] });
  assert.equal(byName.cursor.configured, false);
  assert.equal(byName.grok.configured, false);
  assert.deepEqual(result.body.workspaces, {
    default: '/home/dev/work/default',
    current: '/home/dev/work',
    recent: ['/home/dev/work', '/home/dev/other'],
  });
  assert.deepEqual(result.body.relayModes, ['plan', 'ask', 'agent', 'autopilot']);
  assert.match(result.body.summary, /OAR 0\.9\.4, providers github, openai, claude/);
});

test('relay_info lists Claude Cloud when the remote has it switched on, without efforts', async () => {
  const { run, remote } = setup();
  remote.settings['claude-cloud'] = {
    enabled: true,
    defaultModel: 'claude-sonnet-5-5',
    environmentId: 'env_01EXAMPLEaaaaaaaaaaaaaaaa',
    models: ['claude-sonnet-5-5', 'claude-sonnet-5'],
  };
  // The cloud's ids are the Claude provider's: its efforts must not leak over.
  remote.models.reasoningByModel = { 'claude-sonnet-5': ['none', 'low', 'high'] };
  const result = await run('relay_info', { relay: 'linux-test' });
  assert.equal(result.status, 200);
  const cloud = result.body.providers.find((entry) => entry.provider === 'claude-cloud');
  assert.equal(cloud.configured, true);
  assert.equal(cloud.defaultModel, 'claude-sonnet-5-5');
  assert.deepEqual(cloud.models, ['claude-sonnet-5-5', 'claude-sonnet-5']);
  assert.equal('efforts' in cloud, false);
  assert.match(cloud.note, /create_session cannot open a Claude Cloud session yet/);
  assert.equal(JSON.stringify(cloud).includes('env_01EXAMPLE'), false, 'the environment stays on its relay');

  remote.settings['claude-cloud'] = { enabled: false, defaultModel: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'] };
  const off = await run('relay_info', { relay: 'linux-test' });
  assert.deepEqual(off.body.providers.find((entry) => entry.provider === 'claude-cloud'), {
    provider: 'claude-cloud',
    configured: false,
    defaultModel: 'claude-sonnet-5-5',
    models: [],
  });
});

test('create_session refuses Claude Cloud: it has no repository to pass, and nothing is created', async () => {
  const { run, remote } = setup();
  remote.settings['claude-cloud'] = { enabled: true, defaultModel: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'] };
  const result = await run('create_session', { relay: 'linux-test', text: PROMPT, provider: 'claude-cloud' });
  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, CODES.invalidInput);
  assert.match(result.body.error, /clones a GitHub repository/);
  assert.match(result.body.error, /New Chat on relay "linux-test"/);
  assert.deepEqual(result.body.providers, ['github', 'openai', 'claude']);
  assert.equal(remote.callsTo('POST', '/api/conversation/bootstrap').length, 0);
  assert.equal(remote.callsTo('POST', '/api/message').length, 0);
});

test('list_sessions maps the remote list; query and active scan pages to fill one', async () => {
  const { run, remote } = setup();
  remote.addConversation({ id: 'conv-a', title: 'report builder', origin: { relayName: 'win-test' }, activeTurn: true });
  for (let index = 0; index < 120; index += 1) {
    remote.addConversation({ id: `conv-filler-${String(index).padStart(3, '0')}`, title: `filler ${index}` });
  }
  remote.addConversation({ id: 'conv-b', title: 'Sidebar Polish', provider: 'github', model: 'gpt-5.6-luna' });
  remote.status.sessionWorker.workers = [
    { conversationId: 'conv-filler-005', status: 'processing' },
    { conversationId: 'conv-filler-006', status: 'ready' },
  ];

  const recent = await run('list_sessions', { relay: 'linux-test', limit: 3 });
  assert.equal(recent.status, 200);
  assert.deepEqual(recent.body.sessions.map((row) => row.id), ['conv-b', 'conv-filler-119', 'conv-filler-118']);
  assert.deepEqual(recent.body.sessions[0], {
    id: 'conv-b',
    title: 'Sidebar Polish',
    provider: 'github',
    model: 'gpt-5.6-luna',
    active: false,
    updatedAt: remote.conversations.get('conv-b').updatedAt,
    messageCount: 0,
    cwd: '/home/dev/work',
  });
  assert.equal(recent.body.nextCursor, null, 'recent is one page');

  const searched = await run('list_sessions', { relay: 'linux-test', query: 'REPORT' });
  assert.deepEqual(searched.body.sessions.map((row) => row.id), ['conv-a']);
  assert.equal(searched.body.sessions[0].via, 'win-test');
  assert.equal(searched.body.sessions[0].active, true);
  // Page one: conv-b and 99 fillers; conv-a is on page two.
  assert.equal(remote.callsTo('GET', '/api/conversations').at(-1).query.beforeConversationId, 'conv-filler-021', 'second page');

  const active = await run('list_sessions', { relay: 'linux-test', scope: 'active' });
  assert.deepEqual(active.body.sessions.map((row) => row.id), ['conv-filler-005', 'conv-a']);
});

test('list_sessions scope all pages with an opaque cursor', async () => {
  const { run, remote } = setup();
  for (let index = 0; index < 5; index += 1) remote.addConversation({ id: `conv-${index}`, title: `session ${index}` });
  const first = await run('list_sessions', { relay: 'linux-test', scope: 'all', limit: 2 });
  assert.deepEqual(first.body.sessions.map((row) => row.id), ['conv-4', 'conv-3']);
  assert.equal(typeof first.body.nextCursor, 'string');
  const second = await run('list_sessions', { relay: 'linux-test', scope: 'all', limit: 2, cursor: first.body.nextCursor });
  assert.deepEqual(second.body.sessions.map((row) => row.id), ['conv-2', 'conv-1']);
  const third = await run('list_sessions', { relay: 'linux-test', scope: 'all', limit: 2, cursor: second.body.nextCursor });
  assert.deepEqual(third.body.sessions.map((row) => row.id), ['conv-0']);
  assert.equal(third.body.nextCursor, null);

  const bad = await run('list_sessions', { relay: 'linux-test', scope: 'all', cursor: 'not-a-cursor' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, CODES.invalidInput);
});

test('read_session strips the prompt header, trims text and keeps the newest within max_chars', async () => {
  const { run, remote } = setup();
  withSession(remote, { origin: { relayName: 'win-test' } });
  remote.addMessage('conv-1', {
    id: 'm-agent',
    role: 'user',
    text: '[Remote prompt from an agent on relay "win-test" · session "report builder" · acting for the user]\n\nRun the suite',
    origin: { relayName: 'win-test', hops: 1 },
  });
  remote.addMessage('conv-1', {
    id: 'm-long',
    role: 'assistant',
    text: 'z'.repeat(9000),
    sourceMessageId: 'm-agent',
    model: 'claude-sonnet-5',
    activities: [{ text: 'Tool (bash): npm test' }],
  });
  remote.addQuestion({ id: 'question-2', conversationId: 'conv-1', prompt: 'Keep going?', choices: ['Yes', 'No'] });

  const result = await run('read_session', { relay: 'linux-test', session: 'conv-1', include_activity: true });
  assert.equal(result.status, 200);
  const [, , agentRow, longRow] = result.body.messages;
  assert.equal(agentRow.text, 'Run the suite');
  assert.equal(agentRow.via, 'win-test');
  assert.equal(longRow.truncated, true);
  assert.ok(longRow.text.length <= REMOTE_RELAY_LIMITS.perMessageChars);
  assert.equal(longRow.replyTo, 'm-agent');
  assert.deepEqual(longRow.activities, ['Tool (bash): npm test']);
  assert.equal(result.body.messages[0].activities, undefined, 'user rows carry no activity');
  assert.equal(result.body.session.via, 'win-test');
  assert.equal(result.body.session.openUrl, 'https://relay-b.example.test/?conv=conv-1');
  assert.deepEqual(result.body.pendingQuestions.map((question) => question.id), ['question-2']);

  const tight = await run('read_session', { relay: 'linux-test', session: 'conv-1', max_chars: 500 });
  assert.deepEqual(tight.body.messages.map((row) => row.id), ['m-long'], 'newest kept');
  assert.ok(tight.body.messages[0].text.length <= 500);
  assert.match(tight.body.note, /3 older messages left out/);
  const older = await run('read_session', { relay: 'linux-test', session: 'conv-1', before: tight.body.olderCursor, last: 2 });
  assert.equal(remote.calls.at(-2).query.beforeMessageId, 'm-long');
  assert.deepEqual(older.body.messages.map((row) => row.id), ['m-old-reply', 'm-agent']);
  assert.equal(typeof older.body.olderCursor, 'string', 'the remote still has older rows');

  const bad = await run('read_session', { relay: 'linux-test', session: 'conv-1', before: '%%%' });
  assert.equal(bad.status, 400);
});

test('read_session gives each message its share of max_chars, never less than the per-message cap', async () => {
  const { run, remote } = setup();
  withSession(remote);
  const review = `HEAD${'r'.repeat(8850)}TAIL`;
  remote.addMessage('conv-1', { id: 'm-ask', role: 'user', text: 'Review the report builder export' });
  remote.addMessage('conv-1', { id: 'm-review', role: 'assistant', text: review, sourceMessageId: 'm-ask', model: 'claude-sonnet-5' });

  const whole = await run('read_session', { relay: 'linux-test', session: 'conv-1', last: 1, max_chars: 20000 });
  assert.equal(whole.body.messages.length, 1);
  assert.equal(whole.body.messages[0].text, review, 'one message may use the whole budget');
  assert.equal(whole.body.messages[0].truncated, undefined);

  const shared = await run('read_session', { relay: 'linux-test', session: 'conv-1', last: 3, max_chars: 20000 });
  const trimmed = shared.body.messages.find((row) => row.id === 'm-review');
  assert.equal(trimmed.truncated, true);
  assert.ok(trimmed.text.length <= 6666 && trimmed.text.length > REMOTE_RELAY_LIMITS.perMessageChars, String(trimmed.text.length));
  assert.ok(trimmed.text.startsWith('HEAD') && trimmed.text.endsWith('TAIL'), 'head and tail are kept');

  const defaults = await run('read_session', { relay: 'linux-test', session: 'conv-1' });
  const capped = defaults.body.messages.find((row) => row.id === 'm-review');
  assert.ok(capped.text.length <= REMOTE_RELAY_LIMITS.perMessageChars, 'the default read keeps the 4000 floor as its cap');

  const tight = await run('read_session', { relay: 'linux-test', session: 'conv-1', last: 1, max_chars: 1000 });
  assert.ok(tight.body.messages[0].text.length <= 1000, 'still bounded by max_chars');
});

test('the remote\'s own approval cards are never offered to the agent or answered', async () => {
  const { run, remote } = setup();
  withSession(remote);
  remote.addQuestion({
    id: 'question-approval',
    conversationId: 'conv-1',
    prompt: 'Allow the agent to send a prompt on relay "win-test"?',
    choices: ['Allow', 'Deny'],
    allowFreeform: false,
    context: { source: 'remote_relay', header: 'Remote relay' },
  });
  remote.addQuestion({ id: 'question-2', conversationId: 'conv-1', prompt: 'Keep going?', choices: ['Yes', 'No'] });
  const read = await run('read_session', { relay: 'linux-test', session: 'conv-1' });
  assert.deepEqual(read.body.pendingQuestions.map((question) => question.id), ['question-2']);

  const answered = await run('answer_question', { relay: 'linux-test', question_id: 'question-approval', choices: ['Allow'] });
  assert.equal(answered.status, 403);
  assert.equal(answered.body.code, CODES.forbidden);
  assert.match(answered.body.error, /only its user can answer it/);
  assert.equal(remote.callsTo('POST', '/api/relay-question/question-approval/answer').length, 0);
  assert.equal(remote.questions.get('question-approval').status, 'pending');

  // A remote turn held by its own approval card is running, not waiting on us.
  const held = setup();
  withSession(held.remote);
  held.remote.onMessage = (conv, body) => {
    conv.inFlight = { messageId: body.messageId, streamEvents: [], activities: [] };
    held.remote.addQuestion({
      id: 'question-approval',
      conversationId: 'conv-1',
      prompt: 'Allow the agent to start a new session on relay "lab-relay"?',
      choices: ['Allow', 'Deny'],
      context: { source: 'remote_relay' },
      messageId: body.messageId,
    });
  };
  const waiting = await held.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 4 });
  assert.equal(waiting.body.status, 'running');
  assert.equal(waiting.body.pendingQuestions, undefined);
});

test('read_session reports a running turn as a progress snapshot', async () => {
  const { run, remote } = setup();
  withSession(remote, {
    inFlight: { messageId: 'm-old-user', processingAt: '2026-09-20T10:00:09.000Z', streamEvents: [{ seq: 3, text: 'Halfway there' }], activities: [{ text: 'Tool: grep' }] },
  });
  const result = await run('read_session', { relay: 'linux-test', session: 'conv-1' });
  assert.deepEqual(result.body.inFlight, {
    status: 'running',
    turnMessageId: 'm-old-user',
    startedAt: '2026-09-20T10:00:09.000Z',
    text: 'Halfway there',
    activities: ['Tool: grep'],
  });
  assert.match(result.body.summary, /turn running/);
});

// ─── answer_question, stop, archive ──────────────────────────────────────────

test('answer_question passes the question\'s sdk_session_id and the card\'s answer format', async () => {
  const { run, remote } = setup();
  remote.addQuestion({
    id: 'question-3',
    conversationId: 'conv-9',
    prompt: 'Which checks?',
    choices: ['Lint', 'Unit', 'E2E'],
    context: { multiSelect: true },
    messageId: 'm-turn',
  });
  const result = await run('answer_question', { relay: 'linux-test', question_id: 'question-3', choices: ['unit', 'E2E'], answer: 'skip flaky ones' });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'answered');
  assert.equal(result.body.session, 'conv-9');
  assert.equal(result.body.message_id, 'm-turn');
  const post = remote.callsTo('POST', '/api/relay-question/question-3/answer')[0].body;
  assert.deepEqual(post, { answer: 'Unit, E2E, skip flaky ones', sdk_session_id: 'sdk-remote-1' });
  assert.equal(remote.questions.get('question-3').status, 'answered');

  const again = await run('answer_question', { relay: 'linux-test', question_id: 'question-3', answer: 'x' });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already answered/);

  const missing = await run('answer_question', { relay: 'linux-test', question_id: 'question-404', answer: 'x' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, CODES.notFound);
});

test('answer_question validates options and multi-field questions before sending', async () => {
  const { run, remote } = setup();
  remote.addQuestion({ id: 'question-4', conversationId: 'conv-9', prompt: 'Pick one', choices: ['Light', 'Dark'], allowFreeform: false, sdkSessionId: null });
  const wrong = await run('answer_question', { relay: 'linux-test', question_id: 'question-4', choices: ['Sepia'] });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, CODES.invalidInput);
  assert.match(wrong.body.error, /Options: Light, Dark/);
  const right = await run('answer_question', { relay: 'linux-test', question_id: 'question-4', choices: ['dark'] });
  assert.equal(right.status, 200);
  assert.deepEqual(remote.callsTo('POST', '/api/relay-question/question-4/answer')[0].body, { answer: 'Dark' });

  remote.addQuestion({
    id: 'question-5',
    conversationId: 'conv-9',
    prompt: 'Details',
    requestSchema: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'integer' } } },
  });
  const flat = await run('answer_question', { relay: 'linux-test', question_id: 'question-5', answer: 'report builder' });
  assert.equal(flat.status, 400);
  assert.match(flat.body.error, /several fields \(name, count\)/);
  const structured = await run('answer_question', { relay: 'linux-test', question_id: 'question-5', answer: '{"name":"report builder","count":2}' });
  assert.equal(structured.status, 200);
  assert.deepEqual(remote.callsTo('POST', '/api/relay-question/question-5/answer')[0].body.structuredAnswer, { name: 'report builder', count: 2 });
});

test('stop and archive call the remote routes and report what happened', async () => {
  const { run, remote } = setup();
  withSession(remote, { inFlight: { messageId: 'm-old-user' } });
  const stopped = await run('stop', { relay: 'linux-test', session: 'conv-1' });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.stopRequested, true);
  assert.equal(stopped.body.message_id, 'm-old-user');
  assert.equal(stopped.body.summary, 'stop → linux-test session conv-1: stop requested');
  remote.conversations.get('conv-1').inFlight = null;
  const idle = await run('stop', { relay: 'linux-test', session: 'conv-1' });
  assert.equal(idle.body.stopRequested, false);
  assert.match(idle.body.note, /Nothing was running/);

  const archived = await run('archive', { relay: 'linux-test', session: 'conv-1' });
  assert.equal(archived.body.archived, true);
  assert.equal(remote.conversations.get('conv-1').archived, true);
});

// ─── Errors and logging ──────────────────────────────────────────────────────

test('remote failures map to the contract codes and statuses', async () => {
  const offline = setup();
  offline.remote.fail('GET', '/api/conversation/conv-1', remoteError(CODES.offline, 'Relay "linux-test" is not reachable (ECONNREFUSED)'));
  const down = await offline.run('read_session', { relay: 'linux-test', session: 'conv-1' });
  assert.deepEqual([down.status, down.body.code, down.body.relay], [502, CODES.offline, 'linux-test']);
  assert.match(down.body.error, /not reachable/);

  const unauthorized = setup();
  unauthorized.remote.fail('GET', '/api/status', remoteError(CODES.unauthorized, 'Relay "linux-test" rejected the token (401)', 401));
  const rejected = await unauthorized.run('relay_info', { relay: 'linux-test' });
  assert.deepEqual([rejected.status, rejected.body.code], [502, CODES.unauthorized]);

  const closed = setup();
  withSession(closed.remote);
  closed.remote.fail('POST', '/api/message', remoteError(CODES.inboundDisabled, 'Relay "linux-test" does not accept prompts from other relays\' agents', 403));
  const inbound = await closed.run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  assert.deepEqual([inbound.status, inbound.body.code], [403, CODES.inboundDisabled]);

  const missing = await setup().run('read_session', { relay: 'linux-test', session: 'conv-gone' });
  assert.deepEqual([missing.status, missing.body.code], [404, CODES.notFound]);
  assert.equal(missing.body.error, 'Session conv-gone was not found on relay "linux-test".');

  const conflict = setup();
  conflict.remote.fail('POST', '/api/conversation/bootstrap', remoteError(`${CODES.httpPrefix}400`, 'Relay "linux-test" answered HTTP 400: Claude model "x" is not available', 400, {
    error: 'Claude model "x" is not available',
    code: 'CLAUDE_MODEL_UNAVAILABLE',
    supportedModels: ['claude-sonnet-5'],
  }));
  const refused = await conflict.run('create_session', { relay: 'linux-test', text: PROMPT, model: 'x' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, `${CODES.httpPrefix}400`);
  assert.equal(refused.body.remoteCode, 'CLAUDE_MODEL_UNAVAILABLE');
  assert.deepEqual(refused.body.supportedModels, ['claude-sonnet-5']);

  const broken = setup();
  broken.remote.fail('GET', '/api/conversation/conv-1', remoteError(`${CODES.httpPrefix}500`, 'Relay "linux-test" answered HTTP 500', 500));
  const serverError = await broken.run('read_session', { relay: 'linux-test', session: 'conv-1' });
  assert.deepEqual([serverError.status, serverError.body.code], [502, `${CODES.httpPrefix}500`]);
});

test('through the real outbound client: query, path encoding, hop header and a 404', async () => {
  const token = ['fixture', 'bearer', 'value'].join('-');
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const { pathname } = new URL(url);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (pathname === '/api/conversations') {
      return json(200, { conversations: [{ id: 'conv-1', title: 'sidebar polish', updatedAt: '2026-09-20T10:00:00.000Z' }], pageInfo: { hasMore: false } });
    }
    return json(404, { error: 'Conversation not found' });
  };
  const client = createRemoteRelayClient({ fetchImpl, getOwnRelayId: () => 'relay-self-id', getOwnToken: () => token });
  const dispatcher = createRemoteRelayDispatcher({
    registry: createRegistry([LINUX]),
    client,
    repository: { hasUnlock: () => true },
    getCallerContext: async () => ({ hops: 1, mode: 'agent' }),
    logger: { log() {}, warn() {} },
  });

  const listed = await dispatcher.dispatch({ conversationId: 'c-1', action: 'list_sessions', args: { relay: 'linux-test', limit: 5 } });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.sessions.map((row) => row.id), ['conv-1']);
  assert.equal(requests[0].url, 'https://relay-b.example.test/api/conversations?limit=5');
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(requests[0].init.headers['x-oar-remote-hops'], '2');
  assert.equal(requests[0].init.headers['x-oar-remote-origin'], 'relay-self-id');
  assert.ok(!Object.keys(requests[0].init.headers).some((name) => /^x-relay-/i.test(name)));

  const missing = await dispatcher.dispatch({ conversationId: 'c-1', action: 'read_session', args: { relay: 'linux-test', session: 'conv/../x' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, CODES.notFound);
  assert.equal(requests[1].url, 'https://relay-b.example.test/api/conversation/conv%2F..%2Fx?limit=10');
  assert.ok(!JSON.stringify(missing.body).includes(token));
});

test('an unexpected exception becomes a 500 and never escapes dispatch', async () => {
  const { run, dispatcher, logs } = setup({
    getCallerContext: async () => { throw new Error('database is locked'); },
  });
  const result = await run('read_session', { relay: 'linux-test', session: 'conv-1' });
  assert.equal(result.status, 500);
  assert.equal(result.body.code, REMOTE_RELAY_INTERNAL_ERROR_CODE);
  assert.match(logs.at(-1), /read_session failed conv=c-1: database is locked/);
  assert.equal(dispatcher.inflight('c-1'), 0);
});

test('write actions log one line and one status event each; prompt text never appears', async () => {
  const { run, remote, logs, events } = setup();
  withSession(remote);
  remote.onRead = (conv, query) => {
    remote.reply('conv-1', { sourceMessageId: query.afterMessageId, text: 'Rebuilt the sidebar polish widgets as asked.' });
    remote.onRead = null;
  };
  await run('read_session', { relay: 'linux-test', session: 'conv-1' });
  assert.equal(logs.length, 0, 'reads are not logged');
  await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT });
  await run('create_session', { relay: 'linux-test', text: PROMPT, wait_seconds: 0 });
  assert.deepEqual(logs, [
    '[remote-relays] send linux-test conv-1 → done conv=c-1',
    '[remote-relays] create_session linux-test conv-new → queued conv=c-1',
  ]);
  assert.deepEqual(events.map((event) => [event.type, event.action, event.relay, event.session, event.result, event.ok]), [
    ['remote_relay', 'send', 'linux-test', 'conv-1', 'done', true],
    ['remote_relay', 'create_session', 'linux-test', 'conv-new-2', 'queued', true],
  ]);
  const recorded = JSON.stringify({ logs, events });
  assert.ok(!recorded.includes('rebuild'), 'no prompt text');
  assert.ok(!recorded.includes('Rebuilt'), 'no reply text');
});
