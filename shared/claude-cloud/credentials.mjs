// The Claude login a cloud session runs on.
//
// Claude Cloud sessions are created with the claude.ai login the Claude CLI
// keeps in `<CLAUDE_CONFIG_DIR | ~/.claude>/.credentials.json`. This module is
// the only place that reads it. It hands out the access token, says what it
// found (never the token itself), and takes the token back out of any text
// that is about to leave the process.
//
// What it never does: use the refresh token. A refresh from here would rotate
// the login under the CLI and log it out. When the token has run out the file
// is read again (the CLI rewrites it while it works), then the caller's
// `nudge` may run the CLI once so that it refreshes its own login, and after
// that the answer is `login_expired`.
//
// Nothing here logs, and no error it throws carries the token.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_CLOUD_ERROR_CODES = Object.freeze([
  'login_missing',
  'login_expired',
  'github_not_connected',
  'repo_access_denied',
  'environment_missing',
  'not_found',
  'rate_limited',
  'bad_request',
  'transient',
]);

const DEFAULT_ERROR_MESSAGES = Object.freeze({
  login_missing: 'No Claude login was found on this machine. Log in with the Claude CLI first.',
  login_expired: 'The Claude login has expired or was rejected. Log in to Claude again.',
  github_not_connected: 'GitHub is not connected to this Claude account.',
  repo_access_denied: 'The Claude GitHub app has no access to this repository.',
  environment_missing: 'The Claude Cloud environment was not found.',
  not_found: 'Claude Cloud did not find the session or resource.',
  rate_limited: 'Claude Cloud is rate limiting this account. Try again later.',
  bad_request: 'Claude Cloud refused the request.',
  transient: 'Claude Cloud is not answering right now.',
});

/** The plain sentence for an error code; the fallback of every ClaudeCloudError. */
export function claudeCloudErrorMessage(code) {
  return DEFAULT_ERROR_MESSAGES[code] || DEFAULT_ERROR_MESSAGES.transient;
}

/**
 * Every failure of the cloud client and of the credentials: `code` (one of
 * CLAUDE_CLOUD_ERROR_CODES), `status` (the HTTP status, or null when no answer
 * was involved) and `detail` (what the API said, already redacted, or null).
 *
 * `new ClaudeCloudError(code, message?, { status, detail })`; also accepted:
 * `(message, { code, … })` and `({ code, message, … })`.
 */
export class ClaudeCloudError extends Error {
  constructor(code, message, options) {
    let fields;
    if (code && typeof code === 'object') fields = code;
    else if (message && typeof message === 'object') {
      fields = message.code ? { ...message, message: code } : { ...message, code };
    } else fields = { ...(options || {}), code, message };
    const errorCode = String(fields.code || 'transient');
    super(String(fields.message || '') || claudeCloudErrorMessage(errorCode));
    this.name = 'ClaudeCloudError';
    this.code = errorCode;
    this.status = Number.isFinite(fields.status) ? fields.status : null;
    this.detail = fields.detail ? String(fields.detail) : null;
  }
}

export const CLAUDE_CLOUD_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
/** The cached token is trusted until this long before it runs out. */
export const CLAUDE_CLOUD_TOKEN_MARGIN_MS = 60_000;
/** The CLI is asked to refresh its login at most this often. */
export const CLAUDE_CLOUD_NUDGE_INTERVAL_MS = 5 * 60_000;

const REDACTED = '[redacted]';
/** Tokens handed out earlier stay redactable after the file moved on. */
const MAX_REMEMBERED_TOKENS = 16;

/** Where the CLI keeps its login: `CLAUDE_CONFIG_DIR`, else `.claude` in the home directory. */
export function resolveClaudeCredentialsPath({ env = process.env, homedir = os.homedir, pathImpl = path } = {}) {
  const configDir = String(env?.CLAUDE_CONFIG_DIR || '').trim();
  if (configDir) return pathImpl.join(configDir, '.credentials.json');
  const home = String((typeof homedir === 'function' ? homedir() : homedir) || '').trim();
  return pathImpl.join(home, '.claude', '.credentials.json');
}

