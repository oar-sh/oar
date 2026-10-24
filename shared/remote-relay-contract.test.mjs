import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REMOTE_RELAY_ACTIONS,
  REMOTE_RELAY_ACTION_ARGUMENTS,
  REMOTE_RELAY_ACTION_PERMISSION,
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_LIMITS,
  REMOTE_RELAY_NO_GROUP,
  REMOTE_RELAY_PROVIDERS,
  REMOTE_RELAY_SESSION_SETTINGS,
  REMOTE_RELAY_SCHEDULE_ACTIONS,
  REMOTE_RELAY_SETTING_KEYS,
  REMOTE_RELAY_TOOL_DESCRIPTION,
  REMOTE_RELAY_TOOL_INPUT_SCHEMA,
  REMOTE_RELAY_TOOL_NAME,
  REMOTE_RELAY_APPROVAL_SOURCE,
  AGENT_SESSIONS_SOCKET_EVENT,
  checkRemoteRelayUrlPolicy,
  formatRemotePromptHeader,
  formatSessionGroupList,
  resolveSessionGroupReference,
  isRemoteRelayApprovalQuestion,
  isRemoteRelayWriteAction,
  normalizeRemoteRelayLink,
  normalizeRemoteRelayMaxWaitSeconds,
  normalizeRemoteRelayOrigin,
  normalizeRemoteRelayPermission,
  normalizeRemoteRelayRepo,
  remoteConversationUrl,
  remoteRelayActionPermission,
  remoteRelayPermissionAllows,
  stripRemotePromptHeader,
  summarizeRemoteRelayCall,
  validateRemoteRelayToolInput,
  withRemotePromptHeader,
} from './remote-relay-contract.mjs';
import { RELAY_EVENT_LIMITS } from './relay-events.mjs';

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

test('send needs text, waits 120 s by default and never more than the ceiling of an hour', () => {
  assert.equal(validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's' }).ok, false);
  const result = validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's', text: ' run the tests ' });
  assert.deepEqual(result.args, { relay: 'r', session: 's', text: 'run the tests', wait_seconds: 120, if_busy: 'queue' });
  // An adapter does not know the relay's setting: it clamps to the ceiling only.
  assert.equal(validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's', text: 'x', wait_seconds: 5000 }).args.wait_seconds, 3600);
  assert.equal(validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's', text: 'x', wait_seconds: 900 }).args.wait_seconds, 900);
  assert.equal(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.wait_seconds.maximum, 3600);
  assert.equal(validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's', text: 'x', wait_seconds: 0 }).args.wait_seconds, 0);
  assert.equal(validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's', text: 'x', wait_seconds: 'soon' }).ok, false);
  assert.equal(validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's', text: 'x', if_busy: 'panic' }).ok, false);
});

test('the relay clamps wait_seconds to its own setting and says what was asked for', () => {
  const send = (wait, maxWaitSeconds) => validateRemoteRelayToolInput(
    { action: 'send', relay: 'r', session: 's', text: 'x', wait_seconds: wait },
    { maxWaitSeconds },
  );
  const cut = send(5000, 600);
  assert.equal(cut.args.wait_seconds, 600);
  assert.equal(cut.waitLimitedFrom, 5000);
  const within = send(500, 600);
  assert.equal(within.args.wait_seconds, 500);
  assert.equal('waitLimitedFrom' in within, false);
  assert.equal(send(3600, 3600).args.wait_seconds, 3600);
  assert.equal('waitLimitedFrom' in send(3600, 3600), false);
  assert.equal(send(2400, 1800).args.wait_seconds, 1800);
  // A stored setting outside the range is read as the nearest bound, a broken one as the default.
  assert.equal(send(3000, 99999).args.wait_seconds, 3000);
  assert.equal(send(3000, 5).args.wait_seconds, 120);
  assert.equal(send(3000, 'soon').args.wait_seconds, 600);
  // wait and create_session follow the same limit; other actions carry no wait at all.
  assert.equal(validateRemoteRelayToolInput({ action: 'wait', relay: 'r', session: 's', message_id: 'm', wait_seconds: 900 }, { maxWaitSeconds: 300 }).args.wait_seconds, 300);
  assert.equal(validateRemoteRelayToolInput({ action: 'create_session', relay: 'r', text: 'x', wait_seconds: 900 }, { maxWaitSeconds: 300 }).waitLimitedFrom, 900);
  const read = validateRemoteRelayToolInput({ action: 'read_session', relay: 'r', session: 's', wait_seconds: 900 }, { maxWaitSeconds: 300 });
  assert.equal('wait_seconds' in read.args, false);
  assert.equal('waitLimitedFrom' in read, false);
});

test('the longest-wait setting has a range, a step and a default', () => {
  assert.equal(REMOTE_RELAY_LIMITS.waitMaxSeconds, 600);
  assert.equal(REMOTE_RELAY_LIMITS.waitMaxFloorSeconds, 120);
  assert.equal(REMOTE_RELAY_LIMITS.waitMaxCeilingSeconds, 3600);
  assert.equal(REMOTE_RELAY_LIMITS.waitMaxStepSeconds, 60);
  assert.equal(REMOTE_RELAY_LIMITS.localActiveSessions, 4);
  assert.equal(normalizeRemoteRelayMaxWaitSeconds(undefined), 600);
  assert.equal(normalizeRemoteRelayMaxWaitSeconds(''), 600);
  assert.equal(normalizeRemoteRelayMaxWaitSeconds('1800'), 1800);
  assert.equal(normalizeRemoteRelayMaxWaitSeconds(10), 120);
  assert.equal(normalizeRemoteRelayMaxWaitSeconds(86400), 3600);
  assert.equal(REMOTE_RELAY_SETTING_KEYS.agentSessionsEnabled, 'agent_sessions_enabled');
  assert.equal(REMOTE_RELAY_SETTING_KEYS.maxWaitSeconds, 'remote_relay_max_wait_seconds');
  assert.equal(AGENT_SESSIONS_SOCKET_EVENT, 'agent_sessions_settings_updated');
});

