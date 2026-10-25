'use strict';

import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { summarizeRemoteRelayCall } from '../../shared/remote-relay-contract.mjs';
import { cleanTaskOutput } from '../../shared/task-output-text.mjs';
import { createDeepSeekSettingsService } from './deepseek-settings-service.mjs';

import {
  MAX_REMEMBERED_SECRETS,
  MIN_REDACTED_KEY_PREFIX_LENGTH,
  MIN_REDACTED_SECRET_LENGTH,
  SAVED_PROVIDER_KEY_SETTINGS,
  createWorkerPostRedaction,
  isWorkerPostRequest,
  readSavedProviderKeys,
  redactSecretsDeep,
  redactSecretsInText,
} from './worker-secret-redaction.mjs';

// Not of the `sk-` shape, so only the saved-key path can take it out.
const SAVED_KEY = 'relay-test-key-redact-00000000';
// DeepSeek's shape, `sk-` and 32 hex digits, built here so no key-shaped
// literal is in the file.
const DEEPSEEK_SHAPED_KEY = `sk-${'0123456789abcdef'.repeat(2)}`;
const SETTINGS = Object.freeze({ deepseek_api_key: SAVED_KEY });
const readSetting = (key) => SETTINGS[key] || '';
const WORKER_HEADERS = Object.freeze({ 'x-relay-session-id': 'session-redact-1' });

test('the exact key is replaced wherever it appears in a text', () => {
  assert.equal(
    redactSecretsInText(`token=${SAVED_KEY} and again "${SAVED_KEY}"`, [SAVED_KEY]),
    'token=[redacted] and again "[redacted]"',
  );
  // A near miss inside a text stays.
  const nearMiss = `${SAVED_KEY.slice(0, -1)}x and more`;
  assert.equal(redactSecretsInText(nearMiss, [SAVED_KEY]), nearMiss);
});

test('a text that ends in the first part of a key loses it, from the shortest part that counts', () => {
  const head = SAVED_KEY.slice(0, MIN_REDACTED_KEY_PREFIX_LENGTH);
  assert.equal(redactSecretsInText(`key: ${head}`, [SAVED_KEY]), 'key: [redacted]');
  assert.equal(redactSecretsInText(`key: ${SAVED_KEY.slice(0, -1)}`, [SAVED_KEY]), 'key: [redacted]');
  // Cut short by the worker, before its ellipsis.
  assert.equal(redactSecretsInText(`Tool (Bash): echo ${SAVED_KEY.slice(0, 12)}…`, [SAVED_KEY]), 'Tool (Bash): echo [redacted]…');
  assert.equal(redactSecretsInText(`echo ${SAVED_KEY.slice(0, 12)}...`, [SAVED_KEY]), 'echo [redacted]...');
  // A shorter tail, the same part not at the end, and the bare `sk-` stay.
  const shortTail = `key: ${SAVED_KEY.slice(0, MIN_REDACTED_KEY_PREFIX_LENGTH - 1)}`;
  assert.equal(redactSecretsInText(shortTail, [SAVED_KEY]), shortTail);
  const inside = `${SAVED_KEY.slice(0, 12)} is how it starts`;
  assert.equal(redactSecretsInText(inside, [SAVED_KEY]), inside);
  assert.equal(redactSecretsInText('DeepSeek keys start with sk-', [DEEPSEEK_SHAPED_KEY]), 'DeepSeek keys start with sk-');
  // A tail that only starts like the key, then differs, stays.
  const differs = `key: ${SAVED_KEY.slice(0, 10)}Z`;
  assert.equal(redactSecretsInText(differs, [SAVED_KEY]), differs);
  // The longest part wins: the key's start, then its start again.
  assert.equal(redactSecretsInText(`${head}${SAVED_KEY.slice(0, 20)}`, [SAVED_KEY]), `${head}[redacted]`);
});

