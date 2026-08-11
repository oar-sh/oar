# Provider audit & remediation plan — 2026-08-11

Audit trigger: Cursor session `66e4feaa-8e91-4cdc-8d8b-abd261bb6523` ("sca implementation")
repeatedly dropping from `processing` back to `pending`; suspected provider crossover to
Copilot; Cursor sub-agents appearing in the conversation list.

Status: **Phase 1 implemented 2026-08-11 (signed off by Simon); Phases 2–4 pending.**

Phase 1 delivery notes:
- 1.1 `findPendingForLegacyRelay` (message-repository.mjs) + fallback switch in
  `dequeuePendingMessage`; anonymous requesters can no longer claim
  claude/cursor/grok conversations' rows.
- 1.2 relay.mjs refuses `providerType` ≠ github/openai and now fails the turn on
  model substitution (session disposed, not reused).
- 1.3 `recoverProcessingBefore`/`recoverStale` keep `owner_sdk_session_id`.
- 1.4 `listPendingWorkerOwnerSessionIds` no longer filters on `next_attempt_at`;
  primer warms workers during retry backoff.
- 1.5 `messages.executed_provider` column; set in `/api/response` from the
  authenticated bridge identity (`resolveExecutedProviderForResponse`); server
  logs `PROVIDER MISMATCH`; UI shows a red "ran on <provider>" chip when it
  differs from the conversation's provider.
- 1.6 `relay_session_links` table + `POST /api/relay-session-link` (relay reports
  its execution sessions) + import-sweep skip for relay-owned/bound-elsewhere
  sessions. Cleanup done: shadow conversations `8256d0a7` and `47d94069`
  tombstoned and deleted (their `~/.copilot` session state left on disk as
  evidence); 5 stranded `subagent_runs` rows on `66e4feaa` closed as failed.
  Still to verify manually: `bdbefd8f`, `dfa5b033`, `42b63d92`, `c2a32479`
  (possible earlier shadows, not deleted).

Phase 1 follow-up fix (same day): the provenance check flagged every OpenAI BYOK
image turn as `ran on github`. Cause: this server executes image operations
itself against the conversation's provider API and then finalizes through an
identity-less self-post (`/api/image-operations/:id/execute` → `/api/response`
with only Authorization), so the responder had no bridge identity and fell back
to `github`. Fixed by crediting the bound provider only when the turn is a
server-executed operation (`q.image_operation_id`). Deliberately *not* fixed by
treating all identity-less `openai` turns as legitimate: `server/relay.mjs` is
spawned by `start.js` with plain env, so it authenticates on the Copilot plan
regardless of binding — an identity-less OpenAI *chat* turn genuinely did run on
the wrong plan and must stay flagged. Correctly configured OpenAI BYOK workers
are Copilot CLIs whose web-relay extension does send `X-Relay-Session-Id`, so
they resolve through their runtime row. An unresolvable responder identity now
reports `unknown` (no chip, no mismatch) and logs `PROVIDER UNRESOLVED` rather
than fabricating a `github` mismatch or staying silent.

Phase 1 gap closed (conv `bba84ef0`): `findPendingForLegacyRelay` filtered by
provider but not by owner, contrary to what 1.1 above specifies. An OpenAI image
turn owned by a booting worker was claimed by the identity-less relay 0.3s after
spawn, failed (`gpt-image-*` is not a Copilot model) and burned a retry plus a
60s backoff. The query now also requires `owner_sdk_session_id IS NULL`; owners
are only assigned when routing is enabled, so routing-disabled installs are
unaffected. The two mislabeled image messages were backfilled to `openai`.

## Turn-start latency investigation (2026-08-11)

Symptom: messages sit `pending` for a long time before the turn starts, across
providers. Measured over 457 spawns in `server.log`.

Findings:
- Delivery itself is fast: once a worker socket is ready, a pending message is
  delivered within 500ms by the `monitorQueue` sweep
  (`session-worker-websocket-service.mjs:245-253`). There is no slow sweep.
