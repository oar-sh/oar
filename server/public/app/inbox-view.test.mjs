import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { RELAY_ASK_LIMITS, RELAY_ASK_SOCKET_EVENT as SHARED_SOCKET_EVENT } from '../../../shared/relay-asks.mjs';
import {
  INBOX_ANSWERED_KEEP_MS,
  RELAY_ASK_SOCKET_EVENT,
  buildAskCard,
  createCoalescedRefresh,
  formatInboxAge,
  sessionAsksFromInbox,
  inboxFilterMatches,
  inboxPendingCount,
  inboxSections,
  inboxSessionUrl,
  renderInbox,
} from './inbox-view.mjs';

const NOW = Date.parse('2026-03-02T12:00:00.000Z');
const doc = new JSDOM('<!doctype html><body></body>').window.document;
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

const SELF = { id: 'self', name: 'bench-relay', self: true, reachable: true };
const LAB = { id: 'r-lab', name: 'lab-relay', url: 'https://relay-b.example.test', reachable: true };

function ask(id, extra = {}) {
  return {
    id,
    kind: 'ask',
    session: { id: `conv-${id}`, title: `Session ${id}`, startedBy: 'owner' },
    question: `Question ${id}?`,
    options: [],
    status: 'pending',
    createdAt: minutesAgo(5),
    ...extra,
  };
}

test('the copies of shared/relay-asks.mjs match it', () => {
  assert.equal(RELAY_ASK_SOCKET_EVENT, SHARED_SOCKET_EVENT);
  assert.equal(INBOX_ANSWERED_KEEP_MS, RELAY_ASK_LIMITS.answeredKeepMs);
});

test('HTML in an agent\'s detail, question, options and recommendation is shown literally', () => {
  const card = buildAskCard(doc, ask('a1', {
    question: '<b>Ship</b> it?',
    options: ['<i>Yes</i>', 'No'],
    recommendation: '<a href="https://evil.example">trust me</a>',
    detail: '<img src=x onerror="alert(1)">\n<script>alert(2)</script>\n[link](https://evil.example)',
  }), { relay: SELF, now: NOW });
  assert.equal(card.querySelector('.inbox-item-question').textContent, '<b>Ship</b> it?');
  assert.equal(card.querySelector('.inbox-item-detail-text').textContent, '<img src=x onerror="alert(1)">\n<script>alert(2)</script>\n[link](https://evil.example)');
  assert.equal(card.querySelector('.inbox-item-recommendation').textContent, 'Recommended: <a href="https://evil.example">trust me</a>');
  assert.equal(card.querySelectorAll('img, script, b, i').length, 0, 'nothing of it became markup');
  assert.equal(card.querySelectorAll('a').length, 0, 'no link from agent text');
  assert.deepEqual([...card.querySelectorAll('.inbox-choice')].map((node) => node.textContent), ['<i>Yes</i>', 'No']);
  assert.equal(card.querySelector('details').open, false, 'the detail is folded');
});

test('the recommended option is marked; Answer and Dismiss carry what they act on', () => {
  const card = buildAskCard(doc, ask('a1', { options: ['Postgres', 'SQLite'], recommendation: 'SQLite', urgency: 'now' }), { relay: LAB, now: NOW });
  const recommended = card.querySelector('.inbox-choice.recommended');
  assert.equal(recommended.dataset.choice, 'SQLite');
  assert.equal(recommended.getAttribute('aria-label'), 'SQLite (recommended)');
  assert.equal(card.querySelector('.inbox-item-recommendation'), null, 'an option needs no extra line');
  assert.equal(card.querySelector('.inbox-item-urgent').textContent, 'urgent');
  assert.deepEqual({ ...card.querySelector('.inbox-answer').dataset }, { relayId: 'r-lab', itemId: 'a1', inboxAction: 'answer' });
  assert.equal(card.querySelector('.inbox-dismiss').dataset.inboxAction, 'dismiss');
  assert.equal(card.querySelector('.inbox-open-there').href, 'https://relay-b.example.test/?conv=conv-a1');
  const answered = buildAskCard(doc, ask('a2', { status: 'answered', answer: 'SQLite', choice: 'SQLite', answeredVia: 'lab-relay' }), { relay: SELF, now: NOW });
  assert.equal(answered.querySelector('.inbox-item-outcome').textContent, 'Answered: SQLite (from lab-relay)');
  assert.equal(answered.querySelector('button.inbox-answer'), null);
});

