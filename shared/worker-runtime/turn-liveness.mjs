// How long a turn may stay quiet, given what its runtime is doing.
//
// Every session worker used to fail a turn after 120 s without traffic from
// its runtime, whatever the runtime was busy with. Silence does not mean the
// same thing in every phase. Measured on the Copilot runtime 1.0.88
// (2026-09-27, scripted provider unless noted):
//
//  - a tool that prints nothing (a 150 s shell command): not one event from
//    `tool.execution_start` to its completion, on a perfectly healthy turn;
//  - a model request (hosted, gpt-5.4-mini): a delta every few seconds while
//    the model reasons (246 s at the highest effort, longest gap 8.8 s) or
//    writes a large tool call (51 KB, longest gap 3.8 s) — and nothing at all
//    while the provider's stream itself is silent, which the runtime waits out
//    without a timeout of its own;
//  - the runtime answers a ping within milliseconds in both cases, so a ping
//    tells a busy runtime from a gone one, not a slow model from a stuck one.
//
// So the window depends on the phase, and the phase comes from the events the
// worker already receives: a tool that has started and not finished, a model
// request that has started and not finished, or neither. This module keeps
// that state and answers one question — has this turn been quiet for too
// long? — so the three workers share the rule instead of each carrying a copy
// of a fixed number. What they do about the answer (cancel the run, stop the
// runtime, publish the failure) stays theirs.

/**
 * `idle`: nothing is in flight, so whatever the runtime does next is its own
 * bookkeeping and should take no time. `model`: far above any gap a healthy
 * stream showed, because failing a turn that was still being written costs the
 * user more than three extra minutes on one that was stuck. `tool`: a build or
 * a test run may print nothing for a long time; the tool's own timeout and the
 * relay's turn ceiling bound it as well.
 *
 * 0 means no limit for that phase; an `idle` of 0 turns the watchdog off.
 */
export const DEFAULT_TURN_STALL_WINDOWS_MS = Object.freeze({
  idle: 120_000,
  model: 300_000,
  tool: 30 * 60_000,
});

export const TURN_STALL_PHASES = Object.freeze(['idle', 'model', 'tool']);

const ENV_BY_PHASE = Object.freeze({
  idle: 'OAR_TURN_STALL_IDLE_MS',
  model: 'OAR_TURN_STALL_MODEL_MS',
  tool: 'OAR_TURN_STALL_TOOL_MS',
});

