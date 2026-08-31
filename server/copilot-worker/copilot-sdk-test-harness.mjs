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

/** Records every relay call; `failRoutes` makes a route throw, like a 500. */
export function makeApiStub({ failRoutes = new Set() } = {}) {
  const calls = [];
  async function api(method, routePath, body) {
    calls.push({ method, routePath, body });
    const route = String(routePath).split('?')[0];
    if (failRoutes.has(route)) throw new Error(`stub route failure: ${route}`);
    return {};
  }
  api.calls = calls;
  api.bodiesFor = (routePath) => calls.filter((c) => c.routePath === routePath).map((c) => c.body);
  return api;
}

/**
 * A fake CopilotSession. `send()` accepts one `MessageOptions` object (the
 * real signature: there is no second parameter) and, like the real SDK,
 * resolves immediately — the turn's completion arrives on the event callback,
 * which is what `onSend` is for.
 */
export function createFakeCopilotSession({ config, onSend = null, onAbort = null }) {
  const session = {
    sessionId: config?.sessionId || 'fake-session',
    config,
    sends: [],
    abortCalls: 0,
    setModelCalls: [],
    disconnected: false,
    emit(event) {
      config?.onEvent?.(event);
    },
    replay(events) {
      for (const event of events) session.emit(event);
    },
    async send(options) {
      session.sends.push(options);
      // Scheduled rather than synchronous so the runner's `await session.send`
      // resolves before the events land, matching the real ordering.
      setTimeout(() => { onSend?.(session, options); }, 0);
      return 'fake-message-id';
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
      const session = createFakeCopilotSession({ config, onSend, onAbort });
      session.resumed = true;
      client.sessions.push(session);
      // A session that exists once exists forever, so later reconnects resume.
      client.resumeAvailable = true;
      return session;
    },
    async createSession(config) {
      client.createAttempts.push(config);
      const session = createFakeCopilotSession({ config, onSend, onAbort });
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

export function makeRunner({
  stub,
  client,
  startWarning = null,
  runtimeVersion = '1.0.82',
  ...overrides
} = {}) {
  const started = [];
  return {
    started,
    runner: createCopilotSdkSessionRunner({
      api: stub,
      sdkSessionId: 'conv-1',
      cwd: '/tmp/relay-fixture-workspace',
      resolvePathsImpl: () => FAKE_SDK_PATHS,
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
