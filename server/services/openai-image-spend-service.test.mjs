import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createTokenUsageService } from './token-usage-service.mjs';
import {
  createOpenAIImageSpendService,
  openAIImageCapRefusalText,
  openAIImageRecoveredRunId,
  openAIImageTryCharge,
  openAIImageTryRunId,
} from './openai-image-spend-service.mjs';
import { OPENAI_IMAGE_COST_SOURCES, OPENAI_IMAGE_USAGE_EVENT } from '../../shared/openai-image-spend.mjs';
import { estimateOpenAIImageCost, openAIImageCostFloor } from '../../shared/openai-image-prices.mjs';

const silent = { warn() {}, log() {} };
const REQUEST = Object.freeze({ model: 'gpt-image-2', size: '1024x1024', quality: 'high', count: 1, inputImages: 0 });
const USAGE = Object.freeze({ input_tokens: 40, input_tokens_details: { text_tokens: 40, image_tokens: 0 }, output_tokens: 7024 });

function setup({ at = '2026-11-08T10:00:00.000Z', settings = {}, tokenUsage = true } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const clock = { ms: Date.parse(at) };
  const store = { ...settings };
  const tokens = createTokenUsageService({ db, now: () => clock.ms, timeZone: 'UTC', logger: silent });
  const events = [];
  const spend = createOpenAIImageSpendService({
    tokenUsageService: tokenUsage === true ? tokens : tokenUsage,
    readSetting: (key) => store[key] ?? '',
    db,
    emit: (event, payload) => events.push({ event, payload }),
    now: () => clock.ms,
    timeZone: 'UTC',
    logger: silent,
  });
  return { db, clock, store, tokens, spend, events };
}

const turnRows = (db) => db.prepare(`SELECT * FROM turn_token_usage ORDER BY turn_id, run_id`).all().map((row) => ({ ...row }));
const dayRows = (db) => db.prepare(`SELECT * FROM token_usage_days ORDER BY day, model`).all().map((row) => ({ ...row }));

function bookTry(spend, { turnId = 'q-1', scope = 'claim-a', n = 1, tried, request = REQUEST, conversationId = 'conv-1' }) {
  const reserved = spend.reserveTry({ estimateUsd: estimateOpenAIImageCost(request).costUsd });
  assert.equal(reserved.ok, true);
  return spend.settleTry(reserved.reservation, {
    conversationId,
    turnId,
    runId: openAIImageTryRunId(scope, n),
    model: request.model,
    charge: openAIImageTryCharge({ tried, request }),
  });
}

test('per kind: real usage whenever read, else the estimate for the kinds that may be billed, nothing for the rest', () => {
  const charge = (tried) => openAIImageTryCharge({ tried, request: REQUEST });
  const estimate = estimateOpenAIImageCost(REQUEST).costUsd;
  // A completed reply, a stream that broke after completed events, a 2xx the relay could not read: the usage.
  for (const tried of [
    { ok: true, usage: USAGE },
    { kind: 'stream', usage: USAGE, partials: 2 },
    { kind: 'unprocessed', usage: USAGE },
    { kind: 'timeout', usage: USAGE },
  ]) {
    const got = charge(tried);
    assert.equal(got.basis, 'usage', JSON.stringify(tried));
    assert.equal(got.costSource, OPENAI_IMAGE_COST_SOURCES.table);
    assert.equal(got.outputTokens, 7024);
    assert.ok(Math.abs(got.costUsd - (40 * 5 + 7024 * 30) / 1e6) < 1e-9);
  }
  for (const tried of [
    { kind: 'timeout' },
    { kind: 'broken' },
    { kind: 'stream' },
    { kind: 'unprocessed', status: 200 },
    { kind: 'server', status: 503 },
    { kind: 'server', message: 'stream server error' },
    { kind: 'refused', status: 400, streamed: true },
  ]) {
    const got = charge(tried);
    assert.equal(got.basis, 'estimate', JSON.stringify(tried));
    assert.equal(got.costSource, OPENAI_IMAGE_COST_SOURCES.estimate);
    assert.equal(got.costUsd, estimate);
  }
  // Partials received count in the estimate only.
  assert.ok(Math.abs(charge({ kind: 'stream', partials: 2 }).costUsd - (estimate + (200 * 30) / 1e6)) < 1e-9);
  for (const tried of [{ kind: 'unsent' }, { kind: 'refused', status: 400 }, { kind: 'refused', status: 429 }]) {
    assert.equal(charge(tried), null, JSON.stringify(tried));
  }
  // Images without a usage: the floor × count.
  const floor = openAIImageTryCharge({ tried: { ok: true }, request: { ...REQUEST, count: 2 } });
  assert.equal(floor.basis, 'floor');
  assert.equal(floor.costUsd, openAIImageCostFloor({ ...REQUEST, count: 2 }).costUsd);
  // A real usage lower than the floor is booked as it is.
  const low = openAIImageTryCharge({ tried: { ok: true, usage: { input_tokens: 10, output_tokens: 100 } }, request: { ...REQUEST, count: 2 } });
  assert.equal(low.basis, 'usage');
  assert.ok(low.costUsd < floor.costUsd);
});

