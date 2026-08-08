# Cursor SDK (`@cursor/sdk`)

Updated: 2026-08-02 · Part of the [SDK Feature Tracker](README.md) — legend, changelog, and
provider-agnostic relay rows live there.

**Status: implemented and live-validated (2026-08-02).** Fully built and unit-tested against
`@cursor/sdk` `^1.0.26`, then validated with a real API key: an SDK-level spike (results at the
bottom) plus a relay end-to-end run — streamed turn with thoughts, a full `ask_user` question-card
round trip, and worker-kill resume via the persisted agent id all succeeded on `composer-2.5`.

The SDK has exactly two import sites, mirroring the Claude provider's pattern:
`server/cursor-worker/cursor-sdk-adapter.mjs` (the worker's only static import, plus
`@cursor/sdk/sqlite` for the store) and a dynamic `import()` in `server/server-runtime.mjs`
used only for model discovery (`refreshCursorProviderModels`).

Authentication uses an **API key** (`CURSOR_API_KEY`) saved through the relay's provider
settings — unlike Copilot/Claude, which ride the host's CLI login. The key is stored in
`app_settings`, never returned by any GET route, and reaches the worker via the same
secret-env-file mechanism as the OpenAI BYOK key (`createWorkerSecretEnvFile`,
`WORKER_SECRET_ENV_VARS`).

## Turn execution

| SDK feature | Status | Notes / evidence |
| ----------- | ------ | ---------------- |
| `Agent.create()` / `Agent.resume()` | Implemented | One durable agent per conversation. `createCursorAgentHandle` (`cursor-sdk-adapter.mjs`) creates or resumes by `agentId`; `local: { cwd, store, customTools, autoReview: false }` is passed on BOTH paths because custom tools are function objects the SDK cannot persist. Resume failure falls back to a fresh create (`cursor-turn-runner.mjs`). |
| Local store persistence | Implemented | `SqliteLocalAgentStore.open({ workspaceRef, stateRoot })` from the `@cursor/sdk/sqlite` subpath (v1.0.26 has no public constructor), one store per conversation under `$CURSOR_AGENT_STORE_DIR/<sdkSessionId>/` (default `server/data/cursor-agents/`, gitignored). |
| Durable agent id across worker restarts | Implemented | `agent.agentId` is persisted relay-side (`POST /api/cursor-agent-id` → `runtime_sessions.cursor_agent_id`, cached only after server ack) and replayed on queue messages as `message.cursorAgentId` (`cursor-turn-runner.mjs`, `server/routes/messages-routes.mjs` → `buildDequeuedRelayMessage`). |
| `agent.send()` with per-send model re-pin | Implemented | Per-run model overrides are documented sticky, so `{ model: { id } }` is passed on EVERY send. Resolution: per-message model (non-`auto`, unprefixed ids allowed) → `providerModel` → `CURSOR_RELAY_MODEL` (`cursor-turn-runner.mjs`). |
| `run.stream()` + `onDelta` merged streaming | Implemented | `startCursorRun` merges both surfaces into one ordered event queue; `sdk-message-normalizer.mjs` applies ownership latches (first `text-delta`/`thinking-delta` claims the channel; stream messages become fallback/degraded mode) and emits the same six relay channels as the Claude worker. |
| `run.cancel()` / Stop | Implemented | Control poller `abort_turn` → `AbortController.abort()` (unblocks a pending `ask_user` wait) + best-effort `turn.cancel()`; the merged iterator races the abort signal so the turn ends even if the SDK never emits `CANCELLED` (`shared/control-poller.mjs`, `cursor-sdk-adapter.mjs`). |
| `mode: 'plan' \| 'agent'` | Implemented | Relay `plan` mode maps to plan mode per send (`modeForRelayMode`); every other relay mode runs as `agent`. |
| Image content | Implemented | `SDKUserMessage.images` as base64 `{ data, mimeType }` for images ≤ 5 MiB; oversized/non-image files become path note lines byte-compatible with the Claude worker's wording (`cursor-attachments.mjs`). |
| `AgentBusyError` recovery | Implemented | One retry (close handle → recreate/resume from the cached id → restart the turn); a second busy is terminal `cursor.agent_busy` (`cursor-turn-runner.mjs`). |
| Typed error classification | Implemented | `classifyCursorError` maps `AuthenticationError` → `cursor.authentication_failed` (with a key-renewal system note), `AgentBusyError` → `cursor.agent_busy`, other coded errors → `cursor.<code>`, else `cursor.turn-error`; name/code-based so DI tests inject plain objects. |

