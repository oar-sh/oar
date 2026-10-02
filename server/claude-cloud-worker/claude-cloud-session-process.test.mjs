// platform-agnostic: the '/api/…' literals in this file are HTTP route paths,
// which are '/'-separated on every platform.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeCloudUserContent,
  claudeCloudMessageUuid,
} from './claude-cloud-session-process.mjs';
import {
  CONVERSATION_ID,
  ENVIRONMENT_ID,
  MODEL,
  REPO_URL,
  SESSION_ID,
  SESSION_URL,
  assistantText,
  assistantThinking,
  assistantToolUse,
  branchPushed,
  cloudEvent,
  cloudSession,
  makeApi,
  makeCloud,
  makeRunner,
  relayMessage,
  sandboxLog,
  sessionInit,
  stoppedResult,
  tick,
  toolRequest,
  toolResponse,
  toolResult,
  turnResult,
  userPrompt,
  waitFor,
} from './claude-cloud-test-harness.mjs';

const noFiles = { existsSync: () => false, readFileSync: () => { throw new Error('no such file'); } };
const cloudError = (code, message = `stubbed ${code}`, extra = {}) => (
  Object.assign(new Error(message), { name: 'ClaudeCloudError', code, ...extra })
);
const boundTo = (lastSequence) => ({ claudeCloud: { sessionId: SESSION_ID, lastSequence } });
const activityTexts = (api) => api.posts('/api/activity').map((body) => body.text);

// ---------------------------------------------------------------------------
// Message content

test('the message uuid is stable per queue row and shaped like a uuid', () => {
  const uuid = claudeCloudMessageUuid('queue-message-1');

  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(claudeCloudMessageUuid('queue-message-1'), uuid);
  assert.notEqual(claudeCloudMessageUuid('queue-message-2'), uuid);
});

