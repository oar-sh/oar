# Grok CLI ACP provider

Updated: 2026-08-16 · Part of the [SDK Feature Tracker](README.md)

There is no first-party npm package equivalent to `@cursor/sdk`. The control surface is
the **Grok CLI Agent Client Protocol** (`grok agent --no-leader stdio`). The worker package
lives in `server/grok-worker/`.

Authentication uses the **relay host's Grok CLI login** (`grok login` or `XAI_API_KEY` in the
host environment). The relay stores no API key — enablement is a settings toggle (Claude-style).

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

## Relay integration

- `provider_type: 'grok'`
- Worker kind `COPILOT_WEB_RELAY_WORKER_KIND=grok` → `grok-session-worker.mjs`
- Settings `GET/POST /api/settings/grok` + socket `grok_settings_updated`
- Catalog layer `buildModelCatalogWithGrokProvider` (outermost onion after cursor)
