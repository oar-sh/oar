// Composer background-tasks panel: the live set of tasks (backgrounded Bash,
// subagents, monitors, workflows) still running inside a conversation's
// persistent Claude CLI process. Fed by the `background_tasks` socket event
// (REPLACE semantics per conversation) and the conversation payload's
// `backgroundTasks` on reload; hidden whenever the set is empty. Tasks that
// ended within the relay's hour (`endedTasks` / `endedBackgroundTasks`) stay
// as dimmed rows; shell and Monitor rows open their output in the task
// console (task-console.mjs) and show the relay's health: a stall hint and a
// test runner's pass/fail chip.

import { apiFetch } from './api-client.js';
import { formatTaskModelLabel, formatTaskTokens } from './task-row-format.mjs';
import { prefixToolActivityEmoji } from './tool-activity-emoji.mjs';
import {
  TASK_OUTPUT_NONE_MESSAGES,
  endedOutcome,
  normalizeStallThreshold,
  pipeHoldNotice,
  runnerChip,
  stallHint,
  stepsLabel,
  taskHasConsole,
  taskOutputUnavailable,
  taskPipeHold,
} from './task-console-render.mjs';

// Shared with the sub-agent rows (subagent-row.mjs); re-exported for the
// transcript's finished-workflow card and the existing importers.
export { formatTaskModelLabel, formatTaskTokens };
import {
  getPreviewsForConversation,
  renderPreviewRowsInto,
  subscribePreviews,
} from './preview-cards.mjs';

const tasksByConversation = new Map();
// Tasks that ended within the relay's hour (`endedTasks`): dimmed rows with
// ✓/✘ whose output still opens. A dismissed one stays hidden on this page.
const endedByConversation = new Map();
const dismissedEndedTasks = new Set();
// The relay's health poller (`background_tasks_health`, and `health` on each
// task of the payload): last output time and a test runner's counts.
const healthByConversation = new Map();
// Minutes of quiet after which a row's stall hint turns amber: the relay's
// setting, as the conversation payload (`taskStallMinutes`) or Settings
// last said. One value for the whole relay.
let stallThresholdMinutes = normalizeStallThreshold(null);
const changeListeners = new Set();
// Counts a sub-agent run's activity lines when its row names no `steps`
// (set by the page; the panel itself does not read the run store).
let subagentStepCounter = null;
const stopsInFlight = new Set();
// Manual chevron choices for workflow progress trees, keyed by taskId so a
// user's fold survives the ~2s background_tasks replace re-renders.
const workflowFoldState = new Map();
let currentConversationId = null;
let elapsedTimer = null;
// Counts the `background_tasks` events per conversation. A reload's payload
// is the set as the relay had it when the request was answered; one that was
// asked for before the latest event can land after it and would put the
// older set back (the panel shrinking under the reader, then growing again
// with the next poll).
const taskEventCounts = new Map();

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

