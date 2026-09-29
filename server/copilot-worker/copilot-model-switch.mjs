// Observed model + reasoning-effort switching for the SDK worker (audit #9 and
// the #13 policy: "model switching proceeds without confirmed success").
//
// The session facade's `setModel()` forwards to `rpc.model.switchTo` and
// DISCARDS the result (SDK 1.0.13, session.js ~1606), so a worker that calls it
// can never tell a committed switch from a refused one — and the old behaviour
// on any failure was to log and run the prompt on whatever model the session
// happened to be on. This module talks to the RPC surface directly and treats
// the result as the contract it is:
//
//   * `modelId`        — the model actually active after the call; a mismatch
//                        is a refusal, not a delay.
//   * `deferred: true` — the switch was ENQUEUED behind an active turn and the
//                        live model is unchanged until the queue drains. The
//                        drain is observed by waiting (bounded) for the
//                        `session.model_change` event whose `data.newModel` is
//                        the requested model; the waiter is armed BEFORE the
//                        RPC is sent so a drain cannot slip between the result
//                        arriving and the subscription starting.
//   * `confirmation`   — the runtime wants an interactive decision (compaction
//                        preflight); a headless worker has nobody to ask.
//
// Reasoning effort rides the same machinery. `ReasoningEffort` has NO "none"
// member in 1.0.13 — the relay's `none` (and an absent value) mean "the model's
// default", mapped to the model's `defaultReasoningEffort` from a cached
// `rpc.model.list()` when known, and otherwise simply omitted. An effort-only
// change uses the `rpc.model.setReasoningEffort` RPC (@experimental; the host
// must pre-validate against the model's `supportedReasoningEfforts`, which is
// exactly what the cached catalog is for).
//
// Failure policy differs by session type, decided by the CALLER's `byok` flag:
//
//   * hosted — an unconfirmed explicit selection THROWS
//     (`relay.model-switch-unconfirmed`, naming requested vs actual), and the
//     prompt is never sent on the wrong model.
//   * BYOK — `apply` returns `{ ok: false }` instead of throwing, because the
//     caller has a second mechanism (dispose + resume with a rebuilt
//     `SessionConfig.provider`) that this module knows nothing about. An
//     effort the model is known not to support is skipped SILENTLY for BYOK
//     (openai-compatible ceilings and effort vocabularies differ per provider).
//
// No SDK import, no I/O of its own: everything arrives through the session
// handle and the event feed, which is what keeps the unit suite spawn-free.

/**
 * How long a `deferred: true` switch may wait for its `session.model_change`
 * drain before the selection counts as unconfirmed. Deliberately generous
 * against a healthy runtime (a queued switch drains at the next model-call
 * boundary, typically well under a second) and deliberately bounded: the
 * alternative is sending the user's prompt to a model they explicitly
 * deselected. Configurable as `COPILOT_SDK_RELAY_MODEL_SWITCH_TIMEOUT_MS`.
 */
import { supportedEffortsOf } from '../../shared/model-descriptors.mjs';

export const DEFAULT_MODEL_SWITCH_TIMEOUT_MS = 10_000;

export const MODEL_SWITCH_UNCONFIRMED_CODE = 'model-switch-unconfirmed';
export const MODEL_SWITCH_UNCONFIRMED_STABLE_CODE = 'relay.model-switch-unconfirmed';

/**
 * Relay effort → the vocabulary this module tracks internally.
 *
 * `null` means "the model's own default": the relay sends `none` (or nothing)
 * for it, and SDK 1.0.13's `ReasoningEffort` union has no `none` member — so it
 * must never reach the wire as a literal value.
 */
export function normalizeRelayEffort(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text === 'none') return null;
  return text;
}

// The effort-list reader lives with the shared descriptor rules (the model
// catalog snapshot publishes the same list), re-exported so existing callers
// and tests keep their import. `null` = no parseable list, and unknown must be
// PERMISSIVE here: the runtime is the authority on what it supports, this
// catalog is only a fast-fail.
export { supportedEffortsOf };

