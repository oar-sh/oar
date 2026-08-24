import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  createPushDispatchService,
  ensurePushVapidKeys,
  normalizePushPreferences,
  renderPushNotification,
  PUSH_EVENT_TYPES,
} from './push-dispatch-service.mjs';
import { PUSH_SUBSCRIPTIONS_SCHEMA } from '../migrations/0003-push-subscriptions.mjs';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(PUSH_SUBSCRIPTIONS_SCHEMA);
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created TEXT,
      updated TEXT
    );
  `);
  return db;
}

let uuidCounter = 0;
function nextUuid() {
  uuidCounter += 1;
  return `sub-${uuidCounter}`;
}

function makeService(db, {
  hasActiveDevice = () => false,
  webpush = { sendNotification: async () => ({ statusCode: 201 }) },
  recordStatusEvent,
} = {}) {
  const statusEvents = [];
  const service = createPushDispatchService({
    db,
    webpush,
    hasActiveDevice,
    recordStatusEvent: recordStatusEvent || ((type, details) => statusEvents.push({ type, details })),
    uuid: nextUuid,
    logger: { warn: () => {} },
  });
  return { service, statusEvents };
}

function subscribeDevice(service, { deviceId = 'device-1', endpoint = `https://push.example/${deviceId}`, preferences } = {}) {
  const result = service.upsertSubscription({
    deviceId,
    label: deviceId,
    endpoint,
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    preferences,
  });
  assert.equal(result.ok, true);
  return result.device;
}

// ── Preference normalization ───────────────────────────────────────────────

test('normalizePushPreferences fills safe defaults', () => {
  const prefs = normalizePushPreferences(null);
  assert.equal(prefs.enabled, true);
  assert.deepEqual(prefs.events, {
    question: true,
    turnComplete: true,
    turnFailed: true,
    board: true,
    cliOffline: false,
  });
  assert.deepEqual(prefs.content, { includeTitle: false, preview: 'none', previewChars: 80 });
});

test('normalizePushPreferences clamps preview chars and rejects unknown preview modes', () => {
  const prefs = normalizePushPreferences({
    content: { preview: 'everything', previewChars: 99999 },
  });
  assert.equal(prefs.content.preview, 'none');
  assert.equal(prefs.content.previewChars, 500);
  assert.equal(normalizePushPreferences({ content: { previewChars: 1 } }).content.previewChars, 20);
});

// ── Payload rendering per content-preference combination ──────────────────

const RENDER_EVENT = {
  type: 'question',
  conversationTitle: 'Fix the login flow',
  body: 'Should I use bcrypt or argon2 for password hashing in the new auth module?',
  data: { questionId: 'q-1', conversationId: 'conv-1' },
};

test('render: generic body and no title by default', () => {
  const payload = renderPushNotification(RENDER_EVENT, normalizePushPreferences(null));
  assert.equal(payload.title, 'Copilot needs your input');
  assert.equal(payload.body, 'The agent asked a question.');
  assert.equal(payload.data.type, 'question');
  assert.equal(payload.data.questionId, 'q-1');
  assert.ok(payload.tag.includes('question'));
  assert.ok(Number.isFinite(payload.timestamp));
});

test('render: conversation title is appended when includeTitle is on', () => {
  const payload = renderPushNotification(RENDER_EVENT, {
    content: { includeTitle: true, preview: 'none' },
  });
  assert.equal(payload.title, 'Copilot needs your input — Fix the login flow');
  assert.equal(payload.body, 'The agent asked a question.');
});

test('render: truncated preview honors previewChars and adds an ellipsis', () => {
  const payload = renderPushNotification(RENDER_EVENT, {
    content: { preview: 'truncated', previewChars: 24 },
  });
  assert.equal(payload.body, `${RENDER_EVENT.body.slice(0, 24)}…`);
});

