# Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

Updated: 2026-08-02 · Part of the [SDK Feature Tracker](README.md) — legend, changelog, and
provider-agnostic relay rows live there.

Everything below lives in `server/claude-worker/` unless noted. The SDK has exactly two import
sites: `claude-sdk-adapter.mjs` (the worker's single static import — the turn-path surface is
auditable from that one file) and a deliberate dynamic `import()` in `server/server-runtime.mjs`
used only for model discovery (`refreshClaudeProviderModels`).

Authentication uses the relay host's logged-in Claude credentials; the relay stores no API key.

## Turn execution

| SDK feature | Status | Notes / evidence |
| ----------- | ------ | ---------------- |
| `query()` streaming-input mode | Implemented | Required for image content blocks. The user-message stream is *gated*: it stays open after yielding the message so end-of-turn control requests still have a transport (`claude-sdk-adapter.mjs` → `startClaudeTurn`, `createGatedUserMessageStream`; the gate is released via `turn.endInput` in the runner's `finally`). |
| `options.resume` | Implemented | The native session id from the first turn is persisted (POST `/api/claude-native-session`, cached only after server ack) and replayed, so a conversation survives worker restarts (`claude-turn-runner.mjs` → `persistNativeSessionId`). |
| `options.model` (per turn) | Implemented | Per-message model wins only when non-`auto` **and** `claude-`-prefixed; conversation provider model and worker default (`CLAUDE_RELAY_MODEL`) are fallbacks (`claude-turn-runner.mjs`). |
| `options.effort` (per turn) | Implemented | `normalizeClaudeEffort` whitelists `low/medium/high/xhigh/max`; `none` (and any unknown value) maps to "omit the option" — the SDK default (`claude-sdk-adapter.mjs`). |
| `options.permissionMode` | Partial | Only `plan` (relay `plan` mode) and `default` are used; `acceptEdits` / `bypassPermissions` are not wired (`claude-sdk-adapter.mjs` → `permissionModeForRelayMode`). |
| `options.systemPrompt` (preset+append) | Implemented | `claude_code` preset with a mode-specific append for `ask` and `autopilot` (`claude-sdk-adapter.mjs` → `systemPromptForRelayMode`). |
| `options.includePartialMessages` | Implemented | Drives live reply streaming and thought streaming (`claude-sdk-adapter.mjs`, `sdk-message-normalizer.mjs`). |
| `options.forwardSubagentText` | Implemented | Subagent text is forwarded and routed to its own bubble by `subagentRunId` (derived from `parent_tool_use_id`); main-thread text is tracked separately so subagent prose can never be published as the reply. |
| `options.abortController` | Implemented | Backs the relay Stop control, driven by the control poller (`control-poller.mjs`, `claude-turn-runner.mjs`). |
| `options.cwd` | Implemented | Set from `COPILOT_WORKSPACE_ROOT` (`claude-session-worker.mjs`). |
| `options.pathToClaudeCodeExecutable` | Implemented | Set from `CLAUDE_CODE_EXECUTABLE` when provided. |
| `options.maxTurns` | Not implemented | Turn length is bounded by the relay's own inactivity window (`DEFAULT_PROCESSING_TIMEOUT_MS`, explicitly not a cap on turn length) and the max-turn-duration ceiling (`shared/turn-ceiling.mjs`, applied in `recoverStaleMessages`) instead. |
| Image content blocks | Implemented | Images ≤ 5 MB are inlined as base64 (oversized or unreadable images fall back to a data URL, then a path note); non-image files become absolute path references for the `Read` tool (`claude-attachments.mjs`). |

## Control requests + tools

| SDK feature | Status | Notes / evidence |
| ----------- | ------ | ---------------- |
| `canUseTool` | Partial | Everything is auto-allowed (parity with the Copilot workers' `--allow-all`); only `AskUserQuestion` and `ExitPlanMode` are intercepted, and a bridge failure returns `behavior: 'deny'` with a message (`claude-sdk-adapter.mjs` → `createCanUseTool`). |
| `AskUserQuestion` tool | Implemented | Bridged to relay question cards, one card per question entry, returning the collected `answers` map as `updatedInput` (`ask-user-bridge.mjs`). |
| `ExitPlanMode` tool | Implemented | Publishes a `plan_ready` relay board (`source: exit_plan_mode`); a heuristic fallback also posts one when a `plan`-mode turn ends with ≥2 plan-shaped lines but never called the tool (`claude-turn-runner.mjs` → `countPlanLikeLines`, `source: plan-mode-fallback`). |
| `query.supportedModels()` | Implemented | Model discovery via a short-lived idle query (never-yielding gated prompt, `cwd: os.tmpdir()`) with a 20 s timeout; keeps explicit `claude-*` ids (a trailing `[…]` suffix like `[1m]` survives `isSafeClaudeModelId`), drops bare aliases, and harvests `supportedEffortLevels` per model (`server/server-runtime.mjs` → `refreshClaudeProviderModels`, `shared/model-id.mjs`). |
| `query.getContextUsage()` | Implemented | Read from inside the message loop while the transport is still open (10 s timeout), normalized by `server/services/claude-context-usage.mjs` (`buildClaudeContextSnapshot`, context window from `modelUsage[model].contextWindow`), and posted to the relay on every exit path (`claude-sdk-adapter.mjs` → `readContextUsage`, `claude-turn-runner.mjs` → `publishContextUsage`). |
| `query.setMaxThinkingTokens()` | Partial | Called only as `(null, 'summarized')` to make existing thinking *visible* without enabling it or changing a budget. Deprecated and best-effort; failures are logged and ignored (`claude-sdk-adapter.mjs` → `requestSummarizedThinkingDisplay`). |
| `query.close()` | Implemented | Tears down the discovery query in a `finally`, after releasing the input gate (`server/server-runtime.mjs`). |
| Targeted subagent cancellation | Not implemented (SDK gap) | No per-subagent cancellation primitive; `abort_subagent` control requests are answered with an explicit "not supported" result and full-turn Stop remains available (`control-poller.mjs`). |

## Message-stream consumption

The relay observes the SDK by normalizing its message stream rather than registering hooks. All of
this lives in `sdk-message-normalizer.mjs`.

| Stream surface | Status | Notes / evidence |
| -------------- | ------ | ---------------- |
| `stream_event` partial messages | Implemented | `normalizeStreamEvent` handles `message_start`, `content_block_start`, `text_delta`, `thinking_delta`, `content_block_stop`; emission is gated (`shouldEmitStreamUpdate`: ≥24-char delta or sentence-ending punctuation) to mirror the Copilot publisher. |
| Stable reasoning ids across partials | Implemented | Ids of the form `claude-{thought\|narration}-{thread}-{msgIndex}-{blockIndex}` are kept stable between partial frames and the complete `assistant` message (`beginAssistantMessage` reconciliation), so the server upserts thoughts instead of duplicating them. |
| Narration demotion | Implemented | Assistant `text` blocks that share a message with a `tool_use` are demoted to narration thoughts, never answer text; `redacted_thinking` is handled alongside `thinking`; thoughts are capped at 16 KiB (`MAX_THOUGHT_CHARS`). |
| Subagent lifecycle inference | Implemented | Tool names in `SUBAGENT_TOOL_NAMES` (`task`/`agent`) open a `running` subagent run keyed by `tool_use.id`; the matching `tool_result` closes it `completed`/`failed`. Purely derived from tool blocks — not an SDK lifecycle API. |
| Tool-failure surfacing | Implemented | `tool_result.is_error` becomes a truncated "Tool failed: …" activity line. |
| `system` / `compact_boundary` | Implemented | Host-driven auto-compaction is surfaced as a "Context compacted (Xk → Yk tokens)" activity from `compact_metadata.pre_tokens` / `post_tokens`. The relay never *triggers* compaction (see the README's `/compact` row). |
| `system` / `task_notification` | Implemented | Background-task notifications become activity lines ("Background task <id> <status>: <summary>") plus a `background_task_settled` edge action the runner uses for the gate hold below. |
| `system` / `background_tasks_changed` | Implemented | The live background-task set (REPLACE semantics) feeds the runner's input-gate hold: a turn whose result arrives while non-bash tasks are live (or a settled session-level task's continuation is still queued) keeps the gate — and with it the `canUseTool` control transport — open until a later result finds nothing left to continue. Without the hold, background agents outliving the visible turn lose every permission request ("Tool permission request failed: AbortError: Stream closed", incident conv `f268abe0`). `local_bash` tasks never gate (a dev server would wedge the turn); backstops: 60 s idle release once no gating tasks remain, 30 min linger cap. Each result's text is a segment of the published reply (`\n\n`-joined). |
| Phantom zero-work result skip | Implemented | A resumed session whose previous CLI process died with tracked background tasks replays a bookkeeping turn that emits a `success` result with `num_turns === 0 && duration_api_ms === 0` *before* the real turn. Treating it as the turn result would release the input gate and close the control transport, breaking every later `canUseTool` call — so it is dropped and the real result is awaited. |
| `result` usage fields | Implemented | `modelUsage` (per-model `contextWindow`, used as fallback when `getContextUsage()` is unavailable) and `total_cost_usd` are carried on the normalized result. |
| Turn error classification | Implemented | Auth-shaped errors become `claude.authentication_failed` with a "run `claude` on the relay host" message; other failures map to `claude.turn-error` / `claude.<result.subtype>` (`claude-turn-runner.mjs`). |

## SDK on-disk artifacts

| Surface | Status | Notes / evidence |
| ------- | ------ | ---------------- |
| Session root / transcript resolution | Implemented | `server/services/claude-session-root-service.mjs` probes `$CLAUDE_CONFIG_DIR/projects` and `~/.claude/projects`, computes the project-dir slug from the cwd (`claudeProjectDirSlug`), and anchors a session on the `<nativeSessionId>.jsonl` transcript rather than the lazily created `<nativeSessionId>/` directory (which only appears once `subagents/` or `tool-results/` exist). Includes a bounded non-recursive scan fallback for slug misses, a `SESSION_ID_PATTERN` path-injection guard, and hit/miss caches with TTL for ~1 Hz client polling. Consumed via `server-runtime.mjs` → `sessions-routes.mjs`. |

## Session configuration not wired

| SDK feature | Status | Notes |
| ----------- | ------ | ----- |
| `options.hooks` | Not implemented | Relay observation is done by normalizing the SDK message stream instead (`sdk-message-normalizer.mjs`). |
| `options.mcpServers` | Not implemented | No relay-supplied MCP servers; the host's own configuration applies. |
| `options.agents` / custom subagent definitions | Not implemented | Subagents are observed, not defined, by the relay. |
| `options.allowedTools` / `disallowedTools` | Not implemented | Tool gating is handled entirely in `canUseTool`. |
| `options.settingSources` / skills / plugins | Not implemented | Not configured by the worker. |
| `options.thinking` | Not implemented | Deliberate: every variant forces a `type`, which would override the host's own thinking settings. |
| `options.fallbackModel` | Not implemented | Not configured by the worker. |
| SDK-native compaction | Not implemented | The relay's `/compact` workflow is provider-agnostic (see [README](README.md)); host-driven compaction is only observed via `compact_boundary`. |
