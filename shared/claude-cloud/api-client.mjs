// The Claude Cloud session API, as far as OAR needs it.
//
// Cloud sessions run Claude Code in a VM at Anthropic, on a clone of a GitHub
// repository. This client creates them, sends them messages and answers,
// follows their event stream, and reads usage. It is SDK-free (Node's fetch),
// keeps no state besides the organisation id, and is used by the cloud worker
// and by the server alike.
//
// The API is the one the Claude CLI itself speaks; paths, headers and bodies
// were measured, not documented, so every expectation about them lives in this
// one file.
//
// Every call goes through `request`: it adds the headers, tries once more with
// a freshly read token after a 401, and turns every failure into a
// ClaudeCloudError whose text has been through `credentials.redact`. Nothing
// here logs, and the token is in no error and no return value.

import { randomUUID } from 'node:crypto';

import { ClaudeCloudError, claudeCloudErrorMessage, createClaudeCloudCredentials } from './credentials.mjs';
import { stripModelTierSuffix } from './repo-url.mjs';

export { ClaudeCloudError };

export const CLAUDE_CLOUD_BASE_URL = 'https://api.anthropic.com';
export const CLAUDE_CLOUD_API_VERSION = '2023-06-01';
export const CLAUDE_CLOUD_API_BETA = 'ccr-triggers-2026-01-30,oauth-2025-04-20';

