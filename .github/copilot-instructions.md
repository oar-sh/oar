# Copilot Relay Operating Instructions

When changing anything related to the web relay (`server/` or `.github/extensions/web-relay/`):

1. Use a **single runtime owner**. Do not mix extension-managed mode with standalone relay mode.
   - **Extension-managed (default):** let `.github/extensions/web-relay/extension.mjs` own server supervision and polling/heartbeat.
   - **Standalone dev mode:** `npm start` (starts `server.js` + `relay.mjs`) only when you intentionally are not relying on extension polling.
   - Never run `npm start`, `node server/relay.mjs`, and extension polling together.
   - Never kill or restart the node process bound to port `3333` unless the user explicitly gives permission to restart the web relay.
2. Before any restart, stop stale relay/watchdog processes from earlier runs (especially detached shells) so only one web relay remains bound to `:3333`.
   3. For extension-managed mode, only restart the web relay after explicit user permission. Manual restarts must use the authenticated localhost API (`POST /api/relay/shutdown`); do not use direct process kills or respawn scripts.
      - Include `restart: true` in the request body for an intentional self-restart; omit it for a plain shutdown.
      - Preferred restart request body: `{ "reason": "manual-restart", "requestedBy": "localhost-api", "restart": true }`.
      - `POST /api/relay/shutdown` is queued and only actually exits once the current turn is idle, so do not wait for it to "interrupt" an in-flight turn.
4. Keep the main Copilot CLI session running so extension polling can continue.
5. Verify relay health after changes:
   - `GET /api/status` reports `cliOnline: true`
   - Queue is draining (`pendingCount`/`processingCount` moving or zero)
   - Exactly one listener owns port `3333`
6. Check logs for startup and processing errors:
   - Relay/server logs from `server.js`
   - Extension debug log: `server/logs/ext-debug.log`
7. If the CLI asks a clarification question, answer it in the web relay question card UI element (displayed in the relay dashboard) instead of auto-answering in code. If no clarification question appears, proceed with the next step.
8. Per-message execution mode now lives in the browser composer (`plan` / `ask` / `agent` / `autopilot`) and is stored with each queued turn.
9. When a turn needs user input, always use `ask_user` rather than asking inline text.
10. In `autopilot`, still use `ask_user` for clarification; the relay bridge will capture it and show a web question card even if the direct SDK question hook is bypassed.
11. Do not spawn Copilot CLI client instances for tests or debugging without explicit user permission; ask first if a test would launch one.
12. When tracing a stuck or missing message, follow this exact sequence to locate where it stopped:
   - Collect identifiers first: `conversation_id`, approximate timestamp, and message text (or `message_id` if available).
   - Trace server flow in `server/logs/server.log` for that conversation:
     - `QUEUED` (accepted by relay)
     - `DEQUEUED` (picked for execution)
     - `RESPONSE` (completed)
   - Trace extension flow in `server/logs/ext-debug.log` for same window:
     - `session.send: queuing for msgId ...`
     - `session.sendAndWait: completed ...` (or failure/retry signals)
   - Check DB queue truth in `server/data/copilot.db` (`queue` table) for the specific row status (`pending`/`processing`/`done`) and ownership (`owner_sdk_session_id`, `runtime_session_id`).
   - Check live runtime snapshot via authenticated `GET /api/status`:
     - `sessionWorker.workers[]` entry for the target `sdkSessionId`
     - `activeBridgeOwner`
     - queue counters (`pendingCount`, `processingCount`)
   - Validate worker PID reality: if status says `ready/processing` but the worker PID is not running, treat as stale worker registration.
    - Conclude with a one-line stop point: **accepted but not dequeued**, **dequeued but no response**, or **response emitted but UI missed update**.

Do not consider relay-related work complete until restart + status + log checks pass.

## Running Tests

- **Unit tests:** run `npm test`. This is always safe while the live relay is running — unit
  tests use in-memory SQLite, temp dirs, and injected process fakes; they never touch
  `server/data`, port `3333`, or real processes. Never stop or restart the relay to run them.
- The unit suite is green as of 2026-08-02; treat any failure after your change as a
  regression to fix, not pre-existing noise. If you find already-failing tests, establish
  the baseline (`npm test` on a clean tree) before concluding anything.
- **E2E tests:** `npm run test:e2e` spawns its own isolated server (free port, temp
  `COPILOT_WEB_RELAY_DATA_DIR`/`COPILOT_WEB_RELAY_CONFIG`, and
  `COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN=1` so no real CLI clients or workers are launched)
  and may run beside a live relay. Playwright specs must get the relay URL, token, and DB
  path from `tests/e2e-env.mjs` only — never read `server/config.json`, never open
  `server/data/copilot.db`, and never target `http://127.0.0.1:3333` from a test.
- **Never run `tests/agents/` smoke tests or anything that sends prompts through the live
  relay or spawns Copilot CLI clients without explicit user permission** (see rule 11 above).
  They are excluded from `npm test` on purpose.

## Writing Tests

- **Never put personal data, machine fingerprints, or secrets in test files:** no real
  usernames, home directory paths, hostnames, e-mail addresses, IP addresses, auth tokens, or
  API keys — including values read from the local machine or config files. Use fictional
  fixtures instead: `C:\Users\dev`, `/home/dev`, `user@example.com`, clearly fake tokens.
  `server/test-hygiene.test.mjs` enforces this and will fail the suite.
- Do not branch on `process.platform` in tests. Inject platform/homedir/env/spawn dependencies
  into the code under test and pass explicit values (`'win32'`, `'linux'`), so the suite runs
  identically on every OS. If a test truly requires host OS behavior, either gate it with an
  explicit `{ skip: process.platform !== '<os>' }` option (it then reports as *skipped* on the
  other OS, never as failed), or — when the point of the test is real host behavior such as fs
  semantics or path helpers — annotate the line with a `host-platform: <reason>` comment.
  `server/test-hygiene.test.mjs` enforces this: any other `process.platform` reference in a
  test file fails the suite.
- The `tests/` directory is gitignored: files there never appear in `git status` and content
  searches skip it by default — search it explicitly when tracing test behavior.

## Git Commit Policy

- **Never commit on `main` without explicit user instruction.** The user decides when changes are committed to main.
- On feature branches, only commit autonomously during a large, multi-step implementation where it is clearly expected as part of the work.
- When in doubt, always ask before committing.
- Never push without explicit user instruction.