test('the first part of a key the worker clipped goes, wherever the ellipsis is and whatever follows it', () => {
  // The remote-relay activity line, as the workers build it: the text clipped
  // at 60 characters inside quotes, so the line goes on after the ellipsis.
  const text = `Please use this DeepSeek key for the job: ${DEEPSEEK_SHAPED_KEY}`;
  const sent = `Tool (remote_relay): ${summarizeRemoteRelayCall({ action: 'send', relay: 'other-relay', session: 'session-0001', text })}`;
  const clipped = DEEPSEEK_SHAPED_KEY.slice(0, 17);
  assert.ok(sent.endsWith(`${clipped}…”`), sent);
  assert.equal(
    redactSecretsInText(sent, [DEEPSEEK_SHAPED_KEY]),
    sent.replace(clipped, '[redacted]'),
  );
  const asked = `Tool (remote_relay): ${summarizeRemoteRelayCall({ action: 'ask', relay: 'other-relay', question: text, urgency: 'now' })}`;
  assert.ok(asked.endsWith(`${clipped}…” (now)`), asked);
  assert.equal(redactSecretsInText(asked, [DEEPSEEK_SHAPED_KEY]), asked.replace(clipped, '[redacted]'));

  // Other ways a worker marks a cut, with what comes after it.
  const part = SAVED_KEY.slice(0, 12);
  for (const after of ['…"', '…)', ' …', '⋯', '..', '...', ' [truncated]', '[truncated]', '……', '…\nnext line', '... and more']) {
    assert.equal(redactSecretsInText(`echo ${part}${after}`, [SAVED_KEY]), `echo [redacted]${after}`, JSON.stringify(after));
  }
  // Several cuts in one text each go; the whole key still goes as before.
  assert.equal(
    redactSecretsInText(`a ${part}… b ${SAVED_KEY.slice(0, 9)}... c ${SAVED_KEY}`, [SAVED_KEY]),
    'a [redacted]… b [redacted]... c [redacted]',
  );

  // Not cut, too short, or not the key: ordinary text before an ellipsis stays.
  for (const kept of [
    'Wait for it... then go',
    'Loading…',
    `${SAVED_KEY.slice(0, MIN_REDACTED_KEY_PREFIX_LENGTH - 1)}… is no key part`,
    `${part} goes on, then…`,
    `${SAVED_KEY.slice(0, 10)}Z…`,
    'DeepSeek keys start with sk-…',
    'one. two. three.',
  ]) {
    assert.equal(redactSecretsInText(kept, [SAVED_KEY, DEEPSEEK_SHAPED_KEY]), kept, kept);
  }
});

test('the middleware takes a clipped key out of the remote-relay activity line', () => {
  const settings = { deepseek_api_key: DEEPSEEK_SHAPED_KEY };
  const middleware = createWorkerPostRedaction({ readSetting: (key) => settings[key] || '' });
  const line = `Tool (remote_relay): ${summarizeRemoteRelayCall({
    action: 'send',
    relay: 'other-relay',
    text: `Please use this DeepSeek key for the job: ${DEEPSEEK_SHAPED_KEY}`,
  })}`;
  const body = { messageId: 'm-1', conversationId: 'c-1', text: line };
  const out = runMiddleware(middleware, { method: 'POST', path: '/api/activity', headers: WORKER_HEADERS, body });
  assert.equal(out.text.includes(DEEPSEEK_SHAPED_KEY.slice(0, MIN_REDACTED_KEY_PREFIX_LENGTH)), false, out.text);
  assert.match(out.text, /\[redacted\]…”$/);
});

test('a text that starts with the last part of a key loses it, also after a leading ellipsis', () => {
  // All of DeepSeek's secret part: the 32 hex digits after `sk-`.
  const digits = DEEPSEEK_SHAPED_KEY.slice(3);
  assert.equal(redactSecretsInText(`${digits}\nnext line\n`, [DEEPSEEK_SHAPED_KEY]), '[redacted]\nnext line\n');
  const end = SAVED_KEY.slice(-MIN_REDACTED_KEY_PREFIX_LENGTH);
  assert.equal(redactSecretsInText(`${end} rest`, [SAVED_KEY]), '[redacted] rest');
  assert.equal(redactSecretsInText(SAVED_KEY.slice(1), [SAVED_KEY]), '[redacted]');
  for (const lead of ['…', '… ', '...', '⋯', '[truncated] ']) {
    assert.equal(redactSecretsInText(`${lead}${SAVED_KEY.slice(10)} rest`, [SAVED_KEY]), `${lead}[redacted] rest`, JSON.stringify(lead));
  }
  // The longest end wins: the key's end repeats inside it.
  const repeating = 'relay-test-key-abcdefgh-abcdefgh';
  assert.equal(redactSecretsInText(`${repeating.slice(15)}!`, [repeating]), '[redacted]!');

  // Too short, not the key's end, not at the start, or not the key: it stays.
  for (const kept of [
    `${SAVED_KEY.slice(-(MIN_REDACTED_KEY_PREFIX_LENGTH - 1))} rest`,
    `${SAVED_KEY.slice(5, -1)} rest`,
    `x ${SAVED_KEY.slice(5)}`,
    'deadbeef cafe',
    'abcdef0123 is no key end',
  ]) {
    assert.equal(redactSecretsInText(kept, [SAVED_KEY, DEEPSEEK_SHAPED_KEY]), kept, kept);
  }

  // A snapshot of a task's output, its last 8 KiB, that begins halfway through the key.
  const settings = { deepseek_api_key: DEEPSEEK_SHAPED_KEY };
  const middleware = createWorkerPostRedaction({ readSetting: (key) => settings[key] || '' });
  const output = `${DEEPSEEK_SHAPED_KEY}\n${'x'.repeat(8192)}`.slice(3);
  const snapshot = runMiddleware(middleware, {
    method: 'POST',
    path: '/api/background-tasks/t-1/output-snapshot',
    headers: WORKER_HEADERS,
    body: { conversationId: 'c-1', output },
  });
  assert.equal(snapshot.output, `[redacted]\n${'x'.repeat(8192)}`);
});

