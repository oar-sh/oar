import test from 'node:test';
import assert from 'node:assert/strict';

import * as shared from '../../../shared/relay-events.mjs';
import {
  RELAY_EVENT_LEAD,
  RELAY_EVENT_MESSAGE_KIND,
  isRelayEventMessage,
  parseRelayEventMessageText,
  relayEventSummaryText,
  renderRelayEventRowHtml,
  renderWatchedBadgeHtml,
  renderWatchingPanelHtml,
  watchersOf,
  watchingChipHint,
  watchingChipText,
  watchingSummary,
} from './relay-event-view.mjs';

const event = (type, detail = {}, session = { id: 'conv-fixture-orbit', title: 'Orbit camera' }) => ({ v: 1, relay: { id: 'self', name: 'bench-relay' }, session, type, at: '2026-01-01T10:00:00.000Z', detail });

test('the browser copy matches shared/relay-events.mjs', () => {
  assert.equal(RELAY_EVENT_LEAD, shared.RELAY_EVENT_LEAD);
  assert.equal(RELAY_EVENT_MESSAGE_KIND, shared.RELAY_EVENT_MESSAGE_KIND);
  const samples = [
    shared.buildRelayEventMessageText([event('question_asked', { prompt: 'Ship?', options: ['Yes'] }), event('turn_end', { preview: 'done' })]),
    shared.buildRelayEventMessageText(Array.from({ length: 45 }, () => event('task_finished', { kind: 'shell', description: 'npm test', status: 'completed' })), { digest: true }),
    shared.buildRelayEventMessageText([{ type: 'all_idle', detail: { scope: 'all' } }, { type: 'heartbeat', detail: { scope: 'sessions', sessionCount: 1 } }]),
    shared.buildRelayEventMessageText([{ ...event('turn_end', { preview: 'ok' }), relay: { id: 'rr_fixture', name: 'lab-relay' } }]),
    shared.buildRelayEventMessageText([
      { type: 'link_lost', relay: { id: 'rr_fixture', name: 'lab-relay' }, at: '2026-01-01T10:30:00.000Z', detail: { since: '2026-01-01T10:00:00.000Z' } },
      { ...event('question_asked', { prompt: 'Ship?' }), relay: { id: 'rr_fixture', name: 'lab-relay' }, replayed: true },
      { type: 'link_restored', relay: { id: 'rr_fixture', name: 'lab-relay' }, at: '2026-01-01T10:31:00.000Z', detail: { since: '2026-01-01T10:00:00.000Z', kept: 1 } },
    ]),
    shared.buildRelayEventMessageText([{ type: 'relay_restarted', session: null, relay: { id: 'self', name: 'bench-relay' }, detail: { stop: 'unknown' } }]),
    shared.buildRelayEventMessageText([
      { ...event('turn_end', { preview: 'held' }), held: { reason: 'quiet', from: '23:00', to: '06:00', tz: 'Europe/Berlin' } },
      { ...event('task_failed', { kind: 'shell', description: 'npm test', exitCode: 1 }), held: { reason: 'digest', minutes: 30, subscriptionId: 'sub_fixture' } },
    ]),
    shared.buildRelayEventMessageText([
      event('question_answered', { questionId: 'ask_fixture01', prompt: 'Which?', answer: 'A' }),
      event('board_settled', { boardId: 'brd_fixture01', action: 'exit_only', actionLabel: 'Stop here', title: 'Plan B' }),
    ]),
    'a stray text',
  ];
  for (const text of samples) assert.deepEqual(parseRelayEventMessageText(text), shared.parseRelayEventMessageText(text));
});

test('an event row folds to a summary and opens for a question', () => {
  const text = shared.buildRelayEventMessageText([event('question_asked', { prompt: 'Merge <now>?', options: ['Yes', 'No'] }), event('turn_end', { preview: 'ok' })]);
  const message = { role: 'user', kind: RELAY_EVENT_MESSAGE_KIND, text };
  assert.ok(isRelayEventMessage(message));
  assert.ok(!isRelayEventMessage({ role: 'user', text }));
  const html = renderRelayEventRowHtml(message, { timeText: '10:00' });
  assert.match(html, /^<details class="relay-event-row relay-event-urgent" open>/);
  assert.match(html, /relay event<\/span><span class="relay-event-text">2 events · question, reply<\/span><span class="relay-event-time">10:00/);
  assert.match(html, /Merge &lt;now&gt;\?/);
  assert.doesNotMatch(html, /\[relay event\] session/, 'the line prefix is not repeated on every line');
  const quiet = renderRelayEventRowHtml({ role: 'user', kind: RELAY_EVENT_MESSAGE_KIND, text: shared.buildRelayEventMessageText([event('turn_end', { preview: 'ok' })]) });
  assert.match(quiet, /^<details class="relay-event-row">/);
  assert.equal(relayEventSummaryText({ count: 45, types: ['task_finished'], digest: true }), 'Digest · 45 events · task done');
});

