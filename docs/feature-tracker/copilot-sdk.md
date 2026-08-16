# Copilot SDK (`@github/copilot-sdk`)

Updated: 2026-08-16 · Part of the [SDK Feature Tracker](README.md) — legend, changelog, and
provider-agnostic relay rows live there.

Two integration paths consume this SDK:

- **Extension mode** — `.github/extensions/web-relay/extension.mjs` is the only static import site
  in scope (`joinSession` from `@github/copilot-sdk/extension`).
- **Standalone / server mode** — `server/copilot-sdk-runtime.mjs` → `createInstalledCopilotClient`
  loads the locally installed SDK (`buildInstalledCopilotClientOptions`: stdio connection,
  `mode: 'empty'`, `useLoggedInUser: true`); `server/relay.mjs` additionally supports a
  `connection.kind === 'uri'` (TCP) foreground mode.

## Session + lifecycle

| SDK feature | Status | Notes / evidence |
| ----------- | ------ | ---------------- |
| `joinSession()` (extension mode) | Implemented | Extension joins the foreground CLI session through `joinSessionWithRetry` (`.github/extensions/web-relay/extension.mjs`, `runtime/session-join-retry.mjs` — 409-conflict retry loop). |
| `CopilotClient.createSession()` (standalone mode) | Implemented | Standalone relay creates SDK sessions in `getOrCreateSession()` (`server/relay.mjs`). |
| `CopilotClient.resumeSession()` | Implemented | Reopens persisted SDK sessions during history import, with `suppressResumeEvent: true` and `availableTools: []` so the import can't execute tools (`server/services/sdk-session-import-service.mjs`). |
| `CopilotClient.listSessions()` | Implemented | Enumerates locally persisted SDK sessions for the startup import (`server/services/sdk-session-import-service.mjs`). |
| `getSessionMetadata()` / `getLastSessionId()` | Not implemented | Not used in relay or extension paths. |
| `CopilotClient.deleteSession()` | Partial | Used for cleanup/deletion flows where the runtime exposes it, guarded otherwise (`.github/extensions/web-relay/polling/polling-loop.mjs`, `server/services/delete-archive-service.mjs`). |
| `session.disconnect()` | Not implemented | No explicit disconnect lifecycle wired. Actual teardown of imported sessions uses `resumed.stop?.()` / `resumed.dispose?.()` (`server/services/sdk-session-import-service.mjs`). |
| `session.abort()` | Implemented | The Stop control aborts the active turn (`.github/extensions/web-relay/polling/polling-loop.mjs`). See "Targeted subagent abort" below for the subagent-scoped variant. |
| `session.log()` | Implemented | Ephemeral CLI banners via `session.log(text, { ephemeral: true })` throughout `extension.mjs` and `polling/polling-loop.mjs`. |
| Conversation history refresh / rebuild from SDK events | Implemented | Relay can clear and rebuild retrievable history from SDK events, falling back to transcript data when needed (`server/services/session-history-refresh-service.mjs`, `server/services/session-transcript-service.mjs`). Of the refresh service's exports, only `evaluateRefreshIdleState` and `replaceRetrievableHistory` have production callers; `mapSdkEventsToMessages` / `persistRebuiltHistory` / `clearRetrievableHistory` are test-only. |

## Turn execution + streaming

