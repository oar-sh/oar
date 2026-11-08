import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// The rows are drawn into mounts that live in index.html, so this renders
// against the real file: a renamed or dropped mount fails here instead of in
// the browser. JSDOM does not run the page's scripts.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const LINUX = { platform: 'linux', arch: 'x64', libc: 'glibc' };
const WINDOWS = { platform: 'win32', arch: 'x64', libc: null };

function sdk(id, overrides = {}) {
  return {
    id,
    label: { claude: 'Claude Agent SDK', cursor: 'Cursor SDK', koffi: 'Windows helper (koffi)' }[id],
    state: 'missing',
    pinned: { claude: '0.3.10', cursor: '1.4.2', koffi: '2.9.1' }[id],
    installed: null,
    folder: null,
    dir: null,
    support: 'yes',
    log: '',
    logSeq: 0,
    error: null,
    kind: null,
    retryAt: null,
    attempts: 0,
    heldBy: null,
    startedAt: null,
    finishedAt: null,
    active: false,
    canInstall: true,
    ...overrides,
  };
}

function snapshot(sdks = {}, host = LINUX) {
  return {
    root: '/srv/fixture/sdks',
    host,
    sdks: {
      claude: sdk('claude'),
      cursor: sdk('cursor'),
      koffi: sdk('koffi', host.platform === 'win32' ? {} : { state: 'unsupported', support: 'no', error: 'not here' }),
      ...sdks,
    },
  };
}

// Every request the module makes, answered by `answer` (a snapshot by default).
const requests = [];
let answer = () => ({ status: 200, body: snapshot() });
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
  const { status, body } = answer(String(url), options);
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

const ui = await import('./agent-sdk-ui.js');
const readiness = await import('./provider-readiness.mjs');
const {
  AGENT_SDK_IDS,
  agentSdkActions,
  agentSdkNoteText,
  agentSdkStatusText,
  applyAgentSdkState,
  isAgentSdkRowShown,
  refreshAgentSdkRows,
  resetAgentSdkUiForTests,
  runAgentSdkAction,
} = ui;

const row = (id) => document.getElementById(id);
const partOf = (id, name) => row(id).querySelector(`[data-part="${name}"]`);
const button = (id, action) => row(id).querySelector(`button[data-action="${action}"]`);
const visibleButtons = (id) => [...row(id).querySelectorAll('button[data-action]')].filter((el) => !el.hidden).map((el) => el.textContent);
const CLAUDE_ROWS = ['agent-sdk-claude-row', 'agent-sdk-claude-api-row', 'agent-sdk-deepseek-row'];

function fresh() {
  resetAgentSdkUiForTests();
  readiness.resetProviderReadinessForTests();
  requests.length = 0;
  answer = () => ({ status: 200, body: snapshot() });
}

test('index.html mounts Claude\'s SDK in three provider tabs, Cursor\'s in one, the helper under General', () => {
  assert.deepEqual(AGENT_SDK_IDS, ['claude', 'cursor', 'koffi']);
  for (const id of CLAUDE_ROWS) assert.equal(row(id).dataset.agentSdk, 'claude', id);
  assert.ok(row('agent-sdk-claude-row').closest('#settings-provider-panel-claude'));
  assert.ok(row('agent-sdk-claude-api-row').closest('#settings-provider-panel-claude-api'));
  assert.ok(row('agent-sdk-deepseek-row').closest('#settings-provider-panel-deepseek'));
  assert.ok(row('agent-sdk-cursor-row').closest('#settings-provider-panel-cursor'));
  assert.equal(row('agent-sdk-cursor-row').dataset.agentSdk, 'cursor');
  assert.ok(row('agent-sdk-koffi-row').closest('#settings-panel-general .settings-section'));
  assert.equal(row('agent-sdk-koffi-row').hidden, true, 'hidden until a snapshot says otherwise');
});

test('a missing SDK offers Install in every tab it is mounted in', () => {
  fresh();
  applyAgentSdkState(snapshot());
  for (const id of CLAUDE_ROWS) {
    assert.equal(partOf(id, 'label').textContent, 'Claude Agent SDK', id);
    assert.equal(partOf(id, 'status').textContent, 'Not installed · pinned 0.3.10 · none installed', id);
    assert.equal(partOf(id, 'status').dataset.state, 'unconfigured');
    assert.deepEqual(visibleButtons(id), ['Install'], id);
    assert.equal(button(id, 'install').disabled, false);
    assert.equal(partOf(id, 'log-details').hidden, true);
    assert.equal(partOf(id, 'note').hidden, true);
  }
  assert.equal(partOf('agent-sdk-cursor-row', 'label').textContent, 'Cursor SDK');
});

