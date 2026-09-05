// The installed-PWA app name, stored once per relay in app_settings and served
// to every browser through /manifest.webmanifest. It must live server-side:
// Android's WebAPK update check re-fetches the manifest outside any page
// session, so a name the server does not know reverts on the phone with an
// accept-or-uninstall prompt.

export const PWA_APP_NAME_DEFAULT = 'OAR';
export const PWA_APP_NAME_MAX_LENGTH = 60;

/** Empty is valid and means "use the default name". */
export function normalizePwaAppName(rawValue) {
  const value = String(rawValue ?? '').replace(/\s+/g, ' ').trim();
  if (value.length > PWA_APP_NAME_MAX_LENGTH) {
    return { ok: false, error: `App name must be ${PWA_APP_NAME_MAX_LENGTH} characters or fewer` };
  }
  return { ok: true, value };
}

/** Stored DB value -> custom name, or '' when unset/junk (meaning default). */
export function readPwaAppNameSetting(storedValue) {
  const normalized = normalizePwaAppName(storedValue);
  return normalized.ok ? normalized.value : '';
}

/**
 * Launcher labels get very little room: the first word when it fits, otherwise
 * a hard slice of the full name.
 */
export function derivePwaShortName(name) {
  const text = String(name || '').trim();
  if (!text) return PWA_APP_NAME_DEFAULT;
  const firstWord = text.split(/\s+/)[0] || text;
  if (firstWord.length <= 12) return firstWord;
  return text.slice(0, 12).trim() || PWA_APP_NAME_DEFAULT;
}

export function resolvePwaManifestNames(customName, templateName) {
  const custom = String(customName || '').trim();
  if (custom) {
    return { name: custom, short_name: derivePwaShortName(custom) };
  }
  const fallback = String(templateName || '').trim() || PWA_APP_NAME_DEFAULT;
  return { name: fallback, short_name: derivePwaShortName(fallback) };
}
