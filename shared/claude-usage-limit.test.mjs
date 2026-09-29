import assert from 'node:assert/strict';
import test from 'node:test';

import {
  USAGE_LIMIT_KIND,
  buildUsageLimitFailure,
  classifyUsageLimitRefusal,
  createUsageLimitTracker,
  normalizeRateLimitInfo,
  rateLimitInfoKey,
  usageLimitResumeAt,
  usageLimitResumesByItself,
  usageLimitWindowLabel,
} from './claude-usage-limit.mjs';

// The shapes below are what CLI 2.1.283 sent at the limit, with invented ids.
const RESETS_AT_SEC = 1790632800;
const RESETS_AT_ISO = new Date(RESETS_AT_SEC * 1000).toISOString();
const BEFORE_RESET = RESETS_AT_SEC * 1000 - 86 * 60 * 1000;
const LIMIT_TEXT = "You've hit your session limit · resets 10pm (UTC)";

const rejectedEvent = () => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'rejected',
    resetsAt: RESETS_AT_SEC,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 1, resetsAt: RESETS_AT_SEC },
      seven_day: { utilization: 0.28, resetsAt: RESETS_AT_SEC + 18000 },
    },
  },
  uuid: '00000000-0000-4000-8000-000000000001',
  session_id: '00000000-0000-4000-8000-0000000000aa',
});

const warningEvent = () => ({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning',
    resetsAt: RESETS_AT_SEC,
    rateLimitType: 'five_hour',
    utilization: 0.96,
    isUsingOverage: false,
    surpassedThreshold: 0.9,
    unifiedWindows: {
      five_hour: { utilization: 0.96, resetsAt: RESETS_AT_SEC },
      seven_day: { utilization: 0.27, resetsAt: RESETS_AT_SEC + 18000 },
    },
  },
});

const syntheticAssistant = () => ({
  type: 'assistant',
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: LIMIT_TEXT }] },
  parent_tool_use_id: null,
  error: 'rate_limit',
  is_api_error_message: true,
});

const refusedResult = () => ({
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 429,
  terminal_reason: 'api_error',
  num_turns: 1,
  duration_api_ms: 0,
  result: LIMIT_TEXT,
});

test('a rejected report is normalized with its reset as a timestamp', () => {
  const info = normalizeRateLimitInfo(rejectedEvent().rate_limit_info, { now: BEFORE_RESET });
  assert.equal(info.status, 'rejected');
  assert.equal(info.rateLimitType, 'five_hour');
  assert.equal(info.resetsAt, RESETS_AT_ISO);
  assert.equal(info.utilization, 1);
  assert.equal(info.isUsingOverage, false);
  assert.deepEqual(info.windows.map((w) => [w.id, w.utilization]), [['five_hour', 1], ['seven_day', 0.28]]);
  assert.equal(info.observedAt, new Date(BEFORE_RESET).toISOString());
});

test('a warning keeps its utilization and the threshold it passed', () => {
  const info = normalizeRateLimitInfo(warningEvent().rate_limit_info, { now: BEFORE_RESET });
  assert.equal(info.status, 'allowed_warning');
  assert.equal(info.utilization, 0.96);
  assert.equal(info.surpassedThreshold, 0.9);
});

test('what is not a report normalizes to nothing', () => {
  assert.equal(normalizeRateLimitInfo(null), null);
  assert.equal(normalizeRateLimitInfo({}), null);
  assert.equal(normalizeRateLimitInfo({ status: 'throttled' }), null);
});

test('the refusal the CLI sent is recognised, with the reset of the report', () => {
  const rateLimit = normalizeRateLimitInfo(rejectedEvent().rate_limit_info, { now: BEFORE_RESET });
  const refusal = classifyUsageLimitRefusal({
    rateLimit,
    result: refusedResult(),
    assistantError: 'rate_limit',
    now: BEFORE_RESET,
  });
  assert.deepEqual(refusal, { rateLimitType: 'five_hour', resetsAt: RESETS_AT_ISO, text: LIMIT_TEXT });
});

