// Which principal may call which API route (agent auth, §2.2).
//
// The owner token and browser sessions (the person) may call every route
// behind `auth`. This table says what the other principals may do:
//
//   agent  an agent token (OAR_AGENT_TOKEN): one session's, or the cli one
//   peer   a paired relay's key (`oarp1_…`, origin binding): exactly the
//          routes in REMOTE_RELAY_PEER_ROUTES (shared/remote-relay-contract.mjs)
//
// Values: 'allow', 'deny' (403 AUTH_PERSON_REQUIRED / REMOTE_RELAY_PEER_SCOPE) or
// 'row' (allowed past `auth`; the route decides per request, e.g. only the
// agent's own conversation, only a queued restart).
//
// Deny by default: a route missing here is person-only. `auth` looks routes
// up by method and Express pattern (`req.route.path`), and a test walks the
// router and fails on any route behind `auth` that is not listed, and on any
// listed route that no longer exists.

export const ROUTE_ACCESS = Object.freeze({ allow: 'allow', deny: 'deny', row: 'row' });
export const AUTH_ERROR_CODES = Object.freeze({
  personRequired: 'AUTH_PERSON_REQUIRED',
  // A paired relay's key outside its routes: the remote-relay code.
  peerScope: 'REMOTE_RELAY_PEER_SCOPE',
  crossSite: 'AUTH_CROSS_SITE',
  unauthorized: 'AUTH_REQUIRED',
  // A browser whose session cookie no longer counts (revoked, expired, or
  // the owner token it held was replaced).
  signedOut: 'AUTH_SIGNED_OUT',
  // A request with the session cookie but without the session's proof key
  // (X-OAR-Session-Proof): a page on another port of the host, which gets
  // the cookie but not the key, or a browser whose site data was cleared.
  sessionProof: 'AUTH_SESSION_PROOF',
  // A browser from before sessions (the owner token in its cookie): not
  // signed out, its page trades the cookie at POST /api/auth/session and
  // tries again.
  cookieUpgrade: 'AUTH_COOKIE_UPGRADE',
  // That trade, a second time within moments (another tab of the browser):
  // the first trade's session and key are on their way to the browser.
  upgradePending: 'AUTH_UPGRADE_PENDING',
  // A session's agent token used for another conversation (relay_tool).
  conversationMismatch: 'AUTH_CONVERSATION_MISMATCH',
  // An agent starting a session past relay_tool (and its rules).
  relayToolRequired: 'AUTH_RELAY_TOOL_REQUIRED',
  // A file capability (`k`) that is expired, for another file or another
  // session, or whose session was signed out: the page asks for a new one.
  fileCapability: 'AUTH_FILE_CAPABILITY',
  // The relay's own secrets, database or config: no file route serves them.
  protectedFile: 'FILE_PROTECTED',
});
export const AUTH_PERSON_REQUIRED_MESSAGE = 'Only the person signed in to this relay can do this; an agent token is not enough. Ask the user to do it in the relay UI.';
export const AUTH_ANSWER_PERSON_REQUIRED_MESSAGE = 'Only the person can answer questions; ask them in the relay UI.';
export const AUTH_CROSS_SITE_MESSAGE = 'Refused: this request came from another site. Use the relay\'s own page.';
export const AUTH_SIGNED_OUT_MESSAGE = 'This browser was signed out. Sign in again with the relay token or a sign-in code.';
export const AUTH_SESSION_PROOF_MESSAGE = 'This browser is not signed in here (the session\'s key is missing). Sign in again with the relay token or a sign-in code.';
export const AUTH_COOKIE_UPGRADE_MESSAGE = 'This browser signed in before browser sessions: its page trades the cookie at POST /api/auth/session first.';
export const AUTH_UPGRADE_PENDING_MESSAGE = 'This browser\'s cookie was traded for a session a moment ago (another tab); its session key is on its way.';
export const AUTH_RELAY_TOOL_REQUIRED_MESSAGE = 'An agent starts a session with relay_tool create_session (relay "this"), where this relay\'s rules for agents apply: whether this session may start sessions, the number running, and the owner\'s Allow.';
export const AUTH_FILE_CAPABILITY_MESSAGE = 'This file link is no longer valid (expired, for another file, or its browser session was signed out). Open the file again.';
export const FILE_PROTECTED_MESSAGE = 'Refused: OAR\'s file routes never read, change, move or delete the relay\'s own secrets file, database or config, or a folder holding them.';
export const AUTH_AGENT_TOKEN_HINT ='The relay token is no longer in the config; use OAR_AGENT_TOKEN';

