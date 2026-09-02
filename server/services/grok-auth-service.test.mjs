import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { CLI_SPAWN_DISABLED_ERROR } from './claude-auth-service.mjs';
import {
  createGrokAuthService,
  extractDeviceAuthUrl,
  extractDeviceCode,
  resolveGrokAuthBinary,
} from './grok-auth-service.mjs';

const STUB_BIN = '/opt/grok';
const DEVICE_CODE = 'D7SV-M4TR';
const DEVICE_URL = `https://accounts.x.ai/oauth2/device?user_code=${DEVICE_CODE}`;
// Verbatim `grok login --device-auth` output on Grok Build 1.0.13 (plan §2.2),
// including the single grey (SGR 90) warning line and the blank-line spacing.
const LOGIN_BANNER = [
  '',
  'To sign in, open this URL in your browser:',
  '',
  `  ${DEVICE_URL}`,
  '',
  '  (Could not open browser automatically — open the URL above manually.)',
  '',
  'Confirm this code in your browser:',
  '',
  `  ${DEVICE_CODE}`,
  '',
  '\x1b[90mOnly continue with a code you requested. Do not share it with anyone.\x1b[0m',
  '',
  'Waiting for authorization...',
  '',
].join('\n');

const LOGGED_IN_AUTH = { key: 'grok-stub-key', expiresAt: '2099-01-01T00:00:00.000Z' };
// The live fixture from grok-billing-usage.test.mjs, already normalized.
const BILLING = {
  usagePercent: 25,
  periodType: 'weekly',
  periodStart: '2026-08-04T15:53:24.625Z',
  periodEnd: '2026-08-11T15:53:24.625Z',
  products: [{ product: 'GrokBuild', usagePercent: 25 }],
};

/** Lets the injected promise chains settle without touching the timer seams. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Fake child process: the events the service listens for, plus recorders for
 * everything it signals. `stdin` is deliberately null — the service spawns with
 * `stdio: ['ignore', …]`, so a real child would have none either.
 */
function createFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.stdin = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => { child.killSignals.push(signal); return true; };
  child.emitStdout = (text) => child.stdout.emit('data', Buffer.from(text));
  child.emitStderr = (text) => child.stderr.emit('data', Buffer.from(text));
  child.exit = (code) => {
    child.exitCode = code;
    child.emit('close', code);
  };
  return child;
}

/**
 * Manual timer seam: the service's timeouts (login expiry, logout run timeout,
 * SIGKILL escalation) are fired by the test instead of the clock.
 */
function createManualTimers() {
  const pending = new Map();
  let nextId = 0;
  return {
    pending,
    setTimeoutImpl(fn, ms) {
      const id = (nextId += 1);
      pending.set(id, { fn, ms });
      return { id, unref() { return this; } };
    },
    clearTimeoutImpl(handle) {
      if (handle && pending.has(handle.id)) pending.delete(handle.id);
    },
    delays() {
      return [...pending.values()].map((entry) => entry.ms);
    },
    fire(ms) {
      let fired = 0;
      for (const [id, entry] of [...pending]) {
        if (entry.ms !== ms) continue;
        pending.delete(id);
        entry.fn();
        fired += 1;
      }
      return fired;
    },
  };
}

function createHarness({
  auth = LOGGED_IN_AUTH,
  billing = BILLING,
  autoBilling = true,
  platform = 'linux',
  env = {},
  ...serviceOptions
} = {}) {
  const timers = createManualTimers();
  const calls = [];
  const kills = [];
  const pendingBilling = [];
  const control = { auth, billing, autoBilling, clock: Date.parse('2026-08-31T12:00:00.000Z') };
  let nextPid = 5000;

  const spawnImpl = (command, args, options) => {
    const child = createFakeChild((nextPid += 1));
    calls.push({ command, args, options, child, subcommand: (args || []).join(' ') });
    return child;
  };

  const service = createGrokAuthService({
    env: { GROK_CLI_COMMAND: STUB_BIN, ...env },
    platform,
    spawnImpl,
    processKillImpl: (pid, signal) => { kills.push([pid, signal]); },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    now: () => control.clock,
    logger: { log() {} },
    readAuthKeyImpl: () => control.auth,
    fetchBillingImpl: async () => {
      if (control.autoBilling) return control.billing;
      return new Promise((resolve) => pendingBilling.push(resolve));
    },
    ...serviceOptions,
  });

  const states = [];
  service.subscribe((snapshot) => states.push(snapshot));

  return {
    service,
    states,
    stateNames: () => states.map((entry) => entry.state),
    calls,
    kills,
    timers,
    control,
    settleBilling(value) {
      const resolve = pendingBilling.shift();
      assert.ok(resolve, 'a billing fetch should be pending');
      resolve(value === undefined ? control.billing : value);
    },
    callsFor: (prefix) => calls.filter((call) => call.subcommand.startsWith(prefix)),
    lastChild: () => calls[calls.length - 1]?.child || null,
    cleanup() { service.dispose(); },
  };
}

