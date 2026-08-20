# SDK Feature Tracker

Updated: 2026-08-20
Scope: `server/` + `server/claude-worker/` + `.github/extensions/web-relay/`

The relay is multi-provider. Each provider's SDK surface is tracked in its own file; capabilities
that live in the relay itself (and apply to every provider) are tracked here.

| Provider | Runtime | Tracker |
| -------- | ------- | ------- |
| **Copilot** | `@github/copilot-sdk`, driven by the CLI extension (foreground) or the standalone relay client | [copilot-sdk.md](copilot-sdk.md) |
| **OpenAI (BYOK)** | Rides the Copilot worker via `COPILOT_PROVIDER_*` env vars; image conversations call the OpenAI Images API directly from the relay, outside the SDK turn path | covered by [copilot-sdk.md](copilot-sdk.md) + the core rows below |
| **Claude** | `@anthropic-ai/claude-agent-sdk` in `server/claude-worker/` | [claude-sdk.md](claude-sdk.md) |
| **Cursor** | `@cursor/sdk` in `server/cursor-worker/` — *implemented, pending live validation* | [cursor-sdk.md](cursor-sdk.md) |
| **Grok** | Grok CLI ACP (`grok agent stdio`) in `server/grok-worker/` — host login, no npm agent SDK | [grok-sdk.md](grok-sdk.md) |

> **Evidence style:** rows cite files and exported symbols, not line ranges. Line numbers in this
> document went stale silently and ended up pointing at unrelated code; symbol names survive edits
> and fail loudly when they don't.

Status legend: **Implemented** | **Partial** | **Not implemented**

## Provider capability matrix

The relay-facing contract a provider worker must deliver. This doubles as the implementation
checklist for a new provider (details per column in the per-SDK files).