test('installing streams the log, redrawn as logSeq moves, with Cancel', () => {
  fresh();
  const startedAt = '2026-04-01T10:00:00.000Z';
  applyAgentSdkState(snapshot({ claude: sdk('claude', { state: 'installing', active: true, canInstall: false, startedAt, log: 'added 12 packages\n', logSeq: 3 }) }));
  const id = 'agent-sdk-claude-api-row';
  assert.equal(partOf(id, 'status').textContent, 'Installing… · pinned 0.3.10 · none installed');
  assert.deepEqual(visibleButtons(id), ['Cancel']);
  assert.equal(button(id, 'cancel').disabled, false, 'Cancel does not need canInstall');
  assert.equal(partOf(id, 'log-details').hidden, false);
  assert.equal(partOf(id, 'log-summary').textContent, 'Running · install log');
  assert.equal(partOf(id, 'log').textContent, 'added 12 packages\n');

  applyAgentSdkState(snapshot({ claude: sdk('claude', { state: 'installing', startedAt, log: 'added 12 packages\nadded 40 packages\n', logSeq: 4 }) }));
  assert.equal(partOf(id, 'log').textContent, 'added 12 packages\nadded 40 packages\n');
  // An older answer of the same install does not take the log back.
  applyAgentSdkState(snapshot({ claude: sdk('claude', { state: 'installing', startedAt, log: 'added 12 packages\n', logSeq: 3 }) }));
  assert.equal(partOf(id, 'log').textContent, 'added 12 packages\nadded 40 packages\n');
});

test('an install held by another process says whose it is', () => {
  fresh();
  applyAgentSdkState(snapshot({ cursor: sdk('cursor', { state: 'installing', heldBy: 4242, startedAt: '2026-04-01T10:00:00.000Z' }) }));
  assert.equal(partOf('agent-sdk-cursor-row', 'status').textContent, 'Installing by another OAR process (pid 4242)… · pinned 1.4.2 · none installed');
});

test('ready offers Reinstall; a settled install is not reopened by its own start snapshot', () => {
  fresh();
  const startedAt = '2026-04-01T10:00:00.000Z';
  applyAgentSdkState(snapshot({ claude: sdk('claude', { state: 'ready', installed: '0.3.10', startedAt, finishedAt: '2026-04-01T10:01:00.000Z', log: 'done\n', logSeq: 9 }) }));
  const id = 'agent-sdk-claude-row';
  assert.equal(partOf(id, 'status').textContent, 'Installed · pinned 0.3.10 · installed 0.3.10');
  assert.equal(partOf(id, 'status').dataset.state, 'active');
  assert.deepEqual(visibleButtons(id), ['Reinstall']);
  assert.equal(partOf(id, 'log-summary').textContent, 'Finished · install log');
  applyAgentSdkState(snapshot({ claude: sdk('claude', { state: 'installing', startedAt, log: 'done\n', logSeq: 9 }) }));
  assert.deepEqual(visibleButtons(id), ['Reinstall']);
});

test('a failure shows the error, the next automatic retry and Retry, and opens its log once', () => {
  fresh();
  const failed = sdk('claude', {
    state: 'error',
    kind: 'network',
    error: 'No connection to the npm registry. OAR needs it once per SDK version. (npm error code ENOTFOUND)',
    retryAt: '2026-04-01T10:06:00.000Z',
    attempts: 1,
    startedAt: '2026-04-01T10:00:00.000Z',
    finishedAt: '2026-04-01T10:05:00.000Z',
    log: 'npm error code ENOTFOUND\n',
    logSeq: 2,
  });
  applyAgentSdkState(snapshot({ claude: failed }));
  const id = 'agent-sdk-deepseek-row';
  assert.equal(partOf(id, 'status').textContent, 'Install failed · pinned 0.3.10 · none installed');
  assert.equal(partOf(id, 'status').dataset.state, 'error');
  assert.equal(partOf(id, 'note').hidden, false);
  assert.match(partOf(id, 'note').textContent, /^No connection to the npm registry\. .* Next automatic retry at .+\.$/);
  assert.equal(partOf(id, 'note').dataset.state, 'error');
  assert.deepEqual(visibleButtons(id), ['Retry']);
  assert.equal(partOf(id, 'log-details').open, true);
  assert.equal(partOf(id, 'log-summary').textContent, 'Failed · install log');

  partOf(id, 'log-details').open = false;
  applyAgentSdkState(snapshot({ claude: { ...failed } }));
  assert.equal(partOf(id, 'log-details').open, false, 'the user closed it; a redraw leaves it closed');
});

