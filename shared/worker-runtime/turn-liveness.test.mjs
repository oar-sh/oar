import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TURN_STALL_WINDOWS_MS,
  createTurnLiveness,
  createTurnStalledError,
  describeTurnStall,
  isTurnStalledError,
  probeRuntime,
  resolveTurnStallWindows,
} from './turn-liveness.mjs';

function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

const WINDOWS = { idle: 120_000, model: 300_000, tool: 1_800_000 };

test('with nothing in flight a turn stalls after the idle window', () => {
  const time = clock();
  const liveness = createTurnLiveness({ windows: WINDOWS, now: time.now });
  time.advance(119_000);
  assert.deepEqual(liveness.check(), { phase: 'idle', quietMs: 119_000, limitMs: 120_000, stalled: false, waitMs: 1_000 });
  time.advance(1_000);
  assert.equal(liveness.check().stalled, true);
});

test('a silent tool does not stall the turn at the idle window', () => {
  // A shell command that prints nothing emits no event until it exits.
  const time = clock();
  const liveness = createTurnLiveness({ windows: WINDOWS, now: time.now });
  liveness.begin('tool', 'call-1', 'bash');
  time.advance(30_000);
  // Looked at again when the silence reaches an idle window, which is where
  // a worker asks its runtime whether it is still there.
  assert.equal(liveness.check().waitMs, 90_000);
  time.advance(120_000);
  const verdict = liveness.check();
  assert.equal(verdict.phase, 'tool');
  assert.equal(verdict.stalled, false);
  assert.equal(verdict.waitMs, 90_000);

  liveness.end('tool', 'call-1');
  assert.equal(liveness.phase(), 'idle');
  assert.equal(liveness.check().stalled, true, 'the silence counts from the last traffic, not from the tool ending');
});

test('a model request gets the model window, and traffic restarts it', () => {
  const time = clock();
  const liveness = createTurnLiveness({ windows: WINDOWS, now: time.now });
  liveness.begin('model', 'root');
  time.advance(200_000);
  assert.equal(liveness.check().stalled, false);
  liveness.traffic('assistant.streaming_delta');
  time.advance(299_000);
  assert.equal(liveness.check().stalled, false);
  time.advance(1_000);
  const verdict = liveness.check();
  assert.equal(verdict.stalled, true);
  assert.equal(verdict.phase, 'model');
});

test('the most tolerant open phase decides, and work is counted by id', () => {
  const time = clock();
  const liveness = createTurnLiveness({ windows: WINDOWS, now: time.now });
  liveness.begin('model', 'agent-7');
  liveness.begin('tool', 'call-1', 'bash');
  liveness.begin('tool', 'call-2', 'bash');
  liveness.begin('tool', 'call-3', 'view');
  assert.equal(liveness.phase(), 'tool');
  assert.deepEqual(liveness.toolsInFlight(), ['bash', 'view']);
  liveness.end('tool', 'call-1');
  liveness.end('tool', 'call-2');
  assert.equal(liveness.phase(), 'tool');
  liveness.end('tool', 'call-3');
  assert.equal(liveness.phase(), 'model');
  liveness.end('model', 'agent-7');
  assert.equal(liveness.phase(), 'idle');
});

test('a window of 0 never stalls that phase', () => {
  const time = clock();
  const liveness = createTurnLiveness({ windows: { idle: 120_000, model: 300_000, tool: 0 }, now: time.now });
  liveness.begin('model', 'root');
  liveness.begin('tool', 'call-1', 'bash');
  assert.equal(liveness.phase(), 'tool', 'no limit is the most tolerant window there is');
  time.advance(24 * 3_600_000);
  assert.deepEqual(liveness.check(), { phase: 'tool', quietMs: 24 * 3_600_000, limitMs: 0, stalled: false, waitMs: 120_000 });
});

test('reset closes everything in flight', () => {
  const time = clock();
  const liveness = createTurnLiveness({ windows: WINDOWS, now: time.now });
  liveness.begin('tool', 'call-1', 'bash');
  time.advance(60_000);
  liveness.reset();
  assert.equal(liveness.phase(), 'idle');
  assert.equal(liveness.quietMs(), 0);
});

