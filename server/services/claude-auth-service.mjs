'use strict';
import { spawn } from 'child_process';

/**
 * Claude CLI auth (status / login / logout) driven from the relay.
 *
 * The CLI's `auth login` prints an OAuth authorize URL and then blocks reading
 * the pasted code from a TTY, so it runs under the same `script` pseudo-TTY
 * trick the Copilot worker uses (session-worker-launch-service.mjs:407);
 * `script` forwards our pipe stdin into the PTY, so writing `code + "\n"` to
 * the child's stdin reaches the prompt.
 *
 * One login session at a time, relay-wide:
 *
 *   idle -> starting -> awaiting_code -> exchanging -> success
 *                            |               |
 *                            +-- cancel/timeout, error (rejected code / dead
 *                                process) --> session released
 *
 * `success` and `error` are terminal *display* states: the session is already
 * released (a new `startLogin()` may begin, `logout()` is allowed again) but the
 * outcome stays readable until the next start or `cancel()` resets it to idle.
 */

export const CLAUDE_AUTH_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
export const CLAUDE_AUTH_STATUS_TTL_MS = 5_000;
const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 20_000;
const CLAUDE_AUTH_LOGOUT_TIMEOUT_MS = 60_000;
const KILL_ESCALATION_MS = 2_000;
const MAX_CAPTURED_OUTPUT_CHARS = 16_000;
const MAX_ERROR_TAIL_CHARS = 600;
const MAX_CODE_LENGTH = 4_096;

/** Refusal used by every spawn path when the relay runs with CLI spawns off. */
export const CLI_SPAWN_DISABLED_ERROR = 'cli spawns disabled';

// The authorize URL has moved hosts across CLI releases (claude.com today,
// claude.ai and console.anthropic.com in older/enterprise builds), so the host
// is matched as a family rather than pinned to one domain.
const AUTH_URL_PATTERN = /https:\/\/(?:[A-Za-z0-9-]+\.)*(?:claude\.(?:com|ai)|anthropic\.com)\/\S*/;
// OSC-8 hyperlink: ESC ] 8 ; ; <target> (BEL | ESC \)
const OSC8_PATTERN = /\x1b\]8;;(.*?)(?:\x07|\x1b\\)/g;
// Any OSC sequence (hyperlinks, window-title sets, clipboard writes): ESC ]
// <payload> (BEL | ST). Stripped whole so no `0;title` residue reaches the
// prompt/JSON/error parsers.
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Any CSI sequence (SGR colours, cursor moves, erases).
const CSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Remaining single-character / other escape sequences.
const OTHER_ESCAPE_PATTERN = /\x1b[@-Z\\-_]/g;
const PROMPT_SENTINEL = 'Paste code here';
// `script` gives the CLI an 80-column PTY, and the CLI hard-wraps its own
// output at that width. Only a line that is *exactly* that wide is treated as
// continued: a line that merely ends in a long token ended because the CLI
// printed a newline, and gluing the next line onto it would corrupt the match.
// On a differently-sized terminal this degrades to the pre-wrap behaviour (and
// the OSC-8 href, which never wraps, is preferred anyway).
const PTY_WRAP_COLUMNS = 80;

const LOGIN_STATES = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  AWAITING_CODE: 'awaiting_code',
  EXCHANGING: 'exchanging',
  SUCCESS: 'success',
  ERROR: 'error',
});

export const CLAUDE_AUTH_LOGIN_STATES = LOGIN_STATES;

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * Removes OSC sequences (including OSC-8 hyperlink wrappers), ANSI CSI
 * sequences and the CR the PTY adds to every line, leaving the human-visible
 * text.
 */
export function stripTerminalEscapes(value) {
  return String(value == null ? '' : value)
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(OTHER_ESCAPE_PATTERN, '')
    .replace(/\r/g, '');
}

/**
 * Rejoins lines the PTY hard-wrapped mid-token: a wrap fills the terminal width
 * and leaves no trailing space, so a full-width line is stitched onto the line
 * that follows it (repeatedly, for a URL spanning three or more rows).
 */
