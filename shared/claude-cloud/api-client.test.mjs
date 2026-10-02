import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ClaudeCloudError,
  buildClaudeCloudUserMessage,
  classifyClaudeCloudFailure,
  createClaudeCloudClient,
  createSseParser,
} from './api-client.mjs';
import { ClaudeCloudError as CredentialsError, createClaudeCloudCredentials } from './credentials.mjs';
import { FAKE_CLOUD_REPOSITORIES, FAKE_CLOUD_TOKEN, startFakeClaudeCloudApi } from '../../tests/fake-claude-cloud-api.mjs';

const SESSION_ID = 'cse_01EXAMPLEaaaaaaaaaaaaaaaa';
const ENVIRONMENT_ID = 'env_01EXAMPLEbbbbbbbbbbbbbbbb';
const ORG_ID = '00000000-0000-4000-8000-000000000001';
const REPO_URL = 'https://github.com/example-org/sample-repo';
const TOKEN = 'test-token-value';
const SECOND_TOKEN = 'test-token-second';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/**
 * A fetch that answers from a script, one entry per call: a Response, an
 * Error (thrown), or a function of the recorded call. Every call is recorded
 * with its body parsed.
 */
function scriptedFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      signal: init.signal,
    };
    calls.push(call);
    assert.ok(script.length, `unexpected call ${call.method} ${url}`);
    const next = script.shift();
    const answer = typeof next === 'function' ? await next(call) : next;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Credentials that hand out `tokens` in order (the last one repeats) and record how they were asked. */
function fakeCredentials(tokens = [TOKEN]) {
  const queue = [...tokens];
  const asked = [];
  return {
    asked,
    async getAccessToken(options) {
      asked.push(options ?? null);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    },
    describe: () => ({ source: 'file', hasToken: true, expiresAt: null, subscriptionType: null, rateLimitTier: null }),
    redact: (text) => String(text).replaceAll(TOKEN, '[redacted]').replaceAll(SECOND_TOKEN, '[redacted]'),
  };
}

function setup(script, { tokens, ...options } = {}) {
  const fetchImpl = scriptedFetch(script);
  const credentials = fakeCredentials(tokens);
  const client = createClaudeCloudClient({ credentials, fetchImpl, ...options });
  return { client, fetchImpl, credentials, calls: fetchImpl.calls };
}

const encoder = new TextEncoder();

/** A 200 event stream that sends `chunks` (text or bytes) and closes. */
function sseResponse(chunks) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function clientEvent(sequence, payload, separator = '\n') {
  const data = JSON.stringify({
    event_id: `evt_01EXAMPLE${String(sequence).padStart(4, '0')}`,
    sequence_num: String(sequence),
    event_type: payload.type,
    source: 'worker',
    payload,
  });
  return [`event: client_event`, `id: ${sequence}`, `data: ${data}`, '', ''].join(separator);
}

function collectFrames(feed) {
  const frames = [];
  const comments = [];
  const parser = createSseParser({ onFrame: (frame) => frames.push(frame), onComment: (text) => comments.push(text) });
  feed(parser);
  return { frames, comments };
}

// ---------------------------------------------------------------------------
// The SSE parser
// ---------------------------------------------------------------------------

const SAMPLE_STREAM = [
  ':keepalive\n\n',
  'event: session_update\ndata: {"connection_status":"connected"}\n\n',
  'event: client_event\nid: 7\ndata: {"sequence_num":"7"}\n\n',
  ': another comment\n',
  'event: delivery_update\ndata: {"status":"DELIVERY_STATUS_PROCESSED"}\n\n',
].join('');

const SAMPLE_FRAMES = [
  { event: 'session_update', id: null, data: '{"connection_status":"connected"}' },
  { event: 'client_event', id: '7', data: '{"sequence_num":"7"}' },
  { event: 'delivery_update', id: null, data: '{"status":"DELIVERY_STATUS_PROCESSED"}' },
];

test('SSE: frames, ids and comments come out of a stream in one piece', () => {
  const { frames, comments } = collectFrames((parser) => {
    parser.push(SAMPLE_STREAM);
    parser.end();
  });
  assert.deepEqual(frames, SAMPLE_FRAMES);
  assert.deepEqual(comments, ['keepalive', 'another comment']);
});

test('SSE: the same frames come out wherever the chunks are cut, for LF, CRLF and CR line ends', () => {
  for (const [name, lineEnd] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']]) {
    const text = SAMPLE_STREAM.replaceAll('\n', lineEnd);
    for (let cut = 0; cut <= text.length; cut += 1) {
      const { frames, comments } = collectFrames((parser) => {
        parser.push(text.slice(0, cut));
        parser.push(text.slice(cut));
        parser.end();
      });
      assert.deepEqual(frames, SAMPLE_FRAMES, `${name}, cut at ${cut}`);
      assert.equal(comments.length, 2, `${name}, cut at ${cut}`);
    }
    const { frames } = collectFrames((parser) => {
      for (const char of text) parser.push(char);
      parser.end();
    });
    assert.deepEqual(frames, SAMPLE_FRAMES, `${name}, one character at a time`);
  }
});

test('SSE: several data lines are one value, joined by newlines', () => {
  const { frames } = collectFrames((parser) => {
    parser.push('event: client_event\nid: 3\ndata: {"text":\ndata:  "two lines",\ndata:"ok":true}\n\n');
  });
  assert.deepEqual(frames, [{ event: 'client_event', id: '3', data: '{"text":\n "two lines",\n"ok":true}' }]);
  assert.deepEqual(JSON.parse(frames[0].data), { text: 'two lines', ok: true });
});

test('SSE: only one blank after the colon is dropped, a frame without an event name is a message', () => {
  const { frames } = collectFrames((parser) => {
    parser.push('data:no space\n\ndata:  two spaces\n\nevent:ping\n\nretry: 3000\nunknown: field\n\n');
  });
  assert.deepEqual(frames, [
    { event: 'message', id: null, data: 'no space' },
    { event: 'message', id: null, data: ' two spaces' },
    { event: 'ping', id: null, data: null },
  ]);
});

test('SSE: comments, repeated blank lines and a frame of only an id make no frame, an id does not carry over', () => {
  const { frames, comments } = collectFrames((parser) => {
    parser.push(':keepalive\n\n\n\n:keepalive\n\nid: 5\n\nevent: session_update\ndata: {}\n\n');
  });
  assert.deepEqual(frames, [{ event: 'session_update', id: null, data: '{}' }]);
  assert.deepEqual(comments, ['keepalive', 'keepalive']);
});

test('SSE: a byte order mark in front of the stream is ignored', () => {
  const { frames } = collectFrames((parser) => {
    parser.push('﻿event: session_update\ndata: {}\n\n');
  });
  assert.deepEqual(frames, [{ event: 'session_update', id: null, data: '{}' }]);
});

test('SSE: a final frame the stream did not finish is dropped, whole lines or not', () => {
  // A frame counts at its blank line. One that was cut off may lack its data
  // or its id; delivered, it would move the resume cursor past an event
  // nobody has seen.
  for (const tail of [
    'event: client_event\nid: 8\ndata: {"sequence_num":"8"}\n',
    'event: client_event\nid: 8\ndata: {"sequence_num":"8"}',
    'event: client_event\nid: 8\ndata: {"sequen',
    'event: client_event\nid: 8\n',
    'event: client_ev',
  ]) {
    const { frames } = collectFrames((parser) => {
      parser.push(SAMPLE_STREAM + tail);
      parser.end();
    });
    assert.deepEqual(frames, SAMPLE_FRAMES, JSON.stringify(tail));
  }
});

