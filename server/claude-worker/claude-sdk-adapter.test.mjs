import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_AUTO_BACKGROUND_TIMEOUT_MS,
  CLAUDE_BASH_MAX_TIMEOUT_MS,
  CLAUDE_LIVE_FLAG_SETTINGS_CODE,
  CLAUDE_ULTRACODE_EFFORT,
  LIVE_FLAG_SETTINGS_TIMEOUT_MS,
  RELAY_MCP_SERVER_NAME,
  RELAY_MCP_TOOL_TIMEOUT_MS,
  applyThinkingDisplay,
  claudeSpawnEnv,
  claudeSpawnSettings,
  claudeThinkingFlagSettings,
  claudeUltracodeFlagSettings,
  createCanUseTool,
  isPersonOnlyAsk,
  longCommandInstructionText,
  mergeSpawnSettings,
  normalizeClaudeEffort,
  permissionModeForRelayMode,
  personOnlyQuestionText,
  PERSON_ONLY_ALLOW_CHOICE,
  PERSON_ONLY_COMMAND_MAX,
  PERSON_ONLY_DENY_CHOICE,
  PERSON_ONLY_QUESTION_SOURCE,
  PERSON_ONLY_TOO_LONG_MESSAGE,
  startClaudeSession,
  systemPromptForRelayMode,
} from './claude-sdk-adapter.mjs';

test('relay modes map to SDK permission modes', () => {
  assert.equal(permissionModeForRelayMode('plan'), 'plan');
  assert.equal(permissionModeForRelayMode('ask'), 'default');
  assert.equal(permissionModeForRelayMode('agent'), 'default');
  assert.equal(permissionModeForRelayMode('autopilot'), 'default');
  assert.equal(permissionModeForRelayMode(''), 'default');
});

test('every mode teaches media embedding; ask and autopilot add their nudge on top', () => {
  for (const mode of ['plan', 'agent', 'ask', 'autopilot']) {
    assert.match(systemPromptForRelayMode(mode).append, /image, video, or audio clip inline/);
    assert.match(systemPromptForRelayMode(mode).append, /write it in TeX between dollar signs/);
  }
  assert.match(systemPromptForRelayMode('ask').append, /Prioritize clarification questions/);
  assert.match(systemPromptForRelayMode('autopilot').append, /Keep moving unless user input/);
  assert.doesNotMatch(systemPromptForRelayMode('plan').append, /Prioritize clarification|Keep moving/);
  assert.equal(systemPromptForRelayMode('agent').preset, 'claude_code');
});

test('startClaudeSession builds streaming-input query options', async () => {
  let captured = null;
  const queryImpl = (params) => {
    captured = params;
    return { async* [Symbol.asyncIterator]() {} };
  };
  const abortController = new AbortController();
  const turn = startClaudeSession({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/workspace',
    model: 'claude-sonnet-5',
    resume: 'sess-1',
    relayMode: 'plan',
    abortController,
    canUseTool: async () => ({ behavior: 'allow' }),
    queryImpl,
  });
  assert.ok(captured);
  assert.equal(typeof captured.prompt[Symbol.asyncIterator], 'function');
  assert.equal(captured.options.cwd, '/workspace');
  assert.equal(captured.options.model, 'claude-sonnet-5');
  assert.equal(captured.options.resume, 'sess-1');
  assert.equal(captured.options.permissionMode, 'plan');
  assert.equal(captured.options.includePartialMessages, true);
  assert.equal(captured.options.forwardSubagentText, true);
  assert.equal(captured.options.abortController, abortController);
  assert.equal(typeof captured.options.canUseTool, 'function');

  // The prompt stream carries the initial content, accepts pushed follow-up
  // turns, and only ends when endInput releases it.
  assert.equal(typeof turn.endInput, 'function');
  assert.equal(typeof turn.pushUserMessage, 'function');
  const messages = [];
  const drained = (async () => {
    for await (const message of captured.prompt) messages.push(message);
  })();
  turn.pushUserMessage([{ type: 'text', text: 'follow-up' }]);
  turn.endInput();
  await drained;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].type, 'user');
  assert.deepEqual(messages[0].message.content, [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(messages[1].message.content, [{ type: 'text', text: 'follow-up' }]);
  assert.throws(() => turn.pushUserMessage([{ type: 'text', text: 'late' }]), /ended/);
});

test('an injected api registers the relay MCP server carrying the preview tool', async () => {
  const calls = [];
  let captured = null;
  startClaudeSession({
    content: null,
    cwd: '/workspace',
    api: async (method, routePath, body) => {
      calls.push({ method, routePath, body });
      return { previews: [], enabled: true };
    },
    getConversationId: () => 'conv-7',
    queryImpl: (params) => { captured = params; return {}; },
  });
  assert.equal(RELAY_MCP_SERVER_NAME, 'relay');
  const server = captured.options.mcpServers?.[RELAY_MCP_SERVER_NAME];
  assert.ok(server, 'the relay server must be registered');
  assert.equal(server.type, 'sdk', 'it runs in-process, not as a child MCP process');
  assert.equal(server.name, 'relay');

  // The server owns the only reference to the tool, so the round-trip is
  // exercised through its registration.
  const registered = server.instance._registeredTools;
  assert.deepEqual(Object.keys(registered), ['preview']);
  const result = await registered.preview.handler({ action: 'list' }, {});
  assert.deepEqual(calls, [{ method: 'GET', routePath: '/api/previews?conversationId=conv-7', body: undefined }]);
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, enabled: true, previews: [] });
});

test('the relay MCP server carries relay_tool only when the worker registered it', async () => {
  const calls = [];
  const capture = (remoteRelayTool) => {
    let captured = null;
    startClaudeSession({
      content: null,
      cwd: '/workspace',
      api: async (method, routePath, body) => {
        calls.push({ method, routePath, body });
        return { ok: true, relays: [] };
      },
      getConversationId: () => 'conv-9',
      ...(remoteRelayTool === undefined ? {} : { remoteRelayTool }),
      queryImpl: (params) => { captured = params; return {}; },
    });
    return captured.options.mcpServers[RELAY_MCP_SERVER_NAME];
  };

  assert.deepEqual(Object.keys(capture(undefined).instance._registeredTools), ['preview'], 'off by default');
  assert.deepEqual(Object.keys(capture(false).instance._registeredTools), ['preview']);
  const server = capture(true);
  const registered = server.instance._registeredTools;
  assert.deepEqual(Object.keys(registered), ['preview', 'relay_tool']);

  const result = await registered.relay_tool.handler({ action: 'list_relays' }, {});
  assert.deepEqual(calls, [{
    method: 'POST',
    routePath: '/api/remote-relays/tool',
    body: { conversationId: 'conv-9', action: 'list_relays', args: {} },
  }]);
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, relays: [] });
});

test('the relay MCP server pins its own tool-call timeout above any relay_tool wait', () => {
  let captured = null;
  startClaudeSession({
    content: null,
    cwd: '/workspace',
    api: async () => ({}),
    remoteRelayTool: true,
    queryImpl: (params) => { captured = params; return {}; },
  });
  const server = captured.options.mcpServers[RELAY_MCP_SERVER_NAME];
  assert.equal(server.timeout, RELAY_MCP_TOOL_TIMEOUT_MS);
  // wait_seconds tops out at 600 s; the rest of the budget is approval time.
  assert.ok(RELAY_MCP_TOOL_TIMEOUT_MS >= 60 * 60_000);
});