export function joinWrappedLines(value) {
  const lines = String(value == null ? '' : value).split('\n');
  const joined = [];
  let previousWrapped = false;
  for (const line of lines) {
    if (previousWrapped && joined.length && /^\S/.test(line)) {
      joined[joined.length - 1] = `${joined[joined.length - 1]}${line}`;
    } else {
      joined.push(line);
    }
    previousWrapped = line.length === PTY_WRAP_COLUMNS && /\S$/.test(line);
  }
  return joined.join('\n');
}

/**
 * Pulls the OAuth authorize URL out of raw CLI output.
 *
 * The OSC-8 hyperlink *target* is preferred over the visible label: the label is
 * what a terminal would wrap or truncate, the target is the real href. Falls
 * back to matching the escape-stripped text so a CLI release that drops the
 * hyperlink wrapper still parses (risk row 1 of the plan: degrade, never break),
 * rejoining a hard-wrapped URL when the visible match runs into a line break.
 */
export function extractAuthUrl(rawOutput) {
  const raw = String(rawOutput == null ? '' : rawOutput);
  for (const match of raw.matchAll(OSC8_PATTERN)) {
    const target = normalizeText(match[1]);
    const hit = target.match(AUTH_URL_PATTERN);
    if (hit) return hit[0];
  }
  const visible = stripTerminalEscapes(raw);
  const direct = visible.match(AUTH_URL_PATTERN);
  if (!direct) return '';
  const endedAtLineBreak = visible[direct.index + direct[0].length] === '\n';
  if (!endedAtLineBreak) return direct[0];
  const rejoined = joinWrappedLines(visible).match(AUTH_URL_PATTERN);
  return rejoined && rejoined[0].length > direct[0].length ? rejoined[0] : direct[0];
}

export function hasCodePrompt(rawOutput) {
  return stripTerminalEscapes(rawOutput).includes(PROMPT_SENTINEL);
}

/**
 * Redacts anything token-shaped plus the exact code the user pasted, so an
 * error tail can be surfaced to the UI without leaking a credential. The
 * authorize URL's long PKCE segments get caught by the generic rule too, which
 * is fine: the URL is already carried in the login payload.
 */
export function scrubSecrets(text, submittedCode = '') {
  let output = String(text == null ? '' : text);
  const code = normalizeText(submittedCode);
  if (code.length >= 4) {
    output = output.split(code).join('[redacted]');
  }
  return output
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
}

function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, `'\\''`)}'`;
}

function tailOf(text, limit = MAX_ERROR_TAIL_CHARS) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  const joined = lines.join(' · ');
  return joined.length > limit ? `…${joined.slice(-limit)}` : joined;
}

function parseAuthStatusJson(stdout) {
  const text = stripTerminalEscapes(stdout).trim();
  if (!text) return null;
  // Tolerate leading noise (npm shim banners etc.) by taking the last JSON
  // object in the output.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeStatusPayload(parsed) {
  return {
    loggedIn: parsed?.loggedIn === true,
    authMethod: normalizeText(parsed?.authMethod) || null,
    apiProvider: normalizeText(parsed?.apiProvider) || null,
    email: normalizeText(parsed?.email) || null,
    orgId: normalizeText(parsed?.orgId) || null,
    orgName: normalizeText(parsed?.orgName) || null,
    subscriptionType: normalizeText(parsed?.subscriptionType) || null,
  };
}

export function resolveClaudeAuthBinary(env = process.env) {
  return normalizeText(env?.COPILOT_WEB_RELAY_CLAUDE_AUTH_BIN) || 'claude';
}

