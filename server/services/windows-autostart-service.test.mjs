import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AUTOSTART_WAIT_SECONDS,
  LAUNCHER_CODE_PAGE_LINE,
  LEGACY_WINDOWS_AUTOSTART_FILENAME,
  WINDOWS_AUTOSTART_FILENAME,
  WINDOWS_AUTOSTART_LOG_FILENAME,
  autostartWaitLines,
  buildEarlierWindowsAutostartScripts,
  buildWindowsAutostartScript,
  createWindowsAutostartService,
  launcherScriptsMatch,
  readLauncherNodePath,
  resolveWindowsStartupDirectory,
} from './windows-autostart-service.mjs';
import { scratchEnv } from './scratch-env-test-harness.mjs';

function createTestContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-remote-autostart-'));
  const appData = path.join(root, 'User Data', 'Roaming');
  const packageRoot = path.join(root, 'Installed Apps', 'copilot-remote');
  const nodePath = path.join(root, 'Node JS', 'node.exe');
  const startupDirectory = resolveWindowsStartupDirectory({ APPDATA: appData });
  const entryPath = path.join(startupDirectory, WINDOWS_AUTOSTART_FILENAME);
  const service = createWindowsAutostartService({
    platform: 'win32',
    env: { APPDATA: appData },
    packageRoot,
    nodePath,
  });
  return {
    root,
    packageRoot,
    nodePath,
    startupDirectory,
    entryPath,
    service,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('resolveWindowsStartupDirectory uses the current user APPDATA directory', () => {
  assert.equal(
    resolveWindowsStartupDirectory({ APPDATA: 'C:\\Users\\Example\\AppData\\Roaming' }, path.win32),
    'C:\\Users\\Example\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
  );
  assert.throws(
    () => resolveWindowsStartupDirectory({}, path.win32),
    /APPDATA/,
  );
});

test('buildWindowsAutostartScript quotes installed paths and escapes percent expansion', () => {
  const script = buildWindowsAutostartScript({
    packageRoot: 'C:\\Apps\\Copilot Remote %USER%',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    configPath: 'C:\\Users\\Example\\AppData\\Local\\copilot-remote\\config.json',
    pathImpl: path.win32,
  });
  assert.match(script, /title OAR Web Relay/);
  assert.match(
    script,
    /set "COPILOT_WEB_RELAY_CONFIG=C:\\Users\\Example\\AppData\\Local\\copilot-remote\\config\.json"/,
  );
  assert.match(script, /cd \/d "C:\\Apps\\Copilot Remote %%USER%%"/);
  assert.match(
    script,
    /"C:\\Program Files\\nodejs\\node\.exe" "C:\\Apps\\Copilot Remote %%USER%%\\server\\server\.js"/,
  );
  assert.equal(script.includes('relay.mjs'), false);
});

test('setEnabled installs, preserves, and removes only the owned Startup entry', () => {
  const context = createTestContext();
  try {
    fs.mkdirSync(context.startupDirectory, { recursive: true });
    const unrelatedPath = path.join(context.startupDirectory, 'unrelated.cmd');
    fs.writeFileSync(unrelatedPath, '@echo off\r\n', 'utf8');

    assert.deepEqual(context.service.getState(), {
      supported: true,
      enabled: false,
      platform: 'win32',
    });

    const enabled = context.service.setEnabled(true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.changed, true);
    const installedScript = fs.readFileSync(context.entryPath, 'utf8');
    assert.match(installedScript, new RegExp(context.nodePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(installedScript, /server[\\/]server\.js/);

    const enabledAgain = context.service.setEnabled(true);
    assert.equal(enabledAgain.changed, false);
    assert.equal(fs.readFileSync(context.entryPath, 'utf8'), installedScript);

    // The entry an earlier version generated is written over.
    const earlier = buildEarlierWindowsAutostartScripts({ packageRoot: context.packageRoot, nodePath: context.nodePath }).at(-1);
    fs.writeFileSync(context.entryPath, earlier, 'utf8');
    const repaired = context.service.setEnabled(true);
    assert.equal(repaired.changed, true);
    // The same script; only the padding follows the size of the file replaced.
    assert.ok(launcherScriptsMatch(fs.readFileSync(context.entryPath, 'utf8'), installedScript));

    const disabled = context.service.setEnabled(false);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.changed, true);
    assert.equal(fs.existsSync(context.entryPath), false);
    assert.equal(fs.existsSync(unrelatedPath), true);

    const disabledAgain = context.service.setEnabled(false);
    assert.equal(disabledAgain.changed, false);
  } finally {
    context.cleanup();
  }
});

test('non-Windows state is unsupported and mutation is rejected', () => {
  const service = createWindowsAutostartService({
    platform: 'linux',
    env: {},
    packageRoot: '/opt/copilot-remote',
    nodePath: '/usr/bin/node',
  });
  assert.deepEqual(service.getState(), {
    supported: false,
    enabled: false,
    platform: 'linux',
  });
  assert.throws(() => service.setEnabled(true), /only available on Windows/);
});

test('a pre-rebrand entry still reads as enabled and converges on the new name', () => {
  const context = createTestContext();
  try {
    const legacyPath = path.join(context.startupDirectory, LEGACY_WINDOWS_AUTOSTART_FILENAME);
    const preRebrand = buildEarlierWindowsAutostartScripts({ packageRoot: context.packageRoot, nodePath: context.nodePath }).at(-1);
    fs.mkdirSync(context.startupDirectory, { recursive: true });
    fs.writeFileSync(legacyPath, preRebrand);
    assert.equal(context.service.getState().enabled, true, 'the old file starts a relay too');

    const enabled = context.service.setEnabled(true);
    assert.equal(enabled.enabled, true);
    assert.equal(fs.existsSync(legacyPath), false, 'legacy name removed on enable');
    assert.equal(fs.existsSync(context.entryPath), true);

    fs.writeFileSync(legacyPath, preRebrand);
    const disabled = context.service.setEnabled(false);
    assert.equal(disabled.enabled, false);
    assert.equal(fs.existsSync(legacyPath), false, 'disable sweeps both names');
    assert.equal(fs.existsSync(context.entryPath), false);
  } finally {
    context.cleanup();
  }
});

test('a hand-made entry is never written over or deleted, and no second entry joins it', () => {
  const context = createTestContext();
  try {
    fs.mkdirSync(context.startupDirectory, { recursive: true });
    const handMade = '@echo off\r\nrem my own start\r\n';
    fs.writeFileSync(context.entryPath, handMade);
    assert.deepEqual(context.service.listEntries(), [{ path: context.entryPath, generated: false, otherInstall: null }]);

    const enabled = context.service.setEnabled(true);
    assert.deepEqual([enabled.enabled, enabled.changed, enabled.kept], [true, false, [context.entryPath]]);
    assert.equal(fs.readFileSync(context.entryPath, 'utf8'), handMade);
    const disabled = context.service.setEnabled(false);
    assert.deepEqual([disabled.enabled, disabled.changed, disabled.kept], [true, false, [context.entryPath]]);
    assert.equal(fs.readFileSync(context.entryPath, 'utf8'), handMade);

    // Beside a hand-made pre-rebrand entry no second one is written either.
    const legacyPath = path.join(context.startupDirectory, LEGACY_WINDOWS_AUTOSTART_FILENAME);
    fs.renameSync(context.entryPath, legacyPath);
    assert.deepEqual(context.service.setEnabled(true).kept, [legacyPath]);
    assert.equal(fs.existsSync(context.entryPath), false);
    assert.equal(fs.readFileSync(legacyPath, 'utf8'), handMade);

    // An entry generated for this install (any Node) reads as OAR's own.
    fs.rmSync(legacyPath);
    context.service.setEnabled(true);
    assert.deepEqual(context.service.listEntries(), [{ path: context.entryPath, generated: true, otherInstall: null }]);
  } finally {
    context.cleanup();
  }
});

test('an entry left by another OAR install is hand-made and names that install; --replace keeps a copy outside the Startup folder', () => {
  const context = createTestContext();
  try {
    fs.mkdirSync(context.startupDirectory, { recursive: true });
    const otherRoot = path.join(context.root, 'Old Prefix', 'oar');
    const stale = buildWindowsAutostartScript({ packageRoot: otherRoot, nodePath: context.nodePath });
    fs.writeFileSync(context.entryPath, stale);
    assert.deepEqual(context.service.listEntries(), [{ path: context.entryPath, generated: false, otherInstall: otherRoot }]);
    assert.equal(context.service.refreshInstalledEntry(), false, 'no automatic repair');
    assert.equal(fs.readFileSync(context.entryPath, 'utf8'), stale);

    assert.throws(() => context.service.setEnabled(true, { replace: true }), /folder for its copy/);
    const backupDir = path.join(context.root, 'state');
    const replaced = context.service.setEnabled(true, { replace: true, backupDir });
    const copy = path.join(backupDir, `${WINDOWS_AUTOSTART_FILENAME}.bak`);
    assert.deepEqual(replaced.backedUp, [{ path: context.entryPath, backup: copy }]);
    assert.deepEqual(replaced.kept, []);
    assert.equal(fs.readFileSync(copy, 'utf8'), stale, 'the copy is the old entry, byte for byte');
    assert.deepEqual(context.service.listEntries(), [{ path: context.entryPath, generated: true, otherInstall: null }]);
    assert.deepEqual(fs.readdirSync(context.startupDirectory), [WINDOWS_AUTOSTART_FILENAME], 'no copy in the Startup folder');

    // A second replace keeps the first copy and numbers the next one.
    fs.writeFileSync(context.entryPath, '@echo off\r\nrem mine\r\n');
    const off = context.service.setEnabled(false, { replace: true, backupDir });
    assert.deepEqual(off.backedUp, [{ path: context.entryPath, backup: `${copy}-2` }]);
    assert.equal(fs.existsSync(context.entryPath), false);
    assert.equal(fs.readFileSync(copy, 'utf8'), stale);
  } finally {
    context.cleanup();
  }
});

test('resolveWindowsStartupDirectory falls back to the roaming folder under USERPROFILE without APPDATA', () => {
  assert.equal(
    resolveWindowsStartupDirectory({ USERPROFILE: 'C:\\Users\\Example' }, path.win32),
    'C:\\Users\\Example\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
  );
});

// ─── Data and log folders (the ones `oar start` uses) ────────────────────────

test('buildWindowsAutostartScript pins the data and log folders before Node starts', () => {
  const lines = buildWindowsAutostartScript({
    packageRoot: 'C:\\Users\\dev\\oar',
    nodePath: 'C:\\Users\\dev\\node\\node.exe',
    configPath: 'C:\\Users\\dev\\AppData\\Roaming\\oar\\config.json',
    dataDir: 'C:\\Users\\dev\\AppData\\Roaming\\oar\\data',
    logDir: 'C:\\Users\\dev\\100% logs',
    workingDirectory: 'C:\\Users\\dev\\AppData\\Roaming\\oar',
    pathImpl: path.win32,
  }).split('\r\n');
  const dataLine = lines.indexOf('set "COPILOT_WEB_RELAY_DATA_DIR=C:\\Users\\dev\\AppData\\Roaming\\oar\\data"');
  const logLine = lines.indexOf('set "COPILOT_WEB_RELAY_LOG_DIR=C:\\Users\\dev\\100%% logs"');
  const nodeLine = lines.findIndex((line) => line.startsWith('"C:\\Users\\dev\\node\\node.exe"'));
  assert.ok(dataLine > 0 && logLine > 0, 'both folders pinned');
  assert.ok(dataLine < nodeLine && logLine < nodeLine);
  // Without them (a checkout pins none) the script stays as it was.
  const bare = buildWindowsAutostartScript({
    packageRoot: 'C:\\Users\\dev\\oar', nodePath: 'C:\\Users\\dev\\node\\node.exe', pathImpl: path.win32,
  });
  assert.ok(!bare.includes('COPILOT_WEB_RELAY_DATA_DIR'));
  assert.ok(!bare.includes('COPILOT_WEB_RELAY_LOG_DIR'));
});

test('the sign-in entry of a global install starts the relay on the OAR state root, like oar start', () => {
  const context = createTestContext();
  try {
    context.service.setEnabled(true);
    const script = fs.readFileSync(context.entryPath, 'utf8');
    const stateRoot = path.join(context.root, 'User Data', 'Roaming', 'oar');
    assert.ok(script.includes(`set "COPILOT_WEB_RELAY_DATA_DIR=${path.join(stateRoot, 'data')}"`), script);
    assert.ok(script.includes(`set "COPILOT_WEB_RELAY_LOG_DIR=${path.join(stateRoot, 'logs')}"`), script);
  } finally {
    context.cleanup();
  }
});

test('the sign-in entry pins the folders the running relay was given', () => {
  const context = createTestContext();
  try {
    const service = createWindowsAutostartService({
      platform: 'win32',
      env: {
        APPDATA: path.join(context.root, 'User Data', 'Roaming'),
        COPILOT_WEB_RELAY_DATA_DIR: path.join(context.root, 'own-data'),
        COPILOT_WEB_RELAY_LOG_DIR: path.join(context.root, 'own-logs'),
      },
      packageRoot: context.packageRoot,
      nodePath: context.nodePath,
    });
    service.setEnabled(true);
    const script = fs.readFileSync(context.entryPath, 'utf8');
    assert.ok(script.includes(`set "COPILOT_WEB_RELAY_DATA_DIR=${path.join(context.root, 'own-data')}"`));
    assert.ok(script.includes(`set "COPILOT_WEB_RELAY_LOG_DIR=${path.join(context.root, 'own-logs')}"`));
  } finally {
    context.cleanup();
  }
});

test('an entry an earlier version wrote is brought up to date; an edited or foreign one is left alone', () => {
  const context = createTestContext();
  const appData = path.join(context.root, 'User Data', 'Roaming');
  const [earlier] = buildEarlierWindowsAutostartScripts({
    packageRoot: context.packageRoot,
    nodePath: context.nodePath,
    dataDir: path.join(appData, 'oar', 'data'),
    logDir: path.join(appData, 'oar', 'logs'),
    workingDirectory: path.join(appData, 'oar'),
  });
  try {
    assert.equal(context.service.refreshInstalledEntry(), false, 'nothing installed, nothing written');
    assert.equal(fs.existsSync(context.entryPath), false);

    fs.mkdirSync(context.startupDirectory, { recursive: true });
    fs.writeFileSync(context.entryPath, earlier, 'utf8');
    assert.equal(context.service.refreshInstalledEntry(), true);
    const refreshed = fs.readFileSync(context.entryPath, 'utf8');
    assert.ok(refreshed.includes(`set "COPILOT_WEB_RELAY_DATA_DIR=${path.join(appData, 'oar', 'data')}"`));
    assert.equal(context.service.setEnabled(true).changed, false, 'the same entry an enable writes');
    assert.equal(context.service.refreshInstalledEntry(), false, 'current already');

    const edited = earlier.replace('@echo off', '@echo off\r\nrem mine');
    fs.writeFileSync(context.entryPath, edited, 'utf8');
    assert.equal(context.service.refreshInstalledEntry(), false);
    assert.equal(fs.readFileSync(context.entryPath, 'utf8'), edited);

    // Another install of OAR (say a checkout) owns the one entry name.
    const [foreign] = buildEarlierWindowsAutostartScripts({
      packageRoot: path.join(context.root, 'Other', 'oar'),
      nodePath: context.nodePath,
      workingDirectory: path.join(appData, 'oar'),
    });
    fs.writeFileSync(context.entryPath, foreign, 'utf8');
    assert.equal(context.service.refreshInstalledEntry(), false);
    assert.equal(fs.readFileSync(context.entryPath, 'utf8'), foreign);

    const off = createWindowsAutostartService({
      platform: 'win32',
      env: { APPDATA: appData, COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1' },
      packageRoot: context.packageRoot,
      nodePath: context.nodePath,
    });
    fs.writeFileSync(context.entryPath, earlier, 'utf8');
    assert.equal(off.refreshInstalledEntry(), false, 'an isolated (e2e) relay leaves host autostart alone');
  } finally {
    context.cleanup();
  }
});

// A hand-made launcher that waits for a late-mounted drive before it starts
// the relay: an earlier generated launcher with a wait loop put in front of
// the start line.
function withWaitLoop(script) {
  const lines = script.split('\r\n');
  const start = lines.findIndex((line) => line.includes('server.js"'));
  assert.ok(start > 0, 'the start line is found');
  lines.splice(start, 0,
    ':wait_for_data',
    'if not exist "%LOCALAPPDATA%\\scratch\\ready" (',
    '  timeout /t 2 /nobreak >nul',
    '  goto wait_for_data',
    ')');
  return lines.join('\r\n');
}

test('a hand-made entry that waits before the start line is never rewritten, at any start', () => {
  const context = createTestContext();
  const appData = path.join(context.root, 'User Data', 'Roaming');
  const earlier = buildEarlierWindowsAutostartScripts({
    packageRoot: context.packageRoot,
    nodePath: context.nodePath,
    dataDir: path.join(appData, 'oar', 'data'),
    logDir: path.join(appData, 'oar', 'logs'),
    workingDirectory: path.join(appData, 'oar'),
  });
  try {
    fs.mkdirSync(context.startupDirectory, { recursive: true });
    assert.ok(earlier.length >= 2, 'every earlier format is covered');
    for (const script of earlier) {
      const handMade = withWaitLoop(script);
      fs.writeFileSync(context.entryPath, handMade, 'utf8');
      assert.equal(context.service.refreshInstalledEntry(), false);
      // The next start (after an update, say) leaves it alone just the same.
      assert.equal(context.service.refreshInstalledEntry(), false);
      assert.equal(fs.readFileSync(context.entryPath, 'utf8'), handMade, 'byte for byte');
    }
  } finally {
    context.cleanup();
  }
});

test('the pre-rebrand entry is repaired in place under its own name', () => {
  const context = createTestContext();
  const appData = path.join(context.root, 'User Data', 'Roaming');
  const legacyPath = path.join(context.startupDirectory, LEGACY_WINDOWS_AUTOSTART_FILENAME);
  // 0.9.0 and 0.9.1: the old title, run from the package directory.
  const earliest = buildEarlierWindowsAutostartScripts({
    packageRoot: context.packageRoot,
    nodePath: context.nodePath,
    dataDir: path.join(appData, 'oar', 'data'),
    logDir: path.join(appData, 'oar', 'logs'),
    workingDirectory: path.join(appData, 'oar'),
  }).at(-1);
  try {
    assert.match(earliest, /title Copilot Remote Web Relay/);
    fs.mkdirSync(context.startupDirectory, { recursive: true });
    fs.writeFileSync(legacyPath, earliest, 'utf8');
    assert.equal(context.service.refreshInstalledEntry(), true);
    assert.ok(fs.readFileSync(legacyPath, 'utf8').includes('COPILOT_WEB_RELAY_DATA_DIR'));
    assert.equal(fs.existsSync(context.entryPath), false, 'no second entry');
  } finally {
    context.cleanup();
  }
});

test('an earlier entry is matched whatever its Node and the case of its paths, and keeps its Node', () => {
  const context = createTestContext();
  const appData = path.join(context.root, 'User Data', 'Roaming');
  // A version manager's Node, not the one this relay runs on.
  const otherNode = path.join(context.root, 'nvm4w', 'nodejs', 'node.exe');
  const [earlier] = buildEarlierWindowsAutostartScripts({
    packageRoot: context.packageRoot,
    nodePath: otherNode,
    dataDir: path.join(appData, 'oar', 'data'),
    logDir: path.join(appData, 'oar', 'logs'),
    workingDirectory: path.join(appData, 'oar'),
  });
  try {
    fs.mkdirSync(context.startupDirectory, { recursive: true });
    fs.writeFileSync(context.entryPath, earlier.replace('Installed Apps', 'INSTALLED APPS'), 'utf8');
    assert.equal(context.service.refreshInstalledEntry(), true);
    const refreshed = fs.readFileSync(context.entryPath, 'utf8');
    assert.equal(readLauncherNodePath(refreshed, path.join(context.packageRoot, 'server', 'server.js')), otherNode);
  } finally {
    context.cleanup();
  }
});

test('the automatic repair pins only the install\'s own folders', () => {
  const context = createTestContext();
  const appData = path.join(context.root, 'User Data', 'Roaming');
  const [earlier] = buildEarlierWindowsAutostartScripts({
    packageRoot: context.packageRoot,
    nodePath: context.nodePath,
    dataDir: path.join(appData, 'oar', 'data'),
    logDir: path.join(appData, 'oar', 'logs'),
    workingDirectory: path.join(appData, 'oar'),
  });
  const serviceWith = (env, packageRoot = context.packageRoot) => createWindowsAutostartService({
    platform: 'win32', env: { APPDATA: appData, ...env }, packageRoot, nodePath: context.nodePath,
  });
  try {
    fs.mkdirSync(context.startupDirectory, { recursive: true });
    fs.writeFileSync(context.entryPath, earlier, 'utf8');
    // A short-lived relay on a scratch data folder must not repoint autostart.
    assert.equal(serviceWith({ COPILOT_WEB_RELAY_DATA_DIR: path.join(context.root, 'scratch') }).refreshInstalledEntry(), false);
    assert.equal(fs.readFileSync(context.entryPath, 'utf8'), earlier);
    // `oar start` names the install's own folders: that is fine.
    assert.equal(serviceWith({
      COPILOT_WEB_RELAY_DATA_DIR: path.join(appData, 'oar', 'data'),
      COPILOT_WEB_RELAY_LOG_DIR: path.join(appData, 'oar', 'logs'),
    }).refreshInstalledEntry(), true);
    // A checkout has no folders of its own to pin: nothing to repair there.
    fs.mkdirSync(path.join(context.packageRoot, '.git'), { recursive: true });
    fs.writeFileSync(context.entryPath, earlier, 'utf8');
    assert.equal(serviceWith({}).refreshInstalledEntry(), false);
  } finally {
    context.cleanup();
  }
});

// ─── Rewriting a file a cmd.exe still runs ───────────────────────────────────

/**
 * What a cmd.exe that ran `oldScript` up to its Node line reads once Node
 * exits, after `newScript` replaced the file: cmd opens the file by name again
 * and reads on at its byte offset. Both offsets cmd may hold are tried.
 */
function assertResumeIsHarmless(oldScript, newScript) {
  const oldBytes = Buffer.from(oldScript, 'utf8');
  const newBytes = Buffer.from(newScript, 'utf8');
  assert.match(oldScript, /server\.js"( & exit \/b)?\r\n$/, 'the Node line ends the earlier file');
  // Just after the Node line, and after its line break.
  for (const offset of [oldBytes.length - 2, oldBytes.length]) {
    const [line, next] = newBytes.subarray(offset).toString('utf8').split('\r\n');
    assert.equal(line.trim(), '', `blank at offset ${offset}`);
    assert.equal(next, 'exit /b', `then exit /b at offset ${offset}`);
  }
}

test('a cmd still running an earlier entry reads blanks and exit /b in the new one, not a second start', () => {
  for (const profile of ['C:\\Users\\dev', 'C:\\Users\\dev-\u00e4\u00f6\u00fc \u6587\u5b57']) {
    const inputs = {
      packageRoot: `${profile}\\AppData\\Roaming\\npm\\node_modules\\@oar-sh\\oar`,
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      configPath: `${profile}\\AppData\\Roaming\\oar\\config.json`,
      workingDirectory: `${profile}\\AppData\\Roaming\\oar`,
      pathImpl: path.win32,
    };
    for (const earlier of buildEarlierWindowsAutostartScripts(inputs)) {
      const next = buildWindowsAutostartScript({
        ...inputs,
        dataDir: `${profile}\\AppData\\Roaming\\oar\\data`,
        logDir: `${profile}\\AppData\\Roaming\\oar\\logs`,
        coverBytes: Buffer.byteLength(earlier, 'utf8'),
      });
      assertResumeIsHarmless(earlier, next);
    }
  }
});

test('a new entry jumps over its padding, switches cmd to UTF-8 and ends with its Node line', () => {
  const script = buildWindowsAutostartScript({
    packageRoot: 'C:\\Users\\dev\\oar',
    nodePath: 'C:\\Users\\dev\\node\\node.exe',
    configPath: 'C:\\Users\\dev\\AppData\\Roaming\\oar\\config.json',
    workingDirectory: 'C:\\Users\\dev\\AppData\\Roaming\\oar',
    coverBytes: 5000,
    pathImpl: path.win32,
  });
  const lines = script.split('\r\n');
  assert.deepEqual(lines.slice(0, 2), ['@echo off', 'goto oar_begin']);
  const exitAt = lines.indexOf('exit /b');
  assert.ok(lines.slice(2, exitAt).every((line) => line.trim() === '' && line.length <= 8000), 'padding: blanks, short lines');
  assert.ok(Buffer.byteLength(lines.slice(0, exitAt).join('\r\n')) >= 5000, 'reaches past the file replaced');
  assert.deepEqual(lines.slice(exitAt + 1, exitAt + 3), [':oar_begin', LAUNCHER_CODE_PAGE_LINE]);
  assert.equal(LAUNCHER_CODE_PAGE_LINE, '"%SystemRoot%\\System32\\chcp.com" 65001 >nul');
  // cmd has read the whole Node line before Node runs: a later rewrite is never read on in.
  assert.equal(lines.at(-2), '"C:\\Users\\dev\\node\\node.exe" "C:\\Users\\dev\\oar\\server\\server.js" & exit');
  assert.equal(lines.at(-1), '');
});

// Real cmd.exe, the way the Startup folder runs the entry, on a dummy
// server.js in a scratch folder that only exits with the given code.
test('cmd /d /c returns the exit code Node ended the generated entry with', { skip: process.platform !== 'win32' }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-entry-exit-'));
  try {
    fs.mkdirSync(path.join(scratch, 'pkg', 'server'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'pkg', 'server', 'server.js'), 'process.exit(Number(process.env.OAR_TEST_EXIT));\n');
    const inputs = {
      packageRoot: path.join(scratch, 'pkg'),
      nodePath: process.execPath,
      dataDir: path.join(scratch, 'data'),
      logDir: path.join(scratch, 'logs'),
      workingDirectory: scratch,
    };
    const run = (script, code) => {
      const entry = path.join(scratch, WINDOWS_AUTOSTART_FILENAME);
      fs.writeFileSync(entry, script);
      const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      return spawnSync(cmd, ['/d', '/c', `"${entry}"`], {
        env: scratchEnv(scratch, { OAR_TEST_EXIT: String(code) }),
        windowsVerbatimArguments: true,
        windowsHide: true,
        timeout: 60_000,
      }).status;
    };
    assert.equal(run(buildWindowsAutostartScript(inputs), 3), 3);
    assert.equal(run(buildWindowsAutostartScript(inputs), 0), 0);
    // The form before: `& exit /b` reported 0 whatever Node returned.
    assert.equal(run(buildEarlierWindowsAutostartScripts(inputs)[0], 3), 0);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('refreshing is a no-op off Windows', () => {
  const service = createWindowsAutostartService({ platform: 'linux', env: {}, packageRoot: '/opt/oar', nodePath: '/usr/bin/node' });
  assert.equal(service.refreshInstalledEntry(), false);
});

test('an entry written from scratch still covers an earlier file a cmd may run', () => {
  // Switched off and on (or `oar service remove` + `install`): there is no
  // file to measure, but the earlier entry's cmd may still be running.
  const inputs = {
    packageRoot: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@oar-sh\\oar',
    nodePath: 'C:\\Users\\dev\\AppData\\Local\\nvm\\v22.11.0\\node.exe',
    configPath: 'C:\\Users\\dev\\AppData\\Roaming\\oar\\config.json',
    workingDirectory: 'C:\\Users\\dev\\AppData\\Roaming\\oar',
    pathImpl: path.win32,
  };
  const fresh = buildWindowsAutostartScript({ ...inputs, coverBytes: 0 });
  const edited = `${'rem a long hand-added note\r\n'.repeat(100)}"${inputs.nodePath}" "${inputs.packageRoot}\\server\\server.js"\r\n`;
  assert.ok(Buffer.byteLength(edited) < 4096);
  // A padded entry is left out: its Node line ends it, so its cmd never reads on.
  const unpadded = buildEarlierWindowsAutostartScripts(inputs).filter((script) => !script.includes('goto oar_begin'));
  assert.equal(unpadded.length, 2);
  for (const earlier of [...unpadded, edited]) {
    assertResumeIsHarmless(earlier, fresh);
  }
});

// ─── The wait for TEMP and the data drive ────────────────────────────────────

test('the sign-in entry waits for %TEMP% and the data drive like the boot launcher, logging to the OAR folder', () => {
  const stateRoot = 'C:\\Users\\dev\\AppData\\Roaming\\oar';
  const inputs = {
    packageRoot: 'C:\\Users\\dev\\oar',
    nodePath: 'C:\\Users\\dev\\node\\node.exe',
    configPath: `${stateRoot}\\config.json`,
    dataDir: 'R:\\oar\\data',
    logDir: 'R:\\oar\\logs',
    workingDirectory: stateRoot,
    pathImpl: path.win32,
  };
  const lines = buildWindowsAutostartScript(inputs).split('\r\n');
  // Not beside the entry: Windows opens every file in the Startup folder at sign-in.
  const logTarget = `"${stateRoot}\\${WINDOWS_AUTOSTART_LOG_FILENAME}"`;
  assert.equal(WINDOWS_AUTOSTART_LOG_FILENAME, 'oar-web-relay.log');
  // The same block, word for word, as the boot launcher gets.
  const block = autostartWaitLines({ dataDir: inputs.dataDir, logTarget, pathImpl: path.win32 });
  const start = lines.indexOf(block[0]);
  assert.equal(block[0], 'set "OAR_TEMP="');
  assert.ok(start > 0);
  assert.deepEqual(lines.slice(start, start + block.length), block);
  assert.ok(block.includes('if not exist "R:\\" set "OAR_WAIT_DATA=1"'));
  assert.ok(block.includes(`if %OAR_WAIT% geq ${AUTOSTART_WAIT_SECONDS} goto oar_wait_over`));
  assert.equal(AUTOSTART_WAIT_SECONDS, 300);
  const logLines = block.filter((line) => /(^| )echo \[/.test(line));
  assert.equal(logLines.length, 3);
  assert.ok(logLines.every((line) => line.endsWith(`; starting the relay anyway.>>${logTarget}`)));
  // After the pinned folders, before cd and Node.
  assert.ok(lines.indexOf('set "COPILOT_WEB_RELAY_DATA_DIR=R:\\oar\\data"') < start);
  const cdAt = lines.indexOf(`cd /d "${stateRoot}"`);
  assert.equal(cdAt, start + block.length);
  assert.ok(lines[cdAt + 1].startsWith('"C:\\Users\\dev\\node\\node.exe" '));
});

test('every entry an earlier version generated gets the wait; the new one then stays as it is', () => {
  const context = createTestContext();
  const appData = path.join(context.root, 'User Data', 'Roaming');
  const earlier = buildEarlierWindowsAutostartScripts({
    packageRoot: context.packageRoot,
    nodePath: context.nodePath,
    dataDir: path.join(appData, 'oar', 'data'),
    logDir: path.join(appData, 'oar', 'logs'),
    workingDirectory: path.join(appData, 'oar'),
  });
  try {
    fs.mkdirSync(context.startupDirectory, { recursive: true });
    assert.equal(earlier.length, 3);
    assert.ok(earlier[0].includes('goto oar_begin') && earlier[0].includes('COPILOT_WEB_RELAY_DATA_DIR'), 'the padded form without the wait');
    assert.match(earlier[0], /server\.js" & exit \/b\r\n$/, 'and the Node line that dropped its exit code');
    for (const script of earlier) {
      assert.ok(!script.includes('OAR_WAIT'));
      fs.writeFileSync(context.entryPath, script, 'utf8');
      assert.equal(context.service.refreshInstalledEntry(), true);
      const refreshed = fs.readFileSync(context.entryPath, 'utf8');
      assert.ok(refreshed.includes(`if %OAR_WAIT% geq ${AUTOSTART_WAIT_SECONDS} goto oar_wait_over`));
      assert.match(refreshed, /server\.js" & exit\r\n$/);
      assert.equal(context.service.setEnabled(true).changed, false, 'the same entry an enable writes');
      // The next start leaves it byte for byte.
      assert.equal(context.service.refreshInstalledEntry(), false);
      assert.equal(fs.readFileSync(context.entryPath, 'utf8'), refreshed);
    }
  } finally {
    context.cleanup();
  }
});

test('an entry that waits for R:\\ its own way, or an edited one, stays byte-identical', () => {
  const context = createTestContext();
  const appData = path.join(context.root, 'User Data', 'Roaming');
  const [padded] = buildEarlierWindowsAutostartScripts({
    packageRoot: context.packageRoot,
    nodePath: context.nodePath,
    dataDir: path.join(appData, 'oar', 'data'),
    logDir: path.join(appData, 'oar', 'logs'),
    workingDirectory: path.join(appData, 'oar'),
  });
  const lines = padded.split('\r\n');
  lines.splice(lines.findIndex((line) => line.startsWith('cd /d ')), 0,
    ':wait_for_r',
    'if not exist "R:\\" (',
    '  "%SystemRoot%\\System32\\ping.exe" -n 6 127.0.0.1 >nul',
    '  goto wait_for_r',
    ')');
  const waitsForR = lines.join('\r\n');
  const edited = padded.replace('title OAR Web Relay', 'title My relay');
  try {
    fs.mkdirSync(context.startupDirectory, { recursive: true });
    for (const custom of [waitsForR, edited]) {
      fs.writeFileSync(context.entryPath, custom, 'utf8');
      assert.equal(context.service.refreshInstalledEntry(), false);
      assert.equal(context.service.refreshInstalledEntry(), false);
      assert.equal(fs.readFileSync(context.entryPath, 'utf8'), custom, 'byte for byte');
    }
  } finally {
    context.cleanup();
  }
});

test('the refresh says whether the entry it found ran the relay on the package database', () => {
  const context = createTestContext();
  const appData = path.join(context.root, 'User Data', 'Roaming');
  const earlier = buildEarlierWindowsAutostartScripts({
    packageRoot: context.packageRoot,
    nodePath: context.nodePath,
    dataDir: path.join(appData, 'oar', 'data'),
    logDir: path.join(appData, 'oar', 'logs'),
    workingDirectory: path.join(appData, 'oar'),
  });
  try {
    fs.mkdirSync(context.startupDirectory, { recursive: true });
    for (const [index, pinnedData] of [[0, true], [1, false], [2, false]]) {
      fs.writeFileSync(context.entryPath, earlier[index], 'utf8');
      const found = [];
      assert.equal(context.service.refreshInstalledEntry({ onEarlierForm: (form) => found.push(form) }), true);
      assert.deepEqual(found, [{ path: context.entryPath, pinnedData }], `form ${index}`);
    }
  } finally {
    context.cleanup();
  }
});

test('with a dataDir in config.json, the sign-in entry still pins the state root\'s data folder, as oar start does', () => {
  const context = createTestContext();
  try {
    const appData = path.join(context.root, 'User Data', 'Roaming');
    const configPath = path.join(appData, 'oar', 'config.json');
    const configured = path.join(context.root, 'own-data');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ dataDir: configured }));
    const service = createWindowsAutostartService({
      platform: 'win32', env: { APPDATA: appData }, packageRoot: context.packageRoot, nodePath: context.nodePath, configPath,
    });
    service.setEnabled(true);
    const script = fs.readFileSync(context.entryPath, 'utf8');
    assert.ok(script.includes(`set "COPILOT_WEB_RELAY_DATA_DIR=${path.join(appData, 'oar', 'data')}"`), script);
    assert.ok(!script.includes(configured));
    assert.ok(script.includes(`set "COPILOT_WEB_RELAY_LOG_DIR=${path.join(appData, 'oar', 'logs')}"`));
  } finally {
    context.cleanup();
  }
});
