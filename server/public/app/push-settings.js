import { DEVICE_ID, IS_SHARED_VIEW, showTransientRelayNotice } from './store.js';
import { apiFetch } from './api-client.js';

// Per-device Web Push settings, following the shape of settings-modal.js:
// module state + sync functions driven by the DOM ids in index.html.

const PUSH_EVENT_CONTROL_IDS = {
  question: 'push-event-question-toggle',
  turnComplete: 'push-event-turn-complete-toggle',
  turnFailed: 'push-event-turn-failed-toggle',
  board: 'push-event-board-toggle',
  cliOffline: 'push-event-cli-offline-toggle',
};

let pushUpdateInFlight = false;
let pushDevices = [];
let currentDeviceRow = null;
let localSubscriptionEndpoint = '';

function pushSupportStatus() {
  if (!window.isSecureContext) {
    return {
      supported: false,
      reason: 'Push requires a secure context. Open the app over HTTPS (or localhost) to enable notifications on this device.',
    };
  }
  if (!('serviceWorker' in navigator)) {
    return { supported: false, reason: 'This browser does not support service workers, which push notifications require.' };
  }
  if (!('PushManager' in window) || !('Notification' in window)) {
    return { supported: false, reason: 'This browser does not support Web Push notifications.' };
  }
  return { supported: true, reason: '' };
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function defaultDeviceLabel() {
  const ua = String(navigator.userAgent || '');
  const platform = /Android/i.test(ua)
    ? 'Android'
    : (/iPhone|iPad/i.test(ua) ? 'iOS' : (/Windows/i.test(ua) ? 'Windows' : (/Mac/i.test(ua) ? 'macOS' : (/Linux/i.test(ua) ? 'Linux' : 'Device'))));
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : (/Chrome\//i.test(ua) ? 'Chrome' : (/Firefox\//i.test(ua) ? 'Firefox' : (/Safari\//i.test(ua) ? 'Safari' : 'Browser')));
  return `${platform} ${browser}`;
}

async function getPushRegistration() {
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration) return registration;
  return navigator.serviceWorker.ready;
}

function collectPreferencesFromControls({ enabled } = {}) {
  const previewSelect = document.getElementById('push-preview-select');
  const previewChars = Number(document.getElementById('push-preview-chars-input')?.value);
  const events = {};
  for (const [type, id] of Object.entries(PUSH_EVENT_CONTROL_IDS)) {
    const toggle = document.getElementById(id);
    events[type] = toggle instanceof HTMLInputElement ? toggle.checked : true;
  }
  return {
    enabled: enabled !== undefined ? enabled : currentDeviceRow?.preferences?.enabled !== false,
    events,
    content: {
      includeTitle: document.getElementById('push-include-title-toggle')?.checked === true,
      preview: String(previewSelect?.value || 'none'),
      previewChars: Number.isFinite(previewChars) ? previewChars : 80,
    },
  };
}

function setPushStatus(text, state = '') {
  const status = document.getElementById('push-settings-status');
  if (!status) return;
  status.textContent = text;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

function setPushControlsDisabled(disabled) {
  const ids = [
    'push-include-title-toggle',
    'push-preview-select',
    'push-preview-chars-input',
    ...Object.values(PUSH_EVENT_CONTROL_IDS),
  ];
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element) element.disabled = disabled;
  }
  const charsInput = document.getElementById('push-preview-chars-input');
  if (charsInput && !disabled) {
    charsInput.disabled = String(document.getElementById('push-preview-select')?.value || 'none') !== 'truncated';
  }
}

function formatDeviceTimestamp(value) {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString();
}

