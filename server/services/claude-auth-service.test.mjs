import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  CLI_SPAWN_DISABLED_ERROR,
  createClaudeAuthService,
  extractAuthUrl,
  hasCodePrompt,
  joinWrappedLines,
  resolveClaudeAuthBinary,
  scrubSecrets,
  stripTerminalEscapes,
} from './claude-auth-service.mjs';

const STUB_BIN = '/opt/claude';
const STUB_URL = 'https://claude.com/oauth/authorize?code=true&client_id=stub-client&code_challenge=Xk3nQ7pLm2vB8sT1wY6zR0aC5dF9gH4jK7lN2oP3qS8&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback';
// The exact shape the CLI prints under a PTY: OSC-8 hyperlink (target + label)
// wrapped in SGR colour codes, then the dim paste prompt.
const LOGIN_BANNER = `Opening browser to sign in…\r\nIf the browser did not open, visit: \x1b]8;;${STUB_URL}\x1b\\\x1b[4;34m${STUB_URL}\x1b[0m\x1b]8;;\x1b\\\r\n`;
const CODE_PROMPT = '\x1b[2mPaste code here if prompted > \x1b[0m';

const LOGGED_IN_STATUS = {
  loggedIn: true,
  authMethod: 'claudeai',
  apiProvider: null,
  email: 'stub@example.com',
  orgId: 'org_stub',
  orgName: 'Stub Org',
  subscriptionType: 'max',
};
const LOGGED_OUT_STATUS = {
  loggedIn: false,
  authMethod: null,
  apiProvider: null,
  email: null,
  orgId: null,
  orgName: null,
  subscriptionType: null,
};

/** Lets the injected promise chains settle without touching the timer seams. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Fake child process: the events the service listens for, plus recorders for
 * everything it writes or signals. Nothing here spawns a real process, so the
 * whole suite runs on every platform (DEVELOPING.md unit-test rules).
 */
function createFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdinWrites = [];
  child.stdinEnded = false;
  child.stdin = new EventEmitter();
  child.stdin.write = (chunk) => { child.stdinWrites.push(String(chunk)); return true; };
  child.stdin.end = () => { child.stdinEnded = true; };
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

/** `script -qec "'/opt/claude' 'auth' 'login'" /dev/null` -> `auth login`. */
function describeSubcommand(command, args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  if (command !== 'script') return list.join(' ');
  return String(list[1] || '')
    .split(' ')
    .slice(1)
    .map((part) => part.replace(/^'|'$/g, ''))
    .join(' ');
}

/**
 * Manual timer seam: the service's timeouts (login expiry, run timeout, SIGKILL
 * escalation) are fired by the test instead of the clock.
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
  status = LOGGED_IN_STATUS,
  autoStatus = true,
  platform = 'linux',
  env = {},
  ...serviceOptions
} = {}) {
  const timers = createManualTimers();
  const calls = [];
  const kills = [];
  const control = { status, autoStatus };
  let nextPid = 4000;

  const spawnImpl = (command, args, options) => {
    const child = createFakeChild((nextPid += 1));
    const call = { command, args, options, child, subcommand: describeSubcommand(command, args) };
    calls.push(call);
    // Answering asynchronously mirrors a real child: the service attaches its
    // listeners after spawn() returns.
    queueMicrotask(() => {
      if (!control.autoStatus || !call.subcommand.startsWith('auth status')) return;
      call.child.emitStdout(`${JSON.stringify(control.status)}\n`);
      call.child.exit(0);
    });
    return child;
  };

  const service = createClaudeAuthService({
    env: { COPILOT_WEB_RELAY_CLAUDE_AUTH_BIN: STUB_BIN, ...env },
    platform,
    spawnImpl,
    processKillImpl: (pid, signal) => { kills.push([pid, signal]); },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    logger: { log() {} },
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
    callsFor: (prefix) => calls.filter((call) => call.subcommand.startsWith(prefix)),
    lastChild: () => calls[calls.length - 1]?.child || null,
    cleanup() { service.dispose(); },
  };
}

/** Drives a harness to the awaiting_code state and returns the login child. */
function startLoginToAwaitingCode(harness) {
  const started = harness.service.startLogin();
  assert.equal(started.ok, true);
  const child = harness.lastChild();
  child.emitStdout(LOGIN_BANNER);
  child.emitStdout(CODE_PROMPT);
  assert.equal(harness.service.getLoginState().state, 'awaiting_code');
  return child;
}

