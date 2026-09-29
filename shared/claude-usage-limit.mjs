// The Claude subscription's usage limit, as the CLI reports it.
//
// The CLI sends a `rate_limit_event` at the start of every turn of a
// claude.ai subscription session. At the limit it refuses the request without
// waiting or retrying (captured live, CLI 2.1.283 / SDK 0.3.283):
//
//   rate_limit_event   { status: 'rejected', rateLimitType: 'five_hour',
//                        resetsAt: <unix seconds>, unifiedWindows: {...} }
//   assistant          { model: '<synthetic>', error: 'rate_limit',
//                        is_api_error_message: true, text: "You've hit your
//                        session limit · resets 10pm (UTC)" }
//   result             { is_error: true, subtype: 'success',
//                        api_error_status: 429, terminal_reason: 'api_error' }
//
// Shared by the Claude worker (which sees the stream) and the relay (which
// pauses the turn and resumes it at the reset).

export const USAGE_LIMIT_CODE = 'usage-limit';
export const USAGE_LIMIT_STABLE_CODE = `claude.${USAGE_LIMIT_CODE}`;
export const USAGE_LIMIT_KIND = 'claude-usage-limit';

// A wait up to this long resumes by itself. A longer one (a weekly window can
// be days away) stays paused until the user resumes it.
export const USAGE_LIMIT_AUTO_RESUME_MAX_MS = 6 * 60 * 60 * 1000;

// The reset time is the server's; the first request after it must not race
// the window's own bookkeeping.
export const USAGE_LIMIT_RESUME_MARGIN_MS = 60 * 1000;

// A rejected report that names no reset still ahead counts for this long
// after it arrived. Right after a reset the CLI can refuse once more and name
// the reset that has just passed.
export const USAGE_LIMIT_REPORT_FRESH_MS = 10 * 60 * 1000;

const STATUSES = new Set(['allowed', 'allowed_warning', 'rejected']);

const WINDOW_LABELS = Object.freeze({
  five_hour: '5-hour limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'weekly Opus limit',
  seven_day_sonnet: 'weekly Sonnet limit',
  seven_day_overage_included: 'weekly limit',
  overage: 'extra usage limit',
});

const LIMIT_TEXT = /\b(?:hit|reached)\s+your\s+(?:\w+\s+){0,3}limit\b|\busage limit\b/i;

function toFraction(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, 1);
}

// Unix seconds (what the CLI sends), milliseconds or an ISO string.
function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  let ms = NaN;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value).trim())) {
    const n = Number(value);
    ms = n < 1e11 ? n * 1000 : n;
  } else {
    ms = Date.parse(String(value));
  }
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function normalizeWindows(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .map(([id, window]) => ({
      id: String(id),
      utilization: toFraction(window?.utilization),
      resetsAt: toIso(window?.resetsAt ?? window?.resets_at),
    }))
    .filter((window) => window.utilization !== null || window.resetsAt);
}

export function usageLimitWindowLabel(rateLimitType) {
  return WINDOW_LABELS[String(rateLimitType || '').trim()] || 'usage limit';
}

/**
 * The `rate_limit_info` of a `rate_limit_event`, in the shape the relay keeps.
 * Returns null for anything that is not one.
 */
export function normalizeRateLimitInfo(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const status = String(raw.status || '').trim();
  if (!STATUSES.has(status)) return null;
  const rateLimitType = String(raw.rateLimitType || '').trim() || null;
  const windows = normalizeWindows(raw.unifiedWindows);
  const own = windows.find((window) => window.id === rateLimitType) || null;
  return {
    status,
    rateLimitType,
    resetsAt: toIso(raw.resetsAt) || own?.resetsAt || null,
    // A rejected event carries no utilization of its own: the window is full.
    utilization: toFraction(raw.utilization) ?? own?.utilization ?? (status === 'rejected' ? 1 : null),
    surpassedThreshold: toFraction(raw.surpassedThreshold),
    overageStatus: STATUSES.has(String(raw.overageStatus || '')) ? String(raw.overageStatus) : null,
    isUsingOverage: raw.isUsingOverage === true || raw.overageInUse === true,
    windows,
    observedAt: new Date(now).toISOString(),
  };
}

export function isRateLimitEvent(sdkMessage) {
  return String(sdkMessage?.type || '') === 'rate_limit_event';
}

/** What makes two reports the same to a reader: a repeat is not published. */
export function rateLimitInfoKey(info) {
  if (!info) return '';
  const percent = info.utilization === null ? '' : Math.round(info.utilization * 100);
  return [info.status, info.rateLimitType || '', info.resetsAt || '', percent, info.isUsingOverage ? 'overage' : ''].join('|');
}

