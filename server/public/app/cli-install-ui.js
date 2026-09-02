// Provider CLI install / update rows inside Settings → Providers.
//
// The relay runs the vendors' own install one-liners on the host, so a missing
// `grok` (the relay.grok-cli-missing turn failure) is fixable from a phone
// instead of from a shell on the host — the exact thing the relay exists to
// avoid. One renderer serves every provider sub-tab; which buttons a row offers
// is read straight off the payload's `commands` keys and never re-derived here,
// so the frozen server-side descriptor table stays the single source of truth
// for what can be run.
//
// Every visible state comes from the `cli_install_state` socket broadcast (same
// payload as GET /api/cli/status), so an install survives closing the modal,
// switching tabs, or being started from another device. Rendering is therefore
// idempotent: it reads the latest payload and never assumes a local step
// sequence — the log is redrawn from the whole retained buffer whenever the
// monotonic `logSeq` moves, rather than appended chunk by chunk.
//
// Output hygiene: the log is host process output. The service escape-strips it
// before broadcasting; this module writes it with textContent (never innerHTML)
// and escapes everything it does put through innerHTML with escHtml.

import {
  escHtml,
  openSummaryModal,
  closeSummaryModal,
  setSummaryModalLoading,
  showTransientRelayNotice,
} from './store.js';
import { getCliStatus, startCliInstall, cancelCliInstall } from './api-client.js';

// The panels that carry a row. Copilot is detect-only (npm-global on this host),
// so its payload arrives with an empty `commands` and the buttons stay hidden.
export const CLI_PROVIDER_IDS = ['grok', 'claude', 'copilot'];
const INSTALL_STATES = ['idle', 'running', 'success', 'error', 'cancelled'];
const INSTALL_ACTIONS = ['install', 'update', 'migrate'];
const ACTION_BUTTON_LABELS = {
  install: 'Install',
  update: 'Update',
  migrate: 'Switch to native installer',
};
const ACTION_TITLES = {
  install: 'Install',
  update: 'Update',
  migrate: 'Switch to the native installer',
};
const STATE_WORDS = {
  running: 'Running',
  success: 'Finished',
  error: 'Failed',
  cancelled: 'Cancelled',
};
// Anthropic's own prescribed fix for an unwritable npm global folder, quoted
// with its consequence rather than paraphrased.
const MIGRATE_NOTE = 'The npm copy stays where it is; the native build takes PATH precedence.';

const EMPTY_INSTALL = Object.freeze({
  state: 'idle',
  providerId: null,
  action: null,
  command: null,
  log: '',
  logSeq: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
  active: false,
});

let cliState = { providers: {}, install: { ...EMPTY_INSTALL } };
// Redraw key for the log body: `logSeq` alone is not enough, because it is
// monotonic across the whole relay lifetime and a fresh install starts with an
// empty buffer at the sequence the previous one ended on.
let renderedLogKey = '';
// One-shot: a failed install expands its own log, but a later re-render of the
// same sticky payload must not fight the user closing it again.
let autoExpandProviderId = '';
let lastInstallSignature = '';
// Client-side failures (request rejected before any broadcast), shown on the
// row that asked for them and cleared by the next real state transition.
let localErrors = {};
let installInFlight = false;
let cancelInFlight = false;
// The status read currently in flight, as `{ promise, force }`, so a second
// caller can *join* it instead of being dropped — see refreshCliInstallSections.
let statusRefresh = null;

function normalizeInstallState(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return INSTALL_STATES.includes(value) ? value : 'idle';
}

function normalizeProviderId(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return CLI_PROVIDER_IDS.includes(value) ? value : '';
}

function normalizeAction(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return INSTALL_ACTIONS.includes(value) ? value : '';
}

/**
 * The row's status line (§3): `not installed` / `1.0.13 · ~/.grok/bin/grok ·
 * native · update available`. Every segment degrades on its own — an
 * unparseable version reads as "version unknown" rather than hiding the
 * install, and `updateAvailable: null` (unknown) simply drops that segment.
 */
export function cliRowText(row) {
  if (!row) return 'CLI status unavailable.';
  // `checkedAt: null` is "never probed", which is not the same as "not there".
  if (!row.checkedAt) return 'Checking…';
  if (row.installed !== true) {
    const error = String(row.error || '').trim();
    return error ? `Not installed — ${error}` : 'Not installed';
  }
  const parts = [String(row.version || '').trim() || 'installed (version unknown)'];
  const path = String(row.path || '').trim();
  if (path) parts.push(path);
  const method = String(row.installMethod || '').trim();
  if (method) parts.push(method);
  if (row.updateAvailable === true) {
    const latest = String(row.latestVersion || '').trim();
    parts.push(latest ? `update available (${latest})` : 'update available');
  } else if (row.updateAvailable === false) {
    parts.push('up to date');
  }
  return parts.join(' · ');
}

