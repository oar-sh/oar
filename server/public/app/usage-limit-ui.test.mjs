import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Renders against the real index.html so the banner id stays honest.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const ui = await import('./usage-limit-ui.js');

const CONV = 'conv-usage-limit-ui';
const OTHER = 'conv-usage-limit-other';
const inMinutes = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const banner = () => document.getElementById('usage-limit-banner');
const bannerText = () => banner().querySelector('.usage-limit-text')?.textContent || '';
const buttons = () => [...banner().querySelectorAll('button')].map((btn) => btn.textContent);

const pauseFor = (conversationId, overrides = {}) => ({
  conversationId,
  messageId: 'q-held-1',
  rateLimitType: 'five_hour',
  label: '5-hour limit',
  resetsAt: inMinutes(60),
  resumeAt: inMinutes(61),
  auto: true,
  pausedAt: inMinutes(-1),
  ...overrides,
});

const warning = (overrides = {}) => ({
  status: 'allowed_warning',
  rateLimitType: 'five_hour',
  label: '5-hour limit',
  utilization: 0.96,
  resetsAt: inMinutes(90),
  isUsingOverage: false,
  ...overrides,
});

test.beforeEach(() => ui.__resetUsageLimitUiForTests());

test('the banner is in the composer area and hidden with nothing to say', () => {
  assert.equal(banner().parentElement.id, 'input-area');
  ui.setUsageLimitConversation(CONV, { pause: null, providerType: 'claude' });
  assert.equal(banner().hidden, true);
  assert.equal(banner().classList.contains('visible'), false);
});

test('a paused turn says when it carries on, with Resume now and Cancel', () => {
  const pause = pauseFor(CONV);
  ui.setUsageLimitConversation(CONV, { pause, providerType: 'claude' });
  assert.equal(banner().hidden, false);
  assert.equal(banner().dataset.state, 'paused');
  assert.equal(bannerText(), `⏸ Paused at the Claude 5-hour limit — carries on at ${ui.formatUsageLimitTime(pause.resumeAt)}`);
  assert.deepEqual(buttons(), ['Resume now', 'Cancel']);
});

test('a pause of another conversation does not show here', () => {
  ui.setUsageLimitConversation(CONV, { pause: null, providerType: 'claude' });
  ui.applyUsageLimitPause({ conversationId: OTHER, pause: pauseFor(OTHER) });
  assert.equal(banner().hidden, true);
  ui.setUsageLimitConversation(OTHER, { providerType: 'claude' });
  assert.equal(banner().dataset.state, 'paused');
});

test('the socket ends a pause', () => {
  ui.setUsageLimitConversation(CONV, { pause: pauseFor(CONV), providerType: 'claude' });
  ui.applyUsageLimitPause({ conversationId: CONV, pause: null });
  assert.equal(banner().hidden, true);
});

test('a pause that resumes by itself is over once its time has come', () => {
  ui.setUsageLimitConversation(CONV, { pause: pauseFor(CONV, { resetsAt: inMinutes(-2), resumeAt: inMinutes(-1) }), providerType: 'claude' });
  assert.equal(banner().hidden, true);
});

test('a pause that waits for the user stays after the reset', () => {
  const pause = pauseFor(CONV, { rateLimitType: 'seven_day', label: 'weekly limit', auto: false, resumeAt: null, resetsAt: inMinutes(3 * 24 * 60) });
  ui.setUsageLimitConversation(CONV, { pause, providerType: 'claude' });
  assert.equal(bannerText(), `⏸ Paused at the Claude weekly limit — resets ${ui.formatUsageLimitTime(pause.resetsAt)}`);
  ui.setUsageLimitConversation(CONV, { pause: { ...pause, resetsAt: inMinutes(-5) }, providerType: 'claude' });
  assert.equal(bannerText(), '⏸ Paused at the Claude weekly limit — the limit has reset');
  assert.deepEqual(buttons(), ['Resume now', 'Cancel']);
});

test('a warning before the limit shows in a Claude conversation', () => {
  const state = warning();
  ui.setUsageLimitConversation(CONV, { pause: null, providerType: 'claude' });
  ui.applyClaudeUsageLimit(state);
  assert.equal(banner().dataset.state, 'warning');
  assert.equal(bannerText(), `Claude usage at 96 % of the 5-hour limit — resets ${ui.formatUsageLimitTime(state.resetsAt)}`);
  assert.deepEqual(buttons(), ['Hide']);
});

test('a warning does not show in a conversation of another provider', () => {
  ui.applyClaudeUsageLimit(warning());
  ui.setUsageLimitConversation(CONV, { pause: null, providerType: 'github' });
  assert.equal(banner().hidden, true);
});

test('a hidden warning stays hidden until the report changes', () => {
  const state = warning();
  ui.setUsageLimitConversation(CONV, { pause: null, providerType: 'claude' });
  ui.applyClaudeUsageLimit(state);
  banner().querySelector('.usage-limit-dismiss').click();
  assert.equal(banner().hidden, true);
  ui.applyClaudeUsageLimit({ ...state, utilization: 0.98 });
  assert.equal(banner().hidden, true, 'the same window, still a warning');
  ui.applyClaudeUsageLimit({ ...state, status: 'rejected', utilization: 1 });
  assert.equal(banner().dataset.state, 'reached');
  assert.match(bannerText(), /^Claude 5-hour limit reached — resets .+\. A turn sent before that is paused until then\.$/);
});

test('an allowed report, one past its reset or one covered by extra usage says nothing', () => {
  assert.equal(ui.usageLimitAccountText(warning({ status: 'allowed', utilization: 0.4 })), '');
  assert.equal(ui.usageLimitAccountText(warning({ utilization: 0.5 })), '');
  assert.equal(ui.usageLimitAccountText(warning({ resetsAt: inMinutes(-1) })), '');
  assert.equal(ui.usageLimitAccountText(warning({ status: 'rejected', isUsingOverage: true })), '');
  assert.equal(ui.usageLimitAccountText(null), '');
});

test('the pause wins over the account line', () => {
  ui.applyClaudeUsageLimit(warning({ status: 'rejected', utilization: 1 }));
  ui.setUsageLimitConversation(CONV, { pause: pauseFor(CONV), providerType: 'claude' });
  assert.equal(banner().dataset.state, 'paused');
});

test('a status poll replaces what is known', () => {
  ui.setUsageLimitConversation(CONV, { pause: pauseFor(CONV), providerType: 'claude' });
  ui.applyUsageLimitFromStatus({ usageLimit: { account: null, pauses: [] } });
  assert.equal(banner().hidden, true);
  ui.applyUsageLimitFromStatus({ usageLimit: { account: warning(), pauses: [pauseFor(CONV)] } });
  assert.equal(banner().dataset.state, 'paused');
  // An older relay's status has no such field and changes nothing.
  ui.applyUsageLimitFromStatus({ pendingCount: 0 });
  assert.equal(banner().dataset.state, 'paused');
});

test('a time on another day names the day', () => {
  const now = new Date(2026, 8, 28, 21, 0, 0).getTime();
  const today = new Date(2026, 8, 28, 22, 1, 0).toISOString();
  const later = new Date(2026, 9, 1, 9, 0, 0).toISOString();
  assert.equal(ui.formatUsageLimitTime(today, now), new Date(today).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  assert.ok(ui.formatUsageLimitTime(later, now).endsWith(`, ${new Date(later).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`));
  assert.equal(ui.formatUsageLimitTime('', now), '');
});