// The peer column is enforced: a paired relay's key opens its routes only.
export const PEER_COLUMN_ENFORCED = true;

const A = ROUTE_ACCESS.allow;
const D = ROUTE_ACCESS.deny;
const R = ROUTE_ACCESS.row;

// [method, Express route pattern, agent, peer]
const TABLE = [
  // ── Reads: conversations, sessions, context, search, status, models, usage
  ['GET', '/api/conversations', A, A],
  ['GET', '/api/sessions', A, D],
  ['GET', '/api/conversation/:id', A, A],
  ['GET', '/api/context/:conversationId', A, D],
  ['GET', '/api/context', A, D],
  ['GET', '/api/search/messages', A, D],
  ['GET', '/api/status', A, A],
  ['GET', '/api/status/events', A, D],
  ['GET', '/api/models', A, A],
  ['GET', '/api/model-variants', A, D],
  ['GET', '/api/model-refresh-settings', A, D],
  ['GET', '/api/usage', A, A],
  ['GET', '/api/usage-limit', A, A],
  ['GET', '/api/image-usage', A, A],
  ['GET', '/api/about', A, D],
  ['GET', '/api/relay/identity', A, A],
  ['GET', '/api/relay/shutdown', A, D],
  ['GET', '/api/conversation/:conversationId/subagent/:subagentRunId', A, D],
  ['GET', '/api/conversation/:conversationId/background-task/:taskId/output', A, A],
  ['GET', '/api/media', A, D],
  ['GET', '/api/media/counts', A, D],
  ['GET', '/api/media/facets', A, D],
  ['GET', '/api/media/:id/content', A, D],
  ['GET', '/api/upload/:sha256/content', A, D],
  ['GET', '/api/generated-image/:conversationId/:messageId/:imageId/content', A, D],
  ['GET', '/api/generated-image/:conversationId/:messageId/partials/:fileName', A, D],
  ['GET', '/api/agent-sdks/status', A, D],
  ['GET', '/api/cli/status', A, D],
  ['GET', '/api/update/state', A, D],
  ['GET', '/api/host/suspend', A, D],
  ['GET', '/api/restart-orchestrator', A, D],
  ['GET', '/api/workspace-root/attribution', A, D],
  ['GET', '/api/claude-cloud/repos', A, D],
  ['GET', '/api/claude-cloud/branches', A, D],

  // ── Settings reads (relay_tool reads provider settings)
  ['GET', '/api/settings/openai', A, A],
  ['GET', '/api/settings/copilot', A, A],
  ['GET', '/api/settings/claude', A, A],
  ['GET', '/api/settings/grok', A, A],
  ['GET', '/api/settings/cursor', A, A],
  ['GET', '/api/settings/deepseek', A, A],
  ['GET', '/api/settings/claude-api', A, A],
  ['GET', '/api/settings/claude-cloud', A, A],
  ['GET', '/api/settings/turn-ceiling', A, D],
  ['GET', '/api/settings/subagent-record-retention', A, D],
  ['GET', '/api/settings/share-path-privacy', A, D],
  ['GET', '/api/settings/background-task-timeout', A, D],
  ['GET', '/api/settings/task-stall-minutes', A, D],
  ['GET', '/api/settings/restart-resume', A, D],
  ['GET', '/api/settings/pwa-app-name', A, D],
  ['GET', '/api/settings/features', A, D],
  ['GET', '/api/settings/windows-autostart', A, D],
  ['GET', '/api/settings/cursor-allowance', A, D],
  ['GET', '/api/settings/cursor-dashboard-token', A, D],
  ['GET', '/api/settings/grok-allowance', A, D],
  ['GET', '/api/settings/relay-restart-max-wait', A, D],
  ['GET', '/api/settings/shares', A, D],
  ['GET', '/api/claude/auth/status', A, D],
  ['GET', '/api/grok/auth/status', A, D],
  ['GET', '/api/openai-image-presets', A, A],

  // ── Prompt and session life (owner_approved ignored, plan-only and
  // mayCreateSessions held, as for a remote caller: decided in the routes)
  ['POST', '/api/message', R, A],
  ['POST', '/api/conversation/bootstrap', R, A],
  ['POST', '/api/conversation/:conversationId/cancel-turn', A, A],
  ['POST', '/api/conversation/:conversationId/cancel-queued-turn', A, D],
  ['POST', '/api/conversation/:conversationId/subagent/:subagentRunId/cancel', A, D],
  ['POST', '/api/conversation/:conversationId/background-task/:taskId/stop', A, D],
  ['POST', '/api/conversation/:id/archive', A, A],
  ['POST', '/api/conversation/:id/unarchive', A, D],
  ['POST', '/api/conversation/:id/compact', A, D],
  ['POST', '/api/conversation/:id/relaunch-with-workspace-root', A, D],
  ['POST', '/api/conversation/:id/workspace-root', A, D],
  ['POST', '/api/conversation/:id/refresh-history', A, D],
  ['POST', '/api/conversation/:id/billing', A, D],
  ['PATCH', '/api/conversation/:id', A, D],
  ['PATCH', '/api/conversation/:id/settings', R, R],
  ['PATCH', '/api/conversation/:id/preferences', R, D],
  ['PATCH', '/api/conversation/:id/draft', A, D],
  ['PATCH', '/api/conversation/:id/message/:messageId/pin', A, D],

  // ── Worker plumbing
  ['POST', '/api/response', A, D],
  ['POST', '/api/stream', A, D],
  ['POST', '/api/thought', A, D],
  ['POST', '/api/activity', A, D],
  ['POST', '/api/heartbeat', A, D],
  ['GET', '/api/pending', A, D],
  ['GET', '/api/control/active', A, D],
  ['POST', '/api/control/:controlId/result', A, D],
  ['POST', '/api/continuation-turn', A, D],
  ['POST', '/api/queue-consumed', A, D],
  ['POST', '/api/queue-cancelled', A, D],
  ['POST', '/api/requeue', A, D],
  ['POST', '/api/relay/recover-processing', A, D],
  ['POST', '/api/background-task-settled', A, D],
  ['POST', '/api/background-tasks', A, D],
  ['POST', '/api/background-tasks/:taskId/output-snapshot', A, D],
  ['POST', '/api/subagent-run', A, D],
  ['POST', '/api/subagent-timeline', A, D],
  ['POST', '/api/grok-native-session', A, D],
  ['POST', '/api/claude-native-session', A, D],
  ['POST', '/api/cursor-agent-id', A, D],
  ['POST', '/api/relay-session-link', A, D],
  ['POST', '/api/claude-context-usage', A, D],
  ['POST', '/api/cursor-context-usage', A, D],
  ['POST', '/api/grok-context-usage', A, D],
  ['POST', '/api/turn-token-usage', A, D],
  ['POST', '/api/claude-plan-usage', A, D],
  ['POST', '/api/claude-usage-limit', A, D],
  ['POST', '/api/claude-api-usage', A, D],
  ['POST', '/api/copilot-plan-usage', A, D],
  ['POST', '/api/cursor-plan-usage', A, D],
  ['POST', '/api/grok-plan-usage', A, D],
  ['POST', '/api/deepseek-plan-usage', A, D],
  ['POST', '/api/models/snapshot', A, D],
  ['POST', '/api/session-sync', A, D],
  ['POST', '/api/session-workspace-root', A, D],
  ['GET', '/api/sdk-session-delete/pending', A, D],
  ['POST', '/api/sdk-session-delete/result', A, D],
  ['POST', '/api/claude-cloud-session', A, D],
  ['GET', '/api/claude-cloud-session', A, D],
  ['POST', '/api/claude-cloud/login-nudge', A, D],
  ['POST', '/api/image-operations/:operationId/execute', A, D],
  ['POST', '/api/openai/images/generate', A, D],

  // ── Own cards; answering is the person's alone (every row, §0.1)
  ['GET', '/api/relay-questions', A, A],
  ['GET', '/api/relay-question/:id', A, A],
  ['POST', '/api/relay-question', A, D],
  ['POST', '/api/relay-question/:id/timeout', R, D],
  ['POST', '/api/relay-question/:id/answer', D, D],
  ['POST', '/api/relay-question/:id/dismiss', D, D],
  ['GET', '/api/relay-boards', A, D],
  ['GET', '/api/relay-board/:id', A, D],
  ['POST', '/api/relay-board', A, D],
  ['POST', '/api/relay-board/:id/action', D, D],

  // ── relay_tool, relay events and schedules
  ['POST', '/api/remote-relays/tool', A, D],
  ['GET', '/api/remote-relays/summary', A, D],
  ['GET', '/api/remote-relays/inflight', A, D],
  ['GET', '/api/relay-events/subscriptions', A, D],
  ['DELETE', '/api/relay-events/subscriptions/:id', A, D],
  ['GET', '/api/relay-schedules', A, D],
  ['DELETE', '/api/relay-schedules/:id', A, D],

  // ── Inbox: the person's
  ['GET', '/api/inbox', D, D],
  ['GET', '/api/relay-asks', D, D],
  ['POST', '/api/inbox/relays/:relayId/asks/:id/answer', D, D],
  ['POST', '/api/inbox/relays/:relayId/asks/:id/dismiss', D, D],

  // ── Paired relays' own routes (with peer keys: peer only)
  ['POST', '/api/relay-asks/remote/ask', D, A],
  ['POST', '/api/relay-asks/remote/status', D, A],
  ['POST', '/api/relay-asks/remote/withdraw', D, A],
  ['GET', '/api/relay-asks/remote/inbox', D, A],
  ['POST', '/api/relay-events/remote/subscribe', D, A],
  ['POST', '/api/relay-events/remote/pull', D, A],
  // Answering over the pairing ends (the asks show read-only there).
  ['POST', '/api/relay-asks/remote/answer', D, D],
  ['POST', '/api/relay-asks/remote/dismiss', D, D],
  // Peer keys: delivery, check, request. The owner may call them too (a
  // holder without a key asks on the token it holds).
  ['POST', '/api/remote-relays/peer-key', D, A],
  ['GET', '/api/remote-relays/peer-key/check', D, A],
  ['POST', '/api/remote-relays/peer-key/request', D, A],

  // ── Drives, files, repo, git, uploads (nothing beyond the agent's own shell)
  ['POST', '/api/upload', A, D],
  ['GET', '/api/files/{*splat}', A, D],
  ['GET', '/api/files-preview/{*splat}', A, D],
  ['GET', '/api/repo/tree', A, D],
  ['GET', '/api/repo/list', A, D],
  ['POST', '/api/repo/mkdir', A, D],
  ['POST', '/api/repo/rename', A, D],
  ['POST', '/api/repo/delete', A, D],
  ['GET', '/api/drives/roots', A, D],
  ['GET', '/api/drives/list', A, D],
  ['GET', '/api/drives/file', A, D],
  ['GET', '/api/drives/files-preview', A, D],
  ['POST', '/api/drives/mkdir', A, D],
  ['POST', '/api/drives/rename', A, D],
  ['POST', '/api/drives/delete', A, D],
  ['GET', '/api/session-root/list', A, D],
  ['GET', '/api/git/remote', A, D],
  ['GET', '/api/git/status', A, D],
  ['GET', '/api/git/diff', A, D],
  ['POST', '/api/git/pull', A, D],

  // ── Previews: the agent's own conversation only (decided in the routes)
  ['GET', '/api/previews', R, D],
  ['POST', '/api/previews', R, D],
  ['DELETE', '/api/previews/:token', R, D],

  // ── Conversation groups: reads; moving a session into an existing group
  // or out of one. Creating, renaming, deleting, stopping and archiving
  // groups are the person's.
  ['GET', '/api/conversation-groups', A, A],
  ['PUT', '/api/conversation/:id/group', R, D],
  ['DELETE', '/api/conversation/:id/group', A, D],

  // ── Restart: the queued restart only, and its cancel (§3.5)
  ['POST', '/api/relay/shutdown', R, D],
  ['POST', '/api/relay/shutdown/cancel', A, D],

  // ── `oar url --sign-in`: the cli token straight over loopback only (the
  // route refuses every other principal, the person included; §13.2, 2c)
  ['POST', '/api/auth/signin-codes/terminal', R, D],
];