test('each sign of the limit is enough next to a rejected report', () => {
  const rateLimit = normalizeRateLimitInfo(rejectedEvent().rate_limit_info, { now: BEFORE_RESET });
  const bare = { type: 'result', subtype: 'success', is_error: true, result: 'The request failed.' };
  assert.equal(classifyUsageLimitRefusal({ rateLimit, result: bare, now: BEFORE_RESET }), null);
  assert.ok(classifyUsageLimitRefusal({ rateLimit, result: bare, assistantError: 'rate_limit', now: BEFORE_RESET }));
  assert.ok(classifyUsageLimitRefusal({ rateLimit, result: { ...bare, api_error_status: 429 }, now: BEFORE_RESET }));
  assert.ok(classifyUsageLimitRefusal({ rateLimit, result: { ...bare, result: LIMIT_TEXT }, now: BEFORE_RESET }));
});

test('an exception that names the limit counts when no result arrived', () => {
  const rateLimit = normalizeRateLimitInfo(rejectedEvent().rate_limit_info, { now: BEFORE_RESET });
  const refusal = classifyUsageLimitRefusal({
    rateLimit,
    errorText: `Claude Code returned an error result: ${LIMIT_TEXT}`,
    now: BEFORE_RESET,
  });
  assert.equal(refusal.resetsAt, RESETS_AT_ISO);
  assert.equal(classifyUsageLimitRefusal({ rateLimit, errorText: 'socket hang up', now: BEFORE_RESET }), null);
});

test('a 429 without any report stays an ordinary failure', () => {
  assert.equal(classifyUsageLimitRefusal({ rateLimit: null, result: refusedResult(), assistantError: 'rate_limit', now: BEFORE_RESET }), null);
});

test('a limit reached in the middle of a turn is recognised under the report the turn began with', () => {
  const warning = normalizeRateLimitInfo(warningEvent().rate_limit_info, { now: BEFORE_RESET });
  const refusal = classifyUsageLimitRefusal({ rateLimit: warning, result: refusedResult(), assistantError: 'rate_limit', now: BEFORE_RESET });
  assert.deepEqual(refusal, { rateLimitType: 'five_hour', resetsAt: RESETS_AT_ISO, text: LIMIT_TEXT });

  const allowed = normalizeRateLimitInfo({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: RESETS_AT_SEC, utilization: 0.4 }, { now: BEFORE_RESET });
  const blind = classifyUsageLimitRefusal({ rateLimit: allowed, result: refusedResult(), assistantError: 'rate_limit', now: BEFORE_RESET });
  assert.deepEqual(blind, { rateLimitType: null, resetsAt: null, text: LIMIT_TEXT });
});

test('without a rejected report the error has to name the limit by kind and in words', () => {
  const warning = normalizeRateLimitInfo(warningEvent().rate_limit_info, { now: BEFORE_RESET });
  const kindOnly = { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'Too many requests.' };
  assert.equal(classifyUsageLimitRefusal({ rateLimit: warning, result: kindOnly, assistantError: 'rate_limit', now: BEFORE_RESET }), null);
  const wordsOnly = { type: 'result', subtype: 'error_during_execution', is_error: true, result: LIMIT_TEXT };
  assert.equal(classifyUsageLimitRefusal({ rateLimit: warning, result: wordsOnly, now: BEFORE_RESET }), null);
});

