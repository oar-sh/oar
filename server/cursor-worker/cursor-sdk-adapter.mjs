import path from 'node:path';
import fs from 'node:fs';

/**
 * The only module in the repo that imports `@cursor/sdk` (and its
 * `@cursor/sdk/sqlite` entry). All SDK access is injectable and the real
 * bindings are resolved lazily via dynamic import, so tests that inject
 * fakes never load the SDK at all.
 */

async function defaultAgentFactory() {
  const { Agent } = await import('@cursor/sdk');
  return {
    create: (options) => Agent.create(options),
    resume: (agentId, options) => Agent.resume(agentId, options),
  };
}

// The published SDK exposes a static `open({ workspaceRef, stateRoot })`
// instead of a path constructor; the injectable surface stays
// `storeFactoryImpl(storePath, { cwd })` with the real store rooted in the
// storePath's directory.
async function defaultStoreFactory() {
  const { SqliteLocalAgentStore } = await import('@cursor/sdk/sqlite');
  return (storePath, { cwd } = {}) =>
    SqliteLocalAgentStore.open({
      workspaceRef: cwd || path.dirname(storePath),
      stateRoot: path.dirname(storePath),
    });
}

export async function createCursorAgentHandle({
  apiKey,
  model,
  cwd,
  storeDir,
  sdkSessionId,
  agentId = '',
  customTools = {},
  agentFactoryImpl = null,
  storeFactoryImpl = null,
  dbg = () => {},
} = {}) {
  const factory = agentFactoryImpl || (await defaultAgentFactory());
  const makeStore = storeFactoryImpl || (await defaultStoreFactory());
  const storePath = path.join(storeDir, sdkSessionId, 'agent.db');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const store = await makeStore(storePath, { cwd });
  const options = {
    apiKey,
    model: { id: model },
    local: { cwd, store, customTools, autoReview: false },
  };
  const resumeId = String(agentId || '').trim();
  const agent = resumeId
    ? await factory.resume(resumeId, options)
    : await factory.create(options);
  const resolvedAgentId = agent?.id || agent?.agentId || resumeId;
  dbg('cursor agent ready', resumeId ? 'resumed' : 'created', resolvedAgentId);
  return {
    agent,
    agentId: resolvedAgentId,
    async close() {
      try {
        await agent?.close?.();
      } catch (error) {
        dbg('cursor agent close failed', error?.message || String(error));
      }
    },
  };
}

export function modeForRelayMode(relayMode) {
  return String(relayMode || 'agent').trim().toLowerCase() === 'plan' ? 'plan' : 'agent';
}

/**
 * Start one run and return a turn that is both async-iterable (merged
 * onDelta + run.stream() events in arrival order) and cancellable. The
 * returned iterator ends when the stream ends or the abort signal fires —
 * the Cursor SDK does not reliably emit a terminal message on cancel, so
 * abort must end the consumer's for-await on its own.
 */
