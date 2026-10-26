// The DeepSeek backend of the Claude session runner: everything that differs
// when the CLI the runner drives talks to DeepSeek's Anthropic-compatible
// endpoint instead of Anthropic.
//
// - The CLI's environment: the endpoint and the key as Claude Code's
//   documented ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN, a Claude Code state
//   directory of its own, no nonessential traffic, and nothing of the host's
//   Claude login or of another Anthropic configuration. The endpoint, the
//   key and everything else that routes the CLI's requests or decides whom
//   it trusts (CLAUDE_CLI_PINNED_ENV: provider switches, credentials,
//   proxies, TLS) are pinned again in the CLI's flag settings
//   (liveFlagSettings), over the settings of the chat's folder.
// - Hooks: none run, neither the user's nor the chat folder's, and no
//   statusLine command (CLAUDE_CLI_KEY_CHAT_SETTINGS, on the command line).
// - The model: DeepSeek's ids, with Claude Code's `[1m]` suffix so the CLI
//   plans with the 1M window; helper calls (titles, summaries) go to flash.
//   Claude Code's model aliases are pinned to the session's model
//   (ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_OPUS/SONNET/FABLE_MODEL,
//   CLAUDE_CODE_SUBAGENT_MODEL, CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL), so a
//   sub-agent asked for as "opus" runs on it and not, by DeepSeek's mapping
//   of a Claude id, on V4 Pro; a model switch respawns the CLI for the pins.
//   A Claude id the CLI still names (a session spawned before the pins) is
//   read as the DeepSeek model DeepSeek serves it with (deepseekServedModel).
// - The effort: DeepSeek's low/high/max, which Claude Code sends as
//   `output_config.effort` with adaptive thinking (captured 2026-10-24). It
//   is applied at spawn (CLAUDE_CODE_EFFORT_LEVEL), so a change respawns the
//   CLI between turns on the same session. There is no thinking-off level:
//   Claude Code never sends `thinking: {type: disabled}` for these models.
// - What it reports: no Claude plan usage and no Claude usage limit, but the
//   CLI's token totals per model after each turn (POST
//   /api/deepseek-plan-usage) for the DeepSeek card's estimated spend; images
//   only to models that take them; DeepSeek's errors in its own words.
//
// Source for the endpoint and the variables: DeepSeek's Claude Code guide
// (api-docs.deepseek.com, quick_start/agent_integrations/claude_code).

import { deepseekAnthropicBaseUrl } from '../../shared/deepseek-api.mjs';
import { isHostClaudeSessionVariable } from '../../shared/host-claude-session-env.mjs';
import { CLAUDE_CLI_KEY_CHAT_SETTINGS, claudeCliPinnedEnv } from '../claude-worker/claude-cli-pinned-env.mjs';
import {
  DEEPSEEK_PROVIDER_TYPE,
  DEFAULT_DEEPSEEK_MODEL,
  deepseekModelAcceptsImages,
  deepseekReasoningEffortFor,
  deepseekServedModel,
  isDeepSeekModelId,
} from '../../shared/deepseek-models.mjs';

const LONG_CONTEXT_SUFFIX = '[1m]';
const LONG_CONTEXT_SUFFIX_PATTERN = /\[1m\]$/i;
// Claude Code's helper model; DeepSeek's guide points it at flash.
const HELPER_MODEL = 'deepseek-flash';
// Claude Code's alias for its helper model. The other aliases ("opus",
// "sonnet", "fable", and a sub-agent without a model) resolve to the pins
// spawnEnv sets, that is to the session's model.
const HELPER_ALIAS = 'haiku';
// Where Claude Code reads the model behind each of its aliases, and the model
// of sub-agents and workflow agents (the bundled CLI, 2026-10-24). All pinned
// to the session's model; CLAUDE_CODE_SUBAGENT_MODEL_FORCE is left unset, so
// a sub-agent asked for as "haiku" still runs on the helper model.
const SESSION_MODEL_VARIABLES = Object.freeze([
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL',
]);
const HELPER_MODEL_VARIABLES = Object.freeze(['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']);

