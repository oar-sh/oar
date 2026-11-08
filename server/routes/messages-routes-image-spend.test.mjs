// What an OpenAI image request books, per try, where it runs (the generate
// route and the execute route alike), and the daily cap that stops a try
// before it is sent. Real token tables in memory, a fake OpenAI.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { registerMessagesRoutes } from './messages-routes.mjs';
import {
  FAKE_OPENAI_BASE_URL,
  captureRoutes,
  executeImageOperation,
  fetchFailure,
  invokeRoute,
  makeImageOperationDeps,
  makeRouteDeps,
  openAIImageSse,
  recordingStmts,
  stubImageFetch,
} from './messages-routes-test-harness.mjs';
import { applySchema } from '../db-schema.mjs';
import { createTokenUsageService } from '../services/token-usage-service.mjs';
import { createOpenAIImageSpendService } from '../services/openai-image-spend-service.mjs';
import { OPENAI_IMAGE_COST_SOURCES, OPENAI_IMAGE_USAGE_EVENT, OPENAI_IMAGE_USAGE_PATH } from '../../shared/openai-image-spend.mjs';
import { estimateOpenAIImageCost, openAIImageCostFloor } from '../../shared/openai-image-prices.mjs';

const GENERATE = '/api/openai/images/generate';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5Hh9kAAAAASUVORK5CYII=';
const USAGE = Object.freeze({ input_tokens: 20, input_tokens_details: { text_tokens: 20, image_tokens: 0 }, output_tokens: 196 });
const USAGE_USD = (20 * 5 + 196 * 30) / 1e6;
const REQUEST = Object.freeze({ model: 'gpt-image-2', size: '1024x1024', quality: 'low', count: 1, inputImages: 0 });
const ESTIMATE = estimateOpenAIImageCost(REQUEST).costUsd;
const silent = { warn() {}, log() {} };
const okReply = (usage = USAGE) => ({ status: 200, json: { data: [{ b64_json: PNG }], ...(usage ? { usage } : {}) } });
const reset = () => fetchFailure('ECONNRESET');

/** A token store, a clock, the settings and the spend service over them. */
function spendRig({ at = '2026-11-08T10:00:00.000Z', settings = {} } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const clock = { ms: Date.parse(at) };
  const store = { ...settings };
  const tokens = createTokenUsageService({ db, now: () => clock.ms, timeZone: 'UTC', logger: silent });
  const events = [];
  const spend = createOpenAIImageSpendService({
    tokenUsageService: tokens,
    readSetting: (key) => store[key] ?? '',
    db,
    emit: (event, payload) => events.push({ event, payload }),
    now: () => clock.ms,
    timeZone: 'UTC',
    logger: silent,
  });
  const rows = () => db.prepare('SELECT * FROM turn_token_usage ORDER BY rowid').all().map((row) => ({ ...row }));
  return { db, clock, store, tokens, spend, events, rows };
}

let counter = 0;
function generateRig(rig, { config = {}, claim = 'claim-a' } = {}) {
  const routes = captureRoutes(makeRouteDeps({
    ts: () => '00:00:00.000',
    config,
    isTrulyLocalRequest: () => true,
    openAIImageRetryDelayMs: 0,
    MAX_UPLOAD_ATTACHMENTS: 6,
    openAIImageSpend: rig.spend,
    stmts: { findQById: { get: (id) => (claim ? { id, attempt_id: claim } : null) } },
    getOpenAIProviderSettings: () => ({
      configured: true, enabled: true, apiKey: 'sk-test-key', baseUrl: FAKE_OPENAI_BASE_URL, model: 'gpt-image-2', models: [],
    }),
  }), registerMessagesRoutes);
  return (overrides = {}) => {
    counter += 1;
    return invokeRoute(routes, 'POST', GENERATE, {
      body: { messageId: `q-spend-${counter}`, conversationId: 'conv-1', model: 'gpt-image-2', prompt: 'a red kite', size: '1024x1024', quality: 'low', ...overrides },
    });
  };
}

const near = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-6, `${label} ${actual} ≠ ${expected}`);