test('a session without an api helper registers no MCP servers', () => {
  let captured = null;
  startClaudeSession({
    content: null,
    cwd: '/workspace',
    queryImpl: (params) => { captured = params; return {}; },
  });
  assert.equal('mcpServers' in captured.options, false);
});

test('startClaudeSession omits model for auto and resume when empty', () => {
  let captured = null;
  startClaudeSession({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/workspace',
    model: 'auto',
    resume: '',
    queryImpl: (params) => { captured = params; return {}; },
  });
  assert.equal('model' in captured.options, false);
  assert.equal('resume' in captured.options, false);
});

test('canUseTool bridges AskUserQuestion answers into updatedInput', async () => {
  const canUseTool = createCanUseTool({
    askUserBridge: {
      handleAskUserQuestion: async (input) => ({ answers: { 'Q?': 'A' }, timedOut: false }),
    },
  });
  const input = { questions: [{ question: 'Q?' }] };
  const result = await canUseTool('AskUserQuestion', input, { signal: null });
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(result.updatedInput.answers, { 'Q?': 'A' });
  assert.deepEqual(result.updatedInput.questions, input.questions);
});

test('canUseTool posts plan board on ExitPlanMode and denies so the turn ends', async () => {
  let planInput = null;
  const canUseTool = createCanUseTool({
    onExitPlanMode: async (input) => { planInput = input; },
  });
  const result = await canUseTool('ExitPlanMode', { plan: '1. do\n2. done' }, {});
  // Allowing ExitPlanMode approves the plan and the same turn implements it;
  // deny ends the turn so the plan board's choice drives the next turn.
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /review/i);
  assert.deepEqual(planInput, { plan: '1. do\n2. done' });
});

test('canUseTool allows ExitPlanMode untouched when no board handler is wired', async () => {
  const canUseTool = createCanUseTool({});
  const result = await canUseTool('ExitPlanMode', { plan: '1. do' }, {});
  assert.equal(result.behavior, 'allow');
});

test('canUseTool allows every other tool (allow-all parity)', async () => {
  const canUseTool = createCanUseTool({});
  for (const toolName of ['Bash', 'Edit', 'Write', 'WebFetch']) {
    const result = await canUseTool(toolName, { any: true }, {});
    assert.equal(result.behavior, 'allow');
  }
});

test('canUseTool denies when the bridge fails', async () => {
  const canUseTool = createCanUseTool({
    askUserBridge: {
      handleAskUserQuestion: async () => { throw new Error('relay down'); },
    },
  });
  const result = await canUseTool('AskUserQuestion', { questions: [] }, {});
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /relay down/);
});

// The option shapes Claude Code 2.1.304 sends canUseTool (SDK 0.3.304), as
// probed on a scratch folder; paths and ids invented.
const PERSON_ONLY_RM_COMMAND = 'rm -rf /srv/sample-app/work';
const PERSON_ONLY_RM_REASON = 'Dangerous rm operation on working directory or its ancestor: /srv/sample-app/work';
const ASK_SHAPES = {
  rmWorkspace: {
    suggestions: [],
    decisionReason: PERSON_ONLY_RM_REASON,
    decisionReasonType: 'safetyCheck',
    displayName: 'Bash',
    suppressAlwaysAllowRule: true,
    toolUseID: 'toolu_sample_1',
    requestId: 'req-sample-1',
  },
  rmCompound: {
    suggestions: [{
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: PERSON_ONLY_RM_COMMAND }],
      behavior: 'allow',
      destination: 'localSettings',
    }],
    decisionReason: PERSON_ONLY_RM_REASON,
    decisionReasonType: 'subcommandResults',
    displayName: 'Bash',
    suppressAlwaysAllowRule: true,
    toolUseID: 'toolu_sample_2',
    requestId: 'req-sample-2',
  },
  ordinary: {
    suggestions: [{
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'touch /srv/sample-app/work/new.txt' }],
      behavior: 'allow',
      destination: 'localSettings',
    }],
    blockedPath: '/srv/sample-app/work/new.txt',
    displayName: 'Bash',
    toolUseID: 'toolu_sample_3',
    requestId: 'req-sample-3',
  },
  sensitiveRcFile: {
    suggestions: [],
    blockedPath: '/srv/sample-app/work/.bashrc',
    decisionReason: 'Claude requested permissions to edit /srv/sample-app/work/.bashrc which is a sensitive file.',
    decisionReasonType: 'safetyCheck',
    displayName: 'Bash',
    toolUseID: 'toolu_sample_4',
    requestId: 'req-sample-4',
  },
  claudeSettingsFile: {
    suggestions: [],
    decisionReason: 'Claude requested permissions to write to /srv/sample-app/work/.claude/settings.local.json, but you haven\'t granted it yet.',
    decisionReasonType: 'safetyCheck',
    displayName: 'Bash',
    toolUseID: 'toolu_sample_5',
    requestId: 'req-sample-5',
  },
  defaultToNo: {
    decisionReason: 'Auto mode classifier blocked action: removes a shared sample folder',
    decisionReasonType: 'classifier',
    defaultToNo: true,
    suppressAlwaysAllowRule: true,
    toolUseID: 'toolu_sample_6',
    requestId: 'req-sample-6',
  },
};

function recordingBridge(reply) {
  const calls = [];
  return {
    calls,
    handleAskUserQuestion: async (input, opts) => {
      calls.push({ input, opts });
      const question = input.questions[0].question;
      const result = typeof reply === 'function' ? await reply(question, opts) : reply;
      return { answers: { [question]: result?.answer ?? '' }, timedOut: result?.timedOut === true };
    },
  };
}

const SAMPLE_ASK_RULE = { source: 'userSettings', toolName: 'Bash', ruleContent: 'rm:*' };

test('isPersonOnlyAsk takes the person-only rm shapes and defaultToNo, whatever ask rule matched', () => {
  assert.equal(isPersonOnlyAsk(ASK_SHAPES.rmWorkspace), true);
  assert.equal(isPersonOnlyAsk(ASK_SHAPES.rmCompound), true);
  assert.equal(isPersonOnlyAsk(ASK_SHAPES.defaultToNo), true);
  assert.equal(isPersonOnlyAsk(ASK_SHAPES.ordinary), false);
  // Sensitive-file safety checks carry no suppressAlwaysAllowRule.
  assert.equal(isPersonOnlyAsk(ASK_SHAPES.sensitiveRcFile), false);
  assert.equal(isPersonOnlyAsk(ASK_SHAPES.claudeSettingsFile), false);
  // A matched ask rule changes nothing: the flags decide.
  assert.equal(isPersonOnlyAsk({ ...ASK_SHAPES.rmWorkspace, matchedAskRule: SAMPLE_ASK_RULE }), true);
  assert.equal(isPersonOnlyAsk({ ...ASK_SHAPES.defaultToNo, matchedAskRule: SAMPLE_ASK_RULE }), true);
  assert.equal(isPersonOnlyAsk({ ...ASK_SHAPES.ordinary, matchedAskRule: SAMPLE_ASK_RULE }), false);
  // An unknown reason kind, or an older CLI without the kind, needs defaultToNo.
  assert.equal(isPersonOnlyAsk({ ...ASK_SHAPES.rmWorkspace, decisionReasonType: 'workingDir' }), false);
  assert.equal(isPersonOnlyAsk({ decisionReason: PERSON_ONLY_RM_REASON, suppressAlwaysAllowRule: true }), false);
  assert.equal(isPersonOnlyAsk({ defaultToNo: true }), true);
  assert.equal(isPersonOnlyAsk(undefined), false);
  assert.equal(isPersonOnlyAsk(null), false);
});