test('in its session the card says it does not block, and names who asked on its behalf', () => {
  const card = buildAskCard(doc, ask('a1', { onBehalf: true, askedBy: { conversationId: 'conv-lead', title: 'Lead' } }), { relay: SELF, mode: 'session', now: NOW });
  assert.match(card.querySelector('.inbox-item-kind').textContent, /does not block this session/);
  assert.equal(card.querySelector('.inbox-item-asker').textContent, 'asked by Lead');
  assert.equal(card.querySelector('.inbox-open-session'), null, 'no link to the session it is in');
});

test('sections: per relay, pending newest first, answered in the last day under a divider, filtered', () => {
  const relays = [
    { ...SELF, items: [
      ask('old', { createdAt: minutesAgo(30) }),
      ask('new', { createdAt: minutesAgo(2), session: { id: 'conv-x', title: 'Agent work', startedBy: 'agent' } }),
      ask('done', { status: 'answered', answer: 'Yes', answeredAt: minutesAgo(60), createdAt: minutesAgo(90) }),
      ask('stale', { status: 'dismissed', answeredAt: minutesAgo(25 * 60), createdAt: minutesAgo(26 * 60) }),
      { id: 'card-1', kind: 'ask_user', session: { id: 'conv-y', title: 'Waiting', startedBy: 'owner' }, question: 'Theme?', options: ['Light'], status: 'pending', createdAt: minutesAgo(10) },
    ] },
    { ...LAB, items: [ask('there', { createdAt: minutesAgo(1) })] },
    { id: 'r-gone', name: 'gone-relay', reachable: false, error: 'offline', items: [] },
  ];
  const [self, lab, gone] = inboxSections(relays, { now: NOW });
  assert.deepEqual(self.pending.map((item) => item.id), ['new', 'card-1', 'old']);
  assert.deepEqual(self.closed.map((item) => item.id), ['done'], 'a day later it is gone');
  assert.deepEqual(lab.pending.map((item) => item.id), ['there']);
  assert.equal(gone.relay.reachable, false);
  assert.deepEqual(inboxSections(relays, { filter: 'agents', now: NOW })[0].pending.map((item) => item.id), ['new']);
  assert.deepEqual(inboxSections(relays, { filter: 'mine', now: NOW })[0].pending.map((item) => item.id), ['card-1', 'old']);
  assert.equal(inboxPendingCount(relays), 4);
  assert.equal(inboxFilterMatches({ session: {} }, 'mine'), true, 'unknown counts as the owner\'s');

  const root = renderInbox(doc, { relays, now: NOW });
  assert.deepEqual([...root.querySelectorAll('.inbox-relay-name')].map((node) => node.textContent), ['bench-relay (this relay)', 'lab-relay', 'gone-relay']);
  assert.equal(root.querySelector('.inbox-relay[data-relay-id="r-gone"] .inbox-relay-unreachable').textContent, 'Not reachable: offline');
  assert.equal(root.querySelectorAll('.inbox-divider').length, 1);
  assert.equal(root.querySelector('.inbox-filter-option.active').dataset.inboxFilter, 'all');
});

