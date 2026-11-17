'use strict';

// relay_tool read_worker_log, and the plain tail it shares with
// read_task_output (remote-relay-dispatcher.mjs).
//
// read_worker_log reads the end of the caller's own conversation's worker log
// through GET /api/conversation/:id/worker-log on this relay, called
// in-process with the agent's own token: the route scrubs every window and
// lets an agent token read its own conversation's log only. A worker log is
// read only by its own conversation, so another relay is refused here, and
// the contract refuses a `session` argument.

import { REMOTE_RELAY_ERROR_CODES, REMOTE_RELAY_LIMITS, REMOTE_RELAY_LOCAL_ALIAS } from '../../shared/remote-relay-contract.mjs';
import { cleanTaskOutput, stallMinutes, stripSgr } from '../../shared/task-output-text.mjs';

function toText(value) {
  return String(value ?? '').trim();
}

/**
 * The last `lines` of a line model (`[{ text, count }]`) as plain text, a
 * repeat folded as "  [×N]", cleaned again (control codes, credentials)
 * whatever the other side did, colours dropped, within 32 KB: `{ tail, cut }`,
 * `cut` when lines were left out.
 */
export function plainTail(model, lines) {
  const rendered = model.map((line) => {
    const text = stripSgr(cleanTaskOutput(String(line?.text ?? '')));
    const count = Number(line?.count) > 1 ? Number(line.count) : 1;
    return count > 1 ? `${text}  [×${count}]` : text;
  });
  let tail = rendered.slice(-lines);
  let cut = tail.length < rendered.length;
  let bytes = 0;
  let keepFrom = tail.length;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    bytes += Buffer.byteLength(tail[index], 'utf8') + 1;
    if (bytes > REMOTE_RELAY_LIMITS.taskOutputBytesMax) break;
    keepFrom = index;
  }
  if (keepFrom > 0) {
    tail = tail.slice(keepFrom);
    cut = true;
  }
  return { tail, cut };
}

/** Why read_worker_log does not run on relay `name`: a worker log is read only by its own conversation. */
export function workerLogElsewhereText(name) {
  return `read_worker_log reads your own session's worker log on the relay you run on: use relay "${REMOTE_RELAY_LOCAL_ALIAS}". A worker log is read only by its own conversation, so a session on relay "${toText(name) || 'that relay'}" can be asked to read and quote its own.`;
}

/**
 * The dispatcher's answer to a read_worker_log that names another relay
 * (anything but this one): refused with unsupported before that relay's
 * lock or permission is looked at, since the action can never run there.
 */
export function refuseWorkerLogElsewhere(args) {
  return { status: 400, body: { ok: false, code: REMOTE_RELAY_ERROR_CODES.unsupported, error: workerLogElsewhereText(args?.relay), relay: toText(args?.relay) } };
}

/**
 * The read_worker_log action: `call(ctx, method, path, { query })` and
 * `sessionPath(id, suffix)` are the dispatcher's, `refuse(status, code,
 * message)` makes its refusal error. The answer: the last `lines` lines
 * within 32 KB, the file's path, size and last write, its rolled-over file,
 * or a note when there is no log yet.
 */
export function createReadWorkerLog({ call, sessionPath, refuse, now = Date.now }) {
  return async function readWorkerLog(ctx, args) {
    if (!ctx.relay.local) {
      throw refuse(400, REMOTE_RELAY_ERROR_CODES.unsupported, workerLogElsewhereText(ctx.relay.name));
    }
    const conversationId = toText(ctx.conversationId);
    if (!conversationId) {
      throw refuse(400, REMOTE_RELAY_ERROR_CODES.invalidInput,
        'read_worker_log reads the worker log of the conversation it is called from, and this call names none.');
    }
    const answer = await call(ctx, 'GET', sessionPath(conversationId, '/worker-log'), { query: { lines: args.lines } });
    const log = {
      provider: toText(answer?.provider) || null,
      sdkSessionId: toText(answer?.sdkSessionId) || null,
      path: toText(answer?.path) || null,
    };
    if (toText(answer?.kind) !== 'file') {
      return {
        summary: `read_worker_log → ${ctx.relay.name}: no worker log yet`,
        log: { ...log, folder: toText(answer?.dir) || null },
        tail: [],
        truncated: false,
        note: toText(answer?.message) || 'No worker log yet.',
      };
    }
    const model = Array.isArray(answer?.lines) ? answer.lines : [];
    const { tail, cut } = plainTail(model, args.lines);
    const size = Number.isFinite(Number(answer?.size)) ? Number(answer.size) : null;
    const mtime = Number(answer?.mtime) || null;
    const previous = Array.isArray(answer?.previous) ? answer.previous.map((file) => toText(file?.name)).filter(Boolean) : [];
    const parts = [`${tail.length} line${tail.length === 1 ? '' : 's'}`];
    if (size !== null) parts.push(`${size} bytes`);
    if (mtime) parts.push(`last write ${stallMinutes(mtime, now())} min ago`);
    return {
      summary: `read_worker_log → ${ctx.relay.name}: ${parts.join(', ')}`,
      log: {
        ...log,
        size,
        lastWriteAt: mtime ? new Date(mtime).toISOString() : null,
        ...(previous.length ? { previous } : {}),
      },
      tail,
      truncated: cut || answer?.hasMoreBefore === true,
    };
  };
}