test('a person-only ask becomes an Allow/Deny card and "Allow once" allows without updatedPermissions', async () => {
  const bridge = recordingBridge({ answer: PERSON_ONLY_ALLOW_CHOICE });
  const canUseTool = createCanUseTool({ askUserBridge: bridge });
  const input = { command: PERSON_ONLY_RM_COMMAND, description: 'Remove the work folder' };
  const shapes = {
    ...ASK_SHAPES,
    ruleAndFlags: { ...ASK_SHAPES.rmWorkspace, matchedAskRule: SAMPLE_ASK_RULE },
    ruleAndDefaultToNo: { ...ASK_SHAPES.defaultToNo, matchedAskRule: SAMPLE_ASK_RULE },
  };
  const carded = ['rmWorkspace', 'rmCompound', 'defaultToNo', 'ruleAndFlags', 'ruleAndDefaultToNo'];
  for (const shape of carded) {
    const result = await canUseTool('Bash', input, { signal: new AbortController().signal, ...shapes[shape] });
    assert.deepEqual(result, { behavior: 'allow', updatedInput: input }, shape);
    assert.equal('updatedPermissions' in result, false, shape);
  }
  assert.equal(bridge.calls.length, carded.length);
  const { input: card, opts } = bridge.calls[0];
  assert.equal(card.questions.length, 1);
  assert.equal(card.questions[0].header, 'Safety check');
  assert.deepEqual(card.questions[0].options.map((option) => option.label), [PERSON_ONLY_ALLOW_CHOICE, PERSON_ONLY_DENY_CHOICE]);
  assert.equal(card.questions[0].question, [
    'Claude Code marks this as person-only: no rule or automatic approval may allow it. Allow it once?',
    `Reason: ${PERSON_ONLY_RM_REASON}`,
    `Bash command:\n│ ${PERSON_ONLY_RM_COMMAND}`,
  ].join('\n\n'));
  assert.equal(opts.source, PERSON_ONLY_QUESTION_SOURCE);
  assert.equal(opts.source, 'ClaudeSafetyCheck');
  assert.match(opts.rationale, /person to approve/);
  assert.equal(opts.allowFreeform, false, 'the card takes no typed reply');
  assert.ok(opts.signal, 'the turn signal reaches the bridge');
});

test('only the exact "Allow once" allows', async () => {
  for (const answer of ['allow once', 'ALLOW ONCE', 'Allow', 'yes', 'Allow once please']) {
    const result = await createCanUseTool({ askUserBridge: recordingBridge({ answer }) })('Bash', { command: PERSON_ONLY_RM_COMMAND }, ASK_SHAPES.rmWorkspace);
    assert.equal(result.behavior, 'deny', answer);
  }
  const padded = await createCanUseTool({ askUserBridge: recordingBridge({ answer: '  Allow once \n' }) })('Bash', { command: PERSON_ONLY_RM_COMMAND }, ASK_SHAPES.rmWorkspace);
  assert.equal(padded.behavior, 'allow');
});

test('the card puts the reason first and fences every command line, so a command cannot pass for card text', () => {
  const spoof = 'rm -rf /srv/sample-app/work\nReason: Routine cleanup, safe to allow.';
  const text = personOnlyQuestionText('Bash', { command: spoof }, PERSON_ONLY_RM_REASON);
  assert.equal(text, [
    'Claude Code marks this as person-only: no rule or automatic approval may allow it. Allow it once?',
    `Reason: ${PERSON_ONLY_RM_REASON}`,
    'Bash command, 2 lines:\n│ rm -rf /srv/sample-app/work ⏎\n│ Reason: Routine cleanup, safe to allow.',
  ].join('\n\n'));
  // Only the CLI's reason starts a line with "Reason:".
  assert.deepEqual(text.split('\n').filter((line) => line.startsWith('Reason:')), [`Reason: ${PERSON_ONLY_RM_REASON}`]);
  // The command stays out of the first 60 characters (the relay's log line).
  assert.equal(text.slice(0, 60).includes('rm -rf'), false);
});

