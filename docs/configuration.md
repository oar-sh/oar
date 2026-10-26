# Settings and configuration

Every setting in the web UI, every key of the config file, and every environment variable. This is the detail behind the [README](../README.md#documentation); the most complete guide is [Reference on oar.sh](https://oar.sh/docs/reference/).

## Settings (⚙️ in the web UI)

*On oar.sh: [Settings](https://oar.sh/docs/reference/settings/)*

The modal is organised into seven tabs — **General**, **Providers** (with a **Copilot**, **OpenAI**, **Claude**, **Claude API**, **Claude Cloud**, **Grok**, **Cursor**, and **DeepSeek** sub-tab), **Relays**, **Previews**, **Sharing**, **Notifications**, and **Features** — and reopens on the tab you used last. The `⋯` menu opens it with no conversation open too, so a fresh install can turn on a provider before the first chat; until a provider is ready, the empty screen and **New Chat** point to Settings → Providers. Unless noted as per browser, these settings live in the relay database rather than the config file, and apply to every browser that connects:

| Tab | Setting | Default | What it does |
| --- | ------- | ------- | ------------ |
| General | Theme, Text scaling | dark theme | Per browser |
| General | Show Suspend host action | on | Per browser: shows **💤 Suspend host** in the conversation menu. The entry is there on every relay, but suspending works only when the relay runs on Windows; elsewhere it just says so (see [The conversation menu](web-ui.md#the-conversation-menu)) |
| General | Jump to the end when I send a message | on | Per browser: sending a message takes you to the end of the conversation; off, you stay where you are reading (see [While a turn runs](web-ui.md#while-a-turn-runs)) |
| General | Messages kept per conversation for switching back | `200` | Per browser: how many loaded messages each of the last eight conversations keeps around the place you were reading, so switching back returns there (100 to 1,000, or no limit; see [While a turn runs](web-ui.md#while-a-turn-runs)) |
| General | Max turn duration | `60 min` | Hard cap on how long one turn may run before the relay requeues it, counted from the turn's start or your last answer to one of its questions (0 = no limit, up to 10 h; see below) |
| General | Background task timeout | `4 h` | How long background tasks alone may keep a Claude or Copilot session running after its reply; then they are stopped (0 = no limit, up to 10 h) |
| General | After a relay restart, tell interrupted sessions to carry on | off | A session whose turn the restart cut off for good gets one relay note asking the agent to carry on (see [After a relay restart](web-ui.md#after-a-relay-restart)). A setting of the relay, kept in its database |
| General | Ask after a queued relay restart has waited | `30 min` | A queued **🌄 Restart web relay** waits for the running turns and holds new messages meanwhile; after this long (5 min to 4 h, or no limit) the banner asks whether to restart now, keep waiting or cancel. It never restarts while the turns run; it still restarts as soon as they end (see [The conversation menu](web-ui.md#the-conversation-menu)) |
| General | Mark a background task as quiet after | `10 min` | A background command or monitor that has written nothing for this long shows an amber **no output for N min** on its row (1 to 120 minutes; see [Background tasks](web-ui.md#background-tasks)) |
| General | Keep sub-agent tool output | `90 days` | 7, 14, 30 or 90 days, or always: once a finished sub-agent's record is older, its tool inputs and results are removed (once a day); its thoughts, reply and the one-line summary of each tool call stay |
| General | Autostart (Windows) | Off | *At sign-in* (a visible terminal after you log on) or *At system startup* (headless, no logon needed, one admin confirmation). Also `oar autostart`, with the same rules: an entry OAR did not make (a boot task or launcher edited by hand, a task someone else made, a hand-made Startup entry) is never deleted or replaced; a switch it stands in is refused, with the reason. `oar autostart <mode> --replace` replaces it, keeping a copy |
| General | Relay name | `OAR` (the hostname for paired relays) | Label of the installed PWA on every device, and this relay's name for [paired relays](agents-together.md#remote-relays) |
| General | Check for updates automatically | off | Opt-in: the relay asks oar.sh for the latest version about twice a day. **Check for updates** works regardless; `OAR_NO_UPDATE_CHECK=1` blocks both |
| General | Check for updates, Update, Dismiss, Cancel update | — | **Check for updates** asks oar.sh now. When a newer release exists, **Update** installs it with npm (global installs; a git checkout is told to pull and restart) and queues a relay restart for when no turn runs; **Dismiss** hides that version (not offered for a critical update), **Cancel update** stops an install that is running, and **Update log** shows its output (see [Updating](install.md#updating)) |
| General | Default CWD for new sessions | relay workspace root | Working directory for newly created sessions that have none of their own |
| Providers | CLI row (Copilot, Claude, Grok) | — | The provider CLI's version, path and install method; **Install**, **Update** or **Switch to native installer** for Claude and Grok, with the **Install log**; read-only for Copilot (see [Installing a provider CLI](providers.md#installing-a-provider-cli-from-the-relay)) |
| Providers | Copilot engine | SDK | Extension when this relay cannot run the SDK engine (see [engine choice](providers.md#github-copilot--engine-choice)) |
| Providers | OpenAI API key / model / base URL | — / `gpt-4o` / `https://api.openai.com/v1` | Enables the OpenAI and OpenAI Image providers |
| Providers | Claude SDK: Enable Claude for New Chat model selection, Claude model ID | off / `claude-sonnet-5` | Enables Claude as a New Chat provider and runs model discovery; the model ID is the default model of new Claude chats |
| Providers | Claude: Commit attribution | OAR | What commits and pull requests of Claude and Claude Cloud sessions end with: **OAR**, **Vanilla** (Claude Code's own lines) or **Off**; a folder can override it in the **🧠** context modal (see [Claude (Agent SDK)](providers.md#claude-agent-sdk)) |
| Providers | Claude: Claude background command limit | `2 h` | How long a background command of a Claude session may run before Claude Code stops it, unless Claude gives it its own timeout (30 min to 8 h); applies to Claude sessions started after **Save Claude settings** |
| Providers | Claude account (Relogin / Logout) | host login | Switches the Claude account the relay host's CLI uses, from the browser (see [Claude (Agent SDK)](providers.md#claude-agent-sdk)) |
| Providers | Claude API: Enable Claude API for New Chat and the billing switch | off | On once a key is saved: offers Claude API in **New Chat** and the `Subscription \| API key` toggle in Claude chats (see [Claude API](providers.md#claude-api)). Off, a chat already on the key keeps the toggle so it can move back, and its turns on the key do not run |
| Providers | Claude API key / default model | — / the Claude tab's default, else the first Sonnet | A Claude Console API key (any `sk-ant-` key but Claude login and session tokens and Admin keys). It is never shown again: the tab says one is saved. Saving it lists the key's models from Anthropic; a key Anthropic refuses stays saved and the status line says why. **Refresh models** asks again; **Remove saved key** is refused while a Claude API chat has a message or a queued one, or a worker still runs on the key |
| Providers | Claude API: Monthly cap in US dollars | empty | Once this relay's estimated Claude API spend of the calendar month (the relay's time zone) reaches it, new turns on the key, switches to the key and new Claude API chats are refused; a running turn finishes, and since a turn's cost is booked when it ends, running turns can take the month past the cap. Empty for no cap; Console spend limits apply on top |
| Providers | Claude Cloud | off | Enables Claude Cloud as a New Chat provider, and the live account figures in **Check Usage**; the switch is the consent to use the Claude CLI's login (see [Claude Cloud](providers.md#claude-cloud)) |
| Providers | Claude Cloud environment / default model | first active environment of the account / `claude-sonnet-5-5` | The cloud environment new cloud sessions run in, and the model a new cloud chat starts with |
| Providers | Cursor API key / model | — / `composer-2.5` | Enables Cursor; plus monthly plan allowances and the optional dashboard session token |
| Providers | DeepSeek API key / model / commit attribution / base URL | — / `deepseek-flash` / OAR / `https://api.deepseek.com` | Enables DeepSeek; saving the key lists DeepSeek's models. The base URL (under Advanced) must be https, or http on the same machine |
| Providers | DeepSeek: Monthly budget | empty | An amount with its currency (USD or CNY): the DeepSeek usage card's budget bar measures this calendar month's (UTC) estimated spend against it; empty for no budget bar (see [Usage and context](web-ui.md#usage-and-context)) |
| Providers | DeepSeek: Starting balance | empty | An amount in the balance's currency, for example your first top-up, that the usage card's balance bar measures from; empty measures from the balance after the last top-up the relay has seen (before it has seen one, the highest balance it has read). A later top-up replaces it, and the tab then says it is no longer used; typed in again and saved, it applies again (see [Usage and context](web-ui.md#usage-and-context)) |
| Providers | Grok | off | Enables Grok; default model `grok-4.5`; **Sign in** / **Sign out**; optional monthly allowance |
| Relays | Public address | empty | How paired relays reach this one; **Also add this relay there** needs it. While it is empty, the field shows the address this page is open at as a placeholder (none on `localhost`), and the first **Add** of a relay stores that address (see [Remote relays](agents-together.md#remote-relays)) |
| Relays | Accept prompts from other relays' agents | on | Off: agents on paired relays can still list, read and wait on sessions here, but not prompt, start, stop or archive them, answer questions or watch them for events |
| Relays | Agent sessions: Agents may start and use sessions on this relay | off | Lets agents on this relay start and use other sessions here with the `relay_tool` tool; the first session an agent starts in a conversation asks for your approval (see [Agent sessions](agents-together.md#agent-sessions)) |
| Relays | Agent sessions: Longest wait per tool call | `10 min` | How long one `relay_tool` call may wait for a reply (2 to 60 minutes), on this relay and on paired ones; adjustable whether or not the switch above is on |
| Relays | Remote relays | — | The paired relays; per relay **Agents may** read only, read and prompt, or do everything |
| Relays | Add a relay | — | Paste the other relay's web address and press **Add**. **Use a different token** asks for its token when it differs from this relay's; **Also add this relay there** (on) pairs back, so its agents can work here too |
| Previews | Live previews | — | Lists the published previews with when each was published and last opened, each of which you can close, and those the relay could not check at its start as not served (see [Preview servers](preview-servers.md)) |
| Sharing | Shared conversations | — | Every shared link with **Copy link**, **Renew link**, **Stop sharing** and its access log (see [Sharing](web-ui.md#sharing)) |
| Sharing | Store viewer IP addresses | on | Whether the access log of shared links keeps the viewer's IP address |
| Sharing | Paths and file names | hide the path, show the file name | What shared links show of the relay host's paths: every path and file name, the file name only, or neither |
| Notifications | Push notifications | off | Per device: **Enable push notifications on this device**, **Include conversation title** (off), **Message preview** (none, truncated to **Preview length** characters, 80 by default, or the full text), and **Notify about**: questions, completed and failed turns, plan boards, a host suspend, and a queued relay restart that waited its maximum time (on), the CLI going offline (off). **Devices** lists every subscribed device with **Rename** and **Revoke** |
| Features | Feature flags | see below | **Session worker routing** (on), **Continuation answer routing** (on), **Generated-image continuity** (on), and a reserved **Worker fallback restart** (off, no effect yet). Changes apply after a relay restart; a `COPILOT_REMOTE_<FLAG>` environment variable pins a flag, e.g. `COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED=0` |

## How a stuck turn is detected

*On oar.sh: [Turns and the queue](https://oar.sh/docs/sessions/turns-and-the-queue/)*

Two independent guards, both of which exempt a turn that is waiting on an unanswered question card:

1. **Inactivity** — a turn is only considered stale after `processingTimeoutMs` with no sign of life from its worker. Worker heartbeats name the message they are working on, so a turn that legitimately runs for an hour of tool calls keeps resetting this window.
2. **Max turn duration** — a ceiling on elapsed time, set with the Settings slider (0 = no limit, up to 10 hours). It counts from the start of the turn, or from your last answer to one of its question cards if that came later: answering restarts the clock. This exists purely to catch a worker that has hung while still heartbeating. On Grok the worker also enforces the limit, counted from the start of the prompt, and does not pause for question cards (remote-relay approvals): a Grok turn waiting on an approval card can be cut off, and answering does not restart that clock. Whichever trips first ends the turn; the worker's check ends it with a stall note.

When either trips, the turn is returned to the queue rather than lost.

## Configuration reference (`server/config.json`)

*On oar.sh: [config.json](https://oar.sh/docs/reference/config-json/)*

The config file is `server/config.json` in a git checkout and `~/.oar/config.json` (`%APPDATA%\oar\config.json`) for a global install; `COPILOT_WEB_RELAY_CONFIG` points the relay at another file. It holds the auth token, so the relay keeps it owner-only. The relay reads it at startup: restart the relay after editing it.

| Key                        | Default              | Description                                                               |
| -------------------------- | -------------------- | ------------------------------------------------------------------------- |
| `authToken`                | generated if empty   | Required for API/UI auth. If empty, the relay makes up a random token at every start, keeps it in memory only and prints it to its console (the copy in `relay-console.log` blanks it; when `oar` starts the relay, the launcher makes up the token and it is not printed), so each restart signs every device out; `oar setup` writes a stable one |
| `port`                     | `3333`               | HTTP + WebSocket port                                                     |
| `localhostOnly`            | `true`               | `true` binds only to loopback (`127.0.0.1`); `false` listens on every interface (`0.0.0.0`) for LAN access. Write a JSON boolean: the relay listens on every interface for any value but `true` or the string `"true"` (in any case), while `oar setup`, `oar url` and `oar status` take only `false` as LAN access |
| `dataDir`                  | `data/` beside the server | Database, the relay's lock file, uploads (`uploads/` inside it; without `dataDir` a checkout keeps them in `server/uploads`), Cursor agent stores (`cursor-agents`) and the Claude Code state of DeepSeek chats (`deepseek-claude`); a relative path resolves against the config file's directory. `COPILOT_WEB_RELAY_DATA_DIR` wins. It applies to checkouts only: a global install always uses the state root's data folder (`~/.oar/data`, `%APPDATA%\oar\data` on Windows), however it is started. A Windows autostart relay that ran on a `dataDir` before 0.9.14 has that database copied over once at its first start; the folder is left as it is. Uploads made before `dataDir` was set stay in `server/uploads` and are still read from there |
| `pollIntervalMs`           | `3000`               | Unused: `oar` and the relay still write it into a new config, nothing reads it           |
| `contextIndicatorMode`     | `default`            | The context-usage line on the composer's top edge: `default` colours the whole line from green to red as the context fills; `bar` makes it a bar that grows from the left |
| `processingTimeoutMs`      | `600000`             | Inactivity window before a turn is treated as stale (not a cap on turn length) |
| `conversationSessionMode`  | `isolated`           | Configured strategy (`isolated` / `shared`) recorded on sessions and exposed in status |
| `maxRequeueRetries`        | `5`                  | Queue retry limit for failed processing                                   |
| `remotePath`               | `""`                 | URL base path when reverse-proxied under a subpath; also drives PWA URLs and socket.io path |
| `trustProxy`               | `"loopback"`         | Which proxies may set `X-Forwarded-*` headers (Express `trust proxy`); the client address (rate limits, sign-in lockout, share access log), host and scheme (share links) are read through it, so a direct client cannot forge them. Takes what Express takes: a hop count (`1`), an address or subnet (`"10.0.0.0/8"`), a list of them, or `"loopback"`. Widen it when a proxy on another host forwards to the relay (see [Behind a reverse proxy](remote-access.md#behind-a-reverse-proxy)) |
| `allowedOrigins`           | `[]`                 | Extra browser origins (scheme, host and port, such as `"https://relay.example.com"`) the Socket.IO channel accepts besides the relay's own, for a proxy that rewrites the `Host` header |
| `workspaceRootAllowList`   | unset                | Directories that conversations may start in (they and their subdirectories); unset allows any. `COPILOT_WORKSPACE_ROOT_ALLOW_LIST` sets it too, separated by the platform's path delimiter |
| `publicHostnames`          | `[]`                 | Hostnames the relay itself answers on; the preview lane refuses to share one |
| `tunnelMarkerHeaders`      | `[]`                 | Extra edge-injected headers that mark tunnel traffic (see [Session-worker path guard](remote-access.md#session-worker-path-guard)); merged with `COPILOT_TUNNEL_MARKER_HEADERS` (comma-separated) and `cf-ray`, neither replaces the other |
| `sshTunnel.mode`           | `disabled`           | Tunnel mode (`disabled` or `managed`)                                    |
| `sshTunnel.enabled`        | `false`              | Legacy alias (`true` => `managed`)                                       |
| `sshTunnel.required`       | `false`              | Pause dequeue while managed tunnel is disconnected                        |
| `sshTunnel.remoteBind`     | `loopback`           | Remote bind mode for SSH `-R` (`loopback` or `public`)                    |
| `sshTunnel.command`        | `ssh`                | SSH executable path/command                                               |
| `sshTunnel.user`           | —                    | SSH user                                                                  |
| `sshTunnel.host`           | —                    | SSH host                                                                  |
| `sshTunnel.remotePort`     | —                    | Remote forwarded port                                                     |
| `sshTunnel.identityFile`   | optional             | SSH key path (falls back to default agent/key)                            |
| `sshTunnel.autoReclaimPort` | `true`              | When the server refuses the forward because `remotePort` is taken, log in over SSH, stop the listener of your user that holds it (`lsof`/`fuser`), and retry |
| `sshTunnel.reclaimStaleSshSessions` | `false`     | As a last resort of that reclaim, also end your user's own `sshd` sessions on the server that have no child process (what a dropped `ssh -N -R` leaves behind) |
| `sshTunnel.remoteCleanupCommand` | built-in       | Shell command the reclaim runs on the server instead of the built-in one; it should exit `0` once the port is free |
| `cloudflaredTunnel.mode`   | `disabled`           | Cloudflare tunnel mode (`disabled` or `managed`; `enabled: true` is a legacy alias for `managed`) |
| `cloudflaredTunnel.required` | `false`            | Pause dequeue while the managed Cloudflare tunnel is disconnected         |
| `cloudflaredTunnel.token`  | —                    | The tunnel token from your own Cloudflare Zero Trust tunnel               |
| `cloudflaredTunnel.binary` | `cloudflared`      | Path or command name of the `cloudflared` you installed; defaults to `cloudflared` on `PATH` |
| `cloudflaredTunnel.extraArgs` | `[]`              | Extra arguments appended to `cloudflared tunnel run`                      |
| `previews.enabled`         | `false`              | Publish local dev servers on a separate listener (see [docs/preview-servers.md](preview-servers.md)) |
| `previews.port`            | `port + 1`           | Loopback port for the preview listener; `0` picks an ephemeral port        |
| `previews.bindHost`        | `127.0.0.1`          | Bind address; non-loopback needs `previews.allowPublicBind`                |
| `previews.allowPublicBind` | `false`              | `true` lets `previews.bindHost` be a non-loopback address                 |
| `previews.publicBaseUrl`   | —                    | Public base URL on a hostname **different** from the relay's               |
| `previews.allowedTargetHosts` | `[]`              | Upstreams allowed beyond loopback (container/VM IPs)                       |
| `previews.maxLive`         | `8`                  | Maximum simultaneously published previews                                  |
| `pushVapidSubject`         | `mailto:copilot-remote@example.com` | Contact URI the relay sends to push services with Web Push requests |
| `sharedPresenceMaxPerConversation` | `200`        | Most live viewers counted per shared conversation; caps the watcher count only, not who can read the link |
| `sharedPresenceMaxGlobal`  | `5000`               | Most live shared-link viewers counted in total; same, not an access limit  |
| `cliBinaries`              | *(written by the relay)* | Provider CLI paths resolved after an install from Settings, restored at startup |
| `sdkVersion`               | newest               | Copilot CLI version (`x.y.z`) in the CLI's package cache whose runtime the relay itself uses (session import, model discovery) |
| `sdkPath`, `cliPath`       | unset                | Set both to pin the relay's own Copilot runtime to one CLI version's `copilot-sdk/index.js` and `app.js` instead of searching the package cache. `sdkPath` also picks the version whose SDK the session workers get, `cliPath` the CLI the Extension engine starts |
| `restartGracefulTimeoutMs` | `8000`               | Graceful restart wait before force fallback                               |
| `restartShutdownTimeoutMs` | `45000`              | Drain timeout while waiting for active queue job completion               |
| `restartSpawnTimeoutMs`    | `18000`              | Max wait for resume/restart phase per attempt                             |
| `restartRebindTimeoutMs`   | `20000`              | Max wait for rebind/session-sync completion per attempt                   |
| `restartMaxAttempts`       | `3`                  | Bounded restart attempts before terminal exhaustion                       |
| `restartRetryBackoffMs`    | `[1000,3000,7000]`   | Deterministic retry backoff schedule in milliseconds                      |
| `restartReadyCooldownMs`   | `1000`               | Pause after a completed restart before the queue hands out turns again    |

The `restart*` keys tune the restart of a session's CLI (`/api/restart-orchestrator`), not **🌄 Restart web relay**.

## Environment variables

*On oar.sh: [Environment variables](https://oar.sh/docs/reference/environment-variables/)*

| Variable | Effect |
| -------- | ------ |
| `COPILOT_WEB_RELAY_CONFIG` | Config file to use |
| `COPILOT_WEB_RELAY_DATA_DIR` | Data directory: the database, uploads (in its `uploads` folder), Cursor agent stores (in `cursor-agents`), the Claude Code state of DeepSeek chats (in `deepseek-claude`) and, without `COPILOT_WEB_RELAY_LOG_DIR`, the console log (in `logs`). Wins over `dataDir` |
| `COPILOT_WEB_RELAY_LOG_DIR` | Log directory (`relay-console.log`, `worker-<session>.log`, and `server.log`/`server-err.log` when `oar` started the relay in the background) |
| `OAR_NO_CONSOLE_LOG=1` | Keep no copy of the relay's console in `relay-console.log` |
| `OAR_STATE_ROOT` | State root of a global install, instead of `~/.oar` / `%APPDATA%\oar` |
| `OAR_NO_UPDATE_CHECK=1` | Never contact oar.sh, not even for a manual update check |
| `OAR_UPDATE_MANIFEST_URL` | The version manifest the update check and `oar update` read, instead of `https://oar.sh/latest.json` |
| `OAR_HOST_SUSPEND_DRY_RUN=1` | On a Windows relay, **Suspend host** logs the suspend instead of sleeping the machine |
| `OAR_BOOT_REPORTING_WINDOW_MS` | How long after a relay start a suspend is held back while sessions may still be reporting their background work (default `45000`, at most `600000`; `0` switches the wait off) |
| `OAR_MCP_SERVER=0` | Do not attach OAR's MCP server to Grok and the Copilot extension engine; they get the preview instructions as text again, and no `relay_tool` tool |
| `COPILOT_SDK_PATH` | The Copilot CLI runtime's `copilot-sdk` directory, instead of the newest one in the CLI's package cache |
| `COPILOT_PKG_DIR` | An additional Copilot CLI package cache to search |
| `COPILOT_SESSION_STATE_DIR` | The Copilot CLI's `session-state` folder the relay reads and deletes sessions in, instead of `~/.copilot/session-state`; when that folder does not exist, an existing `~/.copilot/session-state` is used instead |
| `COPILOT_CONFIG_HOME` | Copilot's configuration folder, where `oar copilot` installs its web-relay extension wrapper (`extensions/web-relay`), instead of `~/.copilot` |
| `COPILOT_PROVIDER_MAX_PROMPT_TOKENS`, `COPILOT_PROVIDER_MAX_OUTPUT_TOKENS` | Prompt and output token limits (a positive whole number) for OpenAI conversations on Copilot's SDK engine, instead of the ones OAR knows for the model |
| `GH_TOKEN`, `GITHUB_TOKEN` | GitHub token for the Copilot usage card, instead of `gh auth token` |
| `XAI_API_KEY` | Grok authentication instead of the Grok CLI login |
| `GROK_CLI_COMMAND` | The Grok CLI to run, instead of `grok` on `PATH`; `GROK_COMMAND` is read when it is unset. Installing Grok from Settings sets it |
| `CURSOR_SESSION_TOKEN` | Cursor dashboard session token for live plan bars |
| `CURSOR_AGENT_STORE_DIR` | Where Cursor sessions keep their local agent state, instead of `cursor-agents` in the relay's data folder (see `dataDir` and `COPILOT_WEB_RELAY_DATA_DIR`) |
| `CLAUDE_CONFIG_DIR` | Claude configuration directory, instead of `~/.claude`; Claude and Claude API chats share it, and Claude Cloud reads the CLI's login (`.credentials.json`) from it |
| `CLAUDE_CODE_EXECUTABLE` | The Claude Code binary Claude sessions run on. Unset, they run on the Claude Code build that comes with the Agent SDK, not on the host's `claude`; installing, updating or switching the Claude Code CLI from Settings sets it to that CLI (kept in `cliBinaries`); new Claude sessions use it after the next relay restart |
| `CLAUDE_CODE_OAUTH_TOKEN` | A Claude login token, used instead of the CLI's credentials file, by the relay (Claude Cloud settings tab, **Check Usage**, archiving), its Claude Cloud workers and its Claude workers. Only those two kinds of worker get it: under tmux through an owner-only file rather than on their command line, without tmux in the environment they inherit. Every other worker (Copilot, OpenAI, Cursor, Grok, DeepSeek, Claude API) is started without it, on every platform |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | Not passed to any worker, on any platform; under tmux the worker's shell also unsets them, whatever the tmux server or your profile has. A Claude chat runs on the host's Claude login (the CLI's credentials file or `CLAUDE_CODE_OAUTH_TOKEN`), and a Claude API chat on the key saved in **Settings → Providers → Claude API**, never on a key in the relay's environment. The other `ANTHROPIC_*` variables (base URL, headers, model names) do not reach a Claude API chat's Claude Code either |
| `OAR_ANTHROPIC_API_BASE_URL` | For OAR's own tests: a fake Anthropic API on the same machine that the relay's model listing for Claude API and the Claude API workers use instead of `https://api.anthropic.com`. Only a loopback address is accepted; any other value is ignored |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Overrides the Claude auto-compact window |
| `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`, `CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS` | Not read from the relay's environment: OAR sets them for every Claude session it starts, from **Claude background command limit** (the limit, 8 h and 2 min) |
| `OAR_TURN_STALL_IDLE_MS`, `OAR_TURN_STALL_MODEL_MS`, `OAR_TURN_STALL_TOOL_MS` | How long the runtime of a turn may stay silent before the Copilot (SDK engine), Cursor and Grok workers fail the turn: with nothing in flight (default `120000`), during a model request (`300000`), during a tool call (`1800000`). `0` is no limit for that phase, and an idle `0` switches the check off (not on Grok, which then ignores all three variables and uses its default windows); an idle window set alone scales the other two with it. Claude workers only log such a silence (model window `600000`) |
| `OAR_CLAUDE_CLOUD_BRANCH_LOOKUP=off` | Do not list a repository's branches with `git ls-remote` for a new Claude Cloud chat (`0`, `false` and `no` work too) |
| `COPILOT_CLOUDFLARED_MODE`, `COPILOT_CLOUDFLARED_TOKEN`, `COPILOT_CLOUDFLARED_BINARY` | Override `cloudflaredTunnel.mode`, `.token`, and `.binary` |
| `COPILOT_TUNNEL_MARKER_HEADERS` | Extra headers (comma-separated) that mark tunnel traffic, added to `tunnelMarkerHeaders` and `cf-ray` |
| `COPILOT_PREVIEWS_ENABLED`, `COPILOT_PREVIEWS_PORT`, `COPILOT_PREVIEWS_BIND_HOST`, `COPILOT_PREVIEWS_PUBLIC_BASE_URL`, `COPILOT_PREVIEWS_ALLOWED_TARGET_HOSTS` | Override `previews.enabled` (`1`/`true` or `0`/`false`), `.port`, `.bindHost`, `.publicBaseUrl` and `.allowedTargetHosts` (comma-separated) |
| `COPILOT_WORKSPACE_ROOT_ALLOW_LIST` | Same as `workspaceRootAllowList` |
| `COPILOT_REMOTE_<FLAG>` | Pins a feature flag from the **Features** tab (`1`/`0`, `true`/`false`) |
| `OAR_VERSION`, `OAR_CHANNEL`, `OAR_PORT`, `OAR_NODE`, `OAR_DRY_RUN` | Read by the installer scripts, not by the relay (see [macOS and Linux](install.md#macos-and-linux)) |

**Session workers under tmux.** On Linux and macOS with `tmux` installed, the relay starts each session worker in a tmux session of its own and passes it a fixed set of variables: OAR's own paths, the provider's model and key, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_EXECUTABLE`, `GROK_CLI_COMMAND` (also when set as `GROK_COMMAND`), `CURSOR_AGENT_STORE_DIR`, `COPILOT_PROVIDER_MAX_*_TOKENS` and `OAR_MCP_SERVER`. Any other variable of the relay, such as `OAR_TURN_STALL_*_MS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` or `XAI_API_KEY`, reaches such a worker only if the tmux server has it: tmux keeps the environment it was started with (the relay's when the relay started it, yours when you had tmux running already). The worker's login shell adds what your profile (`~/.profile`) exports, so set such variables there. Without tmux (Windows, or no `tmux` on the host) a worker inherits the relay's whole environment. Two kinds of variable never reach a worker: the values of one launch (the worker kind, its model, its folder) go into that session's command only, never into the environment a tmux server started by the relay keeps; and the variables of a Claude Code session the relay itself was started from (`CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_AGENT_SDK_CLIENT_APP`, and every `CLAUDE_CODE_SESSION_*`, `CLAUDE_CODE_*_SESSION_ID` and `CLAUDE_CODE_MESSAGING_*`) are dropped on every path, so no worker's CLI takes itself for a child of that session. Your own settings stay: `CLAUDE_CODE_*` ones such as `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_GIT_BASH_PATH`, the SDK's `CLAUDE_AGENT_SDK_*` switches, and the two that share the session family's prefix, `CLAUDE_CODE_SESSION_START_ANNOUNCEMENTS_BEFORE_PROMPT` and `CLAUDE_CODE_SESSION_LOG`.

Many internal names still say "copilot" (`COPILOT_WEB_RELAY_*`, `copilot.db`) from the project's earlier life; they apply to every runtime.

## API overview

Every authenticated HTTP route accepts `Authorization: Bearer <token>` or the login cookie; the routes are documented in [server/README.md](../server/README.md#api-reference).
