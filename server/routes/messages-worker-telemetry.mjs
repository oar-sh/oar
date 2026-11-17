// The session worker log line: one JSON envelope per worker event, written
// with the relay's timestamp. Stateless: the queue counts are read at each
// call.

function normalizeTelemetryText(value, fallback = 'none') {
  const text = String(value || '').trim();
  return text || fallback;
}

function toTelemetryRetry(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.trunc(numeric));
}

function toTelemetryPid(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const pid = Math.trunc(numeric);
  return pid > 0 ? pid : null;
}

function toTelemetryQueueField(queue = null) {
  if (!queue || typeof queue !== 'object') return 'pending=0,processing=0,parked=0';
  const pending = toTelemetryRetry(queue.pendingCount);
  const processing = toTelemetryRetry(queue.processingCount);
  const parked = toTelemetryRetry(queue.parkedCount);
  return `pending=${pending},processing=${processing},parked=${parked}`;
}

export function buildSessionWorkerLogEnvelope({
  event = 'session-worker-event',
  worker = null,
  session = null,
  conversation = null,
  message = null,
  continuation = null,
  state = null,
  queue = null,
  retry = 0,
  pid = null,
} = {}) {
  return {
    event: normalizeTelemetryText(event, 'session-worker-event'),
    worker: normalizeTelemetryText(worker),
    session: normalizeTelemetryText(session),
    conversation: normalizeTelemetryText(conversation),
    message: normalizeTelemetryText(message),
    continuation: normalizeTelemetryText(continuation),
    state: normalizeTelemetryText(state, 'unknown'),
    queue: normalizeTelemetryText(queue, toTelemetryQueueField(null)),
    retry: toTelemetryRetry(retry),
    pid: toTelemetryPid(pid),
  };
}

export function createSessionWorkerTelemetry({ queueCounts, ts }) {
  function emitSessionWorkerTelemetry(event, {
    sessionId = null,
    workerId = null,
    conversationId = null,
    messageId = null,
    continuationId = null,
    state = null,
    retry = 0,
    pid = null,
    queue = null,
    level = 'log',
    extra = null,
  } = {}) {
    const envelope = buildSessionWorkerLogEnvelope({
      event,
      worker: workerId,
      session: sessionId,
      conversation: conversationId,
      message: messageId,
      continuation: continuationId,
      state,
      queue: queue ? toTelemetryQueueField(queue) : toTelemetryQueueField(queueCounts?.() || null),
      retry,
      pid,
    });
    const payload = extra && typeof extra === 'object'
      ? { ...envelope, ...extra }
      : envelope;
    const method = typeof console[level] === 'function' ? level : 'log';
    console[method](`[${ts()}] WORKER    ${JSON.stringify(payload)}`);
  }

  return emitSessionWorkerTelemetry;
}
