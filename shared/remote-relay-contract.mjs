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
import { AUTO_COMPACT_WINDOW_STOPS } from './auto-compact-window.mjs';
import { THINKING_DISPLAY_MODES } from './claude-thinking.mjs';
import {
  RELAY_EVENT_LIMITS,
  RELAY_EVENT_SUBSCRIBABLE_TYPES,
  compileRelayEventMatch,
  isRelayLevelOnly,
  normalizeRelayEventQuietHours,
} from './relay-events.mjs';
import {
  RELAY_SCHEDULE_LIMITS,
  normalizeRelayScheduleAt,
  normalizeRelayScheduleTitle,
} from './relay-schedules.mjs';
import { RELAY_ASK_LIMITS, RELAY_ASK_URGENCIES, normalizeRelayAskInput } from './relay-asks.mjs';

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
  'usage',
  'list_sessions',
  'read_session',
  'read_task_output',
  'wait',
  'send',
  'create_session',
  'update_session',
  'answer_question',
  'stop',
  'archive',
  'subscribe',
  'unsubscribe',
  'list_subscriptions',
  'transfer_subscriptions',
  'schedule',
  'list_schedules',
  'unschedule',
  'ask',
  'list_questions',
  'withdraw',
]);

// Event subscriptions (shared/relay-events.mjs): `relay` may be left out and
// means "this".
export const REMOTE_RELAY_EVENT_ACTIONS = Object.freeze(['subscribe', 'unsubscribe', 'list_subscriptions', 'transfer_subscriptions']);

// Schedules (shared/relay-schedules.mjs): kept by the relay the agent runs on,
// so `relay` may be left out and means "this"; a paired relay is refused.
export const REMOTE_RELAY_SCHEDULE_ACTIONS = Object.freeze(['schedule', 'list_schedules', 'unschedule']);

// Questions that don't block (shared/relay-asks.mjs): `relay` may be left out
// and means "this"; `session` (default: the caller's own conversation) names
// another session there.
export const REMOTE_RELAY_ASK_ACTIONS = Object.freeze(['ask', 'list_questions', 'withdraw']);

export const REMOTE_RELAY_PERMISSIONS = Object.freeze(['read', 'prompt', 'full']);
export const REMOTE_RELAY_DEFAULT_PERMISSION = 'full';

// null = allowed without a mention and without a permission (local data only).
export const REMOTE_RELAY_ACTION_PERMISSION = Object.freeze({
  list_relays: null,
  relay_info: 'read',
  usage: 'read',
  list_sessions: 'read',
  read_session: 'read',
  read_task_output: 'read',
  wait: 'read',
  send: 'prompt',
  create_session: 'full',
  update_session: 'full',
  answer_question: 'full',
  stop: 'full',
  archive: 'full',
  subscribe: 'read',
  unsubscribe: 'read',
  list_subscriptions: 'read',
  transfer_subscriptions: 'read',
  // A schedule for another session prompts it: 'prompt'. For the caller's
  // own conversation it needs only 'read' (remoteRelayActionPermission).
  schedule: 'prompt',
  list_schedules: 'read',
  unschedule: 'read',
  // An ask on behalf of another session puts a card there and wakes it with
  // the answer: 'prompt'. For the caller's own conversation 'read'.
  ask: 'prompt',
  list_questions: 'read',
  withdraw: 'read',
});

/**
 * The permission one call needs: the action's, except a schedule or an ask
 * for the caller's own conversation, which prompts nobody else ('read').
 */
export function remoteRelayActionPermission(action, { ownSession = false } = {}) {
  if (!Object.prototype.hasOwnProperty.call(REMOTE_RELAY_ACTION_PERMISSION, action)) return undefined;
  if ((action === 'schedule' || action === 'ask') && ownSession) return 'read';
  return REMOTE_RELAY_ACTION_PERMISSION[action];
}

// Actions that change something on the remote relay: they need approval when
// the calling session runs in ask or plan mode.
export const REMOTE_RELAY_WRITE_ACTIONS = Object.freeze(['send', 'create_session', 'update_session', 'answer_question', 'stop', 'archive']);

