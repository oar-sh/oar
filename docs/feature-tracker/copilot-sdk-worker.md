# Copilot SDK worker (`server/copilot-worker/`)

Updated: 2026-09-25 · Part of the [SDK Feature Tracker](README.md) — legend, changelog, and
provider-agnostic relay rows live there. Design and phase history: [`docs/plans/copilot-sdk-worker.md`](../plans/copilot-sdk-worker.md).

A second engine for Copilot conversations: instead of the `copilot` TUI under a `script`-PTY with
`.github/extensions/web-relay/extension.mjs` injected, one plain Node process per conversation
drives the CLI's **bundled SDK** (`COPILOT_SDK_PATH`) as a headless JSON-RPC runtime — the same
shape as the Claude, Cursor and Grok workers. The extension engine ([copilot-sdk.md](copilot-sdk.md))
remains the default and is untouched; this file tracks the SDK engine only.

**Status:** implemented (phases 0–4), **burn-in in progress**. **Default engine is SDK** as of
2026-09-07 (hardening Phase 6): an unset `copilot_engine` reads as `sdk` when the relay can run
it, falling back to `extension` when no Copilot CLI resolves or session-worker routing is off —
the same guard the save path enforces. Both of Simon's relays run `sdk` by explicit setting.
Burn-in finding #2 (self-initiated turns were dropped; live session `10a1a9ad`, 2026-08-31) is fixed
worker-side, and `/api/continuation-turn` accepts `github`/`openai` alongside `claude`
(`CONTINUATION_PROVIDER_TYPES`, `server/routes/messages-routes.mjs`), so self-initiated turns are
live-testable. See [Self-initiated turns](#self-initiated-continuation-turns).

**Hardening (2026-09-06):** every dequeued row now carries a per-attempt `attemptId` which the
worker echoes on all writes (response/failure/requeue/stream/thought/activity/subagent/questions);
the server rejects writes from a superseded attempt with 409 `stale_attempt`, and the worker drops
(never requeues) on that signal. Continuation registration is idempotent: one `operationId` per
registration, retried verbatim, so a lost response cannot mint a duplicate row.

Same-day follow-ups (phases 2–5 of the hardening plan): runtime-event ownership separates from
queue-row publishing (`publishingTurns`), so a fast continuation landing during a prior turn's
publish window is re-dispatched instead of dropped; continuation registration is cancellable and a
row created after local abandonment is torn down with a fenced requeue; interactive callbacks await
`rowReady`; the question bridge expires cards that land after shutdown began. Per-turn reasoning
effort is applied and model switches are **observed** (`copilot-model-switch.mjs`, below);
structured elicitation is bridged; the worker publishes model-catalog snapshots; and the transport
quartet moved to `shared/worker-runtime/` ahead of extension deletion.

## Engine selection

| Question | Answer / evidence |
| -------- | ----------------- |
| Where is it chosen? | Settings → Providers → Copilot → *Copilot engine* (`#copilot-engine-select`), `GET`/`POST /api/settings/copilot` (`server/routes/sessions-routes.mjs` → `buildCopilotSettingsPayload`, `parseCopilotSettingsUpdateRequest`), broadcast as `copilot_settings_updated`. |
| Where is it stored? | App setting `copilot_engine` (`COPILOT_ENGINE_SETTING_KEY`), values `COPILOT_ENGINES = ['extension','sdk']`, `DEFAULT_COPILOT_ENGINE = 'sdk'` with `FALLBACK_COPILOT_ENGINE = 'extension'` when `copilotSdkEngineUnavailableReason()` fires; read by `getCopilotEngine()` / `getCopilotProviderSettings()` (`server/server-runtime.mjs`). |
| When does it take effect? | Per spawn: `buildSessionWorkerLaunchEnvForSession()` reads `getCopilotEngine()` each time a worker launches, so running sessions keep their engine until their worker restarts. Applies to `provider_type` `github` **and** `openai` (BYOK rides the same worker). |
| Why can a save be refused? | `setCopilotProviderSettings()` answers **409** with `copilotSdkEngineUnavailableReason({ env, routingEnabled })` (`server/services/session-worker-launch-service.mjs`) rather than persisting a setting that cannot take effect: (a) `COPILOT_SDK_PATH` never resolved at boot — the launch env is snapshotted once in `buildSessionWorkerLaunchEnv()`, so a CLI installed since startup needs a relay restart; (b) `SESSION_WORKER_ROUTING_ENABLED` is off, so no node worker is ever spawned. |
| How is the worker launched? | Worker kind `copilot-sdk` (`COPILOT_WEB_RELAY_WORKER_KIND`) in the launch service's node-worker descriptors (`windowsTitle: 'Copilot SDK Worker'`), env applied by `applyCopilotSdkProviderEnvironment()` (throws `copilot-sdk-path-not-resolved` when the path is empty), script from `resolveCopilotSdkWorkerScriptPath()`. Plain `node <script> --session-id <id>` — no PTY, no tmux wrapper, no extension bootstrap. |
| What does routing see? | Nothing new: `shared/provider-routing.mjs` is deliberately untouched. The engine changes the worker *kind*, not the provider type — conversations stay bound to `github`/`openai`, so model catalogs, usage cards and queue SQL are unaffected. |
| Process inspection | `looksLikeCopilotWorkerProcess` (`server/services/session-worker-process-service.mjs`) matches the `<kind>-session-worker` naming convention rather than per-worker literals — which also made `grok-session-worker` visible to the kill route. |

## Module map

| Module | Purpose | Key exports |
| ------ | ------- | ----------- |
| `copilot-sdk-session-worker.mjs` | Process entry point. Config → api client → control poller → turn runner → heartbeat → worker WebSocket, plus signal handling and the crash guard. | *(side-effecting `main()`)* |
| `copilot-sdk-session-process.mjs` | Owns the `CopilotClient`/`CopilotSession` for one conversation and runs turns as a state machine over the session event callback — both `delivered` turns and the `continuation` turns the runtime starts by itself. | `createCopilotSdkSessionRunner`, `RUNTIME_INTERRUPTED_NOTE`, `STEERED_ROW_MERGED_NOTE`, `CONTINUATION_TRIGGER`, `DEFAULT_INFINITE_SESSION_CONFIG` |
| `copilot-sdk-adapter.mjs` | The only module that touches the real SDK: path/version resolution, client start, runtime-exit observation, permission policy, error classification. | `resolveCopilotSdkPaths`, `startCopilotClient`, `observeRuntimeExit`, `describeVersionSkew`, `createCopilotPermissionHandler`, `copilotPermissionDecision`, `isReadOnlyPermissionRequest`, `copilotAgentModeForRelayMode`, `classifyCopilotSessionError`, `classifyCopilotTurnException`, `isCopilotQuotaError`, `isCopilotAuthError`, `isSessionNotFoundError` |
| `copilot-sdk-event-normalizer.mjs` | Pure `SessionEvent` → relay channel/action mapping. No I/O, no SDK import; one instance per turn. | `createCopilotEventNormalizer`, `isSubagentEvent`, `subagentDisplayName`, `formatToolActivityText`, `summarizeToolInput`, `formatSubagentStats` |
| `copilot-continuation-signals.mjs` | Pure signal extraction for self-initiated turns: detached-shell liveness, resume-replay discrimination, and which events mean "the runtime started work". No I/O, no SDK import. | `createBackgroundShellTracker`, `createReplayGate`, `isContinuationOpeningEvent`, `describeSettledShell`, `CONTINUATION_OPENING_EVENT_TYPES`, `SHELL_SETTLED_NOTIFICATION_KINDS` |
| `copilot-question-bridge.mjs` | The runtime's blocking human surfaces (`ask_user`, ask-mode tool approval, structured elicitation) → relay question cards, over `shared/ask-user-bridge.mjs`; tracks in-flight creates + a closing state so shutdown can't strand a card. | `createCopilotQuestionBridge`, `normalizeUserInputChoices`, `deriveWasFreeform`, `PERMISSION_APPROVE_CHOICE`, `PERMISSION_DENY_CHOICE` |
| `copilot-model-switch.mjs` | Observed model/effort switching: drives `rpc.model.switchTo` / `rpc.model.setReasoningEffort` directly (the `setModel` facade discards results), caches one `rpc.model.list()` per session, waits out `deferred` switches on the `session.model_change` drain, and fails unconfirmed explicit selections (`relay.model-switch-unconfirmed`) instead of running on the wrong model. Relay effort `none` maps to the model's `defaultReasoningEffort` (the SDK union has no `none`). | `createCopilotModelSwitcher` |
| `copilot-plan-board.mjs` | `plan_ready` board payload, when the text-shape fallback may post one, and the exit-plan feedback strings. | `buildCopilotPlanReadyBoardPayload`, `shouldPostPlanBoard`, `planTextFromExitRequest`, `PLAN_BOARD_ACTIONS`, `PLAN_LINE_THRESHOLD` |
| `copilot-prompt-context.mjs` | Per-turn relay prompt prefix: mode marker, mode instructions (only on change), `server/relay-tools.md` guidance, live preview block. | `createCopilotPromptContextBuilder`, `withRelayContext`, `loadDefaultRelayToolInstructions` |
| `copilot-byok-provider.mjs` | `SessionConfig.provider` for OpenAI-compatible BYOK, built from `COPILOT_PROVIDER_*`. | `resolveCopilotProviderConfig`, `resolveOpenAiModelTokenLimits` |
| `copilot-attachments.mjs` | Relay message → `MessageOptions` (`prompt` + typed attachments: inline `blob` for small images, `file` refs otherwise). | `buildCopilotMessageOptions`, `MAX_INLINE_IMAGE_BYTES` |
| `copilot-sdk-test-harness.mjs` | Fakes and helpers shared by the worker's unit tests (fake client/session, fixture loader, runner factory). | `createFakeCopilotClient`, `createFakeCopilotSession`, `makeRunner`, `loadFixture`, … |

Shared modules it reuses rather than reimplements: `shared/worker-bootstrap.mjs`
(`parseSessionIdArg`, `createWorkerDebug`, `readOptionalMs`), `shared/control-poller.mjs`,
`shared/worker-crash-guard.mjs`, `shared/ask-user-bridge.mjs`, `shared/question-timeout.mjs`,
`shared/stream-emit-gating.mjs`, `shared/thought-cap.mjs`, `shared/subagent-run-id.mjs`,
`shared/context-window-fallbacks.mjs`, plus the relay transport quartet in
`shared/worker-runtime/` (`config-loader.mjs`, `api-client.mjs`, `worker-websocket-link.mjs`,
`heartbeat.mjs` — relocated 2026-09-06 from `.github/extensions/web-relay/`, where one-line
re-export shims remain for the extension until its deletion).

## Relay contract

| Capability | Status | Notes / evidence |
| ---------- | ------ | ---------------- |
| Queue delivery → turn → response/failure | Implemented | `handlePendingPayload` → `runTurn` → `publishResponse` / `terminalErrorRecord` (`copilot-sdk-session-process.mjs`). `sendAndWait()` is deliberately unused (60 s internal timeout); `send()` resolving is *not* the end of a turn — the sole terminator is `session.idle`, with `session.error` as the failure path. |
| Resume across worker restart | Implemented | The relay's SDK session id **is** the runtime's session id: `buildSessionConfig` sets `SessionConfig.sessionId`, so the runtime's own state under `~/.copilot/session-state/<id>` is the store and there is no side table. `ensureSession` always tries `client.resumeSession()` first and only falls back to `createSession()` on `isSessionNotFoundError`; any other error fails the turn retryably. |
| Steering mid-turn | Implemented (2026-09-25, Claude parity) | The worker opts into the shared link's steering gate (`getSteeringReady` / `getDeliveryHeld`) and publishes the composer snapshot on its heartbeat (`steeringState()` with `supported: true`, `holdReason` ∈ question / compaction / delivery, and the un-steerable `cancellableIds`). Every send uses `mode: "immediate"` (probe 2026-09-25, runtime 1.0.88): mid-turn the runtime injects it at the next tool boundary as `user.message{delivery:"steering"}` — the row settles `kind='folded'` and is marked consumed at that acknowledgement — or, when the model is mid-stream, runs it right after as `delivery:"queued"` on its own row (`user.message.messageId` matches the id `send()` resolves; rows are attributed by id, never by text). Holds: an open `ask_user` / approval / elicitation card, a compaction (`session.compaction_start`…`_complete`, 10-min stale cap) and the window before the turn-opening send resolves hand a delivery back as `steering-held`. Steered prompts carry the hidden steer note (`shared/steer-note.mjs`). Stop = `rpc.interruptMainTurn({flushQueued:false})` (falls back to `session.abort()`): the stopped row is left to the relay's abort control, other pushed rows settle `kind='stopped'` (Resend), and anything of ours still in the queued lane is removed first. Un-steer: a pushed row still in the runtime's queued lane (`rpc.queue.pendingItems`) is reported cancellable; `cancel_pushed_message` → `rpc.queue.removeAt` → `POST /api/queue-cancelled`. At-most-once settle markers with the Claude retry ladder + heartbeat `settleFailed`. A pushed prompt the runtime opens after its turn's idle is adopted as its own turn (2 s grace), never a continuation. Tests: `copilot-sdk-steering-parity.test.mjs`, `copilot-steering-hold-chain.test.mjs` (real socket + relay ws service). |
| Abort / Stop | Implemented | `controlPoller.start({ queueMessageId, onAbortTurn })` → `session.abort()`; the runtime's `agent.interrupted` → `session.idle{aborted:true}` settles through the normal terminator. An abort landing before `send()` settles locally; a runtime-initiated abort publishes `RUNTIME_INTERRUPTED_NOTE`. |
| Idle shutdown | Implemented | `evaluateLifecycle` closes only the runtime (`stopRuntime('idle')`), never the process, after `DEFAULT_IDLE_SHUTDOWN_MS` (10 min, `COPILOT_SDK_RELAY_IDLE_SHUTDOWN_MS`); suppressed while a turn of **either kind** is active, a question card is open, a detached shell is live, or a settled shell's continuation is still due. Stall watchdog `DEFAULT_TURN_STALL_TIMEOUT_MS` (120 s, `COPILOT_SDK_RELAY_TURN_STALL_TIMEOUT_MS`, `0` disables). |
| Self-initiated (continuation) turns | Implemented | See [the section below](#self-initiated-continuation-turns). Registration is idempotent (`operationId`) and returns the row's `attemptId`. |
| Background-task gating | Implemented (2026-09-25: agents + shells from `rpc.tasks`) | The runtime's task registry is the truth: `session.background_tasks_changed` (still an empty payload, ~20 per shell call) schedules a debounced `rpc.tasks.list()`; running agents (`TaskAgentInfo`) and shells (`TaskShellInfo`, detached or promoted) become `/api/background-tasks` cards — `local_agent` with `subagentType` (agentType), `model` (`resolvedModel` → spawn model → session model as `modelInherited`), the live `lastToolCall` (agentId-tagged `tool.execution_start`), `totalTokens` (agentId-tagged `assistant.usage` sum, final from `subagent.completed`), a `summary` from `tasks.getProgress` (latest intent / last output line) — all `stoppable: true`. Per-card Stop and a background agent lane's Stop → `rpc.tasks.cancel({id})` (the panel id IS the runtime task id: agentId / shellId). Finished entries are `tasks.remove`d; `idle` multi-turn agents neither pin nor show (roadmap: `tasks.sendMessage`). Lifecycle: live registry tasks pin the runtime up to the relay's *Background task timeout* slider (rides every delivery, 0 = unlimited; `COPILOT_SDK_RELAY_BACKGROUND_TASK_TIMEOUT_MS` overrides); on expiry tasks are **cancelled**, not forgotten. A background agent's `system.notification{agent_idle|agent_completed}` heralds the continuation (60 s grace) like the shell kinds; the runtime's follow-up (`read_agent` + reply under the old interaction) lands as a continuation row since the delivered row already settled on `assistant.idle`. The normalizer opens no lane for `executionMode:"background"` agents (a transcript note instead; their tagged traffic is dropped). Runtimes without `rpc.tasks` keep the event-scraped shell tracker (non-stoppable shell cards, forget-on-expiry). Tests: `copilot-sdk-background-tasks.test.mjs`. |
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

Two event classes are consumed **outside** the normalizer, in `copilot-continuation-signals.mjs`,
because they are about the session rather than the turn: `system.notification` (a settled shell) and
`session.resume`'s `resumeTime`/`eventCount` (the replay window).

## Self-initiated (continuation) turns

The runtime starts turns nobody asked for. A detached shell (`bash{mode:"async", detach:true}`)
settles on its own clock and the runtime re-invokes the model with no prompt behind it. Live burn-in
(session `10a1a9ad`, 2026-08-31, "set a timer to 1 minute") caught the whole of that second turn
being dropped — `routeEvent` returned early with no active turn — so the user never saw the reply.

| Question | Answer / evidence |
| -------- | ----------------- |
| What opens a continuation? | A live (non-replayed) event in `CONTINUATION_OPENING_EVENT_TYPES` arriving with no active turn. An **allowlist**: a missing opener costs one dropped continuation, a spurious one puts an empty synthetic turn in the transcript. Terminators (`session.idle`/`error`) and connection bookkeeping are excluded by construction. |
| What row does it publish into? | `POST /api/continuation-turn` (`trigger: 'background_task'`, matching the Claude worker so the relay's `CONTINUATION …` log line reads the same for both engines). One `operationId` is minted per registration and repeated on every retry, so a committed-but-lost response resolves to the same row instead of a twin; the response's `attemptId` fences all of the turn's writes. The turn buffers its actions until the row has an id, then flushes them in arrival order; 3 attempts, then the output is **discarded** — the turn still lands in the runtime's own transcript, and the worker stays healthy. |
| How does it end? | Exactly like a delivered turn: `session.idle` / `session.error`, the same stall watchdog, the same abort control (started once the row has an id), the same `finishTurn` publish path, and the same fire-and-forget usage ingest. A continuation spends real quota — the live capture burned a premium request on it. |
| How is replay kept out? | `createReplayGate`: after `session.resume`, suppress events whose own `timestamp` predates `resumeTime`, at most `eventCount` of them, disarming at the first event that is not older. Both halves are needed — see [the plan's §4e](../plans/copilot-sdk-worker.md) for what each one alone gets wrong. There is no SDK replay flag (`ephemeral` marks transience, not replay). |
| Steering during one | A delivered row steers into the running continuation like any other interaction. The continuation owns the normalizer's **implicit segment 0** (it sent no prompt), so the first steered prompt opens segment **1** — tracked by `turn.nextSegmentIndex` / `turn.firstSentSegment` rather than derived, because the two turn kinds differ. Getting it wrong cross-publishes the continuation's reply into the user's row. |
| Relay mode | Inherited from the last delivered turn (`lastRelayMode`): a self-initiated turn has no delivery to read a mode off, and it is a continuation *of* that work. |
| **Live status** | **Unblocked.** `POST /api/continuation-turn` accepts `claude`, `github`, and `openai` (`CONTINUATION_PROVIDER_TYPES`); the burn-in checklist row below is live-testable. |

**Do not set `includeSubAgentStreamingEvents: false`.** It defaults to true, and turning it off also
collapses the *parent's* tool-call argument streaming (live-reproduced twice each way).

## Questions, permissions, plan boards

| Surface | Status | Notes / evidence |
| ------- | ------ | ---------------- |
| `onUserInputRequest` | Implemented (fallback path) | → `questionBridge.askUserInput`, returns **both** `answer` and `wasFreeform` (the deserializer is strict; a missing field fails the call silently). Degrades to `USER_INPUT_UNSUPPORTED_ANSWER`. Since 2026-09-25 it only runs when a runtime refuses the relay's own `ask_user` (row below). |
| Relay `ask_user` tool (multi-select) | Implemented (2026-09-25) | The runtime's built-in `ask_user` offers the model only `question` + `choices` (captured from the request body, 1.0.88), so "pick several" was undeclarable. The worker registers its own `ask_user` via `SessionConfig.tools` with `overridesBuiltInTool: true`, `skipPermission: true`, `defer: 'never'` (`copilot-ask-user-tool.mjs`): the same fields plus `multi_select`. Verified with the fake-provider probe: the model sees exactly one `ask_user` with this schema, the handler gets the call, the built-in path is never used. The handler runs under the same gating as the built-in (`whileAwaitingHuman` → question hold + stall watchdog held, `awaitInteractiveRow`), raises the card through `questionBridge.askUserInput` (`multiSelect` → `context.multiSelect`; every Copilot choice card also gets `context.allowMultiSelect` → the client's **Select several** switch; the wording heuristic `shared/question-multi-select.mjs` still pre-selects), and answers in the built-in's wording ("User selected: X" / "User responded: …"). A runtime that refuses the override (`isToolOverrideRejection`: `overridesBuiltInTool` named, or `ask_user` named alongside a clash/override complaint) gets the session rebuilt without it once; the refusal is remembered until the runtime stops (the next one may be auto-updated). The handler's card is cancelled when either the turn or the runtime's `invocation.signal` aborts. A request demanding an exact choice (`allowFreeform: false`) gets neither hint. Steered prompts carry the hidden steer note except in a continuation. Tests: `copilot-ask-user-tool.test.mjs`. |
| `onPermissionRequest` | Implemented | `createCopilotPermissionHandler` + `copilotPermissionDecision`: read-only tools short-circuit, agent/autopilot auto-approve, plan rejects non-read tools with feedback, ask routes to a relay question card; timeout → `{ kind: 'user-not-available' }`. The decision vocabulary is `approve-once` / `reject` / `user-not-available` only — `{kind:'allow'}` does not exist and is rejected by the runtime. |
| `onExitPlanModeRequest` | Implemented | Posts the board via `publishPlanBoard(..., 'exit_plan_mode')` and always returns `approved: false` — approving tells the runtime the plan was accepted and the same turn rolls straight into implementing while the board sits unanswered. |
| Plan-mode text fallback | Implemented | `shouldPostPlanBoard` (`countPlanLikeLines >= PLAN_LINE_THRESHOLD`), gated on plan **and** ask — one mode wider than the siblings, so ask mode additionally requires `!turn.acted` (no non-read permission approved this turn), otherwise the board would offer "Implement in autopilot" for work already done. |
| `onElicitationRequest` | Implemented | → schema question card (`askStructured` in `copilot-question-bridge.mjs`; the create payload carries `requestedSchema`, the validated `structuredAnswer` comes back as `{ action: 'accept', content }`). Url mode, missing schema, timeout, bridge closing, or an unvalidated answer → `{ action: 'decline' }` (the old blanket behavior, now the fallback). Continuation turns await `rowReady` first. |
| Compaction | Implemented | `DEFAULT_INFINITE_SESSION_CONFIG` sets `enabled: true`, `backgroundCompactionThreshold: 0.80`, `bufferExhaustionThreshold: 0.95` **explicitly** — the runtime's own defaults today, pinned so a future runtime change cannot silently move where a long conversation starts compacting. |

## BYOK (OpenAI-compatible)

`resolveCopilotProviderConfig({ env, model })` builds `SessionConfig.provider`
(`{ type:'openai', baseUrl, apiKey, wireApi?, maxPromptTokens?, maxOutputTokens? }`) when
`COPILOT_PROVIDER_TYPE === 'openai'` and a key is present. `modelId` is deliberately left unset so
`setModel()` stays authoritative.

- **Model switch is a different mechanism per session type.** Hosted sessions go through
  `copilot-model-switch.mjs` (`rpc.model.switchTo` with the result observed — deferred switches
  wait on the `session.model_change` drain, unconfirmed ones fail the row). BYOK sessions try the
  same RPCs only when the freshly resolved provider ceilings are unchanged; otherwise they
  **dispose and resume** — `session.disconnect()`, then `ensureSession()` rebuilds the config
  (now carrying `reasoningEffort`) with freshly resolved ceilings — because
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
- **Built-in slash commands**: feasible but deferred. SDK 1.0.13 exposes an `@experimental`
  `rpc.commands` namespace (`list`/`invoke`/`execute`/`enqueue` — `generated/rpc.d.ts:24603-24652`)
  that covers built-ins headless; the caveat is that `invoke` results of kind `agent-prompt`,
  `show-dialog`, and `set-model`/`set-plan-model` require the client to enact the effect itself,
  so full parity is real integration work, not a flag flip. Custom commands would ride
  `SessionConfig.commands` + the `command.execute` event.

## Test topology

Turn-level behaviour is covered by unit tests driving the runner against a **fake SDK client**
(`copilot-sdk-test-harness.mjs`) over checked-in event fixtures captured from the real runtime
(`server/copilot-worker/fixtures/`: `happy-turn`, `abort-turn`, `ask-user-turn`, `quota-turn`,
`reasoning-turn`, `resume-turn`, `subagent-turn`, `tool-permission-turn`,
`background-timer-turn` + `background-timer-continuation` — the two halves of the burn-in timer
incident, cut from the real `~/.copilot/session-state/<id>/events.jsonl` and scrubbed). No e2e stub of the
JSON-RPC protocol exists, and none is planned — see [the plan's §4c](../plans/copilot-sdk-worker.md).

| Suite | Tests | Covers |
| ----- | ----- | ------ |
| `server/copilot-worker/copilot-sdk-session-process.test.mjs` | 90 | turn state machine, resume, steering, abort, idle/stall, plan boards, usage capture, attempt-fencing echo, observed model/effort switching, elicitation round-trip |
| `server/copilot-worker/copilot-sdk-continuation-turn.test.mjs` | 28 | self-initiated turns end to end over the live timer capture: idempotent registration, reply attribution, streams/activity, usage, heartbeat ownership, replay suppression, lifecycle pinning + cap expiry, steering during a continuation, degraded relay, publish-window event rerouting, late-registration teardown, rowReady-gated questions |
| `server/copilot-worker/copilot-continuation-signals.test.mjs` | 21 | shell open/settle/close signals, replay-window arithmetic, opener allowlist |
| `server/copilot-worker/copilot-sdk-steering-parity.test.mjs` | 12 | delivery gate + holds (delivery/question/compaction), steering-held hand-back vs legacy push, fold vs own-run settle by `user.message.delivery`, Stop with steers (stopped + Resend), un-steer via rpc.queue, at-most-once settle markers → heartbeat settleFailed, orphaned-run adoption, snapshot/ownership |
| `server/copilot-worker/copilot-steering-hold-chain.test.mjs` | 2 | the hold end to end over a real socket + the real relay ws service (question hold withdraws readiness, answer draws the message in; old-relay fallback) |
| `server/copilot-worker/copilot-sdk-background-tasks.test.mjs` | 10 | rpc.tasks registry → cards (model, lastToolCall, tokens, summary), panel Stop → tasks.cancel, lifecycle pin + cap cancel + bounded refusals, agent_idle herald → continuation note, later-turn lane suppression, no-rpc.tasks fallback + 30-min shell cap |
<!-- The continuation suite's fake client replays its fixture on the FIRST send only, so a
     steered second prompt does not re-answer with the first turn's transcript. A test that
     delivers a genuinely separate second turn must pass `replayEverySend: true` — otherwise that
     turn never sees a terminator and sits out the whole 120 s stall watchdog before passing, which
     reads as a hung suite rather than a slow one. -->

| `server/copilot-worker/copilot-sdk-event-normalizer.test.mjs` | 46 | event → channel mapping, subagent lane, terminal guards |
| `server/copilot-worker/copilot-sdk-adapter.test.mjs` | 30 | path/version resolution, permission policy, error classification (structured auth + current quota wording) |
| `server/copilot-worker/copilot-model-switch.test.mjs` | 24 | switchTo/setReasoningEffort selection, none→default mapping, deferred drain/expiry, confirmation-required, BYOK RPC-first vs rebuild |
| `server/copilot-worker/copilot-sdk-model-snapshot.test.mjs` | 9 | catalog snapshots on start/resume/model_change, dedupe, BYOK skip |
| `server/copilot-worker/copilot-byok-provider.test.mjs` | 14 | provider config, ceilings, override validation |
| `server/copilot-worker/copilot-question-bridge.test.mjs` | 18 | ask_user + approval cards, freeform flag, schema cards, closing-state expiry |
| `server/copilot-worker/copilot-ask-user-tool.test.mjs` | 9 | relay `ask_user` schema/args/result wording, override registration, card + question hold while open, in-band failure, refused-override fallback, opt-out |
| `server/copilot-worker/copilot-attachments.test.mjs` | 14 | inline blob vs file refs, decoded-size ceiling for data URLs |
| `server/copilot-worker/copilot-plan-board.test.mjs` | 8 | board payload, fallback gating |
| `server/copilot-worker/copilot-prompt-context.test.mjs` | 9 | prompt prefix composition, commit-after-send |
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
- [ ] **Self-initiated turns** — ask for a timer longer than a minute; the "it fired" reply must
      arrive as its own transcript entry (relay log: `CONTINUATION … trigger=background_task`,
      with an `op=` idempotency key).
- [ ] **Background shell outliving the idle window** — start a shell that takes >10 min; the runtime
      must still be up when it settles (it is the shell's parent), and the reply must arrive.
- [ ] **The cap** — a shell that never finishes must stop pinning after 30 min
      (`COPILOT_SDK_RELAY_BACKGROUND_TASK_TIMEOUT_MS`), and the runtime must then idle out.
- [ ] **Resume replay** — restart the worker mid-conversation; the resume must produce **no**
      continuation rows and no duplicated replies.
- [ ] Background-task gating (shells, not Claude-style tasks — see the section above)
- [ ] Idle shutdown
- [ ] Windows spawn
- [ ] Previews lane
- [ ] `/`-command story (or a documented capability difference)