test('plain text is sent as a string; an image rides inline after the text', () => {
  const plain = buildClaudeCloudUserContent({ text: ' Add a licence file ' }, { fsImpl: noFiles });
  const withImage = buildClaudeCloudUserContent({
    text: 'What is on this screenshot?',
    attachments: [{ name: 'shot.png', type: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }],
  }, { fsImpl: noFiles });

  assert.deepEqual(plain, { content: 'Add a licence file', refused: [] });
  assert.deepEqual(withImage.refused, []);
  assert.deepEqual(withImage.content, [
    { type: 'text', text: 'What is on this screenshot?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ]);
});

test('a file that is no embeddable image is refused by name, with no path fallback', () => {
  const { content, refused } = buildClaudeCloudUserContent({
    text: 'Read these',
    attachments: [
      { name: 'shot.png', type: 'image/png', dataUrl: 'data:image/png;base64,AAAA' },
      { name: 'notes.pdf', type: 'application/pdf', path: 'uploads/notes.pdf' },
      { name: 'drawing.svg', type: 'image/svg+xml', path: 'uploads/drawing.svg' },
    ],
  }, { fsImpl: { existsSync: () => true, readFileSync: () => Buffer.from('file') } });

  assert.equal(content, null);
  assert.deepEqual(refused, ['notes.pdf', 'drawing.svg']);
});

// ---------------------------------------------------------------------------
// Create path

test('the first message creates the session, streams the turn and publishes the reply with usage', async () => {
  const api = makeApi();
  const cloud = makeCloud();
  const { runner } = makeRunner({ api, cloud });
  const message = relayMessage();

  const done = runner.handlePendingPayload({ message });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  assert.equal(runner.getActiveQueueMessageId(), 'queue-message-1');
  assert.deepEqual(runner.getActiveQueueAttempt(), { id: 'queue-message-1', attemptId: 'attempt-1' });

  stream.frame({ kind: 'session_update', id: null, data: { connection_status: 'connected' } });
  stream.emit(
    userPrompt(1, 'Add a licence file', claudeCloudMessageUuid(message.id)),
    sandboxLog(2, 'Allocating sandbox'),
    sandboxLog(3, 'Cloning repository example-org/sample-repo'),
    sessionInit(4),
    assistantThinking(5, 'The repository has no licence yet.'),
    assistantText(6, 'I will add the file.'),
    assistantToolUse(7, 'Write', { file_path: 'LICENSE' }),
    toolResult(8, 'toolu_example_7'),
    assistantText(9, 'The licence file is in place.'),
    turnResult(10, { result: 'The licence file is in place.' }),
  );
  assert.equal(await done, true);

  // Created with the delivered message, the plain model id and a uuid that
  // names the queue row.
  assert.deepEqual(cloud.callsOf('createSession').map((call) => call.args), [{
    title: 'Licence file',
    environmentId: ENVIRONMENT_ID,
    model: MODEL,
    repoUrl: REPO_URL,
    branch: 'main',
    content: 'Add a licence file',
    uuid: claudeCloudMessageUuid(message.id),
  }]);
  assert.equal(cloud.callsOf('sendUserMessage').length, 0);
  assert.deepEqual(cloud.callsOf('openEventStream').map((call) => call.lastEventId), [null]);

  // Bound right after the create, and again with the result's position.
  const reports = api.posts('/api/claude-cloud-session');
  assert.deepEqual(reports[0], {
    conversationId: CONVERSATION_ID, cloudSessionId: SESSION_ID, sessionUrl: SESSION_URL, lastSequence: '0', model: MODEL,
  });
  assert.deepEqual(reports.at(-1), {
    conversationId: CONVERSATION_ID, cloudSessionId: SESSION_ID, sessionUrl: SESSION_URL, lastSequence: '10', costUsd: 0.42, model: MODEL,
  });

  assert.deepEqual(activityTexts(api), [
    'Cloud: Allocating sandbox',
    'Cloud: Cloning repository example-org/sample-repo',
    `Claude Code running in the cloud (model ${MODEL})`,
    'Tool (Write): LICENSE',
  ]);
  assert.deepEqual(api.posts('/api/thought').map((body) => body.text), ['The repository has no licence yet.']);
  const streamed = api.posts('/api/stream');
  assert.deepEqual(streamed.map((body) => [body.text, body.done]), [
    ['I will add the file.', false],
    ['I will add the file.\n\nThe licence file is in place.', false],
    ['The licence file is in place.', true],
  ]);
  assert.ok(streamed.every((body) => body.messageId === 'queue-message-1' && body.attemptId === 'attempt-1'));

  const [response] = api.posts('/api/response');
  assert.equal(api.posts('/api/response').length, 1);
  assert.equal(response.text, 'The licence file is in place.');
  assert.equal(response.model, MODEL);
  assert.equal(response.attemptId, 'attempt-1');
  assert.equal(response.terminalError, undefined);

  // One session read after the reply feeds both usage routes.
  assert.equal(cloud.callsOf('getSession').length, 1);
  const [contextUsage] = api.posts('/api/claude-context-usage');
  assert.equal(contextUsage.conversationId, CONVERSATION_ID);
  assert.equal(contextUsage.contextUsage.totalTokens, 60_000);
  assert.equal(contextUsage.contextUsage.maxTokens, 1_000_000);
  assert.deepEqual(Object.keys(contextUsage.modelUsage), [MODEL]);
  const [planUsage] = api.posts('/api/claude-plan-usage');
  assert.equal(planUsage.conversationId, CONVERSATION_ID);
  assert.equal(planUsage.usage, null);
  assert.equal(planUsage.totalCostUsd, 0.05);
  assert.deepEqual(Object.keys(planUsage.modelUsage), [MODEL]);
  const order = api.calls.map((call) => call.routePath);
  assert.ok(order.indexOf('/api/response') < order.indexOf('/api/claude-context-usage'));

  assert.equal(runner.isTurnActive(), false);
  assert.equal(runner.getActiveQueueMessageId(), '');
  await runner.dispose();
});

test('a create the cloud refuses for a known reason becomes a reply that says what to do', async () => {
  const expectations = {
    login_expired: /Log in again on Settings → Providers → Claude,/,
    login_missing: /Log in on Settings → Providers → Claude,/,
    github_not_connected: /https:\/\/claude\.ai\/connect-github/,
    repo_access_denied: /Claude GitHub app's repository access/,
    environment_missing: /Settings → Providers → Claude Cloud/,
  };
  for (const [code, guidance] of Object.entries(expectations)) {
    const api = makeApi();
    const cloud = makeCloud({ failures: { createSession: cloudError(code, 'what the client said', { detail: 'what the API said' }) } });
    const { runner } = makeRunner({ api, cloud });

    assert.equal(await runner.handlePendingPayload({ message: relayMessage() }), true, code);

    const [response] = api.posts('/api/response');
    assert.match(response.text, /^System note: /, code);
    assert.match(response.text, guidance, code);
    assert.equal(response.terminalError.kind, 'claude-cloud-turn-failed', code);
    assert.equal(response.terminalError.code, code);
    assert.equal(response.terminalError.stableCode, `claude-cloud.${code}`);
    assert.match(response.terminalError.guidance, guidance, code);
    assert.equal(response.terminalError.detail, 'what the API said', code);
    assert.equal(api.posts('/api/requeue').length, 0, code);
    assert.equal(cloud.callsOf('openEventStream').length, 0, code);
    assert.equal(runner.isTurnActive(), false, code);
  }
});

test('a rate limit names the wait; an unknown failure is reported as it is', async () => {
  const limited = makeApi();
  const limitedRunner = makeRunner({
    api: limited,
    cloud: makeCloud({ failures: { createSession: cloudError('rate_limited', 'slow down', { retryAfterMs: 41_500 }) } }),
  }).runner;
  await limitedRunner.handlePendingPayload({ message: relayMessage() });
  assert.match(limited.posts('/api/response')[0].text, /Wait about 42 s, then send the message again\./);

  const unknown = makeApi();
  const unknownRunner = makeRunner({
    api: unknown,
    cloud: makeCloud({ failures: { createSession: cloudError('bad_request', 'Claude Cloud refused the request (HTTP 400).') } }),
  }).runner;
  await unknownRunner.handlePendingPayload({ message: relayMessage() });
  const [response] = unknown.posts('/api/response');
  assert.match(response.text, /the Claude Cloud turn failed \(Claude Cloud refused the request \(HTTP 400\)\.\)/);
  assert.equal(response.terminalError.code, 'turn-error');
});

test('a transient failure requeues the row instead of answering it', async () => {
  const api = makeApi();
  const cloud = makeCloud({ failures: { createSession: cloudError('transient') } });
  const { runner } = makeRunner({ api, cloud });

  assert.equal(await runner.handlePendingPayload({ message: relayMessage() }), true);

  assert.deepEqual(api.posts('/api/requeue'), [{ messageId: 'queue-message-1', attemptId: 'attempt-1' }]);
  assert.equal(api.posts('/api/response').length, 0);
});

test('a non-image attachment refuses the turn before anything reaches the cloud', async () => {
  const api = makeApi();
  const cloud = makeCloud();
  const { runner } = makeRunner({ api, cloud, fsImpl: { existsSync: () => true, readFileSync: () => Buffer.from('file') } });
  const message = relayMessage({ attachments: [{ name: 'notes.pdf', type: 'application/pdf', path: 'uploads/notes.pdf' }] });

  assert.equal(await runner.handlePendingPayload({ message }), true);

  assert.deepEqual(cloud.calls, []);
  const [response] = api.posts('/api/response');
  assert.match(response.text, /Claude Cloud takes images only/);
  assert.match(response.text, /Not sent: "notes\.pdf"\./);
  assert.equal(response.terminalError.code, 'attachment-unsupported');
  assert.equal(api.posts('/api/claude-cloud-session').length, 0);
});

// ---------------------------------------------------------------------------
// Send path and turn pairing

test('a follow-up is sent into the bound session and paired with the result after its own sequence', async () => {
  const api = makeApi();
  const cloud = makeCloud({ sendSequences: [12, 16] });
  const { runner } = makeRunner({ api, cloud });
  const first = relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Now add a changelog', ...boundTo('9') });

  const done = runner.handlePendingPayload({ message: first });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');

  // A restarted worker reads the log on from the stored position first, then
  // sends, then follows the stream from the same position.
  assert.deepEqual(cloud.callsOf('listEvents').map((call) => call.options), [{ cursor: '9', sortOrder: 'asc' }]);
  assert.deepEqual(cloud.callsOf('sendUserMessage').map((call) => [call.id, call.content, call.options]), [
    [SESSION_ID, 'Now add a changelog', { uuid: claudeCloudMessageUuid('queue-message-2') }],
  ]);
  assert.equal(cloud.callsOf('createSession').length, 0);
  assert.deepEqual(cloud.callsOf('openEventStream').map((call) => call.lastEventId), ['9']);

  stream.emit(
    // Replayed, and a turn somebody ran from another client: neither is this turn.
    assistantText(8, 'An answer from an earlier turn.'),
    assistantText(10, 'Text of a turn run elsewhere.'),
    turnResult(11, { result: 'Result of a turn run elsewhere.' }),
    userPrompt(12, 'Now add a changelog', claudeCloudMessageUuid('queue-message-2')),
    sessionInit(13),
    assistantText(14, 'The changelog is written.'),
  );
  await waitFor(() => api.posts('/api/stream').length === 1, 'stream published');
  assert.equal(api.posts('/api/response').length, 0);

  // No `result` string: the reply is the accumulated text.
  const withoutText = turnResult(15);
  stream.emit(withoutText);
  assert.equal(await done, true);

  assert.deepEqual(api.posts('/api/stream').map((body) => body.text), ['The changelog is written.', 'The changelog is written.']);
  assert.equal(api.posts('/api/response')[0].text, 'The changelog is written.');
  assert.equal(api.posts('/api/claude-cloud-session').at(-1).lastSequence, '15');

  // The same worker again: no catch-up, no second stream.
  const second = relayMessage({ id: 'queue-message-3', attemptId: 'attempt-3', text: 'Thanks', ...boundTo('15') });
  const doneSecond = runner.handlePendingPayload({ message: second });
  await waitFor(() => cloud.callsOf('sendUserMessage').length === 2, 'second message sent');
  stream.emit(sessionInit(17), turnResult(18, { result: 'You are welcome.' }));
  assert.equal(await doneSecond, true);

  assert.equal(cloud.callsOf('listEvents').length, 1);
  assert.equal(cloud.callsOf('openEventStream').length, 1);
  assert.deepEqual(api.posts('/api/response').map((body) => [body.messageId, body.text]), [
    ['queue-message-2', 'The changelog is written.'],
    ['queue-message-3', 'You are welcome.'],
  ]);
  await runner.dispose();
});

test('a message the cloud already holds is not a new turn: its turn is replayed from where it started', async () => {
  const api = makeApi();
  // The cloud recognises the uuid and names the place the message has had all along.
  const cloud = makeCloud({ sendSequences: [6] });
  const { runner } = makeRunner({ api, cloud });

  const first = runner.handlePendingPayload({ message: relayMessage() });
  await waitFor(() => cloud.streams.length === 1, 'stream opened');
  cloud.streams[0].emit(
    turnResult(5, { result: 'Done.' }),
    userPrompt(6, 'Now add a changelog'),
    assistantText(7, 'The changelog is written.'),
    turnResult(8, { result: 'The changelog is written.' }),
  );
  await first;

  const again = runner.handlePendingPayload({
    message: relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Now add a changelog', ...boundTo('5') }),
  });
  await waitFor(() => cloud.streams.length === 2, 'stream reopened');
  assert.equal(cloud.streams[0].aborted, true);
  assert.equal(cloud.callsOf('openEventStream').at(-1).lastEventId, '6');
  cloud.streams[1].emit(assistantText(7, 'The changelog is written.'), turnResult(8, { result: 'The changelog is written.' }));
  assert.equal(await again, true);

  assert.deepEqual(api.posts('/api/response').map((body) => [body.messageId, body.text]), [
    ['queue-message-1', 'Done.'],
    ['queue-message-2', 'The changelog is written.'],
  ]);
  // The stored position never moves back.
  assert.equal(api.posts('/api/claude-cloud-session').at(-1).lastSequence, '8');
  await runner.dispose();
});

test('a delivery while a turn runs is not accepted', async () => {
  const api = makeApi();
  const cloud = makeCloud();
  const { runner } = makeRunner({ api, cloud });

  const done = runner.handlePendingPayload({ message: relayMessage() });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  const refused = await runner.handlePendingPayload({ message: relayMessage({ id: 'queue-message-2' }) });

  assert.equal(refused, false);
  assert.equal(await runner.handlePendingPayload({ message: {} }), false);
  assert.equal(runner.getActiveQueueMessageId(), 'queue-message-1');
  assert.equal(cloud.callsOf('createSession').length, 1);
  assert.equal(cloud.callsOf('sendUserMessage').length, 0);

  stream.emit(turnResult(5, { result: 'Done.' }));
  assert.equal(await done, true);
  await runner.dispose();
});

test('a failed turn carries a terminal error; a turn stopped from another client is answered plainly', async () => {
  const api = makeApi();
  const cloud = makeCloud({ sendSequences: [12] });
  const { runner } = makeRunner({ api, cloud });

  const failing = runner.handlePendingPayload({ message: relayMessage() });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  stream.emit(
    assistantText(4, 'Working on it.'),
    turnResult(5, { subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', errors: ['Too many turns.'] }),
  );
  await failing;

  const [failed] = api.posts('/api/response');
  assert.equal(failed.text, 'Too many turns.');
  assert.equal(failed.terminalError.kind, 'claude-cloud-turn-failed');
  assert.equal(failed.terminalError.code, 'error_max_turns');

  const stopped = runner.handlePendingPayload({ message: relayMessage({ id: 'queue-message-2', ...boundTo('5') }) });
  await waitFor(() => cloud.callsOf('sendUserMessage').length === 1, 'message sent');
  stream.emit(assistantText(13, 'Half an answer.'), stoppedResult(14));
  await stopped;

  const answered = api.posts('/api/response')[1];
  assert.equal(answered.text, 'Half an answer.');
  assert.equal(answered.terminalError, undefined);
  assert.equal(cloud.callsOf('sendInterrupt').length, 0);
  await runner.dispose();
});

// ---------------------------------------------------------------------------
// Questions and permission prompts

test('AskUserQuestion becomes relay question cards and the answers go back keyed by question text', async () => {
  const answers = { 'question-1': 'Blue', 'question-2': 'Unit tests, Docs' };
  const api = makeApi({
    '/api/relay-question': (body, attempt) => ({ question: { id: `question-${attempt + 1}` } }),
    '/api/relay-question/question-1': { question: { status: 'answered', answer: answers['question-1'] } },
    '/api/relay-question/question-2': { question: { status: 'answered', answer: answers['question-2'] } },
  });
  const cloud = makeCloud();
  const { runner } = makeRunner({ api, cloud });
  const input = {
    questions: [
      {
        question: 'Which colour do you want?',
        header: 'Colour',
        multiSelect: false,
        options: [{ label: 'Blue', description: 'Calm' }, { label: 'Green', description: 'Fresh' }],
      },
      {
        question: 'Which checks should run?',
        header: 'Checks',
        multiSelect: true,
        options: [{ label: 'Unit tests' }, { label: 'Docs' }, { label: 'Lint' }],
      },
    ],
  };

  const done = runner.handlePendingPayload({ message: relayMessage() });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  stream.emit(
    // The session's own first request comes from the client side: no card.
    cloudEvent(1, {
      type: 'control_request', request_id: 'request-0', request: { subtype: 'set_permission_mode', mode: 'auto' },
    }, 'client'),
    assistantToolUse(4, 'AskUserQuestion', input),
    toolRequest(5, { requestId: 'request-1', toolName: 'AskUserQuestion', input }),
  );
  await waitFor(() => cloud.callsOf('sendControlResponse').length === 1, 'control response sent');

  const cards = api.posts('/api/relay-question');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].prompt, 'Which colour do you want?\n\n- Blue: Calm\n- Green: Fresh');
  assert.deepEqual(cards[0].choices, ['Blue', 'Green']);
  assert.equal(cards[0].messageId, 'queue-message-1');
  assert.equal(cards[0].attemptId, 'attempt-1');
  assert.equal(cards[0].context.source, 'AskUserQuestion');
  assert.equal(cards[0].context.header, 'Colour');
  assert.equal(cards[0].context.multiSelect, undefined);
  assert.deepEqual(cards[1].choices, ['Unit tests', 'Docs', 'Lint']);
  assert.equal(cards[1].context.multiSelect, true);

  assert.deepEqual(cloud.callsOf('sendControlResponse')[0], {
    op: 'sendControlResponse',
    id: SESSION_ID,
    args: {
      requestId: 'request-1',
      response: {
        behavior: 'allow',
        updatedInput: {
          ...input,
          answers: { 'Which colour do you want?': 'Blue', 'Which checks should run?': 'Unit tests, Docs' },
        },
      },
    },
  });

  // The cloud echoes the answer and carries on.
  stream.emit(toolResponse(6, 'request-1'), assistantText(7, 'Blue it is.'), turnResult(8, { result: 'Blue it is.' }));
  assert.equal(await done, true);
  assert.equal(cloud.callsOf('sendControlResponse').length, 1);
  assert.equal(api.posts('/api/response')[0].text, 'Blue it is.');
  await runner.dispose();
});

test('a question nobody answers is denied', async () => {
  const api = makeApi({
    '/api/relay-question': { question: { id: 'question-1' } },
    '/api/relay-question/question-1': { question: { status: 'timed_out' } },
  });
  const cloud = makeCloud();
  const { runner } = makeRunner({ api, cloud });
  const input = { questions: [{ question: 'Which colour do you want?', options: [{ label: 'Blue' }, { label: 'Green' }] }] };

  const done = runner.handlePendingPayload({ message: relayMessage() });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  stream.emit(toolRequest(5, { requestId: 'request-1', toolName: 'AskUserQuestion', input }));
  await waitFor(() => cloud.callsOf('sendControlResponse').length === 1, 'control response sent');

  const { requestId, response } = cloud.callsOf('sendControlResponse')[0].args;
  assert.equal(requestId, 'request-1');
  assert.equal(response.behavior, 'deny');
  assert.match(response.message, /did not answer/);
  assert.equal(response.updatedInput, undefined);

  stream.emit(turnResult(8, { result: 'Going with the default.' }));
  await done;
  await runner.dispose();
});

test('another tool asking for permission becomes an Allow/Deny card', async () => {
  const api = makeApi({
    '/api/relay-question': (body, attempt) => ({ question: { id: `question-${attempt + 1}` } }),
    '/api/relay-question/question-1': { question: { status: 'answered', answer: 'Allow' } },
    '/api/relay-question/question-2': { question: { status: 'answered', answer: 'Deny' } },
  });
  const cloud = makeCloud();
  const { runner } = makeRunner({ api, cloud });
  const input = { command: 'git push origin feature/licence' };

  const done = runner.handlePendingPayload({ message: relayMessage() });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  stream.emit(toolRequest(5, { requestId: 'request-1', toolName: 'Bash', input }));
  await waitFor(() => cloud.callsOf('sendControlResponse').length === 1, 'first decision sent');
  stream.emit(toolRequest(6, { requestId: 'request-2', toolName: 'Bash', input }));
  await waitFor(() => cloud.callsOf('sendControlResponse').length === 2, 'second decision sent');

  const [card] = api.posts('/api/relay-question');
  assert.equal(card.prompt, 'Claude Cloud asks for permission to use Bash.\n\ngit push origin feature/licence');
  assert.deepEqual(card.choices, ['Allow', 'Deny']);
  assert.equal(card.allowFreeform, false);
  assert.equal(card.context.source, 'ClaudeCloudPermission');
  assert.deepEqual(cloud.callsOf('sendControlResponse').map((call) => call.args), [
    { requestId: 'request-1', response: { behavior: 'allow', updatedInput: input } },
    { requestId: 'request-2', response: { behavior: 'deny', message: 'The user denied this tool use.' } },
  ]);

  stream.emit(turnResult(9, { result: 'Pushed.' }));
  await done;
  await runner.dispose();
});

test('a card answered from another client is closed here without a second answer', async () => {
  let polls = 0;
  const api = makeApi({
    '/api/relay-question': { question: { id: 'question-1' } },
    '/api/relay-question/question-1': () => {
      polls += 1;
      return { question: { status: 'pending' } };
    },
  });
  const cloud = makeCloud();
  const { runner } = makeRunner({ api, cloud });
  const input = { questions: [{ question: 'Which colour do you want?', options: [{ label: 'Blue' }, { label: 'Green' }] }] };

  const done = runner.handlePendingPayload({ message: relayMessage() });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  stream.emit(toolRequest(5, { requestId: 'request-1', toolName: 'AskUserQuestion', input }));
  await waitFor(() => polls > 0, 'card polled');
  stream.emit(toolResponse(6, 'request-1'));
  await waitFor(() => api.posts('/api/relay-question/question-1/timeout').length === 1, 'card closed');
  stream.emit(turnResult(7, { result: 'Blue it is.' }));
  await done;

  assert.equal(cloud.callsOf('sendControlResponse').length, 0);
  await runner.dispose();
});

// ---------------------------------------------------------------------------
// Push

test('a push is shown and reported without moving the stored position', async () => {
  const api = makeApi();
  const cloud = makeCloud();
  const { runner } = makeRunner({ api, cloud });

  const done = runner.handlePendingPayload({ message: relayMessage() });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  stream.emit(branchPushed(6, 'feature/licence'));
  await waitFor(() => api.posts('/api/claude-cloud-session').length === 2, 'push reported');

  assert.deepEqual(api.posts('/api/claude-cloud-session')[1], {
    conversationId: CONVERSATION_ID,
    cloudSessionId: SESSION_ID,
    sessionUrl: SESSION_URL,
    // Still the turn's start: a restarted worker must find the message again.
    lastSequence: '0',
    pushedBranch: 'feature/licence',
  });
  assert.deepEqual(activityTexts(api), ['Cloud: pushed branch feature/licence']);

  stream.emit(turnResult(7, { result: 'Pushed feature/licence.' }));
  await done;
  await runner.dispose();
});

// ---------------------------------------------------------------------------
// Stop

test('Stop interrupts the cloud turn; its result ends the turn without a response', async () => {
  const api = makeApi();
  const cloud = makeCloud();
  const { runner, timers, control } = makeRunner({ api, cloud });

  const done = runner.handlePendingPayload({ message: relayMessage() });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  assert.equal(control.registrations[0].queueMessageId, 'queue-message-1');
  stream.emit(assistantText(4, 'Starting the long job.'), assistantToolUse(5, 'Bash', { command: 'sleep 600' }));
  await waitFor(() => api.posts('/api/stream').length === 1, 'text streamed');

  await control.abort();
  assert.deepEqual(cloud.callsOf('sendInterrupt'), [{ op: 'sendInterrupt', id: SESSION_ID }]);
  assert.equal(timers.pending(30_000).length, 1);

  stream.emit(toolResult(6, 'toolu_example_5', { isError: true, content: 'Interrupted.' }), stoppedResult(7));
  assert.equal(await done, true);

  // What streamed is closed off; the relay's abort control owns the row.
  assert.deepEqual(api.posts('/api/stream').at(-1), {
    messageId: 'queue-message-1',
    conversationId: CONVERSATION_ID,
    mode: 'agent',
    text: 'Starting the long job.',
    done: true,
    attemptId: 'attempt-1',
  });
  assert.equal(api.posts('/api/response').length, 0);
  assert.equal(api.posts('/api/requeue').length, 0);
  assert.equal(timers.pending(30_000).length, 0);
  assert.equal(control.stopped.length, 1);
  // The position still moves on, and the usage of the stopped turn is kept.
  assert.equal(api.posts('/api/claude-cloud-session').at(-1).lastSequence, '7');
  assert.equal(api.posts('/api/claude-plan-usage').length, 1);
  await runner.dispose();
});

test('Stop closes an open question card and tells the cloud it was not answered', async () => {
  const api = makeApi({
    '/api/relay-question': { question: { id: 'question-1' } },
    '/api/relay-question/question-1': { question: { status: 'pending' } },
  });
  const cloud = makeCloud();
  const { runner, control } = makeRunner({ api, cloud });
  const input = { questions: [{ question: 'Which colour do you want?', options: [{ label: 'Blue' }, { label: 'Green' }] }] };

  const done = runner.handlePendingPayload({ message: relayMessage() });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  stream.emit(toolRequest(5, { requestId: 'request-1', toolName: 'AskUserQuestion', input }));
  await waitFor(() => api.posts('/api/relay-question').length === 1, 'card opened');

  await control.abort();
  await waitFor(() => cloud.callsOf('sendControlResponse').length === 1, 'denial sent');
  assert.equal(cloud.callsOf('sendControlResponse')[0].args.response.behavior, 'deny');
  assert.equal(api.posts('/api/relay-question/question-1/timeout').length, 1);
  assert.equal(cloud.callsOf('sendInterrupt').length, 1);

  stream.emit(stoppedResult(7));
  await done;
  await runner.dispose();
});

test('no result within 30 s of a Stop ends the turn here, and the late result is not taken for the next turn\'s', async () => {
  const api = makeApi();
  const cloud = makeCloud({ sendSequences: [20], session: cloudSession({ workerStatus: 'running' }) });
  const { runner, timers, control } = makeRunner({ api, cloud });

  const done = runner.handlePendingPayload({ message: relayMessage() });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  stream.emit(assistantText(4, 'Starting the long job.'));
  await waitFor(() => api.posts('/api/stream').length === 1, 'text streamed');
  await control.abort();
  assert.equal(timers.fire(30_000), 1);
  assert.equal(await done, true);

  assert.equal(
    activityTexts(api).at(-1),
    'Cloud: no confirmation of the stop within 30 s. The turn ends here; '
      + `the cloud agent may still be working (${SESSION_URL}).`,
  );
  assert.deepEqual(api.posts('/api/stream').at(-1).done, true);
  assert.equal(api.posts('/api/response').length, 0);

  // The next message: the cloud still works on the stopped turn, whose output
  // and result come first.
  const next = runner.handlePendingPayload({
    message: relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Next task', ...boundTo('0') }),
  });
  await waitFor(() => cloud.callsOf('sendUserMessage').length === 1, 'next message sent');
  stream.emit(
    assistantText(21, 'Late words of the stopped turn.'),
    stoppedResult(22),
    sessionInit(23),
    assistantText(24, 'The next task is done.'),
    turnResult(25, { result: 'The next task is done.' }),
  );
  assert.equal(await next, true);

  const nextStreams = api.posts('/api/stream').filter((body) => body.messageId === 'queue-message-2');
  assert.deepEqual(nextStreams.map((body) => body.text), ['The next task is done.', 'The next task is done.']);
  assert.deepEqual(api.posts('/api/response').map((body) => [body.messageId, body.text]), [
    ['queue-message-2', 'The next task is done.'],
  ]);
  assert.equal(api.posts('/api/claude-cloud-session').at(-1).lastSequence, '25');
  await runner.dispose();
});

test('a stopped turn the cloud has already dropped does not swallow the next result', async () => {
  const api = makeApi();
  const cloud = makeCloud({ sendSequences: [20], session: cloudSession({ workerStatus: 'idle' }) });
  const { runner, timers, control } = makeRunner({ api, cloud });

  const done = runner.handlePendingPayload({ message: relayMessage() });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  await control.abort();
  timers.fire(30_000);
  await done;

  const next = runner.handlePendingPayload({
    message: relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Next task', ...boundTo('0') }),
  });
  await waitFor(() => cloud.callsOf('sendUserMessage').length === 1, 'next message sent');
  stream.emit(turnResult(21, { result: 'The next task is done.' }));
  assert.equal(await next, true);

  assert.equal(api.posts('/api/response')[0].text, 'The next task is done.');
  await runner.dispose();
});

// ---------------------------------------------------------------------------
// Stream drops, give-up, restart

test('a stream that drops mid-turn is reopened after the last event, with a growing pause', async () => {
  const api = makeApi();
  const cloud = makeCloud();
  const { runner, sleeps } = makeRunner({ api, cloud });

  const done = runner.handlePendingPayload({ message: relayMessage() });
  await waitFor(() => cloud.streams.length === 1, 'stream opened');
  cloud.streams[0].emit(sessionInit(4), assistantText(5, 'First half.'));
  await waitFor(() => api.posts('/api/stream').length === 1, 'text streamed');

  // The stream breaks off, and the first reconnect cannot open it.
  cloud.openErrors.push(cloudError('transient'));
  cloud.streams[0].drop('error');
  await waitFor(() => cloud.streams.length === 2, 'stream reopened');
  assert.deepEqual(cloud.callsOf('openEventStream').map((call) => call.lastEventId), [null, '5', '5']);
  assert.deepEqual(sleeps, [1000, 2000]);

  // An event the first stream already delivered is not published twice.
  cloud.streams[1].emit(assistantText(5, 'First half.'), assistantText(6, 'Second half.'), turnResult(7, { result: 'Second half.' }));
  assert.equal(await done, true);

  assert.deepEqual(api.posts('/api/stream').map((body) => body.text), [
    'First half.',
    'First half.\n\nSecond half.',
    'Second half.',
  ]);
  assert.equal(api.posts('/api/response').length, 1);
  assert.equal(api.posts('/api/requeue').length, 0);
  assert.ok(cloud.callsOf('openEventStream').every((call) => call.idleTimeoutMs === 120_000));
  await runner.dispose();
});

test('a stream that stays away for five minutes requeues the row; delivered again it is followed, not sent twice', async () => {
  const api = makeApi();
  const cloud = makeCloud({ sendSequences: [10] });
  let clock = 1_000_000;
  const sleeps = [];
  const { runner } = makeRunner({
    api,
    cloud,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += 100_000;
      await tick();
    },
  });
  const message = relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Now add a changelog', ...boundTo('9') });

  const done = runner.handlePendingPayload({ message });
  await waitFor(() => cloud.streams.length === 1, 'stream opened');
  cloud.streams[0].emit(userPrompt(10, 'Now add a changelog'), assistantText(11, 'Writing the changelog.'));
  await waitFor(() => api.posts('/api/stream').length === 1, 'text streamed');
  for (let i = 0; i < 10; i += 1) cloud.openErrors.push(cloudError('transient'));
  cloud.streams[0].drop('error');
  assert.equal(await done, true);

  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  assert.deepEqual(api.posts('/api/requeue'), [{ messageId: 'queue-message-2', attemptId: 'attempt-2' }]);
  assert.equal(api.posts('/api/response').length, 0);
  assert.match(activityTexts(api).at(-1), /connection to the cloud session stayed away/);

  // The relay delivers the row again under a new attempt.
  cloud.openErrors.length = 0;
  const again = runner.handlePendingPayload({ message: { ...message, attemptId: 'attempt-3' } });
  await waitFor(() => cloud.streams.length === 2, 'stream reopened');
  assert.equal(cloud.callsOf('sendUserMessage').length, 1);
  assert.equal(cloud.callsOf('openEventStream').at(-1).lastEventId, '10');

  cloud.streams[1].emit(
    assistantText(11, 'Writing the changelog.'),
    assistantText(12, 'The changelog is written.'),
    turnResult(13, { result: 'The changelog is written.' }),
  );
  assert.equal(await again, true);

  const [response] = api.posts('/api/response');
  assert.equal(response.text, 'The changelog is written.');
  assert.equal(response.attemptId, 'attempt-3');
  const replayed = api.posts('/api/stream').filter((body) => body.attemptId === 'attempt-3');
  assert.deepEqual(replayed.map((body) => body.text), [
    'Writing the changelog.',
    'Writing the changelog.\n\nThe changelog is written.',
    'The changelog is written.',
  ]);
  await runner.dispose();
});

test('a login that runs out mid-turn ends the turn with the note instead of reconnecting forever', async () => {
  const api = makeApi();
  const cloud = makeCloud();
  const { runner, sleeps } = makeRunner({ api, cloud });

  const done = runner.handlePendingPayload({ message: relayMessage() });
  await waitFor(() => cloud.streams.length === 1, 'stream opened');
  cloud.openErrors.push(cloudError('login_expired'));
  cloud.streams[0].drop('ended');
  assert.equal(await done, true);

  assert.deepEqual(sleeps, [1000]);
  const [response] = api.posts('/api/response');
  assert.equal(response.terminalError.code, 'login_expired');
  assert.match(response.text, /Log in again on Settings → Providers → Claude,/);
  assert.equal(api.posts('/api/requeue').length, 0);
});

test('after a worker restart the delivered turn is found in the event log and followed, not sent again', async () => {
  const api = makeApi({ '/api/relay-question': { question: { id: 'question-1' } } });
  const message = relayMessage({ id: 'queue-message-2', attemptId: 'attempt-9', text: 'Now add a changelog', ...boundTo('9') });
  const cloud = makeCloud({
    listPages: [
      {
        events: [
          userPrompt(10, 'Now add a changelog', claudeCloudMessageUuid(message.id)),
          sessionInit(11),
          assistantText(12, 'Writing the changelog.'),
          // Asked and answered while the previous worker was alive: no card.
          toolRequest(13, { requestId: 'request-1', toolName: 'Bash', input: { command: 'git status' } }),
          toolResponse(14, 'request-1'),
        ],
        nextCursor: '14',
      },
      { events: [assistantText(15, 'Almost there.')], nextCursor: null },
    ],
  });
  const { runner } = makeRunner({ api, cloud });

  const done = runner.handlePendingPayload({ message });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');

  assert.deepEqual(cloud.callsOf('listEvents').map((call) => call.options.cursor), ['9', '14']);
  assert.equal(cloud.callsOf('sendUserMessage').length, 0);
  assert.equal(cloud.callsOf('createSession').length, 0);
  assert.deepEqual(cloud.callsOf('openEventStream').map((call) => call.lastEventId), ['15']);
  assert.equal(api.posts('/api/relay-question').length, 0);
  assert.deepEqual(api.posts('/api/stream').map((body) => [body.text, body.attemptId]), [
    ['Writing the changelog.', 'attempt-9'],
    ['Writing the changelog.\n\nAlmost there.', 'attempt-9'],
  ]);

  stream.emit(turnResult(16, { result: 'The changelog is written.' }));
  assert.equal(await done, true);

  assert.equal(api.posts('/api/response')[0].text, 'The changelog is written.');
  assert.deepEqual(api.posts('/api/claude-cloud-session').at(-1), {
    conversationId: CONVERSATION_ID, cloudSessionId: SESSION_ID, sessionUrl: SESSION_URL, lastSequence: '16', costUsd: 0.42, model: MODEL,
  });
  await runner.dispose();
});

test('a turn that finished while no worker ran is answered from the event log alone', async () => {
  const api = makeApi();
  const message = relayMessage({ id: 'queue-message-2', ...boundTo('9') });
  const cloud = makeCloud({
    listPages: [{
      events: [
        userPrompt(10, 'Add a licence file', claudeCloudMessageUuid(message.id)),
        assistantText(11, 'The licence file is in place.'),
        turnResult(12, { result: 'The licence file is in place.' }),
      ],
      nextCursor: null,
    }],
  });
  const { runner } = makeRunner({ api, cloud });

  assert.equal(await runner.handlePendingPayload({ message }), true);

  assert.equal(cloud.callsOf('sendUserMessage').length, 0);
  assert.equal(cloud.callsOf('openEventStream').length, 0);
  assert.equal(api.posts('/api/response')[0].text, 'The licence file is in place.');
  assert.equal(api.posts('/api/claude-cloud-session').at(-1).lastSequence, '12');
});

// ---------------------------------------------------------------------------
// Idle

test('ten idle minutes close the stream; the next delivery reopens it after the last event', async () => {
  const api = makeApi();
  const cloud = makeCloud({ sendSequences: [11] });
  const { runner, timers } = makeRunner({ api, cloud });

  const done = runner.handlePendingPayload({ message: relayMessage() });
  await waitFor(() => cloud.streams.length === 1, 'stream opened');
  cloud.streams[0].emit(turnResult(10, { result: 'Done.' }));
  await done;
  assert.equal(cloud.streams[0].closed, false);
  assert.equal(timers.fire(600_000), 1);
  await waitFor(() => cloud.streams[0].aborted, 'stream closed');

  const next = runner.handlePendingPayload({ message: relayMessage({ id: 'queue-message-2', ...boundTo('10') }) });
  await waitFor(() => cloud.streams.length === 2, 'stream reopened');
  assert.equal(cloud.callsOf('openEventStream').at(-1).lastEventId, '10');
  assert.equal(cloud.callsOf('listEvents').length, 0);
  cloud.streams[1].emit(turnResult(12, { result: 'Done again.' }));
  assert.equal(await next, true);

  // A delivery cancels the timer of the turn before it.
  assert.equal(timers.pending(600_000).length, 1);
  await runner.dispose();
  assert.equal(cloud.streams[1].aborted, true);
});

// ---------------------------------------------------------------------------
// Model

test('the session is created with the conversation\'s current model, not the one the worker was launched with', async () => {
  const api = makeApi();
  const cloud = makeCloud();
  // The launch model is what the conversation had when the worker started; the
  // model may still be changed until the first message creates the session.
  const { runner } = makeRunner({ api, cloud, defaultModel: 'claude-sonnet-5-5[1m]' });
  const message = relayMessage({ providerModel: 'claude-opus-5[1m]', model: 'claude-opus-5[1m]' });

  const done = runner.handlePendingPayload({ message });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  stream.emit(
    userPrompt(1, 'Add a licence file', claudeCloudMessageUuid(message.id)),
    assistantText(2, 'Done.'),
    turnResult(3, { result: 'Done.' }),
  );
  await done;

  const [created] = cloud.callsOf('createSession');
  assert.equal(created.args.model, 'claude-opus-5');
});

test('without a model on the message the launch model is used', async () => {
  const api = makeApi();
  const cloud = makeCloud();
  const { runner } = makeRunner({ api, cloud, defaultModel: 'claude-sonnet-5-5[1m]' });
  const message = relayMessage({ model: '' });

  const done = runner.handlePendingPayload({ message });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  stream.emit(
    userPrompt(1, 'Add a licence file', claudeCloudMessageUuid(message.id)),
    turnResult(2, { result: 'Done.' }),
  );
  await done;

  assert.equal(cloud.callsOf('createSession')[0].args.model, 'claude-sonnet-5-5');
});

// ---------------------------------------------------------------------------
// Background work of the cloud agent

const backgroundTasks = (sequence, ...descriptions) => cloudEvent(sequence, {
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: descriptions.map((description, index) => ({ description, task_id: `task-${index + 1}`, task_type: 'local_agent' })),
});

async function startHeldTurn({ cloud = makeCloud(), runnerOptions = {}, pending = {} } = {}) {
  const api = makeApi();
  const { runner, timers } = makeRunner({ api, cloud, ...runnerOptions });
  const message = relayMessage();
  const done = runner.handlePendingPayload({ message, ...pending });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  stream.emit(
    userPrompt(1, 'Add a licence file', claudeCloudMessageUuid(message.id)),
    assistantToolUse(2, 'Agent', { description: 'Write the licence' }),
    backgroundTasks(3, 'Write the licence'),
    assistantText(4, 'The agent is still writing; I will check its work when it is done.'),
    turnResult(5, { result: 'The agent is still writing; I will check its work when it is done.' }),
  );
  await waitFor(() => activityTexts(api).some((text) => /background task/.test(text)), 'hold announced');
  return { api, cloud, runner, timers, message, done, stream };
}

test('a result while background work runs does not end the turn; the reply is the agent\'s closing turn', async () => {
  const { api, runner, done, stream } = await startHeldTurn();

  assert.equal(api.posts('/api/response').length, 0);
  assert.equal(runner.isTurnActive(), true);
  assert.ok(activityTexts(api).includes(
    'Cloud: the agent paused while 1 background task is still running; waiting for the result.',
  ));

  stream.emit(
    backgroundTasks(6),
    assistantText(7, 'The licence file is in place and pushed.'),
    turnResult(8, { result: 'The licence file is in place and pushed.' }),
  );
  await done;

  const responses = api.posts('/api/response');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].text, 'The licence file is in place and pushed.');
  // The stored position is the closing turn's result, not the interim one.
  assert.equal(api.posts('/api/claude-cloud-session').at(-1).lastSequence, '8');
});