test('render: truncated preview shorter than the limit is untouched', () => {
  const payload = renderPushNotification(
    { ...RENDER_EVENT, body: 'Short question?' },
    { content: { preview: 'truncated', previewChars: 80 } },
  );
  assert.equal(payload.body, 'Short question?');
});

test('render: full preview carries the whole text', () => {
  const payload = renderPushNotification(RENDER_EVENT, { content: { preview: 'full' } });
  assert.equal(payload.body, RENDER_EVENT.body);
});

test('render: full preview is capped below the push payload limit', () => {
  const payload = renderPushNotification(
    { ...RENDER_EVENT, body: 'x'.repeat(10_000) },
    { content: { preview: 'full' } },
  );
  assert.ok(payload.body.length <= 2000);
});

test('render: title and full preview combine', () => {
  const payload = renderPushNotification(RENDER_EVENT, {
    content: { includeTitle: true, preview: 'full' },
  });
  assert.equal(payload.title, 'Copilot needs your input — Fix the login flow');
  assert.equal(payload.body, RENDER_EVENT.body);
});

test('render: cliOffline keeps its fixed body regardless of preview mode', () => {
  const payload = renderPushNotification(
    { type: 'cliOffline', body: 'should be ignored' },
    { content: { preview: 'full' } },
  );
  assert.equal(payload.body, 'The relay lost its connection to the CLI host.');
});

test('render: distinct tags per event so notifications stack', () => {
  const first = renderPushNotification({ type: 'question', data: { questionId: 'q-1' } }, null);
  const second = renderPushNotification({ type: 'question', data: { questionId: 'q-2' } }, null);
  assert.notEqual(first.tag, second.tag);
});

test('render: every event type has a label', () => {
  for (const type of PUSH_EVENT_TYPES) {
    const payload = renderPushNotification({ type }, null);
    assert.ok(payload.title.length > 0, `title for ${type}`);
    assert.ok(payload.body.length > 0, `body for ${type}`);
    assert.equal(payload.data.type, type);
  }
});

// ── VAPID key persistence ──────────────────────────────────────────────────

test('ensurePushVapidKeys generates once and is stable afterwards', () => {
  const settings = new Map();
  const stmts = {
    getAppSetting: { get: (key) => (settings.has(key) ? { value: settings.get(key) } : undefined) },
    upsertAppSetting: { run: (key, value) => settings.set(key, value) },
  };
  let generateCalls = 0;
  const generateVapidKeys = () => {
    generateCalls += 1;
    return { publicKey: `pub-${generateCalls}`, privateKey: `priv-${generateCalls}` };
  };
  const first = ensurePushVapidKeys(stmts, { generateVapidKeys });
  assert.equal(first.generated, true);
  assert.equal(first.publicKey, 'pub-1');
  const second = ensurePushVapidKeys(stmts, { generateVapidKeys });
  assert.equal(second.generated, false);
  assert.equal(second.publicKey, 'pub-1');
  assert.equal(generateCalls, 1);
});

// ── Suppression ────────────────────────────────────────────────────────────

test('dispatch is suppressed while any device is active', async () => {
  const db = makeDb();
  const sends = [];
  const { service, statusEvents } = makeService(db, {
    hasActiveDevice: () => true,
    webpush: { sendNotification: async (...args) => { sends.push(args); } },
  });
  subscribeDevice(service);
  const result = await service.dispatch({ type: 'question', body: 'hello' });
  assert.equal(result.outcome, 'suppressed');
  assert.equal(sends.length, 0);
  assert.equal(statusEvents[0]?.type, 'push-suppressed');
});

test('dispatch fails closed (suppresses) when active-device state is unknown', async () => {
  const db = makeDb();
  const sends = [];
  const { service } = makeService(db, {
    hasActiveDevice: () => { throw new Error('io not ready'); },
    webpush: { sendNotification: async (...args) => { sends.push(args); } },
  });
  subscribeDevice(service);
  const result = await service.dispatch({ type: 'question', body: 'hello' });
  assert.equal(result.outcome, 'suppressed');
  assert.equal(sends.length, 0);
});

