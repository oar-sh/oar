// Which providers are known to be ready to run a chat, from what the client
// already loads: the provider settings payloads and the model catalog. No DOM.
//
// OpenAI, Claude, Claude Cloud, Cursor, Grok and DeepSeek say so themselves: their
// settings carry `enabled`. Copilot has no such flag and the relay never asks
// whether the Copilot CLI is signed in, so the best signal is indirect: has a
// real Copilot model list ever reached the catalog? A fresh database is seeded
// with a curated list under the source `bootstrap-seed`; a server discovery,
// an extension snapshot or a worker snapshot replaces that source. Until one
// has, Copilot is `unknown`, never "not ready": the signal can be wrong (a
// signed-in host whose first discovery timed out), so callers only point to
// Settings and never block.
//
// A payload that failed to load is `null`, and makes the whole answer
// `known: false`. Callers treat an unknown answer as ready, which is today's
// behaviour: a network blip must never show the setup wall.

export const SEED_CATALOG_SOURCE = 'bootstrap-seed';

const SETTINGS_PROVIDERS = Object.freeze([
  ['openai', 'openai'],
  ['claude', 'claude'],
  ['claudeCloud', 'claude-cloud'],
  ['cursor', 'cursor'],
  ['grok', 'grok'],
  ['deepseek', 'deepseek'],
]);

/** Payloads whose absence means "could not be loaded" rather than "not offered". */
const REQUIRED_INPUTS = Object.freeze(['openai', 'claude', 'cursor', 'grok', 'catalog']);

/**
 * @param {object} input the settings payloads New Chat loads, plus GET /api/models
 * @param {object|null} [input.openai]
 * @param {object|null} [input.claude]
 * @param {object|null} [input.claudeCloud] null on a relay without Claude Cloud: not offered, not unknown
 * @param {object|null} [input.cursor]
 * @param {object|null} [input.grok]
 * @param {object|null} [input.deepseek] null on a relay without DeepSeek: not offered, not unknown
 * @param {object|null} [input.catalog]
 * @returns {{ known: boolean, anyReady: boolean, ready: string[], copilot: 'ready' | 'unknown' }}
 */
export function resolveProviderReadiness(input = {}) {
  const payloads = input && typeof input === 'object' ? input : {};
  const known = REQUIRED_INPUTS.every((key) => payloads[key] && typeof payloads[key] === 'object');
  const ready = [];
  for (const [key, providerId] of SETTINGS_PROVIDERS) {
    if (payloads[key]?.enabled === true) ready.push(providerId);
  }
  const source = String(payloads.catalog?.source || '').trim();
  const copilot = payloads.catalog && typeof payloads.catalog === 'object' && source && source !== SEED_CATALOG_SOURCE
    ? 'ready'
    : 'unknown';
  if (copilot === 'ready') ready.push('github');
  return { known, anyReady: ready.length > 0, ready, copilot };
}

/** The one question the empty screen, New Chat and the composer ask. */
export function isSetupRequired(readiness) {
  return !!readiness && readiness.known === true && readiness.anyReady !== true;
}

// ── The client's live copy ────────────────────────────────────────────────
// Fed from the initial loads, the socket events that follow a Settings save
// or a catalog change, and New Chat's own fresh loads. Subscribers redraw the
// empty screen and the composer when the answer changes.

const inputs = {
  openai: undefined,
  claude: undefined,
  claudeCloud: undefined,
  cursor: undefined,
  grok: undefined,
  deepseek: undefined,
  catalog: undefined,
};
let current = resolveProviderReadiness(inputs);
const listeners = new Set();

function readinessKey(readiness) {
  return `${readiness.known ? 1 : 0}|${readiness.anyReady ? 1 : 0}|${readiness.ready.join(',')}|${readiness.copilot}`;
}

/**
 * Records fresh payloads; `null` for a failed load, `undefined` keys are left
 * as they were. Listeners run only when the resolved answer changed.
 */
export function updateProviderReadinessInputs(partial = {}) {
  if (!partial || typeof partial !== 'object') return current;
  for (const key of Object.keys(inputs)) {
    if (partial[key] !== undefined) inputs[key] = partial[key];
  }
  const next = resolveProviderReadiness(inputs);
  const changed = readinessKey(next) !== readinessKey(current);
  current = next;
  if (changed) {
    for (const listener of Array.from(listeners)) {
      try { listener(current); } catch {}
    }
  }
  return current;
}

export function getProviderReadiness() {
  return current;
}

export function isProviderSetupRequired() {
  return isSetupRequired(current);
}

export function subscribeProviderReadiness(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Tests only: back to "nothing loaded yet". */
export function resetProviderReadinessForTests() {
  for (const key of Object.keys(inputs)) inputs[key] = undefined;
  current = resolveProviderReadiness(inputs);
  listeners.clear();
}
