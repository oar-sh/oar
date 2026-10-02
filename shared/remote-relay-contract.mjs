// The shared contract of the remote-relay feature: one OAR relay lets the
// agents of its sessions work on OTHER OAR relays it is paired with.
//
// Everything that more than one side has to agree on lives here — the tool
// name, description and schema every provider adapter registers, the action
// → permission map the relay enforces, the limits, the error codes, the
// provenance ("origin") shape a relay attaches when its agent prompts a remote
// session, the prompt header line, and the URL policy for remote addresses.
//
// Since agent sessions, the relay an agent runs on is a target as well (the
// "local target", addressed by this relay's name or `this`): the same tool
// creates and drives sessions on its own relay, behind a setting.
//
// SDK-free and side-effect free: imported by the server, the session workers,
// the stdio MCP server and (for the header/URL helpers) the browser.

import { isValidBranchName, normalizeGitHubRepoUrl } from './claude-cloud/repo-url.mjs';

export const REMOTE_RELAY_TOOL_NAME = 'remote_relay';

// Bumped when a relay starts relying on a newer inbound behaviour of its peers.
// 0 = a relay without this feature (reachable read/prompt only, no pairing).
export const REMOTE_RELAY_PROTOCOL = 1;

// Every agent path converges on this one local endpoint; the relay does the
// gating, approval, forwarding and waiting.
export const REMOTE_RELAY_TOOL_ENDPOINT = '/api/remote-relays/tool';

export const REMOTE_RELAY_ACTIONS = Object.freeze([
  'list_relays',
  'relay_info',
  'list_sessions',
  'read_session',
  'wait',
  'send',
  'create_session',
  'answer_question',
  'stop',
  'archive',
]);

export const REMOTE_RELAY_PERMISSIONS = Object.freeze(['read', 'prompt', 'full']);
export const REMOTE_RELAY_DEFAULT_PERMISSION = 'full';

// null = allowed without a mention and without a permission (local data only).
export const REMOTE_RELAY_ACTION_PERMISSION = Object.freeze({
  list_relays: null,
  relay_info: 'read',
  list_sessions: 'read',
  read_session: 'read',
  wait: 'read',
  send: 'prompt',
  create_session: 'full',
  answer_question: 'full',
  stop: 'full',
  archive: 'full',
});

// Actions that change something on the remote relay: they need approval when
// the calling session runs in ask or plan mode.
export const REMOTE_RELAY_WRITE_ACTIONS = Object.freeze(['send', 'create_session', 'answer_question', 'stop', 'archive']);

// The write actions that carry an agent's words to another relay's agent.
export const REMOTE_RELAY_PROMPT_ACTIONS = Object.freeze(['send', 'create_session', 'answer_question']);

export const REMOTE_RELAY_APPROVAL_MODES = Object.freeze(['ask', 'plan']);

export const REMOTE_RELAY_SESSION_SCOPES = Object.freeze(['active', 'recent', 'all']);
export const REMOTE_RELAY_PROVIDERS = Object.freeze(['github', 'openai', 'claude', 'cursor', 'grok', 'claude-cloud']);
export const REMOTE_RELAY_MODES = Object.freeze(['plan', 'ask', 'agent', 'autopilot']);
export const REMOTE_RELAY_IF_BUSY = Object.freeze(['queue', 'fail']);
// Reasoning efforts differ per provider and model (none, low, medium, high,
// xhigh, max, ultracode, ...), so the contract only checks the shape of the
// value: the remote relay decides whether its model takes it.
export const REMOTE_RELAY_EFFORT_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const REMOTE_RELAY_RESULT_STATUSES = Object.freeze([
  'queued',
  'running',
  'waiting_for_answer',
  'done',
  'failed',
  'stopped',
  'cancelled',
  'duplicate',
]);