test('a completed reply books its usage: provider openai, billing image, the requested model, run_id of the claim and try', async (t) => {
  const rig = spendRig();
  stubImageFetch(t, { openai: [okReply()] });
  const { status } = await generateRig(rig)({ model: 'GPT-Image-2', messageId: 'q-kite' });
  assert.equal(status, 200);
  const [row] = rig.rows();
  assert.equal(row.provider, 'openai');
  assert.equal(row.billing, 'image');
  assert.equal(row.model, 'gpt-image-2');
  assert.equal(row.turn_id, 'q-kite');
  assert.equal(row.conversation_id, 'conv-1');
  assert.equal(row.run_id, 'image:claim_claim-a:try1');
  assert.equal(row.at, '2026-11-08T10:00:00.000Z');
  assert.equal(row.input_tokens, 20);
  assert.equal(row.output_tokens, 196);
  near(row.cost_usd, USAGE_USD);
  assert.equal(row.cost_source, OPENAI_IMAGE_COST_SOURCES.table);
  assert.equal(row.cost_unknown, 0);
  assert.equal(rig.events.at(-1).event, OPENAI_IMAGE_USAGE_EVENT);
  assert.equal(rig.events.at(-1).payload.reservedUsd, 0);
  // Without a claim id each run gets its own scope.
  const unclaimed = spendRig();
  const run = generateRig(unclaimed, { claim: null });
  await run({ messageId: 'q-same' });
  await run({ messageId: 'q-other' });
  const ids = unclaimed.rows().map((entry) => entry.run_id);
  assert.match(ids[0], /^image:claim_[0-9a-f-]{36}:try1$/);
  assert.notEqual(ids[0], ids[1]);
});

test('n = 2 streamed: the completed events\' usages add up; without usage the floor × count', async (t) => {
  const rig = spendRig();
  const second = { input_tokens: 20, output_tokens: 300 };
  stubImageFetch(t, {
    openai: [
      { status: 200, sse: openAIImageSse([{ completed: true, b64: PNG, usage: USAGE }, { completed: true, b64: PNG, usage: second }]) },
      { status: 200, sse: openAIImageSse([{ completed: true, b64: PNG }, { completed: true, b64: PNG }]) },
    ],
  });
  const run = generateRig(rig);
  assert.equal((await run({ n: 2 })).status, 200);
  assert.equal((await run({ n: 2 })).status, 200);
  const [summed, floored] = rig.rows();
  assert.equal(summed.input_tokens, 40);
  assert.equal(summed.output_tokens, 496);
  near(summed.cost_usd, (20 * 5 + 20 * 8 + 496 * 30) / 1e6);
  assert.equal(summed.cost_source, OPENAI_IMAGE_COST_SOURCES.table);
  near(floored.cost_usd, openAIImageCostFloor({ ...REQUEST, count: 2 }).costUsd);
  assert.equal(floored.cost_source, OPENAI_IMAGE_COST_SOURCES.estimate);
  assert.equal(floored.output_tokens, null);
});

test('a usage below the floor is booked as it is', async (t) => {
  const rig = spendRig();
  stubImageFetch(t, { openai: [okReply({ input_tokens: 1, output_tokens: 10 })] });
  await generateRig(rig)({ n: 2 });
  near(rig.rows()[0].cost_usd, (1 * 8 + 10 * 30) / 1e6);
});

test('a stream that broke off after a completed image books that usage; a 2xx the relay could not process books its usage', async (t) => {
  const rig = spendRig();
  stubImageFetch(t, {
    openai: [
      { status: 200, sse: openAIImageSse([{ partial: 0, b64: PNG }, { completed: true, b64: PNG, usage: USAGE }]), breakWith: Object.assign(new TypeError('terminated'), { cause: reset().cause }) },
      { status: 200, sse: openAIImageSse([{ completed: true, b64: PNG, usage: USAGE }, { completed: true, b64: PNG, usage: USAGE }]) },
      { status: 200, json: { data: [], usage: USAGE } },
    ],
  });
  const run = generateRig(rig);
  assert.equal((await run({ n: 2, messageId: 'q-break' })).status, 200);
  const unprocessed = await run({ messageId: 'q-unread' });
  assert.equal(unprocessed.body.code, 'IMAGE_REPLY_UNPROCESSED');
  const rows = rig.rows();
  assert.deepEqual(rows.map((row) => [row.turn_id, row.run_id, row.cost_source]), [
    ['q-break', 'image:claim_claim-a:try1', OPENAI_IMAGE_COST_SOURCES.table],
    ['q-break', 'image:claim_claim-a:try2', OPENAI_IMAGE_COST_SOURCES.table],
    ['q-unread', 'image:claim_claim-a:try1', OPENAI_IMAGE_COST_SOURCES.table],
  ]);
  assert.equal(rows[0].output_tokens, 196);
  assert.equal(rows[1].output_tokens, 392);
  near(rows[2].cost_usd, USAGE_USD);
});