test('describe names the phase, the silence and the tools in flight', () => {
  const time = clock();
  const liveness = createTurnLiveness({ windows: WINDOWS, now: time.now });
  liveness.traffic('tool.execution_start');
  liveness.begin('tool', 'call-1', 'bash');
  time.advance(61_000);
  assert.equal(liveness.describe(), 'phase=tool quiet=61s last=tool.execution_start model=0 tools=1 (bash)');
});

test('the windows come from the option, then the environment, then the default', () => {
  assert.deepEqual(resolveTurnStallWindows({ env: {} }), { ...DEFAULT_TURN_STALL_WINDOWS_MS });
  assert.deepEqual(
    resolveTurnStallWindows({ env: { OAR_TURN_STALL_MODEL_MS: '600000', OAR_TURN_STALL_TOOL_MS: '0' } }),
    { idle: 120_000, model: 600_000, tool: 0 },
  );
  assert.deepEqual(
    resolveTurnStallWindows({ env: { OAR_TURN_STALL_MODEL_MS: '600000' }, modelMs: 90_000 }),
    { idle: 120_000, model: 90_000, tool: 1_800_000 },
  );
  // Junk is not a setting.
  assert.deepEqual(resolveTurnStallWindows({ env: { OAR_TURN_STALL_IDLE_MS: 'soon' } }), { ...DEFAULT_TURN_STALL_WINDOWS_MS });
});

test('a lone idle setting keeps the other windows in proportion', () => {
  assert.deepEqual(resolveTurnStallWindows({ env: {}, idleMs: 240_000 }), { idle: 240_000, model: 600_000, tool: 3_600_000 });
  assert.deepEqual(resolveTurnStallWindows({ env: {}, idleMs: 20 }), { idle: 20, model: 50, tool: 300 });
  // Off is off for every phase.
  assert.deepEqual(resolveTurnStallWindows({ env: {}, idleMs: 0 }), { idle: 0, model: 0, tool: 0 });
});

test('the probe tells a runtime that answers from one that does not', async () => {
  assert.equal(await probeRuntime(null), 'none');
  assert.equal(await probeRuntime(async () => ({ ok: true })), 'alive');
  assert.equal(await probeRuntime(async () => false), 'gone');
  assert.equal(await probeRuntime(async () => { throw new Error('connection closed'); }), 'gone');
  assert.equal(await probeRuntime(() => new Promise(() => {}), 10), 'gone');
});

test('the failure says what the runtime was doing', () => {
  const idle = createTurnStalledError({ agentLabel: 'Copilot', quietMs: 120_000 });
  assert.equal(isTurnStalledError(idle), true);
  assert.equal(isTurnStalledError(new Error('boom')), false);
  assert.equal(describeTurnStall(idle), 'System note: the Copilot runtime sent nothing for 120s, so the relay ended the turn.');

  const model = createTurnStalledError({ agentLabel: 'Copilot', quietMs: 300_000, phase: 'model' });
  assert.equal(
    describeTurnStall(model),
    'System note: the Copilot runtime sent nothing for 300s while a model request was running, so the relay ended the turn.',
  );

  const tool = createTurnStalledError({ agentLabel: 'Cursor', quietMs: 1_800_000, phase: 'tool', tools: ['shell'] });
  assert.equal(
    describeTurnStall(tool),
    'System note: the Cursor runtime sent nothing for 1800s while a tool was running (shell), so the relay ended the turn.',
  );

  const gone = createTurnStalledError({ agentLabel: 'Copilot', quietMs: 125_000, phase: 'tool', tools: ['bash'], unresponsive: true });
  assert.equal(
    describeTurnStall(gone),
    'System note: the Copilot runtime stopped answering while a tool was running (bash) '
      + '(nothing for 125s, no reply when asked), so the relay ended the turn.',
  );
  assert.match(gone.message, /copilot turn stalled: no traffic for 125s \(phase tool, runtime not answering\)/);
});