test('a key part counts from 8 characters on: 7 stay, 8 go', () => {
  // Written out, not derived from MIN_REDACTED_KEY_PREFIX_LENGTH, so a change of the number fails here.
  const keys = [SAVED_KEY, DEEPSEEK_SHAPED_KEY];
  // The first part, at the end of a text.
  assert.equal(redactSecretsInText('echo relay-t', keys), 'echo relay-t');
  assert.equal(redactSecretsInText('echo relay-te', keys), 'echo [redacted]');
  assert.equal(redactSecretsInText('key sk-0123', keys), 'key sk-0123');
  assert.equal(redactSecretsInText('key sk-01234', keys), 'key [redacted]');
  // The first part, before an ellipsis.
  assert.equal(redactSecretsInText('“relay-t…” (now)', keys), '“relay-t…” (now)');
  assert.equal(redactSecretsInText('“relay-te…” (now)', keys), '“[redacted]…” (now)');
  // The last part, at the start of a text.
  assert.equal(redactSecretsInText('0000000 rest', keys), '0000000 rest');
  assert.equal(redactSecretsInText('00000000 rest', keys), '[redacted] rest');
});

test('a text without the key, no key and a short key are left as they are', () => {
  assert.equal(redactSecretsInText('nothing secret here', [SAVED_KEY]), 'nothing secret here');
  assert.equal(redactSecretsInText(`a ${SAVED_KEY}`, []), `a ${SAVED_KEY}`);
  assert.equal(redactSecretsInText(`a ${SAVED_KEY}`, ['', null, '   ']), `a ${SAVED_KEY}`);
  const shortKey = 'x'.repeat(MIN_REDACTED_SECRET_LENGTH - 1);
  assert.equal(redactSecretsInText(`box ${shortKey} done`, [shortKey]), `box ${shortKey} done`);
  const longEnough = 'y'.repeat(MIN_REDACTED_SECRET_LENGTH);
  assert.equal(redactSecretsInText(`box ${longEnough} done`, [longEnough]), 'box [redacted] done');
  assert.equal(redactSecretsInText(42, [SAVED_KEY]), 42);
});

test('a key that holds another is replaced whole', () => {
  const inner = 'inner-secret-1234';
  const outer = `${inner}-outer`;
  assert.equal(redactSecretsInText(`${outer} / ${inner}`, [inner, outer]), '[redacted] / [redacted]');
});

test('with several saved keys, the longest match wins where they overlap', () => {
  // Two keys with the same start: the one the cut part belongs to counts, whole.
  const alpha = 'relay-test-key-shared-aaaa1111';
  const beta = 'relay-test-key-shared-bbbb2222';
  for (const order of [[alpha, beta], [beta, alpha]]) {
    assert.equal(redactSecretsInText('x relay-test-key-shared-aa…”', order), 'x [redacted]…”');
    assert.equal(redactSecretsInText('x relay-test-key-shared-', order), 'x [redacted]');
  }
  // One key's first part ends with another key's first part: the longer one
  // goes, not only the other's.
  const outer = 'relay-test-key-longer-one-0000';
  const inner = 'key-longer-one-test-9999';
  for (const order of [[outer, inner], [inner, outer]]) {
    assert.equal(redactSecretsInText('echo relay-test-key-longer-o', order), 'echo [redacted]');
    assert.equal(redactSecretsInText('echo relay-test-key-longer-o…', order), 'echo [redacted]…');
  }
  // A text that starts with one key's last part, which holds the whole of
  // another key: neither leaves a piece of the first.
  const holder = 'relay-test-key-alpha-tail-5555';
  const held = 'key-alpha-tail-5555';
  for (const order of [[holder, held], [held, holder]]) {
    assert.equal(redactSecretsInText('lay-test-key-alpha-tail-5555 rest', order), '[redacted] rest');
    assert.equal(redactSecretsInText(`a ${holder} b ${held} c`, order), 'a [redacted] b [redacted] c');
  }
  // Overlapping occurrences of one key.
  assert.equal(redactSecretsInText('zzzzzzzzz', ['zzzzzzzz']), '[redacted]');
});