const ESTIMATED = [
  ['a timeout, twice', [{ hang: true }], 2, 0],
  ['a broken connection, twice', [{ error: reset() }], 2, 0],
  ['a stream broken after a partial, twice', [{ status: 200, sse: openAIImageSse([{ partial: 0, b64: PNG }]), breakWith: Object.assign(new TypeError('terminated'), { cause: reset().cause }) }], 2, 1],
  ['an HTTP 5xx, twice', [{ status: 503, json: { error: { message: 'overloaded' } } }], 2, 0],
  ['a stream server error event, twice', [{ status: 200, sse: openAIImageSse([{ error: { type: 'server_error', code: 'server_error', message: 'oops' } }]) }], 2, 0],
  ['a refusal after the stream started', [{ status: 200, sse: openAIImageSse([{ error: { type: 'image_generation_user_error', code: 'moderation_blocked', message: 'no' } }]) }], 1, 0],
  ['a 2xx without a readable body', [{ status: 200, text: 'not json' }], 1, 0],
];

for (const [label, answers, tries, partials] of ESTIMATED) {
  test(`${label}: the estimate per try`, async (t) => {
    const rig = spendRig();
    stubImageFetch(t, { openai: answers });
    const result = await generateRig(rig, { config: { openaiImageGenerateTimeoutMs: 15 } })();
    assert.notEqual(result.status, 200);
    const rows = rig.rows();
    assert.deepEqual(rows.map((row) => row.run_id), ['image:claim_claim-a:try1', 'image:claim_claim-a:try2'].slice(0, tries));
    for (const row of rows) {
      assert.equal(row.cost_source, OPENAI_IMAGE_COST_SOURCES.estimate);
      near(row.cost_usd, ESTIMATE + (partials * 100 * 30) / 1e6, label);
    }
    assert.equal(rig.spend.buildState().reservedUsd, 0);
  });
}

test('a stream server error event, then a good reply: the estimate, then the usage', async (t) => {
  const rig = spendRig();
  stubImageFetch(t, { openai: [{ status: 200, sse: openAIImageSse([{ error: { type: 'server_error', code: 'server_error', message: 'oops' } }]) }, okReply()] });
  assert.equal((await generateRig(rig)()).status, 200);
  assert.deepEqual(rig.rows().map((row) => row.cost_source), [OPENAI_IMAGE_COST_SOURCES.estimate, OPENAI_IMAGE_COST_SOURCES.table]);
});

for (const [label, answers] of [
  ['never reached OpenAI', [{ error: fetchFailure('ECONNREFUSED') }]],
  ['a plain 400', [{ status: 400, json: { error: { message: 'bad prompt' } } }]],
  ['a 429', [{ status: 429, json: { error: { message: 'slow down' } } }]],
]) {
  test(`${label}: nothing booked`, async (t) => {
    const rig = spendRig();
    stubImageFetch(t, { openai: answers });
    await generateRig(rig)();
    assert.deepEqual(rig.rows(), []);
    assert.equal(rig.spend.buildState().reservedUsd, 0);
  });
}

test('the resend without stream fields keeps the first reservation and books once', async (t) => {
  const rig = spendRig();
  const original = globalThis.fetch;
  stubImageFetch(t, { openai: [{ status: 400, json: { error: { message: 'stream is not supported' } } }, okReply()] });
  const stubbed = globalThis.fetch;
  const reservedAtCall = [];
  globalThis.fetch = async (...args) => {
    reservedAtCall.push(rig.spend.buildState().reservedUsd);
    return stubbed(...args);
  };
  t.after(() => { globalThis.fetch = original; });
  assert.equal((await generateRig(rig)()).status, 200);
  assert.deepEqual(reservedAtCall, [ESTIMATE, ESTIMATE]);
  assert.deepEqual(rig.rows().map((row) => row.run_id), ['image:claim_claim-a:try1']);
  assert.equal(rig.spend.buildState().reservedUsd, 0);
});

