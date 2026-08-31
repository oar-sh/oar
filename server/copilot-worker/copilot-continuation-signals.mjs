// Pure signal extraction for self-initiated (continuation) turns.
//
// The Copilot runtime can start a turn with nobody asking it to. The shape that
// motivated this module, captured live on 2026-08-31 (session `10a1a9ad`,
// gpt-5.6-luna, "set a timer to 1 minute"):
//
//   user prompt → bash{mode:"async", detach:true} → tool.execution_complete
//                 "<command started in detached background with shellId: 1>"
//               → assistant.message "Timer set for 1 minute…" → session.idle
//   ── the worker settles the row here, correctly ──
//   60s later:  system.notification{kind:{type:"shell_detached_completed", shellId:"1"}}
//               → assistant.turn_start → read_bash{shellId:"1"}
//               → assistant.message "⏰ The 1-minute timer fired." → session.idle
//
// Everything after the notification arrived with **no active turn**, so the
// worker dropped it and the user never saw the reply. Worse, the 10-minute idle
// shutdown would have killed the detached shell outright had the timer been
// longer. This module supplies the three signals the runner needs to fix that,
// with no I/O and no SDK import so they can be unit-tested against real event
// payloads:
//
//  1. `createBackgroundShellTracker` — which detached shells are still live
//     (lifecycle pinning), and when one settles (a continuation is due).
//  2. `isContinuationOpeningEvent` — the runtime has started work of its own.
//  3. `createReplayGate` — the events a `session.resume` replays are history,
//     not new work, and must never open a continuation row.
//
// ## Why detached shells rather than `session.background_tasks_changed`
//
// `BackgroundTasksChangedEvent` exists and fires (~23 times during a single
// bash call), but its `data` is documented as an **empty payload** —
// "indicating background task state changed", with no task list, no id and no
// state. It cannot answer "is anything still running?", which is the only
// question lifecycle pinning has. The typed, id-carrying signals are the shell
// ones, so those are what this tracks:
//
//  - opened: a `bash` `tool.execution_complete` whose telemetry says
//    `detached: "true"` and/or whose result text names the new shell id;
//  - settled: `system.notification` with a `shell_detached_completed` /
//    `shell_completed` `kind` — a discriminated union carrying `shellId`;
//  - closed by hand: a `read_bash` result reporting the exit code, or a
//    successful `stop_bash`.
//
// The set is a best-effort superset-free view: a shell this module never learns
// about simply is not pinned (the old behaviour), and a shell it never learns
// the end of is released by the runner's cap. Neither can wedge a turn.

/** `system.notification` kinds that mean "a shell this session started is done". */
export const SHELL_SETTLED_NOTIFICATION_KINDS = Object.freeze([
  'shell_detached_completed',
  'shell_completed',
]);

/** Tools that address an already-running shell by id. */
export const SHELL_HANDLE_TOOLS = Object.freeze(['read_bash', 'write_bash', 'stop_bash']);

// `<command started in detached background with shellId: 1>`
const SHELL_OPENED_RE = /detached\s+(?:background|command)[^<>]*?shellId:\s*([^\s>,]+)/i;
// `<detached command with shellId: 1 completed with exit code 0>`
const SHELL_EXITED_RE = /shellId:\s*([^\s>,]+)[^<>]*?completed with exit code/i;

/** Cap on the toolCallId → shell bookkeeping, so a long session cannot grow it forever. */
const TOOL_CALL_MEMORY = 200;

function eventData(event) {
  return event && typeof event.data === 'object' && event.data ? event.data : {};
}

function toolResultText(data) {
  const result = data?.result;
  if (!result || typeof result !== 'object') return '';
  return `${String(result.content || '')}\n${String(result.detailedContent || '')}`;
}

function normalizeShellId(value) {
  const id = String(value ?? '').trim();
  return id && id !== 'undefined' && id !== 'null' ? id : '';
}

/**
 * The events that mean "the runtime has started doing something".
 *
 * An allowlist, not a denylist: the SDK event set grows between CLI releases
 * (a live probe already found an undocumented `subagent.configured`), and the
 * cost of the two directions is not symmetric. A missing opener costs one
 * dropped continuation — today's behaviour. A spurious opener creates a
 * synthetic queue row for a housekeeping event and leaves it open until the
 * stall watchdog fails it, in the user's transcript.
 *
 * `session.idle` / `session.error` are deliberately absent: they terminate
 * turns, and a stray terminator arriving with no turn must stay a no-op rather
 * than open a row it would immediately close. So are `session.start`,
 * `session.resume`, `session.shutdown`, `session.background_tasks_changed`,
 * `pending_messages.modified`, `capabilities.changed` and the `model.*` family,
 * which is all connection bookkeeping.
 */
