// Composer background-tasks panel: the live set of tasks (backgrounded Bash,
// subagents, monitors, workflows) still running inside a conversation's
// persistent Claude CLI process. Fed by the `background_tasks` socket event
// (REPLACE semantics per conversation) and the conversation payload's
// `backgroundTasks` on reload; hidden whenever the set is empty.

import { apiFetch } from './api-client.js';
import {
  getPreviewsForConversation,
  renderPreviewRowsInto,
  subscribePreviews,
} from './preview-cards.mjs';

const tasksByConversation = new Map();
const stopsInFlight = new Set();
// Manual chevron choices for workflow progress trees, keyed by taskId so a
// user's fold survives the ~2s background_tasks replace re-renders.
const workflowFoldState = new Map();
let currentConversationId = null;
let elapsedTimer = null;

const TASK_TYPE_ICONS = {
  local_bash: '⌨️',
  local_agent: '🤖',
  agent: '🤖',
  subagent: '🤖',
  local_workflow: '🧩',
  monitor: '👁️',
};

const TASK_TYPE_LABELS = {
  local_bash: 'Bash',
  local_agent: 'Subagent',
  agent: 'Subagent',
  subagent: 'Subagent',
  local_workflow: 'Workflow',
  monitor: 'Monitor',
};

// Workflow digest agent states → compact tree icons.
const WORKFLOW_AGENT_STATE_ICONS = {
  queued: '○',
  running: '◐',
  done: '✓',
  failed: '✗',
  killed: '✗',
};

// Digest statuses that mean the workflow is still doing work: the tree
// defaults to expanded while one of these is live (the "what is it doing"
// view), collapsed once the run settles.
const WORKFLOW_ACTIVE_STATUSES = new Set(['queued', 'pending', 'starting', 'running', 'in_progress']);

// Persisted-run statuses that still read "in flight": when the CLI never
// delivers the terminal task_notification, the buffered digest keeps its last
// live status. The card header says "Finished" — rendering these raw would
// contradict it, so the label owns up to not knowing the outcome instead.
const WORKFLOW_RUN_UNCONFIRMED_STATUSES = new Set(['running', 'pending', 'queued']);

function taskIcon(taskType) {
  return TASK_TYPE_ICONS[String(taskType || '').trim()] || '⚙️';
}

// Badge text: the specific agent type when the worker knows it ("Explore",
// "code-reviewer"), the generic kind otherwise.
function taskKindLabel(task) {
  const label = TASK_TYPE_LABELS[String(task?.taskType || '').trim()] || 'Task';
  const subagentType = String(task?.subagentType || '').trim();
  return label === 'Subagent' && subagentType ? subagentType : label;
}

function formatTaskModel(task) {
  const model = String(task?.model || '').trim();
  if (!model) return '';
  const short = model.replace(/^claude-/, '');
  return task?.modelInherited === true ? `${short} (inherited)` : short;
}

