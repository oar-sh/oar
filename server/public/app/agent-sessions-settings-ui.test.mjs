import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Settings → Relays → Agent sessions renders into markup that lives in
// index.html, so this runs against the real file: a renamed or dropped id
// fails here instead of in the browser. JSDOM does not run the page's scripts
// or inline handlers, so the handlers bootstrap.js exposes are called directly.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const LIMITS = { minWaitSeconds: 120, maxWaitSeconds: 3600, stepSeconds: 60 };
const DEFAULTS = Object.freeze({ enabled: false, maxWaitSeconds: 600, limits: LIMITS, maxActiveSessions: 4 });

// ─── A scripted relay ────────────────────────────────────────────────────────
// GET answers `getResponder`, POST answers `postResponder`; each returns
// [status, body], or throws for a connection that fails.
const requests = [];
let relayState = { ...DEFAULTS };
let getResponder = () => [200, relayState];
let postResponder = (body) => {
  relayState = { ...relayState, ...body };
  return [200, { ok: true, ...relayState }];
};
globalThis.fetch = async (rawUrl, opts = {}) => {
  const url = new URL(String(rawUrl), 'http://localhost/');
  const method = String(opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  requests.push({ method, path: url.pathname, body });
  const [status, payload] = method === 'POST' ? await postResponder(body) : await getResponder();
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      // An older relay's 404 page is not JSON.
      if (payload === undefined) throw new SyntaxError('Unexpected token <');
      return payload;
    },
  };
};

const ui = await import('./agent-sessions-settings-ui.js');

const el = (id) => document.getElementById(id);
const section = () => el('agent-sessions-section');
const toggle = () => el('agent-sessions-enabled-toggle');
const slider = () => el('agent-sessions-max-wait-slider');
const sliderLabel = () => el('agent-sessions-max-wait-value');
const status = () => el('agent-sessions-status');

async function freshSection(state = {}) {
  ui.resetAgentSessionsSettingsForTests();
  relayState = { ...DEFAULTS, ...state };
  getResponder = () => [200, relayState];
  postResponder = (body) => {
    relayState = { ...relayState, ...body };
    return [200, { ok: true, ...relayState }];
  };
  requests.length = 0;
  slider().blur();
  await ui.refreshAgentSessionsSection();
  requests.length = 0;
}

test('the markup ships hidden, switched off, at the default wait', () => {
  assert.equal(section().hasAttribute('hidden'), true);
  assert.equal(section().closest('[data-settings-panel]').dataset.settingsPanel, 'relays');
  assert.equal(toggle().checked, false);
  assert.equal(toggle().disabled, true);
  assert.equal(slider().type, 'range');
  assert.deepEqual([slider().min, slider().max, slider().step, slider().value], ['120', '3600', '60', '600']);
  assert.equal(slider().disabled, true);
  assert.equal(sliderLabel().textContent, '10 min');
  assert.equal(status().hasAttribute('hidden'), true);
  // The inline handlers name what bootstrap.js puts on window.
  assert.equal(toggle().getAttribute('onchange'), 'toggleAgentSessions(this.checked)');
  assert.equal(slider().getAttribute('oninput'), 'previewAgentSessionsMaxWait(this.value)');
  assert.equal(slider().getAttribute('onchange'), 'saveAgentSessionsMaxWait(this.value)');
});