test('create_session takes repo and branch with provider claude-cloud, and with no other', () => {
  assert.ok(REMOTE_RELAY_PROVIDERS.includes('claude-cloud'));
  assert.ok(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.provider.enum.includes('claude-cloud'));
  assert.ok(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.repo);
  assert.ok(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.branch);
  const create = (extra) => validateRemoteRelayToolInput({ action: 'create_session', relay: 'this', text: 'fix the banner', ...extra });

  const cloud = create({ provider: 'claude-cloud', repo: 'example-org/sample-repo', branch: 'feature/banner' });
  assert.equal(cloud.ok, true);
  assert.equal(cloud.args.repo, 'https://github.com/example-org/sample-repo');
  assert.equal(cloud.args.branch, 'feature/banner');
  assert.equal(create({ provider: 'claude-cloud', repo: 'https://github.com/example-org/sample-repo.git' }).args.repo, 'https://github.com/example-org/sample-repo');
  assert.equal('branch' in create({ provider: 'claude-cloud', repo: 'example-org/sample-repo' }).args, false, 'the branch is optional');

  assert.match(create({ provider: 'claude-cloud' }).error, /needs repo/);
  assert.match(create({ provider: 'claude-cloud', repo: 'not a repository' }).error, /GitHub repository/);
  assert.match(create({ provider: 'claude-cloud', repo: 'https://git.example.test/example-org/sample-repo' }).error, /GitHub repository/);
  assert.match(create({ provider: 'claude-cloud', repo: 'example-org/sample-repo', branch: 'bad..name' }).error, /not a valid branch name/);
  assert.match(create({ provider: 'claude-cloud', repo: 'example-org/sample-repo', cwd: '/home/dev/work' }).error, /cwd does not apply/);
  // With any other provider, and with none named, they are a validation error.
  for (const extra of [{ provider: 'claude' }, { provider: 'github' }, {}]) {
    assert.match(create({ ...extra, repo: 'example-org/sample-repo' }).error, /provider "claude-cloud" only/);
    assert.match(create({ ...extra, branch: 'main' }).error, /provider "claude-cloud" only/);
  }
  assert.equal(create({ ...{ provider: 'claude' }, repo: 'example-org/sample-repo' }).code, REMOTE_RELAY_ERROR_CODES.invalidInput);
  // send has no such fields: they are ignored there.
  assert.equal('repo' in validateRemoteRelayToolInput({ action: 'send', relay: 'r', session: 's', text: 'x', repo: 'example-org/sample-repo' }).args, false);
});

test('a repository is taken as a GitHub URL or as owner/repo', () => {
  assert.equal(normalizeRemoteRelayRepo('example-org/sample-repo'), 'https://github.com/example-org/sample-repo');
  assert.equal(normalizeRemoteRelayRepo('github.com/example-org/sample-repo'), 'https://github.com/example-org/sample-repo');
  assert.equal(normalizeRemoteRelayRepo(['git', 'github.com:example-org/sample-repo.git'].join('@')), 'https://github.com/example-org/sample-repo');
  assert.equal(normalizeRemoteRelayRepo('sample-repo'), '');
  assert.equal(normalizeRemoteRelayRepo('example-org/sample-repo/tree/main'), '');
  assert.equal(normalizeRemoteRelayRepo(''), '');
});

test('the description tells an agent how to orchestrate sessions on its own relay', () => {
  for (const part of [
    /self:true/,
    /"this"/,
    /create_session up to 4 sessions/,
    /approval card once per\s+conversation/,
    /cannot create sessions itself/,
    /relay owner's accounts/,
    /"claude-cloud" with repo/,
    /self-contained prompt/,
    /name the branch/,
    /max set on the relay, default 600/,
  ]) {
    assert.match(REMOTE_RELAY_TOOL_DESCRIPTION, part);
  }
});

