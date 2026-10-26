// The Claude API backend of the Claude session runner: Claude Code on the
// Anthropic API, billed to the API key saved in Settings → Providers → Claude
// API instead of the host's Claude login.
//
// - The CLI's environment: the key as ANTHROPIC_API_KEY, the Anthropic API as
//   ANTHROPIC_BASE_URL, and nothing of the host's Claude login, another
//   Anthropic configuration or another provider's switch. The host's Claude
//   Code state directory stays (CLAUDE_CONFIG_DIR is left as the relay set
//   it): the chats are Claude chats, with the Claude provider's sessions,
//   transcripts, resume and task output.
// - The flag settings layer: the user's settings and the chat folder's
//   (.claude/settings.json, .claude/settings.local.json) can set `env`
//   (another ANTHROPIC_BASE_URL, an ANTHROPIC_API_KEY that replaces the key,
//   an ANTHROPIC_AUTH_TOKEN that beats it, a proxy, another provider, custom
//   headers, a CA) and `apiKeyHelper` (a script whose output beats it). The
//   flag layer outranks them all, so it pins the base URL and the key, blanks
//   the bearer token and the helper, and holds every other variable that
//   routes the requests or decides whom the CLI trusts at the CLI's own value
//   (CLAUDE_CLI_PINNED_ENV, shared with the DeepSeek backend). The spawn's
//   `--settings` argument, which other users of the host can read, carries
//   the endpoint and the blanks (claudeApiFlagSettings); the key and the
//   worker's own proxy and TLS values go into the same layer over the CLI's
//   stdin before the first message (liveFlagSettings, claude-sdk-adapter.mjs;
//   scripts/claude-api-cli-proof.mjs shows it).
// - The check: the CLI's `system/init` names where it took its API key from.
//   Anything but ANTHROPIC_API_KEY stops the turn as soon as the init is read
//   (checkInit). The CLI does not wait for that verdict: it sends its first
//   request some 50 to 90 ms after the init (scripts/claude-api-cli-proof.mjs),
//   so one request may already be out on the other credential when the stop
//   lands. The check limits a wrong credential to that one request; it does
//   not prevent it.
// - The model, effort, thinking and images: Claude's, exactly as the Claude
//   worker has them (`claudeModels`).
// - What it reports: no Claude plan usage (there is no plan) and no Claude
//   usage limit (the API answers with its own errors, which describeFailure
//   reads in plain words).
//
// - Hooks: none run, neither the user's nor the chat folder's, and no
//   statusLine command (CLAUDE_CLI_KEY_CHAT_SETTINGS, on the command line).
//
// The agent's shell inherits the CLI's environment, the key included; the
// relay takes the saved key out of what the worker posts and logs.

import { resolveAnthropicApiBaseUrl } from '../../shared/anthropic-api.mjs';
import { isHostClaudeSessionVariable } from '../../shared/host-claude-session-env.mjs';
import { CLAUDE_CLI_KEY_CHAT_SETTINGS, claudeCliPinnedEnv } from '../claude-worker/claude-cli-pinned-env.mjs';

export const CLAUDE_API_BACKEND_ID = 'claude-api';
export const CLAUDE_API_BACKEND_LABEL = 'Claude API';
// Where the relay's launch puts the key (session-worker-launch-service.mjs).
export const CLAUDE_API_KEY_ENV = 'OAR_CLAUDE_API_KEY';
// The stable code of a turn stopped because the CLI took another credential.
export const CLAUDE_API_KEY_SOURCE_CODE = 'claude-api-key-source';
// The only API key source the check lets through: the key in the CLI's
// environment, which is this backend's.
export const EXPECTED_API_KEY_SOURCE = 'ANTHROPIC_API_KEY';
// The sources the SDK's `system/init` can name (sdk.d.ts, ApiKeySource). A
// note names one of these, never a text of the CLI's own.
const KNOWN_API_KEY_SOURCES = Object.freeze([
  'ANTHROPIC_API_KEY',
  'apiKeyHelper',
  '/login managed key',
  'none',
  'user',
  'project',
  'org',
  'temporary',
  'oauth',
]);

