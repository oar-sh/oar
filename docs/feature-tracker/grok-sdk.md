# Grok CLI ACP provider

Updated: 2026-08-31 · Part of the [SDK Feature Tracker](README.md)

There is no first-party npm package equivalent to `@cursor/sdk`. The control surface is
the **Grok CLI Agent Client Protocol** (`grok agent --no-leader stdio`). The worker package
lives in `server/grok-worker/`.

Authentication uses the **relay host's Grok CLI login** (`grok login` or `XAI_API_KEY` in the
host environment). The relay stores no API key — enablement is a settings toggle (Claude-style).
Since 2026-08-31 both halves of "get a working Grok on the host" are drivable from the web UI:
the CLI can be **installed and updated** from the provider panel, and the account can be
**signed in and out** there — see [Account authentication](#account-authentication) and
[CLI install](#cli-install). "Run it on the relay host" is now the fallback, not the only way.

## Turn execution

| Surface | Status | Notes |
| ------- | ------ | ----- |
| `initialize` + `session/new` / `session/load` | Implemented | `createGrokAgentHandle` |
| `session/prompt` streaming | Implemented | `startGrokTurn` merges ACP `session/update` into relay channels |
| `session/cancel` / Stop | Implemented | Control poller `abort_turn` → abort + `session/cancel` |
| Auto permission approve | Implemented | Responds allow-once on `session/request_permission` (allow-all parity; "always" options skipped). Since 2026-08-16 the ACP client itself answers when no turn listener is attached (session/load replays, requests racing prompt settlement) — an unanswered permission request deadlocked the agent |
| Client-hosted terminal + fs (ACP) | Implemented | `acp-host-services.mjs` answers `terminal/create\|output\|wait_for_exit\|kill\|release` and `fs/read_text_file\|write_text_file` — the contract behind the initialize client capabilities. **Advertising a capability without answering its requests deadlocks the agent's turn** (the 2026-08-12 `0117fb12` stall: `terminal/create` waited forever). Unhandled agent→client requests now get JSON-RPC `-32601` so future mismatches fail fast instead of hanging. Windows commands run via pwsh (powershell fallback); output tail-truncated per `outputByteLimit`. |
| Turn stall watchdog | Implemented | `sessionPrompt` fails a turn after 120s without ACP traffic or an absolute ceiling that follows the user's max-turn-duration setting (piggybacked on queue deliveries; 0 = truly unlimited — the old fixed 30-minute cap ignored "No limit"). A running client-hosted terminal defers the inactivity check only while recently active (5-minute window), so a quiet dev server cannot make turns immune to stall detection. Trips classify as `grok.turn-stalled`: partial stream preserved, stall system note, handle recreated. |
| Durable session resume | Implemented | `grok_native_session_id` + `POST /api/grok-native-session`; `session/load` is capability-checked first, and a failed/unsupported load posts a visible system note instead of silently starting a fresh session without the history (2026-08-16) |
| Model discovery | Implemented | From initialize `_meta.modelState` (models, efforts, context windows) with async `grok models` CLI fallback; discovery timeout disposes late-spawned agents |
| Per-message model switch | Not implemented (locked) | ACP has no mid-session switch (model rides `session/new` `_meta` only); relay 409s `GROK_MODEL_REQUIRES_NEW_CONVERSATION`, composer pins the picker |
| Reasoning effort | Partial | Composer effort forwarded on `session/prompt` `_meta.reasoningEffort` (best-effort; live CLI honoring unverified) |
| Attachments / images | Partial | Path notes only (ACP image capability often false) |
| Nested subagent prose | Partial | Lifecycle chips only. Detection keys on the tool name/title (ACP `kind` is the tool *category* and never matches — fixed 2026-08-16); a task/agent-shaped title opens the run |
| Plan boards (`plan_ready`) | Implemented | Text-shape fallback (`countPlanLikeLines` ≥ 2) like Cursor |
| Busy retry | Implemented | One close-and-recreate retry on `grok.agent_busy`, and only before anything streamed — a replay over dispatched frames would duplicate visible text (2026-08-16) |
| Question cards (ask user) | **Not implemented — protocol gap** | ACP exposes no free-form ask-user surface; `session/request_permission` is tool-permission only and is auto-approved. Revisit if the Grok CLI adds one. |
| Empty-turn completion | Implemented | A terminal non-error result with no prose publishes the shared `EMPTY_TURN_COMPLETION_NOTE` instead of requeue-until-cap (2026-08-16) |
| Context usage gauge | Implemented | Per-turn tokens from prompt result `_meta` → `buildGrokContextUsage` → `POST /api/grok-context-usage`; window from discovery meta or static map (unknown models: totals only, no fill metric) |
| Live plan quota (weekly %) | Implemented | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with the host CLI's `~/.grok/auth.json` bearer (`grok-billing-usage.mjs`, fetched best-effort per Check Usage request) → primary percent meter with the weekly reset date, `source: live`. The ACP agent has no quota RPC; `x.ai/auth/check_subscription` is leader-side. Degrades to the estimated view when the CLI is logged out or the proxy is unreachable. |
| Plan usage (Check Usage card) | Implemented | Per-prompt tokens + `costUsdTicks` from `session/prompt` result `_meta` → `POST /api/grok-plan-usage` (route validates the conversation's Grok binding; negative values rejected; full-precision accumulation, display-time rounding). Optional monthly USD allowance ($0 treated as unset) for the estimated meter (secondary when the live quota bar is present); card hidden when Grok disabled. Footer link: https://console.x.ai. **Caveat:** the 1e9 ticks/USD rate cannot be exactly verified for OIDC subscription logins — such accounts have no USD billing (console.x.ai shows nothing; the real quota is the weekly SuperGrok percentage on grok.com → Settings → Usage). A 2026-08-08 magnitude cross-check (~$2.45 tick-USD booked locally vs 25% weekly quota used) supports 1e9 and rules out 1e10; meters stay labeled "estimated". |

## Account authentication

Not an ACP surface: the worker reads whatever `~/.grok/auth.json` the host CLI wrote. The relay now
drives the CLI's own `login` / `logout` subcommands so the account can be switched from a phone.
Implemented 2026-08-31 (plan: `docs/plans/relay-cli-install-and-grok-auth.md` §4.2).

The live probe (Grok Build 1.0.13) is why this is *shorter* than the Claude equivalent rather than a
copy of it: `grok login --device-auth` needs **no pseudo-TTY** (plain piped stdio, stdin ignorable)
and nothing is ever pasted back — the device code rides inside the URL, the CLI polls x.ai itself and
exits 0 once the browser authorises. So the state machine drops a whole state, and there is no
`/login/code` route, no `submitCode()`, and no code-redaction path.

| Surface | Status | Notes / evidence |
| ------- | ------ | ---------------- |
| Login / logout state machine | Implemented (2026-08-31) | `server/services/grok-auth-service.mjs`: one relay-wide, single-flight session (`idle → starting → awaiting_authorization → success/error → idle`), 10-minute hard timeout, idempotent start. The device URL is scraped off **completed lines only** (a chunk boundary mid-URL would otherwise latch a truncated link the state machine never revises) and pinned to `accounts.x.ai/oauth2/device`; the code is preferred from the URL's `user_code`, with the bare `XXXX-XXXX` line as fallback. The binary comes from the same `GROK_CLI_COMMAND` / `GROK_COMMAND` chain the worker and the discovery probe use, so auth and turn execution can never address two different binaries. |
| Status detection | Implemented (2026-08-31) | **There is no `grok auth status`** — `grok models` prints "You are not authenticated." and still exits 0, so the exit code carries nothing. The authoritative signal is `~/.grok/auth.json`, read through the existing `readGrokCliAuthKey()` (`grok-billing-usage.mjs`) rather than a second reader, so the account row and the usage card agree on what "signed in" means. 5 s TTL cache, forced re-read after login/logout. An elapsed token expiry is a *hint* ("may need a new sign-in"), not a signed-out verdict: the CLI refreshes in place. The plan label and weekly quota come from the same best-effort billing proxy the usage card uses, and are suppressed entirely when CLI spawns are disabled. |
| Routes | Implemented (2026-08-31) | Behind the existing auth middleware in `sessions-routes.mjs`: `GET /api/grok/auth/status` (status + login state + `runningGrokWorkers`), `POST /api/grok/auth/login/start`, `POST /api/grok/auth/login/cancel`, `POST /api/grok/auth/logout` (**409** while a login session is active). `runningGrokWorkers` comes from `countRunningWorkersForProvider`, the provider-generalised form of the old Claude-only counter. |
| Socket push | Implemented (2026-08-31) | Every transition broadcasts `grok_auth_state` (`io.emit`, same payload as `GET status`), so a sign-in started on one device finishes on another, the UI needs no polling while the user authorises, and the flow survives closing the modal (`socket-handlers.js` → `applyGrokAuthState`). Transitions are emitted off the *cached* status: building them around a fresh read would park the `awaiting_authorization` push — the one carrying the URL — behind the billing fetch. |
| Post-login hooks | Implemented (2026-08-31) | On success the relay re-runs `refreshGrokProviderModels()` (ACP `initialize` fails while logged out, so discovery repopulates the pickers without a restart) and emits `models_updated` + `grok_settings_updated`. Running workers are deliberately left alone — they keep the token they launched with. |
| Settings UI | Implemented (2026-08-31) | `server/public/app/grok-auth-ui.js` in the Grok sub-tab: account row, **Sign in** → device URL as a link plus **Copy link** and the `XXXX-XXXX` code shown for confirmation against the browser, and **Sign out** behind a confirmation naming the account and the running-worker count. Every visible state comes from the broadcast, so rendering is idempotent and an out-of-order payload cannot rewind it (`isStaleLoginPayload`). |
| Secret handling | n/a by design | Nothing secret transits the relay: the `user_code` is public by design (it is printed on a terminal and typed into a browser), and the token is written by the CLI straight into `~/.grok/auth.json` (0600). The shared secret scrub still runs over any surfaced error tail. |
| Error-path CTA | Implemented (2026-08-31) | `grok.cli_missing` and `grok.authentication_failed` reach the transcript as `relay.grok-cli-missing` / `relay.grok-authentication-failed`, and `relay-error-ctas.mjs` turns those stable codes into **Install Grok CLI** / **Sign in to Grok** buttons plus a **Grok settings** deep link on the failed bubble (`conversation-view.js` → `runRelayErrorCta`). Both messages were reworded to point at the panel instead of a host shell. |
| Testing | Implemented (2026-08-31) | Unit: `grok-auth-service.test.mjs` drives the state machine through an injected `spawnImpl` (no real children, so it runs on Windows), plus `sessions-routes-grok-auth.test.mjs` and the jsdom `grok-auth-ui.test.mjs`. E2E: `server/services/fixtures/grok-stub.sh` stands in for the CLI (`GROK_CLI_COMMAND`, wired in `tests/relay-server-harness.mjs`), printing the real banner byte-for-byte — grey SGR line included — and exiting when a sentinel file appears, which is the test's stand-in for authorising in a browser. `tests/grok-auth.spec.mjs` drives the whole flow through the real UI. The e2e server keeps `COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN` on; the service excepts it only when `COPILOT_WEB_RELAY_GROK_AUTH_ALLOW_STUB_SPAWN` **and** an explicit binary override are both set, so the host's real `grok` can never be reached from a test — least of all by `grok logout`. |

## CLI install

The dead end that prompted it: a Grok turn fails with `relay.grok-cli-missing` and the only fix used
to be a shell on the relay host — the exact thing the relay exists to avoid. The relay now runs the
vendor's own install one-liner itself. Shared with Claude and read-only for Copilot; the service is
`server/services/cli-install-service.mjs` (plan §4.1/§4.3).

| Surface | Status | Notes / evidence |
| ------- | ------ | ---------------- |
| Install / update | Implemented (2026-08-31) | `curl -fsSL https://x.ai/cli/install.sh \| bash` (POSIX) / `irm https://x.ai/cli/install.ps1 \| iex` (Windows), frozen literals in the descriptor table — a request body carries only a descriptor id and an action name, and an unknown id is a 400 before any spawn is considered. Update is `grok update`, never a re-run of the installer: the CLI reports `installer: "internal"` and self-updates. Relay-wide single flight, 10-minute timeout with SIGTERM→SIGKILL escalation, detached process group so the whole `bash -lc 'curl … \| bash'` tree can be signalled. |
| Detection | Implemented (2026-08-31) | Node has no `which`, so PATH plus `~/.grok/bin`, `~/.local/bin`, `/usr/local/bin` are walked by hand (PATHEXT on Windows), with the symlink resolved — `realPath` under `…/node_modules/…` is what classifies an npm global. `grok update --check --json` supplies `updateAvailable` / `latestVersion`; its exit code is ignored because it is 0 either way. Every scrape degrades: an unparseable `--version` renders as "installed (version unknown)" rather than hiding the install, and success is decided by exit code **plus a post-install resolve**, never by parsing installer output. |
| Binding without a restart | Implemented (2026-08-31) | The resolved absolute path is persisted as `cliBinaries` in `config.json` (read-modify-write, tmp-file+rename, and a read that fails is never followed by a write — a blind rewrite would drop the auth token) and applied in-process to `GROK_CLI_COMMAND` / `CLAUDE_CODE_EXECUTABLE`, with the bound binary's own directory hoisted onto the relay's PATH so the ACP adapter's `command: 'grok'` default resolves the same copy. Re-applied at boot. Running workers keep the binary they launched with. `CLAUDE_CODE_EXECUTABLE` was also added to the tmux worker env allowlist, where it had been silently dropped. |
| Streamed log | Implemented (2026-08-31) | Output is escape-stripped before it is retained, capped at 16 KB, and broadcast as `cli_install_state` with a monotonic `logSeq`, so a client connecting mid-install renders the whole retained buffer rather than a suffix. Log broadcasts are coalesced (~250 ms) because a progress-bar installer emits a chunk per frame; state transitions — including the terminal one — always emit immediately with the complete log. |
| npm-global-not-writable | Implemented (2026-08-31) | `claude doctor` is parsed for `Running: <method> (<version>)`, `Path:` and its warnings. When an npm-global Claude can no longer auto-update, the row quotes the warning verbatim and the primary button becomes **Switch to native installer** (`claude install`) — Anthropic's own prescribed fix — with the shadowing consequence spelled out. Never offered otherwise, so a second Claude is never installed implicitly. |
| Copilot | Read-only by design | The Copilot CLI is npm-global under a prefix the relay user cannot write, so an Install button could only ever fail. The row reports version and path and says "managed with npm on this host" (plan §2.5). |
| Cursor | Out of scope | `@cursor/sdk` is a pure npm package; the relay never invokes a `cursor-agent` binary, so an install button would install a CLI nothing runs (plan §2.4). Adding it later is one descriptor entry. |
| Testing | Implemented (2026-08-31) | Unit: `cli-install-service.test.mjs` + `cli-process-runner.test.mjs` + the jsdom `cli-install-ui.test.mjs`. E2E: `tests/cli-install.spec.mjs` drives not-installed → confirm → streamed log → installed, the Update path, the native-installer migration, and the chat-error CTA, against `server/services/fixtures/cli-install-stub.sh`. **The isolation lever is `COPILOT_WEB_RELAY_CLI_BIN_DIR`** (`tests/relay-server-harness.mjs`): it *replaces* PATH and the descriptor dirs, because an isolated relay still inherits the host PATH (it runs `node`) and would otherwise report — and, with the stub-spawn pair set, actually execute — the developer's own grok/claude/copilot. |

## Relay integration

- `provider_type: 'grok'`
- Worker kind `COPILOT_WEB_RELAY_WORKER_KIND=grok` → `grok-session-worker.mjs`
- Settings `GET/POST /api/settings/grok` + socket `grok_settings_updated`
- Account auth `GET /api/grok/auth/status`, `POST /api/grok/auth/login/start|login/cancel|logout` + socket `grok_auth_state`
- CLI install `GET /api/cli/status`, `POST /api/cli/install`, `POST /api/cli/install/cancel` + socket `cli_install_state` (shared with Claude/Copilot)
- Catalog layer `buildModelCatalogWithGrokProvider` (outermost onion after cursor)

## Known gaps

- **The update confirm sheet does not name the running-worker count.** Plan §9's risk row says it
  should (same as the sign-out dialog), but `/api/cli/status` carries no worker counts — only
  `/api/grok/auth/status` has `runningGrokWorkers` — so the sheet renders a generic "sessions
  already running keep the binary they launched with" line instead. Fixing it means adding
  per-provider counts to the CLI status payload; the wording is honest today, just not specific.
- `grok login --oauth` (the loopback-browser variant) and the enterprise `GROK_OIDC_*` /
  `GROK_DEPLOYMENT_KEY` paths are not wired; device-code covers the relay use case.
- No uninstall or version-pinning UI. The descriptors support `bash -s <version>` and
  `GROK_CHANNEL`, but nothing surfaces them.
