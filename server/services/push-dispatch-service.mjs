'use strict';

/**
 * Web Push dispatch: decides whether a push should go out at all (suppressed
 * while any device is actively foregrounded), renders the notification per
 * subscription according to that device's content preferences, and prunes
 * subscriptions the push service reports as gone.
 *
 * A push failure must never break a turn: dispatch() swallows everything and
 * reports outcomes through the status-events store instead.
 */

export const PUSH_EVENT_TYPES = Object.freeze(['question', 'turnComplete', 'turnFailed', 'board', 'cliOffline']);

export const VAPID_PUBLIC_KEY_SETTING = 'push_vapid_public_key';
export const VAPID_PRIVATE_KEY_SETTING = 'push_vapid_private_key';

const PREVIEW_MODES = new Set(['none', 'truncated', 'full']);
const DEFAULT_PREVIEW_CHARS = 80;
const MIN_PREVIEW_CHARS = 20;
const MAX_PREVIEW_CHARS = 500;
// Push payloads are capped around 4 KB by the push services; keep the body
// well under that even in "full" mode.
const MAX_FULL_PREVIEW_CHARS = 2000;
const MAX_TITLE_CHARS = 120;
// A subscription that keeps failing for reasons other than 404/410 is dead
// weight; drop it after this many consecutive failures.
const FAILURE_PRUNE_THRESHOLD = 8;
const PUSH_TTL_SECONDS = 12 * 60 * 60;

const EVENT_LABELS = Object.freeze({
  question: { title: 'Copilot needs your input', generic: 'The agent asked a question.' },
  turnComplete: { title: 'Turn completed', generic: 'The agent finished its turn.' },
  turnFailed: { title: 'Turn failed', generic: 'The agent turn failed.' },
  board: { title: 'Plan ready for review', generic: 'The agent posted a board for review.' },
  cliOffline: { title: 'CLI offline', generic: 'The relay lost its connection to the CLI host.' },
});

function clampInt(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

/**
 * Normalize a raw (possibly user-supplied) preference object into the
 * canonical shape stored in preferences_json. Unknown fields are dropped,
 * missing fields get safe defaults (enabled, all events on except cliOffline,
 * generic content).
 */
export function normalizePushPreferences(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawEvents = source.events && typeof source.events === 'object' ? source.events : {};
  const rawContent = source.content && typeof source.content === 'object' ? source.content : {};
  const events = {};
  for (const type of PUSH_EVENT_TYPES) {
    const fallback = type !== 'cliOffline';
    events[type] = typeof rawEvents[type] === 'boolean' ? rawEvents[type] : fallback;
  }
  const preview = PREVIEW_MODES.has(rawContent.preview) ? rawContent.preview : 'none';
  return {
    enabled: source.enabled !== false,
    events,
    content: {
      includeTitle: rawContent.includeTitle === true,
      preview,
      previewChars: clampInt(rawContent.previewChars, MIN_PREVIEW_CHARS, MAX_PREVIEW_CHARS, DEFAULT_PREVIEW_CHARS),
    },
  };
}

/**
 * Render the notification payload for one subscription. Pure so every content
 * preference combination is unit-testable.
 *
 * @param {{ type: string, conversationTitle?: string|null, body?: string|null, data?: object }} event
 * @param {object} preferences canonical shape from normalizePushPreferences
 */
export function renderPushNotification(event, preferences) {
  const type = PUSH_EVENT_TYPES.includes(event?.type) ? event.type : 'question';
  const prefs = normalizePushPreferences(preferences);
  const labels = EVENT_LABELS[type];

  let title = labels.title;
  const conversationTitle = String(event?.conversationTitle || '').trim();
  if (prefs.content.includeTitle && conversationTitle) {
    title = `${labels.title} — ${conversationTitle}`.slice(0, MAX_TITLE_CHARS);
  }

  let body = labels.generic;
  const text = String(event?.body || '').trim();
  // cliOffline has no conversation text to preview; the generic body is the message.
  if (text && type !== 'cliOffline') {
    if (prefs.content.preview === 'full') {
      body = text.slice(0, MAX_FULL_PREVIEW_CHARS);
    } else if (prefs.content.preview === 'truncated') {
      const limit = prefs.content.previewChars;
      body = text.length > limit ? `${text.slice(0, limit)}…` : text;
    }
  }

  const data = event?.data && typeof event.data === 'object' ? { ...event.data } : {};
  data.type = type;

  // A distinct tag per event so notifications stack instead of replacing each
  // other (decision: one notification per event, no coalescing).
  const tagSeed = String(data.questionId || data.boardId || data.messageId || data.conversationId || Date.now());
  return {
    title,
    body,
    tag: `copilot-${type}-${tagSeed}`,
    timestamp: Date.now(),
    data,
  };
}

/**
 * Generate VAPID keys into app_settings on first start; subsequent starts
 * reuse the stored pair so subscriptions stay valid across restarts.
 *
 * @param {{ getAppSetting: { get(key: string): any }, upsertAppSetting: { run(key: string, value: string, updatedAt: string): any } }} stmts
 * @param {{ generateVapidKeys: () => { publicKey: string, privateKey: string }, now?: () => string }} options
 */
export function ensurePushVapidKeys(stmts, { generateVapidKeys, now = () => new Date().toISOString() }) {
  const existingPublic = String(stmts.getAppSetting.get(VAPID_PUBLIC_KEY_SETTING)?.value || '').trim();
  const existingPrivate = String(stmts.getAppSetting.get(VAPID_PRIVATE_KEY_SETTING)?.value || '').trim();
  if (existingPublic && existingPrivate) {
    return { publicKey: existingPublic, privateKey: existingPrivate, generated: false };
  }
  const keys = generateVapidKeys();
  const timestamp = now();
  stmts.upsertAppSetting.run(VAPID_PUBLIC_KEY_SETTING, keys.publicKey, timestamp);
  stmts.upsertAppSetting.run(VAPID_PRIVATE_KEY_SETTING, keys.privateKey, timestamp);
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, generated: true };
}