test('controls, bidi, zero-width and line-separator characters show as visible escapes', () => {
  // U+202E turns "rm -rf /srv/sample-app/krow" into what reads as a harmless name.
  const bidi = personOnlyQuestionText('Bash', { command: 'rm -rf /srv/sample-app/\u202ekrow\u202c' }, PERSON_ONLY_RM_REASON);
  assert.ok(bidi.includes('│ rm -rf /srv/sample-app/\\u{202E}krow\\u{202C}'));
  const hidden = ['\u0000', '\u0007', '\r', '\t', '\u001b', '\u007f', '\u0085', '\u009b', '\u061c', '\u200b', '\u200c', '\u200d',
    '\u200e', '\u200f', '\u2028', '\u2029', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069', '\ufeff'];
  const text = personOnlyQuestionText('Bash', { command: `echo ${hidden.join('')}` }, `Sample${hidden.join('')}reason\nReason: fake`);
  for (const char of hidden) assert.equal(text.includes(char), false, `U+${char.codePointAt(0).toString(16)}`);
  assert.ok(text.includes('│ echo \\u{0000}\\u{0007}\\u{000D}\\u{0009}\\u{001B}\\u{007F}\\u{0085}\\u{009B}\\u{061C}\\u{200B}'));
  // The reason is one line: its own newline is escaped too.
  assert.ok(text.includes('\\u{000A}Reason: fake'));
  // Well-formed ANSI colour in the CLI's reason is dropped, not escaped.
  assert.ok(personOnlyQuestionText('Bash', { command: 'rm -rf /srv/sample-app/work' }, '\u001b[31mDangerous rm\u001b[0m operation on a sample path')
    .includes('Reason: Dangerous rm operation on a sample path\n'));
  // Non-shell tools show their path, or the input as JSON.
  assert.ok(personOnlyQuestionText('Write', { file_path: '/srv/sample-app/notes.md', content: 'x' }, '').includes('Write path:\n│ /srv/sample-app/notes.md'));
  assert.ok(personOnlyQuestionText('SampleTool', { target: 'x' }, '').includes('SampleTool input:\n│ {"target":"x"}'));
});

test('the card shows the whole command up to the limit, and a longer one is denied without a card', async () => {
  const prefix = 'rm -rf /srv/sample-app/';
  const atLimit = `${prefix}${'a'.repeat(PERSON_ONLY_COMMAND_MAX - prefix.length)}`;
  assert.equal(atLimit.length, PERSON_ONLY_COMMAND_MAX);
  const bridge = recordingBridge({ answer: PERSON_ONLY_ALLOW_CHOICE });
  const canUseTool = createCanUseTool({ askUserBridge: bridge });
  const shown = await canUseTool('Bash', { command: atLimit }, ASK_SHAPES.rmWorkspace);
  assert.equal(shown.behavior, 'allow');
  assert.ok(bridge.calls[0].input.questions[0].question.endsWith(`│ ${atLimit}`), 'shown whole, not cut');

  const tooLong = await canUseTool('Bash', { command: `${atLimit}b` }, ASK_SHAPES.rmWorkspace);
  assert.deepEqual(tooLong, { behavior: 'deny', message: PERSON_ONLY_TOO_LONG_MESSAGE });
  assert.equal(PERSON_ONLY_TOO_LONG_MESSAGE, 'Not run: too long to show for approval; issue the removal as a short command of its own.');
  assert.equal(bridge.calls.length, 1, 'no card for a command too long to show');
});

test('a person-only ask is denied on Deny, other text, timeout, abort, a failed bridge and no bridge', async () => {
  const input = { command: PERSON_ONLY_RM_COMMAND };
  const options = (extra = {}) => ({ ...ASK_SHAPES.rmWorkspace, signal: new AbortController().signal, ...extra });
  const cases = [
    ['Deny', { askUserBridge: recordingBridge({ answer: PERSON_ONLY_DENY_CHOICE }) }, options(), /the user denied it\./],
    ['other text', { askUserBridge: recordingBridge({ answer: 'no, move it to the sample archive' }) }, options(), /the user denied it: no, move it to the sample archive\./],
    ['empty', { askUserBridge: recordingBridge({ answer: '' }) }, options(), /the user denied it\./],
    ['timeout', { askUserBridge: recordingBridge({ answer: 'Allow once', timedOut: true }) }, options(), /no answer came before the timeout/],
    ['no bridge', {}, options(), /the relay could not show the question/],
    ['bridge failed', { askUserBridge: { handleAskUserQuestion: async () => { throw new Error('relay down'); } } }, options(), /the relay could not show the question/],
  ];
  for (const [label, deps, opts, pattern] of cases) {
    const result = await createCanUseTool(deps)('Bash', input, opts);
    assert.equal(result.behavior, 'deny', label);
    assert.match(result.message, pattern, label);
    assert.ok(result.message.startsWith(`Not run: Claude Code marks this as person-only (${PERSON_ONLY_RM_REASON})`), label);
    assert.match(result.message, /Do not work around it/, label);
    assert.equal('updatedPermissions' in result, false, label);
  }

  // Stopping the turn while the card waits: the bridge resolves with the
  // continuation text (or throws), and either way the ask is denied.
  for (const mode of ['resolves', 'throws']) {
    const controller = new AbortController();
    const bridge = recordingBridge(async () => {
      controller.abort();
      if (mode === 'throws') throw new Error('aborted');
      return { answer: PERSON_ONLY_ALLOW_CHOICE, timedOut: true };
    });
    const result = await createCanUseTool({ askUserBridge: bridge })('Bash', input, options({ signal: controller.signal }));
    assert.equal(result.behavior, 'deny', mode);
    assert.match(result.message, /the turn was stopped/, mode);
  }
});

test('a turn already stopped denies a person-only ask without creating a card', async () => {
  const controller = new AbortController();
  controller.abort();
  const bridge = recordingBridge({ answer: PERSON_ONLY_ALLOW_CHOICE });
  const result = await createCanUseTool({ askUserBridge: bridge })('Bash', { command: PERSON_ONLY_RM_COMMAND }, { ...ASK_SHAPES.rmWorkspace, signal: controller.signal });
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /the turn was stopped/);
  assert.equal(bridge.calls.length, 0);
});

test('every other ask stays auto-allowed without a card, and logs carry no command or reason', async () => {
  const bridge = recordingBridge({ answer: PERSON_ONLY_DENY_CHOICE });
  const logged = [];
  const canUseTool = createCanUseTool({ askUserBridge: bridge, dbg: (...args) => logged.push(args.join(' ')) });
  const input = { command: PERSON_ONLY_RM_COMMAND };
  // An ask a user's rule forced, without the person-only flags.
  const ruleOnly = { ...ASK_SHAPES.ordinary, matchedAskRule: SAMPLE_ASK_RULE };
  for (const opts of [ASK_SHAPES.ordinary, ASK_SHAPES.sensitiveRcFile, ASK_SHAPES.claudeSettingsFile, ruleOnly, {}]) {
    const result = await canUseTool('Bash', input, opts);
    assert.deepEqual(result, { behavior: 'allow', updatedInput: input });
  }
  assert.equal(bridge.calls.length, 0);

  await canUseTool('Bash', input, ASK_SHAPES.rmWorkspace);
  await canUseTool('Bash', { command: `${PERSON_ONLY_RM_COMMAND} ${'x'.repeat(PERSON_ONLY_COMMAND_MAX)}` }, ASK_SHAPES.rmWorkspace);
  assert.equal(bridge.calls.length, 1);
  assert.ok(logged.length >= 2);
  for (const line of logged) {
    assert.equal(line.includes('rm -rf'), false);
    assert.equal(line.includes('/srv/sample-app'), false);
  }
});

test('reasoning effort maps onto the SDK effort option per turn', () => {
  let captured = null;
  const queryImpl = (params) => { captured = params; return {}; };
  startClaudeSession({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/workspace',
    reasoningEffort: 'xhigh',
    queryImpl,
  });
  assert.equal(captured.options.effort, 'xhigh');
});

test('none/invalid reasoning effort omits the effort option (SDK default)', () => {
  for (const value of ['none', '', 'auto', 'bogus']) {
    let captured = null;
    startClaudeSession({
      content: [{ type: 'text', text: 'hi' }],
      cwd: '/workspace',
      reasoningEffort: value,
      queryImpl: (params) => { captured = params; return {}; },
    });
    assert.equal('effort' in captured.options, false, `effort should be omitted for "${value}"`);
  }
});

test('normalizeClaudeEffort accepts the SDK effort ladder plus the ultracode sentinel', () => {
  for (const value of ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']) {
    assert.equal(normalizeClaudeEffort(value), value);
    assert.equal(normalizeClaudeEffort(value.toUpperCase()), value);
  }
  assert.equal(normalizeClaudeEffort('none'), '');
  assert.equal(normalizeClaudeEffort('extreme'), '');
});

test('ultracode spawns as xhigh effort plus the session-scoped settings flags', () => {
  let captured = null;
  startClaudeSession({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/workspace',
    reasoningEffort: CLAUDE_ULTRACODE_EFFORT,
    queryImpl: (params) => { captured = params; return {}; },
  });
  // 'ultracode' is not an EffortLevel — the CLI schema would silently drop it.
  assert.equal(captured.options.effort, 'xhigh');
  assert.deepEqual(captured.options.settings, { ultracode: true, enableWorkflows: true });
});

test('non-ultracode spawns pass no settings layer', () => {
  for (const value of ['xhigh', 'max', 'none', '']) {
    let captured = null;
    startClaudeSession({
      content: [{ type: 'text', text: 'hi' }],
      cwd: '/workspace',
      reasoningEffort: value,
      queryImpl: (params) => { captured = params; return {}; },
    });
    assert.equal('settings' in captured.options, false, `settings should be omitted for "${value}"`);
  }
});

test('ultracode and an auto-compact window share one settings object', () => {
  let captured = null;
  startClaudeSession({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/workspace',
    reasoningEffort: CLAUDE_ULTRACODE_EFFORT,
    autoCompactWindow: 150000,
    queryImpl: (params) => { captured = params; return {}; },
  });
  // Both live in Settings; two spreads of `settings` would clobber each other.
  assert.deepEqual(captured.options.settings, {
    ultracode: true,
    enableWorkflows: true,
    autoCompactWindow: 150000,
  });
});

