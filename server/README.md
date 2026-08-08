# Copilot Web Proxy

A Node.js web server that lets you chat with your local coding agents from any device via a browser.

Three runtimes can serve a conversation, selected when the conversation is created:

- **GitHub Copilot CLI** (default) — executed by the `web-relay` CLI extension and its session workers.
- **OpenAI (BYOK)** — the Copilot CLI running in BYOK mode against an OpenAI-compatible endpoint, plus a direct Images API path for image conversations.
- **Claude (Agent SDK)** — a dedicated Node worker in `server/claude-worker/` that speaks the same relay contracts.

See [Claude Agent SDK provider](#claude-agent-sdk-provider) for the third runtime.

## Setup

```bash
npm install
```

This project now runs in package-wide ESM mode (`"type": "module"` in `package.json`).

## Starting the Server

If you run `gh copilot` and the web-relay extension is loaded (project-local or user-global),
the extension auto-starts `server.js` when needed and keeps the relay listener singleton
while letting session-affine CLI workers run in parallel.

If `tty-console` is installed as an optional dependency, the server starts it on an interactive
terminal and stores its config/history files under `server/logs/`.
When active, worker loop telemetry is summarized in the title bar (`Clients`, `Pen`, `Proc`,
`parked`, running `CLIs`) and routine worker dequeue events are not printed as repeating logs.

On Linux/macOS, session-affine worker launches prefer detached `tmux` sessions when `tmux`
is available, using the worker SDK session id as the tmux session name so you can attach
for debugging without changing the Windows launch path. Worker processes now launch from the
relay repository root so the project-local `web-relay` extension is always discoverable; the
session's actual target workspace is still passed via `COPILOT_WORKSPACE_ROOT` / `INIT_CWD`.

The web client now includes a read-only **Inspect tmux console** action in the conversation
three-dot menu. It streams only from active relay session workers and only while the viewer
is actively watching that session.

> **Single-owner rule:** Use either extension-managed relay transport **or** standalone `relay.mjs`, never both at the same time.
> Agent/runtime restart policy is defined in `.github/copilot-instructions.md`.

Launch Copilot CLI from the repository root with extensions enabled and no initial user prompt:

```bash
npm run copilot:relay
```

That runs `gh copilot -- --allow-all` from the repo root, so the
extension is discovered and the relay starts immediately. If you installed the extension
globally, plain `gh copilot` from any repository is enough.

Or manually:

```bash
npm start
```

This starts both the web server and relay automatically.
Stopping the main process (Ctrl+C / closing the terminal) also stops the relay.

If you install this repo locally with `npm link` or `npm install -g .`, the `copilot-remote`
command starts the web relay server if needed and then launches `gh copilot` in the same shell
from whatever folder you run it in. If a relay is already live, it reuses it instead of starting
a second owner.

`copilot-remote` also prepares a user-global `web-relay` extension wrapper by default. You can run
`copilot-remote --install-extension` to install/update only the wrapper and exit.

Relay server output is redirected to a logfile under `%LOCALAPPDATA%\copilot-remote\logs` by
default (or `COPILOT_WEB_RELAY_LOG_DIR` if set), so the terminal stays reserved for the CLI.

The global launcher no longer injects a bootstrap prompt; it just starts `gh copilot` directly
after the relay is ready.

If you need a specific `server/config.json` for token or tunnel settings, set
`COPILOT_WEB_RELAY_CONFIG` to that file before launching. The global npm install does not include
the repo-local gitignored config file by default.

If you want CLI-extension mode (your active Copilot CLI session does the work),
start only the web server manually:

```bash
npm run start:server
```

Mode summary:

- `npm start`: server + standalone SDK relay (manual development / local end-to-end testing)
- `npm run start:server`: server only; `server.js` now acts like the `playground/scripts/self_restart` supervisor entry for manual terminal runs
- `npm run start:server:respawn`: legacy/manual watchdog tool (`respawn.bat`, outside extension-managed flow)
- `npm run start:server:respawn:posix`: legacy/manual watchdog tool (`respawn.sh`, outside extension-managed flow)

On Windows, the visible relay launcher path now targets a stable per-workspace Windows Terminal window name so later foreground launches reuse the same window instead of opening new desktop windows. Keep the hidden/stdio path as a fallback only.

### Runtime safety checklist (avoid duplicate relay workers)

1. Stop stale detached watchdog/relay processes before restart.
2. Keep exactly one listener on port `3333`.
3. The relay singleton lock is stored at `server/data/relay-server.lock` (stale locks are auto-recovered).
4. In extension-managed mode, do not run `npm start` or `node relay.mjs`.
5. Verify `/api/status` shows `cliOnline: true` and queue counts are moving or zero.
6. Follow relay restart policy from `.github/copilot-instructions.md`.
7. In extension-managed mode, use `POST /api/relay/shutdown` for manual restart requests.
   - It is queued until the relay is idle, so it will not stop an in-flight turn immediately.
   - Send `{ "restart": true }` when you want a self-restart instead of a plain shutdown.
8. Do not run tests that spawn Copilot CLI clients unless the user explicitly permits it.

Script necessity note:

- Extension-managed relay does not call npm scripts directly; it starts `server.js` itself.
- Extension-managed relay supervision now includes bounded auto-restart while the CLI session is active.
- Keep `npm start` for manual local development (starts server + standalone relay).
- Keep `npm run start:server` for server-only manual runs and extension-parity testing.
- Treat `npm run start:server:respawn` / `npm run start:server:respawn:posix` as legacy troubleshooting only; do not use them for manual restarts.
- Manual restart policy is defined in `.github/copilot-instructions.md`.

## Global extension install (user-scoped)

Copilot also scans a user extensions directory, so you can make this extension available
across repositories:

```text
C:\Users\<you>\.copilot\extensions\web-relay\extension.mjs
```

With global install, starting `gh copilot` in any workspace will load this extension and keep
the relay tied to that workspace CWD instead of forcing a fixed repo launcher.

If you also keep a project-local copy, extension management can show two `web-relay` entries.
Keep only one active to prevent duplicate loading.

For global install, use `copilot-remote --install-extension` (recommended) or manually place a
wrapper `extension.mjs` there that imports your repository extension entrypoint. Then set one of
these environment variables so it can find your relay server files:

- `COPILOT_WEB_RELAY_SERVER_DIR` (recommended) → absolute path to the `server` folder
- `COPILOT_WEB_RELAY_ROOT` → repo root that contains `server\`
- Optional overrides: `COPILOT_WEB_RELAY_CONFIG`, `COPILOT_WEB_RELAY_TOOLS`, `COPILOT_WEB_RELAY_LOG_DIR`

Project-local extensions still take precedence if the same extension name exists in both locations.

The startup banner shows your access URLs and token.

## Accessing the UI

Open in any browser:
```
http://<your-pc-ip>:3333/
```

If `localhostOnly` is enabled in `config.json`, the server listens only on loopback and you must use:

```
http://localhost:3333/
```

`localhostOnly` affects only the local relay listener. SSH reverse tunnel exposure is configured separately with `sshTunnel.remoteBind`.

Sign in once with the token prompt; the browser stores the session in an HttpOnly cookie.
Each CLI session now tracks its own workspace root:
- the running CLI keeps its learned runtime CWD
- the **🗂️ Change CWD** menu updates that session's persisted next-launch CWD
- the workspace browser follows the selected session's effective CWD instead of one relay-global root

Startup CWD learning prefers explicit session/launcher hints such as `COPILOT_WORKSPACE_ROOT`,
then other runtime cwd hints (`INIT_CWD`, `PWD`, session metadata). The extension startup sync
deliberately skips `process.cwd()` so the relay host directory never silently masquerades as a
project root. Sessions without an explicit configured CWD launch in the relay's working directory.

A plain `cd <path>` chat command persists to that conversation's configured CWD only — it does not
affect other sessions or the global relay root.

Use the chat header **⋯** menu and choose **🗂️ Change CWD** to switch the selected session's next
launch directory from the list of known directories. The CWD picker always stays available; the
launch action is only enabled for the selected CLI when it is not running.

### Socket events for CWD changes

| Event | Emitter | Meaning |
|---|---|---|
| `workspace_root_changed` | Admin CWD picker (`POST /api/workspace-root`) | Global relay root changed; affects all sessions that have no per-session root configured |
| `conversation_workspace_root_updated` | Chat `/cd` command and conversation CWD API | Per-conversation configured root updated; only the referenced conversation is affected |

## Install as an app

The UI is now a Progressive Web App. On Android Chrome, use the browser menu to choose
**Install app** or **Add to Home screen**. Installed app mode now prefers fullscreen launch
where supported (with standalone fallback), and hides install/fullscreen header buttons.

When opened in a regular browser tab, the in-app **Install** button remains available
in the chat header (shown as `⬇` on small screens).

You can rename the installed app label from **⚙️ Settings → Install app name**.
The new label is stored per browser and used for future installs; some platforms may
require reinstalling the app before the launcher label updates.

You can also hide the **💤 Suspend host** action from **⚙️ Settings** with the
**Show Suspend host action** checkbox. This only controls UI visibility; it does not
change host suspend implementation behavior.

If you host the relay behind a subpath, set `remotePath` in `server/config.json` to that public path prefix and open the URL with a trailing slash so the PWA scope matches correctly for install prompts. The relay serves a path-relative manifest identity (`id`, `start_url`, `scope`) so each install stays bound to its own URL subtree and avoids cross-app collisions on shared origins.

## Model Selection

The composer includes a model picker next to the Send button.
Models are now populated dynamically from the active Copilot CLI runtime using
raw model IDs (no relay-specific aliases). The selected model ID is sent as-is
for each message.

Behavior notes:

- The picker refreshes from live CLI model discovery when relay status changes.
- Selection is persisted in browser storage and reused if still available.
- If live discovery is temporarily unavailable, the relay can use cached/current
  model state and shows a warning banner.
- In extension-managed mode, the relay still switches model per message and
  reports the active model used in the response.

### OpenAI API key

Open **Settings → OpenAI API key** to save an OpenAI key and exact model ID
(`gpt-4o` by default). Use the provider toggle to switch new conversations
between OpenAI and GitHub Copilot without re-entering the saved key. While
enabled, newly created extension-managed conversation workers start with Copilot
CLI BYOK environment variables pointing to `https://api.openai.com/v1`.
Zero-message conversations follow provider changes; started conversations keep
their original provider and lock the composer to their assigned model.

GPT-5 and OpenAI reasoning-model sessions use the Responses API automatically;
other OpenAI models retain the broader-compatible Chat Completions wire format.
OpenAI BYOK sessions currently use reasoning effort `none`; GitHub Copilot
reasoning choices remain separate even when both providers expose the same model
ID.

Saving or re-enabling the key refreshes OpenAI's `/v1/models` list and adds
candidate OpenAI model IDs to the composer picker. The Settings model-variant
refresh performs the same discovery while OpenAI is enabled and retains the
cached list if discovery fails. Starting a conversation uses the cached list; it
does not make another discovery request. The model selected when creating a
conversation is persisted on that conversation and used as its `COPILOT_MODEL`;
the Settings model is only the default. Starting a chat from a locked OpenAI
conversation opens an independent model chooser without changing the active
conversation.

Disabling OpenAI retains the key and cached model list. Removing the key is a
separate destructive action and makes subsequent conversations use GitHub
Copilot.
An existing OpenAI-assigned conversation can continue while its worker remains
running, but cannot launch a replacement worker until an OpenAI key is configured.

### Claude models

When the Claude provider is enabled, discovered `claude-*` IDs join the same catalog. The composer
only offers models the active conversation's provider can serve, so Claude models are hidden in
Copilot/OpenAI conversations and vice versa.

**Select Models** has one tab per runtime — **Copilot**, **OpenAI**, **Claude SDK**, **Cursor SDK** —
and each tab lists only rows contributed by that runtime. The Claude and Cursor tabs write their
selection through `POST /api/settings/claude` / `POST /api/settings/cursor` (`enabledModels`) rather
than the model-variant catalog; the configured default model is always enabled and cannot be
deselected, since deselecting it would leave that provider's conversations without a model. An empty
selection means "all available".

`POST /api/model-variants/refresh` refreshes all enabled providers concurrently and reports
`openAIModelDiscovery` and `claudeModelDiscovery` separately, so one provider's failed discovery does
not hide another's success — the cached list is kept and a warning is surfaced in the UI.

## Claude Agent SDK provider

Claude conversations are executed by `server/claude-worker/claude-session-worker.mjs`, a plain Node
process spawned per conversation. It is not part of the Copilot CLI extension: it connects to the
same worker WebSocket, sends the same heartbeats, and posts to the same activity/stream/thought/
response endpoints, but runs turns through `@anthropic-ai/claude-agent-sdk` instead of the Copilot SDK.

### Enabling

**Settings → Claude (Agent SDK) → Enable Claude for New Chat model selection.**

Authentication uses the relay host's own logged-in Claude credentials (`~/.claude`) — the relay never
stores an Anthropic API key. Run `claude` on the host and complete login before enabling. A turn that
fails to authenticate is answered with a system note telling you to do exactly that, rather than
being retried silently.

Enabling (or changing the default model) triggers model discovery: a short-lived idle `query()` is
opened purely to serve a `supportedModels()` control request, with a 20 s timeout. Discovered
`claude-*` IDs — including bracketed capability variants such as `claude-opus-5[1m]` — are stored and
added to the model catalog. Bare aliases (`default`, `sonnet`) are dropped in favour of the explicit IDs.
In the composer, `[1m]` variants are folded into their base model: the base ID is the only dropdown
entry, and the variant is selected through the context-size dropdown (`long_context` composes the
`[1m]` ID on send and in the persisted per-conversation model preference).

Disabling Claude rebinds conversations that have not yet sent a message back to the default provider,
mirroring the OpenAI key-removal reconciliation. Conversations that have already started keep their
provider, and other providers' bindings are never touched.

### Per-turn behavior

| Relay mode  | Claude mapping                                                              |
| ----------- | --------------------------------------------------------------------------- |
| `plan`      | SDK `permissionMode: 'plan'`; `ExitPlanMode` publishes a **plan_ready** board, then the tool call is **denied** so the turn ends for review instead of rolling straight into implementation — the board's choice starts the next turn in the chosen mode |
| `ask`       | System prompt appended to prefer `AskUserQuestion` before implementing        |
| `agent`     | Default permission mode, unmodified preset prompt                            |
| `autopilot` | System prompt appended to keep moving unless input is truly blocking          |

- **Model and reasoning effort are per turn.** Each turn is a fresh `query()` with `resume`, so both
  can change between messages. Effort levels are `none` (SDK default) plus whatever the model reports
  (`low`, `medium`, `high`, `xhigh`, `max`).
- **Tools are auto-allowed**, matching the Copilot workers' `--allow-all` posture. Only two tools are
  intercepted: `AskUserQuestion` (bridged to relay question cards) and `ExitPlanMode` (plan board;
  denied after the board posts — the plan text comes from the tool input, or from the CLI's
  `planFilePath` when no inline plan is sent).
- **Attachments** — images up to 5 MB are inlined as base64 content blocks; larger images and all
  non-image files are passed as absolute path references for Claude's `Read` tool.
- **Subagents** — `forwardSubagentText` is on, so subagent text, thoughts, and activity stream into
  their own nested bubbles. Targeted subagent cancellation is *not* supported; `abort_subagent`
  control requests are answered with an explicit "not supported" result. Full-turn **Stop** works.
- **Thinking** — the worker requests summarized thinking *display* without passing a `thinking`
  option, so it never switches thinking on for a session that has it off, and never changes a budget.

### Session continuity

The native Agent SDK session id observed on the first turn is posted to
`POST /api/claude-native-session` and stored in `runtime_sessions.claude_native_session_id`. Later
turns pass it back as `resume`, so a Claude conversation survives worker restarts. The id is only
cached in the worker after the server accepts it, so a failed persist is retried next turn.

### Context usage

Claude sessions have no Copilot `events.jsonl` to tail. Instead the worker reads the live
context-window breakdown with `getContextUsage()` while the turn's `Query` is still open, and posts it
to `POST /api/claude-context-usage`; the relay stores it in `runtime_sessions.context_usage_json`.
`GET /api/context/:id` then serves Claude and Copilot sessions through one normalized `contextUsage`
view so a single renderer handles both. Claude supplies real per-category token counts; Copilot's
coarse system/tools + messages + buffer split is synthesized into the same shape and flagged
`isEstimate` when the runtime only reports a lower bound.

### Worker environment

`applyClaudeProviderEnvironment` sets these on the worker launch environment:

- `COPILOT_WEB_RELAY_WORKER_KIND=claude` — selects the Claude worker instead of the Copilot CLI
- `CLAUDE_RELAY_MODEL` — the conversation's model, used when a turn carries none

Also honored by the worker: `COPILOT_WORKSPACE_ROOT` (cwd), `COPILOT_WEB_RELAY_CONFIG` (relay config
path), `CLAUDE_CODE_EXECUTABLE` (explicit Claude Code binary), and
`COPILOT_WEB_RELAY_CLAUDE_WORKER_PATH` (override for the worker script location).

On Linux/macOS the Claude worker still launches inside a `tmux` session named after the SDK session
id, but without the `script`-based pseudo-TTY the Copilot workers need — it is a plain Node process.
On Windows it opens a `Claude Worker <id>` terminal window.

### Provider-aware usage snapshots

`fetchUsageSummary` reads GitHub Copilot plan quota, so it is skipped entirely for OpenAI and Claude
turns. Those replies carry no usage line rather than displaying Copilot premium-request numbers under
a reply that never touched Copilot.

## Cursor Agent SDK provider

Cursor conversations run through `server/cursor-worker/cursor-session-worker.mjs`, a per-conversation
Node worker like the Claude one, backed by the Cursor Agent SDK. Authentication uses a Cursor API key
saved via **Settings → Cursor SDK** (`POST /api/settings/cursor`); saving or replacing the key resets
and re-runs model discovery, which also records each model's supported reasoning-effort tiers
(`effortsByModel`).

Per-turn behavior:

| Relay mode  | Cursor mapping                                                               |
| ----------- | ---------------------------------------------------------------------------- |
| `plan`      | SDK native plan mode; a plan-shaped final message publishes a **plan_ready** board |
| `ask` / `autopilot` | The SDK's send options carry no per-turn instruction channel, so a `[Relay mode: …]` nudge is prepended to the user message — injected only when the mode changes, and a change away from a nudged mode sends an explicit cancellation |
| `agent`     | Default behavior, no injection                                                |

- **Model and reasoning effort are per turn.** Effort is validated against the model's discovered
  tiers (`none` = model default); for `auto`/undiscovered models the request passes through and the
  worker validates it against the resolved model's live params.
- **Stale agent handles are retried once.** A cached agent handle whose exchanged auth expired fails
  as a terminal error result even though the API key is still valid, so the worker recreates the
  handle and retries a single time; a second auth failure is treated as a real key problem.
- **Session root** — the worker keeps its per-session agent store at
  `$CURSOR_AGENT_STORE_DIR` or `server/data/cursor-agents/<sdkSessionId>`, created on the first turn.
  The explorer's Session root resolves to it via `resolveCursorSessionRoot`.
- Cursor turns are skipped by `fetchUsageSummary` like OpenAI and Claude turns — no Copilot usage
  line is attached.

## Turn recovery and the max turn duration

A turn in `processing` is returned to the queue by two independent guards. **Both exempt a turn that
is blocked on an unanswered relay question** — that turn is waiting on a human, and `relay_questions`
carries its own expiry.

1. **Inactivity (`processingTimeoutMs`, default 10 min).** Measured from `owner_last_claimed_at`,
   which every worker heartbeat refreshes for the message it is working on — *not* from when the turn
   began. A turn that legitimately runs for hours of tool calls keeps pushing the cutoff forward.
   `processing_at` is only the fallback for rows with no owner (session-worker routing disabled).
   While the CLI is offline the window shrinks to 45 s.
2. **Absolute ceiling (Settings → Max turn duration, default 60 min).** Measured from `processing_at`.
   `0` disables it; the slider range is 0–600 minutes in 5-minute steps. This is a backstop for a
   worker that has hung while still heartbeating, and is stored in the DB app setting
   `turn_ceiling_minutes` — not in `config.json`. Shared bounds and formatting live in
   `shared/turn-ceiling.mjs`.

## Subagent runs and live streaming

- `POST /api/stream` and `POST /api/activity` / `POST /api/thought` accept an optional
  `subagentRunId`. Frames carrying one are routed to that subagent's bubble instead of the parent.
- The browser renders a **live reply preview**: main-thread stream text is markdown-rendered into the
  pending bubble while the turn runs, and replaced by the real message when it completes.
- Subagent bubbles nest by `parentSubagentId`. A child event arriving before its parent's bubble
  exists builds the parent chain on demand, so nesting is preserved regardless of event order.
- After the turn finishes, `subagentRuns` are returned with the assistant message and re-rendered as
  collapsible **🤖 <name>** sections containing that run's thoughts and activity.
- Reloading mid-turn repaints both the reply preview and every subagent bubble from persisted stream
  rows (`deriveInFlightStreamTextByThread`).
- The Copilot extension propagates the SDK `agentId` onto question/tool activity, so subagent-issued
  `ask_user` calls and tool results land in the right bubble. Re-discovering a known run no longer
  demotes it to a root or renames it.

## Conversation list active-turn flag

`GET /api/conversations` returns `activeTurn` per conversation, derived from
`listConversationIdsWithActiveQueue` (`pending` / `processing` / `parked`). Clients previously tracked
this only from one-shot `message_status` socket events, which are lost if the socket drops between a
turn finishing and delivery — leaving a permanent spinner. `activeTurn: false` now clears the
client's optimistic state. Relay shutdown also waits 300 ms before disconnecting sockets so a terminal
`message_status` emitted just before an idle-deferred restart still reaches the browser.

## Image conversations (OpenAI BYOK)

Choosing **OpenAI Image (BYOK)** in New Chat creates a conversation whose replies are generated
images, calling the OpenAI Images API directly rather than going through a CLI worker.

- The New Chat dialog swaps **Reasoning effort** for **Quality**, and adds a **Size** picker whose
  options depend on the model (`dall-e-2`: 256/512/1024 squares; `dall-e-3`: 1024 plus the two
  1792 orientations; otherwise `auto` plus the 1024/1536 set). The chosen size is remembered per
  browser and becomes the conversation's context tier.
- Generated images are stored per conversation and streamed from
  `GET /api/generated-image/:conversationId/:messageId/:imageId/content`.
- **Edit this image** on a generated image sets it as the composer's image target (shown as an
  *Editing …* chip); the next message is queued as an edit of that image instead of a fresh
  generation. Image operations are recorded so a follow-up can continue from the right source image.
