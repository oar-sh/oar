import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEEPSEEK_PRICING_SOURCE,
  DEEPSEEK_SEARCH_PRICING,
  deepseekPriceFor,
  deepseekPricedModel,
  estimateCost,
  estimateSearchCost,
  isDeepSeekPeakTime,
} from './deepseek-pricing.mjs';

// 2026-10-21 is a Wednesday, 2026-10-24 a Saturday, 2026-10-25 a Sunday.
const WEDNESDAY = '2026-10-21';

test('the peak window\'s edges, in UTC, on a weekday', () => {
  const cases = [
    ['00:59', false],
    ['01:00', true],
    ['03:59', true],
    ['04:00', false],
    ['05:59', false],
    ['06:00', true],
    ['09:59', true],
    ['10:00', false],
    ['23:30', false],
  ];
  for (const [time, peak] of cases) {
    assert.equal(isDeepSeekPeakTime(`${WEDNESDAY}T${time}:00.000Z`), peak, time);
  }
  // The same instant written in another zone is the same instant.
  assert.equal(isDeepSeekPeakTime('2026-10-21T09:30:00+08:00'), true, '01:30 UTC');
  assert.equal(isDeepSeekPeakTime(new Date('2026-10-21T07:00:00Z')), true);
  assert.equal(isDeepSeekPeakTime(Date.parse('2026-10-21T11:00:00Z')), false);
});

test('weekends are off-peak all day, Monday and Friday are weekdays', () => {
  for (const day of ['2026-10-24', '2026-10-25']) {
    for (const time of ['01:00', '02:30', '06:00', '09:59']) {
      assert.equal(isDeepSeekPeakTime(`${day}T${time}:00Z`), false, `${day} ${time}`);
    }
  }
  assert.equal(isDeepSeekPeakTime('2026-10-19T01:00:00Z'), true, 'Monday');
  assert.equal(isDeepSeekPeakTime('2026-10-23T09:59:00Z'), true, 'Friday');
  // Sunday 23:59 UTC is Monday morning in Beijing, but DeepSeek's window is UTC.
  assert.equal(isDeepSeekPeakTime('2026-10-25T23:59:00Z'), false);
});

test('an unreadable time is neither peak nor off-peak', () => {
  for (const value of ['', 'not a time', null, undefined, Number.NaN]) {
    assert.equal(isDeepSeekPeakTime(value), null, String(value));
  }
});

test('flash prices in both currencies, peak exactly double', () => {
  const offPeak = `${WEDNESDAY}T12:00:00Z`;
  const peak = `${WEDNESDAY}T02:00:00Z`;
  assert.deepEqual(deepseekPriceFor({ model: 'deepseek-flash', at: offPeak, currency: 'USD' }), { hit: 0.003, miss: 0.15, output: 0.6, peak: false });
  assert.deepEqual(deepseekPriceFor({ model: 'deepseek-flash', at: offPeak, currency: 'CNY' }), { hit: 0.02, miss: 1, output: 4, peak: false });
  assert.deepEqual(deepseekPriceFor({ model: 'deepseek-flash', at: peak, currency: 'USD' }), { hit: 0.006, miss: 0.3, output: 1.2, peak: true });
  assert.deepEqual(deepseekPriceFor({ model: 'deepseek-flash', at: peak, currency: 'cny' }), { hit: 0.04, miss: 2, output: 8, peak: true });

  const tokens = { hitTokens: 1_000_000, missTokens: 1_000_000, outputTokens: 1_000_000 };
  assert.equal(estimateCost({ model: 'deepseek-flash', at: offPeak, currency: 'USD', ...tokens }), 0.753);
  assert.equal(estimateCost({ model: 'deepseek-flash', at: peak, currency: 'USD', ...tokens }), 1.506);
  assert.equal(estimateCost({ model: 'deepseek-flash', at: offPeak, currency: 'CNY', ...tokens }), 5.02);
  assert.equal(estimateCost({ model: 'deepseek-flash', at: peak, currency: 'CNY', ...tokens }), 10.04);
});

test('v4-pro prices in both currencies', () => {
  const offPeak = '2026-10-24T02:00:00Z';
  const peak = `${WEDNESDAY}T08:00:00Z`;
  const tokens = { hitTokens: 1_000_000, missTokens: 1_000_000, outputTokens: 1_000_000 };
  assert.equal(estimateCost({ model: 'deepseek-v4-pro', at: offPeak, currency: 'USD', ...tokens }), 2.662);
  assert.equal(estimateCost({ model: 'deepseek-v4-pro', at: peak, currency: 'USD', ...tokens }), 5.324);
  assert.equal(estimateCost({ model: 'deepseek-v4-pro', at: offPeak, currency: 'CNY', ...tokens }), 18.15);
  assert.equal(estimateCost({ model: 'deepseek-v4-pro', at: peak, currency: 'CNY', ...tokens }), 36.3);
  // A real-sized turn: 120k cached, 8k fresh input, 2k output, off-peak.
  assert.equal(
    estimateCost({ model: 'deepseek-v4-pro', at: offPeak, hitTokens: 120_000, missTokens: 8_000, outputTokens: 2_000 }),
    0.01188,
  );
});

