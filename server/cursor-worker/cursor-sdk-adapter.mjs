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
  agents = null,
  agentFactoryImpl = null,
  storeFactoryImpl = null,
  dbg = () => {},
} = {}) {
  const factory = agentFactoryImpl || (await defaultAgentFactory());
  const makeStore = storeFactoryImpl || (await defaultStoreFactory());
  const storePath = path.join(storeDir, sdkSessionId, 'agent.db');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const store = await makeStore(storePath, { cwd });
  // `agents` rides on BOTH create and resume on purpose. The SDK persists the
  // roster into the agent's store metadata at create time and falls back to
  // that copy when a resume passes none, so a session resumed after the user
  // changed their model selection would otherwise keep the old subagent menu.
  // An empty roster is omitted rather than sent: the SDK maps `{}` to
  // "unspecified" anyway, so there is no way to express "no subagents" that
  // clears the persisted set.
  const hasAgents = !!agents && Object.keys(agents).length > 0;
  const options = {
    apiKey,
    model: { id: model },
    ...(hasAgents ? { agents } : {}),
    local: { cwd, store, customTools, autoReview: false },
  };
  const resumeId = String(agentId || '').trim();
  let agent = null;
  try {
    agent = resumeId
      ? await factory.resume(resumeId, options)
      : await factory.create(options);
  } catch (error) {
    // The handle owns the store it opened; a failed create/resume must not
    // leak the SQLite handle (rebuild paths retry with a fresh open).
    try { store?.close?.(); } catch {}
    throw error;
  }
  const resolvedAgentId = agent?.agentId || resumeId;
  dbg('cursor agent ready', resumeId ? 'resumed' : 'created', resolvedAgentId);
  return {
    agent,
    agentId: resolvedAgentId,
    // Fresh agents' lifetime usage belongs to this conversation; resumed ones
    // carry history the plan-usage ledger must baseline, not book.
    created: !resumeId,
    async close() {
      try {
        await agent?.close?.();
      } catch (error) {
        dbg('cursor agent close failed', error?.message || String(error));
      }
      // Handles are rebuilt on roster changes and busy/auth retries; without
      // this every rebuild leaked an open SQLite store on the same file.
      try { store?.close?.(); } catch (error) {
        dbg('cursor store close failed', error?.message || String(error));
      }
    },
  };
}

/**
 * Read the agent's cumulative billed usage and cost.
 *
 * `agent.getUsage()` returns lifetime totals for the agent (plus a per-run
 * breakdown that carries no model, which is why the relay diffs whole-agent
 * totals per turn instead of classifying runs). Cost is documented as
 * server-derived and eventually consistent, so it can legitimately be absent
 * right after a run ends — the caller re-reports on the next turn and the
 * checkpoint diff picks it up whole.
 *
 * Best-effort: usage reporting must never disturb the turn that produced it.
 * Despite the local agent, this is a *remote* read — the SDK routes
 * `getUsage()` to `GET /v1/agents/:id/usage` through a plain `fetch` with no
 * abort signal — and it runs on the path to publishing the turn's reply, so it
 * is raced against a timeout the way the Claude worker races its control
 * requests. A slow Cursor API costs the usage reading, never the answer.
 */