- Deleting a conversation garbage-collects its generated images.
- Continuity is gated by the `IMAGE_CONVERSATION_CONTINUITY_ENABLED` feature flag (on by default).

## Conversation sharing and per-message visibility

- **Share** on a conversation issues a read-only token; shared viewers read through
  `GET /api/shared/:token` and its scoped upload/generated-image content routes.
- `PATCH /api/conversation/:id/message/:messageId/share-visibility` toggles a single message's
  `hidden_from_shares` flag. Hidden messages are filtered out of every shared view while staying
  fully visible — and visibly marked as hidden — to the owner.
- The control appears on message hover; already-hidden messages keep their label visible so the state
  is never silently lost.
- `POST /api/shared/:token/presence` tracks shared-viewer presence, surfaced as a watcher count.

## Relay Mode Selection

The composer also includes a per-message mode picker:

- `plan`
- `ask`
- `agent`
- `autopilot`

Mode is stored with each queued message so the relay can change behavior per turn.
Clarification prompts from the CLI are forwarded back into the browser as question
cards with a reply box.

`plan` mode behavior:
- Draft a concise implementation plan only (no implementation output).
- Read-only inspection is allowed when it materially improves plan quality (for example `glob`, `rg`, `view`).
- Do not edit repository files or run mutating commands unless implementation is explicitly requested.

