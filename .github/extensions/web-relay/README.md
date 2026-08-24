# Web Relay Extension

The Copilot CLI extension that bridges local CLI sessions with the web relay server. This extension runs as a background agent in the CLI, polls the relay for pending turns, executes them, and streams activity back to the browser UI.

> Scope: this extension serves the **GitHub Copilot** and **OpenAI (BYOK)** providers. Claude
> conversations do not go through it — they run `server/claude-worker/claude-session-worker.mjs`,
> a standalone Node worker that implements the same relay contracts. See `server/README.md`.

## Architecture Overview

```
[Browser UI] <--WebSocket--> [server.js :3333] <--HTTP polling--> [CLI Extension]
                                                                        |
                                                                  [Session Workers]
```

- **`extension.mjs`** — Entry point; registers tools, initializes polling loop, manages extension lifecycle.
- **`polling/polling-loop.mjs`** — Main polling interval; fetches pending turns, executes via session workers, streams updates.
- **`runtime/worker-websocket-link.mjs`** — WebSocket bridge; handles turn execution, tool calls, activity streaming.
- **`skills/`** — Tool implementations: question routing, tool activity, tmux input bridge, reasoning streams.
- **`utils/`** — Helpers: tmux input bridge, prompts, configuration.
- **`server-lifecycle/`** — Manages relay server startup (extension-managed mode).

## Key Components

### Extension Entry Point (`extension.mjs`)

- Registers extension tools and skill handlers
- Starts the relay server if needed (extension-managed mode)
- Initializes polling loop on first `gh copilot` invocation
- Handles relay shutdown and restart requests

### Polling Loop (`polling/polling-loop.mjs`)

- Runs continuously every `pollIntervalMs` (default 3000ms)
- Fetches `/api/pending` to get next turn from the relay queue
- Spawns or reuses session workers to execute turns
- Streams tool/activity updates back to `/api/messages/{id}/events`
- Handles worker failures and retries
- Routes answers to `/api/ask-user` when agent needs user input

### Worker WebSocket Link (`runtime/worker-websocket-link.mjs`)

- Opens WebSocket connection to `localhost:3333/ws/worker/{sdkSessionId}`
- Bridges turn execution between the relay and the CLI session
- Handles streaming of:
  - User messages sent to the agent
  - Tool invocation events
  - Streaming text output
  - Model/reasoning choices
  - Completion events

### Question Routing (`skills/question-routing-hooks.mjs`)

- Intercepts `onElicitationRequest` and `onUserInputRequest` from the CLI session
- Uses structured elicitation (`requestedSchema`) as the canonical ask-user flow
- For structured answers:
  - Extracts `requestSchema` (JSON schema)
  - Registers question in relay database
  - Waits for browser to render form and user to submit
  - Retrieves `structuredAnswer` and returns `ElicitationResponse`

### Tool Activity (`skills/tool-activity.mjs`)

- Hooks Copilot SDK tool invocations
- Streams tool call details (name, arguments, status) to the relay
- Relays tool results back to the browser UI for real-time activity display
- Web Search and Web Fetch activity includes bounded query/URL details and output previews
- `store_memory` activity includes the available `subject`, `fact`, `citations`, `reason`, and `scope` metadata with preserved field content and line breaks
- `vote_memory` activity includes the available `fact`, `direction`, `reason`, and `scope` metadata with preserved field content and line breaks
- Activity is persisted by the relay and is therefore available to authorized shared viewers and replayed history

### Subagent attribution

The SDK `agentId` on a request is propagated as `subagentRunId` on question activity, tool-result
activity, and `report_intent` thoughts. Without it, work done by a subagent would be rendered in the
parent turn's bubble instead of the subagent's own. `skills/subagent-lifecycle.mjs` also preserves an
already-known run's parent and display name when the run is re-discovered (for example on its next
tool call), so a nested subagent is never demoted to a root or renamed mid-turn.

### Reasoning Stream (`skills/reasoning-stream.mjs`)

- (Planned) Optional feature to stream extended reasoning/thinking from models
- Can be toggled behind a feature flag

## Configuration

The extension loads configuration from:

1. `server/config.json` (default settings)
2. Environment variables (e.g., `COPILOT_REMOTE_POLLING_INTERVAL`)
3. Relay API responses (feature flags, runtime config)

