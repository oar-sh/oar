import { query } from '@anthropic-ai/claude-agent-sdk';

const MODE_SYSTEM_PROMPT_APPEND = {
  ask: 'Prioritize clarification questions (AskUserQuestion) before implementation work; do not make broad assumptions when a question would materially change the result.',
  autopilot: 'Keep moving unless user input is truly blocking; avoid unnecessary questions.',
};

const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function normalizeClaudeEffort(value) {
  const effort = String(value || '').trim().toLowerCase();
  return CLAUDE_EFFORT_LEVELS.has(effort) ? effort : '';
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
  abortController,
  canUseTool,
  pathToClaudeCodeExecutable = '',
  queryImpl = query,
  dbg = () => {},
} = {}) {
  const normalizedModel = String(model || '').trim().toLowerCase();
  const effort = normalizeClaudeEffort(reasoningEffort);
  const options = {
    cwd,
    permissionMode: permissionModeForRelayMode(relayMode),
    systemPrompt: systemPromptForRelayMode(relayMode),
    includePartialMessages: true,
    forwardSubagentText: true,
    ...(effort ? { effort } : {}),
    ...(normalizedModel && normalizedModel !== 'auto' ? { model: String(model).trim() } : {}),
    ...(String(resume || '').trim() ? { resume: String(resume).trim() } : {}),
    ...(abortController ? { abortController } : {}),
    ...(typeof canUseTool === 'function' ? { canUseTool } : {}),
    ...(String(pathToClaudeCodeExecutable || '').trim()
      ? { pathToClaudeCodeExecutable: String(pathToClaudeCodeExecutable).trim() }
      : {}),
  };
  const { stream, push, end } = createPushableUserMessageStream();
  const turn = queryImpl({ prompt: stream, options });
  requestSummarizedThinkingDisplay(turn, dbg);
  turn.pushUserMessage = push;
  // The session process MUST call this on every teardown path or the CLI
  // process lingers waiting for more input.
  turn.endInput = end;
  if (content !== undefined && content !== null) push(content);
  return turn;
}

/**
 * Make whatever thinking the session already produces visible to the relay,
 * without changing how much Claude thinks.
 *
 * No `thinking` option is passed to `query()` on purpose: every variant of that
 * option forces a `type`, which would override the host's configuration and
 * could switch thinking on for a session that has it off. `setMaxThinkingTokens`
 * with a null budget resets to the session default — it neither enables thinking
 * on a disabled session nor changes any budget — while the second argument sets
 * the display mode, which is the part that decides whether thinking blocks reach
 * the SDK consumer at all.
 *
 * Best-effort: the method is deprecated and the control request can fail on
 * older CLIs. When it does, complete assistant messages still carry whatever
 * thinking the host's own settings allow.
 */
function requestSummarizedThinkingDisplay(turn, dbg = () => {}) {
  if (typeof turn?.setMaxThinkingTokens !== 'function') return;
  Promise.resolve()
    .then(() => turn.setMaxThinkingTokens(null, 'summarized'))
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
 * Best-effort like `requestSummarizedThinkingDisplay`: the control request is
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
