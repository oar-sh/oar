// The hidden steer note on the Claude worker's steered pushes
// (shared/steer-note.mjs): only a push into a live turn carries it, and a
// replay that echoes the note back still attaches to its own row.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  scriptedTurn,
  initMessage,
  userReplay,
  assistantText,
  resultMessage,
  baseMessage,
  backgroundTasksMessage,
  taskNotificationMessage,
  makeApiStub,
  makeRunner,
  waitFor,
  settled,
  tick,
} from './claude-session-test-harness.mjs';
import { STEERED_MESSAGE_NOTE, withSteerNote } from '../../shared/steer-note.mjs';
import { SLASH_COMMAND_GUARD } from '../../shared/slash-command-guard.mjs';

const textOf = (content) => (Array.isArray(content)
  ? content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
  : String(content));

test('only a steered push carries the note, and its note-echoing replay attaches to its own row', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    steeredFoldGraceMs: 500,
    lifecyclePollMs: 10,
    pendingDeliveredTimeoutMs: 60_000,
  });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(assistantText('working on it'));
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'a turn is live' });

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick follow-up' } });
  await waitFor(() => turn.pushed.length === 2, { label: 'the steer was pushed' });

  // The turn-opening push is the user's text alone; the steer leads with the note.
  assert.equal(textOf(turn.pushed[0]).includes(STEERED_MESSAGE_NOTE), false);
  assert.equal(textOf(turn.pushed[1]), withSteerNote('quick follow-up'));

  turn.emit(resultMessage('first answer', 'native-1'));
  assert.equal(await first, true);

  // The real CLI echoes exactly what was pushed — note included — when it
  // opens the steer's own turn. The match strips the note and attaches.
  turn.emit(userReplay(withSteerNote('quick follow-up')));
  turn.emit(assistantText('second answer'));
  turn.emit(resultMessage('second answer', 'native-1'));

  assert.equal(await second, true);
  const secondResponse = stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2');
  assert.equal(secondResponse.body.text, 'second answer');
  assert.notEqual(secondResponse.body.absorbed, true);
  assert.equal(secondResponse.body.kind, undefined, 'its own turn, not a fold');
  turn.endInput();
  await settled(runner);
});

test('a steered "/cmd" is pushed as plain text behind the note and folds into the running turn', async () => {
  // The relay runs only /compact and /preview as commands; any other "/x" the
  // user confirmed as text steers like a message. The CLI treats a prompt
  // whose last text block starts with "/" as a slash command and would defer
  // it to a turn of its own mid-turn — the leading note is what keeps it text.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    steeredFoldGraceMs: 30,
    lifecyclePollMs: 10,
    pendingDeliveredTimeoutMs: 60_000,
  });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(assistantText('working on it'));
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'a turn is live' });

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: '/review this' } });
  await waitFor(() => turn.pushed.length === 2, { label: 'the steer was pushed' });
  const pushedText = textOf(turn.pushed[1]);
  assert.equal(pushedText, withSteerNote('/review this'));
  assert.equal(pushedText.trim().startsWith('/'), false);
  // The note alone keeps it text: no slash-command guard on top of it.
  assert.equal(pushedText.includes(SLASH_COMMAND_GUARD), false);
  const textBlocks = turn.pushed[1].filter((block) => block?.type === 'text');
  assert.equal(textBlocks.at(-1).text.trim().startsWith('/'), false, 'no text block the CLI would read as a command');

  // The CLI folds it into the running turn: one result, no replay of its own.
  turn.emit(resultMessage('reviewed as part of the first request', 'native-1'));
  assert.equal(await first, true);
  assert.equal(await second, true);
  const secondResponse = stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2');
  assert.equal(secondResponse.body.kind, 'folded');
  turn.endInput();
  await settled(runner);
});

test('a "/cmd" steered into a continuation carries the slash-command guard instead, and its echo still attaches', async () => {
  // A push into a background-task continuation gets no steer note (the running
  // work is the CLI's own), so nothing else would stop the CLI from reading
  // "/status please" as a command and deferring it to a turn of its own.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'job' }]));
  turn.emit(resultMessage('dispatched', 'native-1'));
  assert.equal(await first, true);

  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('agent-1'));
  turn.emit(userReplay('<task-notification>agent-1 completed</task-notification>'));
  turn.emit(assistantText('checking what the agent produced'));
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: '/status please' } });
  await waitFor(() => turn.pushed.length === 2, { label: 'the push into the continuation' });
  const pushedText = textOf(turn.pushed[1]);
  assert.equal(pushedText, `${SLASH_COMMAND_GUARD}/status please`);
  assert.equal(pushedText.includes(STEERED_MESSAGE_NOTE), false);

  // The CLI absorbs it into the running turn and echoes it as pushed.
  turn.emit(userReplay(pushedText));
  turn.emit(assistantText('here is the status'));
  turn.emit(resultMessage('here is the status', 'native-1'));
  assert.equal(await second, true);
  const secondResponse = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2'),
    { label: 'the absorbed message answered' },
  );
  assert.equal(secondResponse.body.text, 'here is the status');
  await tick(20);
  assert.equal(runner._getProcess().pendingDelivered.length, 0);
  turn.endInput();
  await settled(runner);
});
