function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll the relay's control API while a turn is in flight, mirroring the
 * Copilot extension's `checkActiveAbortControl` semantics:
 * - `abort_turn`   → invoke `onAbortTurn()` and acknowledge the control.
 * - `abort_subagent` → report "not supported" (the Claude Agent SDK has no
 *   per-subagent cancellation); the full-turn Stop still works.
 */
export function createControlPoller({
  api,
  sdkSessionId,
  pollMs = 1200,
  sleep = sleepDefault,
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
        note: 'claude query aborted',
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

  function stop() {
    if (active) active.stopped = true;
    active = null;
  }

  return { start, stop, checkOnce };
}
