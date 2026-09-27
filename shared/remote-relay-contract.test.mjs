import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REMOTE_RELAY_ACTIONS,
  REMOTE_RELAY_ACTION_PERMISSION,
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_LIMITS,
  REMOTE_RELAY_TOOL_INPUT_SCHEMA,
  REMOTE_RELAY_TOOL_NAME,
  REMOTE_RELAY_APPROVAL_SOURCE,
  checkRemoteRelayUrlPolicy,
  formatRemotePromptHeader,
  isRemoteRelayApprovalQuestion,
  isRemoteRelayWriteAction,
  normalizeRemoteRelayLink,
  normalizeRemoteRelayOrigin,
  normalizeRemoteRelayPermission,
  remoteConversationUrl,
  remoteRelayPermissionAllows,
  stripRemotePromptHeader,
  summarizeRemoteRelayCall,
  validateRemoteRelayToolInput,
  withRemotePromptHeader,
} from './remote-relay-contract.mjs';

test('the tool is named remote_relay and its schema lists every action', () => {
  assert.equal(REMOTE_RELAY_TOOL_NAME, 'remote_relay');
  assert.deepEqual(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.action.enum, [...REMOTE_RELAY_ACTIONS]);
  assert.deepEqual(REMOTE_RELAY_TOOL_INPUT_SCHEMA.required, ['action']);
  for (const action of REMOTE_RELAY_ACTIONS) {
    assert.ok(Object.prototype.hasOwnProperty.call(REMOTE_RELAY_ACTION_PERMISSION, action), action);
  }
});

test('list_relays needs nothing else', () => {
  assert.deepEqual(validateRemoteRelayToolInput({ action: 'list_relays' }), { ok: true, action: 'list_relays', args: {} });
});

test('an unknown action or a missing relay is refused with the invalid-input code', () => {
  const unknown = validateRemoteRelayToolInput({ action: 'explode' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, REMOTE_RELAY_ERROR_CODES.invalidInput);
  const noRelay = validateRemoteRelayToolInput({ action: 'list_sessions' });
  assert.equal(noRelay.ok, false);
  assert.match(noRelay.error, /needs relay/);
});

test('session actions need a session', () => {
  for (const action of ['read_session', 'wait', 'send', 'stop', 'archive']) {
    const result = validateRemoteRelayToolInput({ action, relay: 'linux-test', message_id: 'm', text: 'x' });
    assert.equal(result.ok, false, action);
    assert.match(result.error, /needs session/);
  }
});

test('list_sessions fills defaults and clamps the page size', () => {
  const result = validateRemoteRelayToolInput({ action: 'list_sessions', relay: 'linux-test', limit: 500 });
  assert.deepEqual(result, { ok: true, action: 'list_sessions', args: { relay: 'linux-test', scope: 'recent', limit: 100 } });
  const scoped = validateRemoteRelayToolInput({ action: 'list_sessions', relay: 'linux-test', scope: 'ACTIVE', query: ' report ' });
  assert.equal(scoped.args.scope, 'active');
  assert.equal(scoped.args.query, 'report');
  assert.equal(validateRemoteRelayToolInput({ action: 'list_sessions', relay: 'r', scope: 'mine' }).ok, false);
});

test('read_session defaults: last 10, 12000 chars, no activity', () => {
  const result = validateRemoteRelayToolInput({ action: 'read_session', relay: 'r', session: 's' });
  assert.deepEqual(result.args, { relay: 'r', session: 's', last: 10, max_chars: 12000, include_activity: false });
  const more = validateRemoteRelayToolInput({ action: 'read_session', relay: 'r', session: 's', last: 999, max_chars: 10, include_activity: true });
  assert.equal(more.args.last, REMOTE_RELAY_LIMITS.readMax);
  assert.equal(more.args.max_chars, 500);
  assert.equal(more.args.include_activity, true);
});

test('send needs text, waits 120 s by default and never more than 600 s', () => {
  assert.equal(validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's' }).ok, false);
  const result = validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's', text: ' run the tests ' });
  assert.deepEqual(result.args, { relay: 'r', session: 's', text: 'run the tests', wait_seconds: 120, if_busy: 'queue' });
  assert.equal(validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's', text: 'x', wait_seconds: 5000 }).args.wait_seconds, 600);
  assert.equal(validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's', text: 'x', wait_seconds: 0 }).args.wait_seconds, 0);
  assert.equal(validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's', text: 'x', wait_seconds: 'soon' }).ok, false);
  assert.equal(validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's', text: 'x', if_busy: 'panic' }).ok, false);
});

