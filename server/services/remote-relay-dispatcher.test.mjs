import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REMOTE_PROMPT_HEADER_PATTERN,
  REMOTE_RELAY_ERROR_CODES as CODES,
  REMOTE_RELAY_LIMITS,
} from '../../shared/remote-relay-contract.mjs';
import { executeRemoteRelayTool } from '../../shared/remote-relay-tool-core.mjs';
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
    // Session groups as GET /api/conversation-groups lists them. null: a relay
    // that predates group on create_session (no list, the bootstrap passes
    // group over and answers no group key).
    groupList: null,
    // The groups the bootstrap sees, when they changed after the lookup.
    groupsAtBootstrap: null,
    // The group a local agent's create joins without group (its creator's).
    creatorGroup: null,
    // A bootstrap that takes the list but passes group over (the backstop).
    bootstrapIgnoresGroup: false,
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
    // PATCH /api/conversation/:id/settings, reduced: the target's own rule
    // (free only for the conversation that started the session, by the call's
    // origin; any other needs owner_approved), a dry run, groups by id or
    // name (a new name makes one), and what changed.
    settingsRouteMissing: false,
    settingsFailure: null,
    settingsSnapshot(conv) {
      const group = conv.groupId ? (remote.groupList || []).find((entry) => entry.id === conv.groupId) : null;
      return {
        model: conv.model,
        effort: conv.effort || null,
        mode: conv.mode,
        auto_compact_window: conv.window ?? 'auto',
        title: conv.title,
        group: group ? { id: group.id, name: group.name, role: 'member' } : null,
        thinking_enabled: conv.thinkingEnabled ?? true,
        thinking_display: conv.thinkingDisplay || 'summarized',
        cwd: conv.cwd,
      };
    },
    applySettings(relay, conv, body) {
      const settings = body?.settings || {};
      const ownerStarted = !conv.origin;
      const caller = body?.origin || null;
      const startedByCaller = !!conv.origin && !!caller && conv.origin.conversationId === caller.conversationId
        && conv.origin.relayId === caller.relayId && (conv.origin.local === true) === (caller.local === true);
      const approvalNeeded = !startedByCaller;
      const now = remote.settingsSnapshot(conv);
      const changed = [];
      let groupPlan = null;
      for (const [key, value] of Object.entries(settings)) {
        if (key === 'group') {
          if (value === null) {
            if (conv.groupId) { groupPlan = { action: 'leave' }; changed.push(key); }
            continue;
          }
          const groups = remote.groupList || [];
          const found = groups.find((entry) => entry.id === value) || groups.find((entry) => entry.name.toLowerCase() === String(value).toLowerCase());
          if (found) {
            if (found.id !== conv.groupId) { groupPlan = { action: 'join', id: found.id, name: found.name }; changed.push(key); }
          } else if (/^grp_/.test(value)) {
            throw remoteError(`${CODES.httpPrefix}400`, `Relay "${relay.name}" answered HTTP 400`, 400, {
              ok: false, code: 'SESSION_GROUP_NOT_FOUND', error: `No session group "${value}" here. Nothing was changed.`, groups: groups.map(({ id, name }) => ({ id, name })),
            });
          } else {
            groupPlan = { action: 'create', name: value };
            changed.push(key);
          }
          continue;
        }
        if (now[key] !== value) changed.push(key);
      }
      const facts = { session: conv.id, provider: conv.provider, ownerStarted, startedByCaller, approvalNeeded };
      if (body?.dry_run === true) return { ok: true, dryRun: true, ...facts, settings: now, changed, ...(groupPlan ? { group: groupPlan } : {}) };
      if (approvalNeeded && body?.owner_approved !== true) {
        throw remoteError(`${CODES.httpPrefix}403`, `Relay "${relay.name}" answered HTTP 403`, 403, {
          ok: false, code: CODES.permission, error: 'This session was started by the relay\'s owner: an agent changes its settings only after the owner allowed that for the calling conversation.',
        });
      }
      const fields = { model: 'model', effort: 'effort', mode: 'mode', auto_compact_window: 'window', title: 'title', thinking_enabled: 'thinkingEnabled', thinking_display: 'thinkingDisplay', cwd: 'cwd' };
      for (const [key, field] of Object.entries(fields)) {
        if (changed.includes(key)) conv[field] = settings[key];
      }
      let groupCreated = null;
      if (groupPlan?.action === 'leave') conv.groupId = null;
      if (groupPlan?.action === 'join') conv.groupId = groupPlan.id;
      if (groupPlan?.action === 'create') {
        groupCreated = { id: `grp_made${(remote.groupList || []).length + 1}`, name: groupPlan.name };
        remote.groupList = [...(remote.groupList || []), { ...groupCreated, memberCount: 1 }];
        conv.groupId = groupCreated.id;
      }
      return {
        ok: true,
        ...facts,
        settings: remote.settingsSnapshot(conv),
        changed,
        ...(changed.includes('cwd') ? { relaunched: true } : {}),
        ...(groupCreated ? { groupCreated } : {}),
      };
    },
    callsTo(method, path) {
      return remote.calls.filter((entry) => entry.method === method && entry.path === path);
    },

    async request(relay, method, path, { body, query = {}, hops } = {}) {
      remote.calls.push({ relay: relay.name, method, path, body, query, hops });
      const failure = remote.failures.get(`${method} ${path}`);
      if (failure) throw failure;
      const notFound = () => remoteError(CODES.notFound, `Relay "${relay.name}": not found`, 404);

      if (method === 'GET' && path === '/api/conversation-groups') {
        if (!remote.groupList) throw notFound();
        return { ok: true, groups: remote.groupList };
      }
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
        // A relay whose cursor row vanished serves that row's group again.
        if (remote.repeatFirstRow && rows.length) rows.push(rows[0]);
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
            ...(conv.mayCreateSessions ? { mayCreateSessions: true } : {}),
            ...(conv.sessionState ? { sessionState: conv.sessionState } : {}),
            ...(conv.sessionTasks ? { sessionTasks: conv.sessionTasks } : {}),
            ...(conv.groupId ? { groupId: conv.groupId, groupRole: conv.groupRole || 'member' } : {}),
            ...(conv.activityAt ? { activityAt: conv.activityAt } : {}),
          })),
          pageInfo: {
            hasMore: start + limit < ordered.length,
            nextCursor: last ? { beforeConversationId: last.id, beforeUpdatedAt: last.updatedAt } : null,
          },
          ...(remote.groups ? { groups: remote.groups } : {}),
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
            ...(conv.mayCreateSessions ? { mayCreateSessions: true } : {}),
            backgroundTasks: conv.backgroundTasks || [],
            ...(conv.sessionState ? { sessionState: conv.sessionState } : {}),
            ...(conv.sessionTasks ? { sessionTasks: conv.sessionTasks } : {}),
            ...(conv.group ? { group: conv.group } : {}),
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
        if (method === 'PATCH' && suffix === '/settings') {
          // A relay that predates update_session: a 404 without the route's code.
          if (remote.settingsRouteMissing) throw notFound();
          if (remote.settingsFailure) throw remote.settingsFailure;
          return remote.applySettings(relay, conv, body);
        }
      }

      if (method === 'POST' && path === '/api/conversation/bootstrap') {
        const takesGroup = !!remote.groupList && !remote.bootstrapIgnoresGroup;
        let group = null;
        if (takesGroup && body.group) {
          const groups = remote.groupsAtBootstrap || remote.groupList;
          const wanted = String(body.group).toLowerCase();
          group = groups.find((candidate) => candidate.id === body.group)
            || groups.find((candidate) => candidate.name.toLowerCase() === wanted);
          if (!group) {
            const error = `No session group "${body.group}" here. No conversation was created.`;
            throw remoteError(`${CODES.httpPrefix}400`, `Relay "${relay.name}" answered HTTP 400: ${error}`, 400, {
              ok: false,
              code: 'SESSION_GROUP_NOT_FOUND',
              error,
              // As the real route: at most 20, and the count when cut.
              groups: groups.slice(0, 20).map(({ id, name }) => ({ id, name })),
              ...(groups.length > 20 ? { groupsTotal: groups.length } : {}),
            });
          }
        }
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
          // A relay that predates the model checks swaps an unknown Copilot id.
          selectedModel: remote.bootstrapBinds || body.model,
          selectedProviderType: body.providerType,
          preferredRelayMode: body.relayMode,
          preferredReasoningEffort: effort,
          ...(takesGroup ? {
            group: group
              ? { id: group.id, name: group.name, role: 'member' }
              : (body.origin?.local === true ? remote.creatorGroup : null),
          } : {}),
        };
      }

      // POST /api/conversation/:id/billing, reduced: an older relay has no
      // such route; a refusal leaves both the billing and the transcript.
      const billingMatch = /^\/api\/conversation\/([^/]+)\/billing$/.exec(path);
      if (method === 'POST' && billingMatch) {
        if (remote.billingRouteMissing) throw notFound();
        const conv = remote.conversations.get(decodeURIComponent(billingMatch[1]));
        if (!conv) {
          throw remoteError(`${CODES.httpPrefix}404`, `Relay "${relay.name}" answered HTTP 404`, 404, {
            ok: false, code: 'CONVERSATION_NOT_FOUND', error: 'Conversation not found',
          });
        }
        if (remote.billingRefusal) {
          throw remoteError(`${CODES.httpPrefix}409`, `Relay "${relay.name}" answered HTTP 409`, 409, { ok: false, ...remote.billingRefusal });
        }
        conv.provider = body.to;
        const message = body.message;
        remote.addMessage(conv.id, {
          id: message.messageId,
          role: 'user',
          text: message.text,
          model: message.model,
          mode: message.relayMode,
          origin: message.origin,
        });
        conv.activeTurn = true;
        return { ok: true, messageId: message.messageId, conversationId: conv.id, runtimeProviderType: body.to, billingSwitched: true };
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
  // This relay's own API, as the loopback client reaches it (the local target).
  local = createFakeRemote(),
  // `{ enabled, maxWaitSeconds }` (null: a relay that never saved the settings).
  agentSessions = null,
  // Conversations (by id) whose agent the user already allowed to start sessions here.
  localApproved = [],
  withLocalClient = true,
  // The relay event service (subscribe and its siblings), or null.
  relayEvents = null,
} = {}) {
  const unlocks = new Set(unlocked.map((relayId) => `c-1:${relayId}`));
  const approvedLocal = new Set(localApproved);
  const repository = {
    hasUnlock: (conversationId, relayId) => unlocks.has(`${conversationId}:${relayId}`),
    hasContactFrom: (conversationId, instanceId) => conversationId === 'c-1' && contacts.includes(instanceId),
    latestHumanMessageId: () => humans.latest,
    // The local target's storage, read off the fake of this relay's own API.
    getConversationOrigin: (conversationId) => local.conversations.get(conversationId)?.origin || null,
    listActiveLocalSessions: (conversationId) => [...local.conversations.values()]
      .filter((conv) => conv.origin?.local === true && conv.origin.conversationId === conversationId && conv.activeTurn === true)
      .map((conv) => conv.id),
    hasLocalSessionApproval: (conversationId) => approvedLocal.has(conversationId),
    // The owner's "agents in this conversation may start sessions".
    mayCreateSessions: (conversationId) => local.conversations.get(conversationId)?.mayCreateSessions === true,
    recordUnlock: (conversationId, relayId) => {
      unlocks.add(`${conversationId}:${relayId}`);
      return true;
    },
    recordLocalSessionApproval: (conversationId) => {
      approvedLocal.add(conversationId);
      return true;
    },
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
    ...(withLocalClient ? { localClient: { request: (...args) => local.request(...args) } } : {}),
    getAgentSessionsSettings: () => agentSessions,
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
    relayEvents,
  });
  const run = (action, args = {}, conversationId = 'c-1') => dispatcher.dispatch({ conversationId, action, args });
  return { remote, local, dispatcher, run, logs, events, approvals, sleeps, clock, unlocks, approvedLocal };
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
    kind: 'ask_user',
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

test('a pending ask does not stop the wait: the session works on, and only the user answers it', async () => {
  const { run, remote } = setup();
  withSession(remote);
  remote.onMessage = (conv, body) => {
    conv.inFlight = { messageId: body.messageId, streamEvents: [{ seq: 1, text: 'Working on it', subagentRunId: null }], activities: [] };
    // A relay that hands asks out whatever it is asked (the waits never ask for them).
    remote.addQuestion({ id: 'ask_fixture0001', kind: 'ask', conversationId: 'conv-1', prompt: 'Which database?', question: 'Which database?', options: ['A'], status: 'pending' });
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 4 });
  assert.equal(result.body.status, 'running');
  assert.equal(result.body.pendingQuestions, undefined);
  const asked = remote.callsTo('GET', '/api/relay-questions');
  assert.ok(asked.length > 0);
  assert.ok(asked.every((entry) => entry.query?.includeAsks === undefined), 'the waits do not ask for asks');
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

const CREATE_ARGS = Object.freeze({ relay: 'linux-test', text: PROMPT, wait_seconds: 0 });
const SEND_ARGS = Object.freeze({ relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });

test('create_session refuses a model its provider does not list, with the close matches, before any card', async () => {
  const { run, remote, approvals } = setup({ caller: { provider: 'github', model: 'gpt-5.6-luna', mode: 'ask' } });
  const result = await run('create_session', { relay: 'linux-test', text: PROMPT, model: 'gpt-5-6-luna', wait_seconds: 0 });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, CODES.unknownModel);
  assert.equal(result.body.error,
    'Unknown model \'gpt-5-6-luna\' for Copilot on relay "linux-test"; did you mean \'gpt-5.6-luna\'? '
    + 'Valid ids: gpt-5.6-luna, claude-sonnet-5. No session was created.');
  assert.deepEqual(result.body.suggestions, ['gpt-5.6-luna']);
  assert.deepEqual(result.body.models, ['gpt-5.6-luna', 'claude-sonnet-5']);
  assert.equal(result.body.provider, 'github');
  assert.equal(remote.callsTo('POST', '/api/conversation/bootstrap').length, 0, 'nothing is created');
  assert.equal(remote.callsTo('POST', '/api/message').length, 0);
  assert.equal(approvals.length, 0, 'the user is not asked about a call that cannot run');

  // Each provider is checked against its own list: a Cursor id is no Claude model.
  const claude = await run('create_session', { relay: 'linux-test', text: PROMPT, provider: 'claude', model: 'composer-2.5' });
  assert.equal(claude.body.code, CODES.unknownModel);
  assert.match(claude.body.error, /^Unknown model 'composer-2\.5' for Claude on relay "linux-test"\. Valid ids: claude-sonnet-5, claude-opus-5\./);
  assert.equal(remote.callsTo('POST', '/api/conversation/bootstrap').length, 0);
});

test('create_session takes listed ids in any casing, Claude aliases and the "[1m]" tier, and auto', async () => {
  const cases = [
    // Another casing is the same id: no word about it.
    { args: { provider: 'claude', model: 'Claude-Opus-5' }, model: 'claude-opus-5', note: null },
    { args: { provider: 'claude', model: 'opus' }, model: 'claude-opus-5', note: /'opus' was taken as claude-opus-5, the newest Claude model of that name/ },
    { args: { provider: 'claude', model: 'sonnet' }, model: 'claude-sonnet-5', note: /'sonnet' was taken as claude-sonnet-5/ },
    { args: { provider: 'claude', model: 'claude-opus-5[1m]' }, model: 'claude-opus-5', note: /'claude-opus-5\[1m\]' was taken as claude-opus-5\. Claude on relay "linux-test" lists no "\[1m\]" id/ },
    // The effort in a Copilot id goes to the bootstrap and the first prompt apart.
    { args: { provider: 'github', model: 'GPT-5.6-luna-high' }, model: 'gpt-5.6-luna', effort: 'high', note: /'GPT-5\.6-luna-high' was taken as gpt-5\.6-luna with effort high\./ },
    { args: { provider: 'github', model: 'auto' }, model: 'auto', note: null },
  ];
  for (const { args, model, effort, note } of cases) {
    const { run, remote } = setup();
    remote.models.reasoningByModel = { 'gpt-5.6-luna': ['low', 'medium', 'high'] };
    const result = await run('create_session', { ...CREATE_ARGS, ...args });
    assert.equal(result.status, 200, `${args.model}: ${JSON.stringify(result.body)}`);
    const bootstrap = remote.callsTo('POST', '/api/conversation/bootstrap')[0].body;
    assert.equal(bootstrap.model, model, args.model);
    assert.equal(result.body.model, model, `${args.model}: the bound model`);
    if (effort) {
      assert.equal(bootstrap.reasoningEffort, effort);
      assert.equal(remote.callsTo('POST', '/api/message')[0].body.reasoningEffort, effort);
    }
    if (note) assert.match(result.body.modelNote, note);
    else assert.equal(result.body.modelNote, undefined, args.model);
  }
  // An effort the model does not list is no effort: the id is unknown, its base suggested.
  const { run, remote } = setup();
  remote.models.reasoningByModel = { 'gpt-5.6-luna': ['low', 'medium', 'high'] };
  const maxed = await run('create_session', { ...CREATE_ARGS, provider: 'github', model: 'gpt-5.6-luna-max' });
  assert.equal(maxed.body.code, CODES.unknownModel);
  assert.deepEqual(maxed.body.suggestions.slice(0, 1), ['gpt-5.6-luna']);
  assert.equal(remote.callsTo('POST', '/api/conversation/bootstrap').length, 0);
  // No family of that name: refused, with the ids that contain it.
  const unknown = await run('create_session', { ...CREATE_ARGS, provider: 'claude', model: 'haiku' });
  assert.equal(unknown.body.code, CODES.unknownModel);
});