- **Dominant cause: the requeue backoff ladder.** `computeRetryDelayMs` is
  `30s x 2^n` (`server-runtime.mjs:4699-4704`), so any transient failure freezes
  the row for 60s, then 120s, 240s. All dequeue SQL gates on `next_attempt_at`,
  and because the row is already `pending` no count-change event fires — only
  the periodic `ready-check` branch rescues it. Every recent slow delivery in
  the log sits exactly 60/120/240s after a `REQUEUED` line. The WS send-failure
  path already uses a 5s cap (`server-runtime.mjs:6761`); the HTTP requeue path
  does not.
- Copilot CLI cold start is ~35s median (2779 `readyWithoutHeartbeatMs`
  samples) and is not ours to fix. Workers ARE kept warm between turns
  (`idleEvictionMs` is 0 and `evictIdleWorkers` has no caller), and warm
  sessions deliver in <300ms.
- **Foot-gun:** `heartbeatTimeoutMs` is 30s (`session-worker-supervisor-service.mjs:84`)
  but median boot is ~35s, so `startup-heartbeat-timeout` can kill a still-booting
  CLI and pay a second cold start.
- The kill route sets a 30s kill-block (`session-worker-supervisor-service.mjs:268-272`),
  so a kill followed by a message costs 30s + full boot.
- `worker launcher: spawned` is logged even when the launcher reused an existing
  tmux pane (`server-runtime.mjs:4124` ignores `launched.reused`), which makes
  spawn counts unreadable: 1208 spawn lines over 356 sessions, 58% within 60s of
  a previous spawn for the same session.

Open follow-ups from the audit of that fix (not yet done):
- No test exercises `POST /api/response` end to end; the provenance decision is
  covered at the helper level only, so the `serverExecutedOperation` wiring and
  the `executed_provider` write are unpinned. A harness would need ~20 statement
  stubs — worth doing when route-level test infrastructure exists.
