import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { resolveOarRoot } from './oar-state-migration-service.mjs';
import { resolveLayoutStateDirs, resolveRelayStateDirs } from './oar-state-layout.mjs';

export const WINDOWS_AUTOSTART_FILENAME = 'oar-web-relay.cmd';
// The pre-rebrand name. Never written anymore, but still recognized (an install
// that enabled autostart before the OAR rename has this file) and cleaned up on
// every state change so the two names can never both launch a relay.
export const LEGACY_WINDOWS_AUTOSTART_FILENAME = 'copilot-remote-web-relay.cmd';
// The launchers' wait, in all, for %TEMP% and the data drive (autostartWaitLines).
export const AUTOSTART_WAIT_SECONDS = 300;
// The sign-in entry's wait log, in the OAR state root: Windows opens every
// file in the Startup folder at sign-in.
export const WINDOWS_AUTOSTART_LOG_FILENAME = 'oar-web-relay.log';

export function escapeBatchValue(value) {
  return String(value || '').replaceAll('%', '%%');
}

export function resolveWindowsStartupDirectory(env = process.env, pathImpl = path) {
  // A relay started without a full profile (the boot task) may lack APPDATA;
  // the roaming folder then is where resolveOarRoot looks too.
  const appData = String(env?.APPDATA || '').trim()
    || (String(env?.USERPROFILE || '').trim()
      ? pathImpl.join(String(env.USERPROFILE).trim(), 'AppData', 'Roaming')
      : '');
  if (!appData) {
    throw new Error('Windows autostart requires the current user APPDATA directory.');
  }
  return pathImpl.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/** The `set` lines that pin the relay's data and log folders (shared with the boot launcher). */
export function stateDirLines({ dataDir = '', logDir = '', pathImpl = path } = {}) {
  const lines = [];
  if (String(dataDir || '').trim()) {
    lines.push(`set "COPILOT_WEB_RELAY_DATA_DIR=${escapeBatchValue(pathImpl.resolve(String(dataDir).trim()))}"`);
  }
  if (String(logDir || '').trim()) {
    lines.push(`set "COPILOT_WEB_RELAY_LOG_DIR=${escapeBatchValue(pathImpl.resolve(String(logDir).trim()))}"`);
  }
  return lines;
}

/**
 * The data folder's drive root (`R:\`), '' for none or a UNC path (cmd's
 * `if exist` does not tell a share root reliably). The root, not the folder:
 * on a first run the relay creates the folder.
 */
export function dataDriveRoot(dataDir = '', pathImpl = path) {
  const trimmed = String(dataDir || '').trim();
  if (!trimmed) return '';
  const { root } = pathImpl.parse(pathImpl.resolve(trimmed));
  return /^[A-Za-z]:[\\/]$/.test(root) ? `${root.slice(0, 2).toUpperCase()}\\` : '';
}

/**
 * Before Node starts: up to AUTOSTART_WAIT_SECONDS in all for %TEMP% and the
 * data drive; when it runs out, one line naming what is missing goes to
 * `logTarget` and Node starts anyway. A round is about a second: `ping -n 2`
 * waits one between its echoes (by full path: an early boot's PATH may lack
 * System32). TEMP is read once, into OAR_TEMP without quotes, only
 * when set: `if not "%TEMP%"==""` breaks on `"D:\My Temp"`, an unset
 * `%TEMP:"=%` expands to `"=`. `waitSeconds`: tests only.
 */
export function autostartWaitLines({ dataDir = '', logTarget, pathImpl = path, waitSeconds = AUTOSTART_WAIT_SECONDS } = {}) {
  const drive = escapeBatchValue(dataDriveRoot(dataDir, pathImpl));
  const missing = (temp, data) => [temp && 'TEMP folder "%OAR_TEMP%"', data && `data drive "${drive}"`].filter(Boolean).join(' and ');
  const logLine = (text) => `echo [%DATE% %TIME%] Still missing after ${waitSeconds} s: ${text}; starting the relay anyway.>>${logTarget}`;
  const lines = [
    'set "OAR_TEMP="',
    'if not defined TEMP goto oar_temp_set',
    'set "OAR_TEMP=%TEMP:"=%"',
    ':oar_temp_set',
    'set /a OAR_WAIT=0',
    ':oar_wait',
    'set "OAR_WAIT_TEMP="',
    'if defined OAR_TEMP if not exist "%OAR_TEMP%\\" set "OAR_WAIT_TEMP=1"',
  ];
  if (drive) {
    lines.push(
      'set "OAR_WAIT_DATA="',
      `if not exist "${drive}" set "OAR_WAIT_DATA=1"`,
      'if not defined OAR_WAIT_TEMP if not defined OAR_WAIT_DATA goto oar_start',
    );
  } else {
    lines.push('if not defined OAR_WAIT_TEMP goto oar_start');
  }
  lines.push(
    `if %OAR_WAIT% geq ${waitSeconds} goto oar_wait_over`,
    '"%SystemRoot%\\System32\\ping.exe" -n 2 127.0.0.1 >nul',
    'set /a OAR_WAIT+=1',
    'goto oar_wait',
    ':oar_wait_over',
  );
  // One line, whichever is missing: exactly one of these runs.
  if (drive) {
    lines.push(
      `if defined OAR_WAIT_TEMP if defined OAR_WAIT_DATA ${logLine(missing(true, true))}`,
      `if defined OAR_WAIT_TEMP if not defined OAR_WAIT_DATA ${logLine(missing(true, false))}`,
      `if not defined OAR_WAIT_TEMP if defined OAR_WAIT_DATA ${logLine(missing(false, true))}`,
    );
  } else {
    lines.push(logLine(missing(true, false)));
  }
  // The copy and the counters are not handed on to the relay.
  lines.push(':oar_start', 'set "OAR_WAIT="', 'set "OAR_WAIT_TEMP="');
  if (drive) lines.push('set "OAR_WAIT_DATA="');
  lines.push('set "OAR_TEMP="');
  return lines;
}

// How far past the end of the file it replaces the padding reaches, and the
// longest padding line (cmd.exe refuses lines over 8191 characters).
export const LAUNCHER_PADDING_MARGIN = 64;
// What the padding covers at least, whatever the file replaced: an entry
// written from scratch (autostart switched off and on) may still have the
// cmd of an earlier one running. Unpadded formats stay under 2 KB; a padded
// one's Node line ends it, so its cmd never reads on.
export const LAUNCHER_MIN_COVER_BYTES = 4096;
const LAUNCHER_PADDING_LINE_MAX = 8000;
// cmd.exe reads a batch file in the console's OEM code page; the file is
// UTF-8, so a path with non-ASCII characters (a user profile) would be
// garbled without this. By full path: an early boot's PATH may lack System32.
export const LAUNCHER_CODE_PAGE_LINE = '"%SystemRoot%\\System32\\chcp.com" 65001 >nul';

/**
 * Every launcher OAR writes has this shape, so it can be replaced while a
 * cmd.exe still runs the one before it. cmd does not keep a batch file open:
 * after each command it opens the file by name again and reads on from the
 * byte offset it had reached, and the relay's cmd waits on the Node line for
 * as long as the relay runs. Read on in a longer replacement, that offset
 * would land on a line before the Node line and start the relay a second
 * time.
 *
 *   <header lines>
 *   goto oar_begin
 *   <spaces, up to past the end of the file this one replaces>
 *   exit /b
 *   :oar_begin
 *   ...
 *   "node.exe" "...server.js" & exit
 *
 * A fresh run jumps over the padding. A cmd still running the file replaced
 * reads on at its offset, inside the padding, finds blanks and then
 * `exit /b`. And since the Node line ends the script itself (cmd has read the
 * whole line before Node starts), a cmd running this file never reads on in
 * a later replacement at all. `coverBytes` is the size of the file being
 * replaced (at least
 * LAUNCHER_MIN_COVER_BYTES is covered).
 */
export function buildLauncherFile({ headerLines = ['@echo off'], bodyLines = [], coverBytes = 0 } = {}) {
  const head = [...headerLines, 'goto oar_begin'];
  const headBytes = Buffer.byteLength(head.map((line) => `${line}\r\n`).join(''), 'utf8');
  let remaining = Math.max(
    LAUNCHER_PADDING_MARGIN,
    Math.max(Number(coverBytes) || 0, LAUNCHER_MIN_COVER_BYTES) + LAUNCHER_PADDING_MARGIN - headBytes,
  );
  const padding = [];
  while (remaining > 0) {
    const width = Math.min(remaining, LAUNCHER_PADDING_LINE_MAX);
    padding.push(' '.repeat(width));
    remaining -= width + 2;
  }
  return [...head, ...padding, 'exit /b', ':oar_begin', LAUNCHER_CODE_PAGE_LINE, ...bodyLines, ''].join('\r\n');
}

/**
 * The line that starts the relay and ends the script (buildLauncherFile).
 * `exit` hands on Node's exit code (`exit /b`, the earlier `ending`, gave
 * `cmd /c` 0). It closes no one's console: Task Scheduler and the Startup
 * folder each start a cmd of their own for a launcher.
 */
export function launcherNodeLine(nodePath, serverPath, { ending = 'exit' } = {}) {
  return `"${escapeBatchValue(nodePath)}" "${escapeBatchValue(serverPath)}" & ${ending}`;
}

/**
 * The Node a launcher runs `serverPath` with, read from its Node line (with or
 * without the trailing `& exit` or `& exit /b`); null when it runs no such
 * server.
 */
export function readLauncherNodePath(script, serverPath) {
  const wanted = escapeBatchValue(serverPath).toLowerCase();
  for (const line of String(script == null ? '' : script).split(/\r?\n/)) {
    const match = line.trimEnd().match(/^"([^"]+)" "([^"]+)"(?: & exit(?: \/b)?)?$/);
    if (match && match[2].toLowerCase() === wanted) return match[1].replaceAll('%%', '%');
  }
  return null;
}

/**
 * Same launcher, whatever the line endings, trailing blanks and the length
 * of the padding. `ignoreCase` for telling whether a launcher is one an
 * earlier version generated: Windows paths compare without case.
 */
export function launcherScriptsMatch(actual, expected, { ignoreCase = false } = {}) {
  const normalize = (value) => {
    const text = String(value == null ? '' : value)
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+$/, ''))
      .filter(Boolean)
      .join('\n');
    return ignoreCase ? text.toLowerCase() : text;
  };
  return normalize(actual) === normalize(expected);
}

