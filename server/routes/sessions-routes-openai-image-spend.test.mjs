import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createPlanUsageService } from '../services/plan-usage-service.mjs';
import { buildOpenAIImagePlanCard } from '../services/plan-usage-openai-image.mjs';
import {
  OPENAI_IMAGE_DAILY_CAP_MAX_USD,
  parseOpenAIImageSpendSettingsRequest,
  parseOpenAISettingsUpdateRequest,
  registerSessionsRoutes,
} from './sessions-routes.mjs';
import { OPENAI_IMAGE_PRESETS_PATH, OPENAI_IMAGE_SPEND_SETTING_KEYS } from '../../shared/openai-image-spend.mjs';
import { OPENAI_IMAGE_PRESETS_SETTING_KEY, OPENAI_IMAGE_PRESET_LIMITS } from '../../shared/openai-image-presets.mjs';
import { asOwner } from '../services/relay-principal-test-harness.mjs';

// The owner's settings of OpenAI image spend (the daily cap and "Allow for
// today" on POST /api/settings/openai), the presets routes, and the OpenAI
// images card of Check Usage. A paired relay's request (its origin header)
// may read but never change any of them.

const NOW = '2026-11-08T10:00:00.000Z';
const TODAY = '2026-11-08';
const PAIRED = Object.freeze({ 'x-oar-remote-origin': 'relay-id-harbour', 'x-oar-remote-hops': '1' });
const OPENAI_ON = Object.freeze({ configured: true, enabled: true, model: 'gpt-image-2', models: ['gpt-image-2'] });

function createMockApp() {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  return { routes, get: record('GET'), post: record('POST'), patch: record('PATCH'), put: record('PUT'), delete: record('DELETE'), use() {} };
}

function setup({ openAISettings = OPENAI_ON, spendState = null, spendThrows = null, day = TODAY, withSpend = true } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const app = createMockApp();
  const emitted = [];
  const notified = [];
  const providerWrites = [];
  const spendAsks = [];
  const clock = { day };
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit: (event, payload) => emitted.push({ event, payload }) },
    db,
    stmts,
    runtimeState: {},
    config: {},
    getOpenAIProviderSettings: () => openAISettings,
    setOpenAIProviderSettings: (parsed) => {
      providerWrites.push(parsed);
      return { ok: true, enabled: openAISettings.enabled, model: openAISettings.model };
    },
    refreshOpenAIProviderModels: async () => ({ ok: true, models: [] }),
    getModelCatalogState: () => ({ models: [] }),
    tokenUsageService: { localDay: () => clock.day, readPeriods: () => ({ groups: [] }) },
    // The relay's own and its paired relays' agents carry the origin header.
    remoteRelayInbound: {},
    planUsageService: createPlanUsageService({ db, now: () => new Date(NOW) }),
    fetchUsageSummary: (callback) => callback(null, { plan: 'copilot_pro' }),
    ...(withSpend ? {
      getOpenAIImageSpendState: async (options) => {
        spendAsks.push(options);
        if (spendThrows) throw new Error(spendThrows);
        return spendState;
      },
      notifyOpenAIImageSpendChanged: () => notified.push(true),
    } : {}),
  });

  const call = async (key, { body = {}, params = {}, query = {}, headers = {} } = {}) => {
    const handler = app.routes.get(key);
    assert.ok(handler, `${key} should be registered`);
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      set() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    await handler(asOwner({ body, headers, query, params, socket: {} }), res);
    return captured;
  };
  const setting = (key) => {
    const row = stmts.getAppSetting.get(key);
    return row ? JSON.parse(row.value) : undefined;
  };
  return { db, stmts, call, setting, emitted, notified, providerWrites, spendAsks, clock };
}

