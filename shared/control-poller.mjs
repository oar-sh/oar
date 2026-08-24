function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll the relay's control API while a turn is in flight, mirroring the
 * Copilot extension's `checkActiveAbortControl` semantics:
 * - `abort_turn`   → invoke `onAbortTurn()` and acknowledge the control.
 * - `abort_subagent` → try `onAbortSubagent(subagentRunId)` when the worker
 *   provides one (the Claude worker can stop a BACKGROUNDED subagent via
 *   `query.stopTask` using the task↔tool_use_id map); otherwise — or when the
 *   handler reports the run unknown — answer "not supported". The full-turn
 *   Stop always works.
 *
 * Provider workers customize the acknowledgement note via `abortAckNote`.
 */
export function createControlPoller({
  api,
  sdkSessionId,
  pollMs = 1200,
  sleep = sleepDefault,
  abortAckNote = 'query aborted',
  onAbortSubagent = null,
  dbg = () => {},
} = {}) {
  let active = null;

  async function checkOnce({ queueMessageId, onAbortTurn }) {
    const ownerSessionId = String(sdkSessionId || '').trim();
    if (!ownerSessionId) return false;
    const pending = await api(
      'GET',
      `/api/control/active?sdkSessionId=${encodeURIComponent(ownerSessionId)}&queueMessageId=${encodeURIComponent(String(queueMessageId || ''))}`,
    ).catch(() => null);
    const control = pending?.control || null;
    const controlType = String(control?.type || '').trim();
    if (!control || !controlType) return false;

    if (controlType === 'abort_subagent') {
      const subagentRunId = String(control.subagentRunId || control.subagent_run_id || '').trim();
      if (typeof onAbortSubagent === 'function' && subagentRunId) {
        try {
          const stopped = await onAbortSubagent(subagentRunId);
          if (stopped) {
            await api('POST', `/api/control/${encodeURIComponent(control.id)}/result`, {
              ok: true,
              note: 'subagent task stopped',
            }).catch(() => {});
            return false;
          }
        } catch (error) {
          dbg('abort_subagent handler failed', error?.message || String(error));
        }
      }
      await api('POST', `/api/control/${encodeURIComponent(control.id)}/result`, {
        ok: false,
        error: 'Targeted subagent cancellation is not supported by this runtime.',
      }).catch(() => {});
      return false;
    }

    if (controlType !== 'abort_turn') return false;

    dbg('abort_turn control received', control.id);
    try {
      await onAbortTurn();
      await api('POST', `/api/control/${encodeURIComponent(control.id)}/result`, {
        ok: true,
        note: abortAckNote,
      }).catch(() => {});
      return true;
    } catch (error) {
      await api('POST', `/api/control/${encodeURIComponent(control.id)}/result`, {
        ok: false,
        error: String(error?.message || error || 'abort failed'),
      }).catch(() => {});
      return false;
    }
  }

  function start({ queueMessageId, onAbortTurn }) {
    stop();
    const state = { stopped: false };
    active = state;
    (async () => {
      while (!state.stopped) {
        await sleep(pollMs);
        if (state.stopped) return;
        try {
          const aborted = await checkOnce({ queueMessageId, onAbortTurn });
          if (aborted) return;
        } catch (error) {
          dbg('control poll failed', error?.message || String(error));
        }
      }
    })();
    return state;
  }

  function stop(handle) {
    // Handle-scoped stop: a caller finishing an old turn must only stop that
    // turn's poller. Without the scoping, a late finalize for a previous
    // context would kill the poller of the turn currently running — leaving
    // its Stop button dead. A bare stop() still stops whatever is active.
    if (handle) {
      handle.stopped = true;
      if (active === handle) active = null;
      return;
    }
    if (active) active.stopped = true;
    active = null;
  }

  return { start, stop, checkOnce };
}
