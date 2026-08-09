'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCursorDashboardUsageFetcher,
  defaultCursorStateDbPath,
  normalizeCursorDashboardUsage,
  readCursorIdeSessionToken,
  sessionTokenFromAccessToken,
} from './cursor-dashboard-usage.mjs';
import { buildCursorPlanCard } from './plan-usage-cursor.mjs';

// Shape documented from the live dashboard endpoint (unix-ms string dates,
// cents, percentages 0-100).
const PERIOD_USAGE_PAYLOAD = {
  billingCycleStart: '1768399334000',
  billingCycleEnd: '1771077734000',
  planUsage: {
    totalSpend: 23222,
    includedSpend: 23222,
    bonusSpend: 0,
    remaining: 16778,
    limit: 40000,
    autoPercentUsed: 1,
    apiPercentUsed: 35,
    totalPercentUsed: 7,
  },
  spendLimitUsage: {
    totalSpend: 0,
    individualLimit: 10000,
    individualUsed: 0,
    limitType: 'user',
  },
  displayMessage: "You've used 7% of your usage limit",
};

test('normalizeCursorDashboardUsage reads the get-current-period-usage shape', () => {
  const usage = normalizeCursorDashboardUsage(PERIOD_USAGE_PAYLOAD);
  assert.ok(usage);
  assert.equal(usage.totalPercentUsed, 7);
  assert.equal(usage.autoPercentUsed, 1);
  assert.equal(usage.apiPercentUsed, 35);
  assert.equal(usage.includedSpendCents, 23222);
  assert.equal(usage.limitCents, 40000);
  assert.equal(usage.billingCycleStart, new Date(1768399334000).toISOString());
  assert.equal(usage.billingCycleEnd, new Date(1771077734000).toISOString());
  assert.equal(usage.onDemand.limitCents, 10000);
});

test('normalizeCursorDashboardUsage reads the older usage-summary shape', () => {
  const usage = normalizeCursorDashboardUsage({
    billingCycleStart: '2026-04-02T14:11:55.000Z',
    billingCycleEnd: '2026-05-02T14:11:55.000Z',
    membershipType: 'ultra',
    individualUsage: {
      plan: { autoPercentUsed: 0, apiPercentUsed: 100, totalPercentUsed: 100, limit: 2000 },
      onDemand: { used: 2309, limit: null },
    },
  });
  assert.equal(usage.totalPercentUsed, 100);
  assert.equal(usage.membershipType, 'ultra');
  assert.equal(usage.billingCycleEnd, '2026-05-02T14:11:55.000Z');
  assert.equal(usage.onDemand.usedCents, 2309);
});

test('normalizeCursorDashboardUsage returns null when nothing usable is present', () => {
  assert.equal(normalizeCursorDashboardUsage(null), null);
  assert.equal(normalizeCursorDashboardUsage({}), null);
  assert.equal(normalizeCursorDashboardUsage({ planUsage: {} }), null);
});