test('the text says whose accounts are used and that the first session asks', () => {
  assert.equal(section().querySelector('label:not([for])').textContent.trim(), 'Agent sessions');
  assert.equal(
    document.querySelector('label[for="agent-sessions-enabled-toggle"]').textContent.trim(),
    'Agents may start and use sessions on this relay',
  );
  assert.match(document.querySelector('label[for="agent-sessions-max-wait-slider"]').textContent, /^Longest wait per tool call/);
  const help = el('agent-sessions-cap').parentElement.textContent;
  assert.match(help, /use this relay's accounts/);
  assert.match(help, /first one in a conversation asks for your approval/);
});

test('a relay without the route keeps the section hidden', async () => {
  ui.resetAgentSessionsSettingsForTests();
  getResponder = () => [404, undefined];
  requests.length = 0;
  const state = await ui.refreshAgentSessionsSection();
  assert.equal(state, null);
  assert.deepEqual(requests, [{ method: 'GET', path: '/api/settings/agent-sessions', body: null }]);
  assert.equal(section().hidden, true);
  assert.equal(status().hidden, true);

  // A JSON 404 reads the same.
  getResponder = () => [404, { error: 'Not found' }];
  await ui.refreshAgentSessionsSection();
  assert.equal(section().hidden, true);

  // The relay was updated: the next open shows the section.
  getResponder = () => [200, relayState];
  await ui.refreshAgentSessionsSection();
  assert.equal(section().hidden, false);
});

test('a relay that had the section and lost it hides it again', async () => {
  await freshSection({ enabled: true });
  assert.equal(section().hidden, false);
  getResponder = () => [404, undefined];
  await ui.refreshAgentSessionsSection();
  assert.equal(section().hidden, true);
  assert.equal(ui.getAgentSessionsSettings(), null);
});

test('a read that fails is not an older relay', async () => {
  // Never loaded: the section shows, switched off, with the reason.
  ui.resetAgentSessionsSettingsForTests();
  getResponder = () => [500, { error: 'boom' }];
  await ui.refreshAgentSessionsSection();
  assert.equal(section().hidden, false);
  assert.equal(toggle().disabled, true);
  assert.equal(slider().disabled, true);
  assert.equal(status().hidden, false);
  assert.equal(status().dataset.state, 'error');
  assert.match(status().textContent, /Could not load/);

  // Loaded before: one failed refresh changes nothing.
  await freshSection({ enabled: true, maxWaitSeconds: 900 });
  getResponder = () => { throw new Error('connection reset'); };
  const errors = test.mock.method(console, 'error', () => {});
  try {
    await ui.refreshAgentSessionsSection();
  } finally {
    errors.mock.restore();
  }
  assert.equal(section().hidden, false);
  assert.equal(toggle().checked, true);
  assert.equal(slider().value, '900');
  assert.equal(status().hidden, true);
});

test('the loaded settings fill the switch and the slider', async () => {
  await freshSection({ enabled: true, maxWaitSeconds: 1800 });
  assert.equal(section().hidden, false);
  assert.equal(toggle().checked, true);
  assert.equal(toggle().disabled, false);
  assert.equal(slider().disabled, false);
  assert.equal(slider().value, '1800');
  assert.equal(sliderLabel().textContent, '30 min');
  assert.equal(slider().getAttribute('aria-valuetext'), '30 min');
  assert.equal(el('agent-sessions-cap').hidden, false);
  assert.equal(el('agent-sessions-cap').textContent, 'At most 4 of them work at the same time per conversation.');
  assert.equal(status().hidden, true);
});

test('range and step come from the relay', async () => {
  await freshSection({ enabled: true, maxWaitSeconds: 300, limits: { minWaitSeconds: 60, maxWaitSeconds: 900, stepSeconds: 30 } });
  assert.deepEqual([slider().min, slider().max, slider().step, slider().value], ['60', '900', '30', '300']);
  assert.equal(sliderLabel().textContent, '5 min');
});

test('the slider stays usable while the switch is off (the wait also governs paired relays), and shows the stored wait', async () => {
  await freshSection({ enabled: false, maxWaitSeconds: 1200 });
  assert.equal(toggle().checked, false);
  assert.equal(toggle().disabled, false);
  assert.equal(slider().disabled, false);
  assert.equal(slider().value, '1200');
  assert.equal(sliderLabel().textContent, '20 min');
});

test('switching on saves, enables the slider and reports it in the status line', async () => {
  await freshSection({ enabled: false });
  let during = null;
  const answer = postResponder;
  postResponder = (body) => {
    // In flight: the switch stays where it was put, nothing can be changed.
    during = { checked: toggle().checked, toggleDisabled: toggle().disabled, sliderDisabled: slider().disabled, status: status().textContent };
    return answer(body);
  };
  await ui.toggleAgentSessions(true);
  assert.deepEqual(requests, [{ method: 'POST', path: '/api/settings/agent-sessions', body: { enabled: true } }]);
  assert.deepEqual(during, { checked: true, toggleDisabled: true, sliderDisabled: true, status: 'Saving…' });
  assert.equal(toggle().checked, true);
  assert.equal(toggle().disabled, false);
  assert.equal(slider().disabled, false);
  assert.equal(status().hidden, false);
  assert.equal(status().dataset.state, 'active');
  assert.equal(status().textContent, 'Agents may start and use sessions on this relay now.');

  await ui.toggleAgentSessions(false);
  assert.equal(toggle().checked, false);
  assert.equal(slider().disabled, false);
  assert.equal(status().textContent, 'Agents can no longer start or use sessions on this relay.');
});

test('a refused switch goes back and the status line says why', async () => {
  await freshSection({ enabled: false });
  postResponder = () => [400, { error: 'Agent sessions need an enabled provider.' }];
  toggle().checked = true;
  await ui.toggleAgentSessions(true);
  assert.equal(toggle().checked, false);
  assert.equal(toggle().disabled, false);
  assert.equal(slider().disabled, false);
  assert.equal(status().dataset.state, 'error');
  assert.equal(status().textContent, 'Agent sessions need an enabled provider.');
});

test('dragging previews the minutes; releasing saves the seconds', async () => {
  await freshSection({ enabled: true, maxWaitSeconds: 600 });
  slider().value = '1500';
  ui.previewAgentSessionsMaxWait(slider().value);
  assert.equal(sliderLabel().textContent, '25 min');
  assert.equal(slider().getAttribute('aria-valuetext'), '25 min');
  assert.deepEqual(requests, [], 'a preview saves nothing');

  let during = null;
  const answer = postResponder;
  postResponder = (body) => {
    during = { value: slider().value, label: sliderLabel().textContent, disabled: slider().disabled };
    return answer(body);
  };
  await ui.saveAgentSessionsMaxWait(slider().value);
  assert.deepEqual(requests, [{ method: 'POST', path: '/api/settings/agent-sessions', body: { maxWaitSeconds: 1500 } }]);
  // The thumb stays where it was dropped while the save runs.
  assert.deepEqual(during, { value: '1500', label: '25 min', disabled: true });
  assert.equal(slider().value, '1500');
  assert.equal(slider().disabled, false);
  assert.equal(sliderLabel().textContent, '25 min');
  assert.equal(status().dataset.state, 'active');
  assert.equal(status().textContent, 'Agents may wait up to 25 min per tool call.');

  // Released where it started: nothing to save.
  requests.length = 0;
  await ui.saveAgentSessionsMaxWait('1500');
  assert.deepEqual(requests, []);
});

test('what is sent is inside the limits; what the relay answers is what shows', async () => {
  await freshSection({ enabled: true, maxWaitSeconds: 600 });
  await ui.saveAgentSessionsMaxWait('99999');
  assert.deepEqual(requests[0].body, { maxWaitSeconds: 3600 });
  assert.equal(sliderLabel().textContent, '60 min');

  // The relay clamps lower than asked.
  postResponder = () => {
    relayState = { ...relayState, maxWaitSeconds: 900 };
    return [200, { ok: true, ...relayState }];
  };
  await ui.saveAgentSessionsMaxWait('1800');
  assert.equal(slider().value, '900');
  assert.equal(sliderLabel().textContent, '15 min');
  assert.equal(status().textContent, 'Agents may wait up to 15 min per tool call.');
});

test('a refused wait puts the slider back and the status line says why', async () => {
  await freshSection({ enabled: true, maxWaitSeconds: 600 });
  postResponder = () => [400, { error: 'maxWaitSeconds must be between 120 and 3600' }];
  slider().value = '2400';
  ui.previewAgentSessionsMaxWait('2400');
  await ui.saveAgentSessionsMaxWait('2400');
  assert.equal(slider().value, '600');
  assert.equal(sliderLabel().textContent, '10 min');
  assert.equal(slider().disabled, false);
  assert.equal(status().dataset.state, 'error');
  assert.equal(status().textContent, 'maxWaitSeconds must be between 120 and 3600');

  // No answer at all: a plain sentence.
  postResponder = () => [500, undefined];
  await ui.saveAgentSessionsMaxWait('2400');
  assert.equal(slider().value, '600');
  assert.equal(status().dataset.state, 'error');
  assert.match(status().textContent, /Request failed \(500\)/);
});

test('the socket event updates the section, without moving a slider in use', async () => {
  await freshSection({ enabled: true, maxWaitSeconds: 600 });
  ui.applyAgentSessionsSettingsState({ ...DEFAULTS, enabled: true, maxWaitSeconds: 1200 });
  assert.equal(slider().value, '1200');
  assert.equal(sliderLabel().textContent, '20 min');
  assert.deepEqual(requests, [], 'an event needs no read');

  // The user holds the slider: the value from elsewhere waits for the blur.
  slider().focus();
  slider().value = '2400';
  ui.previewAgentSessionsMaxWait('2400');
  ui.applyAgentSessionsSettingsState({ ...DEFAULTS, enabled: true, maxWaitSeconds: 300 });
  assert.equal(slider().value, '2400');
  assert.equal(sliderLabel().textContent, '40 min');
  slider().blur();
  assert.equal(slider().value, '300');
  assert.equal(sliderLabel().textContent, '5 min');

  // Switched off on another device.
  ui.applyAgentSessionsSettingsState({ ...DEFAULTS, enabled: false, maxWaitSeconds: 300 });
  assert.equal(toggle().checked, false);
  assert.equal(slider().disabled, false);

  // An event also brings the section up on a page that had hidden it.
  ui.resetAgentSessionsSettingsForTests();
  getResponder = () => [404, undefined];
  await ui.refreshAgentSessionsSection();
  assert.equal(section().hidden, true);
  ui.applyAgentSessionsSettingsState({ ...DEFAULTS, enabled: true });
  assert.equal(section().hidden, false);
  assert.equal(toggle().checked, true);
});

test('reopening the modal clears the last status line', async () => {
  await freshSection({ enabled: false });
  await ui.toggleAgentSessions(true);
  assert.equal(status().hidden, false);
  await ui.refreshAgentSessionsSection();
  assert.equal(status().hidden, true);
  assert.equal(status().textContent, '');
});

// bootstrap.js, settings-modal.js and socket-handlers.js cannot be loaded here
// as a whole, so the three places that wire this section into the app are
// checked in their source.
test('the app wires the section: window handlers, the modal refresh, the socket event', async () => {
  const source = async (name) => readFile(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
  const bootstrap = await source('./bootstrap.js');
  for (const handler of ['toggleAgentSessions', 'previewAgentSessionsMaxWait', 'saveAgentSessionsMaxWait']) {
    assert.equal(typeof ui[handler], 'function');
    assert.ok(bootstrap.includes(`window.${handler} = ${handler};`), `${handler} is exposed on window`);
  }
  assert.match(await source('./settings-modal.js'), /void refreshAgentSessionsSection\(\);/);
  const sockets = await source('./socket-handlers.js');
  assert.match(sockets, /socket\.on\(AGENT_SESSIONS_SOCKET_EVENT, /);
  assert.match(sockets, /applyAgentSessionsSettingsState\(payload\)/);
});
