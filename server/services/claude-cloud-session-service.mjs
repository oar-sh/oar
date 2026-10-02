'use strict';

// What the relay keeps about a Claude Cloud conversation (provider
// `claude-cloud`), and the two things it does with it besides showing it:
// taking the worker's reports and archiving the cloud session.
//
// A cloud conversation has two records. `conversations.cloud_source_json` says
// what the session clones and where it is shown (`{ repoUrl, branch,
// environmentId, sessionUrl, pushedBranches }`); the runtime session row holds
// the binding the worker reports (`claude_cloud_session_id`, the last handled
// event sequence, the cost). Nothing here ever sees the Claude login: the
// cloud client that archives is injected and reads the token itself.

import { isValidBranchName, normalizeGitHubRepoUrl } from '../../shared/claude-cloud/repo-url.mjs';

export const CLAUDE_CLOUD_PROVIDER_TYPE = 'claude-cloud';
export const CLAUDE_CLOUD_PROVIDER_LABEL = 'Claude Cloud';

// A session that pushes more branches than this keeps the newest ones.
const MAX_PUSHED_BRANCHES = 20;
// Ids go into request paths (the worker's and the archive call's), so only
// the characters the cloud uses for them are taken.
const CLOUD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SEQUENCE_PATTERN = /^\d{1,30}$/;

function toText(value) {
  return typeof value === 'string' ? value.trim() : (typeof value === 'number' ? String(value) : '');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isClaudeCloudProviderType(value) {
  return String(value || '').trim().toLowerCase() === CLAUDE_CLOUD_PROVIDER_TYPE;
}

export function isSafeClaudeCloudId(value) {
  return CLOUD_ID_PATTERN.test(String(value || ''));
}

/** A link the browser may show: https only, so a stored value is never a script URL. */
function normalizeSessionUrl(value) {
  const text = toText(value);
  if (!text || text.length > 500) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizePushedBranches(value) {
  const out = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const branch = isPlainObject(entry) ? entry.branch : entry;
    if (!isValidBranchName(branch)) continue;
    if (out.some((existing) => existing.branch === branch)) continue;
    out.push({ branch, at: toText(entry?.at) || null });
  }
  return out.slice(-MAX_PUSHED_BRANCHES);
}

/**
 * The stored cloud source of a conversation, or null when the column is empty
 * or does not name a repository (every other conversation).
 */
export function parseCloudSourceJson(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isPlainObject(parsed)) return null;
  const repo = normalizeGitHubRepoUrl(parsed.repoUrl);
  if (!repo) return null;
  return {
    repoUrl: repo.repoUrl,
    branch: isValidBranchName(parsed.branch) ? parsed.branch : null,
    environmentId: isSafeClaudeCloudId(parsed.environmentId) ? parsed.environmentId : null,
    sessionUrl: normalizeSessionUrl(parsed.sessionUrl),
    pushedBranches: normalizePushedBranches(parsed.pushedBranches),
  };
}

/**
 * Checks the `cloudSource` of a bootstrap request. The repository comes back
 * in its canonical https form; an empty branch means the default branch.
 */
export function validateCloudSourceRequest(cloudSource) {
  const source = isPlainObject(cloudSource) ? cloudSource : {};
  const repo = normalizeGitHubRepoUrl(source.repoUrl);
  if (!repo) {
    return {
      ok: false,
      code: 'claude_cloud_repo_invalid',
      error: 'A Claude Cloud conversation needs a GitHub repository (for example https://github.com/owner/repo).',
    };
  }
  const branch = typeof source.branch === 'string' ? source.branch.trim() : '';
  if (source.branch != null && typeof source.branch !== 'string') {
    return { ok: false, code: 'claude_cloud_branch_invalid', error: 'The branch must be a branch name.' };
  }
  if (branch && !isValidBranchName(branch)) {
    return { ok: false, code: 'claude_cloud_branch_invalid', error: `"${branch.slice(0, 80)}" is not a valid branch name.` };
  }
  return { ok: true, repoUrl: repo.repoUrl, slug: repo.slug, branch: branch || null };
}