| Relay capability | Copilot | Claude | Cursor | Grok |
| ---------------- | ------- | ------ | ------ | ---- |
| Turn execution + live reply streaming | Implemented | Implemented | Implemented (`run.stream()` + `onDelta` merged) | Implemented (ACP `session/update`) |
| Thought / reasoning streaming | Implemented | Implemented | Implemented (`thinking-delta` / `thinking` events) | Implemented |
| Stop (whole turn) | Implemented | Implemented | Implemented (`run.cancel()` + abort-signal race) | Implemented (`session/cancel`) |
| Targeted subagent abort | Partial (capability-probed) | Implemented for backgrounded subagents (`stopTask` via the task↔tool_use_id map, 2026-08-16); in-turn subagents remain whole-turn Stop | Not implemented (SDK gap; button pins "Stop unavailable") | Not implemented (protocol gap) |
| Question cards (ask user) | Implemented (`onUserInputRequest`) | Implemented (`AskUserQuestion` via `canUseTool`; between-turn background-agent questions ride a continuation turn) | Implemented (`ask_user` custom tool; 10/10 live compliance) | Not implemented — **protocol gap**: ACP has no free-form ask-user surface (only `session/request_permission`, which the relay auto-approves) |
| Structured multi-field forms | Implemented (`onElicitationRequest`) | n/a (single-question cards only) | n/a | n/a |
| Plan boards (`plan_ready`) | Implemented (tool detection + text fallback) | Implemented (`ExitPlanMode` + text fallback) | Implemented (text fallback only) | Implemented (text fallback only) |
| Subagent lifecycle bubbles | Implemented (SDK lifecycle events) | Implemented (inferred from tool blocks) | Implemented **with text/thinking attribution** via `tool-call-delta` nested frames (live-verified 2026-08-16) | Implemented (title/name-shaped detection; lifecycle chips) |
| Per-message model switch | Implemented (both paths since 2026-08-16) | Implemented | Implemented (re-pinned every send — sticky overrides) | Not implemented (locked; 409 + composer pin) |
| Model discovery / catalog | Implemented | Implemented | Implemented (`Cursor.models.list()`) | Implemented (initialize `_meta.modelState` + CLI fallback) |
| Reasoning effort per turn | Implemented | Implemented (plus the derived **Ultracode** tier on xhigh-capable models — a settings flag, not an `EffortLevel`) | Implemented (model params; per-model discovery) | Partial (best-effort `_meta`) |
| Attachments / images | Implemented | Implemented | Implemented (`images` on send; path notes otherwise) | Partial (path notes only) |
| Resume across worker restarts | Implemented | Implemented | Implemented (`cursor_agent_id` + `Agent.resume()` + per-conversation store) | Implemented (`session/load`, capability-checked; visible note on fallback) |
| Context usage display | Implemented (server-derived from `events.jsonl`) | Implemented | Implemented (window from the model's `context` parameter; shared static fallback) | Implemented (`_meta` tokens; shared static fallback) |
| Auto-compact window control | Not applicable (no compaction primitive) | Implemented (2026-08-20) | Not applicable | Not applicable |
| Auth model | Relay host's CLI login | Relay host's `claude` login | API key via provider settings (secret-env-file delivery; key rotation respawns workers) | Relay host's `grok` login |

## Relay core (provider-agnostic)

Features the relay implements above the provider layer. These used to live in the Copilot section
but are not Copilot SDK surface.

| Capability | Status | Notes / evidence |
| ---------- | ------ | ---------------- |
| Per-conversation provider binding | Implemented | `runtime_sessions.provider_type` / `provider_model` pin a conversation to `github`, `openai`, or `claude`. `reconcileUnstartedConversationProviders` (`server/server-runtime.mjs`) is provider-parameterized, only rebinds conversations with no messages and no queued work, restores the previous binding when a provider is re-enabled, and stops/restarts the session worker when worker routing is enabled. Worker-kind routing sets `COPILOT_WEB_RELAY_WORKER_KIND` via `applyClaudeProviderEnvironment` (`server/services/session-worker-launch-service.mjs`). |
| Conversation draft persistence + conflict checks | Implemented | Draft saves are always enabled; `PATCH /api/conversation/:id/draft` rejects stale writes with 409 `draft-version-conflict` on `baseDraftUpdatedAt` mismatch (`server/routes/sessions-routes.mjs`, `server/public/app/conversation-view.js` → `persistConversationDraft`, `server/public/app/conversation-draft-timestamp-utils.mjs`). |
| Default session workspace root / relaunch | Implemented | Launches and workspace-root updates honor a default CWD setting plus recent-root state (`server/services/workspace-root-defaults-service.mjs` → `resolveDefaultSessionWorkspaceRootState`, `server/services/session-worker-launch-service.mjs`). Since 2026-08-02 extended by `workspace-root-path-policy.mjs` (validation / normalization / allow-list), `workspace-root-relaunch-service.mjs` (`evaluateWorkspaceRootRelaunch`, `evaluateReuseCwdMismatch`, relaunch coalescing), and `session-worker-stop-service.mjs` (`stopSessionWorkerProcesses`). Since 2026-08-05 `POST /api/conversation/bootstrap` accepts a validated `workspaceRootPath` and seeds the configured root before the first worker launch; the New Chat modal offers the known-CWD list (`server/public/app/known-cwd-options.mjs`, shared with the Change CWD picker). |
| Model catalog composition | Implemented | Copilot, OpenAI BYOK, and Claude catalogs are layered into one payload and filtered per conversation provider — `buildModelCatalogWithProviders` wraps `buildModelCatalogWithClaudeProvider` over `buildModelCatalogWithOpenAIProvider` over the base catalog (`server/routes/sessions-routes.mjs`). |
| Installable PWA shell / scoped manifest / service worker | Implemented | Server renders the shell with a path-relative scoped manifest and versioned service worker (`server/public/index.html`, `server/public/manifest.webmanifest`, `server/public/sw.js`). |
| `/compact` workflow | Implemented | Provider-agnostic: branches to a new conversation seeded with a summary rather than using any SDK compaction primitive. (Claude additionally *observes* host-driven compaction, marks it in the transcript, and configures its window — see [claude-sdk.md](claude-sdk.md).) |
| Native chat fork at message X | Not implemented (SDK gaps) | No public primitive wired in any provider for true server-side branch/fork semantics. |
| Native rewind-to-arbitrary-turn | Not implemented (SDK gaps) | No public API wired for arbitrary rewind; the Copilot CLI exposes last-turn `/rewind` UX only. |

## Changelog

- 2026-08-17: Claude background tasks stopped being opaque rows. `local_workflow` tasks now carry a
  live progress digest the worker reads off the CLI's on-disk workflow state (journal while running,
  run record once it lands — the record is written only at completion), clamped in the worker and
  re-clamped independently by the relay (`sanitizeWorkflowProgress`); the background-task panel folds
  it out as a phase/agent tree with per-agent state, model, and tokens. Completed workflows persist
  their final digest per response message (new `workflow_runs` table, written inside the finalize
  transaction) and render as a collapsed **Finished background task** card in the transcript from the
  same renderer, so it survives reloads. Panel rows were reworked for phones: kind badge stacked over
  Stop, an always-visible token count, and 2-line wrapped text instead of single-line ellipsis. Also
  the client's conversation-switch staleness class: seven guards in `conversation-view.js` (send
  target + composer settings captured before any await, share-toggle reload, both paginators, session
  pill, and a `0%` quota badge that was hidden by `Number(null) === 0`), connect-resync now retries
  with backoff instead of dying on one failed fetch, and foreground recovery isolates its five steps.