test('SSE: a stream that ends on the CR of its last blank line still completes that frame', () => {
  const frames = [];
  const parser = createSseParser({ onFrame: (frame) => frames.push(frame) });
  parser.push('event: session_update\rdata: {}\r\r');
  assert.equal(frames.length, 0, 'the last CR may still be half of a CRLF');
  parser.end();
  assert.deepEqual(frames, [{ event: 'session_update', id: null, data: '{}' }]);
});

test('SSE: after end the parser starts clean', () => {
  const { frames } = collectFrames((parser) => {
    parser.push('event: client_event\nid: 8\ndata: {"cut":');
    parser.end();
    parser.push('event: session_update\ndata: {}\n\n');
  });
  assert.deepEqual(frames, [{ event: 'session_update', id: null, data: '{}' }]);
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

test('every call carries the bearer token and the API headers', async () => {
  const { client, calls } = setup([json({ five_hour: { utilization: 12 } })], { userAgent: 'oar-test-agent' });
  assert.deepEqual(await client.getAccountUsage(), { five_hour: { utilization: 12 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, undefined);
  assert.deepEqual(calls[0].headers, {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'ccr-triggers-2026-01-30,oauth-2025-04-20',
    'user-agent': 'oar-test-agent',
  });
});

test('another base URL is used as given, with or without a trailing slash', async () => {
  const { client, calls } = setup([json({}), json({})], { baseUrl: 'http://127.0.0.1:4100/' });
  await client.getAccountUsage();
  await client.archiveSession(SESSION_ID);
  assert.equal(calls[0].url, 'http://127.0.0.1:4100/api/oauth/usage');
  assert.equal(calls[1].url, `http://127.0.0.1:4100/v1/code/sessions/${SESSION_ID}/archive`);
  assert.match(calls[0].headers['user-agent'], /oar/);
});

test('the organisation id comes from the profile and is asked for once', async () => {
  const { client, calls } = setup([
    json({ account: { email: 'dev@example.com' }, organization: { uuid: ORG_ID, name: 'Example Org' } }),
  ]);
  assert.equal(await client.getOrganizationId(), ORG_ID);
  assert.equal(await client.getOrganizationId(), ORG_ID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/profile');
});

test('another login gets its own organisation id', async () => {
  // Call 1 asks twice (the cache check and the request), call 2 only checks.
  const { client, calls } = setup([
    json({ organization: { uuid: ORG_ID } }),
    json({ organization: { uuid: '00000000-0000-4000-8000-000000000002' } }),
  ], { tokens: [TOKEN, TOKEN, TOKEN, SECOND_TOKEN] });
  assert.equal(await client.getOrganizationId(), ORG_ID);
  assert.equal(await client.getOrganizationId(), ORG_ID);
  assert.equal(await client.getOrganizationId(), '00000000-0000-4000-8000-000000000002');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.Authorization, `Bearer ${SECOND_TOKEN}`);
});

test('a profile without an organisation is an error, not an empty id', async () => {
  const { client } = setup([json({ account: {}, organization: null })]);
  await assert.rejects(client.getOrganizationId(), (error) => error instanceof ClaudeCloudError && error.code === 'bad_request');
});

test('environments are listed for the organisation, renamed, the active ones first', async () => {
  const { client, calls } = setup([
    json({ organization: { uuid: ORG_ID } }),
    json({
      environments: [
        { kind: 'anthropic_cloud', environment_id: 'env_01EXAMPLEarchived00000000', name: 'Old', state: 'archived', created_at: '2026-01-01T00:00:00Z' },
        { kind: 'anthropic_cloud', environment_id: ENVIRONMENT_ID, name: 'Default', state: 'active', created_at: '2026-01-02T00:00:00Z' },
        { kind: 'byoc', environment_id: 'env_01EXAMPLEsecond000000000', name: 'Second', state: 'active' },
        { kind: 'anthropic_cloud', name: 'no id' },
      ],
      has_more: false,
    }),
  ]);
  assert.deepEqual(await client.listEnvironments(), [
    { id: ENVIRONMENT_ID, name: 'Default', kind: 'anthropic_cloud', state: 'active' },
    { id: 'env_01EXAMPLEsecond000000000', name: 'Second', kind: 'byoc', state: 'active' },
    { id: 'env_01EXAMPLEarchived00000000', name: 'Old', kind: 'anthropic_cloud', state: 'archived' },
  ]);
  assert.equal(calls[1].url, 'https://api.anthropic.com/v1/environment_providers');
  assert.equal(calls[1].headers['x-organization-uuid'], ORG_ID);
  assert.equal(calls[0].headers['x-organization-uuid'], undefined);
});

test('an answer without environments is an empty list', async () => {
  const { client } = setup([json({ organization: { uuid: ORG_ID } }), json({})]);
  assert.deepEqual(await client.listEnvironments(), []);
});

test('the prepaid credits and the credit offer are read for the organisation and returned as sent', async () => {
  const prepaid = { amount: 1250, currency: 'USD', auto_reload_settings: null };
  const offer = { available: true, eligible: true, granted: false, amount_minor_units: 4000, currency: 'USD' };
  const { client, calls } = setup([json({ organization: { uuid: ORG_ID } }), json(prepaid), json(offer)]);
  assert.deepEqual(await client.getPrepaidCredits(), prepaid);
  assert.deepEqual(await client.getCreditGrantOffer(), offer);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, `https://api.anthropic.com/api/oauth/organizations/${ORG_ID}/prepaid/credits`);
  assert.equal(calls[2].url, `https://api.anthropic.com/api/oauth/organizations/${ORG_ID}/overage_credit_grant`);
  for (const call of calls.slice(1)) {
    assert.equal(call.method, 'GET');
    assert.equal(call.body, undefined);
    assert.equal(call.headers['x-organization-uuid'], ORG_ID);
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
  }
});

test('a refused prepaid or offer call is an error with a code, like every other call', async () => {
  const { client } = setup([
    json({ organization: { uuid: ORG_ID } }),
    json({ error: { type: 'not_found_error', message: 'no such organisation' } }, 404),
    json({ error: { message: `no offer for ${TOKEN}` } }, 403),
  ]);
  await assert.rejects(client.getPrepaidCredits(), (error) => error instanceof ClaudeCloudError && error.code === 'not_found');
  await assert.rejects(client.getCreditGrantOffer(), (error) => {
    assert.equal(error.code, 'bad_request');
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    return true;
  });
});

/** One entry of the repository list in the API's own shape. */
function repoEntry(owner, name, { defaultBranch = 'main', isPrivate = true, archived = false, disabled = false, pushedAt = '2031-02-01T10:00:00Z', description = null } = {}) {
  return {
    repo: {
      id: 1000 + name.length,
      name,
      owner: { login: owner, type: 'Organization' },
      default_branch: defaultBranch,
      visibility: isPrivate ? 'private' : 'public',
      private: isPrivate,
      archived,
      disabled,
      fork: false,
      permissions: { push: true, pull: true, admin: false },
      size: 120,
      description,
      language: 'JavaScript',
      pushed_at: pushedAt,
      topics: [],
    },
    status: 'active',
    ghe: false,
    gitlab: false,
    source_url: `https://github.com/${owner}/${name}`,
  };
}

test('listRepositories reads the organisation list, renames the entries and drops the disabled ones', async () => {
  const { client, calls } = setup([
    json({ organization: { uuid: ORG_ID } }),
    json({
      repos: [
        repoEntry('example-org', 'sample-repo', { description: 'Sample service' }),
        repoEntry('example-org', 'docs-site', { defaultBranch: 'trunk', isPrivate: false, pushedAt: '2031-01-15T09:30:00Z', description: 'Documentation' }),
        repoEntry('example-org', 'retired', { disabled: true, archived: true }),
        repoEntry('example-org', 'sample-repo'),
        { repo: { name: 'no-owner', owner: {} }, status: 'active' },
        { status: 'active' },
      ],
      is_complete: true,
      next_cursor: null,
      sso_required_orgs: [],
      source_warnings: [],
      skipped_nested: 0,
      sources: ['github_app'],
    }),
  ]);
  const listed = await client.listRepositories();
  assert.deepEqual(listed.repos, [
    {
      owner: 'example-org', name: 'sample-repo', slug: 'example-org/sample-repo', repoUrl: REPO_URL,
      defaultBranch: 'main', private: true, archived: false, pushedAt: '2031-02-01T10:00:00Z', description: 'Sample service',
    },
    {
      owner: 'example-org', name: 'docs-site', slug: 'example-org/docs-site', repoUrl: 'https://github.com/example-org/docs-site',
      defaultBranch: 'trunk', private: false, archived: false, pushedAt: '2031-01-15T09:30:00Z', description: 'Documentation',
    },
  ]);
  assert.equal(listed.complete, true);
  assert.equal(listed.raw.length, 1);
  assert.equal(listed.raw[0].sources[0], 'github_app');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `https://api.anthropic.com/api/oauth/organizations/${ORG_ID}/code/repos`);
  assert.equal(calls[1].method, 'GET');
  assert.equal(calls[1].body, undefined);
  assert.equal(calls[1].headers['x-organization-uuid'], ORG_ID);
  assert.equal(calls[1].headers.Authorization, `Bearer ${TOKEN}`);
});

test('listRepositories follows the cursor and reports an incomplete list', async () => {
  const { client, calls } = setup([
    json({ organization: { uuid: ORG_ID } }),
    json({ repos: [repoEntry('example-org', 'sample-repo')], is_complete: true, next_cursor: 'page-2 token' }),
    json({ repos: [repoEntry('sample-user', 'tiny-tool')], is_complete: false, next_cursor: null }),
  ]);
  const listed = await client.listRepositories();
  assert.deepEqual(listed.repos.map((repo) => repo.slug), ['example-org/sample-repo', 'sample-user/tiny-tool']);
  assert.equal(listed.complete, false, 'the API said so on the last page');
  assert.equal(listed.raw.length, 2);
  assert.equal(calls[2].url, `https://api.anthropic.com/api/oauth/organizations/${ORG_ID}/code/repos?cursor=page-2+token`);
  assert.equal(calls[1].url.includes('?'), false);
});

test('listRepositories stops after twenty pages and says the list is not complete', async () => {
  const pages = Array.from({ length: 25 }, (_, index) => json({
    repos: [repoEntry('example-org', `repo-${index}`)],
    is_complete: true,
    next_cursor: `cursor-${index + 1}`,
  }));
  const { client, calls } = setup([json({ organization: { uuid: ORG_ID } }), ...pages]);
  const listed = await client.listRepositories();
  assert.equal(listed.repos.length, 20);
  assert.equal(listed.complete, false);
  assert.equal(calls.length, 21);
});

test('an answer without repositories is an empty, complete list; a refusal is an error with a code', async () => {
  const empty = setup([json({ organization: { uuid: ORG_ID } }), json({})]);
  assert.deepEqual(await empty.client.listRepositories(), { repos: [], complete: true, raw: [{}] });

  const refused = setup([
    json({ organization: { uuid: ORG_ID } }),
    json({ error: { type: 'permission_error', message: `github_not_connected for ${TOKEN}` } }, 403),
  ]);
  await assert.rejects(refused.client.listRepositories(), (error) => {
    assert.ok(error instanceof ClaudeCloudError);
    assert.equal(error.code, 'github_not_connected');
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    return true;
  });
});

test('listRepositories reads the e2e fake\'s repository list: three repositories, the disabled one dropped', async () => {
  const fake = await startFakeClaudeCloudApi();
  try {
    const client = createClaudeCloudClient({ credentials: fakeCredentials([FAKE_CLOUD_TOKEN]), baseUrl: fake.baseUrl });
    const listed = await client.listRepositories();
    assert.equal(FAKE_CLOUD_REPOSITORIES.length, 4);
    assert.equal(FAKE_CLOUD_REPOSITORIES[3].repo.disabled, true);
    assert.deepEqual(listed.repos.map((repo) => [repo.slug, repo.defaultBranch, repo.private, repo.pushedAt, repo.description]), [
      ['example-org/sample-repo', 'main', true, '2031-02-01T10:00:00Z', 'Sample service'],
      ['example-org/docs-site', 'trunk', false, '2031-01-15T09:30:00Z', 'Documentation'],
      ['sample-user/tiny-tool', 'main', true, '2030-12-20T18:00:00Z', null],
    ]);
    assert.equal(listed.complete, true);
    assert.equal(fake.requestsTo('GET', /\/code\/repos$/).length, 1);
  } finally {
    await fake.stop();
  }
});

test('createSession sends the repository, the branch as revision, the plain model and the first message', async () => {
  const session = {
    id: SESSION_ID, session_url: 'https://claude.ai/code/cshk_01EXAMPLEcccccccccccccccc', title: 'Fix the slug helper', status: 'active',
  };
  const { client, calls } = setup([json({ deduplicated: false, session })]);
  const created = await client.createSession({
    title: 'Fix the slug helper',
    environmentId: ENVIRONMENT_ID,
    model: 'claude-sonnet-5-5[1m]',
    repoUrl: REPO_URL,
    branch: 'dev/slug-fix',
    content: 'Please fix slugify.',
    uuid: '11111111-1111-4111-8111-111111111111',
  });
  assert.deepEqual(created, {
    id: SESSION_ID,
    sessionUrl: 'https://claude.ai/code/cshk_01EXAMPLEcccccccccccccccc',
    deduplicated: false,
    flagSettingsRequestId: null,
    raw: { deduplicated: false, session },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/code/sessions');
  assert.deepEqual(calls[0].body, {
    title: 'Fix the slug helper',
    environment_id: ENVIRONMENT_ID,
    config: {
      model: 'claude-sonnet-5-5',
      sources: [{ type: 'git_repository', url: REPO_URL, revision: 'dev/slug-fix' }],
    },
    events: [{
      payload: {
        uuid: '11111111-1111-4111-8111-111111111111',
        session_id: '',
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'Please fix slugify.' },
      },
    }],
  });
});

test('createSession with flag settings puts their control request in front of the first message', async () => {
  const session = { id: SESSION_ID, session_url: null, title: 'Fix the slug helper', status: 'active' };
  const { client, calls } = setup([json({ deduplicated: false, session })]);
  const attribution = { commit: 'Co-authored-by: Sample Relay (Sample Model) <relay@example.com>', pr: '', sessionUrl: false };
  const created = await client.createSession({
    title: 'Fix the slug helper',
    environmentId: ENVIRONMENT_ID,
    model: 'claude-sonnet-5-5',
    repoUrl: REPO_URL,
    content: 'Please fix slugify.',
    uuid: '11111111-1111-4111-8111-111111111111',
    flagSettings: { attribution },
  });
  const [settings, first] = calls[0].body.events;
  assert.equal(calls[0].body.events.length, 2);
  assert.equal(settings.event_type, 'control_request');
  assert.match(settings.payload.uuid, UUID_PATTERN);
  assert.match(settings.payload.request_id, UUID_PATTERN);
  assert.deepEqual({ ...settings.payload, uuid: null, request_id: null }, {
    uuid: null,
    session_id: '',
    type: 'control_request',
    request_id: null,
    request: { subtype: 'apply_flag_settings', settings: { attribution } },
  });
  assert.equal(first.event_type, 'user');
  assert.equal(first.payload.uuid, '11111111-1111-4111-8111-111111111111');
  assert.equal(first.payload.message.content, 'Please fix slugify.');
  assert.equal(created.flagSettingsRequestId, settings.payload.request_id);
});

test('createSession without a branch sends no revision, and makes up a message uuid and a title', async () => {
  const blocks = [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    { type: 'text', text: 'What is on this picture?' },
  ];
  const { client, calls } = setup([json({ deduplicated: true, session: { id: SESSION_ID } })]);
  const created = await client.createSession({
    environmentId: ENVIRONMENT_ID, model: 'claude-sonnet-5-5', repoUrl: REPO_URL, branch: '  ', content: blocks,
  });
  assert.equal(created.sessionUrl, null);
  assert.equal(created.deduplicated, true);
  assert.deepEqual(calls[0].body.config.sources, [{ type: 'git_repository', url: REPO_URL }]);
  assert.ok(calls[0].body.title);
  assert.match(calls[0].body.events[0].payload.uuid, UUID_PATTERN);
  assert.deepEqual(calls[0].body.events[0].payload.message.content, blocks);
});

test('createSession refuses what the cloud cannot use before any call is made', async () => {
  const valid = { environmentId: ENVIRONMENT_ID, model: 'claude-sonnet-5-5', repoUrl: REPO_URL, content: 'hello' };
  for (const [change, code] of [
    [{ environmentId: '' }, 'environment_missing'],
    [{ environmentId: null }, 'environment_missing'],
    [{ repoUrl: '' }, 'bad_request'],
    [{ model: '[1m]' }, 'bad_request'],
    [{ model: null }, 'bad_request'],
    [{ content: '   ' }, 'bad_request'],
    [{ content: [] }, 'bad_request'],
    [{ content: undefined }, 'bad_request'],
  ]) {
    const { client, calls } = setup([]);
    await assert.rejects(client.createSession({ ...valid, ...change }), (error) => {
      assert.ok(error instanceof ClaudeCloudError);
      assert.equal(error.code, code, JSON.stringify(change));
      assert.equal(error.status, null);
      return true;
    });
    assert.equal(calls.length, 0);
  }
});

test('a create that is answered without a session id is transient, never a session', async () => {
  const { client } = setup([json({ deduplicated: false, session: {} })]);
  await assert.rejects(client.createSession({
    environmentId: ENVIRONMENT_ID, model: 'claude-sonnet-5-5', repoUrl: REPO_URL, content: 'hello',
  }), (error) => error.code === 'transient');
});

test('getSession returns the session itself, out of its response_shape wrapper', async () => {
  const shape = {
    id: SESSION_ID,
    status: 'active',
    worker_status: 'idle',
    external_metadata: {
      context_usage: { used_tokens: 1200, max_tokens: 200000 },
      usage: { cost_usd: 0.12, input_tokens: 10, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 40 },
      current_branches: { '': 'main' },
    },
  };
  const { client, calls } = setup([json({ response_shape: shape }), json(shape)]);
  const session = await client.getSession(SESSION_ID);
  assert.deepEqual(session, shape);
  assert.equal(session.external_metadata.usage.cost_usd, 0.12);
  // Readers that go by the wire shape find it too; it is not serialised twice.
  assert.equal(session.response_shape.worker_status, 'idle');
  assert.deepEqual(JSON.parse(JSON.stringify(session)), shape);
  assert.equal(calls[0].url, `https://api.anthropic.com/v1/code/sessions/${SESSION_ID}`);
  assert.equal(calls[0].method, 'GET');
  // An answer that is not wrapped is taken as the session.
  assert.deepEqual(await client.getSession(SESSION_ID), shape);
});

test('listEvents pages through the log from a cursor', async () => {
  const events = [
    { event_id: 'evt_01EXAMPLE0005', sequence_num: '5', event_type: 'assistant', source: 'worker', payload: { type: 'assistant' } },
    { event_id: 'evt_01EXAMPLE0006', sequence_num: '6', event_type: 'result', source: 'worker', payload: { type: 'result' } },
  ];
  const { client, calls } = setup([json({ data: events, next_cursor: '6' }), json({ data: [], next_cursor: null }), json({})]);
  assert.deepEqual(await client.listEvents(SESSION_ID, { cursor: 4, limit: 50 }), {
    events, nextCursor: '6', data: events, next_cursor: '6',
  });
  assert.equal(calls[0].url, `https://api.anthropic.com/v1/code/sessions/${SESSION_ID}/events?sort_order=asc&cursor=4&limit=50`);

  assert.deepEqual(await client.listEvents(SESSION_ID, { sortOrder: 'desc', cursor: '' }), {
    events: [], nextCursor: null, data: [], next_cursor: null,
  });
  assert.equal(calls[1].url, `https://api.anthropic.com/v1/code/sessions/${SESSION_ID}/events?sort_order=desc`);

  assert.deepEqual((await client.listEvents(SESSION_ID)).events, []);
  assert.equal(calls[2].url, `https://api.anthropic.com/v1/code/sessions/${SESSION_ID}/events?sort_order=asc`);
});

test('sendUserMessage posts a user event for the session and returns where the turn starts', async () => {
  const { client, calls } = setup([
    json({ results: [{ event_id: 'evt_01EXAMPLE0009', sequence_num: '9', duplicate: false }] }),
    json({ results: [{ event_id: 'evt_01EXAMPLE0010', sequence_num: 10, duplicate: true }] }),
  ]);
  assert.deepEqual(
    await client.sendUserMessage(SESSION_ID, 'And now the tests.', { uuid: '22222222-2222-4222-8222-222222222222' }),
    { eventId: 'evt_01EXAMPLE0009', sequence: '9', duplicate: false },
  );
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `https://api.anthropic.com/v1/code/sessions/${SESSION_ID}/events`);
  assert.deepEqual(calls[0].body, {
    events: [{
      event_type: 'user',
      payload: {
        uuid: '22222222-2222-4222-8222-222222222222',
        session_id: SESSION_ID,
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'And now the tests.' },
      },
    }],
  });

  // The sequence is text whatever the API sends, as on the stream.
  const second = await client.sendUserMessage(SESSION_ID, [{ type: 'text', text: 'again' }]);
  assert.deepEqual(second, { eventId: 'evt_01EXAMPLE0010', sequence: '10', duplicate: true });
  assert.match(calls[1].body.events[0].payload.uuid, UUID_PATTERN);
});

test('a message needs a session id and something to say', async () => {
  const { client, calls } = setup([]);
  for (const attempt of [
    () => client.sendUserMessage('', 'hello'),
    () => client.sendUserMessage(null, 'hello'),
    () => client.sendUserMessage(SESSION_ID, ''),
    () => client.sendUserMessage(SESSION_ID, []),
    () => client.getSession('  '),
    () => client.archiveSession(undefined),
    () => client.sendInterrupt(''),
    () => client.openEventStream('', {}),
  ]) {
    await assert.rejects(attempt(), (error) => error instanceof ClaudeCloudError && error.code === 'bad_request');
  }
  assert.equal(calls.length, 0);
});

test('a session id cannot reach into another path', async () => {
  const { client, calls } = setup([json({ response_shape: { id: 'x' } })]);
  await client.getSession('../triggers/trig_01EXAMPLE?x=1');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/code/sessions/..%2Ftriggers%2Ftrig_01EXAMPLE%3Fx%3D1');
});

test('sendControlResponse answers a control request with the decision', async () => {
  const { client, calls } = setup([json({ results: [{ event_id: 'evt_01EXAMPLE0012', sequence_num: '12', duplicate: false }] })]);
  const decision = { behavior: 'allow', updatedInput: { questions: [], answers: { 'Which colour?': 'Blue' } } };
  assert.deepEqual(
    await client.sendControlResponse(SESSION_ID, { requestId: 'req_01EXAMPLE', response: decision }),
    { eventId: 'evt_01EXAMPLE0012', sequence: '12', duplicate: false },
  );
  const [event] = calls[0].body.events;
  assert.equal(event.event_type, 'control_response');
  assert.match(event.payload.uuid, UUID_PATTERN);
  assert.deepEqual({ ...event.payload, uuid: null }, {
    uuid: null,
    session_id: SESSION_ID,
    type: 'control_response',
    response: { subtype: 'success', request_id: 'req_01EXAMPLE', response: decision },
  });
});

test('a control response without a request id or a decision is not sent', async () => {
  const { client, calls } = setup([]);
  await assert.rejects(client.sendControlResponse(SESSION_ID, { response: { behavior: 'deny', message: 'no' } }), { code: 'bad_request' });
  await assert.rejects(client.sendControlResponse(SESSION_ID, { requestId: 'req_01EXAMPLE' }), { code: 'bad_request' });
  assert.equal(calls.length, 0);
});

test('sendInterrupt posts an interrupt control request of its own', async () => {
  const { client, calls } = setup([json({ results: [{ event_id: 'evt_01EXAMPLE0014', sequence_num: '14', duplicate: false }] })]);
  const sent = await client.sendInterrupt(SESSION_ID);
  const [event] = calls[0].body.events;
  assert.equal(event.event_type, 'control_request');
  assert.match(event.payload.uuid, UUID_PATTERN);
  assert.match(event.payload.request_id, UUID_PATTERN);
  assert.notEqual(event.payload.uuid, event.payload.request_id);
  assert.deepEqual({ ...event.payload, uuid: null, request_id: null }, {
    uuid: null, session_id: SESSION_ID, type: 'control_request', request_id: null, request: { subtype: 'interrupt' },
  });
  assert.deepEqual(sent, { eventId: 'evt_01EXAMPLE0014', sequence: '14', duplicate: false, requestId: event.payload.request_id });
});

test('applyFlagSettings posts the settings as a control request; null for a key goes through as null', async () => {
  const { client, calls } = setup([json({ results: [{ event_id: 'evt_01EXAMPLE0015', sequence_num: '15', duplicate: false }] })]);
  const sent = await client.applyFlagSettings(SESSION_ID, { attribution: null });
  const [event] = calls[0].body.events;
  assert.equal(calls[0].body.events.length, 1);
  assert.equal(event.event_type, 'control_request');
  assert.deepEqual({ ...event.payload, uuid: null, request_id: null }, {
    uuid: null,
    session_id: SESSION_ID,
    type: 'control_request',
    request_id: null,
    request: { subtype: 'apply_flag_settings', settings: { attribution: null } },
  });
  assert.deepEqual(sent, { eventId: 'evt_01EXAMPLE0015', sequence: '15', duplicate: false, requestId: event.payload.request_id });
  await assert.rejects(client.applyFlagSettings(SESSION_ID, null), { code: 'bad_request' });
  assert.equal(calls.length, 1);
});

test('unarchiveSession posts an empty body; a session that is active already counts as done', async () => {
  const { client, calls } = setup([
    json({ session: { id: SESSION_ID, status: 'active' } }),
    json({ error: { type: 'conflict_error', message: 'session is not archived' } }, 409),
  ]);
  assert.deepEqual(await client.unarchiveSession(SESSION_ID), { unarchived: true, alreadyActive: false });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `https://api.anthropic.com/v1/code/sessions/${SESSION_ID}/unarchive`);
  assert.deepEqual(calls[0].body, {});
  assert.deepEqual(await client.unarchiveSession(SESSION_ID), { unarchived: true, alreadyActive: true });
});