## Conversation titles

The active conversation header includes a `✍️` button for renaming the conversation inline.
Title edits are saved to the database and broadcast to other open clients immediately.

## Session worker rollout flags

Session-worker refactor gates are OFF by default and can be enabled per flag:

- `SESSION_WORKER_ROUTING_ENABLED`
- `SESSION_WORKER_CONTINUATION_ROUTING_ENABLED`
- `SESSION_WORKER_FALLBACK_RESTART_ENABLED`

Other flags:

- `IMAGE_CONVERSATION_CONTINUITY_ENABLED` — ON by default; keeps generated-image context across turns
  so *Edit this image* can continue from the right source image.

Configuration precedence is:

1. `server/config.json` → `features.{FLAG_NAME}` (`true/false`, `1/0`, `yes/no`, `on/off`)
2. Environment override: `COPILOT_REMOTE_{FLAG_NAME}`

Unknown flag names and invalid values are ignored safely.

Question bridge rule:

- User-facing questions/clarifications must use `ask_user` so they flow through
  the relay question bridge and render as web question cards/buttons.
- This applies in `autopilot` too: still call `ask_user` for clarification, and
  the relay layer will surface the question card even if the direct question hook
  is bypassed.
- Plain-text assistant questions are not considered bridge-backed questions, and there is
  **no fallback that converts them into question cards**. Every relay question originates from an
  explicit request — `onUserInputRequest`, `onElicitationRequest`, or Claude's `AskUserQuestion`.
  A turn that merely ends with a plain-text question simply completes, and the user answers it as
  the next message.

## Session Worker Management

Session workers are long-running CLI processes that execute turns for Copilot agent sessions. The relay manages a pool of workers to enable:
- Parallel execution (multiple sessions can run simultaneously)
- Session persistence (a worker stays alive across turns for a given session)
- Graceful restarts (degraded workers are replaced without losing queued work)

### Worker Lifecycle States

