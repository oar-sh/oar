// Tells the relay which task's output the console shows, so its new bytes
// arrive live on this page only (`task_output_watch` / `_unwatch`, one room
// per socket). The console waits for the watch's answer before it reads the
// tail: bytes written between the read and the join would otherwise be lost
// until the next gap shows them. The relay's rooms may or may not survive a
// reconnect, so the console watches again on every connect.
//
// Another view of one file per conversation (the worker log) passes its own
// event names and `itemKey: null`: it watches a conversation, not a task.

const WATCH_TIMEOUT_MS = 3000;
const TASK_OUTPUT_WATCH_EVENTS = Object.freeze({ watch: 'task_output_watch', unwatch: 'task_output_unwatch' });

export function createTaskConsoleWatch({
  getSocket,
  timeoutMs = WATCH_TIMEOUT_MS,
  events = TASK_OUTPUT_WATCH_EVENTS,
  itemKey = 'taskId',
} = {}) {
  let watched = null;

  async function watch(conversationId, itemId) {
    watched = { conversationId: String(conversationId || ''), ...(itemKey ? { [itemKey]: String(itemId || '') } : {}) };
    const socket = getSocket?.();
    if (!socket?.connected || !watched.conversationId || (itemKey && !watched[itemKey])) return { ok: false, code: 'offline' };
    let result;
    try {
      result = await socket.timeout(timeoutMs).emitWithAck(events.watch, { ...watched });
    } catch {
      return { ok: false, code: 'timeout' };
    }
    return result && typeof result === 'object' ? result : { ok: false, code: 'bad-answer' };
  }

  function unwatch() {
    if (!watched) return;
    watched = null;
    const socket = getSocket?.();
    if (socket?.connected) socket.emit(events.unwatch, {});
  }

  return {
    watch,
    unwatch,
    /** The task the relay should be sending, or null. */
    current: () => (watched ? { ...watched } : null),
  };
}
