import { BASE, TOKEN, authHeaders, updateWorkspaceRootHints, applyContextUsageBar, readContextUsageRatio, currentConvId, conversations, setCliOnline, setCloudflaredTunnelState, setActiveRuntimeSessionCount, setRuntimeSessionBindingCount, setContextIndicatorMode, setServerPlatform } from './store.js';

// fetch() has no default timeout. Without one, a request issued while the app is
// being backgrounded can hang indefinitely on a half-open mobile connection and
// stall every caller awaiting it, including foreground recovery.
const REQUEST_TIMEOUT_MS = 15000;
// Session bootstrap, uploads and git operations do real work server-side, so they
// get a ceiling that only catches a genuinely dead connection.
const LONG_REQUEST_TIMEOUT_MS = 120000;

let networkRequestsEnabled = true;
let fetchOutageActive = false;
let lastFetchOutageSignature = '';

function requestTimeoutSignal(timeoutMs = REQUEST_TIMEOUT_MS) {
  return AbortSignal.timeout?.(timeoutMs);
}

function toErrorMessage(error) {
  if (!error) return 'unknown error';
  const message = String(error?.message || error || '').trim();
  return message || 'unknown error';
}

function noteFetchSuccess() {
  fetchOutageActive = false;
  lastFetchOutageSignature = '';
}

function noteFetchFailure(url, error) {
  if (!networkRequestsEnabled) return;
  const signature = `${String(url || '').trim()}::${toErrorMessage(error)}`;
  if (fetchOutageActive && signature === lastFetchOutageSignature) return;
  fetchOutageActive = true;
  lastFetchOutageSignature = signature;
  console.error('Fetch error', toErrorMessage(error));
}

export function setNetworkRequestsEnabled(value) {
  networkRequestsEnabled = !!value;
  if (networkRequestsEnabled) noteFetchSuccess();
}

export function areNetworkRequestsEnabled() {
  return networkRequestsEnabled;
}

export async function apiFetch(url, opts = {}) {
  if (!networkRequestsEnabled) return null;
  try {
    const response = await fetch(`${BASE}${url}`, {
      signal: requestTimeoutSignal(),
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
        ...(opts.headers || {}),
      },
      ...opts,
    });
    if (!response.ok) {
      console.error('API error', response.status, url);
      return null;
    }
    noteFetchSuccess();
    return response.json();
  } catch (error) {
    noteFetchFailure(url, error);
    return null;
  }
}

