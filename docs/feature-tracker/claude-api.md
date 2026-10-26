# Claude API provider

Updated: 2026-10-25 · Part of the [SDK Feature Tracker](README.md)

The Claude API provider (`claude-api`, shown as "Claude API") runs Claude chats on an API key from the Claude
Console instead of the host's Claude subscription. Like DeepSeek, it runs the **Claude worker's runner**
(`server/claude-worker/claude-session-process.mjs`) with a backend
(`server/claude-api-worker/claude-api-backend.mjs`). The backend sets `claudeModels: true`, so models, effort,
thinking, `[1m]` variants, images and sub-agent models are exactly the Claude chat's. Every runner feature of a
Claude chat is therefore a Claude API feature too, unless a row below says otherwise. The worker entry is
`server/claude-api-worker/claude-api-session-worker.mjs`, which runs `claude-session-worker-main.mjs`.

Authentication is **an API key in the provider settings** (`claude_api_key`;
`services/claude-api-settings-service.mjs`). It is never returned by `GET /api/settings/claude-api`. It reaches only
Claude API workers, as `OAR_CLAUDE_API_KEY` through the secret env file under tmux (`WORKER_SECRET_ENV_VAR_KINDS`).
Inside the worker it becomes the CLI's `ANTHROPIC_API_KEY`, and only in the CLI's spawn env. The relay itself uses
the key for one call only: `GET /v1/models` (`shared/anthropic-api.mjs`). Claude API chats share the host's
Claude Code folder (`CLAUDE_CONFIG_DIR`, `~/.claude`) with subscription chats: the same skills, plugins, MCP servers
and transcripts. That is what lets one chat move between the two billings.

## Key and settings

| Surface | Status | Notes |
| ------- | ------ | ----- |
| Settings tab | Implemented (2026-10-25) | Settings → Providers → Claude API (`server/public/app/claude-api-settings-ui.js`): the key, the switch, the default model, the model list and the monthly cap. The key field is never filled; the tab only says a key is saved. Commit attribution, the background command limit, effort levels and the compaction window are the Claude tab's, and a link says so |
| Settings storage | Implemented (2026-10-25) | `app_settings`: `claude_api_key`, `claude_api_enabled`, `claude_api_model`, `claude_api_models`, `claude_api_enabled_models`, `claude_api_monthly_cap_usd`. `describe()` never includes the key. Saving a key switches the provider on |
| Key check | Implemented (2026-10-25) | `classifyClaudeApiKey`: printable ASCII, 8 to 512 characters, starting with `sk-ant-`. Refused by prefix: `sk-ant-oat` and `sk-ant-ort` (Claude login tokens), `sk-ant-admin` (Admin keys), `sk-ant-sid` and `sk-ant-si-` (session tokens), `sk-ant-cc-` (Claude Code session access) and `sk-ant-ccsr-` (remote session credentials). A refusal is a 400 with the code `claude-api-key-<kind>`. No error quotes the key |
| Key rotation | Implemented (2026-10-25) | A changed key deletes the discovered models and stops the live Claude API workers (`stopLiveProviderWorkersForKeyRotation`) |
| Key removal | Implemented (2026-10-25) | Refused with 409 `claude-api-key-removal-blocked` while Claude API chats exist: chats bound to the provider with messages or queued rows, chats with rows still stamped `claude-api`, or live key workers. Switching the provider off is the way. On removal or switch-off, unstarted Claude API chats move back to the default provider |
| Anthropic refuses the key | Implemented (2026-10-25) | The key stays saved. `POST /api/settings/claude-api` returns `discoveryError`, and the tab shows "API key saved, but Anthropic refused it: …" until a discovery succeeds. The status lives in the page only; it is not stored on the relay |
| Model discovery | Implemented (2026-10-25) | `GET /v1/models` with `x-api-key` and `anthropic-version: 2023-06-01`, pages of 1000, up to 20 pages, 10 s timeout. It runs on key save, on switching the provider on, on a save while no list is stored, and on **Refresh models** (`POST /api/model-variants/refresh`). A failure keeps the stored list. An answer for a key that changed meanwhile is dropped (`claude-api-key-changed`). Errors (`unauthorized`, `forbidden`, `billing`, `rate_limited`, `transient`) have the key taken out |
| Model list | Implemented (2026-10-25) | `offeredModels`: the discovered models, each with a `[1m]` variant when its window is at least the long-context size or the Claude tab lists one. Before the first discovery, the Claude tab's list, with the note "Not listed by Anthropic yet". Default model: the Claude tab's default if offered, else the first Sonnet, else the first |
| Effort levels | Implemented (2026-10-25) | Per model from discovery: `none` only for a model that reports no effort support, else its reported levels plus Ultracode (`withClaudeUltracodeTier`); without discovery data, the Claude tab's levels |
| Context window | Implemented (2026-10-25) | From the discovered `max_input_tokens`; a base model whose `[1m]` variant is offered is capped at the default window |
| Base URL | Not implemented | The key goes to `https://api.anthropic.com` only. `OAR_ANTHROPIC_API_BASE_URL` is honoured on a loopback address only, for tests (`loopbackBaseUrlOrNull`). There is no base-URL setting |

