# Copilot SDK worker (`server/copilot-worker/`)

Updated: 2026-08-31 · Part of the [SDK Feature Tracker](README.md) — legend, changelog, and
provider-agnostic relay rows live there. Design and phase history: [`docs/plans/copilot-sdk-worker.md`](../plans/copilot-sdk-worker.md).

A second engine for Copilot conversations: instead of the `copilot` TUI under a `script`-PTY with
`.github/extensions/web-relay/extension.mjs` injected, one plain Node process per conversation
drives the CLI's **bundled SDK** (`COPILOT_SDK_PATH`) as a headless JSON-RPC runtime — the same
shape as the Claude, Cursor and Grok workers. The extension engine ([copilot-sdk.md](copilot-sdk.md))
remains the default and is untouched; this file tracks the SDK engine only.

**Status:** implemented (phases 0–4), **burn-in pending**. Default engine is still Extension.

## Engine selection

| Question | Answer / evidence |
| -------- | ----------------- |
| Where is it chosen? | Settings → Providers → Copilot → *Copilot engine* (`#copilot-engine-select`), `GET`/`POST /api/settings/copilot` (`server/routes/sessions-routes.mjs` → `buildCopilotSettingsPayload`, `parseCopilotSettingsUpdateRequest`), broadcast as `copilot_settings_updated`. |
| Where is it stored? | App setting `copilot_engine` (`COPILOT_ENGINE_SETTING_KEY`), values `COPILOT_ENGINES = ['extension','sdk']`, `DEFAULT_COPILOT_ENGINE = 'extension'`; read by `getCopilotEngine()` / `getCopilotProviderSettings()` (`server/server-runtime.mjs`). |
| When does it take effect? | Per spawn: `buildSessionWorkerLaunchEnvForSession()` reads `getCopilotEngine()` each time a worker launches, so running sessions keep their engine until their worker restarts. Applies to `provider_type` `github` **and** `openai` (BYOK rides the same worker). |
| Why can a save be refused? | `setCopilotProviderSettings()` answers **409** with `copilotSdkEngineUnavailableReason({ env, routingEnabled })` (`server/services/session-worker-launch-service.mjs`) rather than persisting a setting that cannot take effect: (a) `COPILOT_SDK_PATH` never resolved at boot — the launch env is snapshotted once in `buildSessionWorkerLaunchEnv()`, so a CLI installed since startup needs a relay restart; (b) `SESSION_WORKER_ROUTING_ENABLED` is off, so no node worker is ever spawned. |
| How is the worker launched? | Worker kind `copilot-sdk` (`COPILOT_WEB_RELAY_WORKER_KIND`) in the launch service's node-worker descriptors (`windowsTitle: 'Copilot SDK Worker'`), env applied by `applyCopilotSdkProviderEnvironment()` (throws `copilot-sdk-path-not-resolved` when the path is empty), script from `resolveCopilotSdkWorkerScriptPath()`. Plain `node <script> --session-id <id>` — no PTY, no tmux wrapper, no extension bootstrap. |
| What does routing see? | Nothing new: `shared/provider-routing.mjs` is deliberately untouched. The engine changes the worker *kind*, not the provider type — conversations stay bound to `github`/`openai`, so model catalogs, usage cards and queue SQL are unaffected. |
| Process inspection | `looksLikeCopilotWorkerProcess` (`server/services/session-worker-process-service.mjs`) matches the `<kind>-session-worker` naming convention rather than per-worker literals — which also made `grok-session-worker` visible to the kill route. |

## Module map

