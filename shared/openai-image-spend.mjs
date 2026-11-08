// What OpenAI image turns cost a relay, and its daily cap: the setting keys,
// the codes, the routes and the shape of the spend state the server, the
// dispatcher and the web client share.
//
// "Today" is the relay's local day, the one turn_token_usage.day and
// token_usage_days use. Image turns book there as provider 'openai',
// billing 'image', one row per try (run_id image:<attempt or claim>:try<n>,
// or …:recovered), priced from shared/openai-image-prices.mjs. Estimates and
// the stand-in price of an unknown model count toward the cap, on purpose:
// a cap that misses what may have been billed is no cap.
//
// SDK-free and side-effect free.

export const OPENAI_IMAGE_BOOKING_PROVIDER = 'openai';
export const OPENAI_IMAGE_BOOKING_BILLING = 'image';

// cost_source of a booked row: priced from the usage OpenAI reported, or an
// estimate (a try that may have been billed without a usage, a model the
// table lacks: then cost_unknown is 1 too).
export const OPENAI_IMAGE_COST_SOURCES = Object.freeze({
  table: 'oar-openai-image-table',
  estimate: 'oar-openai-image-estimate',
});

// app_settings keys (JSON values).
export const OPENAI_IMAGE_SPEND_SETTING_KEYS = Object.freeze({
  // USD. 0 means no cap; missing or unreadable means USD 5.
  dailyCapUsd: 'openai_image_daily_cap_usd',
  // The relay-local day ("YYYY-MM-DD") the owner allowed image turns past
  // the cap, and when; it ends by itself when the day does.
  overrideDay: 'openai_image_cap_override_day',
  overrideAt: 'openai_image_cap_override_at',
});

export const OPENAI_IMAGE_DAILY_CAP_DEFAULT_USD = 5;
// The share of the cap from which replies and image chats show a warning.
export const OPENAI_IMAGE_CAP_WARN_RATIO = 0.8;

// A try the cap stops before it is sent, and a send POST /api/message
// refuses (409), when the cap is reached and today is not allowed.
export const OPENAI_IMAGE_DAILY_CAP_REACHED_CODE = 'OPENAI_IMAGE_DAILY_CAP_REACHED';

// GET: the spend state below. Owner token; a paired relay may read it (its
// dispatcher checks before create_session) but never write the cap. With
// `?conversationId=<id>` the state carries `conversation`: that chat's
// { costUsd, estimatedUsd, images, tries }.
export const OPENAI_IMAGE_USAGE_PATH = '/api/image-usage';

// Socket event (owner clients) with the spend state after every booking and
// every change of the cap or the override.
export const OPENAI_IMAGE_USAGE_EVENT = 'image_usage_updated';

// POST /api/settings/openai takes, besides its other fields:
//   imageDailyCapUsd: number ≥ 0 (0 = no cap)
//   allowImagesToday: true (sets the override for today) | false (clears it)
// Refused with 403 for a paired relay's request.
export const OPENAI_IMAGE_SETTINGS_FIELDS = Object.freeze({
  dailyCapUsd: 'imageDailyCapUsd',
  allowToday: 'allowImagesToday',
});

// The presets routes (owner token, never a paired relay's write):
//   GET    /api/openai-image-presets           → { presets: [{ name, …values, builtIn }] }
//   PUT    /api/openai-image-presets           body { preset: { name, …values }, replace? } → { presets }
//   DELETE /api/openai-image-presets/:name     → { presets }
export const OPENAI_IMAGE_PRESETS_PATH = '/api/openai-image-presets';

/**
 * The spend state (GET OPENAI_IMAGE_USAGE_PATH, the `usage` action's meter,
 * the Check Usage card, the banner):
 * {
 *   day: 'YYYY-MM-DD',          // relay local
 *   capUsd: number | null,      // null: no cap
 *   spentUsd: number,           // booked today, estimates included
 *   reservedUsd: number,        // tries in flight today
 *   estimatedUsd: number,       // the part of spentUsd that is estimates
 *   unknownPriceUsd: number,    // the part booked at the stand-in price
 *   monthUsd: number,           // this relay-local month, booked
 *   ratio: number | null,       // (spent + reserved) / cap
 *   warning: boolean,           // ratio ≥ OPENAI_IMAGE_CAP_WARN_RATIO
 *   reached: boolean,           // spent + reserved ≥ cap
 *   allowedToday: boolean,      // the owner's override for this day
 *   allowedAt: string | null,
 * }
 */
export function formatOpenAIImageUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'USD ?';
  return `USD ${number > 0 && number < 0.01 ? number.toFixed(3) : number.toFixed(2)}`;
}
