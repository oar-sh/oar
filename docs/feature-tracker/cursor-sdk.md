# Cursor SDK (`@cursor/sdk`) — implementation reference

Updated: 2026-08-02 · Part of the [SDK Feature Tracker](README.md).

**Status: planned provider — nothing implemented yet.** This file is the reference for building
the Cursor provider; it maps the relay's provider contract (the capability matrix in the
[README](README.md)) onto the SDK surface, flags the known gaps, and lists the relay touch points
a third provider has to change. Once implementation starts, rows here graduate into the same
Implemented/Partial/Not implemented style as the other trackers.

Research date 2026-08-02, against `@cursor/sdk` ~1.0.26 (first released 2026-04-29, beta). The SDK
is young and moving — **re-verify every mapping against
[cursor.com/docs/api/sdk/typescript](https://cursor.com/docs/api/sdk/typescript) before relying on
it.** Facts below marked *(verify)* were not confirmable from public docs.

## SDK shape in one paragraph

`Agent.create({ apiKey, model, local: { cwd } })` creates a durable agent bound to a workspace;
each prompt is a **run**: `const run = await agent.send(text)` then `for await (const event of
run.stream())`. Follow-ups, status, streaming, and cancellation are run-scoped. Agents persist via
a pluggable `local.store` (`SqliteLocalAgentStore`, `JsonlLocalAgentStore`, or custom) and
reattach with `Agent.resume(agentId)`. There is also a cloud runtime (sandboxed VMs, GitHub repos,
auto-PR) — out of scope for the relay, which is workspace-local by design. A separate
`cursor-agent` CLI offers headless NDJSON streaming (`-p --output-format stream-json`), but the
TypeScript SDK is the intended integration path here.

**Requires Node.js 22.13+** for local agents (platform-specific binaries). Check the relay's
supported Node floor before wiring the worker.

## Authentication — differs from both existing providers

Copilot and Claude both ride the relay host's logged-in CLI credentials; the relay stores no
secrets. Cursor authenticates with an **API key** (`CURSOR_API_KEY`, user or service-account key;
admin keys unsupported). That makes the settings flow look like the OpenAI BYOK path, not the
Claude path:

- Store/manage the key like the OpenAI provider settings (see `applyOpenAIProviderEnvironment`
  and the `provider.env` secret-file handling in `server/services/session-worker-launch-service.mjs`).
- Billing goes to the key owner (user plan or owning team for service accounts) — token-based
  consumption pricing.
- *(verify)* whether a logged-in Cursor CLI on the host can be reused instead of a key; public
  docs only document `CURSOR_API_KEY` for the SDK.

## Proposed worker shape

Mirror `server/claude-worker/` — the Claude worker established the provider-worker contract:

```
server/cursor-worker/
  cursor-session-worker.mjs     # env intake: COPILOT_WORKSPACE_ROOT, CURSOR_API_KEY, default model
  cursor-turn-runner.mjs        # turn loop, agentId persistence, plan-board fallback, error mapping
  cursor-sdk-adapter.mjs        # the ONLY @cursor/sdk import site (auditable, like claude-sdk-adapter)
  sdk-message-normalizer.mjs    # run.stream() / onDelta → relay channels (reply, thoughts, activity, subagents)
  ask-user-bridge.mjs           # question cards via a relay-registered custom tool (see gap below)
  control-poller.mjs            # Stop / abort_subagent control requests (reuse Claude's pattern)
```

Launch routing: `COPILOT_WEB_RELAY_WORKER_KIND = 'cursor'` alongside the existing `'claude'` value
in `session-worker-launch-service.mjs`.

## Contract mapping

| Relay capability | Cursor SDK primitive | Confidence / notes |
| ---------------- | -------------------- | ------------------ |
| Turn execution | `Agent.create({ apiKey, model, local: { cwd } })` once, then `agent.send(message)` per relay message → `Run` | High. Keep one durable agent per conversation; pass a stable `agentId` at create time so resume is deterministic. |
| Live reply streaming | `run.stream()` (`SDKMessage`: `assistant`, `thinking`, `tool_call`, `status`, `usage`, `request`) and/or `send`'s `onDelta` callback (`text-delta`, `thinking-delta`, `tool-call-*`, `turn-ended`) | High. `onDelta` is the closer analogue to `includePartialMessages`; the normalizer should consume one of the two, not both. |
| Thought streaming | `thinking` stream events / `thinking-delta` updates (+ `thinking_duration_ms`) | High. |
| Stop (whole turn) | `run.cancel()`; `Agent.cancelRun(runId)` works without a run handle — useful from a control poller after worker restart | High. |
| Targeted subagent abort | None found | Same SDK gap as Claude: answer `abort_subagent` with explicit "not supported" (reuse `control-poller.mjs` pattern). |
| Question cards | **No callback API** — bridge via `local.customTools`: register an `ask_user` tool whose `inputSchema` mirrors Claude's `AskUserQuestion` `questions[]` shape, and whose async `execute()` delegates to `createAskUserBridge` (`server/claude-worker/ask-user-bridge.mjs` — already injection-friendly: posts `/api/relay-question` per entry, polls, returns continuation text on timeout). Return the answers map as `structuredContent` + text fallback. The `{ type: "request", request_id }` stream event signals "awaiting user input" | Medium-high — the bridge is reusable as-is. Must-wire: thread the control poller's `AbortController` into `execute()` as the bridge `signal` (`run.cancel()` will not reject a worker-owned promise, so Stop would otherwise hang until question timeout). Stale-turn recovery is inherited for free — same `/api/relay-question` pipeline. Steering: tool `description` + the relay prompt-sanitizer pattern (`server/services/relay-prompt-sanitizer.mjs`), since `Agent.create` exposes no `systemPrompt`. *(verify: custom tools almost certainly need re-registering on `Agent.resume()` — they are function objects, and inline `mcpServers` are documented as not persisted.)* |
| Structured forms | No elicitation equivalent found | Custom tool with a JSON `inputSchema` could emulate it if ever needed. |
| Plan boards | `mode: "plan"` on create/send for plan-mode turns; no `ExitPlanMode`-style tool observed | Medium. Expect to rely on the same plan-shaped-text fallback both existing providers already have (`countPlanLikeLines` / `allowPlanModeFallback`). *(verify: what a plan-mode run emits at plan completion.)* |
| Subagent lifecycle | Define nothing; observe `tool_call` events where `name` is the `Agent` tool (subagents are spawned via the `Agent` tool, defined inline via `agents` or `.cursor/agents/*.md`) | Medium. Same inference approach as the Claude normalizer's `SUBAGENT_TOOL_NAMES`. *(verify: whether subagent text is forwarded into the parent stream and how it is attributed.)* |
| Per-message model switch | `send(message, { model: { id } })` — **sticky**: a per-run override persists for later runs, so the runner must re-pin the model on *every* send, not only on change | High; the stickiness is documented and is a real footgun for relay semantics. |
| Model discovery | `Cursor.models.list()` — ids, params, Router availability | High. Feed `buildModelCatalogWithCursorProvider` (to be written) the way `refreshClaudeProviderModels` feeds the Claude catalog. Note `auto`-style routing is a real model id here (`auto-smart` + `optimize_for` param), unlike Copilot's session-boundary dance. |
| Reasoning effort | No `effort` option; nearest is model `params` (e.g. `{ id: "fast" }`, `optimize_for` on Router models) | Low. Map relay effort → model params only where a model advertises them (`Cursor.models.list()` exposes per-model params); otherwise omit, as the Claude worker does for `none`. |
| Attachments / images | `SDKUserMessage.images`: `{ url }` or `{ data (base64), mimeType, dimension? }` | High for images. No non-image attachment field found — fall back to the Claude approach: write to disk and reference the absolute path in the prompt text. |
| Resume across restarts | Stable `agentId` on create + `Agent.resume(agentId)`; conversation/run state persisted via `local.store` (`SqliteLocalAgentStore` on disk, or a custom store backed by the relay DB) | High, and stronger than Claude's transcript replay — but *(verify)* how much history `resume` restores without the original store directory. Caveat: inline `mcpServers` are **not** persisted across `Agent.resume()`. |
| Context usage | `usage` stream events / `run.usage` (`TokenUsage`: input/output/cacheRead/cacheWrite/total/reasoning) | Partial by design: token totals exist, but no context-window-fill equivalent of Claude's `getContextUsage()` was found — the relay's context gauge would need model context-window metadata from `Cursor.models.list()` *(verify it's exposed)* plus arithmetic. |
| Turn errors / auth classification | `CursorSdkError` hierarchy: `AuthenticationError`, `RateLimitError`, `ConfigurationError`, `AgentBusyError`, `NetworkError` (with `isRetryable`, `code`, `status`) | High — typed errors beat Claude's regex classification. Map `AuthenticationError` → a `cursor.authentication_failed` relay error ("set/renew the Cursor API key"). `AgentBusyError` matters: a durable agent rejects concurrent runs, which actually matches the relay's one-turn-at-a-time queue. |
| Tool gating | No `canUseTool` equivalent. Available knobs: `local.autoReview` (IDE-grade classifier), `local.sandboxOptions.enabled` (bubblewrap/seatbelt, network-deny), file-based `.cursor/hooks.json` (no programmatic callbacks) | Relay parity posture is allow-all anyway (Copilot `--allow-all`, Claude auto-allow), so default `autoReview: false`, sandbox off, and document it. Do **not** write into the user's `.cursor/` config from the worker. |
| Teardown | `agent.close()` (fire-and-forget) or `await using` / `Symbol.asyncDispose` | High. |

## Known gaps and risks (decide before building)

1. **Question cards hinge on model compliance, not plumbing.** The plumbing is settled (see the
   contract row: custom `ask_user` tool + `createAskUserBridge` reuse + abort-signal threading).
   The open risk is whether the model reliably *calls* the tool instead of narrating a question as
   plain text — there is deliberately no text→card fallback anywhere in the relay, so a narrated
   question silently ends the turn. Validate early with a real key; steering is limited to the
   tool `description` and prompt-sanitizer text since `Agent.create` has no `systemPrompt` option.
2. **Model override stickiness** inverts relay assumptions — pin the model on every `send`.
3. **No context-window fill metric** — the context gauge will be approximate or absent at first.
4. **API-key auth** needs a settings/storage story the Claude provider never needed (reuse the
   OpenAI BYOK plumbing).
5. **Beta SDK** — expect breaking changes; pin the version in `package.json` and keep the adapter
   as the single import site so upgrades are one-file audits.
6. **Node 22.13+ floor** and platform-specific binaries on the relay host (including Windows —
   verify support; the sandbox is documented for Linux/macOS only).

## Relay touch points for a third provider

Grounded in how the Claude provider landed (commit `64a6995`); these are the places hardcoded to
two managed providers today:

- `server/server-runtime.mjs`: `provider_type` handling — note the binary ternary in the
  provider-settings path (`=== 'claude' ? 'claude' : 'openai'`) and `DEFAULT_CLAUDE_MODEL` /
  `DEFAULT_OPENAI_MODEL` — needs to become three-way; plus a `refreshCursorProviderModels`
  discovery sibling and `reconcileUnstartedConversationProviders` coverage for `'cursor'`.
- `server/routes/sessions-routes.mjs`: a `buildModelCatalogWithCursorProvider` layer in
  `buildModelCatalogWithProviders`; provider settings routes.
- `server/services/session-worker-launch-service.mjs`: `applyCursorProviderEnvironment`
  (worker kind `'cursor'`, `CURSOR_API_KEY` via the existing `provider.env` secret-file mechanism).
- `server/services/session-worker-stop-service.mjs` / supervisor: recognize the new worker kind.
- `server/public/app/`: provider pickers, model catalog filtering, context-usage view behavior
  when only token totals are available.
- DB: no schema change expected — `provider_type` is TEXT; migrations only if defaults change.

## Sources

- [Cursor SDK announcement blog](https://cursor.com/blog/typescript-sdk)
- [Cursor SDK TypeScript API reference](https://cursor.com/docs/api/sdk/typescript) — primary source for the mapping table
- [Cursor changelog: SDK release](https://cursor.com/changelog/sdk-release)
- [DataCamp Cursor SDK tutorial](https://www.datacamp.com/tutorial/cursor-sdk) (secondary)