// ─── Pure parsing helpers ────────────────────────────────────────────────────

test('stripTerminalEscapes removes OSC-8 wrappers, SGR codes and PTY carriage returns', () => {
  const raw = 'visit: \x1b]8;;https://claude.com/x\x1b\\\x1b[4;34mhttps://claude.com/x\x1b[0m\x1b]8;;\x1b\\\r\n';
  assert.equal(stripTerminalEscapes(raw), 'visit: https://claude.com/x\n');
});

test('stripTerminalEscapes consumes any OSC sequence, not just hyperlinks', () => {
  // A window-title set (ESC ] 0 ; text BEL) must not leave `0;text` behind for
  // the JSON/prompt parsers.
  assert.equal(stripTerminalEscapes('\x1b]0;claude — auth\x07{"loggedIn":true}'), '{"loggedIn":true}');
  assert.equal(stripTerminalEscapes('\x1b]2;title\x1b\\Paste code here'), 'Paste code here');
});

test('extractAuthUrl prefers the hyperlink target over the visible label', () => {
  const raw = `If the browser did not open, visit: \x1b]8;;${STUB_URL}\x07\x1b[4;34mhttps://claude.com/oauth/aut…\x1b[0m\x1b]8;;\x07\r\n`;
  assert.equal(extractAuthUrl(raw), STUB_URL);
});

test('extractAuthUrl falls back to escape-stripped text when the hyperlink wrapper is gone', () => {
  assert.equal(extractAuthUrl(`\x1b[2mvisit: ${STUB_URL}\x1b[0m\r\n`), STUB_URL);
  assert.equal(extractAuthUrl('nothing to see here'), '');
});

test('extractAuthUrl accepts the other hosts the CLI has printed', () => {
  const claudeAi = 'https://claude.ai/oauth/authorize?code=true&client_id=stub';
  const console_ = 'https://console.anthropic.com/oauth/authorize?code=true';
  assert.equal(extractAuthUrl(`visit: ${claudeAi}\r\n`), claudeAi);
  assert.equal(extractAuthUrl(`\x1b]8;;${console_}\x07label\x1b]8;;\x07`), console_);
  assert.equal(extractAuthUrl('visit: https://evil.example.com/oauth/authorize'), '');
});

test('extractAuthUrl stitches a URL the PTY hard-wrapped at 80 columns', () => {
  const url = `https://claude.com/oauth/authorize?code=true&client_id=stub-client&code_challenge=${'A'.repeat(20)}`;
  const line = `If the browser did not open, visit: ${url}`;
  assert.ok(line.length > 80, 'the fixture must actually wrap');
  const raw = `${line.slice(0, 80)}\n${line.slice(80)}\nPaste code here if prompted > `;
  assert.equal(extractAuthUrl(raw), url);
});

test('extractAuthUrl does not glue the next line onto a URL that simply ended the line', () => {
  // The line is long but not exactly the wrap width, so it ended because the
  // CLI printed a newline: the prompt below it must stay out of the URL.
  const raw = `visit: ${STUB_URL}\nPaste code here if prompted > `;
  assert.equal(extractAuthUrl(raw), STUB_URL);
});

test('joinWrappedLines only stitches full-width lines', () => {
  const full = 'x'.repeat(80);
  assert.equal(joinWrappedLines(`${full}\ntail\nshort\nnext`), `${full}tail\nshort\nnext`);
  assert.equal(joinWrappedLines(`${full}\n more`), `${full}\n more`);
});

test('hasCodePrompt matches the sentinel through the dim SGR wrapper', () => {
  assert.equal(hasCodePrompt(CODE_PROMPT), true);
  assert.equal(hasCodePrompt('Opening browser to sign in…'), false);
});

test('scrubSecrets redacts the submitted code and token-shaped strings', () => {
  const scrubbed = scrubSecrets('rejected code abc123def456 with sk-ant-oat01-deadbeefcafe', 'abc123def456');
  assert.ok(!scrubbed.includes('abc123def456'));
  assert.ok(!scrubbed.includes('sk-ant-oat01-deadbeefcafe'));
  assert.match(scrubbed, /\[redacted\]/);
});

