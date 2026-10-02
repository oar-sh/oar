import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  CLAUDE_CLOUD_ERROR_CODES,
  ClaudeCloudError,
  createClaudeCloudCredentials,
  resolveClaudeCredentialsPath,
} from './credentials.mjs';

// Both path flavours run on every host: the module joins with the injected
// path.posix / path.win32, never with the host's own.
const HOME = '/home/dev';
const FILE = path.posix.join(HOME, '.claude', '.credentials.json');
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function loginFile(overrides = {}) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'test-token-value',
      refreshToken: 'test-refresh-value',
      expiresAt: T0 + 8 * HOUR,
      scopes: ['user:sessions:claude_code'],
      subscriptionType: 'max',
      rateLimitTier: 'tier-example',
      ...overrides,
    },
  });
}

/** A file system of `{ path: text }` that counts its reads; a missing path throws ENOENT. */
function fakeFs(files = {}) {
  const reads = [];
  return {
    files,
    reads,
    readFileSync(filePath, encoding) {
      reads.push(filePath);
      assert.equal(encoding, 'utf8');
      if (!(filePath in files)) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      return files[filePath];
    },
  };
}

function setup({ files = { [FILE]: loginFile() }, env = {}, nudge, start = T0 } = {}) {
  const fsImpl = fakeFs(files);
  const clock = { at: start };
  const credentials = createClaudeCloudCredentials({
    env,
    homedir: () => HOME,
    fsImpl,
    now: () => clock.at,
    nudge,
    pathImpl: path.posix,
  });
  return { credentials, fsImpl, clock };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ClaudeCloudError);
    assert.equal(error.code, code);
    assert.equal(error.status, null);
    return true;
  });
}

test('the login file is found in the home directory, or where CLAUDE_CONFIG_DIR says', () => {
  assert.equal(resolveClaudeCredentialsPath({ env: {}, homedir: () => HOME, pathImpl: path.posix }), FILE);
  assert.equal(resolveClaudeCredentialsPath({ env: {}, homedir: HOME, pathImpl: path.posix }), FILE);
  assert.equal(
    resolveClaudeCredentialsPath({ env: { CLAUDE_CONFIG_DIR: '/srv/claude-config' }, homedir: () => HOME, pathImpl: path.posix }),
    path.posix.join('/srv/claude-config', '.credentials.json'),
  );
  assert.equal(
    resolveClaudeCredentialsPath({ env: {}, homedir: () => 'C:\\Users\\dev', pathImpl: path.win32 }),
    path.win32.join('C:\\Users\\dev', '.claude', '.credentials.json'),
  );
});

test('the token comes from the file and is cached until a minute before it runs out', async () => {
  const { credentials, fsImpl, clock } = setup();
  assert.equal(await credentials.getAccessToken(), 'test-token-value');
  assert.equal(await credentials.getAccessToken(), 'test-token-value');
  clock.at = T0 + 8 * HOUR - MINUTE - 1;
  assert.equal(await credentials.getAccessToken(), 'test-token-value');
  assert.deepEqual(fsImpl.reads, [FILE], 'one read serves every call while the token is fresh');

  // The CLI has rewritten the file in the meantime; the margin makes us look.
  fsImpl.files[FILE] = loginFile({ accessToken: 'test-token-second', expiresAt: T0 + 16 * HOUR });
  clock.at = T0 + 8 * HOUR - MINUTE;
  assert.equal(await credentials.getAccessToken(), 'test-token-second');
  assert.equal(fsImpl.reads.length, 2);
  assert.equal(await credentials.getAccessToken(), 'test-token-second');
  assert.equal(fsImpl.reads.length, 2, 'the new token is cached in turn');
});

test('CLAUDE_CONFIG_DIR moves the file that is read', async () => {
  const configFile = path.posix.join('/srv/claude-config', '.credentials.json');
  const { credentials, fsImpl } = setup({
    files: { [configFile]: loginFile({ accessToken: 'test-token-config-dir' }) },
    env: { CLAUDE_CONFIG_DIR: '/srv/claude-config' },
  });
  assert.equal(await credentials.getAccessToken(), 'test-token-config-dir');
  assert.deepEqual(fsImpl.reads, [configFile]);
});