test('the local target has its own error codes', () => {
  assert.equal(REMOTE_RELAY_ERROR_CODES.localDisabled, 'REMOTE_RELAY_LOCAL_DISABLED');
  assert.equal(REMOTE_RELAY_ERROR_CODES.nestedSession, 'REMOTE_RELAY_NESTED_SESSION');
  assert.equal(REMOTE_RELAY_ERROR_CODES.sessionLimit, 'REMOTE_RELAY_SESSION_LIMIT');
  assert.equal(REMOTE_RELAY_ERROR_CODES.ownSession, 'REMOTE_RELAY_OWN_SESSION');
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

test('send and create_session take an effort: any short lowercase token, no fixed list', () => {
  const send = { action: 'send', relay: 'r', session: 's', text: 'x' };
  const create = { action: 'create_session', relay: 'r', text: 'x' };
  assert.equal(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.effort.type, 'string');
  assert.equal(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.effort.enum, undefined, 'efforts differ per provider and model');
  assert.equal(validateRemoteRelayToolInput({ ...send, effort: 'medium' }).args.effort, 'medium');
  assert.equal(validateRemoteRelayToolInput({ ...create, effort: 'medium' }).args.effort, 'medium');
  for (const effort of ['none', 'low', 'high', 'xhigh', 'max', 'ultracode', 'auto', 'level-2', 'x'.repeat(32)]) {
    assert.equal(validateRemoteRelayToolInput({ ...create, effort }).args.effort, effort, effort);
  }
  assert.equal(validateRemoteRelayToolInput({ ...send, effort: ' High ' }).args.effort, 'high', 'trimmed and lowercased');
  for (const effort of ['very high!', 'very high', 'x'.repeat(33), '-high', 'high_er', 'hoch/höher', 7.5]) {
    for (const input of [send, create]) {
      const result = validateRemoteRelayToolInput({ ...input, effort });
      assert.equal(result.ok, false, `${input.action} ${effort}`);
      assert.equal(result.code, REMOTE_RELAY_ERROR_CODES.invalidInput);
      assert.match(result.error, /^effort must be/);
    }
  }
  for (const effort of ['', '  ', null, undefined]) {
    assert.equal('effort' in validateRemoteRelayToolInput({ ...send, effort }).args, false, 'an empty effort is no effort');
  }
});

test('an effort on any other action is ignored and named, not validated', () => {
  const inputs = [
    { action: 'list_relays' },
    { action: 'relay_info', relay: 'r' },
    { action: 'list_sessions', relay: 'r' },
    { action: 'read_session', relay: 'r', session: 's' },
    { action: 'wait', relay: 'r', session: 's', message_id: 'm-1' },
    { action: 'answer_question', relay: 'r', question_id: 'q', answer: 'yes' },
    { action: 'stop', relay: 'r', session: 's' },
    { action: 'archive', relay: 'r', session: 's' },
  ];
  for (const input of inputs) {
    const plain = validateRemoteRelayToolInput(input);
    assert.equal(plain.ok, true, input.action);
    assert.deepEqual(validateRemoteRelayToolInput({ ...input, effort: 'very high!' }), { ...plain, ignored: ['effort'] }, input.action);
  }
});

test('usage needs a relay and read permission only', () => {
  assert.equal(validateRemoteRelayToolInput({ action: 'usage' }).ok, false);
  assert.deepEqual(validateRemoteRelayToolInput({ action: 'usage', relay: 'this' }).args.relay, 'this');
  assert.equal(remoteRelayPermissionAllows('read', 'usage'), true);
  assert.equal(isRemoteRelayWriteAction('usage'), false);
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

test('an origin keeps local: true and nothing else that is truthy there', () => {
  const local = normalizeRemoteRelayOrigin({ relayId: 'r-1', relayName: 'win-test', conversationId: 'c-1', conversationTitle: 'report builder', hops: 0, local: true });
  assert.equal(local.local, true);
  assert.equal(local.hops, 0);
  assert.equal(local.conversationId, 'c-1');
  assert.equal(local.conversationTitle, 'report builder');
  for (const value of ['true', 1, 'yes', {}]) {
    assert.equal('local' in normalizeRemoteRelayOrigin({ relayName: 'win-test', local: value }), false);
  }
  assert.equal('local' in normalizeRemoteRelayOrigin({ relayName: 'win-test' }), false);
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

test('event actions default to this relay and validate their arguments', () => {
  const validate = validateRemoteRelayToolInput;
  const summarize = summarizeRemoteRelayCall;
  assert.deepEqual(validate({ action: 'subscribe', sessions: ['conv-a', 'conv-a', 'conv-b'], events: ['turn_end', 'TASK_STARTED'], once: true, match: 'tests? pass', stalled_minutes: 0, heartbeat_minutes: 99999 }), {
    ok: true,
    action: 'subscribe',
    args: { relay: 'this', sessions: ['conv-a', 'conv-b'], events: ['turn_end', 'task_started'], once: true, match: 'tests? pass', stalled_minutes: 1, heartbeat_minutes: 1440 },
  });
  assert.equal(validate({ action: 'subscribe', sessions: 'all' }).args.scope, 'all');
  assert.equal(validate({ action: 'subscribe', session: 'conv-a' }).args.sessions[0], 'conv-a');
  assert.match(validate({ action: 'subscribe' }).error, /needs sessions/);
  // relay_restarted alone watches no session; with anything else, sessions are needed.
  assert.deepEqual(validate({ action: 'subscribe', events: ['relay_restarted'], once: true }), {
    ok: true,
    action: 'subscribe',
    args: { relay: 'this', events: ['relay_restarted'], once: true },
  });
  assert.match(validate({ action: 'subscribe', events: ['relay_restarted', 'turn_end'] }).error, /needs sessions .* unless events names only relay_restarted/);
  assert.deepEqual(validate({ action: 'subscribe', sessions: ['conv-a'], events: ['relay_restarted'] }).args.sessions, ['conv-a']);
  assert.match(validate({ action: 'subscribe', sessions: ['all', 'conv-a'] }).error, /not both/);
  assert.match(validate({ action: 'subscribe', sessions: ['conv-a'], events: ['nope'] }).error, /events must be some of/);
  assert.deepEqual(validate({ action: 'subscribe', sessions: ['conv-a'], events: ['subagent_finished', 'task_finished'] }).args.events, ['subagent_finished', 'task_finished']);
  assert.match(validate({ action: 'subscribe', sessions: ['conv-a'], match: '(' }).error, /not a valid regular expression/);
  assert.match(validate({ action: 'unsubscribe' }).error, /subscription_id/);
  assert.deepEqual(validate({ action: 'list_subscriptions', watcher: 'conv-old' }).args, { relay: 'this', watcher: 'conv-old' });
  assert.match(validate({ action: 'transfer_subscriptions' }).error, /needs from/);
  assert.equal(validate({ action: 'transfer_subscriptions', from: 'conv-old', relay: 'lab' }).args.relay, 'lab');
  assert.equal(summarize({ action: 'subscribe', relay: 'this', sessions: ['all'] }), 'subscribe → this: all sessions');
});

test('subscribe options: digest_minutes is clamped, quiet_hours checked, exclude only with ["all"]', () => {
  const validate = validateRemoteRelayToolInput;
  assert.deepEqual(validate({
    action: 'subscribe',
    sessions: ['all'],
    digest_minutes: 0,
    quiet_hours: { from: '7:30', to: '19:00', tz: 'America/New_York' },
    exclude: ['conv-a', ' conv-a ', 'conv-b'],
  }), {
    ok: true,
    action: 'subscribe',
    args: { relay: 'this', scope: 'all', digest_minutes: 1, quiet_hours: { from: '07:30', to: '19:00', tz: 'America/New_York' }, exclude: ['conv-a', 'conv-b'] },
  });
  assert.equal(validate({ action: 'subscribe', sessions: ['conv-a'], digest_minutes: 99999 }).args.digest_minutes, RELAY_EVENT_LIMITS.digestMinutesMax);
  assert.match(validate({ action: 'subscribe', sessions: ['conv-a'], digest_minutes: 'often' }).error, /digest_minutes must be a number/);
  assert.match(validate({ action: 'subscribe', sessions: ['conv-a'], quiet_hours: { from: '23:00', to: '06:00', tz: 'Moon/Base' } }).error, /not an IANA time zone/);
  assert.match(validate({ action: 'subscribe', sessions: ['conv-a'], quiet_hours: { from: '23:00', to: '06:00' } }).error, /needs tz/);
  assert.match(validate({ action: 'subscribe', sessions: ['conv-a'], quiet_hours: { from: '25:00', to: '06:00', tz: 'UTC' } }).error, /HH:MM/);
  assert.match(validate({ action: 'subscribe', sessions: ['conv-a'], quiet_hours: { from: '06:00', to: '06:00', tz: 'UTC' } }).error, /differ/);
  assert.match(validate({ action: 'subscribe', sessions: ['conv-a'], exclude: ['conv-b'] }).error, /exclude goes with sessions \["all"\] only/);
  assert.match(validate({ action: 'subscribe', sessions: ['all'], exclude: Array.from({ length: 51 }, (_, index) => `conv-${index}`) }).error, /at most 50/);
  assert.match(validate({ action: 'subscribe', sessions: ['all'], exclude: { id: 'conv-a' } }).error, /list of session ids/);
  // Providers that send every property empty: no option, nothing ignored.
  const empty = validate({ action: 'subscribe', sessions: ['conv-a'], digest_minutes: null, quiet_hours: { from: '', to: '', tz: '' }, exclude: [] });
  assert.deepEqual(empty, { ok: true, action: 'subscribe', args: { relay: 'this', sessions: ['conv-a'] } });
  assert.deepEqual(validate({ action: 'list_subscriptions', quiet_hours: {} }).ignored, undefined);
  assert.deepEqual(validate({ action: 'list_subscriptions', digest_minutes: 5 }).ignored, ['digest_minutes']);
  for (const key of ['digest_minutes', 'quiet_hours', 'exclude']) assert.ok(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties[key], key);
  assert.deepEqual(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.quiet_hours.required, ['from', 'to', 'tz']);
});

test('what the input check hands on passes it again unchanged, for every action', () => {
  // A call is checked twice: by the worker's tool, and by the relay that
  // receives what the tool sent. ["all"] failed the second check (the
  // first one hands it on as scope "all").
  const inputs = [
    { action: 'list_relays' },
    { action: 'relay_info', relay: 'linux-test' },
    { action: 'usage', relay: 'this' },
    { action: 'list_sessions', relay: 'this', scope: 'all', limit: 5, query: 'docs', cursor: 'c1' },
    { action: 'read_session', relay: 'this', session: 'conv-a', last: 3, max_chars: 900, include_activity: true, before: 'b1' },
    { action: 'read_task_output', relay: 'this', session: 'conv-a', task_id: 'task-b7', lines: 40 },
    { action: 'wait', relay: 'this', session: 'conv-a', message_id: 'm-1', wait_seconds: 30 },
    { action: 'send', relay: 'this', session: 'conv-a', text: 'hello', mode: 'plan', effort: 'high', if_busy: 'fail', model: 'gpt-5.4-mini' },
    { action: 'create_session', relay: 'this', text: 'start', provider: 'claude', cwd: '/home/dev/project', title: 'docs pass', group: 'Docs' },
    { action: 'create_session', relay: 'this', text: 'start', provider: 'claude-cloud', repo: 'https://github.com/example-org/example-repo', branch: 'feature/x' },
    { action: 'update_session', relay: 'this', session: 'conv-a', model: 'claude-opus-5', effort: 'high', mode: 'plan', auto_compact_window: 200000, title: 'Docs pass', group: 'Docs', thinking_enabled: false, thinking_display: 'omitted', cwd: '/home/dev/next' },
    { action: 'update_session', relay: 'this', session: 'conv-a', group: null, auto_compact_window: 'auto' },
    { action: 'update_session', relay: 'this', session: 'conv-a', group: 'none' },
    { action: 'answer_question', relay: 'this', session: 'conv-a', question_id: 'q-1', choices: ['Yes'] },
    { action: 'stop', relay: 'this', session: 'conv-a' },
    { action: 'archive', relay: 'this', session: 'conv-a' },
    { action: 'subscribe', sessions: ['all'] },
    { action: 'subscribe', session: 'all' },
    { action: 'subscribe', sessions: 'all', events: ['turn_end'], once: true, stalled_minutes: 20, heartbeat_minutes: 60 },
    { action: 'subscribe', relay: 'linux-test', sessions: ['conv-a', 'conv-b'], match: 'done' },
    { action: 'subscribe', events: ['relay_restarted'], once: true },
    { action: 'subscribe', sessions: ['all'], digest_minutes: 30, quiet_hours: { from: '23:00', to: '06:00', tz: 'Europe/Berlin' }, exclude: ['conv-a'] },
    { action: 'unsubscribe', subscription_id: 'all' },
    { action: 'unsubscribe', subscription_id: 'sub_fixture1' },
    { action: 'list_subscriptions', watcher: 'conv-b' },
    { action: 'transfer_subscriptions', from: 'conv-old' },
    { action: 'schedule', text: 'Run the sweep.', every_minutes: 30, title: 'Sweep' },
    { action: 'schedule', session: 'conv-b', text: 'Check in.', at: new Date(Date.now() + 3_600_000).toISOString() },
    { action: 'schedule', text: 'Nightly.', at: new Date(Date.now() + 7_200_000).toISOString(), every_minutes: 1440, once: false },
    { action: 'list_schedules', session: 'conv-b' },
    { action: 'unschedule', schedule_id: 'sch_fixture1' },
    { action: 'ask', question: 'Which database?', options: ['Postgres', 'SQLite'], recommendation: 'sqlite', detail: 'Two lines\nof background', urgency: 'now' },
    { action: 'ask', relay: 'linux-test', session: 'conv-b', question: 'Ship it?' },
    { action: 'list_questions', session: 'conv-b' },
    { action: 'withdraw', question_id: 'ask_fixture01' },
  ];
  for (const input of inputs) {
    const first = validateRemoteRelayToolInput(input);
    assert.equal(first.ok, true, `${JSON.stringify(input)}: ${first.error}`);
    const second = validateRemoteRelayToolInput({ ...first.args, action: first.action });
    // What the first check named as ignored is not handed on: the second one
    // refuses and ignores nothing.
    const { ignored: _named, ...handedOn } = first;
    assert.deepEqual(second, handedOn, JSON.stringify(input));
    assert.equal(second.ignored, undefined, JSON.stringify(input));
  }
  // The covered actions are all of them.
  assert.deepEqual([...new Set(inputs.map((input) => input.action))].sort(), [...REMOTE_RELAY_ACTIONS].sort());
});

test('schedule: text and a time, once by default only for at; list and unschedule; relay may be left out', () => {
  const now = Date.parse('2026-03-02T10:00:00.000Z');
  const validate = (input) => validateRemoteRelayToolInput(input, { now });
  assert.deepEqual(validate({ action: 'schedule', text: ' Sweep. ', every_minutes: 30, title: ' Sweep\nnow ' }), {
    ok: true,
    action: 'schedule',
    args: { relay: 'this', text: 'Sweep.', every_minutes: 30, once: false, title: 'Sweep now' },
  });
  assert.deepEqual(validate({ action: 'schedule', session: 'conv-b', text: 'Hi.', at: '2026-03-02T11:30:00+01:00' }).args, {
    relay: 'this', session: 'conv-b', text: 'Hi.', at: '2026-03-02T10:30:00.000Z', once: true,
  });
  assert.deepEqual(validate({ action: 'schedule', text: 'x', at: '2026-03-03T02:00:00Z', every_minutes: '1440' }).args,
    { relay: 'this', text: 'x', at: '2026-03-03T02:00:00.000Z', every_minutes: 1440, once: false });
  assert.equal(validate({ action: 'schedule', text: 'x', every_minutes: 60, once: 'true' }).args.once, true);
  assert.match(validate({ action: 'schedule', every_minutes: 30 }).error, /needs text/);
  assert.match(validate({ action: 'schedule', text: 'x' }).error, /needs at .* or every_minutes/);
  assert.match(validate({ action: 'schedule', text: 'x', every_minutes: 4 }).error, /from 5 to 10080/);
  assert.match(validate({ action: 'schedule', text: 'x', every_minutes: 10081 }).error, /from 5 to 10080/);
  assert.match(validate({ action: 'schedule', text: 'x', every_minutes: 7.5 }).error, /whole number/);
  assert.match(validate({ action: 'schedule', text: 'x', at: '2026-03-02T09:00:00Z' }).error, /in the past/);
  assert.match(validate({ action: 'schedule', text: 'x', at: '2026-03-02 12:00' }).error, /with a zone/);
  assert.match(validate({ action: 'schedule', text: 'x', at: '2026-03-02T12:00:00Z', once: false }).error, /repeats needs every_minutes/);
  assert.match(validate({ action: 'schedule', text: 'x'.repeat(20001), every_minutes: 5 }).error, /longer than 20000/);
  assert.deepEqual(validate({ action: 'schedule', text: 'x', every_minutes: 5, wait_seconds: 9 }).ignored, ['wait_seconds']);
  assert.deepEqual(validate({ action: 'list_schedules' }).args, { relay: 'this' });
  assert.deepEqual(validate({ action: 'list_schedules', relay: 'lab', session: 'conv-b' }).args, { relay: 'lab', session: 'conv-b' });
  assert.match(validate({ action: 'unschedule' }).error, /needs schedule_id/);
  assert.deepEqual(validate({ action: 'unschedule', schedule_id: 'sch_ab' }).args, { relay: 'this', schedule_id: 'sch_ab' });
  assert.equal(summarizeRemoteRelayCall({ action: 'schedule', relay: 'this', every_minutes: 30, title: 'Sweep' }), 'schedule → this: every 30 min “Sweep”');
  assert.equal(summarizeRemoteRelayCall({ action: 'unschedule', relay: 'this', schedule_id: 'sch_ab' }), 'unschedule → this: sch_ab');
  for (const key of ['at', 'every_minutes', 'schedule_id']) assert.ok(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties[key], key);
  assert.match(REMOTE_RELAY_TOOL_DESCRIPTION, /\[relay schedule <id>/);
  assert.doesNotMatch(REMOTE_RELAY_TOOL_DESCRIPTION, /may not survive/);
});

test('schedule needs prompt for another session and read for the caller\'s own', () => {
  assert.equal(remoteRelayActionPermission('schedule'), 'prompt');
  assert.equal(remoteRelayActionPermission('schedule', { ownSession: true }), 'read');
  assert.equal(remoteRelayActionPermission('list_schedules'), 'read');
  assert.equal(remoteRelayActionPermission('unschedule'), 'read');
  assert.equal(remoteRelayActionPermission('send', { ownSession: true }), 'prompt');
  assert.equal(remoteRelayActionPermission('nope'), undefined);
  assert.equal(remoteRelayPermissionAllows('read', 'schedule'), false);
  assert.equal(remoteRelayPermissionAllows('read', 'schedule', { ownSession: true }), true);
  assert.equal(remoteRelayPermissionAllows('prompt', 'schedule'), true);
  assert.deepEqual([...REMOTE_RELAY_SCHEDULE_ACTIONS], ['schedule', 'list_schedules', 'unschedule']);
});

test('ask: a question with options, a recommendation, a detail and an urgency; relay may be left out', () => {
  assert.deepEqual(validateRemoteRelayToolInput({
    action: 'ask',
    question: ' Which database? ',
    options: ['Postgres', 'SQLite'],
    recommendation: 'sqlite',
    detail: '<b>not markup</b>',
  }), {
    ok: true,
    action: 'ask',
    args: { relay: 'this', question: 'Which database?', options: ['Postgres', 'SQLite'], recommendation: 'SQLite', detail: '<b>not markup</b>', urgency: 'normal' },
  });
  assert.deepEqual(validateRemoteRelayToolInput({ action: 'ask', relay: 'lab', session: 'conv-b', question: 'Q', urgency: 'now' }).args,
    { relay: 'lab', session: 'conv-b', question: 'Q', urgency: 'now' });
  assert.match(validateRemoteRelayToolInput({ action: 'ask' }).error, /ask needs question/);
  assert.equal(validateRemoteRelayToolInput({ action: 'ask', question: 'x'.repeat(501) }).code, REMOTE_RELAY_ERROR_CODES.invalidInput);
  assert.match(validateRemoteRelayToolInput({ action: 'ask', question: 'Q', options: Array.from({ length: 9 }, (_, i) => `o${i}`) }).error, /at most 8/);
  assert.match(validateRemoteRelayToolInput({ action: 'ask', question: 'Q', urgency: 'soon' }).error, /urgency/);
  assert.deepEqual(validateRemoteRelayToolInput({ action: 'ask', question: 'Q', text: 'x' }).ignored, ['text']);
  assert.deepEqual(validateRemoteRelayToolInput({ action: 'list_questions' }).args, { relay: 'this' });
  assert.match(validateRemoteRelayToolInput({ action: 'withdraw' }).error, /needs question_id/);
  assert.deepEqual(validateRemoteRelayToolInput({ action: 'withdraw', question_id: 'ask_ab12cd' }).args, { relay: 'this', question_id: 'ask_ab12cd' });
  assert.equal(summarizeRemoteRelayCall({ action: 'ask', relay: 'this', question: 'Which database?', urgency: 'now' }), 'ask → this: “Which database?” (now)');
  assert.equal(summarizeRemoteRelayCall({ action: 'withdraw', relay: 'this', question_id: 'ask_ab12cd' }), 'withdraw → this: ask_ab12cd');
  for (const key of ['question', 'options', 'recommendation', 'detail', 'urgency']) assert.ok(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties[key], key);
  assert.equal(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.options.maxItems, 8);
  assert.match(REMOTE_RELAY_TOOL_DESCRIPTION, /question_answered/);
  assert.match(REMOTE_RELAY_TOOL_DESCRIPTION, /Only the user answers an ask/);
  assert.ok(REMOTE_RELAY_ERROR_CODES.questionLimit);
});

test('ask needs prompt on behalf of another session and read for the caller\'s own; it asks no approval', () => {
  assert.equal(remoteRelayActionPermission('ask'), 'prompt');
  assert.equal(remoteRelayActionPermission('ask', { ownSession: true }), 'read');
  assert.equal(remoteRelayActionPermission('list_questions'), 'read');
  assert.equal(remoteRelayActionPermission('withdraw'), 'read');
  assert.equal(remoteRelayPermissionAllows('read', 'ask'), false);
  assert.equal(remoteRelayPermissionAllows('prompt', 'ask'), true);
  for (const action of ['ask', 'list_questions', 'withdraw']) assert.equal(isRemoteRelayWriteAction(action), false, action);
});

test('subscribe takes scope "all" as ["all"], and not together with session ids', () => {
  assert.deepEqual(validateRemoteRelayToolInput({ action: 'subscribe', scope: 'all' }).args, { relay: 'this', scope: 'all' });
  const mixed = validateRemoteRelayToolInput({ action: 'subscribe', scope: 'all', sessions: ['conv-a'] });
  assert.equal(mixed.ok, false);
  assert.match(mixed.error, /either \["all"\] or a list of session ids/);
  // list_sessions' other scopes mean nothing to subscribe.
  assert.deepEqual(validateRemoteRelayToolInput({ action: 'subscribe', scope: 'recent', sessions: ['conv-a'] }).args, { relay: 'this', sessions: ['conv-a'] });
});

test('read_task_output: session and task_id required, lines defaulted and clamped, read permission', () => {
  assert.deepEqual(validateRemoteRelayToolInput({ action: 'read_task_output', relay: 'this', session: 'conv-a', task_id: 'task-b7' }).args,
    { relay: 'this', session: 'conv-a', task_id: 'task-b7', lines: 200 });
  assert.equal(validateRemoteRelayToolInput({ action: 'read_task_output', relay: 'this', session: 'conv-a', task_id: 'task-b7', lines: 9000 }).args.lines, 500);
  assert.match(validateRemoteRelayToolInput({ action: 'read_task_output', relay: 'this', session: 'conv-a' }).error, /needs task_id/);
  assert.match(validateRemoteRelayToolInput({ action: 'read_task_output', relay: 'this', task_id: 'task-b7' }).error, /needs session/);
  assert.match(validateRemoteRelayToolInput({ action: 'read_task_output', relay: 'this', session: 'conv-a', task_id: '../x' }).error, /not a task id/);
  assert.match(validateRemoteRelayToolInput({ action: 'read_task_output', relay: 'this', session: 'conv-a', task_id: 't', lines: 'many' }).error, /lines must be a number/);
  assert.equal(REMOTE_RELAY_ACTION_PERMISSION.read_task_output, 'read');
  assert.equal(remoteRelayPermissionAllows('read', 'read_task_output'), true);
  assert.match(REMOTE_RELAY_TOOL_DESCRIPTION, /read_task_output/);
  assert.equal(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.lines.maximum, 500);
});

// ─── create_session group, and arguments an action does not take ─────────────

test('create_session takes group, trimmed and capped', () => {
  const parsed = validateRemoteRelayToolInput({ action: 'create_session', relay: 'this', text: 'go', group: '  Docs pass  ' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.args.group, 'Docs pass');
  assert.equal(validateRemoteRelayToolInput({ action: 'create_session', relay: 'this', text: 'go', group: 'g'.repeat(500) }).args.group.length, 200);
  assert.equal(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.group.type, 'string');
  assert.match(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.group.description, /create_session/);
  // An empty group is no group: today's default grouping.
  for (const group of ['', '   ', null, undefined]) {
    const plain = validateRemoteRelayToolInput({ action: 'create_session', relay: 'this', text: 'go', group });
    assert.equal(plain.ok, true, String(group));
    assert.equal(Object.prototype.hasOwnProperty.call(plain.args, 'group'), false, String(group));
  }
  // A known argument of the wrong type still fails.
  const typed = validateRemoteRelayToolInput({ action: 'create_session', relay: 'this', text: 'go', group: { id: 'grp_1' } });
  assert.equal(typed.ok, false);
  assert.match(typed.error, /group must be text/);
});

test('group is not an argument of send (taken by create_session and update_session only, ignored on send)', () => {
  const sent = validateRemoteRelayToolInput({ action: 'send', relay: 'this', session: 's', text: 'hi', group: 'Docs' });
  assert.equal(sent.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(sent.args, 'group'), false);
  assert.deepEqual(sent.ignored, ['group']);
  assert.ok(REMOTE_RELAY_ACTION_ARGUMENTS.create_session.includes('group'));
  assert.ok(REMOTE_RELAY_ACTION_ARGUMENTS.update_session.includes('group'));
  for (const action of REMOTE_RELAY_ACTIONS.filter((name) => name !== 'create_session' && name !== 'update_session')) {
    assert.equal(REMOTE_RELAY_ACTION_ARGUMENTS[action].includes('group'), false, action);
  }
});

test('create_session refuses an argument it does not take and lists its arguments', () => {
  const refused = validateRemoteRelayToolInput({
    action: 'create_session', relay: 'this', text: 'go', session: 'conv-a', scope: 'recent', groupId: 'grp_1',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, REMOTE_RELAY_ERROR_CODES.invalidInput);
  assert.match(refused.error, /^create_session does not take: groupId, scope, session\./);
  assert.match(refused.error, /Its arguments: relay, text, provider, model, cwd, repo, branch, mode, effort, title, group, wait_seconds\./);
  assert.match(refused.error, /Nothing was created\./);
  // The refusal comes first, before any other check of the call.
  assert.equal(validateRemoteRelayToolInput({ action: 'create_session', relay: 'this', bogus: 1 }).error.startsWith('create_session does not take: bogus'), true);
});

test('create_session treats null, empty, false and [] extra arguments as absent', () => {
  const parsed = validateRemoteRelayToolInput({
    action: 'create_session', relay: 'this', text: 'go',
    session: null, scope: '', query: '   ', include_activity: false, choices: [], sessions: undefined,
  });
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.ignored, undefined);
  // 0 and true are values.
  assert.equal(validateRemoteRelayToolInput({ action: 'create_session', relay: 'this', text: 'go', last: 0 }).ok, false);
  assert.equal(validateRemoteRelayToolInput({ action: 'create_session', relay: 'this', text: 'go', once: true }).ok, false);
});

test('other actions return the arguments they do not take in ignored', () => {
  const read = validateRemoteRelayToolInput({ action: 'read_session', relay: 'this', session: 's', text: 'x', provider: 'claude', limit: null });
  assert.equal(read.ok, true);
  assert.deepEqual(read.ignored, ['provider', 'text']);
  const stop = validateRemoteRelayToolInput({ action: 'stop', relay: 'this', session: 's', if_busy: 'fail' });
  assert.deepEqual(stop.ignored, ['if_busy']);
  // A failed check names them too.
  const failed = validateRemoteRelayToolInput({ action: 'wait', relay: 'this', session: 's', model: 'x' });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.ignored, ['model']);
  // Nothing to name: no key.
  assert.equal(validateRemoteRelayToolInput({ action: 'stop', relay: 'this', session: 's' }).ignored, undefined);
  // Capped.
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`extra_${String(index).padStart(2, '0')}`, 1]));
  assert.equal(validateRemoteRelayToolInput({ action: 'stop', relay: 'this', session: 's', ...many }).ignored.length, 20);
});

test('list_relays reports ignored arguments too', () => {
  const parsed = validateRemoteRelayToolInput({ action: 'list_relays', relay: 'this', session: 'conv-a' });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.args, {});
  assert.deepEqual(parsed.ignored, ['session']);
});

test('resolveSessionGroupReference finds by id, by name case-insensitively, reports unknown and ambiguous', () => {
  const groups = [
    { id: 'grp_aaa', name: 'Docs pass', memberCount: 3 },
    { id: 'grp_bbb', name: 'Release', memberCount: 1 },
    { id: 'grp_ccc', name: 'release', memberCount: 2 },
  ];
  assert.equal(resolveSessionGroupReference(groups, 'grp_bbb').group.id, 'grp_bbb');
  assert.equal(resolveSessionGroupReference(groups, '  docs   PASS ').group.id, 'grp_aaa');
  assert.deepEqual(resolveSessionGroupReference(groups, 'nope'), { status: 'unknown' });
  assert.deepEqual(resolveSessionGroupReference(groups, ''), { status: 'unknown' });
  assert.deepEqual(resolveSessionGroupReference([], 'Docs pass'), { status: 'unknown' });
  const ambiguous = resolveSessionGroupReference(groups, 'RELEASE');
  assert.equal(ambiguous.status, 'ambiguous');
  assert.deepEqual(ambiguous.matches.map((group) => group.id), ['grp_bbb', 'grp_ccc']);
  // An id wins over a group that is named like it.
  assert.equal(resolveSessionGroupReference([...groups, { id: 'grp_ddd', name: 'grp_aaa' }], 'grp_aaa').group.id, 'grp_aaa');
  assert.equal(formatSessionGroupList(groups, 2), 'Docs pass (grp_aaa), Release (grp_bbb) and 1 more');
});

test('the tool text lets agents name a group, move sessions with update_session, and leaves renaming to the owner', () => {
  assert.doesNotMatch(REMOTE_RELAY_TOOL_DESCRIPTION, /read-only for agents/);
  assert.match(REMOTE_RELAY_TOOL_DESCRIPTION, /Agents can name an existing group when they create a session/);
  assert.match(REMOTE_RELAY_TOOL_DESCRIPTION, /Renaming and dissolving groups stay the owner's/);
  assert.match(REMOTE_RELAY_TOOL_DESCRIPTION, /comes back in ignored; create_session and update_session refuse/);
  assert.equal(REMOTE_RELAY_ERROR_CODES.unknownGroup, 'REMOTE_RELAY_UNKNOWN_GROUP');
});

// ─── update_session ──────────────────────────────────────────────────────────

test('update_session: a full-permission write action on one session, with the settings it names', () => {
  assert.ok(REMOTE_RELAY_ACTIONS.includes('update_session'));
  assert.equal(REMOTE_RELAY_ACTION_PERMISSION.update_session, 'full');
  assert.equal(isRemoteRelayWriteAction('update_session'), true);
  assert.equal(remoteRelayPermissionAllows('prompt', 'update_session'), false);
  assert.equal(remoteRelayPermissionAllows('full', 'update_session'), true);
  assert.deepEqual([...REMOTE_RELAY_SESSION_SETTINGS], ['model', 'effort', 'mode', 'auto_compact_window', 'title', 'group', 'thinking_enabled', 'thinking_display', 'cwd']);
  assert.deepEqual([...REMOTE_RELAY_ACTION_ARGUMENTS.update_session], ['session', ...REMOTE_RELAY_SESSION_SETTINGS]);
  const parsed = validateRemoteRelayToolInput({
    action: 'update_session', relay: 'this', session: ' conv-a ', model: ' claude-opus-5 ', effort: 'HIGH', mode: 'Plan',
    auto_compact_window: '150000', title: '  Docs pass ', group: ' Docs ', thinking_enabled: 'off', thinking_display: 'Omitted', cwd: ' /home/dev/next ',
  });
  assert.equal(parsed.ok, true, parsed.error);
  assert.deepEqual(parsed.args, {
    relay: 'this', session: 'conv-a', model: 'claude-opus-5', effort: 'high', mode: 'plan',
    auto_compact_window: 150000, title: 'Docs pass', group: 'Docs', thinking_enabled: false, thinking_display: 'omitted', cwd: '/home/dev/next',
  });
  assert.equal(REMOTE_RELAY_ERROR_CODES.permission, 'REMOTE_RELAY_PERMISSION');
});

test('update_session needs a session and at least one setting', () => {
  const validate = (input) => validateRemoteRelayToolInput({ action: 'update_session', relay: 'this', ...input });
  assert.match(validate({ model: 'x' }).error, /needs session/);
  const none = validate({ session: 'conv-a' });
  assert.equal(none.ok, false);
  assert.match(none.error, /needs at least one setting to change: model, effort, mode, auto_compact_window, title, group, thinking_enabled, thinking_display, cwd/);
  // Empty values are no settings.
  assert.equal(validate({ session: 'conv-a', model: '', title: '  ', effort: null, thinking_display: '' }).ok, false);
});

test('update_session: group takes an id or name, and "none" or null take the session out', () => {
  const validate = (group) => validateRemoteRelayToolInput({ action: 'update_session', relay: 'this', session: 'conv-a', group });
  assert.equal(validate('grp_abc').args.group, 'grp_abc');
  assert.equal(validate('New batch').args.group, 'New batch');
  assert.equal(validate(null).args.group, null);
  assert.equal(validate('None').args.group, null);
  assert.equal(validate('g'.repeat(500)).args.group.length, 200);
  assert.match(validate({ id: 'grp_1' }).error, /group must be text/);
  // An empty group names nothing.
  assert.equal(validate('').ok, false);
  assert.equal(REMOTE_RELAY_NO_GROUP, 'none');
});

test('update_session: auto_compact_window, thinking and mode are checked for their shape', () => {
  const validate = (extra) => validateRemoteRelayToolInput({ action: 'update_session', relay: 'this', session: 'conv-a', ...extra });
  assert.equal(validate({ auto_compact_window: 0 }).args.auto_compact_window, 'auto');
  assert.equal(validate({ auto_compact_window: 'AUTO' }).args.auto_compact_window, 'auto');
  assert.equal(validate({ auto_compact_window: 123456.7 }).args.auto_compact_window, 123456);
  assert.match(validate({ auto_compact_window: -5 }).error, /auto_compact_window must be a number of tokens/);
  assert.match(validate({ auto_compact_window: 'lots' }).error, /auto_compact_window/);
  assert.match(validate({ auto_compact_window: true }).error, /auto_compact_window/);
  // false is no 0: refused, never taken for the model default.
  const off = validate({ auto_compact_window: false, model: 'x' });
  assert.equal(off.ok, false);
  assert.match(off.error, /auto_compact_window must be a number of tokens/);
  // The schema promises 0 for the default, not "auto" (a strict schema takes an integer only).
  assert.doesNotMatch(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.auto_compact_window.description, /"auto"/);
  assert.match(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.auto_compact_window.description, /or 0 for the model default/);
  assert.match(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.group.description, /out of its group \("none"\)/);
  assert.match(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.group.description, /A group the owner made is never removed this way/);
  assert.equal(validate({ thinking_enabled: false }).args.thinking_enabled, false);
  assert.equal(validate({ thinking_enabled: 'true' }).args.thinking_enabled, true);
  assert.match(validate({ thinking_enabled: 'maybe' }).error, /thinking_enabled must be true or false/);
  assert.match(validate({ thinking_display: 'raw' }).error, /thinking_display must be one of: summarized, omitted/);
  assert.match(validate({ mode: 'yolo' }).error, /mode must be one of/);
  assert.match(validate({ effort: 'very high!' }).error, /effort must be a short word/);
  assert.match(validate({ model: 42 }).error, /model must be text/);
  assert.match(validate({ title: ['x'] }).error, /title must be text/);
  assert.equal(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.auto_compact_window.type, 'integer');
  assert.equal(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.thinking_enabled.type, 'boolean');
  assert.deepEqual(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.thinking_display.enum, ['summarized', 'omitted']);
});

test('update_session refuses an argument it does not take, the owner-only switch with a word on why', () => {
  const refused = validateRemoteRelayToolInput({ action: 'update_session', relay: 'this', session: 'conv-a', model: 'x', text: 'go' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /^update_session does not take: text\. Its arguments: relay, session, model, effort, mode, auto_compact_window, title, group, thinking_enabled, thinking_display, cwd\. Nothing was changed\.$/);
  const owner = validateRemoteRelayToolInput({ action: 'update_session', relay: 'this', session: 'conv-a', may_create_sessions: true });
  assert.equal(owner.ok, false);
  assert.match(owner.error, /does not take: may_create_sessions\..*the owner's setting alone/);
  assert.match(validateRemoteRelayToolInput({ action: 'update_session', relay: 'this', session: 'conv-a', mayCreateSessions: true }).error, /owner's setting alone/);
});

test('update_session is summarized with the settings it names, and the tool text explains it', () => {
  assert.equal(
    summarizeRemoteRelayCall({ action: 'update_session', relay: 'this', session: 'conv-abcdef123', model: 'x', group: null, thinking_enabled: false }),
    'update_session → this session conv-abc: model, group, thinking_enabled',
  );
  assert.match(REMOTE_RELAY_TOOL_DESCRIPTION, /update_session \{session, \.\.\.\} sets another session's model, effort, mode, auto_compact_window, title, group/);
  assert.match(REMOTE_RELAY_TOOL_DESCRIPTION, /A session this conversation started may be changed freely; any other \(the owner's, another agent's, the one that started you\) needs the owner's Allow once per conversation and relay; your own conversation never/);
  assert.match(REMOTE_RELAY_TOOL_DESCRIPTION, /A group the owner made is never removed that way \(it may stay empty\)/);
  assert.match(REMOTE_RELAY_TOOL_DESCRIPTION, /lasts until the next send that names another mode or comes from a caller in another mode/);
  assert.match(REMOTE_RELAY_TOOL_DESCRIPTION, /unless the owner allowed it for that session \(list_sessions and read_session show mayCreateSessions\)/);
  assert.match(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.action.description, /update_session: change another session's settings/);
  assert.match(REMOTE_RELAY_TOOL_DESCRIPTION, /thinking and cwd \(its CLI restarts there; not while it works\)/);
  for (const key of ['model', 'mode', 'effort', 'title', 'group', 'cwd']) {
    assert.match(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties[key].description, /update_session/, key);
  }
});

test('formatSessionGroupList counts the groups a capped list leaves out', () => {
  const groups = [{ id: 'grp_a', name: 'A' }, { id: 'grp_b', name: 'B' }];
  assert.equal(formatSessionGroupList(groups, 20, 25), 'A (grp_a), B (grp_b) and 23 more');
  assert.equal(formatSessionGroupList(groups, 1, 25), 'A (grp_a) and 24 more');
  // A total below the list's own length changes nothing.
  assert.equal(formatSessionGroupList(groups, 20, 1), 'A (grp_a), B (grp_b)');
  assert.equal(formatSessionGroupList(groups), 'A (grp_a), B (grp_b)');
});