test('resolveClaudeAuthBinary defaults to claude and honours the env seam', () => {
  assert.equal(resolveClaudeAuthBinary({}), 'claude');
  assert.equal(resolveClaudeAuthBinary({ COPILOT_WEB_RELAY_CLAUDE_AUTH_BIN: '/opt/claude' }), '/opt/claude');
});

// ─── Status reads ────────────────────────────────────────────────────────────

test('getStatus runs the CLI without a PTY, parses the JSON and caches within the TTL', async () => {
  const harness = createHarness();
  try {
    const status = await harness.service.getStatus();
    assert.equal(status.ok, true);
    assert.equal(status.loggedIn, true);
    assert.equal(status.email, 'stub@example.com');
    assert.equal(status.subscriptionType, 'max');

    const call = harness.callsFor('auth status')[0];
    assert.equal(call.command, STUB_BIN);
    assert.deepEqual(call.args, ['auth', 'status', '--json']);
    assert.equal(call.options.stdio[0], 'ignore');

    harness.control.status = LOGGED_OUT_STATUS;
    assert.equal((await harness.service.getStatus()).loggedIn, true, 'cached inside the TTL');
    assert.equal(harness.callsFor('auth status').length, 1);

    assert.equal((await harness.service.getStatus({ force: true })).loggedIn, false);
    assert.equal(harness.callsFor('auth status').length, 2);
    assert.equal(harness.service.getCachedStatus().loggedIn, false);
  } finally {
    harness.cleanup();
  }
});

test('getStatus reports a failed probe as ok:false instead of rejecting', async () => {
  const harness = createHarness({ autoStatus: false });
  try {
    const pending = harness.service.getStatus();
    await flush();
    const child = harness.callsFor('auth status')[0].child;
    child.emitStderr('claude: not logged in\n');
    child.exit(1);
    const status = await pending;
    assert.equal(status.ok, false);
    assert.equal(status.loggedIn, false);
    assert.match(status.error, /not logged in/);
  } finally {
    harness.cleanup();
  }
});

test('a forced read never adopts an in-flight probe that started before it', async () => {
  const harness = createHarness({ autoStatus: false });
  try {
    const cached = harness.service.getStatus();
    await flush();
    const probes = harness.callsFor('auth status');
    assert.equal(probes.length, 1);

    // The login/logout that prompts the force happens here, mid-probe.
    const forced = harness.service.getStatus({ force: true });
    assert.equal(harness.callsFor('auth status').length, 1, 'the second spawn waits for the first');

    probes[0].child.emitStdout(`${JSON.stringify(LOGGED_OUT_STATUS)}\n`);
    probes[0].child.exit(0);
    assert.equal((await cached).loggedIn, false);

    await flush();
    const second = harness.callsFor('auth status')[1];
    assert.ok(second, 'the forced read starts its own probe');
    second.child.emitStdout(`${JSON.stringify(LOGGED_IN_STATUS)}\n`);
    second.child.exit(0);
    assert.equal((await forced).loggedIn, true);
  } finally {
    harness.cleanup();
  }
});

test('a non-forced read joins the probe already running', async () => {
  const harness = createHarness({ autoStatus: false });
  try {
    const first = harness.service.getStatus();
    const second = harness.service.getStatus();
    await flush();
    assert.equal(harness.callsFor('auth status').length, 1);
    const child = harness.callsFor('auth status')[0].child;
    child.emitStdout(`${JSON.stringify(LOGGED_IN_STATUS)}\n`);
    child.exit(0);
    assert.equal(await first, await second);
  } finally {
    harness.cleanup();
  }
});

// ─── Login state machine ─────────────────────────────────────────────────────

