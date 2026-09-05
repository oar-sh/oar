import { getUpdateState, setUpdateState, showTransientRelayNotice } from './store.js';
import {
  applyUpdate,
  cancelUpdate,
  checkForUpdateNow,
  dismissUpdate,
  loadUpdateState,
  setUpdateAutoCheck,
} from './api-client.js';

// The Updates section of Settings → General. Automatic checking is opt-in
// (zero telemetry by default), so the toggle drives real network behavior and
// the copy around it must stay honest. Everything server-provided (versions,
// notes URLs, npm logs) renders via textContent/setAttribute — never markup.

let renderedLogKey = '';
let actionInFlight = false;

function byId(id) {
  return document.getElementById(id);
}

function setHidden(id, hidden) {
  const element = byId(id);
  if (element) element.hidden = !!hidden;
}

export function renderUpdateSection() {
  const state = getUpdateState();
  const check = state?.check || null;
  const install = state?.install || null;
  const checkKilled = state?.checkKilled === true;

  const toggle = byId('update-auto-check-toggle');
  if (toggle) {
    toggle.checked = check?.autoCheckEnabled === true;
    toggle.disabled = checkKilled || actionInFlight;
  }
  const checkBtn = byId('update-check-now-btn');
  if (checkBtn) checkBtn.disabled = checkKilled || actionInFlight;
  setHidden('update-check-killed-help', !checkKilled);

  const lastChecked = byId('update-last-checked');
  if (lastChecked) {
    let text = '';
    if (!checkKilled) {
      text = check?.lastCheckedAt
        ? `Last checked ${new Date(check.lastCheckedAt).toLocaleString()}`
        : 'Never checked.';
      if (check?.schemaUnsupported) {
        text += ' The relay could not read the update feed — try updating manually.';
      }
    }
    lastChecked.textContent = text;
  }

  const showCard = check?.available === true && (!check.dismissed || check.critical === true);
  setHidden('update-available-card', !showCard);
  if (showCard) {
    const text = byId('update-available-text');
    if (text) {
      text.textContent = `OAR ${check.version} available${check.critical ? ' — critical update' : ''}`;
    }
    const notesLink = byId('update-notes-link');
    if (notesLink) {
      const notesUrl = typeof check.notesUrl === 'string' ? check.notesUrl : '';
      if (notesUrl.startsWith('https://')) {
        notesLink.setAttribute('href', notesUrl);
        notesLink.hidden = false;
      } else {
        notesLink.removeAttribute('href');
        notesLink.hidden = true;
      }
    }
    const applyBtn = byId('update-apply-btn');
    if (applyBtn) {
      applyBtn.hidden = state?.installMethod !== 'npm-global' || install?.active === true;
      applyBtn.disabled = actionInFlight;
    }
    setHidden('update-git-hint', state?.installMethod !== 'git-checkout');
    const dismissBtn = byId('update-dismiss-btn');
    if (dismissBtn) {
      dismissBtn.hidden = check.critical === true;
      dismissBtn.disabled = actionInFlight;
    }
  }

  const installVisible = !!install && install.state !== 'idle';
  setHidden('update-install-status', !installVisible);
  setHidden('update-install-log', !installVisible || !install?.log);
  const cancelBtn = byId('update-cancel-btn');
  if (cancelBtn) {
    cancelBtn.hidden = install?.state !== 'running';
    cancelBtn.disabled = actionInFlight;
  }
  if (installVisible) {
    const status = byId('update-install-status');
    if (status) {
      status.dataset.state = install.state;
      status.textContent = install.state === 'running'
        ? `Updating to ${install.targetVersion}…`
        : install.state === 'success'
          ? 'npm finished — the relay restarts when the queue is idle.'
          : `Update failed: ${install.error || 'unknown error'}`;
    }
    const logPre = byId('update-install-log-pre');
    const logKey = `${install.startedAt || ''}|${install.logSeq || 0}`;
    if (logPre && logKey !== renderedLogKey) {
      renderedLogKey = logKey;
      logPre.textContent = install.log || '';
      logPre.scrollTop = logPre.scrollHeight;
    }
  }

  const outcome = install?.lastOutcome || null;
  setHidden('update-outcome', !outcome);
  if (outcome) {
    const text = byId('update-outcome-text');
    if (text) {
      text.textContent = outcome.status === 'success'
        ? `Updated to ${outcome.version}.`
        : `Update to ${outcome.attemptedVersion || outcome.version || 'a new version'} did not apply.`;
    }
    const outcomeLog = byId('update-outcome-log');
    if (outcomeLog) {
      const tail = outcome.status === 'failure' ? String(outcome.logTail || '') : '';
      outcomeLog.textContent = tail;
      outcomeLog.hidden = !tail;
    }
    const dismissBtn = byId('update-outcome-dismiss-btn');
    if (dismissBtn) dismissBtn.disabled = actionInFlight;
  }
}

export async function refreshUpdateSection() {
  const payload = await loadUpdateState();
  if (payload?.update) setUpdateState(payload.update);
  renderUpdateSection();
  return payload;
}

async function runUpdateAction(request, failureMessage) {
  if (actionInFlight) return;
  actionInFlight = true;
  renderUpdateSection();
  try {
    const payload = await request();
    if (!payload) {
      showTransientRelayNotice(failureMessage);
      return;
    }
    if (payload.update) setUpdateState(payload.update);
  } finally {
    actionInFlight = false;
    renderUpdateSection();
  }
}

export async function updateAutoCheckSetting(enabled) {
  // On failure the final render snaps the checkbox back to the stored state.
  await runUpdateAction(() => setUpdateAutoCheck(enabled === true), 'Failed to save the update-check setting.');
}

export async function checkForUpdatesNow() {
  // The service swallows network failures by design (the auto-poller must be
  // silent), so an explicit click needs its own feedback: an unchanged
  // check timestamp means the manifest was never reached.
  const before = getUpdateState()?.check?.lastCheckedAt || null;
  await runUpdateAction(() => checkForUpdateNow(), 'Update check failed.');
  const after = getUpdateState()?.check?.lastCheckedAt || null;
  if (after === before) {
    showTransientRelayNotice('Update check failed — the update server could not be reached.');
  }
}

export async function cancelRunningUpdate() {
  await runUpdateAction(() => cancelUpdate(), 'Failed to cancel the update.');
}

export async function applyAvailableUpdate() {
  const version = getUpdateState()?.check?.version;
  if (!version) return;
  await runUpdateAction(() => applyUpdate(version), 'Failed to start the update.');
}

export async function dismissAvailableUpdate() {
  const version = getUpdateState()?.check?.version;
  if (!version) return;
  await runUpdateAction(() => dismissUpdate({ version }), 'Failed to dismiss the update.');
}

export async function dismissUpdateOutcome() {
  await runUpdateAction(() => dismissUpdate({ outcome: true }), 'Failed to dismiss.');
}
