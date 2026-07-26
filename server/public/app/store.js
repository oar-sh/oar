import { recordCliLifecycleEvent, recordRelayLifecycleEvent } from './status-store.mjs';

function resolveAppBase() {
  const configuredBase = typeof window.__COPILOT_APP_CONFIG?.basePath === 'string'
    ? window.__COPILOT_APP_CONFIG.basePath.trim()
    : '';
  if (configuredBase && configuredBase !== '/') {
    return configuredBase.startsWith('/') ? configuredBase.replace(/\/+$/, '') : `/${configuredBase.replace(/\/+$/, '')}`;
  }
  const pathname = String(window.location.pathname || '/');
  const sharedIndex = pathname.indexOf('/shared/');
  if (sharedIndex >= 0) return pathname.slice(0, sharedIndex).replace(/\/+$/, '');
  return pathname.replace(/\/+$/, '');
}

export const BASE = resolveAppBase();
function extractSharedTokenFromPathname(pathname) {
  const path = String(pathname || '/');
  const match = path.match(/\/shared\/([^/?#]+)\/?$/i);
  if (!match) return '';
  return String(match[1] || '').trim().toLowerCase();
}

function resolveSharedConversationToken() {
  const configured = String(window.__COPILOT_APP_CONFIG?.sharedToken || '').trim().toLowerCase();
  if (configured) return configured;
  return extractSharedTokenFromPathname(window.location.pathname);
}
export const SHARED_CONVERSATION_TOKEN = resolveSharedConversationToken();
export const IS_SHARED_VIEW = !!SHARED_CONVERSATION_TOKEN;
export let TOKEN = '';
export let socket = null;
export let currentConvId = null;
let clientIdStorageValue = '';
try {
  clientIdStorageValue = sessionStorage.getItem('copilot_client_id') || '';
} catch {
  clientIdStorageValue = '';
}
export let CLIENT_ID = clientIdStorageValue;
if (!CLIENT_ID) {
  CLIENT_ID = generateId();
  try {
    sessionStorage.setItem('copilot_client_id', CLIENT_ID);
  } catch {}
}

export const seenMessageIds = new Set();
export const pendingUserMessageIds = new Set();
export const pendingUserMessageEntries = new Map();
export let cliOnline = false;
export let relayOnline = false;
export let activeRuntimeSessionCount = 0;
export let runtimeSessionBindingCount = 0;
export let conversations = {};
export let selectedAttachments = [];
export let imageEditTarget = null;
export const RELAY_QUESTION_POLL_MS = 3000;
export const MAX_UPLOAD_ATTACHMENTS = 6;
export const FILE_PREVIEW_MAX_BYTES = 512 * 1024;
export const REPO_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);
export const WORKSPACE_FILE_EXTENSIONS = new Set([
  'md', 'txt', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'xml', 'yml', 'yaml',
  'toml', 'ini', 'csv', 'sql', 'ps1', 'sh', 'bat', 'go', 'py', 'java', 'rb', 'php', 'c', 'h', 'cpp',
  'hpp', 'rs', 'lock', 'log', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf',
]);
export let serverPlatform = '';
export let workspaceRootName = '';
export let workspaceRootPath = '';
export let defaultSessionWorkspaceRootPath = '';
export let defaultSessionWorkspaceRootWarning = '';
export let workspaceRootEntrySet = new Set([
  '.github',
  'server',
  'tests',
  'readme.md',
  'package.json',
  'package-lock.json',
]);
export let recentWorkspaceRoots = [];
export let relayQuestions = new Map();
export let relayBoards = new Map();
export let relayActivities = new Map();
export let relayThoughts = new Map();
export let conversationWatcherCounts = new Map();
export let sessionWorkerStates = new Map();
export let subagentRuns = new Map();
export const subagentCancelInFlight = new Set();
export let thinkingMessageId = null;
export let relayQuestionPollTimer = null;
export let relayQuestionRenderHash = '';
export let relayQuestionDrafts = new Map();
export let selectedAttachmentsState = selectedAttachments;
export let filePreviewState = {
  path: '',
  source: 'workspace',
  mode: 'preview',
  allowHtml: true,
  loading: false,
  error: '',
  payload: null,
  viewerOptions: {
    startSeconds: 0,
    preload: 'metadata',
    autoplay: false,
  },
};
export let repoBrowserState = {
  open: false,
  loading: false,
  activeRoot: 'workspace',
  workspaceIncludeHidden: false,
  workspaceIncludeHeavy: false,
  drivesIncludeHidden: false,
  viewMode: 'list',
  rootName: 'repo',
  sessionRootPath: '',
  sessionRootName: 'Session',
  tree: null,
  nodeMap: new Map(),
  expandedPaths: new Set(),
  collapsedPaths: new Set(),
  currentPath: '',
  truncated: false,
  nodeCount: 0,
  maxNodes: 0,
  loadingPath: '',
  error: '',
};
export let contextUsageRefreshTimer = null;
export let contextUsageRefreshSeq = 0;
export let contextIndicatorMode = 'bar';
export let compactInFlight = false;
export let deferredInstallPrompt = null;
export let viewportBaseHeight = window.innerHeight || document.documentElement.clientHeight || 0;
export let historyRefreshInFlight = false;
const SIDEBAR_WIDTH_PERCENT_MIN = 10;
const SIDEBAR_WIDTH_PERCENT_MAX = 50;
const SIDEBAR_WIDTH_PERCENT_FALLBACK = 24;
const SIDEBAR_WIDTH_PORTRAIT_STORAGE_KEY = 'copilot_sidebar_width_pct_portrait';
const SIDEBAR_WIDTH_LANDSCAPE_STORAGE_KEY = 'copilot_sidebar_width_pct_landscape';
const SIDEBAR_COLLAPSED_DESKTOP_STORAGE_KEY = 'copilot_sidebar_collapsed_desktop';
let sidebarWidthPercent = SIDEBAR_WIDTH_PERCENT_FALLBACK;
const CONVERSATION_SCROLL_STORAGE_PREFIX = 'copilot_message_scroll_';

if (globalThis.marked && typeof globalThis.marked.setOptions === 'function') {
  globalThis.marked.setOptions({ breaks: true });
} else {
  console.warn('[store] marked unavailable; markdown rendering will use plain-text fallback.');
}

export function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export function setCurrentConv(id) {
  currentConvId = id;
  if (id) localStorage.setItem('copilot_last_conv', id);
  else localStorage.removeItem('copilot_last_conv');
  updateCompactButton();
}

export function setConversationWatcherCount(conversationId, count) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const next = Number.isFinite(Number(count)) ? Math.max(0, Math.trunc(Number(count))) : 0;
  if (next <= 0) {
    conversationWatcherCounts.delete(id);
    return;
  }
  conversationWatcherCounts.set(id, next);
}

export function getConversationWatcherCount(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return 0;
  return Number(conversationWatcherCounts.get(id) || 0);
}

function conversationScrollStorageKey(conversationId) {
  const id = String(conversationId || '').trim();
  return id ? `${CONVERSATION_SCROLL_STORAGE_PREFIX}${id}` : '';
}

function readConversationViewState(conversationId) {
  const key = conversationScrollStorageKey(conversationId);
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return {
        scrollTop: Number.isFinite(Number(parsed.scrollTop)) && Number(parsed.scrollTop) >= 0
          ? Math.trunc(Number(parsed.scrollTop))
          : null,
        loadedMessageCount: Number.isFinite(Number(parsed.loadedMessageCount)) && Number(parsed.loadedMessageCount) >= 0
          ? Math.trunc(Number(parsed.loadedMessageCount))
          : null,
      };
    }
  } catch {
    // Legacy numeric storage falls through below.
  }
  const legacyScrollTop = Number(trimmed);
  if (!Number.isFinite(legacyScrollTop) || legacyScrollTop < 0) return null;
  return {
    scrollTop: Math.trunc(legacyScrollTop),
    loadedMessageCount: null,
  };
}