export function cliRowState(row) {
  if (!row) return 'error';
  if (!row.checkedAt) return 'pending';
  if (row.installed === true) return 'active';
  return String(row.error || '').trim() ? 'error' : 'unconfigured';
}

/**
 * The line under the row: why a provider cannot be installed from here, and the
 * doctor warnings verbatim (they are the CLI's own words, not a paraphrase).
 */
export function cliRowNote(row) {
  if (!row) return '';
  const parts = [];
  const blocked = String(row.blockedReason || '').trim();
  if (blocked) parts.push(blocked);
  const warnings = Array.isArray(row.doctor?.warnings) ? row.doctor.warnings : [];
  for (const warning of warnings) {
    const text = String(warning || '').trim();
    if (text) parts.push(text);
  }
  if (row.doctor?.npmGlobalNotWritable === true && row.commands?.migrate) parts.push(MIGRATE_NOTE);
  return parts.join(' ');
}

/** Which action buttons this row offers, in the order they are rendered. */
export function cliRowActions(row) {
  const commands = row?.commands && typeof row.commands === 'object' ? row.commands : {};
  return INSTALL_ACTIONS.filter((action) => {
    if (!commands[action]) return false;
    // The migration is offered only in the case it fixes: an npm-global install
    // that can no longer update itself. Otherwise it would install a second
    // Claude that silently shadows the first.
    if (action === 'migrate') return row?.doctor?.npmGlobalNotWritable === true;
    return true;
  });
}

export function installLogSummary(install) {
  const state = normalizeInstallState(install?.state);
  const word = STATE_WORDS[state] || 'Install';
  const command = String(install?.command || '').trim();
  return command ? `${word} · ${command}` : `${word} · install log`;
}

function setHidden(element, hidden) {
  if (element) element.hidden = !!hidden;
}

function setDisabled(element, disabled) {
  if (element) element.disabled = !!disabled;
}

function el(providerId, suffix) {
  return document.getElementById(`cli-${providerId}-${suffix}`);
}

function currentInstall() {
  return cliState.install || EMPTY_INSTALL;
}

/** True while any install owns the host: the single flight is relay-wide. */
export function isCliInstallBusy() {
  return normalizeInstallState(currentInstall().state) === 'running';
}

function renderCliInstallRow(providerId) {
  const section = document.getElementById(`cli-${providerId}-section`);
  if (!section) return;
  const row = cliState.providers?.[providerId] || null;
  const install = currentInstall();
  const state = normalizeInstallState(install.state);
  const mine = normalizeProviderId(install.providerId) === providerId;
  const busy = state === 'running';

  const label = el(providerId, 'label');
  if (label && String(row?.label || '').trim()) label.textContent = String(row.label).trim();

  const status = el(providerId, 'status');
  if (status) {
    status.textContent = localErrors[providerId] || cliRowText(row);
    status.dataset.state = localErrors[providerId] ? 'error' : cliRowState(row);
  }

  const offered = cliRowActions(row);
  for (const action of INSTALL_ACTIONS) {
    const button = el(providerId, `${action}-btn`);
    if (!button) continue;
    setHidden(button, !offered.includes(action));
    button.textContent = ACTION_BUTTON_LABELS[action];
    setDisabled(button, busy || installInFlight || Boolean(statusRefresh));
  }

  // Cancel while this row's install runs; Dismiss once it has settled — the
  // same route, which is also how the terminal state is cleared.
  setHidden(el(providerId, 'cancel-btn'), !(mine && busy));
  setDisabled(el(providerId, 'cancel-btn'), cancelInFlight);
  const settled = mine && (state === 'success' || state === 'error' || state === 'cancelled');
  setHidden(el(providerId, 'dismiss-btn'), !settled);
  setDisabled(el(providerId, 'dismiss-btn'), cancelInFlight);

  const note = el(providerId, 'note');
  const noteText = mine && install.error && state === 'error'
    ? String(install.error).trim()
    : cliRowNote(row);
  if (note) {
    note.textContent = noteText;
    note.dataset.state = (mine && state === 'error') ? 'error' : '';
  }
  setHidden(note, !noteText);

  const details = el(providerId, 'log-details');
  const showLog = mine && state !== 'idle';
  setHidden(details, !showLog);
  const summary = el(providerId, 'log-summary');
  if (summary) summary.textContent = installLogSummary(install);
  const logBox = el(providerId, 'log');
  // Keyed on the session, not on logSeq alone: logSeq never resets, so a new
  // install would otherwise redraw nothing and leave the previous log on screen.
  const logKey = `${providerId}|${install.startedAt || ''}|${install.logSeq || 0}`;
  if (logBox && showLog && logKey !== renderedLogKey) {
    // textContent, never innerHTML: this is raw host process output.
    logBox.textContent = String(install.log || '');
    logBox.scrollTop = logBox.scrollHeight;
    renderedLogKey = logKey;
  }
  if (details && showLog && autoExpandProviderId === providerId) {
    details.open = true;
    autoExpandProviderId = '';
  }
}

