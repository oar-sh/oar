import { BASE, IS_SHARED_VIEW, showTransientRelayNotice } from './store.js';

const THEME_COLOR_BASE = '#0d1117';
const THEME_COLOR_IMMERSIVE = '#161b22';
const PWA_APP_NAME_STORAGE_KEY = 'copilot_pwa_app_name';
const PWA_APP_NAME_DEFAULT = 'OAR';
const PWA_APP_NAME_MAX_LENGTH = 60;
const INSTALLED_DISPLAY_MODE_QUERIES = ['(display-mode: standalone)', '(display-mode: fullscreen)'];

let deferredInstallPrompt = null;
let pendingInstalledFullscreenGesture = false;
let manifestTemplateCache = null;
let customManifestUrl = null;

function matchesDisplayMode(query) {
  try {
    return !!window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

function isInstalledAppMode() {
  const standalone = matchesDisplayMode('(display-mode: standalone)');
  const minimalUi = matchesDisplayMode('(display-mode: minimal-ui)');
  const launchedFromAndroidApp = String(document.referrer || '').startsWith('android-app://');
  return (
    window.navigator.standalone === true
    || launchedFromAndroidApp
    || standalone
    || minimalUi
  );
}

function isDisplayModeFullscreen() {
  return matchesDisplayMode('(display-mode: fullscreen)');
}

function isBrowserFullscreenMode() {
  return !!document.fullscreenElement;
}

function shouldUseImmersiveTopLayout() {
  return isDisplayModeFullscreen() || isBrowserFullscreenMode();
}

function syncThemeColor(immersive) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  meta.setAttribute('content', immersive ? THEME_COLOR_IMMERSIVE : THEME_COLOR_BASE);
}

export function syncInstalledAppUiState() {
  const installed = isInstalledAppMode();
  const immersive = shouldUseImmersiveTopLayout();
  document.body.classList.toggle('installed-app', installed);
  document.body.classList.toggle('immersive-top', immersive);
  syncThemeColor(immersive);
}

function canToggleFullscreen() {
  return !!document.documentElement.requestFullscreen || !!document.fullscreenElement;
}

async function ensureInstalledAppFullscreen(options = {}) {
  syncInstalledAppUiState();
  if (!isInstalledAppMode()) {
    return false;
  }
  if (isDisplayModeFullscreen() || document.fullscreenElement) {
    return true;
  }
  if (!canToggleFullscreen()) return false;
  if (!options.userGesture) return false;
  try {
    await document.documentElement.requestFullscreen();
    return true;
  } catch {
    return false;
  } finally {
    updateInstallButton();
    updateFullscreenButton();
  }
}

function shouldQueueInstalledFullscreen() {
  return isInstalledAppMode()
    && window.matchMedia('(max-width: 680px)').matches
    && canToggleFullscreen()
    && !document.fullscreenElement;
}

function queueInstalledFullscreenGesture() {
  pendingInstalledFullscreenGesture = shouldQueueInstalledFullscreen();
}

function consumeInstalledFullscreenGesture() {
  if (!pendingInstalledFullscreenGesture || !shouldQueueInstalledFullscreen()) return;
  pendingInstalledFullscreenGesture = false;
  ensureInstalledAppFullscreen({ userGesture: true }).catch(() => {
    pendingInstalledFullscreenGesture = true;
  });
}

function initInstalledFullscreenGestureBridge() {
  if (window.__installedFullscreenGestureBridgeBound) return;
  window.__installedFullscreenGestureBridgeBound = true;
  const consume = () => consumeInstalledFullscreenGesture();
  document.addEventListener('pointerdown', consume, true);
  document.addEventListener('keydown', consume, true);
  window.addEventListener('pageshow', () => {
    queueInstalledFullscreenGesture();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      queueInstalledFullscreenGesture();
    }
  });
}

function getInstallHelpMessage() {
  const ua = String(navigator.userAgent || '').toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) {
    return 'To install on iPhone/iPad: open this page in Safari, tap Share, then choose "Add to Home Screen".';
  }
  if (/android/.test(ua)) {
    return 'To install on Android: open the browser menu (⋮) and choose "Install app" or "Add to Home screen". If Chrome says the app is already installed, open it from your launcher or uninstall the old copy first.';
  }
  return 'To install: open your browser menu and choose "Install app" or "Add to Home screen".';
}

export function updateInstallButton() {
  const btn = document.getElementById('install-btn');
  if (!btn) return;
  if (IS_SHARED_VIEW) {
    btn.disabled = true;
    btn.hidden = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = 'PWA install is unavailable for shared conversations';
    return;
  }
  syncInstalledAppUiState();

  if (isInstalledAppMode()) {
    btn.style.display = 'none';
    return;
  }

  const title = deferredInstallPrompt ? 'Install app to home screen' : 'Show install instructions';
  btn.textContent = '⬇';
  btn.style.display = 'inline-flex';
  btn.title = title;
}