function renderDeviceList() {
  const host = document.getElementById('push-device-list');
  if (!host) return;
  host.textContent = '';
  if (!pushDevices.length) {
    const empty = document.createElement('div');
    empty.className = 'settings-help';
    empty.textContent = 'No devices are subscribed yet.';
    host.appendChild(empty);
    return;
  }
  for (const device of pushDevices) {
    const isCurrent = device.deviceId === DEVICE_ID
      || (localSubscriptionEndpoint && device.endpoint === localSubscriptionEndpoint);
    const row = document.createElement('div');
    row.className = 'push-device-row settings-row';
    row.style.gap = '8px';

    const info = document.createElement('div');
    info.style.flex = '1';
    info.style.minWidth = '0';
    const name = document.createElement('div');
    name.textContent = `${device.label || 'Unnamed device'}${isCurrent ? ' (this device)' : ''}`;
    if (!device.preferences?.enabled) name.textContent += ' — disabled';
    const meta = document.createElement('div');
    meta.className = 'settings-help';
    meta.style.marginTop = '2px';
    meta.textContent = `Last delivery: ${formatDeviceTimestamp(device.lastSuccessAt)}${device.lastError ? ` · last error: ${device.lastError}` : ''}`;
    info.appendChild(name);
    info.appendChild(meta);

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'summary-btn';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', () => {
      void renamePushDevice(device.id, device.label || '');
    });

    const revokeBtn = document.createElement('button');
    revokeBtn.type = 'button';
    revokeBtn.className = 'summary-btn';
    revokeBtn.textContent = 'Revoke';
    revokeBtn.addEventListener('click', () => {
      void revokePushDevice(device.id, isCurrent);
    });

    row.appendChild(info);
    row.appendChild(renameBtn);
    row.appendChild(revokeBtn);
    host.appendChild(row);
  }
}

function syncPreferenceControls(preferences) {
  const prefs = preferences || {};
  const includeTitle = document.getElementById('push-include-title-toggle');
  if (includeTitle instanceof HTMLInputElement) includeTitle.checked = prefs.content?.includeTitle === true;
  const previewSelect = document.getElementById('push-preview-select');
  if (previewSelect) previewSelect.value = ['none', 'truncated', 'full'].includes(prefs.content?.preview) ? prefs.content.preview : 'none';
  const charsInput = document.getElementById('push-preview-chars-input');
  if (charsInput instanceof HTMLInputElement) {
    charsInput.value = String(Number(prefs.content?.previewChars) || 80);
    charsInput.disabled = previewSelect?.value !== 'truncated';
  }
  for (const [type, id] of Object.entries(PUSH_EVENT_CONTROL_IDS)) {
    const toggle = document.getElementById(id);
    if (toggle instanceof HTMLInputElement) {
      const fallback = type !== 'cliOffline';
      toggle.checked = typeof prefs.events?.[type] === 'boolean' ? prefs.events[type] : fallback;
    }
  }
}

async function loadLocalSubscriptionEndpoint() {
  localSubscriptionEndpoint = '';
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    localSubscriptionEndpoint = String(subscription?.endpoint || '');
  } catch {
    localSubscriptionEndpoint = '';
  }
}

function resolveCurrentDeviceRow() {
  currentDeviceRow = pushDevices.find((device) => device.deviceId === DEVICE_ID)
    || (localSubscriptionEndpoint
      ? pushDevices.find((device) => device.endpoint === localSubscriptionEndpoint)
      : null)
    || null;
}

export async function refreshPushSettingsSection() {
  const section = document.getElementById('push-settings-section');
  if (!section) return;
  if (IS_SHARED_VIEW) {
    section.hidden = true;
    return;
  }
  const enableToggle = document.getElementById('push-enabled-toggle');
  const support = pushSupportStatus();
  if (!support.supported) {
    if (enableToggle instanceof HTMLInputElement) {
      enableToggle.checked = false;
      enableToggle.disabled = true;
    }
    setPushControlsDisabled(true);
    setPushStatus(support.reason, 'unconfigured');
    renderDeviceList();
    return;
  }

  if (Notification.permission === 'denied') {
    if (enableToggle instanceof HTMLInputElement) {
      enableToggle.checked = false;
      enableToggle.disabled = true;
    }
    setPushControlsDisabled(true);
    setPushStatus('Notifications are blocked for this site. Re-enable them in the browser\'s site settings, then reopen this dialog.', 'error');
  }

  await loadLocalSubscriptionEndpoint();
  const result = await apiFetch('/api/push/devices');
  pushDevices = Array.isArray(result?.devices) ? result.devices : [];
  resolveCurrentDeviceRow();
  renderDeviceList();

  if (Notification.permission === 'denied') return;

  const enabledHere = !!currentDeviceRow && currentDeviceRow.preferences?.enabled !== false
    && !!localSubscriptionEndpoint && currentDeviceRow.endpoint === localSubscriptionEndpoint;
  if (enableToggle instanceof HTMLInputElement) {
    enableToggle.checked = enabledHere;
    enableToggle.disabled = pushUpdateInFlight;
  }
  syncPreferenceControls(currentDeviceRow?.preferences);
  setPushControlsDisabled(!enabledHere || pushUpdateInFlight);
  setPushStatus(
    enabledHere
      ? 'Push notifications are enabled on this device. They are only sent while no device has the app open.'
      : 'Enable to get notified about questions and finished turns while the app is in the background. Your browser will ask for notification permission.',
    enabledHere ? 'active' : 'unconfigured',
  );
}