test('a booking that throws still counts: the cap refuses the next turn before any request', async (t) => {
  const rig = spendRig({ settings: { openai_image_daily_cap_usd: '0.01' } });
  rig.tokens.recordTurn = () => { throw new Error('database is locked'); };
  const calls = stubImageFetch(t, { openai: [okReply()] });
  const run = generateRig(rig);
  assert.equal((await run()).status, 200);
  assert.deepEqual(rig.rows(), []);
  near(rig.spend.buildState().spentUsd, USAGE_USD);
  const refused = await run();
  assert.equal(calls.openai.length, 1);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'OPENAI_IMAGE_DAILY_CAP_REACHED');
});

test('the cap stops a first try before it is sent: no request, the note says nothing was sent', async (t) => {
  const rig = spendRig({ settings: { openai_image_daily_cap_usd: '0.005' } });
  const calls = stubImageFetch(t, { openai: [okReply()] });
  const refused = await generateRig(rig)();
  assert.equal(calls.openai.length, 0);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'OPENAI_IMAGE_DAILY_CAP_REACHED');
  assert.equal(refused.body.outcome, 'terminal');
  assert.equal(refused.body.error, `Today's estimated OpenAI image spend on this relay, USD 0.00, and this turn's estimate, USD 0.008, would pass the daily cap of USD 0.005, so nothing was sent to OpenAI. Allow more for today in Settings → Providers → OpenAI, or wait until tomorrow (relay time).`);
  assert.deepEqual(rig.rows(), []);
  // Allowed for today: it goes.
  rig.store.openai_image_cap_override_day = '"2026-11-08"';
  assert.equal((await generateRig(rig)()).status, 200);
});

test('an operation the cap stops on its first try: no request, the attempt closes as not sent, the note goes out', async (t) => {
  const rig = spendRig({ settings: { openai_image_daily_cap_usd: '0.005' } });
  const calls = stubImageFetch(t, { openai: [okReply()] });
  const { deps, finished } = makeImageOperationDeps();
  deps.openAIImageSpend = rig.spend;
  const { status, body } = await executeImageOperation(deps);
  assert.equal(calls.openai.length, 0);
  assert.equal(status, 409);
  assert.equal(body.code, 'OPENAI_IMAGE_DAILY_CAP_REACHED');
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, 'failed_retryable');
  const published = calls.self.find((call) => call.route === '/api/response').body.terminalError;
  assert.equal(published.code, 'OPENAI_IMAGE_DAILY_CAP_REACHED');
  assert.match(published.message, /so nothing was sent to OpenAI\./);
});

test('the cap stops a second try: one request, the note says the first may have been billed', async (t) => {
  // Room for one estimate, not two.
  const rig = spendRig({ settings: { openai_image_daily_cap_usd: String(ESTIMATE * 1.5) } });
  const calls = stubImageFetch(t, { openai: [{ status: 503, json: {} }, okReply()] });
  const { deps, finished } = makeImageOperationDeps();
  deps.openAIImageSpend = rig.spend;
  const { status, body } = await executeImageOperation(deps);
  assert.equal(calls.openai.length, 1);
  assert.equal(status, 409);
  assert.equal(body.outcome, 'uncertain');
  assert.match(body.error, /^The first try may have been billed, and the daily cap stopped the second: today's estimated OpenAI image spend on this relay, USD 0\.008, and this try's estimate, USD 0\.008, would pass the daily cap of USD 0\.01\./);
  assert.equal(finished[0].status, 'uncertain');
  assert.deepEqual(rig.rows().map((row) => row.run_id), [`image:${deps.stmts.getLatestAttempt.get().id}:try1`]);
});

