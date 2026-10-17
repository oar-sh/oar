# Settings and configuration

Every setting in the web UI, every key of the config file, and every environment variable. This is the detail behind the [README](../README.md#documentation); the most complete guide is [Reference on oar.sh](https://oar.sh/docs/reference/).

## Settings (⚙️ in the web UI)

*On oar.sh: [Settings](https://oar.sh/docs/reference/settings/)*

The modal is organised into seven tabs — **General**, **Providers** (with a **Copilot**, **OpenAI**, **Claude**, **Claude Cloud**, **Grok**, and **Cursor** sub-tab), **Relays**, **Previews**, **Sharing**, **Notifications**, and **Features** — and reopens on the tab you used last. The `⋯` menu opens it with no conversation open too, so a fresh install can turn on a provider before the first chat; until a provider is ready, the empty screen and **New Chat** point to Settings → Providers. Unless noted as per browser, these settings live in the relay database rather than the config file, and apply to every browser that connects:

| Tab | Setting | Default | What it does |
| --- | ------- | ------- | ------------ |
| General | Theme, Text scaling | dark theme | Per browser |
| General | Show Suspend host action | on | Per browser: shows **💤 Suspend host** in the conversation menu |
| General | Jump to the end when I send a message | on | Per browser: sending a message takes you to the end of the conversation; off, you stay where you are reading (see [While a turn runs](web-ui.md#while-a-turn-runs)) |
| General | Max turn duration | `60 min` | Hard cap on how long one turn may run before the relay requeues it (0 = no limit, up to 10 h; see below) |
| General | Background task timeout | `4 h` | How long background tasks alone may keep a Claude or Copilot session running after its reply; then they are stopped (0 = no limit, up to 10 h) |
| General | Keep sub-agent tool output | `90 days` | 7, 14, 30 or 90 days, or always: once a finished sub-agent's record is older, its tool inputs and results are removed (once a day); its thoughts, reply and the one-line summary of each tool call stay |
| General | Autostart (Windows) | Off | *At sign-in* (a visible terminal after you log on) or *At system startup* (headless, no logon needed, one admin confirmation) |
| General | Relay name | `OAR` (the hostname for paired relays) | Label of the installed PWA on every device, and this relay's name for [paired relays](agents-together.md#remote-relays) |
| General | Check for updates automatically | off | Opt-in: the relay asks oar.sh for the latest version about twice a day. **Check for updates** works regardless; `OAR_NO_UPDATE_CHECK=1` blocks both |
| General | Default CWD for new sessions | relay workspace root | Working directory for newly created sessions that have none of their own |
| Providers | Copilot engine | SDK | Extension when this relay cannot run the SDK engine (see [engine choice](providers.md#github-copilot--engine-choice)) |
| Providers | OpenAI API key / model / base URL | — / `gpt-4o` / `https://api.openai.com/v1` | Enables the OpenAI and OpenAI Image providers |
| Providers | Claude (Agent SDK) | off | Enables Claude as a New Chat provider and runs model discovery; default model `claude-sonnet-5` |
| Providers | Claude account (Relogin / Logout) | host login | Switches the Claude account the relay host's CLI uses, from the browser (see [Claude (Agent SDK)](providers.md#claude-agent-sdk)) |
| Providers | Claude Cloud | off | Enables Claude Cloud as a New Chat provider, and the live account figures in **Check Usage**; the switch is the consent to use the Claude CLI's login (see [Claude Cloud](providers.md#claude-cloud)) |
| Providers | Claude Cloud environment / default model | first active environment of the account / `claude-sonnet-5-5` | The cloud environment new cloud sessions run in, and the model a new cloud chat starts with |
| Providers | Cursor API key / model | — / `composer-2.5` | Enables Cursor; plus monthly plan allowances and the optional dashboard session token |
| Providers | Grok | off | Enables Grok; default model `grok-4.5`; **Sign in** / **Sign out**; optional monthly allowance |
| Relays | Public address, Accept prompts from other relays' agents | browser address / on | How paired relays reach this one, and whether their agents may prompt sessions here (see [Remote relays](agents-together.md#remote-relays)) |
| Relays | Agent sessions: Agents may start and use sessions on this relay | off | Lets agents on this relay start and use other sessions here with the `remote_relay` tool; the first session an agent starts in a conversation asks for your approval (see [Agent sessions](agents-together.md#agent-sessions)) |
| Relays | Agent sessions: Longest wait per tool call | `10 min` | How long one `remote_relay` call may wait for a reply (2 to 60 minutes), on this relay and on paired ones; adjustable whether or not the switch above is on |
| Relays | Remote relays | — | Pair a relay by pasting its web address; per relay **Agents may** read only, read and prompt, or do everything |
| Previews | Live previews | — | Lists the published previews with when each was published and last opened, each of which you can close, and those the relay could not check at its start as not served (see [Preview servers](preview-servers.md)) |
| Sharing | Shared conversations | — | Every shared link with **Copy link**, **Renew link**, **Stop sharing** and its access log (see [Sharing](web-ui.md#sharing)) |
| Sharing | Store viewer IP addresses | on | Whether the access log of shared links keeps the viewer's IP address |
| Sharing | Paths and file names | hide the path, show the file name | What shared links show of the relay host's paths: every path and file name, the file name only, or neither |
| Notifications | Push notifications | off | Per device: which events notify, and whether titles and message previews are included |
| Features | Feature flags | see below | **Session worker routing** (on), **Continuation answer routing** (on), **Generated-image continuity** (on), and a reserved **Worker fallback restart** (off, no effect yet). Changes apply after a relay restart; a `COPILOT_REMOTE_<FLAG>` environment variable pins a flag, e.g. `COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED=0` |

## How a stuck turn is detected

*On oar.sh: [Turns and the queue](https://oar.sh/docs/sessions/turns-and-the-queue/)*

Two independent guards, both of which exempt a turn that is waiting on an unanswered question card:

1. **Inactivity** — a turn is only considered stale after `processingTimeoutMs` with no sign of life from its worker. Worker heartbeats name the message they are working on, so a turn that legitimately runs for an hour of tool calls keeps resetting this window.
2. **Max turn duration** — an absolute ceiling on elapsed time, set with the Settings slider (0 = no limit, up to 10 hours). This exists purely to catch a worker that has hung while still heartbeating.

When either trips, the turn is returned to the queue rather than lost.

## Configuration reference (`server/config.json`)

*On oar.sh: [config.json](https://oar.sh/docs/reference/config-json/)*

The config file is `server/config.json` in a git checkout and `~/.oar/config.json` (`%APPDATA%\oar\config.json`) for a global install; `COPILOT_WEB_RELAY_CONFIG` points the relay at another file. It holds the auth token, so the relay keeps it owner-only. The relay reads it at startup: restart the relay after editing it.

| Key                        | Default              | Description                                                               |
| -------------------------- | -------------------- | ------------------------------------------------------------------------- |
| `authToken`                | generated if empty   | Required for API/UI auth. If empty, the relay generates a random token on every start and prints it to its log without saving it; `oar setup` writes a stable one |
| `port`                     | `3333`               | HTTP + WebSocket port                                                     |
| `localhostOnly`            | `true`               | Bind only to loopback (`127.0.0.1`) and disable LAN/WAN access            |
| `dataDir`                  | `data/` beside the server | Database and uploads; a relative path resolves against the config file's directory. `COPILOT_WEB_RELAY_DATA_DIR` wins, and global installs started by `oar` use `~/.oar/data` |
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
| `cloudflaredTunnel.mode`   | `disabled`           | Cloudflare tunnel mode (`disabled` or `managed`; `enabled: true` is a legacy alias for `managed`) |
| `cloudflaredTunnel.required` | `false`            | Pause dequeue while the managed Cloudflare tunnel is disconnected         |
| `cloudflaredTunnel.token`  | —                    | The tunnel token from your own Cloudflare Zero Trust tunnel               |
| `cloudflaredTunnel.binary` | `cloudflared`      | Path or command name of the `cloudflared` you installed; defaults to `cloudflared` on `PATH` |
| `cloudflaredTunnel.extraArgs` | `[]`              | Extra arguments appended to `cloudflared tunnel run`                      |
| `previews.enabled`         | `false`              | Publish local dev servers on a separate listener (see [docs/preview-servers.md](preview-servers.md)) |
| `previews.port`            | `port + 1`           | Loopback port for the preview listener; `0` picks an ephemeral port        |
| `previews.bindHost`        | `127.0.0.1`          | Bind address; non-loopback needs `previews.allowPublicBind`                |
| `previews.publicBaseUrl`   | —                    | Public base URL on a hostname **different** from the relay's               |
| `previews.allowedTargetHosts` | `[]`              | Upstreams allowed beyond loopback (container/VM IPs)                       |
| `previews.maxLive`         | `8`                  | Maximum simultaneously published previews                                  |
| `pushVapidSubject`         | `mailto:copilot-remote@example.com` | Contact URI the relay sends to push services with Web Push requests |
| `sharedPresenceMaxPerConversation` | `200`        | Most live viewers counted per shared conversation; caps the watcher count only, not who can read the link |
| `sharedPresenceMaxGlobal`  | `5000`               | Most live shared-link viewers counted in total; same, not an access limit  |
| `cliBinaries`              | *(written by the relay)* | Provider CLI paths resolved after an install from Settings, restored at startup |
| `restartGracefulTimeoutMs` | `8000`               | Graceful restart wait before force fallback                               |
| `restartShutdownTimeoutMs` | `45000`              | Drain timeout while waiting for active queue job completion               |
| `restartSpawnTimeoutMs`    | `18000`              | Max wait for resume/restart phase per attempt                             |
| `restartRebindTimeoutMs`   | `20000`              | Max wait for rebind/session-sync completion per attempt                   |
| `restartMaxAttempts`       | `3`                  | Bounded restart attempts before terminal exhaustion                       |
| `restartRetryBackoffMs`    | `[1000,3000,7000]`   | Deterministic retry backoff schedule in milliseconds                      |

## Environment variables

*On oar.sh: [Environment variables](https://oar.sh/docs/reference/environment-variables/)*

| Variable | Effect |
| -------- | ------ |
| `COPILOT_WEB_RELAY_CONFIG` | Config file to use |
| `COPILOT_WEB_RELAY_DATA_DIR` | Data directory (database and uploads) |
| `COPILOT_WEB_RELAY_LOG_DIR` | Log directory |
| `OAR_STATE_ROOT` | State root of a global install, instead of `~/.oar` / `%APPDATA%\oar` |
| `OAR_NO_UPDATE_CHECK=1` | Never contact oar.sh, not even for a manual update check |
| `OAR_HOST_SUSPEND_DRY_RUN=1` | **Suspend host** logs the suspend instead of sleeping the machine |
| `OAR_BOOT_REPORTING_WINDOW_MS` | How long after a relay start a suspend is held back while sessions may still be reporting their background work (default `45000`, at most `600000`; `0` switches the wait off) |
| `OAR_MCP_SERVER=0` | Do not attach OAR's MCP server to Grok and the Copilot extension engine; they get the preview instructions as text again, and no `remote_relay` tool |
| `COPILOT_SDK_PATH` | The Copilot CLI runtime's `copilot-sdk` directory, instead of the newest one in the CLI's package cache |
| `COPILOT_PKG_DIR` | An additional Copilot CLI package cache to search |
| `GH_TOKEN`, `GITHUB_TOKEN` | GitHub token for the Copilot usage card, instead of `gh auth token` |
| `XAI_API_KEY` | Grok authentication instead of the Grok CLI login |
| `CURSOR_SESSION_TOKEN` | Cursor dashboard session token for live plan bars |
| `CLAUDE_CONFIG_DIR` | Claude configuration directory, instead of `~/.claude`; Claude Cloud reads the CLI's login (`.credentials.json`) from it |
| `CLAUDE_CODE_OAUTH_TOKEN` | A Claude login token for Claude Cloud, used instead of the CLI's credentials file, by the relay (settings tab, **Check Usage**, archiving) and by its cloud workers. Under tmux the relay hands it to cloud workers only, through an owner-only file; a worker started without tmux inherits the relay's environment as it is |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Overrides the Claude auto-compact window |
| `COPILOT_CLOUDFLARED_MODE`, `COPILOT_CLOUDFLARED_TOKEN`, `COPILOT_CLOUDFLARED_BINARY` | Override `cloudflaredTunnel.mode`, `.token`, and `.binary` |
| `COPILOT_WORKSPACE_ROOT_ALLOW_LIST` | Same as `workspaceRootAllowList` |
| `COPILOT_REMOTE_<FLAG>` | Pins a feature flag from the **Features** tab (`1`/`0`, `true`/`false`) |

Many internal names still say "copilot" (`COPILOT_WEB_RELAY_*`, `copilot.db`) from the project's earlier life; they apply to every runtime.

## API overview

Every authenticated HTTP route accepts `Authorization: Bearer <token>` or the login cookie; the routes are documented in [server/README.md](../server/README.md#api-reference).
