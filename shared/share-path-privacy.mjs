// What a shared conversation shows of the relay host's paths and file names.
// One relay-wide setting; the owner's own view is never filtered. Shared so the
// settings route, the share routes and the Settings control agree.

export const SHARE_PATH_PRIVACY_SETTING_KEY = 'share_path_privacy';

export const SHARE_PATH_PRIVACY_MODES = Object.freeze(['show', 'filename', 'hide']);
export const DEFAULT_SHARE_PATH_PRIVACY_MODE = 'filename';

export const SHARE_PATH_PRIVACY_LABELS = Object.freeze({
  show: 'Show every path and file name',
  filename: 'Hide the path, show the file name',
  hide: 'Hide paths and file names',
});

function asMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  return SHARE_PATH_PRIVACY_MODES.includes(mode) ? mode : null;
}

/** An unset or unreadable setting means the default, never "show". */
export function readSharePathPrivacySetting(storedValue) {
  return asMode(storedValue) || DEFAULT_SHARE_PATH_PRIVACY_MODE;
}

export function parseSharePathPrivacyUpdate(value) {
  const mode = asMode(value);
  if (!mode) return { ok: false, error: `mode must be one of ${SHARE_PATH_PRIVACY_MODES.join(', ')}` };
  return { ok: true, mode };
}