test('background work that ends without a closing turn settles on the interim reply once the session is idle', async () => {
  const { api, cloud, timers, done, stream } = await startHeldTurn();

  stream.emit(backgroundTasks(6));
  await waitFor(() => timers.pending(45_000).length === 1, 'quiet check scheduled');
  assert.equal(timers.fire(45_000), 1);
  await done;

  assert.equal(api.posts('/api/response')[0].text, 'The agent is still writing; I will check its work when it is done.');
  assert.ok(cloud.callsOf('getSession').length >= 1);
});

test('the quiet check waits while the session is still working', async () => {
  const cloud = makeCloud({ session: cloudSession({ workerStatus: 'running' }) });
  const { api, timers, runner, stream } = await startHeldTurn({ cloud });

  stream.emit(backgroundTasks(6));
  await waitFor(() => timers.pending(45_000).length === 1, 'quiet check scheduled');
  timers.fire(45_000);
  await waitFor(() => timers.pending(45_000).length === 1 && cloud.callsOf('getSession').length === 1, 'quiet check rescheduled');

  assert.equal(api.posts('/api/response').length, 0);
  assert.equal(runner.isTurnActive(), true);
  await runner.dispose();
});

test('a held turn ends at the relay\'s background-task timeout with the interim reply and a note', async () => {
  const { api, timers, done } = await startHeldTurn({ pending: { settings: { backgroundTaskTimeoutMs: 120_000 } } });

  assert.equal(timers.fire(120_000), 1);
  await done;

  assert.equal(api.posts('/api/response')[0].text, 'The agent is still writing; I will check its work when it is done.');
  assert.ok(activityTexts(api).some((text) => /background work is still running after 2 min/.test(text)));
});

