import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  BOOT_ELEVATION_SCRIPT_FILENAME,
  BOOT_LAUNCHER_FILENAME,
  BOOT_LAUNCHER_LOG_FILENAME,
  BOOT_TASK_NAME,
  BOOT_TASK_XML_FILENAME,
  LEGACY_BOOT_TASK_NAME,
  buildBootLauncherScript,
  buildBootTaskXml,
  buildEarlierBootLauncherScripts,
  buildElevationScript,
  classifyTaskXml,
  createWindowsBootAutostartService,
  describeTaskCustomisations,
  encodeTaskXml,
  launcherScriptsMatch,
  parseSidFromWhoami,
  parseTaskXml,
} from './windows-boot-autostart-service.mjs';
import { AUTOSTART_WAIT_SECONDS, autostartWaitLines, dataDriveRoot } from './windows-autostart-service.mjs';
import { resolveRelayStateDirs } from './oar-state-layout.mjs';
import { scratchEnv } from './scratch-env-test-harness.mjs';

// All literals below are the hygiene guard's placeholder host, and the
// platform is always injected — nothing reads the machine running the tests.
const PACKAGE_ROOT = 'C:\\Users\\dev\\oar';
const NODE_PATH = 'C:\\Users\\dev\\node\\node.exe';
const CONFIG_PATH = 'C:\\Users\\dev\\oar\\server\\config.json';
const APPDATA = 'C:\\Users\\dev\\AppData\\Roaming';
const SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const ENV = { APPDATA };
const OAR_ROOT = path.win32.join(APPDATA, 'oar');
const LAUNCHER = path.win32.join(OAR_ROOT, BOOT_LAUNCHER_FILENAME);
// Where `oar start` keeps a global install's data and logs.
const DATA_DIR = path.win32.join(OAR_ROOT, 'data');
const LOG_DIR = path.win32.join(OAR_ROOT, 'logs');

// ─── Launcher script ─────────────────────────────────────────────────────────

test('the boot launcher pins config, cds to the OAR root (not the package dir) and runs server.js', () => {
  const script = buildBootLauncherScript({
    packageRoot: PACKAGE_ROOT,
    nodePath: NODE_PATH,
    configPath: CONFIG_PATH,
    workingDirectory: OAR_ROOT,
    pathImpl: path.win32,
  });
  assert.match(script, /^@echo off\r\n/);
  assert.ok(script.includes(`set "COPILOT_WEB_RELAY_CONFIG=${CONFIG_PATH}"`));
  // cwd must NOT be the package dir: a Windows process pins its cwd, and
  // self-update has to be able to replace the package directory.
  assert.ok(script.includes(`cd /d "${OAR_ROOT}"`));
  assert.ok(!script.includes(`cd /d "${PACKAGE_ROOT}"`));
  assert.ok(script.includes(`"${NODE_PATH}" "${PACKAGE_ROOT}\\server\\server.js"`));
  // Session 0 has no console; a `title` line would be pure noise.
  assert.ok(!script.includes('title '));
});

test('the launcher omits the config line when no config path is set, and escapes %', () => {
  const script = buildBootLauncherScript({
    packageRoot: 'C:\\Users\\dev\\100% repo',
    nodePath: NODE_PATH,
    pathImpl: path.win32,
  });
  assert.ok(!script.includes('COPILOT_WEB_RELAY_CONFIG'));
  assert.ok(script.includes('100%% repo'), 'batch % must be doubled');
});

// ─── Task XML ────────────────────────────────────────────────────────────────

test('the task XML carries the proven settings: S4U by SID, boot+30s, no time limit, restart policy', () => {
  const xml = buildBootTaskXml({ sid: SID, launcherPath: LAUNCHER, packageRoot: PACKAGE_ROOT, workingDirectory: OAR_ROOT });
  assert.ok(xml.includes(`<UserId>${SID}</UserId>`));
  assert.ok(xml.includes('<LogonType>S4U</LogonType>'));
  assert.ok(xml.includes('<BootTrigger>'));
  assert.ok(xml.includes('<Delay>PT30S</Delay>'));
  assert.ok(xml.includes('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>'));
  assert.ok(xml.includes('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'));
  assert.ok(xml.includes('<Count>5</Count>'));
  assert.ok(xml.includes('<Interval>PT1M</Interval>'));
  assert.ok(xml.includes('<StartWhenAvailable>true</StartWhenAvailable>'));
  assert.ok(xml.includes(`<URI>\\${BOOT_TASK_NAME}</URI>`));
  assert.ok(xml.includes('<Command>C:\\Windows\\System32\\cmd.exe</Command>'));
  assert.ok(xml.includes(`<Arguments>/d /c "${LAUNCHER}"</Arguments>`));
  assert.ok(xml.includes(`<WorkingDirectory>${OAR_ROOT}</WorkingDirectory>`));
});

test('the task XML refuses a non-SID and escapes XML-hostile paths', () => {
  assert.throws(() => buildBootTaskXml({ sid: 'dev', launcherPath: LAUNCHER, packageRoot: PACKAGE_ROOT }), /SID/);
  const xml = buildBootTaskXml({
    sid: SID,
    launcherPath: 'C:\\Users\\dev\\a & b\\launch.cmd',
    packageRoot: PACKAGE_ROOT,
  });
  assert.ok(xml.includes('a &amp; b'));
  assert.ok(!xml.includes('a & b'));
});

test('the on-disk XML is UTF-16LE with a BOM, as schtasks demands', () => {
  const buffer = encodeTaskXml('<Task/>');
  assert.deepEqual([buffer[0], buffer[1]], [0xff, 0xfe]);
  assert.equal(buffer.subarray(2).toString('utf16le'), '<Task/>');
});

// ─── Parsing and classification ──────────────────────────────────────────────

const OWN_TASK_XML = buildBootTaskXml({ sid: SID, launcherPath: LAUNCHER, packageRoot: PACKAGE_ROOT });
const FOREIGN_TASK_XML = OWN_TASK_XML.replace(LAUNCHER, 'C:\\Users\\dev\\other\\thing.cmd');