test('redactSecretsDeep walks plain objects and arrays, and copies only what changed', () => {
  const untouched = { kept: { list: ['a', 'b'] } };
  const body = { text: `key ${SAVED_KEY}`, nested: [{ note: SAVED_KEY }, 7, null, true], untouched };
  const out = redactSecretsDeep(body, [SAVED_KEY]);
  assert.deepEqual(out, { text: 'key [redacted]', nested: [{ note: '[redacted]' }, 7, null, true], untouched });
  assert.notEqual(out, body);
  assert.equal(out.untouched, untouched);
  // The caller's object is left as it was.
  assert.equal(body.text, `key ${SAVED_KEY}`);
  // Nothing to replace: the very same value.
  const clean = { text: 'plain' };
  assert.equal(redactSecretsDeep(clean, [SAVED_KEY]), clean);
  assert.equal(redactSecretsDeep(body, []), body);
});

test('a key used as a property name is renamed, in order, without touching the original', () => {
  const body = { first: 1, metadata: { [SAVED_KEY]: 1, [`env ${DEEPSEEK_SHAPED_KEY}`]: `v ${SAVED_KEY}`, after: 'x' }, last: 2 };
  const out = redactSecretsDeep(body, [SAVED_KEY, DEEPSEEK_SHAPED_KEY]);
  assert.deepEqual(out, { first: 1, metadata: { '[redacted]': 1, 'env [redacted]': 'v [redacted]', after: 'x' }, last: 2 });
  assert.deepEqual(Object.keys(out), ['first', 'metadata', 'last']);
  assert.deepEqual(Object.keys(out.metadata), ['[redacted]', 'env [redacted]', 'after']);
  // The caller's object keeps its names.
  assert.deepEqual(Object.keys(body.metadata), [SAVED_KEY, `env ${DEEPSEEK_SHAPED_KEY}`, 'after']);
  // A cut key as a name goes too.
  const cut = DEEPSEEK_SHAPED_KEY.slice(0, MIN_REDACTED_KEY_PREFIX_LENGTH + 2);
  assert.deepEqual(redactSecretsDeep({ [`${cut}…`]: 1 }, [DEEPSEEK_SHAPED_KEY]), { '[redacted]…': 1 });
  // Names without a key (an empty one included) leave the very same object.
  const clean = { '': 1, plain: { sk: 2, '__proto__x': 3 } };
  assert.equal(redactSecretsDeep(clean, [SAVED_KEY]), clean);
  // An own `__proto__` name stays a name when its sibling is renamed.
  const parsed = JSON.parse(`{"__proto__": {"polluted": true}, ${JSON.stringify(SAVED_KEY)}: 1}`);
  const renamed = redactSecretsDeep(parsed, [SAVED_KEY]);
  assert.equal(Object.getPrototypeOf(renamed), Object.prototype);
  assert.deepEqual(Object.keys(renamed), ['__proto__', '[redacted]']);
  assert.equal({}.polluted, undefined);
  // And so through the middleware on a worker post.
  const middleware = createWorkerPostRedaction({ readSetting });
  const activity = { messageId: 'm-1', text: 'Tool', metadata: { env: { [SAVED_KEY]: 'set' } } };
  assert.deepEqual(
    runMiddleware(middleware, { method: 'POST', path: '/api/activity', headers: WORKER_HEADERS, body: activity }),
    { messageId: 'm-1', text: 'Tool', metadata: { env: { '[redacted]': 'set' } } },
  );
});

test('the saved keys come from the registered settings; a provider registers by one entry', () => {
  assert.deepEqual(SAVED_PROVIDER_KEY_SETTINGS.map((entry) => entry.provider), ['deepseek']);
  assert.deepEqual(readSavedProviderKeys({ readSetting }), [SAVED_KEY]);
  assert.deepEqual(readSavedProviderKeys({ readSetting: () => '' }), []);
  assert.deepEqual(readSavedProviderKeys({ readSetting: () => 'short' }), []);
  const entries = [...SAVED_PROVIDER_KEY_SETTINGS, { provider: 'example-provider', settingKey: 'example_api_key' }];
  const settings = { ...SETTINGS, example_api_key: 'example-test-key-1111' };
  assert.deepEqual(
    readSavedProviderKeys({ readSetting: (key) => settings[key] || '', entries }).sort(),
    [SAVED_KEY, 'example-test-key-1111'].sort(),
  );
});