async function subscribeThisDevice() {
  // The permission prompt fires only from this explicit user action; denial is
  // permanent, so it must never run on page load.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Notification permission was denied. Re-enable it in the browser\'s site settings.'
      : 'Notification permission was not granted.');
  }
  const keyResult = await apiFetch('/api/push/vapid-public-key');
  const publicKey = String(keyResult?.publicKey || '').trim();
  if (!publicKey) throw new Error('The relay did not provide a push key.');
  const registration = await getPushRegistration();
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  const payload = subscription.toJSON ? subscription.toJSON() : subscription;
  localSubscriptionEndpoint = String(payload?.endpoint || '');
  const preferences = currentDeviceRow?.preferences
    ? { ...currentDeviceRow.preferences, enabled: true }
    : collectPreferencesFromControls({ enabled: true });
  const result = await apiFetch('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      deviceId: DEVICE_ID,
      label: currentDeviceRow?.label || defaultDeviceLabel(),
      subscription: payload,
      preferences,
    }),
  });
  if (!result?.device) throw new Error('Failed to register the subscription with the relay.');
}

export async function togglePushOnThisDevice(enabled) {
  if (pushUpdateInFlight) {
    void refreshPushSettingsSection();
    return;
  }
  pushUpdateInFlight = true;
  const enableToggle = document.getElementById('push-enabled-toggle');
  if (enableToggle) enableToggle.disabled = true;
  try {
    if (enabled) {
      await subscribeThisDevice();
      showTransientRelayNotice('Push notifications enabled on this device.');
    } else if (currentDeviceRow) {
      // Keep the subscription row so re-enabling is instant; just stop sending.
      await apiFetch(`/api/push/devices/${encodeURIComponent(currentDeviceRow.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ preferences: { ...currentDeviceRow.preferences, enabled: false } }),
      });
      showTransientRelayNotice('Push notifications disabled on this device.');
    }
  } catch (error) {
    alert(error?.message || 'Failed to update push notifications.');
  } finally {
    pushUpdateInFlight = false;
    void refreshPushSettingsSection();
  }
}

export async function updatePushPreferencesFromControls() {
  if (!currentDeviceRow || pushUpdateInFlight) return;
  pushUpdateInFlight = true;
  try {
    const preferences = collectPreferencesFromControls();
    const result = await apiFetch(`/api/push/devices/${encodeURIComponent(currentDeviceRow.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ preferences }),
    });
    if (result?.device) currentDeviceRow = result.device;
  } catch (error) {
    alert(error?.message || 'Failed to save push preferences.');
  } finally {
    pushUpdateInFlight = false;
    void refreshPushSettingsSection();
  }
}

async function renamePushDevice(id, currentLabel) {
  const label = prompt('Device name', currentLabel || '');
  if (label === null) return;
  const result = await apiFetch(`/api/push/devices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ label: String(label).trim() }),
  });
  if (!result?.device) alert('Failed to rename the device.');
  void refreshPushSettingsSection();
}

async function revokePushDevice(id, isCurrent) {
  if (!confirm('Revoke push notifications for this device?')) return;
  const result = await apiFetch(`/api/push/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!result?.ok) {
    alert('Failed to revoke the device.');
  } else if (isCurrent) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager?.getSubscription();
      await subscription?.unsubscribe();
    } catch {}
    localSubscriptionEndpoint = '';
    showTransientRelayNotice('Push notifications revoked for this device.');
  }
  void refreshPushSettingsSection();
}
