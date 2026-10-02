// The provider-facing side of the `remote_relay` tool, in one place.
//
// Every adapter (Claude's in-process MCP server, Cursor's customTools, the
// Copilot SDK engine's session tools, and the OAR stdio MCP server that Grok
// and the Copilot extension engine reach) registers the SAME name, description
// and schema from the contract and forwards every call to the one local relay
// endpoint. The relay does the gating, the approval, the forwarding and the
// waiting; nothing here knows about remote relays beyond the wire shape.
//
// SDK-free and dependency-injected, following preview-tool-core.mjs: all relay
// traffic goes through the worker's injected `api(method, path, body, options)`
// helper (shared/worker-runtime/api-client.mjs).

import {
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_TOOL_DESCRIPTION,
  REMOTE_RELAY_TOOL_ENDPOINT,
  REMOTE_RELAY_TOOL_INPUT_SCHEMA,
  REMOTE_RELAY_TOOL_NAME,
  summarizeRemoteRelayCall,
  validateRemoteRelayToolInput,
} from './remote-relay-contract.mjs';

export {
  REMOTE_RELAY_TOOL_DESCRIPTION,
  REMOTE_RELAY_TOOL_ENDPOINT,
  REMOTE_RELAY_TOOL_INPUT_SCHEMA,
  REMOTE_RELAY_TOOL_NAME,
  summarizeRemoteRelayCall,
};

// The adapters' crisp early check; the relay validates again authoritatively.
export const validateRemoteRelayTool = validateRemoteRelayToolInput;

/**
 * A private deep copy of the contract schema for SDKs that take ownership of
 * the object they are handed (the contract's is frozen at the top level, and
 * an SDK that annotates its input would throw on it).
 */
export function cloneRemoteRelayToolInputSchema() {
  return JSON.parse(JSON.stringify(REMOTE_RELAY_TOOL_INPUT_SCHEMA));
}

// How many remotes this relay knows and whether its own sessions are open to
// agents (`{ count, localEnabled }`): the registration decision.
export const REMOTE_RELAY_SUMMARY_PATH = '/api/remote-relays/summary';
// Calls of one conversation the relay is still working on (`{ inflight }`):
// the Grok inactivity hold, which cannot see the tool call itself.
export const REMOTE_RELAY_INFLIGHT_PATH = '/api/remote-relays/inflight';

// The local relay could not be asked at all, or answered without a body the
// model could read (a transport error, a crash page). Distinct from every
// contract code, which describe a refusal the relay itself made.
export const REMOTE_RELAY_CALL_FAILED = 'REMOTE_RELAY_CALL_FAILED';

// The provider cancelled the call (the user's Stop, a host's cancel, a
// runtime going away) before the relay answered. The relay sees the request
// close and stops too: it withdraws an open approval card and stops waiting
// on the remote. A prompt already handed over is NOT taken back.
export const REMOTE_RELAY_CANCELLED = 'REMOTE_RELAY_CANCELLED';

// How long the registration probe may take before the tool is left out.
export const REMOTE_RELAY_DECISION_TIMEOUT_MS = 5_000;

// A hard ceiling for one tool call on the providers that impose their own
// (MCP clients). The relay already bounds the wait (wait_seconds up to its
// "longest wait" setting, at most an hour) but not the time an approval card
// may sit unanswered, so this only has to outlast a human, never a turn.
export const REMOTE_RELAY_TOOL_CALL_TIMEOUT_MS = 8 * 60 * 60_000;

function toText(value) {
  return String(value ?? '').trim();
}

function withTimeout(promise, timeoutMs, label) {
  if (!(Number(timeoutMs) > 0)) return promise;
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

function errorBodyOf(error) {
  // `body` is the parsed JSON error body when the api client kept it; a
  // client that parsed it into `detail` instead is tolerated too.
  for (const candidate of [error?.body, error?.detail]) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
  }
  return null;
}