test('a failed result ends the turn even while background work runs', async () => {
  const api = makeApi();
  const cloud = makeCloud();
  const { runner } = makeRunner({ api, cloud });
  const message = relayMessage();
  const done = runner.handlePendingPayload({ message });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');

  stream.emit(
    userPrompt(1, 'Add a licence file', claudeCloudMessageUuid(message.id)),
    backgroundTasks(2, 'Write the licence'),
    turnResult(3, { subtype: 'error_max_turns', is_error: true, result: '' }),
  );
  await done;

  assert.equal(api.posts('/api/response').length, 1);
  assert.ok(api.posts('/api/response')[0].terminalError);
});

// ---------------------------------------------------------------------------
// Commit attribution

const OAR_ATTRIBUTION = Object.freeze({
  commit: 'Co-authored-by: Open Agent Relay (Claude Sonnet 5.5) <no-reply@oar.sh>',
  pr: '🤖 Generated with [Open Agent Relay](https://oar.sh)',
  sessionUrl: false,
});
const NO_ATTRIBUTION = Object.freeze({ commit: '', pr: '', sessionUrl: false });
const flagSettingsResponse = (sequence, requestId, subtype = 'success') => cloudEvent(sequence, {
  type: 'control_response',
  response: { subtype, request_id: requestId, ...(subtype === 'success' ? {} : { error: 'unknown settings key' }) },
});

