// End-to-end chain for the Copilot SDK worker's steering hold, over a real
// socket: the runner's gate flip → the shared runner/link bridge → a
// worker.unready / worker.ready frame from the real link → the real relay
// websocket service's readiness → (re)delivery. Only the SDK session and the
// relay's HTTP routes are stubbed. Mirrors claude-steering-hold-chain.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';

import { createSessionWorkerWebSocketService } from '../services/session-worker-websocket-service.mjs';
import { createWorkerWebSocketLink } from '../../shared/worker-runtime/worker-websocket-link.mjs';
import { createRunnerLinkBridge } from '../../shared/worker-runtime/runner-link-wiring.mjs';
import {
  baseMessage,
  createFakeCopilotClient,
  makeApiStub,
  makeFakeQuestionBridge,
  makeRunner,
  waitFor,
  tick,
} from './copilot-sdk-test-harness.mjs';

const TOKEN = 'chain-token';
const SESSION = 'conv-1';

/**
 * A relay that predates the hold protocol: its hellos advertise nothing and it
 * does not know worker.unready (the frame is dropped before the service).
 */
class OldRelayWebSocketServer extends WebSocketServer {
  handleUpgrade(req, socket, head, done) {
    super.handleUpgrade(req, socket, head, (ws) => {
      const send = ws.send.bind(ws);
      ws.send = (data, ...rest) => {
        const frame = JSON.parse(String(data));
        if (frame.type === 'server.hello') delete frame.capabilities;
        return send(JSON.stringify(frame), ...rest);
      };
      const emit = ws.emit.bind(ws);
      ws.emit = (event, raw, ...rest) => {
        if (event === 'message' && JSON.parse(String(raw)).type === 'worker.unready') return true;
        return emit(event, raw, ...rest);
      };
      done(ws);
    });
  }
}