test('archiveSession posts an empty body; an archived session counts as done', async () => {
  const { client, calls } = setup([
    json({}),
    json({ error: { type: 'conflict_error', message: 'session is already archived' } }, 409),
    new Response('conflict', { status: 409 }),
  ]);
  assert.deepEqual(await client.archiveSession(SESSION_ID), { archived: true, alreadyArchived: false });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `https://api.anthropic.com/v1/code/sessions/${SESSION_ID}/archive`);
  assert.deepEqual(calls[0].body, {});
  assert.deepEqual(await client.archiveSession(SESSION_ID), { archived: true, alreadyArchived: true });
  assert.deepEqual(await client.archiveSession(SESSION_ID), { archived: true, alreadyArchived: true });
});

test('archiving a session the cloud does not know is not_found', async () => {
  const { client } = setup([json({ type: 'error', error: { type: 'not_found_error', message: 'session not found' } }, 404)]);
  await assert.rejects(client.archiveSession(SESSION_ID), (error) => {
    assert.equal(error.code, 'not_found');
    assert.equal(error.status, 404);
    assert.equal(error.detail, 'session not found');
    return true;
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

test('a refused call becomes the error code its status and its body name', async () => {
  for (const [status, body, code] of [
    [400, { error: { type: 'invalid_request_error', message: 'events: field required' } }, 'bad_request'],
    [403, { error: { type: 'permission_error', message: 'not allowed' } }, 'bad_request'],
    [409, { error: { message: 'conflict' } }, 'bad_request'],
    [422, 'plain text refusal', 'bad_request'],
    [404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } }, 'not_found'],
    [429, { error: { type: 'rate_limit_error', message: 'too many requests' } }, 'rate_limited'],
    [408, '', 'transient'],
    [500, { error: { type: 'api_error', message: 'internal' } }, 'transient'],
    [502, '<html>bad gateway</html>', 'transient'],
    [503, '', 'transient'],
    [529, { error: { type: 'overloaded_error', message: 'overloaded' } }, 'transient'],
    // What the body names wins over the bare status.
    [400, { error: { type: 'invalid_request_error', reason: 'github_token_missing', message: 'no GitHub token' } }, 'github_not_connected'],
    [403, { reason: 'source_unavailable', sub_reason: 'github_token_missing' }, 'github_not_connected'],
    [400, { error: { message: 'GitHub is not connected for this account' } }, 'github_not_connected'],
    [403, { error: { type: 'repo_access_denied', message: 'the app cannot read this repository' } }, 'repo_access_denied'],
    [404, { error: { reason: 'repo_access_denied' } }, 'repo_access_denied'],
    [400, { message: 'clone failed', sub_reason: 'repository_access_denied' }, 'repo_access_denied'],
    [404, { error: { type: 'not_found_error', message: 'environment not found' } }, 'environment_missing'],
    [400, { error: { message: 'environment_id env_01EXAMPLE does not exist' } }, 'environment_missing'],
    [400, { error: { reason: 'environment_not_found' } }, 'environment_missing'],
    [400, { error: { message: 'invalid environment' } }, 'environment_missing'],
    // A server fault stays one, whatever its text mentions.
    [500, { error: { message: 'github_token_missing while environment not found' } }, 'transient'],
  ]) {
    const response = typeof body === 'string' ? new Response(body, { status }) : json(body, status);
    const { client, calls } = setup([response]);
    await assert.rejects(client.getSession(SESSION_ID), (error) => {
      assert.ok(error instanceof ClaudeCloudError, `${status} ${JSON.stringify(body)}`);
      assert.ok(error instanceof CredentialsError, 'one error class for both modules');
      assert.equal(error.code, code, `${status} ${JSON.stringify(body)}`);
      assert.equal(error.status, status);
      assert.ok(error.message.length > 10);
      return true;
    });
    assert.equal(calls.length, 1, 'only a 401 is tried again');
  }
});

test('the classifier alone: status ranges and the 401 that is left after the retry', () => {
  assert.equal(classifyClaudeCloudFailure(401, { type: 'authentication_error', message: 'invalid bearer token' }), 'login_expired');
  assert.equal(classifyClaudeCloudFailure(401, { reason: 'github_token_missing' }), 'github_not_connected');
  assert.equal(classifyClaudeCloudFailure(404), 'not_found');
  assert.equal(classifyClaudeCloudFailure(425), 'transient');
  assert.equal(classifyClaudeCloudFailure(599), 'transient');
  assert.equal(classifyClaudeCloudFailure(418), 'bad_request');
});

test('error messages say what happened in plain words and keep what the API said', async () => {
  const { client } = setup([
    json({ error: { type: 'invalid_request_error', message: 'events: field required' } }, 400),
    json({ error: { message: 'boom' } }, 503),
    json({ reason: 'github_token_missing' }, 400),
  ]);
  await assert.rejects(client.getSession(SESSION_ID), (error) => {
    assert.equal(error.message, 'Claude Cloud refused the request (HTTP 400). events: field required');
    assert.equal(error.detail, 'events: field required');
    return true;
  });
  await assert.rejects(client.getSession(SESSION_ID), (error) => {
    assert.equal(error.message, 'Claude Cloud is not answering right now (HTTP 503).');
    assert.equal(error.detail, 'boom');
    return true;
  });
  await assert.rejects(client.getSession(SESSION_ID), (error) => {
    assert.equal(error.message, 'GitHub is not connected to this Claude account.');
    return true;
  });
});

test('a long error body is cut, not passed on whole', async () => {
  const { client } = setup([new Response(`<html>${'x'.repeat(5000)}</html>`, { status: 400 })]);
  await assert.rejects(client.getSession(SESSION_ID), (error) => {
    assert.ok(error.detail.length <= 501);
    assert.ok(error.message.length < 600);
    return true;
  });
});

test('a 429 says how long to wait when the API does', async () => {
  const { client } = setup([
    json({ error: { type: 'rate_limit_error', message: 'slow down' } }, 429, { 'retry-after': '12' }),
    json({ error: { type: 'rate_limit_error', message: 'slow down' } }, 429),
  ]);
  await assert.rejects(client.getAccountUsage(), (error) => error.code === 'rate_limited' && error.retryAfterMs === 12_000);
  await assert.rejects(client.getAccountUsage(), (error) => error.code === 'rate_limited' && error.retryAfterMs === undefined);
});

test('a 401 is tried once more with the token read afresh', async () => {
  const { client, calls, credentials } = setup([
    json({ type: 'error', error: { type: 'authentication_error', message: 'invalid bearer token' } }, 401),
    json({ response_shape: { id: SESSION_ID, status: 'active' } }),
  ], { tokens: [TOKEN, SECOND_TOKEN] });
  const session = await client.getSession(SESSION_ID);
  assert.equal(session.status, 'active');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[1].headers.Authorization, `Bearer ${SECOND_TOKEN}`);
  assert.equal(calls[1].url, calls[0].url);
  assert.deepEqual(credentials.asked, [null, { forceReload: true }]);
});

test('the retry repeats the whole request, body included', async () => {
  const { client, calls } = setup([
    json({ error: { message: 'unauthorized' } }, 401),
    json({ results: [{ event_id: 'evt_01EXAMPLE0020', sequence_num: '20', duplicate: false }] }),
  ], { tokens: [TOKEN, SECOND_TOKEN] });
  await client.sendUserMessage(SESSION_ID, 'hello', { uuid: '33333333-3333-4333-8333-333333333333' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, calls[0].body);
  assert.equal(calls[1].method, 'POST');
});

test('a second 401 is login_expired, and there is no third try', async () => {
  const { client, calls, credentials } = setup([
    json({ error: { type: 'authentication_error', message: 'invalid bearer token' } }, 401),
    json({ error: { type: 'authentication_error', message: 'invalid bearer token' } }, 401),
  ], { tokens: [TOKEN, SECOND_TOKEN] });
  await assert.rejects(client.getSession(SESSION_ID), (error) => {
    assert.equal(error.code, 'login_expired');
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(credentials.asked, [null, { forceReload: true }]);
});

test('a 401 after a later answer does not get a second retry either', async () => {
  // Only the first answer of a call may be retried; the count is per call.
  const { client, calls } = setup([
    json({ error: { message: 'unauthorized' } }, 401),
    json({ error: { message: 'unauthorized' } }, 401),
    json({ error: { message: 'unauthorized' } }, 401),
    json({ five_hour: null }),
  ], { tokens: [TOKEN] });
  await assert.rejects(client.getAccountUsage(), { code: 'login_expired' });
  assert.equal(calls.length, 2);
  assert.deepEqual(await client.getAccountUsage(), { five_hour: null });
  assert.equal(calls.length, 4, 'the next call has its own one retry');
});

test('when the fresh read finds the login gone, that is the error, and nothing is sent again', async () => {
  const { client, calls } = setup([
    json({ error: { message: 'unauthorized' } }, 401),
  ], { tokens: [TOKEN, new ClaudeCloudError('login_expired')] });
  await assert.rejects(client.getSession(SESSION_ID), { code: 'login_expired' });
  assert.equal(calls.length, 1);
});

test('without a login no call is made', async () => {
  const { client, calls } = setup([], { tokens: [new ClaudeCloudError('login_missing')] });
  await assert.rejects(client.getAccountUsage(), { code: 'login_missing' });
  await assert.rejects(client.listEnvironments(), { code: 'login_missing' });
  await assert.rejects(client.openEventStream(SESSION_ID, {}), { code: 'login_missing' });
  assert.equal(calls.length, 0);
});

test('the token is taken out of every error, wherever the API or fetch put it', async () => {
  const { client } = setup([
    json({ error: { type: 'invalid_request_error', message: `bad header "Bearer ${TOKEN}"`, echo: TOKEN } }, 400),
    new Response(`upstream said: ${TOKEN} is not valid`, { status: 502 }),
    new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`),
    json({ error: { message: `unauthorized ${TOKEN}` } }, 401),
    json({ error: { message: `still unauthorized ${SECOND_TOKEN} ${TOKEN}` } }, 401),
    new Response(`not json ${TOKEN}`, { status: 200 }),
  ], { tokens: [TOKEN, TOKEN, TOKEN, TOKEN, SECOND_TOKEN, TOKEN] });
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(client.getSession(SESSION_ID), (error) => {
      seen.push(error.code);
      const everything = [error.message, error.detail, error.stack, JSON.stringify(error), String(error.cause ?? '')].join('\n');
      assert.doesNotMatch(everything, /test-token/, `error ${i}: ${error.code}`);
      assert.match(everything, /\[redacted\]/, `error ${i}: the place of the token is marked`);
      return true;
    });
  }
  assert.deepEqual(seen, ['bad_request', 'transient', 'transient', 'login_expired', 'transient']);
});

test('with the real credentials module the token of the login is redacted too', async () => {
  const fetchImpl = scriptedFetch([
    json({ error: { message: `token ${TOKEN} was refused` } }, 403),
  ]);
  const credentials = createClaudeCloudCredentials({
    env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
    homedir: () => '/home/dev',
    fsImpl: { readFileSync() { throw new Error('the file is not read while the env token is set'); } },
  });
  const client = createClaudeCloudClient({ credentials, fetchImpl });
  await assert.rejects(client.getAccountUsage(), (error) => {
    assert.equal(error.code, 'bad_request');
    assert.equal(error.detail, 'token [redacted] was refused');
    assert.equal(error.message, 'Claude Cloud refused the request (HTTP 403). token [redacted] was refused');
    return true;
  });
  assert.equal(fetchImpl.calls[0].headers.Authorization, `Bearer ${TOKEN}`);
});

test('nothing a call returns contains the token', async () => {
  const { client } = setup([
    json({ organization: { uuid: ORG_ID } }),
    json({ environments: [{ environment_id: ENVIRONMENT_ID, name: 'Default', kind: 'anthropic_cloud', state: 'active' }] }),
    json({ session: { id: SESSION_ID, session_url: 'https://claude.ai/code/cshk_01EXAMPLEcccccccccccccccc' } }),
    json({ results: [{ event_id: 'evt_01EXAMPLE0030', sequence_num: '30' }] }),
    sseResponse([clientEvent(31, { type: 'result', subtype: 'success' })]),
  ]);
  const returned = [
    await client.listEnvironments(),
    await client.createSession({ environmentId: ENVIRONMENT_ID, model: 'claude-sonnet-5-5', repoUrl: REPO_URL, content: 'hello' }),
    await client.sendInterrupt(SESSION_ID),
    await client.openEventStream(SESSION_ID, {}),
    Object.keys(client),
  ];
  assert.doesNotMatch(JSON.stringify(returned), /test-token/);
});

test('a network failure is transient and keeps its cause code as detail', async () => {
  const { client, calls } = setup([
    Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }),
    new TypeError('fetch failed'),
  ]);
  await assert.rejects(client.getAccountUsage(), (error) => {
    assert.ok(error instanceof ClaudeCloudError);
    assert.equal(error.code, 'transient');
    assert.equal(error.status, null);
    assert.equal(error.detail, 'ECONNREFUSED');
    assert.equal(error.message, 'Claude Cloud could not be reached.');
    return true;
  });
  await assert.rejects(client.getAccountUsage(), (error) => error.code === 'transient' && error.detail === 'fetch failed');
  assert.equal(calls.length, 2, 'a network failure is not retried here');
});

test('a call that gets no answer in time is transient', async () => {
  const { client } = setup([
    (call) => new Promise((resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
    }),
  ], { requestTimeoutMs: 20 });
  await assert.rejects(client.getAccountUsage(), (error) => {
    assert.equal(error.code, 'transient');
    assert.match(error.message, /did not answer within/);
    return true;
  });
});

test('a 2xx answer that is not JSON is transient; an empty one is null', async () => {
  const { client } = setup([new Response('<html>maintenance</html>', { status: 200 }), new Response('', { status: 200 })]);
  await assert.rejects(client.getAccountUsage(), (error) => error.code === 'transient' && error.status === 200);
  assert.equal(await client.getAccountUsage(), null);
});

// ---------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------

test('openEventStream hands over every frame in order and skips the keepalives', async () => {
  const { client, calls } = setup([sseResponse([
    ':keepalive\n\n',
    'event: session_update\ndata: {"connection_status":"connected"}\n\n',
    clientEvent(4, { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } }),
    ':keepalive\n\n',
    'event: delivery_update\ndata: {"event_id":"evt_01EXAMPLE0003","status":"DELIVERY_STATUS_PROCESSED"}\n\n',
    clientEvent(5, { type: 'result', subtype: 'success', is_error: false, result: 'Done.' }),
  ])]);
  const seen = [];
  let keepalives = 0;
  const outcome = await client.openEventStream(SESSION_ID, {
    onOpen: () => seen.push('open'),
    onEvent: (event) => seen.push(event),
    onKeepalive: () => { keepalives += 1; },
  });
  assert.deepEqual(outcome, { reason: 'ended', lastEventId: '5', error: null });
  assert.equal(seen[0], 'open');
  assert.deepEqual(seen.slice(1).map((event) => [event.kind, event.id]), [
    ['session_update', null],
    ['client_event', '4'],
    ['delivery_update', null],
    ['client_event', '5'],
  ]);
  assert.deepEqual(Object.keys(seen[2]), ['kind', 'id', 'data']);
  assert.deepEqual(seen[1].data, { connection_status: 'connected' });
  assert.equal(seen[2].data.sequence_num, '4');
  assert.equal(seen[2].data.payload.message.content[0].text, 'Working on it.');
  assert.equal(seen[4].data.payload.result, 'Done.');
  assert.equal(keepalives, 2);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, `https://api.anthropic.com/v1/code/sessions/${SESSION_ID}/events/stream`);
  assert.equal(calls[0].headers.Accept, 'text/event-stream');
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal('Last-Event-ID' in calls[0].headers, false);
});

test('openEventStream resumes after the id the caller handled last', async () => {
  const { client, calls } = setup([sseResponse([':keepalive\n\n']), sseResponse([])]);
  assert.deepEqual(await client.openEventStream(SESSION_ID, { lastEventId: 41 }), { reason: 'ended', lastEventId: '41', error: null });
  assert.equal(calls[0].headers['Last-Event-ID'], '41');
  await client.openEventStream(SESSION_ID, { lastEventId: '' });
  assert.equal('Last-Event-ID' in calls[1].headers, false);
});

test('openEventStream: frames cut anywhere between chunks, CRLF line ends, and text cut inside a character', async () => {
  const text = [
    ':keepalive\r\n\r\n',
    clientEvent(1, { type: 'assistant', message: { content: [{ type: 'text', text: 'Grüße – 完了 ✓' }] } }, '\r\n'),
    clientEvent(2, { type: 'result', subtype: 'success', result: 'ok' }, '\r\n'),
  ].join('');
  const bytes = encoder.encode(text);
  for (const size of [1, 2, 3, 7, 64, bytes.length]) {
    const chunks = [];
    for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.slice(at, at + size));
    const { client } = setup([sseResponse(chunks)]);
    const seen = [];
    const outcome = await client.openEventStream(SESSION_ID, { onEvent: (event) => seen.push(event) });
    assert.equal(outcome.reason, 'ended');
    assert.deepEqual(seen.map((event) => event.id), ['1', '2'], `chunks of ${size}`);
    assert.equal(seen[0].data.payload.message.content[0].text, 'Grüße – 完了 ✓', `chunks of ${size}`);
  }
});

test('openEventStream: a frame over several data lines is one JSON value', async () => {
  const { client } = setup([sseResponse(['event: client_event\nid: 9\ndata: {"sequence_num":"9",\ndata: "payload":{"type":"result"}}\n\n'])]);
  const seen = [];
  await client.openEventStream(SESSION_ID, { onEvent: (event) => seen.push(event) });
  assert.deepEqual(seen, [{ kind: 'client_event', id: '9', data: { sequence_num: '9', payload: { type: 'result' } } }]);
});

test('openEventStream: a frame the stream did not finish is not delivered and does not move the cursor', async () => {
  const whole = clientEvent(6, { type: 'assistant', message: { content: [] } });
  const cut = clientEvent(7, { type: 'result', subtype: 'success' });
  for (const tail of [cut.slice(0, -1), cut.slice(0, 40), 'event: client_event\nid: 7\n']) {
    const { client } = setup([sseResponse([whole, tail])]);
    const seen = [];
    const outcome = await client.openEventStream(SESSION_ID, { lastEventId: '5', onEvent: (event) => seen.push(event.id) });
    assert.deepEqual(seen, ['6']);
    assert.deepEqual(outcome, { reason: 'ended', lastEventId: '6', error: null });
  }
});

test('openEventStream: frames without data or with data that is no JSON value are skipped', async () => {
  const { client } = setup([sseResponse([
    'event: ping\n\n',
    'event: client_event\nid: 3\ndata: not json\n\n',
    'event: ephemeral_event\ndata: null\n\n',
    clientEvent(4, { type: 'result', subtype: 'success' }),
  ])]);
  const seen = [];
  const outcome = await client.openEventStream(SESSION_ID, { onEvent: (event) => seen.push(event.id) });
  assert.deepEqual(seen, ['4']);
  assert.equal(outcome.lastEventId, '4');
});

test('openEventStream waits for an async onEvent before the next frame', async () => {
  const { client } = setup([sseResponse([
    clientEvent(1, { type: 'assistant' }) + clientEvent(2, { type: 'assistant' }),
    clientEvent(3, { type: 'result' }),
  ])]);
  const order = [];
  await client.openEventStream(SESSION_ID, {
    onEvent: async (event) => {
      order.push(`start ${event.id}`);
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`end ${event.id}`);
    },
  });
  assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
});

test('openEventStream: an error thrown by onEvent ends the stream and reaches the caller', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(clientEvent(1, { type: 'assistant' }))); },
    cancel() { cancelled = true; },
  });
  const { client } = setup([new Response(body, { status: 200 })]);
  await assert.rejects(
    client.openEventStream(SESSION_ID, { onEvent: () => { throw new Error('handler broke'); } }),
    /handler broke/,
  );
  assert.equal(cancelled, true, 'the connection is not left open');
});

