/**
 * What OpenAI image turns cost this relay today, and its daily cap
 * (shared/openai-image-spend.mjs).
 *
 * One instance per relay process: the send function of image requests
 * (messages-routes runOpenAIImageRequest) asks it before each try leaves the
 * relay, and books with it when the try ends.
 *
 * - Before a try: today's booked spend (token_usage_days, provider 'openai',
 *   billing 'image', estimates included), the tries in flight today and this
 *   try's estimate against the cap, and the try's estimate reserved, in one
 *   synchronous step, so two turns cannot both pass on the same headroom.
 *   A reservation belongs to the relay-local day its try started on: a check
 *   after midnight does not see yesterday's.
 * - When a try ends: its cost booked (tokenUsageService.recordTurn, one row
 *   per try, report.at = the try's start) and its reservation dropped, in the
 *   same synchronous step. A booking that fails stays counted for its day in
 *   memory (fail closed) until a later booking writes it, or its day ends.
 * - A restart drops the reservations along with every try in flight; the
 *   recovery books an estimate for an attempt that was cut off.
 *
 * Every booking emits the spend state (OPENAI_IMAGE_USAGE_EVENT).
 */

import {
  OPENAI_IMAGE_BOOKING_BILLING,
  OPENAI_IMAGE_BOOKING_PROVIDER,
  OPENAI_IMAGE_CAP_WARN_RATIO,
  OPENAI_IMAGE_COST_SOURCES,
  OPENAI_IMAGE_DAILY_CAP_DEFAULT_USD,
  OPENAI_IMAGE_DAILY_CAP_REACHED_CODE,
  OPENAI_IMAGE_SPEND_SETTING_KEYS,
  OPENAI_IMAGE_USAGE_EVENT,
  formatOpenAIImageUsd,
} from '../../shared/openai-image-spend.mjs';
import {
  estimateOpenAIImageCost,
  openAIImageBookingModel,
  openAIImageCostFloor,
  priceOpenAIImageUsage,
} from '../../shared/openai-image-prices.mjs';

// A try that ended this way may have been billed without a usage to show:
// it books the estimate (a refusal only when it came after the stream had
// started). The 5xx are among them, both the HTTP status and the stream's
// server error event: OpenAI does not say they are free.
const ESTIMATED_KINDS = new Set(['timeout', 'broken', 'stream', 'unprocessed', 'server']);
// How far a try's start may lie back for its booking to keep that time
// (token-usage-service.mjs takes the relay's clock past it).
const AT_SKEW_MS = 24 * 60 * 60 * 1000;
const CAP_PLACE = 'Settings → Providers → OpenAI';
const CAP_REMEDY = `Allow more for today in ${CAP_PLACE}, or wait until tomorrow (relay time).`;

/** The run_id of one try: `image:<attempt or claim>:try<n>`. */
export function openAIImageTryRunId(scopeId, tryNumber) {
  return `image:${scopeId}:try${tryNumber}`;
}

/** The run_id of the estimate the recovery books for an attempt cut off. */
export function openAIImageRecoveredRunId(attemptId) {
  return `image:${attemptId}:recovered`;
}

/**
 * What one ended try books, or null for nothing:
 * - the usage OpenAI reported, whenever any was read (a completed reply, or
 *   the completed events before a stream broke off, or a 2xx the relay could
 *   not process), priced as it is;
 * - a reply with its images but no usage: the per-image floor × count;
 * - a try that may have been billed without a usage: the estimate, with the
 *   partials it received;
 * - nothing for a try that never reached OpenAI, or a refusal before any work.
 * `request` is `{ model, size, quality, count, inputImages }`.
 */
export function openAIImageTryCharge({ tried, request }) {
  if (!tried) return null;
  const priced = tried.usage ? priceOpenAIImageUsage({ model: request.model, usage: tried.usage }) : null;
  if (priced) {
    return {
      basis: 'usage',
      inputTokens: priced.inputTokens,
      outputTokens: priced.outputTokens,
      costUsd: priced.costUsd,
      costSource: priced.source,
      costUnknown: priced.costUnknown,
    };
  }
  let estimate = null;
  let basis = 'estimate';
  if (tried.ok) {
    estimate = openAIImageCostFloor(request);
    basis = 'floor';
  } else if (ESTIMATED_KINDS.has(tried.kind) || (tried.kind === 'refused' && tried.streamed === true)) {
    estimate = estimateOpenAIImageCost({ ...request, partials: tried.partials || 0 });
  }
  if (!estimate) return null;
  return {
    basis,
    inputTokens: null,
    outputTokens: null,
    costUsd: estimate.costUsd,
    costSource: OPENAI_IMAGE_COST_SOURCES.estimate,
    costUnknown: estimate.costUnknown,
  };
}