test('forceReload reads the file again although the cached token looks fresh', async () => {
  const { credentials, fsImpl } = setup();
  assert.equal(await credentials.getAccessToken(), 'test-token-value');
  fsImpl.files[FILE] = loginFile({ accessToken: 'test-token-second' });
  assert.equal(await credentials.getAccessToken(), 'test-token-value');
  assert.equal(await credentials.getAccessToken({ forceReload: true }), 'test-token-second');
  assert.equal(await credentials.getAccessToken(), 'test-token-second');
  assert.equal(fsImpl.reads.length, 2);
});

test('the env token wins over the file, which is then never read', async () => {
  const nudges = [];
  const { credentials, fsImpl } = setup({
    files: { [FILE]: loginFile({ expiresAt: T0 - HOUR }) },
    env: { CLAUDE_CODE_OAUTH_TOKEN: '  test-token-from-env\n' },
    nudge: async () => { nudges.push(1); },
  });
  assert.equal(await credentials.getAccessToken(), 'test-token-from-env');
  assert.equal(await credentials.getAccessToken({ forceReload: true }), 'test-token-from-env');
  assert.deepEqual(credentials.describe(), {
    source: 'env', hasToken: true, expiresAt: null, subscriptionType: null, rateLimitTier: null, expired: false,
  });
  assert.deepEqual(fsImpl.reads, []);
  assert.deepEqual(nudges, []);
});

test('an env token that is only blanks does not count', async () => {
  const { credentials } = setup({ env: { CLAUDE_CODE_OAUTH_TOKEN: '   ' } });
  assert.equal(await credentials.getAccessToken(), 'test-token-value');
  assert.equal(credentials.describe().source, 'file');
});

test('no file, no JSON, no login in it, no token: login_missing', async () => {
  for (const files of [
    {},
    { [FILE]: 'not json' },
    { [FILE]: '{}' },
    { [FILE]: JSON.stringify({ claudeAiOauth: null }) },
    { [FILE]: loginFile({ accessToken: '' }) },
    { [FILE]: loginFile({ accessToken: 12345 }) },
  ]) {
    const nudges = [];
    const { credentials } = setup({ files, nudge: async () => { nudges.push(1); } });
    await rejectsWithCode(credentials.getAccessToken(), 'login_missing');
    assert.deepEqual(credentials.describe(), {
      source: 'none', hasToken: false, expiresAt: null, subscriptionType: null, rateLimitTier: null, expired: false,
    });
    assert.deepEqual(nudges, [], 'nothing to refresh where nobody is logged in');
  }
});

test('a login that appears later is picked up: a failure is not cached', async () => {
  const { credentials, fsImpl } = setup({ files: {} });
  await rejectsWithCode(credentials.getAccessToken(), 'login_missing');
  fsImpl.files[FILE] = loginFile();
  assert.equal(await credentials.getAccessToken(), 'test-token-value');
});

test('an expired token without a nudge is login_expired, and the error does not carry it', async () => {
  const { credentials } = setup({ files: { [FILE]: loginFile({ expiresAt: T0 - 1 }) } });
  await assert.rejects(credentials.getAccessToken(), (error) => {
    assert.equal(error.code, 'login_expired');
    assert.doesNotMatch(`${error.message} ${error.detail} ${error.stack} ${JSON.stringify(error)}`, /test-token-value|test-refresh-value/);
    return true;
  });
});

test('a cached token that runs out is read again, and a file that still has the old one is login_expired', async () => {
  const { credentials, fsImpl, clock } = setup();
  assert.equal(await credentials.getAccessToken(), 'test-token-value');
  clock.at = T0 + 8 * HOUR;
  await rejectsWithCode(credentials.getAccessToken(), 'login_expired');
  assert.equal(fsImpl.reads.length, 2);
});

test('the nudge lets the CLI refresh its login, and the file is read again after it', async () => {
  const nudges = [];
  const ctx = setup({
    files: { [FILE]: loginFile({ expiresAt: T0 - 1 }) },
    nudge: async () => {
      nudges.push(ctx.clock.at);
      ctx.fsImpl.files[FILE] = loginFile({ accessToken: 'test-token-refreshed', expiresAt: T0 + 8 * HOUR });
    },
  });
  assert.equal(await ctx.credentials.getAccessToken(), 'test-token-refreshed');
  assert.deepEqual(nudges, [T0]);
  assert.equal(ctx.fsImpl.reads.length, 2, 'once before the nudge, once after');
  assert.equal(await ctx.credentials.getAccessToken(), 'test-token-refreshed');
  assert.deepEqual(nudges, [T0], 'a fresh token needs no nudge');
});