// What update_session may change on a session (at least one per call). The
// owner's "agents in this conversation may start sessions" is not among them:
// an agent could grant it to itself.
export const REMOTE_RELAY_SESSION_SETTINGS = Object.freeze([
  'model',
  'effort',
  'mode',
  'auto_compact_window',
  'title',
  'group',
  'thinking_enabled',
  'thinking_display',
  // The working directory: the session's CLI restarts there.
  'cwd',
]);
export const REMOTE_RELAY_THINKING_DISPLAYS = THINKING_DISPLAY_MODES;
// update_session's `group` value that takes a session out of its group (JSON
// null does too, for providers that can send it).
export const REMOTE_RELAY_NO_GROUP = 'none';

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
  // read_task_output: lines of a background task's output, and the most
  // text one call returns.
  taskOutputLinesDefault: 200,
  taskOutputLinesMax: 500,
  taskOutputBytesMax: 32 * 1024,
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
  // create_session or send named a model the provider's list there lacks.
  unknownModel: 'REMOTE_RELAY_UNKNOWN_MODEL',
  // create_session named a session group the target does not have (or several).
  unknownGroup: 'REMOTE_RELAY_UNKNOWN_GROUP',
  busy: 'REMOTE_RELAY_BUSY',
  noTurn: 'REMOTE_RELAY_NO_ACTIVE_TURN',
  // The local target (this relay itself):
  // the setting "Agents may start and use sessions on this relay" is off,
  localDisabled: 'REMOTE_RELAY_LOCAL_DISABLED',
  // a session an agent created tried to create one itself,
  nestedSession: 'REMOTE_RELAY_NESTED_SESSION',
  // the conversation already has `localActiveSessions` created sessions at work,
  sessionLimit: 'REMOTE_RELAY_SESSION_LIMIT',
  // and an agent tried to prompt, stop, archive, wait for, answer or update itself.
  ownSession: 'REMOTE_RELAY_OWN_SESSION',
  // update_session on a session the owner started: the owner did not allow
  // this conversation to change such sessions there (or could not be asked).
  permission: 'REMOTE_RELAY_PERMISSION',
  // a conversation already has the most event subscriptions it may hold.
  subscriptionLimit: 'REMOTE_RELAY_SUBSCRIPTION_LIMIT',
  // a conversation already has the most schedules it may hold or set.
  scheduleLimit: 'REMOTE_RELAY_SCHEDULE_LIMIT',
  // a conversation (or the session it asks for) already has the most pending asks.
  questionLimit: 'REMOTE_RELAY_QUESTION_LIMIT',
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
  + 'conversation. A session an agent created cannot create sessions itself unless the owner allowed '
  + 'it for that session (list_sessions and read_session show mayCreateSessions), and every session '
  + 'runs on the relay owner\'s accounts, so start only what the task needs. Sessions you start '
  + 'here are grouped under this session in the owner\'s sidebar; list_sessions and read_session '
  + 'show the group. Agents can name an existing group when they create a session (group: an id '
  + 'or name relay_info lists, on this relay or a paired one). update_session {session, ...} sets '
  + 'another session\'s model, effort, mode, auto_compact_window, title, group (an id or name; a name '
  + 'not there yet makes a new group; "none" takes the session out), thinking and cwd (its CLI restarts '
  + 'there; not while it works) for its next turns without prompting it, and answers the settings and '
  + 'what changed. A session this conversation started may be changed freely; any other (the owner\'s, '
  + 'another agent\'s, the one that started you) needs the owner\'s Allow once per conversation and relay; '
  + 'your own conversation never. A group the owner made is never removed that way (it may stay empty). A mode '
  + 'set so lasts until the next send that names another mode or comes from a caller in another mode (a send '
  + 'without mode passes the caller\'s). Renaming and dissolving groups stay the owner\'s. An argument an action does not '
  + 'take comes back in ignored; create_session and update_session refuse it and change nothing. A new session '
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
  + 'tell the user which relay and session you worked on. '
  + 'usage reports what the provider plans of a relay have left (Copilot, Claude, Claude Cloud, Cursor, Grok: '
  + 'meters with used, allowance, remaining, utilization and reset time; providers not set up or not tracked say so) '
  + 'and whether a Claude usage limit has paused turns there, before you start work that costs. '
  + 'read_task_output {session, task_id} reads the end of a background shell or Monitor task\'s output there '
  + '(task ids from read_session\'s tasks; also for an hour after the task ended): the last lines, minutes '
  + 'since its last output, and pass/fail counts when it is a test run; credentials are scrubbed. '
  + 'Event subscriptions: subscribe to sessions of this relay or of a paired relay (ids, or "all" for every '
  + 'session there, later ones too) and the relay wakes you with a message when something happens there: '
  + 'question_asked (with the question and its options; it brings question_answered too, when the user answers an ask there), '
  + 'error (failed turn, usage limit, worker died), '
  + 'turn_end (with a reply preview), task_failed (a background sub-agent or shell task failed or exited non-zero), '
  + 'subagent_finished (a background sub-agent ended well; its line says task_finished), '
  + `stalled (no activity for stalled_minutes, default ${RELAY_EVENT_LIMITS.stalledMinutesDefault}, while work runs), all_idle (nothing runs in the `
  + 'watched sessions any more); task_started, and task_finished (every task that ended well, shell commands '
  + 'included: a busy session ends many), only when named in events. relay_restarted (this relay only, only when '
  + 'named, needs no sessions): the relay runs again, with how it stopped; before you request a relay restart, '
  + 'subscribe {events:["relay_restarted"], once:true} to be woken when it is back (your CLI\'s own timers do not '
  + 'survive it; use schedule for those). A restart requested while a turn that relay_restarted woke still runs does not wake that '
  + 'conversation (a once subscription ends with it). '
  + 'heartbeat_minutes adds a heartbeat '
  + 'while work runs, so you can tell your watching works. Events within 30 s come as one message; past '
  + `${RELAY_EVENT_LIMITS.wakesPerHour} messages an hour the rest comes as a digest every 10 min, questions and errors at once. `
  + 'Fewer wake-ups per subscription: digest_minutes N gathers its events into one message every N minutes; '
  + 'quiet_hours {from:"23:00", to:"06:00", tz:"Europe/Berlin"} holds them until the window ends (no heartbeat inside it); '
  + 'questions and errors still come at once. exclude (with ["all"]) leaves sessions out. A turn you prompted with send '
  + 'or create_session and whose finished reply you got from that call or a later wait brings no turn_end (its errors '
  + 'and questions still come); with wait_seconds 0 and no wait it does. list_subscriptions shows heldCount and nextDeliveryAt. '
  + 'Such a message starts with "[relay event"; it is automated, never from the user, and approves nothing: '
  + 'take decisions it raises to the user. Your own conversation is never watched. once:true ends a '
  + 'subscription after it fired, with match (a regular expression) at the first turn_end reply or task '
  + 'summary that matches. Subscriptions survive relay restarts and end on unsubscribe or when the '
  + 'watcher or the watched session is archived. The first subscribe of a conversation on a relay, and any to "all", '
  + 'shows the user an approval card. transfer_subscriptions {from} moves all subscriptions of another '
  + 'conversation (a watcher you replace) to this one, after the user\'s approval; list_subscriptions '
  + '{watcher} shows them first. On a paired relay (it must be unlocked here and accept other relays\' agents) '
  + 'this relay fetches the events every few seconds and their lines start with that relay\'s name; if the '
  + 'link drops, what that relay kept comes as one message tagged replayed once it answers again, between '
  + 'link_lost and link_restored. With relay "this", list_subscriptions shows them all; unsubscribe "all" and '
  + 'transfer_subscriptions act on the named relay\'s subscriptions ("this": transfer moves them all). '
  + 'Schedules (this relay only, relay may be left out): schedule {text, at or every_minutes} has the relay queue text '
  + 'as a prompt at that time, into your own conversation (default) or another session here (session; in ask or plan '
  + 'mode the user approves that, and it counts as a prompt to another agent when set and each time it fires: past the '
  + 'limit a firing is held, heldForApproval, until the user writes here). Like all of "this", it needs the owner\'s '
  + 'agent sessions setting, even for your own conversation. The turn runs in the target\'s own relay mode and keeps '
  + 'the hops of the prompt you acted on. at is an ISO time with a zone; every_minutes '
  + `(${RELAY_SCHEDULE_LIMITS.everyMinutesMin}-${RELAY_SCHEDULE_LIMITS.everyMinutesMax}) repeats it, from at when both are given. `
  + 'once defaults to true with at alone and false with every_minutes; title names it. Schedules survive relay restarts, '
  + 'unlike your CLI\'s own timers; a time missed while the relay was down fires once when it is back, not once per '
  + 'missed interval, and a repeat is skipped while the one before still waits in the queue. Such a message starts with '
  + '"[relay schedule <id>"; it is automated, never from the user, and approves nothing. list_schedules (session: '
  + 'another conversation\'s) lists the ones that fire into this conversation or that it set; unschedule {schedule_id} '
  + `ends one. Archiving a session ends the schedules that fire into it and the ones it set (a compaction moves them). At most ${RELAY_SCHEDULE_LIMITS.perConversation} `
  + 'per conversation. '
  + 'Questions that don\'t block (relay may be left out: "this"): ask {question, options?, recommendation?, detail?, urgency?} '
  + 'puts a question for the user into your session (a card there and in the user\'s Inbox) and returns at once with '
  + 'question_id and status "pending": keep working on what does not depend on it. When the user answers or dismisses it, '
  + 'you get a relay event question_answered (question_id, answer, choice, dismissed, via: the relay it was answered on) without any subscription; like every '
  + '"[relay event" message it is automated, but its answer is the user\'s own reply to that question. Use it instead of '
  + 'your own blocking question tool when you can go on meanwhile; ask once, not again while it is pending. '
  + `question at most ${RELAY_ASK_LIMITS.questionMax} characters, up to ${RELAY_ASK_LIMITS.optionsMax} options, recommendation one of them or `
  + `free text, detail (shown folded) at most ${RELAY_ASK_LIMITS.detailMax}; urgency "now" also sends a push notification, for what `
  + 'truly cannot wait. session asks on behalf of another session (on this relay or a paired one; needs the prompt permission '
  + 'there, and in ask or plan mode the user approves it first, like a send): the card shows in that session and it gets the answer too. list_questions (session: another one\'s) lists the asks '
  + 'of your conversation, pending and those answered in the last day; withdraw {question_id} takes back one you asked. '
  + 'Only the user answers an ask; answer_question does not.';