// Detail line: the live tool call when the worker saw one ("🪓 Tool
// (PowerShell): cd …", cropped to the row by CSS), else the SDK's progress
// summary, else the bare tool name.
export function taskActivityText(task) {
  const toolCall = String(task?.lastToolCall || '').trim();
  if (toolCall) return { text: prefixToolActivityEmoji(toolCall), toolCall: true };
  const summary = String(task?.summary || '').trim();
  if (summary) return { text: summary, toolCall: false };
  const lastToolName = String(task?.lastToolName || '').trim();
  return { text: lastToolName ? `using ${lastToolName}` : '', toolCall: false };
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
  const model = formatTaskModelLabel(agent.model);
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

function normalizeTaskList(tasks) {
  return (Array.isArray(tasks) ? tasks : []).filter((task) => task?.taskId);
}

function healthMapFor(conversationId, create = false) {
  let map = healthByConversation.get(conversationId);
  if (!map && create) {
    map = new Map();
    healthByConversation.set(conversationId, map);
  }
  return map || null;
}

function rememberTaskHealth(conversationId, tasks) {
  for (const task of tasks) {
    if (task?.health && typeof task.health === 'object') healthMapFor(conversationId, true).set(String(task.taskId), task.health);
  }
}

function notifyChange(conversationId) {
  for (const listener of changeListeners) {
    try { listener(conversationId); } catch (error) { console.warn('background task listener failed', error?.message || error); }
  }
}

/**
 * Taken before a reload of the conversation is asked for, and handed to
 * isBackgroundTasksSnapshotCurrent() with its answer.
 */
export function backgroundTasksSnapshotMark(conversationId) {
  return taskEventCounts.get(String(conversationId || '').trim()) || 0;
}

/**
 * Whether a reload's sets (`backgroundTasks`, `endedBackgroundTasks`) may
 * replace the conversation's on the page: no `background_tasks` event for it
 * arrived since `mark` was taken. Otherwise the event's set is at least as
 * new, and the next reload brings whatever came after it. Without a mark:
 * always.
 */
export function isBackgroundTasksSnapshotCurrent(conversationId, mark) {
  return mark === undefined || mark === null || mark === backgroundTasksSnapshotMark(conversationId);
}

/**
 * The live set (REPLACE semantics). `endedTasks`, when the event or payload
 * carries it, replaces the ended set too; an older relay's event without it
 * leaves the ended rows alone. `event`: it came as a `background_tasks`
 * event (see isBackgroundTasksSnapshotCurrent).
 */
export function setConversationBackgroundTasks(conversationId, tasks, { endedTasks, event = false } = {}) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  if (event) taskEventCounts.set(id, backgroundTasksSnapshotMark(id) + 1);
  const normalized = normalizeTaskList(tasks);
  // Drop fold choices for tasks that left this conversation's set so the map
  // cannot grow across long sessions.
  const surviving = new Set(normalized.map((task) => String(task.taskId)));
  for (const previous of tasksByConversation.get(id) || []) {
    if (!surviving.has(String(previous.taskId))) workflowFoldState.delete(String(previous.taskId));
  }
  if (normalized.length) tasksByConversation.set(id, normalized);
  else tasksByConversation.delete(id);
  rememberTaskHealth(id, normalized);
  if (Array.isArray(endedTasks)) storeEndedTasks(id, endedTasks);
  if (id === currentConversationId) renderBackgroundTasksPanel();
  notifyChange(id);
}

function storeEndedTasks(id, endedTasks) {
  const normalized = normalizeTaskList(endedTasks);
  if (normalized.length) endedByConversation.set(id, normalized);
  else endedByConversation.delete(id);
  rememberTaskHealth(id, normalized);
}

/** The ended set alone (the conversation payload's `endedBackgroundTasks`). */
export function setConversationEndedBackgroundTasks(conversationId, endedTasks) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  storeEndedTasks(id, endedTasks);
  if (id === currentConversationId) renderBackgroundTasksPanel();
  notifyChange(id);
}

/** `background_tasks_health`: merged per task, the rest stays. */
export function setConversationTaskHealth(conversationId, health) {
  const id = String(conversationId || '').trim();
  if (!id || !health || typeof health !== 'object') return;
  const map = healthMapFor(id, true);
  for (const [taskId, entry] of Object.entries(health)) {
    if (entry && typeof entry === 'object') map.set(String(taskId), entry);
  }
  if (id === currentConversationId) renderBackgroundTasksPanel();
  notifyChange(id);
}

export function setConversationTaskStallMinutes(conversationId, minutes) {
  setTaskStallThreshold(minutes);
}

/** The relay's stall setting changed (a payload, or Settings). */
export function setTaskStallThreshold(minutes) {
  if (minutes === undefined || minutes === null) return;
  const next = normalizeStallThreshold(minutes);
  if (next === stallThresholdMinutes) return;
  stallThresholdMinutes = next;
  renderBackgroundTasksPanel();
  notifyChange(currentConversationId);
}

// The conversation is accepted for symmetry with the other getters; the
// setting is relay-wide.
export function getTaskStallMinutes(_conversationId) {
  return stallThresholdMinutes;
}

export function getBackgroundTaskHealth(conversationId, taskId) {
  const id = String(conversationId || '').trim();
  const fromMap = healthMapFor(id)?.get(String(taskId || ''));
  if (fromMap) return fromMap;
  const found = findBackgroundTask(id, taskId);
  return found?.task?.health || null;
}

export function getConversationBackgroundTasks(conversationId) {
  return tasksByConversation.get(String(conversationId || '').trim()) || [];
}

export function getConversationEndedBackgroundTasks(conversationId) {
  return endedByConversation.get(String(conversationId || '').trim()) || [];
}

