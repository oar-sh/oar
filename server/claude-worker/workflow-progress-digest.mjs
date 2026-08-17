// Normalize Claude CLI workflow progress into the bounded digest the relay
// ships on a background-task row (`workflowProgress`).
//
// Two sources feed the digest (verified against CLI 2.1.226):
//
// - `<sessionDir>/workflows/<runId>.json` — the run record, written only at
//   workflow COMPLETION. Its `workflowProgress` array mixes
//   `{type:'workflow_phase'}` and `{type:'workflow_agent'}` entries and is the
//   authoritative tree once it exists.
// - `<sessionDir>/subagents/workflows/<runId>/journal.jsonl` — the live
//   append-only source while the run is in flight: `{type:'started', key,
//   agentId}` then `{type:'result', key, agentId, result}` per agent.
//   started-without-result = running; result = done.
//
// The digest shape is a contract shared with the relay sanitizer and the
// client tree renderer — keep it EXACTLY this:
//
//   { runId, workflowName, status, agentCount, totalTokens, durationMs,
//     phases: [{index, title}], logs: [string],          // last 5, ≤300 chars
//     agents: [{index, label, phaseIndex, phaseTitle, model, state, attempt,
//               lastToolName, tokens, toolCalls, durationMs, startedAt}],
//     agentsOmitted }                                    // agents ≤100, order kept
//
// Both file formats are undocumented CLI internals, so every field is
// presence-checked and clamped; malformed input degrades to omitted fields or
// a null digest — these functions NEVER throw.

const MAX_AGENTS = 100;
const MAX_PHASES = 50;
const MAX_LOGS = 5;
const MAX_LOG_CHARS = 300;
const MAX_LABEL_CHARS = 160;
const MAX_TOOL_NAME_CHARS = 160;
const MAX_TITLE_CHARS = 120;
const MAX_MODEL_CHARS = 80;
const MAX_STATE_CHARS = 32;
const MAX_RUN_ID_CHARS = 64;
const MAX_WORKFLOW_NAME_CHARS = 120;

/** Trimmed string clamped to `max` chars, or null for anything non-string. */
function clampString(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/** A finite number, or null — never NaN/Infinity/strings coerced. */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Digest a completed (or partial) run record. Returns null when `record` is
 * not an object carrying a usable `runId` — the one field every real record
 * has and the digest cannot identify a run without.
 */
export function digestFromRunRecord(record) {
  try {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    const runId = clampString(record.runId, MAX_RUN_ID_CHARS);
    if (!runId) return null;

    const progress = Array.isArray(record.workflowProgress) ? record.workflowProgress : [];
    const phases = [];
    const agents = [];
    let agentTotal = 0;
    for (const entry of progress) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type === 'workflow_phase') {
        if (phases.length < MAX_PHASES) {
          phases.push({
            index: finiteOrNull(entry.index) ?? phases.length + 1,
            title: clampString(entry.title, MAX_TITLE_CHARS),
          });
        }
        continue;
      }
      if (entry.type !== 'workflow_agent') continue;
      agentTotal += 1;
      if (agents.length >= MAX_AGENTS) continue;
      // promptPreview/resultPreview are dropped deliberately: they are the
      // multi-hundred-char fields that would balloon a 2s-cadence broadcast.
      agents.push({
        index: finiteOrNull(entry.index) ?? agentTotal,
        label: clampString(entry.label, MAX_LABEL_CHARS),
        phaseIndex: finiteOrNull(entry.phaseIndex),
        phaseTitle: clampString(entry.phaseTitle, MAX_TITLE_CHARS),
        model: clampString(entry.model, MAX_MODEL_CHARS),
        state: clampString(entry.state, MAX_STATE_CHARS),
        attempt: finiteOrNull(entry.attempt),
        lastToolName: clampString(entry.lastToolName, MAX_TOOL_NAME_CHARS),
        tokens: finiteOrNull(entry.tokens),
        toolCalls: finiteOrNull(entry.toolCalls),
        durationMs: finiteOrNull(entry.durationMs),
        startedAt: finiteOrNull(entry.startedAt),
      });
    }

    // The record also carries top-level `phases: [{title}]`; used only when
    // workflowProgress had no phase entries to derive titles from.
    if (!phases.length && Array.isArray(record.phases)) {
      for (const phase of record.phases) {
        if (phases.length >= MAX_PHASES) break;
        if (!phase || typeof phase !== 'object') continue;
        phases.push({ index: phases.length + 1, title: clampString(phase.title, MAX_TITLE_CHARS) });
      }
    }

    const logs = (Array.isArray(record.logs) ? record.logs : [])
      .filter((line) => typeof line === 'string' && line.trim())
      .slice(-MAX_LOGS)
      .map((line) => line.slice(0, MAX_LOG_CHARS));

    return {
      runId,
      workflowName: clampString(record.workflowName, MAX_WORKFLOW_NAME_CHARS),
      status: clampString(record.status, MAX_STATE_CHARS),
      agentCount: finiteOrNull(record.agentCount) ?? (agentTotal || null),
      totalTokens: finiteOrNull(record.totalTokens),
      // Top-level run duration: only the completed run record knows it. The
      // finished-task card renders it; renderers ignore it when null.
      durationMs: finiteOrNull(record.durationMs),
      phases,
      logs,
      agents,
      agentsOmitted: Math.max(0, agentTotal - agents.length),
    };
  } catch {
    return null;
  }
}

