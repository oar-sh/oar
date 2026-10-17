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

test('an agent prompt folds alone: its reply is no part of the fold; the user\'s own exchange is not planned', () => {
  const rows = [user('u1', 1), reply('a1', 'u1', 1), agent('p1', 2), reply('a2', 'p1', 2), user('u2', 3), reply('a3', 'u2', 3)];
  const group = only(rows);
  assert.deepEqual(Object.keys(group), ['promptId', 'prompt', 'status', 'fold']);
  assert.equal(group.promptId, 'p1');
  assert.equal(group.prompt, rows[2]);
  assert.equal(group.fold, true);
  assert.equal(group.status, 'replied');
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
  assert.equal(agentExchangeRowOf({ role: 'user' }, { id: 'u7' }).id, 'u7');
  assert.deepEqual(agentExchangeRowOf({ id: 'a1', role: 'assistant', kind: 'folded', sourceMessageId: 'p1', text: 'done' }), {
    id: 'a1', role: 'assistant', relayEvent: false, origin: null, kind: 'folded', sourceMessageId: 'p1', outcome: '',
  });
});

test('the summary names the relay, the sending session and the status', () => {
  assert.deepEqual(agentExchangeSummary(REMOTE, 'replied'), {
    from: 'win-test',
    title: 'report builder',
    status: 'replied',
    statusText: 'answered below',
    head: 'note from win-test · report builder',
    text: 'note from win-test · report builder · answered below',
  });
  // A same-relay prompt: the relay's own name from the origin, the sending
  // conversation's current title when the list knows it.
  const conversations = { 'c-lead': { id: 'c-lead', title: 'sidebar polish 2' } };
  assert.equal(agentExchangeSummary(LOCAL, 'working', { conversations }).text, 'note from linux-test · sidebar polish 2 · working…');
  assert.equal(agentExchangeSummary(LOCAL, 'working').text, 'note from linux-test · sidebar polish · working…');
  assert.equal(agentExchangeSummary({ local: true }, 'failed').text, 'note from this relay · failed');
  assert.equal(agentExchangeSummary({ relayId: 'relay-fixture-c' }, 'odd').text, 'note from relay-fixture-c · no reply yet');
  // The reply shows under the row, never inside it, and the words say so.
  assert.deepEqual({ ...AGENT_EXCHANGE_STATUS_TEXT }, {
    working: 'working…',
    replied: 'answered below',
    failed: 'failed',
    stopped: 'stopped',
    none: 'no reply yet',
  });
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

test('a running turn\'s prompt is folded as working; its live bubble is no part of the fold', () => {
  const group = only([agent('p1', 1), live('p1')]);
  assert.equal(group.fold, true);
  assert.equal(group.status, 'working');
  assert.equal('members' in group, false);
  // Running without a bubble on the page (the relay says so).
  assert.equal(only([agent('p1', 1)], { runningIds: ['p1'] }).status, 'working');
  // Neither running nor answered: queued, or never run.
  assert.equal(only([agent('p1', 1)]).status, 'none');
});

test('a working prompt shows open, a finished one folded, and the user\'s toggle wins', () => {
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

test('a user message steered into the turn does not keep the prompt from folding', () => {
  // Handed off: the reply settled absorbed, the turn went on on the user's row.
  const handoff = planOf([agent('p1', 1), reply('a1', 'p1', 1, { kind: 'absorbed' }), { ...user('u2', 1), steered: true }, reply('a2', 'u2', 2)]);
  assert.deepEqual(handoff.map((group) => [group.promptId, group.fold, group.status]), [['p1', true, 'replied']]);
  // Folded into it: the user's message has a marker, the reply answers both.
  const folded = [agent('p1', 1), reply('a1', 'p1', 3), { ...user('u2', 2), steered: true }, reply('m2', 'u2', 3, { kind: 'folded' })];
  assert.deepEqual([only(folded).fold, only(folded).status], [true, 'replied']);
  // Stopped with it: the same.
  const stopped = [agent('p1', 1), reply('a1', 'p1', 3, { text: STOP }), { ...user('u2', 2), steered: true }, reply('m2', 'u2', 3, { kind: 'stopped' })];
  assert.deepEqual([only(stopped).fold, only(stopped).status], [true, 'stopped']);
});

test('an open card or a waiting message of the user\'s does not keep the prompt from folding', () => {
  // Nothing of theirs is behind the fold, so the plan takes no word of them.
  const group = only([agent('p1', 1), live('p1'), user('u2', 2)], { openCardIds: ['p1'], keptShownIds: ['p1'] });
  assert.deepEqual([group.fold, group.status], [true, 'working']);
  assert.equal('reasons' in group, false);
  assert.equal('transient' in group, false);
});

test('an agent prompt steered into another turn is not folded', () => {
  const intoUsers = planOf([user('u1', 1), reply('a1', 'u1', 1, { kind: 'absorbed' }), { ...agent('p2', 1), steered: true }, reply('a2', 'p2', 2)]);
  assert.deepEqual(intoUsers.map((group) => [group.promptId, group.fold, group.status]), [['p2', false, 'replied']]);
  const marker = planOf([user('u1', 1), reply('a1', 'u1', 3), agent('p2', 2), reply('m2', 'p2', 3, { kind: 'folded' })]);
  assert.deepEqual(marker.map((group) => [group.promptId, group.fold]), [['p2', false]]);
  // Steered into another agent's turn: that turn's prompt folds, the steered one does not.
  const agents = planOf([agent('p1', 1), reply('a1', 'p1', 3), agent('p2', 2), reply('m2', 'p2', 3, { kind: 'folded' })]);
  assert.deepEqual(agents.map((group) => [group.promptId, group.fold]), [['p1', true], ['p2', false]]);
});

test('a prompt answered on a continuation row folds as answered', () => {
  const group = only([agent('p1', 1), reply('m1', 'p1', 2, { kind: 'answered-elsewhere' })]);
  assert.deepEqual([group.fold, group.status], [true, 'replied']);
});

test('relay events and replies without their prompt are left alone', () => {
  const event = agentExchangeRowOf({ id: 'e1', role: 'user', kind: RELAY_EVENT_MESSAGE_KIND, text: RELAY_EVENT_LEAD, origin: REMOTE, timestamp: at(1) });
  assert.deepEqual(planOf([event, reply('a1', 'e1', 1), reply('a2', 'p-not-loaded', 2), live('p-other')]), []);
  assert.deepEqual(planOf(null), []);
  assert.deepEqual(planOf([{ role: 'user' }, null]), []);
});
