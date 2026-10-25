import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';

import { formatClaudeBackgroundCommandLimitLabel } from '../../shared/claude-background-command-limit.mjs';
import { parseThinkingDisplay } from '../../shared/claude-thinking.mjs';
import { MEDIA_EMBED_INSTRUCTION_TEXT } from '../../shared/media-embed-instructions.mjs';
import { REMOTE_RELAY_TOOL_CALL_TIMEOUT_MS } from '../../shared/remote-relay-tool-core.mjs';
import { createPreviewToolDefinition } from './claude-preview-tool.mjs';
import { createRemoteRelayToolDefinition } from './claude-remote-relay-tool.mjs';
import { CLAUDE_LIVE_FLAG_SETTINGS_CODE, CLAUDE_LIVE_FLAG_SETTINGS_GUIDANCE } from './claude-turn-failure.mjs';

export { CLAUDE_LIVE_FLAG_SETTINGS_CODE };

// The name the in-process MCP server is registered under; it prefixes every
// tool it carries on the wire (`mcp__relay__preview`, `mcp__relay__remote_relay`).
export const RELAY_MCP_SERVER_NAME = 'relay';

// The per-server tool-call timeout the CLI applies to the relay's tools.
// Measured against CLI 2.1.283: an SDK server's calls are bounded by this
// value, else by the MCP_TOOL_TIMEOUT environment variable, else by 1e8 ms —
// and SDK servers are exempt from the idle timeout. Pinning it here keeps a
// host-wide MCP_TOOL_TIMEOUT (set for some other server) from cutting off a
// remote_relay wait: those run up to wait_seconds (≤ 600 s) plus however long
// an approval card sits unanswered.
export const RELAY_MCP_TOOL_TIMEOUT_MS = REMOTE_RELAY_TOOL_CALL_TIMEOUT_MS;

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
export function claudeSpawnSettings({ ultracode = false, autoCompactWindow = null, thinkingEnabled = null, attribution = null } = {}) {
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
    // What commits and PRs say (shared/claude-attribution.mjs). null is
    // vanilla: the key is left out and the CLI uses its own.
    ...(attribution && typeof attribution === 'object' ? { attribution } : {}),
  };
  return Object.keys(settings).length ? settings : null;
}

/**
 * Live twin of the attribution spawn setting, for a value (OAR or off). A
 * running CLI takes a new text through the flag layer (it arrives as a fresh
 * system-reminder on the next user turn) but cannot UNSET a value it was
 * spawned with — `{}`, `null` and `true` all leave the spawn-time text in
 * force (wire-logged probe, 2026-10-01). Back to vanilla therefore means a
 * fresh process without the key; the session runner does that.
 */
export function claudeAttributionFlagSettings(attribution) {
  return { attribution: attribution && typeof attribution === 'object' ? attribution : { commit: '', pr: '', sessionUrl: false } };
}

export function permissionModeForRelayMode(relayMode) {
  const mode = String(relayMode || 'agent').trim().toLowerCase();
  if (mode === 'plan') return 'plan';
  return 'default';
}

// Bash timeouts the CLI reads from its environment (measured against CLI
// 2.1.292). BASH_DEFAULT_TIMEOUT_MS is the only lever on the background
// default (`max(30 min, BASH_DEFAULT_TIMEOUT_MS)`), but it also becomes the
// foreground default; CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS therefore caps a
// main-agent foreground command at 2 min and then moves it to the background
// instead of letting it block the turn. BASH_MAX_TIMEOUT_MS lifts the ceiling
// an explicit `timeout` may ask for (foreground and background) to 8 h.
// Commands that start with `sleep` are never moved to the background by the
// CLI, and subagents get no auto-background; both run in the foreground for
// up to the default.
export const CLAUDE_BASH_MAX_TIMEOUT_MS = 8 * 3_600_000;
export const CLAUDE_AUTO_BACKGROUND_TIMEOUT_MS = 120_000;

/**
 * The environment a Claude CLI spawn gets, or null to inherit the worker's
 * own. `env` REPLACES the subprocess environment in the SDK, so the base is
 * spread in.
 */