/** Drives a harness to awaiting_authorization and returns the login child. */
function startLoginToAwaitingAuthorization(harness) {
  const started = harness.service.startLogin();
  assert.equal(started.ok, true);
  const child = harness.lastChild();
  child.emitStdout(LOGIN_BANNER);
  assert.equal(harness.service.getLoginState().state, 'awaiting_authorization');
  return child;
}

// ─── Pure parsing helpers ────────────────────────────────────────────────────

test('extractDeviceAuthUrl reads the URL out of the live banner shape', () => {
  assert.equal(extractDeviceAuthUrl(LOGIN_BANNER), DEVICE_URL);
  // The grey warning line is the only escape sequence in the flow; it must not
  // leave `90m` residue that could be glued onto a match.
  assert.ok(!extractDeviceAuthUrl(LOGIN_BANNER).includes('\x1b'));
  assert.equal(extractDeviceAuthUrl('nothing to see here'), '');
  assert.equal(extractDeviceAuthUrl(''), '');
});

test('extractDeviceAuthUrl ignores a look-alike host', () => {
  assert.equal(extractDeviceAuthUrl('open https://accounts.x.ai.evil.example/oauth2/device?user_code=AAAA-BBBB\n'), '');
  assert.equal(extractDeviceAuthUrl('open https://accounts.x.ai/oauth2/token?x=1\n'), '');
});

test('extractDeviceAuthUrl ignores a line the CLI has not finished writing', () => {
  // stdout arrives in arbitrary chunks: a boundary mid-URL must not latch a
  // truncated link, because the first hit wins for the whole session.
  const partial = LOGIN_BANNER.slice(0, LOGIN_BANNER.indexOf(DEVICE_CODE) + 4);
  assert.ok(partial.endsWith('D7SV'), 'the fixture must actually cut the URL');
  assert.equal(extractDeviceAuthUrl(partial), '');
  assert.equal(extractDeviceCode(partial), '');
});

test('extractDeviceCode prefers the code carried in the URL', () => {
  assert.equal(extractDeviceCode(LOGIN_BANNER), DEVICE_CODE);
  // A release that drops user_code from the URL still parses off the bare line.
  const bare = 'To sign in: https://accounts.x.ai/oauth2/device\n\nConfirm this code:\n\n  4KQ2-9ZTX\n';
  assert.equal(extractDeviceCode(bare), '4KQ2-9ZTX');
  assert.equal(extractDeviceCode('Waiting for authorization...\n'), '');
});

test('extractDeviceCode survives a percent-encoded user_code', () => {
  assert.equal(extractDeviceCode('https://accounts.x.ai/oauth2/device?user_code=D7SV%2DM4TR\n'), 'D7SV-M4TR');
});

test('resolveGrokAuthBinary follows the same override chain as the worker', () => {
  assert.equal(resolveGrokAuthBinary({}), 'grok');
  assert.equal(resolveGrokAuthBinary({ GROK_COMMAND: '/opt/grok-alt' }), '/opt/grok-alt');
  assert.equal(
    resolveGrokAuthBinary({ GROK_CLI_COMMAND: '/opt/grok', GROK_COMMAND: '/opt/grok-alt' }),
    '/opt/grok',
  );
});

// ─── Status reads ────────────────────────────────────────────────────────────

