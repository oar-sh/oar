import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUESTIONS_CLOSED_KEEP_MS,
  questionsAria,
  questionsBadge,
  questionsOfConversation,
  questionsPanelTitle,
  questionsTwinLabel,
} from './questions-view.mjs';

const NOW = Date.parse('2026-05-14T09:00:00.000Z');
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();

function ask(id, extra = {}) {
  return {
    id,
    conversationId: 'conv-heron',
    question: `Question ${id}?`,
    status: 'pending',
    urgency: 'normal',
    createdAt: minutesAgo(10),
    ...extra,
  };
}

test('pending first, the urgent ones ahead, each newest first; then the last day\'s closed ones, latest close first', () => {
  const asks = [
    ask('old', { createdAt: minutesAgo(60) }),
    ask('new', { createdAt: minutesAgo(2) }),
    ask('hot-old', { urgency: 'now', createdAt: minutesAgo(50) }),
    ask('hot-new', { urgency: 'now', createdAt: minutesAgo(5) }),
    ask('done-early', { status: 'answered', choice: 'A', answeredAt: minutesAgo(300) }),
    ask('done-late', { status: 'dismissed', answeredAt: minutesAgo(30) }),
    // Withdrawn and cancelled ones close too; they carry no answeredAt.
    ask('gone', { status: 'withdrawn', updatedAt: minutesAgo(40) }),
    ask('stopped', { status: 'cancelled', updatedAt: minutesAgo(20) }),
    ask('stale', { status: 'answered', answeredAt: new Date(NOW - QUESTIONS_CLOSED_KEEP_MS - 60_000).toISOString() }),
  ];
  const { pending, urgent, answered } = questionsOfConversation(asks, 'conv-heron', NOW);
  assert.deepEqual(pending.map((entry) => entry.id), ['hot-new', 'hot-old', 'new', 'old']);
  assert.equal(urgent, 2);
  assert.deepEqual(answered.map((entry) => entry.id), ['stopped', 'done-late', 'gone', 'done-early']);
});

test('only the conversation\'s own asks: another session\'s and a paired relay\'s mirror stay out', () => {
  const asks = [
    ask('mine'),
    ask('theirs', { conversationId: 'conv-plover' }),
    ask('mirror', { relayId: 'r-field' }),
    ask('by-session', { conversationId: undefined, session: { id: 'conv-heron' } }),
    null,
  ];
  assert.deepEqual(questionsOfConversation(asks, 'conv-heron', NOW).pending.map((entry) => entry.id).sort(), ['by-session', 'mine']);
  assert.deepEqual(questionsOfConversation(asks, '', NOW), { pending: [], urgent: 0, answered: [] });
  assert.deepEqual(questionsOfConversation(null, 'conv-heron', NOW), { pending: [], urgent: 0, answered: [] });
});

test('the badge: nothing at zero, the open count, or the urgent count marked', () => {
  assert.deepEqual(questionsBadge({ pending: 0, urgent: 0 }), { text: '', urgent: false });
  assert.deepEqual(questionsBadge({}), { text: '', urgent: false });
  assert.deepEqual(questionsBadge({ pending: 3, urgent: 0 }), { text: '3', urgent: false });
  assert.deepEqual(questionsBadge({ pending: 5, urgent: 2 }), { text: '2', urgent: true });
  assert.deepEqual(questionsBadge({ pending: 'x', urgent: -1 }), { text: '', urgent: false });
});

test('labels: tooltip, ︙ twin and panel head', () => {
  assert.equal(questionsAria({ pending: 5, urgent: 2 }), 'Questions (2 urgent of 5 open)');
  assert.equal(questionsAria({ pending: 3, urgent: 0 }), 'Questions (3 open)');
  assert.equal(questionsAria({}), 'Questions');
  assert.equal(questionsTwinLabel({ pending: 3, urgent: 1 }), '📓 Questions (1 urgent)');
  assert.equal(questionsTwinLabel({ pending: 3, urgent: 0 }), '📓 Questions (3 open)');
  assert.equal(questionsTwinLabel({}), '📓 Questions');
  assert.equal(questionsPanelTitle({ pending: 5, urgent: 2 }), '📓 Questions · 2 urgent · 5 open');
  assert.equal(questionsPanelTitle({ pending: 3, urgent: 0 }), '📓 Questions · 3 open');
  assert.equal(questionsPanelTitle({}), '📓 Questions · none open');
});
