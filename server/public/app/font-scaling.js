import { captureTranscriptAnchor, restoreTranscriptAnchor } from './transcript-viewport-anchor.mjs';

const FONT_SCALE_STORAGE_KEY = 'copilot_font_scale';
const FONT_SCALE_MIN = 0.5;
const FONT_SCALE_MAX = 1.5;
const FONT_SCALE_DEFAULT = 1;
const FONT_SCALE_WHEEL_STEP_MIN = 0.01;
const FONT_SCALE_WHEEL_STEP_MAX = 0.2;
const FONT_SCALE_PILL_VISIBLE_MS = 900;

let fontScaleValue = FONT_SCALE_DEFAULT;
let fontScaleIndicatorTimer = null;
let fontScalePinchState = {
  active: false,
  startDistance: 0,
  startScale: FONT_SCALE_DEFAULT,
};

function readLocalStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function clampFontScale(value) {
  if (value == null) return FONT_SCALE_DEFAULT;
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === '') return FONT_SCALE_DEFAULT;
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return FONT_SCALE_DEFAULT;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, numeric));
}

function readStoredFontScale() {
  return clampFontScale(readLocalStorage(FONT_SCALE_STORAGE_KEY));
}

function normalizeFontScaleSelectValue(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 3) return clampFontScale(numeric / 100);
  return clampFontScale(numeric);
}

export function syncFontScaleSelect() {
  const select = document.getElementById('font-scale-select');
  if (!select) return;
  const currentPercent = Math.round(clampFontScale(fontScaleValue) * 100);
  const candidate = String(currentPercent);
  if (Array.from(select.options).some((option) => option.value === candidate)) {
    select.value = candidate;
    return;
  }
  const dynamicValue = String(currentPercent);
  const dynamicLabel = `${currentPercent}%`;
  let dynamicOption = select.querySelector('option[data-dynamic-font-scale="1"]');
  if (!dynamicOption) {
    dynamicOption = document.createElement('option');
    dynamicOption.setAttribute('data-dynamic-font-scale', '1');
    select.appendChild(dynamicOption);
  }
  dynamicOption.value = dynamicValue;
  dynamicOption.textContent = dynamicLabel;
  select.value = dynamicValue;
}

export function setFontScale(nextScale, { persist = true, preserveMessageAnchor = true } = {}) {
  const normalized = clampFontScale(nextScale);
  if (Math.abs(normalized - fontScaleValue) <= 0.0001) {
    if (persist) writeLocalStorage(FONT_SCALE_STORAGE_KEY, String(normalized));
    syncFontScaleSelect();
    return normalized;
  }
  const anchor = preserveMessageAnchor ? captureTranscriptAnchor(document.getElementById('messages')) : null;
  fontScaleValue = normalized;
  document.documentElement.style.setProperty('--font-scale', normalized.toFixed(4));
  document.documentElement.style.setProperty('--font-scale-percent', `${Math.round(normalized * 100)}%`);
  if (persist) writeLocalStorage(FONT_SCALE_STORAGE_KEY, String(normalized));
  syncFontScaleSelect();
  if (anchor) {
    requestAnimationFrame(() => {
      restoreTranscriptAnchor(document.getElementById('messages'), anchor);
    });
  }
  return normalized;
}

function showFontScaleIndicator(scaleValue) {
  const indicator = document.getElementById('font-scale-indicator');
  if (!indicator) return;
  const normalized = clampFontScale(scaleValue);
  indicator.textContent = `${Math.round(normalized * 100)}%`;
  indicator.hidden = false;
  indicator.classList.add('visible');
  if (fontScaleIndicatorTimer) clearTimeout(fontScaleIndicatorTimer);
  fontScaleIndicatorTimer = setTimeout(() => {
    indicator.classList.remove('visible');
    window.setTimeout(() => {
      if (!indicator.classList.contains('visible')) indicator.hidden = true;
    }, 180);
    fontScaleIndicatorTimer = null;
  }, FONT_SCALE_PILL_VISIBLE_MS);
}

function isImageZoomGestureTarget(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest('#file-preview-body.image-zoom-mode');
}

function pinchDistance(touchA, touchB) {
  return Math.hypot(touchA.clientX - touchB.clientX, touchA.clientY - touchB.clientY);
}

