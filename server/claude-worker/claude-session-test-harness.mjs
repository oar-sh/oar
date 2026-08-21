// Shared test harness for the Claude session runner suites
// (claude-session-process.test.mjs and
// claude-session-process.routes-integration.test.mjs): the scripted SDK
// stand-ins, SDK message builders, api stub, and runner factory they both use.
// Not a *.test.mjs file on purpose — the node --test glob must not pick it up.

import { createClaudeSessionRunner } from './claude-session-process.mjs';

// Keeps the tests off the real `~/.claude/projects`; transcript relocation has
// its own suite in claude-transcript-relocator.test.mjs.
export const noopRelocate = () => ({ status: 'skipped' });

export const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate, { timeoutMs = 3000, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`);
    await tick();
  }
}

export function makeApiStub({ failRoutes = new Set(), continuationIds = [] } = {}) {
  const calls = [];
  let continuationCounter = 0;
  return {
    calls,
    api: async (method, routePath, body) => {
      calls.push({ method, routePath, body });
      if (failRoutes.has(routePath)) throw new Error(`stubbed failure for ${routePath}`);
      if (routePath === '/api/continuation-turn') {
        continuationCounter += 1;
        return { messageId: continuationIds[continuationCounter - 1] || `cont-${continuationCounter}` };
      }
      return { ok: true };
    },
  };
}

/**
 * A scriptable stand-in for the SDK Query: the test emits SDK messages when it
 * chooses, the stream only ends on endInput/close (like the real CLI), and
 * pushed user turns are recorded (and optionally echoed back as replays).
 * NOTE: the real CLI replays a pushed message when it DEQUEUES it — between
 * turns for queued-behind messages, or mid-turn when it absorbs the push as
 * steering — never at push time. echoPushes replays at push time, so it only
 * models pushes made while no turn is active; scripts that queue a message
 * behind a running turn must emit the replay manually at the dequeue point.
 */
export function scriptedTurn({ echoPushes = false } = {}) {
  const queued = [];
  let wake = null;
  let ended = false;
  const turn = {
    pushed: [],
    endInputCalls: 0,
    closed: false,
    interrupts: 0,
    stoppedTasks: [],
    pushUserMessage(content) {
      if (ended) throw new Error('user message stream already ended');
      turn.pushed.push(content);
      if (echoPushes) {
        turn.emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content } });
      }
    },
    endInput() {
      turn.endInputCalls += 1;
      ended = true;
      wake?.();
    },
    close() {
      turn.closed = true;
      ended = true;
      wake?.();
    },
    async interrupt() {
      turn.interrupts += 1;
    },
    async stopTask(taskId) {
      turn.stoppedTasks.push(taskId);
    },
    emit(message) {
      queued.push(message);
      wake?.();
    },
    fail(error) {
      queued.push({ __throw: error });
      wake?.();
    },
    async* [Symbol.asyncIterator]() {
      for (;;) {
        while (queued.length) {
          const next = queued.shift();
          if (next?.__throw) throw next.__throw;
          yield next;
        }
        if (ended) return;
        await new Promise((resolve) => { wake = resolve; });
        wake = null;
      }
    },
  };
  return turn;
}

/** Emits the given messages, then the stream ends by itself. */
export function fakeTurn(messages) {
  return {
    pushUserMessage() {},
    endInput() {},
    async* [Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

export function initMessage(sessionId) {
  return { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet-5' };
}

export function resultMessage(text, sessionId) {
  return {
    type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, num_turns: 1, duration_api_ms: 100,
  };
}

export function phantomResultMessage(sessionId) {
  return {
    type: 'result', subtype: 'success', is_error: false, result: '', session_id: sessionId, num_turns: 0, duration_api_ms: 0,
  };
}

export function backgroundTasksMessage(tasks) {
  return { type: 'system', subtype: 'background_tasks_changed', tasks };
}

export function taskNotificationMessage(taskId, status = 'completed', { skipTranscript = false } = {}) {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status,
    summary: 'settled',
    skip_transcript: skipTranscript,
  };
}

/**
 * The live wire shape: snake_case under `compact_metadata`, and `post_tokens`
 * absent on every auto-compact payload observed (conv 563e252e, 2026-08-20).
 */
export function compactBoundaryMessage({ preTokens = 614117, postTokens = null, trigger = 'auto' } = {}) {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: {
      trigger,
      pre_tokens: preTokens,
      ...(postTokens === null ? {} : { post_tokens: postTokens }),
    },
  };
}

/**
 * The CLI's compaction announcement. Emitted ONCE, when compaction starts: the
 * bundle's 30 s re-emit is gated on the remote-control client's activity
 * callback, which the plain SDK `query()` this worker uses never registers.
 */
export function compactingStatusMessage(status = 'compacting') {
  return { type: 'system', subtype: 'status', status };
}

/**
 * The INFERRED shape of what re-opens the turn after an auto-compaction: the
 * CLI's own summary message, which matches no delivered entry's text. Read off
 * the on-disk transcript (`isCompactSummary: true`) plus the runner's observed
 * behaviour in conv 563e252e — not captured from the SDK stream. What the
 * tests actually pin is the runner's response to ANY turn-opening user message
 * that follows a compaction and matches nothing pending.
 */
export function compactSummaryReplay() {
  return userReplay('This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Primary Request…');
}

export function userReplay(text) {
  return { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } };
}

/**
 * A settled task's continuation as the SDK actually stamps it: `origin.kind`
 * carries the provenance (SDKMessageOrigin) and `content` is a plain string,
 * not a block array. Deliberately WITHOUT the `<task-notification>` tag in the
 * text, so anything that passes only by tag-sniffing fails here.
 */
export function taskNotificationReplay(text = 'The background agent has finished its work.') {
  return {
    type: 'user',
    parent_tool_use_id: null,
    origin: { kind: 'task-notification' },
    message: { role: 'user', content: text },
  };
}

export function assistantText(text) {
  return { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } };
}

// Frozen: tests derive per-test messages via spread ({ ...baseMessage, ... }),
// never by mutating this object.
export const baseMessage = Object.freeze({
  id: 'q-1',
  conversationId: 'conv-1',
  relayMode: 'agent',
  text: 'hello',
  model: 'claude-sonnet-5',
  attachments: [],
});

export function makeRunner({ stub, startImpl, ...overrides }) {
  return createClaudeSessionRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeSessionImpl: startImpl,
    continuationRetryDelayMs: 10,
    ...overrides,
  });
}

export async function settled(runner) {
  await waitFor(() => !runner._getProcess(), { label: 'process teardown' });
}
