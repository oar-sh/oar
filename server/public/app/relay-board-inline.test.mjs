import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  boardBodyShownInReply,
  boardOutcomeLine,
  boardRenderKey,
  boardsOfConversation,
  chosenActionLabel,
} from './relay-board-inline.mjs';

const actions = [
  { id: 'autopilot', label: 'Implement in autopilot' },
  { id: 'exit_only', label: 'Exit plan mode' },
];

test('a reply that already says the plan shows it once', () => {
  assert.equal(boardBodyShownInReply('1. Rename the module\n2. Update the imports', 'Here is the plan.\n\n1. Rename the module\n2.  Update the imports\n\nShall I start?'), true);
  assert.equal(boardBodyShownInReply('1. Rename the module', 'The plan is ready for review.'), false);
});

test('an empty board adds nothing to show', () => {
  assert.equal(boardBodyShownInReply('  ', 'anything'), true);
});

test('the outcome names the action as its button did', () => {
  assert.equal(boardOutcomeLine({ status: 'pending', actions }), '');
  assert.equal(boardOutcomeLine({ status: 'acted', selectedAction: 'autopilot', actions }), 'Chosen: Implement in autopilot');
  assert.equal(boardOutcomeLine({ status: 'dismissed', selectedAction: 'exit_only', actions }), 'Chosen: Exit plan mode');
  assert.equal(chosenActionLabel({ selectedAction: 'keep_planning', actions }), 'keep planning');
  assert.equal(boardOutcomeLine({ status: 'dismissed', actions }), 'Dismissed');
});

test('the boards of a conversation come oldest first, each once', () => {
  const boards = [
    { id: 'b2', conversationId: 'conv-1', createdAt: '2026-01-01T00:02:00Z' },
    { id: 'b1', conversationId: 'conv-1', createdAt: '2026-01-01T00:01:00Z' },
    { id: 'b1', conversationId: 'conv-1', createdAt: '2026-01-01T00:01:00Z' },
    { id: 'b3', conversationId: 'conv-2', createdAt: '2026-01-01T00:00:00Z' },
    null,
  ];
  assert.deepEqual(boardsOfConversation(boards, 'conv-1').map((board) => board.id), ['b1', 'b2']);
  assert.deepEqual(boardsOfConversation(boards, ''), []);
});

test('a board is redrawn when what it shows changes', () => {
  const board = { id: 'b1', status: 'pending', actions, body: 'plan' };
  const key = boardRenderKey(board);
  assert.equal(boardRenderKey({ ...board }), key);
  assert.notEqual(boardRenderKey({ ...board, status: 'acted', selectedAction: 'autopilot' }), key);
  assert.notEqual(boardRenderKey(board, { duplicate: true }), key);
});