function normalizeWheelDeltaPixels(event) {
  const deltaY = Number(event?.deltaY);
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  const deltaMode = Number(event?.deltaMode || 0);
  if (deltaMode === 1) return deltaY * 16; // lines -> approx pixels
  if (deltaMode === 2) return deltaY * (window.innerHeight || 800); // pages -> pixels
  return deltaY; // already pixels
}

function onGlobalFontScaleWheel(event) {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (isImageZoomGestureTarget(event.target)) return;
  event.preventDefault();
  const deltaPixels = normalizeWheelDeltaPixels(event);
  if (!Number.isFinite(deltaPixels) || deltaPixels === 0) return;
  const direction = deltaPixels < 0 ? 1 : -1;
  // Slow wheel gestures move by 1%, while faster spins accelerate.
  const magnitude = Math.min(
    FONT_SCALE_WHEEL_STEP_MAX,
    Math.max(FONT_SCALE_WHEEL_STEP_MIN, Math.abs(deltaPixels) / 10_000),
  );
  const nextScale = setFontScale(fontScaleValue + (direction * magnitude), { persist: true, preserveMessageAnchor: true });
  showFontScaleIndicator(nextScale);
}

function onGlobalFontScaleTouchStart(event) {
  if (event.touches.length !== 2) return;
  if (isImageZoomGestureTarget(event.target)) {
    fontScalePinchState.active = false;
    return;
  }
  const t0 = event.touches[0];
  const t1 = event.touches[1];
  fontScalePinchState = {
    active: true,
    startDistance: pinchDistance(t0, t1),
    startScale: fontScaleValue,
  };
  event.preventDefault();
}

function onGlobalFontScaleTouchMove(event) {
  if (!fontScalePinchState.active) return;
  if (event.touches.length !== 2) {
    fontScalePinchState.active = false;
    return;
  }
  if (isImageZoomGestureTarget(event.target)) {
    fontScalePinchState.active = false;
    return;
  }
  event.preventDefault();
  const t0 = event.touches[0];
  const t1 = event.touches[1];
  const distance = pinchDistance(t0, t1);
  if (!fontScalePinchState.startDistance || !Number.isFinite(distance) || distance <= 0) return;
  const ratio = distance / fontScalePinchState.startDistance;
  const nextScale = fontScalePinchState.startScale * ratio;
  const appliedScale = setFontScale(nextScale, { persist: true, preserveMessageAnchor: true });
  showFontScaleIndicator(appliedScale);
}

function onGlobalFontScaleTouchEnd(event) {
  if (event.touches.length < 2) {
    fontScalePinchState.active = false;
  }
}

function populateFontScaleSelect() {
  const select = document.getElementById('font-scale-select');
  if (!select || select.dataset.populated === '1') return;
  select.dataset.populated = '1';
  for (let value = 50; value <= 150; value += 10) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = `${value}%`;
    select.appendChild(option);
  }
}

export function initFontScaling() {
  populateFontScaleSelect();
  const inlineScale = Number(document.documentElement.style.getPropertyValue('--font-scale'));
  const initialScale = Number.isFinite(inlineScale) ? clampFontScale(inlineScale) : readStoredFontScale();
  setFontScale(initialScale, { persist: false, preserveMessageAnchor: false });
  if (!window.__fontScaleGestureHandlersBound) {
    window.__fontScaleGestureHandlersBound = true;
    window.addEventListener('wheel', onGlobalFontScaleWheel, { passive: false, capture: true });
    window.addEventListener('touchstart', onGlobalFontScaleTouchStart, { passive: false, capture: true });
    window.addEventListener('touchmove', onGlobalFontScaleTouchMove, { passive: false, capture: true });
    window.addEventListener('touchend', onGlobalFontScaleTouchEnd, { passive: true, capture: true });
    window.addEventListener('touchcancel', onGlobalFontScaleTouchEnd, { passive: true, capture: true });
  }
}

export function updateFontScaleFromSelect(rawValue) {
  const next = normalizeFontScaleSelectValue(rawValue);
  if (next == null) {
    syncFontScaleSelect();
    return;
  }
  setFontScale(next, { persist: true, preserveMessageAnchor: true });
}