test('the nudge runs at most once in five minutes', async () => {
  const nudges = [];
  const { credentials, clock } = setup({
    files: { [FILE]: loginFile({ expiresAt: T0 - 1 }) },
    nudge: async () => { nudges.push(clock.at); },
  });
  await rejectsWithCode(credentials.getAccessToken(), 'login_expired');
  assert.deepEqual(nudges, [T0]);

  clock.at = T0 + MINUTE;
  await rejectsWithCode(credentials.getAccessToken(), 'login_expired');
  await rejectsWithCode(credentials.getAccessToken({ forceReload: true }), 'login_expired');
  clock.at = T0 + 5 * MINUTE - 1;
  await rejectsWithCode(credentials.getAccessToken(), 'login_expired');
  assert.deepEqual(nudges, [T0], 'still inside the five minutes');

  clock.at = T0 + 5 * MINUTE;
  await rejectsWithCode(credentials.getAccessToken(), 'login_expired');
  assert.deepEqual(nudges, [T0, T0 + 5 * MINUTE]);
});

test('a nudge that fails changes nothing: the file decides', async () => {
  const { credentials } = setup({
    files: { [FILE]: loginFile({ expiresAt: T0 - 1 }) },
    nudge: async () => { throw new Error('claude: command not found'); },
  });
  await rejectsWithCode(credentials.getAccessToken(), 'login_expired');
});

test('callers that ask at the same time share one read and one nudge', async () => {
  const nudges = [];
  let finishNudge;
  const ctx = setup({
    files: { [FILE]: loginFile({ expiresAt: T0 - 1 }) },
    nudge: () => new Promise((resolve) => {
      nudges.push(1);
      finishNudge = () => {
        ctx.fsImpl.files[FILE] = loginFile({ accessToken: 'test-token-refreshed' });
        resolve();
      };
    }),
  });
  const asked = [ctx.credentials.getAccessToken(), ctx.credentials.getAccessToken(), ctx.credentials.getAccessToken({ forceReload: true })];
  finishNudge();
  assert.deepEqual(await Promise.all(asked), ['test-token-refreshed', 'test-token-refreshed', 'test-token-refreshed']);
  assert.deepEqual(nudges, [1]);
});

test('in its last minute a token is still handed out, after a nudge, and never from the cache', async () => {
  // It works until it runs out; refusing it early would fail turns for nothing.
  const nudges = [];
  const { credentials, fsImpl, clock } = setup({
    files: { [FILE]: loginFile({ expiresAt: T0 + 30_000 }) },
    nudge: async () => { nudges.push(clock.at); },
  });
  assert.equal(await credentials.getAccessToken(), 'test-token-value');
  assert.deepEqual(nudges, [T0]);
  assert.equal(await credentials.getAccessToken(), 'test-token-value');
  assert.equal(fsImpl.reads.length, 3, 'two reads around the nudge, then one per call');
  clock.at = T0 + 30_000;
  await rejectsWithCode(credentials.getAccessToken(), 'login_expired');
});

test('a login without an expiry time is used as it is and read on every call', async () => {
  const nudges = [];
  const { credentials, fsImpl } = setup({
    files: { [FILE]: loginFile({ expiresAt: undefined }) },
    nudge: async () => { nudges.push(1); },
  });
  assert.equal(await credentials.getAccessToken(), 'test-token-value');
  assert.equal(await credentials.getAccessToken(), 'test-token-value');
  assert.equal(fsImpl.reads.length, 2);
  assert.deepEqual(nudges, []);
  assert.equal(credentials.describe().expiresAt, null);
});

test('describe says where the login is and when it ends, never the token', () => {
  const { credentials, fsImpl } = setup();
  const described = credentials.describe();
  assert.deepEqual(described, {
    source: 'file',
    hasToken: true,
    expiresAt: new Date(T0 + 8 * HOUR).toISOString(),
    subscriptionType: 'max',
    rateLimitTier: 'tier-example',
    expired: false,
  });
  assert.doesNotMatch(JSON.stringify(described), /test-token-value|test-refresh-value/);

  fsImpl.files[FILE] = loginFile({ expiresAt: T0 - HOUR, subscriptionType: '', rateLimitTier: null });
  assert.deepEqual(credentials.describe(), {
    source: 'file',
    hasToken: true,
    expiresAt: new Date(T0 - HOUR).toISOString(),
    subscriptionType: null,
    rateLimitTier: null,
    expired: true,
  });
});

