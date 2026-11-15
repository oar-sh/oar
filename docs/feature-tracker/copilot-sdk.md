# Copilot SDK (`@github/copilot-sdk`)

Updated: 2026-11-14 · Part of the [SDK Feature Tracker](README.md) — legend, changelog, and
provider-agnostic relay rows live there.

Two integration paths consume this SDK. This file tracks the first; the second, the headless
per-conversation worker that runs every Copilot, OpenAI (BYOK) and OpenAI Image conversation, has
its own file ([copilot-sdk-worker.md](copilot-sdk-worker.md)). The Copilot CLI extension
(`joinSession` from `@github/copilot-sdk/extension`, the Extension engine) was removed on
2026-11-14, with its rows here, and so was the hand-started standalone relay client
(`server/relay.mjs`), which created sessions and ran turns on this path; the rows for turns,
questions, permissions and model switches are in [copilot-sdk-worker.md](copilot-sdk-worker.md).

- **Relay side** — `server/copilot-sdk-runtime.mjs` → `createInstalledCopilotClient`
  loads the locally installed SDK (`buildInstalledCopilotClientOptions`: stdio connection,
  `mode: 'empty'`, `useLoggedInUser: true`) for the history import, the session delete and the
  model discovery.

## Session + lifecycle

| SDK feature | Status | Notes / evidence |
| ----------- | ------ | ---------------- |
| `CopilotClient.resumeSession()` | Implemented | Reopens persisted SDK sessions during history import, with `suppressResumeEvent: true` and `availableTools: []` so the import can't execute tools (`server/services/sdk-session-import-service.mjs`). |
| `CopilotClient.listSessions()` | Implemented | Enumerates locally persisted SDK sessions for the startup import (`server/services/sdk-session-import-service.mjs`). |
| `getSessionMetadata()` / `getLastSessionId()` | Not implemented | Not used in relay paths. |
| `CopilotClient.deleteSession()` | Implemented | Conversation delete calls it through the SDK session importer's runtime client (`sdk-session-import-service.mjs` → `deleteSession`), after the conversation's session worker is stopped (`DELETE /api/conversation/:id`, `sessions-routes.mjs`). A conversation deleted before its first turn has no session folder yet and is not sent. Neither is one the relay only imported and never ran (`isImportedOnly`): it is hidden and tombstoned, its CLI session kept and no process stopped. A folder the runtime answers "Session file not found" for is removed directly. A delete the runtime fails otherwise is logged and not retried, and the conversation is deleted all the same: that CLI session's state stays on disk. Until 2026-11-14 such a session went on the SDK delete queue for the extension; the table (`sdk_delete_requests`) stays in the database and is no longer read. |
| `session.disconnect()` | Implemented (import path) | Imported resumed sessions are torn down with `await resumed.disconnect()` — the actual 1.0.13 cleanup API; the old optional `stop?.()`/`dispose?.()` calls matched nothing (`server/services/sdk-session-import-service.mjs`). |
| Conversation history refresh / rebuild from SDK events | Implemented | Relay can clear and rebuild retrievable history from SDK events, falling back to transcript data when needed (`server/services/session-history-refresh-service.mjs`, `server/services/session-transcript-service.mjs`). Of the refresh service's exports, only `evaluateRefreshIdleState` and `replaceRetrievableHistory` have production callers; `mapSdkEventsToMessages` / `persistRebuiltHistory` / `clearRetrievableHistory` are test-only. |

## Turn execution + streaming

| SDK feature | Status | Notes / evidence |
| ----------- | ------ | ---------------- |
| Live assistant text preview | Implemented | Main-thread stream frames are markdown-rendered into the pending bubble while the turn runs and repaint after a reload (`server/public/app/conversation-view.js`, `server/public/app/stream-state.mjs` → `deriveInFlightStreamTextByThread`). |
| `session.getEvents()` | Partial | Called only by the history import on a resumed session, guarded for runtimes that do not expose it (`server/services/sdk-session-import-service.mjs`). The refresh service consumes already-parsed messages; it never calls `getEvents()` itself. |

## User input + elicitation

| SDK feature | Status | Notes / evidence |
| ----------- | ------ | ---------------- |
| `onElicitationRequest` (structured forms) | Implemented | Multi-field structured forms handled; the wire field `requestedSchema` is normalized to `requestSchema`, fields parsed by `server/public/app/question-schema-view.mjs`, and answers validated by `shared/question-schema.mjs` → `validateStructuredAnswer` (consumed in `server/routes/ask-user-routes.mjs`). |
| Session UI helpers (`session.ui.confirm/select/input/elicitation`) | Not implemented | Relay uses the callback bridge instead of the direct session UI API. |

## Models + model APIs

| SDK feature | Status | Notes / evidence |
| ----------- | ------ | ---------------- |
| `client.listModels()` | Implemented | The relay's Copilot model discovery asks the installed runtime on a client of its own and feeds the model catalog (`server/services/copilot-model-discovery-service.mjs`). |

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
| Runtime connection modes | Partial | The relay side connects over hidden stdio only (`server/copilot-sdk-runtime.mjs` → `buildInstalledCopilotClientOptions`); the foreground TCP mode went with `server/relay.mjs`. |
| SDK auto-detection / version pin | Implemented | Highest available version folder with `copilot-sdk/index.js` and `app.js` across the Copilot CLI's package folders (`getCopilotBaseDirs`: `COPILOT_PKG_DIR` first, then the cache folders per platform, `~/.copilot/pkg` and the older locations), overridable with `sdkPath`/`cliPath`/`sdkVersion` (`server/copilot-sdk-runtime.mjs` → `resolveInstalledCopilotPaths`). A worker launch asks again each time and a `COPILOT_SDK_PATH` in the environment wins (`resolveCopilotSdkLaunchPath`); nothing found fails the launch with the folders searched. |
| Telemetry config / trace-context provider | Not implemented | No relay wiring for `telemetry` / `onGetTraceContext` options. |
| Session filesystem provider (`sessionFs`) | Not implemented | No custom session FS provider registered. |
| Session lifecycle subscriptions (`client.onLifecycle`) | Not implemented | Not used in relay runtime. |
| TUI foreground control (`get/setForegroundSessionId`) | Not implemented | Not used in relay runtime. |
