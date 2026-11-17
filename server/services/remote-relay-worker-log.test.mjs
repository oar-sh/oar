import test from 'node:test';
import assert from 'node:assert/strict';

import { REMOTE_RELAY_ERROR_CODES, REMOTE_RELAY_LIMITS } from '../../shared/remote-relay-contract.mjs';
import { createReadWorkerLog, plainTail, refuseWorkerLogElsewhere } from './remote-relay-worker-log.mjs';

// Put together at run time: the hygiene scan refuses token shapes. Fake.
const AGENT_TOKEN = ['oar', 'a1_', 'FAKEfake01', '23456789FAKEfake0123'].join('');
const NOW = Date.parse('2026-11-16T12:00:00.000Z');

class Refusal extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function reader(answer) {
  const calls = [];
  const readWorkerLog = createReadWorkerLog({
    call: async (ctx, method, path, options) => {
      calls.push([method, path, options]);
      return answer;
    },
    sessionPath: (id, suffix) => `/api/conversation/${id}${suffix}`,
    refuse: (status, code, message) => new Refusal(status, code, message),
    now: () => NOW,
  });
  return { readWorkerLog, calls };
}

const LOCAL = Object.freeze({ relay: { local: true, name: 'this' }, conversationId: 'conv-1' });

test('plainTail gives the last lines as plain text, a repeat folded', () => {
  const model = [
    { text: 'first' },
    { text: '\u001b[32mok\u001b[0m second', count: 1 },
    { text: 'again', count: 3 },
    { text: 'last' },
  ];
  assert.deepEqual(plainTail(model, 10), { tail: ['first', 'ok second', 'again  [×3]', 'last'], cut: false });
  assert.deepEqual(plainTail(model, 2), { tail: ['again  [×3]', 'last'], cut: true });
});

test('plainTail of an empty log is empty and not cut', () => {
  assert.deepEqual(plainTail([], 50), { tail: [], cut: false });
});

test('plainTail stays within its byte limit and says it cut', () => {
  const line = 'x'.repeat(1000);
  const model = Array.from({ length: 100 }, () => ({ text: line }));
  const { tail, cut } = plainTail(model, 100);
  assert.equal(cut, true);
  const bytes = tail.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8') + 1, 0);
  assert.ok(bytes <= REMOTE_RELAY_LIMITS.taskOutputBytesMax);
  assert.equal(tail.length, Math.floor(REMOTE_RELAY_LIMITS.taskOutputBytesMax / 1001));
});

test('plainTail hides a token a colour code or another code cuts, at any place', () => {
  for (const code of ['\u001b[31m', '\u001b[K', '\u001b]8;;https://example.invalid/\u0007']) {
    for (let at = 1; at < AGENT_TOKEN.length; at += 1) {
      const { tail } = plainTail([{ text: `auth ${AGENT_TOKEN.slice(0, at)}${code}${AGENT_TOKEN.slice(at)} failed` }], 5);
      assert.equal(tail.length, 1);
      assert.equal(tail[0].includes(AGENT_TOKEN.slice(-8)), false, `${JSON.stringify(code)} at ${at}`);
      assert.equal(tail[0].includes('\u001b'), false);
      assert.match(tail[0], /^auth .*\[redacted\].* failed$/);
    }
  }
});

test('read_worker_log answers a file\'s tail with its size and last write', async () => {
  const { readWorkerLog, calls } = reader({
    kind: 'file',
    provider: 'deepseek',
    sdkSessionId: 'sdk-1',
    path: '/logs/worker-conv-1.log',
    size: 2048,
    mtime: NOW - 3 * 60_000,
    previous: [{ name: 'worker-conv-1.log.1' }],
    lines: [{ text: 'started' }, { text: `token ${AGENT_TOKEN.slice(0, 10)}\u001b[1m${AGENT_TOKEN.slice(10)}` }],
  });
  const result = await readWorkerLog(LOCAL, { lines: 20 });
  assert.deepEqual(calls, [['GET', '/api/conversation/conv-1/worker-log', { query: { lines: 20 } }]]);
  assert.equal(result.summary, 'read_worker_log → this: 2 lines, 2048 bytes, last write 3 min ago');
  assert.deepEqual(result.log, {
    provider: 'deepseek',
    sdkSessionId: 'sdk-1',
    path: '/logs/worker-conv-1.log',
    size: 2048,
    lastWriteAt: new Date(NOW - 3 * 60_000).toISOString(),
    previous: ['worker-conv-1.log.1'],
  });
  assert.equal(result.tail[0], 'started');
  assert.equal(result.tail[1].includes(AGENT_TOKEN.slice(-8)), false);
  assert.equal(result.truncated, false);
});

test('read_worker_log of an empty log answers no lines', async () => {
  const { readWorkerLog } = reader({ kind: 'file', path: '/logs/worker-conv-1.log', size: 0, lines: [], hasMoreBefore: false });
  const result = await readWorkerLog(LOCAL, { lines: 20 });
  assert.equal(result.summary, 'read_worker_log → this: 0 lines, 0 bytes');
  assert.deepEqual(result.tail, []);
  assert.equal(result.truncated, false);
});

test('read_worker_log without a log file answers a note and the folder', async () => {
  const { readWorkerLog } = reader({ kind: 'none', provider: 'claude', dir: '/logs', message: 'This chat has no worker log yet.' });
  const result = await readWorkerLog(LOCAL, { lines: 20 });
  assert.deepEqual(result, {
    summary: 'read_worker_log → this: no worker log yet',
    log: { provider: 'claude', sdkSessionId: null, path: null, folder: '/logs' },
    tail: [],
    truncated: false,
    note: 'This chat has no worker log yet.',
  });
  const bare = await reader({}).readWorkerLog(LOCAL, { lines: 20 });
  assert.equal(bare.note, 'No worker log yet.');
});

test('read_worker_log runs only on this relay and only from a conversation', async () => {
  const { readWorkerLog, calls } = reader({ kind: 'file', lines: [] });
  await assert.rejects(readWorkerLog({ relay: { local: false, name: 'other' }, conversationId: 'conv-1' }, { lines: 5 }),
    (error) => error.status === 400 && error.code === REMOTE_RELAY_ERROR_CODES.unsupported && /relay "this"/.test(error.message));
  await assert.rejects(readWorkerLog({ relay: { local: true, name: 'this' }, conversationId: ' ' }, { lines: 5 }),
    (error) => error.status === 400 && error.code === REMOTE_RELAY_ERROR_CODES.invalidInput);
  assert.deepEqual(calls, []);
  const refused = refuseWorkerLogElsewhere({ relay: 'other' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, REMOTE_RELAY_ERROR_CODES.unsupported);
  assert.equal(refused.body.relay, 'other');
});