function requireLauncherInputs({ packageRoot, nodePath }, what) {
  if (!String(packageRoot || '').trim()) {
    throw new Error(`${what} requires the copilot-remote package root.`);
  }
  if (!String(nodePath || '').trim()) {
    throw new Error(`${what} requires the Node.js executable path.`);
  }
}

export function buildWindowsAutostartScript({
  packageRoot,
  nodePath = process.execPath,
  configPath = '',
  // The data and log folders `oar start` gives the relay
  // (resolveRelayStateDirs); without them the relay would keep its database
  // inside the package directory, which every update replaces.
  dataDir = '',
  logDir = '',
  // On Windows a process pins its cwd, and self-update must be able to
  // replace the package directory — so the relay runs from the OAR state
  // root, not from the code it executes.
  workingDirectory = '',
  // Size of the file this one replaces (see buildLauncherFile).
  coverBytes = 0,
  pathImpl = path,
} = {}) {
  return buildLauncherFile({
    bodyLines: signInBodyLines({
      packageRoot, nodePath, configPath, dataDir, logDir, workingDirectory, pathImpl, wait: true,
    }),
    coverBytes,
  });
}

// The entry's lines after the padding; `wait: false` is the earlier form.
function signInBodyLines({ packageRoot, nodePath, configPath, dataDir, logDir, workingDirectory, pathImpl, wait }) {
  requireLauncherInputs({ packageRoot, nodePath }, 'Windows autostart');
  const resolvedPackageRoot = pathImpl.resolve(String(packageRoot));
  const serverPath = pathImpl.join(resolvedPackageRoot, 'server', 'server.js');
  const lines = ['title OAR Web Relay'];
  if (String(configPath || '').trim()) {
    lines.push(`set "COPILOT_WEB_RELAY_CONFIG=${escapeBatchValue(pathImpl.resolve(configPath))}"`);
  }
  lines.push(...stateDirLines({ dataDir, logDir, pathImpl }));
  const cwdTarget = String(workingDirectory || '').trim()
    ? pathImpl.resolve(String(workingDirectory))
    : resolvedPackageRoot;
  if (wait) {
    const logTarget = `"${escapeBatchValue(pathImpl.join(cwdTarget, WINDOWS_AUTOSTART_LOG_FILENAME))}"`;
    lines.push(...autostartWaitLines({ dataDir, logTarget, pathImpl }));
  }
  lines.push(
    `cd /d "${escapeBatchValue(cwdTarget)}"`,
    launcherNodeLine(pathImpl.resolve(String(nodePath)), serverPath, wait ? {} : { ending: 'exit /b' }),
  );
  return lines;
}

