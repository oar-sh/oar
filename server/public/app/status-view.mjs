import {
  activeRuntimeSessionCount,
  runtimeSessionBindingCount,
  cliOnline,
  currentConvId,
  escHtml,
  relayOnline,
  sessionWorkerStates,
  setCurrentConv,
} from './store.js';
import { createInfiniteLoader } from './infinite-loader.js';
import { loadServerStatusEventPage } from './api-client.js';
import {
  clearStatusEvents,
  loadStatusEventPage,
  mergeStatusEvents,
  subscribeStatusEvents,
} from './status-store.mjs';

export const STATUS_CONVERSATION_ID = '__client_status__';
const STATUS_SCROLL_STORAGE_KEY = 'copilot_status_history_scroll';
const STATUS_BOTTOM_THRESHOLD_PX = 24;

let statusViewActive = false;
let previousConversationId = '';
let events = [];
let unsubscribe = null;
let statusViewGeneration = 0;
let statusRenderFrame = 0;
let statusScrollBound = false;

function isNearStatusBottom(host) {
  return !!host && (host.scrollHeight - host.clientHeight - host.scrollTop) <= STATUS_BOTTOM_THRESHOLD_PX;
}

function formatValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value?.message) return String(value.message);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatStatusEvent(event) {
  const details = event?.details || {};
  const type = String(event?.type || 'event');
  if (type.startsWith('console-')) {
    return (details.arguments || []).map(formatValue).filter(Boolean).join(' ');
  }
  if (type === 'relay-connected') return 'Web relay connected';
  if (type === 'relay-unreachable') return 'Web relay unreachable';
  if (type === 'cli-connected') return 'CLI connected';
  if (type === 'cli-unreachable') return 'CLI offline';
  if (type === 'client-error') return `Error: ${formatValue(details.message || details.error)}`;
  if (type === 'unhandled-rejection') return `Unhandled rejection: ${formatValue(details.reason)}`;
  if (type === 'shared-access-opened') {
    return `Shared conversation opened (${details.shareId || 'unknown share'})`;
  }
  return formatValue(details);
}

function renderStatusHeader() {
  if (!statusViewActive) return;
  const title = document.getElementById('chat-title');
  const metadata = document.getElementById('chat-title-cwd');
  const usage = document.getElementById('chat-title-session-usage');
  if (title) {
    title.innerHTML = `Web Relay Status: <span class="${relayOnline ? 'status-online' : 'status-offline'}">${relayOnline ? 'Reachable' : 'Unreachable'}</span> | CLI: <span class="${cliOnline ? 'status-online' : 'status-offline'}">${cliOnline ? 'Online' : 'Offline'}</span>`;
  }
  if (metadata) {
    const allWorkers = Array.from(sessionWorkerStates.values());
    const assignedOnline = Number(activeRuntimeSessionCount || 0);
    const onlineTotal = allWorkers.reduce((count, worker) => {
      const status = String(worker?.status || '').trim().toLowerCase();
      return count + ((status === 'starting' || status === 'ready' || status === 'processing') ? 1 : 0);
    }, 0);
    const unassignedOnline = Math.max(0, onlineTotal - assignedOnline);
    metadata.textContent = `Workers online: ${assignedOnline}${unassignedOnline ? ` (+${unassignedOnline} unassigned)` : ''} (total: ${sessionWorkerStates.size}) | Active runtime sessions: ${assignedOnline} | Total session bindings: ${Number(runtimeSessionBindingCount || 0)}`;
    metadata.hidden = false;
  }
  if (usage) {
    usage.textContent = '';
    usage.hidden = true;
  }
  const primary = document.getElementById('chat-title-primary');
  if (primary && !document.getElementById('clear-status-events')) {
    const clearButton = document.createElement('button');
    clearButton.id = 'clear-status-events';
    clearButton.type = 'button';
    clearButton.textContent = 'Clear local client logs';
    clearButton.title = 'Server status events are retained';
    clearButton.addEventListener('click', async () => {
      await clearStatusEvents();
      events = events.filter((event) => event?.source === 'server');
      localStorage.removeItem(STATUS_SCROLL_STORAGE_KEY);
      await refreshStatusEvents(statusViewGeneration);
    });
    primary.append(clearButton);
  }
}

function renderStatusView({ prepend = false, restoreScrollTop = null } = {}) {
  if (!statusViewActive) return;
  const host = document.getElementById('messages');
  if (!host) return;
  const previousHeight = host.scrollHeight;
  const previousTop = host.scrollTop;
  const followBottom = isNearStatusBottom(host);
  renderStatusHeader();
  const rows = events.map((event) => `
    <div class="status-event">
      <time>${new Date(Number(event.timestamp || 0)).toLocaleString()}</time>
      <span class="status-event-source">${escHtml(String(event.source || 'client'))}</span>
      <code>${escHtml(formatStatusEvent(event))}</code>
    </div>
  `).join('');
  host.innerHTML = `
    <section class="status-view" aria-live="polite">
      <div class="status-events">${rows || '<p class="status-empty">No status events recorded.</p>'}</div>
    </section>
  `;
  if (Number.isFinite(restoreScrollTop)) {
    host.scrollTop = Math.max(0, restoreScrollTop);
  } else if (prepend) {
    host.scrollTop = Math.max(0, previousTop + host.scrollHeight - previousHeight);
  } else if (followBottom) {
    host.scrollTop = host.scrollHeight;
  } else {
    host.scrollTop = previousTop;
  }
}

