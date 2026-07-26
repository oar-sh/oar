'use strict';

import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

function buildPosixWorkerLaunchCommand(targetSessionId, env = {}) {
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

export function createWorkerSecretEnvFile(env = {}, {
  fsImpl = fs,
  tempRoot = os.tmpdir(),
} = {}) {
  const apiKey = String(env?.COPILOT_PROVIDER_API_KEY || '').trim();
  if (!apiKey) return null;
  const directoryPath = fsImpl.mkdtempSync(path.join(tempRoot, 'copilot-relay-worker-'));
  fsImpl.chmodSync(directoryPath, 0o700);
  const filePath = path.join(directoryPath, 'provider.env');
  fsImpl.writeFileSync(
    filePath,
    `export COPILOT_PROVIDER_API_KEY=${shellQuote(apiKey)}\n`,
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

export function buildTmuxWorkerShellCommand(targetSessionId, env = {}, {
  secretEnvFilePath = '',
} = {}) {
  const launchEnv = {
    ...env,
    SESSION_ID: String(targetSessionId || '').trim() || String(env?.SESSION_ID || '').trim(),
  };
  const providerApiKey = String(launchEnv.COPILOT_PROVIDER_API_KEY || '').trim();
  const normalizedSecretEnvFilePath = String(secretEnvFilePath || '').trim();
  if (providerApiKey && !normalizedSecretEnvFilePath) {
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
  // Use script to create a pseudo-TTY without GH_FORCE_TTY so the CLI routes
  // ask_user requests through the SDK's onUserInputRequest handler instead of
  // drawing terminal prompts.
  const workerCommand = buildPosixWorkerLaunchCommand(targetSessionId, launchEnv);
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

  const posixCliExecutable = normalizeText(launchSessionEnv.COPILOT_WEB_RELAY_CLI_EXECUTABLE)
    || normalizeText(launchSessionEnv.COPILOT_CLI_EXECUTABLE)
    || normalizeText(launchSessionEnv.COPILOT_CLI_PATH)
    || 'copilot';
  const spawnCommand = platform === 'win32'
    ? (launchSessionEnv.ComSpec || process.env.ComSpec || 'cmd.exe')
    : posixCliExecutable;
  const spawnArgs = platform === 'win32'
    ? [
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
    ]
    : ['--allow-all', '--session-id', target];
  const child = spawnImpl(spawnCommand, spawnArgs, {
    cwd: launchProcessCwd,
    env: launchSessionEnv,
    detached: true,
    stdio: 'ignore',
    windowsHide: platform !== 'win32',
  });
  child.unref?.();
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