test('login runs under a PTY, scrapes the URL through the escapes and hands the code to stdin', async () => {
  const harness = createHarness({ autoStatus: false });
  try {
    const child = startLoginToAwaitingCode(harness);
    const call = harness.calls[0];
    assert.equal(call.command, 'script');
    assert.deepEqual(call.args, ['-qec', `'${STUB_BIN}' 'auth' 'login'`, '/dev/null']);
    assert.equal(call.options.detached, true);
    assert.equal(harness.service.getLoginState().authUrl, STUB_URL);

    const submitted = harness.service.submitCode('  goodcode  ');
    assert.equal(submitted.ok, true);
    assert.equal(submitted.login.state, 'exchanging');
    assert.deepEqual(child.stdinWrites, ['goodcode\n']);

    child.exit(0);
    // Success is published immediately: the confirming status read has not even
    // been answered yet.
    assert.equal(harness.service.getLoginState().state, 'success');
    assert.equal(harness.service.getLoginState().active, false);
    assert.deepEqual(harness.stateNames(), ['starting', 'awaiting_code', 'exchanging', 'success']);

    await flush();
    const probe = harness.callsFor('auth status')[0];
    assert.ok(probe, 'the login success forces a status refresh');
    probe.child.emitStdout(`${JSON.stringify(LOGGED_IN_STATUS)}\n`);
    probe.child.exit(0);
    await flush();
    // The refreshed status is re-broadcast under the same login state.
    assert.deepEqual(harness.stateNames(), ['starting', 'awaiting_code', 'exchanging', 'success', 'success']);
    assert.equal(harness.service.getCachedStatus().loggedIn, true);
  } finally {
    harness.cleanup();
  }
});

test('success hooks run after the status refresh lands', async () => {
  const harness = createHarness();
  const hookCalls = [];
  try {
    harness.service.onLoginSuccess(() => { hookCalls.push('refresh'); });
    const child = startLoginToAwaitingCode(harness);
    harness.service.submitCode('goodcode');
    child.exit(0);
    assert.deepEqual(hookCalls, [], 'not before the refresh');
    await flush();
    await flush();
    assert.deepEqual(hookCalls, ['refresh']);
  } finally {
    harness.cleanup();
  }
});

test('a login started during the post-success refresh is not clobbered by the old one', async () => {
  const harness = createHarness({ autoStatus: false });
  const hookCalls = [];
  try {
    harness.service.onLoginSuccess(() => { hookCalls.push('refresh'); });
    const child = startLoginToAwaitingCode(harness);
    harness.service.submitCode('goodcode');
    child.exit(0);
    assert.equal(harness.service.getLoginState().state, 'success');

    // A second login begins while the confirming status read is still running.
    harness.service.startLogin();
    assert.equal(harness.service.getLoginState().state, 'starting');
    await flush();
    const probe = harness.callsFor('auth status')[0];
    probe.child.emitStdout(`${JSON.stringify(LOGGED_IN_STATUS)}\n`);
    probe.child.exit(0);
    await flush();

    assert.equal(harness.service.getLoginState().state, 'starting', 'the stale success stays buried');
    assert.deepEqual(hookCalls, [], 'and its hooks do not fire mid-login');
  } finally {
    harness.cleanup();
  }
});

test('a rejected code ends the session in error with a scrubbed message', async () => {
  const harness = createHarness();
  try {
    const child = startLoginToAwaitingCode(harness);
    harness.service.submitCode('wrongcode-0123456789abcdef');
    child.emitStderr('\nOAuth error: invalid_grant - the authorization code is invalid or has expired.\n');
    child.exit(1);

    const failed = harness.service.getLoginState();
    assert.equal(failed.state, 'error');
    assert.match(failed.error, /invalid_grant/);
    assert.ok(!failed.error.includes('wrongcode-0123456789abcdef'));
    assert.equal(failed.active, false);

    // The session is released, so a fresh attempt is allowed.
    assert.equal(harness.service.startLogin().reused, false);
  } finally {
    harness.cleanup();
  }
});

test('a login that dies before a code was submitted reports the tail', async () => {
  const harness = createHarness();
  try {
    harness.service.startLogin();
    const child = harness.lastChild();
    child.emitStderr('claude: command not found\n');
    child.exit(127);
    const failed = harness.service.getLoginState();
    assert.equal(failed.state, 'error');
    assert.match(failed.error, /before a code was submitted \(code 127\)/);
    assert.match(failed.error, /command not found/);
  } finally {
    harness.cleanup();
  }
});