// ── Per-event filtering ────────────────────────────────────────────────────

test('dispatch honors per-event toggles and the enabled flag per device', async () => {
  const db = makeDb();
  const sends = [];
  const { service } = makeService(db, {
    webpush: { sendNotification: async (subscription) => { sends.push(subscription.endpoint); } },
  });
  subscribeDevice(service, { deviceId: 'wants-questions', preferences: { events: { question: true, turnComplete: false } } });
  subscribeDevice(service, { deviceId: 'no-questions', preferences: { events: { question: false, turnComplete: true } } });
  subscribeDevice(service, { deviceId: 'disabled', preferences: { enabled: false, events: { question: true } } });

  await service.dispatch({ type: 'question', body: 'q' });
  assert.deepEqual(sends, ['https://push.example/wants-questions']);

  sends.length = 0;
  await service.dispatch({ type: 'turnComplete', body: 'done' });
  assert.deepEqual(sends, ['https://push.example/no-questions']);
});

test('cliOffline is opt-in: default preferences do not receive it', async () => {
  const db = makeDb();
  const sends = [];
  const { service } = makeService(db, {
    webpush: { sendNotification: async (subscription) => { sends.push(subscription.endpoint); } },
  });
  subscribeDevice(service, { deviceId: 'defaults' });
  const result = await service.dispatch({ type: 'cliOffline' });
  assert.equal(result.outcome, 'no-subscribers');
  assert.equal(sends.length, 0);
});

// ── Per-device content rendering ───────────────────────────────────────────

test('the same event renders differently per device content preferences', async () => {
  const db = makeDb();
  db.prepare(`INSERT INTO conversations (id, title, created, updated) VALUES (?, ?, ?, ?)`)
    .run('conv-1', 'Refactor auth', '2026-01-01', '2026-01-01');
  const payloads = new Map();
  const { service } = makeService(db, {
    webpush: {
      sendNotification: async (subscription, body) => {
        payloads.set(subscription.endpoint, JSON.parse(body));
      },
    },
  });
  subscribeDevice(service, { deviceId: 'generic' });
  subscribeDevice(service, {
    deviceId: 'full',
    preferences: { content: { includeTitle: true, preview: 'full' } },
  });

  await service.dispatch({ type: 'question', conversationId: 'conv-1', body: 'Which database should I use?' });

  const generic = payloads.get('https://push.example/generic');
  assert.equal(generic.title, 'Copilot needs your input');
  assert.equal(generic.body, 'The agent asked a question.');

  const full = payloads.get('https://push.example/full');
  assert.equal(full.title, 'Copilot needs your input — Refactor auth');
  assert.equal(full.body, 'Which database should I use?');
});

// ── Subscription pruning ───────────────────────────────────────────────────

function webPushError(statusCode) {
  const error = new Error(`push failed ${statusCode}`);
  error.statusCode = statusCode;
  return error;
}

test('a 410 Gone deletes the subscription row', async () => {
  const db = makeDb();
  const { service, statusEvents } = makeService(db, {
    webpush: { sendNotification: async () => { throw webPushError(410); } },
  });
  subscribeDevice(service, { deviceId: 'gone' });
  await service.dispatch({ type: 'question', body: 'q' });
  assert.equal(service.listDevices().length, 0);
  assert.ok(statusEvents.some((event) => event.type === 'push-subscription-pruned'));
});

test('a 404 deletes the subscription row', async () => {
  const db = makeDb();
  const { service } = makeService(db, {
    webpush: { sendNotification: async () => { throw webPushError(404); } },
  });
  subscribeDevice(service, { deviceId: 'gone' });
  await service.dispatch({ type: 'question', body: 'q' });
  assert.equal(service.listDevices().length, 0);
});