export async function promptInstallApp() {
  if (IS_SHARED_VIEW) return;
  if (!deferredInstallPrompt) {
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  if (deferredInstallPrompt) {
    try {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice.catch(() => null);
      if (choice?.outcome === 'accepted') {
        showTransientRelayNotice('Install accepted. The app will appear on your home screen.');
      }
    } finally {
      deferredInstallPrompt = null;
      updateInstallButton();
    }
    return;
  }

  alert(getInstallHelpMessage());
}

export function initInstallButton() {
  if (IS_SHARED_VIEW) {
    updateInstallButton();
    return;
  }
  if (window.__installButtonBound) {
    updateInstallButton();
    initInstalledFullscreenGestureBridge();
    queueInstalledFullscreenGesture();
    ensureInstalledAppFullscreen().catch(() => {});
    return;
  }
  window.__installButtonBound = true;
  initInstalledFullscreenGestureBridge();

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    updateInstallButton();
    updateFullscreenButton();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    updateInstallButton();
    updateFullscreenButton();
    queueInstalledFullscreenGesture();
    ensureInstalledAppFullscreen().catch(() => {});
    showTransientRelayNotice('App installed.');
  });

  window.addEventListener('resize', () => {
    updateInstallButton();
    updateFullscreenButton();
  }, { passive: true });

  for (const query of INSTALLED_DISPLAY_MODE_QUERIES) {
    const media = window.matchMedia(query);
    if (media && typeof media.addEventListener === 'function') {
      media.addEventListener('change', () => {
        updateInstallButton();
        updateFullscreenButton();
        queueInstalledFullscreenGesture();
        ensureInstalledAppFullscreen().catch(() => {});
      });
    }
  }

  updateInstallButton();
  updateFullscreenButton();
  queueInstalledFullscreenGesture();
  ensureInstalledAppFullscreen().catch(() => {});
}

export async function toggleFullscreen() {
  if (isInstalledAppMode()) {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      ensureInstalledAppFullscreen({ userGesture: true }).catch(() => {});
    }
    return;
  }
  if (!canToggleFullscreen()) return;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch {
  } finally {
    updateInstallButton();
    updateFullscreenButton();
  }
}

export function updateFullscreenButton() {
  const btn = document.getElementById('fullscreen-btn');
  if (!btn) return;
  syncInstalledAppUiState();
  if (isInstalledAppMode() || isDisplayModeFullscreen()) {
    btn.style.display = 'none';
    return;
  }

  const mobile = window.matchMedia('(max-width: 680px)').matches;
  if (!mobile) {
    btn.style.display = 'none';
    return;
  }

  const full = !!document.fullscreenElement;
  const supported = canToggleFullscreen();
  btn.style.display = 'inline-flex';
  btn.disabled = !supported;

  if (full) {
    btn.textContent = '⤢';
    btn.title = 'Exit fullscreen';
  } else {
    btn.textContent = '⛶';
    btn.title = isInstalledAppMode()
      ? (supported ? 'Enter fullscreen (recommended for installed app)' : 'Fullscreen not supported on this browser')
      : (supported ? 'Enter fullscreen' : 'Fullscreen not supported on this browser');
  }
}

export function initFullscreenButton() {
  const syncFullscreenUi = () => {
    updateInstallButton();
    updateFullscreenButton();
  };
  document.addEventListener('fullscreenchange', syncFullscreenUi);
  window.addEventListener('resize', syncFullscreenUi);
  for (const query of INSTALLED_DISPLAY_MODE_QUERIES) {
    const media = window.matchMedia(query);
    if (media && typeof media.addEventListener === 'function') {
      media.addEventListener('change', syncFullscreenUi);
    }
  }
  updateFullscreenButton();
}

function normalizePwaAppName(rawValue, { allowEmpty = true } = {}) {
  const normalized = String(rawValue || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return allowEmpty
      ? { value: '', error: null }
      : { value: '', error: 'App name cannot be empty.' };
  }
  if (normalized.length > PWA_APP_NAME_MAX_LENGTH) {
    return { value: '', error: `App name must be ${PWA_APP_NAME_MAX_LENGTH} characters or fewer.` };
  }
  return { value: normalized, error: null };
}

function derivePwaShortName(name) {
  const text = String(name || '').trim();
  if (!text) return 'Copilot';
  const firstWord = text.split(/\s+/)[0] || text;
  if (firstWord.length <= 12) return firstWord;
  return text.slice(0, 12).trim() || 'Copilot';
}

function resolveManifestUrlValue(rawValue, baseHref) {
  const value = String(rawValue || '').trim();
  if (!value || value.startsWith('data:') || value.startsWith('blob:')) return value;
  try {
    return new URL(value, baseHref).href;
  } catch {
    return value;
  }
}