/**
 * The failure note of a try the cap stopped before it was sent
 * (`refusal`: reserveTry's). On the first try nothing went to OpenAI; on the
 * second the first may have been billed.
 */
export function openAIImageCapRefusalText({ tryNumber = 1, refusal = {} } = {}) {
  const first = tryNumber <= 1;
  if (refusal.unreadable) {
    return first
      ? 'The relay could not read today\'s OpenAI image spend, so nothing was sent to OpenAI. Retry the message.'
      : 'The first try may have been billed, and the relay could not read today\'s OpenAI image spend, so the second was not sent. Retry the message.';
  }
  const figures = `today's estimated OpenAI image spend on this relay, ${formatOpenAIImageUsd(refusal.spentUsd)}, and this ${first ? 'turn' : 'try'}'s estimate, ${formatOpenAIImageUsd(refusal.estimateUsd)}, would pass the daily cap of ${formatOpenAIImageUsd(refusal.capUsd)}`;
  return first
    ? `${figures.charAt(0).toUpperCase()}${figures.slice(1)}, so nothing was sent to OpenAI. ${CAP_REMEDY}`
    : `The first try may have been billed, and the daily cap stopped the second: ${figures}. ${CAP_REMEDY}`;
}

function dayFormatter(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }
}

function usd(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6;
}

// An app_settings value as text: stored plain or as JSON.
function settingText(raw) {
  const text = String(raw ?? '').trim();
  if (text.startsWith('"')) {
    try { return String(JSON.parse(text)).trim(); } catch {}
  }
  return text;
}

function countGeneratedImages(attachmentsJson) {
  try {
    const list = JSON.parse(String(attachmentsJson || '[]'));
    return Array.isArray(list) ? list.filter((entry) => entry?.generatedImage).length : 0;
  } catch {
    return 0;
  }
}