export async function verifyExistingSession(tokenCandidate = '') {
  if (!networkRequestsEnabled) {
    return {
      ok: false,
      status: 0,
      payload: null,
      error: 'Network requests are paused',
    };
  }
  try {
    const requestStatus = async (headers = null) => {
      const response = await fetch(`${BASE}/api/status`, {
        signal: requestTimeoutSignal(),
        ...(headers ? { headers } : {}),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload) {
        updateWorkspaceRootHints(payload);
        setContextIndicatorMode(payload?.contextIndicatorMode);
        setCliOnline(!!payload?.cliOnline);
        setCloudflaredTunnelState(payload?.cloudflaredTunnel || null);
        setActiveRuntimeSessionCount(payload?.activeRuntimeSessionCount);
        setRuntimeSessionBindingCount(payload?.runtimeSessionBindingCount);
        if (payload?.platform) setServerPlatform(payload.platform);
      }
      if (response.ok) noteFetchSuccess();
      return {
        ok: response.ok,
        status: response.status,
        payload,
        error: response.ok ? null : (payload?.error || 'Unauthorized'),
      };
    };

    const cookieResult = await requestStatus();
    if (cookieResult.ok) return cookieResult;
    const normalizedToken = String(tokenCandidate || '').trim();
    if (!normalizedToken) return cookieResult;
    if (cookieResult.status !== 401) return cookieResult;
    const tokenResult = await requestStatus({ Authorization: `Bearer ${normalizedToken}` });
    if (tokenResult?.ok) {
      return {
        ...tokenResult,
        source: 'token',
      };
    }
    return tokenResult;
  } catch (error) {
    noteFetchFailure('/api/status', error);
    return {
      ok: false,
      status: 0,
      payload: null,
      error: error?.message || 'Network error',
    };
  }
}

export async function verifyToken(token) {
  if (!networkRequestsEnabled) {
    return {
      ok: false,
      status: 0,
      payload: null,
      error: 'Network requests are paused',
    };
  }
  try {
    const response = await fetch(`${BASE}/api/status`, {
      signal: requestTimeoutSignal(),
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload) {
      updateWorkspaceRootHints(payload);
      setContextIndicatorMode(payload?.contextIndicatorMode);
      setCliOnline(!!payload?.cliOnline);
      setCloudflaredTunnelState(payload?.cloudflaredTunnel || null);
      setActiveRuntimeSessionCount(payload?.activeRuntimeSessionCount);
      setRuntimeSessionBindingCount(payload?.runtimeSessionBindingCount);
      if (payload?.platform) setServerPlatform(payload.platform);
    }
    if (response.ok) noteFetchSuccess();
    return {
      ok: response.ok,
      status: response.status,
      payload,
      error: response.ok ? null : (payload?.error || 'Unauthorized'),
    };
  } catch (error) {
    noteFetchFailure('/api/status', error);
    return {
      ok: false,
      status: 0,
      payload: null,
      error: error?.message || 'Network error',
    };
  }
}

export async function refreshWorkspaceRootHints() {
  const status = await apiFetch('/api/status');
  if (status) {
    updateWorkspaceRootHints(status);
    setContextIndicatorMode(status?.contextIndicatorMode);
    setCliOnline(!!status?.cliOnline);
    setCloudflaredTunnelState(status?.cloudflaredTunnel || null);
    setActiveRuntimeSessionCount(status?.activeRuntimeSessionCount);
    setRuntimeSessionBindingCount(status?.runtimeSessionBindingCount);
    if (status?.platform) setServerPlatform(status.platform);
  }
  return status;
}

export async function updateWorkspaceRoot(rootPath, conversationId = null) {
  const pathValue = String(rootPath || '').trim();
  if (!pathValue) return null;
  const convId = String(conversationId || '').trim();
  const endpoint = convId
    ? `/api/conversation/${encodeURIComponent(convId)}/workspace-root`
    : '/api/workspace-root';
  const response = await apiFetch(endpoint, {
    method: 'POST',
    body: JSON.stringify({ rootPath: pathValue }),
  });
  if (response && !convId) updateWorkspaceRootHints(response);
  return response;
}

export async function updateDefaultSessionWorkspaceRoot(rootPath, options = {}) {
  const clear = options?.clear === true;
  const pathValue = String(rootPath || '').trim();
  const response = await apiFetch('/api/settings/default-session-workspace-root', {
    method: 'POST',
    body: JSON.stringify({
      rootPath: clear ? '' : pathValue,
      clear,
    }),
  });
  if (response) updateWorkspaceRootHints(response);
  return response;
}

export async function loadOpenAISettings() {
  return apiFetch('/api/settings/openai');
}

export async function loadClaudeSettings() {
  return apiFetch('/api/settings/claude');
}

export async function updateClaudeSettings({
  enabled = undefined,
  model = undefined,
  enabledModels = undefined,
} = {}) {
  const payload = {};
  if (typeof enabled === 'boolean') payload.enabled = enabled;
  if (typeof model === 'string' && model.trim()) payload.model = model.trim();
  if (Array.isArray(enabledModels)) payload.enabledModels = enabledModels;
  if (!networkRequestsEnabled) return null;
  try {
    const response = await fetch(`${BASE}/api/settings/claude`, {
      signal: requestTimeoutSignal(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const message = String(result?.error || `Failed to update Claude settings (${response.status})`).trim();
      throw new Error(message);
    }
    noteFetchSuccess();
    return result;
  } catch (error) {
    noteFetchFailure('/api/settings/claude', error);
    throw error;
  }
}

// Claude account auth (Relogin / Logout). The relay answers failures with a
// useful `error` string (e.g. logout refused with 409 while a login is in
// flight), so these POSTs use the explicit fetch shape and surface that message
// instead of apiFetch's null-on-error.
async function claudeAuthRequest(path, body = null) {
  if (!networkRequestsEnabled) return null;
  try {
    const response = await fetch(`${BASE}${path}`, {
      signal: requestTimeoutSignal(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(String(result?.error || `Claude auth request failed (${response.status})`).trim());
    }
    noteFetchSuccess();
    return result;
  } catch (error) {
    noteFetchFailure(path, error);
    throw error;
  }
}

export async function getClaudeAuthStatus() {
  return apiFetch('/api/claude/auth/status');
}

export async function startClaudeLogin() {
  return claudeAuthRequest('/api/claude/auth/login/start');
}

// The pasted code is sent once and never stored, logged, or echoed back.
export async function submitClaudeLoginCode(code) {
  return claudeAuthRequest('/api/claude/auth/login/code', { code: String(code || '') });
}

export async function cancelClaudeLogin() {
  return claudeAuthRequest('/api/claude/auth/login/cancel');
}

export async function claudeLogout() {
  return claudeAuthRequest('/api/claude/auth/logout');
}

export async function loadGrokSettings() {
  return apiFetch('/api/settings/grok');
}

export async function updateGrokSettings({
  enabled = undefined,
  model = undefined,
  enabledModels = undefined,
} = {}) {
  const payload = {};
  if (typeof enabled === 'boolean') payload.enabled = enabled;
  if (typeof model === 'string' && model.trim()) payload.model = model.trim();
  if (Array.isArray(enabledModels)) payload.enabledModels = enabledModels;
  if (!networkRequestsEnabled) return null;
  try {
    const response = await fetch(`${BASE}/api/settings/grok`, {
      signal: requestTimeoutSignal(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const message = String(result?.error || `Failed to update Grok settings (${response.status})`).trim();
      throw new Error(message);
    }
    noteFetchSuccess();
    return result;
  } catch (error) {
    noteFetchFailure('/api/settings/grok', error);
    throw error;
  }
}

export async function updateOpenAISettings({
  apiKey = '',
  model = 'gpt-4o',
  baseUrl = undefined,
  enabled = undefined,
  remove = false,
} = {}) {
  const payload = {
    apiKey: String(apiKey || '').trim(),
    model: String(model || '').trim() || 'gpt-4o',
    remove: remove === true,
  };
  if (typeof baseUrl === 'string') payload.baseUrl = String(baseUrl).trim();
  if (typeof enabled === 'boolean') payload.enabled = enabled;
  if (!networkRequestsEnabled) return null;
  try {
    const response = await fetch(`${BASE}/api/settings/openai`, {
      signal: requestTimeoutSignal(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const message = String(result?.error || `Failed to update OpenAI settings (${response.status})`).trim();
      throw new Error(message);
    }
    noteFetchSuccess();
    return result;
  } catch (error) {
    noteFetchFailure('/api/settings/openai', error);
    throw error;
  }
}

export async function loadCursorSettings() {
  return apiFetch('/api/settings/cursor');
}

export async function updateCursorSettings({
  apiKey = '',
  model = undefined,
  enabled = undefined,
  enabledModels = undefined,
  remove = false,
} = {}) {
  const payload = {
    apiKey: String(apiKey || '').trim(),
    remove: remove === true,
  };
  // Only send the model when the caller chose one: an enabled-models-only save
  // must not reset the configured default model.
  if (typeof model === 'string' && model.trim()) payload.model = model.trim();
  if (typeof enabled === 'boolean') payload.enabled = enabled;
  if (Array.isArray(enabledModels)) payload.enabledModels = enabledModels;
  if (!networkRequestsEnabled) return null;
  try {
    const response = await fetch(`${BASE}/api/settings/cursor`, {
      signal: requestTimeoutSignal(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const message = String(result?.error || `Failed to update Cursor settings (${response.status})`).trim();
      throw new Error(message);
    }
    noteFetchSuccess();
    return result;
  } catch (error) {
    noteFetchFailure('/api/settings/cursor', error);
    throw error;
  }
}

export async function loadWindowsAutostartSetting() {
  return apiFetch('/api/settings/windows-autostart');
}

export async function updateWindowsAutostartSetting(enabled) {
  return apiFetch('/api/settings/windows-autostart', {
    method: 'POST',
    body: JSON.stringify({ enabled: !!enabled }),
  });
}

export async function loadTurnCeilingSetting() {
  return apiFetch('/api/settings/turn-ceiling');
}

export async function updateTurnCeilingSetting(ceilingMinutes) {
  return apiFetch('/api/settings/turn-ceiling', {
    method: 'POST',
    body: JSON.stringify({ ceilingMinutes: Number(ceilingMinutes) }),
  });
}

export async function loadBackgroundTaskTimeoutSetting() {
  return apiFetch('/api/settings/background-task-timeout');
}

export async function updateBackgroundTaskTimeoutSetting(timeoutMinutes) {
  return apiFetch('/api/settings/background-task-timeout', {
    method: 'POST',
    body: JSON.stringify({ timeoutMinutes: Number(timeoutMinutes) }),
  });
}

export async function launchSessionWorker(sdkSessionId) {
  const sessionId = String(sdkSessionId || '').trim();
  if (!sessionId) return null;
  return apiFetch(`/api/session-worker/${encodeURIComponent(sessionId)}/launch`, {
    method: 'POST',
  });
}

export async function relaunchSessionWorkerWithWorkspaceRoot(conversationId, rootPath, idempotencyKey = '') {
  const convId = String(conversationId || '').trim();
  const pathValue = String(rootPath || '').trim();
  if (!convId || !pathValue) return null;
  // One key per user gesture, so a duplicate delivery (retried fetch, second tab,
  // stray touch event) is provably the same request and the relay replays it
  // instead of running a second stop/spawn cycle.
  return apiFetch(`/api/conversation/${encodeURIComponent(convId)}/relaunch-with-workspace-root`, {
    method: 'POST',
    body: JSON.stringify({ rootPath: pathValue, idempotencyKey: String(idempotencyKey || '') }),
  });
}

export async function loadUsageSummary() {
  return apiFetch('/api/usage');
}

export async function loadCursorAllowanceSettings() {
  return apiFetch('/api/settings/cursor-allowance');
}

export async function updateCursorAllowanceSettings(payload = {}) {
  return apiFetch('/api/settings/cursor-allowance', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function loadCursorDashboardTokenSettings() {
  return apiFetch('/api/settings/cursor-dashboard-token');
}

export async function updateCursorDashboardTokenSettings(payload = {}) {
  return apiFetch('/api/settings/cursor-dashboard-token', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function loadGrokAllowanceSettings() {
  return apiFetch('/api/settings/grok-allowance');
}

export async function updateGrokAllowanceSettings(payload = {}) {
  return apiFetch('/api/settings/grok-allowance', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function loadContextSummary(convId = null) {
  const trimmedConvId = String(convId || '').trim();
  const lookupId = resolveContextLookupId(trimmedConvId);
  const endpoint = lookupId ? `/api/context/${encodeURIComponent(lookupId)}` : '/api/context';
  return apiFetch(endpoint);
}

function resolveContextLookupId(conversationId) {
  const convId = String(conversationId || '').trim();
  if (!convId) return '';
  const conversation = conversations[convId];
  const sdkSessionId = String(conversation?.sdkSessionId || conversation?.sdk_session_id || '').trim();
  return sdkSessionId || convId;
}

export async function loadModelCatalog() {
  return apiFetch('/api/models');
}

export async function loadModelVariantCatalog() {
  return apiFetch('/api/model-variants');
}

export async function refreshModelVariantCatalog() {
  return apiFetch('/api/model-variants/refresh', { method: 'POST' });
}

export async function saveEnabledModelVariants(enabledVariantIds = []) {
  return apiFetch('/api/model-variants', {
    method: 'PATCH',
    body: JSON.stringify({
      enabledVariantIds: Array.isArray(enabledVariantIds)
        ? enabledVariantIds.map((value) => String(value || '').trim()).filter(Boolean)
        : [],
    }),
  });
}

export async function loadConversations(options = {}) {
  const params = new URLSearchParams();
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 0));
  if (limit) params.set('limit', String(limit));
  const beforeConversationId = String(options.beforeConversationId || options.beforeId || '').trim();
  if (beforeConversationId) params.set('beforeConversationId', beforeConversationId);
  const beforeUpdatedAt = String(options.beforeUpdatedAt || '').trim();
  if (beforeUpdatedAt) params.set('beforeUpdatedAt', beforeUpdatedAt);
  const includeArchived = String(options.archived || '').trim().toLowerCase();
  if (includeArchived === 'true') params.set('archived', 'true');
  const query = params.toString();
  return apiFetch(`/api/conversations${query ? `?${query}` : ''}`);
}

export async function loadConversation(id, options = {}) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  const params = new URLSearchParams();
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 0));
  if (limit) params.set('limit', String(limit));
  const beforeMessageId = String(options.beforeMessageId || options.before || '').trim();
  if (beforeMessageId) params.set('beforeMessageId', beforeMessageId);
  const beforeTimestamp = String(options.beforeTimestamp || '').trim();
  if (beforeTimestamp) params.set('beforeTimestamp', beforeTimestamp);
  const afterMessageId = String(options.afterMessageId || options.after || '').trim();
  if (afterMessageId) params.set('afterMessageId', afterMessageId);
  const afterTimestamp = String(options.afterTimestamp || '').trim();
  if (afterTimestamp) params.set('afterTimestamp', afterTimestamp);
  const aroundMessageId = String(options.aroundMessageId || '').trim();
  if (aroundMessageId) params.set('aroundMessageId', aroundMessageId);
  const query = params.toString();
  return apiFetch(`/api/conversation/${convId}${query ? `?${query}` : ''}`);
}

export async function refreshConversationHistory(id, options = {}) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  const params = new URLSearchParams();
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 0));
  if (limit) params.set('limit', String(limit));
  const query = params.toString();
  return apiFetch(`/api/conversation/${convId}/refresh-history${query ? `?${query}` : ''}`, {
    method: 'POST',
  });
}

export async function searchMessages(options = {}) {
  const query = String(options.query || options.q || '').trim();
  if (!query) return null;
  const params = new URLSearchParams();
  params.set('q', query);
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 0));
  if (limit) params.set('limit', String(limit));
  const offset = Math.max(0, Math.trunc(Number(options.offset) || 0));
  if (offset) params.set('offset', String(offset));
  return apiFetch(`/api/search/messages?${params.toString()}`);
}

export async function deleteConversation(id) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  return apiFetch(`/api/conversation/${convId}`, { method: 'DELETE' });
}

export async function updateMessageShareVisibility(conversationId, messageId, hiddenFromShares) {
  const convId = String(conversationId || '').trim();
  const msgId = String(messageId || '').trim();
  if (!convId || !msgId) return null;
  return apiFetch(`/api/conversation/${encodeURIComponent(convId)}/message/${encodeURIComponent(msgId)}/share-visibility`, {
    method: 'PATCH',
    body: JSON.stringify({ hiddenFromShares: hiddenFromShares === true }),
  });
}

export async function updateConversationTitle(id, title) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  return apiFetch(`/api/conversation/${convId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export async function updateConversationPreferences(id, preferences = {}) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  return apiFetch(`/api/conversation/${convId}/preferences`, {
    method: 'PATCH',
    body: JSON.stringify(preferences || {}),
  });
}

export async function createConversationShareLink(id) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  return apiFetch(`/api/conversation/${encodeURIComponent(convId)}/share`, {
    method: 'POST',
  });
}

export async function loadServerStatusEventPage({ before = null, limit = 40 } = {}) {
  const params = new URLSearchParams();
  const pageSize = Math.max(1, Math.min(100, Math.trunc(Number(limit) || 40)));
  params.set('limit', String(pageSize));
  const beforeTimestamp = Number(before?.timestamp);
  const beforeId = String(before?.id || '').trim();
  if (Number.isFinite(beforeTimestamp) && beforeId) {
    params.set('beforeTimestamp', String(Math.trunc(beforeTimestamp)));
    params.set('beforeId', beforeId);
  }
  const payload = await apiFetch(`/api/status/events?${params.toString()}`);
  return {
    items: Array.isArray(payload?.items) ? payload.items : [],
    hasMore: payload?.hasMore === true,
    nextCursor: payload?.nextCursor || null,
  };
}

export async function loadSharedConversation(shareToken, options = {}) {
  const token = String(shareToken || '').trim().toLowerCase();
  if (!token) return { ok: false, status: 400, error: 'Missing shared token' };
  const params = new URLSearchParams();
  const limit = Math.max(1, Math.trunc(Number(options.limit) || 0));
  if (limit) params.set('limit', String(limit));
  const beforeMessageId = String(options.beforeMessageId || options.before || '').trim();
  if (beforeMessageId) params.set('beforeMessageId', beforeMessageId);
  const beforeTimestamp = String(options.beforeTimestamp || '').trim();
  if (beforeTimestamp) params.set('beforeTimestamp', beforeTimestamp);
  const afterMessageId = String(options.afterMessageId || options.after || '').trim();
  if (afterMessageId) params.set('afterMessageId', afterMessageId);
  const afterTimestamp = String(options.afterTimestamp || '').trim();
  if (afterTimestamp) params.set('afterTimestamp', afterTimestamp);
  const aroundMessageId = String(options.aroundMessageId || '').trim();
  if (aroundMessageId) params.set('aroundMessageId', aroundMessageId);
  const query = params.toString();
  try {
    const response = await fetch(`${BASE}/api/shared/${encodeURIComponent(token)}${query ? `?${query}` : ''}`, {
      signal: requestTimeoutSignal(),
      headers: { 'Content-Type': 'application/json' },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: payload?.error || `Shared conversation request failed (${response.status})`,
      };
    }
    return {
      ok: true,
      status: response.status,
      ...(payload && typeof payload === 'object' ? payload : {}),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error?.message || 'Network error',
    };
  }
}

export async function reportSharedViewerPresence(shareToken, viewerId) {
  const token = String(shareToken || '').trim().toLowerCase();
  const viewer = String(viewerId || '').trim();
  if (!token || !viewer) return { ok: false, status: 400, error: 'Missing shared presence payload' };
  try {
    const response = await fetch(`${BASE}/api/shared/${encodeURIComponent(token)}/presence`, {
      signal: requestTimeoutSignal(),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerId: viewer }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: payload?.error || `Shared presence request failed (${response.status})`,
      };
    }
    return {
      ok: true,
      status: response.status,
      ...(payload && typeof payload === 'object' ? payload : {}),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error?.message || 'Network error',
    };
  }
}

export async function updateConversationDraft(id, draft = {}) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  try {
    const response = await fetch(`${BASE}/api/conversation/${convId}/draft`, {
      signal: requestTimeoutSignal(),
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
      },
      body: JSON.stringify(draft || {}),
    });
    const payload = await response.json().catch(() => null);
    if (response.ok) return payload;
    return {
      ok: false,
      status: response.status,
      ...(payload && typeof payload === 'object' ? payload : {}),
    };
  } catch (error) {
    console.error('Fetch error', error);
    return { ok: false, error: error?.message || 'Network error' };
  }
}

export async function compactConversation(id) {
  const convId = String(id || '').trim();
  if (!convId) return null;
  return apiFetch(`/api/conversation/${convId}/compact`, { method: 'POST' });
}

export async function killSessionWorker(sdkSessionId, body = {}) {
  const sessionId = String(sdkSessionId || '').trim();
  if (!sessionId) return null;
  return apiFetch(`/api/session-worker/${encodeURIComponent(sessionId)}/kill`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
}

export async function requestRelayRestart(body = {}) {
  return apiFetch('/api/relay/shutdown', {
    method: 'POST',
    body: JSON.stringify({
      reason: 'manual-restart',
      requestedBy: 'localhost-api',
      restart: true,
      ...(body || {}),
    }),
  });
}

export async function requestHostSuspend(body = {}) {
  return apiFetch('/api/host/suspend', {
    method: 'POST',
    body: JSON.stringify({
      reason: 'manual-suspend',
      requestedBy: 'localhost-api',
      ...(body || {}),
    }),
  });
}

export async function requestQueueEmpty(body = {}) {
  return apiFetch('/api/queue/empty', {
    method: 'POST',
    body: JSON.stringify({
      reason: 'manual-empty-queue',
      requestedBy: 'localhost-api',
      ...(body || {}),
    }),
  });
}

export async function sendMessage(body) {
  return apiFetch('/api/message', { method: 'POST', body: JSON.stringify(body) });
}

// Raw fetch instead of apiFetch: a rejected bootstrap (bad CWD, unavailable
// model) must surface the server's error message so the New Chat modal can
// show it and keep the user's selection editable.
export async function bootstrapConversationSession(body = {}) {
  if (!areNetworkRequestsEnabled()) return null;
  const response = await fetch(`${BASE}/api/conversation/bootstrap`, {
    signal: requestTimeoutSignal(LONG_REQUEST_TIMEOUT_MS),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = String(payload?.error || '').trim();
    const error = new Error(message || `Could not start a new conversation session (HTTP ${response.status}).`);
    // The conversation may already be committed (worker prestart failed after
    // it was created); the caller needs the payload to open it instead of
    // leaving an unreachable row behind.
    error.status = response.status;
    error.payload = payload || null;
    throw error;
  }
  return payload;
}

export async function cancelConversationTurn(conversationId, body = {}) {
  const convId = String(conversationId || '').trim();
  if (!convId) return null;
  return apiFetch(`/api/conversation/${encodeURIComponent(convId)}/cancel-turn`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
}

export async function cancelQueuedConversationTurn(conversationId, body = {}) {
  const convId = String(conversationId || '').trim();
  if (!convId) return null;
  return apiFetch(`/api/conversation/${encodeURIComponent(convId)}/cancel-queued-turn`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
}

export async function cancelSubagentRun(conversationId, subagentRunId, body = {}) {
  const convId = String(conversationId || '').trim();
  const runId = String(subagentRunId || '').trim();
  if (!convId || !runId) return null;
  return apiFetch(`/api/conversation/${encodeURIComponent(convId)}/subagent/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify(body || {}),
  });
}

export async function loadRelayQuestions(status = 'pending') {
  return apiFetch(`/api/relay-questions?status=${encodeURIComponent(status)}`);
}

export async function loadRelayQuestion(questionId) {
  const id = String(questionId || '').trim();
  if (!id) return null;
  return apiFetch(`/api/relay-question/${encodeURIComponent(id)}`);
}

export async function answerRelayQuestion(questionId, answer, sdkSessionId = null) {
  const id = String(questionId || '').trim();
  if (!id) return null;
  const sessionId = String(sdkSessionId || '').trim();
  return apiFetch(`/api/relay-question/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    body: JSON.stringify({ answer, sdk_session_id: sessionId || undefined }),
  });
}

export async function answerRelayQuestionStructured(questionId, structuredAnswer, sdkSessionId = null) {
  const id = String(questionId || '').trim();
  if (!id) return { ok: false, error: 'Missing question id' };
  const sessionId = String(sdkSessionId || '').trim();
  try {
    const response = await fetch(`${BASE}/api/relay-question/${encodeURIComponent(id)}/answer`, {
      signal: requestTimeoutSignal(),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ structuredAnswer, sdk_session_id: sessionId || undefined }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, error: data?.error || `Request failed (${response.status})`, fields: data?.fields || null };
    }
    return { ok: true, question: data?.question || null };
  } catch (error) {
    return { ok: false, error: error?.message || 'Network error' };
  }
}

export async function loadRelayBoards(status = 'pending') {
  return apiFetch(`/api/relay-boards?status=${encodeURIComponent(status)}`);
}

export async function loadRelayBoard(boardId) {
  const id = String(boardId || '').trim();
  if (!id) return null;
  return apiFetch(`/api/relay-board/${encodeURIComponent(id)}`);
}

export async function submitRelayBoardAction(boardId, actionId) {
  const id = String(boardId || '').trim();
  const action = String(actionId || '').trim();
  if (!id || !action) return null;
  return apiFetch(`/api/relay-board/${encodeURIComponent(id)}/action`, {
    method: 'POST',
    body: JSON.stringify({ actionId: action }),
  });
}

export async function uploadAttachment(item) {
  if (!item?.file) return null;
  const response = await fetch(`${BASE}/api/upload`, {
    signal: requestTimeoutSignal(LONG_REQUEST_TIMEOUT_MS),
    method: 'POST',
    headers: {
      ...authHeaders(),
      'X-File-Name': encodeURIComponent(String(item.name || item.file.name || 'upload')),
      'X-File-Type': String(item.type || item.file.type || 'application/octet-stream'),
    },
    body: item.file,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Upload failed (${response.status})`);
  }
  return response.json();
}

export async function loadRepoTree(includeHidden = false, includeHeavy = false, conversationId = null) {
  const params = new URLSearchParams({
    includeHidden: includeHidden ? '1' : '0',
    includeHeavy: includeHeavy ? '1' : '0',
  });
  const convId = String(conversationId || '').trim();
  if (convId) params.set('conversationId', convId);
  return apiFetch(`/api/repo/tree?${params.toString()}`);
}

export async function loadRepoChildren(pathValue = '', includeHidden = false, includeHeavy = false, conversationId = null) {
  const params = new URLSearchParams({
    path: String(pathValue || '').trim(),
    includeHidden: includeHidden ? '1' : '0',
    includeHeavy: includeHeavy ? '1' : '0',
  });
  const convId = String(conversationId || '').trim();
  if (convId) params.set('conversationId', convId);
  return apiFetch(`/api/repo/list?${params.toString()}`);
}

export async function loadDrivesRoots() {
  return apiFetch('/api/drives/roots');
}

export async function loadDriveChildren(pathValue, includeHidden = false) {
  const path = String(pathValue || '').trim();
  if (!path) return null;
  return apiFetch(`/api/drives/list?path=${encodeURIComponent(path)}&includeHidden=${includeHidden ? '1' : '0'}`);
}

// Distinct from loadDriveChildren: the session root may not exist on disk yet,
// and its listing is augmented with the transcript that lives one level up.
export async function loadSessionRootTree(pathValue, includeHidden = false) {
  const path = String(pathValue || '').trim();
  if (!path) return null;
  return apiFetch(`/api/session-root/list?path=${encodeURIComponent(path)}&includeHidden=${includeHidden ? '1' : '0'}`);
}

export async function loadWorkspaceFilePreview(pathValue, conversationId = null) {
  const path = String(pathValue || '').trim();
  if (!path) return null;
  const encodedPath = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const convId = String(conversationId || '').trim();
  const suffix = convId ? `?conversationId=${encodeURIComponent(convId)}` : '';
  return apiFetch(`/api/files-preview/${encodedPath}${suffix}`);
}

export async function loadGitStatus(conversationId = null) {
  const params = new URLSearchParams();
  const convId = String(conversationId || '').trim();
  if (convId) params.set('conversationId', convId);
  const suffix = params.toString();
  return apiFetch(`/api/git/status${suffix ? `?${suffix}` : ''}`);
}

export async function loadGitDiff(pathValue, { conversationId = null, untracked = false } = {}) {
  const path = String(pathValue || '').trim();
  if (!path) return null;
  const params = new URLSearchParams();
  params.set('path', path);
  if (untracked) params.set('untracked', '1');
  const convId = String(conversationId || '').trim();
  if (convId) params.set('conversationId', convId);
  return apiFetch(`/api/git/diff?${params.toString()}`);
}

export async function requestGitPull(conversationId = null) {
  const params = new URLSearchParams();
  const convId = String(conversationId || '').trim();
  if (convId) params.set('conversationId', convId);
  const suffix = params.toString();
  const response = await fetch(`${BASE}/api/git/pull${suffix ? `?${suffix}` : ''}`, {
    signal: requestTimeoutSignal(LONG_REQUEST_TIMEOUT_MS),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
  }).catch(() => null);
  if (!response) return { ok: false, error: 'Network error' };
  const payload = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, error: payload?.error || `Pull failed (${response.status})` };
  return payload || { ok: false, error: 'Empty response' };
}

export async function loadDriveFilePreview(pathValue) {
  const path = String(pathValue || '').trim();
  if (!path) return null;
  return apiFetch(`/api/drives/files-preview?path=${encodeURIComponent(path)}`);
}

let contextUsageRefreshTimer = null;
let contextUsageRefreshSeq = 0;

export function scheduleContextUsageRefresh(conversationId, delayMs = 0) {
  if (contextUsageRefreshTimer) {
    clearTimeout(contextUsageRefreshTimer);
    contextUsageRefreshTimer = null;
  }

  const convId = String(conversationId || '').trim();
  if (!convId) {
    contextUsageRefreshSeq += 1;
    applyContextUsageBar(null);
    return;
  }

  const seq = ++contextUsageRefreshSeq;
  const waitMs = Math.max(0, Number(delayMs) || 0);
  contextUsageRefreshTimer = setTimeout(() => {
    contextUsageRefreshTimer = null;
    void refreshContextUsageBar(convId, seq);
  }, waitMs);
}

export async function refreshContextUsageBar(conversationId, requestSeq = ++contextUsageRefreshSeq) {
  const convId = String(conversationId || '').trim();
  if (!convId) {
    applyContextUsageBar(null);
    return;
  }
  const lookupId = resolveContextLookupId(convId) || convId;
  // Callers fire this without awaiting, so a rejection here would surface as an
  // unhandled rejection. A miss is routine (a conversation with no turns yet):
  // leave the bar as-is rather than blanking it.
  let payload = null;
  try {
    payload = await apiFetch(`/api/context/${encodeURIComponent(lookupId)}`);
  } catch {
    return;
  }
  if (!payload) return;
  if (requestSeq !== contextUsageRefreshSeq) return;
  if (String(currentConvId || '').trim() !== convId) return;
  applyContextUsageBar(readContextUsageRatio(payload));
}
