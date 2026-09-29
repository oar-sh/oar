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
  // The turns a Stop is polled for, oldest first, and whether the one loop
  // that serves them all is running.
  const registrations = new Set();
  let polling = false;

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
      // The control names the row the user stopped. A runner that owns several
      // rows at once (a turn plus the messages steered into it) needs it to
      // tell the stopped row from the ones it must settle itself.
      await onAbortTurn(control);
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

  /**
   * Hand a Stop to the turns that polled for it, newest first, until one of
   * them takes it. The candidates were chosen before the request went out and
   * are not re-checked here: the relay has claimed the control for this worker
   * by now, so a turn that finished meanwhile still has to answer it.
   */
  async function offerAbort(candidates, control) {
    let failure = null;
    for (const registration of candidates) {
      try {
        await registration.onAbortTurn(control);
        return;
      } catch (error) {
        failure = error;
      }
    }
    throw failure || new Error('abort failed');
  }

  async function pollLoop() {
    while (registrations.size) {
      await sleep(pollMs);
      // One request per row filter, however many turns share it, asked in the
      // order of the newest turn that uses it.
      const byFilter = new Map();
      for (const registration of [...registrations].reverse()) {
        const candidates = byFilter.get(registration.queueMessageId) || [];
        candidates.push(registration);
        byFilter.set(registration.queueMessageId, candidates);
      }
      for (const [queueMessageId, candidates] of byFilter) {
        // Every turn behind this filter ended while an earlier one was asked.
        if (candidates.every((registration) => registration.stopped)) continue;
        try {
          await checkOnce({ queueMessageId, onAbortTurn: (control) => offerAbort(candidates, control) });
        } catch (error) {
          dbg('control poll failed', error?.message || String(error));
        }
      }
    }
    polling = false;
  }

  /**
   * Poll for a Stop on behalf of one turn, until `stop(handle)`. Turns overlap
   * (a settled turn still waiting on a question card or publishing, beside the
   * one that runs), so a new registration never displaces an older one, and a
   * handled Stop does not end the polling: the Stop may have been for another
   * turn's row, and the turns that remain still need theirs.
   */
  function start({ queueMessageId, onAbortTurn }) {
    const registration = {
      stopped: false,
      queueMessageId: String(queueMessageId || ''),
      onAbortTurn,
    };
    registrations.add(registration);
    if (!polling) {
      polling = true;
      void pollLoop();
    }
    return registration;
  }

  function stop(handle) {
    // Handle-scoped stop: a caller finishing a turn ends that turn's
    // registration and no other. Without the scoping, a late finalize for a
    // previous context would end the polling for the turn currently running,
    // leaving its Stop button dead. A bare stop() ends every registration (the
    // worker is shutting down).
    if (handle) {
      handle.stopped = true;
      registrations.delete(handle);
      return;
    }
    for (const registration of registrations) registration.stopped = true;
    registrations.clear();
  }

  return { start, stop, checkOnce };
}
