# Developing

This document covers day-to-day development workflows for the web relay and Copilot CLI extension.

## Runtime ownership

Everything starts the same way — `node server/server.js` (which is all `npm start` does).
The role is chosen by argv: bare, the process stays attached as a supervisor and runs the
server in a `--relay-runtime` worker child; with `--supervised` it runs the server in-process
and exits 75 so its spawner handles restarts. Never set a role via the environment: the
server's env is inherited by tmux workers and by the Copilot CLI, so it would leak downward.

Use a **single runtime owner** at a time:

- **Extension-managed**: start `gh copilot` or `copilot-remote` and let the extension supervise `server.js --supervised`
- **Standalone**: start the server yourself, then `node server/relay.mjs` by hand — only when you intentionally want the standalone relay flow

Do **not** run extension-managed polling and standalone relay processes together.

## Restarting the extension-managed relay

Use this sequence when you need the running relay to pick up server or extension changes.

1. Close all Copilot CLI sessions so the relay can go idle.
2. On Linux/macOS, optionally clear stale worker tmux sessions:

```bash
tmux ls
tmux kill-session -t <sdk-session-id>
```

3. Queue a relay restart through the authenticated localhost API:

```bash
CONFIG="${COPILOT_WEB_RELAY_CONFIG:-server/config.json}"
TOKEN=$(node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(j.authToken||j.relayAuthToken||''));" "$CONFIG")

curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -X POST http://127.0.0.1:3333/api/relay/shutdown \
  -d '{"reason":"manual-restart","requestedBy":"localhost-api","restart":true}'
```

4. Start one fresh Copilot CLI session:

```bash
gh copilot
```

or:

```bash
copilot-remote
```

## Worker debugging

On Linux/macOS, session workers prefer detached `tmux` sessions when `tmux` is available. The tmux session name matches the SDK session id, which makes it easy to inspect a worker directly:

```bash
tmux attach -t <sdk-session-id>
```

### Claude workers

Claude conversations run `server/claude-worker/claude-session-worker.mjs` as a plain Node process
rather than a Copilot CLI session. It uses the same tmux naming, but no `script`-based pseudo-TTY —
so `tmux attach` shows the worker's own `[claude-worker …]` log lines directly.

Prerequisite: the relay host must have a logged-in Claude Code CLI (`claude`). The relay stores no
API key; a turn that cannot authenticate replies with a system note saying so.

Run the worker manually against a live relay:

```bash
COPILOT_WEB_RELAY_WORKER_KIND=claude \
COPILOT_WORKSPACE_ROOT=/path/to/workspace \
CLAUDE_RELAY_MODEL=claude-sonnet-5 \
node server/claude-worker/claude-session-worker.mjs --session-id <sdk-session-id>
```

Useful overrides: `CLAUDE_CODE_EXECUTABLE` (explicit Claude Code binary),
`COPILOT_WEB_RELAY_CLAUDE_WORKER_PATH` (worker script location),
`COPILOT_WEB_RELAY_CONFIG` (relay config used to resolve the server URL and auth token).

## Tests

### Node version

**The unit suite requires Node.js 24+.** This is not a style preference — Node 20 and 22
both fail `createWorkerSecretEnvFile uses owner-only permissions and cleans up` with
`failureType: 'cancelledByParent'`, because their test runner cancels subtests that outlive
the parent. Node 24 awaits them. Measured on the same tree:

| Node | Result |
| ---- | ------ |
| 20.19.2 | 26/28 in `session-worker-launch-service.test.mjs` — 1 failure |
| 22.23.2 | 26/28 — same failure |
| 24.19.0 | 28/28 |

If you hit exactly that one failure, check `node -v` before assuming a regression. Debian's
apt `nodejs` is still on 20, so use nvm:

```bash
nvm install 24 && nvm alias default 24
```

On Debian, add nvm's init to `~/.profile` as well as `~/.bashrc` — `~/.bashrc` returns early
for non-interactive shells, so `bash -lc 'node …'` (CI, scripts, `wsl -e`) would silently keep
using `/usr/bin/node`.

### Unit tests

Unit tests are colocated as `*.test.mjs` and run with the Node test runner:

```bash
npm test
```

Expected: **1608 pass / 0 fail / 4 skip on Windows**, **1612 pass / 0 fail / 0 skip on Linux**.
The 4 Windows skips are host-gated (0600 file modes, symlinks) and run on Linux.

Unit tests are **safe to run while a live relay is running**: they use in-memory SQLite,
temp directories, and injected `spawnImpl`/`execImpl` fakes — nothing binds a port, spawns
a real process, or touches `server/data`.