test('a try books one row: provider openai, billing image, the requested model, run_id per try, at = the try start', () => {
  const { db, spend, clock, events } = setup();
  const reserved = spend.reserveTry({ estimateUsd: 0.25 });
  clock.ms += 30_000;
  spend.settleTry(reserved.reservation, {
    conversationId: 'conv-1',
    turnId: 'q-1',
    runId: openAIImageTryRunId('img_attempt_1', 1),
    model: 'OpenAI/GPT-Image-2',
    charge: openAIImageTryCharge({ tried: { ok: true, usage: USAGE }, request: REQUEST }),
  });
  const [row] = turnRows(db);
  assert.equal(row.provider, 'openai');
  assert.equal(row.billing, 'image');
  assert.equal(row.model, 'gpt-image-2');
  assert.equal(row.run_id, 'image:img_attempt_1:try1');
  assert.equal(row.turn_id, 'q-1');
  assert.equal(row.at, '2026-11-08T10:00:00.000Z');
  assert.equal(row.input_tokens, 40);
  assert.equal(row.output_tokens, 7024);
  assert.equal(row.cost_source, OPENAI_IMAGE_COST_SOURCES.table);
  assert.equal(events.at(-1).event, OPENAI_IMAGE_USAGE_EVENT);
  assert.equal(events.at(-1).payload.reservedUsd, 0);
  assert.ok(events.at(-1).payload.spentUsd > 0.21);
});

test('a try started 23:59:50 that ends 00:00:05 books to the old day; a check at 00:00:05 ignores the old day\'s reservation', () => {
  const { db, spend, clock, store } = setup({ at: '2026-11-08T23:59:50.000Z' });
  store.openai_image_daily_cap_usd = '1';
  const late = spend.reserveTry({ estimateUsd: 0.9 });
  assert.equal(late.ok, true);
  clock.ms = Date.parse('2026-11-09T00:00:05.000Z');
  // The new day: yesterday's 0.9 in flight does not count.
  const fresh = spend.reserveTry({ estimateUsd: 0.9 });
  assert.equal(fresh.ok, true);
  assert.equal(spend.buildState().reservedUsd, 0.9);
  spend.releaseTry(fresh.reservation);
  spend.settleTry(late.reservation, {
    conversationId: 'conv-1', turnId: 'q-1', runId: 'image:c:try1', model: 'gpt-image-2',
    charge: openAIImageTryCharge({ tried: { kind: 'timeout' }, request: REQUEST }),
  });
  assert.equal(turnRows(db)[0].day, '2026-11-08');
  assert.deepEqual(dayRows(db).map((row) => row.day), ['2026-11-08']);
  assert.equal(spend.buildState().spentUsd, 0);
});

test('the cap: refused before anything is reserved; 0 is no cap; the override lifts it for its day only', () => {
  const { spend, store, clock } = setup();
  store.openai_image_daily_cap_usd = '0.30';
  bookTry(spend, { tried: { ok: true, usage: USAGE } }); // ~0.211
  const refused = spend.reserveTry({ estimateUsd: 0.2 });
  assert.equal(refused.ok, false);
  assert.ok(Math.abs(refused.spentUsd - 0.2109) < 0.001);
  assert.equal(refused.capUsd, 0.3);
  assert.equal(spend.buildState().reservedUsd, 0);
  assert.match(openAIImageCapRefusalText({ tryNumber: 1, refusal: refused }), /^Today's estimated OpenAI image spend on this relay, USD 0\.21, and this turn's estimate, USD 0\.20, would pass the daily cap of USD 0\.30, so nothing was sent to OpenAI\. Allow more for today in Settings → Providers → OpenAI, or wait until tomorrow \(relay time\)\.$/);
  assert.match(openAIImageCapRefusalText({ tryNumber: 2, refusal: refused }), /^The first try may have been billed, and the daily cap stopped the second: /);
  // A small one still fits.
  assert.equal(spend.reserveTry({ estimateUsd: 0.05 }).ok, true);
  // The owner allows today (stored as JSON text): it passes.
  store.openai_image_cap_override_day = '"2026-11-08"';
  store.openai_image_cap_override_at = '2026-11-08T11:00:00.000Z';
  assert.equal(spend.reserveTry({ estimateUsd: 5 }).ok, true);
  assert.equal(spend.buildState().allowedToday, true);
  assert.equal(spend.buildState().allowedAt, '2026-11-08T11:00:00.000Z');
  // Tomorrow the override is over by itself.
  clock.ms = Date.parse('2026-11-09T10:00:00.000Z');
  assert.equal(spend.buildState().allowedToday, false);
  // No cap.
  store.openai_image_daily_cap_usd = '0';
  assert.equal(spend.reserveTry({ estimateUsd: 500 }).ok, true);
  assert.equal(spend.buildState().capUsd, null);
  // Missing or unreadable: the default, USD 5.
  store.openai_image_daily_cap_usd = '';
  assert.equal(spend.buildState().capUsd, 5);
  store.openai_image_daily_cap_usd = 'lots';
  assert.equal(spend.buildState().capUsd, 5);
});