/**
 * Did the CLI refuse this turn because the usage limit is reached?
 *
 * The ONE place that decides it. Returns null, or what the relay needs to
 * pause the turn: `{ rateLimitType, resetsAt, text }`. `resetsAt` is null
 * when the report names no reset still ahead; the relay then tries again
 * shortly.
 *
 * - `rateLimit`: the latest normalized `rate_limit_info` of the process.
 * - `result`: the raw SDK `result` message the turn ended with, if any.
 * - `assistantError`: the `error` field of the turn's last assistant message.
 * - `errorText`: the text of an exception, when the stream threw instead.
 *
 * A refusal needs both halves: the turn ended in an error that names the
 * limit, and the CLI reported a rejected window, with its reset still ahead
 * or just now. Without a rejected report (the limit reached in the middle of
 * a long turn, under the report the turn began with) the error has to name
 * the limit twice over: by its kind and in its words. A plain API 429 (an
 * API key's requests per minute) comes with no report at all and stays the
 * failure it is; a rejected window the account's extra usage covers ends no
 * turn.
 */
export function classifyUsageLimitRefusal({
  rateLimit = null,
  result = null,
  assistantError = '',
  errorText = '',
  now = Date.now(),
} = {}) {
  if (!rateLimit) return null;
  const resultText = String(result?.result || '').trim();
  const thrownText = String(errorText || '').trim();
  const endedInError = result ? result.is_error === true || String(result.subtype || '') !== 'success' : Boolean(thrownText);
  if (!endedInError) return null;

  const byKind = String(assistantError || '') === 'rate_limit' || Number(result?.api_error_status) === 429;
  const inWords = LIMIT_TEXT.test(resultText) || LIMIT_TEXT.test(thrownText);
  const rejected = rateLimit.status === 'rejected';
  const resetsAtMs = Date.parse(rateLimit.resetsAt || '');
  const resetAhead = Number.isFinite(resetsAtMs) && resetsAtMs > now;

  if (rejected) {
    if (!byKind && !inWords) return null;
    if (!resetAhead) {
      const observedAtMs = Date.parse(rateLimit.observedAt || '');
      if (!Number.isFinite(observedAtMs) || now - observedAtMs > USAGE_LIMIT_REPORT_FRESH_MS) return null;
    }
  } else if (!byKind || !inWords) {
    return null;
  }

  // A warning names the window that was about to run out; a report that
  // allowed everything says nothing about which reset to wait for.
  const namesTheReset = resetAhead && (rejected || rateLimit.status === 'allowed_warning');
  return {
    rateLimitType: rejected || namesTheReset ? rateLimit.rateLimitType : null,
    resetsAt: namesTheReset ? rateLimit.resetsAt : null,
    text: resultText || thrownText,
  };
}

/** When a paused turn is sent again: the reset plus a margin. */
export function usageLimitResumeAt(resetsAt, { marginMs = USAGE_LIMIT_RESUME_MARGIN_MS } = {}) {
  const ms = Date.parse(resetsAt || '');
  return Number.isFinite(ms) ? new Date(ms + marginMs).toISOString() : null;
}

/** Whether a pause ends by itself, or waits for the user (a reset days away). */
export function usageLimitResumesByItself(resetsAt, { now = Date.now(), maxWaitMs = USAGE_LIMIT_AUTO_RESUME_MAX_MS } = {}) {
  const ms = Date.parse(resetsAt || '');
  return Number.isFinite(ms) && ms - now <= maxWaitMs;
}

/**
 * What the worker reports for a refused turn, inside the response's
 * `terminalError`. A relay that knows the kind pauses the row; an older one
 * fails the turn with this message, as before.
 */
export function buildUsageLimitFailure(message, refusal) {
  const label = usageLimitWindowLabel(refusal?.rateLimitType);
  return {
    kind: USAGE_LIMIT_KIND,
    code: USAGE_LIMIT_CODE,
    stableCode: USAGE_LIMIT_STABLE_CODE,
    message: String(refusal?.text || '').trim() || `The Claude ${label} is reached.`,
    guidance: 'The turn carries on by itself after the reset.',
    rateLimitType: refusal?.rateLimitType || null,
    resetsAt: refusal?.resetsAt || null,
    failedAt: new Date().toISOString(),
    queueMessageId: String(message?.id || '') || null,
  };
}

/**
 * Per-process bookkeeping for the worker: the latest report, what the turn's
 * last assistant message said, and which reports are worth publishing.
 */
export function createUsageLimitTracker({ now = () => Date.now() } = {}) {
  let latest = null;
  let publishedKey = '';
  let assistantError = '';

  /** Returns the normalized report when it is news to the relay, else null. */
  function observe(sdkMessage) {
    const type = String(sdkMessage?.type || '');
    if (type === 'rate_limit_event') {
      const info = normalizeRateLimitInfo(sdkMessage.rate_limit_info, { now: now() });
      if (!info) return null;
      latest = info;
      const key = rateLimitInfoKey(info);
      if (key === publishedKey) return null;
      publishedKey = key;
      return info;
    }
    if (type === 'assistant' && !sdkMessage.parent_tool_use_id) {
      assistantError = String(sdkMessage.error || '').trim();
    }
    return null;
  }

  function classifyResult(sdkResult) {
    return classifyUsageLimitRefusal({ rateLimit: latest, result: sdkResult, assistantError, now: now() });
  }

  function classifyException(error) {
    return classifyUsageLimitRefusal({
      rateLimit: latest,
      assistantError,
      errorText: String(error?.message || error || ''),
      now: now(),
    });
  }

  return {
    observe,
    classifyResult,
    classifyException,
    get latest() { return latest; },
  };
}