// Compact token counts: "812 tok", "62.2k tok", "1.2M tok". Exported for the
// transcript's finished-workflow card, which shares the panel's formatting.
export function formatTaskTokens(totalTokens) {
  const tokens = Number(totalTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens < 1000) return `${tokens} tok`;
  if (tokens < 1_000_000) {
    const thousands = tokens / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k tok`;
  }
  const millions = tokens / 1_000_000;
  return `${millions >= 100 ? Math.round(millions) : millions.toFixed(1)}M tok`;
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

// Compact "4m20s" duration for workflow agents (distinct from formatElapsed,
// which renders a live "4m 20s" wall clock from a start timestamp).
function formatWorkflowAgentDuration(durationMs) {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function workflowTreeAgents(task) {
  const agents = task?.workflowProgress?.agents;
  if (!Array.isArray(agents)) return [];
  return agents.filter((agent) => agent && typeof agent === 'object');
}

function isWorkflowTreeExpanded(task) {
  const taskId = String(task?.taskId || '');
  if (workflowFoldState.has(taskId)) return workflowFoldState.get(taskId) === true;
  const status = String(task?.workflowProgress?.status || '').trim().toLowerCase();
  return WORKFLOW_ACTIVE_STATUSES.has(status);
}

// Chevron toggle. Stores the user's explicit choice so it wins over the
// running/settled default on every subsequent re-render.
export function toggleWorkflowTreeFold(taskId) {
  const id = String(taskId || '').trim();
  if (!id) return;
  const tasks = currentConversationId ? (tasksByConversation.get(currentConversationId) || []) : [];
  const task = tasks.find((entry) => String(entry.taskId) === id) || { taskId: id };
  workflowFoldState.set(id, !isWorkflowTreeExpanded(task));
  renderBackgroundTasksPanel();
}

function agentBelongsToPhase(agent, phase) {
  const phaseIndex = Number(phase.index);
  if (Number.isFinite(phaseIndex) && Number(agent.phaseIndex) === phaseIndex) return true;
  const title = String(phase.title ?? '').trim();
  return !!title && String(agent.phaseTitle ?? '').trim() === title;
}

// One agent row, two lines: the state icon beside the 2-line-clamped label,
// then a muted metrics line "model · 62.2k tok · 27 tools · 4m20s" with
// absent fields simply omitted — the metrics never compete with the label
// for width, so the token count stays readable on a phone. A running agent's
// current tool rides the metrics line as its last, muted segment (never the
// clamped label line, where a long label would clamp the live activity away).
function buildWorkflowAgentRow(agent) {
  const state = String(agent.state ?? '').trim().toLowerCase();
  const row = document.createElement('div');
  row.className = 'bg-task-tree-agent';

  const stateEl = document.createElement('span');
  stateEl.className = state === 'running'
    ? 'bg-task-agent-state bg-task-agent-state-running'
    : 'bg-task-agent-state';
  stateEl.textContent = WORKFLOW_AGENT_STATE_ICONS[state] || '·';
  row.appendChild(stateEl);

  const mainEl = document.createElement('span');
  mainEl.className = 'bg-task-agent-main';
  row.appendChild(mainEl);

  const labelEl = document.createElement('span');
  labelEl.className = 'bg-task-agent-label';
  labelEl.textContent = String(agent.label ?? '').trim();
  mainEl.appendChild(labelEl);

  const lastToolName = String(agent.lastToolName ?? '').trim();
  const activityText = state === 'running' && lastToolName ? `— using ${lastToolName}` : '';

  const meta = [];
  const model = String(agent.model ?? '').trim().replace(/^claude-/, '');
  if (model) meta.push(model);
  const tokens = formatTaskTokens(agent.tokens);
  if (tokens) meta.push(tokens);
  const toolCalls = Number(agent.toolCalls);
  if (Number.isFinite(toolCalls) && toolCalls > 0) {
    meta.push(`${toolCalls} tool${toolCalls === 1 ? '' : 's'}`);
  }
  const duration = formatWorkflowAgentDuration(agent.durationMs);
  if (duration) meta.push(duration);
  const attempt = Number(agent.attempt);
  if (Number.isFinite(attempt) && attempt > 1) meta.push(`attempt ${attempt}`);
  if (meta.length || activityText) {
    const metaEl = document.createElement('span');
    metaEl.className = 'bg-task-agent-meta';
    metaEl.textContent = meta.length && activityText ? `${meta.join(' · ')} ` : meta.join(' · ');
    if (activityText) {
      const activityEl = document.createElement('span');
      activityEl.className = 'bg-task-agent-activity';
      activityEl.textContent = activityText;
      metaEl.appendChild(activityEl);
    }
    mainEl.appendChild(metaEl);
  }
  return row;
}

// Fills a workflow row's tree container: narrator log lines first, then agents
// grouped under their phase headers (ungrouped agents last, no header), then
// the "+N more agents" overflow line. Built with createElement/textContent so
// worker-supplied strings can never execute as markup.
export function renderWorkflowTreeInto(container, task) {
  if (!container) return;
  const digest = task?.workflowProgress;
  const agents = workflowTreeAgents(task);
  if (!digest || !agents.length) return;
  container.textContent = '';

  for (const line of (Array.isArray(digest.logs) ? digest.logs : []).slice(-5)) {
    const text = String(line ?? '').trim();
    if (!text) continue;
    const logEl = document.createElement('div');
    logEl.className = 'bg-task-tree-log';
    logEl.textContent = text;
    container.appendChild(logEl);
  }

  const phases = (Array.isArray(digest.phases) ? digest.phases : [])
    .filter((phase) => phase && typeof phase === 'object');
  const grouped = new Set();
  for (const phase of phases) {
    const members = agents.filter((agent) => !grouped.has(agent) && agentBelongsToPhase(agent, phase));
    if (!members.length) continue;
    const headerEl = document.createElement('div');
    headerEl.className = 'bg-task-tree-phase';
    headerEl.textContent = String(phase.title ?? '');
    container.appendChild(headerEl);
    for (const agent of members) {
      grouped.add(agent);
      container.appendChild(buildWorkflowAgentRow(agent));
    }
  }
  for (const agent of agents) {
    if (!grouped.has(agent)) container.appendChild(buildWorkflowAgentRow(agent));
  }

  const omitted = Number(digest.agentsOmitted);
  if (Number.isFinite(omitted) && omitted > 0) {
    const omittedEl = document.createElement('div');
    omittedEl.className = 'bg-task-tree-omitted';
    omittedEl.textContent = `+${omitted} more agent${omitted === 1 ? '' : 's'}`;
    container.appendChild(omittedEl);
  }
}

// Whole-run duration for the finished-workflow card header ("28m" rather than
// the per-agent "4m20s" — the card summarizes, the tree details).
function formatWorkflowRunDuration(durationMs) {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

/**
 * Header line for a persisted workflow digest:
 * `🧩 Finished background task — review-shared-modules · 20 agents · 1.2M tok
 * · 28m`, with absent fields omitted and a non-completed outcome surfaced as
 * e.g. `🧩 Finished background task (failed) — …`. A digest persisted with a
 * still-running-ish status renders `(unconfirmed)` rather than the
 * self-contradicting `Finished … (running)`.
 */
export function workflowRunCardTitle(run) {
  const rawStatus = String(run?.status || '').trim().toLowerCase();
  const status = WORKFLOW_RUN_UNCONFIRMED_STATUSES.has(rawStatus) ? 'unconfirmed' : rawStatus;
  const statusNote = status && status !== 'completed' ? ` (${status})` : '';
  const parts = [];
  const workflowName = String(run?.workflowName || '').trim();
  if (workflowName) parts.push(workflowName);
  const agentCount = Number(run?.agentCount);
  if (Number.isFinite(agentCount) && agentCount > 0) {
    parts.push(`${agentCount} agent${agentCount === 1 ? '' : 's'}`);
  }
  const tokens = formatTaskTokens(run?.totalTokens);
  if (tokens) parts.push(tokens);
  const duration = formatWorkflowRunDuration(run?.durationMs);
  if (duration) parts.push(duration);
  return `🧩 Finished background task${statusNote}${parts.length ? ` — ${parts.join(' · ')}` : ''}`;
}

/**
 * The transcript's "Finished background task" card for one persisted digest:
 * a native `<details>` (collapsed by default — clicking the summary is the
 * fold toggle, no listener needed) whose body is the SAME tree the live panel
 * renders. Built entirely with createElement/textContent, so digest strings
 * can never execute as markup. Returns null for a non-object run.
 */
export function buildWorkflowRunCard(run) {
  if (!run || typeof run !== 'object') return null;
  const details = document.createElement('details');
  details.className = 'msg-activity msg-workflow-run';
  const summary = document.createElement('summary');
  summary.textContent = workflowRunCardTitle(run);
  details.appendChild(summary);
  const tree = document.createElement('div');
  tree.className = 'bg-task-tree msg-workflow-run-tree';
  renderWorkflowTreeInto(tree, { workflowProgress: run });
  details.appendChild(tree);
  return details;
}

export function setConversationBackgroundTasks(conversationId, tasks) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const normalized = (Array.isArray(tasks) ? tasks : []).filter((task) => task?.taskId);
  // Drop fold choices for tasks that left this conversation's set so the map
  // cannot grow across long sessions.
  const surviving = new Set(normalized.map((task) => String(task.taskId)));
  for (const previous of tasksByConversation.get(id) || []) {
    if (!surviving.has(String(previous.taskId))) workflowFoldState.delete(String(previous.taskId));
  }
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
  // Second line: progress first ("using Bash" prefixed so a bare tool name
  // can't read as the task's kind), then model. Token usage renders as its
  // own always-visible element on the row's right side instead of riding
  // this clampable line, so a long summary can never crowd it out.
  const summary = String(task.summary || '').trim();
  const lastToolName = String(task.lastToolName || '').trim();
  const detail = [
    summary || (lastToolName ? `using ${lastToolName}` : ''),
    formatTaskModel(task),
  ].filter(Boolean).join(' · ');
  const tokens = formatTaskTokens(task.totalTokens);
  // Workflow rows with a digest get a fold chevron plus an (initially empty)
  // tree container right below the row; renderBackgroundTasksPanel fills the
  // container with DOM nodes after this markup lands, so digest text never
  // passes through innerHTML.
  const hasTree = workflowTreeAgents(task).length > 0;
  const treeExpanded = hasTree && isWorkflowTreeExpanded(task);
  const foldButton = hasTree
    ? `<button type="button" class="bg-task-fold" data-task-id="${escHtml(task.taskId)}" aria-expanded="${treeExpanded ? 'true' : 'false'}" title="${treeExpanded ? 'Hide' : 'Show'} workflow progress">${treeExpanded ? '▾' : '▸'}</button>`
    : '';
  const treeHolder = hasTree
    ? `<div class="bg-task-tree" data-task-id="${escHtml(task.taskId)}"${treeExpanded ? '' : ' hidden'}></div>`
    : '';
  return `
    <div class="bg-task-row" data-task-id="${escHtml(task.taskId)}">
      ${foldButton}<span class="bg-task-icon" title="${escHtml(task.taskType || 'task')}">${taskIcon(task.taskType)}</span>
      <span class="bg-task-main">
        <span class="bg-task-desc">${escHtml(task.description || task.taskId)}</span>
        ${detail ? `<span class="bg-task-detail">${escHtml(detail)}</span>` : ''}
      </span>
      <span class="bg-task-side">
        <span class="bg-task-badge">${escHtml(taskKindLabel(task))}</span>
        <span class="bg-task-side-status">
          ${tokens ? `<span class="bg-task-tokens">${escHtml(tokens)}</span>` : ''}
          <span class="bg-task-elapsed">${escHtml(elapsed)}</span>
          <button type="button" class="bg-task-stop" data-task-id="${escHtml(task.taskId)}" ${stopping ? 'disabled' : ''}>${stopping ? 'Stopping…' : 'Stop'}</button>
        </span>
      </span>
    </div>${treeHolder}`;
}

// "2 background tasks running", "1 preview", or both — the panel is shared, so
// the summary has to name whatever is actually in it.
function panelSummaryText(taskCount, previewCount) {
  const parts = [];
  if (taskCount) parts.push(`${taskCount} background task${taskCount === 1 ? '' : 's'} running`);
  if (previewCount) parts.push(`${previewCount} preview${previewCount === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export function renderBackgroundTasksPanel() {
  const panel = document.getElementById('background-tasks-panel');
  if (!panel) return;
  const conversationId = currentConversationId;
  const tasks = conversationId ? (tasksByConversation.get(conversationId) || []) : [];
  const previews = conversationId ? getPreviewsForConversation(conversationId) : [];
  // Previews outlive the task that started the dev server, so the panel stays
  // up for them even once every background task has finished.
  if (!tasks.length && !previews.length) {
    panel.hidden = true;
    panel.removeAttribute('open');
    stopElapsedTimer();
    return;
  }
  const wasOpen = panel.hasAttribute('open');
  panel.hidden = false;
  const summary = panel.querySelector('#background-tasks-summary');
  if (summary) {
    const spinner = tasks.length ? '<span class="bg-task-spinner"></span> ' : '';
    summary.innerHTML = `${spinner}${escHtml(panelSummaryText(tasks.length, previews.length))}`;
  }
  const previewList = panel.querySelector('#background-previews-list');
  if (previewList) {
    // Previews sit above the task list: the link is the thing you came to the
    // panel for, and it should not drift down as tasks come and go.
    renderPreviewRowsInto(previewList, previews);
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
    // Fill expanded workflow trees (collapsed holders stay empty — the toggle
    // re-renders, so they get content the moment they open).
    for (const holder of list.querySelectorAll('.bg-task-tree')) {
      if (holder.hasAttribute('hidden')) continue;
      const holderTaskId = holder.getAttribute('data-task-id');
      const task = tasks.find((entry) => String(entry.taskId) === holderTaskId);
      if (task) renderWorkflowTreeInto(holder, task);
    }
    for (const button of list.querySelectorAll('.bg-task-fold')) {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        toggleWorkflowTreeFold(button.dataset.taskId);
      });
    }
  }
  if (wasOpen) panel.setAttribute('open', '');
  if (tasks.length) startElapsedTimer();
  else stopElapsedTimer();
}

// A preview created, closed, or flipping online/offline re-renders the panel;
// the registry is relay-owned, so the store cannot notify through the task path.
subscribePreviews(() => renderBackgroundTasksPanel());

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
