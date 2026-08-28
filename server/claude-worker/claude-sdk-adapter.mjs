import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';

import { parseThinkingDisplay } from '../../shared/claude-thinking.mjs';
import { createPreviewToolDefinition } from './claude-preview-tool.mjs';

// The name the in-process MCP server is registered under; it prefixes every
// tool it carries on the wire (`mcp__relay__preview`).
export const RELAY_MCP_SERVER_NAME = 'relay';

const MODE_SYSTEM_PROMPT_APPEND = {
  ask: 'Prioritize clarification questions (AskUserQuestion) before implementation work; do not make broad assumptions when a question would materially change the result.',
  autopilot: 'Keep moving unless user input is truly blocking; avoid unnecessary questions.',
};

const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// Relay sentinel for the SDK's session-scoped `ultracode` settings flag
// (xhigh effort plus standing workflow orchestration). It arrives on the same
// `reasoningEffort` wire field as real effort levels but must never be sent
// as an `effort`/`effortLevel` value — the CLI's schema silently discards
// unknown levels. `claudeUltracodeFlagSettings` is the translation.
export const CLAUDE_ULTRACODE_EFFORT = 'ultracode';

export function normalizeClaudeEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  if (effort === CLAUDE_ULTRACODE_EFFORT) return effort;
  return CLAUDE_EFFORT_LEVELS.has(effort) ? effort : '';
}

/**
 * The flag-settings payload that moves a live session into or out of
 * ultracode. `enableWorkflows` is explicit because the worker loads no
 * filesystem settings, so nothing else would switch the feature on; the
 * effort is pinned to xhigh (what the flag implies) rather than left to the
 * flag layer's previous `effortLevel`, so enabling ultracode always lands on
 * the same tier regardless of adapt history. Leaving ultracode clears both
 * flags back to their defaults alongside the newly requested effort.
 */
export function claudeUltracodeFlagSettings(effort) {
  if (effort === CLAUDE_ULTRACODE_EFFORT) {
    return { ultracode: true, enableWorkflows: true, effortLevel: 'xhigh' };
  }
  return { ultracode: null, enableWorkflows: null, effortLevel: effort || null };
}

/**
 * The flag-settings payload that moves a live session onto another auto-compact
 * window. `null` clears the flag layer back to the CLI's model-tuned default,
 * which is exactly what "Auto" means — leaving the previous window pinned would
 * make the setting one-way.
 */
export function claudeAutoCompactFlagSettings(autoCompactWindow) {
  const window = normalizeAutoCompactWindow(autoCompactWindow);
  return { autoCompactWindow: window };
}

/**
 * The flag-settings payload that pins (or clears) `alwaysThinkingEnabled` on a
 * live session.
 *
 * Probed 2026-08-26 (CLI 2.1.226): the CLI honors this key at SPAWN in both
 * directions, and mid-session only in the ENABLING direction — a mid-session
 * `false` is accepted and **silently ignored**; thinking keeps running and
 * stays visible. `adaptProcess` therefore only calls this for `true`, and
 * leaves a disable for the next spawn to apply. Do not "fix" that guard:
 * calling this with `false` doesn't fail, it lies.
 */
export function claudeThinkingFlagSettings(thinkingEnabled) {
  return { alwaysThinkingEnabled: strictThinkingEnabled(thinkingEnabled) };
}

/**
 * true / false / null(=say nothing), with NO relay default applied.
 *
 * The adapter stays mechanical on purpose: the "unset means on" policy lives
 * in `shared/claude-thinking.mjs` and is resolved by the relay before the
 * value ever gets here. If this used `parseThinkingEnabled` instead, its
 * default would fire for a caller that passed nothing and pin
 * `alwaysThinkingEnabled` on every spawn — including the ones that mean to
 * leave the key out entirely.
 */
function strictThinkingEnabled(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

/** A token count, or null for Auto. Junk is Auto, never a pinned window. */
export function normalizeAutoCompactWindow(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric);
}

/**
 * The single `settings` object a spawn gets. Both the ultracode flags and the
 * auto-compact window live in `Settings`, so they must be merged here — two
 * spreads of `settings` in the options literal would silently clobber each
 * other. Returns null when nothing needs to be set.
 */
