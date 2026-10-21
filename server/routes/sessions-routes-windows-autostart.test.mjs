import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';

function createMockApp() {
  const routes = new Map();
  return {
    routes,
    get(routePath, ...handlers) {
      routes.set(`GET ${routePath}`, handlers);
    },
    post(routePath, ...handlers) {
      routes.set(`POST ${routePath}`, handlers);
    },
    patch(routePath, ...handlers) {
      routes.set(`PATCH ${routePath}`, handlers);
    },
    delete(routePath, ...handlers) {
      routes.set(`DELETE ${routePath}`, handlers);
    },
  };
}

function createMockDb() {
  const statement = {
    run() {},
    get() {
      return null;
    },
    all() {
      return [];
    },
  };
  return {
    prepare() {
      return statement;
    },
    transaction(fn) {
      return (...args) => fn(...args);
    },
  };
}

function registerAutostartRoutes(windowsAutostartService, windowsBootAutostartService) {
  const app = createMockApp();
  const auth = (_req, _res, next) => next();
  registerSessionsRoutes(app, {
    auth,
    io: { emit() {} },
    db: createMockDb(),
    stmts: {},
    runtimeState: {},
    config: {},
    parseAttachments: () => [],
    hydrateAttachment: (value) => value,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    buildContextResponseText: () => '',
    readContextFromSessionEvents: () => [],
    inFlightStateForConversation: () => null,
    createCompactedConversation: () => null,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
    queueCounts: () => ({ pending: 0, processing: 0 }),
    getModelCatalogState: () => ({}),
    updateModelCatalog: () => ({}),
    listModelVariantRows: () => [],
    refreshModelVariantCatalogFromCli: async () => ({}),
    setEnabledModelVariants: () => ({}),
    SUPPORTED_REASONING_EFFORTS: [],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => ({}),
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    resolveConversationWorkspaceState: () => ({}),
    updateConversationConfiguredWorkspaceRoot: () => ({ changed: false }),
    learnConversationWorkspaceRoot: () => ({ learned: false }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    processingTimeoutMs: 0,
    localhostOnly: true,
    listenHost: '127.0.0.1',
    ensureSessionId: () => true,
    touchCli() {},
    markCliOffline() {},
    fetchUsageSummary() {},
    readSessionTranscriptMessages: () => [],
    ensureRuntimeSessionBinding: () => ({ ok: true }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'isolated',
    SUPPORTED_RELAY_MODES: ['agent'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['isolated'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'isolated',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: '',
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: {},
    sessionWorkerSupervisor: null,
    sessionWorkerRegistry: null,
    resolveSessionStateRoot: () => null,
    windowsAutostartService,
    windowsBootAutostartService,
  });
  return { app, auth };
}

/** A boot service double whose task state the test scripts directly. */
const OWN_TASK = { path: 'scheduled task \\oar-relay', task: 'oar-relay', otherInstall: null };
const LEGACY_TASK = { path: 'scheduled task \\copilot-remote-relay', task: 'copilot-remote-relay', otherInstall: null };
const LAUNCHER = 'C:\\Users\\dev\\AppData\\Roaming\\oar\\oar-web-relay-launcher.cmd';

function createBootServiceDouble({
  taskStatus = 'missing',
  legacyTaskPresent = false,
  // What the service lists as not made by OAR (see handMadeEntries).
  handMade = [...(taskStatus === 'foreign' ? [OWN_TASK] : []), ...(legacyTaskPresent ? [LEGACY_TASK] : [])],
  customised = false,
} = {}) {
  const calls = [];
  const state = {
    supported: true,
    platform: 'win32',
    taskStatus,
    taskName: 'oar-relay',
    legacyTaskPresent,
    handMade,
    customised,
    generated: taskStatus === 'ready' && !handMade.some((entry) => entry.task === 'oar-relay' || entry.path === LAUNCHER),
    launcherPath: null,
    pendingElevation: null,
    lastError: null,
    manualCommand: 'schtasks /create /tn "oar-relay" /xml "C:\\Users\\dev\\task.xml" /f',
  };
  const double = {
    calls,
    state,
    getState: async () => ({ ...state }),
    requestEnable: async () => {
      calls.push('enable');
      state.pendingElevation = 'enable';
      return { ...state, accepted: true };
    },
    // The administrator answers with `answer` (true: confirmed).
    answer: true,
    requestDisable: async ({ onSettled } = {}) => {
      calls.push('disable');
      const ok = double.answer;
      if (ok) Object.assign(state, { taskStatus: 'missing', legacyTaskPresent: false });
      onSettled?.(ok, {});
      return { ...state, accepted: true };
    },
  };
  return double;
}

async function callRoute(handlers, req = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, response, () => {
      nextCalled = true;
    });
    if (!nextCalled) break;
  }
  return response;
}

function createSigninServiceDouble({ enabled = false, supported = true, entries = [] } = {}) {
  const platform = supported ? 'win32' : 'linux';
  const calls = [];
  let isEnabled = enabled;
  return {
    calls,
    listEntries: () => entries,
    getState: () => ({ supported, enabled: isEnabled, platform }),
    setEnabled: (next) => {
      calls.push(next);
      isEnabled = next;
      return { supported, enabled: isEnabled, platform, changed: true };
    },
  };
}

test('Windows autostart settings routes are authenticated and merge both services into a mode', async () => {
  const signin = createSigninServiceDouble();
  const boot = createBootServiceDouble();
  const { app, auth } = registerAutostartRoutes(signin, boot);
  const getHandlers = app.routes.get('GET /api/settings/windows-autostart');
  const postHandlers = app.routes.get('POST /api/settings/windows-autostart');
  assert.equal(getHandlers[0], auth);
  assert.equal(postHandlers[0], auth);

  const getResponse = await callRoute(getHandlers);
  assert.equal(getResponse.statusCode, 200);
  assert.equal(getResponse.body.mode, 'off');
  assert.equal(getResponse.body.enabled, false);
  assert.equal(getResponse.body.boot.taskStatus, 'missing');

  // Back-compat: the pre-mode boolean POST still lands on sign-in mode.
  const postResponse = await callRoute(postHandlers, { body: { enabled: true } });
  assert.equal(postResponse.statusCode, 200);
  assert.equal(postResponse.body.mode, 'signin');
  assert.equal(postResponse.body.enabled, true);
  assert.deepEqual(signin.calls, [true]);
  assert.deepEqual(boot.calls, [], 'no elevation for a sign-in toggle with no boot task');
});

test('a ready boot task defines the mode even with a leftover Startup entry present', async () => {
  const signin = createSigninServiceDouble({ enabled: true });
  const boot = createBootServiceDouble({ taskStatus: 'ready' });
  const { app } = registerAutostartRoutes(signin, boot);
  const response = await callRoute(app.routes.get('GET /api/settings/windows-autostart'));
  assert.equal(response.body.mode, 'boot');
  assert.equal(response.body.signinEnabled, true, 'the leftover .cmd is reported, not hidden');
});

test('selecting boot mode requests the elevated enable and reports pending', async () => {
  const signin = createSigninServiceDouble({ enabled: true });
  const boot = createBootServiceDouble();
  const { app } = registerAutostartRoutes(signin, boot);
  const response = await callRoute(app.routes.get('POST /api/settings/windows-autostart'), { body: { mode: 'boot' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(boot.calls, ['enable']);
  assert.equal(response.body.accepted, true);
  assert.equal(response.body.boot.pendingElevation, 'enable');
  assert.deepEqual(signin.calls, [], 'the .cmd survives until the UAC is actually confirmed');
});

test('a declined or failed disable leaves the earlier mode: the sign-in half applies only after a confirmed one', async () => {
  const signin = createSigninServiceDouble();
  const boot = createBootServiceDouble({ taskStatus: 'ready' });
  boot.answer = false;
  const { app } = registerAutostartRoutes(signin, boot);
  const response = await callRoute(app.routes.get('POST /api/settings/windows-autostart'), { body: { mode: 'signin' } });
  assert.deepEqual(boot.calls, ['disable']);
  assert.deepEqual(signin.calls, [], 'not armed beside the boot task');
  assert.equal(response.body.mode, 'boot');
});

test('leaving boot mode sweeps the task first, then applies the sign-in half', async () => {
  const signin = createSigninServiceDouble();
  const boot = createBootServiceDouble({ taskStatus: 'ready' });
  const { app } = registerAutostartRoutes(signin, boot);
  const response = await callRoute(app.routes.get('POST /api/settings/windows-autostart'), { body: { mode: 'signin' } });
  assert.deepEqual(boot.calls, ['disable']);
  assert.deepEqual(signin.calls, [true]);
  assert.equal(response.body.accepted, true);
});

const UNCHANGED = /^Nothing changed: OAR does not delete or overwrite an autostart entry it did not make\. .*oar autostart (signin|boot|off) --replace\. Left as it is: /;

// Posts `mode` and returns the response; asserts that nothing was changed.
async function refused(signin, boot, mode) {
  const { app } = registerAutostartRoutes(signin, boot);
  const response = await callRoute(app.routes.get('POST /api/settings/windows-autostart'), { body: { mode } });
  assert.equal(response.statusCode, 409);
  assert.match(response.body.error, UNCHANGED);
  assert.deepEqual(boot.calls, [], 'no elevation, no delete, no replace');
  assert.deepEqual(signin.calls, [], 'no second mode armed beside it');
  return response;
}

test('a foreign or pre-rebrand task stops sign-in and off, as in oar autostart (#57)', async () => {
  for (const mode of ['signin', 'off']) {
    for (const options of [{ taskStatus: 'missing', legacyTaskPresent: true }, { taskStatus: 'foreign' }]) {
      const response = await refused(createSigninServiceDouble({ enabled: true }), createBootServiceDouble(options), mode);
      assert.match(response.body.error, /Left as it is: scheduled task \\(oar-relay|copilot-remote-relay) \(hand-made\)\.$/);
    }
  }
});

test('leaving boot mode with a customised task or launcher changes nothing and says why (#57)', async () => {
  for (const mode of ['signin', 'off']) {
    for (const handMade of [[OWN_TASK], [{ path: LAUNCHER, task: null, otherInstall: null }]]) {
      await refused(createSigninServiceDouble(), createBootServiceDouble({ taskStatus: 'ready', handMade, customised: true }), mode);
    }
  }
});

test('picking boot never replaces a foreign task, the pre-rebrand one, a hand-made launcher or a hand-made Startup entry', async () => {
  await refused(createSigninServiceDouble(), createBootServiceDouble({ taskStatus: 'foreign' }), 'boot');
  await refused(createSigninServiceDouble(), createBootServiceDouble({ legacyTaskPresent: true }), 'boot');
  await refused(createSigninServiceDouble(), createBootServiceDouble({ handMade: [{ path: LAUNCHER, task: null, otherInstall: null }] }), 'boot');
  const stale = { path: 'C:\\Startup\\oar-web-relay.cmd', generated: false, otherInstall: 'C:\\old\\oar' };
  const response = await refused(createSigninServiceDouble({ enabled: true, entries: [stale] }), createBootServiceDouble(), 'boot');
  assert.match(response.body.error, /C:\\Startup\\oar-web-relay\.cmd \(hand-made: it starts the OAR install in C:\\old\\oar\)/);
});

test('picking boot again keeps a hand-made launcher, and regenerates only a generated one that is missing', async () => {
  const keep = createBootServiceDouble({ taskStatus: 'ready', handMade: [{ path: LAUNCHER, task: null, otherInstall: null }], customised: true });
  const signin = createSigninServiceDouble();
  const { app } = registerAutostartRoutes(signin, keep);
  const response = await callRoute(app.routes.get('POST /api/settings/windows-autostart'), { body: { mode: 'boot' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(keep.calls, []);
  assert.deepEqual(signin.calls, [false], 'generated sign-in leftovers only');
  assert.deepEqual(response.body.boot.handMade, [{ path: LAUNCHER, task: null, otherInstall: null }]);

  const missing = createBootServiceDouble({ taskStatus: 'ready', customised: true });
  const second = registerAutostartRoutes(createSigninServiceDouble(), missing);
  await callRoute(second.app.routes.get('POST /api/settings/windows-autostart'), { body: { mode: 'boot' } });
  assert.deepEqual(missing.calls, ['enable']);
});

test('Windows autostart update rejects malformed and unsupported requests', async () => {
  const unsupported = createSigninServiceDouble({ supported: false });
  const { app } = registerAutostartRoutes(unsupported, createBootServiceDouble());
  const handlers = app.routes.get('POST /api/settings/windows-autostart');

  const malformedResponse = await callRoute(handlers, { body: { enabled: 'true' } });
  assert.equal(malformedResponse.statusCode, 400);
  assert.match(malformedResponse.body.error, /mode must be/);

  const badModeResponse = await callRoute(handlers, { body: { mode: 'reboot' } });
  assert.equal(badModeResponse.statusCode, 400);

  const unsupportedResponse = await callRoute(handlers, { body: { enabled: true } });
  assert.equal(unsupportedResponse.statusCode, 400);
  assert.deepEqual(unsupportedResponse.body, {
    error: 'Windows autostart is only available on Windows',
  });
  assert.deepEqual(unsupported.calls, []);
});

test('the routes work without a boot service (boot reported as null)', async () => {
  const signin = createSigninServiceDouble({ enabled: true });
  const { app } = registerAutostartRoutes(signin, undefined);
  const getResponse = await callRoute(app.routes.get('GET /api/settings/windows-autostart'));
  assert.equal(getResponse.body.mode, 'signin');
  assert.equal(getResponse.body.boot, null);
  const postResponse = await callRoute(app.routes.get('POST /api/settings/windows-autostart'), { body: { mode: 'off' } });
  assert.equal(postResponse.statusCode, 200);
  assert.equal(postResponse.body.mode, 'off');
});

test('Windows autostart routes do not expose filesystem error details', async () => {
  const service = {
    getState() {
      throw new Error('EACCES: C:\\Users\\secret\\Startup');
    },
    setEnabled() {
      throw new Error('unused');
    },
  };
  const { app } = registerAutostartRoutes(service);
  const response = await callRoute(app.routes.get('GET /api/settings/windows-autostart'));
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error.includes('secret'), false);
  assert.match(response.body.error, /Startup folder/);
});

test('a customised boot task is passed on to the client as boot mode', async () => {
  const signin = createSigninServiceDouble();
  const boot = createBootServiceDouble({ taskStatus: 'ready' });
  Object.assign(boot.state, { customised: true, customisations: ['boot-delay', 'launcher'], launcherBackupPath: null, readError: null });
  const { app } = registerAutostartRoutes(signin, boot);
  const response = await callRoute(app.routes.get('GET /api/settings/windows-autostart'));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.mode, 'boot');
  assert.equal(response.body.boot.customised, true);
  assert.deepEqual(response.body.boot.customisations, ['boot-delay', 'launcher']);
});

test('a boot task that cannot be read does not fail the setting, and its details stay in the log', async () => {
  const signin = createSigninServiceDouble({ enabled: true });
  const boot = createBootServiceDouble();
  boot.getState = async () => { throw new Error('EACCES: C:\\Users\\secret\\oar'); };
  const { app } = registerAutostartRoutes(signin, boot);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  let response;
  try {
    response = await callRoute(app.routes.get('GET /api/settings/windows-autostart'));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.mode, 'signin');
  assert.equal(response.body.boot.taskStatus, 'unknown');
  assert.match(response.body.boot.readError, /could not be read/);
  assert.equal(JSON.stringify(response.body).includes('secret'), false);
  assert.ok(warnings.some((line) => line.includes('EACCES')), 'logged server-side');
});

test('a failed autostart read is logged server-side while the client gets the generic text', async () => {
  const service = {
    getState() { throw new Error('EACCES: C:\\Users\\secret\\Startup'); },
    setEnabled() { throw new Error('unused'); },
  };
  const { app } = registerAutostartRoutes(service);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    await callRoute(app.routes.get('GET /api/settings/windows-autostart'));
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(warnings.some((line) => line.startsWith('[autostart]') && line.includes('EACCES')));
});

test('the setting names a Startup entry OAR did not make', async () => {
  const stale = { path: 'C:\\Startup\\oar-web-relay.cmd', generated: false, otherInstall: 'C:\\old\\oar' };
  const signin = createSigninServiceDouble({ enabled: true, entries: [stale, { path: 'C:\\Startup\\copilot-remote-web-relay.cmd', generated: true }] });
  const { app } = registerAutostartRoutes(signin, createBootServiceDouble());
  const response = await callRoute(app.routes.get('GET /api/settings/windows-autostart'));
  assert.deepEqual(response.body.signinHandMade, [{ path: stale.path, otherInstall: stale.otherInstall }]);
});