export function renderCliInstallSections() {
  for (const providerId of CLI_PROVIDER_IDS) renderCliInstallRow(providerId);
}

// A broadcast can outrun the HTTP response that triggered it (the first log
// chunk lands before POST /api/cli/install returns its "running" snapshot).
// Within one install session (same startedAt) the sequence only moves forward,
// so an older snapshot must never regress the log or the state.
function isStaleInstallPayload(current, incoming) {
  if (!current || !incoming) return false;
  // The service never leaves `running` for `idle` — a cancel lands on
  // `cancelled` — so an idle snapshot arriving against a running one is a
  // status read that started before this install did.
  if (normalizeInstallState(current.state) === 'running'
    && normalizeInstallState(incoming.state) === 'idle') return true;
  // Different sessions: ISO stamps compare lexicographically, and an older one
  // can only have snapshotted a previous install.
  if (current.startedAt && incoming.startedAt && incoming.startedAt < current.startedAt) return true;
  if (!current.startedAt || current.startedAt !== incoming.startedAt) return false;
  const currentSeq = Number(current.logSeq || 0);
  const incomingSeq = Number(incoming.logSeq || 0);
  if (incomingSeq < currentSeq) return true;
  // Equal sequences: a settled install must not be reopened by the slower
  // response that snapshotted its start.
  return incomingSeq === currentSeq
    && normalizeInstallState(current.state) !== 'running'
    && normalizeInstallState(incoming.state) === 'running';
}

/**
 * Single entry point for every payload (GET response, POST response, socket
 * broadcast). Both keys are optional so an error body that only carries one of
 * them cannot blank the other half of the panel.
 */
export function applyCliInstallState(payload) {
  if (!payload || typeof payload !== 'object') return cliState;
  const providers = (payload.providers && typeof payload.providers === 'object')
    ? payload.providers
    : cliState.providers;
  const incoming = (payload.install && typeof payload.install === 'object') ? payload.install : null;
  if (incoming && isStaleInstallPayload(cliState.install, incoming)) {
    cliState = { ...cliState, providers };
    renderCliInstallSections();
    return cliState;
  }
  const install = incoming
    ? { ...EMPTY_INSTALL, ...incoming, state: normalizeInstallState(incoming.state) }
    : cliState.install;
  cliState = { providers, install };

  const signature = `${install.providerId || ''}|${install.startedAt || ''}|${install.state}`;
  if (signature !== lastInstallSignature) {
    lastInstallSignature = signature;
    localErrors = {};
    // Only a failure opens the log on its own; a running install stays folded
    // until the user asks for it.
    if (install.state === 'error') autoExpandProviderId = normalizeProviderId(install.providerId);
  }
  renderCliInstallSections();
  return cliState;
}

/**
 * Reads the provider rows, joining a read already in flight rather than
 * dropping the second caller.
 *
 * The joining matters because callers arrive in pairs: the chat "Install Grok
 * CLI" CTA opens the settings modal — which starts a forced refresh — and then
 * opens the confirm sheet in the same tick, and that sheet needs the very rows
 * the refresh is fetching. Returning null to the second caller left it looking
 * at an empty `cliState`, so the first click after the failure that prompted it
 * showed "that CLI has no install command on this host" instead of the sheet.
 *
 * A forced caller only joins a *forced* read: joining a cached one could hand it
 * rows up to the service's 30s TTL out of date, which is exactly what the force
 * exists to avoid.
 */