/**
 * Maps an api-client failure onto the result shape the model reads. The relay
 * answers a refusal with `{ ok:false, code, error }` and a 4xx/5xx status; that
 * body IS the answer (LOCKED, FORBIDDEN, OFFLINE, …), so it is passed through
 * as-is. Anything without such a body becomes REMOTE_RELAY_CALL_FAILED.
 */
export function remoteRelayErrorResult(error) {
  const status = Number(error?.status) || 0;
  const body = errorBodyOf(error);
  const detail = typeof error?.detail === 'string' ? toText(error.detail) : '';
  if (body && (body.code || body.error)) {
    return {
      ...body,
      ok: false,
      code: toText(body.code) || REMOTE_RELAY_CALL_FAILED,
      error: toText(body.error || body.message) || detail || `HTTP ${status}`,
    };
  }
  if (status === 404) {
    // A relay that predates the feature (or runs without its routes).
    return {
      ok: false,
      code: REMOTE_RELAY_ERROR_CODES.unsupported,
      error: 'This relay does not offer remote relays (the tool endpoint is missing). Tell the user.',
    };
  }
  return {
    ok: false,
    code: REMOTE_RELAY_CALL_FAILED,
    ...(status ? { status } : {}),
    error: detail || toText(error?.message || error) || 'The relay could not be reached',
  };
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

/** The answer for a call its provider cancelled before the relay answered. */
export function remoteRelayCancelledResult() {
  return {
    ok: false,
    code: REMOTE_RELAY_CANCELLED,
    error: 'The call was cancelled before the relay answered. A message it had already handed over may still run on the remote.',
  };
}

/**
 * Executes one `remote_relay` call: validate, then forward
 * `{ conversationId, action, args }` to the local relay and hand back its JSON.
 * Never throws — a refusal reads as an answer the model can act on, the same
 * contract as executePreviewTool.
 *
 * The call goes out as a long call (`{ longCall: true }`): no client-side
 * timeout at all, because the relay bounds the wait itself (wait_seconds,
 * cut to the relay's own maximum, plus approval time) and fetch's 300 s
 * header limit would cut both short.
 * `signal` (the provider's cancellation) is the only way to end it early.
 */
export async function executeRemoteRelayTool(input, { api, conversationId = '', signal = null } = {}) {
  if (typeof api !== 'function') {
    return { ok: false, code: REMOTE_RELAY_CALL_FAILED, error: 'Remote relay API unavailable in this worker' };
  }
  const conversation = toText(conversationId);
  if (!conversation) {
    return { ok: false, code: REMOTE_RELAY_CALL_FAILED, error: 'No conversation is bound to this call' };
  }
  const parsed = validateRemoteRelayToolInput(input);
  if (!parsed.ok) return parsed;
  if (signal?.aborted) return remoteRelayCancelledResult();
  try {
    const response = await api('POST', REMOTE_RELAY_TOOL_ENDPOINT, {
      conversationId: conversation,
      action: parsed.action,
      args: parsed.args,
    }, { longCall: true, ...(signal ? { signal } : {}) });
    if (response && typeof response === 'object' && !Array.isArray(response)) return response;
    return { ok: true, result: response ?? null };
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) return remoteRelayCancelledResult();
    return remoteRelayErrorResult(error);
  }
}

/**
 * Whether a worker should register the tool: at least one remote is paired,
 * or this relay lets agents start and use sessions on it (the local target).
 * Fails closed — any error, a malformed answer or a slow relay leaves the tool
 * out, and the next worker start asks again.
 */
export async function shouldRegisterRemoteRelayTool({ api, timeoutMs = REMOTE_RELAY_DECISION_TIMEOUT_MS } = {}) {
  if (typeof api !== 'function') return false;
  try {
    const response = await withTimeout(
      Promise.resolve().then(() => api('GET', REMOTE_RELAY_SUMMARY_PATH)),
      timeoutMs,
      'remote relay summary',
    );
    return Number(response?.count) > 0 || response?.localEnabled === true;
  } catch {
    return false;
  }
}

