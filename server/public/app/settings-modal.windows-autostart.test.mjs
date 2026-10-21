import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Autostart (Windows) in Settings › General follows the rules of
// `oar autostart`: an entry OAR did not make is never replaced from here, the
// status line says how to replace it, and a refused switch shows the relay's
// message. Rendered against the real index.html.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.alert = () => {};

const { setServerPlatform } = await import('./store.js');
const { refreshWindowsAutostartSetting, updateWindowsAutostartMode } = await import('./settings-modal.js');
setServerPlatform('win32');

const status = () => document.getElementById('windows-autostart-status');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stateWith(boot, mode = 'off') {
  return {
    supported: true,
    platform: 'win32',
    mode,
    enabled: mode !== 'off',
    signinEnabled: false,
    boot: { taskStatus: 'missing', taskName: 'oar-relay', legacyTaskPresent: false, customised: false, customisations: [], handMade: [], ...boot },
  };
}

test('a foreign, a pre-rebrand or a hand-edited boot task is left as it is, and the status line says how to replace it', async (t) => {
  for (const [state, wanted] of [
    [stateWith({ taskStatus: 'foreign' }), /not created by OAR\. OAR leaves it as it is; to replace it, keeping a copy: oar autostart boot --replace\./],
    [stateWith({ legacyTaskPresent: true }), /pre-rebrand boot task exists\. OAR leaves it as it is; .*--replace\./],
    [stateWith({ taskStatus: 'ready', customised: true, customisations: ['launcher'], handMade: [{ path: 'L', task: null }] }, 'boot'),
      /changed by hand \(launcher edited or from an older OAR\)\. OAR leaves it as it is; .*oar autostart boot --replace\./],
  ]) {
    t.mock.method(globalThis, 'fetch', async () => jsonResponse(state));
    await refreshWindowsAutostartSetting();
    assert.match(status().textContent, wanted);
    assert.doesNotMatch(status().textContent, /replaces it|migrates it|regenerates/);
  }
});

test('a switch the relay refuses shows its message, and the mode stays as it was', async (t) => {
  const message = 'Nothing changed: OAR does not delete or overwrite an autostart entry it did not make. Remove it yourself, or replace it keeping a copy: oar autostart signin --replace. Left as it is: scheduled task \\oar-relay (hand-made).';
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => (options.method === 'POST'
    ? jsonResponse({ error: message }, 409)
    : jsonResponse(stateWith({ taskStatus: 'ready', customised: true, customisations: ['boot-delay'], handMade: [{ path: 'T', task: 'oar-relay' }] }, 'boot'))));
  await refreshWindowsAutostartSetting();
  const alerts = [];
  t.mock.method(globalThis, 'alert', (text) => alerts.push(text));
  await updateWindowsAutostartMode('signin');
  assert.deepEqual(alerts, [`Failed to update the Windows autostart setting: ${message}`]);
  const checked = document.querySelector('input[name="windows-autostart-mode"]:checked');
  assert.equal(checked?.value, 'boot');
});

test('a Startup entry OAR did not make is named in the status line, with how to replace it', async (t) => {
  const state = { ...stateWith({}, 'signin'), signinHandMade: [{ path: 'C:\\Startup\\oar-web-relay.cmd', otherInstall: 'C:\\old\\oar' }] };
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(state));
  await refreshWindowsAutostartSetting();
  assert.equal(status().textContent, 'A Startup entry OAR did not make is there: C:\\Startup\\oar-web-relay.cmd (it starts the OAR install in C:\\old\\oar). OAR leaves it as it is; to replace it, keeping a copy: oar autostart signin --replace.');
});