/**
 * The sign-in entries earlier versions generated, newest first: the padded
 * one before 0.9.14 shipped (no wait, `& exit /b`; needs `dataDir` and
 * `logDir`), 0.9.2 to 0.9.13, then 0.9.0 and 0.9.1 (pre-rebrand name).
 */
export function buildEarlierWindowsAutostartScripts({
  packageRoot,
  nodePath,
  configPath = '',
  dataDir = '',
  logDir = '',
  workingDirectory = '',
  pathImpl = path,
} = {}) {
  requireLauncherInputs({ packageRoot, nodePath }, 'Windows autostart');
  const resolvedPackageRoot = pathImpl.resolve(String(packageRoot));
  const serverPath = pathImpl.join(resolvedPackageRoot, 'server', 'server.js');
  const unpadded = (title, cwd) => [
    '@echo off',
    title,
    ...(String(configPath || '').trim()
      ? [`set "COPILOT_WEB_RELAY_CONFIG=${escapeBatchValue(pathImpl.resolve(configPath))}"`]
      : []),
    `cd /d "${escapeBatchValue(cwd)}"`,
    `"${escapeBatchValue(pathImpl.resolve(String(nodePath)))}" "${escapeBatchValue(serverPath)}"`,
    '',
  ].join('\r\n');
  const scripts = [];
  if (String(workingDirectory || '').trim()) {
    scripts.push(
      buildLauncherFile({
        bodyLines: signInBodyLines({
          packageRoot, nodePath, configPath, dataDir, logDir, workingDirectory, pathImpl, wait: false,
        }),
      }),
      unpadded('title OAR Web Relay', pathImpl.resolve(String(workingDirectory))),
    );
  }
  scripts.push(unpadded('title Copilot Remote Web Relay', resolvedPackageRoot));
  return scripts;
}