test('an auto-compact window alone still reaches the spawn settings', () => {
  let captured = null;
  startClaudeSession({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/workspace',
    reasoningEffort: 'high',
    autoCompactWindow: 500000,
    queryImpl: (params) => { captured = params; return {}; },
  });
  assert.deepEqual(captured.options.settings, { autoCompactWindow: 500000 });
  assert.equal(captured.options.effort, 'high');
});

test('claudeSpawnSettings omits itself when nothing is set', () => {
  assert.equal(claudeSpawnSettings(), null);
  assert.equal(claudeSpawnSettings({ ultracode: false, autoCompactWindow: null }), null);
  // Junk is Auto, never a pinned window.
  assert.equal(claudeSpawnSettings({ autoCompactWindow: 'nonsense' }), null);
  assert.equal(claudeSpawnSettings({ autoCompactWindow: 0 }), null);
});

test('claudeUltracodeFlagSettings translates the sentinel both ways', () => {
  assert.deepEqual(
    claudeUltracodeFlagSettings(CLAUDE_ULTRACODE_EFFORT),
    { ultracode: true, enableWorkflows: true, effortLevel: 'xhigh' },
  );
  assert.deepEqual(
    claudeUltracodeFlagSettings('medium'),
    { ultracode: null, enableWorkflows: null, effortLevel: 'medium' },
  );
  // Effort 'none' (normalized to '') resets the flag layer entirely.
  assert.deepEqual(
    claudeUltracodeFlagSettings(''),
    { ultracode: null, enableWorkflows: null, effortLevel: null },
  );
});

test('canUseTool tells the model to restate the plan when no board was surfaced', async () => {
  const canUseTool = createCanUseTool({
    onExitPlanMode: async () => false,
  });
  const result = await canUseTool('ExitPlanMode', { plan: '' }, {});
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /Restate the complete plan/);
});

test('spawn settings encode thinking explicitly; only an absent value omits the key', () => {
  assert.deepEqual(
    claudeSpawnSettings({ thinkingEnabled: true }),
    { alwaysThinkingEnabled: true },
  );
  assert.deepEqual(
    claudeSpawnSettings({ thinkingEnabled: false }),
    { alwaysThinkingEnabled: false },
  );
  // The adapter applies NO relay default: null/absent means "say nothing", so
  // the key is omitted. The relay resolves its own default (on) before this.
  assert.equal(claudeSpawnSettings({ thinkingEnabled: null }), null);
  assert.equal(claudeSpawnSettings({ thinkingEnabled: 'junk' }), null);
  assert.equal(claudeSpawnSettings({ thinkingEnabled: undefined }), null);
  // ...and it merges with the other settings-layer values, one object.
  assert.deepEqual(
    claudeSpawnSettings({ ultracode: true, autoCompactWindow: 200000, thinkingEnabled: false }),
    { ultracode: true, enableWorkflows: true, autoCompactWindow: 200000, alwaysThinkingEnabled: false },
  );
});

test('claudeThinkingFlagSettings carries the explicit value, applying no default', () => {
  assert.deepEqual(claudeThinkingFlagSettings(true), { alwaysThinkingEnabled: true });
  assert.deepEqual(claudeThinkingFlagSettings(false), { alwaysThinkingEnabled: false });
  assert.deepEqual(claudeThinkingFlagSettings(null), { alwaysThinkingEnabled: null });
  assert.deepEqual(claudeThinkingFlagSettings('junk'), { alwaysThinkingEnabled: null });
});

test('startClaudeSession requests the delivered display mode after spawn', async () => {
  const displayCalls = [];
  const queryImpl = () => ({
    async* [Symbol.asyncIterator]() {},
    async setMaxThinkingTokens(budget, display) { displayCalls.push([budget, display]); },
  });
  startClaudeSession({ cwd: '/tmp', thinkingDisplay: 'omitted', queryImpl });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(displayCalls, [[null, 'omitted']]);
});

test('startClaudeSession defaults the display to summarized (previous behavior)', async () => {
  const displayCalls = [];
  const queryImpl = () => ({
    async* [Symbol.asyncIterator]() {},
    async setMaxThinkingTokens(budget, display) { displayCalls.push([budget, display]); },
  });
  startClaudeSession({ cwd: '/tmp', queryImpl });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(displayCalls, [[null, 'summarized']]);
});

test('applyThinkingDisplay resolves a legacy/unknown mode to the default, never to hidden', async () => {
  // 'host' was a third state before the relay took a position on thinking.
  // A row still carrying it (or any junk) must land on 'summarized' — the one
  // outcome that keeps thoughts visible — rather than being forwarded raw.
  const displayCalls = [];
  const turn = {
    async setMaxThinkingTokens(budget, display) { displayCalls.push([budget, display]); },
  };
  await applyThinkingDisplay(turn, 'host');
  await applyThinkingDisplay(turn, 'nonsense');
  assert.deepEqual(displayCalls, [[null, 'summarized'], [null, 'summarized']]);
});

test('applyThinkingDisplay re-sends the tracked budget rather than nulling it', async () => {
  // The first argument is positional: a hardcoded null while a budget pin
  // existed would silently clear the pin on every display change.
  const displayCalls = [];
  const turn = {
    async setMaxThinkingTokens(budget, display) { displayCalls.push([budget, display]); },
  };
  await applyThinkingDisplay(turn, 'summarized', { budget: 12000 });
  assert.deepEqual(displayCalls, [[12000, 'summarized']]);
});

test('applyThinkingDisplay tolerates old CLIs and failures', async () => {
  await applyThinkingDisplay({}, 'summarized'); // no method: silent no-op
  const failures = [];
  await applyThinkingDisplay(
    { async setMaxThinkingTokens() { throw new Error('nope'); } },
    'summarized',
    { dbg: (...args) => failures.push(args.join(' ')) },
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /nope/);
});

test('claudeSpawnEnv sets the three Bash timeouts on top of the base environment', () => {
  const env = claudeSpawnEnv({
    backgroundCommandLimitMs: 2 * 3_600_000,
    baseEnv: { PATH: '/usr/bin', HOME: '/home/example', BASH_DEFAULT_TIMEOUT_MS: '5000' },
  });
  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/example',
    BASH_DEFAULT_TIMEOUT_MS: '7200000',
    BASH_MAX_TIMEOUT_MS: '28800000',
    CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS: '120000',
  });
  assert.equal(CLAUDE_BASH_MAX_TIMEOUT_MS, 28_800_000);
  assert.equal(CLAUDE_AUTO_BACKGROUND_TIMEOUT_MS, 120_000);
});

test('claudeSpawnEnv leaves the environment alone without a usable limit', () => {
  for (const backgroundCommandLimitMs of [null, undefined, 0, -5, Number.NaN, 'abc']) {
    assert.equal(claudeSpawnEnv({ backgroundCommandLimitMs, baseEnv: { PATH: '/usr/bin' } }), null);
  }
});