test('a rejected window does not pause a turn that went through', () => {
  const rateLimit = normalizeRateLimitInfo(rejectedEvent().rate_limit_info, { now: BEFORE_RESET });
  const fine = { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
  assert.equal(classifyUsageLimitRefusal({ rateLimit, result: fine, now: BEFORE_RESET }), null);
});

test('a refusal that names the reset just passed is one without a reset', () => {
  // Right after the reset the CLI can refuse once more with the old time.
  const afterReset = RESETS_AT_SEC * 1000 + 60_000;
  const rateLimit = normalizeRateLimitInfo(rejectedEvent().rate_limit_info, { now: afterReset - 1000 });
  const refusal = classifyUsageLimitRefusal({ rateLimit, result: refusedResult(), assistantError: 'rate_limit', now: afterReset });
  assert.deepEqual(refusal, { rateLimitType: 'five_hour', resetsAt: null, text: LIMIT_TEXT });
});

test('an old report whose reset has passed pauses nothing', () => {
  const rateLimit = normalizeRateLimitInfo(rejectedEvent().rate_limit_info, { now: BEFORE_RESET });
  const afterReset = RESETS_AT_SEC * 1000 + 1;
  assert.equal(classifyUsageLimitRefusal({ rateLimit, result: refusedResult(), assistantError: 'rate_limit', now: afterReset }), null);
});

test('the tracker publishes a report once and again when it changes', () => {
  const tracker = createUsageLimitTracker({ now: () => BEFORE_RESET });
  assert.equal(tracker.observe(warningEvent()).status, 'allowed_warning');
  assert.equal(tracker.observe(warningEvent()), null);
  const higher = warningEvent();
  higher.rate_limit_info.utilization = 0.98;
  assert.equal(tracker.observe(higher).utilization, 0.98);
  assert.equal(tracker.observe(rejectedEvent()).status, 'rejected');
  assert.equal(tracker.latest.status, 'rejected');
});

test('the tracker classifies the turn from what the stream carried', () => {
  const tracker = createUsageLimitTracker({ now: () => BEFORE_RESET });
  tracker.observe(rejectedEvent());
  tracker.observe(syntheticAssistant());
  assert.equal(tracker.classifyResult(refusedResult()).resetsAt, RESETS_AT_ISO);
  assert.equal(tracker.classifyException(new Error(`Claude Code returned an error result: ${LIMIT_TEXT}`)).rateLimitType, 'five_hour');
});

test('a subagent message does not overwrite the turn\'s own error', () => {
  const tracker = createUsageLimitTracker({ now: () => BEFORE_RESET });
  tracker.observe(rejectedEvent());
  tracker.observe(syntheticAssistant());
  tracker.observe({ type: 'assistant', parent_tool_use_id: 'toolu_01', message: { content: [] } });
  const bare = { type: 'result', subtype: 'success', is_error: true, result: 'The request failed.' };
  assert.ok(tracker.classifyResult(bare));
});

test('the turn is sent again a minute after the reset', () => {
  assert.equal(usageLimitResumeAt(RESETS_AT_ISO), new Date(RESETS_AT_SEC * 1000 + 60_000).toISOString());
  assert.equal(usageLimitResumeAt(''), null);
});

test('a reset within six hours resumes by itself, a later one waits for the user', () => {
  assert.equal(usageLimitResumesByItself(RESETS_AT_ISO, { now: BEFORE_RESET }), true);
  const days = RESETS_AT_SEC * 1000 - 3 * 24 * 3_600_000;
  assert.equal(usageLimitResumesByItself(RESETS_AT_ISO, { now: days }), false);
  assert.equal(usageLimitResumesByItself(null, { now: BEFORE_RESET }), false);
});

test('the failure an older relay would show carries what a newer one pauses on', () => {
  const failure = buildUsageLimitFailure({ id: 'q-1' }, { rateLimitType: 'five_hour', resetsAt: RESETS_AT_ISO, text: LIMIT_TEXT });
  assert.equal(failure.kind, USAGE_LIMIT_KIND);
  assert.equal(failure.stableCode, 'claude.usage-limit');
  assert.equal(failure.message, LIMIT_TEXT);
  assert.equal(failure.resetsAt, RESETS_AT_ISO);
  assert.equal(failure.queueMessageId, 'q-1');
});

test('windows are named for the reader', () => {
  assert.equal(usageLimitWindowLabel('five_hour'), '5-hour limit');
  assert.equal(usageLimitWindowLabel('seven_day_opus'), 'weekly Opus limit');
  assert.equal(usageLimitWindowLabel('something_new'), 'usage limit');
});

test('two reports that read the same share a key', () => {
  const a = normalizeRateLimitInfo(warningEvent().rate_limit_info, { now: BEFORE_RESET });
  const b = normalizeRateLimitInfo(warningEvent().rate_limit_info, { now: BEFORE_RESET + 5000 });
  assert.equal(rateLimitInfoKey(a), rateLimitInfoKey(b));
  assert.equal(rateLimitInfoKey(null), '');
});
