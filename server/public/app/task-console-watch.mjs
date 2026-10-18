// Tells the relay which task's output the console shows, so its new bytes
// arrive live on this page only (`task_output_watch` / `_unwatch`, one room
// per socket). The console waits for the watch's answer before it reads the
// tail: bytes written between the read and the join would otherwise be lost
// until the next gap shows them. The relay's rooms may or may not survive a
// reconnect, so the console watches again on every connect.

const WATCH_TIMEOUT_MS = 3000;

export function createTaskConsoleWatch({ getSocket, timeoutMs = WATCH_TIMEOUT_MS } = {}) {
  let watched = null;

  async function watch(conversationId, taskId) {
    watched = { conversationId: String(conversationId || ''), taskId: String(taskId || '') };
    const socket = getSocket?.();
    if (!socket?.connected || !watched.conversationId || !watched.taskId) return { ok: false, code: 'offline' };
    let result;
    try {
      result = await socket.timeout(timeoutMs).emitWithAck('task_output_watch', {
        conversationId: watched.conversationId,
        taskId: watched.taskId,
      });
    } catch {
      return { ok: false, code: 'timeout' };
    }
    return result && typeof result === 'object' ? result : { ok: false, code: 'bad-answer' };
  }

  function unwatch() {
    if (!watched) return;
    watched = null;
    const socket = getSocket?.();
    if (socket?.connected) socket.emit('task_output_unwatch', {});
  }

  return {
    watch,
    unwatch,
    /** The task the relay should be sending, or null. */
    current: () => (watched ? { ...watched } : null),
  };
}