- 2026-08-17: Added the **Ultracode** effort tier for Claude sessions. The Agent SDK exposes
  `ultracode` as a session-scoped settings flag (xhigh effort plus standing workflow orchestration),
  not an `EffortLevel`, so the relay carries it as a sentinel on the normal effort ladder — derived
  for xhigh-capable models, clamped like any tier on the send path, and translated only in the worker
  (spawn `settings`, mid-session `applyFlagSettings`). Both selectors label the rung "Ultracode" with
  a cost tooltip; it is never a silent default. The four duplicated Claude effort ladders are now one
  (`server/services/provider-reasoning-effort.mjs`). Live-verified both toggle paths on
  `claude-opus-5`.
- 2026-08-16: Merge-readiness review wave (all providers). Queue/provenance: terminal failures
  now record `executed_provider` + run the mismatch check (the original hijack signature exited
  uninstrumented), keep their thoughts, and reconcile still-running `subagent_runs`; the
  relay-eligible provider set lives in `shared/provider-routing.mjs` (one edit adds a provider);
  the relay's provider-mismatch refusal no longer burns a retry; recovery counts against
  `MAX_REQUEUE_RETRIES`; dead workers are detected in ~30s (socket-close probe + sweep) instead
  of the 600s stale window; all three node workers install crash guards and tee output to
  `server/logs/worker-<sid>.log`. Claude: persistent-process wedges fixed (discarded
  continuations, between-turn chatter, respawn races, control-poller handle scoping), init model
  backs `auto` responses, narration demotion works under per-block delivery, attachment guards
  enforced, background-agent questions ride continuation turns, targeted stop for backgrounded
  subagents via `stopTask`. Cursor: auth retry budget 2 covering thrown errors with ask_user
  unblocking, busy retry uses `LocalSendOptions.force`, merged-stream drain-before-throw + stall
  watchdog, context-window lookups timed and negative-cached, store handles closed, **subagent
  text/thinking attribution via `tool-call-delta`** (live-probed; the documented "no
  parent-attribution field" was wrong for 1.0.27), plan-usage first-report seeding, key rotation
  respawns workers. Grok: out-of-turn permission requests answered (deadlock class closed), tool
  names from title/name instead of the ACP category (subagent detection can fire now), user turn
  ceiling honored (0 = unlimited), long-quiet terminals stop deferring the stall watchdog,
  resume failures surface a note, empty turns publish the shared note. Copilot: standalone
  relay's per-message model switch wired (was dead code), extension publishes the shared
  empty-turn note. E2E isolation: `features.mjs` honors `COPILOT_WEB_RELAY_CONFIG`, and the
  test server's HOME points at the temp state root (the import sweep was pulling the host's
  real sessions into "isolated" runs).