test('create_session goes on with a model it cannot check, and says so', async () => {
  // Cursor set up, but its model list not discovered yet.
  const cursor = setup();
  cursor.remote.settings.cursor = { configured: true, enabled: true, model: '', models: [], availableModels: [] };
  const unchecked = await cursor.run('create_session', { ...CREATE_ARGS, provider: 'cursor', model: 'gpt-5-4' });
  assert.equal(unchecked.status, 200, JSON.stringify(unchecked.body));
  assert.equal(cursor.remote.callsTo('POST', '/api/conversation/bootstrap')[0].body.model, 'gpt-5-4');
  assert.equal(unchecked.body.modelNote,
    'Model \'gpt-5-4\' could not be checked: Cursor on relay "linux-test" has no model list yet (its model discovery has not run or failed), so the session was created with it as asked.');

  // Copilot without a catalogue (the models route failed).
  const copilot = setup();
  copilot.remote.fail('GET', '/api/models', remoteError(`${CODES.httpPrefix}500`, 'Relay "linux-test" answered HTTP 500', 500));
  const blind = await copilot.run('create_session', { ...CREATE_ARGS, provider: 'github', model: 'gpt-5-4' });
  assert.equal(blind.status, 200);
  assert.match(blind.body.modelNote, /could not be checked: Copilot on relay "linux-test" has no model list yet/);
});

test('a relay that binds another model than the one asked is named in the answer', async () => {
  const { run, remote } = setup();
  remote.bootstrapBinds = 'gpt-5.6-luna';
  const result = await run('create_session', { ...CREATE_ARGS, provider: 'github', model: 'claude-sonnet-5' });
  assert.equal(result.status, 200);
  assert.equal(result.body.model, 'gpt-5.6-luna');
  assert.match(result.body.modelNote, /Relay "linux-test" started the session on gpt-5\.6-luna, not on claude-sonnet-5 as asked\./);
});

test('a provider not set up there answers as such, before its model is looked at', async () => {
  const { run } = setup();
  const result = await run('create_session', { ...CREATE_ARGS, provider: 'cursor', model: 'whatever-1' });
  assert.equal(result.body.code, CODES.providerUnavailable);
});

test('send checks a model before any approval card, and takes the provider\'s whole list and the session\'s own model', async () => {
  const { run, remote, approvals } = setup({ caller: { mode: 'ask' } });
  withSession(remote, { model: 'claude-sonnet-4-5-20250929' });
  remote.settings.claude.availableModels = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5'];
  const refused = await run('send', { ...SEND_ARGS, model: 'claude-sonet-5' });
  assert.equal(refused.body.code, CODES.unknownModel);
  assert.equal(approvals.length, 0, 'no card for a send that cannot run');
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-5-20250929']) {
    const sent = await run('send', { ...SEND_ARGS, model });
    assert.equal(sent.status, 200, `${model}: ${JSON.stringify(sent.body)}`);
    assert.equal(remote.callsTo('POST', '/api/message').at(-1).body.model, model);
  }
  assert.equal(approvals.length, 2);
});

test('the local target checks the model before its once-per-conversation card', async () => {
  const { run, local, approvals } = setupLocal();
  const refused = await run('create_session', { relay: 'this', text: PROMPT, model: 'gpt-5-6-luna', provider: 'github', wait_seconds: 0 });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, CODES.unknownModel);
  assert.match(refused.body.error, /did you mean 'gpt-5\.6-luna'\?/);
  assert.equal(approvals.length, 0);
  assert.equal(local.callsTo('POST', '/api/conversation/bootstrap').length, 0);
  const created = await run('create_session', { relay: 'this', text: PROMPT, model: 'gpt-5.6-luna', provider: 'github', wait_seconds: 0 });
  assert.equal(created.status, 200);
  assert.equal(approvals.length, 1);
});