| SDK feature | Status | Notes / evidence |
| ----------- | ------ | ---------------- |
| `session.send()` / `session.sendAndWait()` | Implemented | Core turn flow uses send+sendAndWait wrappers (`.github/extensions/web-relay/runtime/session-io.mjs`, `polling/polling-loop.mjs` via the injected `sendAndWaitWithHardTimeout`). |
| Message attachments (file/blob/etc.) | Implemented | `buildSdkAttachments()` maps hydrated uploads to SDK attachments — inline `blob` for images, `file` (path + displayName) otherwise; delivery failure retries the turn without attachments (`.github/extensions/web-relay/polling/polling-loop.mjs`). |
| Per-turn reasoning effort | Implemented | Relay forwards `reasoningEffort` when provided and not `"none"` (`.github/extensions/web-relay/polling/polling-loop.mjs`). |
| Streaming event mode (`streaming: true`) | Implemented | Enabled on join; the extension subscribes `session.on(...)` to `assistant.message`, `assistant.message_delta`, `assistant.reasoning`, `assistant.reasoning_delta` and republishes them as relay stream frames (`.github/extensions/web-relay/extension.mjs`, `skills/reasoning-stream.mjs` → `createReasoningStreamHandlers`). |
| Live assistant text preview | Implemented | Main-thread stream frames are markdown-rendered into the pending bubble while the turn runs and repaint after a reload (`server/public/app/conversation-view.js`, `server/public/app/stream-state.mjs` → `deriveInFlightStreamTextByThread`). |
| Subagent run lifecycle / nested activity | Implemented | `createSubagentLifecycleHandlers` listens to `execution.subagent.start` / `.end` and records runs, activity, thoughts, and per-run stream text; nested bubbles render with stop controls (`.github/extensions/web-relay/skills/subagent-lifecycle.mjs`, `server/repositories/question-repository.mjs` → `listSubagentRunsByResponse`, `server/public/app/conversation-view.js` → `renderSubagentRunsMarkup`). |
| Subagent attribution (`agentId`) | Implemented | The SDK `agentId` is propagated as `subagentRunId` on question activity, tool results, and `report_intent` thoughts, so subagent work renders in its own bubble (`.github/extensions/web-relay/skills/question-routing-hooks.mjs` → `extractSubagentRunIdFromRequest`). |
| Targeted subagent abort | Partial | Per-run cancel probes named methods first — `session.abortSubagentRun`, `abortSubagent`, `abortAgent` — then arity-gated `session.abort({subagentRunId})` / `({agentId})` / `(runId)` shapes; runtimes without a matching primitive report "unsupported" rather than stopping the whole turn (`.github/extensions/web-relay/polling/polling-loop.mjs`). |
| `session.getEvents()` | Partial | Called only by the history import on a resumed session, guarded for runtimes that do not expose it (`server/services/sdk-session-import-service.mjs`). The refresh service consumes already-parsed messages; it never calls `getEvents()` itself. |

## User input + elicitation

| SDK feature | Status | Notes / evidence |
| ----------- | ------ | ---------------- |
| `onUserInputRequest` (ask_user text/choices) | Implemented | Registered as a top-level join option (not inside `hooks`) so the SDK calls it, and bridged to relay question cards (`.github/extensions/web-relay/extension.mjs`, `skills/question-routing-hooks.mjs`; the standalone path registers it in session config in `server/relay.mjs`). |
| `onElicitationRequest` (structured forms) | Implemented | Multi-field structured forms handled; the wire field `requestedSchema` is normalized to `requestSchema`, fields parsed by `server/public/app/question-schema-view.mjs`, and answers validated by `shared/question-schema.mjs` → `validateStructuredAnswer` (consumed in `server/routes/ask-user-routes.mjs`). |
| Plain-text question fallback | Not implemented | Every relay question card originates from an explicit request — `onUserInputRequest`, `onElicitationRequest`, or Claude's `AskUserQuestion`. `/api/relay-question` is POSTed from exactly one place (`skills/question-bridge.mjs` → `forwardRelayQuestion`), reachable only from those callbacks; the prompt sanitizers instead instruct the model never to ask in plain text. |
| Session UI helpers (`session.ui.confirm/select/input/elicitation`) | Not implemented | Relay uses the callback bridge instead of the direct session UI API. |
| `onExitPlanModeRequest` | Not implemented | No top-level registration. Plan boards are derived from `plan_ready` detection in the tool path (`skills/question-routing-hooks.mjs` → `buildPlanBoardPayloadFromRequest`) plus a plan-mode text fallback: final text with ≥2 bullet/numbered lines becomes a `plan_ready` board tagged `source: "plan-mode-fallback"` (`polling/polling-loop.mjs` → `allowPlanModeFallback`, `buildPlanReadyBoardPayload`). This mirrors the Claude worker's heuristic. |
| `onAutoModeSwitchRequest` | Not implemented | No top-level registration; `"auto"` model selection is instead handled by forcing a session boundary (`model-api/model-switching.mjs` → `requiresSessionBoundary`). |

## Hooks + permissions

