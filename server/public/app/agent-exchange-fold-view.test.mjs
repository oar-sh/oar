import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_EXCHANGE_STATUS_TEXT,
  agentExchangeFoldOpen,
  agentExchangeRowOf,
  agentExchangeSummary,
  isAgentPromptMessage,
  planAgentExchangeFolds,
  renderAgentExchangeRowHtml,
  replyOutcome,
} from './agent-exchange-fold-view.mjs';
import { RELAY_EVENT_LEAD, RELAY_EVENT_MESSAGE_KIND } from './relay-event-view.mjs';

const REMOTE = { relayId: 'relay-fixture-b', relayName: 'win-test', conversationId: 'conv-src', conversationTitle: 'report builder', hops: 1 };
const LOCAL = { local: true, relayId: 'relay-fixture-a', relayName: 'linux-test', conversationId: 'c-lead', conversationTitle: 'sidebar polish', hops: 0 };

const at = (minute, second = 0) => `2026-10-01T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
const user = (id, minute, extra = {}) => agentExchangeRowOf({ id, role: 'user', text: `message ${id}`, timestamp: at(minute), ...extra });
const agent = (id, minute, extra = {}) => user(id, minute, { origin: REMOTE, ...extra });
const reply = (id, source, minute, extra = {}) => agentExchangeRowOf({ id, role: 'assistant', text: `reply ${id}`, sourceMessageId: source, timestamp: at(minute, 30), ...extra });
const live = (id) => ({ id, role: 'assistant', live: true });
const FAILURE = 'The relay runtime hit a terminal error and could not complete this turn. Error code: relay.copilot-session-lost. Send the message again to retry.';
const STOP = 'System note: This turn was stopped from the relay UI before completion. Error code: relay.turn-aborted. Send a new message to continue when you are ready.';

const planOf = (rows, options) => planAgentExchangeFolds(rows, options);
const only = (rows, options) => {
  const plan = planOf(rows, options);
  assert.equal(plan.length, 1);
  return plan[0];
};

test('an agent prompt and its reply fold together; the user\'s own exchange is not planned', () => {
  const rows = [user('u1', 1), reply('a1', 'u1', 1), agent('p1', 2), reply('a2', 'p1', 2), user('u2', 3), reply('a3', 'u2', 3)];
  const group = only(rows);
  assert.equal(group.promptId, 'p1');
  assert.deepEqual(group.members.map((row) => row.id), ['a2']);
  assert.equal(group.fold, true);
  assert.deepEqual(group.reasons, []);
  assert.equal(group.status, 'replied');
  assert.equal(group.transient, false);
});

test('only a user row with an agent\'s origin is an agent prompt', () => {
  assert.equal(isAgentPromptMessage({ role: 'user', origin: REMOTE }), true);
  assert.equal(isAgentPromptMessage({ role: 'user', origin: LOCAL }), true);
  assert.equal(isAgentPromptMessage({ role: 'user', origin: { hops: 1 } }), false, 'an origin that names no relay');
  assert.equal(isAgentPromptMessage({ role: 'user' }), false);
  assert.equal(isAgentPromptMessage({ role: 'assistant', origin: REMOTE }), false);
  assert.equal(isAgentPromptMessage({ role: 'user', kind: RELAY_EVENT_MESSAGE_KIND, text: RELAY_EVENT_LEAD, origin: REMOTE }), false);
  const row = agentExchangeRowOf({ id: 'p1', role: 'user', origin: { hops: 1 }, timestamp: at(1) });
  assert.equal(row.origin, null);
  assert.equal(row.timestampMs, Date.parse(at(1)));
  assert.equal(agentExchangeRowOf({ role: 'user', timestamp: 'later' }).timestampMs, 0);
  const parsed = agentExchangeRowOf({ role: 'user', timestamp: 'x' }, { id: 'u7', parseTimestamp: () => 42 });
  assert.deepEqual([parsed.id, parsed.timestampMs], ['u7', 42]);
});

test('the summary names the relay, the sending session and the status', () => {
  assert.deepEqual(agentExchangeSummary(REMOTE, 'replied'), {
    from: 'win-test',
    title: 'report builder',
    status: 'replied',
    statusText: 'replied',
    head: 'note from win-test · report builder',
    text: 'note from win-test · report builder · replied',
  });
  // A same-relay prompt: the relay's own name from the origin, the sending
  // conversation's current title when the list knows it.
  const conversations = { 'c-lead': { id: 'c-lead', title: 'sidebar polish 2' } };
  assert.equal(agentExchangeSummary(LOCAL, 'working', { conversations }).text, 'note from linux-test · sidebar polish 2 · working…');
  assert.equal(agentExchangeSummary(LOCAL, 'working').text, 'note from linux-test · sidebar polish · working…');
  assert.equal(agentExchangeSummary({ local: true }, 'failed').text, 'note from this relay · failed');
  assert.equal(agentExchangeSummary({ relayId: 'relay-fixture-c' }, 'odd').text, 'note from relay-fixture-c · no reply yet');
  assert.deepEqual(Object.keys(AGENT_EXCHANGE_STATUS_TEXT), ['working', 'replied', 'failed', 'stopped', 'none']);
});

test('the row is a details folded to its summary, escaped', () => {
  const summary = agentExchangeSummary({ ...REMOTE, conversationTitle: 'nightly <digest>' }, 'failed');
  const html = renderAgentExchangeRowHtml(summary, { timeText: '10:02' });
  assert.equal(html, '<details class="agent-exchange-row agent-exchange-failed">'
    + '<summary class="agent-exchange-summary" title="note from win-test · nightly &lt;digest&gt; · failed">'
    + '<span class="agent-exchange-text">note from win-test · nightly &lt;digest&gt;</span>'
    + '<span class="agent-exchange-status">failed</span>'
    + '<span class="agent-exchange-time">10:02</span>'
    + '</summary></details>');
  assert.match(renderAgentExchangeRowHtml(summary, { open: true }), /^<details class="agent-exchange-row agent-exchange-failed" open>/);
  assert.doesNotMatch(renderAgentExchangeRowHtml(summary), /agent-exchange-time/);
});

test('a running turn is folded as working, its live bubble with it', () => {
  const group = only([agent('p1', 1), live('p1')]);
  assert.equal(group.fold, true);
  assert.equal(group.status, 'working');
  assert.deepEqual(group.members.map((row) => [row.id, !!row.live]), [['p1', true]]);
  // Running without a bubble on the page (the relay says so).
  assert.equal(only([agent('p1', 1)], { runningIds: ['p1'] }).status, 'working');
  // Neither running nor answered: queued, or never run.
  assert.equal(only([agent('p1', 1)]).status, 'none');
});

test('a working exchange shows open, a finished one folded, and the user\'s toggle wins', () => {
  assert.equal(agentExchangeFoldOpen('working'), true);
  for (const status of ['replied', 'failed', 'stopped', 'none', undefined]) {
    assert.equal(agentExchangeFoldOpen(status), false, String(status));
    assert.equal(agentExchangeFoldOpen(status, true), true, String(status));
  }
  assert.equal(agentExchangeFoldOpen('working', false), false);
  assert.equal(agentExchangeFoldOpen('working', true), true);
  assert.equal(agentExchangeFoldOpen('replied', false), false);
});

test('failed and stopped turns say so; an answer that quotes a code does not', () => {
  assert.equal(replyOutcome(FAILURE), 'failed');
  assert.equal(replyOutcome(STOP), 'stopped');
  assert.equal(replyOutcome(`What the turn wrote first.\n\n${FAILURE}`), 'failed');
  assert.equal(replyOutcome('The log said "Error code: relay.copilot-session-lost." twice.'), '');
  assert.equal(replyOutcome('all done'), '');
  assert.equal(only([agent('p1', 1), reply('a1', 'p1', 1, { text: FAILURE })]).status, 'failed');
  assert.equal(only([agent('p1', 1), reply('a1', 'p1', 1, { text: STOP })]).status, 'stopped');
  // A reply in the end wins over a live bubble not yet taken down.
  assert.equal(only([agent('p1', 1), live('p1'), reply('a1', 'p1', 1)]).status, 'replied');
});

test('a user message steered into the turn keeps the whole turn open', () => {
  // Handed off: the reply settled absorbed, the turn went on on the user's row.
  const handoff = planOf([agent('p1', 1), reply('a1', 'p1', 1, { kind: 'absorbed' }), { ...user('u2', 1), steered: true }, reply('a2', 'u2', 2)]);
  assert.deepEqual(handoff.map((group) => [group.promptId, group.fold, group.reasons]), [['p1', false, ['steered-in']]]);

  // Folded into it: the user's message has a marker, the reply answers both.
  const folded = [agent('p1', 1), reply('a1', 'p1', 3), { ...user('u2', 2), steered: true }, reply('m2', 'u2', 3, { kind: 'folded' })];
  assert.deepEqual(only(folded).reasons, ['steered-in']);
  // Stopped with it: the same.
  const stopped = [agent('p1', 1), reply('a1', 'p1', 3, { text: STOP }), { ...user('u2', 2), steered: true }, reply('m2', 'u2', 3, { kind: 'stopped' })];
  assert.deepEqual(only(stopped).reasons, ['steered-in']);
});

test('the turn a steer joined is the one running when it was sent', () => {
  // p1 ran 10:01–10:03, p2 was queued behind it (sent 10:02, answered 10:05);
  // the user's steer at 10:02:30 joined p1.
  const rows = [
    agent('p1', 1), reply('a1', 'p1', 3),
    agent('p2', 2), reply('a2', 'p2', 5),
    agentExchangeRowOf({ id: 'u3', role: 'user', text: 'and the totals', timestamp: '2026-10-01T10:02:20.000Z' }),
    reply('m3', 'u3', 3, { kind: 'folded' }),
  ];
  const plan = planOf(rows);
  assert.deepEqual(plan.map((group) => [group.promptId, group.fold]), [['p1', false], ['p2', true]]);

  // A steer into the user's own earlier turn leaves the agent's alone.
  const own = [
    user('u1', 1), reply('a1', 'u1', 4),
    agent('p2', 2), reply('a2', 'p2', 6),
    user('u3', 3), reply('m3', 'u3', 4, { kind: 'folded' }),
  ];
  assert.equal(only(own).fold, true);

  // Into a turn still running: it has not ended, so it is still the host.
  assert.deepEqual(only([agent('p1', 1), live('p1'), user('u2', 2), reply('m2', 'u2', 2, { kind: 'stopped' })]).reasons, ['steered-in']);
});

test('an agent prompt steered into another turn is not folded', () => {
  const intoUsers = planOf([user('u1', 1), reply('a1', 'u1', 1, { kind: 'absorbed' }), { ...agent('p2', 1), steered: true }, reply('a2', 'p2', 2)]);
  assert.deepEqual(intoUsers.map((group) => [group.promptId, group.fold, group.reasons]), [['p2', false, ['steered']]]);
  const marker = planOf([user('u1', 1), reply('a1', 'u1', 3), agent('p2', 2), reply('m2', 'p2', 3, { kind: 'folded' })]);
  assert.deepEqual(marker.map((group) => [group.promptId, group.fold, group.reasons]), [['p2', false, ['steered']]]);
  // Steered into another agent's turn: neither of the two folds.
  const agents = planOf([agent('p1', 1), reply('a1', 'p1', 3), agent('p2', 2), reply('m2', 'p2', 3, { kind: 'folded' })]);
  assert.deepEqual(agents.map((group) => [group.promptId, group.fold]), [['p1', false], ['p2', false]]);
});

test('an open question or approval card keeps its turn shown, for a while only', () => {
  const group = only([agent('p1', 1), live('p1')], { openCardIds: new Set(['p1']) });
  assert.deepEqual([group.fold, group.reasons, group.transient], [false, ['open-card'], true]);
  assert.equal(only([agent('p1', 1), live('p1')], { openCardIds: ['p9'] }).fold, true);
  const kept = only([agent('p1', 1), reply('a1', 'p1', 1)], { keptShownIds: ['p1'] });
  assert.deepEqual([kept.fold, kept.reasons, kept.transient], [false, ['kept-shown'], false]);
});

test('a running agent turn with a user message waiting below it stays shown', () => {
  const waiting = only([agent('p1', 1), live('p1'), user('u2', 2)]);
  assert.deepEqual([waiting.fold, waiting.reasons, waiting.transient], [false, ['user-waiting'], true]);
  // Answered, an agent's or a relay event: nothing of the user's is waiting.
  assert.equal(only([agent('p1', 2), live('p1'), user('u0', 1), reply('a0', 'u0', 1)]).fold, true);
  assert.equal(planOf([agent('p1', 1), live('p1'), agent('p2', 2)])[0].fold, true);
  const event = agentExchangeRowOf({ id: 'e2', role: 'user', kind: RELAY_EVENT_MESSAGE_KIND, text: RELAY_EVENT_LEAD, timestamp: at(2) });
  assert.equal(only([agent('p1', 1), live('p1'), event]).fold, true);
  // Once the agent's turn has its reply, a message queued behind it is not its business.
  assert.equal(only([agent('p1', 1), reply('a1', 'p1', 2), user('u2', 2)]).fold, true);
});

test('a prompt answered on a continuation row is not folded', () => {
  const group = only([agent('p1', 1), reply('m1', 'p1', 2, { kind: 'answered-elsewhere' })]);
  assert.deepEqual([group.fold, group.reasons], [false, ['answered-elsewhere']]);
});

test('relay events and replies without their prompt are left alone', () => {
  const event = agentExchangeRowOf({ id: 'e1', role: 'user', kind: RELAY_EVENT_MESSAGE_KIND, text: RELAY_EVENT_LEAD, origin: REMOTE, timestamp: at(1) });
  assert.deepEqual(planOf([event, reply('a1', 'e1', 1), reply('a2', 'p-not-loaded', 2), live('p-other')]), []);
  assert.deepEqual(planOf(null), []);
  assert.deepEqual(planOf([{ role: 'user' }, null]), []);
});