test('other errors increment failure_count and record last_error, keeping the row', async () => {
  const db = makeDb();
  const { service } = makeService(db, {
    webpush: { sendNotification: async () => { throw webPushError(500); } },
  });
  subscribeDevice(service, { deviceId: 'flaky' });
  await service.dispatch({ type: 'question', body: 'q' });
  const [device] = service.listDevices();
  assert.equal(device.failureCount, 1);
  assert.match(device.lastError, /push failed 500/);
});

test('a subscription is pruned after repeated non-410 failures', async () => {
  const db = makeDb();
  const { service } = makeService(db, {
    webpush: { sendNotification: async () => { throw webPushError(500); } },
  });
  subscribeDevice(service, { deviceId: 'dead' });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await service.dispatch({ type: 'question', body: 'q' });
  }
  assert.equal(service.listDevices().length, 0);
});

test('a successful send resets the failure counter', async () => {
  const db = makeDb();
  let fail = true;
  const { service } = makeService(db, {
    webpush: {
      sendNotification: async () => {
        if (fail) throw webPushError(500);
      },
    },
  });
  subscribeDevice(service, { deviceId: 'recovering' });
  await service.dispatch({ type: 'question', body: 'q' });
  assert.equal(service.listDevices()[0].failureCount, 1);
  fail = false;
  await service.dispatch({ type: 'question', body: 'q' });
  const [device] = service.listDevices();
  assert.equal(device.failureCount, 0);
  assert.equal(device.lastError, null);
  assert.ok(device.lastSuccessAt);
});

// ── Robustness ─────────────────────────────────────────────────────────────

test('dispatch never throws, even when webpush throws synchronously', async () => {
  const db = makeDb();
  const { service } = makeService(db, {
    webpush: { sendNotification: () => { throw new Error('sync boom'); } },
  });
  subscribeDevice(service);
  const result = await service.dispatch({ type: 'question', body: 'q' });
  assert.equal(result.outcome, 'dispatched');
  assert.equal(result.sent, 0);
});

test('dispatch rejects unknown event types without touching subscriptions', async () => {
  const db = makeDb();
  const sends = [];
  const { service } = makeService(db, {
    webpush: { sendNotification: async (...args) => { sends.push(args); } },
  });
  subscribeDevice(service);
  const result = await service.dispatch({ type: 'not-a-type', body: 'q' });
  assert.equal(result.outcome, 'invalid-type');
  assert.equal(sends.length, 0);
});

// ── Subscription upsert semantics ──────────────────────────────────────────

test('re-subscribing the same endpoint updates in place', () => {
  const db = makeDb();
  const { service } = makeService(db);
  subscribeDevice(service, { deviceId: 'device-1', endpoint: 'https://push.example/same' });
  const updated = service.upsertSubscription({
    deviceId: 'device-1',
    label: 'Renamed',
    endpoint: 'https://push.example/same',
    keys: { p256dh: 'new-p', auth: 'new-a' },
    preferences: { content: { preview: 'full' } },
  });
  assert.equal(updated.ok, true);
  const devices = service.listDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].label, 'Renamed');
  assert.equal(devices[0].preferences.content.preview, 'full');
});

test('updateDevice renames and updates preferences; deleteDevice revokes', () => {
  const db = makeDb();
  const { service } = makeService(db);
  const device = subscribeDevice(service, { deviceId: 'device-1' });
  const renamed = service.updateDevice(device.id, { label: 'Kitchen tablet' });
  assert.equal(renamed.device.label, 'Kitchen tablet');
  const reconfigured = service.updateDevice(device.id, { preferences: { events: { question: false } } });
  assert.equal(reconfigured.device.preferences.events.question, false);
  assert.equal(service.deleteDevice(device.id).ok, true);
  assert.equal(service.listDevices().length, 0);
  assert.equal(service.deleteDevice(device.id).ok, false);
});