1. **Spawned** — Worker process created, initializing CLI connection
2. **Ready** — Worker opened WebSocket to relay, registered in worker pool, ready to accept turns
3. **Processing** — Worker actively executing a turn (streaming activity to browser)
4. **Degraded** — Worker failed heartbeat or reported errors; relay moves pending work to other workers or restarts
5. **Dead/Exited** — Worker process terminated; polling loop will spawn replacement if turns still pending

### Worker Heartbeat & Health Check

- Workers send keep-alive pings every 30 seconds (default) to `/api/workers/{id}/heartbeat`
- Relay tracks last heartbeat time for each worker
- If a worker misses 2+ consecutive heartbeats (~60 seconds), it's marked "degraded"
- Degraded workers don't receive new turns; existing work is reassigned
- Polling loop detects degraded workers and respawns them if they're still needed

### Supervisor Service

The **session-worker-supervisor-service** tracks all active workers:

- Maintains registry: `workers[sdkSessionId] = { id, process, sdkSessionId, status, lastHeartbeat }`
- Monitors process health: checks if process is still running, collects exit codes
- Handles restarts: when a worker fails, spawns a replacement with exponential backoff
- Cleans up: removes dead workers from registry after TTL (default 5 minutes)

### Environment & Workspace

Session workers inherit:

- `COPILOT_WORKSPACE_ROOT` — Target workspace directory (from turn metadata or session config)
- `INIT_CWD` — Initial working directory (fallback for workspace resolution)
- `COPILOT_REMOTE_*` — All relay config via environment variables
- CLI session state from the last known good checkpoint

### Restart Orchestration

When a worker needs restart:

1. **Graceful shutdown** — Send SIGTERM, wait up to 5 seconds for clean exit
2. **Kill if needed** — Force SIGKILL if SIGTERM timeout
3. **Backoff** — Wait before respawn (start at 1s, double up to 30s max)
4. **Reassign work** — Any pending turns for that session are placed back in queue for the new worker
5. **Report status** — Relay broadcasts worker status to browser UI (shows "reconnecting..." briefly)

### Platform-Specific Behavior

- **macOS/Linux:** Workers prefer `tmux` sessions for better isolation and debugging (can attach with `tmux attach -t {sessionId}`)
- **Windows:** Workers launch in a new Terminal window (TTY-Console if available, otherwise cmd)
- Both: Worker inherits relay's environment and runs from relay repo root so project-local extensions are discoverable

## How It Works

```
[Browser] ←── WebSocket ──→ [server.js :3333] ←── WebSocket-first relay ──→ [Copilot CLI session]
```

1. Browser sends a message → stored in server queue
2. The relay worker socket delivers queued turns to the bound CLI session immediately
3. The CLI processes the turn and posts the response to `POST /api/response`  
4. Server broadcasts response via Socket.io → appears in browser instantly

## Monitoring Mode (CLI)

After launching the server, the CLI opens a worker WebSocket link:
- Identifies itself with the bound SDK session id and worker pid
- Receives queued turns over `ws(s)://.../api/session-worker/ws`
- Reconnects starting at 1 second, with exponential backoff capped at 8 seconds
- Falls back to `GET /api/pending` only while the worker socket is unavailable
- Processes any message with full PC access (file system, commands, etc.)
- Posts the response back
- CLI appears **online** (green dot) in the web UI while the relay is connected
- While working, relay tool activity is streamed into the pending assistant bubble
  (for example `Search (glob)` and `Search (grep)`).
- Assistant reply text is streamed into the pending assistant bubble while the turn is running.
- Tool activity is now also kept with the assistant message as a collapsible
  **Tool activity** section after the response arrives.
- Clarification prompts from `ask_user`/user-input requests are forwarded as
  question cards in the conversation; answering the card resumes the waiting turn.
- Answered relay question cards stay visible in the conversation journal, including
  the answer you submitted.

### Session activation behavior (important)

In extension-managed mode, the web server can already be running while the CLI is still
shown as offline. The worker socket starts when the Copilot session becomes active
(`onSessionStart`), which usually happens after your first prompt in the CLI.

This means the following startup sequence is expected:
1. Open `http://localhost:3333` and briefly see "CLI is offline"
2. Send one message in the CLI
3. Extension opens the worker socket and queued web messages begin processing

If a conversation is still unbound when the CLI first sees it, the extension now claims it through `/api/session-sync` before processing so the browser can send back to the same SDK session. A separate startup sync to `/api/session-workspace-root` reports the CLI working directory for the already-bound session; it no longer creates a placeholder conversation on its own.

| Symptom | Check |
|---|---|
| UI says "CLI is offline" | Verify `/api/status` works with the auth cookie or `Authorization: Bearer <token>` and shows `cliOnline: true` |
| UI flaps online/offline after restart | Ensure you are not mixing extension-managed mode with standalone `relay.mjs`, and confirm only one relay process owns port `3333` |
| "Web relay connected" banner repeats too often | Ensure only one extension instance is active; banner dedupe now persists across extension restarts for the same CLI session and reprints only when relay details change |
| No response after sending | Tail `server\ext-debug.log` and confirm `onSessionStart fired` + `startPolling called` |
| Wrong model used | Check logs for `Model selected: requested=... active=...` |
| Question card stuck | Answer in the card UI; logs should show `relay question created` and `relay question answered` |
| Tunnel not connecting | Check server console for `[ssh-tunnel]` lines; confirm SSH key auth works without password |
| Tunnel keeps reconnecting | VPS `sshd_config` needs `GatewayPorts no` (default) — Caddy handles the public port |

## Windows-Specific Runtime Behavior

### Worker Launcher

- Workers on Windows launch via a **stable Terminal window** (when available).
- If TTY-Console (optional dependency) is installed, workers use an interactive terminal for debugging.
- Otherwise, workers spawn in a new `cmd` or PowerShell window.
- Window name is workspace-based so repeated worker restarts reuse the same window instead of opening duplicates.
- Claude workers open a `Claude Worker <id>` window running `node claude-session-worker.mjs` directly, instead of the `gh copilot` launch path.

### Path Handling

- **Drives API** — `/api/drives/roots` returns fixed/removable drive letters (`C:`, `D:`, etc.) instead of mount points.
- **Path format** — `C:/Users/alice/project/file.txt` (forward slashes, drive letter prefix).
- **Directory listing** — Uses PowerShell via `Get-ChildItem` for recursive listings (faster than fs.readdir on large directories).
- **Workspace root** — Must be an absolute Windows path; relative paths or UNC paths (`\\server\share`) are handled but may behave unexpectedly.

### Model Refresh

- Model discovery on Windows invokes `copilot.ps1` via PowerShell with `-ExecutionPolicy Bypass` to bypass execution policy restrictions.
- Command: `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "copilot help config | Select-String -Pattern 'gpt'"`.
- If PowerShell is not available, falls back to direct `copilot help config` (may fail due to execution policy).

### Environment Variables

- Workers inherit all relay server environment, including `COPILOT_WORKSPACE_ROOT` and `INIT_CWD`.
- On Windows, these paths use backslash or forward-slash format; CLI normalize paths automatically.
- `PYTHONUNBUFFERED=1` and `NODE_OPTIONS` should be set before relay startup for worker inheritance.

### SSH Tunnel on Windows

- SSH tunnel uses `ssh.exe` (assumes `git-bash` or OpenSSH is in PATH).
- If SSH is not available, tunnel mode cannot be "managed"; stays in "disabled" mode.
- Windows Firewall may require inbound rule for local relay port (default 3333) if browser is on another machine.

## API Reference

All authenticated routes accept an HttpOnly auth cookie or an `Authorization: Bearer <token>` header.

