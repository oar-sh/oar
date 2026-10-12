// Tells the relay which run the sub-agent viewer shows, so its record
// arrives live on this page only (`subagent_viewer_watch` / `_unwatch`). The
// viewer waits for the watch's answer before it reads the record: a batch
// sent between the read and the join would otherwise be lost with no later
// hole in `seq` to show it. The relay's rooms may or may not survive a
// reconnect, so the viewer watches again on every connect.

const WATCH_TIMEOUT_MS = 3000;

export function createSubagentViewerWatch({ getSocket, timeoutMs = WATCH_TIMEOUT_MS } = {}) {
  let watched = null;
  // The relay did not know the run yet (a panel row can come before its run
  // row): the next status event of that run asks again.
  let refusedNotFound = false;

  async function watch(conversationId, runId) {
    watched = { conversationId: String(conversationId || ''), runId: String(runId || '') };
    refusedNotFound = false;
    const socket = getSocket?.();
    if (!socket?.connected || !watched.conversationId || !watched.runId) return { ok: false, code: 'offline' };
    let result;
    try {
      result = await socket.timeout(timeoutMs).emitWithAck('subagent_viewer_watch', {
        conversationId: watched.conversationId,
        subagentRunId: watched.runId,
      });
    } catch {
      return { ok: false, code: 'timeout' };
    }
    if (watched?.runId === String(runId || '') && result?.ok !== true && result?.code === 'not-found') refusedNotFound = true;
    return result && typeof result === 'object' ? result : { ok: false, code: 'bad-answer' };
  }

  function unwatch() {
    if (!watched) return;
    watched = null;
    refusedNotFound = false;
    const socket = getSocket?.();
    if (socket?.connected) socket.emit('subagent_viewer_unwatch', {});
  }

  return {
    watch,
    unwatch,
    /** The run the relay should be sending, or null. */
    current: () => (watched ? { ...watched } : null),
    /** True while the relay refused the run on screen as unknown. */
    refused: () => refusedNotFound,
  };
}
