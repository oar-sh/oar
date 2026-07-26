function readErrorText(error) {
  return String(error?.message || error || "").trim();
}

function extractFirstMatch(text, pattern) {
  const match = text.match(pattern);
  return String(match?.[1] || "").trim() || null;
}

function toKebabToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || null;
}

function classifyTerminalError(text) {
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

export function normalizeTerminalSendAndWaitError(error) {
  const detail = readErrorText(error);
  const base = classifyTerminalError(detail);
  if (!base) return null;
  const functionCallId = extractFirstMatch(detail, /function call\s+([a-z0-9_-]+)/i)
    || extractFirstMatch(detail, /\b(call_[a-z0-9_-]+)/i);
  const requestId = extractFirstMatch(detail, /\brequest(?:\s+id|_id)?[:=]\s*([a-z0-9_-]+)/i)
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

export function isTerminalSendAndWaitError(error) {
  return !!normalizeTerminalSendAndWaitError(error);
}

export function buildTerminalFailureText(error) {
  const normalized = normalizeTerminalSendAndWaitError(error) || {
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
