import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  BOOT_ELEVATION_SCRIPT_FILENAME,
  BOOT_LAUNCHER_FILENAME,
  BOOT_LAUNCHER_LOG_FILENAME,
  BOOT_TASK_NAME,
  BOOT_TEMP_WAIT_SECONDS,
  BOOT_TASK_XML_FILENAME,
  LEGACY_BOOT_TASK_NAME,
  buildBootLauncherScript,
  buildBootTaskXml,
  buildElevationScript,
  classifyTaskXml,
  createWindowsBootAutostartService,
  describeTaskCustomisations,
  encodeTaskXml,
  launcherScriptsMatch,
  parseSidFromWhoami,
  parseTaskXml,
} from './windows-boot-autostart-service.mjs';

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
  assert.ok(lines.includes(`"${NODE_PATH}" "${PACKAGE_ROOT}\\server\\server.js"`));
  assert.ok(!lines.some((line) => line.includes('COPILOT_WEB_RELAY_NODE')));
});

test('the boot launcher escapes % in the Node folder', () => {
  const lines = launcherLines({ nodePath: 'C:\\Users\\dev\\100% node\\node.exe' });
  assert.ok(lines.includes('set "PATH=%PATH%;C:\\Users\\dev\\100%% node"'));
});

test('the boot launcher waits for %TEMP% before cd and Node, and logs a wait that ran out', () => {
  const lines = launcherLines();
  const at = (prefix) => lines.findIndex((line) => line.startsWith(prefix));
  // No TEMP: no wait at all.
  assert.ok(lines.includes('if "%TEMP%"=="" goto oar_start'));
  assert.ok(lines.includes('if exist "%TEMP%\\" goto oar_start'));
  assert.ok(lines.includes(`if %OAR_TEMP_WAIT% geq ${BOOT_TEMP_WAIT_SECONDS} goto oar_temp_missing`));
  assert.equal(BOOT_TEMP_WAIT_SECONDS, 120);
  // About a second a round, by full path (an early boot's PATH may lack System32).
  assert.ok(lines.includes('"%SystemRoot%\\System32\\ping.exe" -n 2 127.0.0.1 >nul'));
  const logLine = lines.find((line) => line.startsWith('echo '));
  assert.ok(logLine.endsWith(`>>"%~dp0${BOOT_LAUNCHER_LOG_FILENAME}"`), 'one line next to the launcher');
  assert.ok(logLine.includes('"%TEMP%"'));
  // Generic: no drive letter of any one machine.
  assert.ok(!lines.some((line) => /\b[A-Z]:\\temp/i.test(line)));
  // Order: the wait, then (whatever happened) cd and Node; the counter is not
  // handed on to the relay.
  assert.ok(at('if "%TEMP%"') < at(':oar_wait_temp'));
  assert.ok(at(':oar_temp_missing') < at(':oar_start'));
  assert.equal(lines[at(':oar_start') + 1], 'set "OAR_TEMP_WAIT="');
  assert.ok(at(':oar_start') < at('cd /d '));
  assert.ok(at('cd /d ') < at(`"${NODE_PATH}"`));
});

// ─── Customised task or launcher ─────────────────────────────────────────────

const GENERATED_TASK_XML = buildBootTaskXml({ sid: SID, launcherPath: LAUNCHER, packageRoot: PACKAGE_ROOT, workingDirectory: OAR_ROOT });
const GENERATED_LAUNCHER = buildBootLauncherScript({
  packageRoot: PACKAGE_ROOT, nodePath: NODE_PATH, configPath: CONFIG_PATH, workingDirectory: OAR_ROOT, pathImpl: path.win32,
});

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
