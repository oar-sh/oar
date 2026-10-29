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
node server/server.js
```

This starts the web server and stays attached to the terminal, respawning its
worker child across restarts. Ctrl+C (or closing the terminal) stops both.
A Copilot CLI session with the extension attaches separately.

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

Mode summary — one entry point, role chosen by argv:

- `node server/server.js` (= `npm start`): the process stays attached as a supervisor and runs
  `server-runtime.mjs` in a worker child it marks with `--relay-runtime`. Exit 75 relaunches the
  worker; other non-zero exits are retried 3 times before the supervisor gives up. As the main
  process of a systemd user service (`oar service install`), the supervisor hands exit 75 to
  systemd instead, which restarts the whole service from the code on disk; it relaunches the
  worker itself when that cannot be done within 30 s.
- `node server/server.js --supervised`: runs the server in this process and exits 75 instead of
  restarting itself, leaving that to whoever spawned it. This is what the CLI extension passes.
- `node server/relay.mjs`: the standalone Copilot relay, started by hand after the server is up.
  Manual escape hatch only — never alongside extension-managed transport.

Role flags are argv, not env, on purpose: the server's environment is inherited by tmux worker
sessions and by the Copilot CLI it launches, and the extension spawns the next server from that
same environment — so an env flag would decide the role of unrelated servers down the tree.

On Windows, the visible relay launcher path now targets a stable per-workspace Windows Terminal window name so later foreground launches reuse the same window instead of opening new desktop windows. Keep the hidden/stdio path as a fallback only.

### Runtime safety checklist (avoid duplicate relay workers)

1. Stop stale detached watchdog/relay processes before restart.
2. Keep exactly one listener on port `3333`.
3. The relay singleton lock is stored at `server/data/relay-server.lock` (stale locks are auto-recovered).
4. In extension-managed mode, do not start a second server or run `node relay.mjs`.
5. Verify `/api/status` shows `cliOnline: true` and queue counts are moving or zero.
6. Follow relay restart policy from `.github/copilot-instructions.md`.
7. In extension-managed mode, use `POST /api/relay/shutdown` for manual restart requests.
   - It is queued until the relay is idle, so it will not stop an in-flight turn immediately.
   - Send `{ "restart": true }` when you want a self-restart instead of a plain shutdown.
8. Do not run tests that spawn Copilot CLI clients unless the user explicitly permits it.

Script necessity note:

- Extension-managed relay does not call npm scripts directly; it starts `server.js --supervised` itself.
- Extension-managed relay supervision includes bounded auto-restart while the CLI session is active,
  and is now the only supervisor in that mode.
- `npm start` is a plain alias for `node server/server.js`; there is no other start script.
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

`localhostOnly` affects only the local relay listener. SSH reverse tunnel exposure is configured separately with `sshTunnel.remoteBind`. The Cloudflare Tunnel mode (`cloudflaredTunnel`) needs no public bind at all: `cloudflared` connects outbound to Cloudflare and proxies back into `127.0.0.1`.

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

You can rename the installed app label from **⚙️ Settings → Relay name** (paired relays know this relay by the same name).
The name is stored on the relay (app settings) and served in the web app manifest
to every browser and origin (LAN and tunnel agree), so future installs pick it up
immediately and already-installed Android apps receive it through Chrome's normal
manifest-update flow — one confirmation prompt showing the new name, then the
launcher label updates. A legacy per-browser name is adopted by the relay the
first time that browser loads the app.

**💤 Suspend host** (Windows relay hosts) puts the PC into suspend-to-RAM once
nothing is running any more. The confirmation modal first lists what is still
active — sessions with a running turn, sessions with live background agents, and
open GitHub Actions runs in the workspaces of those sessions (read through the
host's `gh` CLI; an unreadable CI state blocks for 15 minutes, then is ignored).
Confirming queues the request: the relay polls every second and suspends after
everything has been idle for 2 minutes (or 30 seconds when nothing was running
at confirm time). While a suspend is queued every connected client shows a
banner with the blockers or the countdown and a **Cancel** button, the menu entry
reads **💤 Suspend pending…**, and reopening the modal offers to cancel. A relay
restart drops the queued suspend; a push notification (event **Host suspend**)
reports both the actual suspend and such a drop. For the first 45 seconds after
a relay start the check lists one more blocker, "the relay just started,
sessions are still reporting": the workers that outlived the previous runtime
may not have reported their background work yet. A queued **🌄 Restart web relay**
gets a banner of its own, with the sessions it waits for, **Restart now** and
**Cancel restart** (see [Manual relay shutdown / self-restart](#manual-relay-shutdown--self-restart)).

API: `GET /api/host/suspend` (state plus current blockers), `POST /api/host/suspend`,
`POST /api/host/suspend/cancel`, and `POST /api/relay/shutdown/cancel`
(token only, like the restart itself). Set `OAR_HOST_SUSPEND_DRY_RUN=1` to log instead of sleeping;
`OAR_BOOT_REPORTING_WINDOW_MS` changes the 45 seconds (0 to 600000; test relays
pin `0`, which switches the wait off; a negative value is ignored); an override in effect is
logged at start.

You can also hide the **💤 Suspend host** action from **⚙️ Settings** with the
**Show Suspend host action** checkbox. This only controls the menu entry; the
banner for an already queued suspend still shows on every device.

The live thinking bubble's header carries three follow buttons on the right —
**💭** thoughts, **📃** streamed answer, **🛠️** tool list. Arming one keeps that
section's last line pinned just above the composer as the reply grows; scrolling
the transcript by hand (wheel, touch, scroll keys) disarms it, typing in the
composer does not. The armed mode is remembered per conversation for the life of
the page. **Stop** now asks for confirmation before cancelling the turn.

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

### A message without a model, an effort or a mode

The composer always sends all three. A client that leaves one out of
`POST /api/message` (a script, an agent on this relay) gets the conversation's
own, never the relay-wide default:

- **Model**, for an existing Copilot conversation: the conversation's saved
  `preferred_model`, then the runtime session's `provider_model`, then its
  `model`, then the model of the latest user message (`auto` skipped in each);
  only a conversation with none of these runs on the catalog's current model.
  A saved model the catalog no longer lists is refused with
  `409 CONVERSATION_MODEL_UNAVAILABLE` (`model`, `supportedModels`) instead of
  being replaced; the composer shows that text in its banner. An explicit
  `auto` is unchanged (new conversations only). Claude, Cursor, Grok, Claude
  Cloud and OpenAI conversations keep their pinned `provider_model`, as before.
- **Effort**: for Copilot, an effort the model's variant id carries, else the
  conversation's `preferred_reasoning_effort`, clamped to the nearest level the
  model offers (`nearestSupportedReasoningEffort`, the composer's rule); with
  nothing to keep, the model's lowest level that is not `none`, so `none` is
  chosen only when the conversation asked for it or the model has no other
  level. OpenAI, Claude, Cursor and Grok conversations take the conversation's
  effort the same way; with no effort stored, or one that neither matches nor
  clamps (an `ultracode` on a model without it), they keep the provider's own
  default as before (`none`, `low` for an OpenAI o-series model; for Claude,
  Cursor and Grok `none` means the model's default). A Claude Cloud conversation always runs with `none`: the
  cloud takes no effort. A board action's follow-up takes the conversation's
  effort as well.
- **Mode**: a send that names no `relayMode`/`mode` runs in the
  conversation's saved `preferred_relay_mode`, not the relay default.
- **Preferences**: a send to an existing conversation saves only what it named.
  A model it named is saved (with its effort only when that was named too, else
  the stored effort stays); an effort alone is saved against the stored model,
  and a conversation with no saved model runs with that effort but saves
  nothing; a send that named neither writes nothing. The mode saved with them
  is the one the turn runs in, so a send without a mode leaves the stored mode
  as it is. A send from another relay's agent never writes them, as before.

A text repeat inside the duplicate window answers `200` with `duplicate: true`
and `queued: false`, and nothing runs. A message whose turn **failed** no
longer counts: sending it again queues it.

### OpenAI API key

Open **Settings → Providers → OpenAI** to save an OpenAI API key, the default model ID (`gpt-4o`
if none) and an optional **Base URL** (`https://api.openai.com/v1` when empty; any
OpenAI-compatible endpoint, or the capture proxy `server/tools/capture-proxy.mjs`). **Enable OpenAI
API key for New Chat model selection** makes OpenAI selectable in New Chat without re-entering the
key. An OpenAI conversation runs on the Copilot engine the relay has selected, extension or SDK:
the worker is started with `COPILOT_PROVIDER_TYPE=openai`, `COPILOT_PROVIDER_BASE_URL` (the saved
base URL), `COPILOT_PROVIDER_API_KEY`, `COPILOT_PROVIDER_WIRE_API` and `COPILOT_MODEL`
(`applyOpenAIProviderEnvironment`); the CLI reads them on the extension engine, the SDK worker
turns them into the session's provider (`copilot-worker/copilot-byok-provider.mjs`). Started
conversations keep their provider and lock the composer to their model.

GPT-5, `codex-*` and the o1/o3/o4 models use the Responses API; other OpenAI models use Chat
Completions (`resolveOpenAIWireApi`). The reasoning efforts follow the model family
(`shared/openai-reasoning.mjs`): GPT-5 and `codex` offer `none`, `low`, `medium`, `high` and
`xhigh`, the o-series `low`, `medium` and `high`, other models only `none` (image models take
`auto`, `low`, `medium` and `high` as their quality). An effort the model does not offer is refused
with `400`; with none named the conversation's own applies (clamped to the model's levels), else
`none`, or `low` on a model without `none`. GitHub Copilot's reasoning choices stay separate even when both providers list the
same model ID.

Saving or re-enabling the key refreshes OpenAI's `/v1/models` list and adds
candidate OpenAI model IDs to the composer picker. The Settings model-variant
refresh performs the same discovery while OpenAI is enabled and retains the
cached list if discovery fails. Starting a conversation uses the cached list; it
does not make another discovery request. The model selected when creating a
conversation is persisted on that conversation and used as its `COPILOT_MODEL`;
the Settings model is only the default. Starting a chat from a locked OpenAI
conversation opens an independent model chooser without changing the active
conversation.

Disabling OpenAI retains the key and cached model list. **Remove saved key** deletes the key and the
cached list and switches OpenAI off, and it is refused with `409 openai-key-removal-blocked`
(`activeConversationCount`, `startedConversationCount`, `activeQueueConversationCount`) while any
OpenAI conversation that is not deleted, image conversations and archived ones included, has a
message or a pending, processing or parked queue row (`setOpenAIProviderSettings` in
`server-runtime.mjs`). Disable OpenAI instead, or delete those conversations first. A removal that
goes through moves the OpenAI conversations without a message to GitHub Copilot.

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
| `plan`      | SDK `permissionMode: 'plan'`; `ExitPlanMode` publishes a **plan_ready** board, then the tool call is **denied** so the turn ends for review instead of rolling straight into implementation — the board's choice queues the next turn (see [Relay Mode Selection](#relay-mode-selection)): **Approve plan** one agent-mode turn while the saved mode stays plan, **Implement in autopilot** autopilot, **Stop here and prompt myself** agent, **Stop here** nothing |
| `ask`       | System prompt appended to prefer `AskUserQuestion` before implementing        |
| `agent`     | Default permission mode, unmodified preset prompt                            |
| `autopilot` | System prompt appended to keep moving unless input is truly blocking          |

- **Model and reasoning effort are per turn.** Each turn is a fresh `query()` with `resume`, so both
  can change between messages. Effort levels are `none` (SDK default) plus whatever the model reports
  (`low`, `medium`, `high`, `xhigh`, `max`), plus **Ultracode** — see below.
- **Ultracode** is offered on every model whose discovered efforts include `xhigh`. It is not an SDK
  effort level but a session-scoped settings flag, so the relay carries `ultracode` as a sentinel on
  the ordinary effort ladder (`withClaudeUltracodeTier` in `services/provider-reasoning-effort.mjs`,
  the single source for all Claude effort lists) and only the worker translates it: a fresh session
  spawns with `effort: 'xhigh'` and `settings: { ultracode: true, enableWorkflows: true }`, and a
  live session is toggled in or out with `applyFlagSettings` (`claudeUltracodeFlagSettings`).
  `enableWorkflows` is passed explicitly because the worker loads no filesystem settings. It is never
  a silent default — the selectors label the rung "Ultracode" and warn about the token cost.
- **Tools are auto-allowed**, matching the Copilot workers' `--allow-all` posture. Only two tools are
  intercepted: `AskUserQuestion` (bridged to relay question cards) and `ExitPlanMode` (plan board;
  denied after the board posts — the plan text comes from the tool input, or from the CLI's
  `planFilePath` when no inline plan is sent).
- **Attachments** — images up to 5 MB are inlined as base64 content blocks; larger images and all
  non-image files are passed as absolute path references for Claude's `Read` tool.
- **Subagents** — `forwardSubagentText` is on, so subagent text, thoughts, and activity stream into
  their own nested bubbles. `abort_subagent` maps to `query.stopTask()` for a backgrounded subagent;
  one running inside the current turn is still answered "not supported". Full-turn **Stop** works.
- **Thinking** — the worker requests summarized thinking *display* without passing a `thinking`
  option, so it never switches thinking on for a session that has it off, and never changes a budget.

### Session continuity

The native Agent SDK session id observed on the first turn is posted to
`POST /api/claude-native-session` and stored in `runtime_sessions.claude_native_session_id`. Later
turns pass it back as `resume`, so a Claude conversation survives worker restarts. The id is only
cached in the worker after the server accepts it, so a failed persist is retried next turn.

### Background tasks and workflow progress

The worker keeps one persistent CLI process per conversation, so background tasks survive the reply
that started them. The live task set is posted to `POST /api/background-tasks` (REPLACE semantics)
and broadcast as the `background_tasks` socket event; the composer's task panel renders it and can
stop an individual task over a `worker.control` push. The conversation payload carries the set too
(`backgroundTasks`, `endedBackgroundTasks`); the page's live poll and refresh leave it out when a
`background_tasks` event for the conversation arrived while their request was on its way, as the
event's set is at least as new.

The relay holds the task sets in memory (`services/background-task-store.mjs`), so a relay restart
starts without them while the workers and their tasks keep running (the console rows are stored;
see below). The worker is the source of
truth, and the relay asks:

- **Digest and resync.** A worker's heartbeat carries `backgroundTasks: { count, digest }`, a digest
  of its sorted task ids (`shared/worker-runtime/background-task-digest.mjs`). When it differs from
  the set held for that worker (a restart, or a lost post either way round), the heartbeat answer
  says `resyncBackgroundTasks: true` and the worker posts its full set with `resync: true`; the
  request repeats on every beat until the two agree. A task restored this way keeps its start time
  and is not announced as started again. Every post of a set carries `order: { epoch, seq }` (the
  worker process and its count of set posts): two posts can overtake each other on the way, and the
  relay drops one that is older than the newest it applied from that process, or that comes from a
  process other than the one whose heartbeat came last for the session. A drop is logged and
  answered `stale: true` with a `reason`; a worker told so for its newest set asks for a heartbeat,
  on which the relay asks for the set again. `epoch` only names the process and is never compared
  as a time. A task that ended only because a set did not list it comes back, without a second
  start, when a later set lists it, unless a settle notice or its run's status has confirmed the
  end meanwhile. A worker that sends no digest (Cursor, Grok, Claude Cloud, or a worker on older
  code) has no opinion and is never asked.
- **Placeholder.** A live Claude worker on older code cannot answer, but its heartbeat says whether
  background work holds its process (`steering.autoCompactWindow.backgroundWork`). While this
  runtime has not heard from that worker about its tasks, the session reads `background_only` with
  one task "background work, details not reported since the relay restarted (Kill session in its ⋯
  menu ends it)", the panel shows the
  same row without a Stop button, and a host suspend waits. It is derived on read
  (`services/background-work-view.mjs`), raises no event, and goes when the set arrives, the flag
  goes false or the worker is gone.
- **Ends.** The Claude worker keeps a settle notice whose post failed (the newest 20, for 10
  minutes) and sends it again after the next heartbeat the relay answers; such a post is given up
  after 10 s without an answer.
- **The console rows.** What the task console needs of a shell or Monitor task (its `outputPath`
  and `outputKind`, the ended row with status, exit code and `endedAt`, how a task ended when the
  settle came before the set dropped it) is kept in `background_task_rows` (migration 0018,
  `services/background-task-persistence.mjs`), written only when that part of a set changes, not on
  every progress post. At boot the store restores the ended rows still inside their hour, and holds
  the live ones (`restored`): the output route and the console's live room find a held task (the
  route answers it with `status: 'held'`, `held: true` and `stoppable: false`; the console says it
  waits for its worker), but `get()` and with it the panel, the session state and the suspend check
  do not count it as running, and the stop route only pushes the stop to the worker. The worker's next set settles it (a task in the set is live again, with the
  path it had; one not in it becomes an ended row, with the status the runtime before was told), a
  settle sent again for it ends it, and while a key has held tasks its heartbeat digest never
  counts as in step, so the relay asks for the set. Tasks of a worker that sends no set within twice
  the boot reporting window (at least 15 s; 90 s by default) are ended with status `unknown` and the
  pages get the `background_tasks` event (`endUnconfirmed`); a later set that lists one brings it
  back. A held task's end time is when the runtime before last knew it running: a stored live row's
  `updated_at` is written with the set and confirmed at most every 30 minutes while the worker's
  digest agrees, and a live row not confirmed for 6 hours (a worker that went away in an earlier
  runtime without an empty set) is deleted at boot instead of restored. Health readings are not
  stored: the poller reads the files again within 10 s, the ended rows once. A runner's counts come
  from the last 64 KB when its closing summary is there. A live log that outgrew that window is read
  whole by a per-task runner scan (`services/task-output-service.mjs`): it looks for a runner's
  header (a test run after a long install or build prints its header once) and counts from there,
  reads on from where it stopped as the file grows, and starts over on a new file under the path
  (shorter, another inode, an older mtime). The scans live in memory and share 4 MB per tick, each
  tick starting at another task, so after a restart a long log is caught up over a few ticks (the
  window's reading stands until then) and one busy log cannot keep the others waiting. An ended row
  never starts a scan, so the rows a restart brings back are read in their window only. What a
  worker says about a task (description, summary, last tool call, and a shell row's `command`, which
  the Claude worker takes from the Bash or Monitor call that started the task, Copilot from the
  shell tool's arguments or the task registry, Grok from the terminal) goes through `cleanTaskText`
  on the publish and settle routes: control codes and colours out, credentials scrubbed as in the
  output, then cut (a command at 2,000 characters; a Grok description is its command line). It is
  stored with the console rows, so a held or ended row keeps it; share links carry no task rows. The
  `none` answers of the output route use the page's texts (`TASK_OUTPUT_NONE_MESSAGES` in
  `public/app/task-console-render.mjs`). Rows go with their hour, the 20-per-key limit, a set that
  drops them or the conversation's delete. Without the table (a failed migration) the store works in
  memory as before.
- **Run rows left `running`.** A background sub-agent's row whose end was never written would count
  as running work for a day. For a Claude worker that has reported its task set in this runtime, a
  `running` background row that the set does not list and that nothing has updated for 15 minutes
  is left out of the session state, `all_idle` and the suspend blockers.

Tasks of type `local_workflow` carry an extra `workflowProgress` digest, because the SDK exposes no
workflow-progress surface — the worker reads it off disk:

- While the workflow runs, `subagents/workflows/<runId>/journal.jsonl` under the session directory
  gives the agent set and their running/done state; agent labels come from the first line of each
  `agent-<id>.jsonl`.
- The run record `workflows/<runId>.json` is written **only at completion**, and takes over as the
  authoritative tree once it exists — it is the only source of phase titles, logs, token totals, and
  per-agent tool counts.
- Parsing lives in `claude-worker/workflow-progress-digest.mjs` (`digestFromJournal`,
  `digestFromRunRecord`), polling in `claude-session-process.mjs` (`syncWorkflowPoller`, 2 s, only
  while such a task is live, published only when the digest actually changed). Reads are bounded by
  byte caps and a filename pattern, and the digest is clamped (≤100 agents, ≤50 phases, ≤5 log lines,
  per-field length caps). A run is joined to its task by the record's `taskId`, with a start-time
  mtime window as the mid-run fallback.
- The relay never trusts the worker's JSON: `sanitizeWorkflowProgress` (`routes/messages-routes.mjs`)
  re-applies every clamp before storing or broadcasting, and drops a digest with no phases and no
  agents.

When a workflow settles, the worker buffers its final digest (at most five, terminal status never
downgraded) and attaches it to the next `POST /api/response` as `workflowRuns`. Runs that settled on
a journal snapshot get one more run-record read at drain time, since the CLI often flushes the record
a few seconds after the task disappears. The relay writes those rows into `workflow_runs` inside the
same transaction that finalizes the assistant message, keyed on the response message id, and returns
them with the message — so the transcript's collapsed **Finished background task** card (the same
tree renderer as the live panel, `buildWorkflowRunCard` in `public/app/background-tasks-view.mjs`)
survives a reload. A history rebuild deletes a conversation's `workflow_runs` alongside its
`subagent_runs`, because both key on message ids the rebuild replaces.

### Sub-agent records (the sub-agent viewer)

Every sub-agent run keeps its whole record in `subagent_timeline` (migration 0009): one row per
thought, reply text, tool call (full input), tool result (cut at 4 KB, the original length kept in
the entry's metadata), child agent or note, numbered per run by `seq` in the order the relay first
saw it. A writer names each entry with its own `entry_key`; a second write under the same key
updates the entry in place and keeps its `seq`, which is how a thought or a reply streams. A run
keeps at most 2000 entries plus one note saying where it was cut (`subagent_runs.truncated`).
`subagent_runs` also carries the run header the rows show: model, type, task id, tokens, whether it
runs in the background, and who writes its timeline.

- **Claude**: `claude-worker/subagent-timeline-recorder.mjs` reads every SDK message at process
  level, before any turn takes it, and posts entries to `POST /api/subagent-timeline` keyed by the
  run (coalesced every 500 ms; a run the relay does not know yet is retried). A background agent
  outlives the turn that spawned it, so its frames arrive between turns and during later turns;
  they go to its own record, never to a later turn's live lanes. A background launch's receipt
  (`tool_use_result.status: 'async_launched'`) leaves the run running; its `task_notification`
  ends it. Spawns carry `timelineOwner: 'worker'`. A finished background agent that the session
  sends a new message (SendMessage) runs again as the same task: `task_started` names its task id
  again, with a new `run_id` and the SendMessage call as `tool_use_id`. The recorder leads that id
  back to the agent's first run, so the record goes on under the same run (a note marks where it
  resumed, and the run reads `running` again until its next `task_notification`); the task panel
  row, the settle notice and a targeted stop name that run too. Every timeline post also names the
  run's `taskId`, for a worker that did not see the first run (see the route below).