test('a worker post is a request with a body that carries the session header, never a settings route', () => {
  assert.equal(isWorkerPostRequest({ method: 'POST', path: '/api/response', headers: WORKER_HEADERS }), true);
  assert.equal(isWorkerPostRequest({ method: 'PUT', path: '/api/anything', headers: WORKER_HEADERS }), true);
  assert.equal(isWorkerPostRequest({ method: 'POST', path: '/api/response', headers: {} }), false);
  // Present but empty is a worker too: the Copilot extension sends it so until its session is up.
  assert.equal(isWorkerPostRequest({ method: 'POST', path: '/api/response', headers: { 'x-relay-session-id': '' } }), true);
  assert.equal(isWorkerPostRequest({ method: 'POST', path: '/api/response', headers: { 'x-relay-session-id': '  ' } }), true);
  assert.equal(isWorkerPostRequest({ method: 'GET', path: '/api/pending', headers: WORKER_HEADERS }), false);
  assert.equal(isWorkerPostRequest({ method: 'POST', path: '/api/settings/deepseek', headers: WORKER_HEADERS }), false);
});

// Each channel a worker posts text on: the route as it is registered, the
// path a post goes to, and a body of the shape the route reads.
const CHANNELS = Object.freeze([
  { route: '/api/response', path: '/api/response', body: { messageId: 'm-1', conversationId: 'c-1', text: `Here it is: ${SAVED_KEY}` } },
  { route: '/api/stream', path: '/api/stream', body: { messageId: 'm-1', conversationId: 'c-1', text: `so far ${SAVED_KEY}`, done: false } },
  { route: '/api/thought', path: '/api/thought', body: { messageId: 'm-1', conversationId: 'c-1', text: `thinking about ${SAVED_KEY}`, reasoningId: 'r-1' } },
  { route: '/api/activity', path: '/api/activity', body: { messageId: 'm-1', conversationId: 'c-1', text: `Bash: echo ${SAVED_KEY}`, metadata: { command: `echo ${SAVED_KEY}` } } },
  { route: '/api/background-tasks', path: '/api/background-tasks', body: { conversationId: 'c-1', tasks: [{ taskId: 't-1', description: `curl -H "x-api-key: ${SAVED_KEY}"` }] } },
  {
    route: '/api/background-tasks/:taskId/output-snapshot',
    path: '/api/background-tasks/t-1/output-snapshot',
    body: { conversationId: 'c-1', output: `line ${SAVED_KEY}\n` },
  },
  { route: '/api/subagent-run', path: '/api/subagent-run', body: { messageId: 'm-1', conversationId: 'c-1', subagentRunId: 's-1', displayName: `probe ${SAVED_KEY}` } },
  {
    route: '/api/subagent-timeline',
    path: '/api/subagent-timeline',
    body: { conversationId: 'c-1', subagentRunId: 's-1', header: { displayName: 'probe' }, entries: [{ key: 'e-1', kind: 'text', text: SAVED_KEY }] },
  },
  { route: '/api/relay-question', path: '/api/relay-question', body: { queueId: 'm-1', conversationId: 'c-1', prompt: `Use ${SAVED_KEY}?`, choices: [SAVED_KEY] } },
  { route: '/api/claude-context-usage', path: '/api/claude-context-usage', body: { conversationId: 'c-1', contextUsage: { notes: [`key ${SAVED_KEY}`] } } },
  { route: '/api/remote-relays/tool', path: '/api/remote-relays/tool', body: { conversationId: 'c-1', action: 'send', args: { message: `pass on ${SAVED_KEY}` } } },
]);
const channelBody = (routePath) => CHANNELS.find((channel) => channel.path === routePath).body;

test('every channel listed is a route the relay registers', () => {
  const routesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'routes');
  const source = fs.readdirSync(routesDir)
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .map((name) => fs.readFileSync(path.join(routesDir, name), 'utf8'))
    .join('\n');
  for (const { route } of CHANNELS) {
    assert.ok(source.includes(`app.post('${route}',`), route);
  }
});

function runMiddleware(middleware, req) {
  let nextCalls = 0;
  middleware(req, {}, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  return req.body;
}

test('the middleware takes the key out of every channel a worker posts on', () => {
  const middleware = createWorkerPostRedaction({ readSetting });
  for (const { path: routePath, body } of CHANNELS) {
    const out = runMiddleware(middleware, { method: 'POST', path: routePath, headers: WORKER_HEADERS, body });
    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes(SAVED_KEY), false, routePath);
    assert.ok(serialized.includes('[redacted]'), routePath);
    // The ids and flags the route needs are untouched.
    if (body.messageId) assert.equal(out.messageId, body.messageId, routePath);
    if (body.conversationId) assert.equal(out.conversationId, body.conversationId, routePath);
  }
});