test('two turns at once where only one fits: the second is refused on the first one\'s reservation, released after', async (t) => {
  const rig = spendRig({ settings: { openai_image_daily_cap_usd: String(ESTIMATE * 1.5) } });
  const calls = stubImageFetch(t, { openai: [{ status: 400, json: { error: { message: 'bad prompt' } } }] });
  const run = generateRig(rig);
  const first = run();
  const second = run();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(calls.openai.length, 1);
  assert.equal(one.status, 400);
  assert.equal(two.status, 409);
  assert.equal(two.body.code, 'OPENAI_IMAGE_DAILY_CAP_REACHED');
  // The refused first one booked nothing and released its share.
  assert.equal(rig.spend.buildState().reservedUsd, 0);
  assert.equal((await run()).status, 400);
});

test('a try that throws releases its reservation', async (t) => {
  const rig = spendRig();
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get() { throw new Error('headers went away'); } } });
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(generateRig(rig)(), /headers went away/);
  assert.equal(rig.spend.buildState().reservedUsd, 0);
  assert.deepEqual(rig.rows(), []);
});

test('a try started 23:59:50 that ends 00:00:05 books to the old day; a check at 00:00:05 ignores its reservation', async (t) => {
  const rig = spendRig({ at: '2026-11-08T23:59:50.000Z', settings: { openai_image_daily_cap_usd: String(ESTIMATE * 1.5) } });
  const run = generateRig(rig);
  const original = globalThis.fetch;
  stubImageFetch(t, { openai: [okReply()] });
  const stubbed = globalThis.fetch;
  let inner = null;
  let call = 0;
  globalThis.fetch = async (...args) => {
    call += 1;
    if (call === 1) {
      // Midnight passes while the first try is out: a turn now sees only the new day.
      rig.clock.ms = Date.parse('2026-11-09T00:00:05.000Z');
      inner = run({ messageId: 'q-new-day' });
    }
    return stubbed(...args);
  };
  t.after(() => { globalThis.fetch = original; });
  assert.equal((await run({ messageId: 'q-old-day' })).status, 200);
  assert.equal((await inner).status, 200);
  const days = Object.fromEntries(rig.rows().map((row) => [row.turn_id, row.day]));
  assert.deepEqual(days, { 'q-old-day': '2026-11-08', 'q-new-day': '2026-11-09' });
});

test('the recovery books an attempt cut off as :recovered, once, and not over a booked try', async (t) => {
  const rig = spendRig({ at: '2026-10-24T10:05:00.000Z' });
  stubImageFetch(t, { openai: [okReply()] });
  const cutOff = { id: 'img_attempt_cut', attempt_number: 1, status: 'started', started_at: '2026-10-24T09:00:00.000Z' };
  const { deps } = makeImageOperationDeps({ latestAttempt: cutOff });
  deps.openAIImageSpend = rig.spend;
  const { body } = await executeImageOperation(deps);
  assert.equal(body.code, 'IMAGE_ATTEMPT_INTERRUPTED');
  const [row] = rig.rows();
  assert.equal(row.run_id, 'image:img_attempt_cut:recovered');
  assert.equal(row.turn_id, 'q-1');
  assert.equal(row.cost_source, OPENAI_IMAGE_COST_SOURCES.estimate);
  near(row.cost_usd, ESTIMATE);
  assert.equal(row.day, '2026-10-24');
  // An attempt with a booked try: the recovery books nothing more.
  const booked = spendRig({ at: '2026-10-24T10:05:00.000Z' });
  booked.tokens.recordTurn({
    conversationId: 'conv-1', provider: 'openai', billing: 'image',
    report: { turnId: 'q-1', runId: 'image:img_attempt_cut:try1', nativeSessionId: null, responseMessageId: null, at: '2026-10-24T09:00:00.000Z', models: [{ model: 'gpt-image-2', inputTokens: 20, outputTokens: 196, costUsd: USAGE_USD, costSource: OPENAI_IMAGE_COST_SOURCES.table }] },
  });
  const again = makeImageOperationDeps({ latestAttempt: { ...cutOff } });
  again.deps.openAIImageSpend = booked.spend;
  await executeImageOperation(again.deps);
  assert.deepEqual(booked.rows().map((entry) => entry.run_id), ['image:img_attempt_cut:try1']);
});