test('parseTaskXml scrapes the fields classification needs', () => {
  const parsed = parseTaskXml(OWN_TASK_XML);
  assert.equal(parsed.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.ok(parsed.argumentsLine.includes(BOOT_LAUNCHER_FILENAME));
  assert.equal(parsed.logonType, 'S4U');
  assert.equal(parsed.userId, SID);
});

test('a task running our launcher is ready; anything else under our name is foreign', () => {
  assert.equal(classifyTaskXml(OWN_TASK_XML, { launcherPath: LAUNCHER }), 'ready');
  assert.equal(classifyTaskXml(OWN_TASK_XML, { launcherPath: LAUNCHER.toUpperCase() }), 'ready', 'paths compare case-insensitively');
  assert.equal(classifyTaskXml(FOREIGN_TASK_XML, { launcherPath: LAUNCHER }), 'foreign');
  assert.equal(classifyTaskXml('', { launcherPath: LAUNCHER }), 'foreign');
});

// ─── Elevation sweep script ──────────────────────────────────────────────────

test('the enable sweep migrates the legacy task and reports the create result', () => {
  const script = buildElevationScript({ action: 'enable', xmlPath: 'C:\\Users\\dev\\task.xml' });
  const lines = script.split('\r\n');
  assert.ok(lines[0].includes(`/delete /tn "${LEGACY_BOOT_TASK_NAME}"`), 'legacy task removed first');
  assert.ok(lines[2].includes(`/create /tn "${BOOT_TASK_NAME}" /xml "C:\\Users\\dev\\task.xml"`));
  assert.equal(lines[3], 'exit $LASTEXITCODE', 'the create result is the sweep result');
});

test('the disable sweep removes both task names and always reports success', () => {
  const script = buildElevationScript({ action: 'disable' });
  assert.ok(script.includes(`/delete /tn "${BOOT_TASK_NAME}"`));
  assert.ok(script.includes(`/delete /tn "${LEGACY_BOOT_TASK_NAME}"`));
  assert.ok(script.endsWith('exit 0\r\n'));
  assert.throws(() => buildElevationScript({ action: 'oops' }), /Unknown/);
});

test('parseSidFromWhoami reads the CSV shape whoami actually prints', () => {
  assert.equal(parseSidFromWhoami('"User Name","SID"\r\n"host\\dev","S-1-5-21-1-2-3-1001"\r\n'), 'S-1-5-21-1-2-3-1001');
  assert.equal(parseSidFromWhoami('garbage'), null);
});

// ─── Service harness ─────────────────────────────────────────────────────────

function createFakeFs() {
  const files = new Map();
  return {
    files,
    mkdirSync() {},
    existsSync: (p) => files.has(String(p)),
    readFileSync: (p) => {
      if (!files.has(String(p))) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return String(files.get(String(p)));
    },
    writeFileSync: (p, contents) => { files.set(String(p), contents); },
    renameSync: (from, to) => { files.set(String(to), files.get(String(from))); files.delete(String(from)); },
    unlinkSync: (p) => { files.delete(String(p)); },
  };
}

function createFakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = [];
  child.kill = (signal) => { child.killed.push(signal); return true; };
  return child;
}

function createManualTimers() {
  const pendingTimers = new Map();
  let nextId = 0;
  return {
    setTimeoutImpl(fn, ms) {
      const id = (nextId += 1);
      pendingTimers.set(id, { fn, ms });
      return { id, unref() { return this; } };
    },
    clearTimeoutImpl(handle) { if (handle) pendingTimers.delete(handle.id); },
    fire(ms) {
      for (const [id, entry] of [...pendingTimers]) {
        if (entry.ms !== ms) continue;
        pendingTimers.delete(id);
        entry.fn();
      }
    },
  };
}