// The cookie-only surface: GETs of content a browser loads by itself
// (<img>, <video>, a download in a new tab), which cannot carry the
// session's proof key header. Every other request with the session cookie
// needs the key (403 AUTH_SESSION_PROOF without it), GETs included. Each
// route here serves bytes the relay itself chose and names by id or hash
// (an upload, a generated image, an indexed media item): a page on another
// port of the host that replays the cookie can fetch those, and nothing
// else: no transcript, setting, card or secret, no file by path, no write.
// The media route is tag-gated besides: its ids count up, so it answers 404
// to any id without its tag `t` (server/services/media-tag.mjs).
// docs/security.md lists them; relay-route-policy-walk.test.mjs walks them.
export const COOKIE_ONLY_API_ROUTES = Object.freeze([
  'GET /api/upload/:sha256/content',
  'GET /api/generated-image/:conversationId/:messageId/:imageId/content',
  'GET /api/generated-image/:conversationId/:messageId/partials/:fileName',
  'GET /api/media/:id/content',
]);
const COOKIE_ONLY_KEYS = new Set(COOKIE_ONLY_API_ROUTES);

// The routes that read any file by its path. They are not cookie-only: a
// cookie request needs the proof key, or a file capability in the query
// (`k`, FILE_CAPABILITY_PARAM) that the page asked for with its key at
// POST /api/files/capability. A capability is an HMAC under a key only the
// relay holds, over the browser session's id, the exact path the route
// resolves and an expiry at most 10 minutes out (server/services/
// file-capability.mjs); it opens that one file for that session while the
// session lives, Range requests included, and only together with the
// session's own cookie. Whatever the credential, these routes never serve
// the relay's secrets file, its database files or its config.
export const FILE_CAPABILITY_API_ROUTES = Object.freeze([
  'GET /api/files/{*splat}',
  'GET /api/drives/file',
]);
const FILE_CAPABILITY_KEYS = new Set(FILE_CAPABILITY_API_ROUTES);
export const FILE_CAPABILITY_PARAM = 'k';
export const FILE_CAPABILITY_TTL_MS = 10 * 60_000;