/** A task of the live or the ended set: `{ task, ended }`, or null. */
export function findBackgroundTask(conversationId, taskId) {
  const id = String(taskId || '');
  if (!id) return null;
  const live = getConversationBackgroundTasks(conversationId).find((task) => String(task.taskId) === id);
  if (live) return { task: live, ended: false };
  const ended = getConversationEndedBackgroundTasks(conversationId).find((task) => String(task.taskId) === id);
  return ended ? { task: ended, ended: true } : null;
}

const panelRenderListeners = new Set();

/** Called after the panel drew its rows (the task console keeps above its row). */
export function onBackgroundTasksPanelRendered(listener) {
  panelRenderListeners.add(listener);
  return () => panelRenderListeners.delete(listener);
}

function notifyPanelRendered() {
  for (const listener of panelRenderListeners) {
    try { listener(); } catch (error) { console.warn('background task panel listener failed', error?.message || error); }
  }
}

/** Called with the conversation id after any change of tasks or health. */
export function subscribeBackgroundTasks(listener) {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function setSubagentStepCounter(counter) {
  subagentStepCounter = typeof counter === 'function' ? counter : null;
}

export function dismissEndedBackgroundTask(taskId) {
  const id = String(taskId || '').trim();
  if (!id) return;
  dismissedEndedTasks.add(id);
  renderBackgroundTasksPanel();
}

function visibleEndedTasks(conversationId) {
  return getConversationEndedBackgroundTasks(conversationId)
    .filter((task) => !dismissedEndedTasks.has(String(task.taskId)));
}

export function setBackgroundTasksConversation(conversationId) {
  currentConversationId = String(conversationId || '').trim() || null;
  renderBackgroundTasksPanel();
}

export function isBackgroundTaskStopping(conversationId, taskId) {
  return stopsInFlight.has(`${conversationId}:${taskId}`);
}

// The task console's Stop goes through here too, so the row and the console
// show the same "Stopping…" state.
export async function stopBackgroundTask(conversationId, taskId) {
  const key = `${conversationId}:${taskId}`;
  if (stopsInFlight.has(key)) return;
  stopsInFlight.add(key);
  renderBackgroundTasksPanel();
  notifyChange(conversationId);
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
      notifyChange(conversationId);
    }, 15_000);
  } catch (error) {
    stopsInFlight.delete(key);
    renderBackgroundTasksPanel();
    notifyChange(conversationId);
    console.warn('background task stop failed', error?.message || error);
  }
}

// A sub-agent task opens its record in the viewer: the task's spawning
// tool_use id is the run's id. Bash tasks, monitors and workflows have no
// record, and Copilot's tasks carry no run id.
export function subagentRunIdForTask(task) {
  const runId = String(task?.toolUseId || '').trim();
  if (!runId) return '';
  const type = String(task?.taskType || '').trim();
  return type === 'local_agent' || type === 'agent' || type === 'subagent' ? runId : '';
}

// The row's title: a sub-agent opens its record, a shell or Monitor task its
// console; a task whose provider publishes no output says so on hover.
function taskTitleHtml(task) {
  const text = escHtml(task.description || task.taskId);
  const runId = subagentRunIdForTask(task);
  if (runId) {
    return `<button type="button" class="subagent-open bg-task-desc" data-subagent-open="${escHtml(runId)}" title="Open this sub-agent's thoughts, tool calls and reply">${text}</button>`;
  }
  if (taskOutputUnavailable(task)) {
    return `<span class="bg-task-desc bg-task-desc-no-output" title="${escHtml(TASK_OUTPUT_NONE_MESSAGES.provider)}">${text}</span>`;
  }
  if (taskHasConsole(task)) {
    return `<button type="button" class="task-console-open bg-task-desc" data-task-console="${escHtml(task.taskId)}" title="Open this task's output">${text}</button>`;
  }
  return `<span class="bg-task-desc">${text}</span>`;
}

function chipHtml(health) {
  const chip = runnerChip(health);
  if (!chip) return '';
  return `<span class="bg-task-chip${chip.failed ? ' bg-task-chip-fail' : ''}" title="${escHtml(chip.title)}">${escHtml(chip.text)}</span>`;
}

// Always present on a live row (hidden while output is fresh) so the 1 s
// timer can update it in place. A command piped into tail is quiet
// until it ends: its hover title says so.
function stallHtml(hint, task) {
  const classes = `bg-task-stall${hint?.warn ? ' bg-task-stall-warn' : ''}`;
  const notice = pipeHoldNotice(taskPipeHold(task));
  const title = notice ? ` title="${escHtml(notice.title)}"` : '';
  return `<span class="${classes}"${title}${hint ? '' : ' hidden'}>${hint ? escHtml(hint.text) : ''}</span>`;
}