/** Run one delivery to its end on the runner's only stream; `events` are emitted once the message is in the cloud. */
async function runDelivery({ runner, cloud, api }, pending, events) {
  const responses = api.posts('/api/response').length;
  const sends = cloud.callsOf('sendUserMessage').length + cloud.callsOf('createSession').length;
  const done = runner.handlePendingPayload(pending);
  await waitFor(() => cloud.streams.length === 1
    && cloud.callsOf('sendUserMessage').length + cloud.callsOf('createSession').length > sends, 'message sent');
  cloud.streams[0].emit(...events);
  assert.equal(await done, true);
  assert.equal(api.posts('/api/response').length, responses + 1);
}

test('the session is created with the delivered attribution, and a follow-up does not send it again', async () => {
  const api = makeApi();
  const cloud = makeCloud({ sendSequences: [12] });
  const { runner } = makeRunner({ api, cloud });
  const settings = { attribution: OAR_ATTRIBUTION };

  await runDelivery({ runner, cloud, api }, { message: relayMessage(), settings }, [
    flagSettingsResponse(2, 'flag-settings-request-create'),
    assistantText(3, 'Committed.'),
    turnResult(4, { result: 'Committed.' }),
  ]);
  assert.deepEqual(cloud.callsOf('createSession')[0].args.flagSettings, { attribution: OAR_ATTRIBUTION });
  // The sandbox's answer to the settings request is no reply text and no card.
  assert.deepEqual(api.posts('/api/response').map((body) => body.text), ['Committed.']);
  assert.equal(api.posts('/api/question').length, 0);

  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Again', ...boundTo('4') }),
    settings,
  }, [turnResult(13, { result: 'Committed again.' })]);
  assert.equal(cloud.callsOf('applyFlagSettings').length, 0);
  assert.deepEqual(activityTexts(api).filter((text) => /attribution/.test(text)), []);
  await runner.dispose();
});