test('a replayed row carries its tag and keeps the paired relay\'s name on each line', () => {
  const remote = { id: 'rr_fixture', name: 'lab-relay' };
  const text = shared.buildRelayEventMessageText([
    { type: 'link_lost', relay: remote, at: '2026-01-01T10:30:00.000Z', detail: { since: '2026-01-01T10:00:00.000Z' } },
    { ...event('turn_end', { preview: 'ok' }), relay: remote, replayed: true },
    { type: 'link_restored', relay: remote, at: '2026-01-01T10:31:00.000Z', detail: { since: '2026-01-01T10:00:00.000Z', kept: 1 } },
  ]);
  const html = renderRelayEventRowHtml({ role: 'user', kind: RELAY_EVENT_MESSAGE_KIND, text });
  assert.match(html, /<span class="relay-event-tag relay-event-replayed"[^>]*>replayed<\/span>/);
  assert.match(html, /<span class="relay-event-text">3 events · link lost, reply, link back<\/span>/);
  assert.match(html, /<li class="relay-event-line relay-event-turn-end">lab-relay · session/);
  assert.doesNotMatch(html, /Replayed: 1 event/, 'the replay header is the tag, not a line');
});

test('question_answered and board_settled rows are known types with their labels', () => {
  const text = shared.buildRelayEventMessageText([
    event('question_answered', { questionId: 'ask_fixture01', prompt: 'Which?', answer: 'A' }),
    event('board_settled', { boardId: 'brd_fixture01', action: 'approve', actionLabel: 'Approve plan', title: 'Plan A', queuedMessageId: 'msg-fixture-1' }),
  ]);
  const parsed = parseRelayEventMessageText(text);
  assert.deepEqual(parsed.types, ['question_answered', 'board_settled']);
  assert.equal(relayEventSummaryText(parsed), '2 events · answer, plan card settled');
  const html = renderRelayEventRowHtml({ role: 'user', kind: RELAY_EVENT_MESSAGE_KIND, text });
  assert.match(html, /relay-event-line relay-event-question-answered/);
  assert.match(html, /relay-event-line relay-event-board-settled/);
});

const SUBS = [
  { id: 'sub_a', watcher: 'conv-watcher', scope: 'sessions', sessions: [{ id: 'conv-1' }, { id: 'conv-2' }], events: ['turn_end'] },
  { id: 'sub_b', watcher: 'conv-watcher', scope: 'sessions', sessions: [{ id: 'conv-2' }], events: ['error'], once: true },
  { id: 'sub_c', watcher: 'conv-other', scope: 'all', sessions: 'all', events: ['all_idle'], heartbeatMinutes: 60 },
  { id: 'sub_d', watcher: 'conv-gone', scope: 'sessions', sessions: [{ id: 'conv-1' }], endedAt: '2026-01-01T00:00:00.000Z' },
];

test('relay_restarted: its row is labelled, and a subscription to it alone waits for a restart', () => {
  const text = shared.buildRelayEventMessageText([{ type: 'relay_restarted', session: null, relay: { id: 'self', name: 'bench-relay' }, detail: { stop: 'unknown' } }]);
  assert.equal(relayEventSummaryText(parseRelayEventMessageText(text)), '1 event · relay restarted');
  assert.match(renderRelayEventRowHtml({ role: 'user', kind: RELAY_EVENT_MESSAGE_KIND, text }), /relay-event-line relay-event-relay-restarted/);
  const subscriptions = [{ id: 'sub_fixture1', watcher: 'conv-w', relay: 'self', scope: 'sessions', sessions: [], events: ['relay_restarted'], once: true }];
  const summary = watchingSummary(subscriptions, 'conv-w');
  assert.equal(watchingChipText(summary), 'waiting for a relay restart');
  assert.match(renderWatchingPanelHtml(summary), /<span class="relay-watch-what">This relay<\/span><span class="relay-watch-events">relay_restarted · once<\/span>/);
  assert.deepEqual(watchersOf(subscriptions, 'conv-other'), [], 'no session is watched');
  subscriptions.push({ id: 'sub_fixture2', watcher: 'conv-w', relay: 'self', scope: 'sessions', sessions: [{ id: 'conv-a' }], events: ['turn_end'] });
  assert.equal(watchingChipText(watchingSummary(subscriptions, 'conv-w')), 'watching 1 session');
});

test('a watcher counts the distinct sessions it watches', () => {
  const summary = watchingSummary(SUBS, 'conv-watcher');
  assert.equal(summary.count, 2);
  assert.equal(summary.all, false);
  assert.equal(watchingChipText(summary), 'watching 2 sessions');
  assert.equal(watchingChipText(watchingSummary(SUBS, 'conv-other')), 'watching all sessions');
  assert.equal(watchingChipText(watchingSummary(SUBS, 'conv-1')), '');
});