export function createClaudeAuthService({
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  processKillImpl = process.kill.bind(process),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  now = () => Date.now(),
  logger = console,
  loginTimeoutMs = CLAUDE_AUTH_LOGIN_TIMEOUT_MS,
  statusTtlMs = CLAUDE_AUTH_STATUS_TTL_MS,
  statusTimeoutMs = CLAUDE_AUTH_STATUS_TIMEOUT_MS,
  logoutTimeoutMs = CLAUDE_AUTH_LOGOUT_TIMEOUT_MS,
} = {}) {
  const listeners = new Set();
  const successHooks = new Set();
  const login = {
    state: LOGIN_STATES.IDLE,
    authUrl: '',
    error: '',
    startedAt: null,
  };
  let session = null;
  // Bumped by every startLogin/cancel so a slow post-success continuation can
  // tell whether it still owns the visible login state.
  let loginGeneration = 0;
  let statusCache = null;
  let statusInFlight = null;
  // Serialises status spawns: a forced read never joins an older in-flight
  // probe (it could predate the login/logout that prompted the force), but it
  // waits for it rather than running two `claude auth status` at once.
  let statusChain = Promise.resolve();

  const log = (message) => {
    try { logger?.log?.(`[claude-auth] ${message}`); } catch {}
  };

  function loginSnapshot() {
    return {
      state: login.state,
      authUrl: login.authUrl || null,
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

  function setLoginState(nextState, { authUrl, error } = {}) {
    login.state = nextState;
    if (authUrl !== undefined) login.authUrl = authUrl || '';
    if (error !== undefined) login.error = error || '';
    emitState();
  }

  function buildSpawnEnv() {
    // A plain copy of the relay environment: CLAUDE_CONFIG_DIR (and HOME) come
    // along, so status/login/logout all address the same config root the
    // workers read.
    return { ...env };
  }

  function cliSpawnsDisabled() {
    // Same kill switch (and same truthiness rule) as
    // session-worker-launch-service.mjs: a relay started with it must never run
    // a real CLI — including `claude auth logout`, which would sign the
    // developer's own host out.
    if (!String(env?.COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN || '').trim()) return false;
    // Narrow escape hatch for the e2e harness, which keeps the kill switch on
    // (no real Copilot/Claude workers) but still drives the whole auth flow.
    // Both halves are required: the opt-in flag AND an explicit binary override,
    // so "spawns disabled" can never end up running the host's real `claude`.
    return !(
      String(env?.COPILOT_WEB_RELAY_CLAUDE_AUTH_ALLOW_STUB_SPAWN || '').trim()
      && String(env?.COPILOT_WEB_RELAY_CLAUDE_AUTH_BIN || '').trim()
    );
  }

  /**
   * The single spawn site for every auth subcommand.
   *
   * POSIX login/logout run under a pseudo-TTY (`script -qec "<cmd>" /dev/null`)
   * with piped stdio, detached so the whole process group can be signalled. On
   * Windows there is no `script`, so the binary is spawned directly (best
   * effort — the auth flow is a POSIX-host feature). `auth status --json` needs
   * no TTY and runs without one.
   */
  function spawnAuthProcess(args, { pty = true, stdin = 'pipe' } = {}) {
    if (cliSpawnsDisabled()) throw new Error(CLI_SPAWN_DISABLED_ERROR);
    const bin = resolveClaudeAuthBinary(env);
    const child = (!pty || platform === 'win32')
      ? spawnImpl(bin, args, {
        stdio: [stdin, 'pipe', 'pipe'],
        env: buildSpawnEnv(),
        windowsHide: true,
      })
      : spawnImpl('script', ['-qec', [bin, ...args].map(shellQuote).join(' '), '/dev/null'], {
        stdio: [stdin, 'pipe', 'pipe'],
        env: buildSpawnEnv(),
        detached: true,
      });
    // stdin errors (EPIPE when the CLI exits mid-write) arrive asynchronously
    // as 'error' events; without a listener Node turns them into an unhandled
    // error that would take the relay down.
    child?.stdin?.on?.('error', (error) => {
      log(`child stdin error: ${error?.message || error}`);
    });
    return child;
  }

  function killTree(child, signal) {
    if (!child || child.exitCode !== null) return;
    const pid = Number(child.pid);
    if (platform !== 'win32' && Number.isInteger(pid) && pid > 0) {
      try {
        processKillImpl(-pid, signal);
        return;
      } catch {}
    }
    try { child.kill(signal); } catch {}
  }

  function runToCompletion(args, { timeoutMs, usePty = true } = {}) {
    return new Promise((resolve) => {
      let child = null;
      try {
        child = spawnAuthProcess(args, { pty: usePty, stdin: usePty ? 'pipe' : 'ignore' });
      } catch (error) {
        resolve({ ok: false, code: null, output: '', error: error?.message || String(error) });
        return;
      }
      let output = '';
      let settled = false;
      const append = (chunk) => {
        output = `${output}${chunk.toString()}`.slice(-MAX_CAPTURED_OUTPUT_CHARS);
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeoutImpl(timer);
        resolve(result);
      };
      const timer = setTimeoutImpl(() => {
        killTree(child, 'SIGTERM');
        finish({ ok: false, code: null, output, error: `timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      timer?.unref?.();
      child.stdout?.on?.('data', append);
      child.stderr?.on?.('data', append);
      child.stdin?.end?.();
      child.on('error', (error) => finish({
        ok: false, code: null, output, error: error?.message || String(error),
      }));
      child.on('close', (code) => finish({
        ok: code === 0, code, output, error: null,
      }));
    });
  }

  async function fetchStatus() {
    const result = await runToCompletion(['auth', 'status', '--json'], {
      timeoutMs: statusTimeoutMs,
      usePty: false,
    });
    const parsed = parseAuthStatusJson(result.output);
    if (!parsed) {
      return {
        ok: false,
        ...normalizeStatusPayload(null),
        error: result.error
          || tailOf(stripTerminalEscapes(result.output))
          || `claude auth status exited with code ${result.code}`,
        checkedAt: new Date(now()).toISOString(),
      };
    }
    return {
      ok: true,
      ...normalizeStatusPayload(parsed),
      error: null,
      checkedAt: new Date(now()).toISOString(),
    };
  }

  async function getStatus({ force = false } = {}) {
    if (!force && statusCache && !statusCache.stale && (now() - statusCache.at) < statusTtlMs) {
      return statusCache.value;
    }
    // A non-forced caller is happy with whatever probe is already running; a
    // forced one is not (that probe may have started before the login or logout
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

  /** Last status the CLI reported, without ever spawning. */
  function getCachedStatus() {
    return statusCache ? statusCache.value : null;
  }

  /**
   * Keeps the last-known value readable (broadcasts render it) while forcing
   * the next `getStatus()` to re-read the CLI.
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
    const scrubbed = scrubSecrets(message, current.submittedCode);
    releaseSession(current);
    invalidateStatusCache();
    setLoginState(LOGIN_STATES.ERROR, { error: scrubbed || 'Claude login failed' });
  }

  async function succeedSession(current) {
    if (!current || current.settled) return;
    current.settled = true;
    releaseSession(current);
    invalidateStatusCache();
    // Success is published before the confirming status read: that read spawns
    // the CLI again (up to statusTimeoutMs), and the UI must not sit on
    // "exchanging" while it runs.
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
    // Once the code has been written to stdin nothing more from this process is
    // logged: the exchange output can echo credential material.
    if (!current.submittedCode) {
      const visible = stripTerminalEscapes(text).trim();
      if (visible) log(`login: ${visible.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    if (current.settled) return;
    if (login.authUrl) return;
    const url = extractAuthUrl(current.rawOutput);
    if (url) setLoginState(LOGIN_STATES.AWAITING_CODE, { authUrl: url, error: '' });
  }

  function startLogin() {
    if (session) {
      // Idempotent: a second Relogin press (or a second browser tab) joins the
      // session already in flight rather than racing a new PKCE challenge.
      return { ok: true, login: loginSnapshot(), reused: true };
    }
    const startedAt = new Date(now()).toISOString();
    let child = null;
    try {
      child = spawnAuthProcess(['auth', 'login']);
    } catch (error) {
      loginGeneration += 1;
      setLoginState(LOGIN_STATES.ERROR, {
        authUrl: '',
        error: scrubSecrets(error?.message || String(error)),
      });
      return { ok: false, error: login.error, login: loginSnapshot() };
    }
    const current = {
      child,
      rawOutput: '',
      submittedCode: '',
      settled: false,
      timeoutTimer: null,
    };
    session = current;
    loginGeneration += 1;
    login.startedAt = startedAt;
    setLoginState(LOGIN_STATES.STARTING, { authUrl: '', error: '' });

    current.timeoutTimer = setTimeoutImpl(() => {
      failSession(current, `Claude login timed out after ${Math.round(loginTimeoutMs / 1000)}s`);
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
      if (code === 0 && current.submittedCode) {
        void succeedSession(current);
        return;
      }
      const tail = tailOf(stripTerminalEscapes(current.rawOutput));
      failSession(current, current.submittedCode
        ? (tail || `Claude login exited with code ${code}`)
        : `Claude login exited before a code was submitted (code ${code})${tail ? `: ${tail}` : ''}`);
    });
    return { ok: true, login: loginSnapshot(), reused: false };
  }

  function submitCode(code) {
    const current = session;
    if (!current) {
      return { ok: false, statusCode: 409, error: 'No Claude login is in progress', login: loginSnapshot() };
    }
    if (login.state !== LOGIN_STATES.AWAITING_CODE) {
      return {
        ok: false,
        statusCode: 409,
        error: `Claude login is not waiting for a code (state: ${login.state})`,
        login: loginSnapshot(),
      };
    }
    const trimmed = normalizeText(code);
    if (!trimmed) {
      return { ok: false, statusCode: 400, error: 'Missing code', login: loginSnapshot() };
    }
    if (trimmed.length > MAX_CODE_LENGTH || /[\r\n]/.test(trimmed)) {
      return { ok: false, statusCode: 400, error: 'Invalid code', login: loginSnapshot() };
    }
    current.submittedCode = trimmed;
    try {
      current.child.stdin.write(`${trimmed}\n`);
    } catch (error) {
      failSession(current, `Failed to hand the code to the Claude CLI: ${error?.message || error}`);
      return { ok: false, statusCode: 500, error: login.error, login: loginSnapshot() };
    }
    setLoginState(LOGIN_STATES.EXCHANGING, { error: '' });
    return { ok: true, login: loginSnapshot() };
  }

  function cancel() {
    const current = session;
    loginGeneration += 1;
    if (current) {
      current.settled = true;
      terminateSession(current);
      releaseSession(current);
    }
    // Also the "dismiss the terminal state" path for the UI.
    login.startedAt = null;
    setLoginState(LOGIN_STATES.IDLE, { authUrl: '', error: '' });
    return { ok: true, login: loginSnapshot() };
  }

  async function logout() {
    if (session) {
      return { ok: false, statusCode: 409, error: 'A Claude login is in progress; cancel it first' };
    }
    // Same PTY harness as login: `auth logout` was never probed live, so treat
    // it as possibly-interactive and capture whatever it prints.
    const result = await runToCompletion(['auth', 'logout'], { timeoutMs: logoutTimeoutMs });
    const visible = stripTerminalEscapes(result.output);
    if (hasCodePrompt(visible) || /\(y\/n\)|\[y\/N\]/i.test(visible)) {
      log(`logout produced an unexpected prompt: ${tailOf(visible)}`);
    }
    invalidateStatusCache();
    const status = await getStatus({ force: true });
    if (!result.ok) {
      return {
        ok: false,
        statusCode: 500,
        error: scrubSecrets(result.error || tailOf(visible) || `claude auth logout exited with code ${result.code}`),
        status,
      };
    }
    login.startedAt = null;
    // The status cache is fresh at this point, so the IDLE broadcast subscribers
    // build carries the post-logout account state without another spawn.
    setLoginState(LOGIN_STATES.IDLE, { authUrl: '', error: '' });
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
    submitCode,
    cancel,
    logout,
    subscribe,
    onLoginSuccess,
    dispose,
  };
}