test('the reply line carries the turn\'s cost, marked as an estimate, and today against the cap from 80 %', async (t) => {
  // Allowed past the cap today: the second try runs, the warning stays.
  const rig = spendRig({ settings: { openai_image_daily_cap_usd: '0.25', openai_image_cap_override_day: '"2026-11-08"' } });
  stubImageFetch(t, { openai: [{ status: 503, json: {} }, okReply()] });
  const queueRow = { id: 'q-line', conversation_id: 'conv-1', status: 'processing', relay_mode: 'agent', model: 'gpt-image-2', retry_count: 0 };
  const { calls, stmts } = recordingStmts({
    findQById: { get: () => queueRow },
    getRuntimeSessionByConversation: { get: () => ({ provider_type: 'openai' }) },
    getConvAnyStatus: { get: () => ({ id: 'conv-1', status: 'active', sdk_session_id: 'sdk-1' }) },
  });
  const root = `${process.cwd()}/.test-artifacts/image-spend-${process.pid}`;
  t.after(async () => (await import('node:fs')).rmSync(root, { recursive: true, force: true }));
  let uuid = 0;
  const routes = captureRoutes(makeRouteDeps({
    ts: () => '00:00:00.000',
    uuidv4: () => `reply-${++uuid}`,
    io: { emit() {} },
    stmts,
    db: { prepare: () => ({ run: () => ({ changes: 1 }), get: () => null, all: () => [] }), transaction: (fn) => (...args) => fn(...args) },
    config: {},
    isTrulyLocalRequest: () => true,
    openAIImageRetryDelayMs: 0,
    MAX_UPLOAD_ATTACHMENTS: 6,
    openAIImageSpend: rig.spend,
    getOpenAIProviderSettings: () => ({ configured: true, enabled: true, apiKey: 'sk-test-key', baseUrl: FAKE_OPENAI_BASE_URL, model: 'gpt-image-2', models: [] }),
    resolveSessionStateRoot: () => root,
    readSessionTranscriptMessages: () => [],
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    relayThoughtsForResponse: () => [],
    relayThoughtsForQueueMessage: () => [],
    sanitizeActivityText: (value) => String(value || ''),
    hydrateAttachment: (attachment) => attachment,
    parseAttachments: () => [],
    inFlightStateForConversation: () => null,
    emitToClientsExceptSessionId: () => {},
    queueCounts: () => ({ pendingCount: 0, processingCount: 0 }),
    runtimeState: {},
  }), registerMessagesRoutes);
  const generated = await invokeRoute(routes, 'POST', GENERATE, {
    body: { messageId: 'q-line', conversationId: 'conv-1', model: 'gpt-image-2', prompt: 'a red kite', size: '1024x1024', quality: 'high' },
  });
  assert.equal(generated.status, 200);
  const reply = await invokeRoute(routes, 'POST', '/api/response', {
    body: { messageId: 'q-line', conversationId: 'conv-1', text: '', model: 'gpt-image-2', generatedImages: generated.body.generatedImages },
  });
  assert.equal(reply.status, 200);
  const text = calls.find((call) => call.stmt === 'insertMsg').args[3];
  // The 503 try at its estimate (high), the good one at its usage: 88 % of the cap.
  const total = estimateOpenAIImageCost({ ...REQUEST, quality: 'high' }).costUsd + USAGE_USD;
  assert.equal(text, `1 image · 1x1 · gpt-image-2 · ~USD ${total.toFixed(2)} (estimate) · today USD ${total.toFixed(2)} of 0.25 (${Math.round((total / 0.25) * 100)} %)`);
  assert.equal(text, '1 image · 1x1 · gpt-image-2 · ~USD 0.22 (estimate) · today USD 0.22 of 0.25 (88 %)');
});

