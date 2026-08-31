// BYOK (bring-your-own-key) provider config for the SDK worker.
//
// Why this exists at all: on the EXTENSION path the `COPILOT_PROVIDER_*`
// environment variables are read by the `copilot` CLI's own startup layer,
// which turns them into the process-wide custom provider. Sessions this worker
// creates through the SDK never go through that layer — a live probe confirmed
// the runtime IGNORES those variables for SDK-created sessions — so the same
// configuration has to be re-expressed in-process as `SessionConfig.provider`
// (`ProviderConfig`, verified against the bundled runtime 1.0.82 types).
//
// The variable names are deliberately NOT re-invented here: they are exactly
// the ones `applyOpenAIProviderEnvironment()`
// (server/services/session-worker-launch-service.mjs) writes today, so one
// relay-side OpenAI configuration drives both engines and the existing
// secret-env-file plumbing (`WORKER_SECRET_ENV_VARS` already carries
// `COPILOT_PROVIDER_API_KEY`) keeps working untouched.
//
// Note on cost: BYOK usage events report `cost: 0` (the field is the premium
// multiplier, not money), so nothing here feeds a spend display.

import { resolveModelTokenCeilings } from '../../shared/context-window-fallbacks.mjs';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function text(value) {
  return String(value ?? '').trim();
}

/**
 * A token ceiling override read from the environment.
 *
 * `parseInt` is deliberately NOT used: it truncates at the first character it
 * cannot read, so `1e6` would silently become **1** and `90000.5` would become
 * 90000 — an escape hatch that quietly does the wrong thing is worse than one
 * that refuses. An unusable value is logged and IGNORED, falling through to the
 * shared table and then to the runtime's own default, rather than being
 * truncated into a number nobody asked for.
 */
function tokenCeilingOverride(name, raw, dbg) {
  const value = text(raw);
  if (!value) return null;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    dbg(`ignoring ${name}: expected a positive whole number of tokens, got ${JSON.stringify(value)}`);
    return null;
  }
  return numeric;
}

/**
 * Prompt/output token ceilings for the model this session will call.
 *
 * The runtime resolves these from its own model catalog and falls back to a
 * synthesized 128k context for a model it does not recognise, which is wrong in
 * the expensive direction for a large-context model: a long relay conversation
 * would lose history it never needed to lose.
 *
 * The numbers themselves live in `shared/context-window-fallbacks.mjs` — the
 * same module the Copilot snapshot service and the Cursor worker read — so this
 * worker cannot disagree with the rest of the relay about how big a model's
 * window is. The prompt ceiling is derived there as `window − output`.
 *
 * An unknown model is left UNSET on purpose: the runtime's own default is a
 * safe answer, whereas a guessed ceiling that is too HIGH turns early
 * compaction into hard API errors.
 */
export function resolveOpenAiModelTokenLimits(model) {
  const { maxPromptTokens = null, maxOutputTokens = null } = resolveModelTokenCeilings(model);
  if (maxPromptTokens === null || maxOutputTokens === null) return {};
  return { maxPromptTokens, maxOutputTokens };
}

/**
 * Build `SessionConfig.provider` from the worker's environment, or null when
 * this session is not a BYOK session.
 *
 * The signal is the same one the extension path uses: the launch service only
 * writes `COPILOT_PROVIDER_TYPE` for a session whose relay provider is
 * `openai`, and deletes the whole family otherwise. An API key is required
 * because a provider config without credentials would silently fail every
 * model call instead of failing to start.
 *
 * `modelId` is deliberately left UNSET. `ProviderConfig.modelId` falls back to
 * `SessionConfig.model`, so leaving it out is what keeps `session.setModel()`
 * authoritative for the rest of the session; pinning it here would freeze the
 * session on the model it was created with and make every later switch a
 * silent no-op.
 *
 * The ceilings are resolved against the model passed in, so a caller that
 * switches models must rebuild this config — `SessionConfig.provider` is fixed
 * at session creation and runtime 1.0.82 exposes no way to update it
 * mid-session (see `copilot-sdk-session-process.mjs`).
 */
export function resolveCopilotProviderConfig({ env = process.env, model = '', dbg = () => {} } = {}) {
  const type = text(env.COPILOT_PROVIDER_TYPE).toLowerCase();
  if (type !== 'openai') return null;
  const apiKey = text(env.COPILOT_PROVIDER_API_KEY);
  if (!apiKey) return null;
  // The session's live model wins over the configured default: the token
  // ceilings below have to describe the model that will actually be called.
  const effectiveModel = text(model) || text(env.COPILOT_MODEL);
  const wireApi = text(env.COPILOT_PROVIDER_WIRE_API).toLowerCase();
  const limits = resolveOpenAiModelTokenLimits(effectiveModel);
  const maxPromptTokens = tokenCeilingOverride(
    'COPILOT_PROVIDER_MAX_PROMPT_TOKENS', env.COPILOT_PROVIDER_MAX_PROMPT_TOKENS, dbg,
  ) ?? limits.maxPromptTokens ?? null;
  const maxOutputTokens = tokenCeilingOverride(
    'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS', env.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS, dbg,
  ) ?? limits.maxOutputTokens ?? null;
  return {
    type: 'openai',
    baseUrl: text(env.COPILOT_PROVIDER_BASE_URL) || DEFAULT_BASE_URL,
    apiKey,
    // Only the two documented values are forwarded; anything else is a typo in
    // the relay config and the runtime's own default ("completions") is a
    // better answer than a rejected session config.
    ...(wireApi === 'responses' || wireApi === 'completions' ? { wireApi } : {}),
    ...(maxPromptTokens ? { maxPromptTokens } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };
}
