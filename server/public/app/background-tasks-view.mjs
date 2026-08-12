// Composer background-tasks panel: the live set of tasks (backgrounded Bash,
// subagents, monitors, workflows) still running inside a conversation's
// persistent Claude CLI process. Fed by the `background_tasks` socket event
// (REPLACE semantics per conversation) and the conversation payload's
// `backgroundTasks` on reload; hidden whenever the set is empty.

import { apiFetch } from './api-client.js';

const tasksByConversation = new Map();
const stopsInFlight = new Set();
let currentConversationId = null;
let elapsedTimer = null;

const TASK_TYPE_ICONS = {
  local_bash: '⌨️',
  local_agent: '🤖',
  subagent: '🤖',
  local_workflow: '🧩',
  monitor: '👁️',
};

function taskIcon(taskType) {
  return TASK_TYPE_ICONS[String(taskType || '').trim()] || '⚙️';
}

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function formatElapsed(startedAt) {
  const started = Number(startedAt);
  if (!Number.isFinite(started) || started <= 0) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function setConversationBackgroundTasks(conversationId, tasks) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const normalized = (Array.isArray(tasks) ? tasks : []).filter((task) => task?.taskId);
  if (normalized.length) tasksByConversation.set(id, normalized);
  else tasksByConversation.delete(id);
  if (id === currentConversationId) renderBackgroundTasksPanel();
}

export function getConversationBackgroundTasks(conversationId) {
  return tasksByConversation.get(String(conversationId || '').trim()) || [];
}

export function setBackgroundTasksConversation(conversationId) {
  currentConversationId = String(conversationId || '').trim() || null;
  renderBackgroundTasksPanel();
}

async function stopBackgroundTask(conversationId, taskId) {
  const key = `${conversationId}:${taskId}`;
  if (stopsInFlight.has(key)) return;
  stopsInFlight.add(key);
  renderBackgroundTasksPanel();
  try {
    await apiFetch(`/api/conversation/${encodeURIComponent(conversationId)}/background-task/${encodeURIComponent(taskId)}/stop`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    // The worker's next background_tasks_changed replaces the set; keep the
    // button in its stopping state until that lands (or 15s pass).
    setTimeout(() => {
      stopsInFlight.delete(key);
      renderBackgroundTasksPanel();
    }, 15_000);
  } catch (error) {
    stopsInFlight.delete(key);
    renderBackgroundTasksPanel();
    console.warn('background task stop failed', error?.message || error);
  }
}

function renderTaskRow(conversationId, task) {
  const key = `${conversationId}:${task.taskId}`;
  const stopping = stopsInFlight.has(key);
  const elapsed = formatElapsed(task.startedAt);
  const detail = String(task.summary || task.lastToolName || '').trim();
  return `
    <div class="bg-task-row" data-task-id="${escHtml(task.taskId)}">
      <span class="bg-task-icon" title="${escHtml(task.taskType || 'task')}">${taskIcon(task.taskType)}</span>
      <span class="bg-task-main">
        <span class="bg-task-desc">${escHtml(task.description || task.taskId)}</span>
        ${detail ? `<span class="bg-task-detail">${escHtml(detail)}</span>` : ''}
      </span>
      <span class="bg-task-elapsed">${escHtml(elapsed)}</span>
      <button type="button" class="bg-task-stop" data-task-id="${escHtml(task.taskId)}" ${stopping ? 'disabled' : ''}>${stopping ? 'Stopping…' : 'Stop'}</button>
    </div>`;
}

export function renderBackgroundTasksPanel() {
  const panel = document.getElementById('background-tasks-panel');
  if (!panel) return;
  const conversationId = currentConversationId;
  const tasks = conversationId ? (tasksByConversation.get(conversationId) || []) : [];
  if (!tasks.length) {
    panel.hidden = true;
    panel.removeAttribute('open');
    stopElapsedTimer();
    return;
  }
  const wasOpen = panel.hasAttribute('open');
  panel.hidden = false;
  const summary = panel.querySelector('#background-tasks-summary');
  if (summary) {
    summary.innerHTML = `<span class="bg-task-spinner"></span> ${tasks.length} background task${tasks.length === 1 ? '' : 's'} running`;
  }
  const list = panel.querySelector('#background-tasks-list');
  if (list) {
    list.innerHTML = tasks.map((task) => renderTaskRow(conversationId, task)).join('');
    for (const button of list.querySelectorAll('.bg-task-stop')) {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        void stopBackgroundTask(conversationId, button.dataset.taskId);
      });
    }
  }
  if (wasOpen) panel.setAttribute('open', '');
  startElapsedTimer();
}

function startElapsedTimer() {
  if (elapsedTimer) return;
  elapsedTimer = setInterval(() => {
    const panel = document.getElementById('background-tasks-panel');
    if (!panel || panel.hidden || !panel.hasAttribute('open')) return;
    const tasks = currentConversationId ? (tasksByConversation.get(currentConversationId) || []) : [];
    for (const task of tasks) {
      const row = panel.querySelector(`.bg-task-row[data-task-id="${CSS.escape(task.taskId)}"] .bg-task-elapsed`);
      if (row) row.textContent = formatElapsed(task.startedAt);
    }
  }, 1000);
}

function stopElapsedTimer() {
  if (!elapsedTimer) return;
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}
