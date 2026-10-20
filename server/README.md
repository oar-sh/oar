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
  worker; other non-zero exits are retried 3 times before the supervisor gives up.
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
  default as before (`none`, which for Claude, Cursor and Grok means the
  model's default). A Claude Cloud conversation always runs with `none`: the
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
  ends it. Spawns carry `timelineOwner: 'worker'`.
- **Copilot and Cursor** publish their sub-agents on the live lanes only (`/api/activity`,
  `/api/thought`, `/api/stream` with a `subagentRunId`); the relay copies each frame into the run's
  timeline, uncut. Fields they do not report (model, tokens) stay blank.
- `POST /api/background-tasks` copies model, type, task id and tokens onto the run whose id is the
  task's `toolUseId`, so the row keeps them after the in-memory task set is cleared.
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
`SUBAGENT RETENTION …` line. No VACUUM: SQLite reuses the freed pages.

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

`remote_relay`'s `usage {relay}` (permission `read`, like `relay_info`; this relay too, as `this`)
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
variable is one of `WORKER_SECRET_ENV_VARS`, restricted to the `claude-cloud` worker kind
(`workerSecretEnvVarsFor`), so under tmux it reaches a cloud worker through the owner-only secret
env file, never as an `export` and never in the environment tmux is started with, and no other
worker kind gets it that way. `redact()` takes the token out of every error text.

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

`POST /api/message` accepts another model of the list until the first message has created the
cloud session, and stores it on the runtime session; after that a different model is `409
CLAUDE_CLOUD_MODEL_REQUIRES_NEW_CONVERSATION`. The worker, however, creates the session with the
model it was launched with: `resolveModel` prefers `CLAUDE_CLOUD_RELAY_MODEL` over the delivered
`providerModel`, so a change made after the worker started only takes effect if the worker is
launched again before the first message. Reasoning effort is always `none` and the context tier
always `default`, whatever the request says.

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

## Relay event subscriptions

A session (the **watcher**) can ask to be told what happens in other sessions of this relay or of a
paired relay, through `remote_relay`. The relay tells it by writing a short event message into the
watcher's conversation; nothing reads transcripts on disk, and it works for every provider.

**Actions** (`relay` may be left out and means `this`; on this relay the agent-sessions setting must
be on, as for every local action; a paired relay: see [Across paired relays](#across-paired-relays)):

- `subscribe {sessions: [ids] | ["all"], events?, once?, match?, stalled_minutes?, heartbeat_minutes?}`
  — `all` watches every session, ones created later too. The watcher's own conversation is never
  watched. The first subscribe of a conversation shows the user an approval card naming the
  sessions; a subscription to `all` is always named on a card (asked again after an Allow that did
  not cover it). The Allow is remembered as unlock rows `self:watch` / `self:watch-all`.
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
(nothing runs in the watched set any more). `task_started` only when named in `events`.
`subagent_finished` is no event of its own but a narrower `task_finished` a subscription can name
(`RELAY_EVENT_SUBSCRIBABLE_TYPES`): the end of a task that is not a shell command, delivered as a
`task_finished` line. The default (`events` left out) is every type but `task_started` and
`task_finished`, with `subagent_finished`: a shell command that ended well wakes only a watcher
that names `task_finished`, which takes every task end. A busy worker ends a shell command every
minute or so, and each was a wake-up, a model turn on the watcher's whole context. A subscription
whose stored list is exactly the old default (every type but `task_started`, in any order) named no
events and is read as the new default (`effectiveRelayEventTypes`, at read time, the row is never
rewritten, so an older relay reading the same database sees what it stored); any other list,
including the old default plus more, is the watcher's choice and stays. A subscribe that names
exactly the old default list stores `subagent_finished` with it, so it is never read as the default. A mirror shows the paired
relay's list as that relay returned it. With
`heartbeat_minutes` a `heartbeat` event comes at that interval while the watched set has work
running, none while it is idle. `match` (a case-insensitive regular expression) filters `turn_end`
and task events by their text; other events pass. `once` ends a subscription after its first event,
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

### Across paired relays

The watching relay (**A**, it holds the watcher) and the watched one (**B**) each keep a row of the
subscription. Only A calls, over its pairing: a pairing in one direction is enough.

- **Gate.** The four actions with `relay: <paired relay>` pass the same checks as any `remote_relay`
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
(`description`, `taskType`, `startedAt`). `all_idle` waits out the first 45 seconds after a relay
start, like the suspend check.

`GET /api/conversations` and `GET /api/conversation/:id` carry `sessionState` (`running_turn`: a
turn processing, or queued and not held by a usage-limit pause; `background_only`: tasks running;
`idle`), `sessionTasks` (running tasks, then up to five that ended within the hour: `kind`
`subagent` | `shell`, `description`, `startedAt`, `lastActivityAt`, `status` `running` |
`completed` | `failed` | `stopped`, `exitCode`, `summary`, `endedAt`) and `lastActivityAt`.
`remote_relay`'s `list_sessions` and `read_session` pass them on as `state`, `tasks` and
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
cards with a reply box.

`plan` mode behavior:
- Draft a concise implementation plan only (no implementation output).
- Read-only inspection is allowed when it materially improves plan quality (for example `glob`, `rg`, `view`).
- Do not edit repository files or run mutating commands unless implementation is explicitly requested.

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
| POST | `/api/conversation/:id/compact` | Compact a conversation into a new one with carry-over summary seed |
| DELETE | `/api/conversation/:id` | Delete a conversation: stops its session worker, deletes its CLI session, removes its rows. A Claude Cloud conversation's cloud session is archived at Anthropic in the background (never waited for). A Copilot session the relay only imported and never ran is hidden and tombstoned instead: nothing is stopped and its CLI session is kept. `409 conversation-active` (`reason: turn-running` / `background-tasks`) while it is still working; `409 worker-stop-failed` when its worker survives the stop (nothing deleted) |
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
| POST | `/api/relay-question` | (CLI) Create a relay question for the browser |
| POST | `/api/relay-question/:id/answer` | (UI) Submit an answer for a relay question |
| POST | `/api/relay-question/:id/timeout` | (CLI/UI) Mark a relay question timed out |
| POST | `/api/heartbeat` | (CLI) Keep CLI status alive. A session worker may send `backgroundTasks: { count, digest }`; the answer carries `resyncBackgroundTasks: true` when the relay's set for that worker differs |
| GET | `/api/status` | Overall status |
| GET | `/api/about` | The About OAR modal: `version`, `commit` (the checkout's HEAD read from `.git`, else a `gitHead` stamp in package.json, else `null`), `startedAt` and `uptimeSeconds` of the relay process; `providers[]` (enabled ones only: `cliVersion` from the CLI probe cache, never a new probe, `sdkVersion` from node_modules, `state` `online`/`offline` for the relay CLI that runs Copilot's extension engine and OpenAI, `online`/`idle` with `runningWorkers` for the others); `stats` (conversations, messages, turns = replies, `turnsByProvider`, `firstConversationAt`); `usage` (only what is stored: Copilot premium requests, Cursor and Grok tokens and cost, Claude Cloud cost); `relay` (`dbBytes` = database + WAL, `runningWorkers`); `update` (latest version only while the opt-in check is on). The totals are read in rowid ranges of 10 000 messages with the event loop free in between, and kept for 60 s |
| GET | `/api/models` | Live/cached model catalog used by the UI picker |
| POST | `/api/models/snapshot` | (CLI/relay) Publish discovered model snapshot |
| POST | `/api/conversation/:id/refresh-history` | Re-import an existing conversation's history through the local Copilot SDK |
| GET | `/api/context/:conversationId` | Context metrics for a conversation or `sdk_session_id`. Copilot sessions are parsed from session-state events (falling back to a labeled lower-bound completion-token estimate when full legacy buckets are missing); Claude sessions are served from the breakdown their worker stored, and so are Cursor, Grok and Claude Cloud sessions. All return the same normalized `contextUsage` view alongside `providerType` and the runtime's own `text` dump |
| GET | `/api/context` | Same payload when a `conversationId` query is provided; otherwise returns a missing-selection response |
| GET | `/api/usage` | Unified plan usage: one card per configured provider (`providers[]` with `meters`, `details`, `links`) built from the live Copilot quota, the Claude worker's latest stored snapshot, and the derived Cursor cycle totals. A provider that cannot be read yields an unavailable card rather than failing the response, so the modal always renders. While Claude Cloud is on, the Claude card's windows are read live from the account, and a Claude Cloud card is added (credit meters, the relay's cloud spend, and the cost of the conversation named by `?conversationId=` when it is a cloud one); a card may carry `notes[]` (a line of text with an optional https link), and a meter `severity` and `resetKind: 'expiry'`. Legacy top-level Copilot quota fields are spread alongside `providers` for cached clients; `?legacy=1` returns the Copilot-only snapshot on its own |
| GET | `/api/settings/cursor-allowance` | Read the manual Cursor plan allowances (`cursorModelsUsd`, `otherModelsUsd`, `resetDay`) |
| POST | `/api/settings/cursor-allowance` | Set the Cursor pool allowances and billing reset day; `null` clears an allowance, and `resetAccounting: true` re-baselines the derived spend tracking |
| GET | `/api/settings/claude` | Read Claude provider settings (`enabled`, `model`, `models`, `availableModels`, `attributionMode`, `backgroundCommandLimitMinutes` with the slider bounds `backgroundCommandLimitMinMinutes`, `backgroundCommandLimitMaxMinutes`, `backgroundCommandLimitStepMinutes`, `backgroundCommandLimitDefaultMinutes`) |
| POST | `/api/settings/claude` | Enable/disable Claude, set the default model, the enabled model subset, the attribution mode or `backgroundCommandLimitMinutes` (clamped to 30…480 and snapped to 30-minute steps; not a number is `400`; read by Claude sessions spawned afterwards); triggers discovery and unstarted-conversation reconciliation |
| GET | `/api/settings/claude-cloud` | Read Claude Cloud settings: `{ enabled, defaultModel, environmentId, environments: [{ id, name }] \| null, environmentsError, account: { loggedIn, email, orgName, subscriptionType } \| null, token: { source, hasToken, expiresAt }, models }`. `token` says where the login is read from (`env`, `file`, `none`) and when it runs out, never the token. `environments` is `null` while the provider is off or the host has no login: nothing is asked of Anthropic then |
| POST | `/api/settings/claude-cloud` | `{ enabled?, defaultModel?, environmentId? }` → `{ ok: true, …the GET body }`. Enabling without a Claude login on the host is `400` with `code: 'claude_cloud_login_missing'`; an empty `environmentId` clears the stored one. Emits `claude_cloud_settings_updated` |
| GET | `/api/settings/cursor` | Read Cursor provider settings — same shape as Claude's: `models` is the enabled subset, `availableModels` the full discovered list, plus per-model `efforts` |
| POST | `/api/settings/cursor` | Set/remove the Cursor API key, default model, or enabled model subset; key changes reset discovered models and effort tiers |
| GET | `/api/settings/turn-ceiling` | Read the max turn duration plus slider bounds (`minMinutes`, `maxMinutes`, `stepMinutes`, `defaultMinutes`) |
| POST | `/api/settings/turn-ceiling` | Set the max turn duration in minutes (`0` = no limit) |
| GET | `/api/settings/relay-restart-max-wait` | How long a queued relay restart waits before it asks: `{ maxWaitMinutes, choices: [5, 10, 15, 30, 60, 120, 240, 0], defaultMinutes: 30, overrideMs }`; `0` = no limit; `overrideMs` is `OAR_RELAY_RESTART_MAX_WAIT_MS` when set |
| POST | `/api/settings/relay-restart-max-wait` | `{ maxWaitMinutes }` → the GET body; anything but one of `choices` is `400`. A queued request measures its current period against the new value at once |
| GET | `/api/settings/subagent-record-retention` | How long sub-agent records keep tool inputs and output: `{ retentionDays, choices: [0, 7, 14, 30, 90], defaultDays: 90 }`; `0` = keep for good |
| POST | `/api/settings/subagent-record-retention` | `{ retentionDays }` → the GET body; anything but one of `choices` is `400`. Runs a retention sweep 5 s later |
| POST | `/api/claude-native-session` | (Claude worker) Persist the native Agent SDK session id for resume |
| POST | `/api/claude-context-usage` | (Claude and Claude Cloud workers) Report the session's context-window breakdown after a turn; `409` for a conversation of any other provider |
| POST | `/api/claude-plan-usage` | (Claude and Claude Cloud workers) Report the session's structured `/usage` data — plan rate-limit windows plus session cost totals — falling back to the stable `modelUsage`/`totalCostUsd` result fields. Stored as the latest Claude snapshot; a Claude Cloud conversation's report is stored under its own snapshot key, `claude-cloud` |
| POST | `/api/claude-cloud-session` | (Claude Cloud worker) Report the cloud session a conversation is bound to: `{ conversationId, cloudSessionId, sessionUrl?, lastSequence, pushedBranch?, costUsd?, model? }` → `{ ok, cloud }`. Sent after the session was created, after every `result` and on a push; emits `claude_cloud_session`. `404` without a runtime session, `409` for a conversation that is not a cloud one |
| POST | `/api/cursor-plan-usage` | (Cursor worker) Report the agent's cumulative billed usage; the relay diffs it against a per-agent checkpoint and books the increase into the current billing cycle under the pool implied by the turn's model |
| POST | `/api/subagent-run` | (Worker) Register/update a subagent run. A new run needs the spawning turn's `messageId`; an update to a known run may omit it (a background agent's end arrives between turns). Optional header fields: `subagentType`, `model`, `modelInherited`, `taskId`, `background`, `timelineOwner`; a post without `status` leaves the run's state alone. Emits `subagent_status` with the whole header |
| POST | `/api/subagent-timeline` | (Worker) `{ conversationId, subagentRunId, entries: [{ key, kind, text, done?, toolName?, toolUseId?, metadata? }], header? }` → `{ ok, stored, truncated }`. Kinds: `thought`, `tool_call`, `tool_result`, `text`, `child`, `note`. Fenced by the run row, not by an open turn; an unknown run whose `header.parentSubagentId` is known is created under the parent's turn, anything else is `404 unknown_run`. Sends `subagent_timeline` `{ conversationId, messageId, subagentRunId, entries, truncated }`, volatile, only to the pages watching the run (`subagent_viewer_watch`) |
| GET | `/api/conversation/:conversationId/subagent/:subagentRunId` | One run's record for the viewer: `?after=<seq>&limit=<n>` (default 500, max 2000) → `{ run, entries, children, nextAfter, complete }`. `entries` are those after `after` plus any still open; `run.legacy` marks a record rebuilt from the lane rows |
| POST | `/api/conversation/:conversationId/subagent/:subagentRunId/cancel` | Request cancellation of one subagent run (unsupported by the Claude runtime) |
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
| GET | `/api/remote-relays/summary` | (Worker) `{ count, online, localEnabled }`: the number of paired relays, how many of them are online, and whether agent sessions are switched on. Workers register `remote_relay` when `count` is above zero or `localEnabled` is `true` |
| POST | `/api/remote-relays/tool` | (Worker) One `remote_relay` tool call: `{ conversationId, action, args }`. For a paired relay the relay checks the mention unlock, the permission, the hop limit and (ask/plan mode) the user's approval, then forwards the call to the remote. For this relay itself (named by its name or `this`; refused with `REMOTE_RELAY_LOCAL_DISABLED` while agent sessions are off) it checks instead that the call does not aim at the caller's own conversation (`REMOTE_RELAY_OWN_SESSION`) and, for `create_session`, that the caller was not created by an agent (`REMOTE_RELAY_NESTED_SESSION`), that fewer than 4 sessions it created have a turn queued or running (`REMOTE_RELAY_SESSION_LIMIT`) and that the user allowed it once for the conversation; the call then runs against this relay's own routes in-process. A `model` in `create_session` or `send` is checked first, before any approval card, against the list New Chat offers for the provider on the target (`/api/models` for Copilot and OpenAI, the provider settings routes for Claude, Cursor, Grok and Claude Cloud): one it does not list is refused with `REMOTE_RELAY_UNKNOWN_MODEL`, `suggestions` (the close matches) and `models`, and nothing is created or sent. Casing follows the list; a Claude alias (`opus`, `sonnet`, `haiku`, with an optional `[1m]`) resolves to the newest listed model of its family by version number (a date suffix ignored, the undated id first, `[1m]` ids only when the alias asks and they are listed); a `[1m]` id with only its base listed runs as the base, with a note; a Copilot id with its effort (`gpt-5.4-high`) goes to the bootstrap and the first prompt as the listed id plus `reasoningEffort` (an explicit `effort` wins, and a note says so), but only when the catalogue lists that effort for the id (`reasoningByModel`): `gpt-5.1-codex-max` with only `gpt-5.1-codex` listed is unknown, with the base suggested; `auto` passes. `send` also takes the provider's whole discovered list (`availableModels`) and the session's own model, as the message route does. Without a list (discovery has not run, the route did not answer; `auto` alone is no list) the model goes on unchecked and `modelNote` says so, as it does when the bootstrap binds another model than the one asked. A provider not set up there answers `REMOTE_RELAY_PROVIDER_UNAVAILABLE` before its model is looked at. The bootstrap route itself checks a Copilot model from an agent against Copilot's own models: an unknown one is refused (`COPILOT_MODEL_UNAVAILABLE`, with `supportedModels` and `suggestedModels`; another provider's model gets that provider's answer), a listed one is bound in the list's casing, an effort-suffixed one as the listed id plus that effort when `reasoningByModel` lists it; the browser's New Chat keeps its fallback to the current model. `wait_seconds` is cut to the `maxWaitSeconds` setting for every target |
| GET | `/api/relay-events/subscriptions` | Every active [relay event subscription](#relay-event-subscriptions) (`{ available, subscriptions }`); refused to other relays' agents |
| DELETE | `/api/relay-events/subscriptions/:id` | The user's Unsubscribe (a paired relay's subscription too: it learns with its next fetch); refused to other relays' agents |
| POST | `/api/relay-events/remote/subscribe` | (Relay to relay) A paired relay's agent subscribes to sessions here: `{ watcher: { conversationId, title }, subscriber: { name }, scope, sessions, events?, once?, match?, stalled_minutes?, heartbeat_minutes?, dry_run? }` → `{ ok, subscription }`. Another relay's request only, inbound switch on; see [Across paired relays](#across-paired-relays) |
| POST | `/api/relay-events/remote/pull` | (Relay to relay) That relay fetches its events: `{ after, subscriptions: [{ id, watcher }], ended: [ids] }` → `{ ok, events, cursor, more, subscriptions, ended, dropped }` |
| POST | `/api/background-task-settled` | (Worker) How a background task ended: `{ conversationId, taskId, toolUseId?, status, summary?, reason?, description?, taskType?, startedAt? }` (Claude worker, from `task_notification`; the last three describe a task that was in its published set) |
| GET | `/api/remote-relays/inflight` | (Worker) Number of `remote_relay` calls running for `conversationId` |
| GET/POST | `/api/settings/remote-relays` | This relay's `publicUrl` and `inboundEnabled` (accept prompts from other relays' agents) |
| GET | `/api/settings/agent-sessions` | Agent sessions: `{ enabled, maxWaitSeconds, limits: { minWaitSeconds: 120, maxWaitSeconds: 3600, stepSeconds: 60 }, maxActiveSessions: 4 }`. `enabled` (default `false`) lets this relay's agents start and use sessions on it through `remote_relay`; `maxWaitSeconds` (default `600`) is the longest wait of one `remote_relay` call, for this relay and paired ones |
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
- The relay waits until no turn is processing before acting. While the request is queued no pending message is handed to a worker (a turn started meanwhile would postpone the restart again); pending and parked rows stay in the database and run after the restart.
- `immediate: true` (boolean-ish, like `restart`) starts it at once, running turns or not: the banner's **Restart now**. The answer still names what it did not wait for.
- Maximum wait (`services/relay-restart-queue.mjs`): after **Ask after a queued relay restart has waited** (`relay_restart_max_wait_minutes`, 30 by default, 5–240 or `0` = no limit; `OAR_RELAY_RESTART_MAX_WAIT_MS` overrides it in ms, for test relays) the request stays queued and sets `question: { askedAt }`; the relay pushes one notification (titled *Relay restart waiting*; switch **Queued relay restart waited its maximum time**, `relayRestart`) and never restarts while turns run; it still goes ahead as soon as the last turn ends, question or not. A raised maximum (or none) that moves the deadline into the future withdraws the question; `/keep-waiting` without a question does nothing (`extended: false`). An `immediate` request may name the queued request it was shown (`expectRequestedAt`, its `requestedAt`); when that request is gone the answer is `accepted: false, stale: true` and nothing starts. Agents are told never to send `immediate` (`relay-tools.md`). The user answers with `immediate`, `/keep-waiting` (another full period from now; counted in `keptWaiting`) or `/cancel`. With no limit the request, and the messages it holds, wait until the turns end or someone decides.
- What it waits for, holds and leaves running (`services/relay-restart-picture.mjs`), in the answer, in `GET /api/relay/shutdown`, in `/api/status` → `relayShutdown` and in the `relay_shutdown_state` socket event (sent on every change and on connect):
  - `waitingFor`: `[{ conversationId, title, turns }]`, the sessions with a processing turn
  - `held`: `{ count, conversations: [{ conversationId, title, count }] }`, pending and parked messages
  - `backgroundTasks`: `[{ conversationId, title, count, detail, survives, why }]`, sessions with running background work of a live worker (the task panel's sets and running sub-agent runs, through `background-work-view.mjs`), then sessions with console tasks held since the last restart (`background-task-store.mjs` `listRestored`), which no worker has confirmed yet: `survives: null`
  - `survival`: `{ action, workersSurvive, summary }`. Workers are separate processes (tmux, detached, a console window) and outlive a restart, which the relay's supervisor or the CLI extension takes; they outlive a shutdown too, except under a systemd service (detected from `INVOCATION_ID` and a `.service` cgroup), whose stop may take the workers with it (`survives: false`, shown as "may stop"; a worker in a tmux session the service did not start survives, which the relay cannot tell). A Claude Cloud session runs at Anthropic and always survives
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

- Physical blobs are stored in `server/uploads/<sha256>` (content-addressed).
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
- The output format is deliberately restricted to JPEG/PNG: Copilot's image-input docs call
  these "the most widely supported formats". WebP compresses better and previews correctly
  in the browser, but arrives at the model unreadable.
- Re-encoding therefore has two triggers, tracked by `reencodeReason()`:
  - `'size'` — the image is over the byte threshold. Abandoned if the result is no smaller.
  - `'format'` — the source is not PNG/JPEG/GIF (e.g. WebP, AVIF, HEIC), so it is converted
    at its original dimensions **regardless of size**, and kept even if the result is larger:
    a bigger image the model can read beats a smaller one it cannot.
- Without the `'format'` trigger a WebP small enough to skip the size threshold would reach
  the model invisible.
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

New tables are likewise created at startup with `CREATE TABLE IF NOT EXISTS` in both the fresh-schema
and migration blocks — most recently `workflow_runs` (final workflow digest per assistant message,
keyed on `response_message_id`, cascade-deleted with the conversation; see
[Background tasks and workflow progress](#background-tasks-and-workflow-progress)).

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
| `claude-cloud-worker/` | Claude Cloud session worker (turn runner over the cloud session's event stream, event normalizer) |
| `../shared/claude-cloud/` | Claude Cloud API client, the reader of the Claude CLI's login, repository/branch/model string rules |
| `services/claude-cloud-settings-service.mjs` | Claude Cloud switch, default model and environment |
| `services/claude-cloud-session-service.mjs` | What the relay keeps per cloud conversation: worker reports, the `cloud` payload field, archiving |
| `services/claude-account-usage-service.mjs` | Live Claude account usage for Check Usage (only while Claude Cloud is on) |
| `services/git-remote-service.mjs` | GitHub remote and branch of a folder, for the New Chat modal |
| `services/relay-event-service.mjs` | Relay event subscriptions: subscribe / transfer, recording, coalescing, the hourly cap and digest, delivery into the watcher's conversation, stalled / all_idle / heartbeat sweeps |
| `services/session-activity-tracker.mjs` | What each session is doing: `state`, tasks, task edges and the activity clock |
| `../shared/relay-events.mjs` | Relay event types, limits and the text of an event message |
| `services/remote-relay-loopback.mjs` | The `remote_relay` client for this relay itself (agent sessions): hands the dispatcher's requests to the relay's own HTTP handler in-process instead of opening a connection |
| `services/claude-session-root-service.mjs` | Resolves the browsable session folder for Claude conversations |
| `services/context-usage-view.mjs` | Normalizes Copilot and Claude context data into one payload |
| `services/cloudflared-tunnel-service.mjs` | Supervises the `cloudflared` child process for the Cloudflare Tunnel mode |
| `services/tunnel-worker-path-guard.mjs` | Rejects session-worker WebSocket paths that arrive through a public tunnel |
| `../shared/turn-ceiling.mjs` | Shared bounds/formatting for the max turn duration setting |