| Module | Purpose | Key exports |
| ------ | ------- | ----------- |
| `copilot-sdk-session-worker.mjs` | Process entry point. Config → api client → control poller → turn runner → heartbeat → worker WebSocket, plus signal handling and the crash guard. | *(side-effecting `main()`)* |
| `copilot-sdk-session-process.mjs` | Owns the `CopilotClient`/`CopilotSession` for one conversation and runs turns as a state machine over the session event callback. | `createCopilotSdkSessionRunner`, `RUNTIME_INTERRUPTED_NOTE`, `STEERED_ROW_MERGED_NOTE`, `DEFAULT_INFINITE_SESSION_CONFIG` |
| `copilot-sdk-adapter.mjs` | The only module that touches the real SDK: path/version resolution, client start, runtime-exit observation, permission policy, error classification. | `resolveCopilotSdkPaths`, `startCopilotClient`, `observeRuntimeExit`, `describeVersionSkew`, `createCopilotPermissionHandler`, `copilotPermissionDecision`, `isReadOnlyPermissionRequest`, `copilotAgentModeForRelayMode`, `classifyCopilotSessionError`, `classifyCopilotTurnException`, `isCopilotQuotaError`, `isCopilotAuthError`, `isSessionNotFoundError` |
| `copilot-sdk-event-normalizer.mjs` | Pure `SessionEvent` → relay channel/action mapping. No I/O, no SDK import; one instance per turn. | `createCopilotEventNormalizer`, `isSubagentEvent`, `subagentDisplayName`, `formatToolActivityText`, `summarizeToolInput`, `formatSubagentStats` |
| `copilot-question-bridge.mjs` | The runtime's two blocking human surfaces (`ask_user`, ask-mode tool approval) → relay question cards, over `shared/ask-user-bridge.mjs`. | `createCopilotQuestionBridge`, `normalizeUserInputChoices`, `deriveWasFreeform`, `PERMISSION_APPROVE_CHOICE`, `PERMISSION_DENY_CHOICE` |
| `copilot-plan-board.mjs` | `plan_ready` board payload, when the text-shape fallback may post one, and the exit-plan feedback strings. | `buildCopilotPlanReadyBoardPayload`, `shouldPostPlanBoard`, `planTextFromExitRequest`, `PLAN_BOARD_ACTIONS`, `PLAN_LINE_THRESHOLD` |
| `copilot-prompt-context.mjs` | Per-turn relay prompt prefix: mode marker, mode instructions (only on change), `server/relay-tools.md` guidance, live preview block. | `createCopilotPromptContextBuilder`, `withRelayContext`, `loadDefaultRelayToolInstructions` |
| `copilot-byok-provider.mjs` | `SessionConfig.provider` for OpenAI-compatible BYOK, built from `COPILOT_PROVIDER_*`. | `resolveCopilotProviderConfig`, `resolveOpenAiModelTokenLimits` |
| `copilot-attachments.mjs` | Relay message → `MessageOptions` (`prompt` + typed attachments: inline `blob` for small images, `file` refs otherwise). | `buildCopilotMessageOptions`, `MAX_INLINE_IMAGE_BYTES` |
| `copilot-sdk-test-harness.mjs` | Fakes and helpers shared by the worker's unit tests (fake client/session, fixture loader, runner factory). | `createFakeCopilotClient`, `createFakeCopilotSession`, `makeRunner`, `loadFixture`, … |

Shared modules it reuses rather than reimplements: `shared/worker-bootstrap.mjs`
(`parseSessionIdArg`, `createWorkerDebug`, `readOptionalMs`), `shared/control-poller.mjs`,
`shared/worker-crash-guard.mjs`, `shared/ask-user-bridge.mjs`, `shared/question-timeout.mjs`,
`shared/stream-emit-gating.mjs`, `shared/thought-cap.mjs`, `shared/subagent-run-id.mjs`,
`shared/context-window-fallbacks.mjs`, plus the extension runtime's relay transport
(`runtime/config-loader.mjs`, `runtime/api-client.mjs`, `runtime/worker-websocket-link.mjs`,
`polling/heartbeat.mjs`).

## Relay contract