const BILLING_URL = 'https://platform.claude.com/settings/billing';
const LIMITS_URL = 'https://platform.claude.com/settings/limits';
const SETTINGS_PLACE = 'Settings → Providers → Claude API';
const KEY_SOURCE_GUIDANCE = 'Remove the apiKeyHelper or other credential from the host\'s Claude Code settings '
  + `(settings.json), check the key in ${SETTINGS_PLACE}, then send the message again.`;

// Variables that would hand the CLI another credential or point it at another
// endpoint or cloud (the bundled CLI, 2026-10-25). Every ANTHROPIC_* is
// dropped as well (FOREIGN_CLI_PREFIXES).
const FOREIGN_CLI_VARIABLES = Object.freeze([
  // The host's Claude login, and the other ways to hand the CLI a login or
  // a key.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_OAUTH_CLIENT_ID',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  // Another provider for the CLI's requests, and their auth bypasses.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_CCR_V2',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  // A host's model and effort pins: the turn's model and effort come from
  // the relay, which bills them to the key.
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  'CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  // Never set, and dropped when inherited: it forces the permission mode to
  // default (plan mode is lost) and sandboxes Bash.
  'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
  // What the relay hands its worker (session-worker-launch-service.mjs,
  // TMUX_WORKER_EXPORTED_ENV_VARS): the worker's own settings, which neither
  // Claude Code nor anything the agent runs reads. A shell of the agent's
  // that starts a relay of its own would take the worker's kind, folders and
  // tools file for its own. The relay's Claude configuration
  // (CLAUDE_CONFIG_DIR, CLAUDE_CODE_EXECUTABLE) is not on it.
  'COPILOT_ALLOW_ALL',
  'GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS',
  'COPILOT_SDK_PATH',
  'EXTENSION_PATH',
  'COPILOT_MODEL',
  'COPILOT_RELAY_MODEL',
  'CLAUDE_RELAY_MODEL',
  'CLAUDE_CLOUD_RELAY_MODEL',
  'CLAUDE_API_RELAY_MODEL',
  'CURSOR_RELAY_MODEL',
  'CURSOR_AGENT_STORE_DIR',
  'CURSOR_API_KEY',
  'GROK_RELAY_MODEL',
  'GROK_CLI_COMMAND',
  'GROK_ALWAYS_APPROVE',
  'SESSION_ID',
  'COPILOT_WORKSPACE_ROOT',
  'INIT_CWD',
]);
// The same by prefix: every Anthropic variable (the two the CLI needs are set
// again below), the relay's folders, config, tools file, worker kind and log
// file (COPILOT_WEB_RELAY_*), the Copilot provider settings, the DeepSeek
// worker's settings, every Claude gateway setting and the relay's own OAR_*
// switches (the key's own variable among them).
const FOREIGN_CLI_PREFIXES = Object.freeze([
  'ANTHROPIC_',
  'COPILOT_WEB_RELAY_',
  'COPILOT_PROVIDER_',
  'DEEPSEEK_',
  'CLAUDE_GATEWAY_',
  'OAR_',
]);

/**
 * Whether a variable of the worker's stays out of the CLI's environment:
 * another credential, endpoint or provider, the relay's settings for its
 * worker, or the host Claude Code session's variables when the relay was
 * started from inside one (shared/host-claude-session-env.mjs; the launcher
 * drops those for every worker, the backend again, however the worker was
 * started).
 */
function isForeignCliVariable(key) {
  const name = String(key).toUpperCase();
  return FOREIGN_CLI_VARIABLES.includes(name)
    || FOREIGN_CLI_PREFIXES.some((prefix) => name.startsWith(prefix))
    || isHostClaudeSessionVariable(name);
}

function text(value) {
  return String(value ?? '').trim();
}