test('startClaudeSession hands query() the merged environment and names the limit in the prompt', () => {
  let captured = null;
  startClaudeSession({
    content: null,
    cwd: '/workspace',
    backgroundCommandLimitMs: 4 * 3_600_000,
    queryImpl: (params) => { captured = params; return {}; },
  });
  const { env } = captured.options;
  assert.equal(env.BASH_DEFAULT_TIMEOUT_MS, '14400000');
  assert.equal(env.BASH_MAX_TIMEOUT_MS, '28800000');
  assert.equal(env.CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS, '120000');
  // env replaces the subprocess environment, so the worker's own must be kept.
  for (const key of Object.keys(process.env)) assert.equal(env[key] === undefined, false, key);
  assert.match(captured.options.systemPrompt.append, /Background Bash commands are stopped after 4 h unless you pass a longer timeout \(up to 8 h\)/);
});

test('startClaudeSession without a limit passes no env', () => {
  let captured = null;
  startClaudeSession({
    content: null,
    cwd: '/workspace',
    queryImpl: (params) => { captured = params; return {}; },
  });
  assert.equal('env' in captured.options, false);
  assert.doesNotMatch(captured.options.systemPrompt.append, /stopped after/);
  assert.match(captured.options.systemPrompt.append, /For long background Bash commands, write the full output to a log file/);
});

test('the long command note asks for a log file and nohup, with the limit when known', () => {
  const withLimit = longCommandInstructionText(150 * 60_000);
  assert.match(withLimit, /^Background Bash commands are stopped after 2 h 30 min unless you pass a longer timeout/);
  assert.match(withLimit, /write the full output to a log file instead of piping it into tail or head/);
  assert.match(withLimit, /Start runs that must survive a session restart detached with nohup and a log file\.$/);
  assert.match(longCommandInstructionText(null), /^For long background Bash commands, write the full output/);
  for (const mode of ['plan', 'agent', 'ask', 'autopilot']) {
    const { append } = systemPromptForRelayMode(mode, { backgroundCommandLimitMs: 2 * 3_600_000 });
    assert.match(append, /stopped after 2 h/);
    assert.match(append, /nohup/);
  }
});

// A query stand-in whose applyFlagSettings the test settles by hand.
function liveFlagQuery() {
  const fake = { captured: null, applied: [], settle: null };
  fake.queryImpl = (params) => {
    fake.captured = params;
    return {
      applyFlagSettings: (settings) => new Promise((resolve, reject) => {
        fake.applied.push(settings);
        fake.settle = { resolve, reject };
      }),
    };
  };
  return fake;
}

async function liveFlagBackend(live) {
  const { createDeepSeekClaudeBackend } = await import('../deepseek-worker/deepseek-claude-backend.mjs');
  return {
    ...createDeepSeekClaudeBackend({
      env: { DEEPSEEK_API_KEY: 'sk-test-0000', DEEPSEEK_CLAUDE_CONFIG_DIR: '/srv/oar/data/deepseek-claude' },
    }),
    liveFlagSettings: () => live,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a backend\'s live flag settings reach the CLI over the control channel before any message', async () => {
  const live = { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'sk-test-0000' }, apiKeyHelper: '' };
  const fake = liveFlagQuery();
  const turn = startClaudeSession({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/tmp',
    model: 'deepseek-flash',
    backend: await liveFlagBackend(live),
    queryImpl: fake.queryImpl,
  });
  // They are not on the command line.
  assert.equal(JSON.stringify(fake.captured.options.settings || {}).includes('sk-test-0000'), false);
  const messages = [];
  const drained = (async () => {
    for await (const message of fake.captured.prompt) messages.push(message);
  })();
  turn.pushUserMessage([{ type: 'text', text: 'second' }]);
  await tick();
  assert.deepEqual(fake.applied, [live]);
  // Held until the CLI has taken them, in order.
  assert.equal(messages.length, 0);
  fake.settle.resolve();
  assert.equal(await turn.liveFlagSettingsApplied, true);
  await tick();
  assert.deepEqual(messages.map((message) => message.message.content[0].text), ['hi', 'second']);
  turn.endInput();
  await drained;
  assert.equal(turn.liveFlagSettingsError, undefined);
});

test('the blanks of a backend\'s live flag settings go on the command line too, the values do not', async () => {
  const live = {
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'sk-test-0000', ANTHROPIC_API_KEY: '' },
    apiKeyHelper: '',
  };
  const fake = liveFlagQuery();
  startClaudeSession({
    content: null,
    cwd: '/tmp',
    model: 'deepseek-flash',
    thinkingEnabled: true,
    backend: await liveFlagBackend(live),
    queryImpl: fake.queryImpl,
  });
  const { settings } = fake.captured.options;
  assert.equal(settings.alwaysThinkingEnabled, true);
  assert.equal(settings.apiKeyHelper, '');
  assert.deepEqual(settings.env, { ANTHROPIC_API_KEY: '' });
  assert.equal(JSON.stringify(settings).includes('sk-test-0000'), false);
  assert.equal(JSON.stringify(settings).includes('127.0.0.1'), false);

  // Live settings without a blank leave the spawn's settings alone: here only
  // the backend's own.
  const plain = liveFlagQuery();
  startClaudeSession({
    content: null,
    cwd: '/tmp',
    model: 'deepseek-flash',
    backend: await liveFlagBackend({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-test-0000' } }),
    queryImpl: plain.queryImpl,
  });
  assert.deepEqual(plain.captured.options.settings, { disableAllHooks: true });
});

test('the DeepSeek pins are built from the CLI\'s environment, and only their blanks reach the command line', async () => {
  const { createDeepSeekClaudeBackend } = await import('../deepseek-worker/deepseek-claude-backend.mjs');
  const { CLAUDE_CLI_PINNED_ENV } = await import('./claude-cli-pinned-env.mjs');
  const backend = createDeepSeekClaudeBackend({
    env: {
      DEEPSEEK_API_KEY: 'sk-test-0000',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:9',
      DEEPSEEK_CLAUDE_CONFIG_DIR: '/srv/oar/data/deepseek-claude',
    },
  });
  const fake = liveFlagQuery();
  // The CLI's environment is built from the worker's process environment.
  const saved = process.env.https_proxy;
  process.env.https_proxy = 'http://127.0.0.1:3128';
  try {
    startClaudeSession({ content: null, cwd: '/tmp', model: 'deepseek-flash', backend, queryImpl: fake.queryImpl });
  } finally {
    if (saved === undefined) delete process.env.https_proxy;
    else process.env.https_proxy = saved;
  }
  const { env, settings } = fake.captured.options;
  // The pins hold the values the CLI starts with: its proxy, in both cases.
  assert.equal(env.https_proxy, 'http://127.0.0.1:3128');
  const live = backend.liveFlagSettings(env);
  assert.equal(live.env.https_proxy, 'http://127.0.0.1:3128');
  assert.equal(live.env.HTTPS_PROXY, process.env.HTTPS_PROXY ?? 'http://127.0.0.1:3128');
  assert.equal(live.env.ANTHROPIC_AUTH_TOKEN, 'sk-test-0000');
  // On the command line: no hooks, every blank pin and nothing with a value.
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.apiKeyHelper, '');
  assert.deepEqual(
    Object.keys(settings.env).sort(),
    Object.entries(live.env).filter(([, value]) => value === '').map(([name]) => name).sort(),
  );
  assert.ok(Object.keys(settings.env).length > 50);
  assert.ok(Object.keys(settings.env).every((name) => CLAUDE_CLI_PINNED_ENV.includes(name)));
  assert.ok(Object.values(settings.env).every((value) => value === ''));
  for (const value of ['sk-test-0000', '127.0.0.1']) assert.equal(JSON.stringify(settings).includes(value), false, value);
});

