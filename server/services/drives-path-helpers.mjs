import path from 'node:path';

import { normalizeDriveLetterOnlyPath } from './workspace-root-path-policy.mjs';

// ---------------------------------------------------------------------------
// Windows drive path helpers
// ---------------------------------------------------------------------------

export function normalizeDriveAbsolutePath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '';
  }
  const withoutNulls = decoded.replace(/\0/g, '');
  let normalized = withoutNulls
    .replace(/\//g, '\\')
    .replace(/\\+/g, '\\')
    .trim();
  if (!normalized) return '';
  normalized = normalizeDriveLetterOnlyPath(normalized);
  if (!/^[A-Za-z]:\\/.test(normalized)) return '';
  normalized = path.win32.normalize(normalized);
  if (!/^[A-Za-z]:\\/.test(normalized)) return '';
  const drive = `${normalized.slice(0, 1).toUpperCase()}:`;
  const rest = normalized.slice(3).replace(/^\\+/, '');
  return rest ? `${drive}\\${rest}` : `${drive}\\`;
}

export function driveRootFromAbsolutePath(absolutePath) {
  const normalized = normalizeDriveAbsolutePath(absolutePath);
  if (!normalized) return '';
  return `${normalized.slice(0, 1).toUpperCase()}:\\`;
}

export function toDriveWebPath(absolutePath) {
  const normalized = normalizeDriveAbsolutePath(absolutePath);
  if (!normalized) return '';
  const drive = `${normalized.slice(0, 1).toUpperCase()}:`;
  const rest = normalized.slice(3).replace(/\\/g, '/');
  return rest ? `${drive}/${rest}` : drive;
}

// ---------------------------------------------------------------------------
// Linux absolute path helper
// ---------------------------------------------------------------------------

export function normalizeLinuxAbsolutePath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '';
  }
  const withoutNulls = decoded.replace(/\0/g, '');
  // path.posix.normalize resolves any '..' segments; we only need to ensure
  // the result is absolute (i.e. still under '/').
  const normalized = path.posix.normalize(withoutNulls.replace(/\\/g, '/'));
  if (!normalized.startsWith('/')) return '';
  return normalized;
}
