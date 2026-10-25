#!/usr/bin/env node
// DeepSeek session worker: the Claude session worker with its CLI pointed at
// DeepSeek's Anthropic-compatible endpoint (deepseek-claude-backend.mjs). The
// relay's launch puts the key in DEEPSEEK_API_KEY (through the owner-only
// secret file under tmux) and names the worker's own Claude Code state
// directory in DEEPSEEK_CLAUDE_CONFIG_DIR.
import fs from 'node:fs';

import { installWorkerLogFile, installWorkerLogRedaction } from '../../shared/worker-runtime/worker-log-file.mjs';
import { runClaudeSessionWorker } from '../claude-worker/claude-session-worker-main.mjs';
import { createDeepSeekClaudeBackend } from './deepseek-claude-backend.mjs';

installWorkerLogFile();
// The key never shows in this worker's console or log, whatever the CLI or
// the agent prints (installed after the log file, so its copy is redacted too).
installWorkerLogRedaction({ secrets: [process.env.DEEPSEEK_API_KEY] });

const backend = createDeepSeekClaudeBackend({ env: process.env });

// The worker reads the CLI's state too (the transcript a resume needs, the
// workflow files): it has to look where its CLI writes, never in the host's
// ~/.claude. The directory holds sessions, so only this user may open it.
if (backend.configDir) {
  fs.mkdirSync(backend.configDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(backend.configDir, 0o700); } catch {}
  process.env.CLAUDE_CONFIG_DIR = backend.configDir;
}

runClaudeSessionWorker({
  logTag: 'deepseek-worker',
  workerName: 'deepseek-session-worker',
  defaultModel: String(process.env.DEEPSEEK_RELAY_MODEL || '').trim() || backend.defaultModel,
  backend,
}).catch((error) => {
  console.error('deepseek-session-worker fatal:', error?.stack || error?.message || error);
  process.exit(1);
});
