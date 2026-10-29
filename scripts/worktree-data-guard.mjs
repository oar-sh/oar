// What a test run must never leave in the checkout it runs from: a database
// file in server/data (a script that opened one by hand-built path) or a
// backup in server/backups (a relay started from the checkout on a seeded
// database without a temp backup folder). New names only, and not those a
// live relay on this checkout makes: the -wal/-shm of a database that was
// there already, and the backups its own manifest (server/data/db-backups.json)
// lists. A file that was there and changed is not looked at.

import fs from 'node:fs';
import path from 'node:path';

const list = (dir, keep = () => true) => {
  try { return fs.readdirSync(dir).filter(keep).sort(); } catch { return []; }
};

function manifestFiles(repoRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server', 'data', 'db-backups.json'), 'utf8'));
    return (manifest.backups || []).map((entry) => String(entry.file || ''))
      .concat((Array.isArray(manifest.pending) ? manifest.pending : []).map((entry) => String(entry.file || '')));
  } catch {
    return [];
  }
}

export function snapshotWorktreeData(repoRoot) {
  return {
    data: list(path.join(repoRoot, 'server', 'data'), (name) => /^(oar|copilot)\.db/.test(name)),
    backups: list(path.join(repoRoot, 'server', 'backups')),
    relayBackups: manifestFiles(repoRoot),
  };
}

/** The names that appeared since `before`, as repo-relative paths. */
export function worktreeDataChanges(before, after) {
  const sideOfKnown = (name) => {
    const main = name.replace(/-(wal|shm|journal)$/, '');
    return main !== name && before.data.includes(main);
  };
  const relayBackups = new Set([...before.relayBackups, ...(after.relayBackups || [])]);
  return [
    ...after.data.filter((name) => !before.data.includes(name) && !sideOfKnown(name)).map((name) => `server/data/${name}`),
    ...after.backups.filter((name) => !before.backups.includes(name) && !relayBackups.has(name)).map((name) => `server/backups/${name}`),
  ];
}
