'use strict';

import { execFileSync, spawn } from 'child_process';
import { createSessionWorkerProcessInspector } from './session-worker-process-service.mjs';
import { launchSessionCli } from './session-worker-launch-service.mjs';
import { windowsSystemToolPath } from '../../shared/windows-system-tools.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function parsePositiveInt(value) {
  const num = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(num) && num > 0 ? num : null;
}

export function createRelayCliLauncherService({
  platform = process.platform,
  cwd = process.cwd(),
  env = process.env,
  now = () => Date.now(),
  execFileSyncImpl = execFileSync,
  spawnImpl = spawn,
  sleepImpl = sleep,
  restartDelayMs = 500,
  killWaitMs = 700,
  maxKillAttempts = 10,
  log = () => {},
  // worker-scope.mjs: a scope of its own under a systemd user service.
  workerScope = null,
} = {}) {
  let activeJob = null;
  const processInspector = createSessionWorkerProcessInspector({
    platform,
    execFileSyncImpl: typeof execFileSyncImpl === 'function' ? execFileSyncImpl : undefined,
  });

  function resolveCwd(targetSessionId = null) {
    if (typeof cwd === 'function') {
      const next = String(cwd(targetSessionId) || '').trim();
      return next || process.cwd();
    }
    const next = String(cwd || '').trim();
    return next || process.cwd();
  }

  function getState() {
    if (!activeJob) return null;
    return {
      transactionId: activeJob.transactionId,
      targetSessionId: activeJob.targetSessionId,
      reason: activeJob.reason || null,
      status: activeJob.status,
      startedAt: activeJob.startedAt,
      completedAt: activeJob.completedAt || null,
      spawnedPid: activeJob.spawnedPid || null,
      error: activeJob.error || null,
      killedPids: Array.isArray(activeJob.killedPids) ? [...activeJob.killedPids] : [],
    };
  }

  function collectWindowsRetirePids(targetSessionId) {
    return processInspector.findWindowsProcessesForSession(targetSessionId)
      .map((proc) => parsePositiveInt(proc?.processId))
      .filter(Boolean);
  }

  function stopWindowsPids(pids) {
    const ids = Array.from(new Set(
      (Array.isArray(pids) ? pids : [pids])
        .map((value) => parsePositiveInt(value))
        .filter(Boolean),
    ));
    if (!ids.length) return [];
    const script = [
      '$ids = @(' + ids.join(',') + ')',
      'foreach ($id in $ids) {',
      '  try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch {}',
      '}',
    ].join('; ');
    execFileSyncImpl(windowsSystemToolPath('powershell.exe'), ['-NoProfile', '-Command', script], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return ids;
  }

  async function retireCliProcesses(job) {
    if (platform !== 'win32') return [];
    const killed = new Set();
    const attempts = Math.max(1, Number(maxKillAttempts || 1));
    const liveTarget = processInspector.findWindowsProcessForSession(job.targetSessionId);
    if (liveTarget?.processId) {
      return Array.from(killed);
    }
    for (let index = 0; index < attempts; index += 1) {
      let targetPids = [];
      try {
        targetPids = collectWindowsRetirePids(job.targetSessionId);
      } catch (error) {
        job.error = error?.message || String(error);
        throw error;
      }
      if (!targetPids.length) return Array.from(killed);
      for (const pid of stopWindowsPids(targetPids)) killed.add(pid);
      await sleepImpl(Math.max(0, Number(killWaitMs || 0)));
    }
    return Array.from(killed);
  }

  async function spawnSessionCli(targetSessionId) {
    const launched = await launchSessionCli({
      targetSessionId,
      cwd: resolveCwd(targetSessionId),
      env,
      platform,
      spawnImpl,
      execFileSyncImpl,
      processInspector,
      log,
      workerScope,
    });
    return launched;
  }

  async function runJob(job) {
    job.status = 'running';
    if (restartDelayMs > 0) {
      await sleepImpl(restartDelayMs);
    }
    const liveTarget = processInspector.findProcessForSession(job.targetSessionId);
    if (liveTarget?.processId) {
      job.killedPids = [];
      job.spawnedPid = liveTarget.processId;
      job.status = 'skipped';
      job.reason = 'target-already-running';
      job.completedAt = isoNow(now);
      log(`relay cli launcher: target ${job.targetSessionId} already running on pid ${liveTarget.processId}; skipping restart`);
      return;
    }
    log(`relay cli launcher: retiring cli processes for ${job.targetSessionId} tx=${job.transactionId || 'none'}`);
    job.killedPids = await retireCliProcesses(job);
    log(`relay cli launcher: spawning session-bound cli for ${job.targetSessionId}`);
    const launched = await spawnSessionCli(job.targetSessionId);
    job.spawnedPid = launched?.pid || null;
    if (launched?.launchMode === 'tmux' && launched?.tmuxSessionName) {
      log(`relay cli launcher: worker session ${job.targetSessionId} running in tmux session ${launched.tmuxSessionName}`);
    }
    job.status = 'spawned';
    job.completedAt = isoNow(now);
  }

  function scheduleRestart({ targetSessionId, transactionId = null, reason = null } = {}) {
    const target = String(targetSessionId || '').trim();
    const tx = String(transactionId || '').trim() || null;
    if (!target) {
      return { ok: false, error: 'missing-target-session', state: getState() };
    }
    const current = activeJob;
    if (current && !current.completedAt && current.status !== 'failed') {
      if (current.targetSessionId === target && current.transactionId === tx) {
        return { ok: true, accepted: true, reused: true, state: getState() };
      }
      return { ok: false, error: 'launcher-busy', state: getState() };
    }
    const liveTarget = processInspector.findProcessForSession(target);
    if (liveTarget?.processId) {
      return {
        ok: true,
        accepted: false,
        reused: true,
        reason: 'target-already-running',
        livePid: liveTarget.processId,
        state: getState(),
      };
    }

    const job = {
      transactionId: tx,
      targetSessionId: target,
      reason: String(reason || '').trim() || null,
      startedAt: isoNow(now),
      completedAt: null,
      status: 'scheduled',
      spawnedPid: null,
      error: null,
      killedPids: [],
      promise: null,
    };
    activeJob = job;
    job.promise = runJob(job).catch((error) => {
      job.status = 'failed';
      job.completedAt = isoNow(now);
      job.error = error?.message || String(error);
      log(`relay cli launcher failed for ${job.targetSessionId}: ${job.error}`);
    });
    return { ok: true, accepted: true, reused: false, state: getState() };
  }

  async function waitForIdle() {
    if (activeJob?.promise) {
      await activeJob.promise;
    }
  }

  return {
    scheduleRestart,
    waitForIdle,
    getState,
  };
}