test('getStatus reads the auth store plus the billing label, and never spawns', async () => {
  const harness = createHarness();
  try {
    const status = await harness.service.getStatus();
    assert.equal(status.ok, true);
    assert.equal(status.loggedIn, true);
    assert.equal(status.expired, false);
    assert.equal(status.expiresAt, '2099-01-01T00:00:00.000Z');
    assert.equal(status.plan, 'GrokBuild');
    assert.equal(status.usagePercent, 25);
    assert.equal(status.periodType, 'weekly');
    assert.equal(status.periodEnd, '2026-08-11T15:53:24.625Z');
    assert.deepEqual(harness.calls, [], 'there is no `grok auth status` to run');
    // The bearer key must never reach a caller.
    assert.ok(!JSON.stringify(status).includes('grok-stub-key'));
  } finally {
    harness.cleanup();
  }
});

test('getStatus reports a missing auth store as signed out without fetching billing', async () => {
  const harness = createHarness({
    auth: null,
    fetchBillingImpl: async () => { throw new Error('should not be called'); },
  });
  try {
    const status = await harness.service.getStatus();
    assert.equal(status.ok, true);
    assert.equal(status.loggedIn, false);
    assert.equal(status.plan, null);
    assert.equal(status.usagePercent, null);
    assert.equal(status.error, null);
  } finally {
    harness.cleanup();
  }
});

test('an elapsed token expiry is flagged but still counts as signed in', async () => {
  const harness = createHarness({ auth: { key: 'k', expiresAt: '2026-08-31T06:00:00Z' } });
  try {
    const status = await harness.service.getStatus();
    assert.equal(status.loggedIn, true, 'the CLI refreshes the key in place');
    assert.equal(status.expired, true);
    assert.equal(status.expiresAt, '2026-08-31T06:00:00.000Z');
  } finally {
    harness.cleanup();
  }
});

test('an unparseable expiry degrades to null rather than a false "expired"', async () => {
  const harness = createHarness({ auth: { key: 'k', expiresAt: 'soon' } });
  try {
    const status = await harness.service.getStatus();
    assert.equal(status.expiresAt, null);
    assert.equal(status.expired, false);
  } finally {
    harness.cleanup();
  }
});

test('a billing payload with several products offers no plan label', async () => {
  const harness = createHarness({
    billing: { ...BILLING, products: [{ product: 'GrokBuild' }, { product: 'GrokApp' }] },
  });
  try {
    const status = await harness.service.getStatus();
    assert.equal(status.plan, null);
    assert.equal(status.usagePercent, 25, 'the quota still renders');
  } finally {
    harness.cleanup();
  }
});

test('a failing billing probe leaves the signed-in verdict intact', async () => {
  const harness = createHarness({ fetchBillingImpl: async () => { throw new Error('network down'); } });
  try {
    const status = await harness.service.getStatus();
    assert.equal(status.loggedIn, true);
    assert.equal(status.plan, null);
    assert.equal(status.usagePercent, null);
    assert.equal(status.error, null);
  } finally {
    harness.cleanup();
  }
});

test('the status is cached inside the TTL and re-read on force', async () => {
  const harness = createHarness();
  try {
    assert.equal((await harness.service.getStatus()).loggedIn, true);
    harness.control.auth = null;
    assert.equal((await harness.service.getStatus()).loggedIn, true, 'cached inside the TTL');
    assert.equal((await harness.service.getStatus({ force: true })).loggedIn, false);
    assert.equal(harness.service.getCachedStatus().loggedIn, false);

    // Past the TTL the cache is not consulted at all.
    harness.control.auth = LOGGED_IN_AUTH;
    harness.control.clock += 5_001;
    assert.equal((await harness.service.getStatus()).loggedIn, true);
  } finally {
    harness.cleanup();
  }
});

test('a forced read never adopts an in-flight read that started before it', async () => {
  const harness = createHarness({ autoBilling: false });
  try {
    const cached = harness.service.getStatus();
    await flush();

    // The login/logout that prompts the force happens here, mid-read.
    const forced = harness.service.getStatus({ force: true });
    harness.control.auth = null;
    harness.settleBilling(BILLING);
    assert.equal((await cached).loggedIn, true, 'the first read still sees the old store');
    assert.equal((await forced).loggedIn, false, 'the forced read re-reads it');
  } finally {
    harness.cleanup();
  }
});