// Registered without `auth`: public by design (shared links, their media).
// Listed so the router walk can tell them from a forgotten `auth`.
export const PUBLIC_API_ROUTES = Object.freeze([
  'GET /api/shared/:token',
  'GET /api/shared/:token/subagent/:subagentRunId',
  'POST /api/shared/:token/presence',
  'GET /api/shared/:token/upload/:sha256/content',
  'GET /api/shared/:token/generated-image/:messageId/:imageId/content',
]);

// Registered without `auth` because they check the credential themselves:
// the sign-in exchange takes the owner token or a sign-in code (`oarc1_`),
// which `auth` never accepts, and refuses agents and paired relays.
export const SIGN_IN_API_ROUTES = Object.freeze([
  'POST /api/auth/session',
]);

// Person-only routes that are written down on purpose (so the table and the
// router walk stay in step); everything not in TABLE is person-only anyway.
export const PERSON_ONLY_ROUTES = Object.freeze([
  // Browser sessions, sign-in codes, the owner token, the security notices
  'DELETE /api/auth/session',
  'GET /api/auth/sessions',
  'PATCH /api/auth/sessions/:id',
  'DELETE /api/auth/sessions/:id',
  'DELETE /api/auth/sessions',
  'POST /api/auth/signin-codes',
  'GET /api/auth/owner-token',
  'POST /api/auth/owner-token/rotate',
  'GET /api/auth/notices',
  'POST /api/auth/notices/:id/dismiss',
  'POST /api/auth/notices/dismiss-signins',
  // File capabilities (`k`) for the page's own native loads: a browser
  // session with its proof key (the owner token gets the links back as they
  // are). An agent reads files with its own token and needs none.
  'POST /api/files/capability',
  // Session delete cannot be undone (§12).
  'DELETE /api/conversation/:id',
  // Shares
  'POST /api/conversation/:id/share',
  'POST /api/conversation/:id/share/renew',
  'DELETE /api/conversation/:id/share',
  'GET /api/shares',
  'GET /api/conversation/:id/share/opens',
  'GET /api/conversation/:id/share-preview',
  'GET /api/conversation/:id/share-preview/subagent/:subagentRunId',
  'PATCH /api/conversation/:id/message/:messageId/share-visibility',
  'POST /api/conversation/:id/share-visibility/unhide-all',
  'POST /api/settings/shares',
  'GET /api/settings/shares/stored-viewer-ips',
  'DELETE /api/settings/shares/stored-viewer-ips',
  // Settings writes and provider logins
  'POST /api/settings/default-session-workspace-root',
  'POST /api/settings/openai',
  'PUT /api/openai-image-presets',
  'DELETE /api/openai-image-presets/:name',
  'POST /api/settings/copilot',
  'POST /api/settings/claude',
  'POST /api/claude/auth/login/start',
  'POST /api/claude/auth/login/code',
  'POST /api/claude/auth/login/cancel',
  'POST /api/claude/auth/logout',
  'POST /api/grok/auth/login/start',
  'POST /api/grok/auth/login/cancel',
  'POST /api/grok/auth/logout',
  'POST /api/settings/grok',
  'POST /api/settings/cursor',
  'POST /api/settings/deepseek',
  'POST /api/settings/claude-api',
  'POST /api/settings/claude-cloud',
  'POST /api/settings/turn-ceiling',
  'POST /api/settings/subagent-record-retention',
  'POST /api/settings/share-path-privacy',
  'POST /api/settings/background-task-timeout',
  'POST /api/settings/task-stall-minutes',
  'POST /api/settings/restart-resume',
  'POST /api/settings/pwa-app-name',
  'POST /api/settings/features',
  'POST /api/settings/windows-autostart',
  'POST /api/settings/cursor-allowance',
  'POST /api/settings/cursor-dashboard-token',
  'POST /api/settings/grok-allowance',
  'POST /api/settings/relay-restart-max-wait',
  'POST /api/model-refresh-settings',
  'PATCH /api/model-variants',
  'POST /api/model-variants/refresh',
  'POST /api/model-variants/seen',
  'POST /api/workspace-root',
  'POST /api/workspace-root/attribution',
  'POST /api/deepseek-usage-import',
  // Pairings
  'GET /api/remote-relays',
  'POST /api/remote-relays',
  'POST /api/remote-relays/pair',
  'PATCH /api/remote-relays/:id',
  'DELETE /api/remote-relays/:id',
  'POST /api/remote-relays/:id/check',
  // Peer keys: Re-pair, Renew, Revoke, confirm a changed identity, dismiss
  // the refusal notice
  'POST /api/remote-relays/:id/repair',
  'POST /api/remote-relays/:id/renew-key',
  'POST /api/remote-relays/:id/revoke-key',
  'POST /api/remote-relays/:id/confirm-identity',
  'POST /api/remote-relays/:id/refusal-notice/dismiss',
  // One-way pairing: the relay that adds this one asks, with the owner
  // token from the pairing link, for a key of its own (inbound only).
  // Never an agent token or a paired relay's key.
  'POST /api/remote-relays/peer-key/inbound',
  'GET /api/settings/remote-relays',
  'POST /api/settings/remote-relays',
  'GET /api/settings/agent-sessions',
  'POST /api/settings/agent-sessions',
  // Push devices (a subscription would receive card contents)
  'GET /api/push/vapid-public-key',
  'GET /api/push/devices',
  'POST /api/push/subscribe',
  'PATCH /api/push/devices/:id',
  'DELETE /api/push/devices/:id',
  // Maintenance
  'POST /api/update/auto-check',
  'POST /api/update/check',
  'POST /api/update/dismiss',
  'POST /api/update/cancel',
  'POST /api/update/apply',
  'POST /api/cli/install',
  'POST /api/cli/install/cancel',
  'POST /api/agent-sdks/install',
  'POST /api/agent-sdks/install/cancel',
  'POST /api/host/suspend',
  'POST /api/host/suspend/cancel',
  'POST /api/usage-limit/resume',
  'POST /api/usage-limit/cancel',
  'POST /api/restart-orchestrator/request',
  'POST /api/restart-orchestrator/rebind',
  'POST /api/restart-orchestrator/bridge-exit',
  'POST /api/session-worker/:sdkSessionId/launch',
  'POST /api/session-worker/:sdkSessionId/kill',
  'POST /api/cache/rebuild',
  'POST /api/relay/pause',
  'POST /api/relay/resume',
  'POST /api/queue/empty',
  'POST /api/relay/shutdown/keep-waiting',
  // Groups: create, rename, delete, stop all, archive all
  'POST /api/conversation-groups',
  'PATCH /api/conversation-groups/:id',
  'DELETE /api/conversation-groups/:id',
  'POST /api/conversation-groups/:id/stop',
  'POST /api/conversation-groups/:id/archive',
]);