test('create_session accepts provider, model, cwd, mode and title', () => {
  const result = validateRemoteRelayToolInput({
    action: 'create_session',
    relay: 'r',
    text: 'build the report',
    provider: 'Claude',
    model: 'claude-sonnet-5',
    cwd: '/work/demo',
    mode: 'autopilot',
    title: 'report builder',
  });
  assert.deepEqual(result.args, {
    relay: 'r',
    text: 'build the report',
    wait_seconds: 120,
    model: 'claude-sonnet-5',
    mode: 'autopilot',
    provider: 'claude',
    cwd: '/work/demo',
    title: 'report builder',
  });
  assert.equal(validateRemoteRelayToolInput({ action: 'create_session', relay: 'r', text: 'x', provider: 'nope' }).ok, false);
  assert.equal(validateRemoteRelayToolInput({ action: 'create_session', relay: 'r', text: 'x', mode: 'yolo' }).ok, false);
});

test('text longer than the limit is refused', () => {
  const text = 'x'.repeat(REMOTE_RELAY_LIMITS.textMax + 1);
  assert.equal(validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's', text }).ok, false);
});

test('wait needs a message id', () => {
  assert.equal(validateRemoteRelayToolInput({ action: 'wait', relay: 'r', session: 's' }).ok, false);
  assert.deepEqual(
    validateRemoteRelayToolInput({ action: 'wait', relay: 'r', session: 's', message_id: 'm-1', wait_seconds: 30 }).args,
    { relay: 'r', session: 's', message_id: 'm-1', wait_seconds: 30 },
  );
});

test('answer_question needs a question id and an answer or choices', () => {
  assert.equal(validateRemoteRelayToolInput({ action: 'answer_question', relay: 'r', answer: 'yes' }).ok, false);
  assert.equal(validateRemoteRelayToolInput({ action: 'answer_question', relay: 'r', question_id: 'q' }).ok, false);
  assert.deepEqual(
    validateRemoteRelayToolInput({ action: 'answer_question', relay: 'r', question_id: 'q', choices: ['A', ' ', 'B'] }).args,
    { relay: 'r', question_id: 'q', choices: ['A', 'B'] },
  );
});

test('permissions rank read < prompt < full, and list_relays needs none', () => {
  assert.equal(remoteRelayPermissionAllows('read', 'list_relays'), true);
  assert.equal(remoteRelayPermissionAllows('read', 'read_session'), true);
  assert.equal(remoteRelayPermissionAllows('read', 'send'), false);
  assert.equal(remoteRelayPermissionAllows('prompt', 'send'), true);
  assert.equal(remoteRelayPermissionAllows('prompt', 'create_session'), false);
  assert.equal(remoteRelayPermissionAllows('prompt', 'answer_question'), false);
  assert.equal(remoteRelayPermissionAllows('full', 'archive'), true);
  assert.equal(remoteRelayPermissionAllows('full', 'explode'), false);
  assert.equal(normalizeRemoteRelayPermission('weird'), 'full', 'unknown values fall back to the default');
});

test('write actions are the ones that change the remote', () => {
  assert.equal(isRemoteRelayWriteAction('send'), true);
  assert.equal(isRemoteRelayWriteAction('stop'), true);
  assert.equal(isRemoteRelayWriteAction('wait'), false);
  assert.equal(isRemoteRelayWriteAction('read_session'), false);
});

test('an approval card is recognised by its context source, formatted or stored', () => {
  assert.equal(REMOTE_RELAY_APPROVAL_SOURCE, 'remote_relay');
  assert.equal(isRemoteRelayApprovalQuestion({ id: 'question-1', context: { source: 'remote_relay', header: 'Remote relay' } }), true);
  assert.equal(isRemoteRelayApprovalQuestion({ request: null, context: { source: ' remote_relay ' }, allowFreeform: false }), true);
  assert.equal(isRemoteRelayApprovalQuestion({ id: 'question-2', context: { source: 'ask_user' } }), false);
  assert.equal(isRemoteRelayApprovalQuestion({ id: 'question-3', context: null }), false);
  assert.equal(isRemoteRelayApprovalQuestion({ id: 'question-4', context: 'remote_relay' }), false);
  assert.equal(isRemoteRelayApprovalQuestion(null), false);
});

test('an origin is sanitised: capped strings, no newlines, hops bounded', () => {
  assert.equal(normalizeRemoteRelayOrigin(null), null);
  assert.equal(normalizeRemoteRelayOrigin({ model: 'x' }), null, 'needs a relay id or name');
  const origin = normalizeRemoteRelayOrigin({
    relayId: 'r-1',
    relayName: 'win-test\nsecond line',
    relayUrl: 'javascript:alert(1)',
    conversationTitle: 't'.repeat(500),
    hops: 99,
    extra: 'dropped',
  });
  assert.equal(origin.kind, 'agent');
  assert.equal(origin.relayName, 'win-test second line');
  assert.equal(origin.relayUrl, '', 'only http(s) links survive');
  assert.equal(origin.conversationTitle.length, 200);
  assert.equal(origin.hops, 10);
  assert.equal('extra' in origin, false);
  assert.equal(normalizeRemoteRelayOrigin({ relayId: 'r', hops: -1 }).hops, 1);
});