// Variables that would point the CLI at another Anthropic configuration or
// hand it another credential. Every ANTHROPIC_* is dropped as well.
const FOREIGN_CLI_VARIABLES = Object.freeze([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  // Claude Code's subprocess env scrub, if the host exports it: it forces the
  // permission mode to default (a chat in plan mode could edit files) and
  // runs every Bash command in a bubblewrap sandbox.
  'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
  // What the relay hands its worker (session-worker-launch-service.mjs,
  // TMUX_WORKER_EXPORTED_ENV_VARS): the worker's own settings, which neither
  // Claude Code nor anything the agent runs reads. A shell of the agent's
  // that starts a relay of its own would take the worker's kind, folders and
  // tools file for its own. The relay's Claude configuration
  // (CLAUDE_CONFIG_DIR, replaced below; CLAUDE_CODE_EXECUTABLE) is not on it.
  'COPILOT_ALLOW_ALL',
  'GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS',
  'COPILOT_SDK_PATH',
  'EXTENSION_PATH',
  'COPILOT_MODEL',
  'COPILOT_RELAY_MODEL',
  'CLAUDE_RELAY_MODEL',
  'CLAUDE_CLOUD_RELAY_MODEL',
  'CURSOR_RELAY_MODEL',
  'CURSOR_AGENT_STORE_DIR',
  'GROK_RELAY_MODEL',
  'GROK_CLI_COMMAND',
  'GROK_ALWAYS_APPROVE',
  'SESSION_ID',
  'COPILOT_WORKSPACE_ROOT',
  'INIT_CWD',
]);
// The same by prefix: the relay's folders, config, tools file, worker kind
// and log file (COPILOT_WEB_RELAY_*), the Copilot provider settings, every
// DeepSeek setting of the worker's (the key included: the CLI gets it as
// ANTHROPIC_AUTH_TOKEN) and the relay's own OAR_* switches.
const FOREIGN_CLI_PREFIXES = Object.freeze(['ANTHROPIC_', 'COPILOT_WEB_RELAY_', 'COPILOT_PROVIDER_', 'DEEPSEEK_', 'OAR_']);

/**
 * Whether a variable of the worker's stays out of the CLI's environment:
 * another Anthropic configuration or credential, the relay's settings for
 * its worker, or the host Claude Code session's variables when the relay was
 * started from inside one (shared/host-claude-session-env.mjs; the launcher
 * drops those for every worker, the backend again, so a CLI talking to
 * DeepSeek never reads itself as a child of the host's session, however the
 * worker was started).
 */
function isForeignCliVariable(key) {
  return FOREIGN_CLI_VARIABLES.includes(key)
    || FOREIGN_CLI_PREFIXES.some((prefix) => key.startsWith(prefix))
    || isHostClaudeSessionVariable(key);
}

function text(value) {
  return String(value ?? '').trim();
}

function withoutSuffix(value) {
  return text(value).replace(LONG_CONTEXT_SUFFIX_PATTERN, '');
}

/**
 * The relay's id of a model the CLI names: "deepseek-flash[1m]" →
 * "deepseek-flash"; a Claude id ("claude-opus-5-5", from a CLI spawned
 * without the alias pins) → the DeepSeek model that served it; anything else
 * as given, without the suffix.
 */
export function deepseekRelayModel(value) {
  return deepseekServedModel(value) || withoutSuffix(value);
}

/** The id the CLI gets: the relay's id with the 1M suffix. */
export function deepseekCliModel(value) {
  const model = deepseekRelayModel(value);
  return model ? `${model}${LONG_CONTEXT_SUFFIX}` : '';
}

/**
 * The DeepSeek model a sub-agent runs on, from what the runner knows of it:
 * the model its own frames name (a DeepSeek id, or a Claude id DeepSeek
 * served), else the alias the spawning tool pinned ("haiku" is the helper
 * model, every other alias the session's model), else the session's model.
 */
export function deepseekSubagentModel(value, sessionModel = '') {
  const served = deepseekServedModel(value);
  if (served) return served;
  if (withoutSuffix(value).toLowerCase() === HELPER_ALIAS) return HELPER_MODEL;
  return deepseekRelayModel(sessionModel);
}

/** The session model a CLI is pinned to, in the CLI's terms; unknown or none is the default model. */
function pinnedCliModel(model) {
  const relayModel = deepseekRelayModel(model);
  return deepseekCliModel(isDeepSeekModelId(relayModel) ? relayModel : DEFAULT_DEEPSEEK_MODEL);
}

/**
 * `{ code, guidance }` for a failed request DeepSeek has its own advice for,
 * or null. Read from the HTTP status the result reports, else from the
 * status the CLI quotes in its error text ("API Error: 402 …").
 */
export function describeDeepSeekFailure(errorText, { status = null } = {}) {
  const message = text(errorText);
  const code = Number(status);
  if (code === 402 || /\b402\b|insufficient[ _]balance/i.test(message)) {
    return {
      code: 'deepseek-balance',
      guidance: 'The DeepSeek account balance is used up. Top it up at https://platform.deepseek.com/top_up, then send the message again.',
    };
  }
  if (code === 401 || /\b401\b|authentication[_ ]error|invalid api key/i.test(message)) {
    return {
      code: 'deepseek-api-key',
      guidance: 'DeepSeek did not accept the API key. Check it in Settings → Providers → DeepSeek, then send the message again.',
    };
  }
  if (code === 429 || /\b429\b|rate[_ ]limit/i.test(message)) {
    return {
      code: 'deepseek-rate-limit',
      guidance: 'DeepSeek is at its concurrency limit for this account. Send the message again in a moment.',
    };
  }
  return null;
}