test('a non-forced read joins the read already running', async () => {
  const harness = createHarness({ autoBilling: false });
  try {
    const first = harness.service.getStatus();
    const second = harness.service.getStatus();
    await flush();
    harness.settleBilling(BILLING);
    assert.equal(await first, await second);
  } finally {
    harness.cleanup();
  }
});

// ─── Login state machine ─────────────────────────────────────────────────────

test('login spawns the device-auth flow on plain pipes and scrapes the URL and code', async () => {
  const harness = createHarness();
  try {
    const child = startLoginToAwaitingAuthorization(harness);
    const call = harness.calls[0];
    assert.equal(call.command, STUB_BIN, 'the binary is spawned directly: no `script` PTY harness');
    assert.deepEqual(call.args, ['login', '--device-auth']);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(call.options.detached, true);
    assert.equal(child.stdin, null, 'nothing is ever written back to the CLI');

    const state = harness.service.getLoginState();
    assert.equal(state.authUrl, DEVICE_URL);
    assert.equal(state.userCode, DEVICE_CODE);
    assert.equal(state.active, true);
    assert.deepEqual(harness.stateNames(), ['starting', 'awaiting_authorization']);

    // Further chunks from the poll loop do not re-broadcast.
    child.emitStdout('Waiting for authorization...\n');
    assert.deepEqual(harness.stateNames(), ['starting', 'awaiting_authorization']);
  } finally {
    harness.cleanup();
  }
});

test('a chunk boundary in the middle of the URL does not latch a truncated link', async () => {
  const harness = createHarness();
  try {
    harness.service.startLogin();
    const child = harness.lastChild();
    const split = LOGIN_BANNER.indexOf(DEVICE_CODE) + 4;
    child.emitStdout(LOGIN_BANNER.slice(0, split));
    assert.equal(harness.service.getLoginState().state, 'starting', 'the half-written URL is ignored');
    child.emitStdout(LOGIN_BANNER.slice(split));
    const state = harness.service.getLoginState();
    assert.equal(state.authUrl, DEVICE_URL);
    assert.equal(state.userCode, DEVICE_CODE);
    assert.deepEqual(harness.stateNames(), ['starting', 'awaiting_authorization']);
  } finally {
    harness.cleanup();
  }
});

test('exit 0 is the success signal: no code is ever submitted', async () => {
  const harness = createHarness({ auth: null });
  const hookCalls = [];
  try {
    harness.service.onLoginSuccess(() => { hookCalls.push('refresh'); });
    const child = startLoginToAwaitingAuthorization(harness);
    harness.control.auth = LOGGED_IN_AUTH;
    child.exit(0);

    // Success is published immediately: the confirming status read has not run.
    assert.equal(harness.service.getLoginState().state, 'success');
    assert.equal(harness.service.getLoginState().active, false);
    assert.deepEqual(hookCalls, [], 'hooks wait for the refreshed status');

    await flush();
    await flush();
    assert.deepEqual(harness.stateNames(), ['starting', 'awaiting_authorization', 'success', 'success']);
    assert.equal(harness.service.getCachedStatus().loggedIn, true);
    assert.deepEqual(hookCalls, ['refresh']);
  } finally {
    harness.cleanup();
  }
});

test('a login started during the post-success refresh is not clobbered by the old one', async () => {
  const harness = createHarness({ autoBilling: false });
  const hookCalls = [];
  try {
    harness.service.onLoginSuccess(() => { hookCalls.push('refresh'); });
    const child = startLoginToAwaitingAuthorization(harness);
    child.exit(0);
    assert.equal(harness.service.getLoginState().state, 'success');

    // A second sign-in begins while the confirming status read is still running.
    harness.service.startLogin();
    assert.equal(harness.service.getLoginState().state, 'starting');
    await flush();
    harness.settleBilling(BILLING);
    await flush();
    await flush();

    assert.equal(harness.service.getLoginState().state, 'starting', 'the stale success stays buried');
    assert.deepEqual(hookCalls, [], 'and its hooks do not fire mid-login');
  } finally {
    harness.cleanup();
  }
});

