import path from 'path';
import { checkOpenAIImageSize } from '../../shared/openai-image-options.mjs';
import { matchFailureNote } from '../../shared/failure-note-text.mjs';

// Helpers the message routes and the image routes both use, and those the
// message routes share with the session-worker route modules.

export function delay(ms) {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  if (!timeoutMs) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

export function normalizeStorageSegment(value, fallback = 'item') {
  const text = String(value || '').trim();
  const compact = text.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return compact.slice(0, 96) || fallback;
}

// Base64 payloads are checked with a character loop, never with a regular
// expression over the whole string. V8 compiles a regexp without
// optimisation once the process has generated more than 1 MB of regexp code
// and holds more than 16 MB of executable memory (TooMuchRegExpCode in
// regexp.cc), which a relay reaches after some uptime. An unoptimised
// `[...]+` then pushes one backtrack frame per character and overflows the
// 64 MiB regexp stack at 4,194,304 characters, a PNG of about 3 MB, with
// "Maximum call stack size exceeded": every gpt-image reply above that size
// was dropped after the provider had billed it, and the row was retried four
// more times (2026-11-07). A fresh process optimises the same regexp and
// never shows it.
// An empty string is not base64 here: every caller checks for a missing
// payload first and answers it with its own message.
export function isBase64Text(value) {
  const text = String(value || '');
  if (!text) return false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (
      (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
      || c === 43 || c === 47 || c === 61 // + / =
      || c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 // ASCII whitespace
    ) continue;
    return false;
  }
  return true;
}

/**
 * `data:<mime>;base64,<payload>` taken apart without a regexp over the
 * payload: `{ mimeType, payload }`, or null when the string is not that
 * shape (no comma, no `;base64` right before it, a parameter in the type,
 * an empty payload).
 */
export function splitBase64DataUrl(dataUrl) {
  const text = String(dataUrl || '');
  if (!/^data:/i.test(text)) return null;
  const comma = text.indexOf(',');
  if (comma < 0) return null;
  const header = text.slice('data:'.length, comma);
  const payload = text.slice(comma + 1);
  if (!/;base64$/i.test(header) || !payload) return null;
  const mimeType = header.slice(0, -';base64'.length);
  if (!mimeType || mimeType.includes(';') || mimeType.includes(',')) return null;
  return { mimeType, payload };
}

export function asSentence(text) {
  const value = String(text || '').trim();
  return !value || /[.!?]$/.test(value) ? value : `${value}.`;
}

export function resolveGeneratedImageReadPath({
  resolveSessionStateRoot,
  sessionId,
  relativePath,
} = {}) {
  if (typeof resolveSessionStateRoot !== 'function') return null;
  const root = String(resolveSessionStateRoot() || '').trim();
  if (!root) return null;
  const safeSession = normalizeStorageSegment(sessionId || '', '');
  if (!safeSession) return null;
  const rawRelative = String(relativePath || '').replace(/\\/g, '/').trim();
  if (!rawRelative) return null;
  const normalizedRelative = path.posix.normalize(rawRelative).replace(/^\/+/, '');
  if (!normalizedRelative || normalizedRelative.startsWith('..') || normalizedRelative.includes('/../')) return null;
  const baseDir = path.resolve(path.join(root, safeSession, 'generated-images'));
  const candidate = path.resolve(path.join(baseDir, normalizedRelative));
  if (!(candidate === baseDir || candidate.startsWith(`${baseDir}${path.sep}`))) return null;
  return candidate;
}

export const SESSION_WORKER_OWNER_LEASE_MS = 120_000;

export const OPAQUE_RESPONSE_RECOVERY_WAIT_MS = 600_000;
export const OPAQUE_RESPONSE_RECOVERY_POLL_MS = 250;

export const AUTO_MODEL_SENTINEL = 'auto';

export function deriveModelOrigin(model) {
  const requested = String(model || '').trim().toLowerCase();
  if (!requested) return null;
  return requested === AUTO_MODEL_SENTINEL ? 'auto' : 'manual';
}

export function normalizeOpenAIImageSize(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  // The composer's size select is the context-tier select: its own values
  // mean the API's default size.
  if (normalized === 'default' || normalized === 'long_context') return 'auto';
  if (!normalized) return '';
  return checkOpenAIImageSize(normalized).size || '';
}

export function normalizeSessionWorkerId(value) {
  const text = String(value || '').trim();
  return text || null;
}

export function addMsToIso(baseIso, ms) {
  const base = Date.parse(baseIso);
  const offset = Number(ms);
  const safeBase = Number.isFinite(base) ? base : Date.now();
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return new Date(safeBase + safeOffset).toISOString();
}

export function normalizeTerminalErrorCode(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^relay\./, '');
  return text.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

function normalizeTerminalErrorText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function extractTerminalId(text, patterns = []) {
  const input = String(text || '');
  for (const pattern of patterns) {
    const match = input.match(pattern);
    const value = String(match?.[1] || '').trim();
    if (value) return value;
  }
  return null;
}

/**
 * Reads a failure a sender reported as text only, without a `terminalError`
 * record. The text has to BE a failure note, not merely contain one
 * (shared/failure-note-text.mjs): a reply that quoted a note was stored as a
 * failed turn, cut off at the quoted code.
 */
export function parseTerminalFailureText(text) {
  const raw = String(text || '').trim();
  const note = matchFailureNote(raw);
  if (!note) return null;
  const code = normalizeTerminalErrorCode(note.stableCode);
  if (!code) return null;
  const message = normalizeTerminalErrorText(note.lead.trim().replace(/\s+$/, '.'));
  const detailMatch = raw.match(/details:\s*(.+)$/i);
  return {
    terminal: true,
    code,
    stableCode: `relay.${code}`,
    message,
    detail: normalizeTerminalErrorText(detailMatch?.[1]),
    functionCallId: extractTerminalId(raw, [
      /functioncallid\s*=\s*([a-z0-9_-]+)/i,
      /function call id[:=]\s*([a-z0-9_-]+)/i,
    ]),
    requestId: extractTerminalId(raw, [
      /requestid\s*=\s*([a-z0-9_-]+)/i,
      /request id[:=]\s*([a-z0-9_-]+)/i,
      /\b(req(?:uest)?[_-][a-z0-9_-]+)/i,
    ]),
  };
}

export function buildTerminalFailureTextForChat(terminalFailure, fallbackMessage = null) {
  const failure = terminalFailure && typeof terminalFailure === 'object' ? terminalFailure : {};
  const code = normalizeTerminalErrorCode(failure.code || failure.stableCode) || 'unknown-terminal';
  const stableCode = `relay.${code}`;
  const message = normalizeTerminalErrorText(failure.message)
    || normalizeTerminalErrorText(fallbackMessage)
    || 'The relay runtime hit a terminal error and could not complete this turn.';
  const guidance = normalizeTerminalErrorText(failure.guidance)
    || 'Send the message again to retry. If this keeps failing, include the error code when you report it.';
  const detail = normalizeTerminalErrorText(failure.detail);
  const ids = [
    normalizeTerminalErrorText(failure.functionCallId) ? `functionCallId=${failure.functionCallId}` : null,
    normalizeTerminalErrorText(failure.requestId) ? `requestId=${failure.requestId}` : null,
  ].filter(Boolean);
  return [
    message,
    `Error code: ${stableCode}.`,
    ids.length ? `IDs: ${ids.join(', ')}.` : null,
    guidance,
    detail ? `Details: ${detail}` : null,
  ].filter(Boolean).join(' ');
}

/**
 * `inferFromText`: whether a text shaped like a failure note counts as one
 * when no record came with it. A session worker always sends the record
 * (`terminalError`), so for its publishes (an `attemptId` names the attempt)
 * the text is a reply whatever it says — a reply that names a code after
 * fixing a failed test is a reply. Senders without an attempt (the Copilot
 * extension, a note read from another relay) still report as text.
 */
export function resolveTerminalFailurePayload(payload = {}, { fallbackText = null, inferFromText = true } = {}) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const parsedTextFailure = inferFromText ? parseTerminalFailureText(body.text) : null;
  const direct = body.terminalError && typeof body.terminalError === 'object'
    ? body.terminalError
    : null;
  const explicitCode = normalizeTerminalErrorCode(
    direct?.stableCode
    || direct?.code
    || body.terminalErrorCode
    || body.errorCode,
  );
  const explicitMessage = normalizeTerminalErrorText(
    direct?.message
    || body.terminalErrorMessage
    || body.errorMessage,
  );
  const explicitDetail = normalizeTerminalErrorText(
    direct?.detail
    || body.terminalErrorDetail
    || body.errorDetail,
  );
  const explicitGuidance = normalizeTerminalErrorText(
    direct?.guidance
    || body.terminalErrorGuidance
    || body.errorGuidance,
  );
  const functionCallId = normalizeTerminalErrorText(
    direct?.functionCallId
    || body.functionCallId,
  );
  const requestId = normalizeTerminalErrorText(
    direct?.requestId
    || body.requestId,
  );

  const terminalRequested = body.terminal === true
    || body.isTerminal === true
    || body.terminalError === true
    || body.errorKind === 'terminal'
    || !!direct
    || !!parsedTextFailure;
  if (!terminalRequested) return null;

  const code = explicitCode
    || normalizeTerminalErrorCode(parsedTextFailure?.code)
    || 'unknown-terminal';
  // Known from the text alone: nothing but the shape of the text says that
  // this is a failure, so the text is kept as it was sent.
  const fromText = !!parsedTextFailure && !direct && !explicitCode
    && body.terminal !== true && body.isTerminal !== true && body.errorKind !== 'terminal';
  return {
    terminal: true,
    ...(fromText ? { fromText: true } : {}),
    code,
    stableCode: `relay.${code}`,
    message: explicitMessage || parsedTextFailure?.message || normalizeTerminalErrorText(fallbackText),
    detail: explicitDetail || parsedTextFailure?.detail || null,
    guidance: explicitGuidance || null,
    functionCallId: functionCallId || parsedTextFailure?.functionCallId || null,
    requestId: requestId || parsedTextFailure?.requestId || null,
  };
}

// The `source` of an abort_turn control queued for a continuation on the
// key that the Claude API claim check refuses (POST /api/continuation-turn):
// the cap, no key, or the provider switched off.
export const CLAUDE_API_CAP_STOP_SOURCE = 'claude-api-cap';