export const REMOTE_RELAY_LIMITS = Object.freeze({
  waitDefaultSeconds: 120,
  // The longest wait of one call is a setting of the relay ("Longest wait per
  // tool call"): waitMaxSeconds is its default, the next three its range. The
  // validator below clamps to the ceiling; the relay clamps to its setting.
  waitMaxSeconds: 600,
  waitMaxFloorSeconds: 120,
  waitMaxCeilingSeconds: 3600,
  waitMaxStepSeconds: 60,
  // Sessions one conversation's agent started on its own relay that may have
  // a turn queued or running at the same time.
  localActiveSessions: 4,
  listDefault: 20,
  listMax: 100,
  readDefault: 10,
  readMax: 50,
  maxCharsDefault: 12000,
  maxCharsMax: 50000,
  perMessageChars: 4000,
  textMax: 100000,
  // Only toward a relay the user did not unlock and that is not the one the
  // prompt came from: a third relay.
  hopLimit: 2,
  // Prompts a conversation's agent may send to other relays' agents without a
  // message from the user in between, before the user is asked.
  agentPromptsBeforeAsking: 30,
  callsPerMinute: 60,
  writesPerMinute: 10,
  healthIntervalMs: 60_000,
  requestTimeoutMs: 15_000,
  responseMaxBytes: 5 * 1024 * 1024,
});

export const REMOTE_RELAY_ERROR_CODES = Object.freeze({
  invalidInput: 'REMOTE_RELAY_INVALID_INPUT',
  unknown: 'REMOTE_RELAY_UNKNOWN',
  locked: 'REMOTE_RELAY_LOCKED',
  forbidden: 'REMOTE_RELAY_FORBIDDEN',
  hopLimit: 'REMOTE_RELAY_HOP_LIMIT',
  approvalDenied: 'REMOTE_RELAY_APPROVAL_DENIED',
  rateLimited: 'REMOTE_RELAY_RATE_LIMITED',
  offline: 'REMOTE_RELAY_OFFLINE',
  unauthorized: 'REMOTE_RELAY_UNAUTHORIZED',
  inboundDisabled: 'REMOTE_INBOUND_DISABLED',
  unsupported: 'REMOTE_RELAY_UNSUPPORTED',
  notFound: 'REMOTE_RELAY_NOT_FOUND',
  providerUnavailable: 'REMOTE_RELAY_PROVIDER_UNAVAILABLE',
  busy: 'REMOTE_RELAY_BUSY',
  noTurn: 'REMOTE_RELAY_NO_ACTIVE_TURN',
  // The local target (this relay itself):
  // the setting "Agents may start and use sessions on this relay" is off,
  localDisabled: 'REMOTE_RELAY_LOCAL_DISABLED',
  // a session an agent created tried to create one itself,
  nestedSession: 'REMOTE_RELAY_NESTED_SESSION',
  // the conversation already has `localActiveSessions` created sessions at work,
  sessionLimit: 'REMOTE_RELAY_SESSION_LIMIT',
  // and an agent tried to prompt, stop, archive, wait for or answer itself.
  ownSession: 'REMOTE_RELAY_OWN_SESSION',
  internal: 'REMOTE_RELAY_INTERNAL',
  // Prefix: the remote answered with this HTTP status, e.g. REMOTE_RELAY_HTTP_409.
  httpPrefix: 'REMOTE_RELAY_HTTP_',
});

// app_settings keys (JSON values). `remote_relays` holds tokens for remotes
// that use their own token: never return that value through an API.
export const REMOTE_RELAY_SETTING_KEYS = Object.freeze({
  instanceId: 'relay_instance_id',
  relays: 'remote_relays',
  publicUrl: 'relay_public_url',
  inboundEnabled: 'remote_relay_inbound_enabled',
  // Agent sessions: the local target's switch (off unless set) and the longest
  // wait of one tool call, for local and paired targets alike.
  agentSessionsEnabled: 'agent_sessions_enabled',
  maxWaitSeconds: 'remote_relay_max_wait_seconds',
});

// Headers a relay adds to every call it forwards to a remote. The remote uses
// them for the inbound switch and to carry the hop count; never the X-Relay-*
// worker identity headers.
export const REMOTE_RELAY_HEADERS = Object.freeze({
  origin: 'x-oar-remote-origin',
  hops: 'x-oar-remote-hops',
});