export function claudeSpawnEnv({ backgroundCommandLimitMs = null, baseEnv = process.env } = {}) {
  const limit = Number(backgroundCommandLimitMs);
  if (backgroundCommandLimitMs === null || !Number.isFinite(limit) || limit <= 0) return null;
  return {
    ...baseEnv,
    BASH_DEFAULT_TIMEOUT_MS: String(Math.round(limit)),
    BASH_MAX_TIMEOUT_MS: String(Math.max(CLAUDE_BASH_MAX_TIMEOUT_MS, Math.round(limit))),
    CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS: String(CLAUDE_AUTO_BACKGROUND_TIMEOUT_MS),
  };
}

/** How to run long commands, with the session's limit when it is known. */
export function longCommandInstructionText(backgroundCommandLimitMs = null) {
  const limit = Number(backgroundCommandLimitMs);
  const known = backgroundCommandLimitMs !== null && Number.isFinite(limit) && limit > 0;
  const limitClause = known
    ? `Background Bash commands are stopped after ${formatClaudeBackgroundCommandLimitLabel(limit / 60_000)} unless you pass a longer timeout (up to 8 h); `
    : 'For long background Bash commands, ';
  return `${limitClause}write the full output to a log file instead of piping it into tail or head, `
    + 'since the pipe holds the output back and loses it if the command is stopped. '
    + 'Start runs that must survive a session restart detached with nohup and a log file.';
}