- 2026-08-20: Claude auto-compaction became visible and adjustable. The context modal gained a per-conversation auto-compact window slider (`shared/auto-compact-window.mjs`, `conversations.auto_compact_window`; NULL = Auto) applied via `applyFlagSettings` on the next delivery, plus a read-only line naming the window in force and its `autocompactSource`. Fixed the payload beneath it: `autoCompactThreshold` is tokens, not a percent, which had made `buffer_tokens` clamp to 0 for every Claude session; free space and buffer are now disjoint slices (they described the same unused tokens, so the usage grid summed past 100% and scaled itself down). Compactions render as a transcript break row carrying pre/post tokens through new `relay_activity.metadata_json`, alongside day separators and a scrollbar rail of boundary dots. Composer context-window options are scoped per model+provider — `claude-opus-5` had been offering Copilot's 264k/1000k choice on Claude conversations, where the SDK reports a flat 1M window.
- 2026-08-12: Rebuilt the Claude worker around one persistent CLI process per conversation (`claude-session-process.mjs`, pushable streaming input) — fixes background tasks being killed seconds after each reply (incident conv `2353a9eb`: the per-turn process + `local_bash` gate exclusion orphaned E2E runs and their "you will be notified" continuations). Background tasks of every type now keep the process alive between turns; task-notification continuations publish as their own relay turns (`POST /api/continuation-turn`, `kind='continuation'` queue rows — never deliverable, torn down instead of requeued; heartbeats now refresh every owned row via `activeQueueMessageIds`). New composer fold shows the live task set (from `POST /api/background-tasks` + `background_tasks` socket event) with per-task Stop (`worker.control` push → `query.stopTask()`); Stop-turn maps to `query.interrupt()` so tasks survive; per-turn model/mode/effort switch live via `setModel`/`setPermissionMode`/`applyFlagSettings`. New "Background task timeout" settings slider (`shared/background-task-timeout.mjs`, default No limit) caps task-only process holds; idle processes exit after 10 min (`CLAUDE_RELAY_IDLE_SHUTDOWN_MS`) and resume on demand.
- 2026-08-09: Fixed the Cursor context gauge (SDK `models.list()` dropped the window field; it now lives in the `context` parameter values, which `readModelContextWindow` parses from the default variant) and added live Cursor plan-quota bars (Total/Auto/API % + reset date) to Check Usage via the dashboard API. The session cookie resolves automatically from the relay host's Cursor IDE login (`state.vscdb` access token, read in place — never copied; the db can be multi-GB), with a user-pasted `WorkosCursorSessionToken` or `CURSOR_SESSION_TOKEN` env var as the headless-host override (new `cursor-dashboard-usage.mjs` + settings field). Hosts with neither (the Linux relay) now get an explicit card message naming the missing token instead of an empty panel. `agent.getUsage()` is 403 feature-gated for individual accounts, which is why the local spend ledger stayed empty.
- 2026-08-08: Grok Check Usage now shows the live weekly SuperGrok quota bar with its reset date — fetched from the CLI chat proxy's `/v1/billing?format=credits` using the relay host's own `~/.grok/auth.json` login (`server/services/grok-billing-usage.mjs`), best-effort per request, estimated meters demoted to secondary when live data is present.
- 2026-08-08: Grok audit fixes before first deploy: guarded the ACP client's `'error'` emit (a missing `grok` CLI could crash the relay server via `ERR_UNHANDLED_ERROR`), spawn cwd now honors the conversation workspace, model locked per conversation (409 `GROK_MODEL_REQUIRES_NEW_CONVERSATION` + composer pin), reasoning effort forwarded on prompt `_meta`, context usage gauge implemented (`/api/grok-context-usage`), plan boards + busy retry + requeue-on-empty + terminal-error field parity in the worker, discovery timeout no longer leaks agents and the CLI fallback is async, plan-usage hardening (negative-value rejection, full-precision accumulation, binding-validated route, worker source badge).
- 2026-08-08: Grok plan usage on Check Usage — per-turn tokens/cost from ACP prompt `_meta`, optional monthly allowance meter, card hidden when Grok disabled, billing link `console.x.ai`.
- 2026-08-08: Added the Grok CLI ACP provider (`server/grok-worker/`) with host-login settings, worker routing, model catalog layer, and frontend picker/badge. Control surface is `grok agent stdio` (no npm agent SDK).
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
- 2026-08-02: Implemented the Cursor provider end-to-end: `server/cursor-worker/` (adapter, merged-stream normalizer, `ask_user` custom tool, turn runner, entry), relay integration (`provider_type 'cursor'`, settings routes + catalog layer, worker-kind launch routing with a generalized secret-env-file, `cursor_agent_id` column, `/api/cursor-agent-id` + `/api/cursor-context-usage`), and the full frontend. Live validation (spike checklist in cursor-sdk.md) pending.
- 2026-08-02: Promoted `ask-user-bridge`, `control-poller`, and `countPlanLikeLines` from `server/claude-worker/` to `shared/` (parameterized for multi-provider use; Claude behavior unchanged).
- 2026-08-02: New Chat now opens the provider picker when any managed provider is enabled — previously only an enabled OpenAI provider unlocked it, leaving Claude-only/Cursor-only setups without a path to the picker.
- 2026-08-02: Live-validated the Cursor provider with a real key: model discovery (35 models), a streamed relay turn with thoughts, a full ask_user question-card round trip (10/10 tool compliance in the spike), context usage capture, and worker-kill resume via `cursor_agent_id`. Fixed `classifyCursorError` to match the live busy signal (`UnknownAgentError("… already has active run")`). Full results in [cursor-sdk.md](cursor-sdk.md).