export const REMOTE_RELAY_SOCKET_EVENT = 'remote_relays_updated';
// Carries the payload of GET /api/settings/agent-sessions.
export const AGENT_SESSIONS_SOCKET_EVENT = 'agent_sessions_settings_updated';

// The local target: the alias that always names the relay the agent runs on,
// and the id it has wherever a paired relay has its registry id (the
// remembered approval is stored as an unlock under it).
export const REMOTE_RELAY_LOCAL_ALIAS = 'this';
export const REMOTE_RELAY_LOCAL_ID = 'self';
export const REMOTE_RELAY_CLOUD_PROVIDER = 'claude-cloud';

export const REMOTE_RELAY_TOOL_DESCRIPTION =
  'Work with sessions on OAR relays: the other relays this relay is paired with ("remote relays") '
  + 'and, when its owner allows it, this relay itself. List the relays, list or read their '
  + 'sessions, prompt a session, start a new one, wait for its reply, and answer or stop it. '
  + 'Start with {action:"list_relays"}. A paired relay stays locked until '
  + 'the user mentions it in this conversation (for example @name) or an agent on that '
  + 'relay writes to it; from then on it stays open for the whole conversation. A '
  + 'locked relay refuses everything except list_relays, so ask the user to mention it. '
  + 'Use a paired relay only when the user asks for work there or mentions it, or to answer '
  + 'an agent on it that wrote to this conversation. '
  + 'This relay is listed with self:true and is addressed by its name or as "this"; it needs '
  + 'no mention. Use it to hand parts of your task to other sessions: create_session up to '
  + `${REMOTE_RELAY_LIMITS.localActiveSessions} sessions that work at the same time (any provider relay_info lists: local ones `
  + 'with cwd, provider "claude-cloud" with repo and an optional branch), then wait for and read '
  + 'each one. The first create_session here shows the user an approval card once per '
  + 'conversation. A session you created cannot create sessions itself, and every session '
  + 'runs on the relay owner\'s accounts, so start only what the task needs. A new session '
  + 'knows nothing of this conversation: write a self-contained prompt, and for '
  + '"claude-cloud" (a sandbox with a fresh clone of the repository) name the branch to '
  + 'work on and to push. '
  + 'send and create_session queue the prompt and wait up to wait_seconds (default 120, '
  + 'max set on the relay, default 600) for the reply. If the turn is still running you get status '
  + '"running" with progress: call {action:"wait", relay, session, message_id} to keep '
  + 'waiting. An agent that answers but keeps working in the background also comes '
  + 'back as "running", with its latest reply so far; "done" means it has finished. '
  + 'If a result lists pendingQuestions, the other agent is waiting for an '
  + 'answer: ask the user (unless they told you to decide yourself) and pass the answer '
  + 'with answer_question. Write actions can first need the user\'s approval. Always '
  + 'tell the user which relay and session you worked on.';