test('fetcher sends the session cookie and Origin, degrades to null on failure', async () => {
  let seen = null;
  const fetcher = createCursorDashboardUsageFetcher({
    getSessionToken: () => 'user123%3A%3Ajwt',
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return { ok: true, json: async () => PERIOD_USAGE_PAYLOAD };
    },
  });
  const usage = await fetcher();
  assert.equal(usage.totalPercentUsed, 7);
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.headers.Cookie, 'WorkosCursorSessionToken=user123%3A%3Ajwt');
  assert.equal(seen.options.headers.Origin, 'https://cursor.com');

  const noToken = createCursorDashboardUsageFetcher({
    getSessionToken: () => '',
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(await noToken(), null);

  const expired = createCursorDashboardUsageFetcher({
    getSessionToken: () => 't',
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  assert.equal(await expired(), null);
});

function makeJwt(payload) {
  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${encode({ alg: 'RS256' })}.${encode(payload)}.signature`;
}

test('sessionTokenFromAccessToken builds the cookie from the JWT sub claim', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const jwt = makeJwt({ sub: 'google-oauth2|user_01ABC', exp: future });
  assert.equal(sessionTokenFromAccessToken(jwt), `user_01ABC%3A%3A${jwt}`);

  const noPrefix = makeJwt({ sub: 'user_plain', exp: future });
  assert.equal(sessionTokenFromAccessToken(noPrefix), `user_plain%3A%3A${noPrefix}`);

  // Expired, malformed, or sub-less tokens are unusable.
  assert.equal(sessionTokenFromAccessToken(makeJwt({ sub: 'u', exp: 1 })), null);
  assert.equal(sessionTokenFromAccessToken(makeJwt({ exp: future })), null);
  assert.equal(sessionTokenFromAccessToken('not-a-jwt'), null);
  assert.equal(sessionTokenFromAccessToken(''), null);
});

test('readCursorIdeSessionToken reads state.vscdb in place and never throws', () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const jwt = makeJwt({ sub: 'auth0|user_9', exp: future });
  const fsImpl = { existsSync: () => true };
  const opened = [];
  const token = readCursorIdeSessionToken({
    stateDbPath: 'X:/fake/state.vscdb',
    fsImpl,
    loadDatabase: (file) => {
      opened.push(file);
      return {
        prepare: () => ({ get: () => ({ value: jwt }) }),
        close: () => {},
      };
    },
  });
  assert.equal(token, `user_9%3A%3A${jwt}`);
  // Opened in place — the multi-GB db must never be copied.
  assert.deepEqual(opened, ['X:/fake/state.vscdb']);

  assert.equal(readCursorIdeSessionToken({
    stateDbPath: 'X:/missing.vscdb',
    fsImpl: { existsSync: () => false },
  }), null);

  assert.equal(readCursorIdeSessionToken({
    stateDbPath: 'X:/fake/state.vscdb',
    fsImpl,
    loadDatabase: () => { throw new Error('database is locked'); },
  }), null);
});

test('defaultCursorStateDbPath resolves per platform', () => {
  assert.match(
    defaultCursorStateDbPath({ platform: 'win32', env: { APPDATA: 'C:/Users/x/AppData/Roaming' }, homeDir: 'C:/Users/x' }),
    /Cursor[\\/]User[\\/]globalStorage[\\/]state\.vscdb$/,
  );
  assert.match(
    defaultCursorStateDbPath({ platform: 'linux', env: {}, homeDir: '/home/x' }),
    /^[\\/]home[\\/]x[\\/]\.config[\\/]Cursor/,
  );
});

test('fetcher prefers the manual token and falls back to the cached IDE login', async () => {
  let ideReads = 0;
  let seenCookie = null;
  const makeFetcher = (manualToken) => createCursorDashboardUsageFetcher({
    getSessionToken: () => manualToken,
    readIdeTokenImpl: () => {
      ideReads += 1;
      return 'ide-user%3A%3Aide-jwt';
    },
    fetchImpl: async (_url, options) => {
      seenCookie = options.headers.Cookie;
      return { ok: true, json: async () => PERIOD_USAGE_PAYLOAD };
    },
  });

  await makeFetcher('manual-token')();
  assert.equal(seenCookie, 'WorkosCursorSessionToken=manual-token');
  assert.equal(ideReads, 0);

  const ideFetcher = makeFetcher('');
  await ideFetcher();
  await ideFetcher();
  assert.equal(seenCookie, 'WorkosCursorSessionToken=ide-user%3A%3Aide-jwt');
  // Cached: the multi-MB state.vscdb copy happens once, not per request.
  assert.equal(ideReads, 1);
});

test('buildCursorPlanCard renders live percent bars with the reset date', () => {
  const card = buildCursorPlanCard({
    configured: true,
    dashboard: normalizeCursorDashboardUsage(PERIOD_USAGE_PAYLOAD),
  });
  assert.equal(card.source, 'live');
  assert.equal(card.status, 'ok');
  const total = card.meters.find((m) => m.id === 'cursor-plan-total');
  assert.equal(total.unit, 'percent');
  assert.equal(total.utilization, 7);
  assert.equal(total.estimated, false);
  assert.equal(total.resetAt, new Date(1771077734000).toISOString());
  assert.equal(card.meters.find((m) => m.id === 'cursor-plan-auto').utilization, 1);
  assert.equal(card.meters.find((m) => m.id === 'cursor-plan-api').utilization, 35);
  const planSection = card.details.find((d) => d.id === 'cursor-plan');
  assert.ok(planSection.rows.some((row) => row.label === 'Included spend' && row.value === '$232.22'));
});

test('buildCursorPlanCard keeps the manual view when no dashboard data exists', () => {
  const card = buildCursorPlanCard({ configured: true, dashboard: null });
  assert.equal(card.source, 'manual');
  assert.ok(!card.meters.some((m) => m.id === 'cursor-plan-total'));
});

test('buildCursorPlanCard explains why live bars are missing', () => {
  // Hosts without a Cursor install (the Linux relay) have no IDE login to
  // read, so the card has to point at the manual token instead of showing a
  // bare $0.00 panel.
  const noToken = buildCursorPlanCard({
    configured: true,
    dashboard: null,
    dashboardAuth: { configured: false, source: null },
  });
  assert.match(noToken.message, /no Cursor IDE login/);
  assert.match(noToken.message, /CURSOR_SESSION_TOKEN/);

  // The rejected-token wording names the token's actual source: a stored
  // token expires, but an IDE-derived one means the IDE login went stale.
  const rejected = buildCursorPlanCard({
    configured: true,
    dashboard: null,
    dashboardAuth: { configured: true, source: 'manual' },
  });
  assert.match(rejected.message, /stored dashboard token/);
  assert.match(rejected.message, /expired/);

  const ideRejected = buildCursorPlanCard({
    configured: true,
    dashboard: null,
    dashboardAuth: { configured: true, source: 'ide' },
  });
  assert.match(ideRejected.message, /Cursor IDE login/);
  assert.ok(!/stored dashboard token/.test(ideRejected.message));

  const envRejected = buildCursorPlanCard({
    configured: true,
    dashboard: null,
    dashboardAuth: { configured: true, source: 'env' },
  });
  assert.match(envRejected.message, /CURSOR_SESSION_TOKEN/);

  // Live data present, or auth state unknown: no nagging.
  const live = buildCursorPlanCard({
    configured: true,
    dashboard: normalizeCursorDashboardUsage(PERIOD_USAGE_PAYLOAD),
    dashboardAuth: { configured: false, source: null },
  });
  assert.ok(!/CURSOR_SESSION_TOKEN/.test(live.message || ''));
  assert.ok(!/CURSOR_SESSION_TOKEN/.test(buildCursorPlanCard({ configured: true }).message || ''));
});

test('local pool estimates step back to secondary next to live bars', () => {
  const card = buildCursorPlanCard({
    configured: true,
    dashboard: normalizeCursorDashboardUsage(PERIOD_USAGE_PAYLOAD),
    allowances: { cursorModelsUsd: 20, otherModelsUsd: null, resetDay: 1 },
  });
  const pool = card.meters.find((m) => m.id === 'cursor-cursor');
  assert.equal(pool.emphasis, 'secondary');
});