function createHarness({ tasks = {}, whoamiSid = SID, schtasksStartError = null, logs = [] } = {}) {
  const fsImpl = createFakeFs();
  const timers = createManualTimers();
  const spawns = [];
  const service = createWindowsBootAutostartService({
    platform: 'win32',
    env: ENV,
    packageRoot: PACKAGE_ROOT,
    nodePath: NODE_PATH,
    configPath: CONFIG_PATH,
    fsImpl,
    pathImpl: path.win32,
    execFileImpl: async (file, args) => {
      if (file === 'whoami') {
        return whoamiSid
          ? { code: 0, stdout: `"User Name","SID"\r\n"host\\dev","${whoamiSid}"\r\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: 'failed' };
      }
      if (file === 'schtasks' && args[0] === '/query') {
        if (schtasksStartError) return { code: 1, stdout: '', stderr: '', startError: schtasksStartError };
        const name = args[2];
        const xml = tasks[name];
        return xml != null ? { code: 0, stdout: xml, stderr: '' } : { code: 1, stdout: '', stderr: 'not found' };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    },
    spawnImpl: (file, args, options) => {
      const child = createFakeChild();
      spawns.push({ file, args, options, child });
      return child;
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    now: () => 1_000,
    logger: { log: (line) => logs.push(line) },
    // Bare names: nothing here may depend on the machine running the tests.
    systemToolPath: (name) => name,
  });
  return { service, fsImpl, timers, spawns, tasks, logs };
}

test('an unsupported platform reports itself instead of pretending', async () => {
  const service = createWindowsBootAutostartService({ platform: 'linux' });
  assert.deepEqual(await service.getState(), { supported: false, platform: 'linux' });
  await assert.rejects(() => service.requestEnable(), /only available on Windows/);
});

test('state classification: missing, legacy, ready, foreign', async () => {
  assert.equal((await createHarness().service.getState()).taskStatus, 'missing');
  const legacy = createHarness({ tasks: { [LEGACY_BOOT_TASK_NAME]: FOREIGN_TASK_XML } });
  const legacyState = await legacy.service.getState();
  assert.equal(legacyState.taskStatus, 'legacy');
  assert.equal(legacyState.legacyTaskPresent, true);
  const ready = createHarness({ tasks: { [BOOT_TASK_NAME]: OWN_TASK_XML } });
  assert.equal((await ready.service.getState()).taskStatus, 'ready');
  const foreign = createHarness({ tasks: { [BOOT_TASK_NAME]: FOREIGN_TASK_XML } });
  assert.equal((await foreign.service.getState()).taskStatus, 'foreign');
});

test('enable writes launcher, UTF-16 XML and sweep, then spawns the RunAs shell', async () => {
  const harness = createHarness();
  const state = await harness.service.requestEnable();
  assert.equal(state.accepted, true);
  assert.equal(state.pendingElevation, 'enable');

  assert.ok(String(harness.fsImpl.files.get(LAUNCHER)).includes('server.js'));
  const xmlBuffer = harness.fsImpl.files.get(path.win32.join(OAR_ROOT, BOOT_TASK_XML_FILENAME));
  assert.deepEqual([xmlBuffer[0], xmlBuffer[1]], [0xff, 0xfe], 'XML lands as UTF-16LE with BOM');
  assert.ok(xmlBuffer.subarray(2).toString('utf16le').includes(`<UserId>${SID}</UserId>`));
  assert.ok(String(harness.fsImpl.files.get(path.win32.join(OAR_ROOT, BOOT_ELEVATION_SCRIPT_FILENAME))).includes('/create'));

  assert.equal(harness.spawns.length, 1);
  const spawnCall = harness.spawns[0];
  assert.equal(spawnCall.file, 'powershell.exe');
  const command = spawnCall.args.join(' ');
  assert.ok(command.includes('-Verb RunAs'), 'elevation goes through UAC, never silently');
  assert.ok(command.includes(BOOT_ELEVATION_SCRIPT_FILENAME));
});

test('a confirmed enable clears pending and removes both sign-in autostart entries', async () => {
  const harness = createHarness();
  const startupDir = path.win32.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  harness.fsImpl.files.set(path.win32.join(startupDir, 'oar-web-relay.cmd'), 'new');
  harness.fsImpl.files.set(path.win32.join(startupDir, 'copilot-remote-web-relay.cmd'), 'old');
  await harness.service.requestEnable();
  harness.tasks[BOOT_TASK_NAME] = OWN_TASK_XML; // what the sweep just registered
  harness.spawns[0].child.emit('close', 0);
  const state = await harness.service.getState();
  assert.equal(state.pendingElevation, null);
  assert.equal(state.lastError, null);
  assert.equal(state.taskStatus, 'ready');
  assert.ok(!harness.fsImpl.files.has(path.win32.join(startupDir, 'oar-web-relay.cmd')));
  assert.ok(!harness.fsImpl.files.has(path.win32.join(startupDir, 'copilot-remote-web-relay.cmd')));
});

test('a declined UAC surfaces the manual command instead of hanging', async () => {
  const harness = createHarness();
  await harness.service.requestEnable();
  harness.spawns[0].child.emit('close', 1);
  const state = await harness.service.getState();
  assert.equal(state.pendingElevation, null);
  assert.match(state.lastError, /not confirmed/);
  assert.ok(state.manualCommand.includes('/create'));
});

test('an elevation that never returns is timed out and the shell killed', async () => {
  const harness = createHarness();
  await harness.service.requestEnable();
  harness.timers.fire(120_000);
  const state = await harness.service.getState();
  assert.equal(state.pendingElevation, null);
  assert.match(state.lastError, /timed out/);
  assert.deepEqual(harness.spawns[0].child.killed, ['SIGTERM']);
  // The late close from the killed child must not clobber the timeout verdict.
  harness.spawns[0].child.emit('close', 0);
  assert.match((await harness.service.getState()).lastError, /timed out/);
});

test('a second request while one elevation is pending is refused, not queued', async () => {
  const harness = createHarness();
  await harness.service.requestEnable();
  const second = await harness.service.requestEnable();
  assert.equal(second.accepted, false);
  assert.equal(harness.spawns.length, 1, 'no second UAC prompt');
});

test('a confirmed disable removes the launcher and reports missing', async () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: OWN_TASK_XML } });
  harness.fsImpl.files.set(LAUNCHER, 'launcher');
  const state = await harness.service.requestDisable();
  assert.equal(state.accepted, true);
  assert.ok(String(harness.fsImpl.files.get(path.win32.join(OAR_ROOT, BOOT_ELEVATION_SCRIPT_FILENAME))).includes('/delete'));
  delete harness.tasks[BOOT_TASK_NAME];
  harness.spawns[0].child.emit('close', 0);
  const after = await harness.service.getState();
  assert.equal(after.taskStatus, 'missing');
  assert.ok(!harness.fsImpl.files.has(LAUNCHER), 'launcher cleaned up with the task');
});

test('a failed SID lookup fails the enable before any elevation is attempted', async () => {
  const harness = createHarness({ whoamiSid: null });
  const state = await harness.service.requestEnable();
  assert.equal(state.accepted, false);
  assert.match(state.lastError, /SID/);
  assert.equal(harness.spawns.length, 0);
});

test('the e2e kill switch blanks the state and refuses mutations', async () => {
  const service = createWindowsBootAutostartService({
    platform: 'win32',
    env: { ...ENV, COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1' },
    packageRoot: PACKAGE_ROOT,
    execFileImpl: async () => { throw new Error('an isolated relay must never run schtasks'); },
  });
  const state = await service.getState();
  assert.equal(state.taskStatus, 'unknown');
  assert.equal(state.legacyTaskPresent, false);
  await assert.rejects(() => service.requestEnable(), /disabled on this relay/);
  await assert.rejects(() => service.requestDisable(), /disabled on this relay/);
});

// ─── Node on PATH, the TEMP wait ─────────────────────────────────────────────

function launcherLines(options = {}) {
  return buildBootLauncherScript({
    packageRoot: PACKAGE_ROOT,
    nodePath: NODE_PATH,
    configPath: CONFIG_PATH,
    workingDirectory: OAR_ROOT,
    pathImpl: path.win32,
    ...options,
  }).split('\r\n');
}

test('the boot launcher puts the Node folder at the end of PATH, before anything runs', () => {
  const lines = launcherLines();
  const pathLine = lines.indexOf('set "PATH=%PATH%;C:\\Users\\dev\\node"');
  assert.ok(pathLine > 0, 'Node folder appended to PATH');
  assert.ok(pathLine < lines.findIndex((line) => line.startsWith('cd /d ')));
  // The relay itself still runs on the absolute path.
  assert.ok(lines.includes(`"${NODE_PATH}" "${PACKAGE_ROOT}\\server\\server.js" & exit`));
  assert.ok(!lines.some((line) => line.includes('COPILOT_WEB_RELAY_NODE')));
});

test('the boot launcher escapes % in the Node folder', () => {
  const lines = launcherLines({ nodePath: 'C:\\Users\\dev\\100% node\\node.exe' });
  assert.ok(lines.includes('set "PATH=%PATH%;C:\\Users\\dev\\100%% node"'));
});

// A data folder on a drive that can come up late (a RAM disk, say).
const LATE_DATA_DIR = 'R:\\oar\\data';
const LATE_LOG_DIR = 'R:\\oar\\logs';
const PING_LINE = '"%SystemRoot%\\System32\\ping.exe" -n 2 127.0.0.1 >nul';

test('the boot launcher waits for %TEMP% and the data drive before cd and Node', () => {
  const lines = launcherLines({ dataDir: LATE_DATA_DIR, logDir: LATE_LOG_DIR });
  const at = (prefix) => lines.findIndex((line) => line.startsWith(prefix));
  // TEMP not set: not waited for.
  assert.ok(lines.includes('if defined OAR_TEMP if not exist "%OAR_TEMP%\\" set "OAR_WAIT_TEMP=1"'));
  // The drive's root, not the folder: on a first run the relay creates that.
  assert.ok(lines.includes('if not exist "R:\\" set "OAR_WAIT_DATA=1"'));
  assert.ok(!lines.some((line) => line.includes('exist "R:\\oar')));
  assert.ok(lines.includes('if not defined OAR_WAIT_TEMP if not defined OAR_WAIT_DATA goto oar_start'));
  // About a second a round, by full path (an early boot's PATH may lack System32).
  assert.ok(lines.includes(PING_LINE));
  // Generic: no TEMP drive of any one machine.
  assert.ok(!lines.some((line) => /\b[A-Z]:\\temp/i.test(line)));
  // Each round checks both again, the flags cleared first.
  assert.ok(at(':oar_wait') < at('set "OAR_WAIT_TEMP="'));
  assert.ok(at('set "OAR_WAIT_DATA="') < at('if not exist "R:\\"'));
  assert.ok(at('if not defined OAR_WAIT_TEMP') < at(PING_LINE));
  assert.equal(lines[at(PING_LINE) + 2], 'goto oar_wait');
  // Order: the pinned folders, the wait, then (whatever happened) cd and Node;
  // the counters are not handed on to the relay.
  assert.ok(at('set "COPILOT_WEB_RELAY_DATA_DIR=') < at('set /a OAR_WAIT=0'));
  assert.deepEqual(lines.slice(at(':oar_start'), at(':oar_start') + 5), [
    ':oar_start', 'set "OAR_WAIT="', 'set "OAR_WAIT_TEMP="', 'set "OAR_WAIT_DATA="', 'set "OAR_TEMP="',
  ]);
  assert.ok(at(':oar_start') < at('cd /d '));
  assert.ok(at('cd /d ') < at(`"${NODE_PATH}"`));
});

test('the wait for both is limited to 300 s in all, not per item', () => {
  assert.equal(AUTOSTART_WAIT_SECONDS, 300);
  const lines = launcherLines({ dataDir: LATE_DATA_DIR, logDir: LATE_LOG_DIR });
  // One counter, one limit, one pause a round, whatever is missing.
  assert.deepEqual(lines.filter((line) => line.includes(' geq ')), ['if %OAR_WAIT% geq 300 goto oar_wait_over']);
  assert.deepEqual(lines.filter((line) => line.includes('OAR_WAIT+=')), ['set /a OAR_WAIT+=1']);
  assert.equal(lines.filter((line) => line === PING_LINE).length, 1);
  assert.equal(lines.filter((line) => line.startsWith(':oar_wait')).length, 2, 'one loop and its way out');
  assert.equal(lines.filter((line) => line === 'set /a OAR_WAIT=0').length, 1);
  assert.ok(lines.indexOf('set /a OAR_WAIT=0') < lines.indexOf(':oar_wait'), 'the counter starts once, outside the loop');
});

test('a wait that runs out logs one line next to the launcher naming what is missing, then starts anyway', () => {
  const lines = launcherLines({ dataDir: LATE_DATA_DIR, logDir: LATE_LOG_DIR });
  const log = `>>"%~dp0${BOOT_LAUNCHER_LOG_FILENAME}"`;
  const echo = (missing) => `echo [%DATE% %TIME%] Still missing after 300 s: ${missing}; starting the relay anyway.${log}`;
  const logLines = lines.filter((line) => /(^| )echo \[/.test(line));
  // One guard per combination, so exactly one line is written.
  assert.deepEqual(logLines, [
    `if defined OAR_WAIT_TEMP if defined OAR_WAIT_DATA ${echo('TEMP folder "%OAR_TEMP%" and data drive "R:\\"')}`,
    `if defined OAR_WAIT_TEMP if not defined OAR_WAIT_DATA ${echo('TEMP folder "%OAR_TEMP%"')}`,
    `if not defined OAR_WAIT_TEMP if defined OAR_WAIT_DATA ${echo('data drive "R:\\"')}`,
  ]);
  const over = lines.indexOf(':oar_wait_over');
  assert.deepEqual(lines.slice(over + 1, over + 5), [...logLines, ':oar_start'], 'then on to Node');
});

test('without a data drive to wait for, the launcher waits for %TEMP% alone', () => {
  for (const dataDir of ['', '\\\\nas\\share\\oar\\data']) {
    const lines = launcherLines({ dataDir });
    assert.ok(!lines.some((line) => line.includes('OAR_WAIT_DATA')), dataDir || 'no data folder');
    assert.ok(lines.includes('if not defined OAR_WAIT_TEMP goto oar_start'));
    assert.deepEqual(lines.filter((line) => /(^| )echo \[/.test(line)), [
      `echo [%DATE% %TIME%] Still missing after 300 s: TEMP folder "%OAR_TEMP%"; starting the relay anyway.>>"%~dp0${BOOT_LAUNCHER_LOG_FILENAME}"`,
    ]);
  }
});

test('a TEMP set with quotes is used without them, never compared as a string', () => {
  // `if not "%TEMP%"==""` was a syntax error for `"D:\My Temp"` that stopped
  // the launcher. And with no TEMP, `%TEMP:"=%` expands to `"=`, not to
  // nothing: it is only reached when TEMP is set, to make OAR_TEMP.
  for (const dataDir of [LATE_DATA_DIR, '']) {
    const lines = launcherLines({ dataDir });
    const text = lines.join('\n');
    assert.ok(!text.includes('"%TEMP%"=='));
    assert.deepEqual(lines.filter((line) => /%TEMP\b/.test(line)), ['set "OAR_TEMP=%TEMP:"=%"'], 'TEMP is read once');
    const copyAt = lines.indexOf('set "OAR_TEMP=%TEMP:"=%"');
    assert.deepEqual(lines.slice(copyAt - 2, copyAt + 2), [
      'set "OAR_TEMP="', 'if not defined TEMP goto oar_temp_set', 'set "OAR_TEMP=%TEMP:"=%"', ':oar_temp_set',
    ]);
    assert.ok(copyAt < lines.indexOf('set /a OAR_WAIT=0'), 'once, before the loop');
    assert.ok(lines.includes('if defined OAR_TEMP if not exist "%OAR_TEMP%\\" set "OAR_WAIT_TEMP=1"'));
    // Cleared before Node, like the counters.
    assert.ok(lines.lastIndexOf('set "OAR_TEMP="') > lines.indexOf(':oar_start'));
    assert.ok(lines.lastIndexOf('set "OAR_TEMP="') < lines.findIndex((line) => line.startsWith('cd /d ')));
  }
});

test('the data drive is the root of the data folder, none for a share', () => {
  assert.equal(dataDriveRoot('R:\\oar\\data', path.win32), 'R:\\');
  assert.equal(dataDriveRoot('r:/oar/data', path.win32), 'R:\\');
  assert.equal(dataDriveRoot(DATA_DIR, path.win32), 'C:\\');
  assert.equal(dataDriveRoot('\\\\nas\\share\\oar\\data', path.win32), '');
  assert.equal(dataDriveRoot('', path.win32), '');
});

// ─── Customised task or launcher ─────────────────────────────────────────────

const GENERATED_TASK_XML = buildBootTaskXml({ sid: SID, launcherPath: LAUNCHER, packageRoot: PACKAGE_ROOT, workingDirectory: OAR_ROOT });
const GENERATED_LAUNCHER = buildBootLauncherScript({
  packageRoot: PACKAGE_ROOT,
  nodePath: NODE_PATH,
  configPath: CONFIG_PATH,
  dataDir: DATA_DIR,
  logDir: LOG_DIR,
  workingDirectory: OAR_ROOT,
  pathImpl: path.win32,
});
// What earlier versions wrote, newest first: the padded launcher that pinned
// the data and log folders and waited 120 s for %TEMP% only; 0.9.11 to
// 0.9.13; 0.9.2 to 0.9.10.
const EARLIER_INPUTS = {
  packageRoot: PACKAGE_ROOT,
  nodePath: NODE_PATH,
  configPath: CONFIG_PATH,
  dataDir: DATA_DIR,
  logDir: LOG_DIR,
  workingDirectory: OAR_ROOT,
  pathImpl: path.win32,
};
const EARLIER_LAUNCHERS = buildEarlierBootLauncherScripts(EARLIER_INPUTS);
const [EARLIER_LAUNCHER] = EARLIER_LAUNCHERS;

test('a generated task has no customisations; schtasks export noise does not count', () => {
  assert.deepEqual(describeTaskCustomisations(GENERATED_TASK_XML, { launcherPath: LAUNCHER, workingDirectory: OAR_ROOT }), []);
  // What Task Scheduler adds on export, and the run level OAR does not set.
  const exported = GENERATED_TASK_XML
    .replace('<LogonType>S4U</LogonType>', '<LogonType>S4U</LogonType>\r\n      <RunLevel>HighestAvailable</RunLevel>')
    .replace('<StartWhenAvailable>', '<Enabled>true</Enabled>\r\n    <StartWhenAvailable>')
    .replace(`/d /c "${LAUNCHER}"`, `/d /c &quot;${LAUNCHER}&quot;`);
  assert.deepEqual(describeTaskCustomisations(exported, { launcherPath: LAUNCHER, workingDirectory: OAR_ROOT }), []);
});

test('a hand-edited task names what differs', () => {
  const noDelay = GENERATED_TASK_XML.replace('      <Delay>PT30S</Delay>\r\n', '');
  assert.deepEqual(describeTaskCustomisations(noDelay, { launcherPath: LAUNCHER, workingDirectory: OAR_ROOT }), ['boot-delay']);
  const otherArgs = GENERATED_TASK_XML.replace(`/d /c "${LAUNCHER}"`, `/c "${LAUNCHER}" extra`);
  assert.deepEqual(describeTaskCustomisations(otherArgs, { launcherPath: LAUNCHER, workingDirectory: OAR_ROOT }), ['action']);
  const interactive = GENERATED_TASK_XML.replace('<LogonType>S4U</LogonType>', '<LogonType>InteractiveToken</LogonType>');
  assert.deepEqual(describeTaskCustomisations(interactive, { launcherPath: LAUNCHER, workingDirectory: OAR_ROOT }), ['logon-type']);
});

test('launchers compare without regard to line endings or trailing blanks', () => {
  assert.equal(launcherScriptsMatch(GENERATED_LAUNCHER.replaceAll('\r\n', '\n'), GENERATED_LAUNCHER), true);
  assert.equal(launcherScriptsMatch(`${GENERATED_LAUNCHER}  \r\n`, GENERATED_LAUNCHER), true);
  assert.equal(launcherScriptsMatch(GENERATED_LAUNCHER.replace('@echo off', '@echo off\r\nrem mine'), GENERATED_LAUNCHER), false);
});

test('a task that runs our launcher but differs reads as boot mode, customised, never as a failure', async () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML.replace('      <Delay>PT30S</Delay>\r\n', '') } });
  harness.fsImpl.files.set(LAUNCHER, GENERATED_LAUNCHER.replace(':oar_start', ':oar_start\r\nrem hand-added'));
  const state = await harness.service.getState();
  assert.equal(state.taskStatus, 'ready');
  assert.equal(state.customised, true);
  assert.deepEqual(state.customisations, ['boot-delay', 'launcher']);
  assert.equal(state.readError, null);
});

test('the generated task and launcher read as not customised; a missing launcher is named', async () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
  harness.fsImpl.files.set(LAUNCHER, GENERATED_LAUNCHER);
  const state = await harness.service.getState();
  assert.equal(state.customised, false);
  assert.deepEqual(state.customisations, []);
  harness.fsImpl.files.delete(LAUNCHER);
  assert.deepEqual((await harness.service.getState()).customisations, ['launcher-missing']);
});

test('schtasks that cannot run reads as unknown (not missing), logged with the environment', async () => {
  const harness = createHarness({ schtasksStartError: 'code=ENOENT spawn schtasks ENOENT' });
  const state = await harness.service.getState();
  assert.equal(state.taskStatus, 'unknown');
  assert.match(state.readError, /schtasks could not be run/);
  assert.ok(!state.readError.includes('ENOENT'), 'the details stay in the log');
  assert.equal(state.legacyTaskPresent, false);
  assert.ok(harness.logs.some((line) => line.includes('ENOENT') && line.includes('PATH=')));
});

test('enabling over a changed launcher keeps it as a .bak and reports where', async () => {
  const harness = createHarness();
  const custom = GENERATED_LAUNCHER.replace(':oar_start', ':oar_start\r\nrem hand-added');
  harness.fsImpl.files.set(LAUNCHER, custom);
  const state = await harness.service.requestEnable();
  assert.equal(state.accepted, true);
  assert.equal(harness.fsImpl.files.get(`${LAUNCHER}.bak`), custom);
  assert.ok(launcherScriptsMatch(harness.fsImpl.files.get(LAUNCHER), GENERATED_LAUNCHER), 'regenerated');
  assert.equal(state.launcherBackupPath, `${LAUNCHER}.bak`);
});

test('enabling over the generated launcher makes no backup', async () => {
  const harness = createHarness();
  harness.fsImpl.files.set(LAUNCHER, GENERATED_LAUNCHER);
  const state = await harness.service.requestEnable();
  assert.equal(harness.fsImpl.files.has(`${LAUNCHER}.bak`), false);
  assert.equal(state.launcherBackupPath, null);
});

test('a launcher that cannot be backed up is not replaced', async () => {
  const harness = createHarness();
  const custom = 'rem mine\r\n';
  harness.fsImpl.files.set(LAUNCHER, custom);
  const write = harness.fsImpl.writeFileSync;
  harness.fsImpl.writeFileSync = (p, contents) => {
    if (String(p).endsWith('.bak')) throw new Error('EACCES');
    write(p, contents);
  };
  const state = await harness.service.requestEnable();
  assert.equal(state.accepted, false);
  assert.equal(harness.fsImpl.files.get(LAUNCHER), custom);
  assert.match(state.lastError, /not replaced/);
  assert.equal(harness.spawns.length, 0, 'no elevation');
});

test('the sweep calls schtasks by full path through the call operator', () => {
  const schtasksPath = 'C:\\Windows\\System32\\schtasks.exe';
  const enable = buildElevationScript({ action: 'enable', xmlPath: 'C:\\Users\\dev\\task.xml', schtasksPath });
  for (const line of enable.split('\r\n').filter((l) => l.includes('/tn'))) {
    assert.ok(line.startsWith(`& "${schtasksPath}" /`), line);
  }
  const disable = buildElevationScript({ action: 'disable', schtasksPath });
  assert.ok(disable.split('\r\n')[0].startsWith(`& "${schtasksPath}" /delete`));
});

// ─── Data and log folders (the ones `oar start` uses) ────────────────────────

test('the boot launcher pins the data and log folders before Node starts', () => {
  const lines = launcherLines({ dataDir: DATA_DIR, logDir: 'C:\\Users\\dev\\100% logs' });
  const dataLine = lines.indexOf(`set "COPILOT_WEB_RELAY_DATA_DIR=${DATA_DIR}"`);
  const logLine = lines.indexOf('set "COPILOT_WEB_RELAY_LOG_DIR=C:\\Users\\dev\\100%% logs"');
  assert.ok(dataLine > 0 && logLine > 0, 'both folders pinned');
  assert.ok(Math.max(dataLine, logLine) < lines.findIndex((line) => line.startsWith(`"${NODE_PATH}"`)));
  assert.ok(!launcherLines().some((line) => line.includes('COPILOT_WEB_RELAY_DATA_DIR')), 'none when none are given');
});

test('enable writes a launcher that starts the relay on the OAR state root, like oar start', async () => {
  const harness = createHarness();
  await harness.service.requestEnable();
  const launcher = String(harness.fsImpl.files.get(LAUNCHER));
  assert.ok(launcher.includes(`set "COPILOT_WEB_RELAY_DATA_DIR=${DATA_DIR}"`), launcher);
  assert.ok(launcher.includes(`set "COPILOT_WEB_RELAY_LOG_DIR=${LOG_DIR}"`), launcher);
  assert.ok(launcherScriptsMatch(launcher, GENERATED_LAUNCHER));
});

test('a launcher an earlier version wrote is brought up to date without an elevation', async () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
  assert.equal(harness.service.refreshInstalledLauncher(), false, 'nothing installed, nothing written');
  assert.ok(!harness.fsImpl.files.has(LAUNCHER));

  harness.fsImpl.files.set(LAUNCHER, EARLIER_LAUNCHER);
  assert.deepEqual((await harness.service.getState()).customisations, ['launcher'], 'reads as changed until refreshed');
  assert.equal(harness.service.refreshInstalledLauncher(), true);
  assert.ok(launcherScriptsMatch(harness.fsImpl.files.get(LAUNCHER), GENERATED_LAUNCHER));
  assert.equal(harness.spawns.length, 0, 'the task runs the launcher file: no re-registration');
  assert.deepEqual((await harness.service.getState()).customisations, []);
  assert.equal(harness.service.refreshInstalledLauncher(), false, 'current already');

  const edited = EARLIER_LAUNCHER.replace(':oar_start', ':oar_start\r\nrem hand-added');
  harness.fsImpl.files.set(LAUNCHER, edited);
  assert.equal(harness.service.refreshInstalledLauncher(), false);
  assert.equal(harness.fsImpl.files.get(LAUNCHER), edited, 'an edited launcher is never overwritten');
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

test('every launcher an earlier version generated is brought up to date; the new one then stays as it is', async () => {
  assert.equal(EARLIER_LAUNCHERS.length, 3);
  assert.ok(EARLIER_LAUNCHER.includes('if %OAR_TEMP_WAIT% geq 120 goto oar_temp_missing'), 'the 120 s form');
  assert.ok(EARLIER_LAUNCHER.includes(`set "COPILOT_WEB_RELAY_DATA_DIR=${DATA_DIR}"`), 'with the pinned folders');
  assert.match(EARLIER_LAUNCHER, /server\.js" & exit \/b\r\n$/, 'and the Node line that dropped its exit code');
  for (const earlier of EARLIER_LAUNCHERS) {
    const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
    harness.fsImpl.files.set(LAUNCHER, earlier);
    assert.equal(harness.service.refreshInstalledLauncher(), true);
    const refreshed = harness.fsImpl.files.get(LAUNCHER);
    assert.ok(launcherScriptsMatch(refreshed, GENERATED_LAUNCHER));
    assert.ok(refreshed.includes('if %OAR_WAIT% geq 300 goto oar_wait_over'));
    assert.match(refreshed, /server\.js" & exit\r\n$/);
    assert.deepEqual((await harness.service.getState()).customisations, []);
    // The next start (after another update, say) leaves it byte for byte.
    assert.equal(harness.service.refreshInstalledLauncher(), false);
    assert.equal(harness.fsImpl.files.get(LAUNCHER), refreshed);
    assert.equal(harness.spawns.length, 0, 'no elevation, no re-registration');
  }
});

test('a launcher that waits for R:\\ its own way, or an edited one, stays byte-identical', () => {
  // The 120 s form, with a wait for the data drive added by hand before cd.
  const lines = EARLIER_LAUNCHER.split('\r\n');
  lines.splice(lines.findIndex((line) => line.startsWith('cd /d ')), 0,
    ':wait_for_r',
    'if not exist "R:\\" (',
    '  "%SystemRoot%\\System32\\ping.exe" -n 6 127.0.0.1 >nul',
    '  goto wait_for_r',
    ')');
  const waitsForR = lines.join('\r\n');
  // Only the limit changed.
  const edited = EARLIER_LAUNCHER.replaceAll('120', '600');
  assert.notEqual(edited, EARLIER_LAUNCHER);
  for (const custom of [waitsForR, edited]) {
    const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
    harness.fsImpl.files.set(LAUNCHER, custom);
    assert.equal(harness.service.refreshInstalledLauncher(), false);
    assert.equal(harness.service.refreshInstalledLauncher(), false);
    assert.equal(harness.fsImpl.files.get(LAUNCHER), custom, 'byte for byte');
  }
});

test('a hand-made launcher that waits before the start line is never rewritten, at any start', () => {
  assert.ok(EARLIER_LAUNCHERS.length >= 2, 'every earlier format is covered');
  for (const script of EARLIER_LAUNCHERS) {
    const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
    const handMade = withWaitLoop(script);
    harness.fsImpl.files.set(LAUNCHER, handMade);
    assert.equal(harness.service.refreshInstalledLauncher(), false);
    // The next start (after an update, say) leaves it alone just the same.
    assert.equal(harness.service.refreshInstalledLauncher(), false);
    assert.equal(harness.fsImpl.files.get(LAUNCHER), handMade, 'byte for byte');
    assert.equal(harness.spawns.length, 0, 'no elevation, no re-registration');
  }
});

test('refreshing the launcher is a no-op off Windows and on an isolated (e2e) relay', () => {
  assert.equal(createWindowsBootAutostartService({ platform: 'linux' }).refreshInstalledLauncher(), false);
  const files = new Map([[LAUNCHER, EARLIER_LAUNCHER]]);
  const service = createWindowsBootAutostartService({
    platform: 'win32',
    env: { ...ENV, COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1' },
    packageRoot: PACKAGE_ROOT,
    nodePath: NODE_PATH,
    configPath: CONFIG_PATH,
    pathImpl: path.win32,
    fsImpl: {
      existsSync: (p) => files.has(String(p)),
      readFileSync: (p) => files.get(String(p)),
      writeFileSync: () => { throw new Error('must not write'); },
    },
  });
  assert.equal(service.refreshInstalledLauncher(), false);
});

test('the boot launchers of 0.9.2 to 0.9.10 (no PATH line, no %TEMP% wait) are repaired too', async () => {
  const oldest = EARLIER_LAUNCHERS.at(-1);
  assert.ok(!oldest.includes('PATH=') && !oldest.includes('OAR_TEMP_WAIT'));
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
  harness.fsImpl.files.set(LAUNCHER, oldest);
  assert.equal(harness.service.refreshInstalledLauncher(), true);
  assert.ok(launcherScriptsMatch(harness.fsImpl.files.get(LAUNCHER), GENERATED_LAUNCHER));
  assert.deepEqual((await harness.service.getState()).customisations, [], 'its own padded file is not customised');
});

test('a launcher of a relay on folders of its own is not repaired automatically', () => {
  const files = new Map([[LAUNCHER, EARLIER_LAUNCHER]]);
  const service = createWindowsBootAutostartService({
    platform: 'win32',
    env: { ...ENV, COPILOT_WEB_RELAY_DATA_DIR: 'D:\\scratch\\data' },
    packageRoot: PACKAGE_ROOT,
    nodePath: NODE_PATH,
    configPath: CONFIG_PATH,
    pathImpl: path.win32,
    fsImpl: {
      existsSync: (p) => files.has(String(p)),
      readFileSync: (p) => files.get(String(p)),
      writeFileSync: () => { throw new Error('must not write'); },
    },
  });
  assert.equal(service.refreshInstalledLauncher(), false);
});

test('a cmd still running an earlier boot launcher reads blanks and exit /b in the new one', () => {
  for (const profile of ['C:\\Users\\dev', 'C:\\Users\\dev-\u00e4\u00f6\u00fc \u6587\u5b57']) {
    const inputs = {
      packageRoot: `${profile}\\AppData\\Roaming\\npm\\node_modules\\@oar-sh\\oar`,
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      configPath: `${profile}\\AppData\\Roaming\\oar\\config.json`,
      workingDirectory: `${profile}\\AppData\\Roaming\\oar`,
      pathImpl: path.win32,
    };
    for (const earlier of buildEarlierBootLauncherScripts(inputs)) {
      const next = buildBootLauncherScript({
        ...inputs,
        dataDir: `${profile}\\AppData\\Roaming\\oar\\data`,
        logDir: `${profile}\\AppData\\Roaming\\oar\\logs`,
        coverBytes: Buffer.byteLength(earlier, 'utf8'),
      });
      assert.match(earlier, /server\.js"( & exit \/b)?\r\n$/, 'the Node line ends the earlier launcher');
      const oldLength = Buffer.byteLength(earlier, 'utf8');
      // Just after the Node line, and after its line break.
      for (const offset of [oldLength - 2, oldLength]) {
        const [line, after] = Buffer.from(next, 'utf8').subarray(offset).toString('utf8').split('\r\n');
        assert.equal(line.trim(), '', `blank at offset ${offset}`);
        assert.equal(after, 'exit /b', `then exit /b at offset ${offset}`);
      }
      const lines = next.split('\r\n');
      assert.deepEqual(lines.slice(0, 4), [...earlier.split('\r\n').slice(0, 3), 'goto oar_begin']);
      assert.ok(lines.at(-2).endsWith('server.js" & exit'));
    }
  }
});

// ─── Real cmd.exe (Windows only) ─────────────────────────────────────────────

// A scratch folder with a dummy server.js that only exits with
// OAR_TEST_EXIT; removed again after `fn`.
function withScratchRelay(fn) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-launcher-run-'));
  try {
    fs.mkdirSync(path.join(scratch, 'pkg', 'server'), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'pkg', 'server', 'server.js'), 'process.exit(Number(process.env.OAR_TEST_EXIT || 0));\n');
    return fn(scratch, {
      packageRoot: path.join(scratch, 'pkg'),
      nodePath: process.execPath,
      dataDir: path.join(scratch, 'data'),
      logDir: path.join(scratch, 'logs'),
      workingDirectory: scratch,
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Writes `script` and runs it the way the task does: cmd.exe /d /c "<file>".
function runBatch(file, script, env = {}) {
  fs.writeFileSync(file, script);
  const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const result = spawnSync(cmd, ['/d', '/c', `"${file}"`], {
    env: scratchEnv(path.dirname(file), env),
    windowsVerbatimArguments: true,
    windowsHide: true,
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('cmd /d /c returns the exit code Node ended the generated launcher with', { skip: process.platform !== 'win32' }, () => {
  withScratchRelay((scratch, inputs) => {
    const launcher = path.join(scratch, BOOT_LAUNCHER_FILENAME);
    assert.equal(runBatch(launcher, buildBootLauncherScript(inputs), { OAR_TEST_EXIT: '3' }).status, 3);
    assert.equal(runBatch(launcher, buildBootLauncherScript(inputs), { OAR_TEST_EXIT: '0' }).status, 0);
    // The form before: `& exit /b` reported 0 whatever Node returned.
    assert.equal(runBatch(launcher, buildEarlierBootLauncherScripts(inputs)[0], { OAR_TEST_EXIT: '3' }).status, 0);
  });
});

test('a TEMP with quotes and a space does not stop the launcher before Node', { skip: process.platform !== 'win32' }, () => {
  withScratchRelay((scratch, inputs) => {
    fs.mkdirSync(path.join(scratch, 'My Temp'));
    const launcher = path.join(scratch, BOOT_LAUNCHER_FILENAME);
    const env = { OAR_TEST_EXIT: '3', TEMP: `"${path.join(scratch, 'My Temp')}"` };
    const run = runBatch(launcher, buildBootLauncherScript(inputs), env);
    assert.equal(run.status, 3, `Node ran and ended the launcher: ${run.output}`);
    assert.ok(!/unexpected/i.test(run.output), run.output);
    assert.ok(!fs.existsSync(path.join(scratch, BOOT_LAUNCHER_LOG_FILENAME)), 'TEMP is there: nothing to log');
    // 0.9.13's wait (`if not "%TEMP%"==""`) stopped right there.
    const before = runBatch(launcher, buildEarlierBootLauncherScripts(inputs)[1], env);
    assert.notEqual(before.status, 3);
    assert.match(before.output, /unexpected/i);
  });
});

test('the wait runs out, logs one line naming both, and goes on', { skip: process.platform !== 'win32' }, () => {
  withScratchRelay((scratch) => {
    const letter = 'QPONMLKJ'.split('').find((candidate) => !fs.existsSync(`${candidate}:\\`));
    assert.ok(letter, 'a free drive letter');
    const log = path.join(scratch, 'wait.log');
    const missingTemp = path.join(scratch, 'not here & gone');
    const script = ['@echo off', ...autostartWaitLines({
      dataDir: `${letter}:\\oar\\data`, logTarget: `"${log}"`, pathImpl: path.win32, waitSeconds: 2,
    }), 'echo went on', ''].join('\r\n');
    const startedAt = Date.now();
    const run = runBatch(path.join(scratch, 'wait.cmd'), script, { TEMP: `"${missingTemp}"` });
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /went on/);
    assert.ok(Date.now() - startedAt >= 1500, 'it waited');
    const lines = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith(
      `Still missing after 2 s: TEMP folder "${missingTemp}" and data drive "${letter}:\\"; starting the relay anyway.`,
    ), lines[0]);
  });
});

test('with no TEMP, the wait for the data drive runs out cleanly, even with & and % in the log path', { skip: process.platform !== 'win32' }, () => {
  withScratchRelay((scratch) => {
    const letter = 'QPONMLKJ'.split('').find((candidate) => !fs.existsSync(`${candidate}:\\`));
    assert.ok(letter, 'a free drive letter');
    const logDir = path.join(scratch, 'Tom & Jerry 100%');
    fs.mkdirSync(logDir);
    const log = path.join(logDir, 'wait.log');
    // TEMP is cleared in the batch: Node puts TEMP back into a child's environment.
    const script = ['@echo off', 'set "TEMP="', ...autostartWaitLines({
      dataDir: `${letter}:\\oar\\data`, logTarget: `"${log.replaceAll('%', '%%')}"`, pathImpl: path.win32, waitSeconds: 1,
    }), 'if defined OAR_TEMP echo OAR_TEMP handed on', 'echo went on', ''].join('\r\n');
    // Not in the '&' folder: cmd /c "<file>" drops the quotes of a path with '&'.
    const run = runBatch(path.join(scratch, 'wait.cmd'), script);
    assert.equal(run.status, 0, run.output);
    assert.equal(run.output.trim(), 'went on', 'no stray command, no error, OAR_TEMP cleared');
    const lines = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].endsWith(`Still missing after 1 s: data drive "${letter}:\\"; starting the relay anyway.`), lines[0]);
    assert.deepEqual(fs.readdirSync(scratch).sort(), ['Tom & Jerry 100%', 'pkg', 'wait.cmd'], 'nothing written elsewhere');
  });
});

test('the launcher a refresh writes keeps the Node the earlier one ran', () => {
  const otherNode = 'C:\\nvm4w\\nodejs\\node.exe';
  // 0.9.11 to 0.9.13, all of it in capitals but the first line.
  const [, earlier] = buildEarlierBootLauncherScripts({
    ...EARLIER_INPUTS, nodePath: otherNode,
  });
  const harness = createHarness();
  harness.fsImpl.files.set(LAUNCHER, earlier.toUpperCase().replace('@ECHO OFF', '@echo off'));
  assert.equal(harness.service.refreshInstalledLauncher(), true, 'paths compare without case');
  const launcher = String(harness.fsImpl.files.get(LAUNCHER));
  assert.ok(launcher.includes('set "PATH=%PATH%;C:\\NVM4W\\NODEJS"'), launcher);
  assert.ok(launcher.includes('"C:\\NVM4W\\NODEJS\\NODE.EXE" "'));
});

test('a repaired launcher that kept its own Node does not read as customised', async () => {
  const otherNode = 'C:\\nvm4w\\nodejs\\node.exe';
  const [earlier] = buildEarlierBootLauncherScripts({
    ...EARLIER_INPUTS, nodePath: otherNode,
  });
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
  harness.fsImpl.files.set(LAUNCHER, earlier);
  assert.equal(harness.service.refreshInstalledLauncher(), true);
  assert.deepEqual((await harness.service.getState()).customisations, []);
});

test('the refresh says whether the launcher it found ran the relay on the package database', () => {
  // 7e1ccfd's padded launcher pinned the data folder; 0.9.13's and 0.9.2's did not.
  for (const [index, pinnedData] of [[0, true], [1, false], [2, false]]) {
    const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
    harness.fsImpl.files.set(LAUNCHER, EARLIER_LAUNCHERS[index]);
    const found = [];
    assert.equal(harness.service.refreshInstalledLauncher({ onEarlierForm: (form) => found.push(form) }), true);
    assert.deepEqual(found, [{ path: LAUNCHER, pinnedData }], `form ${index}`);
  }
  const current = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
  current.fsImpl.files.set(LAUNCHER, GENERATED_LAUNCHER);
  const none = [];
  assert.equal(current.service.refreshInstalledLauncher({ onEarlierForm: (form) => none.push(form) }), false);
  assert.deepEqual(none, [], 'the current launcher is no earlier form');
});

test('with a dataDir in config.json, the boot launcher still pins the state root\'s data folder, as oar start does', () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
  const configured = path.win32.join('D:\\', 'own', 'data');
  harness.fsImpl.files.set(CONFIG_PATH, JSON.stringify({ dataDir: configured }));
  harness.fsImpl.files.set(LAUNCHER, EARLIER_LAUNCHERS[1]);
  assert.equal(harness.service.refreshInstalledLauncher(), true);
  const launcher = String(harness.fsImpl.files.get(LAUNCHER));
  // The folder every launcher of a global install pins (resolveRelayStateDirs).
  const { dataDir } = resolveRelayStateDirs({ packageRoot: PACKAGE_ROOT, env: ENV, platform: 'win32', pathImpl: path.win32, layout: { checkout: false, root: OAR_ROOT, dataDir: DATA_DIR } });
  assert.equal(dataDir, DATA_DIR);
  assert.ok(launcher.includes(`set "COPILOT_WEB_RELAY_DATA_DIR=${DATA_DIR}"`), launcher);
  assert.ok(!launcher.includes(configured));
});