export function refreshCliInstallSections({ force = false } = {}) {
  if (statusRefresh && (statusRefresh.force || !force)) return statusRefresh.promise;
  const previous = statusRefresh?.promise || null;
  // Published before the read starts, so the `finally` below always sees the
  // entry it is meant to clear however early it runs.
  const entry = { force, promise: null };
  statusRefresh = entry;
  entry.promise = (async () => {
    // Never two GETs at once: a forced read that could not join queues behind
    // the one in flight instead of racing it.
    if (previous) await previous.catch(() => {});
    try {
      const payload = await getCliStatus({ force });
      if (!payload) {
        for (const providerId of CLI_PROVIDER_IDS) {
          const status = el(providerId, 'status');
          if (!status) continue;
          status.textContent = 'Unable to load the CLI status.';
          status.dataset.state = 'error';
        }
        return null;
      }
      return applyCliInstallState(payload);
    } finally {
      if (statusRefresh === entry) statusRefresh = null;
      renderCliInstallSections();
    }
  })();
  renderCliInstallSections();
  return entry.promise;
}

/**
 * The confirm sheet. It names the literal command and the directory it writes
 * into, because `curl … | bash` is a trust decision and the user is entitled to
 * read the thing before it runs. The command shown is the server's own
 * `commands[action].display` — this module never composes one.
 */
export async function confirmCliInstall(providerId, action) {
  const id = normalizeProviderId(providerId);
  const wanted = normalizeAction(action);
  if (!id || !wanted) return;
  if (isCliInstallBusy()) {
    showTransientRelayNotice('Another CLI install is already running on the relay host.');
    return;
  }
  // The chat-error CTA can fire before the settings panel has ever loaded, so
  // the sheet reads a fresh status rather than an empty one.
  if (!cliState.providers?.[id]?.checkedAt) await refreshCliInstallSections({ force: true });
  const row = cliState.providers?.[id] || null;
  const command = row?.commands?.[wanted] || null;
  if (!command) {
    const blocked = String(row?.blockedReason || '').trim();
    showTransientRelayNotice(blocked || `${row?.label || 'That CLI'} has no ${wanted} command on this host.`);
    return;
  }
  const label = String(row?.label || 'the CLI').trim();
  const display = String(command.display || '').trim();
  const targetDir = String(command.targetDir || '').trim();
  const migrateNote = wanted === 'migrate' ? `<p>${escHtml(MIGRATE_NOTE)}</p>` : '';
  openSummaryModal({
    title: `${ACTION_TITLES[wanted]} ${label}`,
    subtitle: label,
    kind: 'cli-install',
    bodyHtml: `
      <p>Run this on the relay host, as the relay user and without sudo?</p>
      <pre class="cli-install-command">${escHtml(display)}</pre>
      ${targetDir ? `<p>Installs into <code>${escHtml(targetDir)}</code>.</p>` : ''}
      ${migrateNote}
      <p>Sessions already running keep the binary they launched with.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn" type="button" onclick="runCliInstall('${escHtml(id)}', '${escHtml(wanted)}')">${escHtml(ACTION_TITLES[wanted])}</button>
        <button class="chat-title-action-btn" type="button" onclick="closeSummaryModal()">Cancel</button>
      </div>
    `,
  });
}

export async function runCliInstall(providerId, action) {
  const id = normalizeProviderId(providerId);
  const wanted = normalizeAction(action);
  if (!id || !wanted || installInFlight) return;
  installInFlight = true;
  setSummaryModalLoading(true);
  renderCliInstallSections();
  try {
    const payload = await startCliInstall(id, wanted);
    closeSummaryModal();
    applyCliInstallState(payload);
  } catch (error) {
    closeSummaryModal();
    localErrors = { [id]: String(error?.message || 'Failed to start the CLI install.') };
    // The refusal body carries the current rows too, but it arrived as a
    // throw; re-read so the row is not left describing a state that changed.
    await refreshCliInstallSections().catch(() => {});
  } finally {
    installInFlight = false;
    setSummaryModalLoading(false);
    renderCliInstallSections();
  }
}

/** Cancel a running install, and the dismiss path for a settled one. */
export async function cancelCliInstallRun() {
  if (cancelInFlight) return;
  cancelInFlight = true;
  renderCliInstallSections();
  try {
    applyCliInstallState(await cancelCliInstall());
  } catch (error) {
    showTransientRelayNotice(String(error?.message || 'Failed to cancel the CLI install.'));
    await refreshCliInstallSections().catch(() => {});
  } finally {
    cancelInFlight = false;
    renderCliInstallSections();
  }
}