test('two concurrent turns where only one fits: the second is refused on the first one\'s reservation', () => {
  const { spend, store } = setup();
  store.openai_image_daily_cap_usd = '0.5';
  const first = spend.reserveTry({ estimateUsd: 0.3 });
  const second = spend.reserveTry({ estimateUsd: 0.3 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  spend.releaseTry(first.reservation);
  assert.equal(spend.reserveTry({ estimateUsd: 0.3 }).ok, true);
});

test('a booking that fails stays counted for the day (the cap refuses the next), and is written by a later booking', () => {
  const { db, spend, store, tokens } = setup();
  store.openai_image_daily_cap_usd = '0.3';
  const original = tokens.recordTurn;
  let broken = true;
  tokens.recordTurn = (args) => {
    if (broken) throw new Error('disk I/O error');
    return original(args);
  };
  assert.equal(bookTry(spend, { tried: { ok: true, usage: USAGE } }), false);
  assert.equal(turnRows(db).length, 0);
  assert.ok(spend.buildState().spentUsd > 0.21);
  assert.equal(spend.reserveTry({ estimateUsd: 0.2 }).ok, false);
  assert.equal(spend.turnCost('q-1').tries, 1);
  // The tables come back: the next booking writes the kept one first.
  broken = false;
  store.openai_image_daily_cap_usd = '0';
  bookTry(spend, { turnId: 'q-2', scope: 'claim-b', tried: { kind: 'timeout' } });
  assert.deepEqual(turnRows(db).map((row) => row.run_id), ['image:claim-a:try1', 'image:claim-b:try1']);
  const state = spend.buildState();
  assert.ok(Math.abs(state.spentUsd - (0.21092 + estimateOpenAIImageCost(REQUEST).costUsd)) < 1e-6);
});

test('without token storage, image costs still count for the cap', () => {
  const { spend, store } = setup({ tokenUsage: null });
  store.openai_image_daily_cap_usd = '0.3';
  bookTry(spend, { tried: { ok: true, usage: USAGE } });
  assert.equal(spend.reserveTry({ estimateUsd: 0.2 }).ok, false);
});

test('the recovery books :recovered only when no try of that attempt has a row, and never merges into one', () => {
  const { db, spend } = setup();
  const request = { size: '1024x1024', quality: 'low', count: 1, inputImages: 0 };
  assert.equal(spend.bookRecovered({ conversationId: 'conv-1', turnId: 'q-1', attemptId: 'img_attempt_1', model: 'gpt-image-2', startedAt: '2026-11-08T09:59:00.000Z', request }), true);
  assert.equal(spend.bookRecovered({ conversationId: 'conv-1', turnId: 'q-1', attemptId: 'img_attempt_1', model: 'gpt-image-2', startedAt: '2026-11-08T09:59:00.000Z', request }), false);
  const [row] = turnRows(db);
  assert.equal(row.run_id, openAIImageRecoveredRunId('img_attempt_1'));
  assert.equal(row.cost_source, OPENAI_IMAGE_COST_SOURCES.estimate);
  assert.equal(row.at, '2026-11-08T09:59:00.000Z');
  // An attempt whose try was booked: nothing more.
  bookTry(spend, { turnId: 'q-2', scope: 'img_attempt_2', tried: { ok: true, usage: USAGE } });
  assert.equal(spend.bookRecovered({ conversationId: 'conv-1', turnId: 'q-2', attemptId: 'img_attempt_2', model: 'gpt-image-2', request }), false);
  // A recovery estimate and a real row of another attempt of the same turn stay two rows.
  bookTry(spend, { turnId: 'q-1', scope: 'img_attempt_3', tried: { ok: true, usage: USAGE } });
  const rows = turnRows(db).filter((entry) => entry.turn_id === 'q-1');
  assert.deepEqual(rows.map((entry) => entry.run_id), ['image:img_attempt_1:recovered', 'image:img_attempt_3:try1']);
  assert.deepEqual(rows.map((entry) => entry.cost_source), [OPENAI_IMAGE_COST_SOURCES.estimate, OPENAI_IMAGE_COST_SOURCES.table]);
  const cost = spend.turnCost('q-1');
  assert.equal(cost.tries, 2);
  assert.equal(cost.estimated, true);
});

test('the send refusal: at the cap (booked + reserved), lifted by the override', () => {
  const { spend, store } = setup();
  store.openai_image_daily_cap_usd = '0.3';
  assert.equal(spend.sendRefusal(), null);
  bookTry(spend, { tried: { ok: true, usage: USAGE } });
  assert.equal(spend.sendRefusal(), null);
  store.openai_image_daily_cap_usd = '0.2';
  const refusal = spend.sendRefusal();
  assert.equal(refusal.code, 'OPENAI_IMAGE_DAILY_CAP_REACHED');
  assert.equal(refusal.error, 'Today\'s estimated OpenAI image spend on this relay, USD 0.21, has reached the daily cap of USD 0.20 (Settings → Providers → OpenAI). Nothing was sent. Allow more for today there, or wait until tomorrow (relay time).');
  store.openai_image_cap_override_day = '2026-11-08';
  assert.equal(spend.sendRefusal(), null);
});

test('the spend state: shares of estimates and unknown prices, the month, warning and reached, a chat\'s figures', () => {
  const { db, spend, store, clock } = setup({ at: '2026-11-03T10:00:00.000Z' });
  // Room for the unknown model's stand-in, the dearest listed price.
  store.openai_image_daily_cap_usd = '1.5';
  bookTry(spend, { turnId: 'q-0', scope: 's0', tried: { ok: true, usage: USAGE } }); // another day this month
  clock.ms = Date.parse('2026-11-08T10:00:00.000Z');
  bookTry(spend, { turnId: 'q-1', scope: 's1', tried: { ok: true, usage: USAGE } });
  bookTry(spend, { turnId: 'q-2', scope: 's2', tried: { kind: 'timeout' }, conversationId: 'conv-2' });
  bookTry(spend, { turnId: 'q-3', scope: 's3', tried: { ok: true }, request: { ...REQUEST, model: 'gpt-image-7' }, conversationId: 'conv-2' });
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-2', 'kites', '2026-11-08T09:00:00.000Z', '2026-11-08T09:00:00.000Z')`).run();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp, attachments) VALUES ('m-1', 'conv-2', 'assistant', '', '2026-11-08T10:00:00.000Z', ?)`)
    .run(JSON.stringify([{ name: 'a.png', generatedImage: { imageId: 'i1' } }, { name: 'b.png', generatedImage: { imageId: 'i2' } }, { name: 'notes.txt' }]));
  const estimate = estimateOpenAIImageCost(REQUEST).costUsd;
  const standIn = openAIImageCostFloor({ ...REQUEST, model: 'gpt-image-7' }).costUsd;
  const held = spend.reserveTry({ estimateUsd: 0.01 });
  const state = spend.buildState({ conversationId: 'conv-2' });
  assert.equal(state.day, '2026-11-08');
  assert.equal(state.capUsd, 1.5);
  assert.ok(Math.abs(state.spentUsd - (0.21092 + estimate + standIn)) < 1e-6);
  assert.equal(state.reservedUsd, 0.01);
  assert.ok(Math.abs(state.estimatedUsd - (estimate + standIn)) < 1e-6);
  assert.ok(Math.abs(state.unknownPriceUsd - standIn) < 1e-6);
  assert.ok(Math.abs(state.monthUsd - (2 * 0.21092 + estimate + standIn)) < 1e-6);
  assert.equal(state.warning, state.ratio >= 0.8);
  assert.equal(state.reached, state.spentUsd + state.reservedUsd >= 1.5);
  assert.equal(state.allowedToday, false);
  assert.equal(state.allowedAt, null);
  assert.deepEqual(state.conversation, {
    costUsd: Math.round((estimate + standIn) * 1e6) / 1e6,
    estimatedUsd: Math.round((estimate + standIn) * 1e6) / 1e6,
    images: 2,
    tries: 2,
  });
  spend.releaseTry(held.reservation);
});