function writeConversationViewState(conversationId, nextState = {}) {
  const key = conversationScrollStorageKey(conversationId);
  if (!key) return false;
  const current = readConversationViewState(conversationId) || {};
  const next = {
    scrollTop: Number.isFinite(Number(nextState.scrollTop)) && Number(nextState.scrollTop) >= 0
      ? Math.trunc(Number(nextState.scrollTop))
      : current.scrollTop ?? null,
    loadedMessageCount: Number.isFinite(Number(nextState.loadedMessageCount)) && Number(nextState.loadedMessageCount) >= 0
      ? Math.trunc(Number(nextState.loadedMessageCount))
      : current.loadedMessageCount ?? null,
  };
  localStorage.setItem(key, JSON.stringify(next));
  return true;
}

export function saveConversationScrollTop(conversationId, scrollTop) {
  const value = Number(scrollTop);
  if (!Number.isFinite(value) || value < 0) return false;
  try {
    window.__scrollSaveDebug = {
      conversationId: String(conversationId || '').trim() || null,
      scrollTop: Math.trunc(value),
      at: Date.now(),
      stack: String(new Error().stack || '')
        .split('\n')
        .slice(1, 4)
        .map((line) => line.trim()),
    };
  } catch {}
  return writeConversationViewState(conversationId, { scrollTop: value });
}

export function saveConversationLoadedMessageCount(conversationId, loadedMessageCount) {
  const value = Number(loadedMessageCount);
  if (!Number.isFinite(value) || value < 0) return false;
  return writeConversationViewState(conversationId, { loadedMessageCount: value });
}

export function loadConversationScrollTop(conversationId) {
  return readConversationViewState(conversationId)?.scrollTop ?? null;
}

export function loadConversationLoadedMessageCount(conversationId) {
  return readConversationViewState(conversationId)?.loadedMessageCount ?? null;
}

function normalizePendingMessageText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function pendingConversationKey(conversationId) {
  return String(conversationId || '').trim() || '__new__';
}

function cleanupStalePendingUserMessages(maxAgeMs = 15 * 60 * 1000) {
  const cutoff = Date.now() - Math.max(60_000, Number(maxAgeMs) || 0);
  for (const [messageId, entry] of pendingUserMessageEntries.entries()) {
    const addedAt = Number(entry?.addedAt || 0);
    if (!Number.isFinite(addedAt) || addedAt < cutoff) {
      pendingUserMessageEntries.delete(messageId);
      pendingUserMessageIds.delete(messageId);
    }
  }
}

export function trackPendingUserMessage(messageId, conversationId, text) {
  const id = String(messageId || '').trim();
  const fingerprint = normalizePendingMessageText(text);
  if (!id || !fingerprint) return false;
  cleanupStalePendingUserMessages();
  pendingUserMessageEntries.set(id, {
    conversationKey: pendingConversationKey(conversationId),
    fingerprint,
    addedAt: Date.now(),
  });
  pendingUserMessageIds.add(id);
  return true;
}

export function clearPendingUserMessage(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return false;
  pendingUserMessageIds.delete(id);
  return pendingUserMessageEntries.delete(id);
}

export function hasPendingUserMessageDuplicate(conversationId, text) {
  const fingerprint = normalizePendingMessageText(text);
  if (!fingerprint) return false;
  cleanupStalePendingUserMessages();
  const conversationKey = pendingConversationKey(conversationId);
  for (const entry of pendingUserMessageEntries.values()) {
    if (entry?.conversationKey === conversationKey && entry?.fingerprint === fingerprint) {
      return true;
    }
  }
  return false;
}