test('vanilla attribution creates the session without a settings request; a later change is sent before the message', async () => {
  const api = makeApi();
  const cloud = makeCloud({ sendSequences: [12, 22, 32] });
  const { runner } = makeRunner({ api, cloud });

  await runDelivery({ runner, cloud, api }, { message: relayMessage(), settings: { attribution: null } }, [
    turnResult(4, { result: 'Done.' }),
  ]);
  assert.equal('flagSettings' in cloud.callsOf('createSession')[0].args, false);

  // Switched to OAR on the relay: the next message carries it in front.
  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Commit it', ...boundTo('4') }),
    settings: { attribution: OAR_ATTRIBUTION },
  }, [flagSettingsResponse(11, 'flag-settings-request-1'), turnResult(13, { result: 'Committed.' })]);
  // Switched off, then back to Claude Code's own lines: null takes the setting out.
  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-3', attemptId: 'attempt-3', text: 'And again', ...boundTo('13') }),
    settings: { attribution: NO_ATTRIBUTION },
  }, [turnResult(23, { result: 'Committed.' })]);
  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-4', attemptId: 'attempt-4', text: 'Once more', ...boundTo('23') }),
    settings: { attribution: null },
  }, [turnResult(33, { result: 'Committed.' })]);

  assert.deepEqual(cloud.callsOf('applyFlagSettings').map((call) => [call.id, call.settings]), [
    [SESSION_ID, { attribution: OAR_ATTRIBUTION }],
    [SESSION_ID, { attribution: NO_ATTRIBUTION }],
    [SESSION_ID, { attribution: null }],
  ]);
  // Each settings request went out before the message it belongs to.
  const order = cloud.calls.filter((call) => call.op === 'applyFlagSettings' || call.op === 'sendUserMessage').map((call) => call.op);
  assert.deepEqual(order, [
    'applyFlagSettings', 'sendUserMessage', 'applyFlagSettings', 'sendUserMessage', 'applyFlagSettings', 'sendUserMessage',
  ]);
  await runner.dispose();
});