## Turn execution

| Surface | Status | Notes |
| ------- | ------ | ----- |
| Turns, streaming, thoughts, tools, question cards, plan boards, sub-agents, steering, Stop, background tasks | Implemented (2026-10-25) | The Claude runner unchanged; see [claude-sdk.md](claude-sdk.md) |
| Worker launch | Implemented (2026-10-25) | `applyClaudeApiProviderEnvironment` sets `COPILOT_WEB_RELAY_WORKER_KIND=claude-api`, `OAR_CLAUDE_API_KEY` and `CLAUDE_API_RELAY_MODEL`. Host `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` reach no worker of any kind (`withoutForeignWorkerSecrets`) |
| CLI environment | Implemented (2026-10-25) | `claudeApiCliEnv` drops the OAuth token variables, the Bedrock, Vertex and Foundry switches, the sub-agent model and effort pins, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, the host's Claude session variables, and every `ANTHROPIC_*`, `COPILOT_WEB_RELAY_*`, `COPILOT_PROVIDER_*`, `DEEPSEEK_*`, `CLAUDE_GATEWAY_*` and `OAR_*` variable. It then sets `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` |
| Settings pin | Implemented (2026-10-25) | `claudeApiFlagSettings` on the `--settings` argv (no key in it): `disableAllHooks: true`, `env.ANTHROPIC_BASE_URL`, a blank `env.ANTHROPIC_AUTH_TOKEN` and a blank `apiKeyHelper`. `claudeApiLiveFlagSettings` repeats the layer with the key and the 68 routing and trust names of `CLAUDE_CLI_PINNED_ENV` (`server/claude-worker/claude-cli-pinned-env.mjs`: endpoints, provider switches, credentials, proxies, TLS), over stdin before the first message. User, project and local settings cannot redirect the key. Managed settings still outrank the layer |
| Hooks | Implemented (2026-10-25) | Off in key chats (`CLAUDE_CLI_KEY_CHAT_SETTINGS`): no user, project, local or plugin hook and no status line command runs, and a settings file's `disableAllHooks: false` cannot turn them back on. Hooks in managed settings still run. Subscription chats are unchanged |
| Key source check | Implemented (2026-10-25) | `checkClaudeApiInit`: `apiKeySource` on `system/init` must be `ANTHROPIC_API_KEY`. Anything else stops the turn with `claude-api-key-source`. The CLI sends its first request 50 to 90 ms after the init, so the note says that at most one request may have gone out |
| Subscription key check | Implemented (2026-10-25) | The reverse, for subscription chats (`server/claude-worker/claude-subscription-key-check.mjs`): a turn whose source is `ANTHROPIC_API_KEY`, `apiKeyHelper` or `/login managed key` is stopped with `subscription-key-source`. An unknown source is logged and the turn goes on |
| Failures | Implemented (2026-10-25) | `describeClaudeApiFailure`, in this order: "credit balance is too low" → `claude-api-credit`; "API usage limits" or `enforced_spend_limit_reached` → `claude-api-spend-limit`; 402 or `billing_error` → `claude-api-billing`; 401/403, `authentication_error`, `permission_error` or "invalid x-api-key" → `claude-api-key`; 429/529, `rate_limit_error` or `overloaded_error` → `claude-api-rate-limit`. Every failure prints as `relay.claude-api-<code>` |
| Failure buttons | Implemented (2026-10-25) | `relay-error-ctas.mjs`: `claude-api-not-configured` and `claude-api-cap-reached` get **Claude API settings** and **Switch to subscription**; `claude-api-key` and `claude-api-key-source` get **Claude API settings**; `claude-api-credit` gets **Add funds** and **Claude API settings**; `claude-api-billing` gets **Console billing**; `claude-api-spend-limit` and `claude-api-rate-limit` get **Console limits**. On a refused New Chat, Switch reads **Start on subscription** (`newChatClaudeApiRefusalActions`) |
| Claude plan usage / usage limit | Not applicable | `reportsPlanUsage` / `reportsUsageLimit` are false, and the backend has no `usageRoute`. Claude API chats are never paused by the subscription usage limit (`usage-limit-pause-service.mjs`) |
| Secret redaction | Implemented (2026-10-25) | `worker-secret-redaction.mjs`: the saved key's text becomes `[redacted]` in everything a worker posts (requests with `X-Relay-Session-Id`), including a stream update that ends in the start of the key, and up to 16 keys rotated out since the relay started. Settings routes are never rewritten. Task output read from files goes through `cleanTaskOutput`. The worker's own log is redacted too (`installWorkerLogRedaction`) |