test('a missing count is zero; the aliases and the CLI\'s suffix are priced as flash', () => {
  const at = `${WEDNESDAY}T12:00:00Z`;
  assert.equal(estimateCost({ model: 'deepseek-flash', at, missTokens: 1_000_000 }), 0.15);
  assert.equal(estimateCost({ model: 'deepseek-flash', at, missTokens: 1_000_000, hitTokens: undefined, outputTokens: null }), 0.15);
  assert.equal(estimateCost({ model: 'deepseek-flash', at }), 0);
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-flash[1m]', 'DeepSeek-Flash']) {
    assert.equal(deepseekPricedModel(model), 'deepseek-flash', model);
    assert.equal(estimateCost({ model, at, outputTokens: 1_000_000 }), 0.6, model);
  }
  // A negative count is not a refund.
  assert.equal(estimateCost({ model: 'deepseek-flash', at, missTokens: -1_000_000, outputTokens: 1_000_000 }), 0.6);
});

test('an unknown model, currency or time has no estimate', () => {
  const at = `${WEDNESDAY}T12:00:00Z`;
  const tokens = { missTokens: 1000, outputTokens: 1000 };
  for (const model of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v5', 'claude-sonnet-5', '']) {
    assert.equal(deepseekPricedModel(model), '', model);
    assert.equal(estimateCost({ model, at, ...tokens }), null, model);
  }
  assert.equal(estimateCost({ model: 'deepseek-flash', at, currency: 'EUR', ...tokens }), null);
  assert.equal(estimateCost({ model: 'deepseek-flash', at: 'later', ...tokens }), null);
  assert.equal(estimateCost({ model: 'deepseek-flash', ...tokens }), null);
});

test('the table names its source and date', () => {
  assert.equal(DEEPSEEK_PRICING_SOURCE.date, '2026-10-19');
  assert.match(DEEPSEEK_PRICING_SOURCE.url, /^https:\/\/api-docs\.deepseek\.com\//);
  assert.equal(DEEPSEEK_SEARCH_PRICING.date, '2026-10-24');
  assert.match(DEEPSEEK_SEARCH_PRICING.url, /^https:\/\/api-docs\.deepseek\.com\//);
});

test('searches and fetches are flat per request, in both currencies, from 2026-10-31 16:00 UTC', () => {
  // $0.75 / ¥5 per 1,000 of either; the cutoff is 00:00 Beijing time on 2026-11-01.
  const before = '2026-10-31T15:59:59.999Z';
  const from = '2026-10-31T16:00:00.000Z';
  assert.equal(DEEPSEEK_SEARCH_PRICING.chargedFrom, from);
  assert.equal(estimateSearchCost({ at: before, searchRequests: 1000, fetchRequests: 1000 }), 0);
  assert.equal(estimateSearchCost({ at: from, searchRequests: 1000 }), 0.75);
  assert.equal(estimateSearchCost({ at: from, fetchRequests: 1000, currency: 'CNY' }), 5);
  assert.equal(estimateSearchCost({ at: from, searchRequests: 3, fetchRequests: 1 }), 0.003);
  assert.equal(estimateSearchCost({ at: from, searchRequests: 3, fetchRequests: 1, currency: 'cny' }), 0.02);
  // A peak-hour weekday costs the same: Monday 2026-11-02 02:00 UTC.
  assert.equal(isDeepSeekPeakTime('2026-11-02T02:00:00Z'), true);
  assert.equal(estimateSearchCost({ at: '2026-11-02T02:00:00Z', searchRequests: 1000 }), 0.75);
  // Nothing requested is nothing; a negative count is not a refund.
  assert.equal(estimateSearchCost({ at: from }), 0);
  assert.equal(estimateSearchCost({ at: from, searchRequests: -5 }), 0);
  // An unreadable time or an unknown currency has no estimate.
  assert.equal(estimateSearchCost({ at: 'later', searchRequests: 1 }), null);
  assert.equal(estimateSearchCost({ searchRequests: 1 }), null);
  assert.equal(estimateSearchCost({ at: from, searchRequests: 1, currency: 'EUR' }), null);
});