async function startRelay({ offers, WebSocketServerImpl = WebSocketServer }) {
  const httpServer = http.createServer();
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const requested = [];
  const service = createSessionWorkerWebSocketService({
    WebSocketServerImpl,
    httpServer,
    authToken: TOKEN,
    queueCounts: () => ({ pendingCount: offers.length, processingCount: 0, parkedCount: 0 }),
    requestWork: async ({ reason }) => {
      requested.push(reason);
      const message = offers.shift();
      return message ? { message } : null;
    },
    pollIntervalMs: 250,
    logger: { debug() {}, warn() {} },
  });
  service.start();
  return {
    service,
    requested,
    url: `http://127.0.0.1:${httpServer.address().port}`,
    async stop() {
      service.stop();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

const userMessage = (messageId, delivery, content = '') => ({ type: 'user.message', data: { messageId, delivery, content } });

/**
 * Worker side wired exactly like copilot-sdk-session-worker.mjs: runner ⇄
 * bridge ⇄ real link, against the given relay. Resolves once q-1 is live.
 */
async function bootLiveTurn(t, { WebSocketServerImpl, laterSends = null } = {}) {
  const offers = [{ ...baseMessage, id: 'q-1', text: 'hello' }];
  const relay = await startRelay({ offers, WebSocketServerImpl });
  const stub = makeApiStub();
  let answer = () => {};
  const card = new Promise((resolve) => { answer = resolve; });
  const questionBridge = makeFakeQuestionBridge({ userInputAnswer: 'yes', onAsk: () => card });
  let sendIndex = 0;
  const client = createFakeCopilotClient({
    onSend: (session, _options, messageId) => {
      sendIndex += 1;
      if (sendIndex === 1) {
        session.replay([userMessage(messageId, 'idle', 'hello'), { type: 'assistant.message', data: { messageId: 'm1', content: 'one question first' } }]);
      } else if (laterSends) {
        session.replay(laterSends(messageId, sendIndex));
      } else {
        session.replay([
          userMessage(messageId, 'steering', 'also do X'),
          { type: 'assistant.message', data: { messageId: 'm2', content: 'did both' } },
          { type: 'assistant.idle', data: {} },
        ]);
      }
    },
  });
  const bridge = createRunnerLinkBridge();
  const { runner } = makeRunner({
    stub,
    client,
    questionBridge,
    onDeliveryReadinessChange: (ready) => bridge.onDeliveryReadinessChange(ready),
    canHandBackHeldDelivery: () => bridge.canHandBackHeldDelivery(),
  });
  const delivered = [];
  const link = createWorkerWebSocketLink({
    serverUrl: relay.url,
    token: TOKEN,
    getSessionReady: () => true,
    getSessionId: () => SESSION,
    getPid: () => process.pid,
    getSteeringReady: () => runner.canAcceptSteering(),
    getDeliveryHeld: () => runner.isDeliveryHeld(),
    onDeliver: async (pending) => {
      delivered.push(pending?.message?.id);
      return runner.handlePendingPayload(pending);
    },
    readyRefreshMs: 60_000,
  });
  bridge.attach(link);
  t.after(async () => {
    link.stop();
    await relay.stop();
    await runner.dispose();
  });
  link.start();
  await waitFor(() => delivered.includes('q-1'), { label: 'q-1 delivered over the socket' });
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'q-1 is live' });
  await waitFor(() => relay.service.status().readyCount === 1, { label: 'the steerable turn re-armed the relay' });
  const openCard = () => client.createAttempts[0].onUserInputRequest({ requestId: 'r1', question: 'Proceed?', choices: ['yes', 'no'] });
  return { offers, relay, stub, client, runner, bridge, delivered, openCard, answer };
}

test('a question hold withdraws relay readiness over the socket, and the answer draws the held message in', async (t) => {
  const { offers, relay, stub, client, runner, bridge, delivered, openCard, answer } = await bootLiveTurn(t);
  assert.equal(bridge.canHandBackHeldDelivery(), true, 'the relay advertised the hand-back');

  // The card opens: the runner's flip reaches the relay as worker.unready.
  const decision = openCard();
  await waitFor(() => relay.service.status().readyCount === 0, { label: 'the relay withdrew readiness' });

  // A message queued now is not delivered into the hold.
  offers.push({ ...baseMessage, id: 'q-2', text: 'also do X' });
  relay.service.emitQueueChanged('new-message');
  await tick(600);
  assert.deepEqual(delivered, ['q-1'], 'nothing delivered while the card is open');
  assert.equal(client.session.sends.length, 1);

  // The answer re-arms the relay at once and the held message steers in.
  answer();
  await decision;
  await waitFor(() => delivered.includes('q-2'), { label: 'q-2 delivered after the answer' });
  await waitFor(() => client.session.sends.length === 2, { label: 'q-2 pushed' });
  assert.equal(client.session.sends[1].mode, 'immediate');
  assert.equal(stub.bodiesFor('/api/requeue').length, 0, 'no hand-back was needed');

  await waitFor(
    () => stub.bodiesFor('/api/response').find((body) => body.messageId === 'q-2'),
    { label: 'q-2 settled' },
  );
  assert.equal(stub.bodiesFor('/api/response').find((body) => body.messageId === 'q-2').kind, 'folded');
  assert.deepEqual(
    stub.bodiesFor('/api/response').find((body) => body.messageId === 'q-1').consumedSteerIds,
    [{ id: 'q-2', attemptId: null }],
  );
  await waitFor(() => runner.isTurnActive() === false, { label: 'turn released' });
});

test('against a relay that predates the hold protocol the worker falls back to pushing', async (t) => {
  // A worker updated on disk runs against the old relay until it restarts.
  // That relay ignores worker.unready and would punish a steering-held
  // hand-back (retry + backoff + worker marked errored), so the worker keeps
  // the pre-hold behavior: the message is pushed.
  const { offers, relay, stub, client, runner, bridge, delivered, openCard, answer } = await bootLiveTurn(t, {
    WebSocketServerImpl: OldRelayWebSocketServer,
  });
  assert.equal(bridge.canHandBackHeldDelivery(), false, 'nothing advertised');
  const decision = openCard();
  await waitFor(() => runner.isDeliveryHeld() === true, { label: 'the card holds' });
  offers.push({ ...baseMessage, id: 'q-2', text: 'also do X' });
  relay.service.emitQueueChanged('new-message');
  await waitFor(() => delivered.includes('q-2'), { label: 'the old relay delivers into the hold' });
  await waitFor(() => client.session.sends.length === 2, { label: 'pushed the legacy way' });
  assert.equal(stub.bodiesFor('/api/requeue').length, 0, 'no hand-back to punish');

  answer();
  await decision;
  await waitFor(
    () => stub.bodiesFor('/api/response').find((body) => body.messageId === 'q-2'),
    { label: 'q-2 answered' },
  );
  await waitFor(() => runner.isTurnActive() === false, { label: 'turn released' });
});

test('a running command withdraws relay readiness over the socket, and its end draws the held messages in, oldest first', async (t) => {
  const { offers, relay, stub, client, runner, delivered } = await bootLiveTurn(t, {
    laterSends: (messageId, sendIndex) => (sendIndex === 2
      ? [userMessage(messageId, 'steering', 'also do X'), { type: 'assistant.message', data: { messageId: 'm2', content: 'did X' } }]
      : [
          userMessage(messageId, 'steering', 'and then Y'),
          { type: 'assistant.message', data: { messageId: 'm3', content: 'did Y' } },
          { type: 'assistant.idle', data: {} },
        ]),
  });

  // The command starts: the runner's flip reaches the relay as worker.unready.
  client.session.emit({ type: 'tool.execution_start', data: { toolCallId: 'call-1', toolName: 'bash', arguments: { command: 'npm test' } } });
  await waitFor(() => relay.service.status().readyCount === 0, { label: 'the relay withdrew readiness' });

  // Two messages queued now are not delivered into the running command.
  offers.push({ ...baseMessage, id: 'q-2', text: 'also do X' }, { ...baseMessage, id: 'q-3', text: 'and then Y' });
  relay.service.emitQueueChanged('new-message');
  await tick(600);
  assert.deepEqual(delivered, ['q-1'], 'nothing delivered while the command runs');
  assert.equal(client.session.sends.length, 1);
  assert.equal(runner.steeringState().holdReason, 'tool');

  // Its end re-arms the relay at once and both steer in, in queue order.
  client.session.emit({ type: 'tool.execution_complete', data: { toolCallId: 'call-1', success: true, result: { content: 'ok' } } });
  await waitFor(() => client.session.sends.length === 3, { label: 'both pushed' });
  assert.deepEqual(delivered, ['q-1', 'q-2', 'q-3']);
  assert.match(client.session.sends[1].prompt, /also do X/);
  assert.match(client.session.sends[2].prompt, /and then Y/);
  assert.equal(client.session.sends[1].mode, 'immediate');
  assert.equal(stub.bodiesFor('/api/requeue').length, 0, 'no hand-back was needed');
  assert.equal(client.session.abortCalls, 0);
  assert.deepEqual(client.session.interruptCalls, []);

  await waitFor(
    () => stub.bodiesFor('/api/response').find((body) => body.messageId === 'q-1'),
    { label: 'q-1 settled' },
  );
  assert.deepEqual(
    stub.bodiesFor('/api/response').find((body) => body.messageId === 'q-1').consumedSteerIds,
    [{ id: 'q-2', attemptId: null }, { id: 'q-3', attemptId: null }],
  );
  await waitFor(() => runner.isTurnActive() === false, { label: 'turn released' });
});

test('a message held for a running command opens the next turn when the turn ends first', async (t) => {
  const { offers, relay, stub, client, runner, delivered } = await bootLiveTurn(t, {
    laterSends: (messageId) => [
      userMessage(messageId, 'idle', 'also do X'),
      { type: 'assistant.message', data: { messageId: 'm2', content: 'did X' } },
      { type: 'assistant.idle', data: {} },
    ],
  });
  client.session.emit({ type: 'tool.execution_start', data: { toolCallId: 'call-1', toolName: 'bash', arguments: { command: 'npm test' } } });
  await waitFor(() => relay.service.status().readyCount === 0, { label: 'the relay withdrew readiness' });
  offers.push({ ...baseMessage, id: 'q-2', text: 'also do X' });
  relay.service.emitQueueChanged('new-message');

  // The turn fails under the running command; the completion never comes.
  client.session.emit({ type: 'session.error', data: { errorType: 'query', message: 'No response was returned' } });
  await waitFor(() => delivered.includes('q-2'), { label: 'q-2 delivered once the turn was gone' });
  await waitFor(
    () => stub.bodiesFor('/api/response').find((body) => body.messageId === 'q-2'),
    { label: 'q-2 answered' },
  );
  const answer = stub.bodiesFor('/api/response').find((body) => body.messageId === 'q-2');
  assert.match(answer.text, /did X/);
  assert.notEqual(answer.kind, 'folded');
  assert.ok(stub.bodiesFor('/api/response').find((body) => body.messageId === 'q-1').terminalError, 'q-1 failed');
  await waitFor(() => runner.isTurnActive() === false, { label: 'turn released' });
});