## Question cards, plan boards, subagents

| Capability | Status | Notes / evidence |
| ---------- | ------ | ---------------- |
| `ask_user` custom tool (question cards) | Implemented — **compliance unverified** | No `canUseTool`/`onUserInputRequest` analogue exists in the SDK, so a relay-registered custom tool is the interception point: `cursor-ask-user-tool.mjs` (schema mirrors Claude's `AskUserQuestion`, steering text in the tool description) delegates to `shared/ask-user-bridge.mjs` (`questionSource: 'ask_user'`), threading the turn's abort signal so Stop unblocks the wait; returns `structuredContent` + a `Q:/A:` text fallback and never throws into the run. The open risk is whether the model reliably *calls* it — there is no text→card fallback; spike item 1. |
| Plan boards | Implemented | Text-fallback heuristic only (Cursor has no exit-plan tool): a `plan`-mode turn ending with ≥2 plan-like lines posts a `plan_ready` board with `context.source: 'plan-mode-fallback'` (`buildCursorPlanReadyBoardPayload`, `shared/plan-lines.mjs`). |
| Subagent lifecycle bubbles | Implemented (lifecycle only) | Inferred from `tool_call` messages whose name is `agent`/`task`, keyed by `call_id`. The SDK surface exposes no parent-attribution field, so subagent *text* stays on the main thread — lifecycle chips render without per-subagent prose (documented in the normalizer header). |
| Targeted subagent abort | Not implemented (SDK gap) | Same as Claude: `abort_subagent` controls are answered "not supported"; full-turn Stop remains. |
| Structured multi-field forms | n/a | No elicitation equivalent; the `ask_user` schema could emulate it if ever needed. |

## Models, effort, context usage

| Capability | Status | Notes / evidence |
| ---------- | ------ | ---------------- |
| Model discovery | Implemented | `refreshCursorProviderModels` (`server/server-runtime.mjs`) dynamic-imports the SDK, tries the namespace and client-instance `models.list()` forms defensively, 20 s timeout, filters `isSafeCursorModelId`, persists to `cursor_models`. Exact call form is spike item 2. |
| Reasoning effort | Not implemented | `reasoningByProvider.cursor = ['none']` per model; the SDK has no effort option (nearest is model `params`, unmapped in v1). |
| Context usage | Implemented | The last `usage` event of a turn + the model's context window are synthesized into a Claude-shaped snapshot (`cursor-context-usage.mjs` — occupancy = input+cacheRead+cacheWrite+output, categories deliberately empty) and posted to `POST /api/cursor-context-usage` into the shared `context_usage_json` column. **Window lookup (fixed 2026-08-09):** `models.list()` no longer ships any `contextWindow` field — the window is encoded in the model's `context` *parameter* values ('300k'/'1m'); `readModelContextWindow` now parses the default variant's choice (largest value when no default is flagged). Models without a context parameter (e.g. `composer-2.5`) fall back to token totals with no fill metric. |
| Live plan quota (Total/Auto/API %) | Implemented (automatic) | `agent.getUsage()`'s backing route (`GET /v1/agents/:id/usage`) is 403 `feature_unavailable` for individual accounts and the API key has no other usage surface. The dashboard percentages come from `POST cursor.com/api/dashboard/get-current-period-usage`. The session cookie is built **automatically from the relay host's Cursor IDE login** — `state.vscdb` `cursorAuth/accessToken` (opened read-only in place; the db can be multi-GB), cookie = `<sub user id>::<access JWT>`, cached 5 min (`cursor-dashboard-usage.mjs`). A manually pasted `WorkosCursorSessionToken` (settings route `/api/settings/cursor-dashboard-token`) takes precedence for headless hosts. Best-effort per Check Usage request; on 401/expiry/no-login the card degrades to the manual estimated view. Tokens never echoed to clients. |

## Session configuration not wired

| SDK feature | Status | Notes |
| ----------- | ------ | ----- |
| `mcpServers` / `agents` definitions | Not implemented | The relay observes, never defines; the host's own `.cursor/` config applies. |
| `local.sandboxOptions` / `local.autoReview` | Not implemented (deliberate) | Sandbox off, `autoReview: false` — parity with the relay's allow-all posture on the other providers. |
| File-based hooks (`.cursor/hooks.json`) | Not implemented | The relay never writes into the user's `.cursor/` config. |
| Cloud runtime (`cloud`, artifacts, `Agent.list/archive/delete`, prewarm) | Not implemented | The relay is workspace-local by design. |
| `Cursor.me()` / usage billing APIs | Not implemented | Not needed by the relay. |

## Relay integration (summary; details in the relay-core rows and per-file tests)

Worker package `server/cursor-worker/` mirrors `server/claude-worker/` (entry → WebSocket
delivery → turn runner → adapter → normalizer). Relay side: `provider_type 'cursor'`,
settings routes `GET/POST /api/settings/cursor` (+ `cursor_settings_updated` socket event),
catalog layer `buildModelCatalogWithCursorProvider` (outermost onion layer), launch routing via
`resolveWorkerKind`/`applyCursorProviderEnvironment` with the generalized secret-env-file,
`cursor_agent_id` column, worker-facing routes `POST /api/cursor-agent-id` /
`/api/cursor-context-usage` (409 unless bound to cursor), and the full settings/New-Chat/badge
frontend. Rollout requires `SESSION_WORKER_ROUTING_ENABLED` (like Claude) plus a saved key.

## Live validation results (2026-08-02, real key, `composer-2.5`)

1. **`ask_user` compliance: 10/10** across ten ask-first prompts (zero plain-text questions);
   also confirmed end-to-end through the relay — tool call → question card (`source: 'ask_user'`)
   → answered via `POST /api/relay-question/:id/answer` (requires `sdk_session_id`) → reply used
   the answer.
2. `models.list()`: the namespace form works (the client-instance form does not); entries are
   `{id, displayName, aliases, parameters, variants}` with **no context-window field** — the
   context gauge stays totals-only by SDK limitation. Some models expose an `effort` parameter
   (`low/medium/high`), so effort mapping is feasible later via model `params`.
3. `Agent.resume` recall: confirmed at SDK level (codeword recalled across process exit) and
   through the relay (worker killed mid-conversation; the respawned worker resumed via
   `cursor_agent_id` and recalled earlier conversation state). Note: resume requires an explicit
   `model` on the options or the send — the adapter/runner always pass it.
4. `run.cancel()` during a blocked custom tool: the stream terminates (`CANCELLED`) and the agent
   accepts new sends, but the blocked `execute()` promise never settles — the bridge's
   abort-signal unblocking is load-bearing, as designed.
5. Tool results: the model sees only the `content` text, **not** `structuredContent` — the
   `Q:/A:` text fallback is the load-bearing channel.
6. Sticky model override: confirmed. Busy signal: the live SDK throws
   `UnknownAgentError("Agent … already has active run")` instead of the documented
   `AgentBusyError`; `classifyCursorError` matches both (message-pattern detection), and
   `Agent.cancelRun` reported "Run not found" for the in-flight run — the close-and-resume
   recovery path is the effective one.