test('the middleware leaves a browser request, a settings save, an unsaved key and a short key alone', () => {
  const body = { text: `with ${SAVED_KEY}` };
  const middleware = createWorkerPostRedaction({ readSetting });
  assert.equal(runMiddleware(middleware, { method: 'POST', path: '/api/message', headers: {}, body }), body);
  const settingsBody = { apiKey: SAVED_KEY };
  assert.equal(
    runMiddleware(middleware, { method: 'POST', path: '/api/settings/deepseek', headers: WORKER_HEADERS, body: settingsBody }),
    settingsBody,
  );
  const noKey = createWorkerPostRedaction({ readSetting: () => '' });
  assert.equal(runMiddleware(noKey, { method: 'POST', path: '/api/response', headers: WORKER_HEADERS, body }), body);
  const shortKey = createWorkerPostRedaction({ readSetting: () => 'sk-1234' });
  const shortBody = { text: 'sk-1234 is in here' };
  assert.equal(runMiddleware(shortKey, { method: 'POST', path: '/api/response', headers: WORKER_HEADERS, body: shortBody }), shortBody);
  // A text without the key: the very same body.
  const clean = { text: 'nothing to hide' };
  assert.equal(runMiddleware(middleware, { method: 'POST', path: '/api/response', headers: WORKER_HEADERS, body: clean }), clean);
});

test('a key split across successive stream updates and a thought never reaches a route, not even its first part', () => {
  const settings = { deepseek_api_key: DEEPSEEK_SHAPED_KEY };
  const middleware = createWorkerPostRedaction({ readSetting: (key) => settings[key] || '' });
  // What the Claude normalizer posts: the text so far, before the key is complete.
  const before = 'The key in .env is ';
  const cuts = [5, MIN_REDACTED_KEY_PREFIX_LENGTH, 12, 20, DEEPSEEK_SHAPED_KEY.length - 1, DEEPSEEK_SHAPED_KEY.length];
  const bodies = cuts.map((cut) => ({ messageId: 'm-1', conversationId: 'c-1', text: `${before}${DEEPSEEK_SHAPED_KEY.slice(0, cut)}`, done: false }));
  bodies.push({ messageId: 'm-1', conversationId: 'c-1', text: `${before}${DEEPSEEK_SHAPED_KEY}, as asked.`, done: false });
  const head = DEEPSEEK_SHAPED_KEY.slice(0, MIN_REDACTED_KEY_PREFIX_LENGTH);
  const texts = bodies.map((body) => runMiddleware(middleware, { method: 'POST', path: '/api/stream', headers: WORKER_HEADERS, body }).text);
  for (const text of texts) assert.equal(text.includes(head), false, text);
  // Under the threshold the start stays (the public `sk-` and two digits).
  assert.equal(texts[0], `${before}${DEEPSEEK_SHAPED_KEY.slice(0, 5)}`);
  assert.deepEqual(texts.slice(1, -1), Array(cuts.length - 1).fill(`${before}[redacted]`));
  assert.equal(texts.at(-1), `${before}[redacted], as asked.`);

  // A thought, also sent as it grows (and cut at the thought cap).
  const thought = { messageId: 'm-1', conversationId: 'c-1', reasoningId: 'r-1', text: `I could print ${DEEPSEEK_SHAPED_KEY.slice(0, 17)}` };
  const thoughtOut = runMiddleware(middleware, { method: 'POST', path: '/api/thought', headers: WORKER_HEADERS, body: thought });
  assert.equal(thoughtOut.text, 'I could print [redacted]');
  assert.equal(thoughtOut.reasoningId, 'r-1');
});