test('send refuses a model override the session\'s provider does not list; nothing is sent', async () => {
  const { run, remote } = setup();
  withSession(remote);
  const refused = await run('send', { ...SEND_ARGS, model: 'claude-sonet-5' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, CODES.unknownModel);
  assert.match(refused.body.error, /^Unknown model 'claude-sonet-5' for Claude on relay "linux-test"; did you mean 'claude-sonnet-5'\?.* Nothing was sent\.$/);
  assert.equal(remote.callsTo('POST', '/api/message').length, 0);

  const alias = await run('send', { ...SEND_ARGS, model: 'opus' });
  assert.equal(alias.status, 200);
  assert.equal(remote.callsTo('POST', '/api/message')[0].body.model, 'claude-opus-5');
  assert.match(alias.body.modelNote, /'opus' was taken as claude-opus-5/);

  // Without an override nothing is checked and no catalogue is read.
  const modelsRead = remote.callsTo('GET', '/api/models').length;
  const plain = await run('send', SEND_ARGS);
  assert.equal(plain.status, 200);
  assert.equal(remote.callsTo('GET', '/api/models').length, modelsRead);
  assert.equal(plain.body.modelNote, undefined);
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
  assert.deepEqual(Object.keys(byName), ['github', 'openai', 'claude', 'cursor', 'grok', 'claude-cloud', 'deepseek', 'claude-api']);
  assert.deepEqual(byName['claude-cloud'], { provider: 'claude-cloud', configured: false, defaultModel: null, models: [] },
    'a relay without the Claude Cloud settings route has no such provider');
  assert.deepEqual(byName.deepseek, { provider: 'deepseek', configured: false, defaultModel: null, models: [] },
    'a relay without the DeepSeek settings route has no such provider');
  assert.deepEqual(byName['claude-api'], { provider: 'claude-api', configured: false, defaultModel: null, models: [] },
    'a relay without the Claude API settings route has no such provider');
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

test('relay_info lists DeepSeek with its models while the remote has it switched on', async () => {
  const { run, remote } = setup();
  remote.settings.deepseek = {
    configured: true,
    enabled: true,
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  };
  const result = await run('relay_info', { relay: 'linux-test' });
  const deepseek = result.body.providers.find((entry) => entry.provider === 'deepseek');
  assert.equal(deepseek.configured, true);
  assert.equal(deepseek.defaultModel, 'deepseek-flash');
  assert.deepEqual(deepseek.models, ['deepseek-flash', 'deepseek-v4-pro']);

  // Saved key, switched off: listed, but not as a provider to start with.
  remote.settings.deepseek = { ...remote.settings.deepseek, enabled: false };
  const off = await run('relay_info', { relay: 'linux-test' });
  assert.equal(off.body.providers.find((entry) => entry.provider === 'deepseek').configured, false);
});

test('relay_info lists Claude API with its models while the remote has it switched on', async () => {
  const { run, remote } = setup();
  remote.settings['claude-api'] = {
    configured: true,
    enabled: true,
    model: 'claude-sonnet-5-5',
    models: ['claude-sonnet-5-5', 'claude-opus-5-5'],
  };
  const result = await run('relay_info', { relay: 'linux-test' });
  const claudeApi = result.body.providers.find((entry) => entry.provider === 'claude-api');
  assert.equal(claudeApi.configured, true);
  assert.equal(claudeApi.defaultModel, 'claude-sonnet-5-5');
  assert.deepEqual(claudeApi.models, ['claude-sonnet-5-5', 'claude-opus-5-5']);

  // Saved key, switched off: listed, but not as a provider to start with.
  remote.settings['claude-api'] = { ...remote.settings['claude-api'], enabled: false };
  const off = await run('relay_info', { relay: 'linux-test' });
  assert.equal(off.body.providers.find((entry) => entry.provider === 'claude-api').configured, false);
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
  assert.match(cloud.note, /create_session needs repo/);
  assert.match(cloud.note, /self-contained prompt and name the branch/);
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

test('create_session opens a Claude Cloud session on a paired relay from repo and branch', async () => {
  const { run, remote } = setup({ caller: { model: 'claude-sonnet-5', effort: 'high' } });
  remote.settings['claude-cloud'] = { enabled: true, defaultModel: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5', 'claude-sonnet-5'] };
  const result = await run('create_session', {
    relay: 'linux-test',
    text: PROMPT,
    provider: 'claude-cloud',
    repo: 'example-org/sample-repo',
    branch: 'feature/banner',
    wait_seconds: 0,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const [bootstrap] = remote.callsTo('POST', '/api/conversation/bootstrap');
  assert.equal(bootstrap.body.providerType, 'claude-cloud');
  assert.deepEqual(bootstrap.body.cloudSource, { repoUrl: 'https://github.com/example-org/sample-repo', branch: 'feature/banner' });
  // What New Chat does: the tab's default model unless one is asked for, and no effort.
  assert.equal('model' in bootstrap.body, false, 'this session\'s model is not mirrored into the cloud');
  assert.equal('reasoningEffort' in bootstrap.body, false);
  assert.equal('cwd' in bootstrap.body, false);
  assert.equal(bootstrap.body.origin.relayName, 'win-test');
  assert.equal('local' in bootstrap.body.origin, false, 'a paired relay is told nothing is local');
  assert.equal(bootstrap.hops, 1);
  assert.equal(result.body.provider, 'claude-cloud');
  assert.equal(result.body.repo, 'https://github.com/example-org/sample-repo');
  assert.equal(result.body.branch, 'feature/banner');
  assert.equal(result.body.modelSource, 'remote default');
  assert.equal('effort' in result.body, false);
  assert.equal(remote.callsTo('POST', '/api/message').length, 1);

  const asked = await run('create_session', {
    relay: 'linux-test', text: PROMPT, provider: 'claude-cloud', repo: 'example-org/sample-repo', model: 'claude-sonnet-5', wait_seconds: 0,
  });
  const second = remote.callsTo('POST', '/api/conversation/bootstrap')[1];
  assert.equal(second.body.model, 'claude-sonnet-5');
  assert.deepEqual(second.body.cloudSource, { repoUrl: 'https://github.com/example-org/sample-repo' }, 'no branch: the default one');
  assert.equal(asked.body.modelSource, 'requested');
  assert.equal(asked.body.branch, null);
});

test('create_session for Claude Cloud needs repo, takes it with that provider alone, and nothing is created otherwise', async () => {
  const { run, remote } = setup();
  remote.settings['claude-cloud'] = { enabled: true, defaultModel: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'] };
  const noRepo = await run('create_session', { relay: 'linux-test', text: PROMPT, provider: 'claude-cloud' });
  assert.equal(noRepo.status, 400);
  assert.equal(noRepo.body.code, CODES.invalidInput);
  assert.match(noRepo.body.error, /needs repo/);
  const wrongProvider = await run('create_session', { relay: 'linux-test', text: PROMPT, provider: 'claude', repo: 'example-org/sample-repo' });
  assert.equal(wrongProvider.status, 400);
  assert.match(wrongProvider.body.error, /provider "claude-cloud" only/);
  const badBranch = await run('create_session', { relay: 'linux-test', text: PROMPT, provider: 'claude-cloud', repo: 'example-org/sample-repo', branch: 'no good' });
  assert.equal(badBranch.status, 400);
  assert.match(badBranch.body.error, /not a valid branch name/);
  assert.equal(remote.calls.length, 0, 'refused before the relay is asked anything');

  // A cloud session that names no provider would get its own: repo is asked for then.
  const cloudCaller = setup({ caller: { provider: 'claude-cloud' } });
  cloudCaller.remote.settings['claude-cloud'] = { enabled: true, defaultModel: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'] };
  const inherited = await cloudCaller.run('create_session', { relay: 'linux-test', text: PROMPT });
  assert.equal(inherited.status, 400);
  assert.equal(inherited.body.code, CODES.invalidInput);
  assert.match(inherited.body.error, /This session's provider is claude-cloud/);
  assert.equal(cloudCaller.remote.calls.length, 0);

  // The user is not asked to approve a call that cannot run: not in ask mode,
  // and not with the once-per-conversation card of this relay.
  for (const relay of ['linux-test', 'this']) {
    const asking = setup({ caller: { provider: 'claude-cloud', mode: 'ask' }, agentSessions: { enabled: true, maxWaitSeconds: 600 } });
    const refused = await asking.run('create_session', { relay, text: PROMPT });
    assert.equal(refused.status, 400, relay);
    assert.match(refused.body.error, /This session's provider is claude-cloud/);
    assert.equal(asking.approvals.length, 0, relay);
    assert.equal(asking.approvedLocal.size, 0);
  }
});

test('create_session for Claude Cloud says when the provider is off there, and passes the bootstrap\'s own refusals on', async () => {
  const { run, remote } = setup();
  const args = { relay: 'linux-test', text: PROMPT, provider: 'claude-cloud', repo: 'example-org/sample-repo' };
  // A relay that predates the provider: no settings route.
  const absent = await run('create_session', args);
  assert.equal(absent.body.code, CODES.providerUnavailable);
  assert.equal('remoteCode' in absent.body, false);
  // Switched off: the code New Chat's bootstrap would answer with.
  remote.settings['claude-cloud'] = { enabled: false, defaultModel: 'claude-sonnet-5-5', models: [] };
  const off = await run('create_session', args);
  assert.equal(off.status, 400);
  assert.equal(off.body.code, CODES.providerUnavailable);
  assert.equal(off.body.remoteCode, 'claude_cloud_disabled');
  assert.equal(remote.callsTo('POST', '/api/conversation/bootstrap').length, 0);
  // No environment set: the bootstrap's refusal, with its code.
  remote.settings['claude-cloud'] = { enabled: true, defaultModel: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'] };
  remote.fail('POST', '/api/conversation/bootstrap', remoteError(`${CODES.httpPrefix}400`, 'Relay "linux-test" answered HTTP 400: No cloud environment is set.', 400, {
    ok: false,
    code: 'claude_cloud_environment_missing',
    error: 'No cloud environment is set.',
  }));
  const noEnvironment = await run('create_session', args);
  assert.equal(noEnvironment.status, 400);
  assert.equal(noEnvironment.body.remoteCode, 'claude_cloud_environment_missing');
  assert.match(noEnvironment.body.error, /No cloud environment is set/);
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
  // A card without typed text takes none from an agent either (the remote's
  // answer route would refuse it); an option typed as the answer is an option.
  remote.addQuestion({ id: 'question-6', conversationId: 'conv-9', prompt: 'Pick one', choices: ['Light', 'Dark'], allowFreeform: false, sdkSessionId: null });
  const typed = await run('answer_question', { relay: 'linux-test', question_id: 'question-6', answer: 'whichever is darker' });
  assert.equal(typed.status, 400);
  assert.equal(typed.body.code, CODES.invalidInput);
  assert.match(typed.body.error, /takes only its options \(Light, Dark\)/);
  assert.equal(remote.callsTo('POST', '/api/relay-question/question-6/answer').length, 0);
  const typedOption = await run('answer_question', { relay: 'linux-test', question_id: 'question-6', answer: ' light ' });
  assert.equal(typedOption.status, 200);
  assert.deepEqual(remote.callsTo('POST', '/api/relay-question/question-6/answer')[0].body, { answer: 'Light' });

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

  // A model the remote's list offered when it was read, refused by its
  // bootstrap all the same: its own code and list are passed on.
  const conflict = setup();
  conflict.remote.fail('POST', '/api/conversation/bootstrap', remoteError(`${CODES.httpPrefix}400`, 'Relay "linux-test" answered HTTP 400: Claude model "claude-opus-5" is not available', 400, {
    error: 'Claude model "claude-opus-5" is not available',
    code: 'CLAUDE_MODEL_UNAVAILABLE',
    supportedModels: ['claude-sonnet-5'],
  }));
  const refused = await conflict.run('create_session', { relay: 'linux-test', text: PROMPT, model: 'claude-opus-5' });
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
  assert.equal(requests[1].url, 'https://relay-b.example.test/api/conversation/conv%2F..%2Fx?limit=10&groupMembers=1');
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

// ─── The local target: sessions on this relay itself ────────────────────────

const AGENT_SESSIONS_ON = Object.freeze({ enabled: true, maxWaitSeconds: 600 });

/** A setup with the local target on and no paired relay unlocked (it needs none). */
function setupLocal(options = {}) {
  return setup({ agentSessions: AGENT_SESSIONS_ON, unlocked: [], ...options });
}

function withLocalSession(local, overrides = {}) {
  local.addConversation({ id: 'conv-1', title: 'sidebar polish', ...overrides });
  local.addMessage('conv-1', { id: 'm-old-user', role: 'user', text: 'Earlier question' });
  local.addMessage('conv-1', { id: 'm-old-reply', role: 'assistant', text: 'Earlier answer', sourceMessageId: 'm-old-user', model: 'claude-sonnet-5' });
  return local.conversations.get('conv-1');
}

test('while the setting is off this relay is no target: not listed, and refused by name and as "this"', async () => {
  for (const agentSessions of [null, { enabled: false, maxWaitSeconds: 600 }]) {
    const { run, local, remote } = setup({ agentSessions });
    const listed = await run('list_relays');
    assert.deepEqual(listed.body.relays.map((relay) => relay.name), ['linux-test', 'spare-test']);
    assert.equal(listed.body.relays.some((relay) => relay.self), false);
    assert.doesNotMatch(listed.body.hint, /marked self/);
    for (const name of ['this', 'THIS', '@this', 'win-test']) {
      const refused = await run('list_sessions', { relay: name });
      assert.equal(refused.status, 403, name);
      assert.equal(refused.body.code, CODES.localDisabled);
      assert.match(refused.body.error, /Agents may start and use sessions on this relay/);
      assert.match(refused.body.error, /Ask the user to turn it on/);
    }
    const create = await run('create_session', { relay: 'this', text: PROMPT });
    assert.equal(create.body.code, CODES.localDisabled);
    assert.equal(local.calls.length, 0);
    assert.equal(remote.calls.length, 0);
  }
});

test('without the loopback client the local target does not exist, whatever the setting says', async () => {
  const { run } = setupLocal({ withLocalClient: false });
  assert.equal((await run('list_relays')).body.relays.some((relay) => relay.self), false);
  assert.equal((await run('relay_info', { relay: 'this' })).body.code, CODES.localDisabled);
});

test('list_relays puts this relay first, marked self, with the limits that apply here', async () => {
  const { run, local, remote } = setupLocal();
  const result = await run('list_relays');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.relays[0], { name: 'win-test', self: true, online: true, version: '0.9.4', permission: 'full', unlocked: true });
  assert.deepEqual(result.body.relays.slice(1).map((relay) => [relay.name, relay.unlocked]), [['linux-test', false], ['spare-test', false]]);
  assert.deepEqual(result.body.limits, { maxWaitSeconds: 600, maxActiveSessions: 4 });
  assert.match(result.body.summary, /3 relays, 1 unlocked/);
  assert.match(result.body.hint, /marked self is the one you run on/);
  assert.match(result.body.hint, /"this"/);
  assert.equal(local.calls.length + remote.calls.length, 0, 'list_relays asks nobody');
});

test('the local target needs no mention, no permission and no hop, and is reached through the loopback', async () => {
  const { run, local, remote } = setupLocal({ caller: { hops: 2, originRelayIds: ['relay-linux-id'] } });
  withLocalSession(local);
  const info = await run('relay_info', { relay: 'this' });
  assert.equal(info.status, 200, JSON.stringify(info.body));
  assert.equal(info.body.relay, 'win-test');
  assert.equal(info.body.self, true);
  assert.equal(info.body.acceptsAgentPrompts, true);
  assert.match(info.body.sessionRules, /at most 4 sessions/);

  const sessions = await run('list_sessions', { relay: 'win-test' });
  assert.equal(sessions.status, 200);
  assert.deepEqual(sessions.body.sessions.map((session) => session.id), ['conv-1']);
  const read = await run('read_session', { relay: '@this', session: 'conv-1' });
  assert.equal(read.status, 200);
  assert.equal(read.body.messages.length, 2);

  // A turn that acts on a prompt two relays away may still write here.
  const sent = await run('send', { relay: 'this', session: 'conv-1', text: PROMPT, wait_seconds: 0 });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const [message] = local.callsTo('POST', '/api/message');
  assert.equal(message.hops, 2, 'a call on this relay adds no hop');
  assert.equal(message.body.origin.hops, 2);
  assert.equal(message.body.origin.local, true);
  assert.equal(message.body.origin.conversationId, 'c-1');
  assert.equal(message.body.origin.conversationTitle, 'report builder');
  assert.match(message.body.text, REMOTE_PROMPT_HEADER_PATTERN);
  assert.equal(remote.calls.length, 0, 'no paired relay was asked');
  assert.ok(local.calls.every((call) => call.relay === 'win-test'));
});

test('a paired relay that shares this relay\'s name keeps the name; "this" still means this relay', async () => {
  const twin = { ...LINUX, name: 'win-test' };
  const { run, local, remote } = setupLocal({ relays: [twin], unlocked: ['rr_linux'] });
  const byName = await run('list_sessions', { relay: 'win-test' });
  assert.equal(byName.status, 200);
  assert.equal(remote.callsTo('GET', '/api/conversations').length, 1);
  assert.equal(local.calls.length, 0);
  const byAlias = await run('list_sessions', { relay: 'this' });
  assert.equal(byAlias.status, 200);
  assert.equal(local.callsTo('GET', '/api/conversations').length, 1);
});

test('an unknown name says how this relay is addressed when it is a target', async () => {
  const unknown = await setupLocal().run('relay_info', { relay: 'nowhere' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, CODES.unknown);
  assert.match(unknown.body.error, /this relay itself is "win-test" \(or "this"\)/);
  assert.doesNotMatch((await setup().run('relay_info', { relay: 'nowhere' })).body.error, /this relay itself/);
});

test('the first create_session here asks the user once; after Allow the conversation creates without a card', async () => {
  const { run, local, approvals, approvedLocal, events } = setupLocal();
  const first = await run('create_session', { relay: 'this', text: PROMPT, cwd: '/home/dev/work', wait_seconds: 0 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.relay, 'win-test');
  assert.equal(first.body.status, 'queued');
  assert.equal(first.body.session, 'conv-new-1');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].localSessions, true);
  assert.equal(approvals[0].action, 'create_session');
  assert.deepEqual(approvals[0].relay, { id: 'self', name: 'win-test', url: 'https://relay-a.example.test', local: true });
  assert.equal(approvals[0].args.cwd, '/home/dev/work');
  assert.deepEqual([...approvedLocal], ['c-1'], 'the Allow is stored for the conversation');

  // The session is created the way a paired relay's request creates one, with the local origin.
  const [bootstrap] = local.callsTo('POST', '/api/conversation/bootstrap');
  assert.equal(bootstrap.body.providerType, 'claude');
  assert.equal(bootstrap.body.cwd, '/home/dev/work');
  assert.deepEqual(bootstrap.body.origin, {
    kind: 'agent',
    relayId: 'relay-self-id',
    relayName: 'win-test',
    relayUrl: 'https://relay-a.example.test',
    conversationId: 'c-1',
    conversationTitle: 'report builder',
    provider: 'claude',
    model: 'claude-sonnet-5',
    hops: 0,
    local: true,
  });
  assert.equal(bootstrap.hops, 0);
  assert.equal(local.callsTo('POST', '/api/message')[0].body.origin.local, true);

  const second = await run('create_session', { relay: 'this', text: 'Check the export too', wait_seconds: 0 });
  assert.equal(second.status, 200);
  assert.equal(second.body.session, 'conv-new-2');
  assert.equal(approvals.length, 1, 'no second card');
  // send to a session it created needs none either.
  const sent = await run('send', { relay: 'this', session: 'conv-new-1', text: 'And the numbers?', wait_seconds: 0 });
  assert.equal(sent.status, 200);
  assert.equal(approvals.length, 1);
  assert.deepEqual(events.map((event) => [event.action, event.relay, event.relayId, event.ok]), [
    ['create_session', 'win-test', 'self', true],
    ['create_session', 'win-test', 'self', true],
    ['send', 'win-test', 'self', true],
  ]);

  // Another conversation has its own approval to get.
  const other = await run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 0 }, 'c-2');
  assert.equal(other.status, 200);
  assert.equal(approvals.length, 2);
  assert.equal(approvals[1].conversationId, 'c-2');
});

test('an Allow given earlier (before a restart) is read from storage: no card', async () => {
  const { run, approvals } = setupLocal({ localApproved: ['c-1'] });
  const result = await run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 0 });
  assert.equal(result.status, 200);
  assert.equal(approvals.length, 0);
});

test('Deny refuses that call only: nothing is created, nothing is remembered, the next create asks again', async () => {
  const answers = [false, { approved: false, code: CODES.noTurn, error: 'no running turn to ask on' }, true];
  const asked = [];
  const { run, local, approvedLocal } = setupLocal({
    requestApproval: async (request) => {
      asked.push(request);
      return answers.shift();
    },
  });
  const denied = await run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 0 });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, CODES.approvalDenied);
  assert.match(denied.body.error, /did not allow this agent to start a session on this relay/);
  assert.equal(local.callsTo('POST', '/api/conversation/bootstrap').length, 0);
  assert.equal(approvedLocal.size, 0);

  const noTurn = await run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 0 });
  assert.equal(noTurn.body.code, CODES.noTurn, 'the card\'s own refusal is passed on');
  assert.equal(approvedLocal.size, 0);

  const allowed = await run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 0 });
  assert.equal(allowed.status, 200);
  assert.equal(asked.length, 3);
  assert.deepEqual([...approvedLocal], ['c-1']);
});

test('first creates that arrive together share one card and its answer', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const asked = [];
  const { run, local } = setupLocal({
    requestApproval: async (request) => {
      asked.push(request);
      await gate;
      return true;
    },
  });
  const calls = [1, 2, 3].map((index) => run('create_session', { relay: 'this', text: `Part ${index} of the report`, wait_seconds: 0 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked.length, 1, 'one card for the three calls');
  release();
  const results = await Promise.all(calls);
  assert.deepEqual(results.map((result) => result.status), [200, 200, 200]);
  assert.equal(asked.length, 1);
  assert.equal(local.callsTo('POST', '/api/conversation/bootstrap').length, 3);

  // And a shared Deny refuses all of them.
  const denied = [];
  let deny;
  const denyGate = new Promise((resolve) => { deny = resolve; });
  const refusing = setupLocal({
    requestApproval: async (request) => {
      denied.push(request);
      await denyGate;
      return false;
    },
  });
  const refusedCalls = [1, 2].map(() => refusing.run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 0 }));
  await new Promise((resolve) => setImmediate(resolve));
  deny();
  assert.deepEqual((await Promise.all(refusedCalls)).map((result) => result.body.code), [CODES.approvalDenied, CODES.approvalDenied]);
  assert.equal(denied.length, 1);
  assert.equal(refusing.local.callsTo('POST', '/api/conversation/bootstrap').length, 0);
});

test('one level only: a session an agent created cannot create sessions, and nobody is asked', async () => {
  for (const origin of [
    { relayId: 'relay-self-id', relayName: 'win-test', conversationId: 'c-0', hops: 0, local: true },
    // Created from a paired relay: the same rule.
    { relayId: 'relay-linux-id', relayName: 'linux-test', conversationId: 'conv-elsewhere', hops: 1 },
  ]) {
    const { run, local, approvals } = setupLocal();
    local.addConversation({ id: 'c-1', title: 'report builder', origin });
    const refused = await run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 0 });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, CODES.nestedSession);
    assert.match(refused.body.error, /^A session that an agent created cannot create sessions \(unless the relay's owner allows it for this session\)\./);
    assert.equal(approvals.length, 0);
    assert.equal(local.callsTo('POST', '/api/conversation/bootstrap').length, 0);
    // Everything else stays open to it.
    local.addConversation({ id: 'conv-9', title: 'sidebar polish' });
    assert.equal((await run('read_session', { relay: 'this', session: 'conv-9' })).status, 200);
    assert.equal((await run('send', { relay: 'this', session: 'conv-9', text: 'Done with my part', wait_seconds: 0 })).status, 200);
  }
});

test('the one-level rule is the local target\'s: a created session may still create on a paired relay it may use', async () => {
  const { run, local, remote } = setupLocal({ unlocked: ['rr_linux'] });
  local.addConversation({ id: 'c-1', title: 'report builder', origin: { relayId: 'relay-self-id', relayName: 'win-test', conversationId: 'c-0', hops: 0, local: true } });
  const result = await run('create_session', { relay: 'linux-test', text: PROMPT, wait_seconds: 0 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(remote.callsTo('POST', '/api/conversation/bootstrap').length, 1);
});

test('the fifth session at work is refused until one of the four finishes', async () => {
  const { run, local, approvals } = setupLocal({ localApproved: ['c-1'] });
  for (let index = 1; index <= 4; index += 1) {
    const created = await run('create_session', { relay: 'this', text: `Part ${index} of the report`, wait_seconds: 0 });
    assert.equal(created.status, 200, JSON.stringify(created.body));
  }
  const fifth = await run('create_session', { relay: 'this', text: 'Part 5 of the report', wait_seconds: 0 });
  assert.equal(fifth.status, 409);
  assert.equal(fifth.body.code, CODES.sessionLimit);
  assert.equal(fifth.body.error, '4 sessions you started are still working; wait for one to finish.');
  assert.equal(fifth.body.limit, 4);
  assert.deepEqual(fifth.body.sessions, ['conv-new-1', 'conv-new-2', 'conv-new-3', 'conv-new-4']);
  assert.match(fifth.body.note, /Use wait/);
  assert.equal(local.callsTo('POST', '/api/conversation/bootstrap').length, 4);
  assert.equal(approvals.length, 0);

  // Sessions another conversation started, or a human, do not count against this one.
  const elsewhere = await run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 0 }, 'c-2');
  assert.equal(elsewhere.status, 200);
  // Sending to one of the four is not creating.
  assert.equal((await run('send', { relay: 'this', session: 'conv-new-1', text: 'One more thing', wait_seconds: 0 })).status, 200);

  local.conversations.get('conv-new-2').activeTurn = false;
  const again = await run('create_session', { relay: 'this', text: 'Part 5 of the report', wait_seconds: 0 });
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

test('creates that arrive together cannot slip past the cap', async () => {
  const { run, local } = setupLocal({ localApproved: ['c-1'] });
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map((index) => run('create_session', {
    relay: 'this', text: `Part ${index} of the report`, wait_seconds: 0,
  })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 200, 200, 200, 409, 409]);
  assert.equal(local.callsTo('POST', '/api/conversation/bootstrap').length, 4);
  for (const result of results.filter((entry) => entry.status === 409)) assert.equal(result.body.code, CODES.sessionLimit);
});

test('a create that fails gives its place under the cap back', async () => {
  const { run, local } = setupLocal({ localApproved: ['c-1'] });
  local.fail('POST', '/api/conversation/bootstrap', remoteError(`${CODES.httpPrefix}400`, 'Relay "win-test" answered HTTP 400: Model is not available', 400, { error: 'Model is not available' }));
  for (let index = 0; index < 6; index += 1) {
    const failed = await run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 0 });
    assert.equal(failed.status, 400);
    assert.equal(failed.body.code, `${CODES.httpPrefix}400`);
  }
  local.failures.clear();
  assert.equal((await run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 0 })).status, 200);
});

test('the cap does not apply to sessions created on a paired relay', async () => {
  const { run, remote } = setupLocal({ unlocked: ['rr_linux'] });
  for (let index = 1; index <= 6; index += 1) {
    const created = await run('create_session', { relay: 'linux-test', text: `Part ${index}`, wait_seconds: 0 });
    assert.equal(created.status, 200, JSON.stringify(created.body));
  }
  assert.equal(remote.callsTo('POST', '/api/conversation/bootstrap').length, 6);
});

