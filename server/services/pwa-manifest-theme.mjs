// The installed app's icon and launch screen follow the Theme setting: the
// page links the manifest with `?theme=light` in Day mode, and the manifest
// then names the light icon set and a white background.

export const PWA_LIGHT_BACKGROUND = '#ffffff';

export function normalizePwaTheme(value) {
  return String(value || '').trim().toLowerCase() === 'light' ? 'light' : 'dark';
}

function lightIconSrc(src) {
  return String(src || '').replace(/(^|\/)app-icon(?=[-.])/, '$1app-icon-light');
}

/**
 * The manifest for one theme. Dark is the template as it stands; light swaps
 * every `app-icon*` source for its `app-icon-light*` twin and whitens the
 * launch background and the toolbar colour.
 */
export function applyPwaManifestTheme(manifest, theme) {
  if (normalizePwaTheme(theme) !== 'light') return manifest;
  return {
    ...manifest,
    background_color: PWA_LIGHT_BACKGROUND,
    theme_color: PWA_LIGHT_BACKGROUND,
    icons: Array.isArray(manifest?.icons)
      ? manifest.icons.map((icon) => ({ ...icon, src: lightIconSrc(icon?.src) }))
      : manifest?.icons,
  };
}
