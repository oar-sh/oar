import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { RELAY_STOP_EXIT_CODE } from '../relay-exit-codes.mjs';

/**
 * Where the relay's database (and lock) live, decided before anything else
 * touches disk.
 *
 * Precedence: the COPILOT_WEB_RELAY_DATA_DIR env var, then a `dataDir` key in
 * config.json, then the server directory's own `data/`. Every launcher of a
 * global install pins the env var (`oar start`, `oar copilot`, the systemd
 * unit, both Windows autostart launchers; see resolveRelayStateDirs in
 * oar-state-layout.mjs), and so does the e2e harness. Nothing writes the
 * config key: it is for a hand-edited config, so a dev checkout can point at
 * a release install's data dir (the singleton guard's lock lives inside the
 * data dir, so two relays sharing one refuse to run concurrently).
 *
 * A relative `dataDir` resolves against the config file's directory, not the
 * process cwd — the same config must mean the same data dir no matter where
 * the server was launched from.
 */
export function resolveDataDir({
  env = process.env,
  configPath,
  serverDir,
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  const fromEnv = String(env?.COPILOT_WEB_RELAY_DATA_DIR || '').trim();
  if (fromEnv) return pathImpl.resolve(fromEnv);
  return readConfiguredDataDir({ configPath, fsImpl, pathImpl }) || pathImpl.join(String(serverDir || ''), 'data');
}

/**
 * The `dataDir` config.json names, resolved against the config's folder; ''
 * when it names none. An unreadable, absent or invalid config names none: the
 * runtime reports config problems itself when it loads the file.
 */
export function readConfiguredDataDir({ configPath, fsImpl = fs, pathImpl = path } = {}) {
  const resolvedConfigPath = String(configPath || '').trim();
  if (!resolvedConfigPath) return '';
  let parsed = null;
  try { parsed = JSON.parse(fsImpl.readFileSync(resolvedConfigPath, 'utf8')); } catch {}
  const fromConfig = String(parsed?.dataDir || '').trim();
  return fromConfig ? pathImpl.resolve(pathImpl.dirname(resolvedConfigPath), fromConfig) : '';
}

/**
 * Where uploads live, given the data dir resolveDataDir chose: `uploads/`
 * inside it whenever the env var or config.json picked it, so `dataDir` moves
 * database and uploads together. Only the plain default keeps the checkout
 * layout, `<server>/uploads` beside `<server>/data`. Uploads earlier versions
 * left elsewhere are still read (resolveUploadReadDirs).
 */
export function resolveUploadDir({
  dataDir,
  env = process.env,
  serverDir,
  pathImpl = path,
  platform = process.platform,
} = {}) {
  const pinned = String(env?.COPILOT_WEB_RELAY_DATA_DIR || '').trim();
  const normalize = (value) => {
    const resolved = pathImpl.resolve(String(value || ''));
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  if (!pinned && normalize(dataDir) === normalize(pathImpl.join(String(serverDir || ''), 'data'))) {
    return pathImpl.join(String(serverDir || ''), 'uploads');
  }
  return pathImpl.join(String(dataDir || ''), 'uploads');
}

/**
 * Creates the data and upload folders at startup. One that cannot be created
 * (its drive is missing: a RAM disk or a drive a startup script mounts later
 * than the autostart launcher waited; a file in its place; no permission)
 * ends this runtime with a line naming it and RELAY_STOP_EXIT_CODE instead
 * of an uncaught error: the supervisors do not retry that code, so the line
 * is said once, and the code goes on to whatever started the relay. No
 * other folder is tried: the data must never go elsewhere unnoticed. False
 * when it called `exit`.
 */
export function ensureDataDirs({
  dataDir,
  uploadDir,
  fsImpl = fs,
  logger = console,
  exit = (code) => process.exit(code),
} = {}) {
  const fail = (line) => {
    logger.error(`[startup] ${line}. Exiting with code ${RELAY_STOP_EXIT_CODE}.`);
    exit(RELAY_STOP_EXIT_CODE);
    return false;
  };
  for (const [dir, options] of [[dataDir, { recursive: true, mode: 0o700 }], [uploadDir, { recursive: true }]]) {
    try {
      let stat = null;
      try {
        stat = fsImpl.statSync(dir);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (stat && !stat.isDirectory()) return fail(`${dir} is a file, not a folder`);
      if (!stat) fsImpl.mkdirSync(dir, options);
    } catch (error) {
      if (error?.code === 'ENOTDIR') return fail(`Cannot create ${dir}: it or a folder above it is a file, not a folder`);
      const reason = error?.code === 'ENOENT' ? 'its drive or a folder above it is missing' : (error?.message || String(error));
      return fail(`Cannot create ${dir}: ${reason}`);
    }
  }
  return true;
}

/**
 * The folders uploads are read from, the upload dir first. Earlier versions
 * left uploads in two other places, and both stay folders to read from so no
 * upload drops out of sight after an update: `<server>/uploads` (before 0.9.14
 * a config `dataDir` did not move uploads) and `uploads/` in the folder that
 * holds the data dir (where state migrations before 0.9.14 copied a
 * checkout's uploads). Nothing is copied, moved or deleted there; new uploads
 * go to the upload dir only.
 */
export function resolveUploadReadDirs({
  uploadDir,
  dataDir,
  serverDir,
  pathImpl = path,
  platform = process.platform,
} = {}) {
  const normalize = (value) => {
    const resolved = pathImpl.resolve(String(value || ''));
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const dirs = [];
  const add = (dir) => {
    if (!String(dir || '').trim()) return;
    if (dirs.some((known) => normalize(known) === normalize(dir))) return;
    dirs.push(pathImpl.resolve(dir));
  };
  add(uploadDir);
  if (String(serverDir || '').trim()) add(pathImpl.join(String(serverDir), 'uploads'));
  if (String(dataDir || '').trim()) add(pathImpl.join(pathImpl.dirname(pathImpl.resolve(String(dataDir))), 'uploads'));
  return dirs;
}

const SHA256_NAME = /^[a-f0-9]{64}$/;
const SAMPLE_BYTES = 64 * 1024;
const MAX_REMEMBERED_CHOICES = 10_000;
// Which of several same-size copies to read, per sha256, with the stat of
// every copy it was decided on: decided once, again only when a copy changed.
const rememberedChoices = new Map();

/**
 * Every existing copy of an upload blob in the read dirs, upload dir first.
 * Only a sha256 name is looked up: nothing else in those folders is a blob.
 */
export function existingUploadPaths(dirs, sha256, { fsImpl = fs, pathImpl = path } = {}) {
  const name = String(sha256 || '').trim().toLowerCase();
  if (!SHA256_NAME.test(name)) return [];
  const found = [];
  for (const dir of dirs || []) {
    const candidate = pathImpl.join(dir, name);
    try {
      const stat = fsImpl.statSync(candidate);
      if (stat.isFile()) found.push({ path: candidate, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  return found;
}

// The first and last bytes of a file: copies that share them are taken as the
// same file without reading them whole.
function sampleOf(filePath, size, fsImpl) {
  let fd = null;
  try {
    fd = fsImpl.openSync(filePath, 'r');
    const head = Buffer.alloc(Math.min(SAMPLE_BYTES, size));
    fsImpl.readSync(fd, head, 0, head.length, 0);
    const tailLength = Math.min(SAMPLE_BYTES, Math.max(0, size - head.length));
    const tail = Buffer.alloc(tailLength);
    if (tailLength) fsImpl.readSync(fd, tail, 0, tailLength, size - tailLength);
    return Buffer.concat([head, tail]);
  } catch {
    return null;
  } finally {
    if (fd !== null) try { fsImpl.closeSync(fd); } catch {}
  }
}

function contentMatches(filePath, sha256, fsImpl) {
  try {
    return crypto.createHash('sha256').update(fsImpl.readFileSync(filePath)).digest('hex') === sha256;
  } catch {
    return false;
  }
}

function chooseAmongSameSize(copies, sha256, fsImpl) {
  const signature = copies.map((copy) => `${copy.path}|${copy.size}|${copy.mtimeMs}`).join('\n');
  const remembered = rememberedChoices.get(sha256);
  if (remembered && remembered.signature === signature) return remembered.path;
  let chosen = copies[0].path;
  const first = sampleOf(copies[0].path, copies[0].size, fsImpl);
  const alike = first && copies.slice(1).every((copy) => {
    const sample = sampleOf(copy.path, copy.size, fsImpl);
    return sample && sample.equals(first);
  });
  if (!alike) {
    const verified = copies.find((copy) => contentMatches(copy.path, sha256, fsImpl));
    if (verified) chosen = verified.path;
  }
  if (rememberedChoices.size >= MAX_REMEMBERED_CHOICES) rememberedChoices.delete(rememberedChoices.keys().next().value);
  rememberedChoices.set(sha256, { signature, path: chosen });
  return chosen;
}

/**
 * The path an upload is read from. Blobs are named by the sha256 of their
 * content, so copies in two folders are normally the same file. Should they
 * differ, the copy of the recorded size wins (`expectedSize`); if more than
 * one has that size and they are not alike, the one whose content hashes to
 * its name (decided once per blob until a copy changes). No copy is ever
 * touched. Without any copy: its place in the upload dir, where a new upload
 * is written.
 */
export function uploadPathInDirs(dirs, sha256, { expectedSize = null, fsImpl = fs, pathImpl = path } = {}) {
  const name = String(sha256 || '').trim().toLowerCase();
  const copies = existingUploadPaths(dirs, name, { fsImpl, pathImpl });
  if (!copies.length) return pathImpl.join(dirs[0], name);
  const size = Number(expectedSize);
  const sized = Number.isFinite(size) && size > 0 ? copies.filter((copy) => copy.size === size) : [];
  if (sized.length > 1) return chooseAmongSameSize(sized, name, fsImpl);
  return (sized[0] || copies[0]).path;
}