test('submitCode is refused when no login is awaiting a code', async () => {
  const harness = createHarness();
  try {
    const idle = harness.service.submitCode('goodcode');
    assert.equal(idle.ok, false);
    assert.equal(idle.statusCode, 409);

    harness.service.startLogin();
    assert.equal(harness.service.submitCode('goodcode').statusCode, 409, 'still starting');

    harness.lastChild().emitStdout(LOGIN_BANNER);
    assert.equal(harness.service.submitCode('  ').statusCode, 400);
    assert.equal(harness.service.submitCode('a\nb').statusCode, 400);
    assert.equal(harness.service.submitCode('x'.repeat(5000)).statusCode, 400);
  } finally {
    harness.cleanup();
  }
});

test('startLogin is single-flight: a second call joins the running session', async () => {
  const harness = createHarness();
  try {
    startLoginToAwaitingCode(harness);
    const second = harness.service.startLogin();
    assert.equal(second.reused, true);
    assert.equal(second.login.authUrl, STUB_URL);
    assert.equal(second.login.state, 'awaiting_code');
    assert.equal(harness.calls.length, 1, 'no second CLI process');
  } finally {
    harness.cleanup();
  }
});

test('cancel signals the whole process group and returns to idle', async () => {
  const harness = createHarness();
  try {
    const child = startLoginToAwaitingCode(harness);
    const cancelled = harness.service.cancel();
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.login.state, 'idle');
    assert.equal(cancelled.login.authUrl, null);
    assert.equal(cancelled.login.active, false);
    assert.deepEqual(harness.kills, [[-child.pid, 'SIGTERM']]);
  } finally {
    harness.cleanup();
  }
});

test('the SIGKILL escalation survives the session release', async () => {
  const harness = createHarness();
  try {
    const child = startLoginToAwaitingCode(harness);
    harness.service.cancel();
    assert.ok(harness.timers.delays().includes(2000), 'the escalation timer is still armed');
    harness.timers.fire(2000);
    assert.deepEqual(harness.kills, [[-child.pid, 'SIGTERM'], [-child.pid, 'SIGKILL']]);

    // Once the child is gone the escalation is a no-op.
    harness.kills.length = 0;
    const second = startLoginToAwaitingCode(harness);
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
    const first = startLoginToAwaitingCode(harness);
    harness.service.cancel();
    const second = startLoginToAwaitingCode(harness);
    assert.notEqual(first, second);

    // The killed process finally reports in.
    first.exit(143);

    const state = harness.service.getLoginState();
    assert.equal(state.state, 'awaiting_code');
    assert.equal(state.active, true, 'the newer session is still owned');
    assert.equal(harness.timers.delays().filter((ms) => ms === 600_000).length, 1,
      'the newer session keeps its login timeout');
    assert.equal(harness.service.submitCode('goodcode').ok, true);
    assert.deepEqual(second.stdinWrites, ['goodcode\n']);
  } finally {
    harness.cleanup();
  }
});

