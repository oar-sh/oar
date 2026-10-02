// Shared test harness for the Claude Cloud worker suites: a scripted cloud
// client, a recording relay api, hand-fired timers and cloud event builders.
// Not a *.test.mjs file on purpose — the node --test glob must not pick it up.
//
// Every id, URL and name in here is invented.

import { createClaudeCloudSessionRunner } from './claude-cloud-session-process.mjs';

export const CONVERSATION_ID = 'conversation-example-1';
export const SESSION_ID = 'cse_01EXAMPLEaaaaaaaaaaaaaaaa';
export const SESSION_URL = 'https://claude.ai/code/example-session';
export const ENVIRONMENT_ID = 'env_01EXAMPLEbbbbbbbbbbbbbbbb';
export const REPO_URL = 'https://github.com/example-org/sample-repo';
export const MODEL = 'claude-sonnet-5-5';

export const tick = (ms = 2) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate, label = 'condition', timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`);
    await tick();
  }
}

/**
 * The relay api: records every call. `routeResponses` maps a route to its
 * answer, or to a function of `(body, callIndexForThatRoute)` that returns it
 * or throws.
 */
export function makeApi(routeResponses = {}) {
  const calls = [];
  const counts = new Map();
  const api = async (method, routePath, body) => {
    calls.push({ method, routePath, body });
    const attempt = counts.get(routePath) || 0;
    counts.set(routePath, attempt + 1);
    const canned = routeResponses[routePath];
    if (typeof canned === 'function') return canned(body, attempt);
    if (canned !== undefined) return canned;
    return { ok: true };
  };
  return {
    api,
    calls,
    posts: (routePath) => calls
      .filter((call) => call.method === 'POST' && call.routePath === routePath)
      .map((call) => call.body),
  };
}

export function cloudSession({ workerStatus = 'idle', costUsd = 0.42 } = {}) {
  return {
    id: SESSION_ID,
    status: 'active',
    worker_status: workerStatus,
    session_url: SESSION_URL,
    environment_id: ENVIRONMENT_ID,
    external_metadata: {
      context_usage: { used_tokens: 60_000, max_tokens: 1_000_000 },
      usage: { cost_usd: costUsd, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 40 },
      last_served_model: MODEL,
    },
  };
}

/**
 * A scripted stand-in for the client of shared/claude-cloud/api-client.mjs.
 * Every `openEventStream` call becomes an entry of `streams` that the test
 * drives: `emit(...events)` hands over client events, `drop(reason)` ends the
 * stream the way the real client reports it (it resolves; it throws only
 * when the stream cannot be opened — queue such an error in `openErrors`).
 */
export function makeCloud({
  sendSequences = [],
  listPages = [],
  session = cloudSession(),
  failures = {},
} = {}) {
  const calls = [];
  const streams = [];
  const openErrors = [];
  const record = (op, detail = {}) => {
    calls.push({ op, ...detail });
    if (failures[op]) throw failures[op];
  };
  return {
    calls,
    streams,
    openErrors,
    callsOf: (op) => calls.filter((call) => call.op === op),
    async createSession(args) {
      record('createSession', { args });
      return { id: SESSION_ID, sessionUrl: SESSION_URL, deduplicated: false };
    },
    async sendUserMessage(id, content, options) {
      record('sendUserMessage', { id, content, options });
      return { eventId: options?.uuid || null, sequence: String(sendSequences.shift()), duplicate: false };
    },
    async sendControlResponse(id, args) {
      record('sendControlResponse', { id, args });
      return { eventId: null, sequence: null, duplicate: false };
    },
    async sendInterrupt(id) {
      record('sendInterrupt', { id });
      return { requestId: 'interrupt-request-1' };
    },
    async getSession(id) {
      record('getSession', { id });
      return typeof session === 'function' ? session() : session;
    },
    async listEvents(id, options) {
      record('listEvents', { id, options });
      return listPages.shift() || { events: [], nextCursor: null };
    },
    async openEventStream(id, options) {
      calls.push({ op: 'openEventStream', id, lastEventId: options.lastEventId, idleTimeoutMs: options.idleTimeoutMs });
      const error = openErrors.shift();
      if (error) throw error;
      return new Promise((resolve) => {
        const connection = {
          lastEventId: options.lastEventId,
          closed: false,
          aborted: false,
          emit(...events) {
            for (const event of events) options.onEvent({ kind: 'client_event', id: event.sequence_num, data: event });
          },
          frame(frame) {
            options.onEvent(frame);
          },
          drop(reason = 'ended') {
            connection.closed = true;
            resolve({ reason, lastEventId: null, error: null });
          },
        };
        options.signal?.addEventListener('abort', () => {
          connection.closed = true;
          connection.aborted = true;
          resolve({ reason: 'aborted', lastEventId: null, error: null });
        }, { once: true });
        streams.push(connection);
        options.onOpen?.();
      });
    },
  };
}

/** Timers that only run when the test fires them, by their delay. */
export function makeTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutImpl(fn, ms) {
      const timer = { fn, ms, cleared: false, fired: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) {
      if (timer) timer.cleared = true;
    },
    pending: (ms) => timers.filter((timer) => timer.ms === ms && !timer.cleared && !timer.fired),
    fire(ms) {
      const due = timers.filter((timer) => timer.ms === ms && !timer.cleared && !timer.fired);
      for (const timer of due) {
        timer.fired = true;
        timer.fn();
      }
      return due.length;
    },
  };
}

/** The control poller's seam: the test presses Stop through `abort()`. */
export function makeControlPoller() {
  const poller = {
    registrations: [],
    stopped: [],
    start(registration) {
      poller.registrations.push(registration);
      return registration;
    },
    stop(handle) {
      poller.stopped.push(handle);
    },
    abort: () => poller.registrations.at(-1).onAbortTurn({ id: 'control-1', type: 'abort_turn' }),
  };
  return poller;
}

export function makeRunner({ api, cloud, ...overrides } = {}) {
  const timers = makeTimers();
  const control = makeControlPoller();
  const sleeps = [];
  const runner = createClaudeCloudSessionRunner({
    api: api.api,
    cloud,
    sdkSessionId: CONVERSATION_ID,
    defaultModel: `${MODEL}[1m]`,
    controlPoller: control,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
      await tick();
    },
    askUserBridgeOptions: { questionPollMs: 1 },
    ...overrides,
  });
  return { runner, timers, control, sleeps };
}

export function relayMessage(overrides = {}) {
  return {
    id: 'queue-message-1',
    attemptId: 'attempt-1',
    conversationId: CONVERSATION_ID,
    text: 'Add a licence file',
    relayMode: 'agent',
    model: MODEL,
    ...overrides,
    claudeCloud: {
      sessionId: null,
      lastSequence: null,
      repoUrl: REPO_URL,
      branch: 'main',
      environmentId: ENVIRONMENT_ID,
      title: 'Licence file',
      ...(overrides.claudeCloud || {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Cloud events

export function cloudEvent(sequence, payload, source = 'worker') {
  return {
    event_id: payload.uuid || `event-${sequence}`,
    sequence_num: String(sequence),
    event_type: payload.type,
    source,
    payload,
    created_at: '2026-01-01T00:00:00Z',
  };
}

export const userPrompt = (sequence, text, uuid = `prompt-${sequence}`) => cloudEvent(sequence, {
  type: 'user', uuid, session_id: SESSION_ID, parent_tool_use_id: null, message: { role: 'user', content: text },
}, 'client');

export const sandboxLog = (sequence, content, stepStatus = 'started', level = 'info') => cloudEvent(sequence, {
  type: 'env_manager_log',
  data: { category: 'init', content, level, extra: stepStatus ? { step_id: 'step', step_status: stepStatus } : {} },
});

export const sessionInit = (sequence, model = MODEL) => cloudEvent(sequence, {
  type: 'system', subtype: 'init', model, session_id: SESSION_ID,
});

function assistant(sequence, block, parentToolUseId = null) {
  return cloudEvent(sequence, {
    type: 'assistant',
    session_id: SESSION_ID,
    parent_tool_use_id: parentToolUseId,
    message: { id: `msg_example_${sequence}`, role: 'assistant', content: [block] },
  });
}

export const assistantText = (sequence, text) => assistant(sequence, { type: 'text', text });
export const assistantThinking = (sequence, thinking) => assistant(sequence, { type: 'thinking', thinking });
export const assistantToolUse = (sequence, name, input, id = `toolu_example_${sequence}`) => (
  assistant(sequence, { type: 'tool_use', id, name, input })
);

export const toolResult = (sequence, toolUseId, { isError = false, content = 'ok' } = {}) => cloudEvent(sequence, {
  type: 'user',
  session_id: SESSION_ID,
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }] },
});

export const branchPushed = (sequence, branch) => cloudEvent(sequence, {
  type: 'system', subtype: 'vcs_state_changed', kind: 'push', branch, cwd: '/home/dev/sample-repo', session_id: SESSION_ID,
});

export const toolRequest = (sequence, { requestId, toolName, input, source = 'worker' }) => cloudEvent(sequence, {
  type: 'control_request',
  request_id: requestId,
  request: {
    subtype: 'can_use_tool',
    tool_name: toolName,
    display_name: toolName,
    input,
    tool_use_id: `toolu_example_${sequence}`,
    requires_user_interaction: true,
  },
}, source);

export const toolResponse = (sequence, requestId, source = 'client') => cloudEvent(sequence, {
  type: 'control_response',
  response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: {} } },
}, source);

export const turnResult = (sequence, fields = {}) => cloudEvent(sequence, {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 2,
  duration_ms: 4000,
  duration_api_ms: 3000,
  total_cost_usd: 0.05,
  stop_reason: 'end_turn',
  terminal_reason: 'completed',
  modelUsage: { [MODEL]: { inputTokens: 10, outputTokens: 20, contextWindow: 1_000_000, costUSD: 0.05 } },
  session_id: SESSION_ID,
  ...fields,
});

/** The `result` of a turn the user stopped: an error result that carries no text. */
export const stoppedResult = (sequence) => {
  const event = turnResult(sequence, {
    subtype: 'error_during_execution',
    is_error: true,
    stop_reason: 'tool_use',
    terminal_reason: 'aborted_tools',
    errors: ['The turn was interrupted.'],
  });
  delete event.payload.result;
  return event;
};