export function createDeepSeekClaudeBackend({ env = process.env } = {}) {
  const apiKey = text(env.DEEPSEEK_API_KEY);
  const anthropicBaseUrl = deepseekAnthropicBaseUrl(text(env.DEEPSEEK_BASE_URL));
  const configDir = text(env.DEEPSEEK_CLAUDE_CONFIG_DIR);

  /** DeepSeek's level for a requested effort; unset and unknown are high. */
  function effortFor(value) {
    return deepseekReasoningEffortFor(value) || 'high';
  }

  /**
   * The CLI's environment. Built from the worker's own (which must not reach
   * the CLI as it is: it carries DEEPSEEK_API_KEY and possibly the host's
   * Anthropic settings), so every Anthropic variable is replaced. `model` is
   * the session's model, which every alias is pinned to.
   */
  function spawnEnv(baseEnv = process.env, { effort = '', model = '' } = {}) {
    if (!apiKey) throw new Error('deepseek-api-key-not-configured');
    if (!configDir) throw new Error('deepseek-config-dir-not-configured');
    const next = {};
    for (const [key, value] of Object.entries(baseEnv || {})) {
      if (isForeignCliVariable(key)) continue;
      next[key] = value;
    }
    next.ANTHROPIC_BASE_URL = anthropicBaseUrl;
    next.ANTHROPIC_AUTH_TOKEN = apiKey;
    // Every alias Claude Code resolves on its own ("opus", a sub-agent
    // without a model) lands on the session's model: without a pin the CLI
    // sends a Claude id, which DeepSeek serves by its own mapping
    // (claude-opus → V4 Pro), off the model the chat is locked to.
    const sessionModel = pinnedCliModel(model);
    for (const key of SESSION_MODEL_VARIABLES) next[key] = sessionModel;
    for (const key of HELPER_MODEL_VARIABLES) next[key] = HELPER_MODEL;
    next.CLAUDE_CONFIG_DIR = configDir;
    next.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    next.CLAUDE_CODE_EFFORT_LEVEL = effortFor(effort);
    return next;
  }

  return {
    id: DEEPSEEK_PROVIDER_TYPE,
    providerType: DEEPSEEK_PROVIDER_TYPE,
    label: 'DeepSeek',
    configDir,
    defaultModel: DEFAULT_DEEPSEEK_MODEL,
    // Neither is DeepSeek's: Claude's plan windows and its usage limit.
    reportsPlanUsage: false,
    reportsUsageLimit: false,
    // What it reports instead: the CLI's token totals per model, by the
    // relay's model ids (relayModel); the relay books what each report adds.
    // Claude Code's `total_cost_usd` is at Claude's prices and is not sent.
    usageRoute: '/api/deepseek-plan-usage',

    // A Claude id is not a model of DeepSeek's to request, only one it may
    // have served (relayModel).
    isModel: (value) => isDeepSeekModelId(withoutSuffix(value)),
    cliModel: deepseekCliModel,
    relayModel: deepseekRelayModel,
    subagentModel: deepseekSubagentModel,
    acceptsImages: (model) => deepseekModelAcceptsImages(deepseekRelayModel(model)),
    describeFailure: describeDeepSeekFailure,

    effortFor,
    /** The SDK's `effort` option: DeepSeek's level. */
    effortOption: effortFor,
    /** DeepSeek always thinks (see the effort note above). */
    thinkingEnabled: () => true,
    /**
     * What only a fresh CLI takes, the effort and the model the aliases are
     * pinned to: a change respawns it between turns. `model` is the turn's
     * resolved model (the runner's, not the message's alone).
     */
    spawnKey: (message = {}, { model = '' } = {}) => `${effortFor(message.reasoningEffort)} ${pinnedCliModel(model)}`,

    spawnEnv,

    /**
     * The settings layer every CLI of this backend is spawned with, on its
     * command line (no key in it): no hooks and no statusLine command, from
     * the user's settings or the chat folder's. They would run with the key
     * in their environment, a folder's SessionStart hook before the pins.
     */
    flagSettings: () => ({ ...CLAUDE_CLI_KEY_CHAT_SETTINGS }),

    /**
     * The CLI's routing, trust and credentials once more, in its flag
     * settings layer, which outranks the settings of the chat's folder: a
     * .claude/settings.json or settings.local.json there whose
     * env.ANTHROPIC_BASE_URL, proxy or CA points elsewhere would otherwise
     * get the DeepSeek key as its bearer token (scripts/deepseek-cli-proof.mjs).
     * Every variable of CLAUDE_CLI_PINNED_ENV holds the value of `cliEnv`,
     * the environment the CLI was spawned with (spawnEnv), or is blanked, and
     * so is an apiKeyHelper of the folder's. The key may not go on the
     * command line, so the adapter sends these over the control channel
     * before the first message (startClaudeSession).
     */
    liveFlagSettings(cliEnv = spawnEnv(env)) {
      if (!apiKey) throw new Error('deepseek-api-key-not-configured');
      return {
        env: { ...claudeCliPinnedEnv(cliEnv), ANTHROPIC_BASE_URL: anthropicBaseUrl, ANTHROPIC_AUTH_TOKEN: apiKey },
        apiKeyHelper: '',
      };
    },
  };
}