test('refused live flag settings send nothing and fail with a coded error that names no value', async () => {
  const live = { env: { ANTHROPIC_AUTH_TOKEN: 'sk-test-0000' }, apiKeyHelper: '' };
  const fake = liveFlagQuery();
  const turn = startClaudeSession({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/tmp',
    model: 'deepseek-flash',
    backend: await liveFlagBackend(live),
    queryImpl: fake.queryImpl,
  });
  const messages = [];
  const drained = (async () => {
    for await (const message of fake.captured.prompt) messages.push(message);
  })();
  await tick();
  fake.settle.reject(new Error('Invalid settings: env.ANTHROPIC_AUTH_TOKEN sk-test-0000 rejected'));
  assert.equal(await turn.liveFlagSettingsApplied, false);
  // The stream throws (the SDK aborts the query on that) and sent nothing.
  await assert.rejects(drained, (error) => error === turn.liveFlagSettingsError);
  assert.equal(messages.length, 0);
  const error = turn.liveFlagSettingsError;
  assert.equal(error.code, CLAUDE_LIVE_FLAG_SETTINGS_CODE);
  assert.match(error.message, /did not take the DeepSeek connection settings before the first message, so nothing was sent/);
  assert.equal(error.detail, 'Invalid settings: env.ANTHROPIC_AUTH_TOKEN [redacted] rejected');
  assert.equal(`${error.message} ${error.detail}`.includes('sk-test-0000'), false);
});

test('live flag settings the CLI never answers fail closed after the timeout and send nothing', async () => {
  const live = { env: { ANTHROPIC_AUTH_TOKEN: 'sk-test-0000' }, apiKeyHelper: '' };
  const fake = liveFlagQuery();
  const turn = startClaudeSession({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/tmp',
    model: 'deepseek-flash',
    backend: await liveFlagBackend(live),
    liveFlagSettingsTimeoutMs: 20,
    queryImpl: fake.queryImpl,
  });
  const messages = [];
  const drained = (async () => {
    for await (const message of fake.captured.prompt) messages.push(message);
  })();
  turn.pushUserMessage([{ type: 'text', text: 'second' }]);
  // applyFlagSettings was called and is never settled.
  assert.equal(await turn.liveFlagSettingsApplied, false);
  assert.deepEqual(fake.applied, [live]);
  await assert.rejects(drained, (error) => error === turn.liveFlagSettingsError);
  assert.equal(messages.length, 0);
  const error = turn.liveFlagSettingsError;
  assert.equal(error.code, CLAUDE_LIVE_FLAG_SETTINGS_CODE);
  assert.match(error.message, /so nothing was sent/);
  assert.equal(error.detail, 'no answer within 1 s');
  // A late answer changes nothing.
  fake.settle.resolve();
  await tick();
  assert.equal(messages.length, 0);
  assert.equal(LIVE_FLAG_SETTINGS_TIMEOUT_MS, 60_000);
});

test('the live flag settings timer is cleared on the answer and on abort', async (t) => {
  const started = [];
  const cleared = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    const timer = realSetTimeout(fn, ms, ...args);
    if (ms === LIVE_FLAG_SETTINGS_TIMEOUT_MS) started.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    if (started.includes(timer)) cleared.push(timer);
    return realClearTimeout(timer);
  });
  const live = { env: { ANTHROPIC_AUTH_TOKEN: 'sk-test-0000' }, apiKeyHelper: '' };

  const answered = liveFlagQuery();
  const turn = startClaudeSession({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/tmp',
    model: 'deepseek-flash',
    backend: await liveFlagBackend(live),
    queryImpl: answered.queryImpl,
  });
  assert.equal(started.length, 1);
  await tick();
  answered.settle.resolve();
  assert.equal(await turn.liveFlagSettingsApplied, true);
  assert.deepEqual(cleared, [started[0]]);
  turn.endInput();

  const abortController = new AbortController();
  const aborted = liveFlagQuery();
  startClaudeSession({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/tmp',
    model: 'deepseek-flash',
    abortController,
    backend: await liveFlagBackend(live),
    queryImpl: aborted.queryImpl,
  }).endInput();
  assert.equal(started.length, 2);
  abortController.abort();
  assert.deepEqual(cleared, [started[0], started[1]]);
});

test('without applyFlagSettings live flag settings fail closed; a stream ended while held sends nothing', async () => {
  const live = { env: { ANTHROPIC_AUTH_TOKEN: 'sk-test-0000' } };
  let captured = null;
  const turn = startClaudeSession({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/tmp',
    model: 'deepseek-flash',
    backend: await liveFlagBackend(live),
    queryImpl: (params) => { captured = params; return {}; },
  });
  assert.equal(await turn.liveFlagSettingsApplied, false);
  assert.equal(turn.liveFlagSettingsError.code, CLAUDE_LIVE_FLAG_SETTINGS_CODE);
  await assert.rejects((async () => { for await (const message of captured.prompt) assert.fail(message); })());

  const fake = liveFlagQuery();
  const held = startClaudeSession({
    content: [{ type: 'text', text: 'hi' }],
    cwd: '/tmp',
    model: 'deepseek-flash',
    backend: await liveFlagBackend(live),
    queryImpl: fake.queryImpl,
  });
  const messages = [];
  const drained = (async () => {
    for await (const message of fake.captured.prompt) messages.push(message);
  })();
  held.endInput();
  await drained;
  assert.equal(messages.length, 0);
});

test('a backend without live flag settings sends at once and never calls applyFlagSettings', async () => {
  for (const live of [null, {}]) {
    const fake = liveFlagQuery();
    const turn = startClaudeSession({
      content: [{ type: 'text', text: 'hi' }],
      cwd: '/tmp',
      model: 'deepseek-flash',
      backend: await liveFlagBackend(live),
      queryImpl: fake.queryImpl,
    });
    const messages = [];
    const drained = (async () => {
      for await (const message of fake.captured.prompt) messages.push(message);
    })();
    turn.endInput();
    await drained;
    assert.equal(messages.length, 1);
    assert.deepEqual(fake.applied, []);
    assert.equal('liveFlagSettingsApplied' in turn, false);
  }
});

