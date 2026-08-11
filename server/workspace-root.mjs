import fs from 'fs';
import path from 'path';

import { normalizeDriveLetterOnlyPath } from './services/workspace-root-path-policy.mjs';

// Mirrors workspace-root-path-policy.mjs: the platform is a parameter, never an
// implicit read of the host, so win32 `cd` semantics stay testable off Windows.
function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function isDirectory(targetPath) {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

export function resolveWorkspaceRootPath(preferredRoot, fallbackRoot) {
  const candidates = [preferredRoot, fallbackRoot];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    const resolved = path.resolve(value);
    if (isDirectory(resolved)) return resolved;
  }
  return path.resolve(String(fallbackRoot || process.cwd()).trim() || process.cwd());
}

export function resolveRepositoryWorkspaceRoot(preferredRoot, scriptDir) {
  const repoRoot = path.resolve(String(scriptDir || '').trim() || process.cwd(), '..');
  return resolveWorkspaceRootPath(preferredRoot, repoRoot);
}

export function resolveStartupWorkspaceRoot(scriptDir, preferredRoot = process.env.COPILOT_WORKSPACE_ROOT || process.cwd()) {
  return resolveRepositoryWorkspaceRoot(preferredRoot, scriptDir);
}

export function workspaceRootDisplayName(rootPath) {
  const resolved = path.resolve(String(rootPath || '').trim() || process.cwd());
  const base = path.basename(resolved);
  if (base) return base;
  const driveRoot = path.parse(resolved).root;
  return driveRoot || 'workspace';
}

export function parseCdCommandTarget(text) {
  const source = String(text || '').trim();
  if (!source || source.includes('\n') || source.includes('\r')) return null;

  const match = /^cd(?:\s+\/d)?(?:\s+(.+))?$/i.exec(source);
  if (!match) return null;

  let target = String(match[1] || '').trim();
  if (!target) return null;

  if (
    (target.startsWith('"') && target.endsWith('"'))
    || (target.startsWith("'") && target.endsWith("'"))
  ) {
    target = target.slice(1, -1).trim();
  }
  if (!target) return null;
  if (/[;&|]/.test(target)) return null;
  return target;
}

export function resolveCdCommandPath(
  targetPath,
  currentRoot,
  homeDir = process.env.USERPROFILE || process.env.HOME || process.cwd(),
  platform = process.platform,
) {
  const pathApi = pathFor(platform);
  let candidate = normalizeDriveLetterOnlyPath(targetPath);
  if (!candidate) return null;

  if (candidate === '~') {
    candidate = homeDir;
  } else if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    candidate = pathApi.join(homeDir, candidate.slice(2));
  }

  const baseRoot = pathApi.resolve(String(currentRoot || process.cwd()).trim() || process.cwd());
  return pathApi.resolve(baseRoot, candidate);
}