test('a cancelled install is not shown as a failure', () => {
  fresh();
  applyAgentSdkState(snapshot({ cursor: sdk('cursor', { state: 'error', kind: 'cancelled', error: 'Cursor SDK install cancelled', startedAt: '2026-04-01T10:00:00.000Z', log: 'x\n', logSeq: 1 }) }));
  const id = 'agent-sdk-cursor-row';
  assert.equal(partOf(id, 'status').dataset.state, 'unconfigured');
  assert.equal(partOf(id, 'note').dataset.state, '');
  assert.equal(partOf(id, 'log-summary').textContent, 'Cancelled · install log');
  assert.equal(partOf(id, 'log-details').open, false);
});

test('not available on this platform: no button', () => {
  fresh();
  applyAgentSdkState(snapshot({ cursor: sdk('cursor', { state: 'unsupported', support: 'no', kind: 'platform', canInstall: false, error: 'Cursor SDK is not available on this platform (android-arm64).' }) }));
  const id = 'agent-sdk-cursor-row';
  assert.equal(partOf(id, 'status').textContent, 'Not available on this platform · pinned 1.4.2');
  assert.deepEqual(visibleButtons(id), []);
  assert.equal(partOf(id, 'note').hidden, true);
});

test('spawns off: the buttons are there but disabled', () => {
  fresh();
  applyAgentSdkState(snapshot({ claude: sdk('claude', { canInstall: false }) }));
  assert.equal(button('agent-sdk-claude-row', 'install').hidden, false);
  assert.equal(button('agent-sdk-claude-row', 'install').disabled, true);
});

test('the Windows helper row shows only where koffi can exist, and offers no Reinstall', () => {
  fresh();
  applyAgentSdkState(snapshot());
  assert.equal(row('agent-sdk-koffi-row').hidden, true, 'Linux');

  applyAgentSdkState(snapshot({}, WINDOWS));
  assert.equal(row('agent-sdk-koffi-row').hidden, false, 'Windows');
  assert.equal(partOf('agent-sdk-koffi-row', 'label').textContent, 'Windows helper (koffi)');
  assert.deepEqual(visibleButtons('agent-sdk-koffi-row'), ['Install']);
  applyAgentSdkState(snapshot({ koffi: sdk('koffi', { state: 'error', error: 'npm exited with code 1' }) }, WINDOWS));
  assert.deepEqual(visibleButtons('agent-sdk-koffi-row'), ['Retry']);
  applyAgentSdkState(snapshot({ koffi: sdk('koffi', { state: 'ready', installed: '2.9.1' }) }, WINDOWS));
  assert.deepEqual(visibleButtons('agent-sdk-koffi-row'), []);

  assert.equal(isAgentSdkRowShown('koffi', { host: WINDOWS, sdks: { koffi: { state: 'missing' } } }), true, 'no support field: the platform decides');
  assert.equal(isAgentSdkRowShown('koffi', { host: LINUX, sdks: { koffi: { state: 'missing' } } }), false);
  assert.equal(isAgentSdkRowShown('koffi', { host: WINDOWS, sdks: {} }), false);
  assert.equal(isAgentSdkRowShown('claude', null), true);
});

test('relay output is written as text, never as markup', () => {
  fresh();
  const markup = '<img src=x onerror="window.__sdkInjected=1">';
  applyAgentSdkState(snapshot({
    claude: sdk('claude', { state: 'error', label: `Claude ${markup}`, error: markup, log: markup, logSeq: 1, startedAt: '2026-04-01T10:00:00.000Z' }),
  }));
  const id = 'agent-sdk-claude-row';
  assert.equal(row(id).querySelector('img'), null);
  assert.equal(partOf(id, 'label').textContent, `Claude ${markup}`);
  assert.ok(partOf(id, 'note').textContent.startsWith(markup));
  assert.equal(partOf(id, 'log').textContent, markup);
  assert.equal(window.__sdkInjected, undefined);
});

