# Developing

This document covers day-to-day development workflows for the web relay, its session workers, and
the Copilot CLI extension, plus the relay internals that used to live in the README. The
[README](README.md) is written for people who install and use OAR.

## Naming: OAR vs "copilot"

The product is **OAR — Open Agent Relay** (`@oar-sh/oar`, binary `oar`). Write it
`OAR` in prose and `oar` in code. Many internals deliberately still say
"copilot": the `COPILOT_WEB_RELAY_*` env vars, `.copilot/`-derived host paths,
DB tables, cookies, and `server/data/copilot.db` either address the real GitHub
Copilot CLI's contracts or are invisible identifiers whose rename would only buy
a migration. Do not "fix" them in passing — the deferred rename list lives in
`docs/plans/oar-rebrand-and-release.md` §11.

## Rules for coding agents

These rules apply to any agent working in this repository (they were in the README until 0.9.3):

- Do not restart the web relay unless the user has explicitly given permission. If a manual
  restart is requested, use `POST /api/relay/shutdown` only — never restart the relay by killing
  processes (see [Manual relay control](#manual-relay-control)).
- Do not run tests that spawn Copilot CLI clients unless the user explicitly permits it.
  Unit tests (`npm test`) and e2e tests (`npm run test:e2e`) are isolated from a live relay and
  may run beside it; see [Tests](#tests).
- Do not run extension-managed relay transport together with standalone relay runtime transport
  (see [Single runtime owner rule](#single-runtime-owner-rule)).
- Work on a topic branch, never on `main`. Push it to the private remote `work` (a bare
  `git push` does that), never to `origin`. Land finished work with `npm run land`. Never pass
  `--no-verify` to `git push`, and never set the `OAR_ALLOW_PUBLIC_*` variables unless the user
  asked for exactly that (see [Branches and landing](#branches-and-landing)).
- Invent every name that goes into a fixture, a comment, a doc or a commit message. Do not copy
  what a live relay, a log or this machine shows you: session titles, repository slugs, branch
  names, ticket ids, accounts, hosts.

`.github/copilot-instructions.md` carries the same restart policy for Copilot sessions.

## Relay internals

Operator and developer detail moved here from the README.

### The pieces

1. **Web relay server** (`server/`): queueing, persistence, auth, browser UI, file browser,
   uploads, the OpenAI Image path, and the supervision of per-conversation session workers.
2. **Session workers** (`server/copilot-worker/`, `server/claude-worker/`, `server/cursor-worker/`,
   `server/grok-worker/`): one Node process per conversation that runs its turns through the
   Copilot SDK engine, the Claude Agent SDK, the Cursor Agent SDK, or the Grok CLI over ACP, and
   speaks the same relay contracts as the Copilot workers. The Claude Cloud worker
   (`server/claude-cloud-worker/`) speaks them too but runs no agent: it sends messages to a
   session in Anthropic's cloud and follows that session's event stream.
3. **Copilot CLI extension** (`.github/extensions/web-relay/`): the Extension engine. It polls the
   relay, executes turns, streams activity, and bridges `ask_user` questions into web question
   cards.

### The single server entry point

`server/server.js` is the only entry point, in every mode — manual runs, the CLI
extension, `oar`, the systemd unit, Windows autostart, and the e2e runner all start it
(`npm start` is an alias for exactly `node server/server.js`).
Its role is chosen by argv, never by the environment:

- `node server/server.js` — the process stays attached to your terminal as a
  supervisor and runs the real server (`server-runtime.mjs`) in a worker child it
  marks with `--relay-runtime`. Exit code 75 relaunches the worker; any other
  non-zero exit is retried up to 3 times before the supervisor gives up.
- `node server/server.js --supervised` — runs the server in this process and
  exits 75 on restart, leaving restarts to whoever spawned it. The CLI extension
  passes this so its own bounded-backoff supervision is the only one in play.

Role flags travel on argv because the server's environment is inherited by tmux
worker sessions and by the Copilot CLI it launches — an env-based flag would be
read by unrelated servers started further down that tree.

### Runtime ownership

With session worker routing on (the default), the server launches each conversation's worker
itself, so a plain `node server/server.js` — `npm start`, the systemd unit, Windows autostart —
serves every runtime without a Copilot CLI session attached.

### Single runtime owner rule

Run only one relay owner at a time:

1. **Extension-managed mode**: the Copilot CLI extension (loaded into `gh copilot` by `oar copilot`,
   `npm run copilot:relay`, or the global wrapper) starts and supervises `server.js --supervised`,
   and owns the relay worker WebSocket and fallback dequeue loop. `github`/`openai` turns run in
   Copilot sessions the server launches per conversation.
2. **Standalone mode** (manual escape hatch): start the server, then run `node server/relay.mjs` by hand. It spawns its own Copilot CLI process and polls `GET /api/pending` over HTTP. Use it only when the extension transport is unavailable — there is no npm script for it. On Windows, its visible launcher targets a stable per-workspace Windows Terminal window name, so later foreground launches reuse the same window instead of opening new desktop windows; use the hidden/stdio fallback only when you explicitly need it.

Do not run extension-managed relay transport together with standalone relay runtime transport.

`npm run copilot:relay` is the convenience launcher for extension-managed mode in this repository:
it runs `gh copilot -- --allow-all` from the repo root, so the project-local extension loads and
starts the relay. With the global wrapper installed (see
[Global extension install](#global-extension-install-optional)), plain `gh copilot` from any
repository does the same.

In extension-managed mode, the worker WebSocket begins after the CLI session becomes active (typically after the first prompt), with HTTP dequeue kept only as fallback when the socket is unavailable.
The extension supervises managed `server.js` restarts (bounded backoff) while the CLI session is alive, and stops restart attempts on session shutdown.
When the CLI extension connects, it also prints the relay info window (local/network/remote/auth URLs) directly in the Copilot CLI client.

On Windows, **Settings → Autostart (Windows)** can add a per-user Startup entry (*At sign-in*) that opens a visible terminal at sign-in and runs the installed `node server\server.js` path, or a boot-triggered scheduled task (*At system startup*). Either starts only the web relay server. With session worker routing on (the default), the relay then launches each conversation's worker itself; only with routing off must a Copilot CLI session using the extension attach before queued turns can be processed. Turning the setting off removes the OAR Startup entry.

### Manual relay control

Do not restart the relay by killing processes; use `POST /api/relay/shutdown` instead.

- `POST /api/relay/shutdown` without `restart` queues a normal relay shutdown.
- `POST /api/relay/shutdown` with `restart: true` queues an intentional self-restart.
- Requests are localhost-only and still require relay auth.
- The relay waits until the queue is idle before acting; this endpoint does not interrupt an in-flight turn.
- `/api/status` exposes the queued relay exit state as `relayShutdown` so the UI/logs can distinguish idle, queued, and shutting-down restart/shutdown flows.
- Restart ownership follows the argv role, so exactly one supervisor acts on exit code 75:
  - `node server/server.js` — the attached supervisor respawns its worker child in the same terminal session
  - `node server/server.js --supervised` — the server exits 75 and the CLI extension relaunches it (bounded backoff, and it stops trying once the CLI session shuts down)

The web UI's **🌄 Restart web relay**, `oar stop`, `oar restart`, `oar update` and `oar setup` (after a changed token, port or access) use the same endpoint. The runtime a supervisor starts after a restart reads the config file again, so a new port or token applies; `oar` asks on the port and with the token the relay runs with, then waits for an answer on the new ones. A relay that `oar copilot` started carries its port and token on its command line and keeps them.

### Session mismatch recovery

Session mismatch recovery is restart-driven: the relay restart orchestrator parks queue work, restarts/rebinds the CLI runtime, and resumes dequeueing after rebind confirmation. The extension no longer attempts in-process session switch APIs from the dequeue/send path.

### Global npm command from a checkout

You can install a checkout locally and get a global `oar` command without publishing:

```powershell
npm link
# or
npm install -g .
```

`oar copilot`, run from any folder, starts the web relay server for that folder's workspace root, then immediately hands the shell to `gh copilot` without a bootstrap prompt. If a relay already answers on the port, the command reuses it and still opens Copilot in the same shell. The other commands (`oar help`) are described in the README; in a checkout `oar start` and `oar service` refuse, and `oar setup`, `oar stop`, `oar restart`, `oar status` and `oar url` work on `server/config.json`.

Relay server output is written to a logfile under `%LOCALAPPDATA%\copilot-remote\logs` (`~/.config/copilot-remote/logs` elsewhere) for git checkouts, or `~/.oar/logs` (`%APPDATA%\oar\logs`) for global installs, unless `COPILOT_WEB_RELAY_LOG_DIR` is set, so it stays out of the CLI terminal.

If you want custom token/tunnel settings from a specific `server/config.json`, point `COPILOT_WEB_RELAY_CONFIG` at that file before launching. A plain `npm install -g .` does not bundle the repo-local gitignored config file.

Manual relay shutdowns are queued via `POST /api/relay/shutdown` and only take effect after the current turn goes idle, so they are not a way to interrupt a turn in progress.

### Global extension install (optional)

Install a user-global extension entrypoint for use across repositories:

```text
%USERPROFILE%\.copilot\extensions\web-relay\   (Windows)
~/.copilot/extensions/web-relay/               (Linux/macOS)
```

Recommended command:

```bash
oar --install-extension
```

This writes/updates `extension.mjs` in the user-global extension directory as a wrapper that imports the repository extension entrypoint directly. `oar copilot` does the same on every run unless you pass `--no-install-extension`.
The wrapper also avoids double-loading when you start Copilot from this repository itself, so the
project-local extension remains the single runtime owner in repo-root sessions.

Useful environment variables:

- `COPILOT_WEB_RELAY_SERVER_DIR` (recommended)
- `COPILOT_WEB_RELAY_ROOT`
- `COPILOT_WEB_RELAY_CONFIG`
- `COPILOT_WEB_RELAY_TOOLS`
- `COPILOT_WEB_RELAY_LOG_DIR`
- `COPILOT_WEB_RELAY_NODE`

Project-local extension files still take precedence when both exist.

If the same extension is available both project-local (`.github/extensions/web-relay/`) and user-global (`~/.copilot/extensions/web-relay/`), Copilot may show duplicates in extension management. Keep only one active copy to avoid double-loading.

### Roadmap for later launcher modes

1. **Option 2**: launch/attach a Copilot CLI session directly.
2. **Option 3**: support `oar -- [gh copilot args]` pass-through. *Shipped:* `oar copilot -- <args>`
   (or `oar -- <args>`) runs `gh copilot -- <args>`.
3. **Session resume**: add `--session-id=<...>` handoff once the session orchestration contract is defined.

### API overview

Common routes:

- Browser/API: `/api/message`, `/api/conversations`, `/api/conversation/:id`, `/api/status`, `/api/models`, `/api/usage`, `/api/context/:conversationId`
- Settings: `/api/settings/openai`, `/api/settings/claude`, `/api/settings/claude-cloud`, `/api/settings/grok`, `/api/settings/cursor`, `/api/settings/copilot`, `/api/settings/turn-ceiling`, `/api/settings/windows-autostart`
- Relay control: `/api/relay/shutdown`, `/api/relay/pause`, `/api/relay/resume`
- Worker bridge: `/api/pending`, `/api/response`, `/api/activity`, `/api/stream`, `/api/thought`, `/api/heartbeat`
- Claude worker: `/api/claude-native-session`, `/api/claude-context-usage`, `/api/claude-plan-usage`
- Claude Cloud worker: `/api/claude-cloud-session`, plus the Claude worker's `/api/claude-context-usage` and `/api/claude-plan-usage`
- Claude account auth: `/api/claude/auth/status`, `/api/claude/auth/login/start`, `/api/claude/auth/login/code`, `/api/claude/auth/login/cancel`, `/api/claude/auth/logout`
- Grok account auth: `/api/grok/auth/status`, `/api/grok/auth/login/start`, `/api/grok/auth/login/cancel`, `/api/grok/auth/logout`
- Provider CLI install: `/api/cli/status`, `/api/cli/install`, `/api/cli/install/cancel`
- Cursor worker: `/api/cursor-agent-id`, `/api/cursor-context-usage`, `/api/cursor-plan-usage`
- Questions: `/api/relay-question`, `/api/relay-question/:id`, `/api/relay-question/:id/answer`
- Sharing: `/api/conversation/:id/share`, `/api/conversation/:id/message/:messageId/share-visibility`, `/api/shared/:token`
- Pinned messages: `/api/conversation/:id/message/:messageId/pin`
- Images: `/api/openai/images/generate`, `/api/image-operations/:operationId/execute`, `/api/generated-image/:conversationId/:messageId/:imageId/content`
- File access: `/api/files/*`, `/api/files-preview/*`, `/api/repo/tree`, `/api/drives/*`
- Git: `/api/git/status`, `/api/git/diff`, `/api/git/pull`, `/api/git/remote` (the New Chat modal of a Claude Cloud chat)
- Previews: `/api/previews`, `/api/previews/:token` (publish a local dev server; see `docs/preview-servers.md`)
- Remote relays: `/api/relay/identity`, `/api/remote-relays`, `/api/remote-relays/:id`, `/api/remote-relays/:id/check`, `/api/remote-relays/pair`, `/api/settings/remote-relays`, `/api/settings/agent-sessions`; agent tool calls go through `/api/remote-relays/tool`, and workers read `/api/remote-relays/summary` and `/api/remote-relays/inflight`. With agent sessions on, the relay itself is a target of the tool (its name, or `this`): the dispatcher (`server/services/remote-relay-dispatcher.mjs`) hands such a call to the loopback client (`server/services/remote-relay-loopback.mjs`), which runs it through the relay's own Express handler in-process, with the relay's token and the `x-oar-remote-*` headers. A session an agent creates here therefore goes through the same routes as one a paired relay creates (bootstrap, message, conversation, questions, cancel-turn, archive); the inbound switch does not apply to a loopback request, and it alone may store an origin with `local: true`
- Uploads: `/api/upload`, `/api/upload/:sha256/content`

All authenticated routes accept either:

- `Authorization: Bearer <token>`
- auth cookie from prior login

For deeper implementation/API details, see [server/README.md](server/README.md#api-reference).

## Restarting the extension-managed relay

Use this sequence when you need the running relay to pick up server or extension changes.

1. Close all Copilot CLI sessions so the relay can go idle.
2. On Linux/macOS, optionally clear stale worker tmux sessions:

```bash
tmux ls
tmux kill-session -t <sdk-session-id>
```

3. Queue a relay restart through the authenticated localhost API:

```bash
CONFIG="${COPILOT_WEB_RELAY_CONFIG:-server/config.json}"
TOKEN=$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(j.authToken||j.relayAuthToken||''));" "$CONFIG")

curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -X POST http://127.0.0.1:3333/api/relay/shutdown \
  -d '{"reason":"manual-restart","requestedBy":"localhost-api","restart":true}'
```

### Verifying that a restart actually happened

The restart replaces only the `--relay-runtime` **child**; the supervisor keeps
its PID (it can be weeks old). Judging restart state from the wrong signal is a
recurring trap:

- `pgrep -af server/server.js` lists **both** processes. The one that restarts
  is `pgrep -f relay-runtime`; its start time is the true restart time:

  ```bash
  ps -o pid,lstart,etime -p "$(pgrep -f -- --relay-runtime)"
  ```

- Do **not** trust the `[relay] launched runtime pid=NNN` lines in
  `server/logs/server.log`: the log is heavily trimmed and PIDs wrap on
  long-uptime hosts, so the last launch line can name a PID that no longer
  matches the live child.
- A quick end-to-end health read after a restart: `GET /api/status`
  (`cliOnline`, queue counts) and `GET /api/model-variants` — its `source` /
  `refreshedAt` show whether boot-time Copilot model discovery ran on the new
  process (`server-discovery:boot`).
- **A restart is not a deploy for session workers.** Worker processes survive
  relay restarts by design (resume-across-restart; idle shutdown closes only
  their SDK runtime, never the process), so a live worker keeps executing the
  code it loaded at spawn. After changing worker-side code, recycle affected
  workers too — `POST /api/session-worker/<sdkSessionId>/kill` or
  `tmux kill-session -t <sdk-session-id>` — and compare
  `pgrep -af 'session-worker'` start times against the deploy time to find
  stale ones.

4. Start one fresh Copilot CLI session:

```bash
gh copilot
```

or:

```bash
oar copilot
```

## Worker debugging

On Linux/macOS, session workers prefer detached `tmux` sessions when `tmux` is available. The tmux session name matches the SDK session id, which makes it easy to inspect a worker directly:

```bash
tmux attach -t <sdk-session-id>
```

### Worker logs

Every Node session worker (Claude, Claude Cloud, Cursor, Grok, Copilot SDK) appends its stdout and stderr to
`worker-<sdk-session-id>.log` in the relay's log directory (`COPILOT_WEB_RELAY_LOG_DIR`; `oar doctor`
prints it), across restarts of the worker. At each launch a file over 10 MB is moved to
`worker-<sdk-session-id>.log.1`, replacing the previous one.

- **Linux/macOS**: the launcher redirects the worker's output into the file (`>> file 2>&1` under
  tmux, an inherited descriptor without tmux).
- **Windows**: each worker runs in its own console window (relay log: `mode=console`), which keeps
  showing the output. The launcher passes the file in `COPILOT_WEB_RELAY_WORKER_LOG_FILE` and the
  worker copies what it writes into it (`shared/worker-runtime/worker-log-file.mjs`). The file is
  next to `server.log`: `%LOCALAPPDATA%\copilot-remote\logs` for a git checkout started with
  `oar`, `%APPDATA%\oar\logs` for a global install, `server\logs` for a relay started without the
  launcher. Not in the file on Windows: what Node prints natively (a V8 fatal error such as heap
  exhaustion, a module that fails to load at startup) and the output of a worker started by hand,
  which has no launcher to name the file; set the variable yourself to get one.

The Copilot *Extension* engine has no worker log on any platform: it is the CLI's own TUI. Its
relay extension writes `ext-debug.log` in the same directory.

### Claude workers

Claude conversations run `server/claude-worker/claude-session-worker.mjs` as a plain Node process
rather than a Copilot CLI session. It uses the same tmux naming, but no `script`-based pseudo-TTY —
so `tmux attach` shows the worker's own `[claude-worker …]` log lines directly.

Prerequisite: the relay host must have a logged-in Claude Code CLI (`claude`). The relay stores no
API key; a turn that cannot authenticate replies with a system note saying so.

Run the worker manually against a live relay:

```bash
COPILOT_WEB_RELAY_WORKER_KIND=claude \
COPILOT_WORKSPACE_ROOT=/path/to/workspace \
CLAUDE_RELAY_MODEL=claude-sonnet-5 \
node server/claude-worker/claude-session-worker.mjs --session-id <sdk-session-id>
```

Useful overrides: `CLAUDE_CODE_EXECUTABLE` (explicit Claude Code binary),
`COPILOT_WEB_RELAY_CLAUDE_WORKER_PATH` (worker script location),
`COPILOT_WEB_RELAY_CONFIG` (relay config used to resolve the server URL and auth token).

The auto-compact window is spawn-only: the CLI reads `settings.autoCompactWindow` when it starts,
and a live `applyFlagSettings({ autoCompactWindow })` has no effect. A changed window is applied by
restarting the CLI process once (same session id) before the next turn-opening message, and only
when it is idle — no turn, open question, compaction or background agents/shells. Until then the
context payload reports why (`autoCompactWindowDeferred`: `'turn'`, `'background'` or `'next-message'`).

A running compaction is shown by a `pending` compaction entry on the row of the running turn, or on
the delivered message that waits for its turn. The boundary entry replaces it; a compaction that
ends without one, or whose boundary goes to another row, gets a `cancelled` entry. Known and left
as it is: a waiting message whose boundary is held for its turn reads "Compacting context…" from
the end of the compaction until that turn opens — normally milliseconds, longer only when the turn
start is delayed (API retries).

### Claude Cloud workers

Claude Cloud conversations run `server/claude-cloud-worker/claude-cloud-session-worker.mjs`, a
plain Node process like the Claude worker, with `[claude-cloud-worker <time>]` log lines under
`tmux attach` and in `worker-<sdk-session-id>.log`. It runs no agent and no CLI. The agent lives in
a session at Anthropic; the worker posts the user's messages there and follows the session's event
stream (`claude-cloud-session-process.mjs`). So the log is where to look for what the worker did,
and the session's page on claude.ai (the link in the conversation's cloud line) for what the agent
did.

The provider adds `COPILOT_WEB_RELAY_WORKER_KIND=claude-cloud` and `CLAUDE_CLOUD_RELAY_MODEL` to
the launch environment, and no credential. The worker reads the Claude CLI's login itself
(`shared/claude-cloud/credentials.mjs`; `CLAUDE_CONFIG_DIR` says where), and the token is in no log
line and no error text. Only a relay that runs on `CLAUDE_CODE_OAUTH_TOKEN` passes that variable
on, to cloud workers only and, under tmux, through the secret env file (`workerSecretEnvVarsFor`).
Overrides: `COPILOT_WEB_RELAY_CLAUDE_CLOUD_WORKER_PATH` (worker script location),
`COPILOT_WEB_RELAY_CONFIG`, and for tests `OAR_CLAUDE_CLOUD_API_BASE_URL`, which points the relay's
and the worker's cloud client at a fake API on the same machine; a value that is not a loopback
`http(s)` URL is ignored (`shared/claude-cloud/base-url.mjs`).

**The event stream.** `GET /v1/code/sessions/<id>/events/stream` is server-sent events. The worker
only reads `client_event` frames: the frame's `id:` is the event's sequence number, its data is
`{ event_type, source, sequence_num, payload }`, and `payload` is a plain Claude Code SDK message
(`assistant`, `user`, `system`, `result`, `control_request`, `control_response`,
`rate_limit_event`, `env_manager_log`, …). `session_update`, `delivery_update` and `ephemeral_event`
frames and the keepalive comments carry nothing a turn needs.
`claude-cloud-event-normalizer.mjs` maps events to relay actions; its header lists the channels.
The same events can be read as a paged log (`GET …/events?sort_order=asc&cursor=<sequence>`),
which is what a restarted worker does. Every expectation about these shapes lives in
`shared/claude-cloud/api-client.mjs`, because the API is measured, not documented.

A turn is everything after its user event up to the first `result`. In the log, look for:

- `queue.deliver received … msgId=…`: a delivery arrived;
- `cloud event stream dropped mid-turn; reconnecting reason=… after=<sequence> in=<ms>`: the
  stream ended or could not be opened, and is reopened after the last event handled, with a pause
  growing from 1 s to 15 s. No byte for 120 s, keepalives included, counts as a drop. After five
  minutes without a stream the row is requeued;
- `closing the idle cloud event stream`: only with `idleCloseMs` set. By default the stream stays
  open between turns, because the session may take a turn of its own (see below); between turns a
  dropped stream is reopened with the same pauses for five minutes, then left to the next delivery;
- `login nudge ran|skipped …`: the login in the file had run out, and the worker asked the relay to
  let the CLI refresh it (`POST /api/claude-cloud/login-nudge`, which runs `claude auth status`
  and answers what the file holds now, never the token);
- `cloud set_model refused …` / `cloud attribution request refused …`: a control request the API
  answered with 400. The turn goes on without the switch or the setting, with one activity line;
- `stray turn registration failed` / `stray cloud turn not registered; skipping it until its
  result`: a turn the session started by itself could not get its continuation row;
- `cloud turn failed <code> …`: the code is one of the client's (`login_expired`,
  `github_not_connected`, `repo_access_denied`, `environment_missing`, `rate_limited`, `not_found`,
  `transient`, …). `transient` requeues the row; the others answer it with what to do.

**What the worker sends besides messages.** Three control requests go over the same event API
(`POST …/events` with `event_type: "control_request"`), each answered by a `control_response` on
the stream: `interrupt` (Stop), `apply_flag_settings` (the commit attribution; inside the create
call in front of the first message, and before a later message when it changed; `null` takes a
key out again) and `set_model` (before a message whose model is not the one the worker last gave
the sandbox; the sandbox answers with a fresh `system/init`). After a worker restart the worker
does not know what the sandbox holds and sends both once.

**Turns the session starts by itself.** An event that opens a turn while no turn of ours runs (a
text `user` message from another client such as claude.ai, an `assistant` message, `system/init`
or `background_tasks_changed`) makes the worker register a continuation row
(`POST /api/continuation-turn`, trigger `cloud_client_message` or `cloud_turn`) and publish the
turn under it, like the local workers' background continuations. Turns that happened while no
worker ran are not recovered: the catch-up reads only the delivered turn.

**The usage limit.** The worker feeds the turn's events to the Claude worker's tracker
(`shared/claude-usage-limit.mjs`): reports go to `POST /api/claude-usage-limit`, and a failed
`result` with a rejected report is published as the usage-limit terminal error, which the relay
turns into a pause (`usage-limit-pause-service.mjs`, for `claude` and `claude-cloud`).

**Why a redelivery is safe.** Two things keep a queue row that is delivered a second time from
becoming a second prompt in the cloud:

- *The resume cursor.* `runtime_sessions.claude_cloud_last_sequence` is the sequence number of the
  last finished turn's `result`. The worker reports it through `POST /api/claude-cloud-session`
  after every `result`; it is never a point inside a turn, and the relay never moves it back. It
  rides on every delivery as `claudeCloud.lastSequence`, next to the session id, so a worker that
  starts cold needs nothing but the delivery: it reads the session's event log on from the cursor
  (`catchUp`) before it sends anything.
- *The deterministic message uuid.* The user event's `uuid` is derived from the queue row id
  (`claudeCloudMessageUuid`), not random. A row that is delivered again names the same message, so
  the worker finds it in the log (or, in the same process, in `session.sent`), takes the turn that
  message already started as its own, and publishes that turn's events again under the new
  attempt. A turn that finished while no worker ran is answered from the log alone. The first
  message works the same way: the create call carries the uuid, and a repeated create is answered
  with the session that already exists.

**Re-running a turn.** To watch a turn being published again without spending a new cloud turn,
end the worker *process* while the turn runs (`tmux kill-session -t <sdk-session-id>`, or kill the
pid). The relay's dead-worker recovery returns the row to the queue (it counts as a retry), and
the worker that gets it next follows the turn from the log as described above. **☠️ Kill session**
(`POST /api/session-worker/<sdkSessionId>/kill`) is not that: it fails the rows the worker owned,
and whatever is sent afterwards is a new queue row, so a new user event and a new, billed turn at
Anthropic. The unit suites replay scripted event sequences against the runner
(`claude-cloud-session-process.test.mjs`, harness `claude-cloud-test-harness.mjs`), and
`tests/claude-cloud.spec.mjs` runs whole turns through a relay and a worker of its own against a
fake API on a loopback port (`tests/fake-claude-cloud-api.mjs`). Both cost nothing; prefer them.

**Never run the worker entry bare from an agent's shell.** The entry starts at import, takes its
session id from `--session-id` *or from `SESSION_ID` in the environment*, and its relay from
`COPILOT_WEB_RELAY_CONFIG`. A shell inside a relay session inherits both from the live relay, so
`node server/claude-cloud-worker/claude-cloud-session-worker.mjs` there registers a second worker
for the very session the agent is running in, against the live relay. To check that the file
parses, use `node --check server/claude-cloud-worker/claude-cloud-session-worker.mjs`; to exercise
the logic, run the tests. The Claude, Cursor and Grok worker entries read `SESSION_ID` the same
way.

A live cloud turn costs real money on the relay host's Claude account. Run one only with the
user's explicit go-ahead.

**Checking a running relay.** `scripts/claude-cloud-live-check.mjs --relay <url> --repo
<owner/repo>` (token in `OAR_RELAY_TOKEN`) runs one short cloud turn on a scratch repository and
checks the provider switch, the login, the repository list, create, the commit trailer against the
attribution mode, the session binding and the archive on delete. Exit code 0 means every check
passed. Use it after a restart or a deploy, on each relay.

**After the Claude account of the host changes.** The cloud environment id stored in the settings
belongs to the account that was logged in when it was chosen, and so do the cloud sessions of the
existing chats. Open Settings → Providers → Claude Cloud, switch the provider on again if it is
off and pick an environment of the new account; chats bound to a session of the old account
answer `not_found` and need a new chat.

### Copilot SDK workers

With **Settings → Providers → Copilot → Copilot engine** on *SDK* (the default since 0.9.2, with a
fallback to *Extension* on a relay that cannot run it — `getCopilotEngine()` in
`server/server-runtime.mjs`), Copilot conversations run
`server/copilot-worker/copilot-sdk-session-worker.mjs` as a plain Node process instead of a Copilot
CLI session — same shape as the Claude worker, and with the same `[copilot-sdk-worker …]` log lines
under `tmux attach`. There is **no TUI to inspect**: the worker drives the CLI's bundled SDK runtime
headlessly, so the tmux inspector shows the worker's own log, not a Copilot session. The
*Extension* engine is unaffected.

Prerequisite: `COPILOT_SDK_PATH` must point at the `copilot-sdk` directory inside an installed
Copilot CLI bundle. The relay derives it once at boot from the extension bootstrap path, which is
why installing the CLI while the relay is running does not help until it restarts — the same fact
the settings panel reports when it refuses the engine.

Run the worker manually against a live relay:

```bash
COPILOT_WEB_RELAY_WORKER_KIND=copilot-sdk \
COPILOT_SDK_PATH=~/.cache/copilot/pkg/linux-x64/<version>/copilot-sdk \
COPILOT_WORKSPACE_ROOT=/path/to/workspace \
COPILOT_RELAY_MODEL=gpt-5.4-mini \
node server/copilot-worker/copilot-sdk-session-worker.mjs --session-id <sdk-session-id>
```

Useful overrides: `COPILOT_WEB_RELAY_CLI_EXECUTABLE` (explicit `copilot` binary for the runtime
spawn), `COPILOT_WEB_RELAY_COPILOT_SDK_WORKER_PATH` (worker script location),
`COPILOT_SDK_RELAY_IDLE_SHUTDOWN_MS` (runtime idle close, default 10 min),
`COPILOT_SDK_RELAY_TURN_STALL_TIMEOUT_MS` (stall watchdog with nothing in flight, default 120 s,
`0` disables; see [The stall watchdog](#the-stall-watchdog)),
`COPILOT_SDK_RELAY_BACKGROUND_TASK_TIMEOUT_MS` (an emergency override for how long live background
agents and shells alone may hold the runtime open; `0` = no limit).

Without the override the worker follows the relay's *Background task timeout* slider, which rides
every delivery payload exactly as for the Claude worker (default 4 h; `0` = unlimited). Since 2026-09-25
Copilot background agents and detached shells are read from the runtime's task registry
(`rpc.tasks.list`), listed in the composer's task panel with a working **Stop** (`rpc.tasks.cancel`),
and on cap expiry they are **cancelled** rather than forgotten — so the slider is a choice the user
can see and undo, and the old separate 30-minute default is gone. Runtimes without `rpc.tasks` (older
bundles) fall back to the event-scraped detached-shell tracking: non-stoppable shell cards, and a cap
expiry that forgets the shell (the runner's `DEFAULT_BACKGROUND_TASK_TIMEOUT_MS`, 30 min, applies only
when no getter is supplied, i.e. in tests). Stopping the runtime still kills its detached children.

Live testing spends real Copilot quota: **`gpt-5.4-mini` is the only sanctioned model for live
relay tests**, per the standing live-testing policy, and only with the user's explicit go-ahead.
Everything else belongs in the unit suites, which drive the worker against a fake SDK client.

## The stall watchdog

The Copilot, Cursor and Grok workers fail a turn whose runtime has sent nothing for too long. How
long depends on what the runtime is doing, which the worker reads off the events it already gets
(`shared/worker-runtime/turn-liveness.mjs`):

| Phase | Default | Meaning |
| ----- | ------- | ------- |
| idle | 120 s | nothing is in flight: the session is opening, or the runtime is between steps |
| model | 300 s | a model request has started and not finished |
| tool | 30 min | a tool call has started and not finished |

The windows differ because silence does. A command that prints nothing produces no event until it
exits; a model request produces a delta every few seconds for as long as the provider streams, and
none while it does not. The numbers behind this are in the module's header. Cursor and Grok have
no idle phase inside a run: once the run has started it is a model request unless a tool call is
open.

Overrides, for every worker: `OAR_TURN_STALL_IDLE_MS`, `OAR_TURN_STALL_MODEL_MS`,
`OAR_TURN_STALL_TOOL_MS` (`0` = no limit for that phase). When only the idle window is set, by
this variable or by `COPILOT_SDK_RELAY_TURN_STALL_TIMEOUT_MS`, the other two keep their proportion
to it.

While a turn is kept past the idle window, the Copilot worker asks its runtime once per idle window
whether it is still there (`ping`, 5 s to answer). A runtime that does not answer fails the turn at
once. The other two runtimes have no such request; a dead Grok agent is noticed by its process
exiting.

The Claude worker only observes. Its CLI sends a heartbeat every 30 s while a tool runs in
silence and a frame about every second while the model works (SDK 0.3.283, measured), but how
long its silent stretches get in real sessions is not known (a compaction, the backoff of an API
retry), and failing a turn there means killing the CLI and its background tasks. So a running
turn the CLI has said nothing in for 10 minutes (30 minutes with a tool open) is written to the
worker's log with what was in flight, `running turn quiet for …`, and left running.

The Claude Cloud worker has no stall watchdog either, and does not use `turn-liveness.mjs`. What
it watches is its connection, not the agent: an event stream that delivers no byte for 120 s,
keepalives included, is reopened after the last event handled, and a stream that stays away for
five minutes hands the row back to the queue, where the next delivery follows the same turn
instead of sending it again (see [Claude Cloud workers](#claude-cloud-workers)). A cloud turn that
is quiet while its stream is alive is left running; the worker cannot stop the sandbox, only ask
it to (`interrupt`).

A question card, a `remote_relay` call and a compaction hold the watchdog whatever the phase. What
bounds a turn that stays quiet and alive is the relay's turn ceiling.

A `remote_relay` call can be quiet for long: `wait_seconds` goes up to the relay's **Longest wait
per tool call** (`remote_relay_max_wait_seconds`, 600 s by default, 120 to 3600 s), and an
approval card adds the time the user takes. Nothing on the way cuts that short. The worker's
request to `/api/remote-relays/tool` is a long call without a client-side timeout
(`executeRemoteRelayTool`), the MCP adapters allow a tool call 8 hours
(`REMOTE_RELAY_TOOL_CALL_TIMEOUT_MS`), and the relay does the waiting itself by reading the
target's transcript every 2 s with short requests (`pollForReply`), so no single request to a
paired relay or to the loopback stays open for the wait. The turn ceiling does not know about
the call: with a wait near the maximum and the default ceiling of 60 minutes, the ceiling's
recovery reaches the calling turn before the wait is over.

## Branches and landing

`main` is the only permanent branch, and the only one the public repository receives. Everything
else is a short-lived topic branch that lives on a **private** remote and is deleted once it has
landed. There is no long-lived `dev` branch.

Why it is set up this way: on a public host, deleting a branch does not delete its commits. They
stay fetchable by hash until the host's support purges them, so anything pushed there, including
a leak and the commit that cleans it up, is effectively permanent. On the private remote nobody
else can read them, and once the branch has landed squashed, its intermediate commits are not part
of any public history.

| Remote | What it is | What goes there |
| ------ | ---------- | --------------- |
| `origin` | the public repository | `main` and release tags, nothing else |
| `work` | your private working repository | topic branches, and a mirror of `main` |

Agents and scripts address the remotes **by name**; the URL behind `work` differs per
maintainer and is not recorded in the repository.

### One-time setup per checkout

```bash
npm run setup:git -- --work-url <url of your PRIVATE repository>
```

It sets `core.hooksPath` to `scripts/git-hooks` (shared by every worktree of the checkout), adds
the `work` remote, makes a bare `git push` go to `work`, and creates an empty hygiene denylist if
there is none. It is idempotent; run it again whenever in doubt. Then add your private names to
the denylist (see [Test authoring rules](#test-authoring-rules)).

**Your git identity is published too.** Every commit carries the author's and the committer's
name and e-mail address, and no later change takes them out of a published commit. If your usual
address is on a personal domain, give this repository its own neutral one. The setting is local to
the checkout; your global identity stays as it is:

```bash
node scripts/setup-git.mjs --email "<id>+<login>@users.noreply.github.com"
```

The setup warns when the identity in effect matches the denylist, `land` refuses to build a
commit with it, and the hook refuses to publish one.

### Day to day

```bash
git switch -c dev/<topic> origin/main   # start from the current public main
# ...commit as often as you like; these commits are never published...
git push                                # goes to the private remote
git fetch origin && git rebase origin/main   # when main moved meanwhile
npm run land -- -m "Subject line" --body-file notes.txt
```

`npm run land` refuses unless the branch is clean and sits on top of `origin/main`, then runs the
hygiene guard, the unit suite and the end-to-end suite on exactly the tree that is about to be
published. Only if all three pass does it build **one** squashed commit, push it to `origin/main`,
mirror `main` to `work`, switch the checkout to `main` and delete the topic branch locally and on
`work`. The squashed commit is built with `git commit-tree`, so the files on disk are never
touched; the relay usually runs from this checkout. `--dry-run` does everything except publish.
`--skip-e2e` exists for changes that cannot affect the app, and only when the user agreed.

One topic per branch: what lands is one commit, so its message has to describe one change.

**Working in a separate worktree.** Landing ends by switching the checkout to `main`, so it has to
run where `main` is not held by another worktree; it checks that first and says where to go.
Commit and push in the worktree, remove it, then `git switch dev/<topic>` in the main checkout and
land there.

From PowerShell call the script directly, `node scripts/land.mjs -m "…" --body-file notes.txt`:
npm's PowerShell shim swallows the `--` separator and then reads `--body-file` as its own option.
The same goes for `node scripts/setup-git.mjs --work-url <url>`.

### The pre-push hook

`scripts/git-hooks/pre-push` (logic in `scripts/pre-push.mjs`) runs on every push:

- To `origin` it accepts only `main` and tags, refuses a non-fast-forward of `main`, and scans
  the commits being pushed (messages and added lines) for machine fingerprints, the `gh`
  account, denylist names and secrets. It also checks the **author and committer headers** of
  those commits against the denylist. Deleting a branch is always allowed.
- To any remote it first runs the hygiene guard over the working tree.

The two overrides are environment variables, deliberately not flags:
`OAR_ALLOW_PUBLIC_BRANCH=1` and `OAR_ALLOW_PUBLIC_REWRITE=1`. They are for a maintainer repairing
the public repository by hand. What counts as a leak is defined once, in
`scripts/hygiene-patterns.mjs`, and shared with `server/test-hygiene.test.mjs`.

The hygiene files themselves (`server/test-hygiene.test.mjs`, `scripts/pre-push.test.mjs`) have
to spell out example secrets and fingerprints, so they are exempt from those patterns. They are
**not** exempt from private names: both the suite and the hook check them against the denylist
and the `gh` account. Every example in them is invented.

### If something private was published anyway

Rewriting and force-pushing removes it from the branch, not from the host: the old commits remain
fetchable by hash. Rewrite first, then ask the host's support to purge the unreachable commits and
cached views, and treat any secret among them as compromised.

Every clone that had the old commits keeps them too, held by its reflogs. Clean each one with:

```bash
node scripts/prune-local.mjs                  # lists what would be deleted, changes nothing
node scripts/prune-local.mjs --list gone.txt  # the same, written to a file for review
node scripts/prune-local.mjs --apply          # deletes; cannot be undone
```

Do **not** use `git reflog expire --expire=now --all` for this. It also empties the stash reflog,
and every stash except the newest exists only there: they disappear from `git stash list` and the
following `git gc` deletes them. The script expires every reflog except the stash's, in all
worktrees of the repository. Besides the rewritten commits, a prune removes whatever else nothing
refers to any more: commits of deleted branches, pre-rebase copies, and stashes dropped earlier.
Read the list first.

## Tests

### Node version

**The unit suite requires Node.js 24+.** This is not a style preference — Node 20 and 22
both fail `createWorkerSecretEnvFile uses owner-only permissions and cleans up` with
`failureType: 'cancelledByParent'`, because their test runner cancels subtests that outlive
the parent. Node 24 awaits them. Measured on the same tree:

| Node | Result |
| ---- | ------ |
| 20.19.2 | 26/28 in `session-worker-launch-service.test.mjs` — 1 failure |
| 22.23.2 | 26/28 — same failure |
| 24.19.0 | 28/28 |

If you hit exactly that one failure, check `node -v` before assuming a regression. Debian's
apt `nodejs` is still on 20, so use nvm:

```bash
nvm install 24 && nvm alias default 24
```

On Debian, add nvm's init to `~/.profile` as well as `~/.bashrc` — `~/.bashrc` returns early
for non-interactive shells, so `bash -lc 'node …'` (CI, scripts, `wsl -e`) would silently keep
using `/usr/bin/node`.

### Unit tests

Unit tests are colocated as `*.test.mjs` and run with the Node test runner:

```bash
npm test
```

Expected: **0 fail** everywhere; **4931 pass / 0 fail / 0 skip on Linux (0.9.9, 2026-10-07)** — the count
grows with every change, so treat it as a floor. Windows runs the same suite with **4 skips** that are host-gated
(0600 file modes, symlinks) and run on Linux (0.9.9: **4927 pass / 0 fail / 4 skip**).

Unit tests are **safe to run while a live relay is running**: they use in-memory SQLite,
temp directories, and injected `spawnImpl`/`execImpl` fakes — nothing binds a port, spawns
a real process, or touches `server/data`.

The suite is expected to be green on every platform. A failure after your change is a
regression — fix it before moving on.

The hygiene guard's test-file rules walk the working tree on disk (not `git ls-files`), so
leftover agent worktrees under `.claude/worktrees/` get scanned too and can fail `npm test` in
the main checkout. Remove them (`git worktree remove …`) before running the suite there.

To run a subset, match `*.test.mjs` explicitly — pointing the runner at a directory makes it
try to execute the implementation modules alongside the tests, which fails:

```bash
node --test server/claude-worker/*.test.mjs
node --test shared/*.test.mjs
node --test server/services/context-usage-view.test.mjs
```

### End-to-end tests

```bash
npm run test:e2e
```

Expected: **224 passed / 0 failed / 6 skipped on Linux (0.9.9, 2026-10-07)**, and 201 passed / 29 skipped on
Windows (the skipped ones are host-gated; 24 of them are the Claude Cloud specs, which run only on Linux). Two question-card
tests in `relay-question-ui.spec.mjs` (`:82` and `:386`) are **known flaky** and usually pass on
Playwright's single retry; across five full runs they failed 0–2 times each with no relation to what
else was in the suite. Treat a failure there as flake only after re-running — anything else failing
is a regression.

The e2e runner spawns its own `server.js` on a free port with an isolated state directory
(`COPILOT_WEB_RELAY_DATA_DIR` + `COPILOT_WEB_RELAY_CONFIG` pointed at a temp dir), so it can
run alongside a live relay without touching its database, singleton lock, or config. `HOME`,
`USERPROFILE`, `COPILOT_SESSION_STATE_DIR` and `CLAUDE_CONFIG_DIR` are redirected into the
same temp root, so no host provider state (Copilot sessions, Claude credentials) is visible
to it. The test server also runs with `COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN=1`, so it never
launches real Copilot CLI clients, Claude workers, or `claude auth login/logout/status` —
every one of those spawn paths refuses outright; set `RELAY_E2E_ALLOW_CLI=1` explicitly (with
user permission) if a run genuinely needs live turns (even then the auth subcommands are
pointed at `server/services/fixtures/claude-auth-stub.sh`, never the real CLI).

Three provider-CLI surfaces are stubbed the same way, each behind a **pair** of variables so the
kill switch can never be bypassed into running a real binary: `claude auth *`
(`COPILOT_WEB_RELAY_CLAUDE_AUTH_BIN` + `…_CLAUDE_AUTH_ALLOW_STUB_SPAWN`), the CLI installers
(`COPILOT_WEB_RELAY_CLI_INSTALL_COMMAND` + `…_CLI_INSTALL_ALLOW_STUB_SPAWN`, pointed at
`cli-install-stub.sh`), and `grok login/logout` (`GROK_CLI_COMMAND` +
`…_GROK_AUTH_ALLOW_STUB_SPAWN`, pointed at `grok-stub.sh`).

**`COPILOT_WEB_RELAY_CLI_BIN_DIR` is the one that matters most.** Provider-CLI *detection* walks
`PATH`, and an isolated relay still inherits the host's `PATH` — it has to, it runs `node` — so
without this pin `/api/cli/status` reports the developer's own `grok`/`claude`/`copilot`, and with
the install stub enabled it would run them. The variable **replaces** `PATH` and the descriptors'
own bin directories rather than being preferred over them, and every test relay gets it pointed at
an empty directory inside its temp state root. Specs seed a fake binary there to mean "already
installed"; a spec must never see, run, or modify a host install.

Extra arguments are forwarded to Playwright, so a single spec can be run in isolation:

```bash
node tests/run-e2e.mjs cache-rebuild.spec.mjs
```

Specs must resolve the relay URL, auth token, and database exclusively through
`tests/e2e-env.mjs` (fed by `run-e2e.mjs` via `PLAYWRIGHT_BASE_URL`, `RELAY_TEST_TOKEN`,
`RELAY_TEST_DATA_DIR`). Never read `server/config.json`, open `server/data/copilot.db`, or
target `http://127.0.0.1:3333` from a spec — those belong to the live relay.

That isolation env lives in `tests/relay-server-harness.mjs` (`startRelayServer`), which
`run-e2e.mjs` calls for the server every spec shares. It also pins session-worker routing off and
`COPILOT_SDK_PATH` at a stub directory, so a relay's answer never depends on what the host has
installed. A spec that needs a *differently configured* relay boots its own throwaway one from the
same helper rather than copying the env block — `tests/copilot-engine.spec.mjs` does this to test
the Copilot SDK engine's accept path, which the shared server's routing pin makes unreachable, and
`tests/cli-install.spec.mjs` because a successful install rewrites that relay's `config.json`, binds
`GROK_CLI_COMMAND` into its process env and hoists its `PATH` — none of which the shared server's
other specs should inherit. `tests/claude-cloud.spec.mjs` does it because it needs what the shared
server forbids: worker launches and session-worker routing, for a real Claude Cloud worker (in a
tmux server of its own, so the spec is skipped on Windows). `tests/agent-sessions.spec.mjs` boots
two: a plain one, because it switches the agent-sessions setting, and one set up like the cloud
spec's for a `claude-cloud` session created through the tool (that half is skipped on Windows
too). It runs no model: it posts to `/api/remote-relays/tool` as a worker's tool adapter would
and answers the approval card itself.
Keep that rare: it costs a server boot per relay.

**A test relay must never reach the Anthropic API.** The Claude Cloud client sends the Claude
login to its base URL, so the harness pins `OAR_CLAUDE_CLOUD_API_BASE_URL` to a loopback port
nothing listens on and clears `CLAUDE_CODE_OAUTH_TOKEN` for every test relay (the credentials file
is already out of reach through `CLAUDE_CONFIG_DIR`). The cloud spec overrides both for its own
relay: the URL of `tests/fake-claude-cloud-api.mjs`, and a token only that fake accepts. The
variable cannot name another host: `shared/claude-cloud/base-url.mjs` ignores everything but a
loopback `http(s)` URL.

### Live smoke tests

`tests/agents/` contains smoke tests that send real prompts through a **live** relay. They are
excluded from `npm test`, skip unless `RELAY_TEST_TOKEN` is set, and must never be run
implicitly:

```bash
npm run test:agents:smoke   # requires a live relay + RELAY_TEST_TOKEN; ask the user first
```

Do not run tests that spawn Copilot CLI clients unless explicitly permitted.

### Test authoring rules

- **No personal data, machine fingerprints, or secrets in test files.** Use fictional values:
  `C:\Users\dev`, `/home/dev`, `user@example.com`, obviously fake tokens. Never embed real
  usernames, home paths, hostnames, e-mail addresses, or credentials — not even your own.
  `server/test-hygiene.test.mjs` enforces this and fails the suite on violations.
- **No real accounts or private project names either, anywhere git publishes.** The guard also
  reads the GitHub login your `gh` CLI is signed in to (its local `hosts.yml`, no network) and
  fails on any file naming it; fixtures use `example-org/demo`. Names no machine property
  reveals (your other projects, their ticket ids, personal domains) go into an untracked
  `.git/info/hygiene-denylist`: one entry per line, `#` for comments, matched case-insensitively
  as whole words, so the list itself is never published (`OAR_HYGIENE_DENYLIST` points at another
  file). Create it on every checkout you work in; without it that check is reported as skipped.
  Agents writing fixtures from what a live relay shows are the usual source of such leaks.
- **Platform behavior is injected, not detected.** Services take `platform`, `homedir`, `env`,
  `spawnImpl`/`execImpl` parameters; tests pass `'win32'`/`'linux'` explicitly so the whole
  suite runs identically on any OS. Do not write tests that branch on `process.platform` —
  if a test genuinely cannot run on the host OS, skip it explicitly:
  `test('…', { skip: process.platform !== 'win32' }, …)`.
- **The path module is injected too.** A service that joins onto a caller-supplied base dir
  takes `pathImpl` (or `path`), defaulting to the host's — see `normalizeCloudflaredTunnelConfig`,
  `prepareWorkerLogFile`, `normalizeSshTunnelConfig`, `resolveClaudeProjectsRoots`. Tests then
  pass `path.posix` **and** `path.win32`, so both halves run on both machines:

  ```js
  const cfg = normalizeCloudflaredTunnelConfig(raw, { configBaseDir: '/srv/relay', pathImpl: path.posix });
  ```

  Without this, `path.join('/var/log/relay', 'w.log')` yields `\var\log\relay\w.log` on Windows,
  and a hardcoded POSIX expectation passes on Linux while failing on Windows.
- Paths in fixtures should be built with `path.join()` or use both-separator expectations
  where the code under test normalizes separators.

`server/test-hygiene.test.mjs` enforces the three rules above mechanically:

1. bare `process.platform` in a test,
2. an undeclared win32 path shape (`"C:\…"`, `/^[A-Za-z]:$/`),
3. an undeclared **POSIX join** — an assertion expecting a literal that strictly extends a POSIX
   literal the same test block passed in, which is the exact signature of "the implementation
   joined onto my base dir with the host's separator".

Each is escaped file-wide by naming `path.posix` / `path.win32` / `win32`, gating with `skip`, or
annotating a line `host-platform:` (real host behavior is under test) or `platform-agnostic:` (the
value never reaches path semantics — e.g. an HTTP route path, which is `/`-separated everywhere).

## Notes

- In extension-managed mode, do not restart the relay by killing random processes.
- Use the localhost shutdown API for manual relay restart requests.
- Keep exactly one relay listener on port `3333`.
