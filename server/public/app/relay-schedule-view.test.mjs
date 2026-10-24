import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RELAY_SCHEDULE_MESSAGE_KIND as SHARED_KIND,
  RELAY_SCHEDULE_SOCKET_EVENT as SHARED_EVENT,
  describeRelayScheduleInterval,
} from '../../../shared/relay-schedules.mjs';
import {
  RELAY_SCHEDULE_MESSAGE_KIND,
  RELAY_SCHEDULE_SOCKET_EVENT,
  describeScheduleInterval,
  describeScheduleWhen,
  nextScheduledAt,
  renderScheduledBadgeHtml,
  renderSchedulePanelHtml,
  scheduleChipText,
  schedulesInto,
  schedulesOf,
} from './relay-schedule-view.mjs';

const AGENT = 'conv-fixture-agent';
const WORKER = 'conv-fixture-worker';
const formatTime = (iso) => iso.slice(11, 16);

const SCHEDULES = [
  { id: 'sch_a', session: { id: AGENT, title: 'Coordinator' }, title: 'Sweep', text: 'Run the sweep.', everyMinutes: 30, once: false, nextFireAt: '2026-03-02T10:30:00.000Z' },
  { id: 'sch_b', session: { id: WORKER, title: 'Night review' }, setBy: { id: AGENT, title: 'Coordinator' }, title: '', text: 'Review <runs>\nmore', everyMinutes: 1440, once: false, nextFireAt: '2026-03-03T02:00:00.000Z', skippedCount: 2 },
  { id: 'sch_c', session: { id: WORKER, title: 'Night review' }, title: 'Once', text: 'x', everyMinutes: null, once: true, nextFireAt: '2026-03-02T12:00:00.000Z' },
  { id: 'sch_d', session: { id: AGENT }, title: 'ended', text: 'x', once: true, endedAt: '2026-03-02T09:00:00.000Z' },
];

test('the browser\'s copies match the shared module', () => {
  assert.equal(RELAY_SCHEDULE_SOCKET_EVENT, SHARED_EVENT);
  assert.equal(RELAY_SCHEDULE_MESSAGE_KIND, SHARED_KIND);
  for (const minutes of [5, 45, 60, 90, 120, 1440, 2880, 10080]) {
    assert.equal(describeScheduleInterval(minutes), describeRelayScheduleInterval(minutes), String(minutes));
  }
});

test('a conversation\'s schedules: the ones into it, and the ones it set for others; ended ones are left out', () => {
  assert.deepEqual(schedulesInto(SCHEDULES, AGENT).map((schedule) => schedule.id), ['sch_a']);
  assert.deepEqual(schedulesOf(SCHEDULES, AGENT).map((schedule) => schedule.id), ['sch_a', 'sch_b']);
  assert.deepEqual(schedulesOf(SCHEDULES, WORKER).map((schedule) => schedule.id), ['sch_b', 'sch_c']);
  assert.deepEqual(schedulesOf(SCHEDULES, ''), []);
  assert.equal(scheduleChipText(schedulesOf(SCHEDULES, AGENT)), '2 scheduled');
  assert.equal(scheduleChipText([]), '');
  assert.equal(nextScheduledAt(schedulesInto(SCHEDULES, WORKER)), '2026-03-02T12:00:00.000Z');
  assert.equal(nextScheduledAt([]), null);
});

test('when a schedule fires, in words', () => {
  assert.equal(describeScheduleWhen(SCHEDULES[0], { formatTime }), 'every 30 min · next 10:30');
  assert.equal(describeScheduleWhen(SCHEDULES[2], { formatTime }), 'once · 12:00');
  assert.equal(describeScheduleWhen({ once: true }, { formatTime }), 'once');
  assert.equal(describeScheduleWhen({ once: true, everyMinutes: 30, nextFireAt: '2026-03-02T10:30:00.000Z' }, { formatTime }), 'once · 10:30');
});

test('the sidebar marker shows only on a conversation a schedule fires into', () => {
  const badge = renderScheduledBadgeHtml(SCHEDULES, WORKER, { formatTime });
  assert.equal(badge, '<span class="conv-scheduled-badge" title="2 schedules · next 12:00">scheduled</span>');
  assert.match(renderScheduledBadgeHtml(SCHEDULES, AGENT, { formatTime }), /title="1 schedule · next 10:30"/);
  assert.equal(renderScheduledBadgeHtml(SCHEDULES, 'conv-fixture-none', { formatTime }), '');
});

test('the list names each schedule, where it goes or who set it, and has a Cancel each; text is escaped', () => {
  const agentPanel = renderSchedulePanelHtml(SCHEDULES, AGENT, { formatTime, conversations: { [WORKER]: { title: 'Night review' } } });
  assert.equal((agentPanel.match(/relay-schedule-cancel/g) || []).length, 2);
  assert.match(agentPanel, /<span class="relay-watch-what" title="Run the sweep\.">Sweep<\/span><span class="relay-watch-events">every 30 min · next 10:30<\/span>/);
  assert.match(agentPanel, />Review &lt;runs&gt;<\/span><span class="relay-watch-events">every day · next 02:00 · for Night review · 2 skipped<\/span>/);
  assert.match(agentPanel, /data-schedule-id="sch_b"/);
  const workerPanel = renderSchedulePanelHtml(SCHEDULES, WORKER, { formatTime });
  assert.match(workerPanel, /every day · next 02:00 · set by Coordinator/);
  assert.match(workerPanel, />Once<\/span><span class="relay-watch-events">once · 12:00<\/span>/);
  assert.equal(renderSchedulePanelHtml(SCHEDULES, 'conv-fixture-none'), '<ul class="relay-watch-list"></ul>');
});

test('a held firing says it waits for the user to write in the conversation that set it', () => {
  const held = [{ ...SCHEDULES[1], heldForApproval: true, heldSince: '2026-03-03T02:00:00.000Z' }];
  assert.match(renderSchedulePanelHtml(held, WORKER, { formatTime }), /waiting until you write in Coordinator · set by Coordinator/);
});