test('the cap fields parse apart from the provider settings', () => {
  assert.deepEqual(parseOpenAIImageSpendSettingsRequest({}), { ok: true, present: false });
  assert.deepEqual(parseOpenAIImageSpendSettingsRequest({ imageDailyCapUsd: 7.456 }), { ok: true, present: true, dailyCapUsd: 7.46 });
  assert.deepEqual(parseOpenAIImageSpendSettingsRequest({ imageDailyCapUsd: '12.5', allowImagesToday: false }), { ok: true, present: true, dailyCapUsd: 12.5, allowToday: false });
  assert.deepEqual(parseOpenAIImageSpendSettingsRequest({ imageDailyCapUsd: null }), { ok: true, present: true, dailyCapUsd: 0 }, 'null is no cap');
  assert.deepEqual(parseOpenAIImageSpendSettingsRequest({ allowImagesToday: true }), { ok: true, present: true, allowToday: true });
  for (const imageDailyCapUsd of [-1, OPENAI_IMAGE_DAILY_CAP_MAX_USD + 1, 'lots', Number.NaN, true, '']) {
    const parsed = parseOpenAIImageSpendSettingsRequest({ imageDailyCapUsd });
    assert.equal(parsed.ok, false, String(imageDailyCapUsd));
    assert.match(parsed.error, /imageDailyCapUsd must be a number of USD from 0 \(no cap\) to 10000/);
  }
  assert.match(parseOpenAIImageSpendSettingsRequest({ allowImagesToday: 'yes' }).error, /allowImagesToday must be true or false/);
  // The provider parser says when nothing of its own was asked for.
  assert.equal(parseOpenAISettingsUpdateRequest({ imageDailyCapUsd: 3 }).empty, true);
});

test('GET /api/settings/openai answers the cap (the default until saved) and today\'s override', async () => {
  const fx = setup();
  const fresh = await fx.call('GET /api/settings/openai');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.imageDailyCapUsd, 5);
  assert.equal(fresh.body.imagesAllowedToday, false);
  assert.equal(fresh.body.imagesAllowedAt, null);
  assert.equal(fresh.body.imageDefaultModel, 'gpt-image-2', 'the other fields as before');

  fx.stmts.upsertAppSetting.run(OPENAI_IMAGE_SPEND_SETTING_KEYS.dailyCapUsd, '0', NOW);
  fx.stmts.upsertAppSetting.run(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideDay, JSON.stringify(TODAY), NOW);
  fx.stmts.upsertAppSetting.run(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideAt, JSON.stringify(NOW), NOW);
  const saved = await fx.call('GET /api/settings/openai');
  assert.equal(saved.body.imageDailyCapUsd, 0, '0 is no cap');
  assert.equal(saved.body.imagesAllowedToday, true);
  assert.equal(saved.body.imagesAllowedAt, NOW);

  // The override ends by itself with the relay's day.
  fx.clock.day = '2026-11-09';
  const tomorrow = await fx.call('GET /api/settings/openai');
  assert.equal(tomorrow.body.imagesAllowedToday, false);
  assert.equal(tomorrow.body.imagesAllowedAt, null);

  // A value that cannot be read is the default, never "no cap".
  fx.stmts.upsertAppSetting.run(OPENAI_IMAGE_SPEND_SETTING_KEYS.dailyCapUsd, 'plenty', NOW);
  assert.equal((await fx.call('GET /api/settings/openai')).body.imageDailyCapUsd, 5);
});

test('POST /api/settings/openai saves the cap and the override alone, then announces them', async () => {
  const fx = setup();
  const capped = await fx.call('POST /api/settings/openai', { body: { imageDailyCapUsd: 12.345 } });
  assert.equal(capped.status, 200, JSON.stringify(capped.body));
  assert.equal(capped.body.ok, true);
  assert.equal(capped.body.imageDailyCapUsd, 12.35);
  assert.equal(fx.setting(OPENAI_IMAGE_SPEND_SETTING_KEYS.dailyCapUsd), 12.35);
  assert.deepEqual(fx.providerWrites, [], 'the provider settings are left alone');
  assert.equal(fx.notified.length, 1);
  const announced = fx.emitted.filter((entry) => entry.event === 'openai_settings_updated');
  assert.equal(announced.length, 1);
  assert.equal(announced[0].payload.imageDailyCapUsd, 12.35);

  const allowed = await fx.call('POST /api/settings/openai', { body: { allowImagesToday: true } });
  assert.equal(allowed.body.imagesAllowedToday, true);
  assert.equal(fx.setting(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideDay), TODAY, 'the relay-local day of the token booking');
  assert.equal(typeof fx.setting(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideAt), 'string');
  assert.equal(allowed.body.imagesAllowedAt, fx.setting(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideAt));

  // A new cap keeps the override.
  await fx.call('POST /api/settings/openai', { body: { imageDailyCapUsd: 20 } });
  assert.equal(fx.setting(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideDay), TODAY);

  const stopped = await fx.call('POST /api/settings/openai', { body: { allowImagesToday: false } });
  assert.equal(stopped.body.imagesAllowedToday, false);
  assert.equal(fx.setting(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideDay), undefined);
  assert.equal(fx.setting(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideAt), undefined);
  assert.equal(fx.notified.length, 4);

  const noCap = await fx.call('POST /api/settings/openai', { body: { imageDailyCapUsd: null } });
  assert.equal(noCap.body.imageDailyCapUsd, 0);

  const bad = await fx.call('POST /api/settings/openai', { body: { imageDailyCapUsd: -2, enabled: true } });
  assert.equal(bad.status, 400);
  assert.equal(fx.providerWrites.length, 0, 'a bad cap stops the whole request');
  assert.equal(fx.setting(OPENAI_IMAGE_SPEND_SETTING_KEYS.dailyCapUsd), 0);
  assert.equal((await fx.call('POST /api/settings/openai', { body: {} })).status, 400, 'still nothing to save');
});

