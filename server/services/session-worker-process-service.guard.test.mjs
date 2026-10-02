import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The relay reads the Windows process list through PowerShell; done
// synchronously that holds the relay's only thread for 0.5-1.5 s idle and
// for seconds under load (2026-10-01: 502s for a whole Windows relay). Every
// relay path uses the asynchronous finders; the synchronous ones stay for the
// legacy extension launcher only, which goes with the extension.

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set([
  path.join('services', 'session-worker-process-service.mjs'),
  path.join('services', 'relay-cli-launcher-service.mjs'),
]);
const SYNC_FINDER = /\.(findProcessForSession|findProcessesForSession|findWindowsProcessForSession|findWindowsProcessesForSession|findWindowsProcessTreeForSession|getWindowsProcessSnapshot|getPosixProcessSnapshot|stopWindowsPids)\b(?!Async)/;
const SYNC_POWERSHELL = /execFileSync\w*\(\s*['"]powershell(\.exe)?['"]/;

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'public' || entry.name === 'logs' || entry.name === 'data') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(mjs|js)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) yield full;
  }
}

test('no relay module reads the process list synchronously, apart from the inspector and the legacy launcher', () => {
  const offenders = [];
  for (const file of sourceFiles(serverDir)) {
    const relative = path.relative(serverDir, file);
    if (ALLOWED.has(relative)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (SYNC_FINDER.test(line) || SYNC_POWERSHELL.test(line)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});
