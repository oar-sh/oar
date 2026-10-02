#!/usr/bin/env node
// Claude Cloud session worker: a per-conversation Node process that speaks
// the same relay contracts as the Claude/Cursor/Grok workers, but runs no
// agent itself. The agent and its clone live in a Claude Code cloud session;
// this process sends the user's messages there and follows the session's
// event stream (claude-cloud-session-process.mjs).
import path from 'path';
import { fileURLToPath } from 'url';

import {
  loadTokenFromConfig,
  resolveRelayServerUrl,
} from '../../shared/worker-runtime/config-loader.mjs';
import { createApiClient } from '../../shared/worker-runtime/api-client.mjs';
import { createWorkerWebSocketLink } from '../../shared/worker-runtime/worker-websocket-link.mjs';
import { createHeartbeatController } from '../../shared/worker-runtime/heartbeat.mjs';
import { installWorkerLogFile } from '../../shared/worker-runtime/worker-log-file.mjs';
import { createControlPoller } from '../../shared/control-poller.mjs';
import { installWorkerCrashGuard } from '../../shared/worker-crash-guard.mjs';
import { createClaudeCloudCredentials } from '../../shared/claude-cloud/credentials.mjs';
import { createClaudeCloudClient } from '../../shared/claude-cloud/api-client.mjs';
import { resolveClaudeCloudBaseUrl } from '../../shared/claude-cloud/base-url.mjs';
import { createClaudeCloudSessionRunner } from './claude-cloud-session-process.mjs';

// Windows console launch: the launcher names the worker log, this copies
// stdout/stderr into it. A no-op wherever the launcher redirects instead.
installWorkerLogFile();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEARTBEAT_MS = 10_000;

function parseSessionIdArg(argv = process.argv) {
  const index = argv.indexOf('--session-id');
  if (index !== -1 && argv[index + 1]) return String(argv[index + 1]).trim();
  const inline = argv.find((arg) => String(arg || '').startsWith('--session-id='));
  if (inline) return String(inline.split('=')[1] || '').trim();
  return String(process.env.SESSION_ID || '').trim();
}

function dbg(...parts) {
  const timestamp = new Date().toISOString();
  console.log(`[claude-cloud-worker ${timestamp}]`, ...parts);
}

async function main() {
  const sdkSessionId = parseSessionIdArg();
  if (!sdkSessionId) {
    console.error('claude-cloud-session-worker: missing --session-id');
    process.exit(2);
  }

  const configPath = String(process.env.COPILOT_WEB_RELAY_CONFIG || '').trim()
    || path.resolve(__dirname, '..', 'config.json');
  const serverUrl = resolveRelayServerUrl({ configPath });
  const token = loadTokenFromConfig(configPath);
  const defaultModel = String(process.env.CLAUDE_CLOUD_RELAY_MODEL || '').trim();

  const api = createApiClient({
    serverUrl,
    token,
    getHeaders: () => ({
      'X-Relay-Process-Pid': String(process.pid),
      'X-Relay-Parent-Pid': String(process.ppid),
      'X-Relay-Session-Id': sdkSessionId,
      'X-Relay-Conversation-Id': sdkSessionId,
    }),
  });

  // The Claude CLI's login, read by the client's own module (the credentials
  // file, or CLAUDE_CODE_OAUTH_TOKEN where the relay runs on one): this
  // process never logs it. A login that has run out is nudged through the
  // relay, which can run the CLI (`claude auth status` refreshes a login
  // whose refresh token is still good); the file is read again afterwards.
  // The base URL is the Anthropic API unless a test names a fake one on this
  // machine (base-url.mjs takes nothing else).
  const cloud = createClaudeCloudClient({
    credentials: createClaudeCloudCredentials({
      nudge: async () => {
        const answer = await api('POST', '/api/claude-cloud/login-nudge', {});
        dbg('login nudge', answer?.nudged ? 'ran' : 'skipped', answer?.expired ? 'still expired' : `expires ${answer?.expiresAt || '?'}`);
      },
    }),
    baseUrl: resolveClaudeCloudBaseUrl(process.env),
  });

  const controlPoller = createControlPoller({
    api,
    sdkSessionId,
    abortAckNote: 'cloud turn interrupted',
    dbg,
  });
  const runner = createClaudeCloudSessionRunner({
    api,
    cloud,
    sdkSessionId,
    defaultModel,
    controlPoller,
    dbg,
  });

  let heartbeatTimer = null;
  const heartbeat = createHeartbeatController({
    api,
    pollMs: HEARTBEAT_MS,
    getSessionReady: () => true,
    getHeartbeatTimer: () => heartbeatTimer,
    setHeartbeatTimer: (timer) => { heartbeatTimer = timer; },
    getActiveQueueMessageId: () => runner.getActiveQueueMessageId(),
  });

  const wsLink = createWorkerWebSocketLink({
    serverUrl,
    token,
    dbg,
    getSessionReady: () => true,
    getSessionId: () => sdkSessionId,
    getPid: () => process.pid,
    onDeliver: async (pending, reason) => {
      dbg('queue.deliver received', `reason=${reason}`, `msgId=${pending?.message?.id || 'none'}`);
      try {
        return await runner.handlePendingPayload(pending);
      } catch (error) {
        dbg('turn handling failed', error?.message || String(error));
        return false;
      }
    },
  });

  const shutdown = async (signal) => {
    dbg(`shutting down (${signal})`);
    try { wsLink.stop(); } catch {}
    try { heartbeat.stopHeartbeat(); } catch {}
    try { controlPoller.stop(); } catch {}
    // The cloud session is left as it is: a turn in flight keeps running
    // there, and the next worker finds it through the stored sequence number.
    try { await runner.dispose(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  installWorkerCrashGuard({
    api,
    workerName: 'claude-cloud-session-worker',
    getActiveQueueMessageIds: () => [runner.getActiveQueueAttempt()],
  });

  dbg(`starting session=${sdkSessionId.slice(0, 8)} server=${serverUrl} model=${defaultModel || 'default'}`);
  heartbeat.startHeartbeat();
  wsLink.start();
}

main().catch((error) => {
  console.error('claude-cloud-session-worker fatal:', error?.stack || error?.message || error);
  process.exit(1);
});
