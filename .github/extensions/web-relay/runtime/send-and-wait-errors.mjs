function readErrorText(error) {
  return String(error?.message || error || "").trim();
}

function extractFirstMatch(text, pattern) {
  const match = text.match(pattern);
  return String(match?.[1] || "").trim() || null;
}

export function toKebabToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || null;
}

// The runtime's own vocabulary for "the billing window is spent". The Copilot
// SDK's `ErrorData.errorCode` documents `quota_exceeded` and
// `session_quota_exceeded`; `errorType` documents the coarser `quota`
// category; HTTP 402 is the transport-level form of the same thing.
const QUOTA_ERROR_CODES = new Set([
  "quota_exceeded",
  "session_quota_exceeded",
  "quota-exceeded",
  "session-quota-exceeded",
  "quota",
]);

/**
 * True when a runtime flagged quota exhaustion STRUCTURALLY, independent of
 * how the prose was worded. This exists because the prose is the one part
 * GitHub rewords freely ("premium requests" → "AI credits" → "monthly quota"),
 * and a quota failure misfiled as retryable burns the retry budget against a
 * window that cannot reset until the next billing period.
 *
 * Accepts the loose shapes callers actually hold: an `Error` with `code` /
 * `statusCode`, or a runtime error payload with `errorCode` / `errorType` /
 * `statusCode`.
 */
export function isStructuredQuotaError(source) {
  if (!source || typeof source !== "object") return false;
  for (const field of ["code", "errorCode", "errorType"]) {
    const token = String(source[field] || "").trim().toLowerCase();
    if (token && QUOTA_ERROR_CODES.has(token)) return true;
  }
  const status = Number(source.statusCode ?? source.status);
  return status === 402;
}

const QUOTA_EXHAUSTED = {
  code: "quota-exhausted",
  message: "GitHub Copilot has no AI credits left for this billing window, so the request was rejected.",
  guidance: "Open Check Usage for the reset time and retry after the reset, or switch this conversation to another provider.",
};

/**
 * `hint` carries structured signals that outrank the prose. Only quota is
 * modelled today; the prose branches below are unchanged and remain the sole
 * classifier when no hint is supplied, which is the extension's path.
 */
function classifyTerminalError(text, hint = {}) {
  // Checked before the prose so a structurally-flagged quota error lands in
  // the non-retryable branch however mildly it was worded.
  if (hint.quota === true) return QUOTA_EXHAUSTED;

  const lower = text.toLowerCase();
  if (!lower) return null;

  if (lower.includes("no tool output found for function call")) {
    return {
      code: "missing-tool-output",
      message: "No tool output was returned for a required function call.",
      guidance: "Retry the message. If this keeps happening, restart the relay and include the error code.",
    };
  }
  if (lower.includes("tool call") && (lower.includes("not found") || lower.includes("missing"))) {
    return {
      code: "tool-call-missing",
      message: "A required tool call was missing in the runtime response.",
      guidance: "Retry the message. If it repeats, restart the relay and include the error code.",
    };
  }
  if (lower.includes("tool output") && lower.includes("invalid")) {
    return {
      code: "invalid-tool-output",
      message: "Tool output returned from the runtime was invalid.",
      guidance: "Retry the message. If it repeats, restart the relay and include the error code.",
    };
  }
  // Monthly/plan quota exhaustion is not transient: retrying before the
  // billing window resets can never succeed. Distinct from "rate limit"
  // (per-minute throttling), which stays retryable below.
  if ((lower.includes("quota") && (lower.includes("exceeded") || lower.includes("exhaust")))
    || lower.includes("out of ai credits")
    || lower.includes("premium request allowance")) {
    return QUOTA_EXHAUSTED;
  }
  if ((lower.includes("capierror") || lower.includes("http 400") || lower.includes("status 400") || /^400\b/.test(lower))
    && !lower.includes("timeout")
    && !lower.includes("temporar")
    && !lower.includes("rate limit")) {
    return {
      code: "request-invalid",
      message: "The runtime rejected the request as invalid and non-retryable.",
      guidance: "Retry after adjusting the request. If it persists, restart the relay and include the error code.",
    };
  }

  return null;
}

/**
 * `options` lets a caller that holds structured error fields (an SDK error
 * payload rather than a thrown `Error`) pass them in explicitly:
 * `{ quota: true }`, or `{ errorCode, errorType, statusCode }` to be judged
 * here. Structured fields carried on the error object itself (`error.code`,
 * `error.statusCode`) are read as well, so plain HTTP-ish errors classify
 * without the caller doing anything.
 */
export function normalizeTerminalSendAndWaitError(error, options = {}) {
  const detail = readErrorText(error);
  const quota = options.quota === true
    || isStructuredQuotaError(options)
    || isStructuredQuotaError(error);
  const base = classifyTerminalError(detail, { quota });
  if (!base) return null;
  const functionCallId = extractFirstMatch(detail, /function call\s+([a-z0-9_-]+)/i)
    || extractFirstMatch(detail, /\b(call_[a-z0-9_-]+)/i);
  // GitHub request ids are colon-separated hex segments (AFAC:3C07CD:…).
  const requestId = extractFirstMatch(detail, /\brequest(?:\s+id|_id)?[:=]\s*([a-z0-9_-]+(?::[a-z0-9_-]+)*)/i)
    || extractFirstMatch(detail, /\b(req_[a-z0-9_-]+)/i);
  return {
    terminal: true,
    code: base.code,
    stableCode: `relay.${base.code}`,
    message: base.message,
    guidance: base.guidance,
    detail: detail || "unknown error",
    functionCallId,
    requestId,
    classificationHint: toKebabToken(error?.code || error?.name || null),
  };
}

export function isTerminalSendAndWaitError(error, options = {}) {
  return !!normalizeTerminalSendAndWaitError(error, options);
}

export function buildTerminalFailureText(error, options = {}) {
  const normalized = normalizeTerminalSendAndWaitError(error, options) || {
    stableCode: "relay.unknown-terminal",
    message: "The relay runtime hit a terminal error and could not complete this turn.",
    guidance: "Retry the message.",
    detail: readErrorText(error) || "unknown error",
    functionCallId: null,
    requestId: null,
  };
  const ids = [
    normalized.functionCallId ? `functionCallId=${normalized.functionCallId}` : null,
    normalized.requestId ? `requestId=${normalized.requestId}` : null,
  ].filter(Boolean);
  return [
    normalized.message,
    `Error code: ${normalized.stableCode}.`,
    ids.length ? `IDs: ${ids.join(", ")}.` : null,
    normalized.guidance,
    `Details: ${normalized.detail}`,
  ].filter(Boolean).join(" ");
}