test('openEventStream resolves when the signal aborts, and closes the connection', async () => {
  let cancelled = false;
  let fetchSignal = null;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(clientEvent(1, { type: 'assistant' }) + clientEvent(2, { type: 'assistant' }))); },
    cancel() { cancelled = true; },
  });
  const { client } = setup([(call) => {
    fetchSignal = call.signal;
    return new Response(body, { status: 200 });
  }]);
  const abort = new AbortController();
  const seen = [];
  const outcome = await client.openEventStream(SESSION_ID, {
    signal: abort.signal,
    onEvent: (event) => {
      seen.push(event.id);
      abort.abort();
    },
  });
  assert.deepEqual(outcome, { reason: 'aborted', lastEventId: '1', error: null });
  assert.deepEqual(seen, ['1'], 'nothing is delivered after the abort');
  assert.equal(cancelled, true);
  assert.equal(fetchSignal.aborted, true);
});

test('openEventStream: an abort while the stream is silent ends the wait', async () => {
  const body = new ReadableStream({ start() {} });
  const { client } = setup([new Response(body, { status: 200 })]);
  const abort = new AbortController();
  const pending = client.openEventStream(SESSION_ID, { signal: abort.signal, onOpen: () => setImmediate(() => abort.abort()) });
  assert.deepEqual(await pending, { reason: 'aborted', lastEventId: null, error: null });
});