export function claudeSpawnSettings({ ultracode = false, autoCompactWindow = null, thinkingEnabled = null } = {}) {
  const window = normalizeAutoCompactWindow(autoCompactWindow);
  const thinking = strictThinkingEnabled(thinkingEnabled);
  const settings = {
    ...(ultracode ? { ultracode: true, enableWorkflows: true } : {}),
    ...(window !== null ? { autoCompactWindow: window } : {}),
    // null means OMIT the key. The relay always resolves to true/false
    // before spawning (its default is on), so in practice the key is always
    // present; the omit path exists for direct callers that mean to say
    // nothing.
    ...(thinking !== null ? { alwaysThinkingEnabled: thinking } : {}),
  };
  return Object.keys(settings).length ? settings : null;
}

export function permissionModeForRelayMode(relayMode) {
  const mode = String(relayMode || 'agent').trim().toLowerCase();
  if (mode === 'plan') return 'plan';
  return 'default';
}

export function systemPromptForRelayMode(relayMode) {
  const mode = String(relayMode || 'agent').trim().toLowerCase();
  const append = MODE_SYSTEM_PROMPT_APPEND[mode];
  return {
    type: 'preset',
    preset: 'claude_code',
    ...(append ? { append } : {}),
  };
}

/**
 * The in-process MCP server carrying the relay's own tools, running inside the
 * worker rather than as a child process. It is registered on every session:
 * the worker cannot see whether the relay's preview lane is enabled, and a
 * disabled lane answers the tool call with a refusal the model can relay,
 * which beats inventing a capability flag to plumb through the delivery
 * payload. `getConversationId` is called per tool call because a process
 * outlives the turn it was spawned for.
 */
export function createRelayMcpServer({ api, getConversationId, dbg } = {}) {
  return createSdkMcpServer({
    name: RELAY_MCP_SERVER_NAME,
    tools: [createPreviewToolDefinition({ api, getConversationId, dbg })],
  });
}

/**
 * A user-message stream the session process feeds for the whole life of the
 * CLI process: each `push(content)` becomes one user turn, and the stream
 * only ends on `end()` — which is what lets the CLI exit. The CLI begins
 * shutting down as soon as the input stream ends and the pending result is
 * emitted, which also closes the control transport (canUseTool, context
 * usage), so the session process keeps this open while background tasks or
 * queued continuations still need the process alive.
 */
function createPushableUserMessageStream() {
  const queued = [];
  let wake = null;
  let ended = false;
  async function* stream() {
    for (;;) {
      while (queued.length) yield queued.shift();
      if (ended) return;
      await new Promise((resolve) => { wake = resolve; });
      wake = null;
    }
  }
  return {
    stream: stream(),
    push(content) {
      if (ended) throw new Error('user message stream already ended');
      queued.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      });
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
  };
}

/**
 * The only module that imports `@anthropic-ai/claude-agent-sdk`.
 *
 * Starts one persistent streaming-input `query()` — the CLI process that
 * carries a whole relay session: the first user turn, any user turns pushed
 * later, and the background-task continuation turns the CLI dequeues on its
 * own. Returns the SDK `Query` async iterable with two extra methods:
 * `pushUserMessage(content)` to feed another turn and `endInput()` to let the
 * process exit once its current work drains.
 */
