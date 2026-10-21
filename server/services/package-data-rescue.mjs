/**
 * The preinstall's work (package-data-rescue-preinstall.mjs), on every
 * platform. Relays before 0.9.14 could run on the database and uploads
 * inside the package (Windows autostart, a plain `gh copilot`), and
 * `npm i -g` deletes the old package. While install scripts run, npm keeps
 * it as its retired folder (npmRetiredPath; a scan for npm-shaped names only
 * when that is missing): its database (-wal, -shm), Cursor stores, uploads
 * and config.json are copied, copy only, to
 * `<data folder>/rescued-package-data/<time>/` (written as `.partial`, then
 * renamed), and the relay takes them over at its next start. Any of them
 * makes the old package a source (its uploads beyond the README.md and
 * image_input.md it ships). Nothing to copy, or not an installed package:
 * nothing happens, nothing is printed. A failed copy throws
 * RescueCopyError: exit 1, npm puts the old package back. npm hides a successful script's output, hence the README.txt.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { RESCUE_DIR_NAME, copyMissing, isRetiredName } from './earlier-database-service.mjs';
import { resolveRelayStateDirs, resolveStateLayout } from './oar-state-layout.mjs';

const DB_FILES = ['copilot.db', 'copilot.db-wal', 'copilot.db-shm'];

// What a relay left in a package's server folder; a folder that cannot be
// read throws (no copy failure: nothing was detected yet).
function hasRelayData(fsImpl, serverDir) {
  const has = (...parts) => fsImpl.existsSync(path.join(serverDir, ...parts));
  const anyUpload = (...parts) => has(...parts) && fsImpl.readdirSync(path.join(serverDir, ...parts)).some((name) => /^[a-f0-9]{64}$/.test(name));
  return has('data', 'copilot.db') || has('data', 'cursor-agents') || has('config.json') || anyUpload('uploads') || anyUpload('data', 'uploads');
}

/** Where npm's reify moves a package it replaces (@npmcli/arborist retire-path.js). */
export function npmRetiredPath(packageDir) {
  const hash = crypto.createHash('sha1').update(packageDir).digest('base64').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8);
  return path.resolve(path.dirname(packageDir), `.${path.basename(packageDir)}-${hash}`);
}

/** A copy of an old database failed: the one error that stops the install. */
export class RescueCopyError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RescueCopyError';
    this.rescueCopyFailed = true;
  }
}

/**
 * Returns { status: 'not-installed' | 'nothing' | 'rescued', rescued: [{ from,
 * to }] }; throws a RescueCopyError, naming what to save, when a copy fails.
 */
export function rescuePackageData({
  packageRoot,
  env = process.env,
  platform = process.platform,
  now = () => new Date(),
  fsImpl = fs,
  logger = console,
} = {}) {
  const resolvedRoot = path.resolve(String(packageRoot || ''));
  const scope = path.dirname(resolvedRoot);
  if (path.basename(scope) !== '@oar-sh' || path.basename(path.dirname(scope)) !== 'node_modules') {
    return { status: 'not-installed', rescued: [] };
  }
  // Detection: npm's retired name, else a scan for npm-shaped names (a path
  // in another case hashes differently). Failing here is no copy failure.
  let sources;
  try {
    const exact = npmRetiredPath(resolvedRoot);
    const retired = fsImpl.existsSync(exact)
      ? [exact]
      : fsImpl.readdirSync(scope).filter((name) => isRetiredName(name, path.basename(resolvedRoot))).map((name) => path.join(scope, name));
    sources = retired.filter((dir) => hasRelayData(fsImpl, path.join(dir, 'server')));
  } catch (error) {
    throw new Error(`Could not look for the data of the version being replaced: ${error?.message || error}`, { cause: error });
  }
  if (!sources.length) return { status: 'nothing', rescued: [] };

  // Old data is there: any failure from here stops the install.
  const exists = (file) => fsImpl.existsSync(file);
  const kept = path.join(resolvedRoot, 'server');
  const copyFailed = (from, to, error) => new RescueCopyError(
    `Could not copy the data of the version being replaced (${from}) to ${to}: ${error?.message || error}. `
    + `The update stops and the version installed stays as it is; copy ${path.join(kept, 'data')} and ${path.join(kept, 'uploads')} somewhere safe by hand, then update again.`,
    { cause: error },
  );
  let rescueRoot;
  try {
    const layout = resolveStateLayout({ packageRoot: resolvedRoot, env, platform });
    rescueRoot = path.join(resolveRelayStateDirs({ packageRoot: resolvedRoot, env, platform, layout }).dataDir, RESCUE_DIR_NAME);
  } catch (error) {
    throw copyFailed(path.join(sources[0], 'server'), 'the OAR data folder', error);
  }
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const rescued = [];
  for (const [index, source] of sources.entries()) {
    const serverDir = path.join(source, 'server');
    let target = path.join(rescueRoot, sources.length > 1 ? `${stamp}-${index}` : stamp);
    // Written under a .partial name and renamed when complete: a half copy
    // is never taken for a rescue.
    try {
      for (let n = 1; exists(target) || exists(`${target}.partial`); n += 1) target = `${path.join(rescueRoot, stamp)}-${n}`;
      const partial = `${target}.partial`;
      fsImpl.mkdirSync(rescueRoot, { recursive: true });
      fsImpl.mkdirSync(partial);
      fsImpl.mkdirSync(path.join(partial, 'data'));
      for (const name of DB_FILES) {
        const from = path.join(serverDir, 'data', name);
        if (exists(from)) fsImpl.copyFileSync(from, path.join(partial, 'data', name), fs.constants.COPYFILE_EXCL);
      }
      if (exists(path.join(serverDir, 'data', 'cursor-agents'))) {
        copyMissing(fsImpl, path.join(serverDir, 'data', 'cursor-agents'), path.join(partial, 'data', 'cursor-agents'));
      }
      // Uploads of server/uploads and server/data/uploads, content-addressed.
      for (const uploads of [path.join(serverDir, 'uploads'), path.join(serverDir, 'data', 'uploads')]) {
        if (exists(uploads)) copyMissing(fsImpl, uploads, path.join(partial, 'uploads'));
      }
      if (exists(path.join(serverDir, 'config.json'))) {
        fsImpl.copyFileSync(path.join(serverDir, 'config.json'), path.join(partial, 'config.json'), fs.constants.COPYFILE_EXCL);
      }
      fsImpl.writeFileSync(path.join(partial, 'README.txt'), [
        `Copied by the @oar-sh/oar update on ${now().toISOString()} from`,
        `${serverDir}`,
        'before npm deleted the version it replaced. The relay takes the',
        'database in data\\ over at its next start if it is newer than the',
        'one it has. Nothing here is deleted by OAR.',
        '',
      ].join('\r\n'));
      fsImpl.renameSync(partial, target);
    } catch (error) {
      throw copyFailed(serverDir, target, error);
    }
    rescued.push({ from: serverDir, to: target });
    logger.log?.(`[oar] Copied the data of the version being replaced from ${serverDir} to ${target}; the relay takes it over at its next start.`);
  }
  return { status: 'rescued', rescued };
}