The suite is expected to be green on every platform. A failure after your change is a
regression — fix it before moving on.

To run a subset, match `*.test.mjs` explicitly — pointing the runner at a directory makes it
try to execute the implementation modules alongside the tests, which fails:

```bash
node --test server/claude-worker/*.test.mjs
node --test shared/*.test.mjs
node --test server/services/context-usage-view.test.mjs
```

### End-to-end tests

```bash
npm run test:e2e
```

The e2e runner spawns its own `server.js` on a free port with an isolated state directory
(`COPILOT_WEB_RELAY_DATA_DIR` + `COPILOT_WEB_RELAY_CONFIG` pointed at a temp dir), so it can
run alongside a live relay without touching its database, singleton lock, or config. The test
server also runs with `COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN=1`, so it never launches real
Copilot CLI clients or Claude workers; set `RELAY_E2E_ALLOW_CLI=1` explicitly (with user
permission) if a run genuinely needs live turns.

Extra arguments are forwarded to Playwright, so a single spec can be run in isolation:

```bash
node tests/run-e2e.mjs cache-rebuild.spec.mjs
```

Specs must resolve the relay URL, auth token, and database exclusively through
`tests/e2e-env.mjs` (fed by `run-e2e.mjs` via `PLAYWRIGHT_BASE_URL`, `RELAY_TEST_TOKEN`,
`RELAY_TEST_DATA_DIR`). Never read `server/config.json`, open `server/data/copilot.db`, or
target `http://127.0.0.1:3333` from a spec — those belong to the live relay.

### Live smoke tests

`tests/agents/` contains smoke tests that send real prompts through a **live** relay. They are
excluded from `npm test`, skip unless `RELAY_TEST_TOKEN` is set, and must never be run
implicitly:

```bash
npm run test:agents:smoke   # requires a live relay + RELAY_TEST_TOKEN; ask the user first
```

Do not run tests that spawn Copilot CLI clients unless explicitly permitted.

### Test authoring rules

- **No personal data, machine fingerprints, or secrets in test files.** Use fictional values:
  `C:\Users\dev`, `/home/dev`, `user@example.com`, obviously fake tokens. Never embed real
  usernames, home paths, hostnames, e-mail addresses, or credentials — not even your own.
  `server/test-hygiene.test.mjs` enforces this and fails the suite on violations.
- **Platform behavior is injected, not detected.** Services take `platform`, `homedir`, `env`,
  `spawnImpl`/`execImpl` parameters; tests pass `'win32'`/`'linux'` explicitly so the whole
  suite runs identically on any OS. Do not write tests that branch on `process.platform` —
  if a test genuinely cannot run on the host OS, skip it explicitly:
  `test('…', { skip: process.platform !== 'win32' }, …)`.
- **The path module is injected too.** A service that joins onto a caller-supplied base dir
  takes `pathImpl` (or `path`), defaulting to the host's — see `normalizeCloudflaredTunnelConfig`,
  `prepareWorkerLogFile`, `normalizeSshTunnelConfig`, `resolveClaudeProjectsRoots`. Tests then
  pass `path.posix` **and** `path.win32`, so both halves run on both machines:

  ```js
  const cfg = normalizeCloudflaredTunnelConfig(raw, { configBaseDir: '/srv/relay', pathImpl: path.posix });
  ```

  Without this, `path.join('/var/log/relay', 'w.log')` yields `\var\log\relay\w.log` on Windows,
  and a hardcoded POSIX expectation passes on Linux while failing on Windows.
- Paths in fixtures should be built with `path.join()` or use both-separator expectations
  where the code under test normalizes separators.

`server/test-hygiene.test.mjs` enforces the three rules above mechanically:

1. bare `process.platform` in a test,
2. an undeclared win32 path shape (`"C:\…"`, `/^[A-Za-z]:$/`),
3. an undeclared **POSIX join** — an assertion expecting a literal that strictly extends a POSIX
   literal the same test block passed in, which is the exact signature of "the implementation
   joined onto my base dir with the host's separator".

Each is escaped file-wide by naming `path.posix` / `path.win32` / `win32`, gating with `skip`, or
annotating a line `host-platform:` (real host behavior is under test) or `platform-agnostic:` (the
value never reaches path semantics — e.g. an HTTP route path, which is `/`-separated everywhere).

## Notes

- In extension-managed mode, do not restart the relay by killing random processes.
- Use the localhost shutdown API for manual relay restart requests.
- Keep exactly one relay listener on port `3333`.
