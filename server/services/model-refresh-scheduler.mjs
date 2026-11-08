'use strict';

// The background "Check for new models" (Settings → General → Models).
//
// A minute after boot, then every quarter of an hour, the scheduler asks
// which providers are due and refreshes those through the same helper as the
// Select Models Refresh button (provider-model-refresh.mjs), with reason
// `background`. A provider is due when the check is on, the provider is not
// left out, it is enabled and set up, its last successful refresh (by
// anything: the button, a save, a login, the boot) is at least the interval
// old, and its last failure at least an hour old. A provider never refreshed
// is due at the first tick, which is how an overdue provider is checked after
// boot. Time and timers are injected so a test can drive it with a fake clock.

import {
  MODEL_REFRESH_FAILURE_RETRY_MS,
  MODEL_REFRESH_FIRST_TICK_MS,
  MODEL_REFRESH_PROVIDERS,
  MODEL_REFRESH_TICK_MS,
} from '../../shared/model-refresh-schedule.mjs';
import { modelRefreshErrorSummary } from './provider-model-refresh.mjs';

const HOUR_MS = 60 * 60 * 1000;

function timeOf(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function notInFuture(ms, nowMs) {
  return ms !== null && ms > nowMs ? null : ms;
}

/**
 * The providers due at `nowMs`, in the canonical order. `settings` is
 * `{ auto, intervalHours, excluded }`, `last` the ledger's entries, `table`
 * the provider table (buildProviderRefreshTable).
 */
export function dueModelRefreshProviders({ settings = {}, last = {}, table = {}, nowMs = Date.now() } = {}) {
  if (settings.auto === false) return [];
  const intervalMs = Math.max(1, Number(settings.intervalHours) || 24) * HOUR_MS;
  const excluded = new Set(Array.isArray(settings.excluded) ? settings.excluded : []);
  const due = [];
  for (const { id } of MODEL_REFRESH_PROVIDERS) {
    const entry = table[id];
    if (!entry || excluded.has(id) || typeof entry.refresh !== 'function') continue;
    let setUp = false;
    try {
      setUp = entry.isSetUp?.() === true;
    } catch {
      setUp = false;
    }
    if (!setUp) continue;
    // A stamp later than now (a clock set back, a hand edit) cannot be
    // trusted: the provider is due rather than skipped until then.
    const lastOk = notInFuture(timeOf(last[id]?.lastOkAt), nowMs);
    const lastFailure = notInFuture(timeOf(last[id]?.lastFailureAt), nowMs);
    if (lastOk !== null && nowMs - lastOk < intervalMs) continue;
    if (lastFailure !== null && nowMs - lastFailure < MODEL_REFRESH_FAILURE_RETRY_MS) continue;
    due.push(id);
  }
  return due;
}

export function createModelRefreshScheduler({
  // () => { auto, intervalHours, excluded }
  getSettings = () => ({ auto: true, intervalHours: 24, excluded: [] }),
  // () => { <provider>: { lastOkAt, lastFailureAt } } (the ledger)
  getLast = () => ({}),
  // () => the provider table (buildProviderRefreshTable)
  getTable = () => ({}),
  // ({ providers, reason }) => Promise<{ results, changed }>
  refreshProviders = async () => ({ results: {}, changed: false }),
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  firstTickMs = MODEL_REFRESH_FIRST_TICK_MS,
  tickMs = MODEL_REFRESH_TICK_MS,
  logger = console,
} = {}) {
  let timer = null;
  let running = null;
  let disposed = false;
  // Set by the routes layer, which owns the models_updated payload.
  let onModelsChanged = () => {};

  function schedule(delayMs) {
    if (disposed) return;
    if (timer) clearTimeoutFn(timer);
    timer = setTimeoutFn(() => {
      timer = null;
      void tick().finally(() => schedule(tickMs));
    }, Math.max(0, Number(delayMs) || 0));
    timer?.unref?.();
  }

  /** One look: refreshes what is due. Never rejects; one run at a time. */
  async function tick() {
    if (disposed) return { providers: [], results: {}, changed: false };
    if (running) return running;
    // Cleared in a .finally of its own: a run with nothing due settles
    // before the assignment would otherwise have happened.
    running = (async () => {
      let providers = [];
      try {
        providers = dueModelRefreshProviders({ settings: getSettings(), last: getLast(), table: getTable(), nowMs: now() });
        if (!providers.length) return { providers, results: {}, changed: false };
        logger.log?.(`[model-refresh] background model refresh: ${providers.join(', ')}`);
        const { results = {}, changed = false } = await refreshProviders({ providers, reason: 'background' }) || {};
        const failed = providers.filter((id) => results[id] && results[id].ok !== true && results[id].skipped !== true);
        if (failed.length) {
          // The provider and the kind of failure only: an answer's body may
          // echo what was sent with the request.
          logger.warn?.(`[model-refresh] background model refresh failed for ${failed.map((id) => `${id} (${modelRefreshErrorSummary(results[id].error)})`).join(', ')}`);
        }
        if (changed && !disposed) {
          try {
            onModelsChanged();
          } catch (error) {
            logger.warn?.(`[model-refresh] models-changed listener failed: ${error?.message || error}`);
          }
        }
        return { providers, results, changed };
      } catch (error) {
        logger.warn?.(`[model-refresh] background model refresh failed: ${modelRefreshErrorSummary(error?.message || error)}`);
        return { providers, results: {}, changed: false };
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function start() {
    if (disposed || timer) return;
    schedule(firstTickMs);
  }

  function setOnModelsChanged(listener) {
    onModelsChanged = typeof listener === 'function' ? listener : () => {};
  }

  async function dispose() {
    disposed = true;
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
    try { await running; } catch { /* tick() never rejects */ }
  }

  return { start, tick, dispose, setOnModelsChanged, isStarted: () => timer !== null };
}