export async function readAgentUsage({ agent, dbg = () => {}, timeoutMs = 8000 } = {}) {
  if (typeof agent?.getUsage !== 'function') return null;
  let timer = null;
  try {
    const request = agent.getUsage();
    // The race leaves the losing promise unobserved on timeout; swallow its
    // rejection so it cannot surface as an unhandledRejection.
    request?.catch?.(() => {});
    const usage = await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`cursor usage timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    if (!usage || typeof usage !== 'object') return null;
    const tokens = usage.usage && typeof usage.usage === 'object' ? usage.usage : {};
    const cost = usage.cost && typeof usage.cost === 'object' ? usage.cost : null;
    return {
      rawCostCents: Number.isFinite(Number(cost?.rawCostCents)) ? Number(cost.rawCostCents) : null,
      chargedCents: Number.isFinite(Number(cost?.chargedCents)) ? Number(cost.chargedCents) : null,
      inputTokens: Number.isFinite(Number(tokens.inputTokens)) ? Number(tokens.inputTokens) : null,
      outputTokens: Number.isFinite(Number(tokens.outputTokens)) ? Number(tokens.outputTokens) : null,
      cacheReadTokens: Number.isFinite(Number(tokens.cacheReadTokens)) ? Number(tokens.cacheReadTokens) : null,
      cacheWriteTokens: Number.isFinite(Number(tokens.cacheWriteTokens)) ? Number(tokens.cacheWriteTokens) : null,
      totalTokens: Number.isFinite(Number(tokens.totalTokens)) ? Number(tokens.totalTokens) : null,
      runCount: Array.isArray(usage.runs) ? usage.runs.length : null,
    };
  } catch (error) {
    dbg('cursor agent usage read failed', error?.message || String(error));
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  modelParams = null,
  relayMode = 'agent',
  abortSignal = null,
  // LocalSendOptions passthrough — `{ force: true }` is the SDK's documented
  // recovery for a local agent left wedged by a crashed process.
  sendLocal = null,
  // Turn backstop: with no SDK traffic for this long (and no client-hosted
  // work pending, e.g. an open ask_user card) the run is failed as stalled
  // instead of parking the merged iterator forever. 0 disables.
  stallTimeoutMs = 120_000,
  hasPendingClientWork = () => false,
  dbg = () => {},
} = {}) {
  const queue = [];
  let ended = false;
  let failure = null;
  let notify = null;
  let run = null;
  let lastEventAt = Date.now();
  let stallTimer = null;

  const wake = () => {
    if (!notify) return;
    const resolve = notify;
    notify = null;
    resolve();
  };
  const push = (event) => {
    if (ended) return;
    lastEventAt = Date.now();
    queue.push(event);
    wake();
  };
  const end = () => {
    ended = true;
    if (stallTimer) {
      clearInterval(stallTimer);
      stallTimer = null;
    }
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

  if (!ended && Number(stallTimeoutMs) > 0) {
    stallTimer = setInterval(() => {
      if (ended) return;
      if (hasPendingClientWork()) {
        // A human is thinking about a question card; the clock restarts when
        // the tool settles and traffic resumes.
        lastEventAt = Date.now();
        return;
      }
      if (Date.now() - lastEventAt >= Number(stallTimeoutMs)) {
        failure = failure || new Error(`cursor turn stalled: no SDK traffic for ${Math.round(Number(stallTimeoutMs) / 1000)}s`);
        dbg('cursor run stalled, ending merged stream');
        end();
      }
    }, Math.min(15_000, Math.max(1_000, Math.floor(Number(stallTimeoutMs) / 4))));
    stallTimer.unref?.();
  }

  (async () => {
    if (ended) return;
    try {
      run = await agent.send(message, {
        // Model on EVERY send: per-run overrides are sticky across later runs.
        model: {
          id: model,
          ...(Array.isArray(modelParams) && modelParams.length ? { params: modelParams } : {}),
        },
        mode: modeForRelayMode(relayMode),
        ...(sendLocal && typeof sendLocal === 'object' ? { local: sendLocal } : {}),
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
      // Drain buffered events before surfacing a producer failure: the
      // consumer awaits an HTTP post per action, so a terminal status frame
      // (with the turn's text and usage) is often still queued when the
      // stream throws — dropping it would turn a completed turn into a hard
      // failure. An abort clears the queue, so the failure still surfaces
      // immediately on the abort race.
      if (queue.length) {
        yield queue.shift();
        continue;
      }
      if (failure) throw failure;
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
 * Backend auth rejections often arrive without an AuthenticationError type:
 * as a terminal ERROR run status ("Authentication error If you are logged
 * in, try logging out and back in.") or as a transport error whose code is
 * not a string. Text matching is the only signal that works across all of
 * these shapes.
 */
export function isCursorAuthErrorMessage(text) {
  return /authentication error|unauthenticated|not authenticated|invalid api key|api key.*(?:expired|revoked)/i
    .test(String(text || ''));
}

/**
 * Name/code checks rather than instanceof so classification works on
 * SDK-typed errors, transported plain objects, and test fixtures alike.
 */
export function classifyCursorError(error) {
  const message = String(error?.message || error);
  const isRetryable = error?.isRetryable === true;
  const name = String(error?.name || '');
  if (name === 'AuthenticationError' || isCursorAuthErrorMessage(message)) {
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
  // The namespace form is the only working call shape: `Cursor` has a private
  // constructor and `models` is a static member, so the old client-instance
  // fallback could only ever throw a TypeError that masked the real error.
  const sdk = await import('@cursor/sdk');
  return sdk.Cursor.models.list({ apiKey });
}

const contextWindowCache = new Map();
// Models without a `context` parameter (composer-2.5, grok-4.5) resolve to
// null; remember that for a while so they stop paying a models.list() round
// trip on every turn. Transient list failures are never cached.
const NEGATIVE_CONTEXT_WINDOW_TTL_MS = 30 * 60_000;
const MODELS_LIST_TIMEOUT_MS = 8_000;

function modelEntriesFromListResponse(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.models)) return response.models;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

function modelEntryId(entry) {
  return typeof entry === 'string'
    ? entry
    : String(entry?.id || entry?.name || entry?.model?.id || '');
}

/** Parse a Cursor `context` parameter value: '300k' → 300000, '1m' → 1000000. */
export function parseContextWindowValue(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)([km])?$/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const scale = match[2] === 'm' ? 1_000_000 : (match[2] === 'k' ? 1_000 : 1);
  return Math.round(base * scale);
}

function pickContextWindow(entry) {
  const value = Number(
    entry?.contextWindow
      ?? entry?.context_window
      ?? entry?.contextLength
      ?? entry?.maxContextTokens,
  );
  if (Number.isFinite(value) && value > 0) return value;

  // Current SDK builds expose no window field; the window is encoded in the
  // model's 'context' parameter values ('300k', '1m'). The default variant's
  // choice is what an unmodified send runs with; models without a flagged
  // default fall back to the largest advertised context.
  const parameters = Array.isArray(entry?.parameters) ? entry.parameters : [];
  const contextParam = parameters.find(
    (param) => String(param?.id || '').trim().toLowerCase() === 'context',
  );
  if (!contextParam) return null;

  const variants = Array.isArray(entry?.variants) ? entry.variants : [];
  const defaultVariant = variants.find((variant) => variant?.isDefault === true);
  const defaultContext = (Array.isArray(defaultVariant?.params) ? defaultVariant.params : [])
    .find((param) => String(param?.id || '').trim().toLowerCase() === 'context');
  const fromDefault = parseContextWindowValue(defaultContext?.value);
  if (fromDefault !== null) return fromDefault;

  const candidates = (Array.isArray(contextParam.values) ? contextParam.values : [])
    .map((entryValue) => parseContextWindowValue(
      entryValue && typeof entryValue === 'object' ? entryValue.value : entryValue,
    ))
    .filter((parsed) => parsed !== null);
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * Best-effort context-window lookup: never throws, null on any failure.
 * Successful lookups are cached per model for the process lifetime; a list
 * that succeeds but resolves no window is cached as null with a TTL (the
 * absence is structural, not transient); list failures are never cached. The
 * call is raced against a timeout because it runs in the turn's finally path,
 * where a hung Cursor API would otherwise gate reply publication.
 */
export async function readModelContextWindow({
  apiKey,
  model,
  modelsListImpl = null,
  timeoutMs = MODELS_LIST_TIMEOUT_MS,
  dbg = () => {},
} = {}) {
  const wanted = String(model || '').trim();
  if (!wanted) return null;
  const cached = contextWindowCache.get(wanted);
  if (cached && (!cached.expiresAt || cached.expiresAt > Date.now())) return cached.value;
  try {
    const listImpl = modelsListImpl || defaultModelsList;
    const response = await Promise.race([
      listImpl({ apiKey }),
      new Promise((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`models.list timed out after ${timeoutMs}ms`)),
          Math.max(1, Number(timeoutMs) || MODELS_LIST_TIMEOUT_MS),
        );
        timer.unref?.();
      }),
    ]);
    const entries = modelEntriesFromListResponse(response);
    const wantedLower = wanted.toLowerCase();
    for (const entry of entries) {
      const id = modelEntryId(entry);
      if (id.toLowerCase() !== wantedLower) continue;
      if (typeof entry === 'string') break;
      const contextWindow = pickContextWindow(entry);
      if (contextWindow !== null) {
        contextWindowCache.set(wanted, { value: contextWindow, expiresAt: 0 });
        return contextWindow;
      }
      break;
    }
    contextWindowCache.set(wanted, {
      value: null,
      expiresAt: Date.now() + NEGATIVE_CONTEXT_WINDOW_TTL_MS,
    });
  } catch (error) {
    dbg('cursor models list failed', error?.message || String(error));
  }
  return null;
}

const modelParameterDefsCache = new Map();

/**
 * Map the composer's reasoning effort onto the model params Cursor expects on
 * `agent.send`. Effort lives in a per-model parameter named 'effort' or
 * 'reasoning' ('extra-high' is Cursor's spelling of 'xhigh'); models that also
 * expose a boolean 'thinking' parameter only honor the higher tiers with
 * thinking enabled, so an explicit effort turns thinking on and 'none' turns it
 * off. Best-effort like readModelContextWindow: null on any failure or when the
 * model has no matching parameter, which sends the model's default variant.
 */
export async function resolveCursorReasoningParams({
  apiKey,
  model,
  reasoningEffort,
  modelsListImpl = null,
  dbg = () => {},
} = {}) {
  const wanted = String(model || '').trim();
  const effort = String(reasoningEffort || '').trim().toLowerCase();
  if (!wanted || !effort) return null;
  let parameters = modelParameterDefsCache.get(wanted);
  if (parameters === undefined) {
    try {
      const listImpl = modelsListImpl || defaultModelsList;
      const response = await listImpl({ apiKey });
      const wantedLower = wanted.toLowerCase();
      for (const entry of modelEntriesFromListResponse(response)) {
        if (modelEntryId(entry).toLowerCase() !== wantedLower) continue;
        parameters = typeof entry === 'object' && Array.isArray(entry?.parameters) ? entry.parameters : [];
        break;
      }
      // Successful lookups are cached (including "model has no parameters");
      // failures are not, so a transient list error is retried next turn.
      if (parameters !== undefined) modelParameterDefsCache.set(wanted, parameters);
    } catch (error) {
      dbg('cursor models list failed', error?.message || String(error));
      return null;
    }
  }
  if (!Array.isArray(parameters) || !parameters.length) return null;
  const paramsById = new Map(
    parameters.map((param) => [String(param?.id || '').trim().toLowerCase(), param]),
  );
  const effortParam = paramsById.get('effort') || paramsById.get('reasoning');
  const hasThinkingParam = paramsById.has('thinking');
  const effortValues = new Set(
    (Array.isArray(effortParam?.values) ? effortParam.values : [])
      .map((value) => String((value && typeof value === 'object' ? value.value : value) || '').trim().toLowerCase())
      .filter(Boolean),
  );
  if (effort === 'none') {
    if (hasThinkingParam) return [{ id: 'thinking', value: 'false' }];
    if (effortParam && effortValues.has('none')) return [{ id: String(effortParam.id), value: 'none' }];
    return null;
  }
  if (!effortParam) return null;
  const nativeValue = effortValues.has(effort)
    ? effort
    : (effort === 'xhigh' && effortValues.has('extra-high') ? 'extra-high' : '');
  if (!nativeValue) return null;
  return [
    ...(hasThinkingParam ? [{ id: 'thinking', value: 'true' }] : []),
    { id: String(effortParam.id), value: nativeValue },
  ];
}
