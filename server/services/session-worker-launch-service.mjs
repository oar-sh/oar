'use strict';

import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function parsePositiveInt(value) {
  const num = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(num) && num > 0 ? num : null;
}

function isPidAlive(pidValue) {
  const pid = Number(pidValue);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = String(error?.code || '').trim().toUpperCase();
    return code === 'EPERM';
  }
}

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || null;
}

export function resolveOpenAIWireApi(model = '') {
  const normalized = String(model || '').trim().toLowerCase().replace(/^openai\//, '');
  if (
    normalized.startsWith('gpt-5')
    || normalized.startsWith('codex-')
    || normalized === 'o1'
    || normalized.startsWith('o1-')
    || normalized === 'o3'
    || normalized.startsWith('o3-')
    || normalized.startsWith('o4-')
  ) {
    return 'responses';
  }
  return 'completions';
}

export function applyOpenAIProviderEnvironment(env = {}, {
  enabled = false,
  apiKey = '',
  model = '',
  baseUrl = 'https://api.openai.com/v1',
  wireApi = '',
} = {}) {
  const next = { ...env };
  for (const key of [
    'COPILOT_PROVIDER_TYPE',
    'COPILOT_PROVIDER_BASE_URL',
    'COPILOT_PROVIDER_API_KEY',
    'COPILOT_PROVIDER_WIRE_API',
    'COPILOT_MODEL',
  ]) {
    delete next[key];
  }
  if (!enabled) return next;
  const normalizedApiKey = normalizeText(apiKey);
  const normalizedModel = normalizeText(model);
  if (!normalizedApiKey) throw new Error('openai-api-key-not-configured');
  if (!normalizedModel) throw new Error('openai-model-not-configured');
  next.COPILOT_PROVIDER_TYPE = 'openai';
  next.COPILOT_PROVIDER_BASE_URL = normalizeText(baseUrl) || 'https://api.openai.com/v1';
  next.COPILOT_PROVIDER_API_KEY = normalizedApiKey;
  next.COPILOT_PROVIDER_WIRE_API = normalizeText(wireApi) || resolveOpenAIWireApi(normalizedModel);
  next.COPILOT_MODEL = normalizedModel;
  return next;
}

export function resolveWorkerKind(env = {}) {
  const kind = String(env?.COPILOT_WEB_RELAY_WORKER_KIND || '').trim().toLowerCase();
  if (kind === 'claude' || kind === 'cursor' || kind === 'grok') return kind;
  return 'copilot';
}

export function applyClaudeProviderEnvironment(env = {}, {
  enabled = false,
  model = '',
} = {}) {
  const next = { ...env };
  // Only clear the worker kind this provider owns so clear chains stay
  // order-independent when multiple provider appliers run back to back.
  if (resolveWorkerKind(next) === 'claude') delete next.COPILOT_WEB_RELAY_WORKER_KIND;
  delete next.CLAUDE_RELAY_MODEL;
  if (!enabled) return next;
  // The Claude worker authenticates through the host's logged-in Claude
  // credentials, so no API key flows through the environment here.
  next.COPILOT_WEB_RELAY_WORKER_KIND = 'claude';
  const normalizedModel = normalizeText(model);
  if (normalizedModel) next.CLAUDE_RELAY_MODEL = normalizedModel;
  return next;
}

export function applyCursorProviderEnvironment(env = {}, {
  enabled = false,
  model = '',
  apiKey = '',
} = {}) {
  const next = { ...env };
  if (resolveWorkerKind(next) === 'cursor') delete next.COPILOT_WEB_RELAY_WORKER_KIND;
  delete next.CURSOR_RELAY_MODEL;
  delete next.CURSOR_API_KEY;
  if (!enabled) return next;
  const normalizedApiKey = normalizeText(apiKey);
  if (!normalizedApiKey) throw new Error('cursor-api-key-not-configured');
  next.COPILOT_WEB_RELAY_WORKER_KIND = 'cursor';
  next.CURSOR_API_KEY = normalizedApiKey;
  const normalizedModel = normalizeText(model);
  if (normalizedModel) next.CURSOR_RELAY_MODEL = normalizedModel;
  return next;
}

export function applyGrokProviderEnvironment(env = {}, {
  enabled = false,
  model = '',
  command = '',
} = {}) {
  const next = { ...env };
  // Host-login provider (like Claude): no API key is required in the relay.
  if (resolveWorkerKind(next) === 'grok') delete next.COPILOT_WEB_RELAY_WORKER_KIND;
  delete next.GROK_RELAY_MODEL;
  delete next.GROK_CLI_COMMAND;
  if (!enabled) return next;
  next.COPILOT_WEB_RELAY_WORKER_KIND = 'grok';
  const normalizedModel = normalizeText(model);
  if (normalizedModel) next.GROK_RELAY_MODEL = normalizedModel;
  const normalizedCommand = normalizeText(command);
  if (normalizedCommand) next.GROK_CLI_COMMAND = normalizedCommand;
  return next;
}

export function isClaudeWorkerEnvironment(env = {}) {
  return String(env?.COPILOT_WEB_RELAY_WORKER_KIND || '').trim().toLowerCase() === 'claude';
}

export function isCursorWorkerEnvironment(env = {}) {
  return resolveWorkerKind(env) === 'cursor';
}

export function isGrokWorkerEnvironment(env = {}) {
  return resolveWorkerKind(env) === 'grok';
}

export function resolveClaudeWorkerScriptPath(env = {}) {
  const explicit = normalizeText(env?.COPILOT_WEB_RELAY_CLAUDE_WORKER_PATH);
  if (explicit) return explicit;
  const repoRoot = normalizeText(env?.COPILOT_WEB_RELAY_ROOT);
  if (repoRoot) return path.join(repoRoot, 'server', 'claude-worker', 'claude-session-worker.mjs');
  const serverDir = normalizeText(env?.COPILOT_WEB_RELAY_SERVER_DIR);
  if (serverDir) return path.join(serverDir, 'claude-worker', 'claude-session-worker.mjs');
  return path.join(process.cwd(), 'server', 'claude-worker', 'claude-session-worker.mjs');
}

export function resolveCursorWorkerScriptPath(env = {}) {
  const explicit = normalizeText(env?.COPILOT_WEB_RELAY_CURSOR_WORKER_PATH);
  if (explicit) return explicit;
  const repoRoot = normalizeText(env?.COPILOT_WEB_RELAY_ROOT);
  if (repoRoot) return path.join(repoRoot, 'server', 'cursor-worker', 'cursor-session-worker.mjs');
  const serverDir = normalizeText(env?.COPILOT_WEB_RELAY_SERVER_DIR);
  if (serverDir) return path.join(serverDir, 'cursor-worker', 'cursor-session-worker.mjs');
  return path.join(process.cwd(), 'server', 'cursor-worker', 'cursor-session-worker.mjs');
}

export function resolveGrokWorkerScriptPath(env = {}) {
  const explicit = normalizeText(env?.COPILOT_WEB_RELAY_GROK_WORKER_PATH);
  if (explicit) return explicit;
  const repoRoot = normalizeText(env?.COPILOT_WEB_RELAY_ROOT);
  if (repoRoot) return path.join(repoRoot, 'server', 'grok-worker', 'grok-session-worker.mjs');
  const serverDir = normalizeText(env?.COPILOT_WEB_RELAY_SERVER_DIR);
  if (serverDir) return path.join(serverDir, 'grok-worker', 'grok-session-worker.mjs');
  return path.join(process.cwd(), 'server', 'grok-worker', 'grok-session-worker.mjs');
}

// Workers that run as plain Node processes (no CLI, no pseudo-TTY). Copilot is
// intentionally absent: its launch path must stay exactly as-is.
const NODE_WORKER_DESCRIPTORS = Object.freeze({
  claude: Object.freeze({ resolveScriptPath: resolveClaudeWorkerScriptPath, windowsTitle: 'Claude Worker' }),
  cursor: Object.freeze({ resolveScriptPath: resolveCursorWorkerScriptPath, windowsTitle: 'Cursor Worker' }),
  grok: Object.freeze({ resolveScriptPath: resolveGrokWorkerScriptPath, windowsTitle: 'Grok Worker' }),
});

function resolveNodeWorkerDescriptor(env = {}) {
  const descriptor = NODE_WORKER_DESCRIPTORS[resolveWorkerKind(env)];
  if (!descriptor) return null;
  return {
    scriptPath: descriptor.resolveScriptPath(env),
    windowsTitle: descriptor.windowsTitle,
  };
}

function buildPosixWorkerLaunchCommand(targetSessionId, env = {}) {
  const nodeWorker = resolveNodeWorkerDescriptor(env);
  if (nodeWorker) {
    const nodeExecutable = normalizeText(env?.COPILOT_WEB_RELAY_NODE) || 'node';
    return `${shellQuote(nodeExecutable)} ${shellQuote(nodeWorker.scriptPath)} --session-id ${shellQuote(targetSessionId)}`;
  }
  const cliExecutable = normalizeText(env?.COPILOT_WEB_RELAY_CLI_EXECUTABLE)
    || normalizeText(env?.COPILOT_CLI_EXECUTABLE)
    || normalizeText(env?.COPILOT_CLI_PATH)
    || 'copilot';
  return `${shellQuote(cliExecutable)} --allow-all --session-id ${shellQuote(targetSessionId)}`;
}

export function normalizeTmuxSessionName(targetSessionId) {
  const text = String(targetSessionId || '').trim();
  if (!text) throw new Error('missing-target-session-id');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error(`invalid-tmux-session-name:${text}`);
  }
  return text;
}