test('cancel also clears a terminal error state', async () => {
  const harness = createHarness();
  try {
    const child = startLoginToAwaitingCode(harness);
    harness.service.submitCode('badcode');
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
    const child = startLoginToAwaitingCode(harness);
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

test('a stdin write failure fails the session instead of throwing', async () => {
  const harness = createHarness();
  try {
    const child = startLoginToAwaitingCode(harness);
    child.stdin.write = () => { throw new Error('EPIPE'); };
    const result = harness.service.submitCode('goodcode');
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 500);
    assert.match(harness.service.getLoginState().error, /EPIPE/);
  } finally {
    harness.cleanup();
  }
});

test('an async stdin error event is absorbed, not thrown as an unhandled error', async () => {
  const harness = createHarness();
  try {
    const child = startLoginToAwaitingCode(harness);
    assert.equal(child.stdin.listenerCount('error'), 1);
    child.stdin.emit('error', new Error('write EPIPE'));
    assert.equal(harness.service.getLoginState().state, 'awaiting_code');
  } finally {
    harness.cleanup();
  }
});

// ─── Logout ──────────────────────────────────────────────────────────────────

test('logout runs the CLI once, force-refreshes the status and returns to idle', async () => {
  const harness = createHarness();
  try {
    await harness.service.getStatus();
    harness.control.status = LOGGED_OUT_STATUS;

    const pending = harness.service.logout();
    await flush();
    const logoutCall = harness.callsFor('auth logout')[0];
    assert.equal(logoutCall.command, 'script');
    logoutCall.child.emitStdout('Logged out.\n');
    logoutCall.child.exit(0);

    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.status.loggedIn, false, 'the returned status is post-logout');
    assert.equal(harness.callsFor('auth status').length, 2, 'one probe before, one after');
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
    startLoginToAwaitingCode(harness);
    const refused = await harness.service.logout();
    assert.equal(refused.ok, false);
    assert.equal(refused.statusCode, 409);
    assert.match(refused.error, /login is in progress/i);
    assert.equal(harness.callsFor('auth logout').length, 0);
  } finally {
    harness.cleanup();
  }
});

test('a failing logout reports the scrubbed tail with the refreshed status', async () => {
  const harness = createHarness();
  try {
    const pending = harness.service.logout();
    await flush();
    const call = harness.callsFor('auth logout')[0];
    call.child.emitStderr('logout failed: token sk-ant-oat01-deadbeefcafe rejected\n');
    call.child.exit(1);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 500);
    assert.ok(!result.error.includes('sk-ant-oat01-deadbeefcafe'));
    assert.match(result.error, /logout failed/);
    assert.ok(result.status, 'the caller still gets a status payload');
  } finally {
    harness.cleanup();
  }
});

// ─── Kill switch ─────────────────────────────────────────────────────────────

test('every spawn path refuses when the relay runs with CLI spawns disabled', async () => {
  const harness = createHarness({ env: { COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1' } });
  try {
    const status = await harness.service.getStatus();
    assert.equal(status.ok, false);
    assert.equal(status.error, CLI_SPAWN_DISABLED_ERROR);
    assert.equal(status.loggedIn, false);

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

  // The e2e harness keeps the kill switch on (no real workers) but still needs
  // to drive the auth flow against the injected stub binary. The opt-in only
  // counts together with an explicit binary override.
  const flagOnly = createHarness({
    env: {
      COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1',
      COPILOT_WEB_RELAY_CLAUDE_AUTH_ALLOW_STUB_SPAWN: '1',
      COPILOT_WEB_RELAY_CLAUDE_AUTH_BIN: '',
    },
  });
  try {
    const status = await flagOnly.service.getStatus();
    assert.equal(status.error, CLI_SPAWN_DISABLED_ERROR, 'no stub path: still refused');
    assert.deepEqual(flagOnly.calls, []);
  } finally {
    flagOnly.cleanup();
  }

  const stubbed = createHarness({
    env: {
      COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1',
      COPILOT_WEB_RELAY_CLAUDE_AUTH_ALLOW_STUB_SPAWN: '1',
    },
  });
  try {
    const status = await stubbed.service.getStatus();
    assert.equal(status.ok, true, 'flag + stub binary spawns the stub');
    assert.equal(status.email, 'stub@example.com');
    assert.equal(stubbed.callsFor('auth status').length, 1);
  } finally {
    stubbed.cleanup();
  }
});

// ─── Windows fallbacks ───────────────────────────────────────────────────────

test('on Windows the CLI is spawned directly instead of through script', async () => {
  const harness = createHarness({ platform: 'win32' });
  try {
    harness.service.startLogin();
    const call = harness.calls[0];
    assert.equal(call.command, STUB_BIN);
    assert.deepEqual(call.args, ['auth', 'login']);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.detached, undefined);

    await harness.service.getStatus();
    const statusCall = harness.callsFor('auth status')[0];
    assert.equal(statusCall.command, STUB_BIN);
    assert.equal(statusCall.options.windowsHide, true);
  } finally {
    harness.cleanup();
  }
});

test('on Windows the kill falls back to the child handle, not the process group', async () => {
  const harness = createHarness({ platform: 'win32' });
  try {
    const child = startLoginToAwaitingCode(harness);
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
  const child = startLoginToAwaitingCode(harness);
  const before = harness.states.length;
  harness.service.dispose();
  assert.deepEqual(harness.kills, [[-child.pid, 'SIGTERM']]);
  child.exit(143);
  assert.equal(harness.states.length, before, 'no listener fires after dispose');
});
