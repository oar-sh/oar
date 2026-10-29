import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OAR_REPO_URL,
  OAR_SITE_URL,
  aboutMenuLabel,
  buildAboutModalHtml,
  formatAmount,
  formatBytes,
  formatUptime,
} from './about-view.mjs';

const fixedDates = {
  formatDateTime: (iso) => `at ${iso}`,
  formatDate: (iso) => `on ${iso.slice(0, 10)}`,
};

function aboutPayload(overrides = {}) {
  return {
    version: '1.2.3',
    commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    installMethod: 'git-checkout',
    startedAt: '2026-03-02T11:00:00.000Z',
    uptimeSeconds: 3_700,
    providers: [
      { id: 'github', label: 'GitHub Copilot', engine: 'extension', cliVersion: '1.0.82', sdkVersion: null, state: 'online', runningWorkers: 0 },
      { id: 'claude', label: 'Claude Code', engine: null, cliVersion: '2.1.251', sdkVersion: '0.3.292', state: 'idle', runningWorkers: 0 },
      { id: 'cursor', label: 'Cursor', engine: null, cliVersion: null, sdkVersion: '1.0.36', state: 'online', runningWorkers: 2 },
    ],
    stats: {
      conversations: 1234,
      archivedConversations: 12,
      firstConversationAt: '2026-01-05T09:00:00.000Z',
      messages: 56789,
      turns: 20000,
      turnsByProvider: [{ id: 'github', label: 'GitHub Copilot', turns: 15000 }, { id: 'claude', label: 'Claude Code', turns: 5000 }],
    },
    usage: {
      github: { premiumRequests: 321.5, turns: 300 },
      cursor: { inputTokens: 120000, outputTokens: 30000, cacheReadTokens: 5000, cacheWriteTokens: 0, totalTokens: 155000, runs: 40, rawCostUsd: 3.5, chargedUsd: 0 },
    },
    relay: { uptimeSeconds: 3_700, dbBytes: 300 * 1024 * 1024, dbFileBytes: 290 * 1024 * 1024, walBytes: 10 * 1024 * 1024, runningWorkers: 2 },
    update: { checkEnabled: false, checkKilled: false, available: false, latestVersion: null, notesUrl: null, lastCheckedAt: null },
    ...overrides,
  };
}

test('the menu label carries the running version when it is known', () => {
  assert.equal(aboutMenuLabel('0.9.10'), 'ℹ️ About OAR · 0.9.10');
  assert.equal(aboutMenuLabel(''), 'ℹ️ About OAR');
  assert.equal(aboutMenuLabel('0.0.0'), 'ℹ️ About OAR', 'the unknown-version placeholder is not shown');
});