export const CONTINUATION_OPENING_EVENT_TYPES = Object.freeze([
  // The runtime picked up a prompt on its own (a resume with
  // `continuePendingWork`, or a prompt queued inside the runtime that outlived
  // the interaction it was sent into).
  'user.message',
  'assistant.turn_start',
  'assistant.message_start',
  'assistant.message_delta',
  'assistant.message',
  'assistant.reasoning',
  'assistant.reasoning_delta',
  'assistant.intent',
  'tool.execution_start',
  'tool.user_requested',
  'permission.requested',
  'user_input.requested',
  'elicitation.requested',
  'exit_plan_mode.requested',
  'subagent.started',
  'skill.invoked',
]);

const OPENING_TYPES = new Set(CONTINUATION_OPENING_EVENT_TYPES);

export function isContinuationOpeningEvent(event) {
  return OPENING_TYPES.has(String(event?.type || ''));
}

/**
 * Suppress the historical events a `session.resume` replays through the live
 * event callback.
 *
 * `ResumeData` gives both halves of the discriminator, and they are used
 * together because either alone is unsafe:
 *
 *  - `resumeTime` — "ISO 8601 timestamp when the session was resumed". A
 *    persisted event carries its ORIGINAL `timestamp` (verified against a real
 *    `events.jsonl`), so anything older than `resumeTime` is history. Alone,
 *    this would suppress forever if the runtime ever emitted a stale timestamp.
 *  - `eventCount` — "Total number of persisted events in the session at the
 *    time of resume". That is an exact ceiling on how many events a replay can
 *    produce. Alone, a count is fragile: ephemeral events interleave with the
 *    replay (the resume fixture has 20+ of them in the first second), and
 *    miscounting by one would eat a live event or admit a replayed one.
 *
 * So: suppress events older than `resumeTime`, at most `eventCount` of them,
 * and disarm at the first event that is not older — the replay is contiguous
 * and precedes live traffic, so the first live event proves it is over.
 *
 * A resume with no `resumeTime`, or `eventCount: 0`, arms nothing at all: a
 * fresh session has no history to replay, and guessing would be worse than the
 * status quo.
 */
export function createReplayGate() {
  let window = null;

  function arm(event) {
    const data = eventData(event);
    const resumeTime = Date.parse(String(data.resumeTime || ''));
    const eventCount = Number(data.eventCount);
    if (!Number.isFinite(resumeTime) || !Number.isFinite(eventCount) || eventCount <= 0) {
      window = null;
      return;
    }
    window = { resumeTime, remaining: Math.floor(eventCount) };
  }

  /** True when `event` is a replayed historical event and must be dropped. */
  function isReplay(event) {
    if (String(event?.type || '') === 'session.resume') {
      // The resume event itself is live — it is the thing that arms the window.
      arm(event);
      return false;
    }
    if (!window) return false;
    const timestamp = Date.parse(String(event?.timestamp || ''));
    if (!Number.isFinite(timestamp)) return false;
    if (timestamp >= window.resumeTime) {
      window = null;
      return false;
    }
    window.remaining -= 1;
    if (window.remaining <= 0) window = null;
    return true;
  }

  return {
    isReplay,
    reset: () => { window = null; },
    /** Test seam: whether a replay window is currently open. */
    armed: () => !!window,
  };
}

/**
 * Track the detached shells this session has running.
 *
 * `observe(event)` returns what the event changed, so the caller can pin the
 * runtime's lifecycle and note that a continuation is due without re-parsing.
 */
