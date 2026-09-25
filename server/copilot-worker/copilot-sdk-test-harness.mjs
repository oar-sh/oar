// Spawn-free stand-ins for the Copilot SDK, per DEVELOPING.md: no test in this
// directory starts a runtime process, imports the installed SDK, or talks to a
// relay. The injection seam is a constructor option on
// `createCopilotSdkSessionRunner` (`startClientImpl`), not a module mock.
//
// Deliberately NOT named `*.test.mjs` so `node --test`'s glob skips it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCopilotSdkSessionRunner } from './copilot-sdk-session-process.mjs';
import { renderMediaEmbedInstructionBlock } from '../../shared/media-embed-instructions.mjs';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Load a scrubbed phase-0 event dump as an array of `SessionEvent`s. */
export function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'));
}

export function tick(ms = 5) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate, { timeoutMs = 3000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await tick(2);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/**
 * Records every relay call; `failRoutes` makes a route throw, like a 500.
 *
 * `routeResponses` maps a route to its response body, or to a function of
 * `(body, callIndexForThatRoute)` — which is how a test drives a route that
 * answers differently per attempt (`/api/continuation-turn`'s retry loop).
 * Unlisted routes answer `{}`, as before.
 */
export function makeApiStub({ failRoutes = new Set(), routeResponses = {} } = {}) {
  const calls = [];
  const routeCounts = new Map();
  async function api(method, routePath, body) {
    calls.push({ method, routePath, body });
    const route = String(routePath).split('?')[0];
    if (failRoutes.has(route)) throw new Error(`stub route failure: ${route}`);
    const attempt = routeCounts.get(route) || 0;
    routeCounts.set(route, attempt + 1);
    const canned = routeResponses[route];
    if (typeof canned === 'function') return canned(body, attempt);
    return canned === undefined ? {} : canned;
  }
  api.calls = calls;
  api.bodiesFor = (routePath) => calls.filter((c) => c.routePath === routePath).map((c) => c.body);
  return api;
}

/**
 * An api stub that mints synthetic queue rows, so a test can exercise the
 * continuation path end to end. `POST /api/continuation-turn` answers with a
 * fresh `messageId` and the `attemptId` the row was dequeued under, exactly as
 * the relay route does.
 */
export function makeContinuationApiStub({
  conversationId = 'conv-1',
  messageIds = ['cont-1', 'cont-2', 'cont-3'],
  ...options
} = {}) {
  const minted = [];
  const stub = makeApiStub({
    ...options,
    routeResponses: {
      '/api/continuation-turn': (body, attempt) => {
        const messageId = messageIds[Math.min(attempt, messageIds.length - 1)];
        const attemptId = `attempt-${messageId}`;
        minted.push({ messageId, attemptId, body });
        return { ok: true, messageId, conversationId, attemptId };
      },
      ...(options.routeResponses || {}),
    },
  });
  stub.mintedContinuations = minted;
  return stub;
}

/**
 * A fake CopilotSession. `send()` accepts one `MessageOptions` object (the
 * real signature: there is no second parameter) and, like the real SDK,
 * resolves immediately — the turn's completion arrives on the event callback,
 * which is what `onSend` is for.
 *
 * The `rpc.model` surface mirrors SDK 1.0.13's, which the runner talks to
 * DIRECTLY (the facade's `setModel` discards the switch result). Defaults model
 * a healthy runtime: `switchTo` confirms the requested model immediately,
 * `setReasoningEffort` echoes the level, `list` answers with `modelCatalog`
 * (empty by default — effort validation then degrades to attempting the RPC).
 * `modelRpc.{switchTo,setReasoningEffort,list}` override per test, each called
 * as `(params, session)`.
 */
export function createFakeCopilotSession({
  config, onSend = null, onAbort = null, modelRpc = {},
  // The experimental surfaces the parity work leans on. `queueRpc: false` /
  // `interruptRpc: false` model an older runtime without them (the runner
  // must degrade, never throw); `queueItems` seeds `pendingItems()`.
  queueRpc = true, interruptRpc = true, queueItems = null, onInterrupt = null,
  // `rpc.tasks`: `taskList` seeds `tasks.list()` (TaskInfo entries: agents
  // and shells); `taskProgress` maps id → progress. Off by default so the
  // suites written against the event-scraped shell tracker keep exercising
  // that fallback path; the registry tests opt in with `tasksRpc: true`.
  tasksRpc = false, taskList = null, taskProgress = null,
} = {}) {
  let nextMessageId = 0;
  const session = {
    sessionId: config?.sessionId || 'fake-session',
    config,
    sends: [],
    // The ids `send()` resolved, in send order — what `user.message.messageId`
    // must echo for the runner to attribute a prompt to its row.
    sentIds: [],
    abortCalls: 0,
    interruptCalls: [],
    setModelCalls: [],
    disconnected: false,
    // What `rpc.queue.pendingItems()` answers: [{ id, messageId }]. A test
    // mutates it (or passes `queueItems`) to model the runtime's queued lane.
    queueItems: Array.isArray(queueItems) ? queueItems : [],
    removedQueueItems: [],
    // The runtime's steering lane (runtime 1.0.88 shape): immediate sends
    // waiting to be injected, oldest first, WITHOUT ids — `pendingItems`
    // reports only their text — and how many leading ones are already folded
    // into the running turn. `removeMostRecent` pops the newest (LIFO across
    // both lanes). Tests push `{ messageId, text }` here to model a wait.
    steeringLane: [],
    inFlightSteeringCount: 0,
    removedSteering: [],
    // Order of queue/send calls, for tests that pin request ordering.
    callLog: [],
    // What `rpc.tasks.list()` answers; a test mutates it to model the runtime's
    // task registry moving (running → idle/completed/cancelled).
    taskList: Array.isArray(taskList) ? taskList : [],
    taskProgress: taskProgress && typeof taskProgress === 'object' ? taskProgress : {},
    cancelledTasks: [],
    removedTasks: [],
    emit(event) {
      config?.onEvent?.(event);
    },
    replay(events) {
      for (const event of events) session.emit(event);
    },
    /** The runtime message id of the Nth send (0-based), for hand-built events. */
    idOfSend(index) {
      return session.sentIds[index] || null;
    },
    async send(options) {
      session.sends.push(options);
      session.callLog.push('send');
      nextMessageId += 1;
      const messageId = `fake-message-id-${nextMessageId}`;
      session.sentIds.push(messageId);
      // Scheduled rather than synchronous so the runner's `await session.send`
      // resolves before the events land, matching the real ordering.
      setTimeout(() => { onSend?.(session, options, messageId); }, 0);
      return messageId;
    },
    async abort() {
      session.abortCalls += 1;
      setTimeout(() => { onAbort?.(session); }, 0);
    },
    async setModel(model) {
      session.setModelCalls.push(model);
    },
    async disconnect() {
      session.disconnected = true;
    },
  };
  session.rpc = {
    ...(interruptRpc ? {
      async interruptMainTurn(params) {
        session.interruptCalls.push(params);
        if (onInterrupt) return onInterrupt(session, params);
        // Like the runtime: the main turn is torn down and answers with an
        // aborted idle; nothing else is touched.
        setTimeout(() => { onAbort?.(session); }, 0);
        return { interrupted: true };
      },
    } : {}),
    ...(tasksRpc ? {
      tasks: {
        listCalls: 0,
        async list() {
          session.rpc.tasks.listCalls += 1;
          return { tasks: session.taskList.map((task) => ({ ...task })) };
        },
        async getProgress({ id }) {
          return { progress: session.taskProgress[id] || null };
        },
        async cancel({ id }) {
          const task = session.taskList.find((entry) => entry.id === id);
          if (!task || !['running', 'idle'].includes(task.status)) return { cancelled: false };
          session.cancelledTasks.push(id);
          task.status = 'cancelled';
          task.completedAt = new Date().toISOString();
          // Like the runtime: the registry changing announces itself.
          setTimeout(() => session.emit({ type: 'session.background_tasks_changed', data: {} }), 0);
          return { cancelled: true };
        },
        async remove({ id }) {
          const before = session.taskList.length;
          session.taskList = session.taskList.filter((entry) => entry.id !== id || ['running', 'idle'].includes(entry.status));
          const removed = session.taskList.length !== before;
          if (removed) session.removedTasks.push(id);
          return { removed };
        },
      },
    } : {}),
    ...(queueRpc ? {
      queue: {
        pendingCalls: 0,
        async pendingItems() {
          session.rpc.queue.pendingCalls += 1;
          return {
            items: session.queueItems.map((item) => ({ kind: 'message', ...item })),
            steeringMessages: session.steeringLane.map((entry) => entry.text),
            inFlightSteeringCount: session.inFlightSteeringCount,
          };
        },
        async removeMostRecent() {
          session.callLog.push('removeMostRecent');
          if (session.onRemoveMostRecent) return session.onRemoveMostRecent(session);
          if (session.queueItems.length) {
            session.removedQueueItems.push(session.queueItems.pop().id);
            return { removed: true };
          }
          if (session.steeringLane.length > session.inFlightSteeringCount) {
            session.removedSteering.push(session.steeringLane.pop().messageId);
            return { removed: true };
          }
          return { removed: false };
        },
        async removeAt({ id }) {
          const before = session.queueItems.length;
          session.queueItems = session.queueItems.filter((item) => item.id !== id);
          const removed = session.queueItems.length !== before;
          if (removed) session.removedQueueItems.push(id);
          return { removed };
        },
      },
    } : {}),
    model: {
      switchToCalls: [],
      effortCalls: [],
      listCalls: 0,
      async switchTo(params) {
        session.rpc.model.switchToCalls.push(params);
        if (modelRpc.switchTo) return modelRpc.switchTo(params, session);
        return { modelId: params.modelId };
      },
      async setReasoningEffort(params) {
        session.rpc.model.effortCalls.push(params);
        if (modelRpc.setReasoningEffort) return modelRpc.setReasoningEffort(params, session);
        return { reasoningEffort: params.reasoningEffort };
      },
      async list(params) {
        session.rpc.model.listCalls += 1;
        if (modelRpc.list) return modelRpc.list(params, session);
        return { list: Array.isArray(modelRpc.catalog) ? modelRpc.catalog : [] };
      },
    },
  };
  return session;
}

/**
 * The two ways `resumeSession` fails, which the runner MUST tell apart.
 *
 *  - `missing`   — the runtime has no state under this id. Shaped like the
 *                  real thing: the runtime throws `Session not found: <id>`
 *                  and JSON-RPC wraps it as a generic InternalError (-32603),
 *                  so the message is the only signal.
 *  - `transient` — the call itself failed (connection dropped). Falling
 *                  through to `createSession` here would blank a live
 *                  conversation.
 */
export function makeResumeFailure(flavor, sessionId = 'conv-1') {
  if (flavor === 'transient') {
    const error = new Error('Pending response rejected since connection got disposed');
    error.code = -32097;
    return error;
  }
  const error = new Error(`Request session.resume failed with message: Session not found: ${sessionId}`);
  error.code = -32603;
  return error;
}

/**
 * A fake CopilotClient. `resumeAvailable: false` models a brand-new
 * conversation (the runtime has no state to resume), which is what makes the
 * runner fall through to `createSession`. `resumeFailure: 'transient'` models
 * the RPC itself failing, which must NOT fall through.
 */
export function createFakeCopilotClient({
  resumeAvailable = false,
  resumeFailure = 'missing',
  onSend = null,
  onAbort = null,
  // `rpc.model` behaviour for every session this client mints; see
  // `createFakeCopilotSession`.
  modelRpc = {},
  ...sessionOptions
} = {}) {
  const client = {
    stopped: 0,
    resumeAttempts: [],
    createAttempts: [],
    sessions: [],
    resumeAvailable,
    resumeFailure,
    async resumeSession(sessionId, config) {
      client.resumeAttempts.push({ sessionId, config });
      if (!client.resumeAvailable) throw makeResumeFailure(client.resumeFailure, sessionId);
      const session = createFakeCopilotSession({ config, onSend, onAbort, modelRpc, ...sessionOptions });
      session.resumed = true;
      client.sessions.push(session);
      // A session that exists once exists forever, so later reconnects resume.
      client.resumeAvailable = true;
      return session;
    },
    async createSession(config) {
      client.createAttempts.push(config);
      const session = createFakeCopilotSession({ config, onSend, onAbort, modelRpc, ...sessionOptions });
      client.sessions.push(session);
      client.resumeAvailable = true;
      return session;
    },
    async stop() {
      client.stopped += 1;
      return [];
    },
  };
  Object.defineProperty(client, 'session', {
    get: () => client.sessions[client.sessions.length - 1] || null,
  });
  return client;
}

export const FAKE_SDK_PATHS = {
  sdkDir: '/opt/copilot/pkg/linux-x64/1.0.82/copilot-sdk',
  sdkEntry: '/opt/copilot/pkg/linux-x64/1.0.82/copilot-sdk/index.js',
  versionDir: '/opt/copilot/pkg/linux-x64/1.0.82',
  runtimeEntry: '/opt/copilot/pkg/linux-x64/1.0.82/app.js',
  version: '1.0.82',
};

/** Frozen delivery message; tests derive variants by spread. */
export const baseMessage = Object.freeze({
  id: 'q-1',
  conversationId: 'conv-1',
  relayMode: 'agent',
  text: 'hello',
  model: 'gpt-5-mini',
});

/**
 * A stand-in for the relay question bridge.
 *
 * `answers` maps a matcher to a canned reply, so a test can drive `ask_user`
 * and ask-mode tool approvals without a relay. Every call is recorded.
 */
export function makeFakeQuestionBridge({
  userInputAnswer = 'the human answer',
  userInputTimedOut = false,
  approve = true,
  approvalTimedOut = false,
  approvalFeedback = 'The user declined this action.',
  // Structured elicitation: the validated form submission the fake "relay"
  // hands back, or null for a card that produced none.
  structuredAnswer = null,
  structuredTimedOut = false,
  // Awaited before every answer: a test can hold the card open (a promise it
  // resolves later) to exercise the question hold on steering.
  onAsk = null,
} = {}) {
  const bridge = {
    userInputCalls: [],
    approvalCalls: [],
    structuredCalls: [],
    cancelledCount: 0,
    async askUserInput(request, options) {
      bridge.userInputCalls.push({ request, options });
      if (onAsk) await onAsk(request, options);
      const choices = Array.isArray(request?.choices) ? request.choices : [];
      const answer = typeof userInputAnswer === 'function' ? userInputAnswer(request) : userInputAnswer;
      return {
        answer,
        wasFreeform: userInputTimedOut ? true : !choices.includes(answer),
        timedOut: userInputTimedOut,
      };
    },
    async askToolApproval(request, options) {
      bridge.approvalCalls.push({ request, options });
      if (onAsk) await onAsk(request, options);
      return {
        approved: approvalTimedOut ? false : approve,
        answer: approve ? 'Approve' : 'Deny',
        feedback: approvalFeedback,
        timedOut: approvalTimedOut,
        description: 'a tool',
      };
    },
    async askStructured(spec, options) {
      bridge.structuredCalls.push({ spec, options });
      if (onAsk) await onAsk(spec, options);
      const answer = typeof structuredAnswer === 'function' ? structuredAnswer(spec) : structuredAnswer;
      return {
        structuredAnswer: structuredTimedOut ? null : answer,
        answer: '',
        timedOut: structuredTimedOut,
      };
    },
    async cancelPendingQuestions() {
      bridge.cancelledCount += 1;
      return 0;
    },
    pendingQuestionCount: () => 0,
  };
  return bridge;
}

/**
 * The relay-context prefix the runner prepends to every prompt, for tests that
 * assert on the prompt. `relayToolInstructions` defaults to '' in the harness,
 * so only the mode marker and the mode's standing instructions appear, and the
 * instructions only on the FIRST turn of a given relay mode.
 */
export function expectedPromptPrefix(mode = 'agent', { includeInstructions = true } = {}) {
  const marker = `[Relay mode: ${mode}]`;
  if (!includeInstructions) return marker;
  const instructions = {
    agent: 'Proceed as an interactive coding agent and use tools as needed. If you need clarification, pause and ask through the web relay instead of stalling silently. These instructions remain in effect until relay mode changes.',
    plan: 'Draft a concise plan only. Use read-only inspection tools (glob, rg, view) only when they materially improve plan quality; otherwise draft from provided context. Do not edit repository files or run mutating commands unless the user explicitly asks for implementation. If clarification is required, pause and ask through the web relay. These instructions remain in effect until relay mode changes.',
    ask: 'Prioritize clarification questions before doing any implementation work. If the request is ambiguous or underspecified, pause and ask through the web relay before making assumptions. Do not make broad assumptions when a question would materially change the result. These instructions remain in effect until relay mode changes.',
    autopilot: 'Act directly on the request and use tools when needed. Keep moving unless user input is truly blocking. These instructions remain in effect until relay mode changes.',
  }[mode];
  // The guidance turns also carry the media-embed capability block, appended
  // by applyMediaEmbedInstructions in copilot-prompt-context.mjs.
  return `${marker} ${instructions} ${renderMediaEmbedInstructionBlock()}`;
}

/** The message body with the relay-context prefix in front, as sent. */
export function promptWithPrefix(body, mode = 'agent', options = {}) {
  return `${expectedPromptPrefix(mode, options)} ${body}`;
}

export function makeRunner({
  stub,
  client,
  startWarning = null,
  runtimeVersion = '1.0.82',
  questionBridge = makeFakeQuestionBridge(),
  ...overrides
} = {}) {
  const started = [];
  return {
    started,
    questionBridge,
    runner: createCopilotSdkSessionRunner({
      api: stub,
      sdkSessionId: 'conv-1',
      cwd: '/tmp/relay-fixture-workspace',
      resolvePathsImpl: () => FAKE_SDK_PATHS,
      // Spawn-free and relay-free by default: no test reads the real
      // relay-tools.md off disk or asks a relay whether previews are on.
      relayToolInstructions: '',
      getPreviewInstructionsImpl: () => '',
      createQuestionBridgeImpl: () => questionBridge,
      startClientImpl: async (options) => {
        started.push(options);
        return {
          sdk: {},
          client,
          paths: options.paths,
          // The real adapter never blocks client start on the version probe;
          // it hands back a promise the runner logs when it settles.
          versionReady: Promise.resolve({ runtimeVersion, versionSkewWarning: startWarning }),
        };
      },
      ...overrides,
    }),
  };
}

/**
 * The events of a fixture up to and including the first one matching `type`.
 * Lets a test replay "everything through session.idle" without hand-listing.
 */
export function eventsThrough(events, type) {
  const index = events.findIndex((event) => event.type === type);
  return index === -1 ? events.slice() : events.slice(0, index + 1);
}