test('an agent cannot send to, stop, archive or wait on the conversation it runs in', async () => {
  const { run, local } = setupLocal({
    // The OAR MCP server names its session by SDK session id.
    resolveConversationId: (id) => (id === 'sdk-c-1' ? 'c-1' : id),
  });
  local.addConversation({ id: 'c-1', title: 'report builder' });
  local.addMessage('c-1', { id: 'm-own', role: 'user', text: 'Build the report' });
  for (const [action, extra] of [
    ['send', { text: PROMPT }],
    ['stop', {}],
    ['archive', {}],
    ['wait', { message_id: 'm-own' }],
  ]) {
    for (const session of ['c-1', 'sdk-c-1']) {
      const refused = await run(action, { relay: 'this', session, ...extra });
      assert.equal(refused.status, 400, `${action} ${session}`);
      assert.equal(refused.body.code, CODES.ownSession);
      assert.match(refused.body.error, /the conversation you are running in/);
    }
  }
  assert.equal(local.calls.length, 0, 'refused before this relay\'s API is touched');
  // Reading itself is harmless and stays allowed.
  assert.equal((await run('read_session', { relay: 'this', session: 'c-1' })).status, 200);
});

test('an agent cannot answer a question of its own conversation; another session\'s it can', async () => {
  const { run, local } = setupLocal();
  local.addConversation({ id: 'c-1', title: 'report builder' });
  local.addConversation({ id: 'conv-2', title: 'sidebar polish' });
  local.addQuestion({ id: 'q-own', conversationId: 'c-1', prompt: 'Which colour?', choices: ['Teal', 'Amber'] });
  local.addQuestion({ id: 'q-other', conversationId: 'conv-2', prompt: 'Which colour?', choices: ['Teal', 'Amber'] });
  const own = await run('answer_question', { relay: 'this', question_id: 'q-own', choices: ['Teal'] });
  assert.equal(own.status, 400);
  assert.equal(own.body.code, CODES.ownSession);
  assert.equal(local.questions.get('q-own').status, 'pending');
  const other = await run('answer_question', { relay: 'this', question_id: 'q-other', choices: ['Teal'] });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.equal(local.questions.get('q-other').answer, 'Teal');
});

test('the same session id on a paired relay is another conversation: no own-session refusal there', async () => {
  const { run, remote } = setupLocal({ unlocked: ['rr_linux'] });
  remote.addConversation({ id: 'c-1', title: 'a session that happens to share the id' });
  const sent = await run('send', { relay: 'linux-test', session: 'c-1', text: PROMPT, wait_seconds: 0 });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
});

test('in ask mode the first create shows the one card; later writes here get the ordinary one', async () => {
  const { run, approvals } = setupLocal({ caller: { mode: 'ask' } });
  const first = await run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 0 });
  assert.equal(first.status, 200);
  assert.equal(approvals.length, 1, 'not two cards for one call');
  assert.equal(approvals[0].localSessions, true);

  const second = await run('create_session', { relay: 'this', text: 'Check the export too', wait_seconds: 0 });
  assert.equal(second.status, 200);
  assert.equal(approvals.length, 2);
  assert.equal(approvals[1].localSessions, undefined);
  assert.equal(approvals[1].relay.local, true);
  const stop = await run('stop', { relay: 'this', session: 'conv-new-1' });
  assert.equal(stop.status, 200);
  assert.equal(approvals.length, 3);
  // Reads never ask.
  await run('read_session', { relay: 'this', session: 'conv-new-1' });
  assert.equal(approvals.length, 3);
});

test('create_session here opens a Claude Cloud session from repo and branch', async () => {
  const { run, local } = setupLocal({ localApproved: ['c-1'] });
  local.settings['claude-cloud'] = { enabled: true, defaultModel: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'] };
  // As the real routes answer for a cloud conversation.
  local.efforts.supported = ['none'];
  const result = await run('create_session', {
    relay: 'this',
    text: 'Fix the sample banner on the branch feature/banner and push it.',
    provider: 'claude-cloud',
    repo: 'https://github.com/example-org/sample-repo.git',
    branch: 'feature/banner',
    wait_seconds: 0,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const [bootstrap] = local.callsTo('POST', '/api/conversation/bootstrap');
  assert.equal(bootstrap.body.providerType, 'claude-cloud');
  assert.deepEqual(bootstrap.body.cloudSource, { repoUrl: 'https://github.com/example-org/sample-repo', branch: 'feature/banner' });
  assert.equal(bootstrap.body.origin.local, true);
  assert.equal('model' in bootstrap.body, false);
  assert.equal(result.body.repo, 'https://github.com/example-org/sample-repo');
  assert.equal(result.body.branch, 'feature/banner');
  assert.equal(result.body.provider, 'claude-cloud');
  // The cloud names an effort of its own ("none"): not this call's business.
  assert.equal('effort' in result.body, false);
  assert.equal('effortSource' in result.body, false);
});

test('list_sessions here says which sessions an agent created, and which of them this one did', async () => {
  const { run, local } = setupLocal();
  local.addConversation({ id: 'conv-mine', title: 'part one', origin: { relayName: 'win-test', conversationId: 'c-1', local: true } });
  local.addConversation({ id: 'conv-theirs', title: 'part two', origin: { relayName: 'win-test', conversationId: 'c-7', local: true } });
  local.addConversation({ id: 'conv-remote', title: 'part three', origin: { relayName: 'linux-test', conversationId: 'c-1' } });
  local.addConversation({ id: 'conv-human', title: 'part four' });
  const result = await run('list_sessions', { relay: 'this' });
  const byId = Object.fromEntries(result.body.sessions.map((session) => [session.id, session]));
  assert.equal(byId['conv-mine'].createdBy, 'c-1');
  assert.equal(byId['conv-mine'].startedByYou, true);
  assert.equal(byId['conv-theirs'].createdBy, 'c-7');
  assert.equal('startedByYou' in byId['conv-theirs'], false);
  assert.equal('createdBy' in byId['conv-remote'], false);
  assert.equal(byId['conv-remote'].via, 'linux-test');
  assert.equal('createdBy' in byId['conv-human'], false);
});

test('list_sessions pages by the row\'s sort time and group, and drops a group served again', async () => {
  const { run, local } = setupLocal();
  local.groups = { grp_1: { id: 'grp_1', name: null, displayName: 'report builder', parentConversationId: 'c-1', memberCount: 2, liveMemberCount: 2 } };
  local.addConversation({ id: 'c-1', title: 'report builder', updatedAt: '2026-09-20T10:00:00.000Z', activityAt: '2026-09-20T12:00:00.000Z', groupId: 'grp_1', groupRole: 'head' });
  local.addConversation({ id: 'conv-kid', title: 'part one', updatedAt: '2026-09-20T12:00:00.000Z', activityAt: '2026-09-20T12:00:00.000Z', groupId: 'grp_1', groupRole: 'member' });
  local.addConversation({ id: 'conv-human', title: 'part four', updatedAt: '2026-09-20T11:00:00.000Z' });
  const first = await run('list_sessions', { relay: 'this', scope: 'all', limit: 1 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.nextCursor, 'more to come');
  const second = await run('list_sessions', { relay: 'this', scope: 'all', limit: 1, cursor: first.body.nextCursor });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const query = local.callsTo('GET', '/api/conversations').at(-1).query;
  // The cursor names the row's sort time (its group's), not its own updatedAt, and its group.
  assert.equal(query.beforeUpdatedAt, '2026-09-20T12:00:00.000Z');
  assert.equal(query.beforeGroupId, 'grp_1');
  // A relay that serves a row again (its cursor row vanished, the group came whole) does not list it twice.
  local.repeatFirstRow = true;
  const all = await run('list_sessions', { relay: 'this', scope: 'all', limit: 10 });
  assert.deepEqual(all.body.sessions.map((session) => session.id), ['conv-kid', 'conv-human', 'c-1']);
});

test('list_sessions and read_session show the session group a session sits in', async () => {
  const { run, local } = setupLocal();
  local.groups = { grp_1: { id: 'grp_1', name: null, displayName: 'report builder', parentConversationId: 'c-1', memberCount: 2, liveMemberCount: 2 } };
  local.addConversation({ id: 'c-1', title: 'report builder', groupId: 'grp_1', groupRole: 'head' });
  local.addConversation({ id: 'conv-mine', title: 'part one', origin: { relayName: 'win-test', conversationId: 'c-1', local: true }, groupId: 'grp_1', groupRole: 'member' });
  local.addConversation({ id: 'conv-human', title: 'part four' });
  const listed = await run('list_sessions', { relay: 'this' });
  const byId = Object.fromEntries(listed.body.sessions.map((session) => [session.id, session]));
  assert.deepEqual(byId['c-1'].group, { id: 'grp_1', name: 'report builder', role: 'head' });
  assert.deepEqual(byId['conv-mine'].group, { id: 'grp_1', name: 'report builder', role: 'member' });
  assert.equal('group' in byId['conv-human'], false);

  local.conversations.get('conv-mine').group = {
    id: 'grp_1',
    name: null,
    displayName: 'report builder',
    role: 'member',
    members: [
      { id: 'c-1', title: 'report builder', role: 'head', state: 'running_turn', archived: false },
      { id: 'conv-mine', title: 'part one', role: 'member', state: 'idle', archived: false },
    ],
  };
  const read = await run('read_session', { relay: 'this', session: 'conv-mine' });
  assert.deepEqual(read.body.session.group, {
    id: 'grp_1',
    name: 'report builder',
    role: 'member',
    members: [
      { id: 'c-1', title: 'report builder', role: 'head', state: 'running_turn' },
      { id: 'conv-mine', title: 'part one', role: 'member', state: 'idle' },
    ],
  });
  const plain = await run('read_session', { relay: 'this', session: 'conv-human' });
  assert.equal('group' in plain.body.session, false);
});

test('the rate limit and the loop guard count calls on this relay like any other', async () => {
  const { run, local, approvals } = setupLocal({ localApproved: ['c-1'], humans: { latest: 'm-human-1' } });
  withLocalSession(local);
  for (let index = 0; index < REMOTE_RELAY_LIMITS.writesPerMinute; index += 1) {
    assert.equal((await run('stop', { relay: 'this', session: 'conv-1' })).status, 200);
  }
  const limited = await run('stop', { relay: 'this', session: 'conv-1' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, CODES.rateLimited);
  assert.equal(approvals.length, 0);
});

// ─── The longest wait ────────────────────────────────────────────────────────

test('wait_seconds follows the relay\'s setting: an hour really waits an hour', async () => {
  const { run, remote, clock, sleeps } = setup({ agentSessions: { enabled: false, maxWaitSeconds: 3600 } });
  withSession(remote);
  remote.onMessage = (conv, body) => { conv.inFlight = { messageId: body.messageId, streamEvents: [], activities: [] }; };
  const started = clock.now;
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 3600 });
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'running');
  assert.equal(clock.now - started, 3600 * 1000, 'polled until the hour was over');
  assert.equal(sleeps.length, 1800);
  assert.doesNotMatch(result.body.note, /more than this relay allows/);
});

test('a wait longer than the setting is cut to it, and the result says so', async () => {
  for (const [agentSessions, expected] of [
    [null, 600],
    [{ enabled: false, maxWaitSeconds: 600 }, 600],
    [{ enabled: true, maxWaitSeconds: 120 }, 120],
    [{ enabled: false, maxWaitSeconds: 1800 }, 1800],
  ]) {
    const { run, remote, clock } = setup({ agentSessions });
    withSession(remote);
    remote.onMessage = (conv, body) => { conv.inFlight = { messageId: body.messageId, streamEvents: [], activities: [] }; };
    const started = clock.now;
    const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 3600 });
    assert.equal(result.body.status, 'running');
    assert.equal(clock.now - started, expected * 1000, `waited ${expected} s`);
    assert.match(result.body.note, new RegExp(`wait_seconds 3600 is more than this relay allows per call \\(${expected}, set by its owner\\)`));
    assert.match(result.body.note, /Call wait with this session and message_id/, 'the outcome\'s own note is kept');
  }
});

test('the wait action and the local target follow the same limit', async () => {
  const { run, local, clock } = setupLocal({ agentSessions: { enabled: true, maxWaitSeconds: 1200 }, localApproved: ['c-1'] });
  local.onMessage = (conv, body) => { conv.inFlight = { messageId: body.messageId, streamEvents: [], activities: [] }; };
  const started = clock.now;
  const created = await run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 5000 });
  assert.equal(created.body.status, 'running');
  assert.equal(clock.now - started, 1200 * 1000);
  assert.match(created.body.note, /wait_seconds 5000 is more than this relay allows per call \(1200/);

  const before = clock.now;
  const waited = await run('wait', { relay: 'this', session: created.body.session, message_id: created.body.message_id, wait_seconds: 900 });
  assert.equal(waited.body.status, 'running');
  assert.equal(clock.now - before, 900 * 1000, 'inside the limit: as asked');
  assert.doesNotMatch(waited.body.note, /more than this relay allows/);
  assert.deepEqual((await run('list_relays')).body.limits, { maxWaitSeconds: 1200, maxActiveSessions: 4 });
});

// ─── Event subscriptions ─────────────────────────────────────────────────────

/** A stand-in for the relay event service: records calls, keeps subscriptions. */
function createFakeRelayEvents() {
  const subscriptions = [];
  // noteOwnPrompt / beginOwnWait / endOwnWait, in order.
  const own = [];
  let counter = 0;
  return {
    subscriptions,
    own,
    isAvailable: () => true,
    noteOwnPrompt(entry) {
      own.push({ kind: 'prompt', ...entry });
      return true;
    },
    beginOwnWait(entry) {
      own.push({ kind: 'begin', ...entry });
      return { watcher: entry.watcherConversationId, messageId: entry.messageId };
    },
    endOwnWait(token, options) {
      own.push({ kind: 'end', messageId: token?.messageId, ...options });
      return 0;
    },
    subscribe(options) {
      const subscription = {
        id: `sub_fixture${++counter}`,
        watcher: options.watcherConversationId,
        scope: options.scope,
        sessions: options.scope === 'all' ? 'all' : options.sessionIds.map((id) => ({ id, title: null })),
        events: options.events || ['turn_end'],
        once: options.once,
        ...(options.heartbeatMinutes ? { heartbeatMinutes: options.heartbeatMinutes } : {}),
        ...(options.digestMinutes ? { digestMinutes: options.digestMinutes } : {}),
        ...(options.quietHours ? { quietHours: options.quietHours } : {}),
        ...(options.exclude?.length ? { exclude: options.exclude } : {}),
      };
      subscriptions.push(subscription);
      return subscription;
    },
    unsubscribe({ watcherConversationId, subscriptionId }) {
      const ended = subscriptions.filter((sub) => sub.watcher === watcherConversationId && (subscriptionId === 'all' || sub.id === subscriptionId) && !sub.endedAt);
      if (!ended.length) throw Object.assign(new Error(`No active subscription ${subscriptionId}`), { code: 'notFound' });
      for (const sub of ended) sub.endedAt = 'now';
      return ended;
    },
    listSubscriptions: ({ watcherConversationId }) => subscriptions.filter((sub) => sub.watcher === watcherConversationId),
    previewTransfer({ fromConversationId, toConversationId }) {
      const moving = subscriptions.filter((sub) => sub.watcher === fromConversationId && !sub.endedAt);
      if (!moving.length) throw Object.assign(new Error(`Session ${fromConversationId} has no active subscriptions to transfer.`), { code: 'notFound' });
      if (fromConversationId === toConversationId) throw Object.assign(new Error('same'), { code: 'invalid' });
      return { from: { id: fromConversationId, title: 'old watcher' }, count: moving.length, includesAll: moving.some((sub) => sub.scope === 'all'), subscriptions: moving };
    },
    transferSubscriptions({ fromConversationId, toConversationId }) {
      const preview = this.previewTransfer({ fromConversationId, toConversationId });
      for (const sub of preview.subscriptions) sub.watcher = toConversationId;
      return { from: preview.from, moved: preview.subscriptions, ended: [] };
    },
  };
}

function setupEvents(options = {}) {
  const relayEvents = createFakeRelayEvents();
  const context = setupLocal({ relayEvents, ...options });
  context.local.addConversation({ id: 'conv-watched', title: 'orbit camera' });
  context.local.addConversation({ id: 'conv-other', title: 'docs pass' });
  return { ...context, relayEvents };
}

