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
   speaks the same relay contracts as the Copilot workers.
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

1. **Extension-managed mode**: the Copilot CLI extension (loaded into `gh copilot` by `oar`,
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

The web UI's **🌄 Restart web relay** and `oar update` use the same endpoint.

### Session mismatch recovery

Session mismatch recovery is restart-driven: the relay restart orchestrator parks queue work, restarts/rebinds the CLI runtime, and resumes dequeueing after rebind confirmation. The extension no longer attempts in-process session switch APIs from the dequeue/send path.

### Global npm command from a checkout

You can install a checkout locally and get a global `oar` command without publishing:

```powershell
npm link
# or
npm install -g .
```

Run it from any folder to start the web relay server for that folder's workspace root, then immediately hand the shell to `gh copilot` without a bootstrap prompt. If a relay is already active, the command reuses it and still opens Copilot in the same shell.

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

This writes/updates `extension.mjs` in the user-global extension directory as a wrapper that imports the repository extension entrypoint directly. Plain `oar` does the same on every run unless you pass `--no-install-extension`.
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
2. **Option 3**: support `oar -- [gh copilot args]` pass-through. *Shipped:* `oar -- <args>` runs
   `gh copilot -- <args>`.
3. **Session resume**: add `--session-id=<...>` handoff once the session orchestration contract is defined.

### API overview

Common routes:

- Browser/API: `/api/message`, `/api/conversations`, `/api/conversation/:id`, `/api/status`, `/api/models`, `/api/usage`, `/api/context/:conversationId`
- Settings: `/api/settings/openai`, `/api/settings/claude`, `/api/settings/grok`, `/api/settings/cursor`, `/api/settings/copilot`, `/api/settings/turn-ceiling`, `/api/settings/windows-autostart`
- Relay control: `/api/relay/shutdown`, `/api/relay/pause`, `/api/relay/resume`
- Worker bridge: `/api/pending`, `/api/response`, `/api/activity`, `/api/stream`, `/api/thought`, `/api/heartbeat`
- Claude worker: `/api/claude-native-session`, `/api/claude-context-usage`, `/api/claude-plan-usage`
- Claude account auth: `/api/claude/auth/status`, `/api/claude/auth/login/start`, `/api/claude/auth/login/code`, `/api/claude/auth/login/cancel`, `/api/claude/auth/logout`
- Grok account auth: `/api/grok/auth/status`, `/api/grok/auth/login/start`, `/api/grok/auth/login/cancel`, `/api/grok/auth/logout`
- Provider CLI install: `/api/cli/status`, `/api/cli/install`, `/api/cli/install/cancel`
- Cursor worker: `/api/cursor-agent-id`, `/api/cursor-context-usage`, `/api/cursor-plan-usage`
- Questions: `/api/relay-question`, `/api/relay-question/:id`, `/api/relay-question/:id/answer`
- Sharing: `/api/conversation/:id/share`, `/api/conversation/:id/message/:messageId/share-visibility`, `/api/shared/:token`
- Images: `/api/openai/images/generate`, `/api/image-operations/:operationId/execute`, `/api/generated-image/:conversationId/:messageId/:imageId/content`
- File access: `/api/files/*`, `/api/files-preview/*`, `/api/repo/tree`, `/api/drives/*`
- Git: `/api/git/status`, `/api/git/diff`, `/api/git/pull`
- Previews: `/api/previews`, `/api/previews/:token` (publish a local dev server; see `docs/preview-servers.md`)
- Remote relays: `/api/relay/identity`, `/api/remote-relays`, `/api/remote-relays/:id`, `/api/remote-relays/:id/check`, `/api/remote-relays/pair`, `/api/settings/remote-relays`; agent tool calls go through `/api/remote-relays/tool`, and workers read `/api/remote-relays/summary` and `/api/remote-relays/inflight`
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
oar
```

## Worker debugging

On Linux/macOS, session workers prefer detached `tmux` sessions when `tmux` is available. The tmux session name matches the SDK session id, which makes it easy to inspect a worker directly:

```bash
tmux attach -t <sdk-session-id>
```

### Worker logs

Every Node session worker (Claude, Cursor, Grok, Copilot SDK) appends its stdout and stderr to
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

A question card, a `remote_relay` call and a compaction hold the watchdog whatever the phase. What
bounds a turn that stays quiet and alive is the relay's turn ceiling.

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

Expected: **0 fail** everywhere; **3761 pass / 0 fail / 0 skip on Linux (0.9.5, 2026-09-27)** — the count
grows with every change, so treat it as a floor. Windows runs the same suite with **4 skips** that are host-gated
(0600 file modes, symlinks) and run on Linux: **3757 pass / 0 fail / 4 skip** on the same commit.

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

Expected: **158 passed / 0 failed / 6 skipped on Linux (0.9.5, 2026-09-27)**, and 160 passed / 4 skipped on
Windows (the skipped ones are host-gated). Two question-card
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
other specs should inherit.
Keep that rare: it costs a server boot per relay.

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