- **Copilot and Cursor** publish their sub-agents on the live lanes only (`/api/activity`,
  `/api/thought`, `/api/stream` with a `subagentRunId`); the relay copies each frame into the run's
  timeline, uncut. Fields they do not report (model, tokens) stay blank.
- `POST /api/background-tasks` copies model, type, task id and tokens onto the run whose id is the
  task's `toolUseId`, so the row keeps them after the in-memory task set is cleared. A sub-agent
  task whose `toolUseId` is no run (a resumed agent from a worker that did not see its first run)
  gets the id of the conversation's run that carries its task id, so the row opens that record.
- Every `subagent_status` event carries the whole header and the run's own turn (`messageId`). A
  turn that fails closes its foreground runs; background runs are closed by their worker, or by the
  relay when the worker dies.

The browser draws one row per top-level run in the reply bubble (`public/app/subagent-row.mjs`, the
panel's row grammar); a row's title, like a sub-agent task's title in the composer panel, opens
`public/app/subagent-viewer.mjs`. The viewer reads `GET /api/conversation/:id/subagent/:runId`, grows
with the `subagent_timeline` event, and fetches again from the last contiguous `seq` after a missed
event or a reconnect. A run recorded before the timeline existed is served from its tagged
activity, thought and stream rows (`legacy: true`).

**Live delivery.** `subagent_timeline` goes only to the pages whose viewer shows that run. The viewer
names its run with the socket message `subagent_viewer_watch { conversationId, subagentRunId }`
(acknowledged with `{ ok: true }` or `{ ok: false, code }`: `missing-id`, `not-found`,
`conversation-mismatch`) when it opens, moves to a child or its parent, and after every reconnect,
and sends `subagent_viewer_unwatch` when it closes. The relay checks the run exists and belongs to
the conversation and keeps each socket in at most one room, `subagent-viewer:<runId>`
(`services/subagent-viewer-rooms.mjs`). Batches go to that room as volatile packets, so they are
never kept for a reconnect replay and a backed-up connection drops them. socket.io also drops a
volatile packet while the connection is still writing an earlier one, even from the same tick
(a worker post that changes the header emits `subagent_status` first), so the relay holds batches
one tick, merged per run, before sending. The viewer covers what is dropped: it waits for the
watch's answer before its first read, fetches on a `seq` hole, after a reconnect, and once more when
the run ends. A refused `not-found` watch is sent again on the run's next `subagent_status`. The lane
events (`relay_activity`, `relay_thought`, `relay_stream`, `subagent_status`) go to every page as
before.

**Retention.** After `subagent_record_retention_days` (app setting, `0` = keep for good, otherwise 7,
14, 30 or 90; default 90; Settings → General → *Keep sub-agent tool output*) the relay strips a
finished run's tool entries: a `tool_result` keeps its row with empty text, a `tool_call` keeps its
one-line summary (`subagentToolCallSummary` in `shared/subagent-timeline.mjs`, the viewer's rule) in
place of the input. Both get `pruned_at` (migration 0010) and metadata
`{ pruned: true, prunedAt, originalChars, retentionDays }`; the viewer shows them as "Input removed
after N days" / "output removed after N days". Thoughts, reply text, notes, child rows and the runs
stay, and the age is the entry's `updated_at`; runs still `running` (or `pending`, `processing`) are
never touched, nor are the lane rows. `services/subagent-record-retention.mjs` sweeps 30 s after
start, once a day and 5 s after the setting changes, 2000 rows per transaction with the event loop
free in between, through a partial index over the unstripped tool entries, and logs one
`SUBAGENT RETENTION …` line. No VACUUM: SQLite reuses the freed pages. (The relay's database
backups are not VACUUM copies either: an online `backup()`, see [DEVELOPING.md](../DEVELOPING.md#the-database-file-and-its-backups).)

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

### Plan usage for agents

`relay_tool`'s `usage {relay}` (permission `read`, like `relay_info`; this relay too, as `this`)
reads `GET /api/usage` and `GET /api/usage-limit` on the target and answers per provider card
(Copilot, Claude, Claude Cloud, Cursor, Grok): `status` (`not-configured` and `unavailable` say why
in `message`), `plan`, `source`, `capturedAt`, the meters (`used`, `allowance`, `remaining`,
`utilization`, `unit`, `resetAt`, `severity`) and the card's detail rows and notes; plus
`usageLimit` (`account`: the Claude window, its utilization, reset and overage; `pauses`: the turns
held at a usage limit, by session). The dispatcher copies an allow-list of fields
(`usageCard` in `services/remote-relay-dispatcher.mjs`), so a field the usage report gains later is
not passed on; account labels and links are left out, and an e-mail address or a token-shaped
string in a text is masked. A relay without `/api/usage` per provider answers
`REMOTE_RELAY_UNSUPPORTED`; one without `/api/usage-limit` answers `usageLimit: null` with a note.

## Claude Cloud provider

Provider type `claude-cloud`: a provider of its own, never an alias of `claude`. Its conversations
run Claude Code in a sandbox at Anthropic, on a clone of a GitHub repository. The worker,
`server/claude-cloud-worker/claude-cloud-session-worker.mjs`, is a plain Node process per
conversation that speaks the usual worker contracts (WebSocket link, heartbeat, control poller,
crash guard) but runs no agent: it sends the user's messages to the cloud session and follows the
session's event stream (`claude-cloud-session-process.mjs`, `claude-cloud-event-normalizer.mjs`).
The user-facing description, including what the provider does with the Claude CLI's login, is in
the [providers guide](../docs/providers.md#claude-cloud); the tracker is
[docs/feature-tracker/claude-cloud.md](../docs/feature-tracker/claude-cloud.md).

### The cloud client and the login

`shared/claude-cloud/api-client.mjs` (`createClaudeCloudClient`) is the only code that knows the
cloud API: paths, headers and bodies were measured from what the Claude CLI sends, not taken from
a documented API, so every expectation about them lives in that one file. It is SDK-free (Node's
`fetch`), turns every failure into a `ClaudeCloudError` with a `code` (`login_missing`,
`login_expired`, `github_not_connected`, `repo_access_denied`, `environment_missing`, `not_found`,
`rate_limited`, `bad_request`, `transient`), and never reconnects or retries on a timer by itself.

`shared/claude-cloud/credentials.mjs` (`createClaudeCloudCredentials`) is the only code that reads
the login: `CLAUDE_CODE_OAUTH_TOKEN` from the environment, else `claudeAiOauth.accessToken` in
`<CLAUDE_CONFIG_DIR | ~/.claude>/.credentials.json`. The token is cached until a minute before it
expires and then read again; the refresh token is never used. The relay process has one reader and
one client (`server-runtime.mjs`), whose `nudge` lets the CLI look at its own status
(`claudeAuthService.getStatus({ force: true })`) at most once in five minutes; each worker builds
its own reader, without a nudge. `applyClaudeCloudProviderEnvironment` adds no credential to the
launch environment (`COPILOT_WEB_RELAY_WORKER_KIND=claude-cloud` and `CLAUDE_CLOUD_RELAY_MODEL`,
nothing else). Only a relay that itself runs on `CLAUDE_CODE_OAUTH_TOKEN` passes a login on: the
variable is one of `WORKER_SECRET_ENV_VARS`, restricted to the `claude-cloud` and `claude` worker
kinds (`workerSecretEnvVarsFor`), so under tmux it reaches those workers through the owner-only
secret env file, never as an `export` and never in the environment tmux is started with. Every
other kind has it taken out of its launch environment before any launch path sees it
(`withoutForeignWorkerSecrets`), so the detached and Windows launches do not pass it on either. `redact()` takes the token out of every error text.

The client's base URL is the Anthropic API. `shared/claude-cloud/base-url.mjs`
(`resolveClaudeCloudBaseUrl`) lets `OAR_CLAUDE_CLOUD_API_BASE_URL` replace it for tests, and only
with an `http(s)` URL of `127.0.0.1`, `[::1]` or `localhost` without credentials; any other value
is ignored, because the client sends the login to whatever its base URL is. The relay's client and
the worker's both resolve it there.

### Settings

`services/claude-cloud-settings-service.mjs` keeps three `app_settings` rows:
`claude_cloud_enabled` (default off), `claude_cloud_default_model` (default `claude-sonnet-5-5`)
and `claude_cloud_environment_id`. Everything else the tab shows is read, not stored: the account
from `claude auth status`, the login's source and expiry from `credentials.describe()`, the
environments from the cloud (cached for a minute). **While the provider is off, nothing is asked of
Anthropic**: the environments are listed only when it is on and a login exists. With no
environment stored, `resolveEnvironmentId` takes the account's first active one and stores it.
`models` is the Claude provider's model list with the `[…]` tier suffix dropped, deduplicated, the
default first (`buildClaudeCloudModelList`). Every change is broadcast as the socket event
`claude_cloud_settings_updated` with the GET body.

Switching the provider off does not rebind anything: there is no reconciliation as for the other
providers, and an existing cloud conversation still launches its worker.

### Creating a conversation

`POST /api/conversation/bootstrap` takes `providerType: 'claude-cloud'` with
`cloudSource: { repoUrl, branch? }`. The provider is only ever asked for by name (its model ids are
the Claude provider's own, so a model never selects it). Refusals are `400` with a `code`:
`claude_cloud_disabled`, `claude_cloud_repo_invalid`, `claude_cloud_branch_invalid`,
`claude_cloud_environment_missing`, and `CLAUDE_CLOUD_MODEL_UNAVAILABLE` for a model outside the
list. The repository is normalized to `https://github.com/<owner>/<repo>`
(`shared/claude-cloud/repo-url.mjs` → `normalizeGitHubRepoUrl`; https, ssh and scp forms of
github.com only), the branch is checked against git's ref rules (`isValidBranchName`; empty = the
default branch), and the result is stored in `conversations.cloud_source_json` in the same
transaction as the conversation. Nothing is created at Anthropic here. `POST /api/message` with
`providerType: 'claude-cloud'` on a conversation of another provider is `409
CLAUDE_CLOUD_REQUIRES_NEW_CONVERSATION`.

`POST /api/message` accepts any model of the list, before and after the first message, and stores
it on the runtime session; a model outside the list is `400 CLAUDE_CLOUD_MODEL_UNAVAILABLE`. The
delivery carries the conversation's model as `providerModel`, which the worker's `resolveModel`
prefers over the message's own model and over `CLAUDE_CLOUD_RELAY_MODEL` (the launch model). The
first message creates the session with it; before a later message whose model is not the one the
worker last gave the sandbox, the worker sends a `set_model` control request (`applyModel`; after a
worker restart once, since it cannot know). A `set_model` the API refuses costs the switch, not the
turn. Reasoning effort is always `none` and the context tier always `default`, whatever the request
says.

### Delivery, binding and resume

`buildDequeuedRelayMessage` adds a `claudeCloud` field to every message delivered to a cloud
worker (`buildClaudeCloudDelivery`): `{ sessionId, lastSequence, repoUrl, branch, environmentId,
title }`. A restarted worker therefore needs nothing but the delivery. The worker reports the
binding with `POST /api/claude-cloud-session` (`{ conversationId, cloudSessionId, sessionUrl?,
lastSequence, pushedBranch?, costUsd?, model? }`) after it created the session, after every
`result`, and on a push. `recordWorkerReport` (`services/claude-cloud-session-service.mjs`) stores
the session id, the sequence (never moved back) and the cost on the runtime session row, keeps the
session link and the list of pushed branches (the newest 20) in `cloud_source_json`, and emits the
socket event `claude_cloud_session` with `{ conversationId, cloud }`. A report that names another
cloud session than the stored one starts sequence, cost and pushed branches again.

The conversation list, the conversation payload and the bootstrap answer carry the same `cloud`
field: `{ repoUrl, slug, branch, sessionUrl, pushedBranches: [{ branch, at }], costUsd }`, or
`null` for a conversation that is not a cloud one. There is no session root for a cloud
conversation (`buildConversationSessionRootPayload` returns `null`).

### Usage

The worker posts to the Claude worker's two usage routes. `POST /api/claude-context-usage` accepts
a `claude-cloud` conversation and stores the session's context occupancy (used and maximum tokens,
no categories) in `runtime_sessions.context_usage_json`, which `GET /api/context/:id` serves.
`POST /api/claude-plan-usage` keeps a cloud worker's report under its own snapshot key
(`claude-cloud`), so the Claude card stays what the Claude workers wrote.

`GET /api/usage` builds two things from the cloud client while the provider is on
(`services/claude-account-usage-service.mjs`: the usage body, the prepaid credits and the credit
offer, read without a model turn, cached for 60 s, a failed read for 15 s; the route waits at most
3 s for them and falls back to the last turn's snapshot. Nothing is read and nothing cached is
handed out while the provider is off):

- the **Claude card's** live windows (`normalizeClaudeAccountUsage` in
  `services/plan-usage-claude.mjs`): the 5-hour, weekly and model-scoped windows with the
  account's own severity word, the week by product, and the organisation's prepaid credits;
- the **Claude Cloud card** (`services/plan-usage-claude-cloud.mjs` → `buildClaudeCloudPlanCard`):
  one meter per top-level bucket of the usage body that carries a dollar limit (the cloud credit,
  with its expiry), the relay's own cloud spend (`readClaudeCloudSpend`: the sum of
  `runtime_sessions.claude_cloud_cost_usd` over the cloud conversations that still exist, plus the
  cost of the conversation named by `?conversationId=`), the latest cloud snapshot's session
  detail, and a note when a credit is offered but not claimed.

### Archive

`DELETE /api/conversation/:id` and `POST /api/conversation/:id/archive` call
`archiveSessionInBackground` for a cloud conversation: the cloud session is archived at Anthropic,
best effort and not waited for, so neither action ever depends on Anthropic. Nothing is deleted
there.

## Claude API provider

Provider type `claude-api`: Claude Code on the relay host, billed to a Claude Console API key saved
in **Settings → Providers → Claude API** instead of the host's Claude login. The worker,
`server/claude-api-worker/claude-api-session-worker.mjs`, is the Claude worker (it runs
`runClaudeSessionWorker` from `claude-session-worker-main.mjs`, as the DeepSeek worker does) with a
backend of its own (`claude-api-backend.mjs`); its log lines read `[claude-api-worker …]`. A Claude
API chat is a Claude chat on another bill: the Claude tab's models, efforts, `[1m]` ids, thinking,
images, sub-agent models, attribution and background command limit (`claudeModels`), and the
host's Claude Code state folder (`CLAUDE_CONFIG_DIR` is left as the relay set it, `~/.claude` by
default), so its sessions, transcripts, resume and task output are where a Claude chat's are. A
Claude chat can move between the subscription and the key ([Billing switch](#billing-switch)). The
user-facing description is in the [providers guide](../docs/providers.md#claude-api); the tracker is
[docs/feature-tracker/claude-api.md](../docs/feature-tracker/claude-api.md).

### Settings and the key

`services/claude-api-settings-service.mjs` keeps six `app_settings` rows: `claude_api_key`,
`claude_api_enabled`, `claude_api_model`, `claude_api_models`, `claude_api_enabled_models` and
`claude_api_monthly_cap_usd`; the routes are `GET`/`POST /api/settings/claude-api` (see the
[API reference](#api-reference)). The key field takes any key that starts with `sk-ant-` except the
prefixes it refuses (OAuth access and refresh tokens, Admin keys, session tokens); the discovery
that follows is Anthropic's verdict on the key. A refused key stays saved, and the tab shows the
refusal as its status.

Model discovery is `shared/anthropic-api.mjs`, the only Anthropic endpoint the relay calls with the
key itself: `GET /v1/models` (`anthropic-version: 2023-06-01`, a 10 s timeout, pages of 1000, at
most 20 pages). Before the first discovery the Claude tab's list stands in; a failed discovery
keeps the list stored before it. The key goes to `https://api.anthropic.com` only.
`OAR_ANTHROPIC_API_BASE_URL` replaces that for tests, and only with a loopback URL (the rule of
`shared/claude-cloud/base-url.mjs`); any other value is ignored, and there is no base-URL setting.
The key is taken out of every error text the client produces.

### What the relay hands the worker

`applyClaudeApiProviderEnvironment` (`services/session-worker-launch-service.mjs`) sets
`COPILOT_WEB_RELAY_WORKER_KIND=claude-api`, `OAR_CLAUDE_API_KEY` (the saved key) and
`CLAUDE_API_RELAY_MODEL` (the conversation's model; without one the CLI picks its default).
Without a key it throws `claude-api-key-not-configured`, and the conversation gets the launch note.
`OAR_CLAUDE_API_KEY` is one of `WORKER_SECRET_ENV_VARS`, restricted to the `claude-api` kind: under
tmux it reaches the worker only through the owner-only secret env file, and every other kind has it
taken out of its launch environment (`withoutForeignWorkerSecrets`). The host's own
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are on that list with no kind at all, so no worker of
any kind is started with them. `COPILOT_WEB_RELAY_CLAUDE_API_WORKER_PATH` overrides the worker
script location; on Windows the console window is titled `Claude API Worker <id>`. The worker
installs its log redaction with the key (`installWorkerLogRedaction`) before anything else runs.

Per delivery the relay sends what it sends a Claude chat: Claude's attribution and the Claude tab's
background command limit.

### What the CLI gets

`claudeApiCliEnv` builds the CLI's environment from the worker's, without:

- any `ANTHROPIC_*` variable, the host's `CLAUDE_CODE_OAUTH_TOKEN` and the other ways to hand the
  CLI a login or a key (`CLAUDE_CODE_OAUTH_*`, `CLAUDE_CODE_CUSTOM_OAUTH_URL`,
  `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`);
- the provider switches (`CLAUDE_CODE_USE_BEDROCK`, `…_VERTEX`, `…_FOUNDRY`, `…_ANTHROPIC_AWS`,
  `…_ANTHROPIC_GOOGLE_CLOUD`, `…_GATEWAY`, `…_MANTLE`, `…_CCR_V2`), their `CLAUDE_CODE_SKIP_*_AUTH`
  bypasses and `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`;
- a host's model and effort pins (`CLAUDE_CODE_SUBAGENT_MODEL`, `…_SUBAGENT_MODEL_FORCE`,
  `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`) and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`;
- the relay's settings for its worker (`COPILOT_WEB_RELAY_*`, `COPILOT_PROVIDER_*`, `DEEPSEEK_*`,
  `CLAUDE_GATEWAY_*`, `OAR_*`, the other kinds' models, `COPILOT_ALLOW_ALL`, `SESSION_ID`, …) and a
  host Claude Code session's variables (`shared/host-claude-session-env.mjs`).

It then sets `ANTHROPIC_API_KEY` (the key) and `ANTHROPIC_BASE_URL` (`https://api.anthropic.com`,
or the loopback test URL).

The user's settings and the chat folder's (`.claude/settings.json`, `settings.local.json`) can still
set `env` (another base URL, another `ANTHROPIC_API_KEY`, an `ANTHROPIC_AUTH_TOKEN` that beats it, a
proxy, another provider, custom headers, a CA) and an `apiKeyHelper`. The flag settings layer (the
SDK's `settings`) outranks them all, and the backend pins it in two steps:

- **On the command line** (`claudeApiFlagSettings`, the spawn's `--settings`, which other users of
  the host can read): `disableAllHooks: true`, `env.ANTHROPIC_BASE_URL`, an empty
  `env.ANTHROPIC_AUTH_TOKEN` and an empty `apiKeyHelper`. No key.
- **Over stdin** (`claudeApiLiveFlagSettings`, the backend's `liveFlagSettings`, applied by
  `claude-sdk-adapter.mjs` with `applyFlagSettings` while the first user message is held back):
  the same layer plus `ANTHROPIC_API_KEY` and every
  variable of `CLAUDE_CLI_PINNED_ENV` (`claude-worker/claude-cli-pinned-env.mjs`, shared with
  DeepSeek: endpoints, provider switches, credentials, proxies, TLS trust) at the value the CLI was
  spawned with, else `''`. The message goes out once the CLI has answered. A refusal, or no answer
  within 60 s, fails the turn before anything is sent (`claude-live-flag-settings`).

No hooks and no status line command run, neither the user's, the folder's nor a plugin's
(`CLAUDE_CLI_KEY_CHAT_SETTINGS`); hooks in managed settings still do.
`scripts/claude-api-cli-proof.mjs` and `scripts/claude-cli-hooks-proof.mjs` show both layers against
the bundled CLI; see [DEVELOPING.md](../DEVELOPING.md#claude-api-workers). The agent's own commands
inherit the CLI's environment, the key included.

### The key source check

The CLI's `system/init` names where it took its API key from (`apiKeySource`). On a Claude API
turn anything but `ANTHROPIC_API_KEY` stops the turn as soon as the init is read (`checkInit`,
`checkClaudeApiInit`), with the code `claude-api-key-source` and a note that names the source,
never a key. The check limits a wrong credential; it does not prevent it. The CLI sends its first
request some 50 to 90 ms after the init and does not wait for the verdict, so at most one model
request may already be out on the other credential (the note says so when the turn had traffic
before the init). The CLI's nonessential traffic is not a model request.

A subscription turn gets the reverse check (`claude-worker/claude-subscription-key-check.mjs`): a
Claude worker without a backend stops a turn whose source is `ANTHROPIC_API_KEY`, `apiKeyHelper` or
`/login managed key` (a settings file's key, a key helper, a Console login), with the code
`subscription-key-source` and the advice to remove that credential or to switch the chat's billing
to API key. Any other source lets the turn go on; one the relay does not know is logged.

### Failures

`describeClaudeApiFailure` reads a refused request in the Claude API's terms, first match wins:

| Code | When | Buttons on the note |
| ---- | ---- | ------------------- |
| `claude-api-key-source` | The CLI took another credential (above) | Claude API settings |
| `claude-api-credit` | "credit balance is too low" | Add funds, Claude API settings |
| `claude-api-spend-limit` | "API usage limits", `enforced_spend_limit_reached` | Console limits |
| `claude-api-billing` | 402, `billing_error` | Console billing |
| `claude-api-key` | 401, 403, `authentication_error`, `permission_error`, "invalid x-api-key" | Claude API settings |
| `claude-api-rate-limit` | 429, 529, `rate_limit_error`, `overloaded_error` | Console limits |

The relay adds two of its own, for a turn it refuses before a worker runs it:
`claude-api-not-configured` (no key, or the provider is off) and `claude-api-cap-reached` (the
monthly cap). Each gets **Claude API settings** (at the cap field for the cap) and **Switch to
subscription**; on New Chat the second button is **Start on subscription**, and only when New Chat
offers the Claude provider. The buttons are mapped
in `public/app/relay-error-ctas.mjs`; the Console links go to `platform.claude.com/settings/billing`
and `/settings/limits`. Every failure of a Claude API chat prints as `relay.claude-api-<code>`
(`failureCodePrefix`), never as Claude's `relay.claude-<code>`, and carries no Claude account or
sign-in advice. There is no usage-limit pause on the key: the worker reports no Claude plan usage
and no usage limit (`reportsPlanUsage`, `reportsUsageLimit`), and the pause applies to `claude` and
`claude-cloud` only.

### Usage and the monthly cap

Both Claude workers, the subscription one and the Claude API one, post after every turn to
`POST /api/claude-api-usage` (the publisher's `billingUsageRoute`). The report carries the CLI's
session id, the worker's id of the CLI process (`runId`), the process's own counts per model,
counted from zero, with Claude Code's cost estimate (`runCounts`), and the CLI's session totals
(`sessionTotals`). A report is booked under the posting worker's registered kind; a body that says
otherwise is logged as `BILLING FENCE FAILURE`. `services/claude-api-usage-service.mjs`
(`recordReport`) keeps a checkpoint per conversation, session, run and model
(`claude_api_usage_checkpoints`) and books a run's rise over its checkpoint; a report at or below it
books nothing. Only `claude-api` reports book spend; a subscription report only moves the
checkpoints, so the session's mark (its checkpoint with the latest turn) stays current across a
switch. A resumed run's first result re-reports the earlier turns. It is booked as its session
totals over the mark when the mark covers the session's last finished turn, else from the run's own
counts without a price (`stale-mark`, `no-mark`, logged). Bookings go per relay-local day and model
into `claude_api_usage_totals`. Checkpoints older than 60 days are pruned hourly, keeping each
session's newest run.

`GET /api/usage` adds a Claude API card while a key is saved or the provider is on
(`services/plan-usage-claude-api.mjs`): today and this month in relay-local days, spend per model,
and the cap; its tokens are in the Tokens sections every card gets (see [Token
usage](#token-usage-all-providers)). Tokens Claude Code could not price are not $0: the card marks the estimate
incomplete, and the cap counts only priced spend. The cap is reached when this month's estimate is
at or above `claude_api_monthly_cap_usd`; while a cap is set, a spend that cannot be read counts as
reached. While it is reached, these are refused with `CLAUDE_API_CAP_REACHED`: the claim of a row on
the key, a switch to the key, an agent's send to a chat on the key, and a new Claude API chat. Turns
Claude Code starts by itself after a background task reports are stopped, and so are live
background tasks, each with a note; no worker is launched for a row that cannot run. A running turn
finishes.

### Billing switch

`POST /api/conversation/:id/billing` moves a Claude chat between `claude` (the subscription) and
`claude-api` (the key): `{ to: "claude" | "claude-api", by?: "user" | "agent" | "usage-limit",
message? }` (`provider` is taken for `to`; `by` defaults to `user`). The composer's toggle, the
usage-limit note's button (`by: "usage-limit"`, to the key only, else `400 CLAUDE_BILLING_INVALID`)
and an agent's `send` with a provider use it. `checkSwitch`
(`services/claude-billing-switch-service.mjs`) runs first, and a refusal answers with its status and
`code`:

- `400 CLAUDE_BILLING_INVALID`, `404 CONVERSATION_NOT_FOUND`;
- `409 CLAUDE_BILLING_NOT_CLAUDE` (not a Claude chat), `409 CLAUDE_API_NOT_CONFIGURED` (no key, or
  the provider is off), `409 CLAUDE_NOT_CONFIGURED`, `409 CLAUDE_API_CAP_REACHED`;
- `409 CLAUDE_BILLING_MODEL_UNAVAILABLE` with `model`, when the target's list lacks the chat's
  model (a `[1m]` model needs its `[1m]` id listed; a plain id is also found by its base);
- `409 CLAUDE_BILLING_HISTORY` is kept for a direction whose rule is "blocked"; both directions are
  allowed.

With `message` (the body `/api/message` takes) the route runs the send with the switch, so the
switch and the enqueue are one transaction: a refused send leaves the billing as it was, and a
refused switch sends nothing. Without one it answers `{ ok, conversationId, changed, provider,
released, billing }`; `501 CLAUDE_BILLING_UNAVAILABLE` without the service. The switch sets
`runtime_sessions.provider_type`, `billing_switched_at` and `billing_switched_by`, re-stamps the
chat's pending and parked rows, and writes one transcript note (kind `billing-switch`, rewritten on
a switch back; the note to the key says the first turn there has no prompt cache). A switch to the
key also releases a usage-limit pause. It emits `conversation_billing` and applies from the next
turn; a running one finishes on its billing. `GET /api/conversation/:id` carries the same
`billing`: `{ provider, pending, switchedAt, switchedBy, switchable: { to, allowed, code, reason } }`.

Every queue row names the billing it runs on (`queue.provider`), and the delivery refuses a row to a
worker of the other kind. `services/claude-billing-swap-service.mjs` then replaces the worker
between turns. It waits while the session has a `processing` row or the worker holds a turn, a
question, a compaction or background tasks. It then stops the worker and every process of the
session and launches the new kind, never reusing a live one. A stop that fails is retried with a
backoff (5 s up to 60 s), and after three failures the chat gets a note; a check for a running turn
that fails counts as a running turn. While it waits,
`billing.pending` is `{ to, waitingFor: "turn" | "question" | "compaction" | "background" | "stop" |
null, backgroundTaskCount, swapping }`; it ages out after 15 s (`CLAUDE_BILLING_SWAP_WAIT_TTL_MS`).
The first delivery to the new worker carries a note of the swap. A subscription turn stopped at the
Claude usage limit carries on on the key at once when the chat was moved to it meanwhile.

`POST /api/message` keeps the two apart:

- a send to a Claude chat that names the other billing (`provider` or `providerType`) is `409
  CLAUDE_BILLING_SWITCH_REQUIRED` (`{ code, conversationId, billing }`): it must go through the
  billing route;
- a send whose `billing` differs from the chat's (a stale tab) is `409 CLAUDE_BILLING_CHANGED` with
  `keptInDraft: true`: the text goes into the conversation's draft (`conversation_draft_updated`).
  A send without `billing` is not checked;
- an agent's send to a chat on the key while the cap is reached is `409 CLAUDE_API_CAP_REACHED`, and
  nothing is queued; a page's send is queued and refused at the claim, with a note;
- the answer carries `billingSwitched: true` when a switch came with the send.

A new chat with `providerType: 'claude-api'` (`POST /api/conversation/bootstrap`: New Chat and an
agent's `create_session`) is `400 CLAUDE_API_NOT_CONFIGURED` without a key and `409
CLAUDE_API_CAP_REACHED` at the cap. `relay_tool`'s `send` takes `provider` (`claude` or
`claude-api`) for a Claude session: the other billing goes to the billing route with the message
(`services/remote-relay-dispatcher.mjs`), and the approval card says "Switches billing to API key"
or "Switches billing to subscription". A relay from before the switch answers
`REMOTE_RELAY_UNSUPPORTED`; `CLAUDE_BILLING_MODEL_UNAVAILABLE` maps to
`REMOTE_RELAY_UNKNOWN_MODEL`, and `CLAUDE_API_NOT_CONFIGURED`, `CLAUDE_NOT_CONFIGURED` and
`CLAUDE_API_CAP_REACHED` to `REMOTE_RELAY_PROVIDER_UNAVAILABLE`.

### Redaction of the saved key

`services/worker-secret-redaction.mjs` is a middleware after the JSON parser. On every worker post
(a request with `X-Relay-Session-Id`) it replaces each saved key (DeepSeek and Claude API,
`SAVED_PROVIDER_KEY_SETTINGS`) with `[redacted]`, in values and property names. It also catches a
key's first part at the end of a cut text or before an ellipsis, and its last part at the start of
a text. It knows every key saved since the relay started, from the moment the settings route stores
it (`noteSavedSetting`). Keys shorter than 8 characters are left alone, and the settings routes are
never rewritten. Task output read from files goes through `cleanTaskOutput` instead.

### Checking a running relay

`scripts/claude-api-live-check.mjs` runs a tool turn, a follow-up and the refusal of an OAuth token
on a running relay, on the key saved there, with the cap and a refused key as options. It costs real
money; see [DEVELOPING.md](../DEVELOPING.md#claude-api-workers).

## Cursor Agent SDK provider

Cursor conversations run through `server/cursor-worker/cursor-session-worker.mjs`, a per-conversation
Node worker like the Claude one, backed by the Cursor Agent SDK. Authentication uses a Cursor API key
saved via **Settings → Cursor SDK** (`POST /api/settings/cursor`); saving or replacing the key resets
and re-runs model discovery, which also records each model's supported reasoning-effort tiers
(`effortsByModel`).

Per-turn behavior:

| Relay mode  | Cursor mapping                                                               |
| ----------- | ---------------------------------------------------------------------------- |
| `plan`      | SDK native plan mode; a plan-shaped final message publishes a **plan_ready** board, with the same buttons and follow-ups as Claude's |
| `ask` / `autopilot` | The SDK's send options carry no per-turn instruction channel, so a `[Relay mode: …]` nudge is prepended to the user message — injected only when the mode changes, and a change away from a nudged mode sends an explicit cancellation |
| `agent`     | Default behavior, no injection                                                |

- **Model and reasoning effort are per turn.** Effort is validated against the model's discovered
  tiers (`none` = model default); for `auto`/undiscovered models the request passes through and the
  worker validates it against the resolved model's live params.
- **Stale agent handles are retried once.** A cached agent handle whose exchanged auth expired fails
  as a terminal error result even though the API key is still valid, so the worker recreates the
  handle and retries a single time; a second auth failure is treated as a real key problem.
- **Session root** — the worker keeps its per-session agent store at
  `$CURSOR_AGENT_STORE_DIR/<sdkSessionId>`, else `cursor-agents/<sdkSessionId>` in the relay's data
  dir (`~/.oar/data` on a global install, `server/data` in a checkout), created on the first turn. A
  session with a store at the earlier default `server/data/cursor-agents` keeps using it there when
  it has none in the data dir, or when its `agent.db` there changed last. The explorer's Session root resolves to it via `resolveCursorSessionRoot`.
- Cursor turns are skipped by `fetchUsageSummary` like OpenAI and Claude turns — no Copilot usage
  line is attached.

## Token usage (all providers)

Every worker posts a turn's tokens to `POST /api/turn-token-usage` after the turn, beside whatever
its provider's card gets: fresh input, output, cache writes and cache reads apart, reasoning where
the provider reports it (stored, not shown), and the cost where one is known
(`services/token-usage-service.mjs`, migration 0036).

- `turn_token_usage`: one row per turn (`turn_id`, the queue row's id), run (`run_id`: the Claude
  process's id, the row's attempt id, or the worker's own per-process id) and model, with
  `conversation_id`, `provider`, `billing`, `native_session_id`, `at`, `day` and the counts. Kept with
  the chat and deleted with it, by every hard delete (the conversation route, the startup delete
  retry, the cache rebuild for the chats it removes). Nothing reads it yet besides `readTurn` and
  `readConversation`, for a later display in the chat.
- `token_usage_days`: the sums per day, provider, billing, model and source (`turns`, or `backfill`
  for the days copied by 0036). They outlive the chats.
- A count only rises: a later report of the same turn, run and model keeps the larger value per
  field (a field it leaves out keeps the earlier one), and only the rise goes into the day. A field
  stays NULL until a turn reports it.
- The day is the relay's local date of the turn's first report: the worker's `at`, or the relay's
  clock when that is missing or more than a day off. A later report of the same turn books into that
  day.
- A Claude cloud report carries the session's running totals; the turn is what they add to the
  session's other booked turns for that model, floored at 0.

What each worker reports:

| Worker | Per turn | Cache split | Cost |
| ------ | -------- | ----------- | ---- |
| Claude, Claude API, DeepSeek | the growth of the CLI's `modelUsage` per process and session, measured like the existing bookings (`claude-turn-publisher.mjs`, `turnCounts`); a resumed process's first result counts the turn's main loop only | `cacheCreationInputTokens` and `cacheReadInputTokens` apart; the older bookings still fold writes into misses | Claude Code's `costUSD`; DeepSeek's from `shared/deepseek-pricing.mjs`, sub-agents under the model that served them |
| Claude cloud | the session totals of the result's `modelUsage` | from `modelUsage`; the session read's cache figures stand in only when the session ran one model | `costUSD` |
| Copilot (plan and own key) | `assistant.usage` per model, a sub-agent's model apart; a compaction's own call from `session.compaction_complete` | as reported; a field no call carried is NULL. Fresh input is the prompt count less cache reads and writes (inferred from the runtime's OpenAI-style counts; `OAR_DEBUG_TOKEN_USAGE=1` logs each call's raw counts) | none |
| Cursor | the SDK's turn usage under the turn's model | as reported | none |
| Grok | per model where the agent breaks it down | as reported | the agent's `costUsd` |

`GET /api/usage` appends two sections per billing group to every card it answers with
(`services/plan-usage-tokens.mjs`): `<provider>-token-usage` (today, this month, all time) and
`<provider>-token-usage-by-model` (this month), with `-byok-<type>` after for an own key's group on
the Copilot card. Months are calendar months in relay local time, as on the Claude API card.
Both sections come with `open: true`. The by-model rows name models as the tab does elsewhere and
are sorted by that name; ids with one name (a dated and an undated Claude id) are one row with
their tokens added up (a field neither reported stays null) and the ids in the row's `title`
(`Model ids: <id>, <id>`), which the view shows as the row's tooltip. A detail row's `title` is
optional and set only there.

Known gaps: a 0.9.19 worker posts nothing, so its turns are missing until the workers restart on
0.9.20; a Copilot compaction that completes between turns is not counted; the backfilled days have
cache writes inside input, and DeepSeek's are UTC days, so near a month's end up to a day of
DeepSeek's share can land in the next month.

## Turn recovery and the max turn duration

A turn in `processing` is returned to the queue by two independent guards. **Both exempt a turn that
is blocked on an unanswered relay question** — that turn is waiting on a human, and `relay_questions`
carries its own expiry.

1. **Inactivity (`processingTimeoutMs`, default 10 min).** Measured from `owner_last_claimed_at`,
   which every worker heartbeat refreshes for the message it is working on — *not* from when the turn
   began. A turn that legitimately runs for hours of tool calls keeps pushing the cutoff forward.
   `processing_at` is only the fallback for rows with no owner (session-worker routing disabled).
   While the CLI is offline the window shrinks to 45 s.
2. **Absolute ceiling (Settings → Max turn duration, default 60 min).** Measured from the later of
   `processing_at` and the turn's last answered question (`relay_questions.answered_at`): answering
   a question restarts the clock, so a long interview is not cut off the moment its last answer
   arrives. `0` disables it; the slider range is 0–600 minutes in 5-minute steps. This is a
   backstop for a worker that has hung while still heartbeating, and is stored in the DB app
   setting `turn_ceiling_minutes` — not in `config.json`. Shared bounds and formatting live in
   `shared/turn-ceiling.mjs`.

Both guards are one SQL rule in `message-repository.mjs`, shared by the listing
(`listRecoverableProcessing`) and the requeue (`recoverProcessingBefore`, one row at a time,
re-checking the rule as a safeguard; the sweep runs synchronously, so nothing changes between
the two). The sweep (`services/stale-turn-recovery.mjs`) applies the retry budget to the listed
rows, requeues the rest and announces each one it requeued with `message_status`.

The sweep has no provider filter, so Grok rows are requeued by the rule above too. The Grok worker
also enforces the ceiling itself (delivered with each queue message, `grok-worker/acp-client.mjs`
`sessionPrompt`): counted from when it sent the prompt, it cancels the turn and fails it as
`grok.turn-stalled`. That check does not pause for question cards (on Grok: remote-relay approval
cards through the OAR MCP server), and an answer does not restart its clock. Whichever trips first
ends the turn.

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

## Relay event subscriptions

A session (the **watcher**) can ask to be told what happens in other sessions of this relay or of a
paired relay, through `relay_tool`. The relay tells it by writing a short event message into the
watcher's conversation; nothing reads transcripts on disk, and it works for every provider.

**Actions** (`relay` may be left out and means `this`; on this relay the agent-sessions setting must
be on, as for every local action; a paired relay: see [Across paired relays](#across-paired-relays)):

- `subscribe {sessions: [ids] | ["all"], events?, once?, match?, stalled_minutes?, heartbeat_minutes?}`
  — `all` watches every session, ones created later too. The watcher's own conversation is never
  watched. The first subscribe of a conversation shows the user an approval card naming the
  sessions; a subscription to `all` is always named on a card (asked again after an Allow that did
  not cover it). The Allow is remembered as unlock rows `self:watch` / `self:watch-all`.
  `events: ["relay_restarted"]` alone needs no sessions, watches none and shows no card (see
  [relay_restarted](#relay_restarted-woken-when-the-relay-runs-again)); on a paired relay it is
  refused, by the tool and by that relay's subscribe route.
- `unsubscribe {subscription_id | "all"}`, `list_subscriptions {watcher?}` (another conversation's
  subscriptions, to inspect before a transfer).
- `transfer_subscriptions {from}` — moves every active subscription of another conversation, with
  its settings and its undelivered events, to the caller: a watcher is replaced without a moment
  where events go nowhere. Always an approval card (from where, how many, whether `all` is among
  them), also after the caller's first-subscribe Allow. The new watcher is dropped from moved
  session lists.

**Events** (`shared/relay-events.mjs`): `question_asked` (prompt, options, question id; an approval
card is marked as one only the user can answer), `error` (`turn_failed`, `usage_limit`,
`worker_died`), `turn_end` (status `done` or `stopped`, reply preview), `task_finished` /
`task_failed` (background sub-agents and shell tasks: kind, status, exit code where known; a
non-zero exit is `task_failed`), `stalled` (no activity for `stalled_minutes`, default 15, while a
turn or task runs and no question waits for an answer), `all_idle`
(nothing runs in the watched set any more), `board_settled` (a plan card was settled, with any
button, "Stop here" included; not urgent; detail `boardId`, `boardType`, `action`, `actionLabel`,
`title`, `queuedMessageId`, null for `exit_only`). `task_started` only when named in `events`.
The `board_settled` line has exactly this form, which watchers match on:

```
[relay event] session "<session title>" (<session id>): board_settled "<card title>" → "<label>" (action <action id>, board_id <board id>, queued message <message id>)
```

For "Stop here" the parenthesis ends `…, nothing queued)`.
`subagent_finished` is no event of its own but a narrower `task_finished` a subscription can name
(`RELAY_EVENT_SUBSCRIBABLE_TYPES`): the end of a task that is not a shell command, delivered as a
`task_finished` line. The default (`events` left out) is every type but `task_started` and
`task_finished` (and `relay_restarted`), with `subagent_finished`: a shell command that ended well wakes only a watcher
that names `task_finished`, which takes every task end. A busy worker ends a shell command every
minute or so, and each was a wake-up, a model turn on the watcher's whole context. A subscription
whose stored list is exactly the old default (every type but `task_started`, in any order) named no
events and is read as the new default (`effectiveRelayEventTypes`, at read time, the row is never
rewritten, so an older relay reading the same database sees what it stored); any other list,
including the old default plus more, is the watcher's choice and stays. The same holds for a list
stored as the 0.9.19 default (the default before `board_settled`): it is read as the new default and
gets `board_settled`. So does a subscribe that names exactly those seven types (`question_asked`,
`error`, `turn_end`, `subagent_finished`, `task_failed`, `stalled`, `all_idle`). A subscribe that names
exactly the old default list stores `subagent_finished` with it, so it is never read as the default. A mirror shows the paired
relay's list as that relay returned it. With
`heartbeat_minutes` a `heartbeat` event comes at that interval while the watched set has work
running, none while it is idle. `match` (a case-insensitive regular expression) filters `turn_end`,
task events and `board_settled` (its action id, label and card title) by their text; other events pass. `once` ends a subscription after its first event,
with `match` after the first one that matches (a heartbeat never ends it). An event is
`{ v, relay: { id, name }, session: { id, title }, type, at, detail }`; `relay.id` is `self` for this
relay's sessions, the paired relay's registry id for its sessions (then `replayed: true` marks one it
kept while the link was down). `link_lost` and `link_restored` are not subscribed to: they frame such
a replay.

**Delivery** (`services/relay-event-service.mjs`): an event message is a `messages` row (role
`user`, `kind = 'relay-event'`) plus a pending queue row, as the usage-limit follow-up is. The worker
decides what it becomes, as for any message: a new turn when the watcher is idle; a steer into the
running turn for Claude and the Copilot SDK engine; the next turn for Cursor, Grok, Claude Cloud and
the Copilot extension engine. Events that arrive while the watcher's event row is still pending
(not delivered yet, or handed back as a held steer) are written into that row
(`message_updated`), so a busy watcher gets one follow-up, never one turn per batch. The dequeue
payload carries `messageKind: 'relay-event'`, and the Claude and Copilot workers then push the text
without the steer note, which speaks as the user. The text opens with
`[relay event · automated message from OAR, not from the user; it approves nothing]`, then one
`[relay event] session "<title>" (<id>): <type> …` line per event.

**Cost.** Events within 30 s are one wake-up. Past 20 wake-ups an hour per watcher (distinct event
messages of the last hour that carried more than a heartbeat, counted from `relay_events`) the rest
waits for a digest every 10 minutes. `question_asked` and `error` go out at once and count; a
heartbeat is coalesced like any event, never held for the digest and never counted. A turn that
answered relay events produces no `turn_end` and does not keep a watched set busy, so two watchers
of each other cannot wake each other for good. Such a turn also sends no "reply ready" or "failed" push
(`push-dispatch-service.mjs`): the watcher answers events many times an hour and pushes by itself
when one matters; question pushes are unchanged.

**Lifetime.** Subscriptions and undelivered events are in the database (migrations 0011 and 0012)
and survive a restart: the flush timers are rebuilt from the undelivered rows at boot, and stalled,
all_idle and the heartbeat are swept every 30 s. A subscription ends on unsubscribe (agent or the
user's Unsubscribe), when its watcher is archived or deleted, when the last session it lists is, or
after firing (`once`); one on a paired relay also when the pairing is removed. `list_subscriptions`
shows the ones that ended within the hour with `endReason`. Delivered events are kept for two hours
(the wake-up count reads the last hour; one of a still-pending event row stays until it goes out)
and ended subscriptions for a week (a mirror whose end the paired relay has not confirmed stays);
the sweep prunes both every ten minutes. A `running` sub-agent run whose worker is gone is closed by
`services/stale-subagent-run-sweep.mjs` (a minute after boot, then every ten minutes), and one not
touched for a day is not counted as running meanwhile.

**Hook points**: `/api/response` finalize (turn_end, or error at the usage limit), `failQueueMessage`
(error; a Stop is turn_end `stopped`), `failRecoveredRowTerminally`, `recoverDeadWorkerProcessingRows`
and the background-only worker death (worker_died), `/api/relay-question` and the approval card's
notify (question_asked), the activity tracker's task edges, and the archive and delete routes.

### relay_restarted: woken when the relay runs again

`relay_restarted` is an event of this relay, not of a session (`RELAY_EVENT_RELAY_LEVEL_TYPES`):
a subscription gets it only when it names it, never by default, and one that names nothing else
needs no sessions. An agent that is about to request a restart subscribes with `once: true` first:
`POST /api/relay/shutdown` has no caller identity (agents call it with the token, `requestedBy` is
free text, and agents do not know their conversation id), while the tool knows the calling conversation.

- **How the run before ended.** A clean end of the runtime writes one `app_settings` row
  (`relay_last_exit`: `action`, `reason`, `requested`, `requestedBy`, `requestedAt`, `stoppedAt`,
  `noWake`): the queued (or `immediate`) request from the restart queue's `startShutdown`, else
  `shutdownRuntime` (a signal, the owner process gone). The first note of a runtime wins; a runtime
  stopped before it listened writes none, so the record of the run before stays for the next start.
- **At startup** (`noteRelayStarted`, once the HTTP server listens: a start that fails to bind
  leaves the row for the next one) the relay reads and deletes that row in the same transaction
  that records one `relay_restarted` event for every active subscription of this relay's live
  watchers that names it (not a paired relay's, not a mirror), so each start is told once; a
  `once` subscription ends with it. Without a row the line says the relay did not record how it
  stopped (for example a crash, a forced stop or a reboot). On Windows a stop by the supervisor or
  the CLI extension ends the process without its signal handler, so an ordinary stop there may read
  like that too. A row older than 30 days (`RELAY_LAST_EXIT_MAX_AGE_MS`) is not taken as the run
  just before (an older OAR, which neither writes nor takes it, may have run in between): it is
  dropped, its `noWake` with it. A younger one is used; the line shows its stop time, so a relay
  stopped over a weekend still says how. Delivery is that of every event: coalesced for 30 s (the workers
  report back first), counted toward the hourly cap, written into an event row that is still
  pending.
- **Loop guard.** On every `POST /api/relay/shutdown` (`noteRestartRequested`) the relay notes the
  conversations whose processing turn answers a `relay_restarted` event (its queue row's
  `relay_events`); they go into `noWake` and are not woken by that restart (logged), so a woken
  turn that restarts again ends the chain. That holds for any restart requested while such a turn
  runs (the button, an update, another agent): the API cannot tell who asked. The line says so up
  front. A cancelled (or never queued) request forgets them. A held-back `once` subscription ends
  (`held-back`, logged): that restart was the one it was for, and a later one would wake it with a
  stale "carry on". If it also watches sessions, that ends with it: their events stop too. One
  without `once` stays, and a later restart requested while no such turn
  runs wakes it again. `heartbeat_minutes` on a subscription without sessions is refused (nothing
  runs in an empty set).
- The line: `[relay event] relay_restarted: the relay runs again since <time>, after a restart
  requested by "<requestedBy>" at <time> (reason "<reason>"). Timers and jobs your CLI scheduled
  before may be gone: check what you were waiting for and carry on. A restart requested while this
  turn runs does not wake you again.` A stop by signal reads `after it was stopped (SIGTERM) at
  <time>` (a process id in the runtime's own reason is left out).

### Across paired relays

The watching relay (**A**, it holds the watcher) and the watched one (**B**) each keep a row of the
subscription. Only A calls, over its pairing: a pairing in one direction is enough.

- **Gate.** The four actions with `relay: <paired relay>` pass the same checks as any `relay_tool`
  call there: the relay unlocked in the watcher's conversation (the user named it, or its agent wrote
  there), A's permission for it at least `read`, and B's inbound switch on (B refuses with
  `REMOTE_INBOUND_DISABLED`). `subscribe` first asks B with a dry run (sessions, limits, switch,
  version), then shows the watch card on A naming the relay (and `all`), remembered as
  `<registry id>:watch` / `:watch-all` and forgotten with the pairing, then subscribes on B and stores
  the mirror on A. No card on B. A relay that predates these routes answers Express's plain 404,
  which A reports as `REMOTE_RELAY_UNSUPPORTED` ("runs an OAR version without event subscriptions
  across relays").
- **B's side** (`relay-event-routes.mjs`): `POST /api/relay-events/remote/subscribe` and
  `POST /api/relay-events/remote/pull` take only another relay's request (the `X-OAR-Remote-Origin`
  header names it; this relay's own agents and the browser get `403`) and only while the inbound
  switch is on. The subscription is an ordinary row whose watcher is the key
  `remote:<that relay's id>`, which names no conversation, so nothing a paired relay asks for is ever
  written into a conversation of B's; its events are recorded, swept (stalled, all_idle, heartbeat)
  and filtered like any, and wait for the fetch. Retention: per subscription the newest 500 undelivered
  events (questions and errors kept longest), none older than 7 days; a subscription not fetched for
  7 days ends (`subscriber-gone`). What was dropped is counted and reported once.
- **The fetch** (`services/relay-event-link-service.mjs` on A): every 5 s while A holds active
  subscriptions on B or an end B has not confirmed, every 30 s after a minute without an answer,
  nothing once none are left. The body is `{ after, subscriptions: [{ id, watcher }], ended: [ids] }`:
  B deletes what A stored up to `after`, applies the ends, updates the watcher names, and answers
  `{ events, cursor, more, subscriptions: [state], ended, dropped }` (at most 200 events a page).
  A writes the events into its watchers' undelivered events (only for subscriptions it holds, into the
  watcher it stored), ends or updates its mirrors from the states, clears confirmed ends and moves its
  cursor in one transaction, so a restart of either relay loses or repeats nothing. From there
  delivery is the same as for A's own sessions: coalescing, the cap and digest, the steer, the loop
  guard (an event turn on either relay is no `turn_end` for the other).
- **Gaps.** A link without an answer for 60 s (failing fetches, or A down) is lost from its last
  answer on. The first fetch after that, every page of it, is held and written as one urgent row per
  watcher with subscriptions there: `link_lost` (no answer since …), `Replayed: N events …` with
  questions and errors first, `link_restored` (after how long, how many kept, how many dropped, which
  subscriptions ended there meanwhile). A shorter outage only delays. Nothing wakes the watcher when
  the link drops; `list_subscriptions` shows each paired subscription's `link` (`ok`, `failing`,
  `lost`), and a `heartbeat_minutes` subscription notices the silence.
- **Ends.** Unsubscribe and an archived watcher end the mirror at once and mark it until B confirms
  (`list_subscriptions` shows `endPending`); `unsubscribe` waits up to 10 s for that and says so when B
  did not answer. An archived session on B, or B's user ending the subscription there, ends the mirror
  with the next fetch (`archived`, `ended-on-relay`). Removing the pairing sends one last fetch with
  every subscription as ended, then ends the mirrors (`pairing-removed`).
- `unsubscribe "all"` and `transfer_subscriptions` act on the named relay's subscriptions; with `this`,
  `list_subscriptions` lists all of the watcher's (each with `relay`) and `transfer_subscriptions`
  moves all, its card naming the paired relays among them. A transfer reaches B as the new watcher's
  name with the next fetch.

`/api/remote-relays/tool` refuses a call that carries another relay's origin: a paired relay never
acts, or subscribes, for one of this relay's conversations.

### Session state and tasks

`services/session-activity-tracker.mjs` knows what each session is doing, from the
`/api/background-tasks` sets (a new task id is a start, a task gone from the set has ended, a
changed one is activity), `POST /api/background-task-settled` (how a task ended; the Claude worker
posts it from `task_notification`), the sub-agent run statuses and the activity, thought, stream and
timeline posts (the activity clock). A task that leaves the set without word ends after 5 s with
its run's status, else `completed` with `statusReported: false`; an exit code is read from the task
summary when it names one (the SDK has no field for it). Memory only: a restart forgets the recently
finished tasks and starts the clock at boot. Running tasks come back when the workers send their
sets again (see [Background tasks and workflow progress](#background-tasks-and-workflow-progress)):
a task that started before this runtime did is not announced as started a second time, and the end
of a task this runtime never knew is still an event when the settle notice describes the task
(`description`, `taskType`, `startedAt`). A task that ended stays ended when a later set lists it
again, unless the set names another run of it (`taskRunId`, the SDK's `run_id`): a resumed Claude
sub-agent keeps its task id, so its new run is a start (and later an end) of its own, and a settle
notice of the earlier run that arrives late does not end it. `all_idle` waits out the first 45
seconds after a relay start, like the suspend check.

`GET /api/conversations` and `GET /api/conversation/:id` carry `sessionState` (`running_turn`: a
turn processing, or queued and not held by a usage-limit pause; `background_only`: tasks running;
`idle`), `sessionTasks` (running tasks, then up to five that ended within the hour: `kind`
`subagent` | `shell`, `description`, `startedAt`, `lastActivityAt`, `status` `running` |
`completed` | `failed` | `stopped`, `exitCode`, `summary`, `endedAt`) and `lastActivityAt`.
`relay_tool`'s `list_sessions` and `read_session` pass them on as `state`, `tasks` and
`lastActivityAt`; `active` stays and is true for background work too. `read_session` adds to each
task its `taskId`, `output` (whether it has output to read), a shell task's `command` (its command
line where the worker reports one, scrubbed of credentials and cut at 2,000 characters by the relay
when the worker posts it, shown to at most 500) and, for a task with an output file, `health`
(`minutesSinceOutput`, `quiet`, `quietAfterMinutes`, test-run `counts`);
`read_task_output {session, task_id, lines?}` (read permission; default 200 lines, at most 500 or
32 KB) reads the end of that output through `GET /api/conversation/:id/background-task/:taskId/output`,
scrubbed of credentials.

### Browser

An event message renders as a compact row (`relay-event-view.mjs`) folded to its summary
(`2 events · question, reply`); a row with a question or an error starts open, a replay carries a
**replayed** tag, and the user's fold is kept across re-renders. A watcher's header shows **👁 watching
N sessions** (or all; sessions on paired relays count, the chip's title names those relays), which
opens its subscriptions with an **Unsubscribe** button each (`lab-relay · Report builder`); a watched
session shows a **watched** badge in its header and, when watched by id, in the sidebar (a
subscription to all would badge every row; one on a paired relay badges none of this relay's
sessions). On the watched relay the badge names a paired relay's watcher with its relay.
The list comes from `GET /api/relay-events/subscriptions` and the `relay_event_subscriptions`
socket event (the whole active list after every change).

### Folded agent exchanges

A prompt another agent sent the session (a paired relay's, or one of this relay's own: a user row
with `origin`) folds into one row, `note from <relay> · <session> · answered below` (`working…`,
`failed`, `stopped`, `no reply yet`), which opens to the prompt as it renders otherwise.
Presentation only (`agent-exchange-fold-view.mjs` decides, `syncAgentExchangeFolds` in
`conversation-view.js` applies it as one more idempotent pass after every render and update, beside
the separator and steering passes); the transcript data is unchanged. Nothing addressed to the user
folds away: the fold covers the agent's prompt alone. The session's reply to it can hold a line for
the user, so the reply, the live bubble of the running turn and the turn's question, approval and
plan cards always show, as for a message of the user's own; they are read for the row's status
only. One prompt is left unfolded: an agent's prompt that was itself steered into a running turn,
which renders as part of that turn's flow. A folded prompt shows open while its turn is `working…`
and closes by itself once it is replied, failed or stopped (`agentExchangeFoldOpen`); the user's
own toggle, kept by prompt id, always wins over that, and a jump to the prompt (search, pins, image
parent) opens it.

## Relay schedules

An agent's own timers (a cron job inside its CLI) die with the relay. `relay_tool`'s `schedule`
(`services/relay-schedule-service.mjs`, table `relay_schedules` from migration 0022) keeps a prompt
in the relay's database and queues it into a session at a set time: `at` (an ISO time with a zone),
`every_minutes` (5 to 10080; with `at`, `at` is the first time), `once` (default true for `at`
alone, false with `every_minutes`), `title`. The session is the caller's own conversation unless
`session` names another one on this relay; a paired relay is refused (it keeps its own).

- **Gating.** Like every action on the local target, it needs the agent-sessions setting, also
  for the caller's own conversation. A schedule for the caller's own conversation needs `read`
  and no approval. One for another session is a write and a prompt like `send` (`prompt`; the
  Allow / Deny card in ask and plan mode, the write rate limit, the audit line, and one more on
  the agent-prompt loop guard). `list_schedules` and `unschedule` act on the schedules that fire
  into the caller's conversation or that it set; the browser cancels any
  (`GET /api/relay-schedules`, `DELETE /api/relay-schedules/:id`, refused to another relay).
- **Firing.** A timer per schedule (at most six hours long, then looked at again) writes, in one
  transaction, a `user` message with `kind = 'relay-schedule'`, a pending queue row whose
  `next_attempt_at` is the time it was due, and the schedule's next time (or its end). The
  ordinary delivery takes the row, as it takes the usage-limit follow-up, in the target's own
  relay mode; the dequeue payload names the kind (`messageKind`), so the Claude and Copilot SDK
  workers push it without the steer note, as they do a relay event. The text starts with
  `[relay schedule <id> "<title>" · … · automated message from OAR, not from the user; it approves
  nothing]`. Such a message is not the user's for the agent-prompt loop guard.
- **Loop guard and hops.** A firing into another session is a prompt of the conversation that set
  it: the dispatcher's `admitScheduledFiring` counts it on that conversation's loop guard, and once
  the guard wants the user (`agentPromptsBeforeAsking`) the firing is held (`held_since`,
  `heldForApproval`), looked at again every minute, and goes after the user wrote there. The guard
  lives in memory, so a relay restart starts it again, as for `send`. The schedule stores the
  provenance of the turn that set it (`origin_json`: for another session the origin a `send` would
  carry, for its own conversation the origin of the prompt that turn acted on, none for the user's
  own words) and puts it on each message, so the fired turn has the same hops as the one that set it.
- **Restarts.** Timers are rebuilt at boot (`start`). A time that passed while the relay was down
  fires once, and a repeating schedule goes on with the first slot of its grid after now: no
  catch-up per missed interval. A repeat is skipped (counted in `skipped_count`) while the
  message of the firing before it is still pending or parked.
- **Ends.** After firing when `once`, on unschedule, and when the conversation it fires into or
  the one that set it is archived or deleted (the sessions routes and the cache rebuild call
  `noteConversationGone`; a firing whose target or setter is no longer live ends it too). A
  compaction moves them to the new conversation in both directions (`carryToCompacted`). Ended rows are listed for an
  hour and pruned after a week. At most 20 active schedules fire into one conversation, and one
  conversation sets at most 20.
- **UI.** Socket `relay_schedules` carries the whole active list on every change. The sidebar row
  of a conversation a schedule fires into shows **scheduled**; the header shows "⏰ N scheduled"
  (with the next time) on a conversation that has or set schedules, and opens their list with a
  **Cancel** button each.

## Questions that don't block

`relay_tool`'s `ask` (`services/relay-ask-service.mjs`, table `relay_asks` from migration 0023,
`shared/relay-asks.mjs`) puts a question for the owner into a session and returns at once with
`question_id` and `status: "pending"`. It is not a `relay_questions` row: those belong to a turn
(`queue_id`) that waits on them, and the queue, the stall check and the expiry treat them so.

- **Gating.** An ask about the caller's own conversation, its `list_questions` and any `withdraw`
  on this relay need neither the agent-sessions setting nor a mention (`isOwnAskCall`); the call
  rate limit applies. `session` names another session: on this relay with the setting, on a paired
  relay with `prompt` (unlocked as for any action). Such an ask on behalf is a write, as a schedule
  for another session is: the hop limit, the Allow / Deny card in ask and plan mode, the write rate
  limit and the audit line; the loop guard does not count it (the answer is the user's). An own ask
  is none of that. At most 20 pending asks per asking conversation and per session.
- **Answer.** The owner answers or dismisses an ask through the question routes (an `ask_` id on
  `POST /api/relay-question/:id/answer` takes `{ answer, choice }`; `POST
  /api/relay-question/:id/dismiss` is for asks only), from the session's card or the Inbox. A
  request from any agent, this relay's own through the loopback included, is refused there (403),
  and the dispatcher's `answer_question` refuses an ask before it calls anyone.
- **Delivery.** `relay-event-service.mjs` `noteQuestionAnswered` writes `question_answered` (an
  urgent event) for the session the ask is in and the conversation that asked, as `relay_events`
  rows with `subscription_id = 'ask:<id>'` (no subscription; an unsubscribe never drops them), and
  for the subscriptions on that session that take `question_asked`, paired relays' included. The
  message is an ordinary `relay-event` row (steered into a running turn where the provider steers,
  else the next turn), which `latestHumanMessageId` never counts: the loop guard is not reset.
- **Across paired relays.** An ask about a session on B is stored on B
  (`POST /api/relay-asks/remote/ask`, with the asker's relay id from `X-OAR-Remote-Origin`); A keeps
  a mirror row (`relay_id` = the pairing id, `remote_id`), and `relay-ask-link-service.mjs` asks B
  for the status of A's open asks every 5 s (30 s while B does not answer;
  `POST /api/relay-asks/remote/status`, the caller's own asks only), closes what closed there and
  tells A's asker. B tells its own session.
- **The pairing answers asks only.** A's Inbox answers B's ask through A
  (`POST /api/inbox/relays/:relayId/asks/:id/answer|dismiss` → B's `/api/relay-asks/remote/answer|dismiss`),
  which finds ask ids only: a card's id is not found there, and B's question routes refuse every
  approval card from another relay as before. `GET /api/relay-asks/remote/inbox` gives A's Inbox
  B's asks and cards, an approval card by its header alone and nothing that routes an answer.
- **Ends.** Archiving or deleting the session cancels its pending asks (nobody told) and the
  mirrors it asked; a compaction moves them (`carryToCompacted`); a removed pairing cancels its
  mirrors. Closed rows are pruned after a week.
- **UI.** Socket `relay_ask_updated` (`{ ask, pending }`) on every change. `GET /api/inbox` lists
  this relay (asks pending and closed in the last day, the cards turns wait on, cards answered in
  the last day) and every paired relay not known to be offline (5 s each). The sidebar's **Inbox**
  (`inbox-ui.js`, `inbox-view.mjs`) shows the count and opens the list in the transcript's place;
  a session shows its pending asks as cards before the cards it waits on. Agent text is set with
  `textContent` only.

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
  `sharedPresenceMaxPerConversation` and `sharedPresenceMaxGlobal` cap how many viewers that count
  tracks; they do not limit who can read a link.
- A revoked or renewed token answers a plain 404 on every shared route, the `/shared/:token` page
  included, exactly like a token that never existed. An open shared page stops at its next poll.
- Settings → Sharing lists the active shares (`GET /api/shares`) with **Copy link**, **Renew link**
  and **Stop sharing**, and each share's access log. Renewing adds a token to the share's lineage
  (`conversation_shares.lineage_id`, migration 0016) and revokes the old one, so the log, keyed to
  the lineage, carries over. Stopping a share or deleting the conversation deletes its log; nothing
  else prunes it.
- The access log (`conversation_share_opens`) has one row per open, not per poll: the shared page's
  first fetch carries `open=1` and counts unless the same viewer opened it in the last 10 s; a
  fetch without the flag counts only when that viewer has not fetched the share for 30 minutes
  (a page back from the background, a script). A row keeps the time, the IP address (unless
  **Store viewer IP addresses** is off), the user agent, the country from `cf-ipcountry` (only when
  the request came through a proxy the `trustProxy` setting trusts) and a viewer key: an HMAC of
  address and user agent under a per-relay secret, which counts distinct viewers without the
  address. The address is the one Express derives through `trustProxy`; a forwarded header from an
  untrusted peer is ignored.

## Pinned messages

- `PATCH /api/conversation/:id/message/:messageId/pin` with `{ pinned: boolean }` sets or clears
  `messages.pinned_at`. A conversation holds at most 100 pins; the next one is refused with `409`
  and `code: "pin-limit"`. The answer is
  `{ ok, conversationId, messageId, pinned, pins, pinsRevision }`.
- `GET /api/conversation/:id` carries `pins`: every pinned message of the conversation in
  conversation order, also those outside the requested history page, each as
  `{ messageId, role, preview, timestamp, pinnedAt, attachmentCount, hiddenFromShares }`.
  `preview` is plain text of at most 160 characters. Each message also carries `pinned`.
- Every change is broadcast as the socket event `conversation_pins_updated` with
  `{ conversationId, pins, revision }`. `revision` (`pinsRevision` in the HTTP answers) grows with
  every change. A conversation load that left the relay before a change can reach the browser
  after the change's own event; the browser keeps the list with the higher revision.
- Shared views carry neither `pins` nor `pinned`: pins are the owner's bookmarks.
- Pins belong to message rows. `/compact` starts a new conversation without them (they stay with
  the archived one); re-importing an imported session keeps them, matched like hidden marks.

## Relay Mode Selection

The composer also includes a per-message mode picker:

- `plan`
- `ask`
- `agent`
- `autopilot`

Mode is stored with each queued message so the relay can change behavior per turn.
Clarification prompts from the CLI are forwarded back into the browser as question
cards with a reply box; a card created with `allowFreeform: false` (approval and
permission cards) has none and is answered with its choices.

`plan` mode behavior:
- Draft a concise implementation plan only (no implementation output).
- Read-only inspection is allowed when it materially improves plan quality (for example `glob`, `rg`, `view`).
- Do not edit repository files or run mutating commands unless implementation is explicitly requested.

A message whose mode is on the other side of plan mode from the conversation's running turn (plan
vs. agent, ask or autopilot) is not steered into that turn: it waits and runs as its own turn when
the running one ends. Same-side messages steer as before. The composer then reads "Queue", with the
title "Queued behind the running turn: plan mode and the writing modes do not steer into each other".

**The plan card** ("Plan ready for review", a `plan_ready` board) offers, for every provider and in
this order: "Approve plan" (`approve_only`), "Implement in autopilot" (`autopilot`), "Stop here and
prompt myself" (`interactive`) and "Stop here" (`exit_only`). The Copilot CLI (extension mode) may
bring its own list (for example "Implement with autopilot fleet", `autopilot_fleet`); "Approve plan"
is added first to it. Cards pending from before the upgrade get "Approve plan" too. What each queues:

- `approve_only` marks the plan approved and queues "Plan approved by the user. Do not implement.
  Finish only the plan-only steps you were given, then stop." That one turn runs in agent mode
  (plan mode blocks writes, and the plan document may need committing); the session's saved mode
  stays plan, so the next message plans again.
- `autopilot` queues "Please implement the approved plan now." and moves the session to autopilot;
  `autopilot_fleet` queues "Please implement the approved plan using autopilot_fleet where useful."
  (autopilot).
- `interactive` queues "I approved the plan. Let's proceed interactively with implementation." and
  moves the session to agent.
- `exit_only` queues nothing.

No follow-up carries the plan summary. A click while the plan turn still runs is not steered into
it: the follow-up waits and runs as its own turn. Settling a card sends `board_settled` to the
session's subscribers (see the event types above).

**Plan-only sessions** (`conversations.plan_only`, migration 0035) lock a session in plan mode
against agents. The lock is set only when asked: relay_tool `create_session` with `planOnly: true`,
`update_session` with `planOnly: true` (with `mode: "plan"` unless the session is in plan already),
or the owner's toggle "Plan only: agents can't take this session out of plan mode" in the Context
usage modal, shown for every session. Plan mode alone never sets it.

- While it is set, an agent's `send` or `update_session` that names a mode other than plan is
  refused with HTTP 409, code `plan_only`: "This session is plan-only; agents can't change its mode.
  Clear planOnly first, or ask the user." A `send` without a mode runs in the session's saved mode. An agent's PATCH of
  the preferences route is refused too (409 for a mode change, 403 for any planOnly change): agents
  use `update_session`.
- `create_session` with `planOnly: true` and no mode starts in plan; with another mode named it is
  refused before anything is created. A target relay too old for planOnly creates the session
  without the lock, and the result says so (`planOnlyWarning`).
- An agent clears it only with `planOnly: false` in the same `update_session` that names a mode
  other than plan (`{planOnly: false, mode: "agent"}`). Alone, or with `mode: "plan"`, it is ignored,
  not refused, and on a plan-only session the answer notes "planOnly unchanged: clear it in the same call as the new mode."
  The owner's toggle clears it any time, and the owner can always change the mode in the UI; the
  mode select shows "Plan 🔒" with a dashed accent border and a title on a plan-only session.
- The plan card recommends "Approve plan" and asks before "Implement in autopilot", "Implement with
  autopilot fleet" and "Stop here and prompt myself":
  `This session is plan-only. <label> leaves plan mode. Go on?`. "Approve plan" and "Stop here"
  never ask.
- `list_sessions` and `read_session` show `planOnly: true`. A compaction keeps the lock and the
  saved mode. A turn cut by a usage limit or a restart goes on in plan, except the "Approve plan"
  turn itself.
- The conversation's own agent counts as a plan-mode caller (its saved mode), also during the one
  "Approve plan" agent turn: its `create_session` defaults to plan and its writes show the approval
  card.

**relay_tool `send` without a mode** leaves the target session in its own mode (before 0.9.20 it got
the caller's mode); a mode is set only when the sender names one. `create_session` without a mode
still takes the calling session's mode. The approval card shows a mode for a `send` only when one was
named. A 0.9.19 relay still sends its caller's mode, so a `send` from a non-plan 0.9.19 caller to a
plan-only session on 0.9.20 is refused.

## Conversation titles

The active conversation header includes a `✍️` button for renaming the conversation inline.
Title edits are saved to the database and broadcast to other open clients immediately.

## Updates

OAR never phones home by default. Automatic update checking is **opt-in**:
enable **Check for updates automatically** in ⚙️ Settings (stored in app
settings, off unless you turn it on) and the relay asks `oar.sh/latest.json`
for the newest version about twice a day (12 h ± 1 h jitter, ETag-aware, 5 s
timeout, failures silent). A manual **Check for updates** button works without
opting in — that single request is the only traffic it creates. Set
`OAR_NO_UPDATE_CHECK=1` in the relay's environment to disable even manual
checks; `OAR_UPDATE_MANIFEST_URL` points the check at a different manifest
(used by tests and staging).

When a newer version is available, Settings shows a dismissible-per-version
card (not dismissible if the release is marked critical — it still never
auto-applies). On npm-global installs, **Update** runs
`npm i -g @oar-sh/oar@<version>` with the log streamed into the card, then the
relay restarts once the running turns finish (queued messages wait for it). After the restart the relay
verifies the running version actually changed; if not, the npm log is surfaced
as a failure. Git checkouts are detect-only — the card shows a "pull to
update" hint instead of the button. `oar update [--beta] [--to X.Y.Z]` does
the same from a terminal, and rollback is `oar update --to <previous>`.

## Feature flags

Feature flags are declared in one registry (`server/features.mjs`) and managed
from the web UI's Settings → Features tab, which renders each flag with its
user-facing description. Current flags and defaults:

- `SESSION_WORKER_ROUTING_ENABLED` — ON by default; per-conversation worker
  processes with ownership and crash recovery (off = legacy shared polling).
- `SESSION_WORKER_CONTINUATION_ROUTING_ENABLED` — ON by default; strict
  ownership validation when routing clarification answers back to the asking
  worker.
- `SESSION_WORKER_FALLBACK_RESTART_ENABLED` — OFF by default; reserved rollout
  gate, no effect yet.
- `IMAGE_CONVERSATION_CONTINUITY_ENABLED` — ON by default; keeps
  generated-image context across turns so *Edit this image* can continue from
  the right source image.

Resolution happens once at relay startup, with this precedence:

1. Registry defaults
2. Stored settings (`app_settings` rows, written by the Features tab via
   `GET/POST /api/settings/features`)
3. Environment override: `COPILOT_REMOTE_{FLAG_NAME}` (`true/false`, `1/0`,
   `yes/no`, `on/off`)

Changes saved in the Features tab take effect after a relay restart; the tab
shows a restart notice and offers the queue-idle-deferred restart. A legacy
`features` key in `config.json` is migrated into `app_settings` once at boot
and stripped from the file. Unknown flag names and invalid values are ignored
safely.

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

Each conversation has its own worker process, keyed by the conversation's SDK session id: one
worker per session, and a session's turns never move to another worker. A Copilot conversation on
the *Extension* engine runs the `copilot` CLI with the web-relay extension; every other one
(Claude, Claude Cloud, Cursor, Grok, and Copilot on the *SDK* engine; OpenAI conversations run on
whichever Copilot engine is selected) runs a plain Node worker (`NODE_WORKER_DESCRIPTORS` in
`services/session-worker-launch-service.mjs`). The supervisor
(`services/session-worker-supervisor-service.mjs`) keeps the lifecycle, health and restart limits,
the launch service spawns, `services/session-worker-stop-service.mjs` stops, and the dead-worker
recovery lives in `server-runtime.mjs`. Most of it acts only while the
`SESSION_WORKER_ROUTING_ENABLED` feature flag is on.

### Lifecycle and health

- Registry status: `starting` → `ready` ⇄ `processing`, and `error`. A send, the primer for queued
  messages and `POST /api/session-worker/:sdkSessionId/launch` call `ensureWorker`, which reuses a
  live process of the session (found in the process list, or the tmux pane) and launches one
  otherwise.
- Heartbeats: every worker posts `POST /api/heartbeat` every 10 s, and any frame on its worker
  socket counts as one too. The supervisor uses them only at the start: a launched worker that has
  sent none within 90 s (`heartbeatTimeoutMs`; a Copilot CLI takes about 35 s to boot) is degraded
  as `startup-heartbeat-timeout`. After its first heartbeat a worker is judged by its pid, not by
  missed beats.
- Health (`uiState`, in `/api/status` with the worker list): `green` healthy, `red` a question card
  waits, `yellow` degraded, `white` nothing known. `degradedReason` is `startup-heartbeat-timeout`,
  `stale-pid` (the pid is gone while a turn or a question waits for the worker), `spawn-failed`,
  `restart-exhausted` or the worker's own last error. Yellow clears after 10 s of a healthy worker
  without a new failure (`degradedRecoveryGraceMs`).
- An idle (`ready`) worker whose process is gone and that has not heartbeated for 90 s leaves the
  list; the next message launches a new one. A live idle worker is never evicted by time
  (`idleEvictionMs` is 0).

### A worker that dies

- When a worker's socket closes while its session owns a processing row, holds the composer or has
  background sub-agents running, the relay checks 15 s later (`WORKER_DEATH_GRACE_MS`) whether the
  process is still alive. A sweep every 30 s checks the owners of all processing rows the same way.
- `recoverDeadWorkerProcessingRows` then drops a continuation row, fails a row the worker had
  already consumed or that is over `maxRequeueRetries` (5), and puts the others back to `pending`
  (2 s later, same owner session, one retry more). The session counts a failure (`markError`), the
  dead worker's sub-agent runs are closed, and the primer launches a new worker for the waiting rows.
- A worker that is alive but has had no socket for 60 s while a message waits is replaced (see
  [Worker link reconnects](#worker-link-reconnects)).

### Launch failures and backoff

A launch that throws, a worker that died or a queue row it failed counts a failure: the next launch
of that session waits 1 s, doubling per failure (1, 2, 4, 8, 16 s; capped at 30 s), for 5 retries (`maxRestartRetries`).
Then the session is `restart-exhausted`: one more launch is allowed 60 s after the last failure,
for up to 10 minutes after the first exhaustion, and after that only when a launch is asked for
(the conversation's Retry, the launch or kill route, a relay restart). While a session's worker
cannot be started the conversation shows a note (`services/worker-launch-note-service.mjs`). A
successful launch resets the count.

### Stopping a worker

`stopSessionWorkerProcesses` serves **☠️ Kill session** (`POST /api/session-worker/:sdkSessionId/kill`),
the CWD relaunch, a provider rebind and the replacement of a worker without a socket. It reads the
session's processes from a fresh process list and checks that they are gone: on Linux and macOS
SIGTERM to each and `tmux kill-session`, up to 3 s, then SIGKILL to the survivors and up to 2 s
more; on Windows `Stop-Process -Force` on the process tree, leaf first; processes still alive after 3 s
are stopped once more, with any new ones on a fresh list, and get up to 2 s more. A process list that cannot be read stops nothing (`process-list-unreadable`), and processes
that survive are an error (`409` from the kill route). The kill route fails the rows the worker
owned and blocks launches of the session for 3 s (`killBlockGraceMs`), so the primer does not
start it again at once; the launch route clears that block.

### Launch modes and environment

- **Linux/macOS with `tmux`:** a detached tmux session named after the SDK session id
  (`tmux attach -t <sdk-session-id>`), running `sh -lc`: the extension engine's CLI under `script`
  for a pseudo-TTY, a Node worker with its output appended to its worker log.
- **Linux/macOS without tmux:** a detached child process, a Node worker's output into its log.
- **Windows:** `cmd /c start` opens one console window per worker, titled `<Kind> Worker <first 8
  characters of the session id>`; the extension engine runs `gh copilot -- --allow-all
  --session-id <id>`.

The launch environment is the relay's own, taken once at boot (`buildSessionWorkerLaunchEnv`), plus
per launch the conversation's working directory as `COPILOT_WORKSPACE_ROOT` and `INIT_CWD`,
`SESSION_ID`, `COPILOT_ALLOW_ALL`, and the bound provider's worker kind, model and credentials
(`buildSessionWorkerLaunchEnvForSession`), minus the secrets that are another worker kind's
(`withoutForeignWorkerSecrets`). The detached and Windows launches pass all of that. Under tmux
the worker's login shell gets only the variables `buildTmuxWorkerShellCommand` exports, and the
secrets (`COPILOT_PROVIDER_API_KEY`, `CURSOR_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` for cloud and
Claude workers, `DEEPSEEK_API_KEY` for DeepSeek workers, `OAR_CLAUDE_API_KEY` for Claude API
workers) through an owner-only file it reads and deletes, never in the environment tmux is
started with. The host's `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are secrets of no kind: no
worker is started with them. Any other variable, such as
`OAR_TURN_STALL_*_MS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or `XAI_API_KEY`, only from the tmux
server's environment or the login profile (see [Session workers under
tmux](../docs/configuration.md#environment-variables)). `COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN` makes
every launch fail (`cli-spawn-disabled`), for test relays.

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
  (see [Worker link reconnects](#worker-link-reconnects))
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

### Worker link reconnects

Every session worker (Copilot SDK, Claude, Claude Cloud, Cursor, Grok) and the Copilot CLI extension
use the same link, `shared/worker-runtime/worker-websocket-link.mjs`. Its reconnect rules:

- A connection counts as made at the relay's first `server.hello`, which the relay sends as soon as it
  accepts the socket. A socket still connecting, or open without that hello, after 15 seconds
  (`connectTimeoutMs`) is given up and retried: a relay hung in its shutdown can hold a socket in
  either state without ever ending it.
- The link ends a socket on whichever comes first of an error, a close, that deadline, a stale
  connection (30 seconds without a server frame) and the relay's `server.draining`, and schedules
  the next attempt from there; later events from the same socket are ignored. It never waits for a
  close event, which Node 22 does not fire for a socket closed while connecting, and a socket whose
  constructor throws is retried too.
- There is at most one pending reconnect and one socket at a time. The delay starts at 1 second and
  doubles up to 8 seconds, plus up to 250 ms of jitter; it starts over only after a completed
  handshake, so a relay that accepts and drops the socket is not retried every second.
- Each failed attempt logs one `worker ws disconnected <reason> attempt=<n> retryInMs=<ms>` line in
  the worker log for the first three, then at most one a minute, with `notLogged=<n>` counting the
  ones in between.
- `stop()` (worker shutdown) clears the pending reconnect and the deadline and closes the socket
  without scheduling another attempt.

The relay's detached-worker watch (`services/detached-worker-watch-service.mjs`) is the safety net
behind this: it replaces a worker that has had no socket for 60 seconds while a message waits, but
never while a turn or background work of that session runs, so the link has to reconnect by itself.

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

- Each worker opens its own console window through `cmd /c start`, titled `<Kind> Worker <first 8
  characters of the session id>` (`Copilot Worker`, `Claude Worker`, `Cursor Worker`, `Grok Worker`,
  `Claude Cloud Worker`, `Copilot SDK Worker`); a relaunch opens a new window.
- Node workers run `node <kind>-session-worker.mjs --session-id <id>` directly; the extension engine
  runs `gh copilot -- --allow-all --session-id <id>`.

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
| POST | `/api/message` | Send a message from the browser. A Claude chat's send that names the other billing is `409 CLAUDE_BILLING_SWITCH_REQUIRED`, one whose `billing` is stale `409 CLAUDE_BILLING_CHANGED` (kept in the draft); see [Billing switch](#billing-switch) |
| POST | `/api/upload` | Upload binary file content (deduped by SHA-256) |
| GET | `/api/upload/:sha256/content` | Stream stored upload content by hash |
| PATCH | `/api/conversation/:id/draft` | Save composer draft text and optional `draftAttachments` |
| GET | `/api/files/*` | Stream a workspace file by repo-relative path (token required) |
| GET | `/api/files-preview/*` | Return structured preview JSON for markdown/code/text/image/video files |
| GET | `/api/repo/tree` | Return repository root + first-level entries for lazy workspace browsing |
| GET | `/api/repo/list` | Lazy-load workspace directory entries (`path`, `includeHidden`, `includeHeavy`) |
| GET | `/api/drives/roots` | Return browsable root(s) for explorer drive mode — on Windows returns fixed/removable drive letters; on Linux returns a single `/` root node |
| GET | `/api/drives/list` | Lazy-load directory entries (`path`, optional `includeHidden`) — on Windows `path` is a drive-letter path (e.g. `C:/foo`); on Linux `path` is an absolute POSIX path (e.g. `/home/user`) |
| GET | `/api/session-root/list` | List the explorer's Session root (`path`, optional `includeHidden`) — like `/api/drives/list`, but a not-yet-created root returns an empty folder (`exists: false`) instead of 404, and the sibling `<path>.jsonl` transcript is appended as a child |
| POST | `/api/repo/mkdir` | Create a folder in the workspace: `{ path, name, conversationId? }` where `path` is the repo-relative parent (`''` for the root); the target is resolved like `/api/files/*` (no `..`, no symlink escape). Answers `{ ok, path }`; 409 when the name is taken |
| POST | `/api/repo/rename` | Rename a workspace entry in place: `{ path, newName, conversationId? }`. The root cannot be renamed; symlinks are refused. Answers `{ ok, path }` |
| POST | `/api/repo/delete` | Delete a workspace entry, folders recursively: `{ path, conversationId?, dryRun? }`. `dryRun: true` answers `{ ok, kind, files, dirs, capped }` (counted below the folder, capped at 10 000) and removes nothing |
| POST | `/api/drives/mkdir` | As `/api/repo/mkdir` for an absolute path (also the explorer's Session root), checked like `/api/drives/list`: `{ path, name }`. Missing parents are created with the folder |
| POST | `/api/drives/rename` | As `/api/repo/rename` for an absolute path: `{ path, newName }`. `/` and drive roots are refused |
| POST | `/api/drives/delete` | As `/api/repo/delete` for an absolute path: `{ path, dryRun? }`. `/` and drive roots are refused |
| GET | `/api/drives/file` | Stream a file by path — Windows drive path or Linux absolute path depending on server platform |
| GET | `/api/drives/files-preview` | Return structured preview JSON for a file — Windows drive path or Linux absolute path depending on server platform |
| GET | `/api/git/status` | Git status for the conversation's workspace root (`branch`, `upstream`, `ahead`, `behind`, `files[]` incl. untracked); a non-repo root returns `isRepo: false` rather than an error |
| GET | `/api/git/diff` | Full-context unified diff for one changed file (`path`, optional `untracked=1`); the client renders both "changes only" and "full file" views from this single patch |
| POST | `/api/git/pull` | Run `git pull` in the conversation's workspace root and return the combined output |
| GET | `/api/git/remote` | Where a folder lives on GitHub, for the New Chat modal of a Claude Cloud chat: `?root=<absolute path>` → `{ ok, root, hasGit, remoteUrl, repoUrl, slug, branch, upstream, ahead, behind, dirty }`. The one git route that takes a path from the client; it passes the same policy as a requested CWD (`403` outside `workspaceRootAllowList`, `400` otherwise). Read-only (`git status`, `git remote get-url`) |
| GET | `/api/conversations` | List all conversations |
| GET | `/api/sessions` | List runtime sessions bound 1:1 to conversations |
| GET | `/api/conversation/:id` | Get conversation message windows (`before*`, `after*`, or `aroundMessageId`) plus session-root metadata |
| GET | `/api/search/messages` | Search message text across all conversations (`q`, `limit`, `offset`) |
| PATCH | `/api/conversation/:id` | Update a conversation title |
| POST | `/api/conversation/:id/billing` | Move a Claude chat between the subscription and the saved API key: `{ to: "claude" \| "claude-api", by?: "user" \| "agent" \| "usage-limit", message? }` → `{ ok, conversationId, changed, provider, released, billing }`; with `message` (an `/api/message` body) the switch and the send are one transaction and the answer is the send's. Refusals are `400`/`404`/`409` with a `code` (`CLAUDE_BILLING_*`, `CLAUDE_API_NOT_CONFIGURED`, `CLAUDE_NOT_CONFIGURED`, `CLAUDE_API_CAP_REACHED`); emits `conversation_billing`. See [Billing switch](#billing-switch) |
| POST | `/api/conversation/:id/compact` | Compact a conversation into a new one with carry-over summary seed |
| DELETE | `/api/conversation/:id` | Delete a conversation: stops its session worker, deletes its CLI session, removes its rows. A Claude API conversation's Claude Code session is deleted as a Claude one's (it is in the same place). A Claude Cloud conversation's cloud session is archived at Anthropic in the background (never waited for). A Copilot session the relay only imported and never ran is hidden and tombstoned instead: nothing is stopped and its CLI session is kept. `409 conversation-active` (`reason: turn-running` / `background-tasks`) while it is still working; `409 worker-stop-failed` when its worker survives the stop (nothing deleted) |
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
| POST | `/api/relay/shutdown` | Queue an authenticated relay shutdown or self-restart |
| GET | `/api/relay/shutdown` | The queued request's state (as `relay_shutdown_state`), plus `preview`: what a restart asked now would wait for and leave running (`?action=shutdown` for a shutdown). See [Manual relay shutdown / self-restart](#manual-relay-shutdown--self-restart) |
| POST | `/api/relay/shutdown/keep-waiting` | Answer to the max-wait question: the queued request waits another full period, counted from now → `{ ok, extended, …state }` |
| POST | `/api/relay/shutdown/cancel` | Withdraw a queued (not yet started) shutdown or restart; held messages go out at once |
| GET | `/api/relay-questions` | (CLI/UI) List relay questions by `status` (for example `pending` or `answered`) |
| GET | `/api/relay-question/:id` | (CLI) Fetch a single relay question |
| POST | `/api/relay-question` | (CLI) Create a relay question for the browser. `allowFreeform` defaults to `false` when `choices` are given (to `true` without): such a card has no reply box and takes only its choices |
| POST | `/api/relay-question/:id/answer` | (UI) Submit an answer for a relay question. A card created with `allowFreeform: false` and choices (approval and permission cards) takes only its choices, matched trimmed and in any case and stored as the card's label (several, `", "`-joined, on a multi-select card); anything else is refused with `400` and `choices`, and the card stays open |
| POST | `/api/relay-question/:id/timeout` | (CLI/UI) Mark a relay question timed out |
| POST | `/api/heartbeat` | (CLI) Keep CLI status alive. A session worker may send `backgroundTasks: { count, digest }`; the answer carries `resyncBackgroundTasks: true` when the relay's set for that worker differs |
| GET | `/api/status` | Overall status |
| GET | `/api/about` | The About OAR modal: `version`, `commit` (the checkout's HEAD read from `.git`, else a `gitHead` stamp in package.json, else `null`), `startedAt` and `uptimeSeconds` of the relay process; `providers[]` (enabled ones only: `cliVersion` from the CLI probe cache, never a new probe, `sdkVersion` from node_modules, `state` `online`/`offline` for the relay CLI that runs Copilot's extension engine and OpenAI, `online`/`idle` with `runningWorkers` for the others); `stats` (conversations, messages, turns = replies, `turnsByProvider`, `firstConversationAt`); `usage` (only what is stored: Copilot premium requests, Cursor and Grok tokens and cost, Claude Cloud cost); `relay` (`dbBytes` = database + WAL, `runningWorkers`); `update` (latest version only while the opt-in check is on). The totals are read in rowid ranges of 10 000 messages with the event loop free in between, and kept for 60 s |
| GET | `/api/models` | Live/cached model catalog used by the UI picker |
| POST | `/api/models/snapshot` | (CLI/relay) Publish discovered model snapshot |
| POST | `/api/conversation/:id/refresh-history` | Re-import an existing conversation's history through the local Copilot SDK |
| GET | `/api/context/:conversationId` | Context metrics for a conversation or `sdk_session_id`. Copilot sessions are parsed from session-state events (falling back to a labeled lower-bound completion-token estimate when full legacy buckets are missing); Claude sessions are served from the breakdown their worker stored, and so are Cursor, Grok, Claude Cloud and Claude API sessions; a Claude API session also gets the Claude session's running auto-compact window and the folder's commit attribution. All return the same normalized `contextUsage` view alongside `providerType` and the runtime's own `text` dump |
| GET | `/api/context` | Same payload when a `conversationId` query is provided; otherwise returns a missing-selection response |
| GET | `/api/usage` | Unified plan usage: one card per configured provider (`providers[]` with `meters`, `details`, `links`) built from the live Copilot quota, the Claude worker's latest stored snapshot, and the derived Cursor cycle totals. A provider that cannot be read yields an unavailable card rather than failing the response, so the modal always renders. While Claude Cloud is on, the Claude card's windows are read live from the account, and a Claude Cloud card is added (credit meters, the relay's cloud spend, and the cost of the conversation named by `?conversationId=` when it is a cloud one); a card may carry `notes[]` (a line of text with an optional https link), and a meter `severity` and `resetKind: 'expiry'`. While DeepSeek is on, a DeepSeek card is added: the account balance (`GET {baseUrl}/user/balance` with the saved key, kept for a minute; `is_available: false` becomes a warning, a failed read a `partial` card with the reason and the last balance read) and the relay's estimated spend per model and in total, in the balance's currency (USD without one), as notes and detail rows. Its `meters[]` are a balance bar per currency with money (`deepseek-balance-<currency>`, unit `cny` or `usd`, measured against the balance after its last rise, which `deepseek_balance_reference` keeps) and, with a budget set, `deepseek-monthly-budget` (this calendar month's spend from `deepseek_usage_days`, `resetAt` the next 1st at 00:00 UTC). Its `charts[]` (`{ id, label, kind: 'columns' | 'bars', unit, series[], items[{ key, label, values }], note, summary }`) are `deepseek-daily-spend` (30 UTC days stacked by model) and `deepseek-spend-shares` (per model: cache hit, miss, output and, once any, searches and fetches; `summary` what the cache saved); `?providers=deepseek` reads it live. While a Claude API key is saved or the provider is on, a Claude API card is added: today's and this month's estimated spend and tokens per model in relay-local days, and the monthly cap (see [Usage and the monthly cap](#usage-and-the-monthly-cap)). Legacy top-level Copilot quota fields are spread alongside `providers` for cached clients; `?legacy=1` returns the Copilot-only snapshot on its own |
| GET | `/api/settings/cursor-allowance` | Read the manual Cursor plan allowances (`cursorModelsUsd`, `otherModelsUsd`, `resetDay`) |
| POST | `/api/settings/cursor-allowance` | Set the Cursor pool allowances and billing reset day; `null` clears an allowance, and `resetAccounting: true` re-baselines the derived spend tracking |
| GET | `/api/settings/claude` | Read Claude provider settings (`enabled`, `model`, `models`, `availableModels`, `attributionMode`, `backgroundCommandLimitMinutes` with the slider bounds `backgroundCommandLimitMinMinutes`, `backgroundCommandLimitMaxMinutes`, `backgroundCommandLimitStepMinutes`, `backgroundCommandLimitDefaultMinutes`) |
| POST | `/api/settings/claude` | Enable/disable Claude, set the default model, the enabled model subset, the attribution mode or `backgroundCommandLimitMinutes` (clamped to 30…480 and snapped to 30-minute steps; not a number is `400`; read by Claude sessions spawned afterwards); triggers discovery and unstarted-conversation reconciliation |
| GET | `/api/settings/claude-cloud` | Read Claude Cloud settings: `{ enabled, defaultModel, environmentId, environments: [{ id, name }] \| null, environmentsError, account: { loggedIn, email, orgName, subscriptionType } \| null, token: { source, hasToken, expiresAt }, models }`. `token` says where the login is read from (`env`, `file`, `none`) and when it runs out, never the token. `environments` is `null` while the provider is off or the host has no login: nothing is asked of Anthropic then |
| POST | `/api/settings/claude-cloud` | `{ enabled?, defaultModel?, environmentId? }` → `{ ok: true, …the GET body }`. Enabling without a Claude login on the host is `400` with `code: 'claude_cloud_login_missing'`; an empty `environmentId` clears the stored one. Emits `claude_cloud_settings_updated` |
| GET | `/api/settings/cursor` | Read Cursor provider settings — same shape as Claude's: `models` is the enabled subset, `availableModels` the full discovered list, plus per-model `efforts` |
| POST | `/api/settings/cursor` | Set/remove the Cursor API key, default model, or enabled model subset; key changes reset discovered models and effort tiers |
| GET | `/api/settings/deepseek` | Read DeepSeek settings: `{ configured, enabled, model, models, availableModels, discovered, baseUrl, defaultBaseUrl, attribution, monthlyBudget, monthlyBudgetCurrency, efforts, providerType }`. `monthlyBudgetCurrency` is `USD` or `CNY`, or `null` for a budget saved before the currency was stored (read in the balance's currency). `models` is the enabled subset (the default model always in it), `availableModels` what `GET {baseUrl}/models` listed (or the built-in `deepseek-flash`, `deepseek-v4-pro`). The key is never in it: `configured` says whether one is stored |
| POST | `/api/settings/deepseek` | `{ apiKey?, enabled?, model?, enabledModels?, baseUrl?, attribution?, monthlyBudget?, monthlyBudgetCurrency?, remove? }` → `{ ok: true, …the GET body, reconciliation, warning }`. A key switches the provider on and runs model discovery; a changed key stops the live DeepSeek workers. `baseUrl` must be `https:` (`http:` only on a loopback host), without credentials, query or fragment; `attribution` is `oar` or `off`; `monthlyBudget` is an amount of zero or more (rounded to cents; `null`, empty or zero clears it and its currency, which removes the usage card's budget bar); `monthlyBudgetCurrency` is `USD` or `CNY` (`null` or empty: the balance's currency), stored with the budget and shown on the bar; else `400`. Removing the key is `409` (`deepseek-key-removal-blocked`) while a DeepSeek conversation has a message or a queued one, and moves unstarted DeepSeek conversations back to Copilot. Emits `deepseek_settings_updated` and `models_updated` |
| GET | `/api/settings/claude-api` | Read Claude API settings (Claude chats on a Claude Console API key): `{ configured, enabled, model, models, availableModels, enabledModels, discovered, effortsByModel, contextWindowsByModel, modelDetails, monthlyCapUsd, providerType, label }`. `availableModels` is what `GET https://api.anthropic.com/v1/models` listed for the key (with a `[1m]` id beside a model with a 1M window or one the Claude tab lists so), or the Claude tab's list before the first discovery; `models` is the enabled subset (the default model always in it). The default model is the Claude tab's when offered, else the first Sonnet. The efforts are the Claude provider's, narrowed by what Anthropic reports per model. The key is never in it: `configured` says whether one is stored |
| POST | `/api/settings/claude-api` | `{ apiKey?, enabled?, model?, enabledModels?, monthlyCapUsd?, remove? }` → `{ ok: true, …the GET body, reconciliation, warning }`. A key switches the provider on and runs model discovery; a changed key stops the live Claude API workers. Claude OAuth access and refresh tokens (`sk-ant-oat`, `sk-ant-ort`), Admin keys (`sk-ant-admin`), claude.ai and Claude Code session tokens (`sk-ant-sid`, `sk-ant-si-`, `sk-ant-cc-`, `sk-ant-ccsr-`) and any key that does not start with `sk-ant-` (another vendor's; `claude-api-key-not-console-key`) are refused by prefix (`400`, `claude-api-key-<kind>`), never quoted back. Any other `sk-ant-` key is saved, and the discovery that follows is Anthropic's verdict on it: a key Anthropic refuses stays saved, and the answer carries the refusal in `warning` and in `discoveryError` (`{ error, code }`, null when discovery did not run or went through), which the tab shows as its status. A model list asked for with a key that was changed or removed before the answer came is dropped, and `warning` says so. `monthlyCapUsd` is empty/null for no cap, else a positive amount with at most two decimals up to 1,000,000. Removing the key is `409` (`claude-api-key-removal-blocked`) while a Claude API conversation has a message or a queued one; removing it or switching the provider off moves unstarted Claude API conversations back to Copilot. Emits `claude_api_settings_updated` and `models_updated` |
| GET | `/api/settings/turn-ceiling` | Read the max turn duration plus slider bounds (`minMinutes`, `maxMinutes`, `stepMinutes`, `defaultMinutes`) |
| POST | `/api/settings/turn-ceiling` | Set the max turn duration in minutes (`0` = no limit) |
| GET | `/api/settings/relay-restart-max-wait` | How long a queued relay restart waits before it asks: `{ maxWaitMinutes, choices: [5, 10, 15, 30, 60, 120, 240, 0], defaultMinutes: 30, overrideMs }`; `0` = no limit; `overrideMs` is `OAR_RELAY_RESTART_MAX_WAIT_MS` when set |
| POST | `/api/settings/relay-restart-max-wait` | `{ maxWaitMinutes }` → the GET body; anything but one of `choices` is `400`. A queued request measures its current period against the new value at once |
| GET | `/api/settings/subagent-record-retention` | How long sub-agent records keep tool inputs and output: `{ retentionDays, choices: [0, 7, 14, 30, 90], defaultDays: 90 }`; `0` = keep for good |
| POST | `/api/settings/subagent-record-retention` | `{ retentionDays }` → the GET body; anything but one of `choices` is `400`. Runs a retention sweep 5 s later |
| POST | `/api/claude-native-session` | (Claude, DeepSeek and Claude API workers) Persist the native Agent SDK session id for resume |
| POST | `/api/claude-context-usage` | (Claude, Claude Cloud, DeepSeek and Claude API workers) Report the session's context-window breakdown after a turn; `409` for a conversation of any other provider |
| POST | `/api/claude-plan-usage` | (Claude and Claude Cloud workers) Report the session's structured `/usage` data — plan rate-limit windows plus session cost totals — falling back to the stable `modelUsage`/`totalCostUsd` result fields. Stored as the latest Claude snapshot; a Claude Cloud conversation's report is stored under its own snapshot key, `claude-cloud` |
| POST | `/api/claude-cloud-session` | (Claude Cloud worker) Report the cloud session a conversation is bound to: `{ conversationId, cloudSessionId, sessionUrl?, lastSequence, pushedBranch?, costUsd?, model? }` → `{ ok, cloud }`. Sent after the session was created, after every `result` and on a push; emits `claude_cloud_session`. `404` without a runtime session, `409` for a conversation that is not a cloud one |
| POST | `/api/cursor-plan-usage` | (Cursor worker) Report the agent's cumulative billed usage; the relay diffs it against a per-agent checkpoint and books the increase into the current billing cycle under the pool implied by the turn's model |
| POST | `/api/claude-api-usage` | (Claude and Claude API workers) Report, after every turn, what the turn's Claude Code process ran: `{ conversationId, claudeNativeSessionId, runId, at, turnId?, firstResultOfRun?, resumedSessionId?, billing, runCounts: [{ model, hitTokens, missTokens, outputTokens, costUsd, costUnknown? }], sessionTotals: [ … ] }` → `{ ok, billing, basis, models }`. The billing is the posting worker's registered kind (the body's only without one); only `claude-api` reports book spend, a subscription report keeps the session's mark. See [Usage and the monthly cap](#usage-and-the-monthly-cap). `400` on a malformed body, `404` without a runtime session, `409` for a conversation that is not a Claude one, `501` without the usage service |
| POST | `/api/deepseek-plan-usage` | (DeepSeek worker) Report, after a turn, the CLI's running token totals per model for its Claude Code session: `{ conversationId, sdkSessionId?, claudeNativeSessionId, runId?, at?, totals: [{ model, hitTokens, missTokens, outputTokens }], requests?: [{ model, searchRequests, fetchRequests }] }` (cache hits, cache misses, output; the web searches and fetches). `runId` names the worker's Claude Code process. A Claude model name (`claude-opus-5-5`, from a Claude Code spawned without the alias pins) is booked under the DeepSeek model that served it (`claude-opus*` → `deepseek-v4-pro`, `claude-sonnet*` / `claude-haiku*` → `deepseek-flash`), entries of one model summed. With a run id the totals are that process's own, counted from zero by the worker (the CLI's `modelUsage` is the session's running total, which a resumed CLI continues from its transcript; the worker reports what it grows by per result, and for the first result of a process resumed on its session the turn's own `usage`, so a CLI that died before writing its cost state and restored an older snapshot books nothing of the history again). The relay keeps the totals last reported per (conversation, session, model), with the run id, in `deepseek_usage_checkpoints` and books, under the checkpoint's run id, only the increase, field by field, into `deepseek_usage_totals` with the estimate in USD and CNY at DeepSeek's price for `at` (peak or off-peak; the relay's time when it is missing or more than five minutes ahead). A total below its checkpoint under the checkpoint's run id is a stale report (retried, or delivered after a later one): nothing is booked and the checkpoint keeps its high-water mark. Under another run id the report is a new process, booked in full, from which the checkpoint starts over. Known limits: a late report of an earlier process after a newer one started is booked in full, and the newer run's next report is also booked in full (the checkpoint had moved back to the earlier run, so the relay cannot tell either from a new process); the first result of a process resumed on its session reports the main loop's `usage` under the turn's model, so what sub-agents spent in that one turn is left out. Without a run id (an older worker) the totals are the CLI's session totals: the increase is booked, and a drop is a CLI counting from zero again on the same session, booked in full. A new session starts from zero. With a run id the requests are the process's running counts, booked like the tokens under a run id of their own (`request_run_id`; a repeated post adds nothing, an entry with counts only leaves the token checkpoint's run alone); without one they are the turn's counts, booked as they come. Requests are counted from the first turn and priced at $0.75 / ¥5 per 1,000 from 2026-10-31 16:00 UTC (no peak price); the same sums go into `deepseek_usage_days` per UTC day in the same transaction. A repeated report answers `200` with nothing booked. `400` on a malformed body, `404` without a runtime session, `409` for a conversation not bound to DeepSeek |
| POST | `/api/turn-token-usage` | (every worker) Report a turn's tokens: `{ conversationId, turnId, runId?, provider?, billing?, nativeSessionId?, responseMessageId?, at?, models: [{ model, inputTokens?, outputTokens?, cacheWriteTokens?, cacheReadTokens?, reasoningTokens?, costUsd?, costSource?, costUnknown? }] }`, or `sessionTotals` in place of `models` (Claude cloud: the session's running totals; needs `nativeSessionId`). `turnId` is the queue row's id; `runId` the worker process or attempt. `inputTokens` is fresh input, without cache reads and writes. A missing, negative, non-finite or unsafely large count is unknown (NULL), and 0 means reported zero; a cost above $1e9 is unknown; at most 32 models. The relay books the turn's rise per field over what the same turn, run and model already booked (see [Token usage](#token-usage-all-providers)), so a retried or reordered report books nothing twice. The provider is the chat's: a Claude chat's posting worker's registered kind, else the chat's binding, and the body's `provider` only for a chat without a binding (a cache rebuild); a chat on the user's own OpenAI key books as `github` with billing `byok-openai`, and a Copilot chat's `billing` may name `byok-<type>`. Answers `{ ok, provider, billing, models }`. `400` on a malformed body, `404` for a conversation that does not exist or is deleted (an archived one books), `409` for a chat that keeps no token usage, `501` without the tables |
| POST | `/api/subagent-run` | (Worker) Register/update a subagent run. A new run needs the spawning turn's `messageId`; an update to a known run may omit it (a background agent's end arrives between turns). Optional header fields: `subagentType`, `model`, `modelInherited`, `taskId`, `background`, `timelineOwner`; a post without `status` leaves the run's state alone. Emits `subagent_status` with the whole header |
| POST | `/api/subagent-timeline` | (Worker) `{ conversationId, subagentRunId, taskId?, entries: [{ key, kind, text, done?, toolName?, toolUseId?, metadata? }], header? }` → `{ ok, stored, truncated }`. Kinds: `thought`, `tool_call`, `tool_result`, `text`, `child`, `note`. Fenced by the run row, not by an open turn; an unknown run whose `header.parentSubagentId` is known is created under the parent's turn, an unknown run whose `taskId` (or `header.taskId`) a run of the conversation carries is written to that run (a resumed agent; when the post sets that finished run `running` again, the relay adds a note where it resumed), anything else is `404 unknown_run`. `header.status: 'running'` clears the run's end time. Sends `subagent_timeline` `{ conversationId, messageId, subagentRunId, entries, truncated }`, volatile, only to the pages watching the run (`subagent_viewer_watch`) |
| GET | `/api/conversation/:conversationId/subagent/:subagentRunId` | One run's record for the viewer: `?after=<seq>&limit=<n>` (default 500, max 2000) → `{ run, entries, children, nextAfter, complete }`. `entries` are those after `after` plus any still open; `run.legacy` marks a record rebuilt from the lane rows |
| POST | `/api/conversation/:conversationId/subagent/:subagentRunId/cancel` | Queue an `abort_subagent` control for the session's worker (`{ parentMessageId?, clientId? }` → `{ ok, queued, acknowledgement }`; `not-found`, `message-mismatch`, `already-cancelled` and `already-finished` queue nothing). The Claude worker stops a background sub-agent (`stopTask`), the Copilot SDK worker a background agent (`rpc.tasks.cancel`), the extension engine tries the SDK session's abort methods; any other run, or worker, answers "not supported". Workers read controls only while a turn runs. Whole-turn **Stop** always works |
| PATCH | `/api/conversation/:id/message/:messageId/share-visibility` | Hide or unhide a single message from shared views |
| PATCH | `/api/conversation/:id/message/:messageId/pin` | `{ pinned }` → pin or unpin a single message; answers with the conversation's pin list and broadcasts `conversation_pins_updated` |
| POST | `/api/conversation/:id/share` | The conversation's read-only share link, made if it has none (one active share per conversation): `{ token, shareUrl, path, created }`; a new one sends `share_created` |
| POST | `/api/conversation/:id/share/renew` | A new token for the active share; the old one answers 404 from then on and the access log carries over. Sends `share_renewed`; 404 without an active share |
| DELETE | `/api/conversation/:id/share` | Stop sharing: revokes every token of the conversation and deletes its access log → `{ revokedAt, revokedCount, opensDeleted }`. Sends `share_revoked`; 404 without an active share |
| GET | `/api/shares` | Every active share: `{ shares: [{ conversationId, title, archived, token, shareUrl, path, sharedSince, renewedAt, lastOpenedAt, openCount, viewerCount }], storeViewerIp, accessLog }` |
| GET | `/api/conversation/:id/share/opens` | The active share's access log, newest first: `?limit=<n>` (default 200, max 1000) → `{ opens: [{ openedAt, ip, country, userAgent, viewer }], total, limit }` |
| GET/POST | `/api/settings/shares` | `{ storeViewerIp }`: whether new access log entries (and the status events of shared reads) keep the viewer's IP address; on by default. A change sends `share_settings_changed` |
| GET | `/api/shared/:token` | (No auth) Read-only shared conversation view (hidden messages filtered out). `?open=1` marks the page's first fetch, which the access log counts as an open |
| POST | `/api/shared/:token/presence` | (No auth) Report shared-viewer presence for the watcher count |
| POST | `/api/openai/images/generate` | Generate images for an OpenAI Image conversation |
| POST | `/api/image-operations/:operationId/execute` | Execute a queued image generation/edit operation |
| GET | `/api/generated-image/:conversationId/:messageId/:imageId/content` | Stream a generated image blob |
| GET | `/api/relay/identity` | This relay's identity for paired relays: `relayId`, `name` (the PWA app name, else the hostname), `version`, `platform`, `publicUrl`, `remoteRelays.{protocol, inbound}` |
| GET | `/api/remote-relays` | Paired remote relays with their status (`relays[]`, never a token) plus `self` |
| POST | `/api/remote-relays` | Pair a relay from a pasted web address (`url`, optional `token`, `pairBack`, `selfUrl`); `{ needsToken: true }` when neither token works |
| PATCH | `/api/remote-relays/:id` | Change a paired relay's `permission` (`read` / `prompt` / `full`), URL or token |
| DELETE | `/api/remote-relays/:id` | Remove a paired relay here (the other side keeps its entry) |
| POST | `/api/remote-relays/:id/check` | Probe a paired relay now |
| POST | `/api/remote-relays/pair` | (Relay to relay) Another relay introduces itself after the user paired it there |
| GET | `/api/remote-relays/summary` | (Worker) `{ count, online, localEnabled }`: the number of paired relays, how many of them are online, and whether agent sessions are switched on. Workers register `relay_tool` when `count` is above zero or `localEnabled` is `true` |
| POST | `/api/remote-relays/tool` | (Worker) One `relay_tool` tool call: `{ conversationId, action, args }`. For a paired relay the relay checks the mention unlock, the permission, the hop limit and (ask/plan mode) the user's approval, then forwards the call to the remote. For this relay itself (named by its name or `this`; refused with `REMOTE_RELAY_LOCAL_DISABLED` while agent sessions are off) it checks instead that the call does not aim at the caller's own conversation (`REMOTE_RELAY_OWN_SESSION`) and, for `create_session`, that the caller was not created by an agent (`REMOTE_RELAY_NESTED_SESSION`), that fewer than 4 sessions it created have a turn queued or running (`REMOTE_RELAY_SESSION_LIMIT`) and that the user allowed it once for the conversation; the call then runs against this relay's own routes in-process. A `model` in `create_session` or `send` is checked first, before any approval card, against the list New Chat offers for the provider on the target (`/api/models` for Copilot and OpenAI, the provider settings routes for Claude, Cursor, Grok and Claude Cloud): one it does not list is refused with `REMOTE_RELAY_UNKNOWN_MODEL`, `suggestions` (the close matches) and `models`, and nothing is created or sent. Casing follows the list; a Claude alias (`opus`, `sonnet`, `haiku`, with an optional `[1m]`) resolves to the newest listed model of its family by version number (a date suffix ignored, the undated id first, `[1m]` ids only when the alias asks and they are listed); a `[1m]` id with only its base listed runs as the base, with a note; a Copilot id with its effort (`gpt-5.4-high`) goes to the bootstrap and the first prompt as the listed id plus `reasoningEffort` (an explicit `effort` wins, and a note says so), but only when the catalogue lists that effort for the id (`reasoningByModel`): `gpt-5.1-codex-max` with only `gpt-5.1-codex` listed is unknown, with the base suggested; `auto` passes. `send` also takes the provider's whole discovered list (`availableModels`) and the session's own model, as the message route does. Without a list (discovery has not run, the route did not answer; `auto` alone is no list) the model goes on unchecked and `modelNote` says so, as it does when the bootstrap binds another model than the one asked. A provider not set up there answers `REMOTE_RELAY_PROVIDER_UNAVAILABLE` before its model is looked at. The bootstrap route itself checks a Copilot model from an agent against Copilot's own models: an unknown one is refused (`COPILOT_MODEL_UNAVAILABLE`, with `supportedModels` and `suggestedModels`; another provider's model gets that provider's answer), a listed one is bound in the list's casing, an effort-suffixed one as the listed id plus that effort when `reasoningByModel` lists it; the browser's New Chat keeps its fallback to the current model. `wait_seconds` is cut to the `maxWaitSeconds` setting for every target |
| GET | `/api/relay-events/subscriptions` | Every active [relay event subscription](#relay-event-subscriptions) (`{ available, subscriptions }`); refused to other relays' agents |
| DELETE | `/api/relay-events/subscriptions/:id` | The user's Unsubscribe (a paired relay's subscription too: it learns with its next fetch); refused to other relays' agents |
| POST | `/api/relay-events/remote/subscribe` | (Relay to relay) A paired relay's agent subscribes to sessions here: `{ watcher: { conversationId, title }, subscriber: { name }, scope, sessions, events?, once?, match?, stalled_minutes?, heartbeat_minutes?, dry_run? }` → `{ ok, subscription }`. Another relay's request only, inbound switch on; see [Across paired relays](#across-paired-relays) |
| POST | `/api/relay-events/remote/pull` | (Relay to relay) That relay fetches its events: `{ after, subscriptions: [{ id, watcher }], ended: [ids] }` → `{ ok, events, cursor, more, subscriptions, ended, dropped }` |
| GET | `/api/relay-asks` | The [asks](#questions-that-dont-block) of this relay (`?conversationId=`: the ones in that session) → `{ available, asks, pending }`; refused to agents |
| GET | `/api/inbox` | The Inbox: `{ relays: [{ id, name, self?, url?, reachable, error?, items }], pending }` for this relay and each paired relay; refused to agents |
| POST | `/api/inbox/relays/:relayId/asks/:id/answer` | Answer a paired relay's ask from this Inbox (`{ answer, choice }`; `/dismiss` closes it); refused to agents |
| POST | `/api/relay-question/:id/dismiss` | Dismiss an ask (`ask_` ids only); refused to agents |
| POST | `/api/relay-asks/remote/ask` | (Relay to relay) A paired relay's agent asks about a session here: `{ session, question, options?, recommendation?, detail?, urgency?, asker: { conversationId, title, relayName } }` → `{ ok, ask }`. Another relay's request only, inbound switch on |
| POST | `/api/relay-asks/remote/status` | (Relay to relay) The outcome of that relay's own asks here: `{ ids }` → `{ ok, asks: [{ id, status, answer?, choice?, answeredAt?, session }] }` |
| POST | `/api/relay-asks/remote/withdraw` | (Relay to relay) That relay withdraws one of its asks: `{ id }` |
| POST | `/api/relay-asks/remote/answer` | (Relay to relay) That relay's user answers an ask of this relay from its Inbox: `{ id, answer, choice, via }` (`/dismiss`: `{ id, via }`). Asks only: any other id is not found |
| GET | `/api/relay-asks/remote/inbox` | (Relay to relay) What a paired relay's Inbox shows of this relay: `{ ok, items, pending }` |
| POST | `/api/background-task-settled` | (Worker) How a background task ended: `{ conversationId, taskId, toolUseId?, taskRunId?, status, summary?, reason?, description?, taskType?, startedAt? }` (Claude worker, from `task_notification`; the last three describe a task that was in its published set) |
| GET | `/api/remote-relays/inflight` | (Worker) Number of `relay_tool` calls running for `conversationId` |
| GET/POST | `/api/settings/remote-relays` | This relay's `publicUrl` and `inboundEnabled` (accept prompts from other relays' agents) |
| GET | `/api/settings/agent-sessions` | Agent sessions: `{ enabled, maxWaitSeconds, limits: { minWaitSeconds: 120, maxWaitSeconds: 3600, stepSeconds: 60 }, maxActiveSessions: 4 }`. `enabled` (default `false`) lets this relay's agents start and use sessions on it through `relay_tool`; `maxWaitSeconds` (default `600`) is the longest wait of one `relay_tool` call, for this relay and paired ones |
| POST | `/api/settings/agent-sessions` | `{ enabled?, maxWaitSeconds? }` → `{ ok: true, …the GET body }`, and the socket event `agent_sessions_settings_updated` with the GET body. `enabled` must be a boolean and `maxWaitSeconds` a whole number of seconds inside `limits` and on its step; anything else is `400` with `{ ok: false, error }` and nothing is stored |

### Manual relay shutdown / self-restart

- `POST /api/relay/shutdown`, `POST /api/relay/shutdown/cancel` and `POST /api/queue/empty` need the
  token and nothing else: the browser app calls them from a phone, over a tunnel and over the LAN.
- The request body accepts:
  - `reason` (optional string)
  - `requestedBy` (optional string)
  - `restart` (optional boolean-ish flag; `true` queues self-restart instead of plain shutdown)
  - `immediate` (optional boolean-ish flag; `true` does not wait for the running turns)
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
  - `waitingFor`, `held`, `backgroundTasks`, `survival`, `maxWaitMs`, `deadlineAt`, `immediate` (below)
- A conversation that subscribed to `relay_restarted` is woken when the relay runs again, with who requested it, when and why ([relay_restarted](#relay_restarted-woken-when-the-relay-runs-again)); one whose turn answered that event when the request came is not woken by it.
- The relay waits until no turn is processing before acting. While the request is queued no pending message is handed to a worker (a turn started meanwhile would postpone the restart again); pending and parked rows stay in the database and run after the restart.
- `immediate: true` (boolean-ish, like `restart`) starts it at once, running turns or not: the banner's **Restart now**. The answer still names what it did not wait for.
- Maximum wait (`services/relay-restart-queue.mjs`): after **Ask after a queued relay restart has waited** (`relay_restart_max_wait_minutes`, 30 by default, 5–240 or `0` = no limit; `OAR_RELAY_RESTART_MAX_WAIT_MS` overrides it in ms, for test relays) the request stays queued and sets `question: { askedAt }`; the relay pushes one notification (titled *Relay restart waiting*; switch **Queued relay restart waited its maximum time**, `relayRestart`) and never restarts while turns run; it still goes ahead as soon as the last turn ends, question or not. A raised maximum (or none) that moves the deadline into the future withdraws the question; `/keep-waiting` without a question does nothing (`extended: false`). An `immediate` request may name the queued request it was shown (`expectRequestedAt`, its `requestedAt`); when that request is gone the answer is `accepted: false, stale: true` and nothing starts. Agents are told never to send `immediate` (`relay-tools.md`). The user answers with `immediate`, `/keep-waiting` (another full period from now; counted in `keptWaiting`) or `/cancel`. With no limit the request, and the messages it holds, wait until the turns end or someone decides.
- What it waits for, holds and leaves running (`services/relay-restart-picture.mjs`), in the answer, in `GET /api/relay/shutdown`, in `/api/status` → `relayShutdown` and in the `relay_shutdown_state` socket event (sent on every change and on connect):
  - `waitingFor`: `[{ conversationId, title, turns }]`, the sessions with a processing turn
  - `held`: `{ count, conversations: [{ conversationId, title, count }] }`, pending and parked messages
  - `backgroundTasks`: `[{ conversationId, title, count, detail, survives, why }]`, sessions with running background work of a live worker (the task panel's sets and running sub-agent runs, through `background-work-view.mjs`), then sessions with console tasks held since the last restart (`background-task-store.mjs` `listRestored`), which no worker has confirmed yet: `survives: null`
  - `survival`: `{ action, workersSurvive, summary }`. Workers are separate processes (tmux, detached, a console window) and outlive a restart, which the relay's supervisor or the CLI extension takes, and a shutdown. Under a systemd user service (detected from `INVOCATION_ID` and a `.service` cgroup) a restart is handed to systemd and restarts the whole service; the relay starts its workers in scopes of their own (`systemd-run --user --scope`), so they survive that and a stop, and the summary adds that a worker on a tmux server or in a process started before 0.9.20 may stop once. Where the relay does not start them in scopes (systemd-run missing or without a bus, a system service, a relay that is not the unit's own) they may stop with the service (`survives: false`, shown as "may stop"). A Claude Cloud session runs at Anthropic and always survives
  - while queued also `holdsNewTurns`, `maxWaitMs`, `waitingSince` (start of the current period), `deadlineAt` (`null` without a limit), `question`, `keptWaiting`
- Ownership after an intentional restart follows the argv role, so exactly one supervisor acts on exit 75:
  - `server.js --supervised` exits 75 and relaunches under `.github/extensions/web-relay/server-lifecycle/managed-server.mjs`
  - bare `node server/server.js` keeps its supervisor attached, respawns the `--relay-runtime` child, and keeps the same terminal session alive

### Interrupted turns after a restart

`services/restart-resume-service.mjs` implements **After a relay restart, tell interrupted sessions
to carry on** (`app_settings` `restart_resume_notes`, `'1'` on, off when absent; `GET/POST
/api/settings/restart-resume` `{ enabled }`, a boolean, 400 otherwise). At boot it notes the queue
rows that are `processing` (the turns the runtime before left) and follows them through the
recovery paths, which report each outcome (`noteRestartTurnOutcome`):

| Path | `cut` (cannot run again) | `requeued` | `failed` |
| --- | --- | --- | --- |
| stale sweep (`recoverProcessingOlderThan`) | stale continuation dropped; consumed row failed | requeued | over the retry budget |
| dead worker (`recoverDeadWorkerProcessingRows`) | continuation dropped; consumed row failed | requeued | over the retry budget |
| owner heartbeat idle (`recoverOwnedProcessingRowsForSession`) | continuation dropped; consumed row failed; a started turn failed as `turn-replay-blocked` | requeued | |

A heartbeat that lists a row (`activeQueueMessageId(s)`) claims it: its worker lived through the
restart and has the turn, so whatever ends it later is not put down to the restart, and the
session gets no note. A row that leaves `processing` another way is read from the queue: back in `pending` or `parked` is
`requeued`, anything else (a reply from a worker that lived through the restart) is settled. Once
none of a conversation's rows of the boot is processing, it gets a note when one was `cut` and none
was `requeued`, `claimed` or `failed`; the stale sweep's 15 s tick decides the ones that settled on their own,
and the watch ends 30 minutes after the boot. The note is a message of the relay's (role `user`,
`kind = 'relay-restart-resume'`) with a pending queue row on the interrupted turn's model, mode and
owner, queued at the time it is written (behind a message the user queued meanwhile), as the
usage-limit follow-up is; the primer then starts the worker. No note when the setting is off at
that moment, for a deleted or archived conversation, while the conversation holds a usage-limit
follow-up, or a second time in the same runtime. The browser renders it as a compact relay row
(`relay-restart-note-view.mjs`).

### Upload storage model

- Physical blobs are stored in `<data dir>/uploads/<sha256>` (content-addressed) when
  `COPILOT_WEB_RELAY_DATA_DIR` or the config's `dataDir` chose the data dir, else in
  `server/uploads/<sha256>` (`resolveUploadDir` in `services/data-dir-resolution.mjs`).
- Blobs earlier versions left elsewhere are read in place: `server/uploads` (a config
  `dataDir` did not move uploads before 0.9.14) and `uploads/` in the folder that holds the
  data dir (state migrations before 0.9.14 copied a checkout's uploads there).
  `resolveUploadReadDirs` lists them after the upload dir; a blob is read from the first
  copy whose size is the recorded one (two of that size that are not alike, i.e. differ in
  their first or last 64 KiB: the one whose content hashes to its name, decided once per blob). New uploads are written to the upload dir only, and
  the unreferenced-upload sweep and a cache wipe delete only there.
- Metadata (`original_name`, `mime_type`, `size_bytes`) is stored in SQLite.
- Message/conversation references are tracked in SQLite; when a conversation is deleted,
  unreferenced blobs are garbage-collected from disk automatically.
- Image attachments are forwarded to the Copilot SDK as multimodal attachments
  (`file` when a disk path is available, otherwise inline `blob`).
- Non-image uploads continue to be exposed as file references.
- `POST /api/upload` sniffs the payload's magic bytes and reconciles them against the
  client-supplied `X-File-Type` header. The detected type wins on disagreement, so a
  disguised executable is stored as what it actually is. Unrecognised bytes (plain text,
  CSV, source files) keep the claimed type. The response reports `mimeTypeCorrected`.

### Composer attachments: paste, drag-and-drop and eager upload

- Files reach the composer through three paths, all sharing one ingestion function:
  the 📎 picker, `Ctrl+V` paste, and drag-and-drop onto the input area.
- **Paste attaches, it never sends.** When the clipboard holds both an image and text,
  the image wins and the text is discarded. When it holds only text, the handler does
  nothing so the browser's native paste is untouched.
- Clipboard bitmaps arrive unnamed (or as a generic `image.png`) and are renamed
  `pasted-<ISO-timestamp>.<ext>`.
- Images over ~2 MB are downscaled client-side to a 2560 px longest edge and re-encoded
  to **JPEG** before upload. GIF and SVG are never re-encoded, and a re-encode that fails,
  grows the file, or yields anything other than JPEG/PNG falls back to the original bytes.
- The output format is deliberately restricted to JPEG/PNG (`image-downscale.mjs`): Copilot's
  image-input docs call these "the most widely supported formats". The composer converts for
  every provider alike, although the Claude workers, local and cloud, would take a WebP as it is
  (`claude-attachments.mjs` inlines JPEG, PNG, GIF and WebP).
- Re-encoding therefore has two triggers, tracked by `reencodeReason()`:
  - `'size'` — the image is over the byte threshold. Abandoned if the result is no smaller.
  - `'format'` — the source is not PNG/JPEG/GIF (e.g. WebP, AVIF, HEIC), so it is converted
    at its original dimensions **regardless of size**, and kept even if the result is larger:
    a bigger image the model can read beats a smaller one it cannot.
- Without the `'format'` trigger a WebP small enough to skip the size threshold would reach
  the model in a format outside that pair. An image that does not come through the composer
  (`POST /api/upload` from a script) is stored as it is.
- Attachments upload **eagerly** on selection rather than on Send. Chips show an
  uploading spinner, and a failed upload becomes a clickable retry.
- Send is disabled while any upload is in flight. Failed uploads are deliberately not
  counted as in-flight, so a failure can never wedge the button.
- Exceeding the 6-attachment cap keeps the first 6 and reports the overflow in a toast
  (previously the overflow was dropped silently).
- Shared read-only viewers cannot paste or drop.

### Composer attachment cache

- Pending attachments persist **per conversation**, mirroring how text drafts already work.
  Switching conversations and returning restores them, as does reloading the page.
- Storage is `conversations.draft_attachments`: a JSON array of `{sha256, name, type, size}`.
  Only already-uploaded attachments are persisted — never file bytes.
- `PATCH /api/conversation/:id/draft` accepts an optional `draftAttachments` array.
  Omitting the field leaves the stored attachments untouched; passing `null` or `[]` clears
  them. Every entry must reference a blob the server already holds, otherwise the request
  is rejected with a 400.
- Removing an attachment is expressed as a draft save carrying the remaining list, so it is
  ordered against in-flight draft writes rather than racing them. The server diffs the list
  and releases the reference itself; there is deliberately no delete-by-hash endpoint, since
  blobs are content-addressed and shared, and such a route would let one caller destroy
  another conversation's freshly uploaded blob.
- Draft blobs are kept alive by an `upload_refs` row using the sentinel
  `message_id = '__draft__'`. On send, the real message reference is inserted and the
  sentinel row is dropped. Reference release only reclaims blobs whose sentinel row this
  conversation actually held.
- Conversation deletion needs no special handling: the existing foreign-key cascade and
  orphan sweep already collect draft blobs.
- Because uploads are eager, a blob can exist before anything references it (pasting into a
  conversation that is then abandoned, or switching conversations mid-upload). A sweep runs
  at startup and every 6 hours to reclaim unreferenced blobs older than 24 hours; the age
  floor guarantees an in-flight upload is never collected.
- Attachments added before a conversation exists stay in the composer (already uploaded) and
  are adopted by the conversation created on first send.

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
- Use `/api/session-root/list?path=<sessionRootPath>&includeHidden=0|1` for the explorer's Session root. Child directories below it lazy-load through `/api/drives/list` as usual. The Claude Agent SDK creates a session's directory lazily — only once the session writes `subagents/` or `tool-results/` files — so the root is served as an empty folder until then rather than 404ing, and the transcript that lives one level up in the project directory is listed as a child of it. Cursor sessions resolve their Session root the same lazy way: the worker's per-session agent store (`$CURSOR_AGENT_STORE_DIR` or `cursor-agents/<sdkSessionId>` in the relay's data dir) exists only after the session's first turn, and the Session button stays disabled until it does.
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

`GET /api/git/remote?root=…` belongs to the New Chat modal, not to this one: it reads the `origin`
remote (else the remote of the upstream branch), the current branch, ahead/behind and whether the
checkout is dirty, for the Repository and Branch fields of a Claude Cloud chat
(`services/git-remote-service.mjs`). There is no conversation yet at that point, so it is the one
git route that takes a path from the client, validated like a requested CWD
(`validateRequestedWorkspaceRoot`). Credentials in a remote URL are dropped before it is returned,
and a remote that is not a github.com repository comes back with `repoUrl: null`.

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

The CLI extension (`.github/extensions/web-relay/extension.mjs`) and the Copilot SDK worker
(`copilot-worker/copilot-prompt-context.mjs`) load `relay-tools.md` (`COPILOT_WEB_RELAY_TOOLS`
overrides the path) for shared tool guidance.

How to embed media in a reply (a markdown image naming the file's absolute host path; the page
renders images and turns video and audio into players) is one text,
`shared/media-embed-instructions.mjs`. The Claude worker appends it to the system prompt, the
Copilot SDK worker to its relay guidance, the Cursor and Grok workers put it in front of the first
prompt each worker process sends. The
Copilot extension engine's prompt builder (`shared/worker-runtime/prompt-context.mjs`) does not add
it and `relay-tools.md` does not contain it, and a Claude Cloud session gets no relay guidance at
all, so those two are not told.

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
  },
  "cloudflaredTunnel": {
    "mode": "disabled",
    "required": false,
    "token": "",
    "binary": "",
    "extraArgs": []
  }
}
```

| Key | Default | Description |
|---|---|---|
| `authToken` | generated if empty | Token for all API / UI access. Empty or missing: a random token on every start, printed to the log and not saved (`--token <value>` sets one for the run) |
| `port` | `3333` | HTTP/WebSocket listen port (`--port <n>` for the run) |
| `localhostOnly` | `true` | Bind only to loopback (`127.0.0.1`) and block LAN/WAN access |
| `host` | `127.0.0.1` | Read by the workers only: the address they connect to the relay on (`0.0.0.0`, `::` and `localhost` mean `127.0.0.1`) |
| `dataDir` | `data/` beside the server | Database, the relay's lock file, uploads (`uploads/` inside it) and Cursor agent stores (`cursor-agents`); relative to the config file's folder; `COPILOT_WEB_RELAY_DATA_DIR` wins. Without either, a checkout keeps its uploads in `server/uploads`; uploads made there before `dataDir` was set stay there and are still read |
| `pollIntervalMs` | — | Read by nothing; new config files still get `3000` |
| `processingTimeoutMs` | `600000` | Worker-inactivity window before a turn is treated as stale (ms) — see [Turn recovery](#turn-recovery-and-the-max-turn-duration) |
| `maxRequeueRetries` | `5` | Retries of a recovered queue row before it fails |
| `conversationSessionMode` | `isolated` | `isolated` or `shared`; recorded as `runtime_sessions.strategy` and reported in `/api/status`, with no effect on behaviour |
| `contextIndicatorMode` | `default` | Composer context indicator: `default`, a line across the composer's top edge whose colour runs from green to red as the context fills, or `bar`, a line as long as the share in use; anything else is `default`. Sent to the page in `/api/status` |
| `remotePath` | `""` | URL path prefix when the relay is served under a subpath (PWA URLs, socket.io path) |
| `trustProxy` | `"loopback"` | Express `trust proxy`: which proxies may set `X-Forwarded-*` |
| `workspaceRootAllowList` | unset | Folders conversations may start in; see [Changing the launch CWD](#changing-the-launch-cwd) |
| `publicHostnames` | `[]` | The relay's own public hostnames; the preview lane refuses them |
| `previews.enabled`, `.port`, `.bindHost`, `.allowPublicBind`, `.publicBaseUrl`, `.allowedTargetHosts`, `.maxLive` | `false`, `port + 1`, `127.0.0.1`, `false`, —, `[]`, `8` | The preview listener (`services/preview-registry-service.mjs`, [docs/preview-servers.md](../docs/preview-servers.md)) |
| `pushVapidSubject` | `mailto:copilot-remote@example.com` | Contact URI sent to push services |
| `sharedPresenceMaxPerConversation`, `sharedPresenceMaxGlobal` | `200`, `5000` | Caps of the shared-view watcher count |
| `cliBinaries` | *(written by the relay)* | Provider CLI paths resolved by an install from Settings, applied at startup |
| `cliPort` | `4445` | Port of the standalone `relay.mjs`; the preview lane refuses it |
| `features` | — | Legacy: moved into the database once at startup, then the **Features** tab |
| `sdkVersion` | *(latest detected)* | Optional semver pin (for example `1.0.63`) used by relay SDK auto-detection |
| `sdkPath` | *(auto-detected)* | Optional absolute override for Copilot SDK entry path (`.../copilot-sdk/index.js`) |
| `cliPath` | *(auto-detected)* | Optional absolute override for Copilot CLI app path (`.../app.js`) |
| `restartGracefulTimeoutMs` | `8000` | Graceful shutdown wait before force fallback |
| `restartReadyCooldownMs` | `1000` | How long the worker restart orchestrator still holds dequeue after a restart transaction is ready |
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
| `cloudflaredTunnel.mode` | `disabled` | Cloudflare tunnel mode (`disabled` or `managed`) |
| `cloudflaredTunnel.enabled` | `false` | Legacy alias for mode (`true` => `managed`) |
| `cloudflaredTunnel.required` | `false` | Pause dequeue when the Cloudflare tunnel is disconnected in managed mode |
| `cloudflaredTunnel.token` | — | Tunnel token from the router panel (never logged) |
| `cloudflaredTunnel.binary` | `cloudflared` | Path or command name of the `cloudflared` you installed (OAR ships none); defaults to `cloudflared` on `PATH`. Without one the tunnel stays off and the status says how to install it |
| `cloudflaredTunnel.extraArgs` | `[]` | Extra arguments appended to `cloudflared tunnel run` |
| `tunnelMarkerHeaders` | `[]` | Extra edge-injected header names that mark tunnel traffic; merged with `COPILOT_TUNNEL_MARKER_HEADERS` and `cf-ray` (an empty list does not switch the env value off). A request carrying one is never "from this machine" (session-worker path guard, image-operation run, sign-in lockout exemption) |
| `allowedOrigins` | `[]` | Extra browser origins the Socket.IO channel accepts besides the relay's own origin |

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

There is no migration runner and no record of applied migrations. At every start
`applySchema(db)` (`server/db-schema.mjs`, the same code the tests build their databases with) runs
`SCHEMA_SQL` (`CREATE TABLE IF NOT EXISTS` for a fresh database), then the upgrade sequence:
guarded `ALTER TABLE … ADD COLUMN` statements (each runs only when `PRAGMA table_info` lacks the
column) and, among them, the functions of `server/migrations/0002-…` to `0022-…` in order. Each of those checks the
schema itself and does nothing when its change is already there, so all of them run on every boot.
From 0004 on a failure is logged (`migration 00NN failed; retrying on next boot`) and the boot goes
on. Every file can also be run by hand against a database: `node server/migrations/<file>.mjs
[path/to/oar.db]`; without a path it takes the database in `server/data` (`oar.db`, else the name of
installs from before 0.9.20) and never creates one (`cliDbPath`). `0001-add-structured-answer.mjs` (the `structured_answer` and
`request_schema` columns of `relay_questions`, see [Structured Answers and Multi-Field
Elicitation](#structured-answers-and-multi-field-elicitation)) is only such a script: the boot adds
those columns with its own guarded `ALTER TABLE`.

**In-place column additions:**

Some columns are added directly at startup with guarded `ALTER TABLE` statements rather than
migration files. Recent additions on `runtime_sessions`:

- `claude_native_session_id` (TEXT) — native Claude Agent SDK session id, replayed as `resume`
- `context_usage_json` (TEXT/JSON) — latest context-window breakdown reported by a Claude worker
- `context_usage_captured_at` (TEXT) — when that breakdown was captured

and on `messages`:

- `hidden_from_shares` / `share_hidden_at` — per-message share visibility (see
  [Conversation sharing](#conversation-sharing-and-per-message-visibility))

`0005-remote-relays.mjs` adds `origin_json` to `messages` and `conversations` (provenance of
prompts and sessions another relay's agent created) and the table
`conversation_remote_relay_unlocks` (the remote relays the user mentioned per conversation).
Agent sessions reuse both without a migration of their own: a conversation an agent of this relay
created stores an origin with `local: true` that names the conversation it was created from, and
the user's **Allow** for a conversation's agent to start sessions here is a row of that table
under the relay id `self` (`remote-relay-repository.mjs`).

`0011-relay-event-subscriptions.mjs` adds `relay_event_subscriptions` (what each watcher asked for,
kept after it ended with `ended_at` / `end_reason`, for a week) and `relay_events` (events per watcher, with
`delivered_at` and the message they went into, kept for two hours once delivered). See
[Relay event subscriptions](#relay-event-subscriptions).

`0012-cross-relay-event-subscriptions.mjs` adds the columns both sides of a subscription across
relays need (on the watching relay `remote_subscription_id`, `remote_meta_json`, `remote_sync`; on
the watched one `subscriber_relay_id`, `subscriber_relay_name`, `subscriber_watcher_id`,
`subscriber_watcher_title`, `last_pull_at`, `dropped_count`) and `relay_event_links` (per paired
relay the fetch cursor and the link's health). See [Across paired relays](#across-paired-relays).

`0017-conversation-history-indexes.mjs` adds two indexes and nothing else:
`queue(response_message_id)` for the sub-agent records of each reply on a history page, and
`messages(conversation_id, timestamp, id)` for selecting the page itself. `GET
/api/conversation/:id` and the shared view select the requested page in SQL in conversation order
(timestamp, then id) and hydrate only its replies, so a page costs the same in a conversation of
any length. A conversation with a row whose timestamp is not the relay's ISO form
(`YYYY-MM-DDTHH:MM:SS.mmmZ`) or whose id is not lowercase letters, digits and dashes is paged the
old way: every row loaded, the page cut afterwards.

`0018-background-task-rows.mjs` adds `background_task_rows` (`store_key`, `task_id`, `state`
`live` | `ended`, `row_json`, `ended_at`, `updated_at`; one row per key and task): the task
console's rows across a relay restart (see
[Background tasks and workflow progress](#background-tasks-and-workflow-progress)). Additive and
idempotent; a failure is logged and retried on the next boot, and the store keeps its rows in
memory meanwhile. An older build ignores the table.

`0020-conversation-may-create-sessions.mjs` adds `conversations.may_create_sessions` (INTEGER, 1 =
allowed): the owner's "Agents in this conversation may start sessions" for a session an agent
started, which lifts the relay_tool's one-level rule for it. Only the preferences route
writes it, and only for the owner (a request of an agent or a paired relay is refused). Without the
column the switch cannot be turned on and the rule holds everywhere; an older build ignores it.

`0035-conversation-plan-only.mjs` adds `conversations.plan_only` (NULL or 0 = not plan-only): the
lock of a [plan-only session](#relay-mode-selection), which agents can't take out of plan mode.

`0021-conversation-group-agent-marks.mjs` adds two columns to `conversation_groups` for what an
agent's update_session may do to a group: `agent_made` (1 for a group it made by name, which goes
once empty) and `kept_empty_at` (set when an agent took the last member out of a group the owner
made: the group stays, the boot repair and the sweep leave it alone, the conversation list's first
page names it so the sidebar shows it as an empty group the owner can rename or dissolve, agents can
name it again, and the mark goes when a member joins). The group an agent's create_session forms
around its creator counts as agent-made too. The owner's own moves still remove an empty group. An older
build ignores both columns.
`0022-relay-schedules.mjs` adds `relay_schedules` (`id`, `conversation_id`,
`created_by_conversation_id`, `title`, `text`, `at`, `every_minutes`, `once`, `next_fire_at`,
`last_fired_at`, `fired_count`, `skipped_count`, `last_message_id`, `created_at`, `ended_at`,
`end_reason`, `origin_json`, `held_since`; a repeating row must have its interval; a table of
the first form gets the last two by `ALTER`) and three indexes: see
[Relay schedules](#relay-schedules). Additive and idempotent; a failure is logged and retried on
the next boot, and the schedule actions answer that schedules are not available meanwhile. An
older build ignores the table.
`0023-relay-asks.mjs` adds `relay_asks` (`id`, `relay_id` ('self', or a pairing id for a
mirror, which then needs `remote_id`), `remote_id`, `conversation_id`, `conversation_title`,
`created_by`, `creator_json`, `question`, `options_json`, `recommendation`, `detail`, `urgency`
(`normal` | `now`), `status` (`pending`, `answered`, `dismissed`, `withdrawn`, `cancelled`),
`answer`, `choice`, `answered_at`, `answered_via`, `notified_at`, `created_at`, `updated_at`) and
four indexes (one unique on `relay_id`, `remote_id`): see
[Questions that don't block](#questions-that-dont-block). Additive and idempotent; a failure is
logged and retried on the next boot, and the ask actions answer that they are not available
meanwhile. An older build ignores the table.
`0024-deepseek-usage-totals.mjs` adds `deepseek_usage_totals` (`model` as the key, `hit_tokens`,
`miss_tokens`, `output_tokens`, `turn_count`, `cost_usd` and `cost_cny` (NULL while no turn of the
model could be priced), `first_seen_at`, `last_seen_at`, `updated_at`): what
`POST /api/deepseek-plan-usage` adds up for the DeepSeek card; and `deepseek_usage_checkpoints`
(`conversation_id`, `native_session_id`, `model` as the key, `hit_tokens`, `miss_tokens`,
`output_tokens`, `updated_at`): the totals a CLI session last reported, which a report is
diffed against. Additive and idempotent; the plan usage service creates the tables too, so a
failed boot run is logged and retried on the next boot. An older build ignores both tables.
`0025-deepseek-usage-requests-daily.mjs` adds to `deepseek_usage_totals` the columns
`search_requests`, `fetch_requests` (Claude Code's web searches and fetches on DeepSeek's Search
API), `tools_cost_usd` and `tools_cost_cny` (their cost, 0 before 2026-10-31 16:00 UTC); the table
`deepseek_usage_days` (`day` in UTC and `model` as the key, then the same token, request, turn and
cost columns as the totals): the sums per day the DeepSeek card's daily chart and monthly budget
read, booked in the same transaction as the totals; and `deepseek_balance_reference` (`currency`
as the key, `reference_total`, `last_total`, `reference_at`, `updated_at`): the balance after the
latest top-up, which the card's balance meter measures against. Additive and idempotent, handled
like 0024. An older build ignores the columns and tables.
`0026-deepseek-usage-served-models.mjs` folds rows of `deepseek_usage_totals`, `deepseek_usage_days`
and `deepseek_usage_checkpoints` booked under a Claude model name (`claude-opus*`, which DeepSeek's
Anthropic-compatible endpoint serves with `deepseek-v4-pro`; `claude-sonnet*` and `claude-haiku*`,
served with `deepseek-flash`) into the DeepSeek model's row: tokens, requests and turns are summed,
the folded tokens priced at the DeepSeek model's price for the row's last turn time (`last_seen_at`,
or `updated_at` of a daily row), and the Claude-named row deleted. A session's Claude-named and
DeepSeek-named checkpoints add up to what its worker reports once it names the DeepSeek model.
Idempotent, handled like 0024; the plan usage service runs it too when it opens a database. The folded
tokens and requests are priced at one time, the row's last: a row that spans peak and off-peak turns
is approximated (at most 2× off on the token part).
`0027-deepseek-usage-checkpoint-runs.mjs` adds to `deepseek_usage_checkpoints` the columns `run_id`
(the worker's id of the Claude Code process the totals came from, '' for an older worker's report),
`search_requests` and `fetch_requests` (that process's running counts of web searches and fetches):
a report below the checkpoint under the same run id is stale and books nothing, under another run id
it is a process counting from zero, booked in full; before, every drop was booked in full, so a pair
of reports delivered out of order booked the earlier turns twice. Additive and idempotent, handled
like 0024. An older build ignores the columns.
`0028-deepseek-usage-checkpoint-request-runs.mjs` adds to `deepseek_usage_checkpoints` the column
`request_run_id`: the run id of the checkpoint's search and fetch counts, kept apart from `run_id`,
the run id of its token totals. With 0027 one run id served both, so a report that carried only
counts for a model (a sub-agent's model that searched without a token entry of its own) moved the
run id of that model's token totals too, and a later token report of the earlier process was read as
a new process and booked in full instead of as a stale one. Additive and idempotent, handled like
0024 (it applies 0027 first on a database that skipped it). An older build ignores the column.
`0029-deepseek-balance-rises.mjs` adds to `deepseek_balance_reference` the columns `rose_at` (when
a read last found the balance above the read before it: a top-up or a grant; NULL while no rise was
seen), `last_read_at` (when `last_total` was read) and `rose_from_at` (when the balance before that
rise was read): a starting balance set on the DeepSeek tab counts until the balance rises after it
was set. Additive and idempotent; a failure is logged and retried on the next boot (it applies 0025
first on a database that skipped it). An older build ignores the columns.
`0030-deepseek-usage-actuals.mjs` adds `deepseek_usage_actuals` (`day`, `period_start`,
`period_end`, `model`, `key_fp` (the key masked), `key_name`, `hit_tokens`, `miss_tokens`,
`output_tokens`, `request_count`, `cost`, `currency`, `imported_at`): one row per export day, model
and API key, imported from the two CSV files of DeepSeek's usage export
(`services/deepseek-usage-import.mjs`). The DeepSeek card shows them instead of the relay's estimate
for the days and models they cover; the relay's own usage tables are not touched. Additive and
idempotent; a failure is logged and retried on the next boot, and the import runs it too. An older
build ignores the table.
`0031-queue-provider.mjs` adds `queue.provider`: the billing a row runs on, `claude` or
`claude-api` for a Claude chat (see [Billing switch](#billing-switch)). Two triggers keep it without
every writer knowing it: `queue_provider_after_insert` gives a row inserted without one its chat's
provider when the chat is a Claude or Claude API one (a writer that names one keeps it), and
`queue_provider_after_requeue` gives a row going back from `processing` to `pending` or `parked` the
chat's provider of that moment. The back-fill stamps the unfinished rows of Claude and Claude API
chats; finished rows and other providers' rows stay NULL, which means the chat's billing. Additive
and idempotent; a failure is logged and retried on the next boot. An older build ignores the column,
and the triggers still stamp its rows.
`0032-runtime-session-billing-switch.mjs` adds to `runtime_sessions` the columns
`billing_switched_at` (when the chat last moved between the subscription and the key; NULL for a
chat that never did) and `billing_switched_by` (`user`, `agent` or `usage-limit`). On a switched
chat a worker that reports no kind cannot be read from `provider_type`, so the relay replaces it
once, when it is idle. Additive and idempotent, handled like 0031. An older build ignores the
columns.
`0033-claude-api-usage-checkpoints.mjs` adds `claude_api_usage_checkpoints` (`conversation_id`,
`native_session_id`, `run_id`, `model` as the key, then `billing`, `run_hit_tokens`,
`run_miss_tokens`, `run_output_tokens`, `run_cost_usd`, `session_hit_tokens`,
`session_miss_tokens`, `session_output_tokens`, `session_cost_usd`, `cost_unknown`, `last_turn_id`,
`last_turn_at`, `updated_at`) and the index `idx_claude_api_usage_checkpoints_mark` on
(`native_session_id`, `last_turn_at`): what each Claude Code process of a session last reported, as
far as it was booked, and the session's mark (the row with the latest `last_turn_at`), which a
resumed run's first result is measured against. Both Claude workers' reports write it; see
[Usage and the monthly cap](#usage-and-the-monthly-cap). Additive and idempotent; a failure is
logged and retried on the next boot, and `services/claude-api-usage-service.mjs` runs it too before
it prepares its statements. An older build ignores the table.
`0034-claude-api-usage-totals.mjs` adds `claude_api_usage_totals` (`day`, the relay's local date,
and `model`, lower case without `[1m]`, as the key, then `hit_tokens`, `miss_tokens`,
`output_tokens`, `cost_usd` (Claude Code's own estimate, for the turns it could price),
`unknown_cost_tokens`, `turn_count`, `first_seen_at`, `last_seen_at`, `updated_at`): what turns on
the saved Claude API key ran, which the Claude API card and the monthly cap read. Subscription
turns are never booked here. Additive and idempotent, handled like 0033. An older build ignores the
table.
`0036-token-usage.mjs` adds `turn_token_usage` and `token_usage_days` (see [Token
usage](#token-usage-all-providers)) and, in the same transaction, copies the days the relay already
has: `claude_api_usage_totals` (relay-local days) as provider `claude-api` and `deepseek_usage_days`
(UTC days, kept as they are) as `deepseek`, both with `source = 'backfill'`, `miss_tokens` as
`input_tokens` (cache writes included), `hit_tokens` as `cache_read_tokens`, `cache_write_tokens`
NULL, the dollar cost (DeepSeek's token estimate, not its tools), the unpriced tokens and the turns.
Model ids are normalised (lower case, no `[1m]`) and rows that meet are summed; DeepSeek's days keep
no seen times, so the day's bounds stand in. Both tables existing means it ran: the copy is a
snapshot of the first 0.9.20 boot and never runs again. A missing source table (its migration failed
on this boot) throws, so nothing is created; the failure is logged (`[token-usage] migration 0036
failed; retrying on next boot`) and the next boot runs it again, and the token usage service retries
it too. An older build ignores both tables; turns that run on it are not counted.

`0007-claude-cloud.mjs` adds the storage of [Claude Cloud](#claude-cloud-provider) conversations.
It is additive and idempotent, runs on every boot, and a failure is logged and retried on the next
one:

- `runtime_sessions.claude_cloud_session_id` (TEXT) — the cloud session the conversation runs in,
  reported by its worker after the first message
- `runtime_sessions.claude_cloud_last_sequence` (TEXT) — the event sequence number of the last
  finished turn's `result`: where a restarted worker reads the session's event log on from
- `runtime_sessions.claude_cloud_cost_usd` (REAL) — what the session has cost so far, as the cloud
  reports it
- `conversations.cloud_source_json` (TEXT/JSON) — `{ repoUrl, branch, environmentId, sessionUrl,
  pushedBranches: [{ branch, at }] }`

Older tables are created at startup with `CREATE TABLE IF NOT EXISTS` in `SCHEMA_SQL` (`db-schema.mjs`),
for example `workflow_runs` (final workflow digest per assistant message,
keyed on `response_message_id`, cascade-deleted with the conversation; see
[Background tasks and workflow progress](#background-tasks-and-workflow-progress)); newer ones, such as
`background_task_rows`, come from a migration only (see below).

Statements that depend on these columns are prepared conditionally, so an older database keeps
working with the corresponding feature inert rather than crashing at startup.

**Adding a migration:**

1. Create `server/migrations/00NN-description.mjs` with the next number, exporting a synchronous
   `migrateSomething(db)` that checks the schema (`sqlite_master`, `PRAGMA table_info`) and changes
   only what is missing, plus a `migrate(dbPath)` and an `isMain` block for running it by hand
   (`0018-background-task-rows.mjs` is a small example).
2. Call it from `applySchema` after the previous one, inside `try`/`catch` with a
   `migration 00NN failed; retrying on next boot` warning. It runs on a fresh database too, so
   what it creates needs no entry in `SCHEMA_SQL`.
3. Prepare statements that need the change conditionally, so a database the migration has not
   reached keeps the feature inert instead of failing at startup.

## Files

| File | Description |
|------|-------------|
| `server.js` | Main server |
| `public/index.html` | Web chat UI |
| `config.json` | Auth token and settings (gitignored) |
| `data/oar.db` | Persisted conversations, settings, and queue storage (gitignored); `data/copilot.db` on installs from before 0.9.20 (`services/database-file.mjs` resolves which) |
| `data/db-backups.json` | The database backups this relay wrote (`services/db-backup-service.mjs`): only those are ever rotated; a `.partial` of a writer that died is named there with its pid |
| `data/db-backup-progress.json` | While a backup is written, with the writer's pid and identity: `oar start` says "backing up", `oar backup` refuses, a start waits; one a killed writer left is removed at the next start |
| `data/db-backup-wait.json` | While a start waits for an `oar backup` of the same database (and during its own copy beside it), with the relay's pid: `oar start` leaves the relay running |
| `backups/` | A checkout's database backups, `oar-<version>-<time>-<reason>.db` (gitignored, not packed; a global install keeps them in the state root's `backups/`) |
| `relay-tools.md` | Markdown tool guidance loaded by the relay extension |
| `claude-worker/` | Claude Agent SDK session worker (turn runner, ask-user bridge, attachments, SDK message normalizer) |
| `claude-cloud-worker/` | Claude Cloud session worker (turn runner over the cloud session's event stream, event normalizer) |
| `../shared/claude-cloud/` | Claude Cloud API client, the reader of the Claude CLI's login, repository/branch/model string rules |
| `services/claude-cloud-settings-service.mjs` | Claude Cloud switch, default model and environment |
| `services/claude-cloud-session-service.mjs` | What the relay keeps per cloud conversation: worker reports, the `cloud` payload field, archiving |
| `services/claude-account-usage-service.mjs` | Live Claude account usage for Check Usage (only while Claude Cloud is on) |
| `claude-api-worker/` | Claude API session worker: the Claude worker with a backend that runs Claude Code on the saved Claude API key |
| `../shared/anthropic-api.mjs` | The Claude API key's model discovery (`GET /v1/models`) |
| `services/claude-api-settings-service.mjs` | Claude API key, switch, models and monthly cap |
| `services/claude-api-usage-service.mjs` | Books the Claude workers' usage reports (checkpoints, the mark, daily totals) |
| `services/plan-usage-claude-api.mjs` | The Claude API card in Check Usage and the monthly cap |
| `services/claude-billing-switch-service.mjs` | Moves a Claude chat between the subscription and the key |
| `services/claude-billing-swap-service.mjs` | Replaces a switched chat's worker between turns |
| `services/worker-secret-redaction.mjs` | Takes the saved provider keys out of every worker post |
| `services/git-remote-service.mjs` | GitHub remote and branch of a folder, for the New Chat modal |
| `services/relay-event-service.mjs` | Relay event subscriptions: subscribe / transfer, recording, coalescing, the hourly cap and digest, delivery into the watcher's conversation, stalled / all_idle / heartbeat sweeps |
| `services/session-activity-tracker.mjs` | What each session is doing: `state`, tasks, task edges and the activity clock |
| `../shared/relay-events.mjs` | Relay event types, limits and the text of an event message |
| `services/remote-relay-loopback.mjs` | The `relay_tool` client for this relay itself (agent sessions): hands the dispatcher's requests to the relay's own HTTP handler in-process instead of opening a connection |
| `services/claude-session-root-service.mjs` | Resolves the browsable session folder for Claude conversations |
| `services/context-usage-view.mjs` | Normalizes Copilot and Claude context data into one payload |
| `services/cloudflared-tunnel-service.mjs` | Supervises the `cloudflared` child process for the Cloudflare Tunnel mode |
| `services/tunnel-worker-path-guard.mjs` | Rejects session-worker WebSocket paths that arrive through a public tunnel |
| `../shared/turn-ceiling.mjs` | Shared bounds/formatting for the max turn duration setting |
