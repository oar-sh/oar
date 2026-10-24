import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRelayEventMessageText,
  canonicalRelayEventTimeZone,
  normalizeRelayEventQuietHours,
  parseRelayEventMessageText,
  relayEventClockMinutes,
  relayEventQuietHoursText,
  relayEventQuietWindowEnd,
} from './relay-events.mjs';

const at = (iso) => Date.parse(iso);
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
const BERLIN_NIGHT = { from: '23:00', to: '06:00', tz: 'Europe/Berlin' };

test('quiet_hours is checked: times of day, a known IANA zone, from and to differ', () => {
  assert.deepEqual(normalizeRelayEventQuietHours({ from: '23:00', to: '6:00', tz: 'Europe/Berlin' }), { ok: true, value: { from: '23:00', to: '06:00', tz: 'Europe/Berlin' } });
  assert.deepEqual(normalizeRelayEventQuietHours('{"from":"07:05","to":"08:00","tz":"UTC"}').value, { from: '07:05', to: '08:00', tz: 'UTC' });
  for (const absent of [undefined, null, '', false, {}, { from: '', to: null, tz: '' }]) assert.deepEqual(normalizeRelayEventQuietHours(absent), { ok: true, value: null });
  assert.match(normalizeRelayEventQuietHours({ from: '24:00', to: '06:00', tz: 'UTC' }).error, /HH:MM/);
  assert.match(normalizeRelayEventQuietHours({ from: '7pm', to: '06:00', tz: 'UTC' }).error, /HH:MM/);
  assert.match(normalizeRelayEventQuietHours({ from: '06:00', to: '06:00', tz: 'UTC' }).error, /differ/);
  assert.match(normalizeRelayEventQuietHours({ from: '23:00', to: '06:00' }).error, /needs tz/);
  assert.match(normalizeRelayEventQuietHours({ from: '23:00', to: '06:00', tz: 'Mars/Olympus_Mons' }).error, /not an IANA time zone/);
  assert.match(normalizeRelayEventQuietHours(['23:00', '06:00']).error, /must be an object/);
  assert.match(normalizeRelayEventQuietHours('23:00-06:00').error, /must be an object/);
  assert.equal(canonicalRelayEventTimeZone('Nowhere/Else'), '');
  assert.equal(relayEventClockMinutes('00:00'), 0);
  assert.equal(relayEventClockMinutes('23:59'), 23 * 60 + 59);
  assert.equal(relayEventQuietHoursText(BERLIN_NIGHT), '23:00–06:00 Europe/Berlin');
});

test('a window within one day ends at its end; outside it there is none', () => {
  const office = { from: '09:00', to: '17:00', tz: 'UTC' };
  assert.equal(iso(relayEventQuietWindowEnd(office, at('2026-01-15T10:00:00.000Z'))), '2026-01-15T17:00:00.000Z');
  assert.equal(iso(relayEventQuietWindowEnd(office, at('2026-01-15T09:00:00.000Z'))), '2026-01-15T17:00:00.000Z');
  assert.equal(relayEventQuietWindowEnd(office, at('2026-01-15T17:00:00.000Z')), null, 'the end is not inside');
  assert.equal(relayEventQuietWindowEnd(office, at('2026-01-15T08:59:59.000Z')), null);
  assert.equal(relayEventQuietWindowEnd({ from: '09:00', to: '17:00', tz: 'Nowhere/Else' }, at('2026-01-15T10:00:00.000Z')), null);
});

test('a window that crosses midnight ends the next morning, from either side of midnight', () => {
  // Winter: Berlin is UTC+1.
  assert.equal(iso(relayEventQuietWindowEnd(BERLIN_NIGHT, at('2026-01-15T22:30:00.000Z'))), '2026-01-16T05:00:00.000Z');
  assert.equal(iso(relayEventQuietWindowEnd(BERLIN_NIGHT, at('2026-01-16T03:00:00.000Z'))), '2026-01-16T05:00:00.000Z');
  assert.equal(relayEventQuietWindowEnd(BERLIN_NIGHT, at('2026-01-15T21:59:00.000Z')), null);
  assert.equal(relayEventQuietWindowEnd(BERLIN_NIGHT, at('2026-01-16T05:00:00.000Z')), null);
  // Summer: UTC+2.
  assert.equal(iso(relayEventQuietWindowEnd(BERLIN_NIGHT, at('2026-07-01T21:30:00.000Z'))), '2026-07-02T04:00:00.000Z');
});

test('the nights the clocks change: the window ends at 06:00 local under the new offset', () => {
  // 2026-03-29 01:00 UTC: 02:00 CET becomes 03:00 CEST.
  assert.equal(iso(relayEventQuietWindowEnd(BERLIN_NIGHT, at('2026-03-28T22:30:00.000Z'))), '2026-03-29T04:00:00.000Z');
  // 2026-10-25 01:00 UTC: 03:00 CEST becomes 02:00 CET.
  assert.equal(iso(relayEventQuietWindowEnd(BERLIN_NIGHT, at('2026-10-24T21:30:00.000Z'))), '2026-10-25T05:00:00.000Z');
  // New York, 2026-11-01 06:00 UTC: 02:00 EDT becomes 01:00 EST.
  assert.equal(iso(relayEventQuietWindowEnd({ from: '22:00', to: '07:00', tz: 'America/New_York' }, at('2026-11-01T03:00:00.000Z'))), '2026-11-01T12:00:00.000Z');
});