test('a key changed or removed in Settings is still redacted, for as many keys as the middleware remembers', () => {
  const settings = { deepseek_api_key: SAVED_KEY };
  const middleware = createWorkerPostRedaction({ readSetting: (key) => settings[key] || '' });
  const post = (text) => runMiddleware(middleware, { method: 'POST', path: '/api/response', headers: WORKER_HEADERS, body: { text } }).text;
  assert.equal(post(`old ${SAVED_KEY}`), 'old [redacted]');
  // A worker started before the change still prints the old key.
  const rotated = 'relay-test-key-rotated-11111111';
  settings.deepseek_api_key = rotated;
  assert.equal(post(`old ${SAVED_KEY} new ${rotated}`), 'old [redacted] new [redacted]');
  settings.deepseek_api_key = '';
  assert.equal(post(`old ${SAVED_KEY} new ${rotated}`), 'old [redacted] new [redacted]');

  // Bounded: past MAX_REMEMBERED_SECRETS keys the oldest go; the saved one stays.
  const keys = Array.from({ length: MAX_REMEMBERED_SECRETS + 2 }, (_, index) => `relay-test-key-series-${String(index).padStart(4, '0')}`);
  for (const key of keys) {
    settings.deepseek_api_key = key;
    post('turn');
  }
  const remembered = keys.slice(-MAX_REMEMBERED_SECRETS);
  for (const key of remembered) assert.equal(post(`k ${key}`), 'k [redacted]', key);
  for (const key of [SAVED_KEY, rotated, ...keys.slice(0, 2)]) assert.equal(post(`k ${key}`), `k ${key}`, key);
  // Read again, the saved key is the newest: one more key pushes out the oldest other.
  settings.deepseek_api_key = remembered[0];
  post('turn');
  settings.deepseek_api_key = 'relay-test-key-series-last';
  assert.equal(post(`k ${remembered[0]} ${remembered[1]}`), `k [redacted] ${remembered[1]}`);
});

test('a key saved at the start or noted on a save stays redacted, even when it changes before any worker posts', () => {
  const settings = { deepseek_api_key: SAVED_KEY };
  const middleware = createWorkerPostRedaction({ readSetting: (key) => settings[key] || '' });
  const post = (text) => runMiddleware(middleware, { method: 'POST', path: '/api/response', headers: WORKER_HEADERS, body: { text } }).text;
  // Key A at the start, B saved before any post: A, read at the start, still goes.
  const second = 'relay-test-key-second-22222222';
  settings.deepseek_api_key = second;
  middleware.noteSavedSetting('deepseek_api_key', second);
  // C saved before any post: B was only ever noted on its save.
  const third = 'relay-test-key-third-33333333';
  settings.deepseek_api_key = third;
  middleware.noteSavedSetting('deepseek_api_key', third);
  assert.equal(post(`a ${SAVED_KEY} b ${second} c ${third}`), 'a [redacted] b [redacted] c [redacted]');
  // Another setting, or a short value, is not taken for a key.
  middleware.noteSavedSetting('deepseek_model', 'relay-test-model-name');
  middleware.noteSavedSetting('deepseek_api_key', 'short');
  assert.equal(post('relay-test-model-name short'), 'relay-test-model-name short');

  // The relay's DeepSeek save path, with the hook as the runtime wires it.
  const values = new Map([['deepseek_api_key', SAVED_KEY]]);
  const readStored = (key) => values.get(key) ?? '';
  const wired = createWorkerPostRedaction({ readSetting: readStored });
  const deepseek = createDeepSeekSettingsService({
    readSetting: readStored,
    writeSetting: (key, value) => {
      values.set(key, String(value));
      wired.noteSavedSetting(key, value);
    },
    deleteSetting: (key) => { values.delete(key); },
  });
  assert.equal(deepseek.update({ apiKey: second }).ok, true);
  assert.equal(deepseek.update({ apiKey: third }).ok, true);
  const out = runMiddleware(wired, { method: 'POST', path: '/api/stream', headers: WORKER_HEADERS, body: { text: `${SAVED_KEY} ${second} ${third}` } });
  assert.equal(out.text, '[redacted] [redacted] [redacted]');
});

test('a settings read that fails at the start is logged once; the keys saved later still go', () => {
  const lines = [];
  let fail = true;
  const settings = { deepseek_api_key: SAVED_KEY };
  const middleware = createWorkerPostRedaction({
    readSetting: (key) => {
      if (fail) throw new Error('database is locked');
      return settings[key] || '';
    },
    log: (line) => lines.push(line),
  });
  assert.equal(lines.length, 1);
  const second = 'relay-test-key-second-22222222';
  middleware.noteSavedSetting('deepseek_api_key', second);
  const post = (text) => runMiddleware(middleware, { method: 'POST', path: '/api/response', headers: WORKER_HEADERS, body: { text } }).text;
  assert.equal(post(`b ${second}`), 'b [redacted]');
  fail = false;
  assert.equal(post(`a ${SAVED_KEY} b ${second}`), 'a [redacted] b [redacted]');
  assert.equal(lines.length, 1);
});

test('a settings read that fails lets the post through with the keys read before, and is logged once', () => {
  const lines = [];
  let fail = false;
  const middleware = createWorkerPostRedaction({
    readSetting: (key) => {
      if (fail) throw new Error('database is locked');
      return SETTINGS[key] || '';
    },
    log: (line) => lines.push(line),
  });
  const post = (body) => runMiddleware(middleware, { method: 'POST', path: '/api/response', headers: WORKER_HEADERS, body });
  assert.equal(post({ text: `a ${SAVED_KEY}` }).text, 'a [redacted]');
  fail = true;
  const body = { text: 'hello' };
  for (let index = 0; index < 2; index += 1) assert.equal(post(body), body);
  assert.equal(post({ text: `b ${SAVED_KEY}` }).text, 'b [redacted]');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /worker post redaction: the saved provider keys could not be read/);
  assert.equal(lines[0].includes(SAVED_KEY), false);
});

