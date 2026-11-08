// Server-side Copilot model discovery (Phase 5A of the extension-retirement
// track).
//
// Today the model catalog is only ever POPULATED by a running engine — the
// extension and the standalone relay POST `/api/models/snapshot` when their
// session comes up. Once the extension retires, a relay restart leaves the
// catalog empty until the first SDK worker happens to spawn, and the composer's
// model picker with it. This service closes that gap from the server side: a
// short-lived `CopilotClient` (the same installed-CLI runtime the session
// import service boots) answers `listModels()`, and the result feeds the SAME
// in-process catalog the snapshot route feeds — no HTTP self-call, and the
// entries are tagged `server-discovery:<reason>` alongside the existing
// `web-relay-extension:<reason>` / `standalone-relay:<reason>` sources.
//
// Failure policy is log-and-skip throughout: the catalog keeps its previous
// contents (persisted model-variant rows survive restarts), so a missing CLI,
// a hung runtime or a refused list costs nothing but this refresh. The client
// is disposed in `finally` — a discovery must never leave a runtime process
// behind — and `dispose()` follows the SDK-session-import pattern so a refresh
// in flight at shutdown cannot hang the exit.
import { buildModelSnapshotFields, extractModelDescriptors } from '../../shared/model-descriptors.mjs';

/** Same budget the Claude model discovery races `supportedModels()` against. */
export const DEFAULT_COPILOT_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;
/**
 * How long after boot the startup refresh fires. Staggered like the SDK
 * session importer's startup sweep (which also boots an installed-CLI runtime
 * from the listen callback) so the two spawns don't compete with serving the
 * first page loads; nothing awaits it, so it never blocks startup.
 */
export const DEFAULT_COPILOT_MODEL_DISCOVERY_BOOT_DELAY_MS = 5_000;

