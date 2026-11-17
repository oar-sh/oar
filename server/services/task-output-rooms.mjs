'use strict';

// Who receives a background task's output live: the pages whose console
// shows that task. The console joins with `task_output_watch { conversationId,
// taskId, offset }` (on open and after every reconnect) and leaves with
// `task_output_unwatch`; a socket is in at most one task room. While a room
// has members the relay stats the task's file every second and sends what
// was appended as `task_output_chunk { conversationId, taskId, offset,
// endOffset, text, size, mtime, ended }` (at most 64 KB per emit, cleaned like
// every other read). A page whose next expected offset is not `offset`
// fetches the tail again; a file that shrank is sent as an empty chunk with
// `reset: true`. Nobody watching costs nothing: the room's poller stops when
// it empties.
//
// A second instance serves another file per conversation (the worker log):
// its own room prefix, event names and `socket.data` key, so a page may
// watch a task and that file at once, and a `resolveSource` in place of
// `resolveTask`. With `itemKey: null` a room is one per conversation and the
// payloads carry no item id.

import { TASK_OUTPUT_LIMITS } from '../../shared/task-output-text.mjs';
import { inspectOutputFile, readRange, taskOutputSource } from './task-output-service.mjs';

const ROOM_PREFIX = 'task-output:';
export const TASK_OUTPUT_EVENTS = Object.freeze({
  watch: 'task_output_watch',
  unwatch: 'task_output_unwatch',
  chunk: 'task_output_chunk',
});
// Chunks one tick may send for a fast writer (4 × 64 KB a second).
const MAX_CHUNKS_PER_TICK = 4;
// A watcher whose offset is this far behind the room is caught up by itself;
// further back, it fetches the tail.
const CATCH_UP_BYTES = 256 * 1024;

export function taskOutputRoom(conversationId, taskId) {
  return `${ROOM_PREFIX}${String(conversationId || '')}:${String(taskId || '')}`;
}

function safeAck(ack, payload) {
  if (typeof ack !== 'function') return;
  try { ack(payload); } catch {}
}

function idOf(value) {
  const text = String(value ?? '').trim();
  return text && text.length <= 200 && !/[\s\0]/.test(text) ? text : '';
}

/**
 * `resolveTask(conversationId, taskId)` returns `{ task, ended, key }` for a
 * task in the conversation's live or ended set, or null: the same access
 * check as the output route. Sockets reaching `registerSocket` are already
 * authenticated.
 *
 * Or `resolveSource(conversationId, itemId)`, which returns `{ path, ended }`
 * (`path` '' with a `code` when there is nothing to read), null when the
 * conversation or item is gone; a throw counts as unavailable.
 */