export function startClaudeSession({
  content,
  cwd,
  model = '',
  resume = '',
  relayMode = 'agent',
  reasoningEffort = '',
  autoCompactWindow = null,
  thinkingEnabled = null,
  thinkingDisplay = '',
  abortController,
  canUseTool,
  pathToClaudeCodeExecutable = '',
  api = null,
  getConversationId = () => '',
  queryImpl = query,
  dbg = () => {},
} = {}) {
  const normalizedModel = String(model || '').trim().toLowerCase();
  const effort = normalizeClaudeEffort(reasoningEffort);
  const ultracode = effort === CLAUDE_ULTRACODE_EFFORT;
  const effortOption = ultracode ? 'xhigh' : effort;
  // Spawn-time twin of the flag-settings helpers: the settings layer is the
  // only way to hand a fresh CLI the session-scoped ultracode flag, the
  // auto-compact window and the thinking pin, and all three share one
  // `settings` object.
  const spawnSettings = claudeSpawnSettings({ ultracode, autoCompactWindow, thinkingEnabled });
  // Relay tools need the worker's authenticated API helper; a caller that
  // passes none (tests, probes) gets a session without them.
  const relayMcpServer = typeof api === 'function'
    ? createRelayMcpServer({ api, getConversationId, dbg })
    : null;
  const options = {
    cwd,
    permissionMode: permissionModeForRelayMode(relayMode),
    systemPrompt: systemPromptForRelayMode(relayMode),
    includePartialMessages: true,
    forwardSubagentText: true,
    ...(effortOption ? { effort: effortOption } : {}),
    ...(spawnSettings ? { settings: spawnSettings } : {}),
    ...(normalizedModel && normalizedModel !== 'auto' ? { model: String(model).trim() } : {}),
    ...(String(resume || '').trim() ? { resume: String(resume).trim() } : {}),
    ...(abortController ? { abortController } : {}),
    ...(typeof canUseTool === 'function' ? { canUseTool } : {}),
    ...(relayMcpServer ? { mcpServers: { [RELAY_MCP_SERVER_NAME]: relayMcpServer } } : {}),
    ...(String(pathToClaudeCodeExecutable || '').trim()
      ? { pathToClaudeCodeExecutable: String(pathToClaudeCodeExecutable).trim() }
      : {}),
  };
  const { stream, push, end } = createPushableUserMessageStream();
  const turn = queryImpl({ prompt: stream, options });
  applyThinkingDisplay(turn, thinkingDisplay, { dbg });
  turn.pushUserMessage = push;
  // The session process MUST call this on every teardown path or the CLI
  // process lingers waiting for more input.
  turn.endInput = end;
  if (content !== undefined && content !== null) push(content);
  return turn;
}

/**
 * Set the session's thinking display mode, without changing how much Claude
 * thinks.
 *
 * No `thinking` option is passed to `query()` on purpose: every variant of
 * that option forces a `type`, which would override the host's configuration
 * — the on/off axis goes through `Settings.alwaysThinkingEnabled` instead
 * (spawn settings / `claudeThinkingFlagSettings`). `setMaxThinkingTokens` is
 * deprecated on its FIRST argument only; the second (`thinkingDisplay`) has
 * no replacement on a live session and is the sole live lever for display.
 * Measured 2026-08-26: without this call the API default hides thinking text
 * (blocks arrive with empty `thinking`), so the spawn-time call is
 * load-bearing — it is what makes thought bubbles exist at all.
 *
 * `display` is a relay state ('summarized' | 'omitted' | 'host'); 'host'
 * maps to the wire's `null`, an ACTIVE instruction that clears the session
 * display mode back to the API default — not a skip.
 *
 * The budget argument is positional and re-sent on every call: hardcoding
 * `null` while a budget pin existed would silently clear it, so the caller's
 * tracked budget (always null today — the relay pins none) is threaded
 * through rather than assumed.
 *
 * Best-effort: the method can be missing on older CLIs. When the call fails,
 * complete assistant messages still carry whatever thinking the session's
 * settings allow.
 */
export function applyThinkingDisplay(turn, display, { budget = null, dbg = () => {} } = {}) {
  if (typeof turn?.setMaxThinkingTokens !== 'function') return Promise.resolve();
  const mode = parseThinkingDisplay(display);
  const wireDisplay = mode === 'host' ? null : mode;
  return Promise.resolve()
    .then(() => turn.setMaxThinkingTokens(budget ?? null, wireDisplay))
    .catch((error) => {
      dbg('thinking display request failed', error?.message || String(error));
    });
}

/**
 * Read the session's live context-window breakdown (the data behind `/context`).
 *
 * Must be called while the turn's `Query` is still open: the control request
 * travels over the same transport as the message stream, which the SDK tears
 * down once the async iterator returns. In practice that means calling this
 * from inside the `for await` loop, when the `result` message arrives.
 *
 * Best-effort like `applyThinkingDisplay`: the control request is
 * unavailable on older CLIs, and losing a context snapshot must never fail the
 * turn that produced it.
 */