test('the pure helpers', () => {
  assert.equal(agentSdkStatusText(null), 'Checking…');
  assert.deepEqual(agentSdkActions(null), []);
  assert.deepEqual(agentSdkActions(sdk('claude', { state: 'ready' }), { reinstall: false }), []);
  assert.equal(agentSdkNoteText(sdk('claude', { state: 'error', error: 'boom', retryAt: 'not a date' })), 'boom');
  // A retry time only means something on a failure.
  assert.equal(agentSdkNoteText(sdk('claude', { state: 'installing', retryAt: '2026-04-01T10:06:00.000Z' })), '');
});

test('the status read draws the rows and feeds provider readiness', async () => {
  fresh();
  answer = () => ({ status: 200, body: snapshot({ claude: sdk('claude', { state: 'error', error: 'npm exited with code 1' }) }) });
  await refreshAgentSdkRows();
  assert.deepEqual(requests.map((r) => `${r.method} ${r.url}`), ['GET /api/agent-sdks/status']);
  assert.equal(partOf('agent-sdk-claude-row', 'status').textContent, 'Install failed · pinned 0.3.10 · none installed');

  readiness.updateProviderReadinessInputs({ openai: { enabled: false }, claude: { enabled: true }, cursor: { enabled: false }, grok: { enabled: false }, catalog: { source: 'bootstrap-seed' } });
  const answerNow = readiness.getProviderReadiness();
  assert.deepEqual(answerNow.ready, []);
  assert.equal(answerNow.reasons.claude.text, 'Claude Agent SDK install failed: npm exited with code 1');
});

test('a failed status read says so on the rows, and keeps what was known', async () => {
  fresh();
  answer = () => ({ status: 503, body: { error: 'Agent SDKs are unavailable on this relay' } });
  await refreshAgentSdkRows();
  assert.equal(partOf('agent-sdk-cursor-row', 'status').textContent, 'Unable to load the SDK status.');
  assert.equal(partOf('agent-sdk-cursor-row', 'status').dataset.state, 'error');

  applyAgentSdkState(snapshot());
  await refreshAgentSdkRows();
  assert.equal(partOf('agent-sdk-cursor-row', 'status').textContent, 'Not installed · pinned 1.4.2 · none installed');
});

test('Install, Reinstall and Cancel post the SDK id and draw the answer', async () => {
  fresh();
  applyAgentSdkState(snapshot());
  answer = () => ({ status: 200, body: { ok: true, ...snapshot({ cursor: sdk('cursor', { state: 'installing', startedAt: '2026-04-01T10:00:00.000Z' }) }) } });
  button('agent-sdk-cursor-row', 'install').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requests.at(-1), { url: '/api/agent-sdks/install', method: 'POST', body: { sdk: 'cursor', reinstall: false } });
  assert.deepEqual(visibleButtons('agent-sdk-cursor-row'), ['Cancel']);

  answer = () => ({ status: 200, body: { ok: true, ...snapshot() } });
  await runAgentSdkAction('cursor', 'cancel');
  assert.deepEqual(requests.at(-1), { url: '/api/agent-sdks/install/cancel', method: 'POST', body: { sdk: 'cursor' } });

  await runAgentSdkAction('claude', 'reinstall');
  assert.deepEqual(requests.at(-1).body, { sdk: 'claude', reinstall: true });

  // Nothing leaves for an id or action the module does not know.
  const before = requests.length;
  await runAgentSdkAction('grok', 'install');
  await runAgentSdkAction('claude', 'uninstall');
  assert.equal(requests.length, before);
});

test('a refused request shows the relay\'s words on that row until the next transition', async () => {
  fresh();
  applyAgentSdkState(snapshot());
  answer = (url) => (url.endsWith('/install')
    ? { status: 409, body: { error: 'The SDK folder is longer than 120 characters; set OAR_SDK_DIR to a shorter one.' } }
    : { status: 200, body: snapshot() });
  await runAgentSdkAction('claude', 'install');
  assert.equal(partOf('agent-sdk-claude-row', 'status').textContent, 'The SDK folder is longer than 120 characters; set OAR_SDK_DIR to a shorter one.');
  assert.equal(partOf('agent-sdk-claude-row', 'status').dataset.state, 'error');
  assert.equal(button('agent-sdk-claude-row', 'install').disabled, false, 'the button is free again');

  applyAgentSdkState(snapshot({ claude: sdk('claude', { state: 'installing', startedAt: '2026-04-01T11:00:00.000Z' }) }));
  assert.equal(partOf('agent-sdk-claude-row', 'status').textContent, 'Installing… · pinned 0.3.10 · none installed');
});