/**
 * The terminal failure for a selection the runtime would not (or could not
 * provably) honour. Carried as a marked Error so `classifyCopilotTurnException`
 * can route it to the existing terminal-error publish path without prose
 * sniffing, with a stable code the UI can key on.
 */
export function createModelSwitchUnconfirmedError({
  requestedModel = '',
  requestedEffort = null,
  actualModel = '',
  detail = '',
} = {}) {
  const requested = requestedEffort
    ? `"${requestedModel}" (reasoning effort "${requestedEffort}")`
    : `"${requestedModel}"`;
  const actual = actualModel ? `"${actualModel}"` : 'its previous model';
  // An effort-only refusal on the model the session is already on reads
  // nonsensically as "asked for X but still on X"; name the effort instead.
  const effortOnly = !!requestedEffort && !!requestedModel && requestedModel === actualModel;
  const error = new Error(effortOnly
    ? `System note: this message asked for reasoning effort "${requestedEffort}" on "${requestedModel}", `
      + `but the Copilot runtime did not confirm it${detail ? ` (${detail})` : ''}. `
      + 'The message was not sent; pick a supported effort (or another model) and resend it.'
    : `System note: this message asked for model ${requested}, but the Copilot runtime did not confirm `
      + `the switch — the session is still on ${actual}${detail ? ` (${detail})` : ''}. `
      + 'The message was not sent on the wrong model; pick an available model and resend it.');
  error.modelSwitchUnconfirmed = true;
  error.code = MODEL_SWITCH_UNCONFIRMED_CODE;
  error.stableCode = MODEL_SWITCH_UNCONFIRMED_STABLE_CODE;
  error.requestedModel = requestedModel || null;
  error.requestedEffort = requestedEffort || null;
  error.actualModel = actualModel || null;
  return error;
}

// JSON-RPC reserved codes the SDK's transport uses for a connection that went
// away (`MessageWriteError` … `ConnectionInactive`), as opposed to a server
// handler that threw.
const TRANSPORT_ERROR_CODES = new Set([-32099, -32098, -32097, -32096]);

/**
 * The request failed because the connection to the runtime is gone, not
 * because the runtime refused it.
 */
export function isRuntimeTransportError(error) {
  const code = Number(error?.code);
  if (Number.isFinite(code) && TRANSPORT_ERROR_CODES.has(code)) return true;
  if (error?.name === 'ConnectionError') return true;
  return /\bconnection (?:got |is |was )?(?:disposed|closed)\b/i.test(String(error?.message || ''));
}

export function isModelSwitchUnconfirmedError(error) {
  return error?.modelSwitchUnconfirmed === true;
}

/** switchTo statuses that read as success when the result omits `modelId`. */
const SWITCH_OK_STATUS_RE = /^(?:ok|success|succeeded|applied|switched|completed)$/i;

