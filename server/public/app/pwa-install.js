import { BASE, IS_SHARED_VIEW, showTransientRelayNotice } from './store.js';
import { loadPwaAppNameSetting, updatePwaAppNameSetting } from './api-client.js';

const THEME_COLOR_BASE = '#0d1117';
const THEME_COLOR_IMMERSIVE = '#161b22';
// Legacy per-browser storage of the app name; kept only so adoptLegacyPwaAppName
// can move an existing value to the server once. The name itself now lives in
// app_settings and is served by /manifest.webmanifest.
const PWA_APP_NAME_STORAGE_KEY = 'copilot_pwa_app_name';
const INSTALLED_DISPLAY_MODE_QUERIES = ['(display-mode: standalone)', '(display-mode: fullscreen)'];

let deferredInstallPrompt = null;
let pendingInstalledFullscreenGesture = false;
let pwaAppName = '';
// Monotonic sequence so overlapping loads/saves resolve latest-wins: a stale
// background GET must never repaint over a just-saved name, and a second edit
// must never be dropped in favor of an older in-flight save.
let pwaAppNameRequestSeq = 0;

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

// The app name is stored on the relay and baked into /manifest.webmanifest by
// the server, so every manifest fetch — including Android's out-of-page WebAPK
// update checks — sees the same name. The client only edits the setting.

function paintPwaAppNameInput() {
  const input = document.getElementById('pwa-app-name-input');
  if (!input) return;
  // Don't clobber typing when a background refresh lands mid-edit.
  if (document.activeElement === input) return;
  input.value = pwaAppName;
}

export function syncPwaAppNameInput() {
  paintPwaAppNameInput();
  const seq = ++pwaAppNameRequestSeq;
  void loadPwaAppNameSetting().then((result) => {
    if (seq !== pwaAppNameRequestSeq) return; // superseded by a newer load/save
    if (!result || typeof result.appName !== 'string') return;
    pwaAppName = result.appName;
    paintPwaAppNameInput();
  });
}

export async function updatePwaAppName(rawValue) {
  const seq = ++pwaAppNameRequestSeq;
  const result = await updatePwaAppNameSetting(rawValue);
  if (!result || typeof result.appName !== 'string') {
    alert('Failed to update the install app name.');
    if (seq === pwaAppNameRequestSeq) paintPwaAppNameInput();
    return;
  }
  if (seq !== pwaAppNameRequestSeq) return; // a newer edit owns the UI now
  pwaAppName = result.appName;
  showTransientRelayNotice(result.appName
    ? `Install app name updated to "${result.appName}".`
    : 'Install app name reset to default.');
  paintPwaAppNameInput();
}

/**
 * One-time move of a legacy per-browser name into the relay's settings. The
 * key is removed whether the value is adopted or the server already has a
 * name — either way it is dead weight; only a network/auth failure keeps it
 * so the next boot can retry.
 */
export async function adoptLegacyPwaAppName() {
  if (IS_SHARED_VIEW) return;
  let stored = '';
  try {
    stored = String(localStorage.getItem(PWA_APP_NAME_STORAGE_KEY) || '').trim();
  } catch {
    return;
  }
  if (!stored) return;
  // A legacy over-long value would 400 forever; best-effort truncate instead.
  if (stored.length > 60) stored = stored.slice(0, 60).trim();
  const seq = ++pwaAppNameRequestSeq;
  const current = await loadPwaAppNameSetting();
  if (!current || typeof current.appName !== 'string') return; // offline/unauthed: retry next boot
  let adoptedName = current.appName;
  if (!current.appName) {
    const adopted = await updatePwaAppNameSetting(stored);
    if (!adopted || typeof adopted.appName !== 'string') return; // POST failed: keep the key
    adoptedName = adopted.appName;
  }
  try { localStorage.removeItem(PWA_APP_NAME_STORAGE_KEY); } catch {}
  if (seq !== pwaAppNameRequestSeq) return; // the user already edited; their state wins
  pwaAppName = adoptedName;
  paintPwaAppNameInput();
}

export function registerPwaShell() {
  if (IS_SHARED_VIEW) return;
  if (!('serviceWorker' in navigator)) return;
  const scopeBase = BASE;
  const scopeRoot = `${scopeBase}/`;
  const pwaVersion = String(window.__COPILOT_PWA_VERSION || '0').trim() || '0';
  return navigator.serviceWorker.register(`${scopeBase}/sw.js?v=${encodeURIComponent(pwaVersion)}`, { scope: scopeRoot, updateViaCache: 'none' }).catch(() => {});
}