test('openEventStream with a signal that is aborted already makes no call', async () => {
  const { client, calls } = setup([]);
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(
    await client.openEventStream(SESSION_ID, { signal: abort.signal, lastEventId: '12' }),
    { reason: 'aborted', lastEventId: '12', error: null },
  );
  assert.equal(calls.length, 0);
});

test('openEventStream: an abort while connecting resolves instead of throwing', async () => {
  const abort = new AbortController();
  const { client } = setup([(call) => new Promise((resolve, reject) => {
    call.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
    setImmediate(() => abort.abort());
  })]);
  assert.deepEqual(await client.openEventStream(SESSION_ID, { signal: abort.signal }), { reason: 'aborted', lastEventId: null, error: null });
});

test('openEventStream: a connection that breaks mid-stream resolves as an error the caller reconnects from', async () => {
  const body = new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(clientEvent(8, { type: 'assistant' }))); },
    pull(controller) { controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } })); },
  });
  const { client } = setup([new Response(body, { status: 200 })]);
  const seen = [];
  const outcome = await client.openEventStream(SESSION_ID, { onEvent: (event) => seen.push(event.id) });
  assert.deepEqual(seen, ['8']);
  assert.equal(outcome.reason, 'error');
  assert.equal(outcome.lastEventId, '8');
  assert.ok(outcome.error instanceof ClaudeCloudError);
  assert.equal(outcome.error.code, 'transient');
  assert.equal(outcome.error.detail, 'ECONNRESET');
});