export function createCopilotModelSwitcher({
  switchTimeoutMs = DEFAULT_MODEL_SWITCH_TIMEOUT_MS,
  dbg = () => {},
} = {}) {
  // The last (model, effort) pair CONFIRMED on the live session — by an RPC
  // result, by a drained `session.model_change`, or by the caller vouching for
  // a session config it just built (`noteApplied`). `effort: null` means "the
  // model's default". This is the single gate that keeps the common path
  // (same model, same effort, every turn) at zero RPCs.
  let applied = { model: '', effort: null };
  // One `rpc.model.list()` per live session, fetched lazily and only when an
  // effort actually needs validating or defaulting. Reset with the session.
  let catalog = null;
  // Deferred switches waiting for their `session.model_change` drain.
  const drainWaiters = new Set();

  function settleWaiters(model, value) {
    for (const waiter of [...drainWaiters]) {
      if (model === null || waiter.model === model) {
        drainWaiters.delete(waiter);
        waiter.resolve(value);
      }
    }
  }

  /** The session is gone (rebuild, idle shutdown): nothing confirmed survives it. */
  function reset() {
    applied = { model: '', effort: null };
    catalog = null;
    settleWaiters(null, false);
  }

  /**
   * The caller vouches for the session's state without an RPC — a session
   * CREATED with `config.model` (and, for BYOK, `config.reasoningEffort`) is
   * on that model by construction.
   */
  function noteApplied(model, effort = null) {
    applied = { model: String(model || '').trim(), effort: normalizeRelayEffort(effort) };
  }

  function current() {
    return { ...applied };
  }

  /**
   * Fed every LIVE session event by the runner (the replay gate runs first —
   * a historical `session.model_change` must not confirm a pending switch).
   * Keeps the tracked pair truthful even for switches this worker did not ask
   * for (a deferred switch draining after its wait expired, a runtime-side
   * refusal fallback), and resolves any drain waiter for the new model.
   */
  function observeEvent(event) {
    if (event?.type !== 'session.model_change') return;
    const newModel = String(event?.data?.newModel || '').trim();
    if (!newModel) return;
    applied = { model: newModel, effort: normalizeRelayEffort(event?.data?.reasoningEffort) };
    settleWaiters(newModel, true);
  }

  /** Arm a bounded waiter for the drain of a deferred switch onto `model`. */
  function armDrainWaiter(model) {
    let resolveWaiter;
    let timer = null;
    const waiter = { model };
    const promise = new Promise((resolve) => { resolveWaiter = resolve; });
    waiter.resolve = (value) => {
      clearTimeout(timer);
      resolveWaiter(value);
    };
    timer = setTimeout(() => {
      drainWaiters.delete(waiter);
      waiter.resolve(false);
    }, switchTimeoutMs);
    timer.unref?.();
    drainWaiters.add(waiter);
    return {
      promise,
      cancel: () => {
        drainWaiters.delete(waiter);
        waiter.resolve(false);
      },
    };
  }

  /** Populate the per-session catalog cache from one `rpc.model.list()` call. */
  async function ensureCatalog(session) {
    if (catalog) return;
    const list = typeof session?.rpc?.model?.list === 'function'
      ? await session.rpc.model.list().catch((error) => {
        dbg('rpc.model.list failed; effort validation degrades to the runtime', error?.message || String(error));
        return null;
      })
      : null;
    // A failed list is cached as empty rather than retried per turn: the
    // degradation (send the effort, let the runtime validate) is safe.
    catalog = new Map();
    for (const entry of (Array.isArray(list?.list) ? list.list : [])) {
      const id = String(entry?.id || '').trim();
      if (id) catalog.set(id, entry);
    }
  }

  /** The catalog entry for a model, from one cached per-session list() call. */
  async function modelInfo(session, model) {
    if (!model) return null;
    await ensureCatalog(session);
    return catalog.get(model) || null;
  }

  /**
   * The cached catalog as raw ModelInfo entries, fetching it on first use —
   * the SAME single list() the effort validation reads, so a snapshot publish
   * never adds a second RPC to a session that already validated an effort.
   * Empty when the runtime refused the list; callers treat that as "nothing
   * to publish" rather than an error.
   */
  async function catalogEntries(session) {
    await ensureCatalog(session);
    return [...catalog.values()];
  }

  /**
   * Bring the live session onto (model, effort), doing nothing when both
   * already match.
   *
   * Returns `{ ok: true, changed }` on success. On failure: hosted sessions
   * THROW the unconfirmed error (the caller must not send the prompt); BYOK
   * sessions get `{ ok: false, detail }` so the caller can fall back to its
   * dispose+resume rebuild.
   */
  async function apply(session, { model = '', effort = undefined, byok = false } = {}) {
    const targetModel = String(model || '').trim();
    const targetEffortRaw = normalizeRelayEffort(effort);
    const modelChanged = !!targetModel && targetModel !== applied.model;
    // The model the effort applies to: the one we are switching to, else the
    // one the session is already on. With neither there is nothing to do.
    const effortModel = targetModel || applied.model;
    if (!effortModel) return { ok: true, changed: false };

    const fail = (detail, requestedEffort = targetEffortRaw) => {
      if (byok) {
        dbg('BYOK model RPC unconfirmed; caller falls back to rebuild', detail);
        return { ok: false, detail };
      }
      throw createModelSwitchUnconfirmedError({
        requestedModel: targetModel || applied.model,
        requestedEffort,
        actualModel: applied.model,
        detail,
      });
    };

    // A request that failed because the connection to the runtime is gone says
    // nothing about the model: "pick an available model and resend it" sent
    // the user to the model picker over a dead runtime, and because an
    // unconfirmed switch keeps the runtime, every retry failed the same way.
    // Thrown as it is, it fails the turn and the runtime is rebuilt.
    const failOrRethrow = (error, requestedEffort = targetEffortRaw) => {
      if (isRuntimeTransportError(error)) throw error;
      return fail(error?.message || String(error), requestedEffort);
    };

    // ---- resolve the effort actually sent on the wire -----------------------
    // `null` target = "the model's default": mapped to the catalog's
    // `defaultReasoningEffort` when known, otherwise omitted entirely (and the
    // local tracking resets, so the next explicit effort still reads as a
    // delta). An explicit level is pre-validated against the model's
    // `supportedReasoningEfforts` — the setReasoningEffort RPC is
    // @experimental and documents that the HOST validates.
    let effortToSend;
    let trackedEffort;
    if (targetEffortRaw === null) {
      if (!modelChanged && applied.effort === null) {
        effortToSend = undefined;
        trackedEffort = null;
      } else {
        const info = await modelInfo(session, effortModel);
        const supported = supportedEffortsOf(info);
        if (supported?.includes('none')) {
          // The wire catalog offers a literal "none" (GPT-family entries do,
          // despite the TS union lacking the member): send it as the explicit
          // reset, tracked as null so steady-state stays zero-RPC.
          effortToSend = 'none';
          trackedEffort = null;
        } else {
          const fallback = normalizeRelayEffort(info?.defaultReasoningEffort);
          effortToSend = fallback || undefined;
          trackedEffort = fallback;
        }
      }
    } else {
      const info = await modelInfo(session, effortModel);
      const supported = supportedEffortsOf(info);
      // Fail ONLY on a positive exclusion. An entry with no parseable effort
      // list — model absent from the catalog, an effort-less model, or a wire
      // shape this code does not know — sends the level and lets the runtime
      // confirm or refuse: failing closed here bricked every effort-carrying
      // turn when the session list turned out to speak raw CAPI shape.
      if (Array.isArray(supported) && !supported.includes(targetEffortRaw)) {
        const advertised = supported.length ? ` (it supports: ${supported.join(', ')})` : '';
        if (byok) {
          // Openai-compatible providers define their own effort vocabularies
          // (and many models simply have none); a level the catalog rejects is
          // skipped rather than failed, per the BYOK contract.
          dbg('BYOK model does not support the requested effort; skipping it', effortModel, targetEffortRaw);
          effortToSend = undefined;
          trackedEffort = applied.effort;
        } else if (!modelChanged) {
          return fail(`the model does not support reasoning effort "${targetEffortRaw}"${advertised}`);
        } else {
          // Model change + unsupported effort: the selection as a whole cannot
          // be honoured — running the new model on a different effort than the
          // one explicitly picked is the same silent substitution #13 forbids.
          return fail(`"${targetModel}" does not support reasoning effort "${targetEffortRaw}"${advertised}`);
        }
      } else {
        effortToSend = targetEffortRaw;
        trackedEffort = targetEffortRaw;
      }
    }

    const effortChanged = !modelChanged && effortToSend !== undefined && effortToSend !== applied.effort;

    if (!modelChanged && !effortChanged) {
      // Nothing to send; an unknown-default reset still updates the tracking.
      if (targetEffortRaw === null) applied = { ...applied, effort: trackedEffort };
      return { ok: true, changed: false };
    }

    // ---- model change: rpc.model.switchTo, result consumed ------------------
    if (modelChanged) {
      const switchTo = session?.rpc?.model?.switchTo;
      if (typeof switchTo !== 'function') {
        // No RPC surface (an exotic bundle): the facade's throw-on-failure is
        // the only signal left. Hosted trusts it; BYOK falls back to rebuild.
        if (byok || typeof session?.setModel !== 'function') return fail('the runtime exposes no model-switch RPC');
        await session.setModel(targetModel, effortToSend ? { reasoningEffort: effortToSend } : undefined)
          .catch((error) => failOrRethrow(error));
        applied = { model: targetModel, effort: trackedEffort };
        return { ok: true, changed: true };
      }
      // Armed BEFORE the RPC: a deferred switch can drain between the result
      // arriving and any later subscription, and a missed drain here would
      // fail a selection the runtime actually honoured.
      const drain = armDrainWaiter(targetModel);
      let result;
      try {
        result = await switchTo.call(session.rpc.model, {
          modelId: targetModel,
          ...(effortToSend ? { reasoningEffort: effortToSend } : {}),
        });
      } catch (error) {
        drain.cancel();
        return failOrRethrow(error);
      }
      if (result?.confirmation) {
        // A compaction preflight wants an interactive decision; a headless
        // worker has nobody to put it to mid-dequeue.
        drain.cancel();
        return fail('the runtime requires interactive confirmation for this switch');
      }
      if (result?.deferred === true) {
        // Enqueued behind an active turn: the live model is unchanged until
        // the queue drains. Wait (bounded) for the model_change that proves it.
        dbg('model switch deferred behind an active turn; awaiting the drain', targetModel);
        const drained = await drain.promise;
        if (!drained) {
          return fail(`the queued switch did not apply within ${Math.round(switchTimeoutMs / 1000)}s`);
        }
        // `observeEvent` already updated `applied` from the event (including
        // the effort the runtime settled on); do not overwrite it blind.
        return { ok: true, changed: true };
      }
      drain.cancel();
      const confirmedModel = String(result?.modelId || result?.modelState?.modelId || '').trim();
      if (confirmedModel && confirmedModel !== targetModel) {
        return fail(`the runtime reports "${confirmedModel}" as the active model`);
      }
      if (!confirmedModel && !SWITCH_OK_STATUS_RE.test(String(result?.status || ''))) {
        return fail(String(result?.message || 'the runtime did not report the active model after the switch'));
      }
      applied = { model: targetModel, effort: trackedEffort };
      return { ok: true, changed: true };
    }

    // ---- effort-only change: rpc.model.setReasoningEffort -------------------
    const setEffort = session?.rpc?.model?.setReasoningEffort;
    if (typeof setEffort !== 'function') {
      return fail('the runtime exposes no reasoning-effort RPC', effortToSend);
    }
    let effortResult;
    try {
      effortResult = await setEffort.call(session.rpc.model, { reasoningEffort: effortToSend });
    } catch (error) {
      return failOrRethrow(error, effortToSend);
    }
    const recorded = String(effortResult?.reasoningEffort || '').trim().toLowerCase();
    if (recorded && recorded !== effortToSend) {
      return fail(`the runtime recorded effort "${recorded}"`, effortToSend);
    }
    applied = { ...applied, effort: trackedEffort };
    return { ok: true, changed: true };
  }

  return {
    apply,
    observeEvent,
    noteApplied,
    reset,
    current,
    catalogEntries,
  };
}