| Capability | Status | Notes / evidence |
| ---------- | ------ | ---------------- |
| Queue delivery → turn → response/failure | Implemented | `handlePendingPayload` → `runTurn` → `publishResponse` / `terminalErrorRecord` (`copilot-sdk-session-process.mjs`). `sendAndWait()` is deliberately unused (60 s internal timeout); `send()` resolving is *not* the end of a turn — the sole terminator is `session.idle`, with `session.error` as the failure path. |
| Resume across worker restart | Implemented | The relay's SDK session id **is** the runtime's session id: `buildSessionConfig` sets `SessionConfig.sessionId`, so the runtime's own state under `~/.copilot/session-state/<id>` is the store and there is no side table. `ensureSession` always tries `client.resumeSession()` first and only falls back to `createSession()` on `isSessionNotFoundError`; any other error fails the turn retryably. |
| Steering mid-turn | Implemented | `steerIntoActiveTurn` sends with `mode: 'enqueue'` (live-probed: `immediate` does **not** preempt an in-flight model call, and the whole interaction closes with a single `session.idle`), adopts the row onto the running turn so the lease is renewed and the crash guard requeues both, and answers each row from its own prompt segment indexed by **send order** (`settleSteeredRows`; a row that never got a segment gets `STEERED_ROW_MERGED_NOTE` rather than a requeue that would run it twice). |
| Abort / Stop | Implemented | `controlPoller.start({ queueMessageId, onAbortTurn })` → `session.abort()`; the runtime's `agent.interrupted` → `session.idle{aborted:true}` settles through the normal terminator. An abort landing before `send()` settles locally; a runtime-initiated abort publishes `RUNTIME_INTERRUPTED_NOTE`. |
| Idle shutdown | Implemented | `evaluateLifecycle` closes only the runtime (`stopRuntime('idle')`), never the process, after `DEFAULT_IDLE_SHUTDOWN_MS` (10 min, `COPILOT_SDK_RELAY_IDLE_SHUTDOWN_MS`); suppressed while a turn is active or a question card is open. Stall watchdog `DEFAULT_TURN_STALL_TIMEOUT_MS` (120 s, `COPILOT_SDK_RELAY_TURN_STALL_TIMEOUT_MS`, `0` disables). |
| Background-task gating | Not applicable | `session.background_tasks_changed` carries an empty payload (~23 per bash call) — no task id to stop, nothing to gate on. Dropped in the normalizer; worker controls are logged and ignored. Copilot has no background-task surface equivalent to Claude's. |
| Runtime death detection | Partial (version-fragile) | The SDK exposes no public exit signal, so `observeRuntimeExit` attaches to `client.processExitPromise` — TS-private but present at runtime — degrading to no detection if a future bundle drops it (fallback would be polling `client.ping()` during a turn). `session.shutdown` is deliberately **not** treated as death: the resume fixture shows it arriving from a graceful disconnect right before a healthy turn. |
| Version skew reporting | Implemented | `describeVersionSkew` / `readRuntimeVersion` (`copilot-sdk-adapter.mjs`) — the SDK is per-CLI-version and never vendored. |

## Event mapping

`createCopilotEventNormalizer` publishes on the same six channels as the sibling workers:
`init` / `stream` / `thought` / `activity` / `subagent` / `result`.

