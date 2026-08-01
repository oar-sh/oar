# Developing

This document covers day-to-day development workflows for the web relay and Copilot CLI extension.

## Runtime ownership

Use a **single runtime owner** at a time:

- **Extension-managed**: start `gh copilot` or `copilot-remote` and let the extension supervise `server.js`
- **Standalone**: use `npm start` only when you intentionally want the standalone relay flow

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

Unit tests are colocated as `*.test.mjs` and run with the Node test runner. There is no `npm test`
script — invoke the runner directly on the files or directories you changed:

Match `*.test.mjs` explicitly — pointing the runner at a directory makes it try to execute the
implementation modules alongside the tests, which fails:

```bash
node --test server/claude-worker/*.test.mjs
node --test shared/*.test.mjs
node --test server/services/context-usage-view.test.mjs
```

End-to-end Playwright tests have their own scripts:

```bash
npm run test:e2e
```

Do not run tests that spawn Copilot CLI clients unless explicitly permitted.

## Notes

- In extension-managed mode, do not restart the relay by killing random processes.
- Use the localhost shutdown API for manual relay restart requests.
- Keep exactly one relay listener on port `3333`.