/**
 * The registration decision as a worker holds it: asked once when the worker
 * starts (`refresh()`), read synchronously where a tool set is fixed
 * (`isEnabled()`), and awaitable where the first build may wait for it
 * (`ready()`, which never rejects). `fixed` pins the answer (tests, kill
 * switches) without asking the relay.
 */
export function createRemoteRelayToolGate({
  api,
  fixed = undefined,
  decide = shouldRegisterRemoteRelayTool,
  timeoutMs = REMOTE_RELAY_DECISION_TIMEOUT_MS,
} = {}) {
  if (typeof fixed === 'boolean') {
    return {
      isEnabled: () => fixed,
      isSettled: () => true,
      refresh: () => Promise.resolve(fixed),
      ready: () => Promise.resolve(fixed),
    };
  }
  let enabled = false;
  let settledOnce = false;
  let pending = null;
  function refresh() {
    if (!pending) {
      pending = Promise.resolve()
        .then(() => decide({ api, timeoutMs }))
        .then((value) => { enabled = value === true; }, () => { enabled = false; })
        .then(() => {
          settledOnce = true;
          pending = null;
          return enabled;
        });
    }
    return pending;
  }
  return {
    isEnabled: () => enabled,
    // True once an answer is in and no refresh is running: a caller can then
    // read isEnabled() without awaiting ready().
    isSettled: () => settledOnce && !pending,
    refresh,
    ready: () => (settledOnce && !pending ? Promise.resolve(enabled) : (pending || refresh())),
  };
}

/**
 * How many remote_relay calls of this conversation the relay is still working
 * on. 0 on any failure: the caller's watchdog then does what it would have
 * done without the question.
 */
export async function fetchRemoteRelayInflight({ api, conversationId = '', timeoutMs = 10_000 } = {}) {
  const conversation = toText(conversationId);
  if (typeof api !== 'function' || !conversation) return 0;
  try {
    const response = await withTimeout(
      Promise.resolve().then(() => api(
        'GET',
        `${REMOTE_RELAY_INFLIGHT_PATH}?conversationId=${encodeURIComponent(conversation)}`,
      )),
      timeoutMs,
      'remote relay inflight',
    );
    const count = Number(response?.inflight);
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

/** The text every adapter hands the model: the relay's JSON, pretty-printed. */
export function formatRemoteRelayToolResult(result) {
  try {
    const text = JSON.stringify(result ?? null, null, 2);
    return text === undefined ? 'null' : text;
  } catch {
    return String(result);
  }
}

// ─── Activity lines ──────────────────────────────────────────────────────────

// A provider may report the tool under its bare name or namespaced by the MCP
// server that carries it (`mcp__relay__remote_relay`, `oar__remote_relay`,
// `oar/remote_relay`, `oar-remote_relay`); all of them are this tool.
const REMOTE_RELAY_NAME_PATTERN = new RegExp(`(?:^|__|[^A-Za-z0-9_])${REMOTE_RELAY_TOOL_NAME}$`, 'i');

export function isRemoteRelayToolName(name) {
  return REMOTE_RELAY_NAME_PATTERN.test(toText(name));
}

/**
 * The arguments of a tool call as an object, whether the provider delivered
 * them parsed or as a JSON string. Null when there is nothing usable.
 */
export function remoteRelayCallInput(rawInput) {
  let input = rawInput;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  return input && typeof input === 'object' && !Array.isArray(input) ? input : null;
}

/**
 * The summary part of the activity line (`send → linux-test session 01234567:
 * “…”`), or '' when the call carries no action yet (a streaming frame before
 * its arguments arrived) so the caller keeps its generic line.
 */
export function remoteRelayActivitySummary(rawInput) {
  const input = remoteRelayCallInput(rawInput);
  if (!input || !toText(input.action)) return '';
  return summarizeRemoteRelayCall(input);
}
