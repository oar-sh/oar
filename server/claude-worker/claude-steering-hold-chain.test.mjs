// End-to-end chain for the steering hold, over a real socket: the runner's
// gate flip → the worker's runner/link bridge → a worker.unready / worker.ready
// frame from the real link → the real relay websocket service's readiness →
// (re)delivery. Only the SDK stream and the relay's HTTP routes are stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';

import { createSessionWorkerWebSocketService } from '../services/session-worker-websocket-service.mjs';
import { createWorkerWebSocketLink } from '../../shared/worker-runtime/worker-websocket-link.mjs';
import { createRunnerLinkBridge } from './claude-worker-link-wiring.mjs';
import {
  scriptedTurn,
  initMessage,
  userReplay,
  assistantText,
  resultMessage,
  baseMessage,
  makeRunner,
  waitFor,
  tick,
  settled,
} from './claude-session-test-harness.mjs';

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

function makeQuestionApi() {
  const calls = [];
  let answered = false;
  return {
    calls,
    answer() { answered = true; },
    api: async (method, routePath, body) => {
      calls.push({ method, routePath, body });
      if (routePath === '/api/relay-question') return { question: { id: 'rq-1' } };
      if (routePath === '/api/relay-question/rq-1') {
        return { question: { id: 'rq-1', status: answered ? 'answered' : 'pending', answer: 'yes' } };
      }
      return { ok: true };
    },
  };
}

/**
 * Worker side wired exactly like claude-session-worker.mjs: runner ⇄ bridge ⇄
 * real link, against the given relay. Resolves once q-1 is live.
 */
async function bootLiveTurn(t, { WebSocketServerImpl } = {}) {
  const offers = [{ ...baseMessage, id: 'q-1', text: 'hello' }];
  const relay = await startRelay({ offers, WebSocketServerImpl });
  const questionApi = makeQuestionApi();
  const turn = scriptedTurn();
  let canUseTool = null;
  const bridge = createRunnerLinkBridge();
  const runner = makeRunner({
    stub: questionApi,
    startImpl: (params) => { canUseTool = params.canUseTool; return turn; },
    askUserBridgeOptions: { questionPollMs: 5 },
    steeredFoldGraceMs: 60_000,
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
  });
  link.start();
  await waitFor(() => delivered.includes('q-1'), { label: 'q-1 delivered over the socket' });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(assistantText('one question first'));
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'q-1 is live' });
  await waitFor(() => relay.service.status().readyCount === 1, { label: 'the steerable turn re-armed the relay' });
  const openCard = () => canUseTool('AskUserQuestion', { questions: [{ question: 'Proceed?', options: [{ label: 'yes' }] }] }, {});
  return { offers, relay, questionApi, turn, runner, bridge, delivered, openCard };
}

test('a question hold withdraws relay readiness over the socket, and the answer draws the held message in', async (t) => {
  const { offers, relay, questionApi, turn, runner, bridge, delivered, openCard } = await bootLiveTurn(t);
  assert.equal(bridge.canHandBackHeldDelivery(), true, 'the relay advertised the hand-back');

  // The card opens: the runner's flip reaches the relay as worker.unready.
  const decision = openCard();
  await waitFor(() => relay.service.status().readyCount === 0, { label: 'the relay withdrew readiness' });

  // A message queued now is not delivered into the hold.
  offers.push({ ...baseMessage, id: 'q-2', text: 'also do X' });
  relay.service.emitQueueChanged('new-message');
  await tick(600);
  assert.deepEqual(delivered, ['q-1'], 'nothing delivered while the card is open');
  assert.equal(turn.pushed.length, 1);

  // The answer re-arms the relay at once and the held message steers in.
  questionApi.answer();
  await decision;
  await waitFor(() => delivered.includes('q-2'), { label: 'q-2 delivered after the answer' });
  await waitFor(() => turn.pushed.length === 2, { label: 'q-2 pushed' });
  assert.equal(runner._getProcess().pendingDelivered[0].steered, true, 'it steered into the resumed turn');
  assert.equal(questionApi.calls.some((call) => call.routePath === '/api/requeue'), false, 'no hand-back was needed');

  turn.emit(userReplay('also do X'));
  turn.emit(resultMessage('did both', 'native-1'));
  await waitFor(
    () => questionApi.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2'),
    { label: 'q-2 answered' },
  );
  turn.endInput();
  await settled(runner);
});

test('against a relay that predates the hold protocol the worker falls back to pushing', async (t) => {
  // A worker updated on disk runs against the old relay until it restarts.
  // That relay ignores worker.unready and would punish a steering-held
  // hand-back (retry + backoff + worker marked errored), so the worker keeps
  // the pre-hold behavior: the message is pushed.
  const { offers, relay, questionApi, turn, runner, bridge, delivered, openCard } = await bootLiveTurn(t, {
    WebSocketServerImpl: OldRelayWebSocketServer,
  });
  assert.equal(bridge.canHandBackHeldDelivery(), false, 'nothing advertised');
  const decision = openCard();
  await waitFor(() => runner.isDeliveryHeld() === true, { label: 'the card holds' });
  offers.push({ ...baseMessage, id: 'q-2', text: 'also do X' });
  relay.service.emitQueueChanged('new-message');
  await waitFor(() => delivered.includes('q-2'), { label: 'the old relay delivers into the hold' });
  await waitFor(() => turn.pushed.length === 2, { label: 'pushed the legacy way' });
  assert.equal(questionApi.calls.some((call) => call.routePath === '/api/requeue'), false, 'no hand-back to punish');

  questionApi.answer();
  await decision;
  turn.emit(userReplay('also do X'));
  turn.emit(resultMessage('did both', 'native-1'));
  await waitFor(
    () => questionApi.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2'),
    { label: 'q-2 answered' },
  );
  turn.endInput();
  await settled(runner);
});