test('subscribe defaults to this relay and asks the user once per conversation', async () => {
  const { run, approvals, relayEvents } = setupEvents();
  const first = await run('subscribe', { sessions: ['conv-watched'], heartbeat_minutes: 60 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.subscription.id, 'sub_fixture1');
  assert.match(first.body.note, /never the user's, and approve nothing/);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].watch.kind, 'subscribe');
  assert.deepEqual(approvals[0].watch.sessions, [{ id: 'conv-watched', title: 'orbit camera' }]);
  assert.equal(approvals[0].watch.heartbeatMinutes, 60);
  const second = await run('subscribe', { relay: 'this', sessions: ['conv-other'] });
  assert.equal(second.status, 200);
  assert.equal(approvals.length, 1, 'the second subscribe is not asked again');
  assert.equal(relayEvents.subscriptions.length, 2);
  // Another conversation asks for itself.
  await run('subscribe', { sessions: ['conv-watched'] }, 'c-2');
  assert.equal(approvals.length, 2);
});

test('relay_restarted alone watches no session: no card; on a paired relay it is refused', async () => {
  const { run, approvals, relayEvents, dispatcher } = setupEvents();
  const result = await run('subscribe', { events: ['relay_restarted'], once: true });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(approvals.length, 0, 'nothing of another conversation is watched');
  assert.deepEqual(relayEvents.subscriptions[0].sessions, []);
  assert.deepEqual(relayEvents.subscriptions[0].events, ['relay_restarted']);
  assert.match(result.body.summary, /subscribe → .*: relay_restarted \(sub_fixture1\)/);
  // The worker's own check hands it on, and the relay's check takes it again.
  const asWorker = await runAsWorker(dispatcher, 'subscribe', { events: ['relay_restarted'] });
  assert.equal(asWorker.ok, true, JSON.stringify(asWorker));
  assert.equal(approvals.length, 0);
  // With sessions beside it, the first-subscribe card is asked as always.
  await run('subscribe', { sessions: ['conv-watched'], events: ['turn_end', 'relay_restarted'] });
  assert.equal(approvals.length, 1);

  const paired = setup({ relayEvents: createFakeRelayEvents() });
  const refused = await paired.run('subscribe', { relay: 'linux-test', events: ['relay_restarted'] });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, CODES.invalidInput);
  assert.match(refused.body.error, /about the relay you run on/);
  assert.equal(paired.remote.calls.length, 0);
});

test('subscribe hands digest_minutes, quiet_hours and exclude to the service and names them on the card', async () => {
  const { run, approvals, relayEvents } = setupEvents();
  const quiet = { from: '23:00', to: '06:00', tz: 'Europe/Berlin' };
  const result = await run('subscribe', { sessions: ['all'], digest_minutes: 30, quiet_hours: quiet, exclude: ['conv-other'] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(
    [result.body.subscription.digestMinutes, result.body.subscription.quietHours, result.body.subscription.exclude],
    [30, quiet, ['conv-other']],
  );
  assert.deepEqual(
    [approvals[0].watch.digestMinutes, approvals[0].watch.quietHours, approvals[0].watch.excludeCount],
    [30, quiet, 1],
  );
  const refused = await run('subscribe', { sessions: ['conv-watched'], exclude: ['conv-other'] });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /exclude goes with sessions \["all"\] only/);
  assert.equal(relayEvents.subscriptions.length, 1);
});

test('the watcher\'s own prompt is noted, and every wait for its reply says whether the finished reply came', async () => {
  const relayEvents = createFakeRelayEvents();
  const { run, remote } = setup({ relayEvents });
  withSession(remote);
  remote.onRead = (conv, query, count) => {
    if (count === 1) {
      remote.reply('conv-1', { sourceMessageId: query.afterMessageId, text: 'Started the sleep loop in the background.' });
      conv.backgroundTasks = [{ taskId: 'task-1', description: 'sleep loop', status: 'running' }];
    }
  };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 10 });
  assert.equal(result.body.status, 'running');
  const messageId = result.body.message_id;
  assert.deepEqual(relayEvents.own.map(({ kind, messageId: id, received }) => [kind, id, received]), [
    ['prompt', messageId, undefined],
    ['begin', messageId, undefined],
    ['end', messageId, false],
  ]);
  assert.equal(relayEvents.own[0].watcherConversationId, 'c-1');
  assert.equal(relayEvents.own[0].relayId, 'rr_linux');
  assert.equal(relayEvents.own[0].sessionId, 'conv-1');
  assert.equal(relayEvents.own[1].waitMs, 10_000);
  // The follow-up arrives; a later wait returns it done.
  const conv = remote.conversations.get('conv-1');
  remote.reply('conv-1', { kind: 'continuation', text: 'DONE-LONG 10:09' });
  conv.backgroundTasks = [];
  conv.activeTurn = false;
  const later = await run('wait', { relay: 'linux-test', session: 'conv-1', message_id: messageId });
  assert.equal(later.body.status, 'done');
  assert.deepEqual(relayEvents.own.slice(3).map(({ kind, received }) => [kind, received]), [['begin', undefined], ['end', true]]);
});

test('a prompt sent without waiting is noted, and nothing is held for it', async () => {
  const relayEvents = createFakeRelayEvents();
  const { run, remote } = setup({ relayEvents });
  withSession(remote);
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, wait_seconds: 0 });
  assert.equal(result.body.status, 'queued');
  assert.deepEqual(relayEvents.own.map((entry) => entry.kind), ['prompt']);
});

test('a subscription to all is always on a card, also after a listed-ids Allow', async () => {
  const { run, approvals } = setupEvents();
  await run('subscribe', { sessions: ['conv-watched'] });
  const all = await run('subscribe', { sessions: ['all'] });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(approvals.length, 2);
  assert.equal(approvals[1].watch.all, true);
  await run('subscribe', { sessions: ['all'], events: ['all_idle'] });
  assert.equal(approvals.length, 2, 'all, once allowed, is not asked again');
});

// A call the way a worker makes it: the tool checks and normalizes the input,
// and the relay's route hands what the tool sent to the dispatcher, which
// checks it again.
function runAsWorker(dispatcher, action, input = {}, conversationId = 'c-1') {
  return executeRemoteRelayTool({ ...input, action }, {
    conversationId,
    api: async (_method, _path, body) => (await dispatcher.dispatch(body)).body,
  });
}

test('"all" survives the worker\'s own check: subscribe, unsubscribe and list_subscriptions', async () => {
  const { dispatcher, approvals, relayEvents } = setupEvents();
  for (const input of [{ sessions: ['all'] }, { relay: 'this', session: 'all' }, { sessions: 'all' }]) {
    const subscribed = await runAsWorker(dispatcher, 'subscribe', input);
    assert.equal(subscribed.ok, true, JSON.stringify(subscribed));
    assert.equal(subscribed.subscription.scope, 'all');
  }
  assert.equal(relayEvents.subscriptions.length, 3);
  assert.equal(relayEvents.subscriptions.every((sub) => sub.scope === 'all'), true);
  // The one-time card for "all" is still shown, once.
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].watch.all, true);

  const listed = await runAsWorker(dispatcher, 'list_subscriptions', { relay: 'this' });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const removed = await runAsWorker(dispatcher, 'unsubscribe', { subscription_id: 'all' });
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(relayEvents.subscriptions.every((sub) => sub.endedAt), true);
});

test('a denied subscribe subscribes nothing; own and unknown sessions are refused before the card', async () => {
  const { run, approvals, relayEvents } = setupEvents({ requestApproval: async (request) => { approvals.push(request); return { approved: false }; } });
  const denied = await run('subscribe', { sessions: ['conv-watched'] });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, CODES.approvalDenied);
  assert.equal(relayEvents.subscriptions.length, 0);
  const own = await run('subscribe', { sessions: ['c-1'] });
  assert.equal(own.body.code, CODES.ownSession);
  const unknown = await run('subscribe', { sessions: ['conv-missing'] });
  assert.equal(unknown.status, 404);
  assert.equal(approvals.length, 1);
});

test('a relay that cannot store subscriptions on paired relays refuses them', async () => {
  // The fake event service has no cross-relay storage, and there is no link.
  const { run, remote } = setup({ relayEvents: createFakeRelayEvents() });
  const result = await run('subscribe', { relay: 'linux-test', sessions: ['conv-1'] });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, CODES.unsupported);
  assert.match(result.body.error, /relay "linux-test" cannot be watched from here/);
  assert.equal(remote.calls.length, 0);
});

test('unsubscribe and list_subscriptions, also of another watcher', async () => {
  const { run, relayEvents } = setupEvents();
  await run('subscribe', { sessions: ['conv-watched'] }, 'c-old');
  const listed = await run('list_subscriptions', { watcher: 'c-old' });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.watcher, 'c-old');
  assert.equal(listed.body.subscriptions.length, 1);
  const missing = await run('unsubscribe', { subscription_id: 'sub_fixture1' });
  assert.equal(missing.status, 404, 'a conversation ends only its own subscriptions');
  const ended = await run('unsubscribe', { subscription_id: 'all' }, 'c-old');
  assert.equal(ended.body.ended.length, 1);
  assert.equal(relayEvents.subscriptions[0].endedAt, 'now');
});