export function startCursorRun({
  agent,
  message,
  model,
  relayMode = 'agent',
  abortSignal = null,
  dbg = () => {},
} = {}) {
  const queue = [];
  let ended = false;
  let failure = null;
  let notify = null;
  let run = null;

  const wake = () => {
    if (!notify) return;
    const resolve = notify;
    notify = null;
    resolve();
  };
  const push = (event) => {
    if (ended) return;
    queue.push(event);
    wake();
  };
  const end = () => {
    ended = true;
    wake();
  };
  const onAbort = () => {
    // Unread events are dropped so the consumer ends promptly.
    queue.length = 0;
    end();
  };

  if (abortSignal?.aborted) {
    ended = true;
  } else if (abortSignal) {
    abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  (async () => {
    if (ended) return;
    try {
      run = await agent.send(message, {
        // Model on EVERY send: per-run overrides are sticky across later runs.
        model: { id: model },
        mode: modeForRelayMode(relayMode),
        onDelta: ({ update }) => push({ source: 'delta', update }),
      });
      for await (const sdkMessage of run.stream()) {
        if (ended) break;
        push({ source: 'stream', message: sdkMessage });
      }
    } catch (error) {
      failure = failure || error;
      dbg('cursor run failed', error?.message || String(error));
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
      end();
    }
  })();

  async function* iterate() {
    while (true) {
      if (failure) throw failure;
      if (queue.length) {
        yield queue.shift();
        continue;
      }
      if (ended) return;
      await new Promise((resolve) => { notify = resolve; });
    }
  }

  const iterator = iterate();
  return {
    [Symbol.asyncIterator]: () => iterator,
    async cancel() {
      try {
        await run?.cancel?.();
      } catch (error) {
        dbg('cursor run cancel failed', error?.message || String(error));
      }
    },
    get runId() {
      return run?.id || '';
    },
  };
}

/**
 * Name/code checks rather than instanceof so classification works on
 * SDK-typed errors, transported plain objects, and test fixtures alike.
 */
export function classifyCursorError(error) {
  const message = String(error?.message || error);
  const isRetryable = error?.isRetryable === true;
  const name = String(error?.name || '');
  if (name === 'AuthenticationError') {
    return {
      isAuth: true,
      isBusy: false,
      isRetryable,
      code: 'authentication_failed',
      stableCode: 'cursor.authentication_failed',
      message,
    };
  }
  // v1.0.26 in practice throws UnknownAgentError("Agent <id> already has
  // active run") for the documented AgentBusyError case — match both.
  if (name === 'AgentBusyError' || /already has (an )?active run/i.test(message)) {
    return {
      isAuth: false,
      isBusy: true,
      isRetryable,
      code: 'agent_busy',
      stableCode: 'cursor.agent_busy',
      message,
    };
  }
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = rawCode.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (code) {
    return {
      isAuth: false,
      isBusy: false,
      isRetryable,
      code,
      stableCode: `cursor.${code}`,
      message,
    };
  }
  return {
    isAuth: false,
    isBusy: false,
    isRetryable,
    code: 'turn-error',
    stableCode: 'cursor.turn-error',
    message,
  };
}

async function defaultModelsList({ apiKey }) {
  const sdk = await import('@cursor/sdk');
  try {
    return await sdk.Cursor.models.list({ apiKey });
  } catch {
    // Older/newer SDK builds may expose models on a client instance instead.
    const client = new sdk.Cursor({ apiKey });
    return client.models.list();
  }
}

const contextWindowCache = new Map();

function pickContextWindow(entry) {
  const value = Number(
    entry?.contextWindow
      ?? entry?.context_window
      ?? entry?.contextLength
      ?? entry?.maxContextTokens,
  );
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Best-effort context-window lookup: never throws, null on any failure.
 * Successful lookups are cached per model; failures are not, so a transient
 * list error does not pin null for the process lifetime.
 */
export async function readModelContextWindow({
  apiKey,
  model,
  modelsListImpl = null,
  dbg = () => {},
} = {}) {
  const wanted = String(model || '').trim();
  if (!wanted) return null;
  if (contextWindowCache.has(wanted)) return contextWindowCache.get(wanted);
  try {
    const listImpl = modelsListImpl || defaultModelsList;
    const response = await listImpl({ apiKey });
    const entries = Array.isArray(response)
      ? response
      : Array.isArray(response?.models)
        ? response.models
        : Array.isArray(response?.data)
          ? response.data
          : [];
    const wantedLower = wanted.toLowerCase();
    for (const entry of entries) {
      const id = typeof entry === 'string'
        ? entry
        : String(entry?.id || entry?.name || entry?.model?.id || '');
      if (id.toLowerCase() !== wantedLower) continue;
      if (typeof entry === 'string') break;
      const contextWindow = pickContextWindow(entry);
      if (contextWindow !== null) {
        contextWindowCache.set(wanted, contextWindow);
        return contextWindow;
      }
      break;
    }
  } catch (error) {
    dbg('cursor models list failed', error?.message || String(error));
  }
  return null;
}