- The terminal-failure early return in `/api/response` records no provenance and
  runs no mismatch check, yet stolen turns dying on `402 quota_exceeded` (the
  original incident's signature) all exit there.
- The identity branch never checks that the responder's runtime row belongs to
  the turn's conversation, so same-provider cross-*conversation* execution is
  invisible.
- Relay-eligible providers are encoded in two inverse-shaped places: the
  allowlist in `relay.mjs` processNext and the `NOT IN ('claude','cursor','grok')`
  denylist in `findPendingForLegacyRelay`. Adding a provider means editing both.

---

## Part 1 — Findings (all verified against live data, logs and code)

### F1. The Copilot relay CLI steals queue messages from cursor/claude/grok conversations — CONFIRMED, with real damage

The legacy Copilot relay (`server/relay.mjs`) is spawned unconditionally
(`server/start.js:131-143`) and polls `GET /api/pending` every 2 s (`relay.mjs:940`)
**without** the `x-relay-session-id` bridge identity header (`relay.mjs:303-311`).
Provider workers send it (`cursor-worker/cursor-session-worker.mjs:60-65`).

In `dequeuePendingMessage` (`routes/messages-routes.mjs:715-763`), a requester without a
session id skips the owner-aware branch and falls through to the **global**
`stmts.findPending` (`repositories/message-repository.mjs:108`) — no owner predicate, no
provider predicate, no join to `runtime_sessions`. The relay then executes the message on
the **GitHub Copilot plan**, passing the queue's model id verbatim to
`client.createSession` (`relay.mjs:541-558`). The model-mismatch check is log-only
(`relay.mjs:560-562`). Neither `queue` nor `messages` records the executing provider, and
the UI provider label reads only `runtime_sessions.provider_type`
(`public/app/conversation-provider-indicator.mjs:1-8`) — so a crossover is **invisible**.

Confirmed incidents (from `~/.copilot/session-state/*/events.jsonl` + `server.log` + DB):

| When | Victim conversation | What happened |
|---|---|---|
| 08-11 03:57–04:37 | `ef37beba` "scs implementation" (cursor, grok-4.5) | Message `e9e9797a` stolen 5×. Shadow Copilot session `47d94069` ran **165 turns, 7,040 tool events** (1,484 bash, 621 edit, 355 create) in the **wrong cwd** (`~/git/copilot-remote`), wrote to `~/git/scs-worktrees/*`, ended in `quota_exceeded`. This is what exhausted the Copilot monthly quota. |
| 08-11 13:00 + 13:55–14:11 | `66e4feaa` "sca implementation" (cursor, claude-opus-5) | "procees" and every retry of "please proceed" stolen; shadow session `8256d0a7` (`selectedModel: claude-opus-5`, `producer: copilot-agent`) attempted real Copilot turns, each dying on `402 quota_exceeded` — producing the observed processing→pending flapping until `relay.retry-timeout`. |
| 08-10 07:01 | suspected (verify) | Shadow session `bdbefd8f` "start full implementation", claude-opus-5, **122 turns, 0 errors** — a fully successful run on the Copilot plan. Origin conversation to be confirmed. |

Aggravating factors:
- `claude-opus-5` is enabled in **both** the Cursor catalog (`app_settings.cursor_models`)
  and Copilot `model_variants` (provider='anthropic'), so it crosses silently.
- For `grok-4.5` (0 rows in `model_variants`) Copilot silently served **some other
  model** — the mismatch check at `relay.mjs:560` only logs. The SCS worktree files
  authored 03:57–04:37 were written by an unknown Copilot model while labeled grok-4.5,
  violating the SCS agent-protocol model pinning.
- The steal can happen even while the owner is alive: the global `findPending` ignores
  `owner_sdk_session_id` entirely; the relay's 2 s poll wins whenever the provider worker
  is dead, restarting, or slow to claim ("procees" was grabbed at 13:00:15 while
  `owner=66e4feaa` was set).

### F2. Stale recovery wipes ownership and never respawns the provider worker

`recoverStaleMessages` (`server-runtime.mjs:7131-7148`, 15 s timer, 600 s window) uses
`recoverProcessingBefore` (`message-repository.mjs:249-264`), which sets
`owner_sdk_session_id = NULL` — recovery is provider-blind and turns a routed message into
global prey for F1. The only respawn hook, `primePendingSessionWorkers`
(`server-runtime.mjs:6797-6821`, 5 s timer), filters on
`next_attempt_at IS NULL OR next_attempt_at <= now` (`message-repository.mjs:195`), so
during the 30 s recovery backoff the row is invisible to the primer — and once it matures,
the relay's 2 s poll always beats the primer's 5 s tick. The requeue path
(`messages-routes.mjs:6453-6470`) never restores an owner either, so every retry round
re-enters the steal.

### F3. Cursor (and Claude) workers die/stall silently; server has no death detection

- No `uncaughtException`/`unhandledRejection` handlers in either worker
  (`cursor-session-worker.mjs:117-128`); tmux launch is `exec node …` with
  `stdio: 'ignore'` (`services/session-worker-launch-service.mjs:359-362, 483-484`) — a
  crash leaves **zero** forensic trail.
- The websocket service just forgets a closed worker socket
  (`services/session-worker-websocket-service.mjs:357-364`): no supervisor notification,
  no respawn, no requeue. `processing` rows never trigger a respawn (primer only reads
  `status='pending'`). A dead worker mid-turn = 10 minutes of silence, then F2, then F1.
- Cursor-specific stall paths (Claude has a linger/idle backstop,
  `claude-turn-runner.mjs:55-59, 387-403`; Cursor has none):
  - merged stream parks forever if the SDK transport stalls (`cursor-sdk-adapter.mjs:203-213`);
  - `readModelContextWindow`/`resolveCursorReasoningParams` do un-timeouted network calls
    before the run and inside `finally` (`cursor-sdk-adapter.mjs:295-304, 372-401`;
    `cursor-turn-runner.mjs:268-270, 368-373`);
  - producer failure swallowed when an abort races it (`cursor-sdk-adapter.mjs:166-170, 203-213`);
  - `dispose()` awaited on SIGTERM can hang shutdown (`cursor-session-worker.mjs:108-118`);
  - `ask_user` blocks indefinitely and rows with pending relay questions are exempt from
    stale recovery (`message-repository.mjs:247, 263`).
- In the incident: worker pid 1451563 spawned 13:00:53, ran the turn, spawned 4 sub-agents
  13:03–13:04, then went silent (cursor `index.db` last write 13:04); stale recovery fired
  at 13:55; hijack loop followed.

### F4. Cursor stale-auth handling is a single-shot band-aid

The f686217 handle-recreate retry (`cursor-turn-runner.mjs:405-436`) fires on virtually
every long-running turn (8× in `relay_activity`), but:
- budget is 1 per turn (`:411`) — the 10:13 orchestrator turn re-authenticated at 10:13:04,
  then hit a second auth error at 11:54 and failed terminally (`26d351f4`);
- thrown `AuthenticationError` from `agent.send()` is not retried (catch at `:439-452`
  only handles busy);
- auth failures inside `ensureAgentHandle` aren't covered;
- retry re-sends the whole user message — sub-agents already spawned are orphaned;
- a pending `ask_user` is never aborted/re-asked, leaking the question;
- nothing proactively refreshes a handle known to go stale (~4 h idle).

### F5. "Cursor sub-agents in the conversation list" are actually imported hijack shadows

No code path imports Cursor sub-agents as conversations (verified exhaustively; the only
`data/cursor-agents` consumer is the file-browser root resolver,
`services/cursor-session-root-service.mjs:24-59`). The stray list entries ("procees",
"proceed inplementation along the plan", …) are **shadow Copilot sessions created by F1
hijacks**, later imported by the Copilot session-import sweep
(`services/sdk-session-import-service.mjs:85-150`) — e.g. `sdk_session_imports` row for
`8256d0a7` at 14:11:13. Fixing F1 removes the source; the importer additionally needs to
skip relay-created sessions that shadow existing conversations.

### F6. Cursor sub-agent parity gaps (the real parity work)

- Lifecycle detection works (`sdk-message-normalizer.mjs:184-260` → `POST /api/subagent-run`),
  bubbles render — but **all stream/thought/activity carry `subagentRunId: null`**
  (`sdk-message-normalizer.mjs:83-86, 135, 148, 217, 256`), because the Cursor SDK exposes
  no parent-attribution field. Bubbles stay empty; sub-agent output lands on the main thread.
- Stranded rows: nothing reconciles `subagent_runs` when a turn dies — 4 rows from
  `66e4feaa` stuck at `running` since 13:03 (affects Claude too, Cursor hits it more).
- Malformed `call_id`s (embedded newline, two concatenated ids) used verbatim as row id,
  URL path segment (`messages-routes.mjs:2559`) and CSS selector
  (`conversation-view.js:1378`) — seen live on conv `ef37beba`.
- Targeted sub-agent abort: SDK gap; `abort_subagent` answered "not supported"
  (`shared/control-poller.mjs:36-42`).

### F7. Model/provider bookkeeping desyncs

- `ensureRuntimeSessionBinding` → `touchRuntimeSession` writes every requested model into
  `runtime_sessions.model` without touching `provider_model` (`server-runtime.mjs:7225`);
  worker launch env reads `provider_model || model` (`server-runtime.mjs:4041`). Live
  desync: conv `45f034cb` has `provider_model='grok-4.5'` but `model='claude-opus-5'` — a
  relaunched worker comes up on the stale model.
- Provider rebind on settings change (`server-runtime.mjs:4161-4272`): a failed relaunch
  can leave the DB on the new provider with the old worker's session directory
  (`:4231-4269`); disabling a provider flips unstarted conversations to `github`.
- No per-turn provenance: `POST /api/response` stores whatever `model` the responder
  claims (`messages-routes.mjs:5782`), with no executing-provider field.

---

## Part 2 — Remediation plan

### Phase 1 — Stop the bleeding: queue isolation (fixes crossover + the flapping)

1.1 **Provider-scope the anonymous dequeue.** In `dequeuePendingMessage`
    (`messages-routes.mjs:715-763`): when session-worker routing is enabled and the
    requester has no `x-relay-session-id`, replace the `stmts.findPending` fallback with a
    new `findPendingForLegacyRelay` that joins `runtime_sessions`/`conversations` and only
    returns rows whose conversation is `provider_type IN ('github','')` (no runtime
    session = github) **and** `owner_sdk_session_id IS NULL`. Owned rows are never handed
    to an anonymous poller.
    *Test:* seed a pending row on a cursor conversation; `GET /api/pending` without the
    header returns `{message:null}`; with the owner's header returns the row.

1.2 **Defense in depth in the relay.** `relay.mjs processNext` (`:851-914`): if
    `msg.providerType` (already delivered by `buildDequeuedRelayMessage`,
    `messages-routes.mjs:975-985`) is present and ≠ `github`, immediately requeue with a
    distinct code (`relay.provider-mismatch`) instead of executing. Make the model
    mismatch check (`relay.mjs:560-562`) fail the turn instead of logging.

1.3 **Stale recovery keeps ownership.** `recoverProcessingBefore` / `recoverStale`
    (`message-repository.mjs:225-264`): stop nulling `owner_sdk_session_id` /
    `owner_assigned_at`; clear only the lease columns. Recovered rows stay routed to
    their worker and become primer-visible.
    *Test:* recover a stale cursor-owned row → owner intact → primer respawns the worker
    → relay never sees it.

1.4 **Primer sees backoff rows.** Drop the `next_attempt_at` filter from
    `listPendingWorkerOwnerSessionIds` (`message-repository.mjs:195`) so the worker is
    respawned *during* the backoff window instead of racing the relay after it.

1.5 **Record and display executing provider.** Add `executed_provider` to `messages`
    (migration), set it in `POST /api/response` from the authenticated responder identity
    (bridge header present → that provider; absent → `github`), not from the payload.
    UI: show a per-message provider badge when `executed_provider` differs from the
    conversation's provider — a crossover must be visible, never silent.

1.6 **Importer must not resurrect shadows.** In `sdk-session-import-service`, skip Copilot
    sessions whose first user message matches a queue message belonging to an existing
    non-github conversation (or better: have `relay.mjs` tag sessions it creates —
    `client_name`/session metadata — and skip those wholesale). Cleanup task: delete the
    existing shadow conversations (`8256d0a7`, `47d94069`, verify `bdbefd8f`,
    `dfa5b033`, `42b63d92`, `c2a32479` before removal).

### Phase 2 — Cursor worker stability (fixes "cursor sessions are unstable")

2.1 **Never die silently.** Both workers: add `process.on('uncaughtException'/'unhandledRejection')`
    → best-effort `POST /api/requeue` for the active message + `process.exit(1)`. Launch
    service: stop using `stdio:'ignore'`/bare `exec`; tee worker stdout/stderr to
    `server/logs/worker-<sessionId>.log` (rotating).

2.2 **Server-side death detection.** On worker socket close with an in-flight
    `processing` row (`session-worker-websocket-service.mjs:357-364`): notify the
    supervisor → PID-probe → respawn worker (message stays owned; on `worker-hello` it
    redelivers) or requeue-with-owner after a short grace (e.g. 15 s). Add a periodic
    supervisor sweep PID-probing registry workers that own `processing` rows, replacing
    the 600 s worst case with ~30 s.

2.3 **Port Claude's turn backstops to the cursor runner.** Linger cap + idle-release
    equivalent around the merged stream (`cursor-turn-runner.mjs` /
    `cursor-sdk-adapter.mjs:203-213`), pausing while a relay question or live sub-agent
    is pending (mirror `claude-turn-runner.mjs:387-403` and the pendingControlRequests
    gate). Add timeout races (mirror `readAgentUsage`, `cursor-sdk-adapter.mjs:90-102`)
    to `readModelContextWindow` and `resolveCursorReasoningParams`; never let the
    `finally`-path call block response publication.

2.4 **Harden stale-auth recovery.** Raise per-turn budget to 2–3 with short backoff;
    also retry thrown `AuthenticationError` from `agent.send()` and auth failures in
    `ensureAgentHandle`; abort the pending `ask_user` bridge before re-sending; add
    proactive handle-recreate when idle > 30 min (staleness is the norm — 8 occurrences
    in `relay_activity`). Track in the feature tracker (currently undocumented).

2.5 **Small correctness fixes.** Don't swallow producer `failure` on abort race
    (`cursor-sdk-adapter.mjs:166-170, 203-213`); make SIGTERM shutdown synchronous like
    Claude's (`cursor-session-worker.mjs:108-118` vs `claude-session-worker.mjs:100-106`);
    allow one cancel-and-resume attempt on the second `agent-busy` before going terminal.

### Phase 3 — Sub-agent parity in the turn bubble (all providers)

3.1 **Cursor attribution.** Best-effort `subagentRunId` inference in the cursor
    normalizer: while exactly one sub-agent is `running`, attribute non-main-latched
    stream/thought/tool frames to it; with >1 in flight, keep main-thread fallback
    (never mis-attribute). Re-test against the SDK for a parent field on each upgrade;
    file upstream request.

3.2 **Reconcile stranded runs.** On turn end/fail/abort, both turn runners (or the server
    on queue-message terminal state) mark still-`running` `subagent_runs` rows for that
    queue message as `failed` (with note) — fixes bubbles stuck "running" forever.
    Cleanup task: close the 4 stranded rows on `66e4feaa`.

3.3 **Sanitize `call_id`** before use as row id / URL segment / CSS selector (strip
    whitespace/newlines; hash if still malformed) — `sdk-message-normalizer.mjs`, cancel
    route, `conversation-view.js:1378`.

3.4 **Consistent bubble UX cross-provider.** Verify cursor bubbles render
    thoughts/tools/stop identically to Claude once 3.1 lands; Stop button on providers
    without targeted abort shows a clear "not supported by provider" state instead of a
    dead control.

### Phase 4 — Provider/model bookkeeping hygiene

4.1 Fix `touchRuntimeSession` so `runtime_sessions.model` and `provider_model` cannot
    desync for provider-bound sessions (update both through the per-turn rebind path,
    `messages-routes.mjs:4214-4225`); backfill the bad rows (e.g. `45f034cb`).
4.2 Make provider-rebind failure paths atomic (DB write + worker relaunch commit/rollback
    together, `server-runtime.mjs:4231-4269`); add the missing consistency test to
    `server-runtime-provider-rebind.test.mjs`.
4.3 Update `docs/feature-tracker/cursor-sdk.md`: document the stale-auth retry, turn
    backstops, sub-agent attribution status, and the queue-isolation contract.

### Ops / cleanup (no code)

- Copilot monthly quota is exhausted (402s since at least 13:00 on 08-11) — burned largely
  by shadow session `47d94069` (165 turns / 7,040 tool events). Review the GitHub Copilot
  usage dashboard.
- **SCS integrity:** files under `~/git/scs-worktrees/` for AG-00-SCAFFOLD-T-004,
  AG-01-SHIPGEN-T-100/101/102, AG-02-PHYSICS-T-003/110/111, AG-03-NET-T-122,
  AG-05-INPUT-T-140, AG-06-GAMEPLAY-T-006 were edited on 08-11 03:57–04:37 by the
  mislabeled Copilot model — audit/re-verify those branches against the SCS agent
  protocol before merging.
- `copilot-remote` working tree: verified clean — the hijacked session wrote **no**
  files here.

### Suggested order & sizing

| Step | Size | Risk | Depends on |
|---|---|---|---|
| 1.1 + 1.3 + 1.4 | S–M | low | — |
| 1.2 | S | low | — |
| 2.1 + 2.2 | M | medium | — |
| 1.5 + 1.6 + cleanup | M | low | 1.1 |
| 2.3 + 2.4 + 2.5 | M–L | medium | 2.1 (logs make it debuggable) |
| 3.1–3.4 | M | medium | — |
| 4.1–4.3 | S–M | low | — |

Phase 1 alone would have prevented the entire 66e4feaa incident and the quota burn.