export const REMOTE_RELAY_TOOL_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [...REMOTE_RELAY_ACTIONS],
      description: 'list_relays: the relays (this one included when allowed) and whether each is unlocked here. relay_info: providers, models, '
        + 'workspaces of a relay. list_sessions / read_session: discover and read sessions. send: prompt an '
        + 'existing session. create_session: start a new session with a first prompt. wait: keep waiting for '
        + 'a reply. answer_question: answer a question the remote agent asked. stop: stop the running turn. '
        + 'archive: archive a session.',
    },
    relay: { type: 'string', description: 'Relay name (or its host) from list_relays, or "this" for the relay you run on. Required except for list_relays.' },
    session: { type: 'string', description: 'Session (conversation) id from list_sessions or create_session.' },
    text: { type: 'string', description: 'send / create_session: the prompt for the other agent.' },
    message_id: { type: 'string', description: 'wait: the message_id that send or create_session returned.' },
    wait_seconds: {
      type: 'integer',
      minimum: 0,
      maximum: REMOTE_RELAY_LIMITS.waitMaxCeilingSeconds,
      description: 'send / create_session / wait: how long to wait for the reply (default 120, 0 = do not wait; '
        + 'the relay limits it to its own maximum, 600 unless its owner changed it).',
    },
    scope: {
      type: 'string',
      enum: [...REMOTE_RELAY_SESSION_SCOPES],
      description: 'list_sessions: active = working now, recent = newest first (default), all = page through everything.',
    },
    query: { type: 'string', description: 'list_sessions: only sessions whose title contains this text.' },
    limit: { type: 'integer', minimum: 1, maximum: REMOTE_RELAY_LIMITS.listMax, description: 'list_sessions: page size (default 20).' },
    cursor: { type: 'string', description: 'list_sessions: nextCursor from the previous page.' },
    last: { type: 'integer', minimum: 1, maximum: REMOTE_RELAY_LIMITS.readMax, description: 'read_session: how many recent messages (default 10).' },
    before: { type: 'string', description: 'read_session: olderCursor from the previous read, to page back.' },
    include_activity: { type: 'boolean', description: 'read_session: include the tool activity lines of each reply.' },
    max_chars: {
      type: 'integer',
      minimum: 500,
      maximum: REMOTE_RELAY_LIMITS.maxCharsMax,
      description: 'read_session: total text budget (default 12000).',
    },
    provider: {
      type: 'string',
      enum: [...REMOTE_RELAY_PROVIDERS],
      description: 'create_session: provider (default: the same provider as this session).',
    },
    model: {
      type: 'string',
      description: 'create_session: model id (default: this session\'s model when the remote offers it, else the remote\'s default). '
        + 'send: switch the remote session to this model (default: it keeps its own).',
    },
    cwd: { type: 'string', description: 'create_session: working directory on the target relay (default: its default workspace). Not for claude-cloud.' },
    repo: {
      type: 'string',
      description: 'create_session with provider "claude-cloud" (required there, an error with any other provider): '
        + 'the GitHub repository the cloud session clones, as https://github.com/owner/repo or owner/repo.',
    },
    branch: {
      type: 'string',
      description: 'create_session with provider "claude-cloud": the branch to check out (default: the repository\'s default branch).',
    },
    mode: {
      type: 'string',
      enum: [...REMOTE_RELAY_MODES],
      description: 'send / create_session: relay mode for the remote turn (default: this session\'s mode).',
    },
    effort: {
      type: 'string',
      description: 'send / create_session: reasoning effort for the remote turn, e.g. low, medium, high (relay_info lists '
        + 'what each model takes). create_session default: this session\'s effort when the remote model supports it, '
        + 'else the remote\'s default. send default: the remote session keeps its own.',
    },
    title: { type: 'string', description: 'create_session: session title (default: from the prompt).' },
    question_id: { type: 'string', description: 'answer_question: id from pendingQuestions.' },
    answer: { type: 'string', description: 'answer_question: free-text answer.' },
    choices: {
      type: 'array',
      items: { type: 'string' },
      description: 'answer_question: selected option labels, for questions with options.',
    },
    if_busy: {
      type: 'string',
      enum: [...REMOTE_RELAY_IF_BUSY],
      description: 'send: queue (default; steers into a running turn where the remote supports it) or fail when the session is busy.',
    },
  },
  required: ['action'],
});

function toText(value) {
  return String(value ?? '').trim();
}