| Relay concept | SDK events |
| ------------- | ---------- |
| `init` (session id, model, resumed) | `session.start`, `session.resume`; `session.model_change` updates the model |
| Prompt boundary (steering attribution) | `user.message` opens a new segment |
| `stream` (live reply text) | `assistant.message_start`, `assistant.message_delta`, `assistant.message` — accumulated per `messageId`, gated by `shouldEmitStreamUpdate` |
| `thought` | `assistant.reasoning_delta` (capped, gated), `assistant.reasoning` (final). Hosted Copilot reasoning is encrypted/opaque — the event fires with **empty** content, so the bubble simply never opens; only `reasoningTokens` shows up in usage |
| `activity` | `tool.execution_start`, failed `tool.execution_complete`, `permission.requested` / `permission.completed`, `user_input.requested` |
| `subagent` lane | `subagent.started` / `configured` / `selected` open or label a run; `completed` / `failed` close it (with `durationMs` / `totalToolCalls` / `totalTokens` on a lane row); `deselected` ignored. Keyed on the **envelope `agentId`** (`toolCallId` registered only as an alias for lifecycle events); hosted subagents emit no deltas, so their whole reply arrives as one tagged `assistant.message`. `parentSubagentId` is always `null` — Copilot reports one flat level |
| Usage | `assistant.usage` (also `agentId`-tagged for subagent calls — counted toward spend but never allowed to set the turn's model), `session.usage_info` → context usage, `model.call_failure` → `quotaSnapshots` |
| `result` | `session.idle` (`completed` / `aborted`) and `session.error`, guarded so only one terminal fires. `assistant.turn_end` is inert (one per model call) |
| Dropped | `session.background_tasks_changed`, `pending_messages.modified`, `assistant.streaming_delta`, `model.*`, `session.shutdown` |

**Do not set `includeSubAgentStreamingEvents: false`.** It defaults to true, and turning it off also
collapses the *parent's* tool-call argument streaming (live-reproduced twice each way).

## Questions, permissions, plan boards

| Surface | Status | Notes / evidence |
| ------- | ------ | ---------------- |
| `onUserInputRequest` | Implemented | → `questionBridge.askUserInput`, returns **both** `answer` and `wasFreeform` (the deserializer is strict; a missing field fails the call silently). Degrades to `USER_INPUT_UNSUPPORTED_ANSWER`. |
| `onPermissionRequest` | Implemented | `createCopilotPermissionHandler` + `copilotPermissionDecision`: read-only tools short-circuit, agent/autopilot auto-approve, plan rejects non-read tools with feedback, ask routes to a relay question card; timeout → `{ kind: 'user-not-available' }`. The decision vocabulary is `approve-once` / `reject` / `user-not-available` only — `{kind:'allow'}` does not exist and is rejected by the runtime. |
| `onExitPlanModeRequest` | Implemented | Posts the board via `publishPlanBoard(..., 'exit_plan_mode')` and always returns `approved: false` — approving tells the runtime the plan was accepted and the same turn rolls straight into implementing while the board sits unanswered. |
| Plan-mode text fallback | Implemented | `shouldPostPlanBoard` (`countPlanLikeLines >= PLAN_LINE_THRESHOLD`), gated on plan **and** ask — one mode wider than the siblings, so ask mode additionally requires `!turn.acted` (no non-read permission approved this turn), otherwise the board would offer "Implement in autopilot" for work already done. |
| `onElicitationRequest` | Not implemented | Declined (`{ action: 'decline' }`) — the relay has no card type for the SDK's structured elicitation on this path. |
| Compaction | Implemented | `DEFAULT_INFINITE_SESSION_CONFIG` sets `enabled: true`, `backgroundCompactionThreshold: 0.80`, `bufferExhaustionThreshold: 0.95` **explicitly** — the runtime's own defaults today, pinned so a future runtime change cannot silently move where a long conversation starts compacting. |

## BYOK (OpenAI-compatible)

`resolveCopilotProviderConfig({ env, model })` builds `SessionConfig.provider`
(`{ type:'openai', baseUrl, apiKey, wireApi?, maxPromptTokens?, maxOutputTokens? }`) when
`COPILOT_PROVIDER_TYPE === 'openai'` and a key is present. `modelId` is deliberately left unset so
`setModel()` stays authoritative.

- **Model switch is a different mechanism per session type.** Hosted sessions call
  `session.setModel()`. BYOK sessions **dispose and resume** — `session.disconnect()`, then
  `ensureSession()` rebuilds the config with freshly resolved ceilings — because
  `SessionConfig.provider` is immutable mid-session in runtime 1.0.82. Nothing is lost: the SDK
  session id is the relay session id, so the rebuild takes the ordinary resume path.
- **Token ceilings** come from `resolveModelTokenCeilings(model)` in
  `shared/context-window-fallbacks.mjs` (`maxPromptTokens = contextWindow − maxOutputTokens`), the
  single table also read — through its sibling export `resolveFallbackContextLimitTokens` — by
  `server/services/context-snapshot-service.mjs`, `server/cursor-worker/cursor-turn-runner.mjs` and
  `server/grok-worker/grok-context-usage.mjs`.
- Overrides `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_WIRE_API` (`responses`|`completions`),
  `COPILOT_PROVIDER_MAX_PROMPT_TOKENS`, `COPILOT_PROVIDER_MAX_OUTPUT_TOKENS`; invalid values are
  logged and ignored rather than passed through.
- BYOK turns **skip usage ingest** entirely: they spend the user's own key, so their numbers do not
  belong on the Copilot plan card.

## Usage ingest

`captureTurnUsage()` records the turn's numbers, `postTurnUsage()` posts them fire-and-forget on a
chain after the row is published (never awaited by the turn path, skipped when the snapshot is
unchanged) to **`POST /api/copilot-plan-usage`** (`server/routes/messages-routes.mjs`).

The route is stricter than its siblings on purpose: `github` is the *default* provider binding, so a
"no runtime session? assume github" fallback would let any authenticated poster overwrite a snapshot
the whole relay reads. It requires the runtime session to exist (404) and to be Copilot-bound (409),
normalizes with `normalizeCopilotWorkerUsage` (clamping every count non-negative; 400 when nothing is
usable), and stores under provider key **`copilot-sdk`** — deliberately not `github`, so the Copilot
card's account-level meters stay unified across both engines and this is strictly additive.

It carries the two things no relay-side source can see: `totalNanoAiu` (real spend — the event's
`cost` is the premium multiplier, not money, and there is no `premiumRequests` field) and
`quotaSnapshots.cfi_overage` (overage, which `account.getQuota()`'s cached read never shows).

Rendered as the Copilot card's **Last SDK worker turn** section (`buildCopilotWorkerUsageSection`,
section id `copilot-sdk-last-turn`) with a `Model … · as of …` note, and withheld once the payload's
`capturedAt` is more than `COPILOT_WORKER_USAGE_MAX_AGE_MS` (7 days) old — the snapshot never expires
on its own, and after a switch back to the extension engine nothing would ever replace it.

## Known differences from the extension engine

- **No tmux TUI inspector** for SDK sessions — a headless runtime has no TUI to attach to.
  `tmux attach` shows the worker's own log lines (as for Claude/Cursor/Grok).
- **No thinking stream** for hosted models (encrypted reasoning; see the event table).
- **Structured elicitation forms** are declined rather than bridged.
- Built-in slash-command parity headless is unverified — an open item for burn-in.

## Test topology

Turn-level behaviour is covered by unit tests driving the runner against a **fake SDK client**
(`copilot-sdk-test-harness.mjs`) over checked-in event fixtures captured from the real runtime
(`server/copilot-worker/fixtures/`: `happy-turn`, `abort-turn`, `ask-user-turn`, `quota-turn`,
`reasoning-turn`, `resume-turn`, `subagent-turn`, `tool-permission-turn`). No e2e stub of the
JSON-RPC protocol exists, and none is planned — see [the plan's §4c](../plans/copilot-sdk-worker.md).

| Suite | Tests | Covers |
| ----- | ----- | ------ |
| `server/copilot-worker/copilot-sdk-session-process.test.mjs` | 74 | turn state machine, resume, steering, abort, idle/stall, plan boards, usage capture |
| `server/copilot-worker/copilot-sdk-event-normalizer.test.mjs` | 33 | event → channel mapping, subagent lane, terminal guards |
| `server/copilot-worker/copilot-sdk-adapter.test.mjs` | 28 | path/version resolution, permission policy, error classification |
| `server/copilot-worker/copilot-byok-provider.test.mjs` | 14 | provider config, ceilings, override validation |
| `server/copilot-worker/copilot-question-bridge.test.mjs` | 11 | ask_user + approval cards, freeform flag |
| `server/copilot-worker/copilot-attachments.test.mjs` | 10 | inline blob vs file refs |
| `server/copilot-worker/copilot-plan-board.test.mjs` | 8 | board payload, fallback gating |
| `server/copilot-worker/copilot-prompt-context.test.mjs` | 8 | prompt prefix composition |
| `server/services/session-worker-launch-service.copilot-sdk.test.mjs` | 12 | launch env, refusal reasons |
| `server/routes/sessions-routes-copilot-settings.test.mjs` | 10 | engine GET/POST, 400 vs 409, broadcast suppression on refusal |
| `server/public/app/copilot-engine-ui.test.mjs` | 6 | panel state machine (JSDOM over the real `index.html`) |
| `server/routes/messages-routes-plan-usage.test.mjs` | 6 of 20 | ingest route binding checks and clamping |
| `server/services/plan-usage.test.mjs` | 4 of 47 | last-turn section, 7-day cutoff |
| `server/services/session-worker-process-service.test.mjs` | 1 of 14 | `<kind>-session-worker` inspector match |
| `tests/copilot-engine.spec.mjs` (e2e) | 10 | panel render, both 409 refusals end-to-end, accept + persistence on a routing-enabled relay, ingest 404/409/200, usage-card section + cutoff |

## Burn-in checklist (deprecation gate)

From the plan's §5 — the extension stays default until these are green on real sessions for a
sustained period. Extension removal is a separate future decision.

- [ ] Turn delivery + completion/failure records
- [ ] Steering mid-turn
- [ ] Interrupt / abort
- [ ] Clarification questions round-trip
- [ ] Permission prompts
- [ ] Reasoning stream rendering (capability-gated: expected to stay closed on hosted models)
- [ ] Subagent attribution
- [ ] Model switch mid-session (both mechanisms: hosted `setModel`, BYOK dispose+resume)
- [ ] Model catalog
- [ ] Usage/billing card unchanged, plus the new last-turn section
- [ ] Resume across worker restart
- [ ] Relay restart survival
- [ ] Background-task gating (n/a — confirm nothing regresses)
- [ ] Idle shutdown
- [ ] Windows spawn
- [ ] Previews lane
- [ ] `/`-command story (or a documented capability difference)