function normalizeManifestForBlob(manifest, defaultHref) {
  const baseHref = new URL(String(defaultHref || '').trim(), window.location.href).href;
  const next = { ...(manifest || {}) };
  next.id = resolveManifestUrlValue(next.id, baseHref);
  next.start_url = resolveManifestUrlValue(next.start_url, baseHref);
  next.scope = resolveManifestUrlValue(next.scope, baseHref);
  if (Array.isArray(next.icons)) {
    next.icons = next.icons.map((icon) => {
      if (!icon || typeof icon !== 'object') return icon;
      const source = resolveManifestUrlValue(icon.src, baseHref);
      return { ...icon, src: source };
    });
  }
  return next;
}

function readStoredPwaAppName() {
  const { value } = normalizePwaAppName(localStorage.getItem(PWA_APP_NAME_STORAGE_KEY), { allowEmpty: true });
  return value;
}

export function syncPwaAppNameInput() {
  const input = document.getElementById('pwa-app-name-input');
  if (!input) return;
  input.value = readStoredPwaAppName();
}

async function loadManifestTemplate(defaultHref) {
  if (manifestTemplateCache) return { ...manifestTemplateCache };
  const fallback = {
    name: PWA_APP_NAME_DEFAULT,
    short_name: derivePwaShortName(PWA_APP_NAME_DEFAULT),
    description: 'OAR — Open Agent Relay: drive your local coding agents from any browser.',
    id: './__copilot_remote_pwa__',
    start_url: './',
    scope: './',
    display_override: ['standalone'],
    display: 'standalone',
    background_color: '#161b22',
    theme_color: '#161b22',
    icons: [
      { src: 'app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: 'app-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
  try {
    const response = await fetch(defaultHref, { cache: 'no-store' });
    const manifest = response.ok ? await response.json() : null;
    if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
      manifestTemplateCache = manifest;
      return { ...manifestTemplateCache };
    }
  } catch (error) {
    console.warn('Failed to load manifest template; using fallback.', error);
  }
  manifestTemplateCache = fallback;
  return { ...manifestTemplateCache };
}

export async function applyPwaManifestFromSettings() {
  const manifestLink = document.querySelector('link[rel="manifest"]');
  if (!manifestLink) return;

  const defaultHref = String(manifestLink.dataset.defaultHref || manifestLink.getAttribute('href') || '').trim();
  if (!defaultHref) return;
  if (!manifestLink.dataset.defaultHref) manifestLink.dataset.defaultHref = defaultHref;

  const customName = readStoredPwaAppName();
  if (!customName) {
    if (customManifestUrl) {
      URL.revokeObjectURL(customManifestUrl);
      customManifestUrl = null;
    }
    manifestLink.setAttribute('href', defaultHref);
    return;
  }

  const baseManifest = await loadManifestTemplate(defaultHref);
  const nextManifest = {
    ...baseManifest,
    name: customName,
    short_name: derivePwaShortName(customName),
  };
  const normalizedManifest = normalizeManifestForBlob(nextManifest, defaultHref);
  const manifestBlob = new Blob([JSON.stringify(normalizedManifest, null, 2)], { type: 'application/manifest+json' });
  const objectUrl = URL.createObjectURL(manifestBlob);
  if (customManifestUrl) URL.revokeObjectURL(customManifestUrl);
  customManifestUrl = objectUrl;
  manifestLink.setAttribute('href', objectUrl);
}

export function updatePwaAppName(rawValue) {
  const normalized = normalizePwaAppName(rawValue, { allowEmpty: true });
  if (normalized.error) {
    alert(normalized.error);
    syncPwaAppNameInput();
    return;
  }
  if (normalized.value) {
    localStorage.setItem(PWA_APP_NAME_STORAGE_KEY, normalized.value);
  } else {
    localStorage.removeItem(PWA_APP_NAME_STORAGE_KEY);
  }
  applyPwaManifestFromSettings()
    .then(() => {
      syncPwaAppNameInput();
      showTransientRelayNotice(normalized.value
        ? `Install app name updated to "${normalized.value}".`
        : 'Install app name reset to default.');
    })
    .catch((error) => {
      alert(error?.message || 'Failed to apply install app name');
      syncPwaAppNameInput();
    });
}

export function registerPwaShell() {
  if (IS_SHARED_VIEW) return;
  if (!('serviceWorker' in navigator)) return;
  const scopeBase = BASE;
  const scopeRoot = `${scopeBase}/`;
  const pwaVersion = String(window.__COPILOT_PWA_VERSION || '0').trim() || '0';
  return navigator.serviceWorker.register(`${scopeBase}/sw.js?v=${encodeURIComponent(pwaVersion)}`, { scope: scopeRoot, updateViaCache: 'none' }).catch(() => {});
}