export function createOpenAIImageSpendService({
  tokenUsageService = null,
  // (key) → the app_settings value as text, '' when unset.
  readSetting = () => '',
  // For a chat's image count (messages); optional.
  db = null,
  // (event, payload) → the owner's clients.
  emit = null,
  now = () => Date.now(),
  timeZone = undefined,
  logger = console,
} = {}) {
  const ownFormat = dayFormatter(timeZone);
  const localDay = (ms) => (typeof tokenUsageService?.localDay === 'function'
    ? tokenUsageService.localDay(ms)
    : ownFormat.format(new Date(ms)));
  const reservations = new Map();
  let reservationSeq = 0;
  // Bookings the token tables did not take: { day, usd, estimate, unknown,
  // conversationId, turnId, runId, args }.
  let unbooked = [];
  const warned = new Set();
  const warnOnce = (key, text) => {
    if (warned.has(key)) return;
    warned.add(key);
    logger?.warn?.(text);
  };

  function readCap(nowMs) {
    const day = localDay(nowMs);
    let capUsd = OPENAI_IMAGE_DAILY_CAP_DEFAULT_USD;
    let overrideDay = '';
    let overrideAt = '';
    try {
      const raw = settingText(readSetting(OPENAI_IMAGE_SPEND_SETTING_KEYS.dailyCapUsd));
      if (raw !== '') {
        const value = Number(raw);
        // A value that cannot be read keeps the default: never no cap.
        if (Number.isFinite(value) && value >= 0) capUsd = value;
      }
      overrideDay = settingText(readSetting(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideDay));
      overrideAt = settingText(readSetting(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideAt));
    } catch (error) {
      warnOnce('settings', `[image-spend] the cap settings could not be read; the default cap applies: ${error?.message || error}`);
    }
    const allowedToday = Boolean(overrideDay) && overrideDay === day;
    return { day, capUsd: capUsd > 0 ? capUsd : null, allowedToday, allowedAt: allowedToday ? (overrideAt || null) : null };
  }

  // Booked today and this month (day rows), or null when they cannot be read.
  function readBooked(nowMs) {
    if (!tokenUsageService?.readPeriods) return { today: 0, month: 0 };
    try {
      const periods = tokenUsageService.readPeriods({ provider: OPENAI_IMAGE_BOOKING_PROVIDER, now: nowMs });
      const group = periods?.groups?.find((entry) => entry.billing === OPENAI_IMAGE_BOOKING_BILLING);
      return { today: Number(group?.periods?.today?.costUsd || 0), month: Number(group?.periods?.month?.costUsd || 0) };
    } catch (error) {
      warnOnce('read', `[image-spend] today's image spend could not be read: ${error?.message || error}`);
      return null;
    }
  }

  function reservedFor(day) {
    let sum = 0;
    for (const entry of reservations.values()) if (entry.day === day) sum += entry.usd;
    return sum;
  }

  function unbookedFor(filter) {
    let sum = 0;
    for (const entry of unbooked) if (filter(entry)) sum += entry.usd;
    return sum;
  }

  // The cap's figures without the turn rows: for the checks.
  function snapshot(nowMs) {
    const cap = readCap(nowMs);
    const booked = readBooked(nowMs);
    const month = cap.day.slice(0, 7);
    const spentUsd = (booked?.today || 0) + unbookedFor((entry) => entry.day === cap.day);
    const monthUsd = (booked?.month || 0) + unbookedFor((entry) => entry.day.startsWith(`${month}-`));
    return { ...cap, unreadable: !booked, spentUsd, monthUsd, reservedUsd: reservedFor(cap.day) };
  }

  /**
   * Before a try leaves the relay: refused (`{ ok:false, … }`, nothing to
   * send) when today's spend, the tries in flight and this estimate would
   * pass the cap and today is not allowed; else the estimate is reserved
   * (`{ ok:true, reservation }`) until settleTry or releaseTry.
   */
  function reserveTry({ estimateUsd = 0, startedAtMs = now() } = {}) {
    const state = snapshot(startedAtMs);
    const estimate = usd(estimateUsd);
    if (state.capUsd !== null && !state.allowedToday) {
      if (state.unreadable) return { ok: false, unreadable: true, day: state.day, capUsd: state.capUsd, estimateUsd: estimate };
      const spentUsd = usd(state.spentUsd + state.reservedUsd);
      if (spentUsd + estimate > state.capUsd + 1e-9) {
        return { ok: false, day: state.day, spentUsd, estimateUsd: estimate, capUsd: state.capUsd };
      }
    }
    reservationSeq += 1;
    const reservation = { id: reservationSeq, day: state.day, usd: estimate, startedAtMs };
    reservations.set(reservation.id, { day: reservation.day, usd: estimate });
    return { ok: true, reservation };
  }

  /** Drops a reservation whose try books nothing (a refusal, a throw, an abort). */
  function releaseTry(reservation) {
    if (reservation) reservations.delete(reservation.id);
  }

  function tryRecord(entry) {
    if (!tokenUsageService?.recordTurn) return false;
    try {
      return Boolean(tokenUsageService.recordTurn(entry.args));
    } catch (error) {
      warnOnce(`book:${error?.message || error}`, `[image-spend] booking an image try failed; it stays counted in memory: ${error?.message || error}`);
      return false;
    }
  }

  // Books one row, after the ones that failed before; whatever the tables
  // do not take stays counted for its day.
  function book(entry) {
    const today = localDay(now());
    if (unbooked.length) {
      const kept = [];
      for (const earlier of unbooked) {
        if (tryRecord(earlier)) continue;
        if (earlier.day < today) {
          logger?.warn?.(`[image-spend] an image try of ${earlier.day} (${formatOpenAIImageUsd(earlier.usd)}) could not be booked and is dropped with its day`);
          continue;
        }
        kept.push(earlier);
      }
      unbooked = kept;
    }
    if (tryRecord(entry)) return true;
    if (!tokenUsageService?.recordTurn) warnOnce('no-service', '[image-spend] no token usage storage: image costs are counted in memory only');
    else warnOnce('null', '[image-spend] the token usage tables are not there: image costs are counted in memory until they are');
    unbooked.push(entry);
    return false;
  }

  function bookingEntry({ conversationId, turnId, runId, model, atMs, charge }) {
    const nowMs = now();
    const dayMs = Number.isFinite(atMs) && Math.abs(atMs - nowMs) <= AT_SKEW_MS ? atMs : nowMs;
    return {
      day: localDay(dayMs),
      usd: usd(charge.costUsd),
      estimate: charge.costSource === OPENAI_IMAGE_COST_SOURCES.estimate,
      unknown: charge.costUnknown === true,
      conversationId: String(conversationId || ''),
      turnId: String(turnId || ''),
      runId,
      args: {
        conversationId: String(conversationId || ''),
        provider: OPENAI_IMAGE_BOOKING_PROVIDER,
        billing: OPENAI_IMAGE_BOOKING_BILLING,
        report: {
          turnId: String(turnId || ''),
          runId,
          nativeSessionId: null,
          responseMessageId: null,
          at: new Date(dayMs).toISOString(),
          models: [{
            model: openAIImageBookingModel(model),
            inputTokens: charge.inputTokens ?? null,
            outputTokens: charge.outputTokens ?? null,
            costUsd: usd(charge.costUsd),
            costSource: charge.costSource,
            costUnknown: charge.costUnknown === true,
          }],
        },
      },
    };
  }

  /**
   * A try ended: its reservation dropped and its cost (openAIImageTryCharge;
   * null books nothing) booked, synchronously. Returns whether a row was
   * written (false: none, or kept in memory).
   */
  function settleTry(reservation, { conversationId, turnId, runId, model, charge = null } = {}) {
    releaseTry(reservation);
    if (!charge) return false;
    const written = book(bookingEntry({ conversationId, turnId, runId, model, atMs: reservation?.startedAtMs, charge }));
    notifyImageSpendChanged();
    return written;
  }

  /**
   * The recovery found an attempt cut off while it ran (`started`): its
   * estimate, as `image:<attemptId>:recovered`, unless a try of that attempt
   * was booked already. Returns whether it booked.
   */
  function bookRecovered({ conversationId, turnId, attemptId, model, startedAt, request }) {
    if (!attemptId || !turnId) return false;
    const prefix = `image:${attemptId}:`;
    let rows = [];
    try {
      rows = tokenUsageService?.readTurn?.(turnId)?.rows || [];
    } catch {}
    if (rows.some((row) => String(row.runId || '').startsWith(prefix))) return false;
    if (unbooked.some((entry) => entry.runId.startsWith(prefix))) return false;
    const estimate = estimateOpenAIImageCost({ ...request, model });
    book(bookingEntry({
      conversationId,
      turnId,
      runId: openAIImageRecoveredRunId(attemptId),
      model,
      atMs: Date.parse(String(startedAt || '')),
      charge: {
        inputTokens: null,
        outputTokens: null,
        costUsd: estimate.costUsd,
        costSource: OPENAI_IMAGE_COST_SOURCES.estimate,
        costUnknown: estimate.costUnknown,
      },
    }));
    notifyImageSpendChanged();
    return true;
  }

  function imageRows(rows) {
    return (rows || []).filter((row) => row.provider === OPENAI_IMAGE_BOOKING_PROVIDER && row.billing === OPENAI_IMAGE_BOOKING_BILLING);
  }

  /**
   * What one turn's tries were booked at (the reply line):
   * `{ costUsd, estimated, unknownPrice, tries }`, or null when none.
   */
  function turnCost(turnId) {
    const id = String(turnId || '');
    let rows = [];
    try {
      rows = imageRows(tokenUsageService?.readTurn?.(id)?.rows);
    } catch {}
    const parts = [
      ...rows.map((row) => ({ usd: Number(row.costUsd || 0), estimate: row.costSource === OPENAI_IMAGE_COST_SOURCES.estimate, unknown: row.costUnknown === true })),
      ...unbooked.filter((entry) => entry.turnId === id).map((entry) => ({ usd: entry.usd, estimate: entry.estimate, unknown: entry.unknown })),
    ];
    if (!parts.length) return null;
    return {
      costUsd: usd(parts.reduce((sum, part) => sum + part.usd, 0)),
      estimated: parts.some((part) => part.estimate),
      unknownPrice: parts.some((part) => part.unknown),
      tries: parts.length,
    };
  }

  function readImageTurnRows(filter) {
    try {
      return imageRows(tokenUsageService?.readTurnRows?.({
        provider: OPENAI_IMAGE_BOOKING_PROVIDER,
        billing: OPENAI_IMAGE_BOOKING_BILLING,
        ...filter,
      }));
    } catch {
      return [];
    }
  }

  function conversationImages(conversationId) {
    if (!db?.prepare) return 0;
    try {
      const rows = db.prepare(`SELECT attachments FROM messages WHERE conversation_id = ? AND role = 'assistant' AND attachments IS NOT NULL`).all(conversationId) || [];
      return rows.reduce((sum, row) => sum + countGeneratedImages(row.attachments), 0);
    } catch {
      return 0;
    }
  }

  /**
   * The spend state (shared/openai-image-spend.mjs); with `conversationId`
   * also that chat's `{ costUsd, estimatedUsd, images, tries }`. The estimate
   * and unknown-price shares come from the turn rows (the day rows keep no
   * cost_source): a deleted chat's rows are gone from them.
   */
  function buildState({ conversationId = null, nowMs = now() } = {}) {
    const state = snapshot(nowMs);
    const todayRows = readImageTurnRows({ day: state.day });
    const todayUnbooked = unbooked.filter((entry) => entry.day === state.day);
    const estimatedUsd = todayRows.filter((row) => row.costSource === OPENAI_IMAGE_COST_SOURCES.estimate).reduce((sum, row) => sum + Number(row.costUsd || 0), 0)
      + todayUnbooked.filter((entry) => entry.estimate).reduce((sum, entry) => sum + entry.usd, 0);
    const unknownPriceUsd = todayRows.filter((row) => row.costUnknown).reduce((sum, row) => sum + Number(row.costUsd || 0), 0)
      + todayUnbooked.filter((entry) => entry.unknown).reduce((sum, entry) => sum + entry.usd, 0);
    const used = state.spentUsd + state.reservedUsd;
    const ratio = state.capUsd !== null ? used / state.capUsd : null;
    const out = {
      day: state.day,
      capUsd: state.capUsd,
      spentUsd: usd(state.spentUsd),
      reservedUsd: usd(state.reservedUsd),
      estimatedUsd: usd(estimatedUsd),
      unknownPriceUsd: usd(unknownPriceUsd),
      monthUsd: usd(state.monthUsd),
      ratio: ratio === null ? null : Math.round(ratio * 10000) / 10000,
      warning: ratio !== null && ratio >= OPENAI_IMAGE_CAP_WARN_RATIO,
      reached: state.capUsd !== null && used >= state.capUsd - 1e-9,
      allowedToday: state.allowedToday,
      allowedAt: state.allowedAt,
    };
    if (conversationId) {
      const id = String(conversationId);
      const rows = readImageTurnRows({ conversationId: id });
      const pending = unbooked.filter((entry) => entry.conversationId === id);
      out.conversation = {
        costUsd: usd(rows.reduce((sum, row) => sum + Number(row.costUsd || 0), 0) + pending.reduce((sum, entry) => sum + entry.usd, 0)),
        estimatedUsd: usd(rows.filter((row) => row.costSource === OPENAI_IMAGE_COST_SOURCES.estimate).reduce((sum, row) => sum + Number(row.costUsd || 0), 0)
          + pending.filter((entry) => entry.estimate).reduce((sum, entry) => sum + entry.usd, 0)),
        images: conversationImages(id),
        tries: rows.length + pending.length,
      };
    }
    return out;
  }

  /**
   * A send to an image model (POST /api/message), any sender: null, or
   * `{ code, error }` while today's booked and reserved spend has reached
   * the cap and today is not allowed.
   */
  function sendRefusal({ nowMs = now() } = {}) {
    const state = snapshot(nowMs);
    if (state.capUsd === null || state.allowedToday) return null;
    if (state.unreadable) {
      return {
        code: OPENAI_IMAGE_DAILY_CAP_REACHED_CODE,
        error: 'The relay could not read today\'s OpenAI image spend, so it cannot check the daily cap. Nothing was sent.',
      };
    }
    const used = state.spentUsd + state.reservedUsd;
    if (used < state.capUsd - 1e-9) return null;
    return {
      code: OPENAI_IMAGE_DAILY_CAP_REACHED_CODE,
      error: `Today's estimated OpenAI image spend on this relay, ${formatOpenAIImageUsd(used)}, has reached the daily cap of ${formatOpenAIImageUsd(state.capUsd)} (${CAP_PLACE}). Nothing was sent. Allow more for today there, or wait until tomorrow (relay time).`,
    };
  }

  /** Emits the spend state to the owner's clients: after a booking, a cap or an override change. */
  function notifyImageSpendChanged() {
    if (typeof emit !== 'function') return;
    try {
      emit(OPENAI_IMAGE_USAGE_EVENT, buildState());
    } catch (error) {
      warnOnce(`emit:${error?.message || error}`, `[image-spend] the spend state could not be sent: ${error?.message || error}`);
    }
  }

  return {
    localDay: (ms = now()) => localDay(ms),
    reserveTry,
    releaseTry,
    settleTry,
    bookRecovered,
    turnCost,
    buildState,
    sendRefusal,
    notifyImageSpendChanged,
  };
}