function taskSteps(task) {
  const label = stepsLabel(task?.steps);
  if (label || !subagentRunIdForTask(task) || !subagentStepCounter) return label;
  try {
    const counted = subagentStepCounter(String(task.toolUseId));
    return Number.isFinite(Number(counted)) && Number(counted) > 0 ? stepsLabel(counted) : '';
  } catch {
    return '';
  }
}

export function renderTaskRow(conversationId, task) {
  const key = `${conversationId}:${task.taskId}`;
  const stopping = stopsInFlight.has(key);
  const elapsed = formatElapsed(task.startedAt);
  // Token usage and the model render on the row's right side instead of
  // riding the detail line, so a long tool call can never crowd them out.
  const activity = taskActivityText(task);
  const modelLabel = formatTaskModelLabel(task.model);
  const modelTitle = task.modelInherited === true ? `${task.model} (inherited from the session)` : task.model;
  const tokens = formatTaskTokens(task.totalTokens);
  const steps = taskSteps(task);
  const health = getBackgroundTaskHealth(conversationId, task.taskId);
  const stall = taskHasConsole(task)
    ? stallHint(health?.lastOutputAt, getTaskStallMinutes(conversationId))
    : null;
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
        ${taskTitleHtml(task)}
        ${activity.text ? `<span class="bg-task-detail${activity.toolCall ? ' bg-task-toolcall' : ''}" title="${escHtml(activity.text)}">${escHtml(activity.text)}</span>` : ''}
      </span>
      <span class="bg-task-side">
        <span class="bg-task-side-head">
          ${modelLabel ? `<span class="bg-task-model" title="${escHtml(modelTitle)}">${escHtml(modelLabel)}</span>` : ''}
          <span class="bg-task-badge">${escHtml(taskKindLabel(task))}</span>
        </span>
        <span class="bg-task-side-status">
          ${tokens ? `<span class="bg-task-tokens">${escHtml(tokens)}</span>` : ''}
          ${steps ? `<span class="bg-task-steps">${escHtml(steps)}</span>` : ''}
          ${chipHtml(health)}
          ${taskHasConsole(task) ? stallHtml(stall, task) : ''}
          <span class="bg-task-elapsed">${escHtml(elapsed)}</span>
          ${task.stoppable === false ? '' : `<button type="button" class="bg-task-stop" data-task-id="${escHtml(task.taskId)}" ${stopping ? 'disabled' : ''}>${stopping ? 'Stopping…' : 'Stop'}</button>`}
        </span>
      </span>
    </div>${treeHolder}`;
}

function endedDuration(task) {
  const started = Number(task.startedAt);
  const endedAt = Number.isFinite(Number(task.endedAt)) ? Number(task.endedAt) : Date.parse(String(task.endedAt || ''));
  if (!Number.isFinite(started) || started <= 0 || !Number.isFinite(endedAt) || endedAt < started) return '';
  const seconds = Math.floor((endedAt - started) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A task that ended within the hour: dimmed, ✓/✘, no Stop, a dismiss ×. */
export function renderEndedTaskRow(conversationId, task) {
  const outcome = endedOutcome(task);
  const health = getBackgroundTaskHealth(conversationId, task.taskId);
  const duration = endedDuration(task);
  return `
    <div class="bg-task-row bg-task-row-ended" data-task-id="${escHtml(task.taskId)}">
      <span class="bg-task-icon" title="${escHtml(task.taskType || 'task')}">${taskIcon(task.taskType)}</span>
      <span class="bg-task-main">
        ${taskTitleHtml(task)}
      </span>
      <span class="bg-task-side">
        <span class="bg-task-side-head">
          <span class="bg-task-badge">${escHtml(taskKindLabel(task))}</span>
        </span>
        <span class="bg-task-side-status">
          ${chipHtml(health)}
          <span class="bg-task-outcome${outcome.failed ? ' bg-task-outcome-fail' : outcome.ok ? ' bg-task-outcome-ok' : ''}" title="${escHtml(outcome.label)}">${outcome.icon}</span>
          ${duration ? `<span class="bg-task-elapsed">${escHtml(duration)}</span>` : ''}
          <button type="button" class="bg-task-dismiss" data-task-id="${escHtml(task.taskId)}" aria-label="Dismiss" title="Hide this finished task">×</button>
        </span>
      </span>
    </div>`;
}

// "2 background tasks running · 1 finished", "1 preview", or a mix — the
// panel is shared, so the summary has to name whatever is actually in it.
// Only live tasks count as running.
export function panelSummaryText(taskCount, previewCount, endedCount = 0) {
  const parts = [];
  if (taskCount) parts.push(`${taskCount} background task${taskCount === 1 ? '' : 's'} running`);
  if (endedCount) parts.push(`${endedCount} finished`);
  if (previewCount) parts.push(`${previewCount} preview${previewCount === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export function renderBackgroundTasksPanel() {
  const panel = document.getElementById('background-tasks-panel');
  if (!panel) return;
  const conversationId = currentConversationId;
  const tasks = conversationId ? (tasksByConversation.get(conversationId) || []) : [];
  const ended = conversationId ? visibleEndedTasks(conversationId) : [];
  const previews = conversationId ? getPreviewsForConversation(conversationId) : [];
  // Previews outlive the task that started the dev server, so the panel stays
  // up for them even once every background task has finished.
  if (!tasks.length && !ended.length && !previews.length) {
    panel.hidden = true;
    panel.removeAttribute('open');
    // No stale rows behind the hidden panel (a dismissed last row is gone).
    const staleList = panel.querySelector('#background-tasks-list');
    if (staleList) staleList.innerHTML = '';
    stopElapsedTimer();
    notifyPanelRendered();
    return;
  }
  const wasOpen = panel.hasAttribute('open');
  panel.hidden = false;
  const summary = panel.querySelector('#background-tasks-summary');
  if (summary) {
    const spinner = tasks.length ? '<span class="bg-task-spinner"></span> ' : '';
    summary.innerHTML = `${spinner}${escHtml(panelSummaryText(tasks.length, previews.length, ended.length))}`;
  }
  const previewList = panel.querySelector('#background-previews-list');
  if (previewList) {
    // Previews sit above the task list: the link is the thing you came to the
    // panel for, and it should not drift down as tasks come and go.
    renderPreviewRowsInto(previewList, previews);
  }
  const list = panel.querySelector('#background-tasks-list');
  if (list) {
    list.innerHTML = tasks.map((task) => renderTaskRow(conversationId, task)).join('')
      + ended.map((task) => renderEndedTaskRow(conversationId, task)).join('');
    for (const button of list.querySelectorAll('.bg-task-stop')) {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        void stopBackgroundTask(conversationId, button.dataset.taskId);
      });
    }
    for (const button of list.querySelectorAll('.bg-task-dismiss')) {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        dismissEndedBackgroundTask(button.dataset.taskId);
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
  notifyPanelRendered();
}

// A preview created, closed, or flipping online/offline re-renders the panel;
// the registry is relay-owned, so the store cannot notify through the task path.
subscribePreviews(() => renderBackgroundTasksPanel());

function startElapsedTimer() {
  if (elapsedTimer) return;
  elapsedTimer = setInterval(() => {
    const panel = document.getElementById('background-tasks-panel');
    if (!panel || panel.hidden || !panel.hasAttribute('open')) return;
    const conversationId = currentConversationId;
    const tasks = conversationId ? (tasksByConversation.get(conversationId) || []) : [];
    const threshold = getTaskStallMinutes(conversationId);
    for (const task of tasks) {
      const rowSelector = `.bg-task-row:not(.bg-task-row-ended)[data-task-id="${CSS.escape(task.taskId)}"]`;
      const row = panel.querySelector(`${rowSelector} .bg-task-elapsed`);
      if (row) row.textContent = formatElapsed(task.startedAt);
      const stallEl = panel.querySelector(`${rowSelector} .bg-task-stall`);
      if (stallEl) applyStallHint(stallEl, stallHint(getBackgroundTaskHealth(conversationId, task.taskId)?.lastOutputAt, threshold));
    }
  }, 1000);
}

function applyStallHint(element, hint) {
  element.hidden = !hint;
  element.textContent = hint ? hint.text : '';
  element.className = `bg-task-stall${hint?.warn ? ' bg-task-stall-warn' : ''}`;
}

function stopElapsedTimer() {
  if (!elapsedTimer) return;
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}