function parseJsonObject(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function formatPushDeviceRow(row) {
  if (!row) return null;
  return {
    id: String(row.id || ''),
    deviceId: String(row.device_id || ''),
    label: String(row.device_label || '').trim() || null,
    endpoint: String(row.endpoint || ''),
    preferences: normalizePushPreferences(parseJsonObject(row.preferences_json)),
    userAgent: String(row.user_agent || '').trim() || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastError: String(row.last_error || '').trim() || null,
    failureCount: Number(row.failure_count || 0),
  };
}

/**
 * @param {object} options
 * @param {import('better-sqlite3').Database} options.db
 * @param {{ sendNotification: Function }} options.webpush configured web-push module (VAPID details already set)
 * @param {() => boolean} options.hasActiveDevice suppression source; a throw is treated as "unknown" and fails closed
 * @param {(type: string, details?: object) => void} [options.recordStatusEvent]
 * @param {() => string} options.uuid
 * @param {Console} [options.logger]
 */
export function createPushDispatchService({
  db,
  webpush,
  hasActiveDevice,
  recordStatusEvent = () => {},
  uuid,
  logger = console,
}) {
  const sql = {
    listAll: db.prepare(`
      SELECT * FROM push_subscriptions
      ORDER BY updated_at DESC
    `),
    getById: db.prepare(`SELECT * FROM push_subscriptions WHERE id = ?`),
    getByEndpoint: db.prepare(`SELECT * FROM push_subscriptions WHERE endpoint = ?`),
    insert: db.prepare(`
      INSERT INTO push_subscriptions (
        id, device_id, device_label, endpoint, keys_json, preferences_json,
        user_agent, created_at, updated_at, last_success_at, last_error, failure_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)
    `),
    updateSubscription: db.prepare(`
      UPDATE push_subscriptions
      SET device_id = ?, device_label = ?, keys_json = ?, preferences_json = ?, user_agent = ?, updated_at = ?
      WHERE id = ?
    `),
    updateLabel: db.prepare(`UPDATE push_subscriptions SET device_label = ?, updated_at = ? WHERE id = ?`),
    updatePreferences: db.prepare(`UPDATE push_subscriptions SET preferences_json = ?, updated_at = ? WHERE id = ?`),
    delete: db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`),
    markSuccess: db.prepare(`
      UPDATE push_subscriptions
      SET last_success_at = ?, last_error = NULL, failure_count = 0
      WHERE id = ?
    `),
    markFailure: db.prepare(`
      UPDATE push_subscriptions
      SET last_error = ?, failure_count = failure_count + 1
      WHERE id = ?
    `),
    getConversationTitle: db.prepare(`SELECT title FROM conversations WHERE id = ?`),
  };

  function listDevices() {
    return sql.listAll.all().map(formatPushDeviceRow).filter(Boolean);
  }

  function getDevice(id) {
    return formatPushDeviceRow(sql.getById.get(String(id || '')));
  }

  /**
   * Register or refresh a device's subscription. Upserts on the unique
   * endpoint so a browser that re-subscribes updates in place.
   */
  function upsertSubscription({ deviceId, label, endpoint, keys, preferences, userAgent }) {
    const normalizedEndpoint = String(endpoint || '').trim();
    const normalizedDeviceId = String(deviceId || '').trim();
    if (!normalizedEndpoint || !normalizedDeviceId || !keys || typeof keys !== 'object') {
      return { ok: false, error: 'Missing endpoint, deviceId, or keys' };
    }
    const now = new Date().toISOString();
    const normalizedLabel = String(label || '').trim().slice(0, 80) || null;
    const normalizedUserAgent = String(userAgent || '').trim().slice(0, 200) || null;
    const preferencesJson = JSON.stringify(normalizePushPreferences(preferences));
    const keysJson = JSON.stringify({
      p256dh: String(keys.p256dh || ''),
      auth: String(keys.auth || ''),
    });
    const existing = sql.getByEndpoint.get(normalizedEndpoint);
    if (existing) {
      sql.updateSubscription.run(
        normalizedDeviceId,
        normalizedLabel ?? existing.device_label,
        keysJson,
        preferencesJson,
        normalizedUserAgent ?? existing.user_agent,
        now,
        existing.id,
      );
      return { ok: true, device: getDevice(existing.id) };
    }
    const id = uuid();
    sql.insert.run(
      id,
      normalizedDeviceId,
      normalizedLabel,
      normalizedEndpoint,
      keysJson,
      preferencesJson,
      normalizedUserAgent,
      now,
      now,
    );
    return { ok: true, device: getDevice(id) };
  }

  function updateDevice(id, { label, preferences } = {}) {
    const row = sql.getById.get(String(id || ''));
    if (!row) return { ok: false, error: 'Not found' };
    const now = new Date().toISOString();
    if (label !== undefined) {
      sql.updateLabel.run(String(label || '').trim().slice(0, 80) || null, now, row.id);
    }
    if (preferences !== undefined) {
      sql.updatePreferences.run(JSON.stringify(normalizePushPreferences(preferences)), now, row.id);
    }
    return { ok: true, device: getDevice(row.id) };
  }

  function deleteDevice(id) {
    const result = sql.delete.run(String(id || ''));
    return { ok: result.changes > 0 };
  }

  function conversationTitle(conversationId) {
    const id = String(conversationId || '').trim();
    if (!id) return null;
    try {
      return String(sql.getConversationTitle.get(id)?.title || '').trim() || null;
    } catch {
      return null;
    }
  }

  function safeRecordStatusEvent(type, details) {
    try {
      recordStatusEvent(type, details);
    } catch {}
  }

  async function sendToSubscription(row, event) {
    const preferences = normalizePushPreferences(parseJsonObject(row.preferences_json));
    const payload = renderPushNotification(event, preferences);
    const keys = parseJsonObject(row.keys_json) || {};
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys },
        JSON.stringify(payload),
        { TTL: PUSH_TTL_SECONDS, urgency: 'high' },
      );
      sql.markSuccess.run(new Date().toISOString(), row.id);
      return { sent: true };
    } catch (error) {
      const statusCode = Number(error?.statusCode || 0);
      if (statusCode === 404 || statusCode === 410) {
        // The push service says this subscription no longer exists; drop it.
        sql.delete.run(row.id);
        safeRecordStatusEvent('push-subscription-pruned', {
          deviceId: row.device_id,
          label: row.device_label || undefined,
          statusCode,
        });
        return { sent: false, pruned: true };
      }
      const message = String(error?.message || error || 'unknown').slice(0, 200);
      sql.markFailure.run(message, row.id);
      const failureCount = Number(sql.getById.get(row.id)?.failure_count || 0);
      if (failureCount >= FAILURE_PRUNE_THRESHOLD) {
        sql.delete.run(row.id);
        safeRecordStatusEvent('push-subscription-pruned', {
          deviceId: row.device_id,
          label: row.device_label || undefined,
          failureCount,
        });
      }
      return { sent: false, error: message, statusCode: statusCode || undefined };
    }
  }

  /**
   * Fire-and-forget push for one event. Never throws; suppression failures
   * fail closed (no push when the active-device state is unknown).
   */
  async function dispatch({ type, conversationId = null, body = null, data = {} }) {
    try {
      if (!PUSH_EVENT_TYPES.includes(type)) return { outcome: 'invalid-type' };

      let active = true; // fail closed: unknown state suppresses
      try {
        active = hasActiveDevice() === true;
      } catch {
        active = true;
      }
      if (active) {
        safeRecordStatusEvent('push-suppressed', { eventType: type, conversationId: conversationId || undefined });
        return { outcome: 'suppressed' };
      }

      const rows = sql.listAll.all().filter((row) => {
        const preferences = normalizePushPreferences(parseJsonObject(row.preferences_json));
        return preferences.enabled && preferences.events[type] === true;
      });
      if (!rows.length) {
        return { outcome: 'no-subscribers' };
      }

      const event = {
        type,
        conversationTitle: conversationTitle(conversationId),
        body,
        data: { ...data, conversationId: conversationId || undefined },
      };
      const results = await Promise.all(rows.map((row) => sendToSubscription(row, event)));
      const sent = results.filter((result) => result.sent).length;
      const failed = results.length - sent;
      safeRecordStatusEvent('push-dispatched', {
        eventType: type,
        conversationId: conversationId || undefined,
        sent,
        failed: failed || undefined,
      });
      return { outcome: 'dispatched', sent, failed };
    } catch (error) {
      // Never let a push failure surface into the calling turn.
      try {
        logger.warn(`[push] dispatch failed: ${error?.message || error}`);
      } catch {}
      return { outcome: 'error' };
    }
  }

  // Semantic wrappers so each io.emit call site stays a single line and the
  // payload construction lives in one place.
  function notifyQuestion(question) {
    // Short choices become notification action buttons. Long ones are skipped
    // rather than truncated: the button text is also the answer that gets
    // POSTed back, and a truncated answer would be wrong.
    const choices = (Array.isArray(question?.choices) ? question.choices : [])
      .map((choice) => String(choice || '').trim())
      .filter((choice) => choice && choice.length <= 120)
      .slice(0, 3);
    return dispatch({
      type: 'question',
      conversationId: question?.conversationId || null,
      body: question?.prompt || null,
      data: {
        questionId: question?.id || undefined,
        choices: choices.length ? choices : undefined,
      },
    });
  }

  function notifyTurnComplete({ conversationId, messageId, text } = {}) {
    return dispatch({
      type: 'turnComplete',
      conversationId: conversationId || null,
      body: text || null,
      data: { messageId: messageId || undefined },
    });
  }

  function notifyTurnFailed({ conversationId, messageId, text } = {}) {
    return dispatch({
      type: 'turnFailed',
      conversationId: conversationId || null,
      body: text || null,
      data: { messageId: messageId || undefined },
    });
  }

  function notifyBoard(board) {
    return dispatch({
      type: 'board',
      conversationId: board?.conversationId || null,
      body: board?.title || board?.body || null,
      data: { boardId: board?.id || undefined },
    });
  }

  function notifyCliOffline() {
    return dispatch({ type: 'cliOffline' });
  }

  return {
    listDevices,
    getDevice,
    upsertSubscription,
    updateDevice,
    deleteDevice,
    dispatch,
    notifyQuestion,
    notifyTurnComplete,
    notifyTurnFailed,
    notifyBoard,
    notifyCliOffline,
  };
}