export function createWindowsAutostartService({
  platform = process.platform,
  env = process.env,
  packageRoot,
  nodePath = process.execPath,
  configPath = '',
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  const supported = platform === 'win32';

  function entryPath() {
    return pathImpl.join(
      resolveWindowsStartupDirectory(env, pathImpl),
      WINDOWS_AUTOSTART_FILENAME,
    );
  }

  function legacyEntryPath() {
    return pathImpl.join(
      resolveWindowsStartupDirectory(env, pathImpl),
      LEGACY_WINDOWS_AUTOSTART_FILENAME,
    );
  }

  function getState() {
    // The legacy-named entry still counts as "enabled": it starts the relay at
    // sign-in exactly like the current name does, and reporting it as off
    // would invite enabling a second copy next to it.
    const enabled = supported
      && (fsImpl.existsSync(entryPath()) || fsImpl.existsSync(legacyEntryPath()));
    return {
      supported,
      enabled: supported ? enabled : false,
      platform,
    };
  }

  function removeLegacyEntry() {
    const target = legacyEntryPath();
    if (!fsImpl.existsSync(target)) return false;
    fsImpl.unlinkSync(target);
    return true;
  }

  const workingDirectory = () => resolveOarRoot(env, platform);
  const serverPath = () => pathImpl.join(pathImpl.resolve(String(packageRoot || '')), 'server', 'server.js');

  function buildScript({ stateDirs, coverBytes = 0, nodePathOverride = null } = {}) {
    return buildWindowsAutostartScript({
      packageRoot,
      nodePath: nodePathOverride || nodePath,
      configPath,
      ...(stateDirs || resolveRelayStateDirs({ packageRoot, env, platform, fsImpl, pathImpl })),
      workingDirectory: workingDirectory(),
      coverBytes,
      pathImpl,
    });
  }

  function writeEntry(targetPath, script) {
    fsImpl.mkdirSync(pathImpl.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      fsImpl.writeFileSync(temporaryPath, script, { encoding: 'utf8', flag: 'wx' });
      fsImpl.renameSync(temporaryPath, targetPath);
    } finally {
      if (fsImpl.existsSync(temporaryPath)) fsImpl.unlinkSync(temporaryPath);
    }
  }

  /**
   * Brings an entry an earlier version wrote (see
   * buildEarlierWindowsAutostartScripts) up to date, under the name it has;
   * the relay calls this once it runs, so an update or `oar start` repairs the
   * entry without the setting being switched off and on. Only an entry exactly
   * as that version wrote it for this install and its config is rewritten,
   * keeping the Node it runs; one edited by hand, or one of another install
   * of OAR (the Startup entry has one name for all of them), is left alone. It
   * pins only the install's own folders (resolveLayoutStateDirs), so nothing
   * happens in a checkout or on a relay started with folders of its own. True
   * when it rewrote an entry.
   */
  // `onEarlierForm`: the earlier form found (`pinnedData` false: package database).
  function refreshInstalledEntry({ onEarlierForm } = {}) {
    if (!supported || String(env?.COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN || '').trim()) return false;
    const stateDirs = resolveLayoutStateDirs({ packageRoot, env, platform, fsImpl, pathImpl });
    if (!stateDirs) return false;
    let changed = false;
    for (const targetPath of [entryPath(), legacyEntryPath()]) {
      if (!fsImpl.existsSync(targetPath)) continue;
      const current = String(fsImpl.readFileSync(targetPath, 'utf8'));
      const entryNodePath = readLauncherNodePath(current, serverPath());
      if (!entryNodePath) continue;
      const earlier = buildEarlierWindowsAutostartScripts({
        packageRoot, nodePath: entryNodePath, configPath, ...stateDirs, workingDirectory: workingDirectory(), pathImpl,
      });
      const matched = earlier.find((script) => launcherScriptsMatch(current, script, { ignoreCase: true }));
      if (!matched) continue;
      onEarlierForm?.({ path: targetPath, pinnedData: matched.includes('COPILOT_WEB_RELAY_DATA_DIR') });
      writeEntry(targetPath, buildScript({
        stateDirs,
        nodePathOverride: entryNodePath,
        coverBytes: Buffer.byteLength(current, 'utf8'),
      }));
      changed = true;
    }
    return changed;
  }

  function setEnabled(enabled) {
    if (!supported) {
      throw new Error('Windows autostart is only available on Windows.');
    }
    if (typeof enabled !== 'boolean') {
      throw new TypeError('Windows autostart enabled state must be a boolean.');
    }

    const targetPath = entryPath();
    const existed = fsImpl.existsSync(targetPath);
    if (!enabled) {
      const removedLegacy = removeLegacyEntry();
      if (existed) fsImpl.unlinkSync(targetPath);
      return { ...getState(), changed: existed || removedLegacy };
    }
    // Enabling always converges on the one current filename; if only the
    // legacy entry existed, the current-name write below reports the change.
    removeLegacyEntry();

    const current = existed ? String(fsImpl.readFileSync(targetPath, 'utf8')) : '';
    if (existed && launcherScriptsMatch(current, buildScript())) {
      return { ...getState(), changed: false };
    }

    writeEntry(targetPath, buildScript({ coverBytes: Buffer.byteLength(current, 'utf8') }));
    return { ...getState(), changed: true };
  }

  return {
    getState,
    setEnabled,
    refreshInstalledEntry,
  };
}