test('watchers of a session: listed always, all-subscriptions only where asked', () => {
  assert.deepEqual(watchersOf(SUBS, 'conv-1', { includeAll: false }), ['conv-watcher']);
  assert.deepEqual(watchersOf(SUBS, 'conv-1'), ['conv-watcher', 'conv-other']);
  assert.deepEqual(watchersOf(SUBS, 'conv-other'), [], 'a watcher never watches itself');
  assert.deepEqual(watchersOf(SUBS, 'conv-3', { includeAll: false }), []);
  const badge = renderWatchedBadgeHtml(['conv-watcher'], { conversations: { 'conv-watcher': { title: 'Relay assistant' } } });
  assert.equal(badge, '<span class="conv-watched-badge" title="Watched by Relay assistant">watched</span>');
});

test('the chip list names each subscription with its Unsubscribe button', () => {
  const html = renderWatchingPanelHtml(watchingSummary(SUBS, 'conv-watcher'), { conversations: { 'conv-1': { title: 'Orbit camera' } } });
  assert.match(html, /Orbit camera, session conv-2/);
  assert.match(html, /error · once/);
  assert.equal((html.match(/data-subscription-id="/g) || []).length, 2);
});

test('subscriptions on a paired relay count for the chip, name the relay, and badge none of this relay\'s sessions', () => {
  const subs = [
    ...SUBS,
    { id: 'sub_e', watcher: 'conv-watcher', relay: 'rr_fixture', relayName: 'lab-relay', remoteId: 'sub_there', scope: 'sessions', sessions: [{ id: 'conv-1', title: 'Report builder' }], events: ['turn_end'] },
    { id: 'sub_f', watcher: 'conv-watcher', relay: 'rr_fixture', relayName: 'lab-relay', remoteId: 'sub_there2', scope: 'all', sessions: 'all', events: ['error'] },
  ];
  const summary = watchingSummary(subs, 'conv-watcher');
  assert.equal(summary.count, 3, 'the same id on another relay is another session');
  assert.deepEqual(summary.relays, ['lab-relay']);
  const html = renderWatchingPanelHtml(summary, { conversations: { 'conv-1': { title: 'Orbit camera' } } });
  assert.match(html, /lab-relay · Report builder/);
  assert.match(html, /All sessions of lab-relay/);
  assert.deepEqual(watchersOf(subs, 'conv-1'), ['conv-watcher', 'conv-other'], 'a paired relay\'s "all" badges nothing here');
});

test('subscription options: a small hint on the chip, named in the list, and exclude respected by the badge', () => {
  const quiet = { from: '23:00', to: '06:00', tz: 'Europe/Berlin' };
  const subs = [
    { id: 'sub_h', watcher: 'conv-w', relay: 'self', scope: 'all', sessions: 'all', events: ['turn_end'], digestMinutes: 30, quietHours: quiet, exclude: ['conv-1'] },
    { id: 'sub_i', watcher: 'conv-w', relay: 'self', scope: 'sessions', sessions: [{ id: 'conv-2' }], events: ['error'], digestMinutes: 30 },
  ];
  const summary = watchingSummary(subs, 'conv-w');
  assert.equal(watchingChipText(summary), 'watching all sessions (+1 listed)');
  assert.equal(watchingChipHint(summary), 'digest 30 min · quiet 23:00–06:00', 'each named once');
  assert.equal(watchingChipHint(watchingSummary(SUBS, 'conv-watcher')), '');
  assert.match(renderWatchingPanelHtml(summary), /turn_end · digest 30 min · quiet 23:00–06:00 Europe\/Berlin · 1 left out/);
  assert.deepEqual(watchersOf(subs, 'conv-1'), [], 'left out of the "all" subscription');
  assert.deepEqual(watchersOf(subs, 'conv-3'), ['conv-w']);
});

test('a row held through quiet hours says so in its summary', () => {
  const text = shared.buildRelayEventMessageText([
    { ...event('turn_end', { preview: 'one' }), held: { reason: 'quiet', from: '23:00', to: '06:00', tz: 'UTC' } },
    { ...event('turn_end', { preview: 'two' }), held: { reason: 'quiet', from: '23:00', to: '06:00', tz: 'UTC' } },
  ]);
  const html = renderRelayEventRowHtml({ role: 'user', kind: RELAY_EVENT_MESSAGE_KIND, text });
  assert.match(html, /<span class="relay-event-text">After quiet hours · 2 events · reply<\/span>/);
  assert.doesNotMatch(html, /Held during quiet hours/, 'the header is the summary, not a line');
});

test('a paired relay\'s watcher is named with its relay on the badge', () => {
  const subs = [{ id: 'sub_g', watcher: 'remote:relay-fixture-a', relay: 'self', subscriber: { relayId: 'relay-fixture-a', name: 'win-test', watcherId: 'conv-far', watcherTitle: 'Relay assistant' }, scope: 'sessions', sessions: [{ id: 'conv-1' }], events: ['turn_end'] }];
  const watchers = watchersOf(subs, 'conv-1', { includeAll: false });
  assert.deepEqual(watchers, ['remote:relay-fixture-a:conv-far']);
  assert.equal(
    renderWatchedBadgeHtml(watchers, { subscriptions: subs }),
    '<span class="conv-watched-badge" title="Watched by Relay assistant on win-test">watched</span>',
  );
});
