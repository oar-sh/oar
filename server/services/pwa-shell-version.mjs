// The installed app's shell version (`__PWA_VERSION` in the served
// index.html): the newest modification time among the files the service
// worker caches as the shell, so a deploy that changes one of them gives the
// app a new version and it reloads its shell.

import fs from 'node:fs';
import path from 'node:path';

/** Whether a file under the public folder (its relative path) is part of the shell. */
export function shouldIncludeInPwaVersion(relativePath) {
  if (!relativePath) return false;
  const normalized = String(relativePath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.startsWith('.')) return false;
  if (normalized === 'index.html' || normalized === 'sw.js' || normalized === 'manifest.webmanifest') return true;
  if (/^app-icon(?:-light)?(?:-maskable)?(?:-\d+)?\.(?:png|svg)$/i.test(normalized)) return true;
  if (/^favicon\.ico$/i.test(normalized)) return true;
  if (normalized.startsWith('app/')) {
    const ext = path.extname(normalized).toLowerCase();
    return ext === '.js' || ext === '.mjs' || ext === '.css' || ext === '.html';
  }
  return false;
}

/** Epoch ms → `YYYY-MM-DD-HH-MM-SSZ` (UTC), or '0' for an invalid time. */
export function formatPwaVersionTimestamp(valueMs) {
  const date = new Date(valueMs);
  if (!Number.isFinite(date.getTime())) return '0';
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}-${hh}-${min}-${ss}Z`;
}

/**
 * The shell version of the public folder `publicDir`: its shell files'
 * newest modification time, or now when none could be read.
 */
export function computePwaShellVersion(publicDir, { now = () => Date.now() } = {}) {
  let maxMtimeMs = 0;
  const stack = [publicDir];
  while (stack.length) {
    const dirPath = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(publicDir, absolutePath);
      if (!shouldIncludeInPwaVersion(relativePath)) continue;
      try {
        const stats = fs.statSync(absolutePath);
        if (Number.isFinite(stats.mtimeMs) && stats.mtimeMs > maxMtimeMs) {
          maxMtimeMs = stats.mtimeMs;
        }
      } catch {}
    }
  }
  const sourceMs = Number.isFinite(maxMtimeMs) && maxMtimeMs > 0 ? maxMtimeMs : now();
  return formatPwaVersionTimestamp(sourceMs);
}