test('the reply line\'s 80 % warning counts tries in flight too, as the banner does', async (t) => {
  // Booked alone, this turn is 60 % of the cap; with another turn's try in
  // flight, 90 %.
  const rig = spendRig({ settings: { openai_image_daily_cap_usd: '0.01' } });
  stubImageFetch(t, { openai: [okReply()] });
  const queueRow = { id: 'q-line', conversation_id: 'conv-1', status: 'processing', relay_mode: 'agent', model: 'gpt-image-2', retry_count: 0 };
  const { calls, stmts } = recordingStmts({
    findQById: { get: () => queueRow },
    getRuntimeSessionByConversation: { get: () => ({ provider_type: 'openai' }) },
    getConvAnyStatus: { get: () => ({ id: 'conv-1', status: 'active', sdk_session_id: 'sdk-1' }) },
  });
  const root = `${process.cwd()}/.test-artifacts/image-spend-${process.pid}`;
  t.after(async () => (await import('node:fs')).rmSync(root, { recursive: true, force: true }));
  let uuid = 0;
  const routes = captureRoutes(makeRouteDeps({
    ts: () => '00:00:00.000',
    uuidv4: () => `reply-${++uuid}`,
    io: { emit() {} },
    stmts,
    db: { prepare: () => ({ run: () => ({ changes: 1 }), get: () => null, all: () => [] }), transaction: (fn) => (...args) => fn(...args) },
    config: {},
    isTrulyLocalRequest: () => true,
    openAIImageRetryDelayMs: 0,
    MAX_UPLOAD_ATTACHMENTS: 6,
    openAIImageSpend: rig.spend,
    getOpenAIProviderSettings: () => ({ configured: true, enabled: true, apiKey: 'sk-test-key', baseUrl: FAKE_OPENAI_BASE_URL, model: 'gpt-image-2', models: [] }),
    resolveSessionStateRoot: () => root,
    readSessionTranscriptMessages: () => [],
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    relayThoughtsForResponse: () => [],
    relayThoughtsForQueueMessage: () => [],
    sanitizeActivityText: (value) => String(value || ''),
    hydrateAttachment: (attachment) => attachment,
    parseAttachments: () => [],
    inFlightStateForConversation: () => null,
    emitToClientsExceptSessionId: () => {},
    queueCounts: () => ({ pendingCount: 0, processingCount: 0 }),
    runtimeState: {},
  }), registerMessagesRoutes);
  const generated = await invokeRoute(routes, 'POST', GENERATE, {
    body: { messageId: 'q-line', conversationId: 'conv-1', model: 'gpt-image-2', prompt: 'a red kite', size: '1024x1024', quality: 'low' },
  });
  assert.equal(generated.status, 200);
  const inFlight = rig.spend.reserveTry({ estimateUsd: 0.003 });
  assert.equal(inFlight.ok, true);
  assert.ok(rig.spend.buildState().spentUsd / 0.01 < 0.8);
  const reply = await invokeRoute(routes, 'POST', '/api/response', {
    body: { messageId: 'q-line', conversationId: 'conv-1', text: '', model: 'gpt-image-2', generatedImages: generated.body.generatedImages },
  });
  assert.equal(reply.status, 200);
  const text = calls.find((call) => call.stmt === 'insertMsg').args[3];
  assert.equal(rig.spend.buildState().warning, true);
  assert.equal(text, '1 image · 1x1 · gpt-image-2 · ~USD 0.006 · today USD 0.009 of 0.01 (90 %)');
});

test('GET image usage: the spend state, and a chat\'s figures with conversationId', async (t) => {
  const rig = spendRig({ settings: { openai_image_daily_cap_usd: '5' } });
  stubImageFetch(t, { openai: [okReply()] });
  await generateRig(rig)();
  const routes = captureRoutes(makeRouteDeps({ openAIImageSpend: rig.spend }), registerMessagesRoutes);
  const plain = await invokeRoute(routes, 'GET', OPENAI_IMAGE_USAGE_PATH);
  assert.equal(plain.status, 200);
  assert.equal(plain.body.day, '2026-11-08');
  assert.equal(plain.body.capUsd, 5);
  near(plain.body.spentUsd, USAGE_USD);
  assert.equal(plain.body.reached, false);
  assert.equal(plain.body.warning, false);
  assert.equal('conversation' in plain.body, false);
  const chat = await invokeRoute(routes, 'GET', OPENAI_IMAGE_USAGE_PATH, { query: { conversationId: 'conv-1' } });
  assert.deepEqual({ ...chat.body.conversation, costUsd: Math.round(chat.body.conversation.costUsd * 1e6) }, {
    costUsd: Math.round(USAGE_USD * 1e6), estimatedUsd: 0, images: 0, tries: 1,
  });
});