test('a non-zero exit ends the session in error with a scrubbed tail', async () => {
  const harness = createHarness();
  try {
    const child = startLoginToAwaitingAuthorization(harness);
    child.emitStderr('\nAuthorization failed: the device code expired. token=abcdefghijklmnopqrstuvwxyz0123456789\n');
    child.exit(1);

    const failed = harness.service.getLoginState();
    assert.equal(failed.state, 'error');
    assert.match(failed.error, /exited with code 1/);
    assert.match(failed.error, /device code expired/);
    assert.ok(!failed.error.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
    assert.equal(failed.active, false);

    // The session is released, so a fresh attempt is allowed.
    assert.equal(harness.service.startLogin().reused, false);
  } finally {
    harness.cleanup();
  }
});

test('a login that dies with no output at all still reports the exit code', async () => {
  const harness = createHarness();
  try {
    harness.service.startLogin();
    harness.lastChild().exit(127);
    const failed = harness.service.getLoginState();
    assert.equal(failed.state, 'error');
    assert.match(failed.error, /Grok login exited with code 127$/);
  } finally {
    harness.cleanup();
  }
});

test('a spawn error fails the session instead of throwing', async () => {
  const harness = createHarness();
  try {
    harness.service.startLogin();
    harness.lastChild().emit('error', new Error('spawn ENOENT'));
    assert.match(harness.service.getLoginState().error, /ENOENT/);
    assert.equal(harness.service.getLoginState().state, 'error');
  } finally {
    harness.cleanup();
  }
});

test('startLogin is single-flight: a second call joins the running session', async () => {
  const harness = createHarness();
  try {
    startLoginToAwaitingAuthorization(harness);
    const second = harness.service.startLogin();
    assert.equal(second.reused, true);
    assert.equal(second.login.authUrl, DEVICE_URL);
    assert.equal(second.login.userCode, DEVICE_CODE);
    assert.equal(second.login.state, 'awaiting_authorization');
    assert.equal(harness.calls.length, 1, 'no second device code is requested');
  } finally {
    harness.cleanup();
  }
});

test('cancel signals the whole process group and returns to idle', async () => {
  const harness = createHarness();
  try {
    const child = startLoginToAwaitingAuthorization(harness);
    const cancelled = harness.service.cancel();
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.login.state, 'idle');
    assert.equal(cancelled.login.authUrl, null);
    assert.equal(cancelled.login.userCode, null);
    assert.equal(cancelled.login.active, false);
    assert.deepEqual(harness.kills, [[-child.pid, 'SIGTERM']]);
  } finally {
    harness.cleanup();
  }
});

test('the SIGKILL escalation survives the session release', async () => {
  const harness = createHarness();
  try {
    const child = startLoginToAwaitingAuthorization(harness);
    harness.service.cancel();
    assert.ok(harness.timers.delays().includes(2000), 'the escalation timer is still armed');
    harness.timers.fire(2000);
    assert.deepEqual(harness.kills, [[-child.pid, 'SIGTERM'], [-child.pid, 'SIGKILL']]);

    // Once the child is gone the escalation is a no-op.
    harness.kills.length = 0;
    const second = startLoginToAwaitingAuthorization(harness);
    harness.service.cancel();
    second.exitCode = 0;
    harness.timers.fire(2000);
    assert.deepEqual(harness.kills, [[-second.pid, 'SIGTERM']]);
  } finally {
    harness.cleanup();
  }
});

test('a late close from a cancelled session leaves a newer login alone', async () => {
  const harness = createHarness();
  try {
    const first = startLoginToAwaitingAuthorization(harness);
    harness.service.cancel();
    const second = startLoginToAwaitingAuthorization(harness);
    assert.notEqual(first, second);

    // The killed process finally reports in — and it exits 0, which would be a
    // success for its own session.
    first.exit(0);
    await flush();

    const state = harness.service.getLoginState();
    assert.equal(state.state, 'awaiting_authorization');
    assert.equal(state.active, true, 'the newer session is still owned');
    assert.equal(harness.timers.delays().filter((ms) => ms === 600_000).length, 1,
      'the newer session keeps its login timeout');
  } finally {
    harness.cleanup();
  }
});