test('openEventStream: a stream that goes silent ends as idle when the caller set a limit', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(clientEvent(2, { type: 'assistant' }))); },
    cancel() { cancelled = true; },
  });
  const { client } = setup([new Response(body, { status: 200 })]);
  const outcome = await client.openEventStream(SESSION_ID, { idleTimeoutMs: 25 });
  assert.deepEqual(outcome, { reason: 'idle', lastEventId: '2', error: null });
  assert.equal(cancelled, true);
});

test('openEventStream throws the mapped error when the stream cannot be opened', async () => {
  const { client } = setup([
    json({ error: { type: 'not_found_error', message: 'session not found' } }, 404),
    new TypeError('fetch failed'),
    new Response('', { status: 503 }),
  ]);
  const opened = [];
  const options = { onOpen: () => opened.push(1) };
  await assert.rejects(client.openEventStream(SESSION_ID, options), { code: 'not_found', status: 404 });
  await assert.rejects(client.openEventStream(SESSION_ID, options), { code: 'transient' });
  await assert.rejects(client.openEventStream(SESSION_ID, options), { code: 'transient', status: 503 });
  assert.deepEqual(opened, []);
});

test('openEventStream retries its 401 once like every other call', async () => {
  const { client, calls, credentials } = setup([
    json({ error: { message: 'unauthorized' } }, 401),
    sseResponse([clientEvent(1, { type: 'result' })]),
    json({ error: { message: 'unauthorized' } }, 401),
    json({ error: { message: 'unauthorized' } }, 401),
  ], { tokens: [TOKEN, SECOND_TOKEN] });
  const seen = [];
  const outcome = await client.openEventStream(SESSION_ID, { lastEventId: '0', onEvent: (event) => seen.push(event.id) });
  assert.equal(outcome.reason, 'ended');
  assert.deepEqual(seen, ['1']);
  assert.equal(calls[1].headers.Authorization, `Bearer ${SECOND_TOKEN}`);
  assert.equal(calls[1].headers.Accept, 'text/event-stream');
  assert.equal(calls[1].headers['Last-Event-ID'], '0');
  assert.deepEqual(credentials.asked.slice(0, 2), [null, { forceReload: true }]);

  await assert.rejects(client.openEventStream(SESSION_ID, {}), { code: 'login_expired' });
  assert.equal(calls.length, 4);
});

