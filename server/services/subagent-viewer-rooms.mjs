'use strict';

// Who receives a sub-agent's record live: only the pages whose viewer shows
// that run. The viewer names its run with `subagent_viewer_watch` (on open,
// on switching to a child or its parent, and after every reconnect) and
// leaves with `subagent_viewer_unwatch`; the relay keeps each socket in at
// most one viewer room. `emitSubagentTimeline` sends volatile to that room,
// so a page without the viewer gets nothing and a connection that cannot take
// a batch drops it — the viewer fetches whatever it misses.

import { sanitizeSubagentRunId } from '../../shared/subagent-run-id.mjs';

const ROOM_PREFIX = 'subagent-viewer:';

export function subagentViewerRoom(runId) {
  return `${ROOM_PREFIX}${String(runId || '')}`;
}

/**
 * Sends a run's record batches to its viewers. socket.io drops a volatile
 * packet whenever the connection is still writing an earlier one, even one
 * sent in the same tick, and a worker post that changes the run's header
 * emits the run's status just before its batch. So batches wait one tick,
 * merged per run (the newest copy of an entry wins), and go out together:
 * dropped only when the connection is really backed up.
 */
export function createSubagentTimelinePublisher(io, { defer = setImmediate } = {}) {
  const pending = new Map();
  let scheduled = false;

  function flush() {
    scheduled = false;
    const batches = [...pending.values()];
    pending.clear();
    for (const batch of batches) {
      const entries = [...batch.entries.values()].sort((a, b) => Number(a.seq) - Number(b.seq));
      try {
        io.to(subagentViewerRoom(batch.subagentRunId)).volatile.emit('subagent_timeline', { ...batch.head, entries });
      } catch {}
    }
  }

  return function publish(payload) {
    const runId = String(payload?.subagentRunId || '');
    if (!runId || !payload?.entries?.length) return;
    let batch = pending.get(runId);
    if (!batch) {
      batch = { subagentRunId: runId, head: null, entries: new Map() };
      pending.set(runId, batch);
    }
    const { entries, ...head } = payload;
    batch.head = { ...head, truncated: !!(batch.head?.truncated || head.truncated) };
    for (const entry of entries) batch.entries.set(Number(entry.seq), entry);
    if (!scheduled) {
      scheduled = true;
      defer(flush);
    }
  };
}

function safeAck(ack, payload) {
  if (typeof ack !== 'function') return;
  try { ack(payload); } catch {}
}

/**
 * `getRun(runId)` returns the run row (`id`, `conversation_id`) or null.
 * Sockets reaching `registerSocket` are already authenticated (the `io.use`
 * gate, and the re-check of recovered sockets in the connection handler).
 */
export function createSubagentViewerRooms({ getRun } = {}) {
  if (typeof getRun !== 'function') throw new Error('createSubagentViewerRooms requires getRun');

  function leave(socket) {
    const current = socket.data?.subagentViewerRoom;
    if (current) socket.leave(current);
    if (socket.data) socket.data.subagentViewerRoom = null;
  }

  function watch(socket, payload) {
    const conversationId = String(payload?.conversationId || '').trim();
    const runId = sanitizeSubagentRunId(payload?.subagentRunId);
    if (!conversationId || !runId) return { ok: false, code: 'missing-id' };
    let run = null;
    try {
      run = getRun(runId);
    } catch {
      return { ok: false, code: 'unavailable' };
    }
    if (!run) return { ok: false, code: 'not-found' };
    if (String(run.conversation_id || '') !== conversationId) return { ok: false, code: 'conversation-mismatch' };
    const room = subagentViewerRoom(runId);
    if (socket.data?.subagentViewerRoom !== room) {
      leave(socket);
      socket.join(room);
      if (socket.data) socket.data.subagentViewerRoom = room;
    } else if (!socket.rooms?.has?.(room)) {
      // A recovered socket keeps its data; its rooms may or may not be back.
      socket.join(room);
    }
    return { ok: true, subagentRunId: runId };
  }

  function registerSocket(socket) {
    if (!socket || typeof socket.on !== 'function') return;
    socket.on('subagent_viewer_watch', (payload, ack) => {
      const result = watch(socket, payload);
      // A refused watch leaves no stale room behind: the page shows another run now.
      if (!result.ok) leave(socket);
      safeAck(ack, result);
    });
    socket.on('subagent_viewer_unwatch', (_payload, ack) => {
      leave(socket);
      safeAck(ack, { ok: true });
    });
  }

  return { registerSocket };
}
