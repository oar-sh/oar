import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveOarRoot } from './oar-state-root.mjs';

/**
 * Where the agent SDKs the relay installs on demand live, and which folder
 * holds a usable copy. Synchronous, without a database and without imports
 * of the relay's own services: the relay's lock check (koffi on Windows) and
 * a worker's loader read this before anything else runs. The installing half
 * is agent-sdk-store.mjs.
 *
 *   <root>/<sdk>/<version>-<hash8>/          one folder per SDK, version and platform
 *     oar-sdk.json                            the marker, written last
 *   <root>/<sdk>/.leases/<folder>/<pid>-*.json  who uses a folder (agent-sdk-store.mjs)
 *   <root>/<sdk>/.store.lock                 held while one process installs or deletes
 *
 * <root> is <state root>/sdks, or OAR_SDK_DIR. <hash8> covers the pins
 * folder's files (package.json, lockfile, entries) and the platform, so a
 * changed entry file or a root shared by Windows and WSL never reuses a
 * folder made for something else.
 */

export const AGENT_SDK_PINS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent-sdks');
export const AGENT_SDK_MARKER = 'oar-sdk.json';
export const AGENT_SDK_LEASES_DIR = '.leases';
// Bumped when the folder layout or the marker changes meaning.
export const AGENT_SDK_STORE_FORMAT = 1;

/** What each pins folder installs, and which file a loader imports. */
export const AGENT_SDK_DESCRIPTORS = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Agent SDK',
    packageName: '@anthropic-ai/claude-agent-sdk',
    entries: Object.freeze({ main: 'entry.mjs' }),
    platformScope: '@anthropic-ai/claude-agent-sdk-',
    // Platforms without a vendor build where the SDK runs the host's own
    // Claude Code CLI instead (CLAUDE_CODE_EXECUTABLE). None is verified
    // yet; native Termux (android) would be the candidate.
    hostCliPlatforms: Object.freeze([]),
    platforms: null,
  }),
  cursor: Object.freeze({
    id: 'cursor',
    label: 'Cursor SDK',
    packageName: '@cursor/sdk',
    entries: Object.freeze({ main: 'entry.mjs', sqlite: 'entry-sqlite.mjs' }),
    platformScope: '@cursor/sdk-',
    platforms: null,
  }),
  koffi: Object.freeze({
    id: 'koffi',
    label: 'Windows helper (koffi)',
    packageName: 'koffi',
    entries: Object.freeze({ main: 'entry.cjs' }),
    platformScope: '@koromix/koffi-',
    // The relay needs it only for its lock check on Windows.
    platforms: Object.freeze(['win32']),
  }),
});

export const AGENT_SDK_IDS = Object.freeze(Object.keys(AGENT_SDK_DESCRIPTORS));

