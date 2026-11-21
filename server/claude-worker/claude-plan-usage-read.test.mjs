import test from 'node:test';
import assert from 'node:assert/strict';

import { readPlanUsage, scanPlanBehaviors } from './claude-sdk-adapter.mjs';

const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

const PLAN_ANSWER = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: { five_hour: { utilization: 10, resets_at: null } },
};

// A session's Query: its usage method records each call's options and
// answers at once.
function sessionQuery() {
  const calls = [];
  return {
    calls,
    [USAGE_METHOD](options) {
      calls.push(options ?? null);
      return Promise.resolve({ ...PLAN_ANSWER, behaviors: options?.skipBehaviors ? null : { day: {} } });
    },
  };
}

// A stand-in for the SDK's query(): records what it was started with and
// hands back a Query whose usage answer the test controls (`usage`), and
// which counts its close() calls. It reads the prompt the way the SDK does,
// so the test can see that the prompt never yields.
function scanQueryImpl(usage) {
  const started = [];
  const impl = ({ prompt, options }) => {
    const query = {
      prompt,
      options,
      closed: 0,
      yielded: [],
      usageCalls: [],
      initializationResult: async () => ({}),
      close() { this.closed += 1; },
    };
    if (usage !== undefined) {
      query[USAGE_METHOD] = (callOptions) => {
        query.usageCalls.push(callOptions ?? null);
        return typeof usage === 'function' ? usage() : Promise.resolve(usage);
      };
    }
    void (async () => {
      for await (const message of prompt) query.yielded.push(message);
    })();
    started.push(query);
    return query;
  };
  impl.started = started;
  return impl;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a turn reads the plan limits without the transcript scan', async () => {
  const session = sessionQuery();
  const answer = await readPlanUsage(session, () => {});
  assert.equal(answer.rate_limits.five_hour.utilization, 10);
  assert.deepEqual(session.calls, [{ skipBehaviors: true }]);
});

test('the scan runs in a Claude Code process of its own, with no model turn, and closes it', async () => {
  const queryImpl = scanQueryImpl({ ...PLAN_ANSWER, behaviors: { day: { request_count: 3 } } });
  const env = { CLAUDE_CONFIG_DIR: '/home/dev/.claude-alt' };
  const answer = await scanPlanBehaviors(() => {}, {
    queryImpl, env, cwd: '/tmp/scan-cwd', pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
  });
  assert.deepEqual(answer.behaviors, { day: { request_count: 3 } });
  assert.equal(queryImpl.started.length, 1);
  const [scan] = queryImpl.started;
  assert.deepEqual(scan.usageCalls, [null], 'the full answer, scan included');
  assert.equal(scan.options.env, env, 'the worker\'s environment: same login and config dir');
  assert.equal(scan.options.cwd, '/tmp/scan-cwd');
  assert.equal(scan.options.pathToClaudeCodeExecutable, '/opt/claude/bin/claude');
  assert.deepEqual(scan.options.settingSources, []);
  assert.equal(scan.options.model, undefined);
  assert.equal(scan.options.mcpServers, undefined);
  assert.equal(scan.closed, 1, 'closed after the answer');
  await settle();
  assert.deepEqual(scan.yielded, [], 'the prompt never yielded: no model turn');
});

test('the scan process is closed when the scan times out, fails, or has no usage method', async () => {
  const timedOut = scanQueryImpl(() => new Promise(() => {}));
  const messages = [];
  assert.equal(await scanPlanBehaviors((...args) => messages.push(args.join(' ')), { queryImpl: timedOut, timeoutMs: 20 }), null);
  assert.equal(timedOut.started[0].closed, 1);
  assert.match(messages[0], /usage transcript scan timed out after 20ms/);

  const failing = scanQueryImpl(() => Promise.reject(new Error('control channel closed')));
  assert.equal(await scanPlanBehaviors(() => {}, { queryImpl: failing }), null);
  assert.equal(failing.started[0].closed, 1);

  const withoutMethod = scanQueryImpl(undefined);
  assert.equal(await scanPlanBehaviors(() => {}, { queryImpl: withoutMethod }), null);
  assert.equal(withoutMethod.started[0].closed, 1);

  const throwing = () => { throw new Error('spawn failed'); };
  assert.equal(await scanPlanBehaviors(() => {}, { queryImpl: throwing }), null);
  const afterwards = scanQueryImpl({ ...PLAN_ANSWER, behaviors: null });
  assert.ok(await scanPlanBehaviors(() => {}, { queryImpl: afterwards }), 'the next scan may start');
});

test('one scan per worker process at a time', async () => {
  let finish = null;
  const queryImpl = scanQueryImpl(() => new Promise((resolve) => { finish = resolve; }));
  const first = scanPlanBehaviors(() => {}, { queryImpl });
  await settle();
  assert.equal(await scanPlanBehaviors(() => {}, { queryImpl }), null);
  assert.equal(queryImpl.started.length, 1);
  finish({ ...PLAN_ANSWER, behaviors: null });
  await first;
  assert.equal(queryImpl.started[0].closed, 1);
});

test('a live session\'s reads are untouched while a scan runs', async () => {
  let finish = null;
  const queryImpl = scanQueryImpl(() => new Promise((resolve) => { finish = resolve; }));
  const session = sessionQuery();
  const scan = scanPlanBehaviors(() => {}, { queryImpl });
  await settle();
  const started = Date.now();
  const answer = await readPlanUsage(session, () => {});
  assert.ok(answer, 'the session answers while the scan is open');
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(session.calls, [{ skipBehaviors: true }], 'nothing but its own fast read reached the session');
  finish({ ...PLAN_ANSWER, behaviors: null });
  await scan;
});

test('a plan read that times out answers null', async () => {
  const query = { [USAGE_METHOD]: () => new Promise(() => {}) };
  const messages = [];
  assert.equal(await readPlanUsage(query, (...args) => messages.push(args.join(' ')), { timeoutMs: 20 }), null);
  assert.match(messages[0], /plan usage timed out after 20ms/);
});

test('a session Query without the usage method answers null', async () => {
  assert.equal(await readPlanUsage({}, () => {}), null);
  assert.equal(await readPlanUsage(null, () => {}), null);
});