test('formatters', () => {
  assert.equal(formatUptime(42), '42 s');
  assert.equal(formatUptime(3_700), '1 h 1 min');
  assert.equal(formatUptime(3 * 86_400 + 4 * 3_600), '3 d 4 h');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(300 * 1024 * 1024), '300 MB');
  assert.equal(formatBytes(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(formatAmount(1234), '1,234');
  assert.equal(formatAmount(155000), '155.0 k');
  assert.equal(formatAmount(4_560_000), '4.56 M');
});

test('the modal shows every section, the short commit and the links', () => {
  const html = buildAboutModalHtml(aboutPayload(), fixedDates);
  for (const id of ['build', 'providers', 'activity', 'usage', 'relay', 'update', 'links']) {
    assert.match(html, new RegExp(`data-about-section="${id}"`), `section ${id}`);
  }
  assert.match(html, /<code>a1b2c3d<\/code>/);
  assert.match(html, /at 2026-03-02T11:00:00.000Z/);
  assert.match(html, /since on 2026-01-05/);
  assert.match(html, /1,234/);
  assert.match(html, /12 archived/);
  assert.match(html, /Turns on Claude Code/);
  assert.match(html, /CLI 2\.1\.251 · SDK 0\.3\.292/);
  assert.match(html, /data-state="online">online<\/span> · 2 workers/);
  assert.match(html, /Premium requests/);
  assert.match(html, /USD 3\.50/);
  assert.match(html, /300 MB/);
  for (const href of [OAR_REPO_URL, OAR_SITE_URL]) {
    assert.match(html, new RegExp(`href="${href.replace(/[.]/g, '\\.')}" target="_blank" rel="noopener"`));
  }
});

test('a build without a commit and a relay without providers or usage still render', () => {
  const html = buildAboutModalHtml(aboutPayload({ commit: null, providers: [], usage: {} }), fixedDates);
  assert.doesNotMatch(html, />Commit</);
  assert.match(html, /No provider is turned on/);
  assert.match(html, /No provider has reported usage yet/);
});

test('update facts show only while the check is on, else how to turn it on', () => {
  const off = buildAboutModalHtml(aboutPayload(), fixedDates);
  assert.match(off, /Update checks are off/);
  assert.match(off, /data-about-open-settings/);
  const available = buildAboutModalHtml(aboutPayload({
    update: { checkEnabled: true, available: true, latestVersion: '1.3.0', notesUrl: 'https://example.test/notes', lastCheckedAt: '2026-03-02T08:00:00.000Z' },
  }), fixedDates);
  assert.match(available, /Latest: 1\.3\.0/);
  assert.match(available, /href="https:\/\/example\.test\/notes" target="_blank" rel="noopener"/);
  assert.doesNotMatch(available, /Update checks are off/);
  const current = buildAboutModalHtml(aboutPayload({
    update: { checkEnabled: true, available: false, latestVersion: null, lastCheckedAt: '2026-03-02T08:00:00.000Z' },
  }), fixedDates);
  assert.match(current, /Up to date, checked at 2026-03-02T08:00:00\.000Z/);
  const killed = buildAboutModalHtml(aboutPayload({ update: { checkEnabled: false, checkKilled: true } }), fixedDates);
  assert.match(killed, /OAR_NO_UPDATE_CHECK/);
});

test('provider and version text is escaped', () => {
  const html = buildAboutModalHtml(aboutPayload({
    version: '<b>1</b>',
    providers: [{ id: 'grok', label: '<img src=x>', cliVersion: '"1"', state: 'idle' }],
  }), fixedDates);
  assert.doesNotMatch(html, /<b>1<\/b>|<img src=x>/);
  assert.match(html, /&lt;b&gt;1&lt;\/b&gt;/);
});

test('the Database row shows the file the relay runs on with its size', () => {
  for (const dbPath of ['/home/dev/oar/server/data/oar.db', '/home/dev/.oar/data/copilot.db']) {
    const html = buildAboutModalHtml(aboutPayload({ relay: { ...aboutPayload().relay, dbPath } }), fixedDates);
    assert.match(html, new RegExp(`${dbPath.replace(/[.]/g, '\\.')} · 300 MB`), dbPath);
    assert.match(html, /290 MB \+ 10\.0 MB WAL/);
  }
  assert.match(buildAboutModalHtml(aboutPayload(), fixedDates), />300 MB</, 'no path known: the size alone');
});

test('the Backups row: the last one with its time and size, or why there was none; kept of N and the folder', () => {
  const base = { enabled: true, keep: 2, dir: '/home/dev/.oar/backups', problem: null, kept: 1 };
  const html = (backups) => buildAboutModalHtml(aboutPayload({ backups }), fixedDates);
  assert.match(html({ ...base, lastResult: { status: 'written', at: '2026-11-03T09:15:00.000Z', bytes: 351 * 1024 * 1024 } }),
    /<span>Backups<\/span><span class="plan-usage-detail-hint">1 kept of 2 · \/home\/dev\/\.oar\/backups<\/span>.*at 2026-11-03T09:15:00\.000Z · 351 MB/);
  assert.match(html({ ...base, lastResult: { status: 'skipped', at: '2026-11-03T09:15:00.000Z', reason: 'not enough disk space' } }), /skipped at 2026-11-03T09:15:00\.000Z: not enough disk space/);
  assert.match(html({ ...base, lastResult: { status: 'failed', at: '2026-11-03T09:15:00.000Z', reason: 'disk I/O error' } }), /failed at .*: disk I\/O error/);
  assert.match(html({ ...base, lastResult: { status: 'busy', at: '2026-11-03T09:15:00.000Z', reason: 'another backup of this database is running (process 4242)' } }), /busy at .*: another backup of this database is running \(process 4242\)/);
  assert.match(html({ ...base, lastResult: null }), /none yet/);
  assert.match(html({ ...base, enabled: false, lastResult: null }), /at start: off \(dbBackups\.enabled\); 1 kept of 2/);
  assert.match(html({ ...base, problem: 'dbBackups.dir in config.json must be an absolute path (it is "x")', lastResult: null }), /1 kept of 2 · dbBackups\.dir in config\.json must be an absolute path \(it is &quot;x&quot;\)/);
  assert.doesNotMatch(buildAboutModalHtml(aboutPayload(), fixedDates), /Backups/, 'no backups known: no row');
});

test('the Backups hint has no dangling separator when there is no folder', () => {
  const html = buildAboutModalHtml(aboutPayload({ backups: { enabled: true, keep: 2, dir: null, problem: null, kept: 0, lastResult: null } }), fixedDates);
  assert.match(html, /<span class="plan-usage-detail-hint">0 kept of 2<\/span>/);
});

test('the usage section names every provider\'s tokens of all time, "—" where a kind is unknown, an own key apart', () => {
  const nb = (text) => text.replace(/ /g, '\u00a0');
  const html = buildAboutModalHtml(aboutPayload({
    usage: {
      github: {
        premiumRequests: 321.5,
        turns: 300,
        tokens: { inputTokens: 70_000, outputTokens: 7_000, cacheWriteTokens: 0, cacheReadTokens: 1_200_000, since: '2026-10-02', backfilled: false, firstTurnsDay: '2026-10-02' },
        ownKeyTokens: [{ billing: 'byok-openai', inputTokens: 40, outputTokens: 4, cacheWriteTokens: null, cacheReadTokens: 60, since: '2026-10-03', backfilled: false, firstTurnsDay: '2026-10-03' }],
      },
      'claude-api': { tokens: { inputTokens: 510, outputTokens: 55, cacheWriteTokens: 300, cacheReadTokens: 4_900, since: '2026-09-14', backfilled: true, firstTurnsDay: '2026-10-02' } },
      deepseek: { tokens: { inputTokens: 2_000, outputTokens: 800, cacheWriteTokens: null, cacheReadTokens: 7_000, since: '2026-09-18', backfilled: true, firstTurnsDay: null } },
      grok: { tokens: { inputTokens: null, outputTokens: null, cacheWriteTokens: null, cacheReadTokens: null, since: null, backfilled: false, firstTurnsDay: null } },
    },
  }), fixedDates);
  const usage = html.slice(html.indexOf('data-about-section="usage"'));
  assert.match(usage, /GitHub Copilot<\/div>.*Premium requests.*Tokens \(all time\)<\/span><span class="plan-usage-detail-hint">in 70.0 k · out 7,000 · cache w 0 · cache r 1.20 M · since /s);
  // The date as Check Usage writes it, never broken on a phone.
  assert.ok(usage.includes(`since ${nb('Oct 2, 2026')}</span>`), 'the first day, unbroken');
  assert.match(usage, /<td class="plan-usage-detail-value"><span class="plan-usage-detail-part">1.28 M<\/span><\/td>/);
  assert.match(usage, /Tokens \(all time\), own OpenAI key<\/span><span class="plan-usage-detail-hint">in 40 · out 4 · cache w — · cache r 60 · since /);
  // Copied days: until the first counted turn, input holds cache writes.
  assert.ok(usage.includes(`since ${nb('Sep 14, 2026')} · input includes cache writes before ${nb('Oct 2, 2026')}</span>`), 'Claude API: copied days dated');
  assert.ok(usage.includes(`cache w — · cache r 7,000 · since ${nb('Sep 18, 2026')} · input includes cache writes (days from before the upgrade)</span>`), 'DeepSeek: copied days only');
  // Nothing known at all: the total is unknown too, not 0.
  assert.match(usage, /Grok<\/div>.*cache w — · cache r —<\/span><\/div><\/td><td class="plan-usage-detail-value"><span class="plan-usage-detail-part">—<\/span><\/td>/s);
  assert.doesNotMatch(usage, /keep no usage here|where the provider does not report one/);
  assert.match(usage, /"—" where no turn reported one\. On Claude API and DeepSeek the days from before the upgrade have cache writes inside input\./);
});
