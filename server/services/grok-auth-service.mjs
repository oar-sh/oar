'use strict';
import { spawn } from 'child_process';

// The mechanical spawn plumbing — escape stripping, secret scrubbing, the
// process-group kill, the run-to-completion wrapper — is shared with the Claude
// auth service and the CLI install service. One implementation, so the two auth
// paths cannot drift apart in what they scrub or how hard they kill.
import {
  CLI_SPAWN_DISABLED_ERROR,
  MAX_CAPTURED_OUTPUT_CHARS,
  killTree as killProcessTree,
  runToCompletion as runProcessToCompletion,
  scrubSecrets,
  stripTerminalEscapes,
  tailOf,
} from './cli-process-runner.mjs';
import { createGrokBillingUsageFetcher, readGrokCliAuthKey } from './grok-billing-usage.mjs';

/**
 * Grok CLI auth (status / login / logout) driven from the relay.
 *
 * Probed live against Grok Build 1.0.13 (2026-08-31), and that probe is why
 * this file is so much shorter than claude-auth-service.mjs: `grok login
 * --device-auth` needs no pseudo-TTY (plain piped stdio, stdin ignorable) and
 * the user never pastes anything back — the code rides inside the URL, the CLI
 * polls x.ai itself and exits 0 once the browser authorises. So there is no
 * `exchanging` state, no `submitCode()`, and no `script -qec` harness here.
 *
 *   idle -> starting -> awaiting_authorization -> success
 *                              |
 *                              +-- cancel/timeout, error (non-zero exit, dead
 *                                  process) --> session released
 *
 * `success` and `error` are terminal *display* states, exactly as in the Claude
 * service: the session is already released (a new `startLogin()` may begin,
 * `logout()` is allowed again) but the outcome stays readable until the next
 * start or `cancel()` resets it to idle.
 *
 * Status has no command to run. There is no `grok auth status`, and `grok
 * models` prints "You are not authenticated." while still exiting 0, so the exit
 * code carries nothing. The authoritative signal is `~/.grok/auth.json`, which
 * grok-billing-usage.mjs already reads for the usage card — reused here rather
 * than reimplemented, so both surfaces agree on what "logged in" means.
 *
 * No Grok secret transits the relay: the device `user_code` is public by design
 * (it is printed on the terminal and typed into a browser), and the token is
 * written by the CLI straight into `~/.grok/auth.json` (0600). The bearer key
 * read for the billing label never leaves this module.
 */

export const GROK_AUTH_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
export const GROK_AUTH_STATUS_TTL_MS = 5_000;
const GROK_AUTH_LOGOUT_TIMEOUT_MS = 60_000;
const KILL_ESCALATION_MS = 2_000;

// The device-authorisation endpoint, pinned to the host the CLI actually
// prints. Unlike Claude's authorize URL this one has never moved, and pinning
// it keeps a stray link in some future banner from being offered as the sign-in
// target.
const DEVICE_URL_PATTERN = /https:\/\/accounts\.x\.ai\/oauth2\/device\S*/;
// `user_code=D7SV-M4TR` inside that URL — the authoritative copy of the code.
// `%` is in the class so a percent-encoded separator survives to decodeURIComponent().
const DEVICE_URL_CODE_PATTERN = /[?&]user_code=([A-Za-z0-9][A-Za-z0-9%-]*)/;
// The same code printed on its own line under "Confirm this code in your
// browser:", used only when a future release stops putting it in the URL.
const DEVICE_CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;

const LOGIN_STATES = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  AWAITING_AUTHORIZATION: 'awaiting_authorization',
  SUCCESS: 'success',
  ERROR: 'error',
});

