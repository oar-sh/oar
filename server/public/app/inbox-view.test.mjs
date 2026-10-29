import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { INBOX_REMOTE_CHANGED_EVENT as SHARED_REMOTE_CHANGED_EVENT, RELAY_ASK_LIMITS, RELAY_ASK_SOCKET_EVENT as SHARED_SOCKET_EVENT } from '../../../shared/relay-asks.mjs';
import { REMOTE_INBOX_CHANGED_EVENT as SERVER_REMOTE_CHANGED_EVENT } from '../../services/remote-inbox-watch-service.mjs';
import { REMOTE_RELAY_APPROVAL_VARIANT_LABELS, REMOTE_RELAY_APPROVAL_VARIANTS } from '../../../shared/remote-relay-contract.mjs';
import {
  INBOX_ANSWERED_KEEP_MS,
  INBOX_APPROVAL_VARIANT_LABELS,
  INBOX_REMOTE_CHANGED_EVENT,
  RELAY_ASK_SOCKET_EVENT,
  buildAskCard,
  buildPlanItem,
  captureInboxFolds,
  createCoalescedRefresh,
  inboxFoldKey,
  noteInboxFold,
  pruneInboxFolds,
  restoreInboxFolds,
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
  // The event the server's watch of paired relays sends, and the one the page listens to.
  assert.equal(INBOX_REMOTE_CHANGED_EVENT, SHARED_REMOTE_CHANGED_EVENT);
  assert.equal(SERVER_REMOTE_CHANGED_EVENT, SHARED_REMOTE_CHANGED_EVENT);
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

// ─── Plan cards ─────────────────────────────────────────────────────

function plan(id, extra = {}) {
  return {
    id,
    kind: 'plan',
    session: { id: `conv-${id}`, title: `Session ${id}`, startedBy: 'agent' },
    title: 'Plan ready for review',
    body: '1. Split <b>the</b> parser\n2. Move the tests',
    actions: [
      { id: 'approve_only', label: 'Approve plan' },
      { id: 'autopilot', label: 'Implement in autopilot' },
      { id: 'exit_only', label: 'Stop here' },
    ],
    recommendedAction: 'approve_only',
    planOnly: true,
    status: 'pending',
    selectedAction: null,
    createdAt: minutesAgo(3),
    ...extra,
  };
}

test('a plan card: its head, the plan folded and shown literally, and the card\'s own buttons', () => {
  const card = buildPlanItem(doc, plan('p1'), { relay: SELF, now: NOW });
  assert.equal(card.dataset.kind, 'plan');
  assert.equal(card.querySelector('.inbox-item-kind').textContent, 'Plan · ready for review');
  assert.equal(card.querySelector('.inbox-open-session').textContent, 'Session p1');
  const details = card.querySelector('details.inbox-plan-body');
  assert.equal(details.open, false, 'the plan is folded');
  assert.equal(details.querySelector('.inbox-plan-text').textContent, '1. Split <b>the</b> parser\n2. Move the tests');
  assert.equal(card.querySelectorAll('b').length, 0);
  const buttons = [...card.querySelectorAll('.inbox-plan-action')];
  assert.deepEqual(buttons.map((node) => node.textContent), ['Approve plan', 'Implement in autopilot', 'Stop here']);
  assert.deepEqual({ ...buttons[0].dataset }, { relayId: 'self', inboxAction: 'plan-action', boardId: 'p1', actionId: 'approve_only', sessionId: 'conv-p1' });
  assert.ok(buttons[0].classList.contains('inbox-plan-action-recommended'));
  assert.ok(!buttons[1].classList.contains('inbox-plan-action-recommended'));
});

test('a settled plan card says what was chosen; a paired relay\'s has its title and "Open there"', () => {
  const chosen = buildPlanItem(doc, plan('p2', { status: 'acted', selectedAction: 'approve_only', actedAt: minutesAgo(1) }), { relay: SELF, now: NOW });
  assert.equal(chosen.querySelector('.inbox-item-outcome').textContent, 'Chosen: Approve plan');
  assert.equal(chosen.querySelectorAll('button.inbox-plan-action').length, 0);
  const stopped = buildPlanItem(doc, plan('p3', { status: 'dismissed', selectedAction: 'exit_only' }), { relay: SELF, now: NOW });
  assert.equal(stopped.querySelector('.inbox-item-outcome').textContent, 'Chosen: Stop here');

  const remote = { id: 'p4', kind: 'plan', session: { id: 'conv-p4', title: 'Far session' }, title: 'Ship the cache', question: 'Ship the cache', status: 'pending', createdAt: minutesAgo(2) };
  const there = buildPlanItem(doc, remote, { relay: LAB, now: NOW });
  assert.equal(there.querySelector('.inbox-item-header').textContent, 'Ship the cache');
  assert.equal(there.querySelector('details'), null);
  assert.equal(there.querySelectorAll('.inbox-plan-action').length, 0);
  assert.equal(there.querySelector('.inbox-open-there-button').href, 'https://relay-b.example.test/?conv=conv-p4');
});

test('plan cards sort into the sections and count in the badge; an acted one is closed', () => {
  const relays = [{ ...SELF, items: [plan('p5'), plan('p6', { status: 'acted', selectedAction: 'autopilot', actedAt: minutesAgo(10) }), ask('a9')] }];
  const [section] = inboxSections(relays, { now: NOW });
  assert.deepEqual(section.pending.map((item) => item.id).sort(), ['a9', 'p5']);
  assert.deepEqual(section.closed.map((item) => item.id), ['p6']);
  assert.equal(inboxPendingCount(relays), 2);
  const root = renderInbox(doc, { relays, now: NOW });
  assert.equal(root.querySelectorAll('.inbox-plan').length, 2);
});

// ─── Folds across re-renders ──────────────────────────────────────────────────

test('an open fold stays open across a re-render, a closed one stays closed, by relay and item', () => {
  const relays = [
    { ...SELF, items: [ask('a1', { detail: 'Plan draft:\n1. Split the parser' }), ask('a2', { detail: 'More' }), plan('p1')] },
    { ...LAB, items: [ask('a1', { detail: 'The same id on another relay' })] },
  ];
  const openFolds = new Set();
  const host = doc.createElement('div');
  const render = () => {
    captureInboxFolds(openFolds, host);
    host.replaceChildren(renderInbox(doc, { relays, now: NOW }));
    restoreInboxFolds(openFolds, host);
  };
  const fold = (relayId, itemId, kind = 'detail') => host.querySelector(`.inbox-item[data-relay-id="${relayId}"][data-item-id="${itemId}"] details.${kind === 'plan' ? 'inbox-plan-body' : 'inbox-item-detail'}`);
  render();
  assert.equal(fold('self', 'a1').open, false, 'folded at first');
  fold('self', 'a1').open = true;
  fold('self', 'p1', 'plan').open = true;
  render();
  assert.equal(fold('self', 'a1').open, true, 'still open after the re-render');
  assert.equal(fold('self', 'p1', 'plan').open, true, 'the plan too');
  assert.equal(fold('self', 'a2').open, false, 'a closed one stays closed');
  assert.equal(fold('r-lab', 'a1').open, false, 'the same id on another relay is its own');
  // Closed by hand, it stays closed.
  fold('self', 'a1').open = false;
  render();
  assert.equal(fold('self', 'a1').open, false);
  // A toggle noted directly (the page's `toggle` listener) counts the same.
  noteInboxFold(openFolds, fold('self', 'a2'));
  fold('self', 'a2').open = true;
  noteInboxFold(openFolds, fold('self', 'a2'));
  assert.ok(openFolds.has(inboxFoldKey(fold('self', 'a2'))));
});

test('a fold is forgotten once its item leaves the list; an unreachable relay keeps its folds', () => {
  const openFolds = new Set([`self\na1\ndetail`, `self\np1\nplan`, `r-lab\na7\ndetail`]);
  pruneInboxFolds(openFolds, [
    { ...SELF, items: [plan('p1')] },
    { ...LAB, reachable: false, items: [] },
  ], { now: NOW });
  assert.deepEqual([...openFolds].sort(), [`r-lab\na7\ndetail`, `self\np1\nplan`]);
  // Answered more than a day ago: no longer listed.
  pruneInboxFolds(openFolds, [
    { ...SELF, items: [plan('p1', { status: 'acted', actedAt: new Date(NOW - INBOX_ANSWERED_KEEP_MS - 60_000).toISOString() })] },
    { ...LAB, items: [] },
  ], { now: NOW });
  assert.deepEqual([...openFolds], []);
});

test('a session\'s ask card keeps its Details open when it is drawn again', () => {
  const openFolds = new Set();
  const item = ask('a3', { detail: 'Background', session: { id: 'conv-a3' } });
  const draw = () => buildAskCard(doc, item, { relay: { id: 'self', self: true }, mode: 'session', now: NOW });
  const wrapper = doc.createElement('div');
  wrapper.append(draw());
  wrapper.querySelector('details').open = true;
  captureInboxFolds(openFolds, wrapper);
  wrapper.replaceChildren(draw());
  restoreInboxFolds(openFolds, wrapper);
  assert.equal(wrapper.querySelector('details.inbox-item-detail').open, true);
});
test('the approval kinds named here are the shared ones', () => {
  assert.deepEqual(Object.keys(INBOX_APPROVAL_VARIANT_LABELS), [...REMOTE_RELAY_APPROVAL_VARIANTS]);
  assert.deepEqual(INBOX_APPROVAL_VARIANT_LABELS, REMOTE_RELAY_APPROVAL_VARIANT_LABELS);
});

test('a paired relay\'s approval says what it is about; one from a relay without summaries keeps the plain text', () => {
  const approval = {
    id: 'card-5', kind: 'approval', session: { id: 'conv-z', title: 'Caller' }, header: 'Remote relay', question: '', status: 'pending', createdAt: minutesAgo(3),
    variant: 'create_session', summary: 'New session requested by \'Lead <b>x</b>\': Docs pass, claude-sonnet-5',
  };
  const old = { ...approval, id: 'card-6', variant: undefined, summary: undefined };
  const loop = { ...approval, id: 'card-7', variant: 'loop_guard', summary: 'Loop guard: 30 prompts by \'Lead\'' };
  const unknown = { ...approval, id: 'card-8', variant: 'something_new', summary: 'Something new requested by \'Lead\'' };
  const root = renderInbox(doc, { relays: [{ ...SELF, items: [] }, { ...LAB, items: [approval, old, loop, unknown, { ...approval, id: 'card-9', variant: 'constructor' }] }], now: NOW });
  const card = (id) => root.querySelector(`[data-item-id="${id}"]`);
  assert.equal(card('card-5').querySelector('.inbox-item-kind').textContent, 'New session · the session waits');
  const summary = card('card-5').querySelector('.inbox-item-summary');
  assert.equal(summary.textContent, 'lab-relay · New session requested by \'Lead <b>x</b>\': Docs pass, claude-sonnet-5');
  assert.equal(summary.querySelector('b'), null, 'plain text, never markup');
  assert.equal(card('card-5').querySelector('.inbox-open-there-button').href, 'https://relay-b.example.test/?conv=conv-z');
  assert.equal(card('card-5').querySelectorAll('button[data-inbox-action]').length, 0);
  assert.equal(card('card-6').querySelector('.inbox-item-kind').textContent, 'Approval · the session waits');
  assert.equal(card('card-6').querySelector('.inbox-item-question').textContent, 'An Allow / Deny card on that relay.');
  assert.equal(card('card-6').querySelector('.inbox-item-summary'), null);
  assert.equal(card('card-7').querySelector('.inbox-item-kind').textContent, 'Loop guard · the session waits');
  assert.equal(card('card-8').querySelector('.inbox-item-kind').textContent, 'Approval · the session waits');
  assert.equal(card('card-9').querySelector('.inbox-item-kind').textContent, 'Approval · the session waits', 'no inherited name passes for a variant');
});