test('cancel also clears a terminal error state', async () => {
  const harness = createHarness();
  try {
    const child = startLoginToAwaitingAuthorization(harness);
    child.exit(1);
    assert.equal(harness.service.getLoginState().state, 'error');
    assert.equal(harness.service.cancel().login.state, 'idle');
  } finally {
    harness.cleanup();
  }
});

test('the login hard timeout kills the session and reports an error', async () => {
  const harness = createHarness({ loginTimeoutMs: 400 });
  try {
    const child = startLoginToAwaitingAuthorization(harness);
    assert.equal(harness.timers.fire(400), 1);
    const failed = harness.service.getLoginState();
    assert.equal(failed.state, 'error');
    assert.match(failed.error, /timed out/i);
    assert.equal(failed.active, false);
    assert.deepEqual(harness.kills, [[-child.pid, 'SIGTERM']]);
  } finally {
    harness.cleanup();
  }
});

// ─── Logout ──────────────────────────────────────────────────────────────────

test('logout runs the CLI once, force-refreshes the status and returns to idle', async () => {
  const harness = createHarness();
  try {
    await harness.service.getStatus();

    const pending = harness.service.logout();
    await flush();
    const call = harness.callsFor('logout')[0];
    assert.equal(call.command, STUB_BIN);
    assert.deepEqual(call.args, ['logout']);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    harness.control.auth = null;
    call.child.emitStdout('Signed out.\n');
    call.child.exit(0);

    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.status.loggedIn, false, 'the returned status is post-logout');
    assert.equal(harness.service.getLoginState().state, 'idle');
    // The idle transition is broadcast with the fresh status already cached.
    assert.equal(harness.states.at(-1).state, 'idle');
    assert.equal(harness.service.getCachedStatus().loggedIn, false);
  } finally {
    harness.cleanup();
  }
});

test('logout is refused with 409 while a login is in progress', async () => {
  const harness = createHarness();
  try {
    startLoginToAwaitingAuthorization(harness);
    const refused = await harness.service.logout();
    assert.equal(refused.ok, false);
    assert.equal(refused.statusCode, 409);
    assert.match(refused.error, /login is in progress/i);
    assert.equal(harness.callsFor('logout').length, 0);
  } finally {
    harness.cleanup();
  }
});

test('a failing logout reports the scrubbed tail with the refreshed status', async () => {
  const harness = createHarness();
  try {
    const pending = harness.service.logout();
    await flush();
    const call = harness.callsFor('logout')[0];
    call.child.emitStderr('logout failed: key abcdefghijklmnopqrstuvwxyz0123456789 rejected\n');
    call.child.exit(1);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 500);
    assert.ok(!result.error.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
    assert.match(result.error, /logout failed/);
    assert.ok(result.status, 'the caller still gets a status payload');
  } finally {
    harness.cleanup();
  }
});

test('a hung logout is killed at the run timeout', async () => {
  const harness = createHarness({ logoutTimeoutMs: 500 });
  try {
    const pending = harness.service.logout();
    await flush();
    const child = harness.callsFor('logout')[0].child;
    assert.equal(harness.timers.fire(500), 1);
    assert.deepEqual(harness.kills, [[-child.pid, 'SIGTERM']]);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out after 500ms/);
  } finally {
    harness.cleanup();
  }
});

// ─── Kill switch ─────────────────────────────────────────────────────────────