function textOrNull(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function isoOrNull(ms) {
  if (ms === null) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * `nudge`: an async function that makes the Claude CLI refresh its own login
 * (the caller decides which command). Called at most once per five minutes,
 * and only when the login in the file is about to run out or has.
 */
export function createClaudeCloudCredentials({
  env = process.env,
  homedir = os.homedir,
  fsImpl = fs,
  now = Date.now,
  nudge = null,
  pathImpl = path,
} = {}) {
  let cached = null;
  let loading = null;
  let lastNudgeAt = null;
  const remembered = [];

  function remember(token) {
    if (!token || remembered.includes(token)) return;
    remembered.push(token);
    if (remembered.length > MAX_REMEMBERED_TOKENS) remembered.shift();
  }

  function readEnvToken() {
    const token = textOrNull(env?.[CLAUDE_CLOUD_TOKEN_ENV]);
    if (token) remember(token);
    return token;
  }

  /** The login in the file, or null when there is no file, no JSON or no token in it. */
  function readFileLogin() {
    let oauth = null;
    try {
      const filePath = resolveClaudeCredentialsPath({ env, homedir, pathImpl });
      oauth = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'))?.claudeAiOauth;
    } catch {
      return null;
    }
    const accessToken = textOrNull(oauth?.accessToken);
    if (!accessToken) return null;
    remember(accessToken);
    const expiresAt = Number(oauth.expiresAt);
    return {
      accessToken,
      expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
      subscriptionType: textOrNull(oauth.subscriptionType),
      rateLimitTier: textOrNull(oauth.rateLimitTier),
    };
  }

  // A login without an expiry time is taken as it is and read again each time.
  const isExpired = (login) => login.expiresAt !== null && now() >= login.expiresAt;
  const isFresh = (login) => login.expiresAt !== null && now() < login.expiresAt - CLAUDE_CLOUD_TOKEN_MARGIN_MS;
  const needsRefresh = (login) => login.expiresAt !== null && !isFresh(login);

  async function loadFromFile() {
    let login = readFileLogin();
    if (login && needsRefresh(login) && typeof nudge === 'function'
      && (lastNudgeAt === null || now() - lastNudgeAt >= CLAUDE_CLOUD_NUDGE_INTERVAL_MS)) {
      lastNudgeAt = now();
      // A nudge that fails changes nothing: the file decides.
      try { await nudge(); } catch {}
      login = readFileLogin();
    }
    cached = null;
    if (!login) throw new ClaudeCloudError('login_missing');
    if (isExpired(login)) throw new ClaudeCloudError('login_expired');
    // Inside the last minute the token still works, so it is handed out, but
    // `isFresh` keeps it from being served from the cache.
    cached = login;
    return login.accessToken;
  }

  /**
   * The bearer token. `forceReload` skips the cache (the API refused the
   * cached token: the CLI may have replaced it early). Throws ClaudeCloudError
   * `login_missing` or `login_expired`.
   */
  async function getAccessToken({ forceReload = false } = {}) {
    const envToken = readEnvToken();
    if (envToken) return envToken;
    if (!forceReload && cached && isFresh(cached)) return cached.accessToken;
    // One read (and one nudge) for everybody who asks while it runs.
    if (!loading) loading = loadFromFile().finally(() => { loading = null; });
    return loading;
  }

  /** What there is to say about the login without saying the token. Never throws. */
  function describe() {
    const none = { source: 'none', hasToken: false, expiresAt: null, subscriptionType: null, rateLimitTier: null, expired: false };
    if (readEnvToken()) return { ...none, source: 'env', hasToken: true };
    const login = readFileLogin();
    if (!login) return none;
    return {
      source: 'file',
      hasToken: true,
      expiresAt: isoOrNull(login.expiresAt),
      subscriptionType: login.subscriptionType,
      rateLimitTier: login.rateLimitTier,
      expired: isExpired(login),
    };
  }

  /**
   * The text without any token this module has handed out or seen, and
   * without anything that has the shape of a bearer header or a Claude token.
   */
  function redact(text) {
    let out = String(text ?? '');
    readEnvToken();
    for (const token of remembered) out = out.split(token).join(REDACTED);
    return out
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
      .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED);
  }

  return { getAccessToken, describe, redact };
}
