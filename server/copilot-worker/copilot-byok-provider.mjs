// BYOK (bring-your-own-key) provider config for the SDK worker.
//
// Why this exists at all: when the `copilot` CLI itself starts, the
// `COPILOT_PROVIDER_*` environment variables are read by its own startup layer,
// which turns them into the process-wide custom provider. Sessions this worker
// creates through the SDK never go through that layer — a live probe confirmed
// the runtime IGNORES those variables for SDK-created sessions — so the same
// configuration has to be re-expressed in-process as session options
// (`inference.providers` and `inference.models`, see
// `copilotProviderSessionOptions`).
//
// The variable names are deliberately NOT re-invented here: they are exactly
// the ones `applyOpenAIProviderEnvironment()`
// (server/services/session-worker-launch-service.mjs) writes today, so one
// relay-side OpenAI configuration drives the worker and the existing
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
 * Resolve the BYOK provider block (connection and token ceilings) from the
 * worker's environment, or null when this session is not a BYOK session.
 *
 * The signal: the launch service only
 * writes `COPILOT_PROVIDER_TYPE` for a session whose relay provider is
 * `openai`, and deletes the whole family otherwise. An API key is required
 * because a provider config without credentials would silently fail every
 * model call instead of failing to start.
 *
 * The ceilings are resolved against the model passed in, so a caller that
 * switches models must rebuild the session: the provider is fixed at session
 * creation and no RPC updates it mid-session (see
 * `copilot-sdk-session-process.mjs`).
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

/**
 * The name the BYOK provider is registered under in
 * `inference.providers`. Must not contain `/`: model selection ids are
 * `<provider>/<id>`.
 */
export const BYOK_PROVIDER_NAME = 'openai';

/**
 * Express a resolved provider block (`resolveCopilotProviderConfig`) as
 * grouped session options. The SDK throws on a whole-session `provider`
 * ("provider is no longer supported; use inference.providers and
 * inference.models"). The connection goes into `inference.providers`
 * (NamedProviderConfig), the token ceilings into an `inference.models` entry
 * (ProviderModelConfig) for the session's model, and
 * `inference.defaultProvider` routes the unqualified model ids OAR uses to
 * it, which needs `github.capi.enabled: false`. Unregistered ids still route
 * there with inferred metadata, so a later model switch keeps working; it
 * rebuilds this block anyway (`byokRebuildReason`).
 *
 * Returns an empty object for a hosted session (`provider` null).
 */
export function copilotProviderSessionOptions(provider, { model = '', reasoningEffort = null } = {}) {
  if (!provider) return {};
  const { maxPromptTokens, maxOutputTokens, ...connection } = provider;
  const modelId = text(model);
  return {
    inference: {
      providers: [{ name: BYOK_PROVIDER_NAME, ...connection }],
      ...(modelId ? {
        models: [{
          id: modelId,
          provider: BYOK_PROVIDER_NAME,
          ...(maxPromptTokens ? { maxPromptTokens } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
        }],
      } : {}),
      defaultProvider: BYOK_PROVIDER_NAME,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
    github: { capi: { enabled: false } },
  };
}

/**
 * Resolve a session's BYOK provider and express it as session options.
 *
 * BYOK sessions must carry their provider IN the session config: the
 * runtime's `COPILOT_PROVIDER_*` startup layer does not run for SDK-created
 * sessions, so without this an OpenAI-provider conversation would silently
 * run on hosted Copilot models instead. The effort rides in the options
 * because the rebuilt config is the switch mechanism for these sessions, so
 * a dispose+resume model switch must not drop it; hosted sessions apply
 * effort through the validated RPC path instead (`reasoningEffort` is only
 * valid for models that support it, which cannot be checked before the
 * session exists).
 *
 * Returns `{ provider, model, options }`: the resolved block (null for a
 * hosted session), the model it was resolved for, and the session options to
 * spread into the config (empty for a hosted session). The caller remembers
 * the first two for `byokRebuildReason`: the block's token ceilings describe
 * that model, and no model-switch RPC can update them.
 */
export function resolveByokSession({
  resolve = resolveCopilotProviderConfig,
  env = process.env,
  model = '',
  reasoningEffort = null,
  dbg = () => {},
} = {}) {
  const provider = resolve({ env, model, dbg });
  return {
    provider,
    model: provider ? text(model) : '',
    options: copilotProviderSessionOptions(provider, {
      model,
      reasoningEffort: provider ? reasoningEffort : null,
    }),
  };
}

/**
 * Why a BYOK session must be rebuilt for a new (model, effort) selection
 * rather than switched in place by RPC, or '' when the RPC may be tried.
 *
 *  - The target model resolves to different token ceilings. No RPC can
 *    update them (there is no setProvider), so an in-place switch would leave
 *    the old model's ceilings on the new one.
 *  - A different model. `inference.models` lists only the model the session
 *    was built with, and an unregistered id gets inferred metadata without
 *    the provider's defaults, so it would lose its ceilings even when they
 *    are equal (gpt-5 and gpt-5.4 share theirs).
 */
export function byokRebuildReason({ built = {}, next = {} } = {}) {
  if (JSON.stringify(next.provider ?? null) !== JSON.stringify(built.provider ?? null)) {
    return 'ceilings differ for the target model';
  }
  if (text(next.model) !== text(built.model)) {
    return 'model is not the one the session registered';
  }
  return '';
}