function clampInteger(value, { min, max, fallback }) {
  if (value === undefined || value === null || toText(value) === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function invalid(error) {
  return { ok: false, code: REMOTE_RELAY_ERROR_CODES.invalidInput, error };
}

const SESSION_ACTIONS = new Set(['read_session', 'wait', 'send', 'stop', 'archive']);

/**
 * The longest wait a relay may be set to allow, from whatever was stored or
 * sent: a whole number of seconds inside the range, or the default.
 */
export function normalizeRemoteRelayMaxWaitSeconds(value) {
  const number = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) {
    return REMOTE_RELAY_LIMITS.waitMaxSeconds;
  }
  return Math.min(
    REMOTE_RELAY_LIMITS.waitMaxCeilingSeconds,
    Math.max(REMOTE_RELAY_LIMITS.waitMaxFloorSeconds, Math.trunc(number)),
  );
}

/**
 * The repository of a Claude Cloud session as an agent may write it: any form
 * shared/claude-cloud/repo-url.mjs takes, or the bare `owner/repo`. Returns
 * the canonical https URL, or '' when the text names no GitHub repository.
 */
export function normalizeRemoteRelayRepo(value) {
  const text = toText(value);
  if (!text) return '';
  const direct = normalizeGitHubRepoUrl(text);
  if (direct) return direct.repoUrl;
  if (!/^[^/\s:@]+\/[^/\s:@]+$/.test(text)) return '';
  return normalizeGitHubRepoUrl(`https://github.com/${text}`)?.repoUrl || '';
}

/**
 * Validates and normalises one tool call. Adapters call it for a crisp early
 * message; the relay calls it again authoritatively. Returns
 * `{ ok:true, action, args }` with only the fields the action uses, defaults
 * filled in and numbers clamped, or `{ ok:false, code, error }`.
 *
 * `maxWaitSeconds` is the relay's own setting; without it (an adapter, which
 * does not know the setting) wait_seconds is clamped to the ceiling only.
 * `waitLimitedFrom` is set on the result when the relay's setting cut the wait.
 */
export function validateRemoteRelayToolInput(input = {}, { maxWaitSeconds } = {}) {
  const action = toText(input?.action).toLowerCase();
  if (!REMOTE_RELAY_ACTIONS.includes(action)) {
    return invalid(`action must be one of: ${REMOTE_RELAY_ACTIONS.join(', ')}`);
  }
  if (action === 'list_relays') return { ok: true, action, args: {} };

  const args = {};
  const relay = toText(input?.relay);
  if (!relay) return invalid(`${action} needs relay (a name from list_relays)`);
  args.relay = relay;

  if (SESSION_ACTIONS.has(action)) {
    const session = toText(input?.session);
    if (!session) return invalid(`${action} needs session (an id from list_sessions)`);
    args.session = session;
  }

  const waitCeiling = clampInteger(input?.wait_seconds, {
    min: 0,
    max: REMOTE_RELAY_LIMITS.waitMaxCeilingSeconds,
    fallback: REMOTE_RELAY_LIMITS.waitDefaultSeconds,
  });
  if (waitCeiling === null) return invalid('wait_seconds must be a number of seconds');
  const waitMax = maxWaitSeconds === undefined
    ? REMOTE_RELAY_LIMITS.waitMaxCeilingSeconds
    : normalizeRemoteRelayMaxWaitSeconds(maxWaitSeconds);
  const waitSeconds = Math.min(waitCeiling, waitMax);
  // What the agent asked for, when the relay's setting allows less.
  const waitLimited = waitSeconds < waitCeiling
    ? { waitLimitedFrom: Math.trunc(Math.min(Number(input.wait_seconds), Number.MAX_SAFE_INTEGER)) }
    : {};

  const optionalEnum = (key, allowed) => {
    const value = toText(input?.[key]).toLowerCase();
    if (!value) return { ok: true };
    if (!allowed.includes(value)) return invalid(`${key} must be one of: ${allowed.join(', ')}`);
    args[key] = value;
    return { ok: true };
  };
  const optionalText = (key, max = 500) => {
    const value = toText(input?.[key]);
    if (value) args[key] = value.slice(0, max);
  };

  if (action === 'list_sessions') {
    const scopeCheck = optionalEnum('scope', REMOTE_RELAY_SESSION_SCOPES);
    if (!scopeCheck.ok) return scopeCheck;
    args.scope = args.scope || 'recent';
    const limit = clampInteger(input?.limit, { min: 1, max: REMOTE_RELAY_LIMITS.listMax, fallback: REMOTE_RELAY_LIMITS.listDefault });
    if (limit === null) return invalid('limit must be a number');
    args.limit = limit;
    optionalText('query', 200);
    optionalText('cursor', 1000);
  } else if (action === 'read_session') {
    const last = clampInteger(input?.last, { min: 1, max: REMOTE_RELAY_LIMITS.readMax, fallback: REMOTE_RELAY_LIMITS.readDefault });
    if (last === null) return invalid('last must be a number');
    args.last = last;
    const maxChars = clampInteger(input?.max_chars, { min: 500, max: REMOTE_RELAY_LIMITS.maxCharsMax, fallback: REMOTE_RELAY_LIMITS.maxCharsDefault });
    if (maxChars === null) return invalid('max_chars must be a number');
    args.max_chars = maxChars;
    args.include_activity = input?.include_activity === true || toText(input?.include_activity).toLowerCase() === 'true';
    optionalText('before', 1000);
  } else if (action === 'wait') {
    const messageId = toText(input?.message_id);
    if (!messageId) return invalid('wait needs message_id (from send or create_session)');
    args.message_id = messageId;
    args.wait_seconds = waitSeconds;
  } else if (action === 'send' || action === 'create_session') {
    const text = toText(input?.text);
    if (!text) return invalid(`${action} needs text (the prompt)`);
    if (text.length > REMOTE_RELAY_LIMITS.textMax) return invalid(`text is longer than ${REMOTE_RELAY_LIMITS.textMax} characters`);
    args.text = text;
    args.wait_seconds = waitSeconds;
    optionalText('model', 200);
    const modeCheck = optionalEnum('mode', REMOTE_RELAY_MODES);
    if (!modeCheck.ok) return modeCheck;
    const effort = toText(input?.effort).toLowerCase();
    if (effort) {
      if (!REMOTE_RELAY_EFFORT_PATTERN.test(effort)) {
        return invalid('effort must be a short word such as low, medium or high (letters, digits and dashes, at most 32 characters)');
      }
      args.effort = effort;
    }
    if (action === 'send') {
      const busyCheck = optionalEnum('if_busy', REMOTE_RELAY_IF_BUSY);
      if (!busyCheck.ok) return busyCheck;
      args.if_busy = args.if_busy || 'queue';
    } else {
      const providerCheck = optionalEnum('provider', REMOTE_RELAY_PROVIDERS);
      if (!providerCheck.ok) return providerCheck;
      optionalText('cwd', 1000);
      optionalText('title', 200);
      // A Claude Cloud session clones a repository instead of opening a
      // folder: repo and branch belong to that provider alone. A call that
      // names no provider gets this session's, so "repo is missing" for a
      // cloud caller is the relay's to say.
      const repoText = toText(input?.repo);
      const branchText = toText(input?.branch);
      if (args.provider === REMOTE_RELAY_CLOUD_PROVIDER) {
        if (!repoText) {
          return invalid('create_session with provider "claude-cloud" needs repo (https://github.com/owner/repo or owner/repo)');
        }
        if (args.cwd) return invalid('cwd does not apply to provider "claude-cloud": it clones repo instead of opening a folder');
      } else if (repoText || branchText) {
        return invalid('repo and branch go with provider "claude-cloud" only; pass provider "claude-cloud", or cwd for a folder on the relay');
      }
      if (repoText) {
        const repo = normalizeRemoteRelayRepo(repoText);
        if (!repo) return invalid('repo must be a GitHub repository: https://github.com/owner/repo or owner/repo');
        args.repo = repo;
      }
      if (branchText) {
        if (!isValidBranchName(branchText)) return invalid(`branch "${branchText.slice(0, 80)}" is not a valid branch name`);
        args.branch = branchText;
      }
    }
  } else if (action === 'answer_question') {
    const questionId = toText(input?.question_id);
    if (!questionId) return invalid('answer_question needs question_id (from pendingQuestions)');
    args.question_id = questionId;
    const answer = toText(input?.answer);
    const choices = Array.isArray(input?.choices)
      ? input.choices.map((choice) => toText(choice)).filter(Boolean).slice(0, 50)
      : [];
    if (!answer && choices.length === 0) return invalid('answer_question needs answer or choices');
    if (answer) args.answer = answer.slice(0, REMOTE_RELAY_LIMITS.textMax);
    if (choices.length) args.choices = choices;
  }
  const waits = Object.prototype.hasOwnProperty.call(args, 'wait_seconds');
  return { ok: true, action, args, ...(waits ? waitLimited : {}) };
}

const PERMISSION_RANK = { read: 1, prompt: 2, full: 3 };

export function normalizeRemoteRelayPermission(value) {
  const permission = toText(value).toLowerCase();
  return REMOTE_RELAY_PERMISSIONS.includes(permission) ? permission : REMOTE_RELAY_DEFAULT_PERMISSION;
}

/** True when a remote with `permission` allows `action`. */
export function remoteRelayPermissionAllows(permission, action) {
  if (!Object.prototype.hasOwnProperty.call(REMOTE_RELAY_ACTION_PERMISSION, action)) return false;
  const needed = REMOTE_RELAY_ACTION_PERMISSION[action];
  if (needed === null) return true;
  return (PERMISSION_RANK[normalizeRemoteRelayPermission(permission)] || 0) >= PERMISSION_RANK[needed];
}

export function isRemoteRelayWriteAction(action) {
  return REMOTE_RELAY_WRITE_ACTIONS.includes(action);
}

export function isRemoteRelayPromptAction(action) {
  return REMOTE_RELAY_PROMPT_ACTIONS.includes(action);
}

// ─── Approval cards ──────────────────────────────────────────────────────────

// The Allow / Deny card a relay puts on its own turn before a write action on
// another relay (ask / plan mode) is an ordinary relay question whose
// `context.source` is this. Only that relay's user may answer it: its question
// routes hide the card from other relays' agents and refuse their answers, and
// a dispatcher never offers one to its agent.
export const REMOTE_RELAY_APPROVAL_SOURCE = 'remote_relay';

/** True for such a card: a formatted question, or a stored request envelope (both carry `context`). */
export function isRemoteRelayApprovalQuestion(question) {
  const context = question && typeof question === 'object' ? question.context : null;
  return !!context && typeof context === 'object' && toText(context.source) === REMOTE_RELAY_APPROVAL_SOURCE;
}

// ─── Provenance ──────────────────────────────────────────────────────────────

const ORIGIN_CAPS = {
  relayId: 100,
  relayName: 60,
  relayUrl: 300,
  conversationId: 100,
  conversationTitle: 200,
  provider: 40,
  model: 100,
};

/**
 * Sanitises an `origin` object received on /api/message or bootstrap (or built
 * locally before forwarding). Returns null when it does not describe an agent
 * on a relay. Every field is a capped string except `hops` and `local`.
 *
 * `local: true` marks an agent of THIS relay (the local target): the
 * conversation named by `conversationId` lives here. Only the in-process
 * loopback may claim it; the inbound side drops it from anything that came in
 * over HTTP (readRemoteRelayRequest).
 */
export function normalizeRemoteRelayOrigin(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const origin = { kind: 'agent' };
  for (const [key, cap] of Object.entries(ORIGIN_CAPS)) {
    const value = toText(raw[key]).replace(/[\r\n]+/g, ' ');
    origin[key] = value ? value.slice(0, cap) : '';
  }
  if (!origin.relayId && !origin.relayName) return null;
  if (origin.relayUrl && !/^https?:\/\//i.test(origin.relayUrl)) origin.relayUrl = '';
  const hops = Number(raw.hops);
  origin.hops = Number.isInteger(hops) && hops >= 0 ? Math.min(hops, 10) : 1;
  if (raw.local === true) origin.local = true;
  return origin;
}

function quoteForHeader(value) {
  return toText(value).replace(/["\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The one line a relay puts at the top of a prompt it forwards, so the remote
 * AGENT knows another agent is talking to it. The remote UI hides it when the
 * message carries `origin` (the badge shows the same facts).
 */
export function formatRemotePromptHeader(origin) {
  // The same line for an agent of this relay (origin.local): REMOTE_PROMPT_HEADER_PATTERN
  // and every reader that strips it stay as they are.
  const parts = [`[Remote prompt from an agent on relay "${quoteForHeader(origin?.relayName) || 'unknown'}"`];
  const title = quoteForHeader(origin?.conversationTitle);
  if (title) parts.push(`session "${title}"`);
  const model = quoteForHeader(origin?.model);
  if (model) parts.push(model);
  parts.push('acting for the user]');
  return parts.join(' · ');
}

export const REMOTE_PROMPT_HEADER_PATTERN = /^\[Remote prompt from an agent on relay "[^"\r\n]*"[^\r\n]*\](?:\r?\n){1,2}/;

export function withRemotePromptHeader(text, origin) {
  return `${formatRemotePromptHeader(origin)}\n\n${String(text ?? '')}`;
}

export function stripRemotePromptHeader(text) {
  return String(text ?? '').replace(REMOTE_PROMPT_HEADER_PATTERN, '');
}

// ─── Remote addresses ────────────────────────────────────────────────────────

function ipv4Parts(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

function isLoopbackHost(host) {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const parts = ipv4Parts(host);
  return !!parts && parts[0] === 127;
}

function isPrivateHost(host) {
  const parts = ipv4Parts(host);
  if (parts) {
    const [a, b] = parts;
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return /^f[cd][0-9a-f]{2}:/.test(bare);
}

/**
 * The address policy: https anywhere; plain http only for loopback and private
 * ranges (the token travels with every call). Returns `{ ok, warning? }` or
 * `{ ok:false, error }`.
 */
export function checkRemoteRelayUrlPolicy(url) {
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url));
  } catch {
    return { ok: false, error: 'Not a valid URL' };
  }
  if (parsed.protocol === 'https:') return { ok: true };
  if (parsed.protocol !== 'http:') return { ok: false, error: 'Only https:// (or http:// on loopback and private networks) is supported' };
  const host = parsed.hostname.toLowerCase();
  if (isLoopbackHost(host)) return { ok: true, warning: 'Plain http on loopback (for example an SSH port forward).' };
  if (isPrivateHost(host)) return { ok: true, warning: 'Plain http: the token crosses your network unencrypted.' };
  return { ok: false, error: 'Plain http is only allowed for loopback and private network addresses; use https://' };
}

/**
 * Turns whatever the user pasted — a web-client URL, possibly with ?token=,
 * a #hash, a push_conv/conv deep link or a trailing index.html — into the
 * relay's base URL (origin + remotePath, no trailing slash) and the token the
 * link carried, if any.
 */
export function normalizeRemoteRelayLink(link) {
  let raw = toText(link);
  if (!raw) return { ok: false, error: 'Paste the web address of the other relay' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'Not a valid URL' };
  }
  const policy = checkRemoteRelayUrlPolicy(parsed);
  if (!policy.ok) return policy;
  const token = toText(parsed.searchParams.get('token')) || null;
  let pathname = parsed.pathname || '/';
  const segments = pathname.split('/');
  const lastSegment = segments[segments.length - 1];
  if (lastSegment && lastSegment.includes('.')) segments.pop();
  pathname = segments.join('/').replace(/\/+$/, '');
  const baseUrl = `${parsed.protocol}//${parsed.host}${pathname}`;
  return {
    ok: true,
    baseUrl,
    host: parsed.hostname.toLowerCase(),
    token,
    ...(policy.warning ? { warning: policy.warning } : {}),
  };
}

/** Link that opens one conversation in a relay's web UI. */
export function remoteConversationUrl(baseUrl, conversationId) {
  const base = toText(baseUrl).replace(/\/+$/, '');
  const id = toText(conversationId);
  if (!base) return '';
  return id ? `${base}/?conv=${encodeURIComponent(id)}` : `${base}/`;
}

// ─── Activity line ───────────────────────────────────────────────────────────

function clip(value, max) {
  const text = toText(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The one-line summary the workers use for the tool's activity line. */
export function summarizeRemoteRelayCall(input = {}) {
  const action = toText(input?.action).toLowerCase() || 'call';
  const relay = toText(input?.relay);
  const session = toText(input?.session);
  const target = [relay, session ? `session ${session.slice(0, 8)}` : ''].filter(Boolean).join(' ');
  const text = input?.text ? `: “${clip(input.text, 60)}”` : '';
  return target ? `${action} → ${target}${text}` : `${action}${text}`;
}