/** The `cloud_source_json` of a new conversation. */
export function buildCloudSourceRecord({ repoUrl, branch = null, environmentId = null } = {}) {
  return {
    repoUrl,
    branch: branch || null,
    environmentId: environmentId || null,
    sessionUrl: null,
    pushedBranches: [],
  };
}

function normalizeCostUsd(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * The `cloud` field of the conversation list and detail payloads:
 * `{ repoUrl, slug, branch, sessionUrl, pushedBranches, costUsd }`, or null
 * for a conversation that is not a cloud one.
 */
export function buildConversationCloudPayload({ cloudSourceJson = null, costUsd = null } = {}) {
  const source = parseCloudSourceJson(cloudSourceJson);
  if (!source) return null;
  return {
    repoUrl: source.repoUrl,
    slug: normalizeGitHubRepoUrl(source.repoUrl)?.slug || null,
    branch: source.branch,
    sessionUrl: source.sessionUrl,
    pushedBranches: source.pushedBranches,
    costUsd: normalizeCostUsd(costUsd),
  };
}

/**
 * The `claudeCloud` field of a delivered message: what the worker needs to
 * create the session (first message) or to send into it (every later one).
 * Null for another provider, and for a cloud conversation whose source is
 * missing: the worker answers that with its own "no repository" reply.
 */
export function buildClaudeCloudDelivery({ conversation = null, runtimeSession = null, fallbackEnvironmentId = '' } = {}) {
  if (!isClaudeCloudProviderType(runtimeSession?.provider_type)) return null;
  const source = parseCloudSourceJson(conversation?.cloud_source_json);
  if (!source) return null;
  const sessionId = toText(runtimeSession?.claude_cloud_session_id);
  const lastSequence = toText(runtimeSession?.claude_cloud_last_sequence);
  const fallback = toText(fallbackEnvironmentId);
  return {
    sessionId: isSafeClaudeCloudId(sessionId) ? sessionId : null,
    lastSequence: SEQUENCE_PATTERN.test(lastSequence) ? lastSequence : null,
    repoUrl: source.repoUrl,
    branch: source.branch,
    environmentId: source.environmentId || (isSafeClaudeCloudId(fallback) ? fallback : null),
    title: toText(conversation?.title) || 'New Conversation',
  };
}

/** The larger of two sequence numbers (strings of digits), so a late report never moves the cursor back. */
function laterSequence(stored, reported) {
  const a = SEQUENCE_PATTERN.test(toText(stored)) ? toText(stored) : null;
  const b = SEQUENCE_PATTERN.test(toText(reported)) ? toText(reported) : null;
  if (!a) return b;
  if (!b) return a;
  return BigInt(b) > BigInt(a) ? b : a;
}

export function createClaudeCloudSessionService({
  stmts,
  // The shared cloud client (archive). A getter, so the server can build the
  // client lazily and tests can leave it out.
  getCloudClient = () => null,
  emit = () => {},
  now = () => new Date(),
  logger = console,
} = {}) {
  function nowIso() {
    const value = now();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  function cloudPayloadFor(conversation, runtimeSession) {
    return buildConversationCloudPayload({
      cloudSourceJson: conversation?.cloud_source_json,
      costUsd: runtimeSession?.claude_cloud_cost_usd,
    });
  }

  /**
   * POST /api/claude-cloud-session: the worker's binding report (after the
   * session was created, after every `result`, and on a push).
   * Returns `{ ok, statusCode, error }` or `{ ok: true, cloud }`.
   */
  function recordWorkerReport(body = {}) {
    const conversationId = toText(body?.conversationId);
    const cloudSessionId = toText(body?.cloudSessionId);
    if (!conversationId || !cloudSessionId) {
      return { ok: false, statusCode: 400, error: 'Missing conversationId or cloudSessionId' };
    }
    if (!isSafeClaudeCloudId(cloudSessionId)) {
      return { ok: false, statusCode: 400, error: 'Invalid cloudSessionId' };
    }
    const runtimeSession = stmts.getRuntimeSessionByConversation?.get?.(conversationId) || null;
    if (!runtimeSession) {
      return { ok: false, statusCode: 404, error: 'Runtime session not found for conversation' };
    }
    if (!isClaudeCloudProviderType(runtimeSession.provider_type || 'github')) {
      return { ok: false, statusCode: 409, error: 'Conversation is not bound to the Claude Cloud provider' };
    }
    if (typeof stmts.updateRuntimeSessionClaudeCloudSession?.run !== 'function'
      || typeof stmts.updateConvCloudSource?.run !== 'function') {
      return { ok: false, statusCode: 500, error: 'Claude Cloud session storage is unavailable' };
    }
    const conversation = stmts.getConvAnyStatus?.get?.(conversationId) || null;
    const source = parseCloudSourceJson(conversation?.cloud_source_json);
    if (!conversation || !source) {
      return { ok: false, statusCode: 409, error: 'Conversation has no cloud repository' };
    }

    // The sequence and the cost belong to one cloud session: a report naming
    // another session (the first one was replaced) starts both again.
    const storedSessionId = toText(runtimeSession.claude_cloud_session_id);
    const sameSession = !storedSessionId || storedSessionId === cloudSessionId;
    const reportedCost = normalizeCostUsd(body?.costUsd);
    const lastSequence = laterSequence(sameSession ? runtimeSession.claude_cloud_last_sequence : null, body?.lastSequence);
    const costUsd = reportedCost !== null
      ? reportedCost
      : (sameSession ? normalizeCostUsd(runtimeSession.claude_cloud_cost_usd) : null);
    const timestamp = nowIso();
    stmts.updateRuntimeSessionClaudeCloudSession.run(cloudSessionId, lastSequence, costUsd, timestamp, conversationId);

    const next = {
      ...source,
      sessionUrl: normalizeSessionUrl(body?.sessionUrl) || (sameSession ? source.sessionUrl : null),
      pushedBranches: sameSession ? [...source.pushedBranches] : [],
    };
    const pushedBranch = typeof body?.pushedBranch === 'string' ? body.pushedBranch.trim() : '';
    if (pushedBranch && isValidBranchName(pushedBranch)) {
      // A branch pushed again moves to the end with its new time.
      next.pushedBranches = [
        ...next.pushedBranches.filter((entry) => entry.branch !== pushedBranch),
        { branch: pushedBranch, at: timestamp },
      ].slice(-MAX_PUSHED_BRANCHES);
    }
    const nextJson = JSON.stringify(next);
    stmts.updateConvCloudSource.run(nextJson, conversationId);

    const cloud = buildConversationCloudPayload({ cloudSourceJson: nextJson, costUsd });
    emit('claude_cloud_session', { conversationId, cloud });
    return { ok: true, cloud };
  }

  /**
   * Archives the cloud session of a conversation that is being deleted or
   * archived here. Best effort: it returns at once (true when an archive was
   * started), and a failure is logged and never reaches the caller.
   */
  function archiveSessionInBackground({ conversationId = '', runtimeSession = null } = {}) {
    if (!isClaudeCloudProviderType(runtimeSession?.provider_type)) return false;
    const cloudSessionId = toText(runtimeSession?.claude_cloud_session_id);
    if (!isSafeClaudeCloudId(cloudSessionId)) return false;
    let client = null;
    try {
      client = getCloudClient();
    } catch {
      client = null;
    }
    if (typeof client?.archiveSession !== 'function') return false;
    const label = toText(conversationId).slice(0, 8) || 'unknown';
    Promise.resolve()
      .then(() => client.archiveSession(cloudSessionId))
      .then(() => {
        logger?.log?.(`[claude-cloud] archived the cloud session of conversation ${label}`);
      })
      .catch((error) => {
        // The client's errors carry a code and a redacted message, never the token.
        const reason = toText(error?.code) || toText(error?.message).slice(0, 200) || 'unknown error';
        logger?.warn?.(`[claude-cloud] the cloud session of conversation ${label} was not archived: ${reason}`);
      });
    return true;
  }

  return { cloudPayloadFor, recordWorkerReport, archiveSessionInBackground };
}