export function isTmuxAvailable({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform === 'win32') return false;
  try {
    execFileSyncImpl('tmux', ['-V'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function tmuxSessionExists(sessionName, {
  execFileSyncImpl = execFileSync,
} = {}) {
  try {
    execFileSyncImpl('tmux', ['has-session', '-t', sessionName], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function killTmuxSession(sessionName, {
  execFileSyncImpl = execFileSync,
} = {}) {
  if (!tmuxSessionExists(sessionName, { execFileSyncImpl })) return false;
  try {
    execFileSyncImpl('tmux', ['kill-session', '-t', sessionName], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function getTmuxPanePid(sessionName, {
  execFileSyncImpl = execFileSync,
} = {}) {
  try {
    const output = execFileSyncImpl('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_pid}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const firstLine = String(output || '').trim().split(/\r?\n/).find(Boolean) || '';
    return parsePositiveInt(firstLine);
  } catch {
    return null;
  }
}

export const WORKER_SECRET_ENV_VARS = Object.freeze(['COPILOT_PROVIDER_API_KEY', 'CURSOR_API_KEY']);

export function createWorkerSecretEnvFile(env = {}, {
  fsImpl = fs,
  tempRoot = os.tmpdir(),
} = {}) {
  const secretLines = [];
  for (const key of WORKER_SECRET_ENV_VARS) {
    const value = String(env?.[key] || '').trim();
    if (!value) continue;
    secretLines.push(`export ${key}=${shellQuote(value)}\n`);
  }
  if (!secretLines.length) return null;
  const directoryPath = fsImpl.mkdtempSync(path.join(tempRoot, 'copilot-relay-worker-'));
  fsImpl.chmodSync(directoryPath, 0o700);
  const filePath = path.join(directoryPath, 'provider.env');
  fsImpl.writeFileSync(
    filePath,
    secretLines.join(''),
    { encoding: 'utf8', mode: 0o600 },
  );
  fsImpl.chmodSync(filePath, 0o600);
  return {
    filePath,
    cleanup() {
      fsImpl.rmSync(filePath, { force: true });
      fsImpl.rmdirSync(directoryPath);
    },
  };
}

/**
 * Where a worker's stdout/stderr land. Before this existed workers ran with
 * their output discarded (`stdio: 'ignore'` / bare tmux exec), so a crash
 * left zero forensic trail — the failure mode that made the 2026-08-11
 * incident undiagnosable. Best-effort by design: a log problem must never
 * block a worker spawn. Naive rotation: >10 MB rolls to `<file>.1`.
 */
export function prepareWorkerLogFile(targetSessionId, launchEnv = {}, {
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  try {
    const explicitDir = normalizeText(launchEnv?.COPILOT_WEB_RELAY_LOG_DIR);
    const serverDir = normalizeText(launchEnv?.COPILOT_WEB_RELAY_SERVER_DIR);
    // `new URL(...).pathname` yields '/C:/git/...' on Windows, which pathImpl.join
    // then mangles into '\C:\git\...'; fileURLToPath decodes it to a real host path.
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const baseDir = explicitDir
      || (serverDir ? pathImpl.join(serverDir, 'logs') : pathImpl.join(moduleDir, '..', 'logs'));
    fsImpl.mkdirSync(baseDir, { recursive: true });
    const safeId = String(targetSessionId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'worker';
    const logPath = pathImpl.join(baseDir, `worker-${safeId}.log`);
    try {
      const stats = fsImpl.statSync(logPath);
      if (stats.size > 10 * 1024 * 1024) fsImpl.renameSync(logPath, `${logPath}.1`);
    } catch {}
    return logPath;
  } catch {
    return null;
  }
}

export function buildTmuxWorkerShellCommand(targetSessionId, env = {}, {
  secretEnvFilePath = '',
  workerLogPath = '',
} = {}) {
  const launchEnv = {
    ...env,
    SESSION_ID: String(targetSessionId || '').trim() || String(env?.SESSION_ID || '').trim(),
  };
  const hasSecretEnvValue = WORKER_SECRET_ENV_VARS
    .some((key) => String(launchEnv[key] || '').trim());
  const normalizedSecretEnvFilePath = String(secretEnvFilePath || '').trim();
  if (hasSecretEnvValue && !normalizedSecretEnvFilePath) {
    throw new Error('worker-secret-env-file-required');
  }
  const exports = [];
  for (const key of [
    'COPILOT_ALLOW_ALL',
    'GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS',
    'COPILOT_WEB_RELAY_ROOT',
    'COPILOT_WEB_RELAY_SERVER_DIR',
    'COPILOT_WEB_RELAY_CONFIG',
    'COPILOT_WEB_RELAY_TOOLS',
    'COPILOT_WEB_RELAY_LOG_DIR',
    'COPILOT_WEB_RELAY_CLI_EXECUTABLE',
    'COPILOT_WEB_RELAY_EXTENSION_BOOTSTRAP_PATH',
    'COPILOT_SDK_PATH',
    'EXTENSION_PATH',
    'COPILOT_PROVIDER_TYPE',
    'COPILOT_PROVIDER_BASE_URL',
    'COPILOT_PROVIDER_WIRE_API',
    'COPILOT_MODEL',
    'COPILOT_WEB_RELAY_WORKER_KIND',
    // Without this the tmux path would fall back to ~/.claude while the relay
    // (and the detached spawn path, which inherits the full environment) uses
    // the override — worker and relay would read different config roots.
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_RELAY_MODEL',
    'CURSOR_RELAY_MODEL',
    'CURSOR_AGENT_STORE_DIR',
    'GROK_RELAY_MODEL',
    'GROK_CLI_COMMAND',
    'GROK_ALWAYS_APPROVE',
    'SESSION_ID',
    'COPILOT_WORKSPACE_ROOT',
    'INIT_CWD',
  ]) {
    const value = String(launchEnv?.[key] || '').trim();
    if (!value) continue;
    exports.push(`${key}=${shellQuote(value)}`);
  }
  const prefix = exports.length ? `${exports.map((entry) => `export ${entry};`).join(' ')} ` : '';
  const secretPrefix = normalizedSecretEnvFilePath
    ? `. ${shellQuote(normalizedSecretEnvFilePath)} || exit $?; rm -f ${shellQuote(normalizedSecretEnvFilePath)}; rmdir ${shellQuote(path.dirname(normalizedSecretEnvFilePath))}; `
    : '';
  const workerCommand = buildPosixWorkerLaunchCommand(targetSessionId, launchEnv);
  if (resolveNodeWorkerDescriptor(launchEnv)) {
    // Node workers (Claude, Cursor, Grok) are plain processes; no pseudo-TTY
    // needed. Their output is teed to the worker log so a crash leaves a
    // trail (the Copilot CLI keeps its own logs and draws a TUI, so it is
    // deliberately not teed).
    const teeSuffix = String(workerLogPath || '').trim()
      ? ` >> ${shellQuote(workerLogPath)} 2>&1`
      : '';
    return `${prefix}${secretPrefix}exec ${workerCommand}${teeSuffix}`;
  }
  // Use script to create a pseudo-TTY without GH_FORCE_TTY so the CLI routes
  // ask_user requests through the SDK's onUserInputRequest handler instead of
  // drawing terminal prompts.
  return `${prefix}${secretPrefix}exec script -q -c ${shellQuote(workerCommand)} /dev/null`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildWorkerLaunchEnv({ processCwd, workspaceRoot, env = process.env } = {}) {
  const launchProcessCwd = String(processCwd || '').trim();
  const launchWorkspaceRoot = String(workspaceRoot || '').trim() || launchProcessCwd;
  if (!launchProcessCwd && !launchWorkspaceRoot) return env;
  const launchEnv = {
    ...env,
    COPILOT_ALLOW_ALL: 'true',
    GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'true',
    ...(launchWorkspaceRoot ? {
      COPILOT_WORKSPACE_ROOT: launchWorkspaceRoot,
      INIT_CWD: launchWorkspaceRoot,
    } : {}),
    ...(launchProcessCwd ? { PWD: launchProcessCwd } : {}),
  };
  // COPILOT_ALLOW_ALL matches the --allow-all launch flag and lets headless
  // workers pass folder trust before extension activation. The global wrapper
  // handles outside-package workers and defers to the project extension inside
  // this package, so workers must not force both.
  delete launchEnv.COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION;
  return launchEnv;
}

export async function launchSessionCli({
  targetSessionId,
  cwd,
  processCwd = '',
  workspaceRoot = '',
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  execFileSyncImpl = execFileSync,
  processInspector = null,
  tmuxPollAttempts = 4,
  tmuxPollDelayMs = 200,
  detachedPollAttempts = 10,
  detachedPollDelayMs = 200,
  allowProcessReuse = true,
  createSecretEnvFileImpl = createWorkerSecretEnvFile,
} = {}) {
  const target = String(targetSessionId || '').trim();
  if (!target) throw new Error('missing-target-session-id');

  // Kill switch for test/e2e servers: a relay started with this env var must
  // never spawn real session workers (Copilot CLI clients or Claude workers).
  if (String(env?.COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN || '').trim()) {
    throw new Error('cli-spawn-disabled');
  }

  if (allowProcessReuse) {
    const liveProcess = typeof processInspector?.findProcessForSession === 'function'
      ? processInspector.findProcessForSession(target)
      : null;
    const liveProcessPid = parsePositiveInt(liveProcess?.processId);
    if (liveProcessPid && isPidAlive(liveProcessPid)) {
      return {
        pid: liveProcessPid,
        reused: true,
        launchMode: platform === 'win32' ? 'detached' : 'existing',
        tmuxSessionName: null,
      };
    }
  }

  const launchWorkspaceRoot = String(workspaceRoot || cwd || process.cwd());
  const launchProcessCwd = String(processCwd || cwd || process.cwd());
  const launchEnv = buildWorkerLaunchEnv({
    processCwd: launchProcessCwd,
    workspaceRoot: launchWorkspaceRoot,
    env,
  });
  const launchSessionEnv = {
    ...launchEnv,
    SESSION_ID: target,
  };

  if (isTmuxAvailable({ platform, execFileSyncImpl })) {
    const sessionName = normalizeTmuxSessionName(target);
    const tmuxEnv = { ...launchSessionEnv };
    delete tmuxEnv.TMUX;
    delete tmuxEnv.TMUX_PANE;
    delete tmuxEnv.COPILOT_PROVIDER_API_KEY;
    delete tmuxEnv.CURSOR_API_KEY;
    if (allowProcessReuse) {
      const existingPanePid = getTmuxPanePid(sessionName, { execFileSyncImpl });
      if (existingPanePid && isPidAlive(existingPanePid)) {
        return {
          pid: existingPanePid,
          reused: true,
          launchMode: 'tmux',
          tmuxSessionName: sessionName,
        };
      }
    }
    killTmuxSession(sessionName, { execFileSyncImpl });
    const secretEnvFile = createSecretEnvFileImpl(launchSessionEnv);
    const tmuxWorkerLogPath = resolveNodeWorkerDescriptor(launchSessionEnv)
      ? prepareWorkerLogFile(target, launchSessionEnv)
      : null;
    try {
      execFileSyncImpl('tmux', [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-c',
        launchProcessCwd,
        'sh',
        '-lc',
        buildTmuxWorkerShellCommand(target, launchSessionEnv, {
          secretEnvFilePath: secretEnvFile?.filePath,
          workerLogPath: tmuxWorkerLogPath || '',
        }),
      ], {
        env: tmuxEnv,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch (error) {
      secretEnvFile?.cleanup?.();
      throw error;
    }
    const attempts = Math.max(1, Number(tmuxPollAttempts) || 1);
    for (let index = 0; index < attempts; index += 1) {
      await sleep(Math.max(50, Number(tmuxPollDelayMs) || 200));
      const processMatch = typeof processInspector?.findProcessForSession === 'function'
        ? processInspector.findProcessForSession(target)
        : null;
      if (processMatch?.processId) {
        return {
          pid: Number(processMatch.processId),
          reused: false,
          launchMode: 'tmux',
          tmuxSessionName: sessionName,
        };
      }
      const panePid = getTmuxPanePid(sessionName, { execFileSyncImpl });
      if (panePid && isPidAlive(panePid)) {
        return {
          pid: panePid,
          reused: false,
          launchMode: 'tmux',
          tmuxSessionName: sessionName,
        };
      }
    }
    throw new Error('worker-spawn-unhealthy:tmux-pane-missing');
  }

  const nodeWorker = resolveNodeWorkerDescriptor(launchSessionEnv);
  const nodeWorkerExecutable = normalizeText(launchSessionEnv.COPILOT_WEB_RELAY_NODE) || 'node';
  const posixCliExecutable = normalizeText(launchSessionEnv.COPILOT_WEB_RELAY_CLI_EXECUTABLE)
    || normalizeText(launchSessionEnv.COPILOT_CLI_EXECUTABLE)
    || normalizeText(launchSessionEnv.COPILOT_CLI_PATH)
    || 'copilot';
  const spawnCommand = platform === 'win32'
    ? (launchSessionEnv.ComSpec || process.env.ComSpec || 'cmd.exe')
    : (nodeWorker ? nodeWorkerExecutable : posixCliExecutable);
  const spawnArgs = platform === 'win32'
    ? (nodeWorker
      ? [
        '/d',
        '/s',
        '/c',
        'start',
        `${nodeWorker.windowsTitle} ${target.slice(0, 8)}`,
        nodeWorkerExecutable,
        nodeWorker.scriptPath,
        '--session-id',
        target,
      ]
      : [
        '/d',
        '/s',
        '/c',
        'start',
        `Copilot Worker ${target.slice(0, 8)}`,
        'gh',
        'copilot',
        '--',
        '--allow-all',
        '--session-id',
        target,
      ])
    : (nodeWorker
      ? [nodeWorker.scriptPath, '--session-id', target]
      : ['--allow-all', '--session-id', target]);
  // POSIX node workers tee stdout/stderr into the worker log (a crash must
  // leave a trail). On win32 the `start` intermediary opens its own console,
  // so fd inheritance cannot reach the worker — its window shows the output.
  let detachedStdio = 'ignore';
  if (platform !== 'win32' && nodeWorker) {
    const workerLogPath = prepareWorkerLogFile(target, launchSessionEnv);
    if (workerLogPath) {
      try {
        const logFd = fs.openSync(workerLogPath, 'a');
        detachedStdio = ['ignore', logFd, logFd];
      } catch {
        detachedStdio = 'ignore';
      }
    }
  }
  const child = spawnImpl(spawnCommand, spawnArgs, {
    cwd: launchProcessCwd,
    env: launchSessionEnv,
    detached: true,
    stdio: detachedStdio,
    windowsHide: platform !== 'win32',
  });
  child.unref?.();
  if (Array.isArray(detachedStdio) && typeof detachedStdio[1] === 'number') {
    // The child inherited the descriptor; the parent's copy must not leak.
    try { fs.closeSync(detachedStdio[1]); } catch {}
  }
  if (platform === 'win32') {
    const attempts = Math.max(1, Number(detachedPollAttempts) || 1);
    for (let index = 0; index < attempts; index += 1) {
      await sleep(Math.max(50, Number(detachedPollDelayMs) || 200));
      const processMatch = typeof processInspector?.findProcessForSession === 'function'
        ? processInspector.findProcessForSession(target)
        : null;
      const processPid = parsePositiveInt(processMatch?.processId);
      if (processPid && isPidAlive(processPid)) {
        return {
          pid: processPid,
          reused: false,
          launchMode: 'console',
          tmuxSessionName: null,
          child,
        };
      }
    }
    return {
      pid: null,
      reused: false,
      launchMode: 'console',
      tmuxSessionName: null,
      child,
    };
  }
  const pid = parsePositiveInt(child?.pid);
  if (!pid) throw new Error('worker-spawn-unhealthy:missing-pid');
  return {
    pid,
    reused: false,
    launchMode: 'detached',
    tmuxSessionName: null,
    child,
  };
}