export function authHeaders() {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

export function setToken(value) {
  TOKEN = String(value || '').trim();
}

export function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  const rounded = idx === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[idx]}`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const timestampMs = parseTimestampMs(iso);
  if (!timestampMs) return '';
  const d = new Date(timestampMs);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export function parseTimestampMs(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const sqliteUtcLike = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)$/;
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  let normalized = text;
  if (!hasExplicitTimezone && sqliteUtcLike.test(text)) {
    const [, day, time] = text.match(sqliteUtcLike) || [];
    normalized = `${day}T${time}Z`;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function setServerPlatform(value) {
  serverPlatform = String(value || '').trim().toLowerCase();
}

export function updateWorkspaceRootHints(payload) {
  const normalizedPayload = payload && typeof payload === 'object' ? payload : {};
  if (Object.prototype.hasOwnProperty.call(normalizedPayload, 'workspaceRootName')) {
    workspaceRootName = String(normalizedPayload.workspaceRootName || '').trim().toLowerCase();
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPayload, 'workspaceRootPath')) {
    workspaceRootPath = String(normalizedPayload.workspaceRootPath || '').trim();
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPayload, 'defaultSessionWorkspaceRootPath')
      || Object.prototype.hasOwnProperty.call(normalizedPayload, 'default_session_workspace_root_path')) {
    defaultSessionWorkspaceRootPath = String(
      normalizedPayload.defaultSessionWorkspaceRootPath
      ?? normalizedPayload.default_session_workspace_root_path
      ?? '',
    ).trim();
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPayload, 'defaultSessionWorkspaceRootWarning')
      || Object.prototype.hasOwnProperty.call(normalizedPayload, 'default_session_workspace_root_warning')) {
    defaultSessionWorkspaceRootWarning = String(
      normalizedPayload.defaultSessionWorkspaceRootWarning
      ?? normalizedPayload.default_session_workspace_root_warning
      ?? '',
    ).trim();
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPayload, 'workspaceRootEntries')) {
    const entries = Array.isArray(normalizedPayload.workspaceRootEntries) ? normalizedPayload.workspaceRootEntries : [];
    workspaceRootEntrySet = new Set(entries.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean));
  }
  const recentRoots = Array.isArray(normalizedPayload.recentWorkspaceRoots)
    ? normalizedPayload.recentWorkspaceRoots
    : (Array.isArray(normalizedPayload.recentCwds) ? normalizedPayload.recentCwds : null);
  if (Array.isArray(recentRoots)) {
    const deduped = [];
    const seen = new Set();
    for (const candidate of recentRoots) {
      const text = String(candidate || '').trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(text);
    }
    recentWorkspaceRoots = deduped;
  }
}

export function getRecentWorkspaceRoots() {
  return recentWorkspaceRoots.slice();
}

export function getConversationWorkspaceState(conversationId = currentConvId) {
  const convId = String(conversationId || '').trim();
  if (!convId) return null;
  const conversation = conversations?.[convId] || null;
  if (!conversation) return null;
  const configuredWorkspaceRootPath = String(
    conversation.configuredWorkspaceRootPath || conversation.configured_workspace_root_path || '',
  ).trim();
  const configuredWorkspaceRootName = String(
    conversation.configuredWorkspaceRootName || conversation.configured_workspace_root_name || '',
  ).trim();
  const runtimeWorkspaceRootPath = String(
    conversation.runtimeWorkspaceRootPath || conversation.runtime_workspace_root_path || '',
  ).trim();
  const runtimeWorkspaceRootName = String(
    conversation.runtimeWorkspaceRootName || conversation.runtime_workspace_root_name || '',
  ).trim();
  const currentWorkspaceRootPath = String(
    conversation.currentWorkspaceRootPath || conversation.current_workspace_root_path || runtimeWorkspaceRootPath || configuredWorkspaceRootPath || '',
  ).trim();
  const currentWorkspaceRootName = String(
    conversation.currentWorkspaceRootName || conversation.current_workspace_root_name || runtimeWorkspaceRootName || configuredWorkspaceRootName || '',
  ).trim();
  return {
    configuredWorkspaceRootPath,
    configuredWorkspaceRootName,
    runtimeWorkspaceRootPath,
    runtimeWorkspaceRootName,
    currentWorkspaceRootPath,
    currentWorkspaceRootName,
  };
}

export function getConversationCurrentWorkspaceRootPath(conversationId = currentConvId) {
  return String(getConversationWorkspaceState(conversationId)?.currentWorkspaceRootPath || '').trim();
}

export function setActiveRuntimeSessionCount(value) {
  const numeric = Number(value);
  activeRuntimeSessionCount = Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
  updateCliStatus();
}

export function setRuntimeSessionBindingCount(value) {
  const numeric = Number(value);
  runtimeSessionBindingCount = Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
  updateCliStatus();
}

export function clampContextUsageRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

export function readContextUsageRatio(payload) {
  const snapshot = payload?.snapshot && typeof payload.snapshot === 'object' ? payload.snapshot : null;
  if (!snapshot) return null;
  const usedPct = Number(snapshot.used_percent);
  if (Number.isFinite(usedPct)) {
    return clampContextUsageRatio(usedPct / 100);
  }
  const usedTotal = Number(snapshot.used_total_tokens);
  const maxTokens = Number(snapshot.max_context_tokens);
  if (Number.isFinite(usedTotal) && Number.isFinite(maxTokens) && maxTokens > 0) {
    return clampContextUsageRatio(usedTotal / maxTokens);
  }
  return null;
}

export function normalizeContextIndicatorMode(value) {
  return String(value || '').trim().toLowerCase() === 'bar' ? 'bar' : 'default';
}

export function setContextIndicatorMode(mode) {
  contextIndicatorMode = normalizeContextIndicatorMode(mode);
  const inputArea = document.getElementById('input-area');
  if (!inputArea) return;
  inputArea.classList.toggle('ctx-indicator-bar', contextIndicatorMode === 'bar');
}

export function applyContextUsageBar(ratio) {
  const inputArea = document.getElementById('input-area');
  if (!inputArea) return;

  const normalized = clampContextUsageRatio(ratio);
  if (normalized === null) {
    inputArea.style.setProperty('--context-usage-bar', 'linear-gradient(90deg, rgba(139,148,158,0.65) 0%, rgba(139,148,158,0.95) 50%, rgba(139,148,158,0.65) 100%)');
    inputArea.style.setProperty('--context-usage-glow', 'rgba(139,148,158,0.35)');
    inputArea.style.setProperty('--context-usage-opacity', '0.62');
    inputArea.style.setProperty('--context-usage-ratio', '0');
    inputArea.style.setProperty('--context-usage-hue', '120');
    delete inputArea.dataset.contextUsageRatio;
    return;
  }

  const hue = Math.round((1 - normalized) * 120);
  const lightness = 49 - Math.round(normalized * 8);
  const baseColor = `hsl(${hue}, 88%, ${lightness}%)`;
  const shineAlpha = (0.44 + (normalized * 0.18)).toFixed(2);
  const glowAlpha = Math.min(0.86, 0.42 + (normalized * 0.28)).toFixed(2);
  inputArea.style.setProperty(
    '--context-usage-bar',
    `linear-gradient(90deg, rgba(255,255,255,0.16) 0%, ${baseColor} 24%, rgba(255,255,255,${shineAlpha}) 50%, ${baseColor} 76%, rgba(255,255,255,0.16) 100%)`
  );
  inputArea.style.setProperty('--context-usage-glow', `hsla(${hue}, 88%, 52%, ${glowAlpha})`);
  inputArea.style.setProperty('--context-usage-opacity', '0.98');
  inputArea.style.setProperty('--context-usage-ratio', normalized.toFixed(4));
  inputArea.style.setProperty('--context-usage-hue', String(hue));
  inputArea.dataset.contextUsageRatio = normalized.toFixed(4);
}

export function scrollBottom() {
  const el = document.getElementById('messages');
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  saveConversationScrollTop(currentConvId, el.scrollTop);
}

export function getMessagesDistanceFromBottom() {
  const el = document.getElementById('messages');
  if (!el) return null;
  return Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
}

function resolveMessagesNearBottomThreshold(el, thresholdPx = null) {
  if (Number.isFinite(Number(thresholdPx)) && Number(thresholdPx) >= 0) {
    return Math.trunc(Number(thresholdPx));
  }
  const viewportHeight = Number(el?.clientHeight || 0);
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0;
  const relativeThreshold = Math.floor(viewportHeight * 0.08);
  return Math.min(48, Math.max(12, relativeThreshold));
}

export function isMessagesNearBottom(thresholdPx = null) {
  const el = document.getElementById('messages');
  if (!el) return true;
  const distance = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
  const threshold = resolveMessagesNearBottomThreshold(el, thresholdPx);
  return distance <= threshold;
}

export function isMessagesAtBottom(epsilonPx = 1) {
  const el = document.getElementById('messages');
  if (!el) return true;
  const epsilon = Math.max(0, Number.isFinite(Number(epsilonPx)) ? Number(epsilonPx) : 1);
  const distance = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
  return distance <= epsilon;
}

export function scrollBottomAfterSend() {
  scrollBottom();
  requestAnimationFrame(() => {
    scrollBottom();
  });
  setTimeout(() => {
    scrollBottom();
  }, 120);
}

export function isMobileComposerViewport() {
  return window.matchMedia('(max-width: 680px)').matches;
}

export function releaseComposerFocusAfterSend(input) {
  if (!input || !isMobileComposerViewport()) return;
  try { input.blur(); } catch {}
  document.body.classList.remove('keyboard-open');
  syncViewportMetrics();
}

export function autoResize(el) {
  el.style.height = 'auto';
  const maxHeight = Number.parseFloat(globalThis.getComputedStyle?.(el)?.maxHeight || '');
  const cap = Number.isFinite(maxHeight) && maxHeight > 0 ? maxHeight : 160;
  el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  syncViewportMetrics();
}

export function updateSessionPill(conversation, runtimeSession) {
  const title = document.getElementById('chat-title');
  const usageLine = document.getElementById('chat-title-session-usage');
  const sdkSessionId = String(
    runtimeSession?.sdkSessionId
    || runtimeSession?.sdk_session_id
    || conversation?.sdkSessionId
    || conversation?.sdk_session_id
    || '',
  ).trim();
  if (!sdkSessionId) {
    if (title) {
      delete title.dataset.copilotSessionId;
      title.title = '';
    }
    if (usageLine) {
      usageLine.textContent = '';
      usageLine.hidden = true;
    }
    return;
  }
  if (title) {
    title.dataset.copilotSessionId = sdkSessionId;
    title.title = `Copilot session ${sdkSessionId} (click to copy)`;
  }

  const usageSummary = runtimeSession?.sessionUsageSummary
    || runtimeSession?.session_usage_summary
    || conversation?.sessionUsageSummary
    || conversation?.session_usage_summary
    || null;
  const aicUsed = Number(usageSummary?.aicUsed ?? usageSummary?.aic_used);
  const premiumRequests = Number(usageSummary?.totalPremiumRequests ?? usageSummary?.total_premium_requests);
  const planCreditsUsed = Number(usageSummary?.planCreditsUsed ?? usageSummary?.plan_credits_used);
  const planMonthlyPercentUsed = Number(usageSummary?.planMonthlyPercentUsed ?? usageSummary?.plan_monthly_percent_used);
  if (!usageLine) return;
  const parts = [];
  if (Number.isFinite(aicUsed) && aicUsed >= 0) {
    parts.push(`Session: ${aicUsed.toFixed(2)} AIC used`);
  } else if (Number.isFinite(planCreditsUsed) && planCreditsUsed > 0) {
    parts.push(`Session plan: ${planCreditsUsed.toFixed(3)} credits used`);
  }
  if (Number.isFinite(planMonthlyPercentUsed) && planMonthlyPercentUsed > 0) {
    parts.push(`${planMonthlyPercentUsed.toFixed(3)}% monthly plan`);
  }
  if (Number.isFinite(premiumRequests) && premiumRequests >= 0) {
    parts.push(`${Math.trunc(premiumRequests)} premium request${Math.trunc(premiumRequests) === 1 ? '' : 's'}`);
  }
  if (!parts.length) {
    usageLine.textContent = '';
    usageLine.hidden = true;
    return;
  }
  usageLine.textContent = parts.join(' · ');
  usageLine.hidden = false;
}

export function updateCompactButton() {
  const btn = document.getElementById('chat-menu-compact');
  if (!btn) return;
  if (btn.hidden || btn.getAttribute('aria-hidden') === 'true') {
    btn.disabled = true;
    btn.tabIndex = -1;
    btn.setAttribute('aria-disabled', 'true');
    return;
  }
  const conv = currentConvId ? conversations[currentConvId] : null;
  const canCompact = !!(currentConvId && conv && !conv.archived && !compactInFlight);
  btn.disabled = !canCompact;
  btn.title = canCompact
    ? 'Compact conversation into a fresh session'
    : (compactInFlight ? 'Compacting conversation…' : 'Open an active conversation to compact');
}

export function updateCliStatus() {
  const dot = document.getElementById('cli-dot');
  const text = document.getElementById('cli-status-text');
  const banner = document.getElementById('offline-banner');
  const changeCwdBtn = document.getElementById('chat-menu-change-cwd');
  const workerStates = Array.from(sessionWorkerStates.values());
  const processingCount = workerStates.filter((state) => String(state?.status || '').trim().toLowerCase() === 'processing').length;
  const errorCount = workerStates.filter((state) => String(state?.uiState || state?.derivedUiState || '').trim().toLowerCase() === 'error').length;
  const questionCount = workerStates.filter((state) => String(state?.uiState || state?.derivedUiState || '').trim().toLowerCase() === 'question').length;
  if (dot) {
    dot.className = relayOnline ? 'online' : 'offline';
    if (!relayOnline) {
      dot.title = 'Web relay unreachable';
    } else if (!cliOnline) {
      dot.title = 'Web relay reachable; CLI offline';
    } else if (processingCount > 0) {
      dot.title = `Web relay reachable; ${processingCount} session worker${processingCount === 1 ? '' : 's'} processing`;
    } else if (errorCount > 0) {
      dot.title = `Web relay reachable; ${errorCount} session worker${errorCount === 1 ? '' : 's'} degraded`;
    } else if (questionCount > 0) {
      dot.title = `Web relay reachable; ${questionCount} session worker${questionCount === 1 ? '' : 's'} waiting on a question`;
    } else {
      dot.title = 'Web relay reachable';
    }
  }
  if (text) text.textContent = cliOnline ? 'CLI online' : 'CLI offline';
  if (changeCwdBtn) {
    changeCwdBtn.disabled = false;
    changeCwdBtn.title = 'Change the next launch CWD';
  }
  if (banner) {
    if (cliOnline) banner.classList.remove('visible');
    else banner.classList.add('visible');
  }
}

export function setCliOnline(value) {
  const nextOnline = !!value;
  const changed = cliOnline !== nextOnline;
  cliOnline = nextOnline;
  if (changed) recordCliLifecycleEvent(nextOnline);
  updateCliStatus();
}

export function setRelayOnline(value) {
  const nextOnline = !!value;
  const changed = relayOnline !== nextOnline;
  relayOnline = nextOnline;
  if (changed) recordRelayLifecycleEvent(nextOnline);
  updateCliStatus();
}

export function setImageEditTarget(value) {
  imageEditTarget = value && typeof value === 'object'
    ? {
        messageId: String(value.messageId || '').trim(),
        imageId: String(value.imageId || '').trim(),
        nodeId: String(value.nodeId || '').trim() || null,
        name: String(value.name || 'generated image').trim() || 'generated image',
      }
    : null;
}

function normalizeWorkerSessionId(value) {
  const text = String(value || '').trim();
  return text || '';
}

function normalizeWorkerStatus(value) {
  const text = String(value || '').trim().toLowerCase();
  return text || 'unknown';
}

const CANONICAL_UI_STATES = new Set(['offline', 'ready', 'question', 'error']);
const UI_STATE_ALIAS_MAP = new Map([
  ['offline', 'offline'],
  ['inactive', 'offline'],
  ['unknown', 'offline'],
  ['new', 'offline'],
  ['disconnected', 'offline'],
  ['stopped', 'offline'],
  ['idle', 'offline'],
  ['white', 'offline'],
  ['healthy', 'ready'],
  ['ready', 'ready'],
  ['online', 'ready'],
  ['active', 'ready'],
  ['busy', 'ready'],
  ['processing', 'ready'],
  ['starting', 'ready'],
  ['green', 'ready'],
  ['question', 'question'],
  ['question-pending', 'question'],
  ['question_pending', 'question'],
  ['awaiting-input', 'question'],
  ['awaiting_input', 'question'],
  ['needs-input', 'question'],
  ['needs_input', 'question'],
  ['input-required', 'question'],
  ['input_required', 'question'],
  ['waiting-for-input', 'question'],
  ['waiting_for_input', 'question'],
  ['red', 'question'],
  ['error', 'error'],
  ['degraded', 'error'],
  ['unsafe', 'error'],
  ['failed', 'error'],
  ['yellow', 'error'],
]);

function normalizeUiState(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (CANONICAL_UI_STATES.has(text)) return text;
  return UI_STATE_ALIAS_MAP.get(text) || '';
}

function normalizeUiStateFromStatus(value) {
  return normalizeUiState(normalizeWorkerStatus(value));
}

export function resolveConversationUiState({ conversation = null, workerState = null, hasPendingQuestion = false } = {}) {
  const backendUiState = normalizeUiState(
    workerState?.uiState
    || workerState?.ui_state
    || conversation?.runtimeSessionUiState
    || conversation?.runtime_session_ui_state,
  );
  if (backendUiState) return backendUiState;
  if (hasPendingQuestion) return 'question';

  const fallbackUiState = normalizeUiState(
    workerState?.derivedUiState
    || workerState?.fallbackUiState
    || normalizeUiStateFromStatus(workerState?.status)
    || normalizeUiStateFromStatus(conversation?.runtimeSessionStatus)
    || normalizeUiStateFromStatus(conversation?.runtime_session_status),
  );
  return fallbackUiState || 'offline';
}

function normalizeWorkerStateEntry(worker) {
  const sdkSessionId = normalizeWorkerSessionId(worker?.sdkSessionId);
  if (!sdkSessionId) return null;
  const explicitUiState = normalizeUiState(worker?.uiState || worker?.ui_state);
  const derivedUiState = normalizeUiStateFromStatus(worker?.status);
  return {
    sdkSessionId,
    status: normalizeWorkerStatus(worker?.status),
    uiState: explicitUiState || null,
    derivedUiState: derivedUiState || null,
    workerId: String(worker?.workerId || '').trim() || null,
    pid: Number.isInteger(Number(worker?.pid)) ? Number(worker.pid) : null,
    updatedAt: String(worker?.updatedAt || '').trim() || null,
  };
}

function buildSessionWorkerStateHash(map) {
  const parts = [];
  for (const [sid, state] of map.entries()) {
    parts.push(`${sid}:${state.status}:${state.uiState || ''}:${state.derivedUiState || ''}:${state.workerId || ''}:${state.pid || ''}:${state.updatedAt || ''}`);
  }
  return parts.sort().join('|');
}

let sessionWorkerStateHash = '';

export function setSessionWorkerStatesFromStatusPayload(payload) {
  const workers = Array.isArray(payload?.workers) ? payload.workers : [];
  const next = new Map();
  for (const worker of workers) {
    const normalized = normalizeWorkerStateEntry(worker);
    if (!normalized) continue;
    next.set(normalized.sdkSessionId, normalized);
  }
  const nextHash = buildSessionWorkerStateHash(next);
  if (nextHash === sessionWorkerStateHash) return false;
  sessionWorkerStateHash = nextHash;
  sessionWorkerStates = next;
  return true;
}

export function getSessionWorkerState(sdkSessionId) {
  const sid = normalizeWorkerSessionId(sdkSessionId);
  if (!sid) return null;
  return sessionWorkerStates.get(sid) || null;
}

function isPortraitViewport() {
  return !!window.matchMedia('(orientation: portrait)').matches;
}

function isOverlaySidebarViewport() {
  return window.matchMedia('(max-width: 680px)').matches;
}

function syncMobileSidebarTopOffset() {
  const header = document.getElementById('chat-header');
  const top = isOverlaySidebarViewport() && header
    ? Math.max(0, Math.ceil(header.getBoundingClientRect().bottom))
    : 0;
  document.documentElement.style.setProperty('--mobile-sidebar-top', `${top}px`);
}

function parseCssPx(value) {
  const numeric = Number.parseFloat(String(value || ''));
  return Number.isFinite(numeric) ? numeric : 0;
}

function isVisibleElement(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function measureSidebarHeaderMinWidthPx() {
  const header = document.querySelector('#sidebar .sidebar-header');
  if (!header) return 0;
  const headerStyle = window.getComputedStyle(header);
  const sidePadding = parseCssPx(headerStyle.paddingLeft) + parseCssPx(headerStyle.paddingRight);
  const headerGap = parseCssPx(headerStyle.columnGap || headerStyle.gap);

  let neededWidth = sidePadding;
  let sectionCount = 0;

  const statusDot = document.getElementById('cli-dot');
  if (isVisibleElement(statusDot)) {
    neededWidth += Math.ceil(statusDot.getBoundingClientRect().width || 0);
    sectionCount += 1;
  }

  const newConversationButton = document.getElementById('new-conv-btn');
  if (isVisibleElement(newConversationButton)) {
    const buttonStyle = window.getComputedStyle(newConversationButton);
    neededWidth += Math.ceil(parseCssPx(buttonStyle.minWidth));
    sectionCount += 1;
  }

  const statusButton = document.getElementById('status-btn');
  if (isVisibleElement(statusButton)) {
    const buttonStyle = window.getComputedStyle(statusButton);
    neededWidth += Math.ceil(parseCssPx(buttonStyle.minWidth));
    sectionCount += 1;
  }

  const actions = document.getElementById('sidebar-actions');
  if (isVisibleElement(actions)) {
    const actionsStyle = window.getComputedStyle(actions);
    const actionGap = parseCssPx(actionsStyle.columnGap || actionsStyle.gap);
    const visibleButtons = Array.from(actions.children).filter(child => isVisibleElement(child));
    let actionsWidth = 0;
    for (const button of visibleButtons) {
      actionsWidth += Math.ceil(button.getBoundingClientRect().width || 0);
    }
    if (visibleButtons.length > 1) actionsWidth += actionGap * (visibleButtons.length - 1);
    neededWidth += actionsWidth;
    sectionCount += 1;
  }

  if (sectionCount > 1) {
    neededWidth += headerGap * (sectionCount - 1);
  }
  return Math.ceil(neededWidth + 4);
}

function sidebarWidthPercentMin() {
  const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0, 1);
  const headerMinPx = measureSidebarHeaderMinWidthPx();
  const headerMinPercent = (headerMinPx / viewportWidth) * 100;
  return Math.min(SIDEBAR_WIDTH_PERCENT_MAX, Math.max(SIDEBAR_WIDTH_PERCENT_MIN, headerMinPercent));
}

function clampSidebarWidthPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return SIDEBAR_WIDTH_PERCENT_FALLBACK;
  const minPercent = sidebarWidthPercentMin();
  if (numeric <= minPercent) return minPercent;
  if (numeric >= SIDEBAR_WIDTH_PERCENT_MAX) return SIDEBAR_WIDTH_PERCENT_MAX;
  return Math.round(numeric * 100) / 100;
}

function currentSidebarWidthStorageKey() {
  return isPortraitViewport()
    ? SIDEBAR_WIDTH_PORTRAIT_STORAGE_KEY
    : SIDEBAR_WIDTH_LANDSCAPE_STORAGE_KEY;
}

function oppositeSidebarWidthStorageKey() {
  return isPortraitViewport()
    ? SIDEBAR_WIDTH_LANDSCAPE_STORAGE_KEY
    : SIDEBAR_WIDTH_PORTRAIT_STORAGE_KEY;
}

function readSidebarWidthPercentForCurrentOrientation() {
  const primary = Number(localStorage.getItem(currentSidebarWidthStorageKey()));
  if (Number.isFinite(primary)) return clampSidebarWidthPercent(primary);
  const fallback = Number(localStorage.getItem(oppositeSidebarWidthStorageKey()));
  if (Number.isFinite(fallback)) return clampSidebarWidthPercent(fallback);
  return SIDEBAR_WIDTH_PERCENT_FALLBACK;
}

function persistSidebarWidthPercentForCurrentOrientation(percent) {
  localStorage.setItem(currentSidebarWidthStorageKey(), String(clampSidebarWidthPercent(percent)));
}

function applySidebarWidthPercent(percent, { persist = true } = {}) {
  sidebarWidthPercent = clampSidebarWidthPercent(percent);
  const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0, 1);
  const widthPx = Math.round((viewportWidth * sidebarWidthPercent) / 100);
  document.documentElement.style.setProperty('--sidebar-width', `${Math.max(1, widthPx)}px`);
  if (persist) {
    persistSidebarWidthPercentForCurrentOrientation(sidebarWidthPercent);
  }
}

function readDesktopSidebarCollapsed() {
  return localStorage.getItem(SIDEBAR_COLLAPSED_DESKTOP_STORAGE_KEY) === '1';
}

function setDesktopSidebarCollapsed(collapsed) {
  const next = !!collapsed;
  document.body.classList.toggle('sidebar-collapsed', next);
  localStorage.setItem(SIDEBAR_COLLAPSED_DESKTOP_STORAGE_KEY, next ? '1' : '0');
}

export function isSidebarOpen() {
  const sidebar = document.getElementById('sidebar');
  if (isOverlaySidebarViewport()) {
    return !!sidebar?.classList.contains('open');
  }
  return !document.body.classList.contains('sidebar-collapsed');
}

export function openSidebar() {
  if (isOverlaySidebarViewport()) {
    document.body.classList.remove('sidebar-collapsed');
    document.getElementById('sidebar')?.classList.add('open');
    document.getElementById('sidebar-overlay')?.classList.add('visible');
    return;
  }
  setDesktopSidebarCollapsed(false);
}

export function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('visible');
}

export function toggleSidebar(forceOpen = null) {
  if (isOverlaySidebarViewport()) {
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !isSidebarOpen();
    if (shouldOpen) openSidebar();
    else closeSidebar();
    return;
  }
  const nextOpen = typeof forceOpen === 'boolean' ? forceOpen : !isSidebarOpen();
  setDesktopSidebarCollapsed(!nextOpen);
}

export function syncSidebarLayoutState() {
  applySidebarWidthPercent(readSidebarWidthPercentForCurrentOrientation(), { persist: false });
  if (isOverlaySidebarViewport()) {
    document.body.classList.remove('sidebar-collapsed');
    return;
  }
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('visible');
  setDesktopSidebarCollapsed(readDesktopSidebarCollapsed());
}

function beginSidebarResize(pointerDownEvent) {
  if (pointerDownEvent.button !== 0) return;
  if (isOverlaySidebarViewport() || !isSidebarOpen()) return;
  const startX = Number(pointerDownEvent.clientX || 0);
  const startPercent = sidebarWidthPercent;
  document.body.classList.add('sidebar-resizing');
  pointerDownEvent.preventDefault();

  const onPointerMove = (moveEvent) => {
    const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0, 1);
    const deltaX = Number(moveEvent.clientX || 0) - startX;
    const deltaPercent = (deltaX / viewportWidth) * 100;
    applySidebarWidthPercent(startPercent + deltaPercent, { persist: true });
  };

  const onPointerUp = () => {
    document.body.classList.remove('sidebar-resizing');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

export function initSidebarLayout() {
  syncMobileSidebarTopOffset();
  syncSidebarLayoutState();
  if (window.__sidebarLayoutBound) return;
  window.__sidebarLayoutBound = true;

  const handle = document.getElementById('sidebar-resizer');
  if (handle) {
    handle.addEventListener('pointerdown', beginSidebarResize);
  }

  const resync = () => syncSidebarLayoutState();
  window.addEventListener('resize', resync, { passive: true });
  window.addEventListener('orientationchange', resync, { passive: true });
  const chatHeader = document.getElementById('chat-header');
  if (chatHeader && typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(syncMobileSidebarTopOffset);
    observer.observe(chatHeader);
  }
}

export function setCompactInFlight(value) {
  compactInFlight = !!value;
  updateCompactButton();
}

export function isCompactInFlight() {
  return compactInFlight;
}

export function setHistoryRefreshInFlight(value) {
  historyRefreshInFlight = !!value;
  const refreshBtn = document.getElementById('chat-menu-refresh-history');
  if (refreshBtn) {
    if (refreshBtn.hidden || refreshBtn.getAttribute('aria-hidden') === 'true') {
      refreshBtn.disabled = true;
      refreshBtn.tabIndex = -1;
      refreshBtn.setAttribute('aria-disabled', 'true');
      return;
    }
    refreshBtn.disabled = historyRefreshInFlight;
    refreshBtn.textContent = historyRefreshInFlight ? '🔄️ Refreshing…' : '🔄️ Refresh history';
  }
}

export function isHistoryRefreshInFlight() {
  return historyRefreshInFlight;
}

export function setModelBanner(message) {
  const el = document.getElementById('model-banner');
  if (!el) return;
  const text = String(message || '').trim();
  if (!text) {
    el.textContent = '';
    el.classList.remove('visible');
    return;
  }
  el.textContent = text;
  el.classList.add('visible');
}

export function showTransientRelayNotice(message, ms = 4000) {
  const text = String(message || '').trim();
  if (!text) return;
  setModelBanner(text);
  setTimeout(() => {
    const el = document.getElementById('model-banner');
    if (!el) return;
    if (String(el.textContent || '').trim() === text) {
      setModelBanner('');
    }
  }, Math.max(1500, Number(ms) || 4000));
}

export function syncViewportMetrics() {
  const layoutHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const layoutWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const vv = window.visualViewport;
  let appHeight = layoutHeight;
  let viewportTopOffset = 0;

  if (vv) {
    const visibleHeight = Math.max(0, vv.height || 0);
    const offsetTop = Math.max(0, vv.offsetTop || 0);
    viewportTopOffset = offsetTop;
    const baselineCandidate = Math.max(layoutHeight, visibleHeight + offsetTop);
    if (baselineCandidate > viewportBaseHeight) viewportBaseHeight = baselineCandidate;
    appHeight = baselineCandidate;
  } else if (layoutHeight > viewportBaseHeight) {
    viewportBaseHeight = layoutHeight;
  }

  document.documentElement.style.setProperty('--viewport-top-offset', `${Math.max(0, Math.round(viewportTopOffset))}px`);
  document.documentElement.style.setProperty('--app-height', `${Math.max(0, Math.round(appHeight))}px`);
  const messagesEl = document.getElementById('messages');
  const messagesHeight = messagesEl ? Math.max(0, messagesEl.clientHeight || 0) : appHeight;
  const messagesWidth = messagesEl ? Math.max(0, messagesEl.clientWidth || 0) : layoutWidth;
  document.documentElement.style.setProperty('--messages-height', `${Math.max(0, Math.round(messagesHeight))}px`);
  document.documentElement.style.setProperty('--messages-width', `${Math.max(0, Math.round(messagesWidth))}px`);
  syncMobileSidebarTopOffset();
}

export let summaryModalState = {
  kind: '',
  refresh: null,
  loading: false,
};

export function setSummaryModalLoading(loading) {
  summaryModalState.loading = !!loading;
  const refreshBtn = document.getElementById('summary-modal-refresh');
  if (refreshBtn) {
    refreshBtn.hidden = !summaryModalState.refresh;
    refreshBtn.disabled = summaryModalState.loading || !summaryModalState.refresh;
    refreshBtn.textContent = summaryModalState.loading ? 'Loading…' : 'Refresh';
  }
  // Freeze/unfreeze all action buttons inside the modal body while a request is in flight
  const bodyEl = document.getElementById('summary-modal-body');
  if (bodyEl) {
    for (const btn of bodyEl.querySelectorAll('button')) {
      btn.disabled = summaryModalState.loading;
    }
  }
}

export function renderSummaryModalContent({ title, subtitle = '', bodyHtml = '', refresh = null, kind = '' }) {
  summaryModalState.kind = String(kind || '').trim();
  summaryModalState.refresh = typeof refresh === 'function' ? refresh : null;

  const titleEl = document.getElementById('summary-modal-title');
  const subtitleEl = document.getElementById('summary-modal-subtitle');
  const bodyEl = document.getElementById('summary-modal-body');
  const staleModelSaveBtn = document.getElementById('summary-modal-save-models');
  if (staleModelSaveBtn) staleModelSaveBtn.remove();
  if (titleEl) titleEl.textContent = String(title || 'Details').trim() || 'Details';
  if (subtitleEl) subtitleEl.textContent = String(subtitle || '').trim();
  if (bodyEl) bodyEl.innerHTML = bodyHtml || '';
  setSummaryModalLoading(false);
}

export function openSummaryModal({ title, subtitle = '', bodyHtml = '', refresh = null, kind = '' }) {
  renderSummaryModalContent({ title, subtitle, bodyHtml, refresh, kind });
  const modal = document.getElementById('summary-modal');
  modal?.classList.add('visible');
  modal?.setAttribute('aria-hidden', 'false');
}

export function closeSummaryModal() {
  summaryModalState.kind = '';
  summaryModalState.refresh = null;
  summaryModalState.loading = false;
  const modal = document.getElementById('summary-modal');
  modal?.classList.remove('visible');
  modal?.setAttribute('aria-hidden', 'true');
  const titleEl = document.getElementById('summary-modal-title');
  const subtitleEl = document.getElementById('summary-modal-subtitle');
  const bodyEl = document.getElementById('summary-modal-body');
  if (titleEl) titleEl.textContent = 'Details';
  if (subtitleEl) subtitleEl.textContent = '';
  if (bodyEl) bodyEl.innerHTML = '';
  setSummaryModalLoading(false);
}

export async function refreshSummaryModal() {
  if (!summaryModalState.refresh || summaryModalState.loading) return;
  setSummaryModalLoading(true);
  try {
    await summaryModalState.refresh();
  } finally {
    setSummaryModalLoading(false);
  }
}

export function normalizeSubagentRunId(value) {
  return String(value || '').trim() || null;
}

export function normalizeSubagentStatus(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['pending', 'processing', 'running', 'completed', 'failed', 'cancelled'].includes(text)) return text;
  return 'running';
}

export function markSubagentCancelInFlight(subagentRunId) {
  const id = normalizeSubagentRunId(subagentRunId);
  if (!id) return false;
  subagentCancelInFlight.add(id);
  return true;
}

export function clearSubagentCancelInFlight(subagentRunId) {
  const id = normalizeSubagentRunId(subagentRunId);
  if (!id) return false;
  return subagentCancelInFlight.delete(id);
}

export function isSubagentCancelInFlight(subagentRunId) {
  const id = normalizeSubagentRunId(subagentRunId);
  return id ? subagentCancelInFlight.has(id) : false;
}

export function upsertSubagentRun(payload) {
  const subagentRunId = normalizeSubagentRunId(payload?.subagentRunId);
  if (!subagentRunId) return null;

  const existing = subagentRuns.get(subagentRunId);
  const now = new Date().toISOString();
  const entry = {
    subagentRunId,
    messageId: String(payload?.messageId || existing?.messageId || '').trim() || null,
    conversationId: String(payload?.conversationId || existing?.conversationId || '').trim() || null,
    parentSubagentId: normalizeSubagentRunId(payload?.parentSubagentId) || existing?.parentSubagentId || null,
    displayName: String(payload?.displayName || existing?.displayName || '').trim() || null,
    status: normalizeSubagentStatus(payload?.status) || existing?.status || 'running',
    startedAt: existing?.startedAt || payload?.timestamp || now,
    updatedAt: payload?.timestamp || now,
    activities: existing?.activities || [],
    thoughts: existing?.thoughts || [],
  };

  subagentRuns.set(subagentRunId, entry);
  return entry;
}

export function getSubagentRun(subagentRunId) {
  const id = normalizeSubagentRunId(subagentRunId);
  return id ? subagentRuns.get(id) || null : null;
}

export function getSubagentRunsByMessage(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return [];
  const results = [];
  for (const entry of subagentRuns.values()) {
    if (entry.messageId === id) results.push(entry);
  }
  return results.sort((a, b) => {
    const aTime = parseTimestampMs(a.startedAt);
    const bTime = parseTimestampMs(b.startedAt);
    return aTime - bTime;
  });
}

export function getChildSubagentRuns(parentSubagentId) {
  const id = normalizeSubagentRunId(parentSubagentId);
  if (!id) return [];
  const results = [];
  for (const entry of subagentRuns.values()) {
    if (entry.parentSubagentId === id) results.push(entry);
  }
  return results.sort((a, b) => {
    const aTime = parseTimestampMs(a.startedAt);
    const bTime = parseTimestampMs(b.startedAt);
    return aTime - bTime;
  });
}

export function getRootSubagentRunsByMessage(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return [];
  const results = [];
  for (const entry of subagentRuns.values()) {
    if (entry.messageId === id && !entry.parentSubagentId) {
      results.push(entry);
    }
  }
  return results.sort((a, b) => {
    const aTime = parseTimestampMs(a.startedAt);
    const bTime = parseTimestampMs(b.startedAt);
    return aTime - bTime;
  });
}

export function addSubagentActivity(subagentRunId, activityText) {
  const entry = getSubagentRun(subagentRunId);
  if (!entry) return false;
  const text = String(activityText || '').trim();
  if (!text) return false;
  entry.activities.push({ text, timestamp: new Date().toISOString() });
  return true;
}

export function addSubagentThought(subagentRunId, thoughtPayload) {
  const entry = getSubagentRun(subagentRunId);
  if (!entry) return false;
  const text = String(thoughtPayload?.text || '').trim();
  if (!text) return false;
  entry.thoughts.push({
    reasoningId: String(thoughtPayload?.reasoningId || '').trim() || null,
    text,
    done: !!thoughtPayload?.done,
    timestamp: thoughtPayload?.timestamp || new Date().toISOString(),
  });
  return true;
}

export function clearSubagentRunsForMessage(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return 0;
  let cleared = 0;
  for (const [runId, entry] of subagentRuns.entries()) {
    if (entry.messageId === id) {
      subagentRuns.delete(runId);
      subagentCancelInFlight.delete(runId);
      cleared += 1;
    }
  }
  return cleared;
}

export function clearSubagentRunsForConversation(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return 0;
  let cleared = 0;
  for (const [runId, entry] of subagentRuns.entries()) {
    if (entry.conversationId === id) {
      subagentRuns.delete(runId);
      subagentCancelInFlight.delete(runId);
      cleared += 1;
    }
  }
  return cleared;
}
