#!/usr/bin/env node
// Claude API session worker: the Claude session worker with its CLI on the
// Anthropic API and the key saved in Settings → Providers → Claude API
// (claude-api-backend.mjs). The relay's launch puts the key in
// OAR_CLAUDE_API_KEY (through the owner-only secret file under tmux) and the
// chat's model in CLAUDE_API_RELAY_MODEL. The CLI keeps the host's Claude
// Code state directory: the chats are Claude chats, resumed and read where
// the Claude worker reads them.
import { installWorkerLogFile, installWorkerLogRedaction } from '../../shared/worker-runtime/worker-log-file.mjs';
import { runClaudeSessionWorker } from '../claude-worker/claude-session-worker-main.mjs';
import { CLAUDE_API_KEY_ENV, createClaudeApiClaudeBackend } from './claude-api-backend.mjs';

installWorkerLogFile();
// The key never shows in this worker's console or log, whatever the CLI or
// the agent prints (installed after the log file, so its copy is redacted too).
installWorkerLogRedaction({ secrets: [process.env[CLAUDE_API_KEY_ENV]] });

const backend = createClaudeApiClaudeBackend({ env: process.env });

runClaudeSessionWorker({
  logTag: 'claude-api-worker',
  workerName: 'claude-api-session-worker',
  // None set: the CLI's own default, as for a Claude chat without a model.
  defaultModel: String(process.env.CLAUDE_API_RELAY_MODEL || '').trim(),
  backend,
}).catch((error) => {
  console.error('claude-api-session-worker fatal:', error?.stack || error?.message || error);
  process.exit(1);
});
