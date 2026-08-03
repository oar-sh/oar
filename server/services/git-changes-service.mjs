'use strict';

import { execFile as nodeExecFile } from 'child_process';

// Read-only-ish git integration for the "Git changes" modal: status (branch,
// ahead/behind, changed files), a full-context per-file diff, and pull.
// The service never receives paths from the client directly — routes resolve
// the workspace root server-side and validate file paths before calling in.

const GIT_COMMAND_TIMEOUT_MS = 15_000;
const GIT_PULL_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
// Large enough that hunks always include the whole file, so the client can
// render both "full file" and "changes only" views from one patch.
const FULL_CONTEXT_LINES = 999_999;

function normalizeGitPath(value) {
  const text = String(value || '');
  if (!text) return '';
  // Porcelain quotes paths with special characters ("path with\ttab").
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

export function parseGitStatusBranchHeader(headerLine) {
  const result = { branch: '', upstream: '', ahead: 0, behind: 0, detached: false, initial: false };
  const text = String(headerLine || '').trim();
  if (!text.startsWith('##')) return result;
  let body = text.slice(2).trim();
  if (!body) return result;
  if (body.startsWith('No commits yet on ')) {
    result.branch = body.slice('No commits yet on '.length).trim();
    result.initial = true;
    return result;
  }
  if (body === 'HEAD (no branch)') {
    result.branch = 'HEAD';
    result.detached = true;
    return result;
  }
  const bracketStart = body.lastIndexOf(' [');
  if (bracketStart !== -1 && body.endsWith(']')) {
    const tracking = body.slice(bracketStart + 2, -1);
    body = body.slice(0, bracketStart);
    const aheadMatch = tracking.match(/ahead (\d+)/);
    const behindMatch = tracking.match(/behind (\d+)/);
    if (aheadMatch) result.ahead = Number(aheadMatch[1]);
    if (behindMatch) result.behind = Number(behindMatch[1]);
  }
  const ellipsis = body.indexOf('...');
  if (ellipsis !== -1) {
    result.branch = body.slice(0, ellipsis);
    result.upstream = body.slice(ellipsis + 3);
  } else {
    result.branch = body;
  }
  return result;
}

// Parses `git status --porcelain=v1 -z --branch` output. NUL-separated
// entries; renames/copies carry a second NUL-separated original path.
export function parseGitStatusPorcelain(stdout) {
  const entries = String(stdout || '').split('\0').filter((entry) => entry.length > 0);
  const summary = { branch: '', upstream: '', ahead: 0, behind: 0, detached: false, initial: false };
  const files = [];
  let index = 0;
  while (index < entries.length) {
    const entry = entries[index];
    index += 1;
    if (entry.startsWith('## ') || entry === '##') {
      Object.assign(summary, parseGitStatusBranchHeader(entry));
      continue;
    }
    if (entry.length < 4) continue;
    const indexStatus = entry[0];
    const worktreeStatus = entry[1];
    const rawPath = entry.slice(3);
    let origPath = '';
    if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
      origPath = normalizeGitPath(entries[index] || '');
      index += 1;
    }
    const untracked = indexStatus === '?' && worktreeStatus === '?';
    const deleted = indexStatus === 'D' || worktreeStatus === 'D';
    const statusCode = untracked
      ? 'U'
      : (worktreeStatus !== ' ' && worktreeStatus !== '?' ? worktreeStatus : indexStatus);
    files.push({
      path: normalizeGitPath(rawPath).replace(/\\/g, '/'),
      origPath: origPath ? origPath.replace(/\\/g, '/') : '',
      indexStatus,
      worktreeStatus,
      status: statusCode,
      untracked,
      deleted,
      renamed: indexStatus === 'R' || worktreeStatus === 'R',
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ...summary, files };
}

function isNotARepositoryError(error) {
  const text = `${error?.message || ''}\n${error?.stderr || ''}`.toLowerCase();
  return text.includes('not a git repository');
}

export function createGitChangesService({ execFileImpl = nodeExecFile } = {}) {
  function runGit(rootPath, args, { timeoutMs = GIT_COMMAND_TIMEOUT_MS, okExitCodes = [0] } = {}) {
    return new Promise((resolve, reject) => {
      execFileImpl('git', args, {
        cwd: rootPath,
        timeout: timeoutMs,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error && !okExitCodes.includes(Number(error.code))) {
          const failure = new Error(String(stderr || error.message || 'git command failed').trim());
          failure.stderr = String(stderr || '');
          failure.code = error.code;
          return reject(failure);
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
  }

  async function getStatus(rootPath) {
    try {
      const { stdout } = await runGit(rootPath, ['status', '--porcelain=v1', '-z', '--branch']);
      return { ok: true, isRepo: true, ...parseGitStatusPorcelain(stdout) };
    } catch (error) {
      if (isNotARepositoryError(error)) {
        return { ok: true, isRepo: false, branch: '', upstream: '', ahead: 0, behind: 0, files: [] };
      }
      return { ok: false, error: error?.message || 'Failed to read git status' };
    }
  }

  async function getDiff(rootPath, relativePath, { untracked = false } = {}) {
    const gitPath = String(relativePath || '').replace(/\\/g, '/');
    if (!gitPath) return { ok: false, error: 'Missing file path' };
    try {
      let patch = '';
      if (untracked) {
        // --no-index exits 1 when the files differ; that is the success case.
        const { stdout } = await runGit(
          rootPath,
          ['diff', '--no-index', `-U${FULL_CONTEXT_LINES}`, '--', '/dev/null', gitPath],
          { okExitCodes: [0, 1] },
        );
        patch = stdout;
      } else {
        const { stdout } = await runGit(
          rootPath,
          ['diff', 'HEAD', `-U${FULL_CONTEXT_LINES}`, '--', gitPath],
        );
        patch = stdout;
        if (!patch.trim()) {
          // Fall back for files that only differ in the index vs worktree edge
          // cases (e.g. intent-to-add) where `diff HEAD` came back empty.
          const fallback = await runGit(
            rootPath,
            ['diff', '--no-index', `-U${FULL_CONTEXT_LINES}`, '--', '/dev/null', gitPath],
            { okExitCodes: [0, 1] },
          );
          patch = fallback.stdout;
        }
      }
      return { ok: true, path: gitPath, patch };
    } catch (error) {
      if (isNotARepositoryError(error)) {
        return { ok: false, error: 'Not a git repository' };
      }
      return { ok: false, error: error?.message || 'Failed to read git diff' };
    }
  }

  async function pull(rootPath) {
    try {
      const { stdout, stderr } = await runGit(rootPath, ['pull'], { timeoutMs: GIT_PULL_TIMEOUT_MS });
      return { ok: true, output: `${stdout}${stderr}`.trim() };
    } catch (error) {
      return { ok: false, error: error?.message || 'git pull failed' };
    }
  }

  return { getStatus, getDiff, pull };
}
