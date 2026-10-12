import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
  DEFAULT_SUBAGENT_RECORD_RETENTION_DAYS,
  SUBAGENT_RECORD_RETENTION_CHOICES,
} from '../../../shared/subagent-record-retention.mjs';

// The "Keep sub-agent tool output" select, on the real index.html: its
// choices are the relay's, it starts at the relay's default, and it shows
// the relay's value once that loads. JSDOM does not run the page's scripts.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const { refreshSubagentRecordRetentionSetting, updateSubagentRecordRetentionSetting } = await import('./settings-modal.js');

const select = () => document.getElementById('subagent-record-retention-select');
const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('the select offers the relay\'s choices and starts at its default', () => {
  const values = [...select().options].map((option) => Number(option.value)).sort((a, b) => a - b);
  assert.deepEqual(values, [...SUBAGENT_RECORD_RETENTION_CHOICES].sort((a, b) => a - b));
  assert.equal(select().value, String(DEFAULT_SUBAGENT_RECORD_RETENTION_DAYS));
});

test('the select shows the relay\'s value, and keeps it when a load fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ retentionDays: 14, choices: [0, 7, 14, 30, 90], defaultDays: 90 }));
  await refreshSubagentRecordRetentionSetting();
  assert.equal(select().value, '14');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('relay unreachable'); });
  await refreshSubagentRecordRetentionSetting();
  assert.equal(select().value, '14');
});

test('a change is posted and the relay\'s answer is shown', async (t) => {
  const posted = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    posted.push(JSON.parse(init.body));
    return jsonResponse({ retentionDays: 0, choices: [0, 7, 14, 30, 90], defaultDays: 90 });
  });
  await updateSubagentRecordRetentionSetting('0');
  assert.deepEqual(posted, [{ retentionDays: 0 }]);
  assert.equal(select().value, '0');
  assert.equal(select().disabled, false);
});
