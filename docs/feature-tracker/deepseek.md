# DeepSeek provider

Updated: 2026-10-25 · Part of the [SDK Feature Tracker](README.md)

DeepSeek has no agent SDK of its own. Its API comes in three formats: OpenAI-compatible, Responses, and
Anthropic-compatible. The DeepSeek provider uses the third: a DeepSeek conversation runs the **Claude
worker's runner** (`server/claude-worker/claude-session-process.mjs`) with a backend
(`server/deepseek-worker/deepseek-claude-backend.mjs`). The backend points the Claude Code build bundled
with `@anthropic-ai/claude-agent-sdk` at `<base URL>/anthropic`, which is DeepSeek's documented Claude Code
setup. Every runner feature of a Claude chat is therefore a DeepSeek feature too, unless a row below says
otherwise. The worker entry is `server/deepseek-worker/deepseek-session-worker.mjs`, and both entries run
`claude-session-worker-main.mjs`.

Authentication is **an API key in the provider settings** (`deepseek_api_key`; `services/deepseek-settings-service.mjs`).
It is never returned by `GET /api/settings/deepseek`. It reaches only DeepSeek workers, as
`DEEPSEEK_API_KEY` through the secret env file under tmux (`WORKER_SECRET_ENV_VAR_KINDS`). Inside the
worker it becomes the CLI's `ANTHROPIC_AUTH_TOKEN`.

## Turn execution

| Surface | Status | Notes |
| ------- | ------ | ----- |
| Turns, streaming, thoughts, tools, question cards, plan boards, sub-agents, steering, Stop, background tasks | Implemented | The Claude runner unchanged; see [claude-sdk.md](claude-sdk.md) |
| CLI environment | Implemented | `spawnEnv`: no `ANTHROPIC_*` from the worker, no `CLAUDE_CODE_OAUTH_TOKEN`, no `DEEPSEEK_API_KEY`, no `CLAUDE_CODE_SUBAGENT_MODEL*`; sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_HAIKU_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL` (`deepseek-flash`), `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_FABLE_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` (the session's model), `CLAUDE_CONFIG_DIR=<data>/deepseek-claude` (no Claude login there), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CODE_EFFORT_LEVEL`. Measured 2026-10-24: during a turn the CLI's only peer was `api.deepseek.com` |
| Model ids | Implemented | The CLI gets `deepseek-flash[1m]` (Claude Code plans with the 1M window) and strips the suffix on the wire (captured); `relayModel` maps the CLI's names back, a Claude id to the DeepSeek model that served it |
| Sub-agent model | Implemented | Found 2026-10-24: with only the haiku pin, an Agent asked for as "opus" went to DeepSeek as `claude-opus-5-5`, which DeepSeek serves with V4 Pro, so a Flash chat ran a V4 Pro sub-agent, unpriced. Every alias and the sub-agent default are pinned to the session's model (`spawnEnv`), a model switch respawns the CLI for the pins (`spawnKey`), the badge shows the DeepSeek model (`subagentModel`), and a report under a Claude name is booked under the served model (`deepseekServedModel`; migration 0026 folds earlier rows). Live check with an "opus" sub-agent: pending |
| Reasoning effort | Implemented | `low`/`high`/`max`, sent by the CLI as `output_config.effort` with `thinking: {type: adaptive}` (captured). It is applied at spawn, so a change respawns the CLI between turns (`backend-spawn`, shared with a model switch). **No thinking-off level:** Claude Code never sends `thinking: {type: disabled}` for a DeepSeek model, neither with the SDK's `thinking` option nor with `MAX_THINKING_TOKENS=0`, and DeepSeek thinks unless told not to. A requested `none` runs as `low` |
| Thinking round trip in tool turns | Implemented | DeepSeek answers 400 when a tool turn's reasoning is not sent back. Claude Code sends the thinking blocks back: the live check's follow-up after a tool turn passes |
| Images | Implemented | Inline only for models that take images (`deepseekModelAcceptsImages`: flash yes, v4-pro no); otherwise a path note. `POST /api/message` refuses a switch to a text-only model once the history holds images (`DEEPSEEK_MODEL_TEXT_ONLY`) |
| Failures | Implemented | `describeDeepSeekFailure`: 402 → `deepseek-balance`, 401 → `deepseek-api-key`, 429 → `deepseek-rate-limit`, each with DeepSeek's advice and buttons in the transcript (`relay-error-ctas.mjs`). Every failure prints as `relay.deepseek-<code>` (any other refusal: `relay.deepseek-api-error`); before 2026-10-25 they printed as `relay.claude-deepseek-balance` and the like, which the buttons never matched |
| Claude plan usage / usage limit | Not applicable | `reportsPlanUsage` / `reportsUsageLimit` are false: no `/api/claude-plan-usage` and no `/api/claude-usage-limit` posts, and no pause |

## Models, settings, context

| Surface | Status | Notes |
| ------- | ------ | ----- |
| Model discovery | Implemented | `GET {baseUrl}/models` on key save, on re-enable, on a base URL change, and on **Refresh** (`refreshModels`). Only `deepseek-*` ids are kept, a failure keeps the stored list, and the fallback is `deepseek-flash`, `deepseek-v4-pro` |
| Base URL | Implemented | `normalizeDeepSeekBaseUrl`: `https:`, or `http:` on a loopback host; no credentials, query or fragment |
| Context usage + compaction window | Implemented | The CLI's context report through `/api/claude-context-usage`; the 🧠 modal's window control; 400K unless the chat pins one (`DEEPSEEK_DEFAULT_AUTO_COMPACT_WINDOW`, delivered with each message) |
| Commit attribution | Implemented | `deepseek_attribution` (`oar` or `off`); a folder override applies, and its `vanilla` reads as `oar` (`deepseekAttributionForConversation`) |
| Session root (**Session** folder button) and delete | Implemented | A second `createClaudeSessionRootResolver` over `<data>/deepseek-claude` only (`resolveDeepSeekSessionRoot`); deleting a DeepSeek conversation removes its transcript there, as for Claude |

## Live check

`scripts/deepseek-live-check.mjs --relay <url> --cwd <scratch folder>` runs four short turns on the key saved in
the relay: a tool turn, a follow-up, an effort change and a model switch. It also checks the context panel and
the delete. It passed 11/11 on 2026-10-24, on an isolated test relay.
