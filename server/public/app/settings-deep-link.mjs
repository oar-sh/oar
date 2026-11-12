// `?settings=<tab>` opens Settings at that tab when the app has started, and
// `&add-relay=1` (with the Relays tab) brings up the "Add a relay" form
// (agent auth §13.2: a paired relay's "Turn on push there", the rotation
// dialog's "Open there", the new sign-in push). The link opens UI only: it
// changes no setting, and it carries no value for any field. The tab must be
// one of the Settings tabs; anything else is ignored. Read once, then taken
// out of the address.

export const SETTINGS_DEEP_LINK_TABS = Object.freeze([
  'general', 'appearance', 'providers', 'relays', 'security', 'previews', 'shares', 'notifications', 'features',
]);
const PARAMS = ['settings', 'add-relay'];

/** `{ tab, addRelay, cleanedPath }`: cleanedPath is null when the URL needs no rewrite. */
export function readSettingsDeepLink(href) {
  let url;
  try {
    url = new URL(String(href || ''));
  } catch {
    return { tab: '', addRelay: false, cleanedPath: null };
  }
  if (!PARAMS.some((param) => url.searchParams.has(param))) return { tab: '', addRelay: false, cleanedPath: null };
  const raw = String(url.searchParams.get('settings') || '').trim().toLowerCase();
  const tab = SETTINGS_DEEP_LINK_TABS.includes(raw) ? raw : '';
  const addRelay = tab === 'relays' && url.searchParams.get('add-relay') === '1';
  for (const param of PARAMS) url.searchParams.delete(param);
  return { tab, addRelay, cleanedPath: `${url.pathname}${url.search}${url.hash}` };
}

/** Reads the link from the current address and takes it out. */
export function consumeSettingsDeepLink({ location = window.location, history = window.history, title = document.title } = {}) {
  const { tab, addRelay, cleanedPath } = readSettingsDeepLink(location?.href);
  if (cleanedPath !== null) history?.replaceState?.(history?.state ?? null, title, cleanedPath);
  return { tab, addRelay };
}

/**
 * A notification tap asks for Settings at a tab. Over the sign-in box
 * Settings would lie above it and its calls would fail, so the tab then
 * waits in the address (`?settings=<tab>`), which the start after the
 * sign-in reads. Returns 'opened', 'deferred' or 'ignored' (not a tab).
 */
export function requestSettingsTab(rawTab, {
  isAuthGateVisible = () => false,
  open = () => {},
  location = window.location,
  history = window.history,
  title = document.title,
} = {}) {
  const tab = String(rawTab || '').trim().toLowerCase();
  if (!SETTINGS_DEEP_LINK_TABS.includes(tab)) return 'ignored';
  let gated = false;
  try { gated = isAuthGateVisible() === true; } catch { gated = false; }
  if (!gated) {
    open(tab);
    return 'opened';
  }
  let url;
  try { url = new URL(String(location?.href || '')); } catch { return 'deferred'; }
  for (const param of PARAMS) url.searchParams.delete(param);
  url.searchParams.set('settings', tab);
  history?.replaceState?.(history?.state ?? null, title, `${url.pathname}${url.search}${url.hash}`);
  return 'deferred';
}
