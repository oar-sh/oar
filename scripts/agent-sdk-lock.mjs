#!/usr/bin/env node
// Writes the lockfile of each pins folder in server/agent-sdks/ (the agent
// SDKs, and koffi, that the relay installs on demand with `npm ci`). A folder
// ships its manifest as pin.json and the lockfile as pin-lock.json, never as
// package.json (a dependency scanner would list the SDKs as OAR's own); the
// store and this script hand them to npm under the npm names.
//
//   node scripts/agent-sdk-lock.mjs            every folder
//   node scripts/agent-sdk-lock.mjs claude     one folder
//
// Linux only: npm on Windows leaves the `libc` field out of the Linux
// platform entries it writes, and `npm ci` from such a lock installs the
// glibc and the musl binary side by side. The lock lists every platform's
// optional packages whatever the host, so one generated on Linux serves all.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AGENT_SDK_PIN_FILES } from '../server/services/agent-sdk-paths.mjs';

export const PIN_MANIFEST = AGENT_SDK_PIN_FILES['package.json'];
export const PIN_LOCK = AGENT_SDK_PIN_FILES['package-lock.json'];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AGENT_SDK_PINS_DIR = path.join(repoRoot, 'server', 'agent-sdks');

// zod before 4.6.6 has the CVE the 0.9.23 round removed.
const MIN_ZOD = [4, 6, 6];

function versionBelow(version, min) {
  const parts = String(version || '').split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < min.length; index += 1) {
    const value = Number.isFinite(parts[index]) ? parts[index] : 0;
    if (value !== min[index]) return value < min[index];
  }
  return false;
}

function packageName(key) {
  return key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

/**
 * What is wrong with a pins folder's lockfile, as readable lines (none: it
 * may ship). `id` is the folder name, `pkg` its manifest (pin.json).
 */
export function lockProblems(id, pkg, lock) {
  const problems = [];
  const packages = lock?.packages || {};
  const root = packages[''] || {};
  if (lock?.name !== pkg?.name || root.name !== pkg?.name) problems.push(`the lock names ${lock?.name}, ${PIN_MANIFEST} ${pkg?.name}`);
  const wanted = pkg?.dependencies || {};
  if (JSON.stringify(root.dependencies || {}) !== JSON.stringify(wanted)) problems.push(`the lock root lists other dependencies than ${PIN_MANIFEST}`);
  for (const [name, version] of Object.entries(wanted)) {
    const installed = packages[`node_modules/${name}`]?.version;
    if (installed !== version) problems.push(`${name}: the lock holds ${installed}, ${PIN_MANIFEST} pins ${version}`);
  }
  const withScripts = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (!key) continue;
    const name = packageName(key);
    if (entry.hasInstallScript) withScripts.push(name);
    if (name === 'zod' && versionBelow(entry.version, MIN_ZOD)) problems.push(`${key} is zod ${entry.version}, below ${MIN_ZOD.join('.')}`);
    // npm writes `libc` only where the package declares it; a musl build
    // without it would install beside the glibc one.
    if ((entry.os || []).includes('linux') && /musl/.test(name) && !(entry.libc || []).includes('musl')) {
      problems.push(`${key} has no "libc": ["musl"]; generate the lock on Linux`);
    }
  }
  // The installs run with --ignore-scripts, which would hide a package that
  // needs its script. koffi has one, and does without it: its binary comes
  // from its prebuilt optional package, which the store requires.
  const allowed = id === 'koffi' ? ['koffi'] : [];
  if (JSON.stringify(withScripts.sort()) !== JSON.stringify(allowed)) {
    problems.push(`packages with an install script: ${withScripts.join(', ') || 'none'} (expected ${allowed.join(', ') || 'none'})`);
  }
  return problems;
}

export function listPinsFolders(dir = AGENT_SDK_PINS_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, PIN_MANIFEST)))
    .map((entry) => entry.name)
    .sort();
}

function npmCommand() {
  const beside = path.join(path.dirname(process.execPath), 'npm');
  return fs.existsSync(beside) ? beside : 'npm';
}

function generate(id) {
  const folder = path.join(AGENT_SDK_PINS_DIR, id);
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, PIN_MANIFEST), 'utf8'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `oar-sdk-lock-${id}-`));
  try {
    // npm reads and writes the npm names; the pins folder keeps its own.
    fs.copyFileSync(path.join(folder, PIN_MANIFEST), path.join(work, 'package.json'));
    const result = spawnSync(npmCommand(), [
      'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--lockfile-version=3',
    ], { cwd: work, stdio: 'inherit', env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH || ''}` } });
    if (result.status !== 0) throw new Error(`npm install --package-lock-only failed for ${id} (exit ${result.status})`);
    const text = fs.readFileSync(path.join(work, 'package-lock.json'), 'utf8');
    const problems = lockProblems(id, pkg, JSON.parse(text));
    if (problems.length) throw new Error(`${id}: ${problems.join('; ')}`);
    fs.writeFileSync(path.join(folder, PIN_LOCK), text.endsWith('\n') ? text : `${text}\n`);
    console.log(`${id}: ${PIN_LOCK} written`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function main(argv) {
  if (process.platform !== 'linux') {
    console.error('agent-sdk-lock: run this on Linux (npm elsewhere leaves "libc" out of the Linux entries).');
    return 2;
  }
  const known = listPinsFolders();
  const ids = argv.length ? argv : known;
  for (const id of ids) {
    if (!known.includes(id)) {
      console.error(`agent-sdk-lock: no pins folder server/agent-sdks/${id}/`);
      return 2;
    }
  }
  for (const id of ids) generate(id);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