test('behind express.json, a route sees the redacted body; a key saved later applies to the next post', async () => {
  const settings = { deepseek_api_key: '' };
  const app = express();
  app.use(express.json());
  app.use(createWorkerPostRedaction({ readSetting: (key) => settings[key] || '' }));
  const seen = [];
  app.post(/.*/, (req, res) => {
    seen.push(req.body);
    res.json({ ok: true });
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const { port } = server.address();
    const post = (routePath, body, headers = WORKER_HEADERS) => fetch(`http://127.0.0.1:${port}${routePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    await post('/api/stream', channelBody('/api/stream'));
    assert.equal(seen.at(-1).text, `so far ${SAVED_KEY}`);
    settings.deepseek_api_key = SAVED_KEY;
    for (const routePath of ['/api/response', '/api/stream', '/api/thought', '/api/background-tasks/t-1/output-snapshot', '/api/activity']) {
      await post(routePath, channelBody(routePath));
      assert.equal(JSON.stringify(seen.at(-1)).includes(SAVED_KEY), false, routePath);
    }
    assert.equal(seen.at(-1).text, 'Bash: echo [redacted]');
    // The header sent empty, as the Copilot extension does before its session is up.
    await post('/api/activity', channelBody('/api/activity'), { 'X-Relay-Session-Id': '' });
    assert.equal(seen.at(-1).text, 'Bash: echo [redacted]');
    await post('/api/response', channelBody('/api/response'), {});
    assert.equal(seen.at(-1).text, `Here it is: ${SAVED_KEY}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the relay builds the redaction at its start, notes each DeepSeek save, and mounts it after the JSON body parser and before every route', () => {
  const runtimePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server-runtime.mjs');
  const source = fs.readFileSync(runtimePath, 'utf8').replace(/\r\n/g, '\n');
  const built = source.indexOf('const workerPostRedaction = createWorkerPostRedaction({ readSetting: readAppSettingValue });');
  const service = source.indexOf('const deepseekSettingsService = createDeepSeekSettingsService({');
  assert.notEqual(built, -1);
  assert.ok(source.indexOf('\nconst stmts = {') < built && built < service);
  const serviceSource = source.slice(service, source.indexOf('\n});', service));
  assert.match(
    serviceSource,
    /writeSetting: \(key, value\) => \{\n    stmts\.upsertAppSetting\.run\(key, String\(value\), new Date\(\)\.toISOString\(\)\);\n    workerPostRedaction\.noteSavedSetting\(key, value\);\n  \},/,
  );
  const parser = source.indexOf("app.use(express.json({ limit: '20mb' }));");
  const redaction = source.indexOf('app.use(workerPostRedaction);');
  const firstRoutes = source.indexOf('registerMessagesRoutes(app, sharedRouteDeps);');
  assert.notEqual(parser, -1);
  assert.notEqual(redaction, -1);
  assert.ok(parser < redaction && redaction < firstRoutes);
  // No route is registered before it.
  const before = source.slice(0, redaction);
  assert.doesNotMatch(before, /\napp\.(?:get|post|put|patch|delete|all)\(/);
});

test('task output: a snapshot a worker posts loses the saved key; a task\'s file, read by the relay, a key of DeepSeek\'s shape', () => {
  // The snapshot of a task without a file is a worker post: the saved key
  // goes by its exact text, whatever its shape.
  const middleware = createWorkerPostRedaction({ readSetting });
  const snapshot = runMiddleware(middleware, {
    method: 'POST',
    path: '/api/background-tasks/t-1/output-snapshot',
    headers: WORKER_HEADERS,
    body: { conversationId: 'c-1', output: `$ env | grep KEY\nplain ${SAVED_KEY}\n` },
  });
  assert.equal(snapshot.output, '$ env | grep KEY\nplain [redacted]\n');
  // A task's file does not pass the middleware; the task output scrub takes
  // the key out by its shape.
  const cleaned = cleanTaskOutput(`$ env | grep KEY\nANTHROPIC_AUTH_TOKEN=${DEEPSEEK_SHAPED_KEY}\nplain ${DEEPSEEK_SHAPED_KEY}\n`);
  assert.equal(cleaned.includes(DEEPSEEK_SHAPED_KEY), false);
});
