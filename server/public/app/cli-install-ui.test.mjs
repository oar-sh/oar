import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// The install UI writes into markup that lives in index.html, so the smoke test
// renders against the real file rather than a hand-rolled fixture: a renamed or
// dropped element id fails here instead of in the browser. JSDOM does not
// execute the page's <script> tags, so this is pure markup + module.
const indexHtml = await readFile(
  fileURLToPath(new URL('../index.html', import.meta.url)),
  'utf8',
);
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});

const IDLE_INSTALL = {
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
};

const GROK_INSTALL_COMMAND = {
  display: 'curl -fsSL https://x.ai/cli/install.sh | bash',
  targetDir: '~/.grok/bin',
};

function providerRow(overrides = {}) {
  return {
    id: 'grok',
    label: 'Grok CLI',
    binary: 'grok',
    installed: false,
    version: null,
    path: null,
    realPath: null,
    installMethod: null,
    updateAvailable: null,
    latestVersion: null,
    canInstall: true,
    canUpdate: false,
    blockedReason: null,
    commands: { install: GROK_INSTALL_COMMAND },
    doctor: null,
    bound: null,
    error: null,
    checkedAt: '2026-08-31T12:00:00.000Z',
    ...overrides,
  };
}

function payload(providers, install = {}) {
  return { providers, install: { ...IDLE_INSTALL, ...install } };
}

// Nothing in these cases fetches; the stub only keeps an accidental refresh
// from reaching the network.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload({}) });

const {
  applyCliInstallState,
  cliRowText,
  cliRowState,
  cliRowNote,
  cliRowActions,
  installLogSummary,
  isCliInstallBusy,
} = await import('./cli-install-ui.js');

const el = (id) => document.getElementById(id);

test('a never-probed row says so instead of claiming the CLI is missing', () => {
  applyCliInstallState(payload({ grok: providerRow({ checkedAt: null }) }));
  assert.equal(el('cli-grok-status').textContent, 'Checking…');
  assert.equal(el('cli-grok-status').dataset.state, 'pending');
});

test('a not-installed row offers Install only, off the commands keys', () => {
  applyCliInstallState(payload({ grok: providerRow() }));
  assert.equal(el('cli-grok-status').textContent, 'Not installed');
  assert.equal(el('cli-grok-status').dataset.state, 'unconfigured');
  assert.equal(el('cli-grok-install-btn').hidden, false);
  assert.equal(el('cli-grok-install-btn').disabled, false);
  assert.equal(el('cli-grok-update-btn').hidden, true);
  assert.equal(el('cli-grok-migrate-btn').hidden, true);
  assert.equal(el('cli-grok-log-details').hidden, true);
});

test('an installed row composes version · path · method · update state', () => {
  applyCliInstallState(payload({
    grok: providerRow({
      installed: true,
      version: '1.0.13',
      path: '/opt/grok/bin/grok',
      installMethod: 'native',
      updateAvailable: true,
      latestVersion: '1.0.14',
      canInstall: false,
      canUpdate: true,
      commands: { update: { display: 'grok update', targetDir: '~/.grok/bin' } },
    }),
  }));
  assert.equal(
    el('cli-grok-status').textContent,
    '1.0.13 · /opt/grok/bin/grok · native · update available (1.0.14)',
  );
  assert.equal(el('cli-grok-status').dataset.state, 'active');
  assert.equal(el('cli-grok-install-btn').hidden, true);
  assert.equal(el('cli-grok-update-btn').hidden, false);
});

test('an unknown update state drops the segment rather than guessing "up to date"', () => {
  const row = providerRow({ installed: true, version: '2.1.247', path: '/usr/bin/claude', updateAvailable: null });
  assert.equal(cliRowText(row), '2.1.247 · /usr/bin/claude');
  assert.equal(cliRowText({ ...row, updateAvailable: false }), '2.1.247 · /usr/bin/claude · up to date');
  // An installer that changed its banner must not turn a working install into
  // a missing one.
  assert.equal(cliRowText({ ...row, version: null }), 'installed (version unknown) · /usr/bin/claude');
  assert.equal(cliRowText(null), 'CLI status unavailable.');
  assert.equal(cliRowState(null), 'error');
});