test('the open stream is not under the request timeout', async () => {
  let push;
  const body = new ReadableStream({ start(controller) { push = controller; } });
  const { client } = setup([new Response(body, { status: 200 })], { requestTimeoutMs: 15 });
  const seen = [];
  const pending = client.openEventStream(SESSION_ID, { onEvent: (event) => seen.push(event.id) });
  await new Promise((resolve) => setTimeout(resolve, 60));
  push.enqueue(encoder.encode(clientEvent(3, { type: 'result' })));
  push.close();
  assert.equal((await pending).reason, 'ended');
  assert.deepEqual(seen, ['3']);
});

// ---------------------------------------------------------------------------
// The message builder and the surface
// ---------------------------------------------------------------------------

test('the user message is the SDK shape the cloud takes', () => {
  assert.deepEqual(buildClaudeCloudUserMessage({ content: 'hi', sessionId: SESSION_ID, uuid: '44444444-4444-4444-8444-444444444444' }), {
    uuid: '44444444-4444-4444-8444-444444444444',
    session_id: SESSION_ID,
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: 'hi' },
  });
  const made = buildClaudeCloudUserMessage({ content: 'hi' });
  assert.equal(made.session_id, '');
  assert.match(made.uuid, UUID_PATTERN);
});

test('the client offers exactly the calls of the contract', () => {
  const { client } = setup([]);
  assert.deepEqual(Object.keys(client).sort(), [
    'applyFlagSettings', 'archiveSession', 'createSession', 'getAccountUsage', 'getCreditGrantOffer', 'getOrganizationId',
    'getPrepaidCredits', 'getSession', 'listEnvironments', 'listEvents', 'listRepositories', 'openEventStream',
    'sendControlResponse', 'sendInterrupt', 'sendUserMessage', 'unarchiveSession',
  ]);
  for (const call of Object.values(client)) assert.equal(typeof call, 'function');
});