export async function readContextUsage(turn, dbg = () => {}, { timeoutMs = 10000 } = {}) {
  if (typeof turn?.getContextUsage !== 'function') return null;
  let timer = null;
  try {
    // The input gate is still closed while this runs, so a CLI that never
    // answers would otherwise stall the turn indefinitely.
    return await Promise.race([
      turn.getContextUsage(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`context usage timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    dbg('context usage request failed', error?.message || String(error));
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read the session's structured `/usage` data: plan rate-limit windows plus
 * session cost/token totals — the same data Claude Code's `/usage` dialog
 * renders.
 *
 * Same transport constraint as `readContextUsage`: the control request only
 * works while the turn's `Query` is open, so this is called from the same
 * finalize step, before the input gate releases.
 *
 * The SDK marks this API EXPERIMENTAL and says the method name will change
 * when it stabilizes, so the call is feature-detected and every failure is
 * swallowed — plan limits are a nice-to-have, never a reason to fail a turn.
 */
const CLAUDE_USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

export async function readPlanUsage(turn, dbg = () => {}, { timeoutMs = 10000 } = {}) {
  if (typeof turn?.[CLAUDE_USAGE_METHOD] !== 'function') return null;
  let timer = null;
  try {
    const request = turn[CLAUDE_USAGE_METHOD]();
    // The race leaves the losing promise unobserved on timeout; swallow its
    // rejection so it cannot surface as an unhandledRejection.
    request.catch?.(() => {});
    return await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`plan usage timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (error) {
    dbg('plan usage request failed', error?.message || String(error));
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build the `canUseTool` callback for one turn. Everything is auto-allowed
 * (parity with the Copilot workers' `--allow-all` posture); the only
 * interceptions are AskUserQuestion (bridged to relay question cards) and
 * ExitPlanMode (surfaces the plan_ready board).
 *
 * ExitPlanMode is DENIED after the board is posted: allowing it tells the CLI
 * the user approved the plan, and the same turn rolls straight into
 * implementation while the board is still waiting for a choice (verified
 * against the live SDK). Denying with a review note ends the turn cleanly —
 * the board action then starts the next turn in the chosen mode via resume,
 * which matches direct Claude Code UX.
 */
const EXIT_PLAN_DENY_MESSAGE = 'Plan received — it is shown to the user in the relay for review. '
  + 'End the turn now with a short closing message and do not start implementing; '
  + 'the user\'s decision will arrive as a new message.';
// When the handler could not surface a board (no plan text reached it), the
// model must restate the plan as its final message: plan-shaped final text
// triggers the runner's fallback board, so the user still gets the review UI.
const EXIT_PLAN_DENY_NO_BOARD_MESSAGE = 'Plan received, but it could not be shown for review. '
  + 'Restate the complete plan as your final message, then end the turn without implementing; '
  + 'the user\'s decision will arrive as a new message.';
export function createCanUseTool({
  askUserBridge,
  onExitPlanMode,
  dbg = () => {},
} = {}) {
  return async function canUseTool(toolName, input, { signal } = {}) {
    const normalizedToolName = String(toolName || '').trim();
    try {
      if (normalizedToolName === 'AskUserQuestion' && askUserBridge) {
        const { answers } = await askUserBridge.handleAskUserQuestion(input, { signal });
        return {
          behavior: 'allow',
          updatedInput: { ...input, answers },
        };
      }
      if (normalizedToolName === 'ExitPlanMode' && typeof onExitPlanMode === 'function') {
        // The handler reports whether a review board was actually surfaced;
        // treat a bare undefined (legacy handlers) as posted.
        const posted = await onExitPlanMode(input);
        return {
          behavior: 'deny',
          message: posted === false ? EXIT_PLAN_DENY_NO_BOARD_MESSAGE : EXIT_PLAN_DENY_MESSAGE,
        };
      }
    } catch (error) {
      dbg('canUseTool bridge failed', normalizedToolName, error?.message || String(error));
      return {
        behavior: 'deny',
        message: `Relay bridge failed for ${normalizedToolName}: ${error?.message || error}`,
      };
    }
    return { behavior: 'allow', updatedInput: input };
  };
}