| SDK feature | Status | Notes / evidence |
| ----------- | ------ | ---------------- |
| `hooks.onPreToolUse` | Implemented | Used for activity routing, subagent lifecycle publishing, and the ask_user pre-bridge (`.github/extensions/web-relay/extension.mjs`, `skills/question-routing-hooks.mjs`, `skills/subagent-lifecycle.mjs`). |
| `hooks.onSessionStart` / `hooks.onSessionEnd` | Implemented | Relay activation, startup workspace-root sync, and graceful shutdown (`.github/extensions/web-relay/extension.mjs`). |
| `hooks.onPostToolUse` | Implemented | Registered in extension join options and used to publish subagent lifecycle updates and tool-result activity (`.github/extensions/web-relay/extension.mjs`, `skills/subagent-lifecycle.mjs`). |
| `onPreMcpToolCall` / `onUserPromptSubmitted` / `onErrorOccurred` | Not implemented | Not registered in join options. |
| `onPermissionRequest` | Partial | Standalone relay sets `approveAll` (`server/relay.mjs` → `getOrCreateSession`). The extension path registers no permission handler, but is effectively allow-all anyway: `onPreToolUse` unconditionally returns `permissionDecision: "allow"` (`skills/question-routing-hooks.mjs` → `allowToolUse`). |

## Models + model APIs

| SDK feature | Status | Notes / evidence |
| ----------- | ------ | ---------------- |
| Model switch per turn | Implemented | Extension path via the `session.rpc.model.switchTo({ modelId, contextTier })` RPC (`model-api/model-switching.mjs`); the standalone relay calls its own `setModelForMessage` in `processNext` since 2026-08-16 — the helper existed but had no caller, so cached sessions silently kept their creation model. |
| Runtime model discovery | Implemented | Extension calls the `models.list` RPC over `session.connection.sendRequest` and publishes a snapshot to `POST /api/models/snapshot`, including on the error path (`.github/extensions/web-relay/model-api/model-switching.mjs`). |
| `session.setModel()` helper | Not implemented | The implementation uses `session.rpc.model.switchTo(...)` rather than `session.setModel(...)`. |
| `client.listModels()` | Partial | Available and used by the standalone relay path only (`server/relay.mjs`); the extension path prefers the `models.list` RPC. |

## Advanced session configuration

| SDK feature | Status | Notes / evidence |
| ----------- | ------ | ---------------- |
| `requestCanvasRenderer` / canvas APIs | Not implemented | No canvas renderer opt-in or canvas API wiring. |
| `requestExtensions` / slash `commands` | Not implemented | No SDK session config for extension surface commands in relay path. |
| Tool filters (`availableTools` / `excludedTools`) | Partial | `availableTools: []` is passed on `resumeSession()` during history import — deliberately empty so an imported session cannot execute tools (`server/services/sdk-session-import-service.mjs`). Not configured on any create/join path; `excludedTools` unused. |
| `mcpServers` session config | Not implemented | No custom MCP server config set by relay runtime. |
| `customAgents` / `defaultAgent` / startup `agent` | Not implemented | Not configured by relay runtime. |
| `skillDirectories` / `instructionDirectories` / `disabledSkills` | Not implemented | Not configured by relay runtime. |
| `provider` (BYOK) | Partial | BYOK is configured through the CLI's `COPILOT_PROVIDER_*` environment variables on the worker launch env, not through an SDK session config option (`server/services/session-worker-launch-service.mjs` → `applyOpenAIProviderEnvironment`). |
| `remoteSession` mode (`off/export/on`) | Not implemented | Not configured by relay runtime. |
| `cloud` session creation options | Not implemented | No `cloud` create-session usage. |
| `infiniteSessions` tuning | Not implemented | No explicit tuning/override configured by relay runtime. |

## Client/runtime integration

| SDK feature | Status | Notes / evidence |
| ----------- | ------ | ---------------- |
| Runtime connection modes | Implemented | Standalone supports hidden stdio and foreground TCP connection handling (`server/relay.mjs`; options assembled by `server/copilot-sdk-runtime.mjs` → `buildInstalledCopilotClientOptions`). |
| SDK auto-detection / version pin | Implemented | Highest available `copilot-sdk/index.js` + `app.js` under the platform pkg root (descending semver sort), overridable with `sdkPath`/`cliPath`/`sdkVersion`/`COPILOT_PKG_DIR` (`server/copilot-sdk-runtime.mjs` → `resolveInstalledCopilotPaths`). |
| Telemetry config / trace-context provider | Not implemented | No relay wiring for `telemetry` / `onGetTraceContext` options. |
| Session filesystem provider (`sessionFs`) | Not implemented | No custom session FS provider registered. |
| Session lifecycle subscriptions (`client.onLifecycle`) | Not implemented | Not used in relay runtime. |
| TUI foreground control (`get/setForegroundSessionId`) | Not implemented | Not used in relay runtime. |