export function createBackgroundShellTracker({ now = () => Date.now() } = {}) {
  const shells = new Map(); // shellId -> { shellId, description, startedAt }
  const toolCalls = new Map(); // toolCallId -> { toolName, shellId, description }

  function rememberToolCall(toolCallId, entry) {
    if (!toolCallId) return;
    toolCalls.set(toolCallId, entry);
    // Bounded: a long conversation makes thousands of tool calls and only the
    // most recent handful are ever looked up.
    while (toolCalls.size > TOOL_CALL_MEMORY) {
      const oldest = toolCalls.keys().next().value;
      toolCalls.delete(oldest);
    }
  }

  function open(shellId, description) {
    const id = normalizeShellId(shellId);
    if (!id || shells.has(id)) return null;
    const shell = { shellId: id, description: String(description || '').trim(), startedAt: now() };
    shells.set(id, shell);
    return shell;
  }

  function close(shellId) {
    const id = normalizeShellId(shellId);
    if (!id) return null;
    const shell = shells.get(id) || null;
    shells.delete(id);
    // A shell can settle before this tracker ever saw it open (the worker
    // reconnected mid-flight); report the id anyway so the caller still knows a
    // continuation is due.
    return shell || { shellId: id, description: '', startedAt: 0 };
  }

  /**
   * `heralded` is true only for the `system.notification` path.
   *
   * That notification is the runtime telling ITSELF a shell finished, and it is
   * what makes it re-invoke the model — so it, and only it, means "a
   * continuation is imminent". A `read_bash` that reports an exit code closes
   * the same shell, but it happens INSIDE a turn that already knows: treating
   * it as a herald would hold the runtime open for the grace window after every
   * ordinary background command.
   */
  function observe(event) {
    const type = String(event?.type || '');
    const data = eventData(event);
    const opened = [];
    const settled = [];
    let heralded = false;

    if (type === 'tool.execution_start') {
      const toolCallId = String(data.toolCallId || '').trim();
      const toolName = String(data.toolName || '').trim();
      const args = data.arguments && typeof data.arguments === 'object' ? data.arguments : {};
      rememberToolCall(toolCallId, {
        toolName,
        shellId: normalizeShellId(args.shellId),
        description: String(args.description || '').trim(),
      });
      return { opened, settled, heralded };
    }

    if (type === 'tool.execution_complete') {
      const toolCallId = String(data.toolCallId || '').trim();
      const call = toolCalls.get(toolCallId) || null;
      toolCalls.delete(toolCallId);
      const text = toolResultText(data);
      const detached = String(data.toolTelemetry?.properties?.detached || '') === 'true';

      // The exit report wins over the open report: a `read_bash` whose result
      // says the command exited is a close, even though its text also matches
      // the "detached … shellId" shape.
      const exited = SHELL_EXITED_RE.exec(text);
      if (exited) {
        const shell = close(exited[1]);
        if (shell) settled.push(shell);
        return { opened, settled, heralded };
      }

      if (call?.toolName === 'stop_bash' && data.success !== false) {
        const shell = close(call.shellId);
        if (shell) settled.push(shell);
        return { opened, settled, heralded };
      }

      const started = SHELL_OPENED_RE.exec(text);
      if (started && data.success !== false) {
        const shell = open(started[1], call?.description);
        if (shell) opened.push(shell);
        return { opened, settled, heralded };
      }
      // Telemetry says detached but the result text named no id — nothing to
      // key on, so it is deliberately not tracked rather than tracked wrongly.
      return { opened, settled, heralded };
    }

    if (type === 'system.notification') {
      const kind = data.kind && typeof data.kind === 'object' ? data.kind : {};
      if (!SHELL_SETTLED_NOTIFICATION_KINDS.includes(String(kind.type || ''))) {
        return { opened, settled, heralded };
      }
      // The runtime is about to re-invoke the model off the back of this.
      heralded = true;
      const shell = close(kind.shellId);
      if (shell) {
        settled.push({
          ...shell,
          description: shell.description || String(kind.description || '').trim(),
        });
      }
      return { opened, settled, heralded };
    }

    return { opened, settled, heralded };
  }

  return {
    observe,
    size: () => shells.size,
    live: () => [...shells.values()],
    /**
     * Drop every shell that has been running longer than `capMs`, so a forgotten
     * background command cannot pin the runtime forever. Returns what it forgot.
     */
    expireOlderThan(capMs) {
      if (!(capMs > 0)) return [];
      const deadline = now() - capMs;
      const expired = [];
      for (const shell of [...shells.values()]) {
        if (shell.startedAt <= deadline) {
          shells.delete(shell.shellId);
          expired.push(shell);
        }
      }
      return expired;
    },
    reset() {
      shells.clear();
      toolCalls.clear();
    },
  };
}

/** A one-line transcript note for a settled shell, posted into its continuation. */
export function describeSettledShell(shell) {
  const id = normalizeShellId(shell?.shellId);
  const description = String(shell?.description || '').trim();
  if (!id) return '';
  return description
    ? `Background shell ${id} finished: ${description}`
    : `Background shell ${id} finished`;
}