const DEFAULT_USER_AGENT = 'oar-claude-cloud';
/** How long a call may take until its answer is complete (a create took 8 s when measured). */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_DETAIL_CHARS = 500;
const DEFAULT_SESSION_TITLE = 'Untitled session';

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function clip(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}…` : flat;
}

/**
 * A push parser for a `text/event-stream` body. Feed it decoded text in any
 * chunking; it calls `onFrame({ event, id, data })` for every complete frame
 * that carries an `event:` or a `data:` field (`data` is the joined text of
 * the data lines, or null when the frame has none) and `onComment(text)` for
 * every comment line (the keepalives).
 *
 * Lines may end in LF, CRLF or CR, and a chunk may end anywhere, also between
 * the CR and the LF. A frame is complete at its blank line: `end()` drops
 * what an interrupted stream left unfinished, as the SSE rules say, so that a
 * frame cut off in the middle is never taken for a whole one. The reader gets
 * it again when it reconnects from the last id it saw.
 */
export function createSseParser({ onFrame = () => {}, onComment = () => {} } = {}) {
  let buffer = '';
  let started = false;
  let event = '';
  let id = null;
  let dataLines = [];
  let hasContent = false;

  function reset() {
    event = '';
    id = null;
    dataLines = [];
    hasContent = false;
  }

  function takeLine(line) {
    if (line === '') {
      if (hasContent) onFrame({ event: event || 'message', id, data: dataLines.length ? dataLines.join('\n') : null });
      reset();
      return;
    }
    if (line.startsWith(':')) {
      onComment(line.slice(1).trim());
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      event = value;
      hasContent = true;
    } else if (field === 'data') {
      dataLines.push(value);
      hasContent = true;
    } else if (field === 'id') {
      // An id alone does not make a frame; it belongs to the one it is in.
      if (!value.includes('\u0000')) id = value;
    }
    // `retry:` and unknown fields are ignored.
  }

  function push(text) {
    buffer += String(text ?? '');
    if (!started && buffer.length) {
      started = true;
      if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
    }
    let start = 0;
    for (;;) {
      let end = -1;
      for (let i = start; i < buffer.length; i += 1) {
        const code = buffer.charCodeAt(i);
        if (code === 10 || code === 13) {
          end = i;
          break;
        }
      }
      if (end === -1) break;
      const isCr = buffer.charCodeAt(end) === 13;
      // A CR at the very end may be the first half of a CRLF still on its way.
      if (isCr && end === buffer.length - 1) break;
      takeLine(buffer.slice(start, end));
      start = end + (isCr && buffer.charCodeAt(end + 1) === 10 ? 2 : 1);
    }
    buffer = buffer.slice(start);
  }

  function end() {
    // A lone CR held back above did end its line; a blank one closes a frame.
    if (buffer.endsWith('\r')) {
      const line = buffer.slice(0, -1);
      buffer = '';
      takeLine(line);
    }
    buffer = '';
    reset();
  }

  return { push, end };
}

/** The SDK user message a cloud session takes as an event payload. */
export function buildClaudeCloudUserMessage({ content, sessionId = '', uuid = null } = {}) {
  return {
    uuid: uuid || randomUUID(),
    session_id: String(sessionId || ''),
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content },
  };
}

/**
 * The control request that hands settings to the sandbox's Claude Code, as
 * the SDK's `applyFlagSettings` does for a local one (session-scoped: the
 * flag layer, nothing is written in the sandbox). A key set to null is taken
 * out of that layer again.
 */
export function buildClaudeCloudFlagSettingsRequest({ settings, sessionId = '', requestId = null } = {}) {
  return {
    uuid: randomUUID(),
    session_id: String(sessionId || ''),
    type: 'control_request',
    request_id: requestId || randomUUID(),
    request: { subtype: 'apply_flag_settings', settings },
  };
}

/** What an error body says about itself, wherever the API put it. */
function readErrorBody(text) {
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const outer = payload && typeof payload === 'object' ? payload : {};
  const inner = outer.error && typeof outer.error === 'object' ? outer.error : {};
  return {
    type: firstText(inner.type, outer.type),
    reason: firstText(inner.reason, outer.reason),
    subReason: firstText(inner.sub_reason, outer.sub_reason),
    message: firstText(inner.message, outer.message, outer.error, outer.detail),
  };
}

/**
 * The error code for a refused call: what the body names wins over the bare
 * status, because a missing GitHub connection and a repository the Claude
 * GitHub app may not read both arrive as plain 4xx answers.
 */
export function classifyClaudeCloudFailure(status, { type = '', reason = '', subReason = '', message = '' } = {}) {
  const said = `${type} ${reason} ${subReason} ${message}`.toLowerCase();
  if (status >= 400 && status < 500) {
    if (/github_token_missing|github_not_connected|github[^.]{0,40}\bnot connected/.test(said)) return 'github_not_connected';
    if (/repo(?:sitory)?_access_denied/.test(said)) return 'repo_access_denied';
    if (/environment_(?:not_found|missing|invalid|unavailable)/.test(said)
      || /\benvironment(?:_id)?\b[^.]{0,60}\b(?:not found|does not exist|missing|invalid|unknown)/.test(said)
      || /\b(?:invalid|unknown|missing)\b[^.]{0,30}\benvironment/.test(said)) return 'environment_missing';
  }
  if (status === 401) return 'login_expired';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 425 || status >= 500) return 'transient';
  return 'bad_request';
}

function retryAfterMs(headers) {
  const seconds = Number(headers?.get?.('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

/**
 * `credentials`: from createClaudeCloudCredentials (the default reads the
 * CLI's login). `fetchImpl`, `baseUrl`, `userAgent` and `requestTimeoutMs`
 * are for tests and operators. `now` and `sleep` are accepted so that every
 * caller can pass its clock, and unused: this client neither waits nor
 * retries on a timer; backing off is the caller's business.
 */
export function createClaudeCloudClient({
  credentials = createClaudeCloudCredentials(),
  fetchImpl = globalThis.fetch,
  baseUrl = CLAUDE_CLOUD_BASE_URL,
  userAgent = DEFAULT_USER_AGENT,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const base = String(baseUrl || CLAUDE_CLOUD_BASE_URL).replace(/\/+$/, '');
  const redact = (text) => credentials.redact(String(text ?? ''));
  // The organisation belongs to the login, so it is kept with the token it
  // was read for: another account after a re-login gets its own.
  let organization = null;

  function failure(code, { status = null, detail = '', message = '' } = {}) {
    const safeDetail = clip(redact(detail));
    const text = message || claudeCloudErrorMessage(code);
    const withStatus = status && (code === 'bad_request' || code === 'transient') ? `${text.replace(/\.$/, '')} (HTTP ${status}).` : text;
    const full = safeDetail && (code === 'bad_request' || code === 'not_found') ? `${withStatus} ${safeDetail}` : withStatus;
    return new ClaudeCloudError(code, redact(full), { status, detail: safeDetail || null });
  }

  function failureFromResponse(res, text) {
    const safeText = redact(text);
    const said = readErrorBody(safeText);
    const error = failure(classifyClaudeCloudFailure(res.status, said), {
      status: res.status,
      detail: said.message || safeText,
    });
    const wait = res.status === 429 ? retryAfterMs(res.headers) : null;
    if (wait !== null) error.retryAfterMs = wait;
    return error;
  }

  /**
   * One HTTP exchange. A `stream` call that is answered with a body returns
   * as soon as the headers are there, with the controller that ends it; every
   * other call returns the complete text. Rejects with an AbortError when
   * `signal` ended it, with `transient` for anything else that kept the
   * answer from arriving.
   */
  async function exchange(method, routePath, { token, body, headers, stream, signal }) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    const release = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    try {
      const res = await fetchImpl(`${base}${routePath}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'anthropic-version': CLAUDE_CLOUD_API_VERSION,
          'anthropic-beta': CLAUDE_CLOUD_API_BETA,
          'user-agent': userAgent,
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (stream && res.ok && res.body) {
        // The clock was for the headers; the stream itself has no deadline.
        clearTimeout(timer);
        return { res, text: null, controller, release };
      }
      const text = await res.text();
      release();
      return { res, text, controller: null, release: null };
    } catch (error) {
      release();
      if (signal?.aborted) throw abortError();
      if (timedOut) {
        throw failure('transient', { message: `Claude Cloud did not answer within ${Math.round(requestTimeoutMs / 1000)} s.` });
      }
      throw failure('transient', {
        message: 'Claude Cloud could not be reached.',
        detail: firstText(error?.cause?.code, error?.cause?.message, error?.message),
      });
    }
  }

  /**
   * Every call. Resolves `{ status, body }` (the parsed JSON, null for an
   * empty answer), or the open exchange for a `stream` call. A 401 is tried
   * once more with the token read afresh; `okStatuses` are answers besides
   * 2xx that the caller takes as success.
   */
  async function request(method, routePath, { body, headers = {}, stream = false, signal = null, okStatuses = [] } = {}) {
    let token = await credentials.getAccessToken();
    for (let attempt = 0; ; attempt += 1) {
      const result = await exchange(method, routePath, { token, body, headers, stream, signal });
      const { res, text } = result;
      if (result.controller) return result;
      if (res.status === 401 && attempt === 0) {
        token = await credentials.getAccessToken({ forceReload: true });
        continue;
      }
      const accepted = okStatuses.includes(res.status);
      if (!res.ok && !accepted) throw failureFromResponse(res, text);
      let parsed = null;
      if (String(text || '').trim()) {
        try {
          parsed = JSON.parse(text);
        } catch {
          if (!accepted) {
            throw failure('transient', { status: res.status, message: 'Claude Cloud sent an answer that is not JSON.', detail: text });
          }
        }
      }
      return { status: res.status, body: parsed };
    }
  }

  function sessionPath(id, suffix = '') {
    const sessionId = String(id ?? '').trim();
    if (!sessionId) throw failure('bad_request', { message: 'A cloud session id is required.' });
    return `/v1/code/sessions/${encodeURIComponent(sessionId)}${suffix}`;
  }

  /** The uuid of the organisation the login belongs to. */
  async function getOrganizationId() {
    const token = await credentials.getAccessToken();
    if (organization && organization.token === token) return organization.id;
    const { body } = await request('GET', '/api/oauth/profile');
    const id = firstText(body?.organization?.uuid);
    if (!id) throw failure('bad_request', { message: 'The Claude account has no organisation to run cloud sessions in.' });
    organization = { token, id };
    return id;
  }

  /** The cloud environments of the organisation as `{ id, name, kind, state }`, the active ones first. */
  async function listEnvironments() {
    const organizationId = await getOrganizationId();
    const { body } = await request('GET', '/v1/environment_providers', { headers: { 'x-organization-uuid': organizationId } });
    const environments = (Array.isArray(body?.environments) ? body.environments : [])
      .map((entry) => ({
        id: firstText(entry?.environment_id, entry?.id),
        name: firstText(entry?.name),
        kind: firstText(entry?.kind),
        state: firstText(entry?.state),
      }))
      .filter((entry) => entry.id);
    return [
      ...environments.filter((entry) => entry.state === 'active'),
      ...environments.filter((entry) => entry.state !== 'active'),
    ];
  }

  function requireContent(content) {
    const usable = typeof content === 'string' ? content.trim().length > 0 : Array.isArray(content) && content.length > 0;
    if (!usable) throw failure('bad_request', { message: 'A message for the cloud session is required.' });
  }

  /**
   * Create a session with its first message. `uuid` is the message's id: the
   * API answers a repeated create with the same uuid with the session it
   * already made (`deduplicated`), so a retried delivery should pass it again.
   * `flagSettings` (optional) reach the sandbox's Claude Code before the
   * message does; `flagSettingsRequestId` names the request its
   * `control_response` on the event stream answers.
   */
  async function createSession({ title, environmentId, model, repoUrl, branch, content, uuid, flagSettings = null } = {}) {
    const environment = firstText(environmentId);
    if (!environment) throw failure('environment_missing');
    const url = firstText(repoUrl);
    if (!url) throw failure('bad_request', { message: 'A repository URL for the cloud session is required.' });
    const plainModel = stripModelTierSuffix(model);
    if (!plainModel) throw failure('bad_request', { message: 'A model for the cloud session is required.' });
    requireContent(content);
    const revision = firstText(branch);
    const settingsRequest = flagSettings && typeof flagSettings === 'object'
      ? buildClaudeCloudFlagSettingsRequest({ settings: flagSettings })
      : null;
    const { body } = await request('POST', '/v1/code/sessions', {
      body: {
        title: firstText(title) || DEFAULT_SESSION_TITLE,
        environment_id: environment,
        config: {
          model: plainModel,
          sources: [{ type: 'git_repository', url, ...(revision ? { revision } : {}) }],
        },
        // In this order: the settings have to be in place when the agent
        // reads the message.
        events: settingsRequest
          ? [
            { event_type: 'control_request', payload: settingsRequest },
            { event_type: 'user', payload: buildClaudeCloudUserMessage({ content, sessionId: '', uuid }) },
          ]
          : [{ payload: buildClaudeCloudUserMessage({ content, sessionId: '', uuid }) }],
      },
    });
    const id = firstText(body?.session?.id);
    if (!id) throw failure('transient', { message: 'Claude Cloud answered the create without a session id.' });
    return {
      id,
      sessionUrl: firstText(body.session.session_url) || null,
      deduplicated: body.deduplicated === true,
      flagSettingsRequestId: settingsRequest?.request_id || null,
      raw: body,
    };
  }

  /**
   * The session as the API describes it (`status`, `worker_status`,
   * `external_metadata`, …). The API wraps it in `response_shape`; the object
   * returned is the unwrapped one and answers to `.response_shape` as well.
   */
  async function getSession(id) {
    const { body } = await request('GET', sessionPath(id));
    const session = body?.response_shape && typeof body.response_shape === 'object' ? body.response_shape : body;
    if (!session || typeof session !== 'object') {
      throw failure('transient', { message: 'Claude Cloud answered without a session.' });
    }
    if (!('response_shape' in session)) {
      Object.defineProperty(session, 'response_shape', { value: session, enumerable: false });
    }
    return session;
  }

  /** One page of the event log: `{ events, nextCursor }` (also as `data` / `next_cursor`). */
  async function listEvents(id, { cursor = null, sortOrder = 'asc', limit = null } = {}) {
    const query = new URLSearchParams({ sort_order: sortOrder === 'desc' ? 'desc' : 'asc' });
    if (cursor !== null && cursor !== undefined && String(cursor) !== '') query.set('cursor', String(cursor));
    if (Number.isInteger(limit) && limit > 0) query.set('limit', String(limit));
    const { body } = await request('GET', sessionPath(id, `/events?${query}`));
    const events = Array.isArray(body?.data) ? body.data : [];
    const nextCursor = body?.next_cursor === null || body?.next_cursor === undefined || body.next_cursor === ''
      ? null
      : String(body.next_cursor);
    return { events, nextCursor, data: events, next_cursor: nextCursor };
  }

  async function postEvent(id, eventType, payload) {
    const { body } = await request('POST', sessionPath(id, '/events'), {
      body: { events: [{ event_type: eventType, payload }] },
    });
    const first = Array.isArray(body?.results) ? body.results[0] : null;
    return {
      eventId: firstText(first?.event_id) || null,
      sequence: first?.sequence_num === null || first?.sequence_num === undefined ? null : String(first.sequence_num),
      duplicate: first?.duplicate === true,
    };
  }

  /** Send a user message; `sequence` is where its turn starts in the event log. */
  async function sendUserMessage(id, content, { uuid = null } = {}) {
    const routeId = String(id ?? '').trim();
    requireContent(content);
    return postEvent(routeId, 'user', buildClaudeCloudUserMessage({ content, sessionId: routeId, uuid }));
  }

  /**
   * Answer a `can_use_tool` control request. `response` is the decision:
   * `{ behavior: 'allow', updatedInput }` or `{ behavior: 'deny', message }`.
   */
  async function sendControlResponse(id, { requestId, response } = {}) {
    const routeId = String(id ?? '').trim();
    const request_id = firstText(requestId);
    if (!request_id || !response || typeof response !== 'object') {
      throw failure('bad_request', { message: 'A control response needs the request id and the decision.' });
    }
    return postEvent(routeId, 'control_response', {
      uuid: randomUUID(),
      session_id: routeId,
      type: 'control_response',
      response: { subtype: 'success', request_id, response },
    });
  }

  /** Stop the running turn. Its `result` event follows on the stream. */
  async function sendInterrupt(id) {
    const routeId = String(id ?? '').trim();
    const requestId = randomUUID();
    const sent = await postEvent(routeId, 'control_request', {
      uuid: randomUUID(),
      session_id: routeId,
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'interrupt' },
    });
    return { ...sent, requestId };
  }

  /**
   * Hand settings to the sandbox's Claude Code (see
   * buildClaudeCloudFlagSettingsRequest). Whether it took them is its
   * `control_response` on the event stream, under the returned `requestId`.
   */
  async function applyFlagSettings(id, settings) {
    const routeId = String(id ?? '').trim();
    if (!settings || typeof settings !== 'object') {
      throw failure('bad_request', { message: 'Flag settings for the cloud session are required.' });
    }
    const payload = buildClaudeCloudFlagSettingsRequest({ settings, sessionId: routeId });
    const sent = await postEvent(routeId, 'control_request', payload);
    return { ...sent, requestId: payload.request_id };
  }

  /** Archive the session. One that is archived already counts as done. */
  async function archiveSession(id) {
    const { status } = await request('POST', sessionPath(id, '/archive'), { body: {}, okStatuses: [409] });
    return { archived: true, alreadyArchived: status === 409 };
  }

  /** The account's usage windows and dollar buckets, as the API sends them. */
  async function getAccountUsage() {
    const { body } = await request('GET', '/api/oauth/usage');
    return body;
  }

  function organizationPath(organizationId, suffix) {
    return `/api/oauth/organizations/${encodeURIComponent(organizationId)}${suffix}`;
  }

  /**
   * The organisation's prepaid usage credits, as the API sends them
   * (`{ amount, currency, … }`, the amount in minor units).
   */
  async function getPrepaidCredits() {
    const organizationId = await getOrganizationId();
    const { body } = await request('GET', organizationPath(organizationId, '/prepaid/credits'), {
      headers: { 'x-organization-uuid': organizationId },
    });
    return body;
  }

  /**
   * Whether a usage credit is on offer to the organisation, as the API sends
   * it (`{ available, eligible, granted, amount_minor_units, currency, … }`).
   * Only ever read: claiming is done on claude.ai.
   */
  async function getCreditGrantOffer() {
    const organizationId = await getOrganizationId();
    const { body } = await request('GET', organizationPath(organizationId, '/overage_credit_grant'), {
      headers: { 'x-organization-uuid': organizationId },
    });
    return body;
  }

  /**
   * Follow the session's event stream. Calls `onOpen()` once the stream is
   * open and `onEvent({ kind, id, data })` for every frame, one after the
   * other (an async `onEvent` is awaited): `kind` is the `event:` name, `id`
   * the sequence number as sent (a string) or null, `data` the parsed JSON.
   * Keepalive comments, frames without data and frames whose data is not a
   * JSON value are skipped; `onKeepalive()` hears the comments.
   *
   * Throws a ClaudeCloudError when the stream cannot be opened. Once it is
   * open it only ever resolves, with `{ reason, lastEventId, error }`:
   * `ended` (the API closed it), `aborted` (`signal`), `idle` (no byte for
   * `idleTimeoutMs`, when one is given), `error` (the connection broke;
   * `error` says how). It never reconnects: the caller does, passing the last
   * id it handled as `lastEventId`.
   */
  async function openEventStream(id, {
    lastEventId = null, signal = null, onEvent = null, onOpen = null, onKeepalive = null, idleTimeoutMs = 0,
  } = {}) {
    const routePath = sessionPath(id, '/events/stream');
    let lastId = lastEventId === null || lastEventId === undefined || String(lastEventId) === '' ? null : String(lastEventId);
    if (signal?.aborted) return { reason: 'aborted', lastEventId: lastId, error: null };

    let open;
    try {
      open = await request('GET', routePath, {
        headers: { Accept: 'text/event-stream', ...(lastId !== null ? { 'Last-Event-ID': lastId } : {}) },
        stream: true,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) return { reason: 'aborted', lastEventId: lastId, error: null };
      throw error;
    }
    // A 2xx without a body: nothing to follow.
    if (!open.controller) return { reason: 'ended', lastEventId: lastId, error: null };

    const { res, controller, release } = open;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const pending = [];
    const parser = createSseParser({
      onFrame: (frame) => pending.push(frame),
      onComment: () => pending.push(null),
    });
    let idle = false;
    let broken = null;
    let idleTimer = null;
    const stopReading = () => { reader.cancel().catch(() => {}); };
    const armIdleTimer = () => {
      if (!(idleTimeoutMs > 0)) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idle = true;
        controller.abort();
        stopReading();
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    signal?.addEventListener?.('abort', stopReading, { once: true });

    // Hand over what the parser has completed, in order, until the caller
    // aborts.
    async function deliverPending() {
      for (const frame of pending.splice(0)) {
        if (signal?.aborted) return;
        if (frame === null) {
          if (typeof onKeepalive === 'function') await onKeepalive();
          continue;
        }
        if (frame.data === null) continue;
        let data;
        try {
          data = JSON.parse(frame.data);
        } catch {
          continue;
        }
        if (data === null || data === undefined) continue;
        if (typeof onEvent === 'function') await onEvent({ kind: frame.event, id: frame.id, data });
        if (frame.id !== null) lastId = frame.id;
      }
    }

    try {
      if (typeof onOpen === 'function') await onOpen({ lastEventId: lastId });
      armIdleTimer();
      while (!signal?.aborted && !idle) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (!signal?.aborted && !idle) broken = error;
          break;
        }
        if (chunk.done) break;
        armIdleTimer();
        parser.push(typeof chunk.value === 'string' ? chunk.value : decoder.decode(chunk.value, { stream: true }));
        await deliverPending();
      }
      parser.end();
      await deliverPending();
    } finally {
      clearTimeout(idleTimer);
      signal?.removeEventListener?.('abort', stopReading);
      release();
      controller.abort();
      stopReading();
    }

    if (signal?.aborted) return { reason: 'aborted', lastEventId: lastId, error: null };
    if (idle) return { reason: 'idle', lastEventId: lastId, error: null };
    if (broken) {
      return {
        reason: 'error',
        lastEventId: lastId,
        error: failure('transient', {
          message: 'The Claude Cloud event stream broke off.',
          detail: firstText(broken?.cause?.code, broken?.cause?.message, broken?.message),
        }),
      };
    }
    return { reason: 'ended', lastEventId: lastId, error: null };
  }

  return {
    getOrganizationId,
    listEnvironments,
    createSession,
    getSession,
    listEvents,
    sendUserMessage,
    sendControlResponse,
    sendInterrupt,
    applyFlagSettings,
    archiveSession,
    getAccountUsage,
    getPrepaidCredits,
    getCreditGrantOffer,
    openEventStream,
  };
}