export function getAgentSdkDescriptor(id) {
  const key = String(id || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(AGENT_SDK_DESCRIPTORS, key) ? AGENT_SDK_DESCRIPTORS[key] : null;
}

/** `<state root>/sdks`, or OAR_SDK_DIR; always absolute. */
export function resolveAgentSdkRoot({ env = process.env, platform = process.platform } = {}) {
  const override = String(env?.OAR_SDK_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join(resolveOarRoot(env, platform), 'sdks');
}

/** Linux's C library as npm tells it, 'glibc' or 'musl'; null elsewhere. */
export function detectLibc({ platform = process.platform, report = () => process.report?.getReport?.() } = {}) {
  if (platform !== 'linux') return null;
  try {
    return report()?.header?.glibcVersionRuntime ? 'glibc' : 'musl';
  } catch {
    return null;
  }
}

export function hostPlatform({ platform = process.platform, arch = process.arch, libc } = {}) {
  return { platform, arch, libc: libc === undefined ? detectLibc({ platform }) : libc };
}

const pinCache = new Map();

/**
 * The pin of an SDK for this host: the pins folder's files as read once
 * (an `oar update` replaces them under a running relay, which goes on
 * installing what it was started with), the pinned version and the folder
 * name, `<version>-<first 8 hex of the content hash>`.
 */
export function readAgentSdkPin(id, { pinsDir = AGENT_SDK_PINS_DIR, fsImpl = fs, host = hostPlatform() } = {}) {
  const descriptor = getAgentSdkDescriptor(id);
  if (!descriptor) return null;
  const folder = path.join(pinsDir, descriptor.id);
  const cacheKey = JSON.stringify([folder, host.platform, host.arch, host.libc]);
  if (fsImpl === fs && pinCache.has(cacheKey)) return pinCache.get(cacheKey);
  const names = ['package.json', 'package-lock.json', ...Object.values(descriptor.entries)].sort();
  const files = {};
  const hash = crypto.createHash('sha256').update(`oar-sdk-store:${AGENT_SDK_STORE_FORMAT}\0${host.platform}\0${host.arch}\0${host.libc || ''}\0`);
  for (const name of names) {
    files[name] = fsImpl.readFileSync(path.join(folder, name));
    hash.update(`${name}\0`).update(files[name]).update('\0');
  }
  const packageJson = JSON.parse(files['package.json'].toString('utf8'));
  const version = String(packageJson.dependencies?.[descriptor.packageName] || '');
  const fullHash = hash.digest('hex');
  const pin = Object.freeze({
    id: descriptor.id,
    version,
    hash: fullHash,
    dirName: `${version}-${fullHash.slice(0, 8)}`,
    host: Object.freeze({ ...host }),
    files: Object.freeze(files),
    lock: JSON.parse(files['package-lock.json'].toString('utf8')),
  });
  if (fsImpl === fs) pinCache.set(cacheKey, pin);
  return pin;
}

function matchesList(list, value) {
  if (!Array.isArray(list) || !list.length) return true;
  if (list.includes(`!${value}`)) return false;
  const allowed = list.filter((item) => !String(item).startsWith('!'));
  return !allowed.length || allowed.includes(value);
}

/**
 * The vendor's platform package this host gets from the pinned lockfile, or
 * null when the vendor lists none for it. Matches os, cpu and libc as npm
 * does.
 */
export function platformPackageFor(pin) {
  const descriptor = getAgentSdkDescriptor(pin?.id);
  if (!descriptor || !pin?.lock?.packages) return null;
  const { platform, arch, libc } = pin.host;
  for (const [key, entry] of Object.entries(pin.lock.packages)) {
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!name.startsWith(descriptor.platformScope) || !entry?.os) continue;
    if (!matchesList(entry.os, platform) || !matchesList(entry.cpu, arch)) continue;
    if (entry.libc && libc && !matchesList(entry.libc, libc)) continue;
    return name;
  }
  return null;
}

/**
 * Whether this host can run the SDK at all, from the descriptor and the
 * lockfile alone: 'yes' (a vendor build for it), 'cli' (none, but the
 * descriptor lets the host's own CLI do the work there) or 'no' ("not
 * available on this platform", never retried).
 */
export function agentSdkSupport(pin, { hostCliPlatforms } = {}) {
  const descriptor = getAgentSdkDescriptor(pin?.id);
  if (!descriptor) return 'no';
  if (descriptor.platforms && !descriptor.platforms.includes(pin.host.platform)) return 'no';
  if (platformPackageFor(pin)) return 'yes';
  return (hostCliPlatforms ?? descriptor.hostCliPlatforms ?? []).includes(pin.host.platform) ? 'cli' : 'no';
}

/**
 * The files an install is checked by, relative to its folder: the entries,
 * each pinned package's package.json and the platform package's, the SDK's
 * own main module. A file an antivirus took, or a half-deleted tree, changes
 * one of them.
 */
export function agentSdkCheckedFiles(pin) {
  const descriptor = getAgentSdkDescriptor(pin?.id);
  const files = [...Object.values(descriptor.entries)];
  const packageJson = JSON.parse(pin.files['package.json'].toString('utf8'));
  for (const name of Object.keys(packageJson.dependencies || {})) files.push(`node_modules/${name}/package.json`);
  const platformPackage = platformPackageFor(pin);
  if (platformPackage) files.push(`node_modules/${platformPackage}/package.json`);
  return files;
}

/** The marker of an installed folder, or null. */
export function readAgentSdkMarker(dir, { fsImpl = fs } = {}) {
  try {
    const marker = JSON.parse(fsImpl.readFileSync(path.join(dir, AGENT_SDK_MARKER), 'utf8'));
    return marker && typeof marker === 'object' && !Array.isArray(marker) ? marker : null;
  } catch {
    return null;
  }
}

function sizesMatch(dir, files, fsImpl) {
  if (!files || typeof files !== 'object' || !Object.keys(files).length) return false;
  try {
    for (const [rel, size] of Object.entries(files)) {
      const stat = fsImpl.statSync(path.join(dir, ...rel.split('/')));
      if (!stat.isFile() || stat.size !== size) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `dir` holds a finished install made for this host: its marker
 * names the SDK, the store format and the platform, and every file it
 * recorded is there at its size. With `pin`, also the pinned version and
 * content hash.
 */
export function isValidAgentSdkInstall(dir, { id, pin = null, host = pin?.host || hostPlatform(), fsImpl = fs } = {}) {
  const marker = readAgentSdkMarker(dir, { fsImpl });
  if (!marker || marker.format !== AGENT_SDK_STORE_FORMAT || marker.id !== (pin?.id || id)) return false;
  if (marker.platform !== host.platform || marker.arch !== host.arch || (marker.libc || null) !== (host.libc || null)) return false;
  if (pin && (marker.version !== pin.version || marker.hash !== pin.hash || path.basename(dir) !== pin.dirName)) return false;
  return sizesMatch(dir, marker.files, fsImpl);
}

const FOLDER_NAME = /^\d[\w.+-]*-[0-9a-f]{8}$/;

/**
 * The pinned folder of an SDK when it holds a finished install, else null.
 * With `anyVersion`, otherwise the newest valid folder of an earlier pin
 * (koffi: any version reads a process's start time).
 */
export function findReadyAgentSdkDir(id, {
  env = process.env,
  platform = process.platform,
  root = resolveAgentSdkRoot({ env, platform }),
  pinsDir = AGENT_SDK_PINS_DIR,
  host = hostPlatform({ platform }),
  anyVersion = false,
  fsImpl = fs,
} = {}) {
  try {
    const pin = readAgentSdkPin(id, { pinsDir, fsImpl, host });
    if (!pin) return null;
    const pinned = path.join(root, pin.id, pin.dirName);
    if (isValidAgentSdkInstall(pinned, { pin, fsImpl })) return pinned;
    if (!anyVersion) return null;
    let best = null;
    for (const name of fsImpl.readdirSync(path.join(root, pin.id))) {
      if (!FOLDER_NAME.test(name)) continue;
      const dir = path.join(root, pin.id, name);
      if (!isValidAgentSdkInstall(dir, { id: pin.id, host, fsImpl })) continue;
      const at = Date.parse(readAgentSdkMarker(dir, { fsImpl })?.installedAt || '') || 0;
      if (!best || at > best.at) best = { dir, at };
    }
    return best?.dir || null;
  } catch {
    return null;
  }
}

export const AGENT_SDK_PACKAGE_ROOT = path.resolve(AGENT_SDK_PINS_DIR, '..', '..');

/**
 * Whether this process takes the SDKs from the package's own node_modules:
 * a git checkout has them as devDependencies at the pinned versions.
 * OAR_AGENT_SDK_SOURCE=store makes a checkout use the store like an install
 * does.
 */
export function agentSdksFromCheckout({ env = process.env, packageRoot = AGENT_SDK_PACKAGE_ROOT, fsImpl = fs } = {}) {
  if (String(env?.OAR_AGENT_SDK_SOURCE || '').trim().toLowerCase() === 'store') return false;
  try { return fsImpl.existsSync(path.join(packageRoot, '.git')); } catch { return false; }
}

/**
 * Whether this process takes one SDK from the checkout: a checkout (above)
 * whose node_modules really holds the package. One installed without its
 * devDependencies (`npm install --omit=dev`) takes it from the store.
 */
export function agentSdkFromCheckout(id, { env = process.env, packageRoot = AGENT_SDK_PACKAGE_ROOT, fsImpl = fs } = {}) {
  const descriptor = getAgentSdkDescriptor(id);
  if (!descriptor || !agentSdksFromCheckout({ env, packageRoot, fsImpl })) return false;
  try {
    return fsImpl.existsSync(path.join(packageRoot, 'node_modules', ...descriptor.packageName.split('/'), 'package.json'));
  } catch {
    return false;
  }
}

export function isAgentSdkFolderName(name) {
  return FOLDER_NAME.test(String(name || ''));
}

/**
 * Records that process `pid` uses the folder `dir`, so no store's clean-up
 * deletes it while the process runs (agent-sdk-store.mjs judges the
 * leases). `holder` is the process's identity as the relay lock records it.
 * Returns the lease file, or null when it could not be written.
 */
export function writeAgentSdkLease(dir, { pid = process.pid, holder = null, bootId = '', now = () => new Date(), fsImpl = fs } = {}) {
  try {
    const leasesDir = path.join(path.dirname(dir), AGENT_SDK_LEASES_DIR, path.basename(dir));
    fsImpl.mkdirSync(leasesDir, { recursive: true });
    const file = path.join(leasesDir, `${pid}-${crypto.randomBytes(3).toString('hex')}.json`);
    fsImpl.writeFileSync(file, `${JSON.stringify({ format: 2, pid, holder, ...(bootId ? { bootId } : {}), startedAt: now().toISOString() })}\n`, { flag: 'wx' });
    return file;
  } catch {
    return null;
  }
}