// Shared-prefix stripping only kicks in when the common prefix is long enough
// to be boilerplate; short shared openers ("review: ") are kept as-is.
const MIN_COMMON_PREFIX_CHARS = 24;
// Leftovers a stripped tail may start with (the prefix often ends mid-
// separator): whitespace, dashes, and common punctuation.
const LABEL_LEADING_NOISE = /^[\s.,;:!?·…"'()[\]{}<>|/\\`~*_#=–—-]+/;

/**
 * Strip the longest common prefix shared by the given labels. Live labels are
 * prompt previews, and workflows often prefix every agent's prompt with the
 * same boilerplate — N indistinguishable labels. When ≥2 non-empty string
 * entries share a prefix of ≥24 chars, that prefix is stripped from each and
 * the tail (trimmed of leading whitespace/punctuation, clamped to the label
 * limit) becomes the label. Non-string entries pass through untouched and do
 * not join the prefix computation; a label that was nothing but the shared
 * prefix keeps its original text (an empty label would be strictly worse).
 * Single label or short prefix ⇒ unchanged. Pure and throw-free.
 */
export function stripCommonPromptPrefix(labels) {
  try {
    if (!Array.isArray(labels)) return [];
    const strings = labels.filter((label) => typeof label === 'string' && label.length > 0);
    if (strings.length < 2) return labels.slice();
    let prefix = strings[0];
    for (const label of strings) {
      let shared = 0;
      const limit = Math.min(prefix.length, label.length);
      while (shared < limit && prefix[shared] === label[shared]) shared += 1;
      prefix = prefix.slice(0, shared);
      if (!prefix) break;
    }
    if (prefix.length < MIN_COMMON_PREFIX_CHARS) return labels.slice();
    return labels.map((label) => {
      if (typeof label !== 'string' || label.length === 0) return label;
      const tail = label.slice(prefix.length).replace(LABEL_LEADING_NOISE, '').slice(0, MAX_LABEL_CHARS);
      return tail || label;
    });
  } catch {
    return Array.isArray(labels) ? labels.slice() : [];
  }
}

/** Label lookup tolerant of a Map or a plain object (own keys only). */
function labelFor(labelsByAgentId, agentId) {
  try {
    if (!labelsByAgentId) return null;
    if (typeof labelsByAgentId.get === 'function') return labelsByAgentId.get(agentId) ?? null;
    if (typeof labelsByAgentId === 'object' && Object.hasOwn(labelsByAgentId, agentId)) {
      return labelsByAgentId[agentId];
    }
  } catch {
    // fall through to null
  }
  return null;
}

/**
 * Digest the live journal while the run record does not exist yet. `entries`
 * are the parsed journal lines in file order; `labelsByAgentId` (Map or plain
 * object) supplies per-agent labels read from the first line of each
 * `agent-<agentId>.jsonl`, falling back to `agent <n>`. The journal carries no
 * phases, tokens, or timings, so those digest fields are empty/null; `runId`
 * is optional (the caller knows it from the run directory's name).
 * Returns null when no agent can be derived — an empty digest has nothing to
 * render and would only churn the publish path.
 */
export function digestFromJournal({ entries, labelsByAgentId, workflowName, runId } = {}) {
  try {
    if (!Array.isArray(entries)) return null;
    const stateByAgentId = new Map();
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const agentId = clampString(entry.agentId, 256);
      if (!agentId) continue;
      if (entry.type === 'started') {
        if (!stateByAgentId.has(agentId)) stateByAgentId.set(agentId, 'running');
      } else if (entry.type === 'result') {
        // A result without a prior `started` still proves the agent ran.
        stateByAgentId.set(agentId, 'done');
      }
    }
    if (!stateByAgentId.size) return null;

    // Live labels are prompt previews; when the workflow prefixed every
    // agent's prompt with the same boilerplate, strip the shared prefix so
    // each label shows the distinguishing tail instead of N identical strings.
    // The strip runs on the UNCLAMPED strings — boilerplate longer than the
    // label limit would otherwise clamp every label to the same prefix and
    // leave nothing to distinguish — and the label clamp is applied to the
    // results (stripped tails come back pre-clamped, but the keep-original
    // degenerate paths do not).
    const agentEntries = [...stateByAgentId];
    const labels = stripCommonPromptPrefix(
      agentEntries.map(([agentId]) => {
        const label = labelFor(labelsByAgentId, agentId);
        return typeof label === 'string' ? label.trim() || null : null;
      }),
    ).map((label) => clampString(label, MAX_LABEL_CHARS));

    const agents = [];
    let index = 0;
    for (const [, state] of agentEntries) {
      index += 1;
      if (agents.length >= MAX_AGENTS) continue;
      agents.push({
        index,
        label: (typeof labels[index - 1] === 'string' && labels[index - 1]) || `agent ${index}`,
        phaseIndex: null,
        phaseTitle: null,
        model: null,
        state,
        attempt: null,
        lastToolName: null,
        tokens: null,
        toolCalls: null,
        durationMs: null,
        startedAt: null,
      });
    }

    return {
      runId: clampString(runId, MAX_RUN_ID_CHARS),
      workflowName: clampString(workflowName, MAX_WORKFLOW_NAME_CHARS),
      status: 'running',
      agentCount: stateByAgentId.size,
      totalTokens: null,
      durationMs: null,
      phases: [],
      logs: [],
      agents,
      agentsOmitted: Math.max(0, stateByAgentId.size - agents.length),
    };
  } catch {
    return null;
  }
}