/**
 * The environment the CLI runs with: the worker's own without anything
 * foreign, then the key and the endpoint. `OAR_ANTHROPIC_API_BASE_URL` names
 * a fake API for tests; only a loopback URL is taken from it
 * (resolveAnthropicApiBaseUrl), anything else is the Anthropic API.
 */
export function claudeApiCliEnv(baseEnv = process.env, { apiKey = '', baseUrl = '' } = {}) {
  const key = text(apiKey);
  if (!key) throw new Error('claude-api-key-not-configured');
  const next = {};
  for (const [name, value] of Object.entries(baseEnv || {})) {
    if (isForeignCliVariable(name)) continue;
    next[name] = value;
  }
  next.ANTHROPIC_API_KEY = key;
  next.ANTHROPIC_BASE_URL = text(baseUrl) || resolveAnthropicApiBaseUrl(baseEnv || {});
  return next;
}

/**
 * The flag settings layer every CLI of this backend is spawned with, on its
 * command line: no key in it. It outranks the user's, the project's and the
 * local settings, so their `env` cannot send the requests elsewhere or swap
 * the key for a bearer token, and their `apiKeyHelper` cannot swap it for
 * its own (nor run at the CLI's startup). No hooks and no statusLine command
 * run (CLAUDE_CLI_KEY_CHAT_SETTINGS). Skills, plugins and MCP servers are
 * left as the other layers have them.
 */
export function claudeApiFlagSettings(baseUrl) {
  return {
    ...CLAUDE_CLI_KEY_CHAT_SETTINGS,
    env: {
      ANTHROPIC_BASE_URL: text(baseUrl),
      ANTHROPIC_AUTH_TOKEN: '',
    },
    apiKeyHelper: '',
  };
}

/**
 * The same layer with the key, which the CLI takes over stdin before the
 * first message (claude-sdk-adapter.mjs): a settings file's
 * env.ANTHROPIC_API_KEY would otherwise replace the CLI's environment's.
 * Every other variable that routes the CLI's requests, and with them the key,
 * or decides whom it trusts on the way (the proxies, the other providers'
 * switches and endpoints, the custom headers, the CA and TLS settings) holds
 * the value of `cliEnv`, the environment the CLI was spawned with, or is
 * blanked (claudeCliPinnedEnv).
 */
export function claudeApiLiveFlagSettings(baseUrl, apiKey, cliEnv = {}) {
  const key = text(apiKey);
  if (!key) throw new Error('claude-api-key-not-configured');
  const settings = claudeApiFlagSettings(baseUrl);
  return { ...settings, env: { ...claudeCliPinnedEnv(cliEnv), ...settings.env, ANTHROPIC_API_KEY: key } };
}

/** The source the CLI named, as a note may quote it: a known name, or a stand-in. */
function quotedApiKeySource(value) {
  const source = typeof value === 'string' ? value : '';
  if (KNOWN_API_KEY_SOURCES.includes(source)) return `"${source}"`;
  return source ? 'a source this relay does not know' : 'no source';
}

/**
 * Null when the CLI's `system/init` says it took the key from
 * ANTHROPIC_API_KEY (the backend's), else the Error that stops the turn. Its
 * message names the source the CLI reported, never a key. `afterTraffic`: the
 * init came while the turn was already talking to the API, so one request
 * may have gone out on the other credential.
 */
export function checkClaudeApiInit(sdkMessage, { afterTraffic = false } = {}) {
  if (!sdkMessage || sdkMessage.type !== 'system' || sdkMessage.subtype !== 'init') return null;
  const source = sdkMessage.apiKeySource;
  if (source === EXPECTED_API_KEY_SOURCE) return null;
  const error = new Error(
    `Claude Code reported ${quotedApiKeySource(source)} as its API key source instead of the saved Claude API key, so the turn was stopped.`
    + (afterTraffic ? ' At most one request may have gone out on that credential.' : ''),
  );
  error.code = CLAUDE_API_KEY_SOURCE_CODE;
  error.apiKeySource = KNOWN_API_KEY_SOURCES.includes(source) ? source : null;
  error.guidance = KEY_SOURCE_GUIDANCE;
  return error;
}