## Billing switch

| Surface | Status | Notes |
| ------- | ------ | ----- |
| Composer toggle | Implemented (2026-10-25) | `#claude-billing-toggle` (`claude-billing-toggle.mjs`), under the lock note: **Subscription** / **API key**. Shown in Claude and Claude API chats while Claude API has a key and is on; a chat on the key keeps it when the provider is switched off. It warns that the first turn on the key has no prompt cache and costs more, and says when the switch waits (a running turn, an open question, a compaction, background tasks) |
| Switch route | Implemented (2026-10-25) | `POST /api/conversation/:id/billing` with `to` (`claude` or `claude-api`), `by` (`user`, `agent`, `usage-limit`) and an optional `message` sent in the same transaction. `checkSwitch` refuses with `CLAUDE_BILLING_INVALID`, `CONVERSATION_NOT_FOUND`, `CLAUDE_BILLING_NOT_CLAUDE`, `CLAUDE_API_NOT_CONFIGURED`, `CLAUDE_NOT_CONFIGURED`, `CLAUDE_API_CAP_REACHED` or `CLAUDE_BILLING_MODEL_UNAVAILABLE` (the chat's model, `[1m]` included, is not in the target list). A switch on a chat with history is allowed both ways |
| Switch effect | Implemented (2026-10-25) | `switchBilling` sets `provider_type`, `billing_switched_at` and `billing_switched_by` (migration 0032), re-stamps the chat's unstarted rows (`queue.provider`, migration 0031) and writes one billing note per run. Going to the key releases a usage-limit pause. Emits `conversation_billing` |
| Message on the wrong billing | Implemented (2026-10-25) | `POST /api/message` answers 409 `CLAUDE_BILLING_SWITCH_REQUIRED` to a send naming the other billing and 409 `CLAUDE_BILLING_CHANGED` to a tab that still shows the old one. `provider` on `/api/message` is not a switch |
| Worker swap | Implemented (2026-10-25) | `claude-billing-swap-service.mjs` waits for an idle worker, stops every process of the session and launches the new kind on the same native session; a live worker is never reused. Stops retry with backoff from 5 s to 60 s. The transcript note reads "Restarted the session on the Claude API key (billing switch)" |
| Delivery fence | Implemented (2026-10-25) | `claudeBillingFence`: a row runs only on a worker of its stamped billing. A mismatched row goes back (`kind-mismatch`). A worker that reports no kind on a switched chat is replaced once, when idle |
| Usage-limit button | Implemented (2026-10-25) | The subscription usage-limit pause offers **Switch this chat to API key** when the switch is allowed; it is applied only on that click. When the cap blocks it, the banner says so |

## Usage and cap

| Surface | Status | Notes |
| ------- | ------ | ----- |
| Usage booking | Implemented (2026-10-25) | Both Claude worker kinds post `POST /api/claude-api-usage` after every turn (`billingUsageRoute`, `publishBillingUsage`): per-model run counts with Claude Code's own `costUSD`, and the session totals. The relay books the rise of each CLI run's counts; a resumed run's first result is measured against the session's mark. Only `claude-api` reports book spend; a subscription report only moves the mark. The billing booked is the posting worker's registered kind (`claude-api-usage-service.mjs`, migrations 0033 and 0034) |
| Check Usage card | Implemented (2026-10-25) | `plan-usage-claude-api.mjs`: estimated spend today and this month, spend and tokens per model, and the cap as a meter when one is set. Days follow the relay's local clock. Links: **Console billing** and **Console limits**. Shown while a key is saved, also when the provider is off. OAR keeps no price table of its own |
| Monthly cap | Implemented (2026-10-25) | Optional, in dollars per calendar month, up to 1,000,000 with two decimals; empty means no cap. Reached when this month's priced estimate is at or above it. A cap that cannot be read counts as reached. Then the relay refuses: the claim of a row on the key, the switch to the key, an agent's send to a chat on the key (409, nothing queued), a new Claude API chat (`CLAUDE_API_CAP_REACHED`) and the launch of its worker. A turn Claude Code starts by itself on the key (a background task reporting back) is stopped, with its background tasks. A running turn finishes |
| Agents | Implemented (2026-10-25) | `claude-api` is in `REMOTE_RELAY_PROVIDERS`. `send` takes `provider: "claude"` or `"claude-api"` for a Claude session and switches its billing with the message; the approval card names the switch. A target relay too old for the switch gets a refusal and nothing is sent |
| UI labels | Implemented (2026-10-25) | New Chat entry "Claude API", Select Models tab, pill colour `--provider-claude-api`, lock note "🔒 Session locked to Claude SDK models (API key)." On a refused New Chat the dialog stays open (`showNewConversationClaudeApiRefusal`) |

## Known gaps

| Surface | Status | Notes |
| ------- | ------ | ----- |
| Workspace header | Planned | A key without a workspace gets HTTP 400 from Anthropic. Sending the workspace in a request header is not supported yet; for now the key has to be created inside a workspace |
| Models without a price | Not implemented | A model Claude Code has no price for (today Claude Haiku 5.5) shows "no price known" on the card. Its tokens are left out of the estimate, which says "estimate incomplete", and the cap counts only priced spend |
| Balance | Not implemented | No Admin key and no balance read. The card links to the Console billing page instead. Turns paid from a Max or Team plan's subscriber API credit are counted too |
| Console spend limits | Not applicable | They apply on top of the OAR cap |
| The agent's own commands | Not implemented | No subprocess scrub: the agent's Bash commands can read the key from their environment. The relay only redacts its text in what workers post |

## Proofs and live check

`scripts/claude-api-cli-proof.mjs` runs the bundled Claude Code against a loopback fake Anthropic API, with user and
folder settings, proxies, TLS overrides and Bedrock or Vertex switches that try to redirect the key. Each turn must
reach the fake API with the key. `scripts/claude-cli-hooks-proof.mjs` checks that no hook or status line command
runs in a DeepSeek or Claude API chat, while a subscription control runs them. Both use placeholder keys only.

`scripts/claude-api-live-check.mjs --relay <url> --cwd <scratch folder> [--cap] [--bad-key]` runs short Sonnet turns
on the key saved in the relay: a tool turn and a follow-up that needs its history. It checks that the settings
route refuses a Claude login token. With `--cap` it lowers the cap for one refused send and puts it back. With
`--bad-key` it saves a key Anthropic refuses and does not put the old one back. It costs a few cents.