export function createCopilotModelDiscoveryService({
  // () => Promise<{ client, dispose }> — createInstalledCopilotClient bound to
  // the relay's config/workspace by the caller.
  createClient,
  // Feature detection: throws when no Copilot CLI runtime is resolvable
  // (resolveInstalledCopilotPaths' contract). A relay without the CLI must not
  // spawn anything or log an error per refresh — Copilot may simply not be one
  // of its providers.
  resolveInstalledPaths,
  // The in-process catalog feed the snapshot route uses (server-runtime's
  // updateModelCatalog) — fed directly, no HTTP self-call.
  updateModelCatalog,
  timeoutMs = DEFAULT_COPILOT_MODEL_DISCOVERY_TIMEOUT_MS,
  bootDelayMs = DEFAULT_COPILOT_MODEL_DISCOVERY_BOOT_DELAY_MS,
  // (result, reason) after each refresh that got past the CLI check: the
  // model refresh ledger's clock (the boot refresh included).
  onRefreshed = () => {},
  logger = console,
} = {}) {
  if (typeof createClient !== 'function' || typeof updateModelCatalog !== 'function') {
    throw new Error('Copilot model discovery requires a client factory and a catalog feed');
  }
  let closing = false;
  let activeRefresh = null;
  // The live client handle mid-refresh, so dispose() can tear it down FIRST —
  // that is what makes a hung listModels() settle promptly at shutdown instead
  // of holding the refresh (and the exit behind it) for the full timeout.
  let activeRuntime = null;
  let startupTimer = null;
  // Set by the routes layer (which owns the provider-enriched catalog payload
  // and the socket) so a successful discovery reaches connected clients the
  // same way a snapshot POST does.
  let onCatalogUpdated = () => {};

  function raceTimeout(promise, label) {
    return Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  }

  function isCliResolvable() {
    if (typeof resolveInstalledPaths !== 'function') return false;
    try {
      resolveInstalledPaths();
      return true;
    } catch {
      return false;
    }
  }

  async function refresh(reason = 'unspecified') {
    if (closing) return { ok: false, skipped: true, models: [], error: 'Copilot model discovery is shutting down' };
    // Single-flight: a manual refresh racing the boot refresh shares its run.
    if (activeRefresh) return activeRefresh;
    if (!isCliResolvable()) {
      return { ok: false, skipped: true, models: [], error: 'Copilot CLI runtime is not installed' };
    }
    activeRefresh = (async () => {
      const clientPromise = createClient();
      let runtime = null;
      try {
        runtime = await raceTimeout(clientPromise, 'Copilot client start');
        activeRuntime = runtime;
        if (closing) return { ok: false, skipped: true, models: [], error: 'Copilot model discovery is shutting down' };
        const modelInfos = await raceTimeout(runtime.client.listModels(), 'Copilot model discovery');
        const descriptors = extractModelDescriptors(modelInfos);
        if (!descriptors.length) {
          // Log-and-skip, and deliberately no error write into the catalog:
          // an empty answer must not degrade whatever a worker snapshot or a
          // previous run already published.
          logger.warn?.('[copilot-model-discovery] listModels returned no usable models');
          return { ok: false, models: [], error: 'Copilot model discovery returned no models' };
        }
        // The typed client-level entries and the worker's raw session-level
        // entries go through the same shared builder, so both publishers
        // agree on every per-model metadata field.
        const { models, contextLimitsByModel, modelMetadataByModel } = buildModelSnapshotFields(descriptors);
        // No currentModel/defaultModel: a session-less listModels cannot know
        // the active model, and updateModelCatalog keeps its existing pair
        // when the snapshot omits them.
        updateModelCatalog({
          models,
          contextLimitsByModel,
          modelMetadataByModel,
          source: `server-discovery:${reason}`,
          error: null,
        });
        try {
          onCatalogUpdated();
        } catch (error) {
          logger.warn?.(`[copilot-model-discovery] catalog-updated listener failed: ${error?.message || error}`);
        }
        return { ok: true, models, error: null };
      } catch (error) {
        const detail = String(error?.message || error || 'unknown error');
        logger.warn?.(`[copilot-model-discovery] refresh (${reason}) failed: ${detail}`);
        return { ok: false, models: [], error: `Copilot model discovery failed: ${detail}` };
      } finally {
        // dispose() may already have taken the handle mid-refresh; only tear
        // down what this refresh still owns, so the runtime is disposed exactly
        // once whichever side gets there first.
        const owned = activeRuntime === runtime ? runtime : null;
        activeRuntime = null;
        if (owned) {
          try {
            await owned.dispose?.();
          } catch (error) {
            logger.warn?.(`[copilot-model-discovery] client dispose failed: ${error?.message || error}`);
          }
        } else if (!runtime) {
          // The timeout won the start race: the spawn may still resolve later
          // with a live runtime nobody owns — dispose it then (the same trade
          // refreshGrokProviderModels makes with its late agent handle).
          clientPromise.then((late) => late?.dispose?.()).catch(() => {});
        }
        activeRefresh = null;
      }
    })().then((result) => {
      try { onRefreshed(result, reason); } catch { /* the clock is best-effort */ }
      return result;
    });
    return activeRefresh;
  }

  /**
   * The deferred boot trigger. Unref'd so a relay that exits immediately (a
   * failed listen, a test) is not held open by a discovery it never wanted.
   */
  function scheduleStartupRefresh({ delayMs = bootDelayMs, reason = 'boot' } = {}) {
    if (closing || startupTimer) return;
    startupTimer = setTimeout(() => {
      startupTimer = null;
      void refresh(reason);
    }, Math.max(0, Number(delayMs) || 0));
    startupTimer.unref?.();
  }

  function setOnCatalogUpdated(listener) {
    onCatalogUpdated = typeof listener === 'function' ? listener : () => {};
  }

  async function dispose() {
    // Flag first, exactly like the session importer: refresh() must refuse new
    // work before anything is torn down, or a concurrent caller respawns a
    // runtime while the server is exiting.
    closing = true;
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    // Tear the live client down before awaiting the refresh: a hung
    // listModels() only settles when its transport dies, and waiting the full
    // discovery timeout here is exactly the shutdown hang this must avoid.
    const runtime = activeRuntime;
    activeRuntime = null;
    if (runtime) {
      try { await runtime.dispose?.(); } catch { /* best-effort at shutdown */ }
    }
    try { await activeRefresh; } catch { /* refresh() never rejects; belt only */ }
  }

  return {
    refresh,
    scheduleStartupRefresh,
    setOnCatalogUpdated,
    isCliResolvable,
    dispose,
  };
}