test('a worker that does not know what the sandbox has sends the attribution once, vanilla included', async () => {
  for (const attribution of [OAR_ATTRIBUTION, null]) {
    const api = makeApi();
    const cloud = makeCloud({ sendSequences: [12, 16] });
    const { runner } = makeRunner({ api, cloud });
    await runDelivery({ runner, cloud, api }, {
      message: relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Commit it', ...boundTo('9') }),
      settings: { attribution },
    }, [turnResult(13, { result: 'Committed.' })]);
    await runDelivery({ runner, cloud, api }, {
      message: relayMessage({ id: 'queue-message-3', attemptId: 'attempt-3', text: 'Again', ...boundTo('13') }),
      settings: { attribution },
    }, [turnResult(17, { result: 'Committed.' })]);
    assert.deepEqual(cloud.callsOf('applyFlagSettings').map((call) => call.settings), [{ attribution }]);
    await runner.dispose();
  }
});

test('a delivery that does not name an attribution sends no settings', async () => {
  const api = makeApi();
  const cloud = makeCloud({ sendSequences: [12] });
  const { runner } = makeRunner({ api, cloud });
  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Commit it', ...boundTo('9') }),
    settings: { backgroundTaskTimeoutMs: 120_000 },
  }, [turnResult(13, { result: 'Committed.' })]);
  assert.equal(cloud.callsOf('applyFlagSettings').length, 0);
  await runner.dispose();
});

test('a settings request the API refuses costs the setting, not the turn; the next message tries again', async () => {
  const api = makeApi();
  const failures = { applyFlagSettings: cloudError('bad_request', 'Claude Cloud refused the request (HTTP 400).') };
  const cloud = makeCloud({ sendSequences: [12, 16], failures });
  const { runner } = makeRunner({ api, cloud });
  const settings = { attribution: OAR_ATTRIBUTION };

  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Commit it', ...boundTo('9') }),
    settings,
  }, [turnResult(13, { result: 'Committed.' })]);
  assert.equal(api.posts('/api/response')[0].terminalError ?? null, null);
  assert.deepEqual(activityTexts(api).filter((text) => /attribution/.test(text)), [
    'Cloud: the commit attribution setting could not be applied; commits of this turn may carry Claude Code\'s own attribution lines.',
  ]);

  delete failures.applyFlagSettings;
  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-3', attemptId: 'attempt-3', text: 'Again', ...boundTo('13') }),
    settings,
  }, [turnResult(17, { result: 'Committed.' })]);
  assert.equal(cloud.callsOf('applyFlagSettings').length, 2);
  await runner.dispose();
});

test('a settings request that cannot be sent for another reason fails the turn like the message would', async () => {
  const api = makeApi();
  const cloud = makeCloud({ sendSequences: [12], failures: { applyFlagSettings: cloudError('transient') } });
  const { runner } = makeRunner({ api, cloud });
  const message = relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Commit it', ...boundTo('9') });
  assert.equal(await runner.handlePendingPayload({ message, settings: { attribution: OAR_ATTRIBUTION } }), true);
  // Nothing went into the session without its setting; the row is delivered again.
  assert.equal(cloud.callsOf('sendUserMessage').length, 0);
  assert.equal(api.posts('/api/requeue').length, 1);
  assert.equal(api.posts('/api/response').length, 0);
  await runner.dispose();
});