test('describe reads the file as it is now, not what was cached', async () => {
  const { credentials, fsImpl } = setup();
  await credentials.getAccessToken();
  delete fsImpl.files[FILE];
  assert.equal(credentials.describe().source, 'none');
});

test('redact takes every token it has handed out or seen out of a text', async () => {
  const { credentials, fsImpl } = setup();
  await credentials.getAccessToken();
  fsImpl.files[FILE] = loginFile({ accessToken: 'test-token-second' });
  await credentials.getAccessToken({ forceReload: true });

  const text = 'invalid bearer test-token-value (was test-token-second, twice: test-token-second)';
  assert.equal(credentials.redact(text), 'invalid bearer [redacted] (was [redacted], twice: [redacted])');
});

test('redact knows the env token and a token only describe has seen', () => {
  const fromEnv = setup({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token-from-env' } }).credentials;
  assert.equal(fromEnv.redact('{"token":"test-token-from-env"}'), '{"token":"[redacted]"}');

  const { credentials } = setup();
  credentials.describe();
  assert.equal(credentials.redact('echo test-token-value'), 'echo [redacted]');
});

test('redact removes anything shaped like a bearer header or a Claude token, known or not', () => {
  const { credentials } = setup({ files: {} });
  const claudeShaped = `sk-ant-${'oat01-'}${'a1B2'.repeat(4)}`;
  assert.equal(
    credentials.redact(`Authorization: Bearer some-other-opaque-value.123 and ${claudeShaped}!`),
    'Authorization: Bearer [redacted] and [redacted]!',
  );
  assert.equal(credentials.redact('the bearer of bad news'), 'the bearer of bad news');
});

test('redact takes anything and gives back text', () => {
  const { credentials } = setup();
  assert.equal(credentials.redact(null), '');
  assert.equal(credentials.redact(undefined), '');
  assert.equal(credentials.redact(503), '503');
  assert.equal(credentials.redact('nothing secret'), 'nothing secret');
});

test('the refresh token is never handed out', async () => {
  const { credentials } = setup();
  assert.notEqual(await credentials.getAccessToken(), 'test-refresh-value');
  assert.doesNotMatch(JSON.stringify(credentials.describe()), /test-refresh-value/);
});

test('ClaudeCloudError carries code, status and detail, with a plain sentence as message', () => {
  const plain = new ClaudeCloudError('login_expired');
  assert.ok(plain instanceof Error);
  assert.equal(plain.name, 'ClaudeCloudError');
  assert.equal(plain.code, 'login_expired');
  assert.equal(plain.status, null);
  assert.equal(plain.detail, null);
  assert.match(plain.message, /Claude login has expired/);

  const full = new ClaudeCloudError('rate_limited', 'Slow down.', { status: 429, detail: 'too many requests' });
  assert.deepEqual([full.code, full.message, full.status, full.detail], ['rate_limited', 'Slow down.', 429, 'too many requests']);

  // The two other spellings callers reach for.
  const messageFirst = new ClaudeCloudError('Not there.', { code: 'not_found', status: 404 });
  assert.deepEqual([messageFirst.code, messageFirst.message, messageFirst.status], ['not_found', 'Not there.', 404]);
  const objectOnly = new ClaudeCloudError({ code: 'transient', status: 502 });
  assert.deepEqual([objectOnly.code, objectOnly.status], ['transient', 502]);
  assert.match(objectOnly.message, /not answering/);
  const codeAndOptions = new ClaudeCloudError('bad_request', { status: 400 });
  assert.deepEqual([codeAndOptions.code, codeAndOptions.status], ['bad_request', 400]);

  assert.equal(new ClaudeCloudError().code, 'transient');
});

test('every error code has its own sentence', () => {
  const sentences = CLAUDE_CLOUD_ERROR_CODES.map((code) => new ClaudeCloudError(code).message);
  assert.equal(new Set(sentences).size, CLAUDE_CLOUD_ERROR_CODES.length);
  assert.deepEqual([...CLAUDE_CLOUD_ERROR_CODES], [
    'login_missing', 'login_expired', 'github_not_connected', 'repo_access_denied', 'environment_missing',
    'not_found', 'rate_limited', 'bad_request', 'transient',
  ]);
});
