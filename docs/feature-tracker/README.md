# SDK Feature Tracker

Updated: 2026-08-02
Scope: `server/` + `server/claude-worker/` + `.github/extensions/web-relay/`

The relay is multi-provider. Each provider's SDK surface is tracked in its own file; capabilities
that live in the relay itself (and apply to every provider) are tracked here.

| Provider | Runtime | Tracker |
| -------- | ------- | ------- |
| **Copilot** | `@github/copilot-sdk`, driven by the CLI extension (foreground) or the standalone relay client | [copilot-sdk.md](copilot-sdk.md) |
| **OpenAI (BYOK)** | Rides the Copilot worker via `COPILOT_PROVIDER_*` env vars; image conversations call the OpenAI Images API directly from the relay, outside the SDK turn path | covered by [copilot-sdk.md](copilot-sdk.md) + the core rows below |
| **Claude** | `@anthropic-ai/claude-agent-sdk` in `server/claude-worker/` | [claude-sdk.md](claude-sdk.md) |
| **Cursor** | `@cursor/sdk` — *planned, not yet implemented* | [cursor-sdk.md](cursor-sdk.md) |

> **Evidence style:** rows cite files and exported symbols, not line ranges. Line numbers in this
> document went stale silently and ended up pointing at unrelated code; symbol names survive edits
> and fail loudly when they don't.

Status legend: **Implemented** | **Partial** | **Not implemented**

## Provider capability matrix

The relay-facing contract a provider worker must deliver. This doubles as the implementation
checklist for a new provider — the Cursor column maps each capability to the SDK primitive that
would back it (details in [cursor-sdk.md](cursor-sdk.md)).

| Relay capability | Copilot | Claude | Cursor (planned) |
| ---------------- | ------- | ------ | ---------------- |
| Turn execution + live reply streaming | Implemented | Implemented | `agent.send()` → `run.stream()` / `onDelta` |
| Thought / reasoning streaming | Implemented | Implemented | `thinking` events, `thinking-delta` updates |
| Stop (whole turn) | Implemented | Implemented | `run.cancel()` / `Agent.cancelRun()` |
| Targeted subagent abort | Partial (capability-probed) | Not implemented (SDK gap) | No primitive found — likely same gap |
| Question cards (ask user) | Implemented (`onUserInputRequest`) | Implemented (`AskUserQuestion` via `canUseTool`) | **Gap** — no callback API; likely a custom-tool bridge |
| Structured multi-field forms | Implemented (`onElicitationRequest`) | n/a (single-question cards only) | Unknown |
| Plan boards (`plan_ready`) | Implemented (tool detection + text fallback) | Implemented (`ExitPlanMode` + text fallback) | `mode: "plan"` + text-fallback heuristic |
| Subagent lifecycle bubbles | Implemented (SDK lifecycle events) | Implemented (inferred from tool blocks) | `tool_call` events for the `Agent` tool |
| Per-message model switch | Implemented | Implemented | `send({ model })` — sticky per run, must re-pin |
| Model discovery / catalog | Implemented | Implemented | `Cursor.models.list()` |
| Reasoning effort per turn | Implemented | Implemented | Model `params` — partial mapping only |
| Attachments / images | Implemented | Implemented | `images` on `SDKUserMessage` |
| Resume across worker restarts | Implemented | Implemented | Stable `agentId` + `Agent.resume()` + local store |
| Context usage display | Not implemented | Implemented | Partial — token totals, no context-window fill |
| Auth model | Relay host's CLI login | Relay host's `claude` login | **API key** (`CURSOR_API_KEY`) — a new pattern for the relay |

## Relay core (provider-agnostic)

Features the relay implements above the provider layer. These used to live in the Copilot section
but are not Copilot SDK surface.

| Capability | Status | Notes / evidence |
| ---------- | ------ | ---------------- |
| Per-conversation provider binding | Implemented | `runtime_sessions.provider_type` / `provider_model` pin a conversation to `github`, `openai`, or `claude`. `reconcileUnstartedConversationProviders` (`server/server-runtime.mjs`) is provider-parameterized, only rebinds conversations with no messages and no queued work, restores the previous binding when a provider is re-enabled, and stops/restarts the session worker when worker routing is enabled. Worker-kind routing sets `COPILOT_WEB_RELAY_WORKER_KIND` via `applyClaudeProviderEnvironment` (`server/services/session-worker-launch-service.mjs`). |
| Conversation draft persistence + conflict checks | Implemented | Draft saves are always enabled; `PATCH /api/conversation/:id/draft` rejects stale writes with 409 `draft-version-conflict` on `baseDraftUpdatedAt` mismatch (`server/routes/sessions-routes.mjs`, `server/public/app/conversation-view.js` → `persistConversationDraft`, `server/public/app/conversation-draft-timestamp-utils.mjs`). |
| Default session workspace root / relaunch | Implemented | Launches and workspace-root updates honor a default CWD setting plus recent-root state (`server/services/workspace-root-defaults-service.mjs` → `resolveDefaultSessionWorkspaceRootState`, `server/services/session-worker-launch-service.mjs`). Since 2026-08-02 extended by `workspace-root-path-policy.mjs` (validation / normalization / allow-list), `workspace-root-relaunch-service.mjs` (`evaluateWorkspaceRootRelaunch`, `evaluateReuseCwdMismatch`, relaunch coalescing), and `session-worker-stop-service.mjs` (`stopSessionWorkerProcesses`). |
| Model catalog composition | Implemented | Copilot, OpenAI BYOK, and Claude catalogs are layered into one payload and filtered per conversation provider — `buildModelCatalogWithProviders` wraps `buildModelCatalogWithClaudeProvider` over `buildModelCatalogWithOpenAIProvider` over the base catalog (`server/routes/sessions-routes.mjs`). |
| Installable PWA shell / scoped manifest / service worker | Implemented | Server renders the shell with a path-relative scoped manifest and versioned service worker (`server/public/index.html`, `server/public/manifest.webmanifest`, `server/public/sw.js`). |
| `/compact` workflow | Implemented | Provider-agnostic: branches to a new conversation seeded with a summary rather than using any SDK compaction primitive. (Claude additionally *observes* host-driven compaction — see [claude-sdk.md](claude-sdk.md).) |
| Native chat fork at message X | Not implemented (SDK gaps) | No public primitive wired in any provider for true server-side branch/fork semantics. |
| Native rewind-to-arbitrary-turn | Not implemented (SDK gaps) | No public API wired for arbitrary rewind; the Copilot CLI exposes last-turn `/rewind` UX only. |

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
- 2026-08-02: Split the tracker into `docs/feature-tracker/` — this README (capability matrix, relay-core rows, changelog) plus one file per provider SDK.
- 2026-08-02: Corrections from a full re-audit: `availableTools` is now Partial (empty list passed on history-import resume); elicitation validation actually lives in `shared/question-schema.mjs`, not the schema view; `session.getEvents()` is called only by the import service; the Claude SDK has a second (dynamic) import site in `server-runtime.mjs` for model discovery; the extension path is allow-all via `onPreToolUse` `permissionDecision`, not via CLI posture alone.
- 2026-08-02: Added newly landed Claude surface: `task_notification` system messages, the phantom zero-work result skip, `compact_boundary` activity, `modelUsage`/cost fields on results, and transcript-anchored Session roots.
- 2026-08-02: Added [cursor-sdk.md](cursor-sdk.md) as the implementation reference for the planned Cursor provider.