export function createTaskOutputRooms({
  io,
  resolveTask,
  resolveSource = null,
  roomPrefix = ROOM_PREFIX,
  events = TASK_OUTPUT_EVENTS,
  dataKey = 'taskOutputRoom',
  // The payload field naming the item within the conversation; null for one
  // file per conversation.
  itemKey = 'taskId',
  logLabel = 'task-output',
  // Line-safe sends (the worker log): > 0 sends complete lines only, an open
  // line once the file has been quiet this long, and that line again from
  // its start, scrubbed whole, once it is complete (`rewrite: true`); a long
  // line is cut between words. 0: the task console's sends.
  idleFlushMs = 0,
  // The source's path is looked up again on every watch and tick; a new one
  // (another SDK session's log) restarts the room there with a reset.
  followPath = false,
  now = Date.now,
  intervalMs = 1000,
  chunkBytes = TASK_OUTPUT_LIMITS.chunkBytes,
  roomSize = (room) => io?.sockets?.adapter?.rooms?.get?.(room)?.size || 0,
  readChunk = readRange,
  inspect = inspectOutputFile,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = console,
} = {}) {
  if (typeof resolveTask !== 'function' && typeof resolveSource !== 'function') {
    throw new Error('createTaskOutputRooms requires resolveTask');
  }
  const resolve = typeof resolveSource === 'function' ? resolveSource : (conversationId, taskId) => {
    const found = resolveTask(conversationId, taskId);
    if (!found) return found;
    const { kind, path } = taskOutputSource(found.task);
    // A snapshot is fetched again by the console, `none` has nothing.
    return { path, ended: !!found.ended, code: path ? undefined : (kind === 'snapshot' ? 'snapshot' : 'no-output') };
  };
  // room → { conversationId, itemId, path, offset, timer, busy }
  const watched = new Map();

  function roomOf(conversationId, itemId) {
    return itemKey ? `${roomPrefix}${conversationId}:${itemId}` : `${roomPrefix}${conversationId}`;
  }

  // The ids every chunk of a room carries.
  function idsOf(entry) {
    return itemKey ? { conversationId: entry.conversationId, [itemKey]: entry.itemId } : { conversationId: entry.conversationId };
  }

  function stopRoom(room) {
    const entry = watched.get(room);
    if (!entry) return;
    if (entry.timer) clearIntervalImpl(entry.timer);
    watched.delete(room);
  }

  function leave(socket) {
    const current = socket.data?.[dataKey];
    if (current) socket.leave(current);
    if (socket.data) socket.data[dataKey] = null;
    if (current && roomSize(current) === 0) stopRoom(current);
  }

  function lookup(conversationId, itemId) {
    try {
      return resolve(conversationId, itemId);
    } catch {
      return undefined;
    }
  }

  // Where a room may start in a file of `size` bytes: after the last line
  // break of its last 64 KB (never inside a character, an escape or a line
  // whose credentials would be scrubbed in two halves), 0 when there is none
  // in a shorter file.
  async function safeOffset(path, size) {
    if (!(size > 0)) return 0;
    const start = Math.max(0, size - chunkBytes);
    try {
      const probe = await readChunk(path, { start, maxBytes: size - start, holdOpenLine: true, longLineBytes: chunkBytes });
      return probe?.ok && Number.isInteger(probe.endOffset) ? probe.endOffset : size;
    } catch {
      return size;
    }
  }

  // `flush`: send the open last line too (the writer is idle, the task ended,
  // or the bytes were already sent to the room).
  async function sendRange(target, entry, start, end, ended, { flush = true } = {}) {
    let offset = start;
    for (let sent = 0; sent < MAX_CHUNKS_PER_TICK && offset < end; sent += 1) {
      const chunk = await readChunk(entry.path, {
        start: offset,
        maxBytes: Math.min(chunkBytes, end - offset),
        holdOpenLine: !flush,
        longLineBytes: chunkBytes,
      });
      if (!chunk.ok || chunk.endOffset <= offset) break;
      target.emit(events.chunk, {
        ...idsOf(entry),
        offset: chunk.offset,
        endOffset: chunk.endOffset,
        text: chunk.text,
        size: chunk.size,
        mtime: chunk.mtime,
        ended,
      });
      offset = chunk.endOffset;
    }
    return offset;
  }

  // Line-safe sends from where the room's unconfirmed bytes start (the open
  // line already sent, else the room's offset) to `end`: complete lines
  // (the first chunk marked `rewrite` when it repeats a sent open line), then,
  // when `flushOpen` and nothing more completes, the open line.
  async function sendLineSafe(target, entry, end, ended, flushOpen) {
    const resending = entry.openLineStart !== null;
    let offset = resending ? entry.openLineStart : entry.offset;
    let rewrite = resending;
    let stalled = false;
    for (let sent = 0; sent < MAX_CHUNKS_PER_TICK && offset < end; sent += 1) {
      const chunk = await readChunk(entry.path, {
        start: offset,
        maxBytes: Math.min(chunkBytes, end - offset),
        holdOpenLine: true,
        longLineBytes: chunkBytes,
        softCut: true,
      });
      if (!chunk.ok) return;
      if (chunk.endOffset <= offset) {
        stalled = true;
        break;
      }
      target.emit(events.chunk, {
        ...idsOf(entry),
        offset: chunk.offset,
        endOffset: chunk.endOffset,
        text: chunk.text,
        size: chunk.size,
        mtime: chunk.mtime,
        ended,
        ...(rewrite ? { rewrite: true } : {}),
      });
      rewrite = false;
      offset = chunk.endOffset;
      entry.openLineStart = null;
      entry.offset = offset;
    }
    if (!flushOpen || !(stalled || offset >= end)) return;
    // The open line, from its start; only when bytes past what was sent wait.
    const from = entry.openLineStart !== null ? entry.openLineStart : entry.offset;
    if (end <= entry.offset) return;
    const piece = await readChunk(entry.path, { start: from, maxBytes: Math.min(chunkBytes, end - from), holdOpenLine: false });
    if (!piece.ok || piece.endOffset <= entry.offset) return;
    target.emit(events.chunk, {
      ...idsOf(entry),
      offset: piece.offset,
      endOffset: piece.endOffset,
      text: piece.text,
      size: piece.size,
      mtime: piece.mtime,
      ended,
      partial: true,
      ...(entry.openLineStart !== null ? { rewrite: true } : {}),
    });
    entry.openLineStart = from;
    entry.offset = piece.endOffset;
  }

  // The room's source moved to `path`: it starts over there, and the pages
  // read the tail again.
  async function switchPath(target, entry, path, ended) {
    entry.path = path;
    entry.openLineStart = null;
    const info = await inspect(path);
    const size = info.ok ? info.size : 0;
    entry.offset = await safeOffset(path, size);
    entry.lastSize = size;
    entry.lastGrowthAt = now();
    target.emit(events.chunk, {
      ...idsOf(entry),
      offset: entry.offset,
      endOffset: entry.offset,
      text: '',
      size,
      mtime: info.ok ? info.mtimeMs : null,
      ended,
      reset: true,
    });
  }

  async function poll(room) {
    const entry = watched.get(room);
    if (!entry || entry.busy) return;
    if (roomSize(room) === 0) {
      stopRoom(room);
      return;
    }
    entry.busy = true;
    try {
      const found = lookup(entry.conversationId, entry.itemId);
      // The task left both sets (an hour after its end): nothing more comes.
      if (found === null) {
        stopRoom(room);
        return;
      }
      const ended = !!found?.ended;
      const target = io.to(room);
      if (followPath && found?.path && found.path !== entry.path) {
        await switchPath(target, entry, String(found.path), ended);
        return;
      }
      const info = await inspect(entry.path);
      // Not there (yet, or any more): keep waiting.
      if (!info.ok) return;
      // Unchanged since the last tick: the writer is idle, an open line goes out.
      const idle = info.size === entry.lastSize;
      if (!idle) entry.lastGrowthAt = now();
      entry.lastSize = info.size;
      if (info.size < entry.offset) {
        entry.openLineStart = null;
        entry.offset = await safeOffset(entry.path, info.size);
        target.emit(events.chunk, {
          ...idsOf(entry),
          offset: entry.offset,
          endOffset: entry.offset,
          text: '',
          size: info.size,
          mtime: info.mtimeMs,
          ended,
          reset: true,
        });
        return;
      }
      if (idleFlushMs > 0) {
        if (info.size > entry.offset || entry.openLineStart !== null) {
          await sendLineSafe(target, entry, info.size, ended, ended || now() - entry.lastGrowthAt >= idleFlushMs);
        }
      } else if (info.size > entry.offset) {
        entry.offset = await sendRange(target, entry, entry.offset, info.size, ended, { flush: idle || ended });
      }
    } catch (error) {
      const what = itemKey ? `task ${String(entry.itemId).slice(0, 12)}` : `conversation ${String(entry.conversationId).slice(0, 12)}`;
      logger?.warn?.(`[${logLabel}] live read failed for ${what}: ${error?.message || error}`);
    } finally {
      const still = watched.get(room);
      if (still) still.busy = false;
    }
  }

  async function watch(socket, payload) {
    const conversationId = idOf(payload?.conversationId);
    const itemId = itemKey ? idOf(payload?.[itemKey]) : '';
    if (!conversationId || (itemKey && !itemId)) return { ok: false, code: 'missing-id' };
    const found = lookup(conversationId, itemId);
    if (found === undefined) return { ok: false, code: 'unavailable' };
    if (!found) return { ok: false, code: 'not-found' };
    const path = String(found.path || '');
    if (!path) return { ok: false, code: found.code || 'no-output' };
    let info = await inspect(path);
    // A file not there yet (a spool is named before its first byte) is
    // waited for: the room starts at offset 0.
    if (!info.ok && info.code === 'missing') info = { ok: true, size: 0, mtimeMs: null };
    if (!info.ok) return { ok: false, code: info.code || 'unreadable' };

    const room = roomOf(conversationId, itemId);
    if (socket.data?.[dataKey] !== room) {
      leave(socket);
      socket.join(room);
      if (socket.data) socket.data[dataKey] = room;
    } else if (!socket.rooms?.has?.(room)) {
      // A recovered socket keeps its data; its rooms may or may not be back.
      socket.join(room);
    }

    const requested = Number(payload?.offset);
    const wanted = Number.isInteger(requested) && requested >= 0 && requested <= info.size ? requested : null;
    // Where the page's tail ended, so nothing written between its fetch and
    // this watch is lost; a page far behind (or one that names no offset)
    // starts at a safe place near the end and fetches the tail up to it.
    const startOffset = watched.has(room) ? 0
      : (wanted !== null && info.size - wanted <= CATCH_UP_BYTES ? wanted : await safeOffset(path, info.size));
    let entry = watched.get(room);
    if (!entry) {
      entry = {
        conversationId,
        itemId,
        path,
        offset: startOffset,
        lastSize: info.size,
        lastGrowthAt: now(),
        // Line-safe sends: where the open line sent last begins, if one was.
        openLineStart: null,
        timer: null,
        busy: false,
      };
      watched.set(room, entry);
      entry.timer = setIntervalImpl(() => { poll(room).catch(() => {}); }, intervalMs);
      entry.timer?.unref?.();
    } else if (followPath && entry.path !== path && !entry.busy) {
      await switchPath(io.to(room), entry, path, !!found.ended);
    } else if (wanted !== null && wanted < entry.offset && entry.offset - wanted <= CATCH_UP_BYTES) {
      // A second page joins behind the room: it gets the gap on its own.
      await sendRange(socket, entry, wanted, entry.offset, !!found.ended);
    }
    return { ok: true, ...(itemKey ? { [itemKey]: itemId } : {}), offset: entry.offset, size: info.size };
  }

  function registerSocket(socket) {
    if (!socket || typeof socket.on !== 'function') return;
    socket.on(events.watch, (payload, ack) => {
      watch(socket, payload)
        .then((result) => {
          // A refused watch leaves no stale room behind: the page shows another task now.
          if (!result.ok) leave(socket);
          safeAck(ack, result);
        })
        .catch(() => {
          leave(socket);
          safeAck(ack, { ok: false, code: 'unavailable' });
        });
    });
    socket.on(events.unwatch, (_payload, ack) => {
      leave(socket);
      safeAck(ack, { ok: true });
    });
    // socket.io takes a closed socket out of its rooms; the poller stops at
    // its next tick when that emptied the room.
  }

  return {
    registerSocket,
    /** Rooms with a poller, for tests and diagnostics. */
    watchedRooms: () => [...watched.keys()],
    poll,
    stop() {
      for (const room of [...watched.keys()]) stopRoom(room);
    },
  };
}
