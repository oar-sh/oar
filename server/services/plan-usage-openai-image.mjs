'use strict';

/**
 * OpenAI images on the Check Usage modal (provider `openai`, the booking's
 * provider, so the Tokens sections of plan-usage-tokens.mjs land on it).
 *
 * The figures are the spend state of shared/openai-image-spend.mjs: today
 * and this month in the relay's local days, booked by OAR from its price
 * table, estimates and the stand-in price of an unknown model included (they
 * count toward the cap on purpose). The card shows the daily cap as a meter,
 * the warning share, the owner's "Allow for today", and how much of today is
 * estimated. The raw state rides along as `imageSpend` for the browser's cap
 * bar.
 */

import {
  SOURCE_WORKER,
  STATUS_OK,
  STATUS_UNAVAILABLE,
  buildMeter,
  buildProviderCard,
  roundCurrency,
  toFiniteNumber,
} from './plan-usage-contract.mjs';
import {
  OPENAI_IMAGE_BOOKING_PROVIDER,
  OPENAI_IMAGE_CAP_WARN_RATIO,
  formatOpenAIImageUsd,
} from '../../shared/openai-image-spend.mjs';

export const OPENAI_IMAGE_CARD_LABEL = 'OpenAI images';

const OPENAI_USAGE_URL = 'https://platform.openai.com/usage';

const usd = (value) => Math.max(0, toFiniteNumber(value) ?? 0);

/**
 * The card, or null when there is nothing to show: OpenAI is off and nothing
 * was booked this month. `state` is the spend state; `error` replaces it
 * when it could not be read.
 */
export function buildOpenAIImagePlanCard({ state = null, error = null, configured = false } = {}) {
  const links = [{ label: 'OpenAI usage', url: OPENAI_USAGE_URL }];
  if (!state) {
    if (!configured) return null;
    return buildProviderCard({
      provider: OPENAI_IMAGE_BOOKING_PROVIDER,
      label: OPENAI_IMAGE_CARD_LABEL,
      status: STATUS_UNAVAILABLE,
      message: `This relay's OpenAI image spend could not be read${error ? `: ${error}` : ''}.`,
      source: SOURCE_WORKER,
      links,
    });
  }
  const spent = usd(state.spentUsd);
  const reserved = usd(state.reservedUsd);
  const month = usd(state.monthUsd);
  if (!configured && month <= 0 && spent <= 0 && reserved <= 0) return null;

  const capUsd = toFiniteNumber(state.capUsd);
  const hasCap = capUsd !== null && capUsd > 0;
  const used = roundCurrency(spent + reserved);
  const allowed = state.allowedToday === true;
  const percent = hasCap ? Math.round((used / capUsd) * 100) : null;

  const messages = [];
  if (hasCap && state.reached === true) {
    messages.push(allowed
      ? `Today's image spend has reached the daily cap of ${formatOpenAIImageUsd(capUsd)}; image turns run anyway, because the owner allowed them for today.`
      : `Today's image spend has reached the daily cap of ${formatOpenAIImageUsd(capUsd)}: new image turns are refused until tomorrow (relay time), or until the owner allows more for today (Settings → Providers → OpenAI).`);
  } else if (hasCap && state.warning === true) {
    messages.push(`Today's image spend is at ${percent} % of the daily cap of ${formatOpenAIImageUsd(capUsd)}.`);
  }
  if (!hasCap) messages.push('No daily cap is set for OpenAI images on this relay.');

  const meters = [];
  if (hasCap) {
    meters.push(buildMeter({
      id: 'openai-images-daily-cap',
      label: 'Daily cap',
      unit: 'usd',
      used,
      allowance: capUsd,
      remaining: roundCurrency(Math.max(0, capUsd - used)),
      estimated: true,
      severity: state.reached === true ? 'reached' : (state.warning === true ? 'warning' : null),
      note: `This relay's image spend today (${state.day || 'relay time'}), images in progress included; a warning from ${Math.round(OPENAI_IMAGE_CAP_WARN_RATIO * 100)} %, and at the cap new image turns are refused${allowed ? ' (allowed for today by the owner)' : ''}. It starts over at midnight, relay time.`,
    }));
  }

  const estimated = usd(state.estimatedUsd);
  const unknown = usd(state.unknownPriceUsd);
  const notes = [
    {
      id: 'openai-images-today',
      label: 'Today',
      value: formatOpenAIImageUsd(used),
      hint: [
        reserved > 0 ? `${formatOpenAIImageUsd(reserved)} in progress` : '',
        estimated > 0 ? `${formatOpenAIImageUsd(estimated)} estimated` : '',
        unknown > 0 ? `${formatOpenAIImageUsd(unknown)} at an unknown model's stand-in price` : '',
      ].filter(Boolean).join(' · ') || null,
      text: `OpenAI image spend today: ${formatOpenAIImageUsd(used)}${reserved > 0 ? `, of it ${formatOpenAIImageUsd(reserved)} in progress` : ''}.`,
    },
    {
      id: 'openai-images-month',
      label: 'This month',
      value: formatOpenAIImageUsd(month),
      text: `OpenAI image spend this month: ${formatOpenAIImageUsd(month)}.`,
    },
    {
      id: 'openai-images-override',
      label: 'Allow for today',
      value: allowed ? 'on' : 'off',
      hint: allowed && state.allowedAt ? `since ${state.allowedAt}` : null,
      text: allowed
        ? 'The owner allowed image turns past the cap for today; it ends at midnight, relay time.'
        : 'Past the cap, image turns are refused unless the owner allows them for today.',
    },
  ];
  const conversation = state.conversation && typeof state.conversation === 'object' ? state.conversation : null;
  if (conversation) {
    const images = Math.max(0, Math.trunc(toFiniteNumber(conversation.images) ?? 0));
    notes.push({
      id: 'openai-images-this-chat',
      label: 'This chat',
      value: formatOpenAIImageUsd(usd(conversation.costUsd)),
      hint: `${images} ${images === 1 ? 'image' : 'images'}`,
      text: `OpenAI images in this chat: ${formatOpenAIImageUsd(usd(conversation.costUsd))} (${images} ${images === 1 ? 'image' : 'images'}).`,
    });
  }
  notes.push({
    id: 'openai-images-estimate',
    text: 'Priced by OAR from its own table of OpenAI image prices, for the image turns of this relay; a try that may have been billed without a usage report counts at its estimate. OpenAI\'s usage page has every request on the key.',
  });

  const card = buildProviderCard({
    provider: OPENAI_IMAGE_BOOKING_PROVIDER,
    label: OPENAI_IMAGE_CARD_LABEL,
    status: STATUS_OK,
    message: messages.join(' ') || null,
    source: SOURCE_WORKER,
    meters: meters.filter(Boolean),
    notes,
    links,
  });
  return card ? { ...card, imageSpend: state } : null;
}
