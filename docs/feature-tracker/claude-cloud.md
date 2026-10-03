# Claude Cloud (Claude Code cloud sessions)

Updated: 2026-10-02 · Part of the [SDK Feature Tracker](README.md) — legend, changelog, and
provider-agnostic relay rows live there.

Provider type `claude-cloud`. A cloud conversation runs Claude Code in a sandbox at Anthropic, on
a clone of a GitHub repository; nothing of it runs on the relay host. There is no SDK: the relay
speaks the session API the Claude CLI itself uses, over Node's `fetch`. That API is **not a
documented public API**: paths, headers and bodies were measured, so every expectation about them
lives in one file, `shared/claude-cloud/api-client.mjs`, and what is listed here is what that file
and the worker do, not what the API promises.

Where the code lives:

- `shared/claude-cloud/` — `api-client.mjs` (`createClaudeCloudClient`, `createSseParser`),
  `credentials.mjs` (`createClaudeCloudCredentials`, `ClaudeCloudError`), `repo-url.mjs`
  (`normalizeGitHubRepoUrl`, `isValidBranchName`, `stripModelTierSuffix`, `compareUrl`),
  `base-url.mjs` (`resolveClaudeCloudBaseUrl`). Used by the worker and by the server alike.
- `server/claude-cloud-worker/` — `claude-cloud-session-worker.mjs` (entry),
  `claude-cloud-session-process.mjs` (`createClaudeCloudSessionRunner`),
  `claude-cloud-event-normalizer.mjs` (`createClaudeCloudEventNormalizer`).
- `server/services/` — `claude-cloud-settings-service.mjs`, `claude-cloud-session-service.mjs`,
  `git-remote-service.mjs`, `claude-account-usage-service.mjs`, `plan-usage-claude-cloud.mjs`;
  routes in `server/routes/claude-cloud-routes.mjs`; storage in
  `server/migrations/0007-claude-cloud.mjs`.
- `server/public/app/` — `claude-cloud-ui.mjs` (pure helpers), `claude-cloud-settings-ui.js`,
  `claude-cloud-conversation-ui.js`, and the New Chat fields in `journal-view.js`.

It is a provider of its own, never an alias of `claude`: every `=== 'claude'` check stays
Claude-only, and the type is listed where it needs the same treatment
(`shared/provider-routing.mjs` → `SESSION_WORKER_PROVIDER_TYPES`,
`session-worker-launch-service.mjs` → `NODE_WORKER_DESCRIPTORS`, `ensureRuntimeSessionBinding` and
`buildSessionWorkerLaunchEnvForSession` in `server/server-runtime.mjs`).

## Turn execution