function readMs(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * The windows a worker runs with: an explicit value wins, then the
 * environment (`OAR_TURN_STALL_{IDLE,MODEL,TOOL}_MS`), then the default.
 *
 * `idleMs` is also what a worker's older single setting maps to. When it is
 * the only thing set, the other two windows keep their proportion to it
 * instead of their absolute defaults: whoever raised the one number to get
 * through long silences must not end up with a model window below it, and a
 * test that shortens it to milliseconds gets all three shortened.
 */
export function resolveTurnStallWindows({ env = process.env, idleMs, modelMs, toolMs } = {}) {
  const explicit = { idle: readMs(idleMs), model: readMs(modelMs), tool: readMs(toolMs) };
  const idle = explicit.idle ?? readMs(env?.[ENV_BY_PHASE.idle]) ?? DEFAULT_TURN_STALL_WINDOWS_MS.idle;
  const scale = idle / DEFAULT_TURN_STALL_WINDOWS_MS.idle;
  const windows = { idle };
  for (const phase of ['model', 'tool']) {
    windows[phase] = explicit[phase]
      ?? readMs(env?.[ENV_BY_PHASE[phase]])
      ?? Math.round(DEFAULT_TURN_STALL_WINDOWS_MS[phase] * scale);
  }
  return windows;
}

const unlimited = (ms) => !(Number(ms) > 0);

/**
 * The liveness state of one turn.
 *
 * `traffic()` is any sign of life from the runtime. `begin`/`end` bracket
 * work in flight, by id, so parallel tool calls and subagents' model
 * requests each count once. `check()` compares the silence with the window
 * of the most tolerant phase that is open.
 */
export function createTurnLiveness({ windows = DEFAULT_TURN_STALL_WINDOWS_MS, now = Date.now } = {}) {
  let lastTrafficAt = now();
  let lastTrafficType = '';
  const open = { model: new Map(), tool: new Map() };

  function phase() {
    let current = 'idle';
    for (const candidate of ['model', 'tool']) {
      if (!open[candidate].size) continue;
      if (current === 'idle') { current = candidate; continue; }
      const held = windows[current];
      const next = windows[candidate];
      if (unlimited(next) || (!unlimited(held) && next > held)) current = candidate;
    }
    return current;
  }

  return {
    traffic(type = '') {
      lastTrafficAt = now();
      lastTrafficType = String(type || '');
    },
    begin(kind, id, label = '') {
      const key = String(id || '').trim();
      if (!open[kind] || !key) return;
      open[kind].set(key, String(label || '').trim());
    },
    end(kind, id) {
      open[kind]?.delete(String(id || '').trim());
    },
    /**
     * Close what one agent had open: its model request (id = the agent) and
     * its tools (ids `<agent>:<call>`). For a subagent that ended.
     */
    endAgent(agent) {
      const key = String(agent || '').trim();
      if (!key) return;
      open.model.delete(key);
      for (const id of [...open.tool.keys()]) {
        if (id.startsWith(`${key}:`)) open.tool.delete(id);
      }
    },
    /** Nothing is in flight any more (the turn's terminator, a new turn). */
    reset() {
      open.model.clear();
      open.tool.clear();
      lastTrafficAt = now();
      lastTrafficType = '';
    },
    phase,
    quietMs: () => Math.max(0, now() - lastTrafficAt),
    /** The labels of the tools in flight, without repeats. */
    toolsInFlight: () => [...new Set([...open.tool.values()].filter(Boolean))],
    /**
     * The tools one agent has in flight (ids `<agent>:<call>`): one label per
     * call, repeats kept, '' for a call without a name. For a caller that
     * has to know what the main agent waits for, whatever its subagents do.
     */
    toolsOf(agent) {
      const key = String(agent || '').trim();
      if (!key) return [];
      const labels = [];
      for (const [id, label] of open.tool) {
        if (id.startsWith(`${key}:`)) labels.push(label);
      }
      return labels;
    },
    /**
     * `stalled` once the silence has reached the window of the current phase;
     * otherwise `waitMs` is when to look again: when the window runs out, but
     * no later than the next multiple of the idle window, which is where a
     * worker with a probe asks its runtime whether it is still there.
     */
    check({ quietMs: measuredQuietMs } = {}) {
      const current = phase();
      const limitMs = Number(windows[current]) || 0;
      // A worker whose transport keeps its own activity clock passes the
      // silence in; the phases are still this module's.
      const quietMs = Number.isFinite(measuredQuietMs)
        ? Math.max(0, measuredQuietMs)
        : Math.max(0, now() - lastTrafficAt);
      const idleMs = unlimited(windows.idle) ? DEFAULT_TURN_STALL_WINDOWS_MS.idle : windows.idle;
      const step = Math.max(1, idleMs - (quietMs % idleMs));
      if (unlimited(limitMs)) return { phase: current, quietMs, limitMs: 0, stalled: false, waitMs: step };
      if (quietMs >= limitMs) return { phase: current, quietMs, limitMs, stalled: true, waitMs: 0 };
      return { phase: current, quietMs, limitMs, stalled: false, waitMs: Math.max(1, Math.min(limitMs - quietMs, step)) };
    },
    /** One line for the worker's log when a turn is failed or kept. */
    describe() {
      const tools = [...open.tool.values()].filter(Boolean);
      return `phase=${phase()} quiet=${Math.round((now() - lastTrafficAt) / 1000)}s`
        + ` last=${lastTrafficType || 'none'} model=${open.model.size} tools=${open.tool.size}`
        + `${tools.length ? ` (${[...new Set(tools)].join(', ')})` : ''}`;
    },
  };
}

/**
 * Ask a runtime whether it is still there. `'alive'` when `probe` resolves in
 * time, `'gone'` when it rejects or does not answer, `'none'` when the worker
 * has no way to ask. Never rejects.
 */
export async function probeRuntime(probe, timeoutMs = 5_000) {
  if (typeof probe !== 'function') return 'none';
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(() => probe()).then((answer) => (answer === false ? 'gone' : 'alive'), () => 'gone'),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('gone'), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const TURN_STALLED_ERROR_CODE = 'turn-stalled';

/**
 * The failure of a turn that was quiet for too long. `unresponsive` marks the
 * other way a turn ends here: the window had not run out, but the runtime no
 * longer answered when asked.
 */
export function createTurnStalledError({
  agentLabel = 'agent', quietMs = 0, phase = 'idle', tools = [], unresponsive = false,
} = {}) {
  const seconds = Math.round((Number(quietMs) || 0) / 1000);
  const error = new Error(
    `${String(agentLabel).toLowerCase()} turn stalled: no traffic for ${seconds}s`
    + ` (phase ${phase}${unresponsive ? ', runtime not answering' : ''})`,
  );
  error.code = TURN_STALLED_ERROR_CODE;
  error.stall = {
    agentLabel, quietSeconds: seconds, phase, tools: [...tools], unresponsive: unresponsive === true,
  };
  return error;
}

export function isTurnStalledError(error) {
  return error?.code === TURN_STALLED_ERROR_CODE && !!error?.stall;
}

/**
 * What the user is told. It names what the runtime was doing, because that
 * is what tells a stuck model request from a tool that hung.
 */
export function describeTurnStall(error) {
  const stall = error?.stall || {};
  const label = String(stall.agentLabel || 'agent');
  const tools = Array.isArray(stall.tools) ? stall.tools.filter(Boolean) : [];
  const doing = stall.phase === 'tool'
    ? ` while a tool was running${tools.length ? ` (${tools.slice(0, 3).join(', ')})` : ''}`
    : stall.phase === 'model' ? ' while a model request was running' : '';
  if (stall.unresponsive) {
    return `System note: the ${label} runtime stopped answering${doing}`
      + ` (nothing for ${stall.quietSeconds}s, no reply when asked), so the relay ended the turn.`;
  }
  return `System note: the ${label} runtime sent nothing for ${stall.quietSeconds}s${doing}, so the relay ended the turn.`;
}
