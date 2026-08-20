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

export function userReplay(text) {
  return { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } };
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