export function systemPromptForRelayMode(relayMode, { backgroundCommandLimitMs = null } = {}) {
  const mode = String(relayMode || 'agent').trim().toLowerCase();
  // The media-embed capability rides every session — unlike the mode nudges it
  // is renderer knowledge the model cannot discover any other way. The long
  // command note rides every session too: the limit is the relay's setting.
  const append = [
    MEDIA_EMBED_INSTRUCTION_TEXT,
    longCommandInstructionText(backgroundCommandLimitMs),
    MODE_SYSTEM_PROMPT_APPEND[mode],
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    type: 'preset',
    preset: 'claude_code',
    append,
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
 *
 * `remote_relay` is the exception: it rides along only when the worker found
 * at least one paired remote (`remoteRelayTool`), because a tool that can do
 * nothing on a relay without remotes would only cost context on every turn.
 */
export function createRelayMcpServer({ api, getConversationId, dbg, remoteRelayTool = false } = {}) {
  return createSdkMcpServer({
    name: RELAY_MCP_SERVER_NAME,
    timeout: RELAY_MCP_TOOL_TIMEOUT_MS,
    tools: [
      createPreviewToolDefinition({ api, getConversationId, dbg }),
      ...(remoteRelayTool ? [createRemoteRelayToolDefinition({ api, getConversationId, dbg })] : []),
    ],
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
 *
 * `held`: nothing is sent until `release()` (the messages pushed meanwhile
 * wait in order). `fail(error)` instead makes the stream throw it, which the
 * SDK answers by aborting the query; nothing held is ever sent, and neither
 * is it when the stream ends while still held.
 */
function createPushableUserMessageStream({ held = false } = {}) {
  const queued = [];
  let wake = null;
  let ended = false;
  let holding = held;
  let failure = null;
  async function* stream() {
    for (;;) {
      if (failure) throw failure;
      if (!holding) {
        while (queued.length && !failure) yield queued.shift();
        if (failure) continue;
      }
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
    release() {
      holding = false;
      wake?.();
    },
    fail(error) {
      failure = error;
      wake?.();
    },
  };
}

/** Every string in a settings object, for taking them out of a text. */
function settingsStrings(value, found = []) {
  if (typeof value === 'string') {
    if (value) found.push(value);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) settingsStrings(item, found);
  }
  return found;
}

/**
 * The blanked keys of a backend's live flag settings (top-level and `env`
 * values that are ''), for the spawn's `settings` too: an empty value holds
 * no secret, and the CLI acts on some settings at startup, before the live
 * ones land (it runs a folder's apiKeyHelper then; CLI 2.1.304,
 * scripts/deepseek-cli-proof.mjs). Null when there is none.
 */
function liveSettingsBlanks(live) {
  if (!live) return null;
  const blanks = {};
  for (const [key, value] of Object.entries(live)) {
    if (value === '') blanks[key] = '';
  }
  const env = Object.entries(live.env && typeof live.env === 'object' ? live.env : {}).filter(([, value]) => value === '');
  if (env.length) blanks.env = Object.fromEntries(env);
  return Object.keys(blanks).length ? blanks : null;
}

/** The spawn's `settings` with the live settings' blanks on top. */
function withLiveSettingsBlanks(spawnSettings, live) {
  const blanks = liveSettingsBlanks(live);
  if (!blanks) return spawnSettings;
  const settings = { ...(spawnSettings || {}), ...blanks };
  if (spawnSettings?.env || blanks.env) settings.env = { ...(spawnSettings?.env || {}), ...(blanks.env || {}) };
  return settings;
}

/**
 * How long the CLI may take to answer a backend's live flag settings (ms).
 * It answers in well under a second (CLI 2.1.304); one that never does fails
 * the turn like a refusal, and the held message is never sent.
 */
export const LIVE_FLAG_SETTINGS_TIMEOUT_MS = 60_000;

/**
 * The Error a spawn fails with when the CLI refused its live flag settings.
 * The message names no value; `detail` is the CLI's own words with every
 * value of the settings taken out.
 */
function liveFlagSettingsError(cause, settings, label = '') {
  const error = new Error(
    `Claude Code did not take the ${label ? `${label} ` : ''}connection settings before the first message, so nothing was sent.`,
  );
  error.code = CLAUDE_LIVE_FLAG_SETTINGS_CODE;
  error.guidance = CLAUDE_LIVE_FLAG_SETTINGS_GUIDANCE;
  let detail = String(cause?.message || cause || '');
  for (const value of settingsStrings(settings).sort((a, b) => b.length - a.length)) {
    detail = detail.split(value).join('[redacted]');
  }
  error.detail = detail.slice(0, 200);
  return error;
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
  attribution = null,
  // How long a backgrounded Bash command may run without its own timeout
  // (ms, the relay's setting); null leaves the CLI's defaults and the
  // worker's environment alone.
  backgroundCommandLimitMs = null,
  thinkingDisplay = '',
  abortController,
  canUseTool,
  pathToClaudeCodeExecutable = '',
  api = null,
  getConversationId = () => '',
  // Whether this process carries `remote_relay` (the worker's registration
  // decision). Fixed for the process: the tool list is part of the spawn.
  remoteRelayTool = false,
  // Another endpoint for the CLI (null = Anthropic through the host's Claude
  // login): it builds the CLI's environment and maps model and effort into
  // its terms (../deepseek-worker/deepseek-claude-backend.mjs).
  backend = null,
  liveFlagSettingsTimeoutMs = LIVE_FLAG_SETTINGS_TIMEOUT_MS,
  queryImpl = query,
  dbg = () => {},
} = {}) {
  const normalizedModel = String(model || '').trim().toLowerCase();
  const effort = backend ? '' : normalizeClaudeEffort(reasoningEffort);
  const ultracode = effort === CLAUDE_ULTRACODE_EFFORT;
  const effortOption = backend ? backend.effortOption(reasoningEffort) : (ultracode ? 'xhigh' : effort);
  const cliModel = backend ? backend.cliModel(model) : String(model || '').trim();
  // Spawn-time twin of the flag-settings helpers: the settings layer is the
  // only way to hand a fresh CLI the session-scoped ultracode flag, the
  // auto-compact window and the thinking pin, and all three share one
  // `settings` object.
  const spawnSettings = claudeSpawnSettings({ ultracode, autoCompactWindow, thinkingEnabled, attribution });
  // Relay tools need the worker's authenticated API helper; a caller that
  // passes none (tests, probes) gets a session without them.
  const relayMcpServer = typeof api === 'function'
    ? createRelayMcpServer({ api, getConversationId, dbg, remoteRelayTool: remoteRelayTool === true })
    : null;
  // A backend's CLI always gets an environment of its own: the worker's
  // carries the backend's secret and maybe the host's Anthropic settings.
  // The model goes in as well: the backend pins Claude Code's model aliases to
  // it, so a sub-agent asked for as "opus" runs on the session's model. The
  // Bash limits go on top: the backend drops a host session's Bash cap, not
  // the relay's own.
  const backendEnv = backend ? backend.spawnEnv(process.env, { effort: reasoningEffort, model }) : null;
  const limitEnv = claudeSpawnEnv({ backgroundCommandLimitMs, baseEnv: backendEnv || process.env });
  const env = limitEnv || backendEnv;
  // A backend's pins that may not go on the command line (a key): `settings`
  // below is the CLI's `--settings` argument, which other users of the host
  // can read. These go into the same flag layer over the control channel
  // (stdin), and no user message is sent before the CLI has taken them: the
  // first API request of the process comes after (measured on CLI 2.1.304,
  // the CLI proofs in scripts/). The layer outranks the user's, the
  // project's and the local settings and holds through their reloads and
  // through later applyFlagSettings calls of other keys. A refusal ends the
  // process before anything is sent (CLAUDE_LIVE_FLAG_SETTINGS_CODE), and so
  // does no answer within liveFlagSettingsTimeoutMs. Their blanks go on the
  // command line as well, for what the CLI does at startup. They are built
  // from the CLI's environment: a pin holds the value the CLI starts with.
  const liveSettings = typeof backend?.liveFlagSettings === 'function' ? backend.liveFlagSettings(env || process.env) : null;
  const live = liveSettings && typeof liveSettings === 'object' && Object.keys(liveSettings).length ? liveSettings : null;
  const settings = withLiveSettingsBlanks(spawnSettings, live);
  const options = {
    cwd,
    permissionMode: permissionModeForRelayMode(relayMode),
    systemPrompt: systemPromptForRelayMode(relayMode, { backgroundCommandLimitMs: limitEnv ? backgroundCommandLimitMs : null }),
    includePartialMessages: true,
    forwardSubagentText: true,
    ...(effortOption ? { effort: effortOption } : {}),
    ...(settings ? { settings } : {}),
    ...(env ? { env } : {}),
    ...(normalizedModel && normalizedModel !== 'auto' && cliModel ? { model: cliModel } : {}),
    ...(String(resume || '').trim() ? { resume: String(resume).trim() } : {}),
    ...(abortController ? { abortController } : {}),
    ...(typeof canUseTool === 'function' ? { canUseTool } : {}),
    ...(relayMcpServer ? { mcpServers: { [RELAY_MCP_SERVER_NAME]: relayMcpServer } } : {}),
    ...(String(pathToClaudeCodeExecutable || '').trim()
      ? { pathToClaudeCodeExecutable: String(pathToClaudeCodeExecutable).trim() }
      : {}),
  };
  const { stream, push, end, release, fail } = createPushableUserMessageStream({ held: Boolean(live) });
  const turn = queryImpl({ prompt: stream, options });
  if (live) {
    // The wait ends with the answer, the timeout or the session's abort,
    // whichever comes first; each one clears the others.
    const signal = abortController?.signal || null;
    let timer = null;
    let onAbort = null;
    const settled = () => {
      clearTimeout(timer);
      timer = null;
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      onAbort = null;
    };
    const unanswered = new Promise((resolve, reject) => {
      const waitMs = Math.max(0, Number(liveFlagSettingsTimeoutMs) || 0);
      timer = setTimeout(() => {
        timer = null;
        reject(new Error(`no answer within ${Math.ceil(waitMs / 1000)} s`));
      }, waitMs);
      timer.unref?.();
      if (signal) {
        onAbort = settled;
        if (signal.aborted) settled();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    turn.liveFlagSettingsApplied = Promise.race([
      Promise.resolve().then(() => {
        if (typeof turn.applyFlagSettings !== 'function') throw new Error('applyFlagSettings is not available');
        return turn.applyFlagSettings(live);
      }),
      unanswered,
    ])
      .finally(settled)
      .then(() => {
        release();
        return true;
      }, (error) => {
        const refused = liveFlagSettingsError(error, live, backend?.label || '');
        turn.liveFlagSettingsError = refused;
        dbg('live flag settings refused', refused.detail);
        fail(refused);
        return false;
      });
  }
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