/**
 * `{ code, guidance }` for a failed request the Claude API has its own advice
 * for, or null. Read from the error the runner stopped the turn with, the
 * HTTP status the result reports, else from the status and the words the CLI
 * quotes in its error text ("API Error: 401 …"). The account refusals come
 * first: a spend limit can come as a 429, which is not a rate limit.
 */
export function describeClaudeApiFailure(errorText, { status = null, error = null } = {}) {
  if (error?.code === CLAUDE_API_KEY_SOURCE_CODE) {
    return { code: CLAUDE_API_KEY_SOURCE_CODE, guidance: error.guidance || KEY_SOURCE_GUIDANCE };
  }
  const message = text(errorText);
  const code = Number(status);
  if (/credit balance is too low/i.test(message)) {
    return {
      code: 'claude-api-credit',
      guidance: `The Claude API account's credit balance is too low. Add credits in the Claude Console (${BILLING_URL}), then send the message again.`,
    };
  }
  if (/API usage limits|enforced_spend_limit_reached/i.test(message)) {
    return {
      code: 'claude-api-spend-limit',
      guidance: `The Claude API account has reached its spend limit. Raise the limit in the Claude Console (${LIMITS_URL}) or wait until it resets, then send the message again.`,
    };
  }
  if (code === 402 || /\b402\b|billing_error/i.test(message)) {
    return {
      code: 'claude-api-billing',
      guidance: `The Claude API refused the request for a billing reason. Check the payment details in the Claude Console (${BILLING_URL}), then send the message again.`,
    };
  }
  if (
    code === 401
    || code === 403
    || /\b40[13]\b|authentication_error|permission_error|invalid x-api-key|invalid api key/i.test(message)
  ) {
    return {
      code: 'claude-api-key',
      guidance: `The Claude API did not accept the API key. Check it in ${SETTINGS_PLACE}, then send the message again.`,
    };
  }
  if (code === 429 || code === 529 || /\b(?:429|529)\b|rate_limit_error|overloaded_error/i.test(message)) {
    return {
      code: 'claude-api-rate-limit',
      guidance: `The Claude API is rate-limiting this key or is overloaded. Send the message again in a moment; the key's rate limits are in the Claude Console (${LIMITS_URL}).`,
    };
  }
  return null;
}

export function createClaudeApiClaudeBackend({ env = process.env } = {}) {
  const apiKey = text(env[CLAUDE_API_KEY_ENV]);
  const baseUrl = resolveAnthropicApiBaseUrl(env);

  return {
    id: CLAUDE_API_BACKEND_ID,
    providerType: CLAUDE_API_BACKEND_ID,
    label: CLAUDE_API_BACKEND_LABEL,
    // Claude's models, effort, thinking, `[1m]`, images and sub-agent models,
    // exactly as the Claude worker has them: the runner and the adapter take
    // none of those from this backend.
    claudeModels: true,
    // No plan windows and no subscription usage limit on an API key, and no
    // usage route of its own.
    reportsPlanUsage: false,
    reportsUsageLimit: false,
    usageRoute: null,
    describeFailure: describeClaudeApiFailure,
    checkInit: checkClaudeApiInit,
    /** The settings layer pin, merged into the spawn's `settings` (no key in it). */
    flagSettings: () => claudeApiFlagSettings(baseUrl),
    /**
     * The layer again with the key and the routing and trust pins for a CLI
     * spawned with `cliEnv`, over stdin before the first message.
     */
    liveFlagSettings: (cliEnv = claudeApiCliEnv(env, { apiKey, baseUrl })) => claudeApiLiveFlagSettings(baseUrl, apiKey, cliEnv),

    /**
     * The CLI's environment, built from the worker's own (which must not
     * reach the CLI as it is: it carries OAR_CLAUDE_API_KEY and possibly the
     * host's login or Anthropic settings).
     */
    spawnEnv(baseEnv = process.env) {
      return claudeApiCliEnv(baseEnv, { apiKey, baseUrl });
    },
  };
}
