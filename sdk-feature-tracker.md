# SDK Feature Tracker (relay/app)

Updated: 2026-08-01
Scope: `server/` + `server/claude-worker/` + `.github/extensions/web-relay/`

Two agent SDKs now back the relay, tracked separately below:

- **[Copilot SDK](#copilot-sdk)** (`@github/copilot-sdk`) — the default runtime, driven by the CLI extension.
- **[Claude Agent SDK](#claude-agent-sdk)** (`@anthropic-ai/claude-agent-sdk`) — the Claude provider's worker.

> **Evidence style:** rows cite files and exported symbols, not line ranges. Line numbers in this
> document went stale silently and ended up pointing at unrelated code; symbol names survive edits
> and fail loudly when they don't.

## Changelog

- 2026-06-20: Wired SDK `hooks.onPostToolUse` in extension mode for subagent lifecycle publishing.
- 2026-06-20: Wired SDK history-fetch polling to `session.getEvents()`; behavior is guarded when runtime lacks the method.
- 2026-06-20: Added installable PWA shell support with a scoped manifest and versioned service worker.
- 2026-06-20: Added session history refresh, default session workspace root settings, draft version conflict handling, and subagent lifecycle tracking.
- 2026-07-13: Removed conversation draft persistence feature flag; draft persistence is now always-on.
- 2026-07-23: OpenAI BYOK image conversations call the Images API directly from the relay, outside the SDK turn path.
- 2026-07-25: Added image operation continuity so a generated image can be used as the source for the next turn.
- 2026-07-30: Added per-message share visibility (`hidden_from_shares`), filtered out of shared views.
- 2026-08-01: Added the Claude Agent SDK provider (`server/claude-worker/`) with its own coverage table.
- 2026-08-01: Corrected `resumeSession()` / `listSessions()` from "Not implemented" — both are used by the SDK session import service.
- 2026-08-01: Corrected the documented "plain-text question auto-conversion" fallback — no such code exists; `ask_user` is still the only path to a question card.
- 2026-08-01: Re-anchored all evidence from line ranges to file + symbol references after finding the ranges stale.

Status legend: **Implemented** | **Partial** | **Not implemented**

# Copilot SDK

## Session + lifecycle


| SDK feature                                                                    | Status          | Notes / evidence                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `joinSession()` (extension mode)                                               | Implemented     | Extension joins the foreground CLI session through `joinSessionWithRetry` (`.github/extensions/web-relay/extension.mjs`, `runtime/session-join-retry.mjs`).                                                                                                                  |
| `CopilotClient.createSession()` (standalone mode)                              | Implemented     | Standalone relay creates SDK sessions in `getOrCreateSession()` (`server/relay.mjs`).                                                                                                                                                                                        |
| `CopilotClient.resumeSession()`                                                | Implemented     | Used to reopen persisted SDK sessions during history import (`server/services/sdk-session-import-service.mjs`).                                                                                                                                                              |
| `CopilotClient.listSessions()`                                                 | Implemented     | Enumerates locally persisted SDK sessions for the startup import (`server/services/sdk-session-import-service.mjs`).                                                                                                                                                         |
| `getSessionMetadata()` / `getLastSessionId()`                                  | Not implemented | Not used in relay or extension paths.                                                                                                                                                                                                                                       |
| `CopilotClient.deleteSession()`                                                | Partial         | Used for cleanup/deletion flows where the runtime exposes it, guarded otherwise (`.github/extensions/web-relay/polling/polling-loop.mjs`, `server/services/delete-archive-service.mjs`).                                                                                     |
| `session.disconnect()`                                                         | Not implemented | No explicit disconnect lifecycle wired.                                                                                                                                                                                                                                     |
| `session.abort()`                                                              | Implemented     | The Stop control aborts the active turn; a subagent-targeted variant is probed through several call shapes before falling back (`.github/extensions/web-relay/polling/polling-loop.mjs`).                                                                                    |
| Conversation draft persistence + conflict checks                               | Implemented     | Draft saves are always enabled and reject stale writes with 409 conflicts (`server/routes/sessions-routes.mjs`, `server/public/app/conversation-view.js`, `server/public/app/journal-view.js`, `server/public/app/conversation-draft-timestamp-utils.mjs`).                  |
| Conversation history refresh / rebuild from SDK events                         | Implemented     | Relay can clear and rebuild retrievable history from SDK events, falling back to transcript data when needed (`server/services/session-history-refresh-service.mjs`, `server/services/session-transcript-service.mjs`).                                                      |
| Default session workspace root / launch fallback                               | Implemented     | New session launches and workspace-root updates honor a default CWD setting plus recent-root state (`server/services/workspace-root-defaults-service.mjs`, `server/services/session-worker-launch-service.mjs`).                                                             |
| Per-conversation provider binding                                              | Implemented     | `runtime_sessions.provider_type` / `provider_model` pin a conversation to Copilot, OpenAI, or Claude; disabling a provider rebinds only its *unstarted* conversations (`server/server-runtime.mjs` → `reconcileUnstartedConversationProviders`).                             |


## Turn execution + streaming


| SDK feature                                | Status      | Notes / evidence                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.send()` / `session.sendAndWait()` | Implemented | Core turn flow uses send+sendAndWait wrappers (`.github/extensions/web-relay/runtime/session-io.mjs`, `polling/polling-loop.mjs`).                                                                                                                                                          |
| Message attachments (file/blob/etc.)       | Implemented | Relay maps hydrated uploads to SDK attachments — `file` when a disk path exists, otherwise inline `blob` (`.github/extensions/web-relay/polling/polling-loop.mjs`).                                                                                                                          |
| Per-turn reasoning effort                  | Implemented | Relay forwards `reasoningEffort` when provided (`.github/extensions/web-relay/polling/polling-loop.mjs`).                                                                                                                                                                                    |
| Streaming event mode (`streaming: true`)   | Implemented | Enabled on join; deltas consumed and republished as relay stream frames (`.github/extensions/web-relay/extension.mjs`, `skills/reasoning-stream.mjs`).                                                                                                                                       |
| Live assistant text preview                | Implemented | Main-thread stream frames are markdown-rendered into the pending bubble while the turn runs and repaint after a reload (`server/public/app/conversation-view.js`, `server/public/app/stream-state.mjs` → `deriveInFlightStreamTextByThread`).                                                |
| Subagent run lifecycle / nested activity   | Implemented | Relay records subagent runs, activity, thoughts, and per-run stream text, then renders nested bubbles with stop controls (`.github/extensions/web-relay/skills/subagent-lifecycle.mjs`, `server/repositories/question-repository.mjs` → `listSubagentRunsByResponse`, `server/public/app/conversation-view.js` → `renderSubagentRunsMarkup`). |
| Subagent attribution (`agentId`)           | Implemented | The SDK `agentId` is propagated as `subagentRunId` on question activity, tool results, and `report_intent` thoughts, so subagent work renders in its own bubble (`.github/extensions/web-relay/skills/question-routing-hooks.mjs` → `extractSubagentRunIdFromRequest`).                       |
| Targeted subagent abort                    | Partial     | The relay exposes a per-run cancel control and probes several `session.abort(...)` call shapes; runtimes without a matching primitive report "unsupported" rather than stopping the whole turn (`.github/extensions/web-relay/polling/polling-loop.mjs`).                                     |
| `session.getEvents()`                      | Partial     | Used to rebuild history from a resumed session, guarded for runtimes that do not expose it (`server/services/sdk-session-import-service.mjs`).                                                                                                                                               |


## User input + elicitation


| SDK feature                                                        | Status          | Notes / evidence                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `onUserInputRequest` (ask_user text/choices)                       | Implemented     | Registered as a top-level option (not inside `hooks`) so the SDK calls it, and bridged to relay question cards (`.github/extensions/web-relay/extension.mjs`, `skills/question-routing-hooks.mjs`).                       |
| `onElicitationRequest` (structured forms)                          | Implemented     | Multi-field structured forms handled and validated against `requestSchema` (`.github/extensions/web-relay/skills/question-routing-hooks.mjs`, `server/public/app/question-schema-view.mjs`).                              |
| Plain-text question fallback                                       | Not implemented | Every relay question card originates from an explicit request — `onUserInputRequest`, `onElicitationRequest`, or Claude's `AskUserQuestion`. A turn that merely *ends* with a plain-text question is not converted into a card, so `ask_user` remains the only way to reach the browser. |
| Session UI helpers (`session.ui.confirm/select/input/elicitation`) | Not implemented | Relay uses the callback bridge instead of the direct session UI API.                                                                                                                                                     |
| `onExitPlanModeRequest`                                            | Not implemented | No top-level registration in join/create configs. Plan boards are instead derived from `plan_ready` detection in the tool/turn path (`.github/extensions/web-relay/skills/question-routing-hooks.mjs`, `polling/polling-loop.mjs`). |
| `onAutoModeSwitchRequest`                                          | Not implemented | No top-level registration in join/create configs.                                                                                                                                                                        |


## Hooks + permissions


| SDK feature                                                      | Status          | Notes / evidence                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks.onPreToolUse`                                             | Implemented     | Used for activity routing, subagent lifecycle publishing, and the ask_user pre-bridge (`.github/extensions/web-relay/extension.mjs`, `skills/question-routing-hooks.mjs`, `skills/subagent-lifecycle.mjs`).                                                                              |
| `hooks.onSessionStart` / `hooks.onSessionEnd`                    | Implemented     | Relay activation, startup workspace-root sync, and graceful shutdown (`.github/extensions/web-relay/extension.mjs`).                                                                                                                                                                    |
| `hooks.onPostToolUse`                                            | Implemented     | Registered in extension join options and used to publish subagent lifecycle updates and tool-result activity (`.github/extensions/web-relay/extension.mjs`, `skills/subagent-lifecycle.mjs`).                                                                                            |
| `onPreMcpToolCall` / `onUserPromptSubmitted` / `onErrorOccurred` | Not implemented | Not registered in join options.                                                                                                                                                                                                                                                          |
| `onPermissionRequest`                                            | Partial         | Standalone relay sets `approveAll`; the extension-join path relies on the CLI's own `--allow-all` posture rather than a custom permission handler (`server/relay.mjs` → `getOrCreateSession`).                                                                                           |


## Models + model APIs


| SDK feature                 | Status          | Notes / evidence                                                                                                                                           |
| --------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model switch per turn       | Implemented     | Relay switches the requested model per message via the model-switching service (`.github/extensions/web-relay/model-api/model-switching.mjs`, `server/relay.mjs` → `setModelForMessage`). |
| Runtime model discovery     | Implemented     | Extension calls the `models.list` RPC over `session.connection.sendRequest` and publishes a snapshot to `POST /api/models/snapshot` (`.github/extensions/web-relay/model-api/model-switching.mjs`).      |
| `session.setModel()` helper | Not implemented | The implementation uses RPC-level model methods rather than `session.setModel(...)` directly.                                                                                             |
| `client.listModels()`       | Partial         | Available and used by the standalone relay path (`server/relay.mjs`); the extension path prefers the `models.list` RPC.                                                                   |
| Model catalog composition   | Implemented     | Copilot, OpenAI BYOK, and Claude catalogs are layered into one payload and filtered per conversation provider (`server/routes/sessions-routes.mjs` → `buildModelCatalogWithOpenAIProvider` / `buildModelCatalogWithClaudeProvider`). |


## Advanced session configuration


| SDK feature                                                      | Status          | Notes / evidence                                                    |
| ---------------------------------------------------------------- | --------------- | ------------------------------------------------------------------- |
| `requestCanvasRenderer` / canvas APIs                            | Not implemented | No canvas renderer opt-in or canvas API wiring.                     |
| `requestExtensions` / slash `commands`                           | Not implemented | No SDK session config for extension surface commands in relay path. |
| Tool filters (`availableTools` / `excludedTools`)                | Not implemented | Not configured in current session creation/join options.            |
| `mcpServers` session config                                      | Not implemented | No custom MCP server config set by relay runtime.                   |
| `customAgents` / `defaultAgent` / startup `agent`                | Not implemented | Not configured by relay runtime.                                    |
| `skillDirectories` / `instructionDirectories` / `disabledSkills` | Not implemented | Not configured by relay runtime.                                    |
| `provider` (BYOK)                                                | Partial         | BYOK is configured through the CLI's `COPILOT_PROVIDER_*` environment variables on the worker launch env, not through an SDK session config option (`server/services/session-worker-launch-service.mjs` → `applyOpenAIProviderEnvironment`). |
| `remoteSession` mode (`off/export/on`)                           | Not implemented | Not configured by relay runtime.                                    |
| `cloud` session creation options                                 | Not implemented | No `cloud` create-session usage.                                    |
| `infiniteSessions` tuning                                        | Not implemented | No explicit tuning/override configured by relay runtime.            |


## Client/runtime integration


| SDK feature                                              | Status          | Notes / evidence                                                                                                                                                                                                                              |
| -------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime connection modes                                 | Implemented     | Standalone supports hidden stdio and foreground TCP connection handling (`server/relay.mjs`).                                                                                                                                                  |
| SDK auto-detection / version pin                         | Implemented     | Highest available `copilot-sdk/index.js` + `app.js` under the platform pkg root, overridable with `sdkPath`/`cliPath`/`sdkVersion`/`COPILOT_PKG_DIR` (`server/copilot-sdk-runtime.mjs`).                                                        |
| Installable PWA shell / scoped manifest / service worker | Implemented     | Server renders the shell with a path-relative scoped manifest and versioned service worker (`server/public/index.html`, `server/public/manifest.webmanifest`, `server/public/sw.js`).                                                          |
| Telemetry config / trace-context provider                | Not implemented | No relay wiring for `telemetry` / `onGetTraceContext` options.                                                                                                                                                                                |
| Session filesystem provider (`sessionFs`)                | Not implemented | No custom session FS provider registered.                                                                                                                                                                                                     |
| Session lifecycle subscriptions (`client.onLifecycle`)   | Not implemented | Not used in relay runtime.                                                                                                                                                                                                                    |
| TUI foreground control (`get/setForegroundSessionId`)    | Not implemented | Not used in relay runtime.                                                                                                                                                                                                                    |


## Conversation control gaps (important)


| Capability                          | Status                    | Notes                                                                                   |
| ----------------------------------- | ------------------------- | --------------------------------------------------------------------------------------- |
| Native SDK chat fork at message X   | Not implemented (SDK gap) | No public primitive currently wired for true server-side branch/fork semantics.         |
| Native SDK rewind-to-arbitrary-turn | Not implemented (SDK gap) | No public API currently wired for arbitrary rewind; CLI exposes last-turn `/rewind` UX. |


# Claude Agent SDK

Package: `@anthropic-ai/claude-agent-sdk`. Everything below lives in `server/claude-worker/`, which
is the only place in the repo that imports it — `claude-sdk-adapter.mjs` is the single import site,
so the SDK surface the relay depends on is auditable from one file.

Authentication uses the relay host's logged-in Claude credentials; the relay stores no API key.

## Turn execution


| SDK feature                            | Status          | Notes / evidence                                                                                                                                                                       |
| -------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query()` streaming-input mode         | Implemented     | Required for image content blocks. The user-message stream is *gated*: it stays open after yielding the message so end-of-turn control requests still have a transport (`claude-sdk-adapter.mjs` → `startClaudeTurn`, `createGatedUserMessageStream`). |
| `options.resume`                       | Implemented     | The native session id from the first turn is persisted and replayed, so a conversation survives worker restarts (`claude-turn-runner.mjs` → `persistNativeSessionId`).                  |
| `options.model` (per turn)             | Implemented     | Per-message model wins; conversation provider model and worker default are fallbacks (`claude-turn-runner.mjs`).                                                                       |
| `options.effort` (per turn)            | Implemented     | `none` maps to "omit the option" (SDK default); the rest pass through (`claude-sdk-adapter.mjs` → `normalizeClaudeEffort`).                                                            |
| `options.permissionMode`               | Partial         | Only `plan` (relay `plan` mode) and `default` are used; `acceptEdits` / `bypassPermissions` are not wired (`claude-sdk-adapter.mjs` → `permissionModeForRelayMode`).                   |
| `options.systemPrompt` (preset+append) | Implemented     | `claude_code` preset with a mode-specific append for `ask` and `autopilot` (`claude-sdk-adapter.mjs` → `systemPromptForRelayMode`).                                                     |
| `options.includePartialMessages`       | Implemented     | Drives live reply streaming and thought streaming (`claude-sdk-adapter.mjs`, `sdk-message-normalizer.mjs`).                                                                            |
| `options.forwardSubagentText`          | Implemented     | Subagent text is forwarded and routed to its own bubble by `subagentRunId`; main-thread text is tracked separately so subagent prose can never be published as the reply.               |
| `options.abortController`              | Implemented     | Backs the relay Stop control, driven by the control poller (`control-poller.mjs`, `claude-turn-runner.mjs`).                                                                            |
| `options.cwd`                          | Implemented     | Set from `COPILOT_WORKSPACE_ROOT` (`claude-session-worker.mjs`).                                                                                                                        |
| `options.pathToClaudeCodeExecutable`   | Implemented     | Set from `CLAUDE_CODE_EXECUTABLE` when provided.                                                                                                                                        |
| `options.maxTurns`                     | Not implemented | Turn length is bounded by the relay's own inactivity window and max-turn-duration ceiling instead.                                                                                      |
| Image content blocks                   | Implemented     | Images ≤ 5 MB are inlined as base64; larger images and non-image files become absolute path references for the `Read` tool (`claude-attachments.mjs`).                                  |


## Control requests + tools


| SDK feature                         | Status          | Notes / evidence                                                                                                                                                                                     |
| ----------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `canUseTool`                        | Partial         | Everything is auto-allowed (parity with the Copilot workers' `--allow-all`); only `AskUserQuestion` and `ExitPlanMode` are intercepted (`claude-sdk-adapter.mjs` → `createCanUseTool`).               |
| `AskUserQuestion` tool              | Implemented     | Bridged to relay question cards, one card per question entry, returning the collected `answers` map as `updatedInput` (`ask-user-bridge.mjs`).                                                        |
| `ExitPlanMode` tool                 | Implemented     | Publishes a `plan_ready` relay board; a heuristic fallback also posts one when a `plan`-mode turn ends with a plan-shaped reply but never called the tool (`claude-turn-runner.mjs`).                  |
| `query.supportedModels()`           | Implemented     | Model discovery via a short-lived idle query with a 20 s timeout; keeps explicit `claude-*` ids (including `[1m]` variants) and drops bare aliases (`server/server-runtime.mjs` → `refreshClaudeProviderModels`). |
| `query.getContextUsage()`           | Implemented     | Read from inside the message loop while the transport is still open, then posted to the relay (`claude-sdk-adapter.mjs` → `readContextUsage`, 10 s timeout).                                          |
| `query.setMaxThinkingTokens()`      | Partial         | Called only as `(null, 'summarized')` to make existing thinking *visible* without enabling it or changing a budget. Deprecated and best-effort; failures are logged and ignored.                       |
| `query.close()`                     | Implemented     | Used to tear down the discovery query (`server/server-runtime.mjs`).                                                                                                                                  |
| Targeted subagent cancellation      | Not implemented (SDK gap) | No per-subagent cancellation primitive; `abort_subagent` control requests are answered with an explicit "not supported" result and full-turn Stop remains available (`control-poller.mjs`). |


## Session configuration not wired


| SDK feature                                        | Status          | Notes                                                                                            |
| -------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `options.hooks`                                    | Not implemented | Relay observation is done by normalizing the SDK message stream instead (`sdk-message-normalizer.mjs`). |
| `options.mcpServers`                               | Not implemented | No relay-supplied MCP servers; the host's own configuration applies.                             |
| `options.agents` / custom subagent definitions     | Not implemented | Subagents are observed, not defined, by the relay.                                                |
| `options.allowedTools` / `disallowedTools`         | Not implemented | Tool gating is handled entirely in `canUseTool`.                                                  |
| `options.settingSources` / skills / plugins        | Not implemented | Not configured by the worker.                                                                     |
| `options.thinking`                                 | Not implemented | Deliberate: every variant forces a `type`, which would override the host's own thinking settings. |
| `options.fallbackModel`                            | Not implemented | Not configured by the worker.                                                                     |
| SDK-native compaction                              | Not implemented | The relay's `/compact` workflow is provider-agnostic and branches to a new conversation seeded with a summary, rather than using an SDK primitive. |