function routeKey(method, routePath) {
  const verb = String(method || '').toUpperCase() === 'HEAD' ? 'GET' : String(method || '').toUpperCase();
  return `${verb} ${String(routePath || '')}`;
}

const PERSON_ONLY = Object.freeze({ agent: D, peer: D, listed: false });

export const RELAY_ROUTE_POLICY = (() => {
  const map = new Map();
  for (const [method, routePath, agent, peer] of TABLE) {
    const key = routeKey(method, routePath);
    if (map.has(key)) throw new Error(`relay-route-policy: ${key} is listed twice`);
    map.set(key, Object.freeze({ agent, peer, listed: true }));
  }
  for (const key of PERSON_ONLY_ROUTES) {
    if (map.has(key)) throw new Error(`relay-route-policy: ${key} is listed twice`);
    map.set(key, Object.freeze({ agent: D, peer: D, listed: true }));
  }
  return map;
})();

/**
 * The policy of a route: `{ agent, peer, listed }`. An unknown route (or an
 * array of patterns, which only public pages use) is person-only.
 */
export function routePolicyFor(method, routePath) {
  if (typeof routePath !== 'string') return PERSON_ONLY;
  return RELAY_ROUTE_POLICY.get(routeKey(method, routePath)) || PERSON_ONLY;
}

export function relayRouteKey(method, routePath) {
  return routeKey(method, routePath);
}

/** May a request with the session cookie alone (no proof key) call this route? */
export function isCookieOnlyRoute(method, routePath) {
  if (typeof routePath !== 'string') return false;
  return COOKIE_ONLY_KEYS.has(routeKey(method, routePath));
}

/** Does this route take a file capability (`k`) in place of the proof key? */
export function isFileCapabilityRoute(method, routePath) {
  if (typeof routePath !== 'string') return false;
  return FILE_CAPABILITY_KEYS.has(routeKey(method, routePath));
}
