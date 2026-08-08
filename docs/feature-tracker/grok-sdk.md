# Grok CLI ACP provider

Updated: 2026-08-08 · Part of the [SDK Feature Tracker](README.md)

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
| Auto permission approve | Implemented | Responds allow-once on `session/request_permission` (allow-all parity; "always" options skipped) |
| Durable session resume | Implemented | `grok_native_session_id` + `POST /api/grok-native-session` |
| Model discovery | Implemented | From initialize `_meta.modelState` (models, efforts, context windows) with async `grok models` CLI fallback; discovery timeout disposes late-spawned agents |
| Per-message model switch | Not implemented (locked) | ACP has no mid-session switch (model rides `session/new` `_meta` only); relay 409s `GROK_MODEL_REQUIRES_NEW_CONVERSATION`, composer pins the picker |
| Reasoning effort | Partial | Composer effort forwarded on `session/prompt` `_meta.reasoningEffort` (best-effort; live CLI honoring unverified) |
| Attachments / images | Partial | Path notes only (ACP image capability often false) |
| Nested subagent prose | Partial | Lifecycle chips for agent/task tools only |
| Plan boards (`plan_ready`) | Implemented | Text-shape fallback (`countPlanLikeLines` ≥ 2) like Cursor |
| Busy retry | Implemented | One close-and-recreate retry on `grok.agent_busy` (Cursor parity) |
| Context usage gauge | Implemented | Per-turn tokens from prompt result `_meta` → `buildGrokContextUsage` → `POST /api/grok-context-usage`; window from discovery meta or static map (unknown models: totals only, no fill metric) |
| Live plan quota (weekly %) | Implemented | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with the host CLI's `~/.grok/auth.json` bearer (`grok-billing-usage.mjs`, fetched best-effort per Check Usage request) → primary percent meter with the weekly reset date, `source: live`. The ACP agent has no quota RPC; `x.ai/auth/check_subscription` is leader-side. Degrades to the estimated view when the CLI is logged out or the proxy is unreachable. |
| Plan usage (Check Usage card) | Implemented | Per-prompt tokens + `costUsdTicks` from `session/prompt` result `_meta` → `POST /api/grok-plan-usage` (route validates the conversation's Grok binding; negative values rejected; full-precision accumulation, display-time rounding). Optional monthly USD allowance ($0 treated as unset) for the estimated meter (secondary when the live quota bar is present); card hidden when Grok disabled. Footer link: https://console.x.ai. **Caveat:** the 1e9 ticks/USD rate cannot be exactly verified for OIDC subscription logins — such accounts have no USD billing (console.x.ai shows nothing; the real quota is the weekly SuperGrok percentage on grok.com → Settings → Usage). A 2026-08-08 magnitude cross-check (~$2.45 tick-USD booked locally vs 25% weekly quota used) supports 1e9 and rules out 1e10; meters stay labeled "estimated". |

## Relay integration

- `provider_type: 'grok'`
- Worker kind `COPILOT_WEB_RELAY_WORKER_KIND=grok` → `grok-session-worker.mjs`
- Settings `GET/POST /api/settings/grok` + socket `grok_settings_updated`
- Catalog layer `buildModelCatalogWithGrokProvider` (outermost onion after cursor)