Key config keys read by the extension:

- `pollIntervalMs` — How often to fetch pending turns (ms)
- `processingTimeoutMs` — Max turn execution time (ms)
- `workerRestartIntervalMs` — Backoff between worker restarts on failure (ms)
- Feature flags: `SESSION_WORKER_ROUTING_ENABLED`, `SESSION_WORKER_CONTINUATION_ROUTING_ENABLED`

## Session Worker Lifecycle

1. **Create** — New session worker spawned by polling loop on first turn for an `sdkSessionId`
2. **Connect** — Worker opens WebSocket link to relay and registers with `/api/workers`
3. **Execute** — Worker receives turns, executes via CLI session, streams activity
4. **Heartbeat** — Worker periodically sends keep-alive to indicate it's ready
5. **Degraded** — If heartbeat fails, relay marks worker as "degraded"; polling loop may restart it
6. **Restart** — If worker process exits unexpectedly or is in a bad state, polling loop spawns a replacement

## Startup Behavior

### Extension-Managed Mode (Default)

- Extension detects if relay is running: `GET /api/status` health check
- If relay is down, extension starts `server.js` via `npm start` from the relay repo root
- Extension owns the relay lifecycle and keeps it running as long as CLI is active
- Polling loop keeps running even between user turns
- On exit, extension gracefully shuts down relay

### Standalone Mode

- User manually runs `npm start` or `npm run copilot:relay` from relay repo
- CLI extension still runs polling loop, but doesn't supervise the relay
- Relay stays running after CLI exits (server continues listening on port 3333)

**Single-Owner Rule:** Never run both modes simultaneously; it will cause port conflicts and undefined behavior.

## Browser-to-Extension Communication

### WebSocket Message Flow

1. Browser sends message: `POST /api/messages` (queues with relay)
2. Extension polls: `GET /api/pending` (fetches from queue)
3. Extension opens WebSocket: `ws://localhost:3333/ws/worker/{sdkSessionId}`
4. Browser listens: `GET /api/messages/{id}/events` (Server-Sent Events stream)
5. Worker streams: Tool invocations, text chunks, activity updates
6. Browser renders: Real-time chat, tool activity, streaming text

### Question Flow

1. Agent/tool calls `onElicitationRequest(schema)` or `onUserInputRequest()`
2. Question routing skill detects and registers in relay
3. Browser fetches: `GET /api/ask-user` (gets pending questions)
4. Browser renders: Form or text input based on schema type
5. User submits: `POST /api/ask-user` with answer
6. Extension retrieves: `GET /api/pending` (gets question + answer)
7. Extension returns: `ElicitationResponse` to agent

## Testing

Test files located in:
- `runtime/worker-websocket-link.test.mjs` — WebSocket bridge tests
- `skills/*.test.mjs` — Skill handler tests

Run them with the Node test runner (there is no `npm test` script). Match `*.test.mjs` explicitly —
pointing the runner at a directory makes it try to execute the implementation modules too:
```bash
node --test .github/extensions/web-relay/skills/*.test.mjs
```

## Troubleshooting

### Relay won't start
- Check `npm install` has been run
- Verify Node.js 24+ is in PATH
- Check port 3333 is available (or use `"port"` in config)
- See extension logs: `server/logs/ext-debug.log`

### Polling loop not running
- Check extension is loaded: `gh extension list | grep web-relay`
- Check relay is healthy: `curl http://localhost:3333/api/status`
- Check CLI session is connected: Check browser sidebar for "Online" status

### Worker keeps restarting
- Check worker process logs: `server/logs/` directory
- Increase `processingTimeoutMs` if turns are timing out
- Check Copilot SDK issues: `gh copilot` errors in terminal

### Structured answers not appearing
- Check browser console for rendering errors
- Verify `request_schema` is valid JSON: Relay logs may show schema parse errors
- Check migration was applied: `server/data/copilot.db` should have `relay_questions.structured_answer` column

## Contributing

When modifying the extension:
- Keep polling loop responsive: avoid long synchronous operations
- Don't block WebSocket handling: stream events instead of buffering large responses
- Test with both macOS/Linux (tmux paths) and Windows (TTY-Console)
- Update test files alongside feature changes