test('a backend builds the CLI environment and maps the model and effort into its terms', async () => {
  const { createDeepSeekClaudeBackend } = await import('../deepseek-worker/deepseek-claude-backend.mjs');
  const backend = createDeepSeekClaudeBackend({
    env: { DEEPSEEK_API_KEY: 'sk-test-6666666666666666', DEEPSEEK_CLAUDE_CONFIG_DIR: '/srv/oar/data/deepseek-claude' },
  });
  let captured = null;
  startClaudeSession({
    content: null,
    cwd: '/tmp',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
    backend,
    queryImpl: (params) => { captured = params; return {}; },
  });
  assert.equal(captured.options.model, 'deepseek-v4-pro[1m]');
  assert.equal(captured.options.effort, 'max');
  assert.equal(captured.options.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(captured.options.env.ANTHROPIC_AUTH_TOKEN, 'sk-test-6666666666666666');
  assert.equal(captured.options.env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
  // The session's model reaches the backend: its alias pins follow it.
  assert.equal(captured.options.env.ANTHROPIC_MODEL, 'deepseek-v4-pro[1m]');
  assert.equal(captured.options.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-pro[1m]');
  assert.equal(captured.options.env.CLAUDE_CODE_SUBAGENT_MODEL, 'deepseek-v4-pro[1m]');
  assert.equal(captured.options.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-flash');
  // No relay limit set: the environment is still the backend's own, never
  // the worker's as it is (which carries the DeepSeek key under its own name).
  assert.equal('DEEPSEEK_API_KEY' in captured.options.env, false);

  // With a relay limit the Bash limits go on top of the backend's
  // environment: the relay's own auto-background cap reaches the CLI, while
  // the backend still drops a host session's variables and the worker's.
  const hostKeys = { CLAUDECODE: '1', CLAUDE_AGENT_SDK_VERSION: '0.0.0', COPILOT_WEB_RELAY_WORKER_KIND: 'deepseek' };
  const saved = Object.fromEntries(Object.keys(hostKeys).map((key) => [key, process.env[key]]));
  Object.assign(process.env, hostKeys);
  try {
    startClaudeSession({
      content: null,
      cwd: '/tmp',
      model: 'deepseek-flash',
      backgroundCommandLimitMs: 3_600_000,
      backend,
      queryImpl: (params) => { captured = params; return {}; },
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(captured.options.env.CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS, '120000');
  assert.equal(captured.options.env.BASH_DEFAULT_TIMEOUT_MS, '3600000');
  assert.equal(captured.options.env.ANTHROPIC_AUTH_TOKEN, 'sk-test-6666666666666666');
  for (const key of Object.keys(hostKeys)) assert.equal(key in captured.options.env, false, key);

  // DeepSeek's thinking cannot be switched off through Claude Code: none is low.
  startClaudeSession({
    content: null,
    cwd: '/tmp',
    model: 'deepseek-flash',
    reasoningEffort: 'none',
    backend,
    queryImpl: (params) => { captured = params; return {}; },
  });
  assert.equal(captured.options.effort, 'low');
  assert.equal('thinking' in captured.options, false);
  assert.equal(captured.options.env.CLAUDE_CODE_EFFORT_LEVEL, 'low');

  // Ultracode is Claude's: a backend never turns it into flags.
  startClaudeSession({
    content: null,
    cwd: '/tmp',
    model: 'deepseek-flash',
    reasoningEffort: CLAUDE_ULTRACODE_EFFORT,
    backend,
    queryImpl: (params) => { captured = params; return {}; },
  });
  assert.equal(captured.options.settings?.ultracode, undefined);
  assert.equal(captured.options.effort, 'max');
});

test('mergeSpawnSettings adds a backend\'s settings on top and merges env by name', () => {
  assert.equal(mergeSpawnSettings(null, null), null);
  assert.equal(mergeSpawnSettings(null, {}), null);
  const own = { autoCompactWindow: 400_000, alwaysThinkingEnabled: true };
  assert.equal(mergeSpawnSettings(own, null), own);
  assert.equal(mergeSpawnSettings(own, {}), own);
  assert.deepEqual(mergeSpawnSettings(null, { apiKeyHelper: '' }), { apiKeyHelper: '' });
  assert.deepEqual(
    mergeSpawnSettings({ ...own, env: { KEEP: '1', CLASH: 'relay' } }, { env: { CLASH: 'backend' }, apiKeyHelper: '' }),
    { ...own, env: { KEEP: '1', CLASH: 'backend' }, apiKeyHelper: '' },
  );
});

test('the Claude API backend changes the environment and adds its settings pins, nothing else', async () => {
  const { createClaudeApiClaudeBackend } = await import('../claude-api-worker/claude-api-backend.mjs');
  const backend = createClaudeApiClaudeBackend({ env: { OAR_CLAUDE_API_KEY: 'sk-ant-api03-test-0000' } });
  const spawn = (extra) => {
    let captured = null;
    startClaudeSession({
      content: null,
      cwd: '/tmp',
      model: 'claude-opus-5-5[1m]',
      reasoningEffort: CLAUDE_ULTRACODE_EFFORT,
      autoCompactWindow: 400_000,
      thinkingEnabled: true,
      relayMode: 'plan',
      queryImpl: (params) => { captured = params; return {}; },
      ...extra,
    });
    return captured.options;
  };
  const plain = spawn({});
  const api = spawn({ backend });
  // The model, the effort (ultracode included), the mode and the relay's
  // settings are Claude's, exactly as without a backend.
  assert.equal(api.model, 'claude-opus-5-5[1m]');
  assert.equal(api.model, plain.model);
  assert.equal(api.effort, plain.effort);
  assert.equal(api.effort, 'xhigh');
  assert.equal(api.permissionMode, 'plan');
  const { env: pins, apiKeyHelper, disableAllHooks, ...relaySettings } = api.settings;
  assert.deepEqual(relaySettings, plain.settings);
  assert.equal(relaySettings.ultracode, true);
  // No hooks run in an API-key chat; a subscription chat keeps them.
  assert.equal(disableAllHooks, true);
  assert.equal('disableAllHooks' in plain.settings, false);
  // The pins: the endpoint, a blank bearer token, a blank key helper and the
  // blanks of the routing and trust pins. The key is not among them (the
  // settings layer is a CLI argument), nor any pin with a value.
  const live = backend.liveFlagSettings(api.env);
  assert.deepEqual(pins, {
    ...Object.fromEntries(Object.entries(live.env).filter(([, value]) => value === '')),
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
  });
  assert.ok(Object.keys(pins).length > 50);
  assert.equal(pins.ANTHROPIC_AUTH_TOKEN, '');
  assert.equal(pins.CLAUDE_CODE_USE_BEDROCK, '');
  assert.equal(apiKeyHelper, '');
  assert.equal(JSON.stringify(api.settings).includes('sk-ant-api03-test-0000'), false);
  // The key is in the environment, under the CLI's name only.
  assert.equal(api.env.ANTHROPIC_API_KEY, 'sk-ant-api03-test-0000');
  assert.equal(api.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal('OAR_CLAUDE_API_KEY' in api.env, false);
  // Without a backend nothing of it is there: no env option, no pins.
  assert.equal('env' in plain, false);
  assert.equal('env' in plain.settings, false);
  assert.equal('apiKeyHelper' in plain.settings, false);
  // Nothing else of the options differs.
  const rest = (options) => {
    const { env, settings, ...others } = options;
    return JSON.stringify(others, (key, value) => (typeof value === 'function' ? 'fn' : value));
  };
  assert.equal(rest(api), rest(plain));

  // The key goes into the same layer over the control channel, before the
  // first message, so a settings file's ANTHROPIC_API_KEY cannot replace it.
  const fake = liveFlagQuery();
  const turn = startClaudeSession({ content: 'hi', cwd: '/tmp', model: 'claude-opus-5-5', backend, queryImpl: fake.queryImpl });
  await tick();
  assert.deepEqual(fake.applied, [backend.liveFlagSettings(fake.captured.options.env)]);
  assert.equal(fake.applied[0].env.ANTHROPIC_API_KEY, 'sk-ant-api03-test-0000');
  assert.equal(fake.applied[0].env.ANTHROPIC_AUTH_TOKEN, '');
  assert.equal(fake.applied[0].apiKeyHelper, '');
  assert.equal(JSON.stringify(fake.captured.options.settings).includes('sk-ant-api03-test-0000'), false);
  fake.settle.resolve();
  assert.equal(await turn.liveFlagSettingsApplied, true);
  turn.endInput();
});