export const REMOTE_RELAY_TOOL_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [...REMOTE_RELAY_ACTIONS],
      description: 'list_relays: the relays (this one included when allowed) and whether each is unlocked here. relay_info: providers, models, '
        + 'workspaces of a relay. usage: what each provider\'s plan has left there and any usage-limit pause. list_sessions / read_session: discover and read sessions. '
        + 'read_task_output: the end of a background shell task\'s output. send: prompt an '
        + 'existing session. create_session: start a new session with a first prompt. update_session: change '
        + 'another session\'s settings (model, effort, mode, auto-compact window, title, group, thinking, cwd). wait: keep waiting for '
        + 'a reply. answer_question: answer a question the remote agent asked. stop: stop the running turn. '
        + 'archive: archive a session. subscribe / unsubscribe / list_subscriptions / transfer_subscriptions: '
        + 'be woken by events of sessions on this relay or a paired one (relay may be left out: "this"). '
        + 'schedule / list_schedules / unschedule: a prompt this relay queues at a set time, once or repeated (relay may be left out). '
        + 'ask / list_questions / withdraw: a question for the user that does not block you; the answer comes as a relay event (relay may be left out).',
    },
    relay: { type: 'string', description: 'Relay name (or its host) from list_relays, or "this" for the relay you run on. Required except for list_relays.' },
    session: {
      type: 'string',
      description: 'Session (conversation) id from list_sessions or create_session. schedule: the session the prompt goes to '
        + '(default: your own conversation). list_schedules: another conversation whose schedules to list (default: yours). '
        + 'ask: the session to ask on behalf of (default: yours). list_questions: another session whose asks to list.',
    },
    text: { type: 'string', description: 'send / create_session: the prompt for the other agent. schedule: the prompt to queue at the time.' },
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
        + 'send: switch the remote session to this model (default: it keeps its own). update_session: the session\'s model from now on. '
        + 'Must be an id relay_info lists for the provider (Claude also takes "opus", "sonnet", "haiku"): '
        + 'an unknown id is refused with the close matches, nothing created or sent.',
    },
    cwd: {
      type: 'string',
      description: 'create_session: working directory on the target relay (default: its default workspace). update_session: the '
        + 'session\'s working directory from now on; its CLI restarts there (refused while a turn or a background task runs). Not for claude-cloud.',
    },
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
      description: 'send / create_session: relay mode for the remote turn (default: this session\'s mode). '
        + 'update_session: the session\'s mode from now on.',
    },
    effort: {
      type: 'string',
      description: 'send / create_session: reasoning effort for the remote turn, e.g. low, medium, high (relay_info lists '
        + 'what each model takes). create_session default: this session\'s effort when the remote model supports it, '
        + 'else the remote\'s default. send default: the remote session keeps its own. update_session: the session\'s '
        + 'effort from now on (one its model takes).',
    },
    title: {
      type: 'string',
      description: 'create_session: session title (default: from the prompt). update_session: the new title. '
        + 'schedule: a short name for the schedule.',
    },
    group: {
      type: 'string',
      description: 'create_session: an existing session group on the target relay to put the new session in: its id (grp_…) '
        + 'or its exact name, case-insensitive (relay_info lists them). Default: a session started on this relay joins '
        + 'your own group, one on a paired relay none. An unknown group is refused with the groups there, nothing created. '
        + `update_session: move the session into a group (id or name; a name the relay does not have yet makes a new group) or out of its group ("${REMOTE_RELAY_NO_GROUP}"). `
        + 'A group the owner made is never removed this way: it stays, empty if the session was its last member; one update_session made goes once empty. '
        + 'Renaming and dissolving groups is the owner\'s.',
    },
    auto_compact_window: {
      type: 'integer',
      minimum: 0,
      description: 'update_session: how many tokens of context a Claude session gathers before it compacts '
        + `(${AUTO_COMPACT_WINDOW_STOPS.filter(Boolean).join(', ')}; other numbers go to the nearest), or 0 for the model default.`,
    },
    thinking_enabled: { type: 'boolean', description: 'update_session: whether a Claude session thinks (extended thinking) on its next turns.' },
    thinking_display: {
      type: 'string',
      enum: [...THINKING_DISPLAY_MODES],
      description: 'update_session: whether a Claude session\'s thinking text shows in its transcript (summarized) or not (omitted).',
    },
    question_id: { type: 'string', description: 'answer_question: id from pendingQuestions. withdraw: the id ask returned.' },
    question: {
      type: 'string',
      maxLength: RELAY_ASK_LIMITS.questionMax,
      description: `ask: the question for the user, at most ${RELAY_ASK_LIMITS.questionMax} characters (background goes in detail).`,
    },
    options: {
      type: 'array',
      items: { type: 'string' },
      maxItems: RELAY_ASK_LIMITS.optionsMax,
      description: `ask: up to ${RELAY_ASK_LIMITS.optionsMax} short answer labels shown as buttons (the user may also type an answer).`,
    },
    recommendation: { type: 'string', description: 'ask: the answer you recommend: one of the options, or free text.' },
    detail: {
      type: 'string',
      maxLength: RELAY_ASK_LIMITS.detailMax,
      description: `ask: background for the user, shown folded, at most ${RELAY_ASK_LIMITS.detailMax} characters (plain text).`,
    },
    urgency: {
      type: 'string',
      enum: [...RELAY_ASK_URGENCIES],
      description: 'ask: normal (default), or now to send the user a push notification as well.',
    },
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
    sessions: {
      type: 'array',
      items: { type: 'string' },
      description: 'subscribe: the session ids to watch, or ["all"] for every session of the relay (later ones too); '
        + 'not needed when events names only relay_restarted.',
    },
    events: {
      type: 'array',
      items: { type: 'string', enum: [...RELAY_EVENT_SUBSCRIBABLE_TYPES] },
      description: 'subscribe: which events (default: all but task_started, task_finished and relay_restarted, with subagent_finished: '
        + 'a shell command that ended well wakes you only when you name task_finished; relay_restarted wakes you when this relay runs again).',
    },
    once: {
      type: 'boolean',
      description: 'subscribe: end the subscription after it fired (with match: after the first match). '
        + 'schedule: fire once and end (default true with at alone, false with every_minutes).',
    },
    match: {
      type: 'string',
      description: 'subscribe: a regular expression (case-insensitive) a turn_end reply or a task summary must match; other events pass.',
    },
    stalled_minutes: {
      type: 'integer',
      minimum: RELAY_EVENT_LIMITS.stalledMinutesMin,
      maximum: RELAY_EVENT_LIMITS.stalledMinutesMax,
      description: `subscribe: quiet minutes while work runs before "stalled" (default ${RELAY_EVENT_LIMITS.stalledMinutesDefault}).`,
    },
    heartbeat_minutes: {
      type: 'integer',
      minimum: RELAY_EVENT_LIMITS.heartbeatMinutesMin,
      maximum: RELAY_EVENT_LIMITS.heartbeatMinutesMax,
      description: 'subscribe: a heartbeat event every N minutes while a watched turn or task runs (default: none).',
    },
    digest_minutes: {
      type: 'integer',
      minimum: RELAY_EVENT_LIMITS.digestMinutesMin,
      maximum: RELAY_EVENT_LIMITS.digestMinutesMax,
      description: 'subscribe: gather this subscription\'s events into one message every N minutes '
        + '(questions and errors still come at once; default: none).',
    },
    quiet_hours: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start, "HH:MM" local time.' },
        to: { type: 'string', description: 'End, "HH:MM" local time (may be past midnight).' },
        tz: { type: 'string', description: 'IANA time zone, e.g. "Europe/Berlin".' },
      },
      required: ['from', 'to', 'tz'],
      description: 'subscribe: hold this subscription\'s events in this daily window and deliver them as one message '
        + 'when it ends (questions and errors still come at once; default: none).',
    },
    exclude: {
      type: 'array',
      items: { type: 'string' },
      maxItems: RELAY_EVENT_LIMITS.excludeMax,
      description: `subscribe with sessions ["all"]: session ids to leave out (at most ${RELAY_EVENT_LIMITS.excludeMax}).`,
    },
    subscription_id: { type: 'string', description: 'unsubscribe: the id subscribe returned, or "all".' },
    watcher: { type: 'string', description: 'list_subscriptions: another conversation\'s id, to see its subscriptions (default: this one).' },
    from: { type: 'string', description: 'transfer_subscriptions: the id of the conversation whose subscriptions move here.' },
    at: {
      type: 'string',
      description: 'schedule: when to queue the prompt, an ISO time with a zone (e.g. 2026-11-02T06:30:00Z); '
        + 'with every_minutes the first time.',
    },
    every_minutes: {
      type: 'integer',
      minimum: RELAY_SCHEDULE_LIMITS.everyMinutesMin,
      maximum: RELAY_SCHEDULE_LIMITS.everyMinutesMax,
      description: `schedule: repeat every N minutes (${RELAY_SCHEDULE_LIMITS.everyMinutesMin} to ${RELAY_SCHEDULE_LIMITS.everyMinutesMax}); `
        + 'the first time is at, else N minutes from now.',
    },
    schedule_id: { type: 'string', description: 'unschedule: the id schedule or list_schedules returned.' },
    task_id: { type: 'string', description: 'read_task_output: the background task\'s id (taskId in read_session\'s tasks).' },
    lines: {
      type: 'integer',
      minimum: 1,
      maximum: REMOTE_RELAY_LIMITS.taskOutputLinesMax,
      description: `read_task_output: how many of the last output lines (default ${REMOTE_RELAY_LIMITS.taskOutputLinesDefault}).`,
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

const SESSION_ACTIONS = new Set(['read_session', 'read_task_output', 'wait', 'send', 'update_session', 'stop', 'archive']);

// Actions that refuse an argument they do not take (nothing is changed),
// where the others name it in `ignored`.
const STRICT_ARGUMENT_ACTIONS = new Set(['create_session', 'update_session']);

// The arguments each action reads besides `action` and `relay`, including what
// the first check hands the second (subscribe's `scope: "all"`). Anything else
// is refused by create_session and update_session and listed as `ignored` by
// the others.
export const REMOTE_RELAY_ACTION_ARGUMENTS = Object.freeze({
  list_relays: Object.freeze([]),
  relay_info: Object.freeze([]),
  usage: Object.freeze([]),
  list_sessions: Object.freeze(['scope', 'limit', 'query', 'cursor']),
  read_session: Object.freeze(['session', 'last', 'before', 'include_activity', 'max_chars']),
  read_task_output: Object.freeze(['session', 'task_id', 'lines']),
  wait: Object.freeze(['session', 'message_id', 'wait_seconds']),
  send: Object.freeze(['session', 'text', 'wait_seconds', 'model', 'mode', 'effort', 'if_busy']),
  create_session: Object.freeze(['text', 'provider', 'model', 'cwd', 'repo', 'branch', 'mode', 'effort', 'title', 'group', 'wait_seconds']),
  update_session: Object.freeze(['session', ...REMOTE_RELAY_SESSION_SETTINGS]),
  answer_question: Object.freeze(['question_id', 'answer', 'choices']),
  stop: Object.freeze(['session']),
  archive: Object.freeze(['session']),
  subscribe: Object.freeze([
    'sessions', 'session', 'scope', 'events', 'once', 'match', 'stalled_minutes', 'heartbeat_minutes', 'digest_minutes', 'quiet_hours', 'exclude',
  ]),
  unsubscribe: Object.freeze(['subscription_id']),
  list_subscriptions: Object.freeze(['watcher']),
  transfer_subscriptions: Object.freeze(['from']),
  schedule: Object.freeze(['session', 'text', 'at', 'every_minutes', 'once', 'title']),
  list_schedules: Object.freeze(['session']),
  unschedule: Object.freeze(['schedule_id']),
  ask: Object.freeze(['session', 'question', 'options', 'recommendation', 'detail', 'urgency']),
  list_questions: Object.freeze(['session']),
  withdraw: Object.freeze(['question_id']),
});

const IGNORED_ARGUMENTS_MAX = 20;

// Some providers send every property of the schema, empty ones as null, '' or
// false: such a value is no argument.
function isEmptyArgument(value) {
  if (value === undefined || value === null || value === false) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  // An object property (quiet_hours) sent with every field empty.
  if (typeof value === 'object') return Object.values(value).every(isEmptyArgument);
  return false;
}

/** The keys of `input` the action does not take (empty values left out), sorted and capped. */
function argumentsNotTaken(action, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const taken = new Set(['action', 'relay', ...(REMOTE_RELAY_ACTION_ARGUMENTS[action] || [])]);
  return Object.keys(input)
    .filter((key) => !taken.has(key) && !isEmptyArgument(input[key]))
    .sort()
    .slice(0, IGNORED_ARGUMENTS_MAX)
    .map((key) => key.slice(0, 60));
}

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
 *
 * An argument the action does not take is never dropped in silence:
 * create_session and update_session refuse it (nothing is created or
 * changed), every other action lists it in `ignored` on the result, which the
 * caller passes on to the agent.
 */
export function validateRemoteRelayToolInput(input = {}, options = {}) {
  const action = toText(input?.action).toLowerCase();
  const notTaken = REMOTE_RELAY_ACTIONS.includes(action) ? argumentsNotTaken(action, input) : [];
  if (STRICT_ARGUMENT_ACTIONS.has(action) && notTaken.length) {
    const ownerOnly = action === 'update_session' && notTaken.some((key) => /^may_?create_?sessions$/i.test(key))
      ? ' Whether a session may start sessions is the owner\'s setting alone.'
      : '';
    return invalid(`${action} does not take: ${notTaken.join(', ')}. Its arguments: relay, ${REMOTE_RELAY_ACTION_ARGUMENTS[action].join(', ')}.${ownerOnly} Nothing was ${action === 'create_session' ? 'created' : 'changed'}.`);
  }
  const result = validateToolInput(input, options);
  return notTaken.length ? { ...result, ignored: notTaken } : result;
}

function validateToolInput(input, { maxWaitSeconds, now } = {}) {
  const action = toText(input?.action).toLowerCase();
  if (!REMOTE_RELAY_ACTIONS.includes(action)) {
    return invalid(`action must be one of: ${REMOTE_RELAY_ACTIONS.join(', ')}`);
  }
  if (action === 'list_relays') return { ok: true, action, args: {} };

  const args = {};
  const relayOptional = REMOTE_RELAY_EVENT_ACTIONS.includes(action)
    || REMOTE_RELAY_SCHEDULE_ACTIONS.includes(action)
    || REMOTE_RELAY_ASK_ACTIONS.includes(action);
  const relay = toText(input?.relay) || (relayOptional ? REMOTE_RELAY_LOCAL_ALIAS : '');
  if (!relay) return invalid(`${action} needs relay (a name from list_relays)`);
  args.relay = relay;
  if (REMOTE_RELAY_EVENT_ACTIONS.includes(action)) return validateEventAction(action, input, args);
  if (REMOTE_RELAY_SCHEDULE_ACTIONS.includes(action)) return validateScheduleAction(action, input, args, { now });
  if (REMOTE_RELAY_ASK_ACTIONS.includes(action)) return validateAskAction(action, input, args);

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
  } else if (action === 'read_task_output') {
    const taskId = toText(input?.task_id);
    if (!taskId) return invalid('read_task_output needs task_id (a taskId from read_session\'s tasks)');
    if (taskId.length > 200 || /[\s/\\]/.test(taskId)) return invalid('task_id is not a task id');
    args.task_id = taskId;
    const lines = clampInteger(input?.lines, {
      min: 1,
      max: REMOTE_RELAY_LIMITS.taskOutputLinesMax,
      fallback: REMOTE_RELAY_LIMITS.taskOutputLinesDefault,
    });
    if (lines === null) return invalid('lines must be a number');
    args.lines = lines;
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
      // An empty group is no group: the default grouping applies.
      if (input?.group !== undefined && input?.group !== null && typeof input.group !== 'string') {
        return invalid('group must be text: a group id (grp_…) or a group name from relay_info');
      }
      optionalText('group', 200);
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
  } else if (action === 'update_session') {
    const settings = validateRemoteRelaySessionSettings(input);
    if (!settings.ok) return settings;
    Object.assign(args, settings.values);
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

function readBoolean(value) {
  if (value === true || value === false) return value;
  const text = toText(value).toLowerCase();
  if (['true', 'on', '1'].includes(text)) return true;
  if (['false', 'off', '0'].includes(text)) return false;
  return null;
}

/**
 * update_session's settings, each checked for its shape: `{ ok, values }`
 * with the ones the call names, or `{ ok:false }`. A setting left empty (null,
 * '') is not named, except `group: null`, which takes the session out of its
 * group like "none". The values come out in a form this check takes again
 * (the worker's tool and the relay both run it). Whether the model and the
 * effort exist there, and what a window snaps to, is the relay's to say.
 */
export function validateRemoteRelaySessionSettings(input) {
  const values = {};
  const text = (key, max) => {
    const value = input?.[key];
    if (value === undefined || value === null) return { ok: true };
    if (typeof value !== 'string') return invalid(`${key} must be text`);
    if (value.trim()) values[key] = value.trim().slice(0, max);
    return { ok: true };
  };
  for (const [key, max] of [['model', 200], ['title', 200], ['cwd', 1000]]) {
    const check = text(key, max);
    if (!check.ok) return check;
  }
  const mode = toText(input?.mode).toLowerCase();
  if (mode) {
    if (!REMOTE_RELAY_MODES.includes(mode)) return invalid(`mode must be one of: ${REMOTE_RELAY_MODES.join(', ')}`);
    values.mode = mode;
  }
  const effort = toText(input?.effort).toLowerCase();
  if (effort) {
    if (!REMOTE_RELAY_EFFORT_PATTERN.test(effort)) {
      return invalid('effort must be a short word such as low, medium or high (letters, digits and dashes, at most 32 characters)');
    }
    values.effort = effort;
  }
  const window = input?.auto_compact_window;
  if (window !== undefined && window !== null && toText(window) !== '') {
    const word = toText(window).toLowerCase();
    const number = Number(window);
    // A boolean is no window (false is not 0).
    if (typeof window === 'boolean') return invalid('auto_compact_window must be a number of tokens (such as 200000), or 0 for the model default');
    if (word === 'auto' || number === 0) values.auto_compact_window = 'auto';
    else if (Number.isFinite(number) && number > 0) values.auto_compact_window = Math.trunc(number);
    else return invalid('auto_compact_window must be a number of tokens (such as 200000), or 0 for the model default');
  }
  if (Object.prototype.hasOwnProperty.call(input || {}, 'group')) {
    const group = input.group;
    if (group === null) {
      values.group = null;
    } else if (typeof group !== 'string') {
      return invalid(`group must be text: a group id (grp_…) or name, or "${REMOTE_RELAY_NO_GROUP}" to take the session out of its group`);
    } else if (group.trim()) {
      values.group = group.trim().toLowerCase() === REMOTE_RELAY_NO_GROUP ? null : group.trim().slice(0, 200);
    }
  }
  const thinking = input?.thinking_enabled;
  if (thinking !== undefined && thinking !== null && toText(thinking) !== '') {
    const enabled = readBoolean(thinking);
    if (enabled === null) return invalid('thinking_enabled must be true or false');
    values.thinking_enabled = enabled;
  }
  const display = toText(input?.thinking_display).toLowerCase();
  if (display) {
    if (!THINKING_DISPLAY_MODES.includes(display)) return invalid(`thinking_display must be one of: ${THINKING_DISPLAY_MODES.join(', ')}`);
    values.thinking_display = display;
  }
  if (!Object.keys(values).length) {
    return invalid(`update_session needs at least one setting to change: ${REMOTE_RELAY_SESSION_SETTINGS.join(', ')}`);
  }
  return { ok: true, values };
}

function optionalMinutes(input, key, { min, max }) {
  const raw = input?.[key];
  if (raw === undefined || raw === null || toText(raw) === '') return { ok: true, value: null };
  const number = Number(raw);
  if (!Number.isFinite(number)) return invalid(`${key} must be a number of minutes`);
  return { ok: true, value: Math.min(max, Math.max(min, Math.trunc(number))) };
}

function validateEventAction(action, input, args) {
  if (action === 'subscribe') {
    let sessions = input?.sessions;
    if (typeof sessions === 'string') sessions = sessions.split(',');
    const ids = [
      ...(Array.isArray(sessions) ? sessions : []),
      ...(toText(input?.session) ? [input.session] : []),
    ].map(toText).filter(Boolean);
    // `scope: "all"` is how this check hands ["all"] on. A call is checked
    // twice, by the worker's tool and again by the relay that receives what
    // the tool sent, so the second check must take the first one's output.
    const scopeAll = toText(input?.scope).toLowerCase() === 'all';
    if (scopeAll && ids.some((id) => id.toLowerCase() !== 'all')) {
      return invalid('sessions is either ["all"] or a list of session ids, not both');
    }
    if (scopeAll && !ids.length) ids.push('all');
    const all = ids.some((id) => id.toLowerCase() === 'all');
    if (all && ids.length > 1) return invalid('sessions is either ["all"] or a list of session ids, not both');
    if (input?.events !== undefined && input?.events !== null) {
      const events = (Array.isArray(input.events) ? input.events : String(input.events).split(','))
        .map((event) => toText(event).toLowerCase())
        .filter(Boolean);
      const unknown = events.filter((event) => !RELAY_EVENT_SUBSCRIBABLE_TYPES.includes(event));
      if (unknown.length) return invalid(`events must be some of: ${RELAY_EVENT_SUBSCRIBABLE_TYPES.join(', ')} (not ${unknown.join(', ')})`);
      if (events.length) args.events = [...new Set(events)];
    }
    // relay_restarted alone watches no session.
    if (!ids.length && !isRelayLevelOnly(args.events)) {
      return invalid('subscribe needs sessions (ids from list_sessions) or ["all"], unless events names only relay_restarted');
    }
    if (ids.length > RELAY_EVENT_LIMITS.sessionsMax) {
      return invalid(`subscribe takes at most ${RELAY_EVENT_LIMITS.sessionsMax} sessions; use ["all"] for more`);
    }
    if (all) args.scope = 'all';
    else if (ids.length) args.sessions = [...new Set(ids)].map((id) => id.slice(0, 200));
    if (input?.once === true || toText(input?.once).toLowerCase() === 'true') args.once = true;
    const match = String(input?.match ?? '');
    if (match.trim()) {
      const compiled = compileRelayEventMatch(match);
      if (!compiled.ok) return invalid(compiled.error);
      args.match = match;
    }
    const stalled = optionalMinutes(input, 'stalled_minutes', { min: RELAY_EVENT_LIMITS.stalledMinutesMin, max: RELAY_EVENT_LIMITS.stalledMinutesMax });
    if (!stalled.ok) return stalled;
    if (stalled.value !== null) args.stalled_minutes = stalled.value;
    const heartbeat = optionalMinutes(input, 'heartbeat_minutes', { min: RELAY_EVENT_LIMITS.heartbeatMinutesMin, max: RELAY_EVENT_LIMITS.heartbeatMinutesMax });
    if (!heartbeat.ok) return heartbeat;
    if (heartbeat.value !== null) args.heartbeat_minutes = heartbeat.value;
    const digest = optionalMinutes(input, 'digest_minutes', { min: RELAY_EVENT_LIMITS.digestMinutesMin, max: RELAY_EVENT_LIMITS.digestMinutesMax });
    if (!digest.ok) return digest;
    if (digest.value !== null) args.digest_minutes = digest.value;
    const quiet = normalizeRelayEventQuietHours(input?.quiet_hours);
    if (!quiet.ok) return invalid(quiet.error);
    if (quiet.value) args.quiet_hours = quiet.value;
    let exclude = input?.exclude;
    if (typeof exclude === 'string') exclude = exclude.split(',');
    if (exclude !== undefined && exclude !== null && !Array.isArray(exclude)) return invalid('exclude must be a list of session ids');
    const excluded = [...new Set((exclude || []).map(toText).filter(Boolean))];
    if (excluded.length) {
      if (!all) return invalid('exclude goes with sessions ["all"] only; a list of sessions names what it watches');
      if (excluded.length > RELAY_EVENT_LIMITS.excludeMax) return invalid(`exclude takes at most ${RELAY_EVENT_LIMITS.excludeMax} sessions`);
      args.exclude = excluded.map((id) => id.slice(0, 200));
    }
  } else if (action === 'unsubscribe') {
    const id = toText(input?.subscription_id);
    if (!id) return invalid('unsubscribe needs subscription_id (from subscribe or list_subscriptions), or "all"');
    args.subscription_id = id.slice(0, 100);
  } else if (action === 'list_subscriptions') {
    const watcher = toText(input?.watcher);
    if (watcher) args.watcher = watcher.slice(0, 200);
  } else if (action === 'transfer_subscriptions') {
    const from = toText(input?.from);
    if (!from) return invalid('transfer_subscriptions needs from (the id of the conversation whose subscriptions move here)');
    args.from = from.slice(0, 200);
  }
  return { ok: true, action, args };
}

function optionalBoolean(value) {
  if (value === true || value === false) return value;
  const text = toText(value).toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return undefined;
}

function validateScheduleAction(action, input, args, { now = Date.now() } = {}) {
  const session = toText(input?.session);
  if (action === 'schedule') {
    if (session) args.session = session.slice(0, 200);
    const text = toText(input?.text);
    if (!text) return invalid('schedule needs text (the prompt to queue)');
    if (text.length > RELAY_SCHEDULE_LIMITS.textMax) return invalid(`text is longer than ${RELAY_SCHEDULE_LIMITS.textMax} characters`);
    args.text = text;
    const at = normalizeRelayScheduleAt(input?.at, { now });
    if (!at.ok) return invalid(at.error);
    const rawEvery = input?.every_minutes;
    let every = null;
    if (rawEvery !== undefined && rawEvery !== null && toText(rawEvery) !== '') {
      const number = Number(rawEvery);
      const { everyMinutesMin: min, everyMinutesMax: max } = RELAY_SCHEDULE_LIMITS;
      if (!Number.isInteger(number) || number < min || number > max) {
        return invalid(`every_minutes must be a whole number of minutes from ${min} to ${max}`);
      }
      every = number;
    }
    if (!at.value && every === null) return invalid('schedule needs at (an ISO time) or every_minutes');
    const once = optionalBoolean(input?.once);
    if (once === false && every === null) return invalid('a schedule that repeats needs every_minutes');
    if (at.value) args.at = at.value;
    if (every !== null) args.every_minutes = every;
    args.once = once ?? every === null;
    const title = normalizeRelayScheduleTitle(input?.title);
    if (title) args.title = title;
  } else if (action === 'list_schedules') {
    if (session) args.session = session.slice(0, 200);
  } else if (action === 'unschedule') {
    const id = toText(input?.schedule_id);
    if (!id) return invalid('unschedule needs schedule_id (from schedule or list_schedules)');
    args.schedule_id = id.slice(0, 100);
  }
  return { ok: true, action, args };
}

function validateAskAction(action, input, args) {
  const session = toText(input?.session);
  if (action === 'ask') {
    if (session) args.session = session.slice(0, 200);
    const checked = normalizeRelayAskInput(input);
    if (!checked.ok) return invalid(checked.error);
    args.question = checked.value.question;
    if (checked.value.options.length) args.options = checked.value.options;
    if (checked.value.recommendation) args.recommendation = checked.value.recommendation;
    if (checked.value.detail) args.detail = checked.value.detail;
    args.urgency = checked.value.urgency;
  } else if (action === 'list_questions') {
    if (session) args.session = session.slice(0, 200);
  } else if (action === 'withdraw') {
    const id = toText(input?.question_id);
    if (!id) return invalid('withdraw needs question_id (the id ask returned)');
    args.question_id = id.slice(0, 100);
  }
  return { ok: true, action, args };
}

const PERMISSION_RANK = { read: 1, prompt: 2, full: 3 };

export function normalizeRemoteRelayPermission(value) {
  const permission = toText(value).toLowerCase();
  return REMOTE_RELAY_PERMISSIONS.includes(permission) ? permission : REMOTE_RELAY_DEFAULT_PERMISSION;
}

/** True when a remote with `permission` allows `action` (`ownSession`: see remoteRelayActionPermission). */
export function remoteRelayPermissionAllows(permission, action, { ownSession = false } = {}) {
  if (!Object.prototype.hasOwnProperty.call(REMOTE_RELAY_ACTION_PERMISSION, action)) return false;
  const needed = remoteRelayActionPermission(action, { ownSession });
  if (needed === null) return true;
  return (PERMISSION_RANK[normalizeRemoteRelayPermission(permission)] || 0) >= PERMISSION_RANK[needed];
}

export function isRemoteRelayWriteAction(action) {
  return REMOTE_RELAY_WRITE_ACTIONS.includes(action);
}

export function isRemoteRelayPromptAction(action) {
  return REMOTE_RELAY_PROMPT_ACTIONS.includes(action);
}

// ─── Session groups ──────────────────────────────────────────────────────────

// How many groups relay_info lists, and how many an unknown-group refusal names.
export const REMOTE_RELAY_GROUP_LIMITS = Object.freeze({ listMax: 50, refusalMax: 20 });

function groupNameKey(value) {
  return toText(value).replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The group a create_session `group` names among `groups` (`[{ id, name }]`,
 * `name` being what the owner's sidebar shows): the id itself, else the one
 * group with that name (case-insensitive). The relay that creates the session
 * and the relay that asks both decide with this. Returns
 * `{ status: 'found', group }`, `{ status: 'unknown' }` or
 * `{ status: 'ambiguous', matches }`.
 */
export function resolveSessionGroupReference(groups, reference) {
  const list = (Array.isArray(groups) ? groups : []).filter((group) => toText(group?.id));
  const wanted = toText(reference);
  if (!wanted) return { status: 'unknown' };
  const byId = list.find((group) => toText(group.id) === wanted);
  if (byId) return { status: 'found', group: byId };
  const key = groupNameKey(wanted);
  const matches = list.filter((group) => groupNameKey(group.name) === key);
  if (matches.length === 1) return { status: 'found', group: matches[0] };
  return matches.length ? { status: 'ambiguous', matches } : { status: 'unknown' };
}

/**
 * `Alpha (grp_…), Beta (grp_…) and 3 more`, at most `max` named. `total` is
 * how many there are when `groups` is already a capped list.
 */
export function formatSessionGroupList(groups, max = REMOTE_RELAY_GROUP_LIMITS.refusalMax, total = null) {
  const list = Array.isArray(groups) ? groups : [];
  const named = list.slice(0, max).map((group) => `${toText(group?.name).replace(/[\r\n]+/g, ' ') || 'Group'} (${toText(group?.id)})`);
  const count = Number.isInteger(total) && total > list.length ? total : list.length;
  const more = count - named.length;
  return `${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
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
  let text = input?.text ? `: “${clip(input.text, 60)}”` : '';
  if (action === 'subscribe') {
    const sessions = Array.isArray(input?.sessions) ? input.sessions.map(toText).filter(Boolean) : [];
    text = sessions.some((id) => id.toLowerCase() === 'all')
      ? ': all sessions'
      : (sessions.length ? `: ${sessions.length} session${sessions.length === 1 ? '' : 's'}` : text);
  } else if (action === 'transfer_subscriptions' && toText(input?.from)) {
    text = `: from session ${toText(input.from).slice(0, 8)}`;
  } else if (action === 'update_session') {
    const named = REMOTE_RELAY_SESSION_SETTINGS.filter((key) => (key === 'group' && input?.group === null)
      || (input?.[key] !== undefined && input?.[key] !== null && toText(input[key]) !== ''));
    text = named.length ? `: ${named.join(', ')}` : '';
  } else if (action === 'schedule') {
    const every = Number(input?.every_minutes);
    const when = [toText(input?.at) ? `at ${toText(input.at)}` : '', every > 0 ? `every ${every} min` : ''].filter(Boolean).join(', ');
    const title = toText(input?.title) ? `“${clip(input.title, 40)}”` : '';
    text = when || title ? `: ${[when, title].filter(Boolean).join(' ')}` : text;
  } else if (action === 'unschedule' && toText(input?.schedule_id)) {
    text = `: ${toText(input.schedule_id).slice(0, 40)}`;
  } else if (action === 'ask' && toText(input?.question)) {
    text = `: “${clip(input.question, 60)}”${toText(input?.urgency).toLowerCase() === 'now' ? ' (now)' : ''}`;
  } else if (action === 'withdraw' && toText(input?.question_id)) {
    text = `: ${toText(input.question_id).slice(0, 40)}`;
  }
  return target ? `${action} → ${target}${text}` : `${action}${text}`;
}
