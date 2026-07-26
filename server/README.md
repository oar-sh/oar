# Copilot Web Proxy

A Node.js web server that lets you chat with your GitHub Copilot CLI from any device via a browser.

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
- Plain-text assistant questions are not considered bridge-backed questions.
- Relay now includes a fallback: if a turn clearly ends with a plain-text follow-up
  question and choices but no `ask_user` bridge was used, it auto-converts that
  question into a relay question card, waits for the answer, and resumes the turn.

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
| GET | `/api/drives/file` | Stream a file by path — Windows drive path or Linux absolute path depending on server platform |
| GET | `/api/drives/files-preview` | Return structured preview JSON for a file — Windows drive path or Linux absolute path depending on server platform |
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
| GET | `/api/context/:conversationId` | Parse and return context metrics from session-state events for a conversation, falling back to a labeled lower-bound completion-token estimate when full legacy buckets are missing |
| GET | `/api/context` | Parse context metrics only when `conversationId` query is provided; otherwise returns a missing-selection response |
| GET | `/api/usage` | Live Copilot usage snapshot |

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
- Requests are auth-protected and restricted to files inside the workspace root.
- **Platform split** — the drives API adapts automatically based on the server OS:
  - **Windows:** drive roots are discovered via `fsutil.exe`; paths use Windows drive-letter format (`C:/foo/bar`); directory listing uses PowerShell.
  - **Linux:** a single `/` root is returned; paths are absolute POSIX paths (`/home/user/file.txt`); directory listing uses `fs.readdir` + `fs.stat`.
- The `/api/status` response includes a `platform` field (`win32`, `linux`, `darwin`, etc.) so the browser UI can adapt path handling accordingly.
- Drive browsing is auth-protected; path traversal attacks and non-absolute paths are rejected on both platforms.
- Traversal or non-file paths are rejected.
- **Linux access scope** — on Linux the drives API currently allows any authenticated user to browse and read any path that the server process has OS-level read access to (i.e. the same permissions as the user running the relay). There is no additional allowlist restriction beyond requiring an absolute path.
  > **TODO:** add an optional `drivesAllowList` config key (array of absolute path prefixes) so operators can restrict drive access to a set of directories (e.g. home folder or workspace root). When the list is non-empty, requests whose resolved path does not start with one of the listed prefixes should be rejected with `403`.
- The web UI opens workspace mentions in an in-app preview dialog with **Preview / Raw** mode buttons.
- Markdown preview supports optional embedded-HTML mode with script/event-handler stripping and a visible warning.
- The floating **📁 Browse files** button opens the explorer with **Workspace** and **Drives** roots, tree navigation, list/icon folder views, and image thumbnails.

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
call `/api/usage` directly.

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
| `processingTimeoutMs` | `600000` | Max response wait time (ms) |
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
the relay runs a one-shot remote cleanup over SSH (default: kill listeners
for that remote port via `lsof`/`fuser` when available) and retries quickly on the same
fixed port. Set `sshTunnel.autoReclaimPort` to `false` to disable, or provide
`sshTunnel.remoteCleanupCommand` for your own server-specific cleanup command.

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
| `data/copilot.db` | Persisted conversations and queue storage (gitignored) |
| `relay-tools.md` | Markdown tool guidance loaded by the relay extension |