test('the prompt header names the relay, the session and the model, and strips cleanly', () => {
  const origin = { relayName: 'win-test', conversationTitle: 'report builder', model: 'claude-sonnet-5' };
  assert.equal(
    formatRemotePromptHeader(origin),
    '[Remote prompt from an agent on relay "win-test" · session "report builder" · claude-sonnet-5 · acting for the user]',
  );
  const text = withRemotePromptHeader('run the tests', origin);
  assert.equal(stripRemotePromptHeader(text), 'run the tests');
  assert.equal(stripRemotePromptHeader('[Remote prompt] is not a header'), '[Remote prompt] is not a header');
  assert.equal(
    formatRemotePromptHeader({ relayName: 'a"b]c' }),
    '[Remote prompt from an agent on relay "a b c" · acting for the user]',
    'quotes and brackets cannot break the line',
  );
});

test('https is always allowed; plain http only on loopback and private ranges', () => {
  assert.deepEqual(checkRemoteRelayUrlPolicy('https://relay-b.example.test'), { ok: true });
  assert.equal(checkRemoteRelayUrlPolicy('http://127.0.0.1:13352').ok, true);
  assert.ok(checkRemoteRelayUrlPolicy('http://localhost:3333').warning);
  for (const host of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '100.100.1.1']) {
    const result = checkRemoteRelayUrlPolicy(`http://${host}:3333`);
    assert.equal(result.ok, true, host);
    assert.match(result.warning, /unencrypted/);
  }
  for (const host of ['172.32.0.1', '8.8.8.8', 'relay-b.example.test']) {
    assert.equal(checkRemoteRelayUrlPolicy(`http://${host}`).ok, false, host);
  }
  assert.equal(checkRemoteRelayUrlPolicy('ftp://relay-b.example.test').ok, false);
  assert.equal(checkRemoteRelayUrlPolicy('not a url').ok, false);
});

test('a pasted web-client link becomes a base URL and the token it carried', () => {
  assert.deepEqual(normalizeRemoteRelayLink('relay-b.example.test'), {
    ok: true, baseUrl: 'https://relay-b.example.test', host: 'relay-b.example.test', token: null,
  });
  const withToken = normalizeRemoteRelayLink('https://relay-b.example.test/?token=abc123#settings');
  assert.equal(withToken.baseUrl, 'https://relay-b.example.test');
  assert.equal(withToken.token, 'abc123');
  assert.equal(normalizeRemoteRelayLink('https://relay-b.example.test/oar/?push_conv=c-1').baseUrl, 'https://relay-b.example.test/oar');
  assert.equal(normalizeRemoteRelayLink('https://relay-b.example.test/oar/index.html').baseUrl, 'https://relay-b.example.test/oar');
  assert.equal(normalizeRemoteRelayLink('https://relay-b.example.test/oar').baseUrl, 'https://relay-b.example.test/oar');
  const loopback = normalizeRemoteRelayLink('http://127.0.0.1:13352/');
  assert.equal(loopback.baseUrl, 'http://127.0.0.1:13352');
  assert.ok(loopback.warning);
  assert.equal(normalizeRemoteRelayLink('').ok, false);
  assert.equal(normalizeRemoteRelayLink('http://relay-b.example.test').ok, false);
});

test('a conversation link opens that conversation on the relay', () => {
  assert.equal(remoteConversationUrl('https://relay-b.example.test/', 'c 1'), 'https://relay-b.example.test/?conv=c%201');
  assert.equal(remoteConversationUrl('https://relay-b.example.test', ''), 'https://relay-b.example.test/');
  assert.equal(remoteConversationUrl('', 'c'), '');
});

test('the activity summary names the action, relay, session and prompt', () => {
  assert.equal(summarizeRemoteRelayCall({ action: 'list_relays' }), 'list_relays');
  assert.equal(
    summarizeRemoteRelayCall({ action: 'send', relay: 'linux-test', session: '0123456789abcdef', text: 'run the whole suite please' }),
    'send → linux-test session 01234567: “run the whole suite please”',
  );
  assert.match(summarizeRemoteRelayCall({ action: 'create_session', relay: 'r', text: 'x'.repeat(100) }), /…”$/);
});
