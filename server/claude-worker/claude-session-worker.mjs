#!/usr/bin/env node
// Claude session worker: a per-conversation Node process that speaks the same
// relay contracts as the Copilot CLI workers (worker WebSocket, heartbeat,
// control polling, activity channels) but executes turns through the Claude
// Agent SDK using the host machine's logged-in Claude credentials.
import { installWorkerLogFile } from '../../shared/worker-runtime/worker-log-file.mjs';
import { runClaudeSessionWorker } from './claude-session-worker-main.mjs';

// Windows console launch: the launcher names the worker log, this copies
// stdout/stderr into it. A no-op wherever the launcher redirects instead.
installWorkerLogFile();

runClaudeSessionWorker().catch((error) => {
  console.error('claude-session-worker fatal:', error?.stack || error?.message || error);
  process.exit(1);
});
