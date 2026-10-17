// Windows system programs by absolute path, and the bits of a process
// environment that decide whether a child can start at all.
//
// A relay started by the boot-time Scheduled Task (S4U, before anyone signs
// in) gets an environment built without a full profile: user PATH entries
// that refer to other variables can arrive unexpanded, and a bare `node`
// that a signed-in shell finds was not found there. Node looks a bare name
// up on PATH only, so the programs Windows ships are called by their full
// path under %SystemRoot%; one that is not there falls back to the bare
// name, which is what every call site did before.

import fs from 'node:fs';
import path from 'node:path';

const WINDOWS_DEFAULT_ROOT = 'C:\\Windows';

function text(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * The value of an environment variable, matched without regard to case.
 * Windows names are case-insensitive, and a copied environment (`{ ...env }`)
 * keeps whatever case it came with: `Path`, not `PATH`, on most machines.
 */
export function readEnvValue(env, name) {
  if (!env || typeof env !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(env, name)) return text(env[name]);
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return text(env[key]);
  }
  return '';
}

/** The key PATH is stored under in `env` (`Path` on most Windows machines). */
export function envPathKey(env, platform = process.platform) {
  if (env && typeof env === 'object') {
    if (Object.prototype.hasOwnProperty.call(env, 'PATH')) return 'PATH';
    if (platform === 'win32') {
      const found = Object.keys(env).find((key) => key.toLowerCase() === 'path');
      if (found) return found;
    }
  }
  return platform === 'win32' ? 'Path' : 'PATH';
}

export function windowsSystemRoot(env = process.env) {
  return readEnvValue(env, 'SystemRoot') || readEnvValue(env, 'windir') || WINDOWS_DEFAULT_ROOT;
}

const TOOL_SUBPATHS = Object.freeze({
  'powershell.exe': ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'],
});

/**
 * Full path of a program that ships with Windows (`schtasks.exe`,
 * `powershell.exe`, `taskkill.exe`, ...), or the bare name when the file is
 * not where Windows keeps it.
 */
export function windowsSystemToolPath(name, {
  env = process.env,
  existsImpl = fs.existsSync,
} = {}) {
  const bare = text(name);
  const fileName = /\.exe$/i.test(bare) ? bare : `${bare}.exe`;
  const parts = TOOL_SUBPATHS[fileName.toLowerCase()] || ['System32', fileName];
  const full = path.win32.join(windowsSystemRoot(env), ...parts);
  try {
    if (existsImpl(full)) return full;
  } catch {}
  return bare;
}

/** The command interpreter: %ComSpec%, else cmd.exe under %SystemRoot%. */
export function windowsCmdPath({ env = process.env, existsImpl = fs.existsSync } = {}) {
  return readEnvValue(env, 'ComSpec') || windowsSystemToolPath('cmd.exe', { env, existsImpl });
}

/**
 * One log line's worth of the environment a child was started with: PATH in
 * full (the entries are what a failed lookup needs), SystemRoot and ComSpec.
 */
export function describeSpawnEnvironment(env = process.env, platform = process.platform) {
  const pathValue = readEnvValue(env, 'PATH');
  const parts = [`PATH=${pathValue || '(not set)'}`];
  if (platform === 'win32') {
    parts.push(`SystemRoot=${readEnvValue(env, 'SystemRoot') || '(not set)'}`);
    parts.push(`ComSpec=${readEnvValue(env, 'ComSpec') || '(not set)'}`);
  }
  return parts.join(' ');
}

/** What a failed execFile/execFileSync reports, on one line. */
export function describeExecError(error) {
  if (!error) return 'unknown error';
  const parts = [];
  const code = error.code ?? error.status;
  if (code !== undefined && code !== null) parts.push(`code=${code}`);
  if (error.signal) parts.push(`signal=${error.signal}`);
  const stderr = text(Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : error.stderr);
  const message = text(error.message).split(/\r?\n/)[0];
  if (message) parts.push(message);
  if (stderr) parts.push(`stderr=${stderr.replace(/\s+/g, ' ').slice(0, 500)}`);
  return parts.join(' ') || 'unknown error';
}