test('transfer always shows its card, moves everything on Allow and nothing on Deny', async () => {
  let answer = true;
  const approvals = [];
  const { run, relayEvents } = setupEvents({ requestApproval: async (request) => { approvals.push(request); return answer; } });
  await run('subscribe', { sessions: ['conv-watched'] }, 'c-old');
  await run('subscribe', { sessions: ['all'] }, 'c-old');
  await run('subscribe', { sessions: ['conv-other'] });
  const before = approvals.length;
  answer = { approved: false };
  const denied = await run('transfer_subscriptions', { from: 'c-old' });
  assert.equal(denied.status, 403);
  assert.equal(relayEvents.subscriptions.filter((sub) => sub.watcher === 'c-old').length, 2);
  answer = true;
  const moved = await run('transfer_subscriptions', { from: 'c-old' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.moved.length, 2);
  const cards = approvals.slice(before);
  assert.equal(cards.length, 2, 'asked although c-1 already passed its first-subscribe card');
  assert.deepEqual([cards[1].watch.kind, cards[1].watch.count, cards[1].watch.all], ['transfer', 2, true]);
  assert.equal(relayEvents.subscriptions.filter((sub) => sub.watcher === 'c-old').length, 0);
  const nothing = await run('transfer_subscriptions', { from: 'c-old' });
  assert.equal(nothing.status, 404);
});

test('list_sessions and read_session say what a session does: state and tasks', async () => {
  const { run, local } = setupLocal();
  const tasks = [
    { kind: 'subagent', description: 'M1 orbit camera', startedAt: '2026-09-20T09:00:00.000Z', lastActivityAt: '2026-09-20T09:58:00.000Z', status: 'running', runId: 'toolu_fixture_m1' },
    { kind: 'shell', description: 'npm test', startedAt: '2026-09-20T09:10:00.000Z', status: 'failed', exitCode: 1, summary: 'Exit code 1', endedAt: '2026-09-20T09:20:00.000Z' },
  ];
  withLocalSession(local, { sessionState: 'background_only', sessionTasks: tasks });
  const listed = await run('list_sessions', { relay: 'this' });
  const [session] = listed.body.sessions;
  assert.equal(session.active, true, 'background work counts as active');
  assert.equal(session.state, 'background_only');
  assert.deepEqual(session.tasks.map((task) => [task.kind, task.status, task.exitCode]), [['subagent', 'running', undefined], ['shell', 'failed', 1]]);
  const active = await run('list_sessions', { relay: 'this', scope: 'active' });
  assert.equal(active.body.sessions.length, 1);
  const read = await run('read_session', { relay: 'this', session: 'conv-1' });
  assert.equal(read.body.session.state, 'background_only');
  assert.equal(read.body.session.active, true);
  assert.equal(read.body.session.tasks[1].summary, 'Exit code 1');
});

test('a relay without sessionState reads as before', async () => {
  const { run, local } = setupLocal();
  withLocalSession(local);
  const listed = await run('list_sessions', { relay: 'this' });
  assert.equal(listed.body.sessions[0].active, false);
  assert.equal(listed.body.sessions[0].state, undefined);
});

// ─── usage ───────────────────────────────────────────────────────────────────

function withUsageRoutes(remote, { usage, limit = null }) {
  const original = remote.request.bind(remote);
  remote.request = async (relay, method, path, options = {}) => {
    if (method === 'GET' && path === '/api/usage') {
      remote.calls.push({ relay: relay.name, method, path });
      if (usage instanceof Error) throw usage;
      return usage;
    }
    if (method === 'GET' && path === '/api/usage-limit') {
      remote.calls.push({ relay: relay.name, method, path });
      if (!limit) throw remoteError(`${CODES.httpPrefix}501`, 'Relay answered HTTP 501', 501, { ok: false, error: 'Usage limit handling is unavailable' });
      return limit;
    }
    return original(relay, method, path, options);
  };
}

const USAGE_REPORT = Object.freeze({
  // A legacy Copilot field at the top: never passed on.
  quota_snapshots: { premium_interactions: { remaining: 12 } },
  providers: [
    {
      provider: 'cursor',
      label: 'Cursor',
      status: 'ok',
      planName: 'Pro',
      accountLabel: 'dev@example.com',
      source: 'live',
      capturedAt: '2026-09-20T09:00:00.000Z',
      meters: [{ id: 'cursor-total', label: 'Plan usage (total)', unit: 'usd', used: 14.5, allowance: 20, remaining: 5.5, utilization: 72.5, resetAt: '2026-10-01T00:00:00.000Z', secretish: 'x' }],
      details: [{ id: 'cycle', label: 'Billing cycle', rows: [{ label: 'Resets', value: '2026-10-01' }, { label: 'Signed in as', value: 'dev@example.com' }] }],
      notes: [{ id: 'n1', text: `Token ${'a'.repeat(40)} expires soon` }],
      links: [{ label: 'Cursor Spending dashboard', url: 'https://cursor.example.test/spending' }],
    },
    { provider: 'grok', label: 'Grok', status: 'not-configured', message: 'Grok is not set up on this relay.', meters: [] },
    { provider: 'claude', label: 'Claude', status: 'ok', planName: 'Max', meters: [{ label: '5-hour window', unit: 'percent', utilization: 41, resetAt: '2026-09-20T12:00:00.000Z' }] },
  ],
});

test('usage reports each provider plan and the usage-limit state, with nothing private', async () => {
  const { run, remote } = setup();
  withUsageRoutes(remote, {
    usage: USAGE_REPORT,
    limit: {
      ok: true,
      account: { status: 'allowed_warning', rateLimitType: 'five_hour', label: '5-hour', utilization: 0.91, resetsAt: '2026-09-20T12:00:00.000Z', observedAt: '2026-09-20T09:59:00.000Z' },
      pauses: [{ conversationId: 'conv-paused', messageId: 'm-held', label: '5-hour', rateLimitType: 'five_hour', resetsAt: '2026-09-20T12:00:00.000Z', resumeAt: '2026-09-20T12:00:05.000Z', auto: true }],
    },
  });
  const result = await run('usage', { relay: 'spare-test' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(result.body.summary, /^usage → spare-test: cursor, claude reported, 1 paused at a usage limit$/);
  const [cursor, grok, claude] = result.body.providers;
  assert.deepEqual(cursor.meters, [{ label: 'Plan usage (total)', unit: 'usd', used: 14.5, allowance: 20, remaining: 5.5, utilization: 72.5, resetAt: '2026-10-01T00:00:00.000Z' }]);
  assert.equal(cursor.plan, 'Pro');
  assert.deepEqual(cursor.details[0].rows, [{ label: 'Resets', value: '2026-10-01' }, { label: 'Signed in as', value: '[address]' }]);
  assert.deepEqual(cursor.notes, ['Token [hidden] expires soon']);
  assert.deepEqual([grok.status, grok.message, grok.meters], ['not-configured', 'Grok is not set up on this relay.', []]);
  assert.equal(claude.meters[0].utilization, 41);
  assert.deepEqual(result.body.usageLimit, {
    account: { status: 'allowed_warning', window: '5-hour', utilization: 0.91, resetsAt: '2026-09-20T12:00:00.000Z', observedAt: '2026-09-20T09:59:00.000Z' },
    pauses: [{ session: 'conv-paused', window: '5-hour', resetsAt: '2026-09-20T12:00:00.000Z', resumeAt: '2026-09-20T12:00:05.000Z', auto: true }],
  });
  const text = JSON.stringify(result.body);
  for (const leak of ['dev@example.com', 'quota_snapshots', 'cursor.example.test', 'secretish', 'a'.repeat(40)]) {
    assert.equal(text.includes(leak), false, `no ${leak}`);
  }
});

test('usage needs read permission only, and works on this relay too', async () => {
  // spare-test is a "read" relay: enough.
  const { run, remote, local } = setupLocal({ unlocked: ['rr_spare'] });
  withUsageRoutes(remote, { usage: USAGE_REPORT });
  const paired = await run('usage', { relay: 'spare-test' });
  assert.equal(paired.status, 200, JSON.stringify(paired.body));
  assert.equal(paired.body.usageLimit, null);
  assert.match(paired.body.note, /usage-limit state was not available/);
  withUsageRoutes(local, { usage: USAGE_REPORT });
  const own = await run('usage', { relay: 'this' });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.providers.length, 3);
  const locked = await run('usage', { relay: 'linux-test' });
  assert.equal(locked.body.code, CODES.locked);
});

test('a relay without plan usage answers a clear error', async () => {
  const { run, remote } = setup();
  withUsageRoutes(remote, { usage: remoteError(CODES.notFound, 'Relay "linux-test": not found', 404) });
  const missing = await run('usage', { relay: 'linux-test' });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, CODES.unsupported);
  assert.match(missing.body.error, /Relay "linux-test" does not report plan usage/);
  withUsageRoutes(remote, { usage: { quota_snapshots: {} } });
  const legacy = await run('usage', { relay: 'linux-test' });
  assert.equal(legacy.body.code, CODES.unsupported);
  assert.match(legacy.body.error, /older shape/);
});

// ─── read_task_output ────────────────────────────────────────────────────────

const OUTPUT_PATH = '/api/conversation/conv-1/background-task/task-b7/output';

// The output route of the target relay; `answer` is its JSON or an Error.
function withTaskOutputRoute(target, answer) {
  const original = target.request.bind(target);
  target.request = async (relay, method, path, options = {}) => {
    if (method === 'GET' && path.includes('/background-task/')) {
      target.calls.push({ relay: relay.name, method, path, query: options.query });
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return original(relay, method, path, options);
  };
}

const RUNNING_OUTPUT = Object.freeze({
  ok: true,
  taskId: 'task-b7',
  kind: 'file',
  ended: false,
  status: 'running',
  exitCode: null,
  taskStallMinutes: 10,
  health: {
    lastOutputAt: Date.parse('2026-09-20T09:48:00.000Z'),
    size: 5000,
    counts: { passed: 412, failed: 2, skipped: 0 },
    runner: 'vitest',
    final: false,
    firstFailureOffset: 1200,
  },
  task: { taskId: 'task-b7', taskType: 'local_bash', description: 'npm test', startedAt: 1_758_355_000_000, stoppable: true },
  text: 'ignored by the action',
  lines: [
    { text: '\x1b[32m ✓\x1b[39m src/needle.test.ts (12 tests) 8ms', count: 1, ansi: true },
    { text: 'waiting for the compass server', count: 3, ansi: false },
    // A relay that forgot to scrub still gets scrubbed here.
    // Put together at run time: the hygiene scan refuses token shapes in the source.
    { text: `GITHUB_TOKEN=${['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('')}`, count: 1, ansi: false },
  ],
  startOffset: 4000,
  endOffset: 5000,
  size: 5000,
  mtime: Date.parse('2026-09-20T09:48:00.000Z'),
  hasMoreBefore: true,
});

test('read_task_output reads the tail of a task on a read-only relay: plain lines, quiet minutes, counts', async () => {
  const { run, remote } = setup();
  withTaskOutputRoute(remote, RUNNING_OUTPUT);
  const result = await run('read_task_output', { relay: 'spare-test', session: 'conv-1', task_id: 'task-b7', lines: 50 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const call = remote.calls.find((entry) => entry.path === OUTPUT_PATH);
  assert.deepEqual([call.relay, call.query], ['spare-test', { lines: 50 }]);
  assert.deepEqual(result.body.tail, [
    ' ✓ src/needle.test.ts (12 tests) 8ms',
    'waiting for the compass server  [×3]',
    'GITHUB_TOKEN=[redacted]',
  ]);
  assert.deepEqual(result.body.stall, { minutes: 12, since: '2026-09-20T09:48:00.000Z', quiet: true, quietAfterMinutes: 10 });
  assert.deepEqual(result.body.counts, { runner: 'vitest', passed: 412, failed: 2, skipped: 0, final: false });
  assert.deepEqual(result.body.task, { id: 'task-b7', description: 'npm test', type: 'local_bash', startedAt: 1_758_355_000_000, status: 'running', exitCode: null });
  assert.equal(result.body.truncated, true);
  assert.match(result.body.summary, /^read_task_output → spare-test session conv-1 task task-b7: 3 lines, running, last output 12 min ago, 412 passed, 2 failed$/);
  assert.equal(JSON.stringify(result.body).includes('ghp_abcdef'), false);
});

test('read_task_output of an ended task: its status and exit code, counts from the lines, no stall', async () => {
  const { run, local } = setupLocal();
  withTaskOutputRoute(local, {
    ok: true,
    taskId: 'task-b7',
    kind: 'file',
    ended: true,
    status: 'failed',
    exitCode: 1,
    health: null,
    taskStallMinutes: 10,
    task: { taskId: 'task-b7', taskType: 'local_bash', description: 'npm test', endedAt: 1_758_362_000_000 },
    lines: [
      { text: 'ℹ tests 2', count: 1 },
      { text: 'ℹ pass 1', count: 1 },
      { text: 'ℹ fail 1', count: 1 },
      { text: 'ℹ duration_ms 12.5', count: 1 },
    ],
    mtime: Date.parse('2026-09-20T09:00:00.000Z'),
    hasMoreBefore: false,
  });
  const result = await run('read_task_output', { relay: 'this', session: 'conv-1', task_id: 'task-b7' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(local.calls.find((entry) => entry.path === OUTPUT_PATH).query.lines, 200);
  assert.equal(result.body.stall, null);
  assert.deepEqual([result.body.task.status, result.body.task.exitCode, result.body.task.endedAt], ['failed', 1, 1_758_362_000_000]);
  assert.deepEqual(result.body.counts, { runner: 'node:test', passed: 1, failed: 1, skipped: 0, final: true });
  assert.equal(result.body.truncated, false);
});

test('read_task_output keeps to its line count and 32 KB, newest lines last', async () => {
  const { run, remote } = setup();
  const lines = Array.from({ length: 400 }, (_, index) => ({ text: `${String(index).padStart(4, '0')} ${'x'.repeat(120)}`, count: 1 }));
  withTaskOutputRoute(remote, { ...RUNNING_OUTPUT, lines, hasMoreBefore: false });
  const result = await run('read_task_output', { relay: 'spare-test', session: 'conv-1', task_id: 'task-b7', lines: 500 });
  assert.equal(result.body.truncated, true);
  assert.ok(Buffer.byteLength(result.body.tail.join('\n')) <= 32 * 1024);
  assert.match(result.body.tail.at(-1), /^0399 /);
  const few = await run('read_task_output', { relay: 'spare-test', session: 'conv-1', task_id: 'task-b7', lines: 5 });
  assert.equal(few.body.tail.length, 5);
});

test('read_task_output says why there is nothing: no output for the provider, an unknown task, an older relay', async () => {
  const { run, remote } = setup();
  withTaskOutputRoute(remote, { ok: true, taskId: 'task-b7', kind: 'none', ended: false, message: 'Output is not available for this provider.', task: {} });
  const none = await run('read_task_output', { relay: 'spare-test', session: 'conv-1', task_id: 'task-b7' });
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.tail, []);
  assert.equal(none.body.note, 'Output is not available for this provider.');

  withTaskOutputRoute(remote, remoteError(`${CODES.httpPrefix}404`, 'Relay answered HTTP 404', 404, { error: 'Task not found', code: 'task-not-found' }));
  const unknown = await run('read_task_output', { relay: 'spare-test', session: 'conv-1', task_id: 'task-b7' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, CODES.notFound);
  assert.match(unknown.body.error, /Task task-b7 is not running in session conv-1 on relay "spare-test"/);

  withTaskOutputRoute(remote, remoteError(`${CODES.httpPrefix}404`, 'Relay answered HTTP 404', 404, { error: 'Not found' }));
  const older = await run('read_task_output', { relay: 'spare-test', session: 'conv-1', task_id: 'task-b7' });
  assert.equal(older.body.code, CODES.unsupported);

  withTaskOutputRoute(remote, remoteError(`${CODES.httpPrefix}404`, 'Relay answered HTTP 404', 404, { error: 'Conversation not found' }));
  const noSession = await run('read_task_output', { relay: 'spare-test', session: 'conv-1', task_id: 'task-b7' });
  assert.equal(noSession.body.code, CODES.notFound);
  assert.match(noSession.body.error, /Session conv-1 was not found/);
});

test('read_session gives each task its taskId, whether it has output, and its health', async () => {
  const { run, local } = setupLocal();
  withLocalSession(local, {
    sessionState: 'background_only',
    sessionTasks: [
      { id: 'task-b7', kind: 'shell', description: 'npm test', startedAt: '2026-09-20T09:00:00.000Z', status: 'running' },
      { id: 'task-c8', kind: 'shell', description: 'npm run build', status: 'completed', exitCode: 0, endedAt: '2026-09-20T09:30:00.000Z' },
      { id: 'agent-d9', kind: 'subagent', description: 'review', status: 'running' },
    ],
    backgroundTasks: [
      { taskId: 'task-b7', outputPath: '/tmp/out/task-b7.log', outputKind: 'file', command: 'npm test 2>&1 | tail -40', health: RUNNING_OUTPUT.health },
      { taskId: 'agent-d9', outputKind: 'none' },
    ],
  });
  const original = local.request.bind(local);
  local.request = async (relay, method, path, options = {}) => {
    const answer = await original(relay, method, path, options);
    if (method === 'GET' && path === '/api/conversation/conv-1') {
      return { ...answer, taskStallMinutes: 15, endedBackgroundTasks: [{ taskId: 'task-c8', outputPath: '/tmp/out/task-c8.log', status: 'completed', exitCode: 0 }] };
    }
    return answer;
  };
  const read = await run('read_session', { relay: 'this', session: 'conv-1' });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const [running, built, agent] = read.body.session.tasks;
  assert.equal(running.taskId, 'task-b7');
  assert.equal(running.output, true);
  // The relay scrubbed the command line when the worker posted it.
  assert.equal(running.command, 'npm test 2>&1 | tail -40');
  assert.deepEqual(running.health, {
    minutesSinceOutput: 12,
    quiet: false,
    quietAfterMinutes: 15,
    counts: { runner: 'vitest', passed: 412, failed: 2, skipped: 0 },
  });
  assert.deepEqual([built.taskId, built.output, built.health], ['task-c8', true, undefined]);
  assert.deepEqual([agent.taskId, agent.output, agent.command], ['agent-d9', false, undefined]);
  // list_sessions stays as it was.
  const listed = await run('list_sessions', { relay: 'this' });
  assert.equal(listed.body.sessions[0].tasks[0].taskId, undefined);
});

// ─── Session groups: relay_info, create_session `group`, ignored arguments ───

const DOCS_GROUP = Object.freeze({ id: 'grp_docs0000000000000001', name: 'Docs batch', memberCount: 3 });
const QA_GROUP = Object.freeze({ id: 'grp_qa000000000000000001', name: 'QA', memberCount: 1 });

test('relay_info lists the target\'s groups (id, name, member count), capped', async () => {
  const { run, remote } = setup();
  remote.groupList = Array.from({ length: 55 }, (_, index) => ({ id: `grp_${String(index).padStart(20, '0')}`, name: `Batch ${index}`, memberCount: index + 1 }));
  const result = await run('relay_info', { relay: 'linux-test' });
  assert.equal(result.status, 200);
  assert.equal(result.body.groups.length, 50);
  assert.equal(result.body.groupsTotal, 55);
  assert.deepEqual(result.body.groups[0], { id: 'grp_00000000000000000000', name: 'Batch 0', memberCount: 1 });
  assert.equal('groupsNote' in result.body, false);

  remote.groupList = [DOCS_GROUP];
  const few = await run('relay_info', { relay: 'linux-test' });
  assert.deepEqual(few.body.groups, [{ id: DOCS_GROUP.id, name: 'Docs batch', memberCount: 3 }]);
  assert.equal('groupsTotal' in few.body, false);
});

test('relay_info on a target without the groups list says so and still answers', async () => {
  const { run } = setup();
  const result = await run('relay_info', { relay: 'linux-test' });
  assert.equal(result.status, 200);
  assert.ok(result.body.providers.length > 0);
  assert.equal(result.body.groups, null);
  assert.match(result.body.groupsNote, /The target relay doesn't support groups on create_session yet: relay "linux-test" runs an older OAR/);
  assert.match(result.body.groupsNote, /create_session cannot take group there\.$/);
});

test('create_session with group resolves it before the approval card, and the card names it', async () => {
  const { run, remote, approvals } = setup({ caller: { mode: 'ask' } });
  remote.groupList = [DOCS_GROUP, QA_GROUP];
  const result = await run('create_session', { relay: 'linux-test', text: PROMPT, group: 'docs BATCH', wait_seconds: 0 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].group, { id: DOCS_GROUP.id, name: 'Docs batch' });
  const lookup = remote.calls.findIndex((entry) => entry.path === '/api/conversation-groups');
  assert.ok(lookup >= 0 && lookup < remote.calls.findIndex((entry) => entry.path === '/api/conversation/bootstrap'));
});

test('create_session with an unknown group is refused before anything is created, listing the groups', async () => {
  const { run, remote, approvals } = setup({ caller: { mode: 'ask' } });
  remote.groupList = [DOCS_GROUP, QA_GROUP];
  const result = await run('create_session', { relay: 'linux-test', text: PROMPT, group: 'Release', wait_seconds: 0 });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, CODES.unknownGroup);
  assert.equal(result.body.error,
    `Relay "linux-test" has no session group "Release". Groups there: Docs batch (${DOCS_GROUP.id}), QA (${QA_GROUP.id}). No session was created.`);
  assert.deepEqual(result.body.groups, [{ id: DOCS_GROUP.id, name: 'Docs batch' }, { id: QA_GROUP.id, name: 'QA' }]);
  assert.match(result.body.note, /create_session takes an existing group only; update_session can put the session into a new group/);
  assert.equal(result.body.relay, 'linux-test');
  assert.equal(remote.callsTo('POST', '/api/conversation/bootstrap').length, 0, 'nothing is created');
  assert.equal(approvals.length, 0, 'the user is not asked about a call that cannot run');
});

test('create_session on a relay without any group says only the owner creates them', async () => {
  const { run, remote } = setup();
  // A relay that lists groups, and has none.
  remote.groupList = [];
  const result = await run('create_session', { relay: 'linux-test', text: PROMPT, group: 'Release', wait_seconds: 0 });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, CODES.unknownGroup);
  assert.equal(result.body.error, 'Relay "linux-test" has no session groups. No session was created.');
  assert.deepEqual(result.body.groups, []);
  assert.match(result.body.note, /update_session can put the session into a new group of that name afterwards/);
  assert.equal(remote.callsTo('POST', '/api/conversation/bootstrap').length, 0);
});

test('create_session with an ambiguous group name is refused, asking for the id', async () => {
  const { run, remote } = setup();
  const other = { id: 'grp_qa000000000000000002', name: 'qa', memberCount: 2 };
  remote.groupList = [DOCS_GROUP, QA_GROUP, other];
  const result = await run('create_session', { relay: 'linux-test', text: PROMPT, group: 'Qa', wait_seconds: 0 });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, CODES.unknownGroup);
  assert.equal(result.body.error,
    `"Qa" names several session groups on relay "linux-test": QA (${QA_GROUP.id}), qa (${other.id}). Pass the id. No session was created.`);
  assert.deepEqual(result.body.groups.map((group) => group.id), [QA_GROUP.id, other.id]);
  assert.equal(remote.callsTo('POST', '/api/conversation/bootstrap').length, 0);
  const byId = await run('create_session', { relay: 'linux-test', text: PROMPT, group: other.id, wait_seconds: 0 });
  assert.equal(byId.status, 200);
  assert.deepEqual(byId.body.group, { id: other.id, name: 'qa', role: 'member' });
});

test('create_session with group on a paired relay sends the resolved id and returns group', async () => {
  const { run, remote } = setup();
  remote.groupList = [DOCS_GROUP];
  const result = await run('create_session', { relay: 'linux-test', text: PROMPT, group: '  Docs Batch ', wait_seconds: 0 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  const [bootstrap] = remote.callsTo('POST', '/api/conversation/bootstrap');
  assert.equal(bootstrap.body.group, DOCS_GROUP.id, 'the id the lookup found, not the agent\'s words');
  assert.deepEqual(result.body.group, { id: DOCS_GROUP.id, name: 'Docs batch', role: 'member' });
  assert.equal('groupWarning' in result.body, false);
  assert.doesNotMatch(result.body.summary, /no group/);
});

test('create_session with group on the local target wins over the creator\'s group', async () => {
  const { run, local, approvals } = setupLocal();
  local.groupList = [DOCS_GROUP];
  local.creatorGroup = { id: 'grp_creator0000000000001', name: 'report builder', role: 'member' };
  const result = await run('create_session', { relay: 'this', text: PROMPT, group: DOCS_GROUP.id, wait_seconds: 0 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.group, { id: DOCS_GROUP.id, name: 'Docs batch', role: 'member' });
  assert.equal(local.callsTo('POST', '/api/conversation/bootstrap')[0].body.group, DOCS_GROUP.id);
  // The once-per-conversation card names it too.
  assert.equal(approvals[0].localSessions, true);
  assert.deepEqual(approvals[0].group, { id: DOCS_GROUP.id, name: 'Docs batch' });
  // An unknown group here is refused the same way, before the cap or a card.
  const refused = await run('create_session', { relay: 'this', text: PROMPT, group: 'Nope', wait_seconds: 0 });
  assert.equal(refused.body.code, CODES.unknownGroup);
  assert.match(refused.body.error, /^This relay has no session group "Nope"\. Groups there: Docs batch/);
});

test('create_session without group on the local target returns the creator\'s group', async () => {
  const { run, local } = setupLocal({ localApproved: ['c-1'] });
  local.groupList = [DOCS_GROUP];
  local.creatorGroup = { id: 'grp_creator0000000000001', name: 'report builder', role: 'member' };
  const result = await run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 0 });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.group, local.creatorGroup);
  assert.equal('group' in local.callsTo('POST', '/api/conversation/bootstrap')[0].body, false, 'today\'s request, no group');
  assert.equal(local.callsTo('GET', '/api/conversation-groups').length, 0, 'no lookup without group');
});

test('create_session with group on a relay without group support is refused before creating', async () => {
  const { run, remote, approvals } = setup({ caller: { mode: 'ask' } });
  // groupList null: the relay predates the list (404).
  const result = await run('create_session', { relay: 'linux-test', text: PROMPT, group: 'Docs batch', wait_seconds: 0 });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, CODES.unsupported);
  assert.equal(result.body.error,
    'The target relay doesn\'t support groups on create_session yet: relay "linux-test" runs an older OAR (its group list answered 404). No session was created.');
  assert.equal(remote.callsTo('POST', '/api/conversation/bootstrap').length, 0);
  assert.equal(approvals.length, 0);
});

test('create_session with group is refused when the target\'s groups cannot be read: 401, 403, 5xx, timeout', async () => {
  const cases = [
    [new RemoteRelayError(CODES.unauthorized, 'Relay "linux-test" rejected the token (401)', { status: 401 }), CODES.unauthorized,
      'Relay "linux-test" rejected this relay\'s token when asked for its session groups (401). No session was created.'],
    [remoteError(`${CODES.httpPrefix}403`, 'Relay "linux-test" answered HTTP 403', 403, { error: 'no' }), `${CODES.httpPrefix}403`,
      'Relay "linux-test" refused to list its session groups (403). No session was created.'],
    [remoteError(`${CODES.httpPrefix}500`, 'Relay "linux-test" answered HTTP 500', 500, { error: 'boom' }), `${CODES.httpPrefix}500`,
      'Relay "linux-test" failed to list its session groups (HTTP 500). No session was created.'],
    [new RemoteRelayError(CODES.offline, 'Relay "linux-test" is not reachable (timed out after 15 s)', { detail: 'timed out after 15 s' }), CODES.offline,
      'Relay "linux-test" did not answer when asked for its session groups (timed out after 15 s). No session was created.'],
  ];
  for (const [error, code, text] of cases) {
    const { run, remote, approvals } = setup({ caller: { mode: 'ask' } });
    remote.groupList = [DOCS_GROUP];
    remote.fail('GET', '/api/conversation-groups', error);
    const result = await run('create_session', { relay: 'linux-test', text: PROMPT, group: 'Docs batch', wait_seconds: 0 });
    assert.equal(result.body.ok, false, code);
    assert.equal(result.body.code, code);
    assert.equal(result.body.error, text);
    assert.match(result.body.note, /Leave group out/);
    assert.equal(remote.callsTo('POST', '/api/conversation/bootstrap').length, 0, code);
    assert.equal(approvals.length, 0, code);
  }
});

test('create_session whose target ignored group returns groupWarning, not a plain success', async () => {
  const { run, remote } = setup();
  remote.groupList = [DOCS_GROUP];
  remote.bootstrapIgnoresGroup = true;
  const result = await run('create_session', { relay: 'linux-test', text: PROMPT, group: 'Docs batch', wait_seconds: 0 });
  assert.equal(result.status, 200);
  assert.equal(result.body.session, 'conv-new-1', 'the session exists: the agent must not start a second one');
  assert.equal(result.body.group, null);
  assert.equal(result.body.groupWarning,
    'The session was created WITHOUT a group: relay "linux-test" ignored group "Docs batch" (its OAR is older and does not take group on create_session). Tell the user; the owner can move the session into the group by hand.');
  assert.match(result.body.summary, /\(no group: target too old\)$/);
  assert.ok(result.body.note.startsWith(result.body.groupWarning));
});

test('a bootstrap refusal for a vanished group maps to REMOTE_RELAY_UNKNOWN_GROUP with the groups', async () => {
  const { run, remote } = setup();
  remote.groupList = [DOCS_GROUP, QA_GROUP];
  // Dissolved by the owner between the lookup and the create.
  remote.groupsAtBootstrap = [QA_GROUP];
  const result = await run('create_session', { relay: 'linux-test', text: PROMPT, group: 'Docs batch', wait_seconds: 0 });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, CODES.unknownGroup);
  assert.equal(result.body.error, `Relay "linux-test" has no session group "Docs batch". Groups there: QA (${QA_GROUP.id}). No session was created.`);
  assert.deepEqual(result.body.groups, [{ id: QA_GROUP.id, name: 'QA' }]);
  assert.equal(remote.conversations.size, 0, 'nothing was created');
  assert.equal(remote.callsTo('POST', '/api/message').length, 0);
});

test('create_session with group for claude-cloud passes it on', async () => {
  const { run, remote } = setup();
  remote.settings['claude-cloud'] = { enabled: true, defaultModel: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'] };
  remote.efforts.supported = ['none'];
  remote.groupList = [DOCS_GROUP];
  const result = await run('create_session', {
    relay: 'linux-test',
    text: 'Fix the sample banner on feature/banner and push it.',
    provider: 'claude-cloud',
    repo: 'example-org/sample-repo',
    branch: 'feature/banner',
    group: 'Docs batch',
    wait_seconds: 0,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const [bootstrap] = remote.callsTo('POST', '/api/conversation/bootstrap');
  assert.equal(bootstrap.body.providerType, 'claude-cloud');
  assert.equal(bootstrap.body.group, DOCS_GROUP.id);
  assert.deepEqual(result.body.group, { id: DOCS_GROUP.id, name: 'Docs batch', role: 'member' });
});

test('dispatch adds ignored to the answer of other actions', async () => {
  const { run, remote } = setup();
  withSession(remote);
  const read = await run('read_session', { relay: 'linux-test', session: 'conv-1', text: 'stray', group: 'Docs batch' });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.ignored, ['group', 'text']);
  const listed = await run('list_relays', { session: 'conv-1' });
  assert.deepEqual(listed.body.ignored, ['session']);
  // A refusal names them as well.
  const refused = await run('send', { relay: 'linux-test', session: 'conv-1', cwd: '/home/dev/other' });
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body.ignored, ['cwd']);
  // create_session refuses them instead, nothing created.
  const create = await run('create_session', { relay: 'linux-test', text: PROMPT, session: 'conv-1' });
  assert.equal(create.status, 400);
  assert.match(create.body.error, /^create_session does not take: session\./);
  assert.equal(remote.callsTo('POST', '/api/conversation/bootstrap').length, 0);
  // Nothing to name: no key.
  assert.equal('ignored' in (await run('read_session', { relay: 'linux-test', session: 'conv-1' })).body, false);
});

test('a refusal names at most 20 groups and says how many more there are, from the lookup and from the bootstrap', async () => {
  const many = Array.from({ length: 23 }, (_, index) => ({ id: `grp_many${String(index).padStart(16, '0')}`, name: `Batch ${index}`, memberCount: 1 }));
  const { run, remote } = setup();
  remote.groupList = many;
  const looked = await run('create_session', { relay: 'linux-test', text: PROMPT, group: 'Release', wait_seconds: 0 });
  assert.equal(looked.body.code, CODES.unknownGroup);
  assert.match(looked.body.error, /Batch 19 \(grp_many0000000000000019\) and 3 more\. No session was created\.$/);
  assert.equal(looked.body.groups.length, 20);
  assert.equal(looked.body.groupsTotal, 23);

  // The target's own refusal comes capped, with its count.
  remote.groupList = [DOCS_GROUP];
  remote.groupsAtBootstrap = many;
  const refused = await run('create_session', { relay: 'linux-test', text: PROMPT, group: 'Docs batch', wait_seconds: 0 });
  assert.equal(refused.body.code, CODES.unknownGroup);
  assert.match(refused.body.error, /Batch 19 \(grp_many0000000000000019\) and 3 more\. No session was created\.$/);
  assert.equal(refused.body.groups.length, 20);
  assert.equal(refused.body.groupsTotal, 23);
  assert.equal(remote.conversations.size, 0);
});

// ─── update_session ──────────────────────────────────────────────────────────

// A session the calling conversation (c-1 on this relay, win-test) started there.
const AGENT_ORIGIN = Object.freeze({ relayId: 'relay-self-id', relayName: 'win-test', conversationId: 'c-1', hops: 1 });
const BATCH_GROUP = Object.freeze({ id: 'grp_batch0000000000001', name: 'Docs batch', memberCount: 2 });
const settingsCalls = (target) => target.callsTo('PATCH', '/api/conversation/conv-1/settings');

test('update_session on a session an agent started: checked, a dry run, then the change; no card in agent mode', async () => {
  const { run, remote, approvals } = setup();
  withSession(remote, { origin: AGENT_ORIGIN });
  const result = await run('update_session', { relay: 'linux-test', session: 'conv-1', model: 'claude-opus-5', effort: 'high', title: 'Docs pass' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.deepEqual(result.body.changed, ['model', 'effort', 'title']);
  assert.equal(result.body.settings.model, 'claude-opus-5');
  assert.equal(result.body.settings.effort, 'high');
  assert.equal(result.body.settings.title, 'Docs pass');
  assert.equal(result.body.summary, 'update_session → linux-test session conv-1: model, effort, title');
  assert.equal(result.body.openUrl, 'https://relay-b.example.test/?conv=conv-1');
  assert.equal(approvals.length, 0);
  const [dry, real] = settingsCalls(remote);
  assert.equal(dry.body.dry_run, true);
  assert.deepEqual(dry.body.settings, { model: 'claude-opus-5', effort: 'high', title: 'Docs pass' });
  assert.equal(real.body.owner_approved, false);
  assert.equal(real.hops, 1);
});

test('update_session refuses an unknown model with the close matches before anything else; nothing is changed', async () => {
  const { run, remote, approvals } = setup({ caller: { mode: 'ask' } });
  withSession(remote, { origin: AGENT_ORIGIN });
  const refused = await run('update_session', { relay: 'linux-test', session: 'conv-1', model: 'claude-opus-9' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, CODES.unknownModel);
  assert.match(refused.body.error, /Nothing was changed\.$/);
  assert.ok(refused.body.models.includes('claude-opus-5'));
  assert.equal(settingsCalls(remote).length, 0);
  assert.equal(approvals.length, 0);
  // A listed id in another casing is the provider's.
  const cased = await run('update_session', { relay: 'linux-test', session: 'conv-1', model: 'Claude-Opus-5' });
  assert.equal(cased.body.settings.model, 'claude-opus-5');
});

test('update_session refuses an effort the model does not take, with the ones it takes', async () => {
  const { run, remote } = setup();
  withSession(remote, { origin: AGENT_ORIGIN });
  remote.models.reasoningByModel = { 'claude-sonnet-5': ['low', 'medium', 'high'] };
  const refused = await run('update_session', { relay: 'linux-test', session: 'conv-1', effort: 'max' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, CODES.invalidInput);
  assert.deepEqual(refused.body.supportedEfforts, ['low', 'medium', 'high']);
  assert.match(refused.body.error, /does not take effort "max".*Nothing was changed\./);
  assert.equal(settingsCalls(remote).length, 0);
  assert.equal((await run('update_session', { relay: 'linux-test', session: 'conv-1', effort: 'medium' })).status, 200);
});

test('a session the owner started: the owner is asked once per conversation and relay, and the target is told', async () => {
  const { run, remote, approvals, unlocks } = setup();
  withSession(remote);
  const first = await run('update_session', { relay: 'linux-test', session: 'conv-1', effort: 'high' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].action, 'update_session');
  assert.deepEqual(approvals[0].sessionSettings, { session: 'conv-1', title: 'sidebar polish', changed: ['effort'] });
  assert.ok(unlocks.has('c-1:rr_linux:session-settings'));
  assert.equal(settingsCalls(remote).at(-1).body.owner_approved, true);
  // Remembered: the next change asks nobody.
  const second = await run('update_session', { relay: 'linux-test', session: 'conv-1', mode: 'plan' });
  assert.equal(second.status, 200);
  assert.equal(approvals.length, 1);
  assert.match(second.body.note, /This mode lasts until the next send that names another mode or comes from a caller in another mode/);
});

test('the owner\'s Deny refuses with REMOTE_RELAY_PERMISSION and changes nothing; ask mode adds no second card', async () => {
  const denying = setup({ requestApproval: async () => ({ approved: false }) });
  withSession(denying.remote);
  const refused = await denying.run('update_session', { relay: 'linux-test', session: 'conv-1', effort: 'high' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, CODES.permission);
  assert.match(refused.body.error, /did not allow this conversation to change sessions on relay "linux-test" that it did not start/);
  assert.equal(settingsCalls(denying.remote).length, 1, 'the dry run only');
  assert.equal(denying.remote.conversations.get('conv-1').effort, undefined);

  // In ask mode the owner's card is this call's approval too.
  const asking = setup({ caller: { mode: 'ask' } });
  withSession(asking.remote);
  assert.equal((await asking.run('update_session', { relay: 'linux-test', session: 'conv-1', effort: 'high' })).status, 200);
  assert.equal(asking.approvals.length, 1);
  assert.ok(asking.approvals[0].sessionSettings);
  // A session an agent started gets the ordinary write card in ask mode.
  asking.remote.addConversation({ id: 'conv-2', title: 'made by an agent', origin: AGENT_ORIGIN });
  assert.equal((await asking.run('update_session', { relay: 'linux-test', session: 'conv-2', effort: 'low' })).status, 200);
  assert.equal(asking.approvals.length, 2);
  assert.equal(asking.approvals[1].sessionSettings, undefined);
});

test('a change to nothing asks nobody and says so', async () => {
  const { run, remote, approvals } = setup({ caller: { mode: 'plan' } });
  withSession(remote, { effort: 'high' });
  const same = await run('update_session', { relay: 'linux-test', session: 'conv-1', effort: 'high' });
  assert.equal(same.status, 200);
  assert.deepEqual(same.body.changed, []);
  assert.match(same.body.note, /nothing was changed/);
  assert.equal(same.body.summary, 'update_session → linux-test session conv-1: nothing to change');
  assert.equal(approvals.length, 0);
  assert.equal(settingsCalls(remote).length, 1, 'the dry run only');
});

test('update_session groups: by id, by name, a new name makes one, null takes the session out', async () => {
  const { run, remote } = setup();
  withSession(remote, { origin: AGENT_ORIGIN });
  remote.groupList = [BATCH_GROUP];
  const byId = await run('update_session', { relay: 'linux-test', session: 'conv-1', group: BATCH_GROUP.id });
  assert.deepEqual(byId.body.settings.group, { id: BATCH_GROUP.id, name: 'Docs batch', role: 'member' });
  const out = await run('update_session', { relay: 'linux-test', session: 'conv-1', group: null });
  assert.equal(out.body.settings.group, null);
  const byName = await run('update_session', { relay: 'linux-test', session: 'conv-1', group: 'docs batch' });
  assert.equal(byName.body.settings.group.id, BATCH_GROUP.id);
  const made = await run('update_session', { relay: 'linux-test', session: 'conv-1', group: 'Release prep' });
  assert.equal(made.status, 200);
  assert.equal(made.body.groupCreated.name, 'Release prep');
  assert.equal(made.body.settings.group.id, made.body.groupCreated.id);
  const none = await run('update_session', { relay: 'linux-test', session: 'conv-1', group: 'none' });
  assert.equal(none.body.settings.group, null);
  // An unknown id is the target's to refuse, with its groups.
  const unknown = await run('update_session', { relay: 'linux-test', session: 'conv-1', group: 'grp_missing' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.code, CODES.unknownGroup);
  assert.ok(unknown.body.groups.some((group) => group.id === BATCH_GROUP.id));
});

test('update_session: a busy session, an older relay, a missing session and a relay without full permission', async () => {
  const { run, remote } = setup();
  withSession(remote, { origin: AGENT_ORIGIN });
  remote.settingsFailure = remoteError(`${CODES.httpPrefix}409`, 'Relay "linux-test" answered HTTP 409', 409, {
    ok: false, code: 'SESSION_BUSY', reason: 'a turn is running there', error: 'The session cannot move to another folder now: a turn is running there. Nothing was changed.',
  });
  const busy = await run('update_session', { relay: 'linux-test', session: 'conv-1', cwd: '/home/dev/other' });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, CODES.busy);
  assert.equal(busy.body.reason, 'a turn is running there');
  remote.settingsFailure = null;
  remote.settingsRouteMissing = true;
  const older = await run('update_session', { relay: 'linux-test', session: 'conv-1', effort: 'high' });
  assert.equal(older.status, 400);
  assert.equal(older.body.code, CODES.unsupported);
  assert.match(older.body.error, /older OAR \(no update_session there\)/);
  const missing = await run('update_session', { relay: 'linux-test', session: 'conv-404', effort: 'high' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, CODES.notFound);

  const limited = setup({ relays: [{ ...LINUX, permission: 'prompt' }], unlocked: ['rr_linux'] });
  withSession(limited.remote, { origin: AGENT_ORIGIN });
  const forbidden = await limited.run('update_session', { relay: 'linux-test', session: 'conv-1', effort: 'high' });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, CODES.forbidden);
  assert.equal(settingsCalls(limited.remote).length, 0);
});

test('the target\'s own rule holds even when this relay took the session for an agent\'s', async () => {
  const { run, remote } = setup();
  withSession(remote, { origin: AGENT_ORIGIN });
  // The dry run says agent-made; the session's origin is gone by the write.
  const realApply = remote.applySettings;
  remote.applySettings = (relay, conv, body) => (body?.dry_run ? realApply(relay, conv, body) : realApply(relay, { ...conv, origin: null }, body));
  const refused = await run('update_session', { relay: 'linux-test', session: 'conv-1', effort: 'high' });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, CODES.permission);
  assert.match(refused.body.error, /Nothing was changed\.$/);
});

test('update_session on this relay: never the caller itself, an agent-made session freely, the owner\'s after the card', async () => {
  const { run, local, approvals, unlocks } = setupLocal({ resolveConversationId: (id) => (id === 'sdk-c-1' ? 'c-1' : id) });
  local.addConversation({ id: 'c-1', title: 'report builder' });
  for (const session of ['c-1', 'sdk-c-1']) {
    const own = await run('update_session', { relay: 'this', session, effort: 'high' });
    assert.equal(own.status, 400, session);
    assert.equal(own.body.code, CODES.ownSession);
  }
  withLocalSession(local, { origin: { relayId: 'relay-self-id', relayName: 'win-test', conversationId: 'c-1', hops: 0, local: true } });
  const child = await run('update_session', { relay: 'this', session: 'conv-1', thinking_enabled: false, auto_compact_window: 300000 });
  assert.equal(child.status, 200, JSON.stringify(child.body));
  assert.deepEqual(child.body.changed, ['auto_compact_window', 'thinking_enabled']);
  assert.equal(approvals.length, 0);
  local.addConversation({ id: 'conv-owner', title: 'owner chat' });
  const owner = await run('update_session', { relay: 'this', session: 'conv-owner', title: 'Renamed by an agent' });
  assert.equal(owner.status, 200);
  assert.equal(approvals.length, 1);
  assert.ok(approvals[0].sessionSettings);
  assert.ok(unlocks.has('c-1:self:session-settings'));
  // Another conversation is asked for itself.
  local.addConversation({ id: 'c-2', title: 'second lead' });
  await run('update_session', { relay: 'this', session: 'conv-owner', title: 'Renamed again' }, 'c-2');
  assert.equal(approvals.length, 2);
});

test('the one-level rule yields to the owner\'s "may start sessions"; the cap and the first card stay', async () => {
  const { run, local, approvals } = setupLocal();
  local.addConversation({ id: 'c-1', title: 'report builder', origin: { relayId: 'relay-self-id', relayName: 'win-test', conversationId: 'c-0', hops: 0, local: true }, mayCreateSessions: true });
  const created = await run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 0 });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(approvals.length, 1, 'the first create still shows the card');
  assert.equal(approvals[0].localSessions, true);
  // The cap still holds.
  for (let index = 0; index < 4; index += 1) {
    local.addConversation({ id: `busy-${index}`, title: 'busy', origin: { relayId: 'relay-self-id', relayName: 'win-test', conversationId: 'c-1', hops: 0, local: true }, activeTurn: true });
  }
  const capped = await run('create_session', { relay: 'this', text: PROMPT, wait_seconds: 0 });
  assert.equal(capped.body.code, CODES.sessionLimit);
});

test('list_sessions and read_session show mayCreateSessions where the owner set it', async () => {
  const { run, local } = setupLocal();
  local.addConversation({ id: 'c-1', title: 'report builder' });
  withLocalSession(local, { origin: { relayId: 'relay-self-id', relayName: 'win-test', conversationId: 'c-1', hops: 0, local: true }, mayCreateSessions: true });
  local.addConversation({ id: 'conv-2', title: 'plain' });
  const listed = await run('list_sessions', { relay: 'this' });
  assert.equal(listed.body.sessions.find((session) => session.id === 'conv-1').mayCreateSessions, true);
  assert.equal('mayCreateSessions' in listed.body.sessions.find((session) => session.id === 'conv-2'), false);
  const read = await run('read_session', { relay: 'this', session: 'conv-1' });
  assert.equal(read.body.session.mayCreateSessions, true);
});

test('update_session through the worker\'s tool: checked twice, a null group survives the trip', async () => {
  const { dispatcher, remote } = setup();
  withSession(remote, { origin: AGENT_ORIGIN, groupId: BATCH_GROUP.id });
  remote.groupList = [BATCH_GROUP];
  const api = async (_method, _path, body) => (await dispatcher.dispatch(body)).body;
  const result = await executeRemoteRelayTool({ action: 'update_session', relay: 'linux-test', session: 'conv-1', group: null }, { api, conversationId: 'c-1' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.changed, ['group']);
  assert.equal(result.settings.group, null);
});

// ─── update_session: who may change what freely (fix round 1) ────────────────

test('update_session asks the owner for any session this conversation did not start: a sibling, its creator, another conversation\'s', async () => {
  const { run, local, approvals } = setupLocal();
  const localOrigin = (conversationId) => ({ relayId: 'relay-self-id', relayName: 'win-test', conversationId, hops: 0, local: true });
  // c-1 was started by lead; sibling by lead too; mine by c-1; theirs by c-2.
  local.addConversation({ id: 'lead', title: 'lead' });
  local.addConversation({ id: 'c-1', title: 'report builder', origin: localOrigin('lead') });
  local.addConversation({ id: 'sibling', title: 'sibling', origin: localOrigin('lead') });
  local.addConversation({ id: 'mine', title: 'mine', origin: localOrigin('c-1') });
  local.addConversation({ id: 'theirs', title: 'theirs', origin: localOrigin('c-2') });
  assert.equal((await run('update_session', { relay: 'this', session: 'mine', effort: 'high' })).status, 200);
  assert.equal(approvals.length, 0, 'its own session: free');
  for (const session of ['sibling', 'lead', 'theirs']) {
    const result = await run('update_session', { relay: 'this', session, effort: 'high' });
    assert.equal(result.status, 200, session);
  }
  // One card for all three: once per conversation and relay.
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].sessionSettings.session, 'sibling');
  // The call names its conversation to the target, which decides.
  const sent = local.callsTo('PATCH', '/api/conversation/mine/settings')[0];
  assert.equal(sent.body.origin.conversationId, 'c-1');
  assert.equal(sent.body.origin.local, true);
});

test('on a paired relay: free only on a session this conversation started there; another conversation\'s needs the card', async () => {
  const { run, remote, approvals } = setup();
  remote.addConversation({ id: 'conv-mine', title: 'mine', origin: { relayId: 'relay-self-id', relayName: 'win-test', conversationId: 'c-1', hops: 1 } });
  remote.addConversation({ id: 'conv-other', title: 'other', origin: { relayId: 'relay-self-id', relayName: 'win-test', conversationId: 'c-9', hops: 1 } });
  assert.equal((await run('update_session', { relay: 'linux-test', session: 'conv-mine', effort: 'high' })).status, 200);
  assert.equal(approvals.length, 0);
  assert.equal((await run('update_session', { relay: 'linux-test', session: 'conv-other', effort: 'high' })).status, 200);
  assert.equal(approvals.length, 1);
  assert.equal(remote.callsTo('PATCH', '/api/conversation/conv-other/settings').at(-1).body.owner_approved, true);
});

test('a partial write on the target and an unreadable process list come back as such', async () => {
  const { run, remote } = setup();
  withSession(remote, { origin: AGENT_ORIGIN });
  remote.settingsFailure = remoteError(`${CODES.httpPrefix}400`, 'Relay "linux-test" answered HTTP 400', 400, {
    ok: false, code: 'SESSION_GROUP_NOT_FOUND', error: 'The session group grp_gone is gone. These settings were changed before: cwd, effort.', changed: ['cwd', 'effort'],
  });
  const partial = await run('update_session', { relay: 'linux-test', session: 'conv-1', cwd: '/home/dev/other', effort: 'low', group: 'grp_gone' });
  assert.equal(partial.body.ok, false);
  assert.deepEqual(partial.body.changed, ['cwd', 'effort']);
  assert.match(partial.body.error, /changed before: cwd, effort/);
  remote.settingsFailure = remoteError(`${CODES.httpPrefix}503`, 'Relay "linux-test" answered HTTP 503', 503, {
    ok: false, code: 'PROCESS_LIST_UNREADABLE', error: 'This relay could not read its process list, so it cannot tell whether the session\'s CLI still runs; the folder was not changed.', changed: [],
  });
  const unreadable = await run('update_session', { relay: 'linux-test', session: 'conv-1', cwd: '/home/dev/other' });
  assert.equal(unreadable.status, 503);
  assert.equal(unreadable.body.remoteCode, 'PROCESS_LIST_UNREADABLE');
  assert.match(unreadable.body.error, /could not read its process list/);
  assert.deepEqual(unreadable.body.changed, []);
  // A relaunch that failed after the folder was saved.
  remote.settingsFailure = remoteError(`${CODES.httpPrefix}500`, 'Relay "linux-test" answered HTTP 500', 500, {
    ok: false, code: 'relaunch-failed', error: 'Failed to relaunch the CLI The folder is saved for its next launch; nothing else was changed.', changed: ['cwd'],
  });
  const relaunch = await run('update_session', { relay: 'linux-test', session: 'conv-1', cwd: '/home/dev/other' });
  assert.equal(relaunch.body.ok, false);
  assert.deepEqual(relaunch.body.changed, ['cwd']);
});

// ─── send with provider: a Claude session's billing ──────────────────────────

test('send with provider switches a Claude session\'s billing and sends in one call', async () => {
  const { run, remote, approvals } = setup();
  withSession(remote);
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, provider: 'claude-api', wait_seconds: 0 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, 'queued');
  assert.equal(result.body.provider, 'claude-api');
  assert.equal(result.body.billingSwitched, true);
  assert.match(result.body.note, /now runs on the API key/);
  const [switchCall] = remote.callsTo('POST', '/api/conversation/conv-1/billing');
  assert.equal(switchCall.body.to, 'claude-api');
  assert.equal(switchCall.body.by, 'agent');
  assert.equal(switchCall.body.message.conversationId, 'conv-1');
  assert.ok(switchCall.body.message.text.endsWith(PROMPT));
  assert.equal(remote.callsTo('POST', '/api/message').length, 0);
  assert.equal(remote.conversations.get('conv-1').provider, 'claude-api');
  // The approval card says what the send does to the bill.
  assert.ok(approvals.length <= 1);
});

test('send with the session\'s own billing is an ordinary send', async () => {
  const { run, remote } = setup();
  withSession(remote, { provider: 'claude-api' });
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, provider: 'claude-api', wait_seconds: 0 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.billingSwitched, undefined);
  assert.equal(remote.callsTo('POST', '/api/message').length, 1);
  assert.equal(remote.callsTo('POST', '/api/conversation/conv-1/billing').length, 0);
});

test('an older relay without the switch: refused, nothing sent', async () => {
  const { run, remote } = setup();
  const conv = withSession(remote);
  remote.billingRouteMissing = true;
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, provider: 'claude-api', wait_seconds: 0 });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'REMOTE_RELAY_UNSUPPORTED');
  assert.match(result.body.error, /cannot switch a session's billing/);
  assert.equal(conv.messages.length, 2);
  assert.equal(conv.provider, 'claude');
});

