'use strict';

// The GitHub Copilot switch (Settings → Providers → Copilot → Enable GitHub
// Copilot). Inside the code the provider id is `github`; `copilot` is the tab,
// the CLI and its install id.
//
// One app_settings row, `copilot_enabled` ('true' / 'false'). Pure helpers
// over readSetting / writeSetting, with no shared instance, so the route
// modules and the runtime read the same key.
//
// An existing relay gets 'true' from migration 0043. On a new database the
// key is unset, and the first read with a detector decides it once: the
// Copilot CLI found → on, else off, written so detection never flips it
// again. A read without a detector (route deps the runtime did not give one)
// says on and writes nothing.
//
// Two states belong to the process, not the database. Migration 0043 failed
// at this start (db-schema.mjs notes it): while the key is unset, every read
// says off and writes nothing, so the next start retries the migration;
// switching Copilot on in Settings writes the key, which reads answer from
// then on. A detected value that cannot be written: the read answers it
// anyway, warns once, and a later read tries the write again.

export const COPILOT_ENABLED_SETTING_KEY = 'copilot_enabled';

let switchMigrationFailed = false;
let unsavedSwitchWarned = false;

/** Migration 0043 failed at this start (db-schema.mjs). */
export function noteCopilotSwitchMigrationFailed() {
  switchMigrationFailed = true;
}

/** A stored value → true / false, or null when unset or unreadable. */
export function parseCopilotEnabledSetting(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

/**
 * Whether Copilot is on. `readSetting(key)` → the stored text ('' when
 * unset); `writeSetting(key, value, stamp)` stores the detected value;
 * `detectCli()` → whether the Copilot CLI is installed. Unset and no
 * detector: on, nothing written. A detector that throws counts as not found.
 * Unset after a failed migration (`migrationFailed`): off, nothing detected
 * or written. Never throws.
 */
export function readCopilotEnabled({
  readSetting = () => '',
  writeSetting = null,
  detectCli = null,
  now = () => new Date(),
  migrationFailed = switchMigrationFailed,
  warn = (line) => console.warn(line),
} = {}) {
  let stored = null;
  try {
    stored = parseCopilotEnabledSetting(readSetting(COPILOT_ENABLED_SETTING_KEY));
  } catch {
    stored = null;
  }
  if (stored !== null) return stored;
  if (migrationFailed) return false;
  if (typeof detectCli !== 'function') return true;
  let found = false;
  try {
    found = Boolean(detectCli());
  } catch {
    found = false;
  }
  if (typeof writeSetting === 'function') {
    try {
      writeSetting(COPILOT_ENABLED_SETTING_KEY, found ? 'true' : 'false', now().toISOString());
    } catch (error) {
      if (!unsavedSwitchWarned) {
        unsavedSwitchWarned = true;
        try {
          warn(`[copilot] the Copilot switch could not be saved (${error?.message || error}): Copilot is ${found ? 'on' : 'off'} for now, as detected, and the next start decides it again`);
        } catch {}
      }
    }
  }
  return found;
}

/**
 * readCopilotEnabled for a route module, over the repository statements its
 * deps carry (`getAppSetting`, `upsertAppSetting`). Statements it lacks (a
 * test's stand-in) read as unset and write nothing.
 */
export function copilotEnabledFromStmts(stmts, { detectCli = null, now = () => new Date() } = {}) {
  const upsert = stmts?.upsertAppSetting;
  return readCopilotEnabled({
    readSetting: (key) => String(stmts?.getAppSetting?.get?.(key)?.value ?? ''),
    writeSetting: typeof upsert?.run === 'function' ? (key, value, stamp) => upsert.run(key, value, stamp) : null,
    detectCli,
    now,
  });
}

/**
 * The answer to a new chat that would be Copilot's while Copilot is off:
 * `named` (the provider `github`, or a model of Copilot's catalogue) →
 * COPILOT_NOT_ENABLED; nothing named → PROVIDER_REQUIRED. Nothing picks
 * another provider instead.
 */
export function copilotOffCreateRefusal({ named = false } = {}) {
  return named
    ? {
        ok: false,
        code: 'COPILOT_NOT_ENABLED',
        error: 'Copilot is switched off on this relay, so no Copilot chat was started. Switch it on in Settings → Providers → Copilot, or name another provider.',
      }
    : {
        ok: false,
        code: 'PROVIDER_REQUIRED',
        error: 'Name a provider: Copilot is switched off on this relay.',
      };
}

/** Whether `model` is listed in Copilot's own catalogue (`{ models }`), any casing. */
export function isCopilotCatalogModel(model, catalog = null) {
  const wanted = String(model || '').trim().toLowerCase();
  if (!wanted) return false;
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  return models.some((entry) => String(entry || '').trim().toLowerCase() === wanted);
}

/** A chat's provider type is Copilot's: `github`, or none (a chat from before providers). */
export function isCopilotProviderType(providerType) {
  const type = String(providerType ?? '').trim().toLowerCase();
  return type === '' || type === 'github';
}

/** The claim's refusal for a Copilot row while Copilot is switched off. */
export function copilotClaimRefusal() {
  return { code: 'COPILOT_SWITCHED_OFF', error: 'Copilot is switched off on this relay, so this turn did not run.' };
}

/**
 * The note of a Copilot row failed at the claim. The code ends the
 * paragraph, where the transcript's button looks for it (relay-error-ctas.mjs).
 */
export function copilotSwitchedOffNoteText() {
  return 'Copilot is switched off on this relay, so this turn did not run. '
    + 'Switch it on in Settings → Providers → Copilot, then send the message again. '
    + 'Error code: relay.copilot-switched-off.';
}

/**
 * The CLI detector the runtime hands to every reader of the switch:
 * `resolveInstalledPaths()` is copilot-sdk-runtime.mjs's
 * resolveInstalledCopilotPaths (bound to the config), which answers the
 * installed SDK and binary or throws when there is none.
 */
export function createCopilotCliDetector({ resolveInstalledPaths } = {}) {
  return () => {
    try {
      return Boolean(resolveInstalledPaths?.());
    } catch {
      return false;
    }
  };
}

/** Stores the switch as the user set it. */
export function writeCopilotEnabled({ writeSetting, enabled, now = () => new Date() } = {}) {
  if (typeof writeSetting !== 'function') throw new Error('Copilot settings cannot be saved here');
  writeSetting(COPILOT_ENABLED_SETTING_KEY, enabled === true ? 'true' : 'false', now().toISOString());
  return enabled === true;
}

/** POST /api/settings/copilot body → `{ ok, enabled }` or `{ ok: false, error }`. */
export function parseCopilotSettingsUpdateRequest(body = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  if (typeof payload.enabled !== 'boolean') {
    return { ok: false, error: 'No Copilot settings update provided' };
  }
  return { ok: true, enabled: payload.enabled };
}

/**
 * GET /api/settings/copilot: the engine fields older paired relays read,
 * the switch and whether the CLI is installed.
 */
export function copilotSettingsPayload({ engine = 'sdk', engines = ['sdk'], enabled = true, cliFound = false } = {}) {
  return {
    engine: String(engine || 'sdk'),
    engines: Array.isArray(engines) && engines.length ? [...engines] : ['sdk'],
    enabled: enabled !== false,
    cliFound: cliFound === true,
  };
}