test('the cap fields ride along with a provider change', async () => {
  const fx = setup();
  const both = await fx.call('POST /api/settings/openai', { body: { enabled: true, imageDailyCapUsd: 8 } });
  assert.equal(both.status, 200, JSON.stringify(both.body));
  assert.equal(fx.providerWrites.length, 1);
  assert.equal('imageDailyCapUsd' in fx.providerWrites[0], false, 'the provider setter never sees the cap');
  assert.equal(fx.setting(OPENAI_IMAGE_SPEND_SETTING_KEYS.dailyCapUsd), 8);
  assert.equal(both.body.imageDailyCapUsd, 8);
  assert.equal(fx.notified.length, 1);
  // A provider change alone announces nothing about the cap.
  await fx.call('POST /api/settings/openai', { body: { enabled: true } });
  assert.equal(fx.notified.length, 1);
});

test('a paired relay\'s request cannot lift the cap: 403, nothing written', async () => {
  const fx = setup();
  for (const body of [{ allowImagesToday: true }, { imageDailyCapUsd: 0 }, { imageDailyCapUsd: 9000, enabled: true }]) {
    const refused = await fx.call('POST /api/settings/openai', { body, headers: PAIRED });
    assert.equal(refused.status, 403, JSON.stringify(body));
    assert.match(refused.body.error, /owner's settings alone/);
  }
  assert.equal(fx.setting(OPENAI_IMAGE_SPEND_SETTING_KEYS.dailyCapUsd), undefined);
  assert.equal(fx.setting(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideDay), undefined);
  assert.deepEqual(fx.providerWrites, []);
  assert.deepEqual(fx.notified, []);
  // An origin in the body is a remote request too.
  const viaBody = await fx.call('POST /api/settings/openai', { body: { allowImagesToday: true, origin: { relayId: 'relay-id-harbour', hops: 1 } } });
  assert.equal(viaBody.status, 403);
  // It may read them, and the rest of the route is as before for it.
  assert.equal((await fx.call('GET /api/settings/openai', { headers: PAIRED })).body.imageDailyCapUsd, 5);
  assert.equal((await fx.call('POST /api/settings/openai', { body: { enabled: true }, headers: PAIRED })).status, 200);
});

test('presets: the built-ins and the owner\'s, one change per call', async () => {
  const fx = setup();
  const listed = await fx.call(`GET ${OPENAI_IMAGE_PRESETS_PATH}`);
  assert.deepEqual(listed.body.presets.map((preset) => [preset.name, preset.builtIn]), [
    ['Draft square', true], ['Photo landscape', true], ['Portrait', true], ['Wallpaper 4K', true], ['Sticker', true],
  ]);

  const added = await fx.call(`PUT ${OPENAI_IMAGE_PRESETS_PATH}`, { body: { preset: { name: '  Lantern   sketches ', size: '1024x1536', quality: 'Low' } } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(added.body.presets.at(-1), { name: 'Lantern sketches', size: '1024x1536', quality: 'low', builtIn: false });
  assert.deepEqual(fx.setting(OPENAI_IMAGE_PRESETS_SETTING_KEY), [{ name: 'Lantern sketches', size: '1024x1536', quality: 'low' }]);
  const event = fx.emitted.find((entry) => entry.event === 'openai_image_presets_updated');
  assert.deepEqual(event.payload, { presets: added.body.presets });

  await fx.call(`PUT ${OPENAI_IMAGE_PRESETS_PATH}`, { body: { preset: { name: 'Tide charts', count: 2 } } });
  // The same name again: refused without replace, replaced with it, in place.
  const again = await fx.call(`PUT ${OPENAI_IMAGE_PRESETS_PATH}`, { body: { preset: { name: 'lantern sketches', quality: 'high' } } });
  assert.equal(again.status, 400);
  assert.equal(again.body.code, 'OPENAI_IMAGE_PRESET_REFUSED');
  assert.match(again.body.error, /exists; save with replace/);
  const replaced = await fx.call(`PUT ${OPENAI_IMAGE_PRESETS_PATH}`, { body: { preset: { name: 'lantern sketches', quality: 'high' }, replace: true } });
  assert.deepEqual(fx.setting(OPENAI_IMAGE_PRESETS_SETTING_KEY), [{ name: 'lantern sketches', quality: 'high' }, { name: 'Tide charts', count: 2 }]);
  assert.equal(replaced.body.presets.length, 7);

  for (const [body, pattern] of [
    [{ preset: { name: 'Sticker', size: '1024x1024' } }, /built-in preset/],
    [{ preset: { name: 'Empty' } }, /needs at least one of/],
    [{ preset: { name: 'Bad size', size: '1000x1000' } }, /multiples of 16/],
    [{ preset: { name: 'x'.repeat(41), quality: 'low' } }, /at most 40 characters/],
    [{}, /a preset is an object/],
  ]) {
    const refused = await fx.call(`PUT ${OPENAI_IMAGE_PRESETS_PATH}`, { body });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.body.code, 'OPENAI_IMAGE_PRESET_REFUSED');
    assert.match(refused.body.error, pattern);
  }

  const deleted = await fx.call(`DELETE ${OPENAI_IMAGE_PRESETS_PATH}/:name`, { params: { name: 'TIDE CHARTS' } });
  assert.equal(deleted.status, 200);
  assert.deepEqual(fx.setting(OPENAI_IMAGE_PRESETS_SETTING_KEY), [{ name: 'lantern sketches', quality: 'high' }]);
  const builtIn = await fx.call(`DELETE ${OPENAI_IMAGE_PRESETS_PATH}/:name`, { params: { name: 'Portrait' } });
  assert.equal(builtIn.status, 400);
  assert.match(builtIn.body.error, /built-in preset cannot be deleted/);
  const missing = await fx.call(`DELETE ${OPENAI_IMAGE_PRESETS_PATH}/:name`, { params: { name: 'Tide charts' } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /no own preset "Tide charts"/);
});

test('presets: the limit holds, a broken stored list reads as what still passes, a paired relay only reads', async () => {
  const fx = setup();
  const many = Array.from({ length: OPENAI_IMAGE_PRESET_LIMITS.ownMax }, (_, index) => ({ name: `Shelf ${index + 1}`, count: 1 }));
  fx.stmts.upsertAppSetting.run(OPENAI_IMAGE_PRESETS_SETTING_KEY, JSON.stringify([...many, { name: 'Sticker', count: 1 }, 'junk']), NOW);
  assert.equal((await fx.call(`GET ${OPENAI_IMAGE_PRESETS_PATH}`)).body.presets.length, 5 + OPENAI_IMAGE_PRESET_LIMITS.ownMax);
  const full = await fx.call(`PUT ${OPENAI_IMAGE_PRESETS_PATH}`, { body: { preset: { name: 'One more', count: 1 } } });
  assert.equal(full.status, 400);
  assert.match(full.body.error, /at most 30 own presets/);

  fx.stmts.upsertAppSetting.run(OPENAI_IMAGE_PRESETS_SETTING_KEY, '{not json', NOW);
  assert.equal((await fx.call(`GET ${OPENAI_IMAGE_PRESETS_PATH}`)).body.presets.length, 5);

  const before = fx.stmts.getAppSetting.get(OPENAI_IMAGE_PRESETS_SETTING_KEY).value;
  const put = await fx.call(`PUT ${OPENAI_IMAGE_PRESETS_PATH}`, { body: { preset: { name: 'Harbour', quality: 'low' } }, headers: PAIRED });
  const del = await fx.call(`DELETE ${OPENAI_IMAGE_PRESETS_PATH}/:name`, { params: { name: 'Harbour' }, headers: PAIRED });
  assert.equal(put.status, 403);
  assert.equal(del.status, 403);
  assert.equal(fx.stmts.getAppSetting.get(OPENAI_IMAGE_PRESETS_SETTING_KEY).value, before, 'nothing written');
  assert.equal((await fx.call(`GET ${OPENAI_IMAGE_PRESETS_PATH}`, { headers: PAIRED })).status, 200);
});

const SPEND = Object.freeze({
  day: TODAY,
  capUsd: 5,
  spentUsd: 4.1,
  reservedUsd: 0.2,
  estimatedUsd: 0.3,
  unknownPriceUsd: 0,
  monthUsd: 31.75,
  ratio: 0.86,
  warning: true,
  reached: false,
  allowedToday: false,
  allowedAt: null,
});

test('Check Usage gets an OpenAI images card from the spend state', async () => {
  const fx = setup({ spendState: { ...SPEND, conversation: { costUsd: 0.5, estimatedUsd: 0, images: 3, tries: 3 } } });
  const res = await fx.call('GET /api/usage', { query: { conversationId: 'conv-lantern' } });
  assert.equal(res.status, 200);
  assert.deepEqual(fx.spendAsks, [{ conversationId: 'conv-lantern' }]);
  const card = res.body.providers.find((entry) => entry.label === 'OpenAI images');
  assert.ok(card, JSON.stringify(res.body.providers.map((entry) => entry.provider)));
  assert.equal(card.provider, 'openai');
  assert.equal(card.status, 'ok');
  assert.equal(card.meters[0].id, 'openai-images-daily-cap');
  assert.equal(card.meters[0].used, 4.3);
  assert.equal(card.meters[0].allowance, 5);
  assert.equal(card.meters[0].remaining, 0.7);
  assert.equal(card.meters[0].severity, 'warning');
  assert.match(card.message, /at 86 % of the daily cap of USD 5\.00/);
  const notes = Object.fromEntries(card.notes.filter((note) => note.label).map((note) => [note.id, note]));
  assert.equal(notes['openai-images-today'].value, 'USD 4.30');
  assert.match(notes['openai-images-today'].hint, /USD 0\.20 in progress · USD 0\.30 estimated/);
  assert.equal(notes['openai-images-month'].value, 'USD 31.75');
  assert.equal(notes['openai-images-override'].value, 'off');
  assert.equal(notes['openai-images-this-chat'].value, 'USD 0.50');
  assert.equal(notes['openai-images-this-chat'].hint, '3 images');
  assert.deepEqual(card.imageSpend.capUsd, 5, 'the raw state for the cap bar');
  assert.equal(JSON.stringify(card).includes('$'), false, 'money as USD, never a dollar sign');
});

test('the OpenAI images card: reached, allowed, no cap, unreadable, and none while OpenAI is off and idle', async () => {
  const reached = buildOpenAIImagePlanCard({ state: { ...SPEND, spentUsd: 5.2, reservedUsd: 0, reached: true }, configured: true });
  assert.match(reached.message, /new image turns are refused until tomorrow \(relay time\)/);
  assert.equal(reached.meters[0].remaining, 0);
  assert.equal(reached.meters[0].severity, 'reached');
  const allowed = buildOpenAIImagePlanCard({ state: { ...SPEND, spentUsd: 5.2, reached: true, allowedToday: true, allowedAt: NOW }, configured: true });
  assert.match(allowed.message, /run anyway, because the owner allowed them for today/);
  assert.equal(allowed.notes.find((note) => note.id === 'openai-images-override').value, 'on');
  const uncapped = buildOpenAIImagePlanCard({ state: { ...SPEND, capUsd: null, ratio: null, warning: false }, configured: true });
  assert.deepEqual(uncapped.meters, []);
  assert.match(uncapped.message, /No daily cap/);
  assert.equal(buildOpenAIImagePlanCard({ state: { ...SPEND, spentUsd: 0, reservedUsd: 0, monthUsd: 0 }, configured: false }), null);
  assert.ok(buildOpenAIImagePlanCard({ state: { ...SPEND, spentUsd: 0, reservedUsd: 0 }, configured: false }), 'spend this month shows it after OpenAI was switched off');

  const fx = setup({ spendThrows: 'database is locked' });
  const res = await fx.call('GET /api/usage');
  const card = res.body.providers.find((entry) => entry.provider === 'openai');
  assert.equal(card.status, 'unavailable');
  assert.match(card.message, /could not be read: database is locked/);
  // Without the seam (older wiring), no card.
  const older = setup({ withSpend: false });
  assert.equal((await older.call('GET /api/usage')).body.providers.some((entry) => entry.provider === 'openai'), false);
});