export const GROK_AUTH_LOGIN_STATES = LOGIN_STATES;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function toIso(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Escape-stripped output truncated to its last line break.
 *
 * Both scrapes run against a growing buffer of arbitrary stdout chunks, and the
 * first hit wins for the rest of the session — so a chunk boundary landing
 * mid-URL would otherwise latch a truncated link the user cannot open and the
 * state machine never revises. Only completed lines are ever scanned; the URL
 * and the code each sit alone on one, so nothing is lost by waiting for the
 * newline that follows them.
 */
function completedLines(rawOutput) {
  const visible = stripTerminalEscapes(rawOutput);
  const lastBreak = visible.lastIndexOf('\n');
  return lastBreak < 0 ? '' : visible.slice(0, lastBreak + 1);
}

/**
 * Pulls the device-authorisation URL out of raw CLI output.
 *
 * Simpler than the Claude equivalent because there is no PTY: the CLI prints
 * the URL on one unwrapped line with no OSC-8 hyperlink wrapper, so escape
 * stripping (for the one `\x1b[90m…\x1b[0m` warning line) plus a single match is
 * the whole job — no hard-wrap rejoining. Returns '' rather than throwing when
 * the banner changes shape; the panel then degrades to the raw output tail
 * (plan §9, risk row 2).
 */
export function extractDeviceAuthUrl(rawOutput) {
  const match = completedLines(rawOutput).match(DEVICE_URL_PATTERN);
  return match ? match[0] : '';
}

/**
 * The `XXXX-XXXX` device code, preferred from the URL's `user_code` parameter
 * (that is the copy the browser will compare against) and falling back to the
 * bare line the CLI prints below it.
 */
export function extractDeviceCode(rawOutput) {
  const visible = completedLines(rawOutput);
  const url = visible.match(DEVICE_URL_PATTERN);
  const fromUrl = url && url[0].match(DEVICE_URL_CODE_PATTERN);
  if (fromUrl) {
    try {
      return decodeURIComponent(fromUrl[1]);
    } catch {
      return fromUrl[1];
    }
  }
  const bare = visible.match(DEVICE_CODE_PATTERN);
  return bare ? bare[1] : '';
}

/**
 * Same override chain the Grok session worker (grok-session-worker.mjs:48) and
 * the model-discovery probe (server-runtime.mjs:1110) use, so auth and turn
 * execution can never end up addressing two different binaries.
 */
export function resolveGrokAuthBinary(env = process.env) {
  return normalizeText(env?.GROK_CLI_COMMAND) || normalizeText(env?.GROK_COMMAND) || 'grok';
}

export function createGrokAuthService({
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  processKillImpl = process.kill.bind(process),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  now = () => Date.now(),
  logger = console,
  readAuthKeyImpl = readGrokCliAuthKey,
  fetchBillingImpl = createGrokBillingUsageFetcher(),
  loginTimeoutMs = GROK_AUTH_LOGIN_TIMEOUT_MS,
  statusTtlMs = GROK_AUTH_STATUS_TTL_MS,
  logoutTimeoutMs = GROK_AUTH_LOGOUT_TIMEOUT_MS,
} = {}) {
  const listeners = new Set();
  const successHooks = new Set();
  const login = {
    state: LOGIN_STATES.IDLE,
    authUrl: '',
    userCode: '',
    error: '',
    startedAt: null,
  };
  let session = null;
  // Bumped by every startLogin/cancel so a slow post-success continuation can
  // tell whether it still owns the visible login state.
  let loginGeneration = 0;
  let statusCache = null;
  let statusInFlight = null;
  // Serialises status reads: a forced read never joins an older in-flight one
  // (it could predate the login/logout that prompted the force), but it waits
  // for it rather than racing a second billing fetch.
  let statusChain = Promise.resolve();

  const log = (message) => {
    try { logger?.log?.(`[grok-auth] ${message}`); } catch {}
  };

  function loginSnapshot() {
    return {
      state: login.state,
      authUrl: login.authUrl || null,
      userCode: login.userCode || null,
      error: login.error || null,
      startedAt: login.startedAt || null,
      active: Boolean(session),
    };
  }

  function emitState() {
    const snapshot = loginSnapshot();
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch (error) { log(`listener failed: ${error?.message || error}`); }
    }
  }

  function setLoginState(nextState, { authUrl, userCode, error } = {}) {
    login.state = nextState;
    if (authUrl !== undefined) login.authUrl = authUrl || '';
    if (userCode !== undefined) login.userCode = userCode || '';
    if (error !== undefined) login.error = error || '';
    emitState();
  }

  function cliSpawnsDisabled() {
    // Same kill switch (and same truthiness rule) as
    // session-worker-launch-service.mjs and the Claude auth service: a relay
    // started with it must never run a real CLI — including `grok logout`, which
    // would sign the developer's own host out.
    if (!String(env?.COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN || '').trim()) return false;
    // Narrow escape hatch for the e2e harness, which keeps the kill switch on
    // (no real workers) but still drives the whole auth flow. Both halves are
    // required: the opt-in flag AND an explicit binary override, so "spawns
    // disabled" can never end up running the host's real `grok`.
    return !(
      String(env?.COPILOT_WEB_RELAY_GROK_AUTH_ALLOW_STUB_SPAWN || '').trim()
      && (String(env?.GROK_CLI_COMMAND || '').trim() || String(env?.GROK_COMMAND || '').trim())
    );
  }

  /**
   * The billing proxy is the only outbound network call in this module, and it
   * is purely cosmetic (the plan label). The kill switch that blocks CLI spawns
   * blocks it too — including through the stub escape hatch, which exists so a
   * test relay can drive the flow *without* reaching x.ai.
   */
  function outboundProbesDisabled() {
    return Boolean(String(env?.COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN || '').trim());
  }

  /**
   * The single spawn site for every auth subcommand. No PTY anywhere: probed
   * live, `login --device-auth` runs happily on plain pipes with stdin closed,
   * and `logout` is non-interactive.
   */
  function spawnGrokProcess(args) {
    if (cliSpawnsDisabled()) throw new Error(CLI_SPAWN_DISABLED_ERROR);
    const bin = resolveGrokAuthBinary(env);
    return spawnImpl(bin, args, {
      // stdin is never written to, so it is closed outright rather than left as
      // a pipe nothing ever drains.
      stdio: ['ignore', 'pipe', 'pipe'],
      // A plain copy of the relay environment: HOME (and any GROK_* overrides)
      // come along, so login/logout address the same `~/.grok` root the workers
      // and the usage card read.
      env: { ...env },
      windowsHide: true,
      // POSIX only: its own process group, so cancel()/dispose() can signal the
      // polling CLI and anything it spawned in one shot. Windows has no
      // equivalent here, so killTree() falls back to the child handle.
      ...(platform === 'win32' ? {} : { detached: true }),
    });
  }

  const killTree = (child, signal) => killProcessTree(child, signal, { platform, processKillImpl });

  /** One-shot subcommands (`logout`); the login session drives its own child. */
  function runGrokCommand(args, { timeoutMs } = {}) {
    return runProcessToCompletion(() => spawnGrokProcess(args), {
      timeoutMs,
      setTimeoutImpl,
      clearTimeoutImpl,
      killChild: killTree,
    });
  }

  /**
   * `ok` reports that the account state was *determined*, not that anyone is
   * signed in — reading the auth store cannot fail in a way this module could
   * report, so the only `ok:false` payload in the system is the route module's
   * pre-first-read placeholder.
   */
  function loggedOutStatus() {
    return {
      ok: true,
      loggedIn: false,
      expiresAt: null,
      expired: false,
      plan: null,
      usagePercent: null,
      periodType: null,
      periodEnd: null,
      error: null,
      checkedAt: new Date(now()).toISOString(),
    };
  }

  async function fetchStatus() {
    // readGrokCliAuthKey() never throws and cannot tell "no file" from
    // "unreadable file" apart — both mean the relay has no usable Grok login,
    // which is exactly what the account row needs to say.
    let auth = null;
    try {
      auth = readAuthKeyImpl();
    } catch (error) {
      log(`auth store read failed: ${error?.message || error}`);
      auth = null;
    }
    if (!auth?.key) return loggedOutStatus();

    const expiresAt = toIso(auth.expiresAt);
    // The CLI rotates the key every few hours and refreshes it in place, so an
    // elapsed expiry is a "may need to sign in again" hint, not a logged-out
    // verdict — the row still reads as signed in.
    const expired = Boolean(expiresAt && Date.parse(expiresAt) <= now());

    let billing = null;
    if (!outboundProbesDisabled() && typeof fetchBillingImpl === 'function') {
      try {
        billing = await fetchBillingImpl();
      } catch (error) {
        // The fetcher already degrades to null; this only catches a broken seam.
        log(`billing probe failed: ${error?.message || error}`);
        billing = null;
      }
    }
    const products = Array.isArray(billing?.products) ? billing.products : [];
    return {
      ok: true,
      loggedIn: true,
      expiresAt,
      expired,
      // The proxy payload names the *product* ("GrokBuild"), not the
      // subscription tier — nothing the relay can read exposes the tier — so the
      // label is offered only when there is exactly one product to name, and the
      // UI composes the rest of the row from usagePercent/periodType.
      plan: products.length === 1 ? (products[0]?.product || null) : null,
      usagePercent: Number.isFinite(billing?.usagePercent) ? billing.usagePercent : null,
      periodType: billing?.periodType || null,
      periodEnd: billing?.periodEnd || null,
      error: null,
      checkedAt: new Date(now()).toISOString(),
    };
  }

  async function getStatus({ force = false } = {}) {
    if (!force && statusCache && !statusCache.stale && (now() - statusCache.at) < statusTtlMs) {
      return statusCache.value;
    }
    // A non-forced caller is happy with whatever read is already running; a
    // forced one is not (that read may have started before the login or logout
    // it is meant to observe), so it queues its own behind it.
    if (statusInFlight && !force) return statusInFlight;
    const pending = statusChain
      .then(() => fetchStatus())
      .then((value) => {
        statusCache = { at: now(), value, stale: false };
        return value;
      });
    statusChain = pending.then(() => {}, () => {});
    statusInFlight = pending;
    pending.then(
      () => { if (statusInFlight === pending) statusInFlight = null; },
      () => { if (statusInFlight === pending) statusInFlight = null; },
    );
    return pending;
  }

  /** Last status read, without ever touching the auth store or the network. */
  function getCachedStatus() {
    return statusCache ? statusCache.value : null;
  }

  /**
   * Keeps the last-known value readable (broadcasts render it) while forcing the
   * next `getStatus()` to re-read the auth store.
   */
  function invalidateStatusCache() {
    if (statusCache) statusCache.stale = true;
  }

  /**
   * Drops the session's timers and, when it is still the current one, the
   * module-level handle. A late `close` from an already-settled session must
   * never tear down a newer session started in the meantime.
   */
  function releaseSession(owner = null) {
    const current = owner || session;
    if (!current) return;
    if (current.timeoutTimer) clearTimeoutImpl(current.timeoutTimer);
    current.timeoutTimer = null;
    if (session === current) session = null;
  }

  function terminateSession(current, { signal = 'SIGTERM' } = {}) {
    const child = current?.child;
    if (!child) return;
    killTree(child, signal);
    // Deliberately not stored on the session: releaseSession() runs immediately
    // after most terminate calls, so a session-owned timer would be cleared
    // before it could escalate and a SIGTERM-ignoring CLI would live forever.
    // Unref'd and closed over the child, so it is a no-op once the child exits.
    const escalation = setTimeoutImpl(() => killTree(child, 'SIGKILL'), KILL_ESCALATION_MS);
    escalation?.unref?.();
  }

  function failSession(current, message) {
    if (!current || current.settled) return;
    current.settled = true;
    terminateSession(current);
    const scrubbed = scrubSecrets(message);
    releaseSession(current);
    invalidateStatusCache();
    setLoginState(LOGIN_STATES.ERROR, { error: scrubbed || 'Grok login failed' });
  }

  async function succeedSession(current) {
    if (!current || current.settled) return;
    current.settled = true;
    releaseSession(current);
    invalidateStatusCache();
    // Success is published before the confirming status read: that read hits the
    // billing proxy (up to its own timeout), and the UI must not sit on
    // "awaiting authorization" while it runs.
    const generation = loginGeneration;
    setLoginState(LOGIN_STATES.SUCCESS, { error: '' });
    try {
      await getStatus({ force: true });
    } catch (error) {
      log(`status refresh after login failed: ${error?.message || error}`);
    }
    if (generation !== loginGeneration) {
      // A new login (or a cancel) took over while the status read ran; its own
      // outcome owns the state and the hooks now.
      log('skipping post-login refresh broadcast: a newer login session took over');
      return;
    }
    // Re-broadcast the unchanged login state so subscribers pick up the fresh
    // status that just landed in the cache.
    emitState();
    for (const hook of [...successHooks]) {
      try { await hook(); } catch (error) { log(`post-login hook failed: ${error?.message || error}`); }
    }
  }

  function handleLoginOutput(current, chunk) {
    const text = chunk.toString();
    current.rawOutput = `${current.rawOutput}${text}`.slice(-MAX_CAPTURED_OUTPUT_CHARS);
    // Nothing secret is ever printed by this flow — the device code is public by
    // design and the token goes straight to disk — so the whole transcript is
    // loggable, unlike the Claude login's post-exchange output.
    const visible = stripTerminalEscapes(text).trim();
    if (visible) log(`login: ${visible.replace(/\s+/g, ' ').slice(0, 300)}`);
    if (current.settled) return;
    if (login.authUrl && login.userCode) return;
    const authUrl = login.authUrl || extractDeviceAuthUrl(current.rawOutput);
    if (!authUrl) return;
    const userCode = login.userCode || extractDeviceCode(current.rawOutput);
    if (authUrl === login.authUrl && userCode === login.userCode) return;
    setLoginState(LOGIN_STATES.AWAITING_AUTHORIZATION, { authUrl, userCode, error: '' });
  }

  function startLogin() {
    if (session) {
      // Idempotent: a second Sign in press (or a second browser tab) joins the
      // session already in flight rather than requesting a second device code
      // and leaving the user two codes to choose between.
      return { ok: true, login: loginSnapshot(), reused: true };
    }
    const startedAt = new Date(now()).toISOString();
    let child = null;
    try {
      child = spawnGrokProcess(['login', '--device-auth']);
    } catch (error) {
      loginGeneration += 1;
      setLoginState(LOGIN_STATES.ERROR, {
        authUrl: '',
        userCode: '',
        error: scrubSecrets(error?.message || String(error)),
      });
      return { ok: false, error: login.error, login: loginSnapshot() };
    }
    const current = {
      child,
      rawOutput: '',
      settled: false,
      timeoutTimer: null,
    };
    session = current;
    loginGeneration += 1;
    login.startedAt = startedAt;
    setLoginState(LOGIN_STATES.STARTING, { authUrl: '', userCode: '', error: '' });

    current.timeoutTimer = setTimeoutImpl(() => {
      failSession(current, `Grok login timed out after ${Math.round(loginTimeoutMs / 1000)}s`);
    }, loginTimeoutMs);
    current.timeoutTimer?.unref?.();

    child.stdout?.on?.('data', (chunk) => handleLoginOutput(current, chunk));
    child.stderr?.on?.('data', (chunk) => handleLoginOutput(current, chunk));
    child.on('error', (error) => failSession(current, error?.message || String(error)));
    child.on('close', (code) => {
      if (current.settled) {
        releaseSession(current);
        return;
      }
      // The CLI polls x.ai itself and exits 0 only once the browser has
      // authorised, so the exit code *is* the outcome — there is no submitted
      // code to cross-check the way the Claude flow has to.
      if (code === 0) {
        void succeedSession(current);
        return;
      }
      const tail = tailOf(stripTerminalEscapes(current.rawOutput));
      failSession(current, tail
        ? `Grok login exited with code ${code}: ${tail}`
        : `Grok login exited with code ${code}`);
    });
    return { ok: true, login: loginSnapshot(), reused: false };
  }

  function cancel() {
    const current = session;
    loginGeneration += 1;
    if (current) {
      current.settled = true;
      terminateSession(current);
      releaseSession(current);
    }
    // Also the "dismiss the terminal state" path for the UI. Aborting mid-poll
    // is safe: the probe confirmed `~/.grok/auth.json` is still absent after a
    // SIGINT, so a cancelled login leaves no half-written credential behind.
    login.startedAt = null;
    setLoginState(LOGIN_STATES.IDLE, { authUrl: '', userCode: '', error: '' });
    return { ok: true, login: loginSnapshot() };
  }

  async function logout() {
    if (session) {
      return { ok: false, statusCode: 409, error: 'A Grok login is in progress; cancel it first' };
    }
    const result = await runGrokCommand(['logout'], { timeoutMs: logoutTimeoutMs });
    const visible = stripTerminalEscapes(result.output);
    invalidateStatusCache();
    const status = await getStatus({ force: true });
    if (!result.ok) {
      return {
        ok: false,
        statusCode: 500,
        error: scrubSecrets(result.error || tailOf(visible) || `grok logout exited with code ${result.code}`),
        status,
      };
    }
    login.startedAt = null;
    // The status cache is fresh at this point, so the IDLE broadcast subscribers
    // build carries the post-logout account state without a second read.
    setLoginState(LOGIN_STATES.IDLE, { authUrl: '', userCode: '', error: '' });
    return { ok: true, status };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function onLoginSuccess(hook) {
    if (typeof hook !== 'function') return () => {};
    successHooks.add(hook);
    return () => successHooks.delete(hook);
  }

  function dispose() {
    const current = session;
    if (current) {
      current.settled = true;
      loginGeneration += 1;
      terminateSession(current);
      releaseSession(current);
    }
    listeners.clear();
    successHooks.clear();
  }

  return {
    getStatus,
    getCachedStatus,
    getLoginState: loginSnapshot,
    startLogin,
    cancel,
    logout,
    subscribe,
    onLoginSuccess,
    dispose,
  };
}