| Surface | Status | Notes / evidence |
| ------- | ------ | ---------------- |
| Conversation creation | Implemented | `POST /api/conversation/bootstrap` with `providerType: 'claude-cloud'` and `cloudSource: { repoUrl, branch? }` (`validateCloudSourceRequest`, `buildCloudSourceRecord` in `claude-cloud-session-service.mjs`; wiring in `sessions-routes.mjs`). Refused with `claude_cloud_disabled`, `claude_cloud_repo_invalid`, `claude_cloud_branch_invalid`, `claude_cloud_environment_missing`. The source is stored in `conversations.cloud_source_json`; nothing is created at Anthropic. The provider is asked for by name only: its model ids are the Claude provider's, so a model never selects it, and `POST /api/message` cannot create or convert one (`CLAUDE_CLOUD_REQUIRES_NEW_CONVERSATION`). |
| Repository and branch from a folder | Implemented | `GET /api/git/remote?root=` (`git-routes.mjs`, `git-remote-service.mjs` → `describe`): `origin`, else the upstream's remote; branch, ahead/behind, dirty. The New Chat modal fills two editable fields from it and warns about what the clone will not have (`claude-cloud-ui.mjs` → `resolveCloudSourceAutoFill`, `buildCloudSourceWarnings`, `validateCloudSourceInputs`). The browser's copies of the repository and branch rules are held to the shared ones by `claude-cloud-ui.test.mjs`. |
| Repository and branch suggestions | Implemented (2026-10-02) | `GET /api/claude-cloud/repos` (`claude-cloud-repo-service.mjs` → `listRepositories`): Anthropic's list of the repositories the Claude GitHub app can reach (`GET /api/oauth/organizations/{org}/code/repos`, `api-client.mjs` → `listRepositories`, cached a minute) united with the repositories of earlier cloud chats (`listRecentCloudSources`, newest first, `accessible: false` when the app lost one). `GET /api/claude-cloud/branches?repo=` → `listBranches`: `git ls-remote --symref <url> HEAD refs/heads/*` on the host, no prompts, 15 s; `OAR_CLAUDE_CLOUD_BRANCH_LOOKUP=off` disables it (pinned off in the e2e harness). Browser: `filterCloudRepoSuggestions` / `filterCloudBranchSuggestions` / `cloudRepoAccess` (`claude-cloud-ui.mjs`), lists under the fields in `journal-view.js` (arrow keys, Enter, Escape, click; a pick writes the default branch, a typed branch is kept); a repository not on a complete list gets the `not-accessible` warning. Tests: `claude-cloud-ui.test.mjs`, `journal-view.claude-cloud.test.mjs`, `tests/claude-cloud.spec.mjs`. |
| Session creation with the first message | Implemented | The delivered message carries `claudeCloud: { sessionId, lastSequence, repoUrl, branch, environmentId, title }` (`buildClaudeCloudDelivery`, added in `buildDequeuedRelayMessage`). Without a `sessionId` the worker calls `createSession` (title, environment, model, `sources: [{ type: 'git_repository', url, revision }]`, the message as the first event) and reports the binding (`startCloudTurn`, `reportSession` → `POST /api/claude-cloud-session`). |
| Follow-up messages | Implemented | `sendUserMessage` posts a `user` event into the bound session; the event's sequence number is where the turn starts (`startCloudTurn`). No idle limit on the relay's side: the session is addressed by its id however long ago its last turn was. |
| Live reply stream | Implemented | `openEventStream` follows `GET …/events/stream` (SSE, `createSseParser`; resumable with `Last-Event-ID`). Only `client_event` frames matter (`handleFrame`). The normalizer maps each event to relay actions: `assistant` `text` blocks → the accumulated reply (`/api/stream`), `thinking` → thoughts keyed by the event's sequence number so a replay updates in place, `tool_use` / failed `tool_result` → activity, `env_manager_log` → "Cloud: …" activity lines for sandbox steps, `system/init` → the model and one activity line. Events carry complete content blocks; there are no partial frames. |
| Turn boundary | Implemented | One `result` per user message. A turn is every event after its user event's sequence number up to the first `result` (`handleEvent`, `inTurn`); events at or below `session.lastSeq` are replays and skipped. A turn that ended here without its `result` (Stop not confirmed) is counted in `unfinishedTurns`, so its late `result` is not taken for the next turn's; `confirmUnfinishedTurns` drops the count when the session reports `worker_status: idle`. |
| Background work of the cloud agent | Implemented | A `result` that arrives while the session reports background tasks (`system/background_tasks_changed` with a non-empty `tasks`, e.g. a subagent started in the background) does not end the relay turn: `holdForBackground` keeps it open, and the reply is the `result` of the closing turn the agent takes when that work is done. `scheduleQuietCheck` settles on the interim reply when the work ends and the session goes idle without a closing turn; `endBackgroundHold('ceiling')` ends the turn at the relay's background-task timeout (`settings.backgroundTaskTimeoutMs`, else `backgroundHoldMs`) with a note. A failed or interrupted `result` ends the turn at once. |
| Result publishing | Implemented | `publishResult`: the `result` text, else the streamed text, else the shared empty-turn note; an error result becomes a terminal error classified by the Claude worker's `classifyClaudeResultFailure`; a turn stopped from another client is answered plainly. Publishing goes through the Claude worker's `createClaudeTurnPublisher`. |
| Subagents | Implemented | Inferred from subagent tool blocks as in the Claude worker (`isSubagentToolName`): a run opens on the `tool_use` and closes on its `tool_result`. Thoughts and activity are attributed by `parent_tool_use_id`; a subagent's text is not published as the reply. |
| Push reports | Implemented | `system/vcs_state_changed` with `kind: 'push'` → an activity line and a `pushedBranch` report; the relay keeps the newest 20 in `cloud_source_json.pushedBranches` and broadcasts `claude_cloud_session`. The conversation's cloud line links each to GitHub's compare page against the chat's branch (`claude-cloud-ui.mjs` → `buildCloudLineModel`, `cloudCompareUrl`; server twin `compareUrl`). |
| Stream reconnect | Implemented | The client never reconnects by itself. Mid-turn the runner reopens the stream after the last event handled, with a pause growing from 1 s to 15 s (`followStream`); a stream with no byte for 120 s, keepalives included, is taken for dead and reopened (`streamIdleTimeoutMs`). After 5 minutes without a stream the row is requeued and, delivered again, followed instead of sent twice. A failure reconnecting cannot cure (`FATAL_STREAM_CODES`: login, not found, bad request, GitHub, environment) ends the turn with its note. |
| Resume across worker restarts | Implemented | The relay stores the cloud session id and the sequence number of the last finished turn's `result` (`claude_cloud_last_sequence`; never a point inside a turn, never moved back: `laterSequence`). A new worker reads the event log on from there (`catchUp` → `listEvents`), finds the delivered message by its uuid and republishes its turn under the new attempt; a turn that finished while no worker ran is answered from the log alone. The uuid is derived from the queue row id (`claudeCloudMessageUuid`), and the create call passes it too, so a repeated create returns the session it already made (`deduplicated`). |
| Idle stream close | Implemented | Ten minutes without a turn close the event stream (`scheduleIdleClose`); the next delivery reopens it after the last event. The worker process itself stays. |
| Mid-turn steering | Not implemented | Single-flight: `handlePendingPayload` refuses a delivery while a turn runs, the worker advertises no steering, and the message waits in the relay's queue. |
| Relay modes / plan boards | Not implemented | The session runs in the cloud's own permission mode. The composer offers `agent` only and hides the selector (`RELAY_MODES_BY_PROVIDER` in `bootstrap.js`, `body.claude-cloud-conversation`). |
| Reasoning effort / context tier | Not applicable | `CLAUDE_CLOUD_REASONING_EFFORTS` is `['none']` (`provider-reasoning-effort.mjs`); the send path forces effort `none` and tier `default`. |
| Per-message model | Implemented (2026-10-02) | The composer's model follows the conversation as for a local Claude chat: the relay stores it on the runtime session (no more `409 CLAUDE_CLOUD_MODEL_REQUIRES_NEW_CONVERSATION`, no composer lock), the delivery carries it as `providerModel`, and the worker sends a `set_model` control request before the message when it differs from what it last gave the sandbox (`applyModel`; unknown after a worker restart → sent once). Live-verified: the sandbox answers `control_response` success, emits a fresh `system/init` with the new model, and the next turn runs on it. A refused `set_model` (400) costs the switch, not the turn (activity line). |
| Background continuations / task panel | Continuations implemented (2026-10-02); no task panel | The worker keeps the event stream open between turns (`idleCloseMs = 0`; between turns a dropped stream is reopened with backoff for `reconnectGiveUpMs`, then left to the next delivery). An event that opens a turn while no turn of ours runs — a text `user` message from another client, an `assistant` message, `system/init` or `background_tasks_changed` — makes `openStrayTurn` register a continuation row (`POST /api/continuation-turn`, which now accepts `claude-cloud`; trigger `cloud_client_message` or `cloud_turn`, idempotent by operation id, three tries) and follow the turn under that row: an activity line names the source ("message sent on claude.ai: …" / "the agent continued on its own"), the reply is published as a `continuation` reply (the browser's "background continuation" tag). A turn the relay will not register is skipped whole (`unfinishedTurns`). Not covered: turns that happened while no worker ran (catch-up reads only the delivered turn). `task_notification` is still an activity line; no task panel. |
| Usage-limit pause | Implemented (2026-10-02) | The cloud worker runs the Claude worker's `createUsageLimitTracker` over the turn's events: every new `rate_limit_event` goes to `POST /api/claude-usage-limit` (which now accepts `claude-cloud` conversations), and a failed `result` is classified with it (`classifyUsageLimitRefusal`: rejected report + 429/`rate_limit`/limit text). A refusal is published with `buildUsageLimitFailure` as the terminal error, and the relay's `usage-limit-pause-service` (provider gate widened to `claude-cloud`) pauses the row and queues the held follow-up as for a local Claude chat; the resume prompt is a new message, so the cloud session gets a fresh user event. The warning before the limit stays an activity line. Fake API: the word "limit" scripts a refusal. |
| Relay tools in the sandbox (`preview`, `remote_relay`, media by host path) | Not implemented | The session is created with a model and a source only; no tool and no relay guidance is passed. |
| Commit attribution | Implemented (2026-10-02) | The relay resolves the mode as for Claude (`claudeAttributionForConversation`: the Claude tab's setting, the override of the folder the chat was started from if it has one, the model's name) and delivers the finished object in `settings.attribution`. The worker hands it to the sandbox's Claude Code as an `apply_flag_settings` control request: in the create call in front of the first message (`createSession({ flagSettings })`), and before a later message when it differs from what this process sent (`applyAttribution`; a restarted worker sends it once, since it cannot know what the sandbox has). `null` (vanilla) takes the key out of the sandbox's flag layer again, so no restart is needed, unlike the local CLI. A request the API refuses (400) or the sandbox answers with an error costs the setting, not the turn: one activity line, and the next message tries again. Live-verified with all three modes. The commit author stays the sandbox's git identity. |

## Questions and permission prompts

| Surface | Status | Notes / evidence |
| ------- | ------ | ---------------- |
| `AskUserQuestion` | Implemented | The cloud emits a `control_request` with `subtype: 'can_use_tool'`; requests whose event `source` is `client` (the clients' own `set_permission_mode`, `interrupt`) are ignored (`controlActions`). `AskUserQuestion` goes through the shared `ask-user-bridge.mjs` (`handleAskUserQuestion`): one card per question, multi-select as checkmarks, answers keyed by the question text and returned as `updatedInput.answers` in a `control_response` event (`askUser`, `sendControlResponse`). |
| Permission prompt for any other tool | Implemented | An **Allow** / **Deny** card naming the tool and a summary of its input (`askPermission`, context source `ClaudeCloudPermission`). |
| Unanswered card | Implemented | Timeout (the relay default, `DEFAULT_QUESTION_TIMEOUT_MS`) or a Stop → `behavior: 'deny'` with a message that nobody answered. |
| Answered from another client | Implemented | A `control_response` on the stream for an open request closes the card here without a second answer (`permission_settled`). |
| After a restart | Implemented | `catchUp` collects the request ids already answered in the log, so a replayed request opens no card. |
| Cards run beside the event line | Implemented | `startPermissionRequest` is not awaited by the event chain: a card may stay open for hours and the `result` of a turn stopped meanwhile still gets through. |

## Stop

| Surface | Status | Notes / evidence |
| ------- | ------ | ---------------- |
| Whole-turn Stop | Implemented | The control poller's `abort_turn` → `abortTurn` → `sendInterrupt` (a `control_request` event with `subtype: 'interrupt'`). The interrupted turn ends with its own `result` (`isInterruptedCloudResult`: `terminal_reason` starting with `aborted`), and the relay's abort control owns the row, as for the other workers. |
| Stop before the message is in the session | Implemented | The turn settles `stopped` and nothing is sent (`startCloudTurn`). |
| Stop without confirmation | Implemented | No `result` within 30 s (`interruptGraceMs`) ends the turn locally with an activity line saying the cloud agent may still be working, with the session link. The sandbox cannot be stopped from the relay. |
| Open cards on Stop | Implemented | Closed as unanswered; the cloud is told with a denial. |
| Targeted subagent stop | Not implemented | Whole turn only. |

## Attachments

| Surface | Status | Notes / evidence |
| ------- | ------ | ---------------- |
| Inline images | Implemented | `buildClaudeCloudUserContent` reuses the Claude worker's `buildClaudeAttachmentContent`: jpeg, png, gif, webp up to 5 MB, as base64 image blocks after the text. |
| Any other attachment | Refused | The sandbox cannot read the relay host's files, so there is no path fallback: the turn is answered with a note naming the files and nothing reaches the cloud (`refuseAttachments`, stable code `claude-cloud.attachment-unsupported`). The composer filters first: the file input accepts images only and other files are dropped with a notice (`partitionCloudAttachments`, `attachments-view.js`). |

## Usage

| Surface | Status | Notes / evidence |
| ------- | ------ | ---------------- |
| Context use | Implemented | After each turn the worker reads the session once (`publishUsage` → `getSession`, 10 s cap) and posts `external_metadata.context_usage` in the Claude shape to `POST /api/claude-context-usage` (`readCloudSessionUsage`), which accepts `claude-cloud`; `GET /api/context/:id` serves it. Used and maximum tokens only, no categories. |
| Session cost | Implemented | The same read gives `usage.cost_usd` (else the `result`'s `total_cost_usd`); it is reported with the binding and stored in `runtime_sessions.claude_cloud_cost_usd`. Shown on the cloud line and summed on the usage card. |
| Per-turn usage report | Implemented | `POST /api/claude-plan-usage` with the `result`'s `modelUsage` and cost; a cloud conversation's report is stored under the snapshot key `claude-cloud`, apart from the Claude card's. |
| Claude Cloud card (Check Usage) | Implemented | `plan-usage-claude-cloud.mjs` → `buildClaudeCloudPlanCard`, only while the provider is on. A meter per top-level bucket of the account usage body that carries a dollar limit (`listClaudeDollarBuckets`; the credit arrives under a name that may change, so the rule is the dollar limit and the name table only supplies a label), with the reset date read as an expiry (`resetKind: 'expiry'`); "Cloud spend (OAR sessions)" from `readClaudeCloudSpend` (`plan-usage-service.mjs`: the latest reported cost per cloud conversation that still exists, no dates, so no per-day sums); the latest cloud snapshot's session sections; a note when a credit is offered but not claimed (`describeClaudeCreditOffer`). |
| Live account usage | Implemented | `claude-account-usage-service.mjs`: `getAccountUsage`, `getPrepaidCredits`, `getCreditGrantOffer` of the cloud client, cached 60 s (a failure 15 s), read only while the provider is on. `GET /api/usage` waits at most 3 s. It also replaces the Claude card's windows (`normalizeClaudeAccountUsage` in `plan-usage-claude.mjs`: severity per window, model-scoped weekly windows, the week by product, prepaid credits). The limit-reset vouchers of the claude.ai usage page are in no endpoint this login reaches; the card links there. |

## Account and authentication

| Surface | Status | Notes / evidence |
| ------- | ------ | ---------------- |
| Login source | Implemented | `credentials.mjs`: `CLAUDE_CODE_OAUTH_TOKEN` from the process environment, else `claudeAiOauth.accessToken` in `<CLAUDE_CONFIG_DIR \| ~/.claude>/.credentials.json` (`resolveClaudeCredentialsPath`). A credentials file without that entry is `login_missing`. |
| Read-only use | Implemented | The module is the only reader. The token is cached in memory until 60 s before expiry (`CLAUDE_CLOUD_TOKEN_MARGIN_MS`), then the file is read again. The refresh token is never used: a refresh from here would rotate the login under the CLI. |
| Nudge | Implemented (relay and workers, 2026-10-02) | When the login in the file is about to run out or has, the reader calls its `nudge` at most once in five minutes (`CLAUDE_CLOUD_NUDGE_INTERVAL_MS`), then reads the file again. The relay's reader runs `claudeAuthService.getStatus({ force: true })`, i.e. `claude auth status`; a cloud worker's reader asks the relay to do the same (`POST /api/claude-cloud/login-nudge`, the route sees only the reader's `describe`; answers `{ nudged, hasToken, expiresAt, expired }`, never the token), since a worker cannot run the CLI. A 401 from the API makes the client reload the token (`forceReload`), which is where the nudge happens mid-chat; still expired → `login_expired` and the Relogin note. Assumption not yet seen live: that `claude auth status` refreshes an expired access token while the refresh token is good (it refreshed one 2026-10-02 at 22:15Z when a local session ran). |
| Token never leaves the client | Implemented | Sent as the bearer header to the client's base URL only: `CLAUDE_CLOUD_BASE_URL`, or the loopback URL a test names in `OAR_CLAUDE_CLOUD_API_BASE_URL` (`shared/claude-cloud/base-url.mjs` → `resolveClaudeCloudBaseUrl`, `loopbackBaseUrlOrNull`: `127.0.0.1`, `[::1]` or `localhost`, no credentials; anything else is ignored). Not in the database, not in a route body (`describe()` returns source and expiry), and `applyClaudeCloudProviderEnvironment` adds no credential to a launch. Every error text passes `redact()`, which removes the tokens the reader has seen plus anything shaped like a bearer header. Tests: `credentials.test.mjs`, `api-client.test.mjs`, `base-url.test.mjs`. |
| `CLAUDE_CODE_OAUTH_TOKEN` and workers | Implemented | A relay run on the environment token instead of the CLI's credentials file passes it on to its cloud workers. The variable is in `WORKER_SECRET_ENV_VARS`, restricted to the `claude-cloud` kind (`workerSecretEnvVarsFor`): under tmux it travels in the owner-only secret env file the worker's shell sources and deletes, is not exported and is removed from the environment tmux is started with; a launch of another kind writes no secret file for it. The detached launch inherits the relay's environment as it is. Tests: `session-worker-launch-service.claude-cloud.test.mjs`. |
| 401 handling | Implemented | One retry with the token read afresh (`request`), then `login_expired`. |
| Error codes | Implemented | `classifyClaudeCloudFailure`: `github_not_connected`, `repo_access_denied`, `environment_missing` from the error body, else by status (`login_expired`, `not_found`, `rate_limited`, `transient`, `bad_request`). The worker turns a known code into a reply that says what to do (`KNOWN_ERROR_REPLIES`); `transient` requeues the row. |
| Settings | Implemented | `GET` / `POST /api/settings/claude-cloud` (`claude-cloud-settings-service.mjs`): switch (off by default; enabling without a login is `claude_cloud_login_missing`), default model, environment. Environments come from `listEnvironments` (the organisation id from the profile, cached per token), listed only while the provider is on and a login exists. The account line comes from the Claude auth service; the login is changed on the Claude tab. Socket event `claude_cloud_settings_updated`. |
| Off means off | Implemented, with one exception | While the provider is off the settings service and the account usage service ask Anthropic for nothing. A cloud conversation created earlier is not rebound and still works: its worker launches, and deleting or archiving it archives its cloud session. |

## Lifecycle

| Surface | Status | Notes / evidence |
| ------- | ------ | ---------------- |
| Archive on delete / archive | Implemented | `archiveSessionInBackground` from the conversation delete and archive routes: best effort, not waited for, a 409 counts as already archived. Nothing is ever deleted at Anthropic. |
| Worker shutdown | Implemented | SIGTERM/SIGINT stop the link and the stream and leave the cloud session as it is: a turn in flight keeps running there and the next worker finds it. |
| Heartbeat | Implemented | Every 10 s with the active queue message id (`createHeartbeatController`), so the relay's inactivity guard sees a live turn. The worker has no stall watchdog of its own; a turn that stays quiet with a live stream is bounded by the relay's turn ceiling. |
| Session root | Not applicable | `buildConversationSessionRootPayload` returns `null`; the conversation menu hides **Change CWD**. |

## Remote relays

| Surface | Status | Notes / evidence |
| ------- | ------ | ---------------- |
| Listed as a provider | Implemented | `REMOTE_RELAY_PROVIDERS` and the dispatcher's `SETTINGS_PROVIDERS` include it; the provider list names it without efforts and with a note (`CLOUD_CREATE_NOTE`). |
| `create_session` | Implemented (2026-10-02) | `repo` (a GitHub URL or `owner/repo`, canonicalised by `normalizeRemoteRelayRepo`) and an optional `branch` (`isValidBranchName`) in the tool schema; `validateRemoteRelayToolInput` requires `repo` with `provider: "claude-cloud"`, refuses `cwd` with it, and refuses `repo`/`branch` with any other provider. The dispatcher's `createSession` posts them as `cloudSource: { repoUrl, branch? }` to `POST /api/conversation/bootstrap`, which applies New Chat's checks and codes (a provider that is off comes back as `REMOTE_RELAY_PROVIDER_UNAVAILABLE` with `remoteCode: claude_cloud_disabled`). No model and no effort are mirrored from the caller: without `model` the bootstrap takes the tab's default. A caller that is itself a cloud session and names neither provider nor `repo` is refused before any approval card (`createSessionProblem`). The result carries `repo` and `branch`. Works on a paired relay and, with agent sessions on, on this relay itself (see the "Agent sessions" row in [README.md](README.md)). Existing cloud sessions take `send`, `wait`, `read_session` and `stop`. |

## Not wired

| Feature | Status | Notes |
| ------- | ------ | ----- |
| Renaming the cloud session | Not implemented | The session is created with the conversation's title at that moment; later title changes are not mirrored. |
| Creating environments | Not implemented | The tab lists the account's environments and picks the first active one; none is created from the relay. |
| A `cloud_session` tool for local agents | Not implemented, superseded | There is no tool of its own: an agent starts a cloud session with `remote_relay` `create_session` on this relay or a paired one (see [Remote relays](#remote-relays)). |
| A live check against the real API | Not implemented | No script in the repository talks to Anthropic; a live cloud turn is a manual test and costs money. |

## Tests

- Unit: `shared/claude-cloud/*.test.mjs` (fake `fetch`, fake file system, SSE chunk boundaries, 401
  retry, redaction, expiry and nudge, the loopback rule of the base URL),
  `server/claude-cloud-worker/*.test.mjs` (scripted event sequences through
  `claude-cloud-test-harness.mjs`: create, follow-up, question round trip, push, Stop, reconnect,
  restart catch-up, refusals), `claude-cloud-session-service.test.mjs`,
  `claude-cloud-settings-service.test.mjs`, `claude-cloud-routes.test.mjs`,
  `messages-routes-claude-cloud.test.mjs`, `sessions-routes-claude-cloud.test.mjs`,
  `sessions-routes-usage.test.mjs`, `server-runtime-claude-cloud-provider.test.mjs`,
  `session-worker-launch-service.claude-cloud.test.mjs`, `git-remote-service.test.mjs`,
  `claude-account-usage-service.test.mjs`, `plan-usage-claude-cloud.test.mjs`,
  `0007-claude-cloud.test.mjs`, `shared/provider-routing.test.mjs`, and the browser helpers'
  `claude-cloud-*.test.mjs` and `journal-view.claude-cloud.test.mjs`.
- End to end: `tests/claude-cloud.spec.mjs` boots a relay of its own with worker launches allowed
  and drives the real settings tab, New Chat modal, composer, routes, queue and a really launched
  cloud worker against `tests/fake-claude-cloud-api.mjs`, a loopback HTTP server that speaks the
  shapes the client was written against (it scripts a session's answer by the text of the user
  message). Relay and worker are pointed at it with `OAR_CLAUDE_CLOUD_API_BASE_URL`; the login is
  a `CLAUDE_CODE_OAUTH_TOKEN` only the fake accepts, which reaches the worker through the secret
  env file. Skipped on Windows (it isolates its workers in a tmux server of its own). The shared
  e2e relay (`tests/relay-server-harness.mjs`) pins the base URL to a loopback port nothing
  listens on and clears the token, so no other spec can reach Anthropic.
  `tests/agent-sessions.spec.mjs` uses the same fake for a cloud session an agent creates through
  `remote_relay` (`repo`, `branch`, the tab's default model, the local origin, no nesting); the
  paired-relay path is covered by `remote-relay-dispatcher.test.mjs`.