`GET /api/status` now also includes `readyBanner`, a preformatted relay-info payload used by the CLI extension to print the access window directly in the Copilot CLI client when relay connectivity is established.
It also includes `restartOrchestrator` with the current relay-side restart transaction state.
It also includes `relayShutdown`, which reports queued manual relay shutdown/restart state separately from the worker restart orchestrator.
Queue metrics include `parkedCount` for turns deferred behind restart/rebind gates.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/message` | Send a message from the browser |
| POST | `/api/upload` | Upload binary file content (deduped by SHA-256) |
| GET | `/api/upload/:sha256/content` | Stream stored upload content by hash |
| GET | `/api/files/*` | Stream a workspace file by repo-relative path (token required) |
| GET | `/api/files-preview/*` | Return structured preview JSON for markdown/code/text/image/video files |
| GET | `/api/repo/tree` | Return repository root + first-level entries for lazy workspace browsing |
| GET | `/api/repo/list` | Lazy-load workspace directory entries (`path`, `includeHidden`, `includeHeavy`) |
| GET | `/api/drives/roots` | Return browsable root(s) for explorer drive mode — on Windows returns fixed/removable drive letters; on Linux returns a single `/` root node |
| GET | `/api/drives/list` | Lazy-load directory entries (`path`, optional `includeHidden`) — on Windows `path` is a drive-letter path (e.g. `C:/foo`); on Linux `path` is an absolute POSIX path (e.g. `/home/user`) |
| GET | `/api/session-root/list` | List the explorer's Session root (`path`, optional `includeHidden`) — like `/api/drives/list`, but a not-yet-created root returns an empty folder (`exists: false`) instead of 404, and the sibling `<path>.jsonl` transcript is appended as a child |
| GET | `/api/drives/file` | Stream a file by path — Windows drive path or Linux absolute path depending on server platform |
| GET | `/api/drives/files-preview` | Return structured preview JSON for a file — Windows drive path or Linux absolute path depending on server platform |
| GET | `/api/git/status` | Git status for the conversation's workspace root (`branch`, `upstream`, `ahead`, `behind`, `files[]` incl. untracked); a non-repo root returns `isRepo: false` rather than an error |
| GET | `/api/git/diff` | Full-context unified diff for one changed file (`path`, optional `untracked=1`); the client renders both "changes only" and "full file" views from this single patch |
| POST | `/api/git/pull` | Run `git pull` in the conversation's workspace root and return the combined output |
| GET | `/api/conversations` | List all conversations |
| GET | `/api/sessions` | List runtime sessions bound 1:1 to conversations |
| GET | `/api/conversation/:id` | Get conversation message windows (`before*`, `after*`, or `aroundMessageId`) plus session-root metadata |
| GET | `/api/search/messages` | Search message text across all conversations (`q`, `limit`, `offset`) |
| PATCH | `/api/conversation/:id` | Update a conversation title |
| POST | `/api/conversation/:id/compact` | Compact a conversation into a new one with carry-over summary seed |
| DELETE | `/api/conversation/:id` | Delete a conversation |
| GET | `/api/sdk-session-delete/pending` | (CLI relay) Fetch next pending SDK session delete request |
| POST | `/api/sdk-session-delete/result` | (CLI relay) Report SDK session delete result |
| POST | `/api/session-sync` | (CLI relay) Sync conversation↔SDK binding and optionally confirm orchestrator rebind completion |
| POST | `/api/session-workspace-root` | (CLI relay) Report the startup workspace CWD for a session once it is known |
| GET | `/api/pending` | (CLI) Fetch next pending message |
| POST | `/api/response` | (CLI) Submit response for a message |
| GET | `/api/restart-orchestrator` | Read relay restart orchestrator state |
| POST | `/api/restart-orchestrator/request` | Queue a restart transaction for a target SDK session |
| POST | `/api/activity` | (CLI) Push in-flight tool activity for current message; web search/fetch entries may include bounded queries, URLs, and output previews, while `store_memory`/`vote_memory` entries include available memory metadata |
| POST | `/api/stream` | (CLI) Push in-flight assistant text stream for current pending message |
| POST | `/api/relay/pause` | Pause dequeueing and drop currently queued messages |
| POST | `/api/relay/resume` | Resume dequeueing after pause |
| POST | `/api/relay/shutdown` | Queue a localhost-only authenticated relay shutdown or self-restart |
| GET | `/api/relay-questions` | (CLI/UI) List relay questions by `status` (for example `pending` or `answered`) |
| GET | `/api/relay-question/:id` | (CLI) Fetch a single relay question |
| POST | `/api/relay-question` | (CLI) Create a relay question for the browser |
| POST | `/api/relay-question/:id/answer` | (UI) Submit an answer for a relay question |
| POST | `/api/relay-question/:id/timeout` | (CLI/UI) Mark a relay question timed out |
| POST | `/api/heartbeat` | (CLI) Keep CLI status alive |
| GET | `/api/status` | Overall status |
| GET | `/api/models` | Live/cached model catalog used by the UI picker |
| POST | `/api/models/snapshot` | (CLI/relay) Publish discovered model snapshot |
| POST | `/api/conversation/:id/refresh-history` | Re-import an existing conversation's history through the local Copilot SDK |
| GET | `/api/context/:conversationId` | Context metrics for a conversation or `sdk_session_id`. Copilot sessions are parsed from session-state events (falling back to a labeled lower-bound completion-token estimate when full legacy buckets are missing); Claude sessions are served from the breakdown their worker stored. Both return the same normalized `contextUsage` view alongside `providerType` and the runtime's own `text` dump |
| GET | `/api/context` | Same payload when a `conversationId` query is provided; otherwise returns a missing-selection response |
| GET | `/api/usage` | Unified plan usage: one card per configured provider (`providers[]` with `meters`, `details`, `links`) built from the live Copilot quota, the Claude worker's latest stored snapshot, and the derived Cursor cycle totals. A provider that cannot be read yields an unavailable card rather than failing the response, so the modal always renders. Legacy top-level Copilot quota fields are spread alongside `providers` for cached clients; `?legacy=1` returns the Copilot-only snapshot on its own |
| GET | `/api/settings/cursor-allowance` | Read the manual Cursor plan allowances (`cursorModelsUsd`, `otherModelsUsd`, `resetDay`) |
| POST | `/api/settings/cursor-allowance` | Set the Cursor pool allowances and billing reset day; `null` clears an allowance, and `resetAccounting: true` re-baselines the derived spend tracking |
| GET | `/api/settings/claude` | Read Claude provider settings (`enabled`, `model`, `models`, `availableModels`) |
| POST | `/api/settings/claude` | Enable/disable Claude, set the default model or the enabled model subset; triggers discovery and unstarted-conversation reconciliation |
| GET | `/api/settings/cursor` | Read Cursor provider settings — same shape as Claude's: `models` is the enabled subset, `availableModels` the full discovered list, plus per-model `efforts` |
| POST | `/api/settings/cursor` | Set/remove the Cursor API key, default model, or enabled model subset; key changes reset discovered models and effort tiers |
| GET | `/api/settings/turn-ceiling` | Read the max turn duration plus slider bounds (`minMinutes`, `maxMinutes`, `stepMinutes`, `defaultMinutes`) |
| POST | `/api/settings/turn-ceiling` | Set the max turn duration in minutes (`0` = no limit) |
| POST | `/api/claude-native-session` | (Claude worker) Persist the native Agent SDK session id for resume |
| POST | `/api/claude-context-usage` | (Claude worker) Report the session's context-window breakdown after a turn |
| POST | `/api/claude-plan-usage` | (Claude worker) Report the session's structured `/usage` data — plan rate-limit windows plus session cost totals — falling back to the stable `modelUsage`/`totalCostUsd` result fields. Stored as the latest Claude snapshot |
| POST | `/api/cursor-plan-usage` | (Cursor worker) Report the agent's cumulative billed usage; the relay diffs it against a per-agent checkpoint and books the increase into the current billing cycle under the pool implied by the turn's model |
| POST | `/api/subagent-run` | (Worker) Register/update a subagent run for the active turn |
| POST | `/api/conversation/:conversationId/subagent/:subagentRunId/cancel` | Request cancellation of one subagent run (unsupported by the Claude runtime) |
| PATCH | `/api/conversation/:id/message/:messageId/share-visibility` | Hide or unhide a single message from shared views |
| POST | `/api/conversation/:id/share` | Create or update the conversation's read-only share token |
| GET | `/api/shared/:token` | Read-only shared conversation view (hidden messages filtered out) |
| POST | `/api/shared/:token/presence` | Report shared-viewer presence for the watcher count |
| POST | `/api/openai/images/generate` | Generate images for an OpenAI Image conversation |
| POST | `/api/image-operations/:operationId/execute` | Execute a queued image generation/edit operation |
| GET | `/api/generated-image/:conversationId/:messageId/:imageId/content` | Stream a generated image blob |

### Manual relay shutdown / self-restart

- `POST /api/relay/shutdown` is localhost-only even when the relay is otherwise reachable on the network.
- The request body accepts:
  - `reason` (optional string)
  - `requestedBy` (optional string)
  - `restart` (optional boolean-ish flag; `true` queues self-restart instead of plain shutdown)
- Example restart request:

```json
{
  "reason": "manual-restart",
  "requestedBy": "localhost-api",
  "restart": true
}
```

- Response payload includes:
  - `status`: `queued` or `shutting_down`
  - `action`: `shutdown` or `restart`
  - `restart`: boolean mirror of the action
  - `requestedAt`, `reason`, `requestedBy`
  - `queue`: current `pendingCount` / `processingCount` / `parkedCount`
- The relay waits until the queue is idle before acting; this API is not an interrupt or cancel mechanism.
- Ownership after an intentional restart depends on the active runtime owner:
  - extension-managed `server.js` relaunches under `.github/extensions/web-relay/server-lifecycle/managed-server.mjs`
  - standalone `npm start` relaunches under `server/start.js`
  - bare `node server.js` keeps `server.js` attached as the self-restart supervisor, respawns a worker-mode child, and keeps the same terminal session alive

### Upload storage model

- Physical blobs are stored in `server/uploads/<sha256>` (content-addressed).
- Metadata (`original_name`, `mime_type`, `size_bytes`) is stored in SQLite.
- Message/conversation references are tracked in SQLite; when a conversation is deleted,
  unreferenced blobs are garbage-collected from disk automatically.
- Image attachments are forwarded to the Copilot SDK as multimodal attachments
  (`file` when a disk path is available, otherwise inline `blob`).
- Non-image uploads continue to be exposed as file references.

### Chat file reference tokens

- The web explorer/file preview can copy references as backticked tokens:
  - ``@file:<path>``
  - ``@folder:<path>``
- Folder tokens use the full folder path.
- File tokens use the full file path shown by the preview/browser context.
- Tokens are root-agnostic: workspace paths are repo-relative, drive paths keep `C:/...` form.

### Reference-driven inspection helper

- Messages containing `@file:` tokens are parsed server-side before queueing.
- Text/markdown references stay as plain references (no binary payload attached).
- Small image references (up to ~1 MB) are attached to the pending turn so vision-capable
  models receive real image input.
- Oversized image references are left as plain text references to avoid oversized request payloads.

### Workspace file bridge

- Use `/api/files/<repo-relative-path>` to open workspace files in a new tab. The browser sends the auth cookie automatically.
- Use `/api/files-preview/<repo-relative-path>` for structured preview JSON (`kind`, `language`, `content`, `truncated`, `size`).
- Use `/api/repo/tree?includeHidden=0&includeHeavy=0` to load workspace root and first-level entries.
- Use `/api/repo/list?path=<repo-relative-dir>&includeHidden=0|1&includeHeavy=0|1` for lazy-loaded workspace directory browsing.
- Use `/api/drives/roots` + `/api/drives/list?path=<path>&includeHidden=0|1` for lazy-loaded drive/root browsing (separate from workspace heavy mode).
- Use `/api/drives/file?path=<path>` and `/api/drives/files-preview?path=<path>` for drive/root file raw/preview access.
- Use `/api/session-root/list?path=<sessionRootPath>&includeHidden=0|1` for the explorer's Session root. Child directories below it lazy-load through `/api/drives/list` as usual. The Claude Agent SDK creates a session's directory lazily — only once the session writes `subagents/` or `tool-results/` files — so the root is served as an empty folder until then rather than 404ing, and the transcript that lives one level up in the project directory is listed as a child of it. Cursor sessions resolve their Session root the same lazy way: the worker's per-session agent store (`$CURSOR_AGENT_STORE_DIR` or `server/data/cursor-agents/<sdkSessionId>`) exists only after the session's first turn, and the Session button stays disabled until it does.
- Requests are auth-protected and restricted to files inside the workspace root.
- **Platform split** — the drives API adapts automatically based on the server OS:
  - **Windows:** drive roots are discovered via `fsutil.exe`; paths use Windows drive-letter format (`C:/foo/bar`); directory listing uses PowerShell.
  - **Linux:** a single `/` root is returned; paths are absolute POSIX paths (`/home/user/file.txt`); directory listing uses `fs.readdir` + `fs.stat`.
- The `/api/status` response includes a `platform` field (`win32`, `linux`, `darwin`, etc.) so the browser UI can adapt path handling accordingly.
- Drive browsing is auth-protected; path traversal attacks and non-absolute paths are rejected on both platforms.
- Traversal or non-file paths are rejected.
- **Linux access scope** — on Linux the drives API currently allows any authenticated user to browse and read any path that the server process has OS-level read access to (i.e. the same permissions as the user running the relay). There is no additional allowlist restriction beyond requiring an absolute path.
  > **TODO:** add an optional `drivesAllowList` config key (array of absolute path prefixes) so operators can restrict drive access to a set of directories (e.g. home folder or workspace root). When the list is non-empty, requests whose resolved path does not start with one of the listed prefixes should be rejected with `403`.
  >
  > When implementing it, reuse `isWithinAllowedPrefix()` from `services/workspace-root-path-policy.mjs` rather than writing a second `startsWith` check — a bare prefix match would let `C:\work` admit `C:\work-secrets`. See `workspaceRootAllowList` below, which already follows this pattern.

### Git changes modal

The **🌿 Git changes** entry in the conversation `⋯` menu opens a modal over the conversation's
workspace root, backed by `services/git-changes-service.mjs` and `routes/git-routes.mjs`:

- `GET /api/git/status?conversationId=…` — branch, upstream, ahead/behind, and every changed file
  (staged, unstaged, and untracked; porcelain v1 parsing). The root is resolved server-side from the
  conversation scope exactly like the file-preview routes — the client never sends a path — and a
  workspace root that is not a git repository returns `isRepo: false` rather than an error.
- `GET /api/git/diff?path=…&untracked=0|1&conversationId=…` — one full-context unified diff
  (`-U999999`, untracked files via `git diff --no-index /dev/null`). The client renders both the
  **Changes only** view (context collapsed to gap markers) and the **Full file** view from this
  single patch; the parsing lives in `public/app/git-diff-model.mjs`.
- `POST /api/git/pull?conversationId=…` — runs `git pull` in the workspace root and returns the
  combined output.

File paths passed to `/api/git/diff` go through the same `resolveWorkspaceFilePath` containment
check as the file bridge, so traversal outside the workspace root is rejected.

### Changing the launch CWD

Two endpoints set a conversation's launch directory. Both accept the same aliases —
`rootPath`, `workspaceRootPath`, `workspace_root_path`, `cwd` — and both validate the
path before touching the database.

| Endpoint | Effect |
| --- | --- |
| `POST /api/conversation/:id/workspace-root` | Saves the next-launch CWD. Does not touch the running CLI. |
| `POST /api/conversation/:id/relaunch-with-workspace-root` | Saves the CWD, stops the CLI, and relaunches it in the new directory. |

**Validation** (`services/workspace-root-path-policy.mjs`): the path must be absolute
(drive-relative `C:foo` and extended-length `\\?\` forms are rejected), must not contain
`; & | \0 \r \n` — the same characters the chat `cd` command already rejects — and must
resolve, via `realpath`, to an existing directory. The resolved real path is what gets
persisted and spawned, so a symlink cannot smuggle a request past the allow list.
Failures return `400` with a `code` of `missing-root-path`, `invalid-root-path`,
`relative-root-path`, or `root-path-not-found`.

**`workspaceRootAllowList`** (optional, `server/config.json`, or the
`COPILOT_WORKSPACE_ROOT_ALLOW_LIST` env var using the platform path delimiter): an array of
absolute path prefixes. **Absent, `null`, `[]`, or not an array disables the check entirely**,
which is the default and matches the historical "any existing directory" behaviour. When it is
non-empty, a request outside every prefix is rejected with `403` and
`code: "root-path-not-allowed"`. Matching is on segment boundaries and is case-insensitive on
Windows. Entries that do not resolve to a directory are logged and dropped rather than failing
closed, so a typo cannot brick the relay.

**Concurrency.** All three endpoints that reach the session-worker launch path — the relaunch
route, the save route, and `POST /api/session-worker/:sdkSessionId/launch` — share one mutex
keyed by `sdkSessionId`. On top of that, the relaunch route coalesces duplicate requests
(a mobile double-tap, a second tab, a retried fetch) within a 5 s window:

- same request in flight → awaits it and returns the same body plus `coalesced: true`
- same request just settled → replays the cached body with `coalesced: true, cached: true`
- a *different* request in flight → `409` with `code: "relaunch_in_progress"`

Request identity is `conversationId` + the normalized path, or an explicit `Idempotency-Key`
header / `idempotencyKey` body field, which the web UI mints once per user gesture.
Both endpoints are additionally rate limited to 6 requests per 10 s per session and client IP,
returning `429` with `Retry-After`.

**Stop semantics.** The relaunch stops every process in the session's tree, waits for them to
exit, and escalates once (`SIGKILL` on POSIX; a re-enumerated forced pass on Windows, which
catches children spawned after the first snapshot). If anything survives, the relay **does not
launch** — it returns `409` with `code: "worker-stop-timeout"` and `remainingPids`, having still
saved the CWD for the next clean launch. Launching on top of a survivor is what previously left
two CLIs claiming one session.

**Response fields.** A successful relaunch reports what actually happened rather than a bare
`ok: true`:

| Field | Meaning |
| --- | --- |
| `relaunched` | A fresh process was started in the requested directory. |
| `workspaceRootApplied` | The running CLI is actually in the requested directory. |
| `reusedExistingProcess` | An existing process was reused, so the new CWD did **not** take effect. |
| `warning: "cwd-not-applied"` | Present with `activeWorkspaceRootPath` and a human-readable `message` whenever `workspaceRootApplied` is `false`. |
| `stoppedPids` / `launchedPid` | Which processes were killed and which was started. |
| `coalesced` / `cached` | This response was replayed from a duplicate request. |

**Recent CWD history.** `recent_workspace_roots` is keyed by `path_key`, a case-normalized form
of the path (lower-cased in full on Windows, untouched on POSIX), so `C:\Git\Repo` and
`c:\git\repo` occupy one row and the 12-entry cap counts distinct directories. The runtime
rebuilds an older table in place at startup; `server/migrations/0002-recent-workspace-roots-path-key.mjs`
performs the same rebuild offline.
- The web UI opens workspace mentions in an in-app preview dialog with **Preview / Raw** mode buttons.
- Markdown preview supports optional embedded-HTML mode with script/event-handler stripping and a visible warning.
- The floating **📁 Browse files** button opens the explorer with **Workspace**, **Drives**, and (when available) **Session** roots, tree navigation, list/icon folder views, and image thumbnails.

### Browser filter persistence and refresh behavior

- The **Hidden** and **Heavy** toolbar toggles are persisted in `localStorage`, under separate keys
  for the workspace root and the drives/session roots (the toolbar labels them differently:
  "Hidden" vs "Hidden/System"). Every filter defaults to off, so a fresh browser profile behaves
  exactly as it did before persistence existed.
- Refreshing the browser — via the Refresh button or a filter toggle — refetches the lazy tree and
  then re-opens the folders that were expanded, rather than collapsing back to the root. A rapid
  double-toggle is safe: the restore is applied against the tree that actually arrived last.
- Switching root, or a session root changing underneath the browser, discards a parked restore
  because the saved path belongs to the tree being left.

### External link handling

Links in chat bubbles, question cards, and subagent bubbles are opened in a new tab with
`noopener`/`noreferrer` applied, including links added to the DOM after page load. Workspace file
links (`@file:` mentions and file-preview markdown) are exempt so they continue to open the in-app
preview.

## Structured Answers and Multi-Field Elicitation

The relay supports **structured answer forms** that extend beyond simple text `ask_user` questions. When a Copilot agent or tool needs multi-field input (e.g., confirmation with multiple checkboxes, form data with validation), the relay bridges the question into a web form.

### Database Schema

Structured answers are stored in the `relay_questions` table:

- `id` (primary key, UUID)
- `request_schema` (JSON schema defining form fields: types, validation, constraints)
- `structured_answer` (JSON object containing user's multi-field response)

The migration `server/migrations/0001-add-structured-answer.mjs` creates the `structured_answer` and `request_schema` columns.

### Elicitation Flow

1. **Agent sends multi-field question** → Copilot SDK sends `ElicitationRequest` with `requestSchema` (JSON schema).
2. **Extension bridges question** → `.github/extensions/web-relay/skills/question-routing-hooks.mjs` detects structured schema and registers it in the relay.
3. **Browser renders form** → `server/public/app/question-schema-view.mjs` generates UI from the JSON schema (text inputs, checkboxes, dropdowns, etc.).
4. **User submits form** → `ask-user-view.js` validates and POSTs to `/api/ask-user` with `structuredAnswer` payload.
5. **Relay stores + returns** → Answer stored in `structured_answer` column; extension retrieves via `/api/pending` and returns `ElicitationResponse` to SDK.

### Schema Example

```json
{
  "type": "object",
  "properties": {
    "confirmation": {
      "type": "boolean",
      "title": "Do you want to proceed?"
    },
    "environment": {
      "type": "string",
      "enum": ["dev", "staging", "prod"],
      "title": "Select environment"
    },
    "tags": {
      "type": "array",
      "items": { "type": "string" },
      "title": "Enter tags"
    }
  },
  "required": ["confirmation", "environment"]
}
```

### Browser Behavior

- Multi-field forms render form controls for each schema property.
- Validation happens client-side (required fields, type checking) and server-side.
- Single-field simple `ask_user` (legacy) still renders as a single text input or button group.

## Relay Tool Guidance

The CLI extension (`.github/extensions/web-relay/extension.mjs`) loads `relay-tools.md`
for shared tool guidance.

The browser UI keeps the usage button in the sidebar header, and that button continues to
call `/api/usage` directly. It now renders the unified plan-usage report — one card per
provider with meters, reset countdowns and collapsible cost detail — via
`public/app/plan-usage-view.mjs`, falling back to the old Copilot-only text summary when
the response carries no `providers` array (an older relay, or one without the plan-usage
service).

## Config (`config.json`)

```json
{
  "authToken": "<your-token>",
  "port": 3333,
  "localhostOnly": true,
  "pollIntervalMs": 3000,
  "processingTimeoutMs": 600000,
  "conversationSessionMode": "isolated",
  "contextIndicatorMode": "default",
  "sdkVersion": "1.0.63",
  "sdkPath": "/absolute/path/to/copilot-sdk/index.js",
  "cliPath": "/absolute/path/to/app.js",
  "sshTunnel": {
    "mode": "disabled",
    "required": false,
    "remoteBind": "loopback",
    "command": "ssh",
    "user": "ubuntu",
    "host": "relay.example.com",
    "remotePort": 4444,
    "identityFile": "~/.ssh/id_rsa",
    "autoReclaimPort": true
  }
}
```

| Key | Default | Description |
|---|---|---|
| `authToken` | *(required)* | Token for all API / UI access |
| `port` | `3333` | HTTP/WebSocket listen port |
| `localhostOnly` | `true` | Bind only to loopback (`127.0.0.1`) and block LAN/WAN access |
| `pollIntervalMs` | `3000` | CLI poll interval (ms) |
| `processingTimeoutMs` | `600000` | Worker-inactivity window before a turn is treated as stale (ms) — see [Turn recovery](#turn-recovery-and-the-max-turn-duration) |
| `conversationSessionMode` | `isolated` | SDK session strategy (`isolated` or `shared`) |
| `contextIndicatorMode` | `default` | Input context indicator style (`default` shimmer line or `bar` fill indicator) |
| `sdkVersion` | *(latest detected)* | Optional semver pin (for example `1.0.63`) used by relay SDK auto-detection |
| `sdkPath` | *(auto-detected)* | Optional absolute override for Copilot SDK entry path (`.../copilot-sdk/index.js`) |
| `cliPath` | *(auto-detected)* | Optional absolute override for Copilot CLI app path (`.../app.js`) |
| `restartGracefulTimeoutMs` | `8000` | Graceful shutdown wait before force fallback |
| `restartShutdownTimeoutMs` | `45000` | Drain timeout while waiting for active queue jobs |
| `restartSpawnTimeoutMs` | `18000` | Max wait for resume process to leave online state |
| `restartRebindTimeoutMs` | `20000` | Max wait for session-sync rebind confirmation |
| `restartMaxAttempts` | `3` | Max restart attempts before terminal exhaustion |
| `restartRetryBackoffMs` | `[1000,3000,7000]` | Deterministic retry backoff schedule |
| `sshTunnel.mode` | `disabled` | Tunnel mode (`disabled` or `managed`) |
| `sshTunnel.enabled` | `false` | Legacy alias for mode (`true` => `managed`, `false` => `disabled`) |
| `sshTunnel.required` | `false` | Pause dequeue when tunnel is disconnected in managed mode |
| `sshTunnel.remoteBind` | `loopback` | Remote bind mode for SSH `-R` (`loopback` or `public`) |
| `sshTunnel.command` | `ssh` | SSH executable path or command name |
| `sshTunnel.user` | — | SSH user on VPS |
| `sshTunnel.host` | — | VPS hostname / IP |
| `sshTunnel.remotePort` | — | Port opened on the VPS |
| `sshTunnel.identityFile` | *(optional)* | SSH private key path (`~` expanded); uses ssh-agent if omitted |
| `sshTunnel.autoReclaimPort` | `true` | When remote bind fails, run a remote reclaim step before retrying |
| `sshTunnel.reclaimStaleSshSessions` | `false` | Also kill your own childless `@notty` SSH sessions when the port stays held (see caveat below) |
| `sshTunnel.remoteCleanupCommand` | *(optional)* | Override reclaim command (`ssh user@host <command>`) for custom VPS cleanup |

### SDK auto-detection behavior

- Relay first honors explicit `sdkPath` + `cliPath` from `config.json` when both are set.
- Otherwise it auto-detects the highest available semver under platform-specific install roots:
  - **Windows:** `%LOCALAPPDATA%\copilot\pkg`
  - **Linux:** `$XDG_CACHE_HOME/copilot/pkg` (default `~/.cache/copilot/pkg`), then `$XDG_DATA_HOME/copilot/pkg` (default `~/.local/share/copilot/pkg`)
  - **macOS:** `~/Library/Application Support/copilot/pkg`
- Within each root it checks platform subdirs (`<platform>-<arch>`, then `universal`) and picks the highest version containing both:
  - `copilot-sdk/index.js`
  - `app.js`
- Optional environment override: set `COPILOT_PKG_DIR` to force a specific pkg base directory.
- Optional config pin: set `sdkVersion` to require an exact version during auto-detection.

## SSH Reverse Tunnel

When `sshTunnel.mode` is `managed` (or legacy `sshTunnel.enabled=true`), `server.js` spawns:

```
ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -R <remoteSpec> <user>@<host>
```

`sshTunnel.remoteBind` controls `<remoteSpec>`:
- `loopback` => `<remotePort>:127.0.0.1:<port>` (loopback bind, best with Caddy `reverse_proxy localhost:<remotePort>`)
- `public` => `*:<remotePort>:127.0.0.1:<port>`
`ExitOnForwardFailure=yes` ensures the tunnel process exits immediately if remote port forwarding fails, allowing clean auto-retry instead of a false "connected" state.

**Auto-reconnect** — if the tunnel exits for any reason it is rescheduled with
exponential backoff (5 s → 10 s → 20 s → 40 s → 60 s cap, no retry limit).
The counter resets after a connection is stable for >30 s.

**Remote stale-forward reclaim** — on `remote port forwarding failed for listen port`,
the relay runs a one-shot remote cleanup over SSH and retries quickly on the same
fixed port. Set `sshTunnel.autoReclaimPort` to `false` to disable, or provide
`sshTunnel.remoteCleanupCommand` for your own server-specific cleanup command.

The reclaim reads the port state from `ss` / `/proc/net/tcp` rather than trusting
`lsof`. This matters: when the port is held by a stale `ssh -R` forward, the owning
`sshd` session has dropped privileges, so `/proc/<pid>/fd` is root-owned and both
`lsof` and `fuser` report nothing even though the socket belongs to your own uid.
The cleanup exits non-zero while the port is still bound, so a port that cannot be
freed falls back to exponential backoff instead of respawning `ssh` every second.

Killing such a forward requires killing the `sshd` session that owns it. That is
off by default because the session cannot be identified precisely without root.
Enabling `sshTunnel.reclaimStaleSshSessions` sweeps your own `sshd` sessions that
have no child processes — the shape `ssh -N -R` leaves behind. Interactive shells,
IDE remote servers (VS Code / Cursor) and the reclaim command itself all have
children and are skipped, but any *other* `-N` forward you rely on for a different
port would also be killed, so leave it off unless the relay owns the account.

**Caddy VPS config:**

```
relay.example.com {
    reverse_proxy localhost:4444
}
```

**`/api/status`** now includes:

```json
"contextIndicatorMode": "default",
"sshTunnel": {
  "mode": "managed",
  "required": false,
  "enabled": true,
  "blocking": false,
  "connected": true,
  "host": "relay.example.com",
  "remotePort": 4444,
  "remoteBindMode": "loopback",
  "reconnectAttempts": 0,
  "connectedSince": "2026-05-18T01:00:00.000Z",
  "lastError": null,
  "valid": true
}
```

### Managed vs. Disabled Mode

| Setting | Behavior |
|---------|----------|
| `mode: "disabled"` | No SSH tunnel; relay is only accessible locally (localhost). Suitable for development or internal network access. |
| `mode: "managed"` | SSH tunnel enabled; relay opens reverse port forward to VPS. Suitable for remote access or internet-facing deployments. |

### Tunnel Connection & Queueing

- **Tunnel required = false** (default): Queue continues to process even if tunnel is disconnected. Browser can still interact via localhost.
- **Tunnel required = true**: Queue is paused (returns `paused: true` with reason `ssh_tunnel_required`) when tunnel is disconnected. Used when relay **must** be accessible via VPS (e.g., mobile browser always connects through VPS).

When `required=true` and tunnel is down:
- Relay stays running internally
- `/api/pending` returns `{ paused: true, reason: "ssh_tunnel_required" }` 
- Extension stops dequeuing turns
- Browser sees "waiting for tunnel to reconnect..." status
- Once tunnel reconnects, queue resumes automatically

### SSH Tunnel Configuration Precedence

1. `server/config.json` → `sshTunnel` object
2. Environment variables → `COPILOT_REMOTE_SSH_TUNNEL_*` prefixed keys

Example environment overrides:
```bash
COPILOT_REMOTE_SSH_TUNNEL_MODE=managed \
COPILOT_REMOTE_SSH_TUNNEL_USER=deployer \
COPILOT_REMOTE_SSH_TUNNEL_HOST=vps.example.com \
COPILOT_REMOTE_SSH_TUNNEL_REMOTE_PORT=4444 \
npm start
```

### SSH tunnel migration notes

- `sshTunnel.mode` is now the canonical switch. Use `disabled` for direct relay deployments and `managed` for reverse SSH.
- `sshTunnel.enabled` still works for compatibility and maps to `mode`.
- Add `sshTunnel.required: true` only when queue dequeue must stop until the tunnel reconnects.

`restartOrchestrator` in `/api/status` and `/api/restart-orchestrator` now exposes
attempt/retry/timeout fields (`attempts`, `maxAttempts`, `retryAt`, `retryBackoffMs`,
`spawnDeadlineAt`, `rebindDeadlineAt`) plus terminal outcomes
(`terminalOutcomeCode`, `terminalOutcomeMessage`, `terminalOutcomeAttempts`).
Failure classes are deterministic: transient timeouts (`spawn-timeout`, `rebind-timeout`)
retry with bounded backoff; session mismatch conflicts (`transaction-mismatch`, `target-mismatch`)
are terminal and stop retrying.  
`POST /api/session-sync` accepts optional orchestrator correlation/target/rebind fields:
`orchestrator_correlation_id`, `orchestrator_target_session_id`, and `rebind_completed`
(or `rebind_state=completed`). Rebind mismatches return `409` with `retryable`/`terminal`.
The extension dequeue/send path treats this restart-orchestrator flow as authoritative and
does not attempt in-process runtime session switch calls.

This worker restart-orchestrator flow is separate from the manual relay self-restart state
reported as `relayShutdown`.



## Database Migrations

The relay uses a simple SQL migration system to evolve the SQLite schema over time.

**Migration File Location:** `server/migrations/`

**Migration Lifecycle:**

1. On server startup, relay checks the database for applied migrations
2. Unapplied migrations (in filename order) are executed automatically
3. Each migration file exports a `up()` function that creates/alters tables
4. After successful execution, migration is recorded in the database metadata
5. Migrations are idempotent: re-running a migration is safe (no duplicates)

**Currently Deployed Migration:**

- **`0001-add-structured-answer.mjs`** — Adds `structured_answer` and `request_schema` columns to the `relay_questions` table to support multi-field elicitation forms (see [Structured Answers and Multi-Field Elicitation](#structured-answers-and-multi-field-elicitation) section).
  - `request_schema` (TEXT/JSON) — JSON schema defining form fields and validation
  - `structured_answer` (TEXT/JSON) — User's submitted multi-field response object

**In-place column additions:**

Some columns are added directly at startup with guarded `ALTER TABLE` statements rather than
migration files. Recent additions on `runtime_sessions`:

- `claude_native_session_id` (TEXT) — native Claude Agent SDK session id, replayed as `resume`
- `context_usage_json` (TEXT/JSON) — latest context-window breakdown reported by a Claude worker
- `context_usage_captured_at` (TEXT) — when that breakdown was captured

and on `messages`:

- `hidden_from_shares` / `share_hidden_at` — per-message share visibility (see
  [Conversation sharing](#conversation-sharing-and-per-message-visibility))

Statements that depend on these columns are prepared conditionally, so an older database keeps
working with the corresponding feature inert rather than crashing at startup.

**To Deploy New Migrations:**

1. Create file `server/migrations/000N-description.mjs` (increment the number)
2. Export an async `up()` function that receives the database connection
3. Write SQL alterations:
   ```javascript
   export async function up(db) {
     await db.exec(`ALTER TABLE some_table ADD COLUMN new_col TEXT;`);
   }
   ```
4. Restart the relay; migration runs automatically
5. Verify: check relay logs for `[migrations] Applying 000N-description`

## Files

| File | Description |
|------|-------------|
| `server.js` | Main server |
| `public/index.html` | Web chat UI |
| `config.json` | Auth token and settings (gitignored) |
| `data/copilot.db` | Persisted conversations, settings, and queue storage (gitignored) |
| `relay-tools.md` | Markdown tool guidance loaded by the relay extension |
| `claude-worker/` | Claude Agent SDK session worker (turn runner, ask-user bridge, attachments, SDK message normalizer) |
| `services/claude-session-root-service.mjs` | Resolves the browsable session folder for Claude conversations |
| `services/context-usage-view.mjs` | Normalizes Copilot and Claude context data into one payload |
| `../shared/turn-ceiling.mjs` | Shared bounds/formatting for the max turn duration setting |