test('the npm-global-not-writable case quotes the doctor warning and offers the migration', () => {
  const doctor = {
    method: 'npm-global',
    version: '2.1.247',
    path: '/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
    autoUpdates: 'enabled',
    lastUpdateAttempt: 'failed (no_permissions) — 2026-08-26',
    warnings: ["Can't auto-update: npm global folder isn't writable Fix: Run claude install to switch to the native installer (no sudo)"],
    npmGlobalNotWritable: true,
  };
  const claude = providerRow({
    id: 'claude',
    label: 'Claude Code CLI',
    installed: true,
    version: '2.1.247',
    path: '/usr/bin/claude',
    installMethod: 'npm-global',
    canInstall: false,
    canUpdate: true,
    commands: {
      update: { display: 'claude update', targetDir: '~/.local/bin' },
      migrate: { display: 'claude install', targetDir: '~/.local/bin' },
    },
    doctor,
  });
  applyCliInstallState(payload({ claude }));
  assert.deepEqual(cliRowActions(claude), ['update', 'migrate']);
  assert.equal(el('cli-claude-migrate-btn').hidden, false);
  assert.equal(el('cli-claude-note').hidden, false);
  assert.match(el('cli-claude-note').textContent, /npm global folder isn't writable/);
  assert.match(el('cli-claude-note').textContent, /native build takes PATH precedence/);

  // A healthy npm-global install must not be offered a second, shadowing copy.
  const healthy = { ...claude, doctor: { ...doctor, npmGlobalNotWritable: false, warnings: [] } };
  applyCliInstallState(payload({ claude: healthy }));
  assert.deepEqual(cliRowActions(healthy), ['update']);
  assert.equal(el('cli-claude-migrate-btn').hidden, true);
  assert.equal(el('cli-claude-note').hidden, true);
});

test('a detect-only provider renders read-only with its reason', () => {
  const copilot = providerRow({
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    installed: true,
    version: '0.9.1',
    path: '/usr/bin/copilot',
    installMethod: 'npm-global',
    canInstall: false,
    canUpdate: false,
    blockedReason: 'Managed with npm on this host — install and update it from a shell.',
    commands: {},
  });
  applyCliInstallState(payload({ copilot }));
  assert.deepEqual(cliRowActions(copilot), []);
  assert.equal(el('cli-copilot-install-btn').hidden, true);
  assert.equal(el('cli-copilot-update-btn').hidden, true);
  assert.equal(el('cli-copilot-note').textContent, copilot.blockedReason);
});

test('a running install streams the log and freezes every provider (single flight)', () => {
  applyCliInstallState(payload(
    { grok: providerRow(), claude: providerRow({ id: 'claude', label: 'Claude Code CLI' }) },
    {
      state: 'running',
      providerId: 'grok',
      action: 'install',
      command: GROK_INSTALL_COMMAND.display,
      log: 'Downloading grok 1.0.13…\n',
      logSeq: 4,
      startedAt: '2026-08-31T12:01:00.000Z',
      active: true,
    },
  ));
  assert.equal(isCliInstallBusy(), true);
  assert.equal(el('cli-grok-log-details').hidden, false);
  assert.equal(el('cli-grok-log').textContent, 'Downloading grok 1.0.13…\n');
  assert.equal(el('cli-grok-log-summary').textContent, `Running · ${GROK_INSTALL_COMMAND.display}`);
  assert.equal(el('cli-grok-cancel-btn').hidden, false);
  assert.equal(el('cli-grok-dismiss-btn').hidden, true);
  // Relay-wide: two installers writing ~/.local/bin at once is the failure the
  // server-side single flight exists to prevent, so no row offers a second one.
  assert.equal(el('cli-grok-install-btn').disabled, true);
  assert.equal(el('cli-claude-install-btn').disabled, true);
  // Another provider's row must not borrow this install's log.
  assert.equal(el('cli-claude-log-details').hidden, true);
});

test('a later chunk appends and an out-of-order broadcast cannot regress it', () => {
  const base = {
    state: 'running',
    providerId: 'grok',
    action: 'install',
    command: GROK_INSTALL_COMMAND.display,
    startedAt: '2026-08-31T12:01:00.000Z',
    active: true,
  };
  applyCliInstallState(payload({ grok: providerRow() }, { ...base, log: 'one\ntwo\n', logSeq: 5 }));
  assert.equal(el('cli-grok-log').textContent, 'one\ntwo\n');
  // Same session, older sequence: the socket outran the HTTP response.
  applyCliInstallState(payload({ grok: providerRow() }, { ...base, log: 'one\n', logSeq: 4 }));
  assert.equal(el('cli-grok-log').textContent, 'one\ntwo\n');
  // A genuinely new session (different startedAt) redraws from its own buffer,
  // even though logSeq is monotonic across the whole relay lifetime.
  applyCliInstallState(payload({ grok: providerRow() }, {
    ...base, startedAt: '2026-08-31T12:09:00.000Z', log: '', logSeq: 5,
  }));
  assert.equal(el('cli-grok-log').textContent, '');
});

test('a failure expands its own log once and stays put afterwards', () => {
  applyCliInstallState(payload({ grok: providerRow() }, {
    state: 'error',
    providerId: 'grok',
    action: 'install',
    command: GROK_INSTALL_COMMAND.display,
    log: 'curl: (6) Could not resolve host: x.ai\n',
    logSeq: 9,
    error: 'Grok CLI install exited with code 6',
    startedAt: '2026-08-31T12:10:00.000Z',
    finishedAt: '2026-08-31T12:10:20.000Z',
  }));
  assert.equal(el('cli-grok-log-details').open, true);
  assert.equal(el('cli-grok-log-summary').textContent, `Failed · ${GROK_INSTALL_COMMAND.display}`);
  assert.equal(el('cli-grok-note').textContent, 'Grok CLI install exited with code 6');
  assert.equal(el('cli-grok-note').dataset.state, 'error');
  assert.equal(el('cli-grok-dismiss-btn').hidden, false);
  assert.equal(el('cli-grok-cancel-btn').hidden, true);
  // The user folds it away; the same sticky payload must not pop it open again.
  el('cli-grok-log-details').open = false;
  applyCliInstallState(payload({ grok: providerRow() }, {
    state: 'error',
    providerId: 'grok',
    action: 'install',
    command: GROK_INSTALL_COMMAND.display,
    log: 'curl: (6) Could not resolve host: x.ai\n',
    logSeq: 9,
    error: 'Grok CLI install exited with code 6',
    startedAt: '2026-08-31T12:10:00.000Z',
    finishedAt: '2026-08-31T12:10:20.000Z',
  }));
  assert.equal(el('cli-grok-log-details').open, false);
});

test('a status read that predates the running install cannot rewind it', () => {
  const running = {
    state: 'running',
    providerId: 'grok',
    action: 'install',
    command: GROK_INSTALL_COMMAND.display,
    log: 'fetching…\n',
    logSeq: 12,
    startedAt: '2026-08-31T12:15:00.000Z',
    active: true,
  };
  applyCliInstallState(payload({ grok: providerRow() }, running));
  assert.equal(el('cli-grok-log-details').hidden, false);
  // The forced probe the settings modal fires on open can outlive the Install
  // click that follows it. The service never leaves `running` for `idle`.
  applyCliInstallState(payload({ grok: providerRow() }, IDLE_INSTALL));
  assert.equal(el('cli-grok-log-details').hidden, false);
  assert.equal(isCliInstallBusy(), true);
  // Nor may a previous install's terminal snapshot land on top of this one.
  applyCliInstallState(payload({ grok: providerRow() }, {
    state: 'success',
    providerId: 'grok',
    action: 'install',
    command: GROK_INSTALL_COMMAND.display,
    log: 'older run\n',
    logSeq: 3,
    startedAt: '2026-08-31T11:00:00.000Z',
    finishedAt: '2026-08-31T11:00:30.000Z',
  }));
  assert.equal(isCliInstallBusy(), true);
  assert.equal(el('cli-grok-log').textContent, 'fetching…\n');
});

test('dismissing a settled install hides the log and reopens the buttons', () => {
  applyCliInstallState(payload({ grok: providerRow() }, {
    state: 'success',
    providerId: 'grok',
    action: 'install',
    command: GROK_INSTALL_COMMAND.display,
    log: 'done\n',
    logSeq: 20,
    startedAt: '2026-08-31T12:15:00.000Z',
    finishedAt: '2026-08-31T12:16:00.000Z',
  }));
  assert.equal(el('cli-grok-dismiss-btn').hidden, false);
  // Dismiss clears the session server-side: idle with no provider and no stamp.
  applyCliInstallState(payload({ grok: providerRow() }, IDLE_INSTALL));
  assert.equal(el('cli-grok-log-details').hidden, true);
  assert.equal(el('cli-grok-dismiss-btn').hidden, true);
  assert.equal(el('cli-grok-install-btn').disabled, false);
  assert.equal(isCliInstallBusy(), false);
});

test('a payload with only one half of the contract leaves the other alone', () => {
  applyCliInstallState(payload({ grok: providerRow({ installed: true, version: '1.0.13', path: '/bin/grok' }) }));
  applyCliInstallState({ install: { ...IDLE_INSTALL, state: 'cancelled', providerId: 'grok', startedAt: '2026-08-31T13:00:00.000Z' } });
  assert.match(el('cli-grok-status').textContent, /^1\.0\.13 · \/bin\/grok/);
  assert.equal(el('cli-grok-dismiss-btn').hidden, false);
  // Junk never throws and never blanks the panel.
  applyCliInstallState(null);
  assert.match(el('cli-grok-status').textContent, /^1\.0\.13/);
  assert.equal(installLogSummary({ state: 'nonsense', command: '' }), 'Install · install log');
  assert.equal(cliRowNote(null), '');
});