test('an end the clocks skip is the moment they jump; an end they repeat is its first time, with no re-entry', () => {
  const short = { from: '23:00', to: '02:30', tz: 'Europe/Berlin' };
  // 02:30 does not exist on 2026-03-29: at 01:00 UTC the clocks go from 02:00 to 03:00.
  assert.equal(iso(relayEventQuietWindowEnd(short, at('2026-03-28T23:00:00.000Z'))), '2026-03-29T01:00:00.000Z');
  // 02:30 comes twice on 2026-10-25: first at 00:30 UTC (CEST).
  assert.equal(iso(relayEventQuietWindowEnd(short, at('2026-10-24T22:00:00.000Z'))), '2026-10-25T00:30:00.000Z');
  // At 01:00 UTC the clocks go back to 02:00 CET: 02:00–02:29 come again, outside the window now.
  assert.equal(relayEventQuietWindowEnd(short, at('2026-10-25T00:30:00.000Z')), null);
  assert.equal(relayEventQuietWindowEnd(short, at('2026-10-25T01:00:00.000Z')), null);
  assert.equal(relayEventQuietWindowEnd(short, at('2026-10-25T01:29:00.000Z')), null);
  // The next night is an ordinary one.
  assert.equal(iso(relayEventQuietWindowEnd(short, at('2026-10-25T22:30:00.000Z'))), '2026-10-26T01:30:00.000Z');
});

test('held events say why: quiet hours and a subscription digest have their own header', () => {
  const base = { v: 1, relay: { id: 'self', name: 'bench-relay' }, session: { id: 'conv-fixture-orbit', title: 'Orbit camera' }, at: '2026-01-01T10:00:00.000Z' };
  const quiet = buildRelayEventMessageText([
    { ...base, type: 'turn_end', detail: { status: 'done', preview: 'one' }, held: { reason: 'quiet', ...BERLIN_NIGHT } },
    { ...base, type: 'turn_end', detail: { status: 'done', preview: 'two' }, held: { reason: 'quiet', ...BERLIN_NIGHT } },
  ]);
  assert.match(quiet, /^Held during quiet hours \(23:00–06:00 Europe\/Berlin\): 2 events, delivered now that the window has ended/m);
  const parsedQuiet = parseRelayEventMessageText(quiet);
  assert.equal(parsedQuiet.quiet, true);
  assert.equal(parsedQuiet.count, 2);
  assert.ok(parsedQuiet.lines.every((line) => line.startsWith('[relay event]')));
  const gathered = (preview) => ({ ...base, type: 'turn_end', detail: { status: 'done', preview }, held: { reason: 'digest', minutes: 30, subscriptionId: 'sub_fixture01' } });
  const digest = buildRelayEventMessageText([gathered('a'), gathered('b')]);
  assert.match(digest, /^Digest of 2 events \(subscription sub_fixture01 every 30 min; questions and errors come at once\):$/m);
  assert.equal(parseRelayEventMessageText(digest).digest, true);
  assert.equal(parseRelayEventMessageText(digest).quiet, false);
  // A digest of one event reads as that event.
  const single = buildRelayEventMessageText([gathered('only')]);
  assert.doesNotMatch(single, /Digest/);
  assert.equal(parseRelayEventMessageText(single).digest, false);
  assert.equal(parseRelayEventMessageText(single).count, 1);
});

test('the hourly cap\'s digest and a subscription\'s digest are one "Digest of" line', () => {
  const base = { v: 1, relay: { id: 'self', name: 'bench-relay' }, session: { id: 'conv-fixture-orbit', title: 'Orbit camera' }, at: '2026-01-01T10:00:00.000Z' };
  const text = buildRelayEventMessageText([
    { ...base, type: 'turn_end', detail: { preview: 'gathered' }, held: { reason: 'digest', minutes: 15, subscriptionId: 'sub_fixture02' } },
    { ...base, type: 'all_idle', session: null, detail: { scope: 'all' } },
  ], { digest: true });
  const headers = text.split('\n').filter((line) => line.startsWith('Digest of'));
  assert.deepEqual(headers, [
    'Digest of 2 events (the limit of 20 wake-ups an hour is reached; until it frees up, events come every 10 min; subscription sub_fixture02 every 15 min; questions and errors come at once):',
  ]);
  // The cap alone reads as before.
  assert.match(buildRelayEventMessageText([{ ...base, type: 'turn_end', detail: { preview: 'x' } }], { digest: true }), /^Digest of 1 event \(the limit of 20 wake-ups an hour is reached; until it frees up, events come every 10 min\):$/m);
});

test('a link_restored line says how many kept events a subscription\'s options still hold', () => {
  const remote = { id: 'rr_fixture', name: 'lab-relay' };
  const text = buildRelayEventMessageText([
    { type: 'link_lost', relay: remote, at: '2026-01-01T10:30:00.000Z', detail: { since: '2026-01-01T10:00:00.000Z' } },
    { type: 'question_asked', relay: remote, session: { id: 'conv-fixture-orbit', title: 'Orbit camera' }, replayed: true, detail: { prompt: 'Ship?' } },
    { type: 'link_restored', relay: remote, at: '2026-01-01T10:31:00.000Z', detail: { since: '2026-01-01T10:00:00.000Z', kept: 3 } },
  ]);
  assert.match(text, /link_restored: .*; 2 of them are held by your subscription's digest or quiet hours and come later$/m);
});