test('settings the sandbox does not take are noted in the turn and sent again with the next message', async () => {
  const api = makeApi();
  const cloud = makeCloud({ sendSequences: [12, 16] });
  const { runner } = makeRunner({ api, cloud });
  const settings = { attribution: OAR_ATTRIBUTION };

  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Commit it', ...boundTo('9') }),
    settings,
  }, [flagSettingsResponse(11, 'flag-settings-request-1', 'error'), turnResult(13, { result: 'Committed.' })]);
  assert.equal(activityTexts(api).filter((text) => /attribution setting could not be applied/.test(text)).length, 1);

  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-3', attemptId: 'attempt-3', text: 'Again', ...boundTo('13') }),
    settings,
  }, [flagSettingsResponse(15, 'flag-settings-request-2'), turnResult(17, { result: 'Committed.' })]);
  assert.equal(cloud.callsOf('applyFlagSettings').length, 2);
  assert.equal(activityTexts(api).filter((text) => /attribution setting could not be applied/.test(text)).length, 1);
  await runner.dispose();
});

// ---------------------------------------------------------------------------
// Usage limit

const rateLimitEvent = (sequence, status, resetsAtMs) => cloudEvent(sequence, {
  type: 'rate_limit_event',
  session_id: SESSION_ID,
  rate_limit_info: {
    status,
    rateLimitType: 'five_hour',
    resetsAt: Math.round(resetsAtMs / 1000),
    utilization: 1,
    unifiedWindows: { five_hour: { resetsAt: Math.round(resetsAtMs / 1000), utilization: 1 } },
  },
});

test('a turn the cloud refuses at the usage limit is reported as such, so the relay pauses it', async () => {
  const api = makeApi();
  const cloud = makeCloud();
  const { runner } = makeRunner({ api, cloud });
  // Whole seconds: the event carries unix seconds.
  const resetsAt = Math.round((Date.now() + 40 * 60_000) / 1000) * 1000;

  const done = runner.handlePendingPayload({ message: relayMessage() });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  stream.emit(
    sessionInit(1),
    rateLimitEvent(2, 'allowed_warning', resetsAt),
    assistantText(3, 'Working on the licence file.'),
    rateLimitEvent(4, 'rejected', resetsAt),
    cloudEvent(5, {
      type: 'assistant',
      error: 'rate_limit',
      is_api_error_message: true,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      message: { id: 'msg_example_5', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 10pm (UTC)" }] },
    }),
    turnResult(6, { subtype: 'success', is_error: true, api_error_status: 429, terminal_reason: 'api_error', result: undefined }),
  );
  assert.equal(await done, true);

  // Both reports reached the relay (the warning and the refusal).
  const reports = api.posts('/api/claude-usage-limit');
  assert.deepEqual(reports.map((body) => [body.conversationId, body.report.status, body.report.rateLimitType]), [
    [CONVERSATION_ID, 'allowed_warning', 'five_hour'],
    [CONVERSATION_ID, 'rejected', 'five_hour'],
  ]);
  assert.equal(reports[1].report.resetsAt, new Date(resetsAt).toISOString());

  // The response names the limit as the terminal error the relay pauses on,
  // with what the turn had written kept apart from the limit line.
  const [response] = api.posts('/api/response');
  assert.equal(response.terminalError.kind, 'claude-usage-limit');
  assert.equal(response.terminalError.rateLimitType, 'five_hour');
  assert.equal(response.terminalError.resetsAt, new Date(resetsAt).toISOString());
  assert.equal(response.partialText, 'Working on the licence file.');
  await runner.dispose();
});

test('a failed turn without a rejected report is an ordinary failure', async () => {
  const api = makeApi();
  const cloud = makeCloud();
  const { runner } = makeRunner({ api, cloud });
  const done = runner.handlePendingPayload({ message: relayMessage() });
  const [stream] = await waitFor(() => cloud.streams.length && cloud.streams, 'stream opened');
  stream.emit(
    sessionInit(1),
    rateLimitEvent(2, 'allowed', Date.now() + 60_000),
    turnResult(3, { subtype: 'error_during_execution', is_error: true, result: undefined, errors: ['Something else broke.'] }),
  );
  assert.equal(await done, true);
  // The report is forwarded (the relay keeps the account's latest reading),
  // but an allowed report refuses nothing.
  assert.deepEqual(api.posts('/api/claude-usage-limit').map((body) => body.report.status), ['allowed']);
  const [response] = api.posts('/api/response');
  assert.notEqual(response.terminalError?.kind, 'claude-usage-limit');
  await runner.dispose();
});

// ---------------------------------------------------------------------------
// Model switching

test('a follow-up with another model switches the sandbox before the message; the same model again does not', async () => {
  const api = makeApi();
  const cloud = makeCloud({ sendSequences: [12, 22, 32] });
  const { runner } = makeRunner({ api, cloud });

  await runDelivery({ runner, cloud, api }, { message: relayMessage() }, [turnResult(4, { result: 'Done.' })]);
  assert.equal(cloud.callsOf('createSession')[0].args.model, MODEL);

  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Again, but on Opus', providerModel: 'claude-opus-5-5[1m]', ...boundTo('4') }),
  }, [turnResult(13, { result: 'On Opus.' })]);
  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-3', attemptId: 'attempt-3', text: 'Still Opus', providerModel: 'claude-opus-5-5', ...boundTo('13') }),
  }, [turnResult(23, { result: 'Still on Opus.' })]);
  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-4', attemptId: 'attempt-4', text: 'Back', providerModel: MODEL, ...boundTo('23') }),
  }, [turnResult(33, { result: 'Back.' })]);

  assert.deepEqual(cloud.callsOf('setModel').map((call) => [call.id, call.model]), [
    [SESSION_ID, 'claude-opus-5-5'],
    [SESSION_ID, MODEL],
  ]);
  const order = cloud.calls.filter((call) => call.op === 'setModel' || call.op === 'sendUserMessage').map((call) => call.op);
  assert.deepEqual(order, ['setModel', 'sendUserMessage', 'sendUserMessage', 'setModel', 'sendUserMessage']);
  // The reply's model follows the switch.
  assert.deepEqual(api.posts('/api/claude-cloud-session').filter((body) => body.model).map((body) => body.model).slice(-3), ['claude-opus-5-5', 'claude-opus-5-5', MODEL]);
  await runner.dispose();
});

test("a worker that does not know the sandbox's model sends it once", async () => {
  const api = makeApi();
  const cloud = makeCloud({ sendSequences: [12, 16] });
  const { runner } = makeRunner({ api, cloud });
  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Hello', ...boundTo('9') }),
  }, [turnResult(13, { result: 'Hi.' })]);
  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-3', attemptId: 'attempt-3', text: 'Again', ...boundTo('13') }),
  }, [turnResult(17, { result: 'Hi again.' })]);
  assert.deepEqual(cloud.callsOf('setModel').map((call) => call.model), [MODEL]);
  await runner.dispose();
});

test('a set_model the API refuses costs the switch, not the turn', async () => {
  const api = makeApi();
  const cloud = makeCloud({ sendSequences: [12], failures: { setModel: cloudError('bad_request', 'Claude Cloud refused the request (HTTP 400).') } });
  const { runner } = makeRunner({ api, cloud });
  await runDelivery({ runner, cloud, api }, {
    message: relayMessage({ id: 'queue-message-2', attemptId: 'attempt-2', text: 'Hello', providerModel: 'claude-opus-5-5', ...boundTo('9') }),
  }, [turnResult(13, { result: 'Hi.' })]);
  assert.equal(api.posts('/api/response')[0].terminalError ?? null, null);
  assert.ok(activityTexts(api).some((text) => /model could not be switched to claude-opus-5-5/.test(text)));
  await runner.dispose();
});