test('a card here is answered in place unless it needs its session; a paired relay\'s card opens there', () => {
  const card = { id: 'card-1', kind: 'ask_user', session: { id: 'conv-y', title: 'Waiting', startedBy: 'owner' }, question: 'Theme?', options: ['Light', 'Dark'], allowFreeform: false, status: 'pending', createdAt: minutesAgo(10), sdkSessionId: 'sdk-1' };
  const approval = { id: 'card-2', kind: 'approval', session: { id: 'conv-z', title: 'Caller' }, header: 'Remote relay', question: '', status: 'pending', createdAt: minutesAgo(3) };
  const root = renderInbox(doc, {
    relays: [
      { ...SELF, items: [card, { ...card, id: 'card-3', structured: true }] },
      { ...LAB, items: [approval, { ...card, id: 'card-4', sdkSessionId: undefined }] },
    ],
    now: NOW,
  });
  const here = root.querySelector('[data-item-id="card-1"]');
  assert.deepEqual([...here.querySelectorAll('.inbox-choice')].map((node) => [node.dataset.inboxAction, node.dataset.choice, node.dataset.sdkSessionId]), [['card-choice', 'Light', 'sdk-1'], ['card-choice', 'Dark', 'sdk-1']]);
  assert.equal(here.querySelector('.inbox-answer-text'), null, 'a card without free text takes its choices only');
  assert.equal(here.querySelector('.inbox-open-session').dataset.sessionId, 'conv-y');
  assert.equal(root.querySelector('[data-item-id="card-3"] .inbox-open-session-button').dataset.inboxAction, 'open');
  const there = root.querySelector('[data-item-id="card-2"]');
  assert.equal(there.querySelector('.inbox-open-there-button').href, 'https://relay-b.example.test/?conv=conv-z');
  assert.equal(there.querySelectorAll('button[data-inbox-action]').length, 0, 'an approval card there is never answered from here');
  assert.equal(root.querySelector('[data-item-id="card-4"] button[data-inbox-action="card-choice"]'), null);
});

test('a refresh asked for while one runs runs once more after it, never twice at once', async () => {
  const releases = [];
  let running = 0;
  let most = 0;
  let loads = 0;
  const refresh = createCoalescedRefresh(async () => {
    loads += 1;
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => releases.push(resolve));
    running -= 1;
    return loads;
  });
  const first = refresh();
  const second = refresh();
  const third = refresh();
  assert.equal(second, first, 'answered by the load that runs');
  assert.equal(third, first);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 2, 'one more load for the calls that came meanwhile, not two');
  releases.shift()();
  assert.equal(await first, 2, 'resolves with the last load');
  assert.equal(most, 1);
  // Idle again: the next call starts a load of its own.
  const fourth = refresh();
  assert.notEqual(fourth, first);
  releases.shift()();
  assert.equal(await fourth, 3);
});

test('the session cards are built anew from each load: a withdrawn ask drops out', () => {
  const load = (items) => [{ ...SELF, items }, { ...LAB, items: [ask('there')] }];
  const before = sessionAsksFromInbox(load([ask('a1'), ask('a2'), { id: 'card-1', kind: 'ask_user', status: 'pending' }]));
  assert.deepEqual([...before.keys()], ['a1', 'a2'], 'this relay\'s asks only');
  assert.equal(before.get('a1').conversationId, 'conv-a1');
  const after = sessionAsksFromInbox(load([ask('a2')]));
  assert.deepEqual([...after.keys()], ['a2']);
  assert.equal(sessionAsksFromInbox(null).size, 0);
});

test('ages and session links', () => {
  assert.equal(formatInboxAge(minutesAgo(0), NOW), 'just now');
  assert.equal(formatInboxAge(minutesAgo(7), NOW), '7 min');
  assert.equal(formatInboxAge(minutesAgo(180), NOW), '3 h');
  assert.equal(formatInboxAge(minutesAgo(60 * 72), NOW), '3 d');
  assert.equal(formatInboxAge('nope', NOW), '');
  assert.equal(inboxSessionUrl('https://relay-b.example.test/', 'conv 1'), 'https://relay-b.example.test/?conv=conv%201');
  assert.equal(inboxSessionUrl('javascript:alert(1)', 'x'), '', 'only http(s) addresses');
});