function scheduleStatusHistoryBoundaryCheck() {
  if (statusRenderFrame) return;
  statusRenderFrame = requestAnimationFrame(() => {
    statusRenderFrame = 0;
    if (!statusViewActive) return;
    const host = document.getElementById('messages');
    if (host) void statusHistoryLoader.handleBoundaryDistance(host.scrollTop);
  });
}

function emptyStatusEventPage() {
  return {
    items: [],
    hasMore: false,
    nextCursor: null,
  };
}

function statusTimelineCursor(clientPage, serverPage) {
  return {
    client: clientPage.nextCursor,
    clientExhausted: !clientPage.hasMore,
    server: serverPage.nextCursor,
    serverExhausted: !serverPage.hasMore,
  };
}

const statusHistoryLoader = createInfiniteLoader({
  fetchPage: async (cursor = {}) => {
    const [clientPage, serverPage] = await Promise.all([
      cursor.clientExhausted ? emptyStatusEventPage() : loadStatusEventPage({ before: cursor.client }),
      cursor.serverExhausted ? emptyStatusEventPage() : loadServerStatusEventPage({ before: cursor.server }),
    ]);
    return {
      items: mergeStatusEvents(clientPage.items, serverPage.items),
      hasMore: clientPage.hasMore || serverPage.hasMore,
      nextCursor: statusTimelineCursor(clientPage, serverPage),
    };
  },
  applyPage: async (page) => {
    events = mergeStatusEvents(events, page.items);
    renderStatusView({ prepend: true });
    scheduleStatusHistoryBoundaryCheck();
  },
});

async function refreshStatusEvents(generation) {
  const [clientPage, serverPage] = await Promise.all([
    loadStatusEventPage(),
    loadServerStatusEventPage(),
  ]);
  if (!statusViewActive || generation !== statusViewGeneration) return false;
  events = mergeStatusEvents(events, [...clientPage.items, ...serverPage.items]);
  statusHistoryLoader.reset({
    hasMore: clientPage.hasMore || serverPage.hasMore,
    nextCursor: statusTimelineCursor(clientPage, serverPage),
  });
  const savedScrollValue = localStorage.getItem(STATUS_SCROLL_STORAGE_KEY);
  const savedScrollTop = savedScrollValue === null ? null : Number(savedScrollValue);
  renderStatusView({ restoreScrollTop: Number.isFinite(savedScrollTop) ? savedScrollTop : null });
  scheduleStatusHistoryBoundaryCheck();
  return true;
}

function initStatusScrollPersistence() {
  if (statusScrollBound) return;
  statusScrollBound = true;
  document.getElementById('messages')?.addEventListener('scroll', () => {
    if (!statusViewActive) return;
    const host = document.getElementById('messages');
    if (!host) return;
    localStorage.setItem(STATUS_SCROLL_STORAGE_KEY, String(Math.max(0, host.scrollTop)));
    scheduleStatusHistoryBoundaryCheck();
  }, { passive: true });
}

export function isStatusViewActive() {
  return statusViewActive;
}

export function leaveStatusView() {
  const wasActive = statusViewActive;
  statusViewGeneration += 1;
  statusViewActive = false;
  document.body.classList.remove('status-view-active');
  document.getElementById('input-area')?.removeAttribute('hidden');
  document.getElementById('pending-question-banner')?.removeAttribute('hidden');
  document.getElementById('clear-status-events')?.remove();
  const metadata = document.getElementById('chat-title-cwd');
  if (metadata) {
    metadata.textContent = '';
    metadata.hidden = true;
  }
  const usage = document.getElementById('chat-title-session-usage');
  if (usage) {
    usage.textContent = '';
    usage.hidden = true;
  }
  unsubscribe?.();
  unsubscribe = null;
  window.renderConvList?.();
  return wasActive;
}

export async function toggleStatusView() {
  if (statusViewActive) {
    leaveStatusView();
    const restoreId = previousConversationId;
    previousConversationId = '';
    if (restoreId) await window.openConversation?.(restoreId, { restoreScroll: true });
    return;
  }
  previousConversationId = String(currentConvId || '').trim();
  const generation = ++statusViewGeneration;
  statusViewActive = true;
  setCurrentConv(null);
  window.renderConvList?.();
  if (previousConversationId) localStorage.setItem('copilot_last_conv', previousConversationId);
  document.body.classList.add('status-view-active');
  renderStatusHeader();
  document.getElementById('pending-question-banner')?.setAttribute('hidden', '');
  document.getElementById('input-area')?.setAttribute('hidden', '');
  initStatusScrollPersistence();
  unsubscribe = subscribeStatusEvents((event) => {
    events = mergeStatusEvents(events, [event]);
    renderStatusView();
  });
  if (!await refreshStatusEvents(generation)) return;
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('visible');
}