test('every spawn path refuses when the relay runs with CLI spawns disabled', async () => {
  const harness = createHarness({ env: { COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1' } });
  try {
    const started = harness.service.startLogin();
    assert.equal(started.ok, false);
    assert.equal(started.error, CLI_SPAWN_DISABLED_ERROR);
    assert.equal(harness.service.getLoginState().state, 'error');
    assert.equal(harness.service.getLoginState().active, false);

    const loggedOut = await harness.service.logout();
    assert.equal(loggedOut.ok, false);
    assert.equal(loggedOut.error, CLI_SPAWN_DISABLED_ERROR);

    assert.deepEqual(harness.calls, [], 'no child process was ever created');
  } finally {
    harness.cleanup();
  }

  // Status needs no spawn, so it keeps working — but the outbound billing probe
  // is blocked by the same switch, so an isolated test relay never reaches x.ai.
  const statusOnly = createHarness({
    env: { COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1' },
    fetchBillingImpl: async () => { throw new Error('should not be called'); },
  });
  try {
    const status = await statusOnly.service.getStatus();
    assert.equal(status.loggedIn, true);
    assert.equal(status.plan, null, 'no billing label without the network');
  } finally {
    statusOnly.cleanup();
  }

  // The e2e harness keeps the kill switch on but still drives the auth flow
  // against an injected stub binary. The opt-in only counts together with an
  // explicit binary override.
  const flagOnly = createHarness({
    env: {
      COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1',
      COPILOT_WEB_RELAY_GROK_AUTH_ALLOW_STUB_SPAWN: '1',
      GROK_CLI_COMMAND: '',
    },
  });
  try {
    assert.equal(flagOnly.service.startLogin().error, CLI_SPAWN_DISABLED_ERROR, 'no stub path: still refused');
    assert.deepEqual(flagOnly.calls, []);
  } finally {
    flagOnly.cleanup();
  }

  const stubbed = createHarness({
    env: {
      COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1',
      COPILOT_WEB_RELAY_GROK_AUTH_ALLOW_STUB_SPAWN: '1',
    },
  });
  try {
    assert.equal(stubbed.service.startLogin().ok, true, 'flag + stub binary spawns the stub');
    assert.equal(stubbed.calls[0].command, STUB_BIN);
  } finally {
    stubbed.cleanup();
  }
});

// ─── Windows fallbacks ───────────────────────────────────────────────────────

test('on Windows the child is not detached and the kill uses the child handle', async () => {
  const harness = createHarness({ platform: 'win32' });
  try {
    const child = startLoginToAwaitingAuthorization(harness);
    const call = harness.calls[0];
    assert.equal(call.command, STUB_BIN);
    assert.deepEqual(call.args, ['login', '--device-auth']);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.detached, undefined);

    harness.service.cancel();
    assert.deepEqual(harness.kills, [], 'no process-group signal on Windows');
    assert.deepEqual(child.killSignals, ['SIGTERM']);
    harness.timers.fire(2000);
    assert.deepEqual(child.killSignals, ['SIGTERM', 'SIGKILL']);
  } finally {
    harness.cleanup();
  }
});

test('dispose tears down the running session and stops broadcasting', async () => {
  const harness = createHarness();
  const child = startLoginToAwaitingAuthorization(harness);
  const before = harness.states.length;
  harness.service.dispose();
  assert.deepEqual(harness.kills, [[-child.pid, 'SIGTERM']]);
  child.exit(0);
  await flush();
  assert.equal(harness.states.length, before, 'no listener fires after dispose');
});

test('a .cmd grok on win32 spawns through a shell with every token quoted', async () => {
  const harness = createHarness({
    platform: 'win32',
    env: { GROK_CLI_COMMAND: 'C:\Users\dev\AppData\Roaming\npm\grok.cmd' },
  });
  try {
    harness.service.startLogin();
    const call = harness.calls[0];
    // CVE-2024-27980: Windows cannot CreateProcess a .cmd, so the spawn asks
    // for a shell and pre-quotes each token itself (cli-process-runner.mjs).
    assert.equal(call.options.shell, true);
    assert.equal(call.command, '"C:\Users\dev\AppData\Roaming\npm\grok.cmd"');
    assert.deepEqual(call.args, ['"login"', '"--device-auth"']);
  } finally {
    harness.cleanup();
  }
});

test('a plain grok binary on win32 still spawns directly, without a shell', async () => {
  const harness = createHarness({
    platform: 'win32',
    env: { GROK_CLI_COMMAND: 'C:\Users\dev\.grok\bin\grok.exe' },
  });
  try {
    harness.service.startLogin();
    const call = harness.calls[0];
    assert.equal(call.options.shell, undefined);
    assert.equal(call.command, 'C:\Users\dev\.grok\bin\grok.exe');
    assert.deepEqual(call.args, ['login', '--device-auth']);
  } finally {
    harness.cleanup();
  }
});
