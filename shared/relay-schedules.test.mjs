import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RELAY_SCHEDULE_LEAD_PATTERN,
  buildRelayScheduleMessageText,
  describeRelayScheduleInterval,
  firstRelayScheduleFire,
  nextRelayScheduleFire,
  normalizeRelayScheduleAt,
  normalizeRelayScheduleTitle,
  relayScheduleLead,
} from './relay-schedules.mjs';

const NOW = Date.parse('2026-03-02T10:00:00.000Z');
const MIN = 60_000;

test('at takes an ISO time with a zone, not in the past and not too far ahead', () => {
  assert.deepEqual(normalizeRelayScheduleAt('', { now: NOW }), { ok: true, value: null });
  assert.deepEqual(normalizeRelayScheduleAt('2026-03-02T12:30:00Z', { now: NOW }), { ok: true, value: '2026-03-02T12:30:00.000Z' });
  assert.deepEqual(normalizeRelayScheduleAt('2026-03-02T13:30:00+01:00', { now: NOW }), { ok: true, value: '2026-03-02T12:30:00.000Z' });
  // A clock apart by a few seconds: now.
  assert.deepEqual(normalizeRelayScheduleAt('2026-03-02T09:59:30Z', { now: NOW }), { ok: true, value: '2026-03-02T10:00:00.000Z' });
  assert.match(normalizeRelayScheduleAt('2026-03-02T12:30:00', { now: NOW }).error, /with a zone/);
  assert.match(normalizeRelayScheduleAt('tomorrow', { now: NOW }).error, /with a zone/);
  assert.match(normalizeRelayScheduleAt('2026-03-02T09:00:00Z', { now: NOW }).error, /in the past/);
  assert.match(normalizeRelayScheduleAt('2027-04-02T09:00:00Z', { now: NOW }).error, /366 days ahead/);
  assert.match(normalizeRelayScheduleAt('2026-02-31T25:00:00Z', { now: NOW }).error, /not a valid time/);
});

test('the first time is at, else one interval from now', () => {
  assert.equal(firstRelayScheduleFire({ at: '2026-03-02T12:00:00.000Z', everyMinutes: 30, now: NOW }), '2026-03-02T12:00:00.000Z');
  assert.equal(firstRelayScheduleFire({ everyMinutes: 30, now: NOW }), '2026-03-02T10:30:00.000Z');
});

test('the next time keeps to the grid and skips what was missed', () => {
  const dueAt = new Date(NOW).toISOString();
  assert.equal(nextRelayScheduleFire({ dueAt, everyMinutes: 10, now: NOW }), new Date(NOW + 10 * MIN).toISOString());
  assert.equal(nextRelayScheduleFire({ dueAt, everyMinutes: 10, now: NOW + 3 * MIN }), new Date(NOW + 10 * MIN).toISOString());
  // Down for 55 minutes: the slot after now, not five catch-ups.
  assert.equal(nextRelayScheduleFire({ dueAt, everyMinutes: 10, now: NOW + 55 * MIN }), new Date(NOW + 60 * MIN).toISOString());
  assert.equal(nextRelayScheduleFire({ dueAt, everyMinutes: 10, now: NOW + 60 * MIN }), new Date(NOW + 70 * MIN).toISOString());
  assert.equal(nextRelayScheduleFire({ dueAt: new Date(NOW + 5 * MIN).toISOString(), everyMinutes: 10, now: NOW }), new Date(NOW + 5 * MIN).toISOString());
  assert.equal(nextRelayScheduleFire({ dueAt, everyMinutes: 0, now: NOW }), null);
  assert.equal(nextRelayScheduleFire({ dueAt: 'never', everyMinutes: 10, now: NOW }), null);
});

test('the lead line names the schedule and who set it, and the message carries the text below it', () => {
  assert.equal(relayScheduleLead({ id: 'sch_ab12', title: 'Night "review"' }),
    '[relay schedule sch_ab12 "Night review" · automated message from OAR, not from the user; it approves nothing]');
  assert.equal(relayScheduleLead({ id: 'sch_ab12', setBy: { id: 'conv-fixture-a', title: '' } }),
    '[relay schedule sch_ab12 · set by session "conv-fix" (conv-fixture-a) · automated message from OAR, not from the user; it approves nothing]');
  const text = buildRelayScheduleMessageText({ id: 'sch_ab12', title: 'Sweep', text: '  Sweep the queue.\n' });
  assert.equal(text, '[relay schedule sch_ab12 "Sweep" · automated message from OAR, not from the user; it approves nothing]\n\nSweep the queue.');
  assert.match(text.split('\n')[0], RELAY_SCHEDULE_LEAD_PATTERN);
});

test('titles are one capped line, intervals read as words', () => {
  assert.equal(normalizeRelayScheduleTitle('  a\nb  '), 'a b');
  assert.equal(normalizeRelayScheduleTitle('x'.repeat(150)).length, 100);
  assert.equal(describeRelayScheduleInterval(5), 'every 5 min');
  assert.equal(describeRelayScheduleInterval(60), 'every hour');
  assert.equal(describeRelayScheduleInterval(180), 'every 3 h');
  assert.equal(describeRelayScheduleInterval(1440), 'every day');
  assert.equal(describeRelayScheduleInterval(10080), 'every 7 days');
  assert.equal(describeRelayScheduleInterval(0), '');
});