test('a switch the target refuses sends nothing, with its reason', async () => {
  const { run, remote } = setup();
  const conv = withSession(remote);
  remote.billingRefusal = { code: 'CLAUDE_API_NOT_CONFIGURED', error: 'Claude API has no key.' };
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, provider: 'claude-api', wait_seconds: 0 });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'REMOTE_RELAY_PROVIDER_UNAVAILABLE');
  assert.match(result.body.error, /did not switch session conv-1 to the API key: Claude API has no key\./);
  assert.equal(result.body.remoteCode, 'CLAUDE_API_NOT_CONFIGURED');
  assert.equal(conv.messages.length, 2);
});

test('provider on a session that is no Claude one, or another provider: refused before anything is sent', async () => {
  const { run, remote } = setup();
  const conv = withSession(remote, { provider: 'cursor', model: 'composer-2.5' });
  const onCursor = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, provider: 'claude', wait_seconds: 0 });
  assert.equal(onCursor.status, 400);
  assert.equal(onCursor.body.code, 'REMOTE_RELAY_INVALID_INPUT');
  const other = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, provider: 'deepseek', wait_seconds: 0 });
  assert.equal(other.status, 400);
  assert.match(other.body.error, /send takes provider "claude"/);
  assert.equal(conv.messages.length, 2);
  assert.equal(remote.callsTo('POST', '/api/message').length, 0);
});

test('a model sent with the switch is checked against the billing it moves to', async () => {
  const { run, remote } = setup();
  const conv = withSession(remote);
  remote.settings['claude-api'] = { configured: true, enabled: true, model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'], availableModels: ['claude-sonnet-5-5'] };
  remote.models.providersByModel['claude-sonnet-5-5'] = ['claude-api'];
  // claude-opus-5 is on the subscription's list, not on the key's.
  const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, provider: 'claude-api', model: 'claude-opus-5', wait_seconds: 0 });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.code, 'REMOTE_RELAY_UNKNOWN_MODEL');
  assert.equal(conv.messages.length, 2);
  assert.equal(conv.provider, 'claude');
});

test('the approval card names a billing switch only when the send makes one', async () => {
  for (const [current, expected] of [['claude', 'claude-api'], ['claude-api', undefined]]) {
    const { run, remote, approvals } = setup({ caller: { mode: 'plan' } });
    withSession(remote, { provider: current });
    const result = await run('send', { relay: 'linux-test', session: 'conv-1', text: PROMPT, provider: 'claude-api', wait_seconds: 0 });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(approvals.length, 1, current);
    assert.equal(approvals[0].args.provider, expected, current);
  }
});
