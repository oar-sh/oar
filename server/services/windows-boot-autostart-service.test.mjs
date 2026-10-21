import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
  buildElevationCommand,
  buildElevationScript,
  buildTaskExportCommand,
  classifyTaskXml,
  createWindowsBootAutostartService,
  describeHandMade,
  describeTaskCustomisations,
  describeWindowsAutostart,
  handMadeLines,
  switchBlockers,
  encodeTaskXml,
  launcherScriptsMatch,
  SWEEP_FAILED_EXIT_CODE,
  parseSidFromWhoami,
  parseUserFromWhoami,
  psLiteral,
  parseTaskXml,
} from './windows-boot-autostart-service.mjs';
import {
  AUTOSTART_WAIT_SECONDS,
  autostartWaitLines,
  buildEarlierWindowsAutostartScripts,
  buildWindowsAutostartScript,
  dataDriveRoot,
} from './windows-autostart-service.mjs';
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
// The account whoami names in the harness.
const USER = { name: 'host\\dev', sid: SID };
const OAR_ROOT = path.win32.join(APPDATA, 'oar');
// Where Task Scheduler keeps the tasks (no SystemRoot in ENV: the default).
const TASKS_DIR = 'C:\\Windows\\System32\\Tasks';
const LAUNCHER = path.win32.join(OAR_ROOT, BOOT_LAUNCHER_FILENAME);
// How getState() lists the tasks OAR did not make.
const OWN_TASK_ENTRY = { path: `scheduled task \\${BOOT_TASK_NAME}`, task: BOOT_TASK_NAME, otherInstall: null };
const LEGACY_TASK_ENTRY = { path: `scheduled task \\${LEGACY_BOOT_TASK_NAME}`, task: LEGACY_BOOT_TASK_NAME, otherInstall: null };
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

test('the enable sweep deletes the legacy task first, and a failed create fails the sweep', () => {
  const script = buildElevationScript({ action: 'enable', xmlPath: 'C:\\Users\\dev\\task.xml' });
  const lines = script.split('\r\n');
  assert.equal(lines[0], '$failed = $false');
  assert.ok(lines[1].includes(`/delete /tn '${LEGACY_BOOT_TASK_NAME}'`), 'legacy task removed first');
  assert.ok(lines[3].includes(`/create /tn '${BOOT_TASK_NAME}' /xml 'C:\\Users\\dev\\task.xml'`));
  assert.equal(lines[4], 'if ($LASTEXITCODE -ne 0) { $failed = $true }', 'the create result is the sweep result');
  assert.ok(script.includes(`exit ${SWEEP_FAILED_EXIT_CODE}`));
});

test('the disable sweep removes our task, never the hand-made pre-rebrand one, and fails while it is still there', () => {
  const script = buildElevationScript({ action: 'disable' });
  assert.ok(script.includes(`/delete /tn '${BOOT_TASK_NAME}'`));
  assert.ok(script.includes(`/query /tn '${BOOT_TASK_NAME}' *>$null`));
  assert.ok(!script.includes(LEGACY_BOOT_TASK_NAME));
  assert.ok(script.endsWith('exit 0\r\n'));
  assert.throws(() => buildElevationScript({ action: 'oops' }), /Unknown/);
});

test('a failed sweep puts back each task it deleted from its copy', () => {
  const restore = [{ task: BOOT_TASK_NAME, xml: 'C:\\oar\\oar-relay.task.xml.bak' }];
  const script = buildElevationScript({ action: 'enable', xmlPath: 'C:\\oar\\task.xml', restore });
  const failure = script.slice(script.indexOf('if ($failed) {'));
  assert.ok(failure.includes(`/query /tn '${BOOT_TASK_NAME}' *>$null`));
  assert.ok(failure.includes(`/create /tn '${BOOT_TASK_NAME}' /xml 'C:\\oar\\oar-relay.task.xml.bak' /f`));
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

// What schtasks writes into a pipe (code page 437 here), read as UTF-8: ü is
// a byte that is no UTF-8 (U+FFFD), Ł its look-alike L, anything else `?`.
function oemPipe(text) {
  return String(text).replace(/[^\x00-\x7f]/g, (char) => ({ '\u00fc': '\ufffd', '\u0141': 'L' })[char] ?? '?');
}

// `control.exportFails`: the PowerShell export fails (or a function of the
// task name and the export's number says so); `control.gates[name]`: a
// promise each export of that task waits for. `exports` lists each one started.
// `control.queryFails(name)`: what schtasks /query returns instead, or null;
// `control.taskFileErrors[name]`: the code a stat of its task file throws.
// A task in `tasks` has its file under System32\Tasks (TASKS_DIR).
function createHarness({ tasks = {}, whoamiSid = SID, schtasksStartError = null, logs = [], spawn: spawnOverride = null, env = ENV, control = {} } = {}) {
  const fsImpl = createFakeFs();
  fsImpl.statSync = (p) => {
    const file = String(p);
    const task = file.startsWith(`${TASKS_DIR}\\`) ? file.slice(TASKS_DIR.length + 1) : null;
    if (task && control.taskFileErrors?.[task]) throw Object.assign(new Error(`${control.taskFileErrors[task]}: ${file}`), { code: control.taskFileErrors[task] });
    if (task ? tasks[task] != null : fsImpl.files.has(file)) return {};
    throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  };
  const timers = createManualTimers();
  const spawns = [];
  const exports = [];
  const service = createWindowsBootAutostartService({
    platform: 'win32',
    env,
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
        const failed = control.queryFails?.(name);
        if (failed) return failed;
        const xml = tasks[name];
        return xml != null ? { code: 0, stdout: oemPipe(xml), stderr: '' } : { code: 1, stdout: '', stderr: 'not found' };
      }
      if (file === 'powershell.exe' && args.at(-2) === '-Command' && args.at(-1).includes('Export-ScheduledTask')) {
        const name = args.at(-1).match(/-TaskName '((?:[^']|'')*)'/)[1].replaceAll("''", "'");
        exports.push(name);
        if (control.gates?.[name]) await control.gates[name];
        const fails = typeof control.exportFails === 'function' ? control.exportFails(name, exports.length) : control.exportFails;
        if (fails) return { code: 1, stdout: '', stderr: 'Export-ScheduledTask : Access is denied.' };
        const xml = tasks[name];
        return xml != null ? { code: 0, stdout: xml, stderr: '' } : { code: 1, stdout: '', stderr: 'Export-ScheduledTask : The system cannot find the file specified.' };
      }
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    },
    spawnImpl: (file, args, options) => {
      const child = spawnOverride ? spawnOverride(file, args, options) : createFakeChild();
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
  return { service, fsImpl, timers, spawns, tasks, logs, exports, control };
}

const DECLINED = 1223;

// The sweep a request handed to the elevated PowerShell (its -EncodedCommand).
function sweepOf(harness, index = 0) {
  const encoded = harness.spawns[index].args.join(' ').match(/-EncodedCommand ([A-Za-z0-9+/=]+)'/)[1];
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

// Answers the administrator prompt (the elevated shell's exit code) and lets
// the service settle: it checks the tasks before it reports.
async function answer(harness, code, index = 0) {
  harness.spawns[index].child.emit('close', code);
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
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
  assert.ok(sweepOf(harness).includes('/create'));
  assert.equal(harness.fsImpl.files.has(path.win32.join(OAR_ROOT, BOOT_ELEVATION_SCRIPT_FILENAME)), false, 'no record before the prompt is answered');

  assert.equal(harness.spawns.length, 1);
  const spawnCall = harness.spawns[0];
  assert.equal(spawnCall.file, 'powershell.exe');
  const command = spawnCall.args.join(' ');
  assert.ok(command.includes('-Verb RunAs'), 'elevation goes through UAC, never silently');
  const encoded = command.match(/-EncodedCommand ([A-Za-z0-9+/=]+)'/)[1];
  assert.match(Buffer.from(encoded, 'base64').toString('utf16le'), /\/create \/tn 'oar-relay'/, 'the sweep travels encoded, no file path to quote');
});

test('a confirmed enable clears pending and removes both generated sign-in autostart entries', async () => {
  const harness = createHarness();
  const startupDir = path.win32.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  harness.fsImpl.files.set(path.win32.join(startupDir, 'oar-web-relay.cmd'), GENERATED_SIGNIN_ENTRY);
  harness.fsImpl.files.set(path.win32.join(startupDir, 'copilot-remote-web-relay.cmd'), PRE_REBRAND_SIGNIN_ENTRY);
  const settled = [];
  await harness.service.requestEnable({ onSettled: (ok, extra) => settled.push([ok, extra]) });
  harness.tasks[BOOT_TASK_NAME] = OWN_TASK_XML; // what the sweep just registered
  await answer(harness, 0);
  const state = await harness.service.getState();
  assert.equal(state.pendingElevation, null);
  assert.equal(state.lastError, null);
  assert.equal(state.taskStatus, 'ready');
  assert.ok(!harness.fsImpl.files.has(path.win32.join(startupDir, 'oar-web-relay.cmd')));
  assert.ok(!harness.fsImpl.files.has(path.win32.join(startupDir, 'copilot-remote-web-relay.cmd')));
  assert.deepEqual(settled, [[true, { kept: [], copies: [] }]], 'the caller learns when the prompt was answered');
});

test('a confirmed enable leaves a hand-made sign-in entry byte-identical and names it', async () => {
  const harness = createHarness();
  const entry = path.win32.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'oar-web-relay.cmd');
  const handMade = GENERATED_SIGNIN_ENTRY.replace('cd /d', 'rem mine\r\ncd /d');
  harness.fsImpl.files.set(entry, handMade);
  const settled = [];
  await harness.service.requestEnable({ onSettled: (ok, extra) => settled.push([ok, extra]) });
  harness.tasks[BOOT_TASK_NAME] = OWN_TASK_XML;
  await answer(harness, 0);
  assert.equal(harness.fsImpl.files.get(entry), handMade);
  assert.deepEqual(settled, [[true, { kept: [entry], copies: [] }]]);
});

test('a declined UAC surfaces the manual command instead of hanging', async () => {
  const harness = createHarness();
  await harness.service.requestEnable();
  await answer(harness, DECLINED);
  const state = await harness.service.getState();
  assert.equal(state.pendingElevation, null);
  assert.match(state.lastError, /declined; nothing was changed/);
  assert.equal(harness.fsImpl.files.has(LAUNCHER), false, 'the launcher written for it is gone again');
  assert.equal(harness.fsImpl.files.has(path.win32.join(OAR_ROOT, BOOT_TASK_XML_FILENAME)), false);
  assert.equal(harness.fsImpl.files.has(path.win32.join(OAR_ROOT, BOOT_ELEVATION_SCRIPT_FILENAME)), false);
  assert.ok(state.manualCommand.includes('/create'));
});

test('an elevation that never returns is timed out and the shell killed', async () => {
  const harness = createHarness();
  await harness.service.requestEnable();
  harness.timers.fire(120_000);
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
  const state = await harness.service.getState();
  assert.equal(state.pendingElevation, null);
  assert.match(state.lastError, /no answer at the administrator prompt within 2 minutes/);
  assert.deepEqual(harness.spawns[0].child.killed, ['SIGTERM']);
  // The late close from the killed child must not clobber the timeout verdict.
  await answer(harness, 0);
  assert.match((await harness.service.getState()).lastError, /within 2 minutes/);
});

test('a second request while one elevation is pending is refused, not queued', async () => {
  const harness = createHarness();
  await harness.service.requestEnable();
  const second = await harness.service.requestEnable();
  assert.equal(second.accepted, false);
  assert.equal(harness.spawns.length, 1, 'no second UAC prompt');
});

test('a confirmed disable removes the generated launcher and reports missing', async () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
  harness.fsImpl.files.set(LAUNCHER, GENERATED_LAUNCHER);
  const settled = [];
  const state = await harness.service.requestDisable({ onSettled: (ok) => settled.push(ok) });
  assert.equal(state.accepted, true);
  assert.ok(sweepOf(harness).includes('/delete'));
  delete harness.tasks[BOOT_TASK_NAME];
  await answer(harness, 0);
  const after = await harness.service.getState();
  assert.equal(after.taskStatus, 'missing');
  assert.ok(!harness.fsImpl.files.has(LAUNCHER), 'launcher cleaned up with the task');
  assert.deepEqual(settled, [true]);
});

test('leaving boot mode never deletes a customised task or a hand-edited launcher, and elevates nothing (#57)', async () => {
  const edited = GENERATED_LAUNCHER.replace(':oar_start', ':oar_start\r\nrem waits for my drive');
  const cases = [
    { xml: GENERATED_TASK_XML, launcher: edited, handMade: [{ path: LAUNCHER, task: null, otherInstall: null }] },
    { xml: GENERATED_TASK_XML.replace('      <Delay>PT30S</Delay>\r\n', ''), launcher: GENERATED_LAUNCHER, handMade: [OWN_TASK_ENTRY] },
    { xml: FOREIGN_TASK_XML, launcher: null, handMade: [OWN_TASK_ENTRY] },
  ];
  for (const { xml, launcher, handMade } of cases) {
    const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: xml } });
    if (launcher) harness.fsImpl.files.set(LAUNCHER, launcher);
    const state = await harness.service.requestDisable();
    assert.equal(state.accepted, false);
    assert.equal(state.generated, false);
    assert.deepEqual(state.handMade, handMade);
    assert.equal(harness.spawns.length, 0, 'no elevation, no delete');
    assert.equal(harness.fsImpl.files.get(LAUNCHER) ?? null, launcher, 'the launcher is byte-identical');
  }
});

test('a launcher an earlier version generated is OAR\'s own: leaving boot mode removes it; the pre-rebrand task stays', async () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML, [LEGACY_BOOT_TASK_NAME]: FOREIGN_TASK_XML } });
  harness.fsImpl.files.set(LAUNCHER, EARLIER_LAUNCHER);
  const state = await harness.service.requestDisable();
  assert.equal(state.generated, true);
  assert.deepEqual(state.handMade, [LEGACY_TASK_ENTRY]);
  assert.equal(state.accepted, true);
  delete harness.tasks[BOOT_TASK_NAME];
  await answer(harness, 0);
  assert.ok(!harness.fsImpl.files.has(LAUNCHER));
});

test('a launcher edited while the prompt is open is kept', async () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
  harness.fsImpl.files.set(LAUNCHER, GENERATED_LAUNCHER);
  await harness.service.requestDisable();
  harness.fsImpl.files.set(LAUNCHER, 'rem mine\r\n');
  delete harness.tasks[BOOT_TASK_NAME];
  await answer(harness, 0);
  assert.equal(harness.fsImpl.files.get(LAUNCHER), 'rem mine\r\n');
});

test('a declined disable is reported to the caller, and nothing is removed', async () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
  harness.fsImpl.files.set(LAUNCHER, GENERATED_LAUNCHER);
  const settled = [];
  await harness.service.requestDisable({ onSettled: (ok) => settled.push(ok) });
  await answer(harness, DECLINED);
  assert.deepEqual(settled, [false]);
  assert.equal(harness.fsImpl.files.get(LAUNCHER), GENERATED_LAUNCHER);
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
// The sign-in entries OAR generates and generated for the same install.
const GENERATED_SIGNIN_ENTRY = buildWindowsAutostartScript({ ...EARLIER_INPUTS, pathImpl: path.win32 });
const PRE_REBRAND_SIGNIN_ENTRY = buildEarlierWindowsAutostartScripts({ ...EARLIER_INPUTS, pathImpl: path.win32 }).at(-1);

test('a generated task has no customisations; schtasks export noise does not count', () => {
  assert.deepEqual(describeTaskCustomisations(GENERATED_TASK_XML, { launcherPath: LAUNCHER, workingDirectory: OAR_ROOT }), []);
  // What Task Scheduler adds on export: its defaults, the least run level.
  const exported = GENERATED_TASK_XML
    .replace('<LogonType>S4U</LogonType>', '<LogonType>S4U</LogonType>\r\n      <RunLevel>LeastPrivilege</RunLevel>')
    .replace('<Delay>PT30S</Delay>', '<Enabled>true</Enabled>\r\n      <Delay>PT30S</Delay>')
    .replace('<StartWhenAvailable>', '<IdleSettings>\r\n      <StopOnIdleEnd>true</StopOnIdleEnd>\r\n      <RestartOnIdle>false</RestartOnIdle>\r\n    </IdleSettings>\r\n    <Priority>7</Priority>\r\n    <StartWhenAvailable>')
    .replace('<StartWhenAvailable>', '<Enabled>true</Enabled>\r\n    <StartWhenAvailable>')
    .replace(`/d /c "${LAUNCHER}"`, `/d /c &quot;${LAUNCHER}&quot;`);
  assert.deepEqual(describeTaskCustomisations(exported, { launcherPath: LAUNCHER, workingDirectory: OAR_ROOT, user: USER }), []);
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

test('enabling over a hand-edited launcher is refused, with the message oar autostart prints', async () => {
  const harness = createHarness();
  const custom = GENERATED_LAUNCHER.replace(':oar_start', ':oar_start\r\nrem hand-added');
  harness.fsImpl.files.set(LAUNCHER, custom);
  const state = await harness.service.requestEnable();
  assert.equal(state.accepted, false);
  assert.match(state.refused, /^Nothing changed: .* oar autostart boot --replace\. Left as it is: .*oar-web-relay-launcher\.cmd \(hand-made\)\.$/);
  assert.equal(harness.fsImpl.files.get(LAUNCHER), custom, 'byte-identical');
  assert.equal(harness.fsImpl.files.has(`${LAUNCHER}.bak`), false);
  assert.equal(harness.spawns.length, 0, 'no elevation');
});

test('a foreign or pre-rebrand task is never replaced by enabling, without replace', async () => {
  for (const tasks of [{ [BOOT_TASK_NAME]: FOREIGN_TASK_XML }, { [LEGACY_BOOT_TASK_NAME]: FOREIGN_TASK_XML }]) {
    const harness = createHarness({ tasks });
    const state = await harness.service.requestEnable();
    assert.equal(state.accepted, false);
    assert.equal(harness.spawns.length, 0);
    assert.equal(harness.fsImpl.files.has(LAUNCHER), false, 'nothing written');
  }
});

test('enabling with replace keeps a copy of a changed launcher beside it and reports where', async () => {
  const harness = createHarness();
  const custom = GENERATED_LAUNCHER.replace(':oar_start', ':oar_start\r\nrem hand-added');
  harness.fsImpl.files.set(LAUNCHER, custom);
  const settled = [];
  const state = await harness.service.requestEnable({ replace: true, onSettled: (ok, extra) => settled.push([ok, extra]) });
  assert.equal(state.accepted, true);
  assert.equal(harness.fsImpl.files.get(`${LAUNCHER}.bak`), custom);
  assert.ok(launcherScriptsMatch(harness.fsImpl.files.get(LAUNCHER), GENERATED_LAUNCHER), 'regenerated');
  assert.equal(state.launcherBackupPath, `${LAUNCHER}.bak`);
  harness.tasks[BOOT_TASK_NAME] = OWN_TASK_XML;
  await answer(harness, 0);
  assert.deepEqual(settled, [[true, { kept: [], copies: [{ path: LAUNCHER, backup: `${LAUNCHER}.bak`, task: null, generated: false }] }]]);

  // An earlier copy is never written over.
  const again = createHarness();
  again.fsImpl.files.set(LAUNCHER, custom);
  again.fsImpl.files.set(`${LAUNCHER}.bak`, 'an earlier copy');
  await again.service.requestEnable({ replace: true });
  assert.equal(again.fsImpl.files.get(`${LAUNCHER}.bak`), 'an earlier copy');
  assert.equal(again.fsImpl.files.get(`${LAUNCHER}.bak-2`), custom);
});

test('enabling with replace keeps the XML of a foreign and a pre-rebrand task, and drops the copies when the prompt is declined', async () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: FOREIGN_TASK_XML, [LEGACY_BOOT_TASK_NAME]: OWN_TASK_XML } });
  const ownCopy = path.win32.join(OAR_ROOT, `${BOOT_TASK_NAME}.task.xml.bak`);
  const legacyCopy = path.win32.join(OAR_ROOT, `${LEGACY_BOOT_TASK_NAME}.task.xml.bak`);
  await harness.service.requestEnable({ replace: true });
  const copy = harness.fsImpl.files.get(ownCopy);
  assert.deepEqual([copy[0], copy[1]], [0xff, 0xfe], 'UTF-16 as schtasks /create /xml takes it back');
  assert.equal(copy.subarray(2).toString('utf16le'), FOREIGN_TASK_XML);
  assert.ok(harness.fsImpl.files.has(legacyCopy));
  await answer(harness, DECLINED);
  assert.equal(harness.fsImpl.files.has(ownCopy), false);
  assert.equal(harness.fsImpl.files.has(legacyCopy), false);
});

test('leaving boot mode with replace copies the hand-made task and launcher first, then deletes them, the pre-rebrand task too', async () => {
  const harness = createHarness({ tasks: {
    [BOOT_TASK_NAME]: GENERATED_TASK_XML.replace('      <Delay>PT30S</Delay>\r\n', ''),
    [LEGACY_BOOT_TASK_NAME]: FOREIGN_TASK_XML,
  } });
  const custom = 'rem mine\r\n';
  harness.fsImpl.files.set(LAUNCHER, custom);
  const settled = [];
  assert.equal((await harness.service.requestDisable()).accepted, false, 'not without replace');
  const state = await harness.service.requestDisable({ replace: true, onSettled: (ok, extra) => settled.push([ok, extra]) });
  assert.equal(state.accepted, true);
  const script = sweepOf(harness);
  assert.ok(script.includes(`/delete /tn '${BOOT_TASK_NAME}'`) && script.includes(`/delete /tn '${LEGACY_BOOT_TASK_NAME}'`));
  delete harness.tasks[BOOT_TASK_NAME];
  delete harness.tasks[LEGACY_BOOT_TASK_NAME];
  await answer(harness, 0);
  assert.equal(harness.fsImpl.files.has(LAUNCHER), false);
  assert.equal(harness.fsImpl.files.get(`${LAUNCHER}.bak`), custom);
  assert.deepEqual(settled[0][1].copies.map((copy) => copy.path), [OWN_TASK_ENTRY.path, LEGACY_TASK_ENTRY.path, LAUNCHER]);
});

test('a hand-made launcher no task runs is replaced without an elevation; one of another install is named', async () => {
  const harness = createHarness();
  const otherRoot = 'C:\\Users\\dev\\old-prefix\\oar';
  const stray = buildBootLauncherScript({ ...EARLIER_INPUTS, packageRoot: otherRoot });
  harness.fsImpl.files.set(LAUNCHER, stray);
  assert.deepEqual((await harness.service.getState()).handMade, [{ path: LAUNCHER, task: null, otherInstall: otherRoot }]);
  const settled = [];
  const state = await harness.service.requestDisable({ replace: true, onSettled: (ok) => settled.push(ok) });
  assert.equal(state.accepted, true);
  assert.equal(harness.spawns.length, 0);
  assert.deepEqual(settled, [true]);
  assert.equal(harness.fsImpl.files.has(LAUNCHER), false);
  assert.equal(harness.fsImpl.files.get(`${LAUNCHER}.bak`), stray);
});

test('the command line and the web UI read one mode and the same blockers out of both services', () => {
  const signinEntries = [{ path: 'C:\\Startup\\oar-web-relay.cmd', generated: false, otherInstall: 'C:\\old\\oar' }];
  const boot = { taskStatus: 'ready', taskName: BOOT_TASK_NAME, launcherPath: LAUNCHER, handMade: [{ path: LAUNCHER, task: null, otherInstall: null }] };
  const now = describeWindowsAutostart({ signinEntries, boot });
  assert.equal(now.mode, 'boot');
  assert.deepEqual(now.entries.map((entry) => [entry.mode, entry.path, entry.generated]), [
    ['signin', 'C:\\Startup\\oar-web-relay.cmd', false],
    ['boot', OWN_TASK_ENTRY.path, true],
    ['boot', LAUNCHER, false],
  ]);
  assert.deepEqual(switchBlockers(now, 'boot').map((entry) => entry.path), ['C:\\Startup\\oar-web-relay.cmd']);
  assert.deepEqual(switchBlockers(now, 'off').map((entry) => entry.path), ['C:\\Startup\\oar-web-relay.cmd', LAUNCHER]);
  assert.equal(describeHandMade(signinEntries[0]), 'C:\\Startup\\oar-web-relay.cmd (hand-made: it starts the OAR install in C:\\old\\oar)');
  assert.match(handMadeLines(switchBlockers(now, 'signin'), 'signin')[0], /oar autostart signin --replace\.$/);
  assert.equal(describeWindowsAutostart({ boot: { readError: 'x' } }).mode, 'unknown');
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
  const state = await harness.service.requestEnable({ replace: true });
  assert.equal(state.accepted, false);
  assert.equal(harness.fsImpl.files.get(LAUNCHER), custom);
  assert.match(state.lastError, /Could not keep a copy .* nothing was changed/);
  assert.equal(harness.spawns.length, 0, 'no elevation');
});

test('the sweep calls schtasks by full path through the call operator', () => {
  const schtasksPath = 'C:\\Windows\\System32\\schtasks.exe';
  const enable = buildElevationScript({ action: 'enable', xmlPath: 'C:\\Users\\dev\\task.xml', schtasksPath });
  for (const line of enable.split('\r\n').filter((l) => l.includes('/tn'))) {
    assert.ok(line.trim().startsWith(`& '${schtasksPath}' /`), line);
  }
  const disable = buildElevationScript({ action: 'disable', schtasksPath });
  assert.ok(disable.split('\r\n')[1].startsWith(`& '${schtasksPath}' /delete`));
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

// ─── Only the task OAR registers is OAR's: every field, the account, failures ─

const HAND_EDITED_TASKS = {
  'run with highest privileges': [GENERATED_TASK_XML.replace('<LogonType>S4U</LogonType>', '<LogonType>S4U</LogonType>\r\n      <RunLevel>HighestAvailable</RunLevel>'), 'run-level'],
  'a second action': [GENERATED_TASK_XML.replace('</Exec>', '</Exec>\r\n    <Exec>\r\n      <Command>C:\\Users\\dev\\other.exe</Command>\r\n    </Exec>'), 'action'],
  'a second trigger': [GENERATED_TASK_XML.replace('</BootTrigger>', '</BootTrigger>\r\n    <LogonTrigger>\r\n      <Enabled>true</Enabled>\r\n    </LogonTrigger>'), 'trigger'],
  'another account': [GENERATED_TASK_XML.replace(`<UserId>${SID}</UserId>`, '<UserId>S-1-5-21-9-9-9-500</UserId>'), 'user'],
  'another setting': [GENERATED_TASK_XML.replace('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>', '<ExecutionTimeLimit>PT72H</ExecutionTimeLimit>'), 'settings'],
};

test('a task edited by hand in any field that matters is no generated task', () => {
  assert.deepEqual(describeTaskCustomisations(GENERATED_TASK_XML, { launcherPath: LAUNCHER, workingDirectory: OAR_ROOT, user: USER }), []);
  assert.deepEqual(describeTaskCustomisations(GENERATED_TASK_XML.replace(SID, 'host\\dev'), { launcherPath: LAUNCHER, workingDirectory: OAR_ROOT, user: USER }), [], 'the account by name');
  for (const [what, [xml, name]] of Object.entries(HAND_EDITED_TASKS)) {
    assert.ok(describeTaskCustomisations(xml, { launcherPath: LAUNCHER, workingDirectory: OAR_ROOT, user: USER }).includes(name), what);
  }
  assert.deepEqual(describeTaskCustomisations('<Task><Actions>', { launcherPath: LAUNCHER }), ['unreadable']);
  assert.ok(describeTaskCustomisations(GENERATED_TASK_XML, { launcherPath: LAUNCHER, workingDirectory: OAR_ROOT, user: null }).includes('user'), 'an account that cannot be told is no proof');
  assert.deepEqual(parseUserFromWhoami('"User Name","SID"\r\n"host\\dev","S-1-5-21-1-2-3-1001"\r\n'), { name: 'host\\dev', sid: 'S-1-5-21-1-2-3-1001' });
});

test('leaving boot mode never deletes a task edited in any of those ways; --replace keeps its exported XML first', async () => {
  for (const [what, [xml]] of Object.entries(HAND_EDITED_TASKS)) {
    const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: xml } });
    harness.fsImpl.files.set(LAUNCHER, GENERATED_LAUNCHER);
    const state = await harness.service.requestDisable();
    assert.equal(state.generated, false, what);
    assert.deepEqual(state.handMade, [OWN_TASK_ENTRY], what);
    assert.equal(state.accepted, false, what);
    assert.equal(harness.spawns.length, 0, `${what}: no elevation, no delete`);

    const replaced = await harness.service.requestDisable({ replace: true });
    assert.equal(replaced.accepted, true, what);
    const copy = harness.fsImpl.files.get(path.win32.join(OAR_ROOT, `${BOOT_TASK_NAME}.task.xml.bak`));
    assert.equal(copy.subarray(2).toString('utf16le'), xml, `${what}: the copy is the task as exported`);
  }
});

test('a sweep that fails is no decline: the launcher goes back, and every copy stays for the tasks it put back', async () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: FOREIGN_TASK_XML } });
  const ownCopy = path.win32.join(OAR_ROOT, `${BOOT_TASK_NAME}.task.xml.bak`);
  const settled = [];
  await harness.service.requestEnable({ replace: true, onSettled: (ok, extra) => settled.push([ok, extra]) });
  const script = sweepOf(harness);
  assert.ok(script.includes(`/create /tn '${BOOT_TASK_NAME}' /xml '${ownCopy}' /f`), 'the sweep puts the task back from its copy');
  await answer(harness, SWEEP_FAILED_EXIT_CODE);
  assert.ok(harness.fsImpl.files.has(ownCopy), 'the copy stays');
  assert.equal(harness.fsImpl.files.has(LAUNCHER), false, 'the launcher is as it was (none)');
  const [[ok, extra]] = settled;
  assert.equal(ok, false);
  assert.equal(extra.declined, false);
  assert.match(extra.error, /could not be registered \(schtasks failed\)\. Afterwards: scheduled task \\oar-relay is registered\. Copies kept: .*oar-relay\.task\.xml\.bak/);
  assert.deepEqual(extra.copies.map((copy) => copy.backup), [ownCopy]);

  // Confirmed, but the task is not there afterwards: no copy goes either.
  const unverified = createHarness({ tasks: { [BOOT_TASK_NAME]: FOREIGN_TASK_XML } });
  await unverified.service.requestEnable({ replace: true });
  delete unverified.tasks[BOOT_TASK_NAME];
  await answer(unverified, 0);
  assert.ok(unverified.fsImpl.files.has(ownCopy));
  assert.match((await unverified.service.getState()).lastError, /it is not registered afterwards\)\. Afterwards: scheduled task \\oar-relay is not registered\./);

  // A failed disable keeps the task's copy and the launcher.
  const disable = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
  disable.fsImpl.files.set(LAUNCHER, GENERATED_LAUNCHER);
  await disable.service.requestDisable();
  await answer(disable, SWEEP_FAILED_EXIT_CODE);
  assert.equal(disable.fsImpl.files.get(LAUNCHER), GENERATED_LAUNCHER);
  assert.ok(disable.fsImpl.files.has(ownCopy));
});

test('the copy of a generated task goes only once the new one is verified in place', async () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
  const ownCopy = path.win32.join(OAR_ROOT, `${BOOT_TASK_NAME}.task.xml.bak`);
  await harness.service.requestEnable();
  assert.ok(harness.fsImpl.files.has(ownCopy), 'copied before the sweep deletes it');
  await answer(harness, 0);
  assert.equal(harness.fsImpl.files.has(ownCopy), false, 'registered again: the copy of a generated task goes');
});

test('every path in the sweep and the command is a PowerShell literal', () => {
  for (const [value, literal] of [
    ["C:\\Users\\John Smith\\oar", "'C:\\Users\\John Smith\\oar'"],
    ["C:\\Users\\O'Brien\\oar", "'C:\\Users\\O''Brien\\oar'"],
    ['C:\\Users\\O\u2019Brien\\oar', "'C:\\Users\\O\u2019\u2019Brien\\oar'"],
    ['C:\\Users\\J\u00fcrgen $env:x `n &%\\oar', "'C:\\Users\\J\u00fcrgen $env:x `n &%\\oar'"],
  ]) {
    assert.equal(psLiteral(value), literal);
  }
  const command = buildElevationCommand({ powershellPath: "C:\\Win'dows\\powershell.exe", script: 'exit 0' });
  assert.ok(command.includes("-FilePath 'C:\\Win''dows\\powershell.exe' -Verb RunAs"));
  assert.ok(command.includes(`-EncodedCommand ${Buffer.from('exit 0', 'utf16le').toString('base64')}'`));
});

test('the sweep reaches schtasks with paths as they are: a space, an apostrophe, non-ASCII, & % $ and a backtick', { skip: process.platform !== 'win32' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-sweep-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const odd = path.join(root, "John Smith O'Brien J\u00fcrgen \u2019 & %TEMP% $x `n");
  fs.mkdirSync(odd);
  const log = path.join(odd, 'calls.log');
  const xml = path.join(odd, 'task.xml');
  const copy = path.join(odd, 'oar-relay.task.xml.bak');
  // A stand-in for schtasks that writes down what it got; /create fails.
  const fake = [
    `function Fake { Add-Content -LiteralPath ${psLiteral(log)} -Value ($args -join '|') -Encoding UTF8`,
    "  if ($args[0] -eq '/create' -and $args[4] -ne '/f') { $global:LASTEXITCODE = 1 } elseif ($args[0] -eq '/query') { $global:LASTEXITCODE = 1 } else { $global:LASTEXITCODE = 0 } }",
  ].join('\r\n');
  const script = `${fake}\r\n${buildElevationScript({ action: 'enable', xmlPath: xml, schtasksPath: 'Fake', restore: [{ task: BOOT_TASK_NAME, xml: copy }] })}`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', buildElevationCommand({ powershellPath: powershell, script, verb: '' })], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(result.status, SWEEP_FAILED_EXIT_CODE, result.stderr);
  const calls = fs.readFileSync(log, 'utf8').replace(/^\ufeff/, '').trim().split(/\r?\n/);
  assert.deepEqual(calls, [
    `/delete|/tn|${LEGACY_BOOT_TASK_NAME}|/f`,
    `/delete|/tn|${BOOT_TASK_NAME}|/f`,
    `/create|/tn|${BOOT_TASK_NAME}|/xml|${xml}`,
    `/query|/tn|${BOOT_TASK_NAME}`,
    `/create|/tn|${BOOT_TASK_NAME}|/xml|${copy}|/f`,
  ]);
});
// ─── A declined prompt is never a confirmed one ──────────────────────────────

const STARTUP_ENTRY = path.win32.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'oar-web-relay.cmd');

test('an elevated PowerShell that never started counts as nothing done: everything goes back, no copy stays', async () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: FOREIGN_TASK_XML } });
  const settled = [];
  await harness.service.requestEnable({ replace: true, onSettled: (ok, extra) => settled.push([ok, extra]) });
  harness.spawns[0].child.stderr.emit('data', 'Start-Process : This command cannot be run');
  await answer(harness, 2);
  const [[ok, extra]] = settled;
  assert.equal(ok, false);
  assert.equal(extra.declined, true);
  assert.match(extra.reason, /the elevated step could not be started: Start-Process : This command cannot be run/);
  assert.deepEqual(extra.copies, []);
  assert.deepEqual([...harness.fsImpl.files.keys()].filter((file) => file.startsWith(OAR_ROOT)), [], 'not a file left in the OAR folder');
});

test('the elevation command never turns a declined prompt into exit 0', () => {
  const command = buildElevationCommand({ powershellPath: 'powershell.exe', script: 'exit 0' });
  assert.match(command, /Start-Process .* -ErrorAction Stop/);
  assert.ok(command.includes('if (-not $p) { exit 1223 };'));
  assert.ok(command.includes('if ($null -eq $p.ExitCode) { exit 4 };'));
});

// Start-Process as a declined prompt makes it behave: the error it raises
// (not a terminating one), a bare error, and no process with no error.
const DECLINED_START_PROCESS = {
  'the cancel error': "function Start-Process { Write-Error -Exception ([System.InvalidOperationException]::new('This command cannot be run due to the error: The operation was canceled by the user.', [System.ComponentModel.Win32Exception]::new(1223))) };",
  'a bare error': "function Start-Process { Write-Error 'The operation was canceled by the user.' };",
  'no process and no error': 'function Start-Process { };',
};

function realPowerShell(fake) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return (file, args, options) => {
    const child = spawn(powershell, [...args.slice(0, -1), `${fake} ${args.at(-1)}`], options);
    child.kill = () => true;
    return child;
  };
}

function settledOnce() {
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  return { done, onSettled: (ok, extra) => resolve([ok, extra]) };
}

test('a declined prompt, as Windows PowerShell reports it, changes nothing in either direction', { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
  for (const [how, fake] of Object.entries(DECLINED_START_PROCESS)) {
    // Sign-in to boot: the Startup entry stays byte-identical, nothing is written.
    const enable = createHarness({ spawn: realPowerShell(fake) });
    enable.fsImpl.files.set(STARTUP_ENTRY, GENERATED_SIGNIN_ENTRY);
    const up = settledOnce();
    assert.equal((await enable.service.requestEnable({ onSettled: up.onSettled })).accepted, true);
    const [upOk, upExtra] = await up.done;
    assert.equal(upOk, false, how);
    assert.equal(upExtra.declined, true, how);
    assert.equal(enable.fsImpl.files.get(STARTUP_ENTRY), GENERATED_SIGNIN_ENTRY, `${how}: the Startup entry is as it was`);
    assert.deepEqual([...enable.fsImpl.files.keys()].filter((file) => file.startsWith(OAR_ROOT)), [], `${how}: no launcher, task XML or script left`);

    // Boot to off: the task stays, and so does its launcher, byte-identical.
    const disable = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML }, spawn: realPowerShell(fake) });
    disable.fsImpl.files.set(LAUNCHER, GENERATED_LAUNCHER);
    const down = settledOnce();
    assert.equal((await disable.service.requestDisable({ onSettled: down.onSettled })).accepted, true);
    const [downOk, downExtra] = await down.done;
    assert.equal(downOk, false, how);
    assert.equal(downExtra.declined, true, how);
    assert.equal(disable.fsImpl.files.get(LAUNCHER), GENERATED_LAUNCHER, `${how}: the launcher is as it was`);
    assert.deepEqual([...disable.fsImpl.files.keys()].filter((file) => file !== LAUNCHER && file.startsWith(OAR_ROOT)), [], `${how}: no copy or script left`);
    assert.equal((await disable.service.getState()).taskStatus, 'ready');
  }
});
test('a declined --replace leaves a hand-edited launcher byte-identical and no copy of it', async () => {
  const harness = createHarness();
  const custom = GENERATED_LAUNCHER.replace(':oar_start', ':oar_start\r\nrem waits for my drive');
  harness.fsImpl.files.set(LAUNCHER, custom);
  await harness.service.requestEnable({ replace: true });
  assert.ok(launcherScriptsMatch(harness.fsImpl.files.get(LAUNCHER), GENERATED_LAUNCHER), 'written for the prompt');
  await answer(harness, DECLINED);
  assert.equal(harness.fsImpl.files.get(LAUNCHER), custom, 'put back byte for byte');
  assert.deepEqual([...harness.fsImpl.files.keys()].filter((file) => file !== LAUNCHER && file.startsWith(OAR_ROOT)), [], 'no copy, task XML or script left');
});

test('leaving boot mode, once confirmed, takes the task XML and the record of the sweep with it', async () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
  harness.fsImpl.files.set(LAUNCHER, GENERATED_LAUNCHER);
  harness.fsImpl.files.set(path.win32.join(OAR_ROOT, BOOT_TASK_XML_FILENAME), 'xml');
  harness.fsImpl.files.set(path.win32.join(OAR_ROOT, BOOT_ELEVATION_SCRIPT_FILENAME), 'record');
  await harness.service.requestDisable();
  delete harness.tasks[BOOT_TASK_NAME];
  await answer(harness, 0);
  assert.deepEqual([...harness.fsImpl.files.keys()].filter((file) => file.startsWith(OAR_ROOT)), [], 'nothing of boot mode is left');
});
test('a confirmed disable whose task is still registered afterwards is a failure: the launcher and every copy stay', async () => {
  // Our own task still there after exit 0.
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML } });
  harness.fsImpl.files.set(LAUNCHER, GENERATED_LAUNCHER);
  const settled = [];
  await harness.service.requestDisable({ onSettled: (ok, extra) => settled.push([ok, extra]) });
  await answer(harness, 0);
  const [[ok, extra]] = settled;
  assert.equal(ok, false);
  assert.equal(extra.declined, false);
  assert.match(extra.error, /could not be removed \(it is still registered afterwards\)/);
  assert.equal(harness.fsImpl.files.get(LAUNCHER), GENERATED_LAUNCHER, 'the task still runs it: it stays');
  assert.ok(harness.fsImpl.files.has(path.win32.join(OAR_ROOT, `${BOOT_TASK_NAME}.task.xml.bak`)), 'the copy stays');
  assert.equal(harness.fsImpl.files.has(path.win32.join(OAR_ROOT, BOOT_ELEVATION_SCRIPT_FILENAME)), false, 'no record of a sweep that did not do its work');

  // With --replace, our task gone but the pre-rebrand one still there.
  const legacy = createHarness({ tasks: { [BOOT_TASK_NAME]: GENERATED_TASK_XML, [LEGACY_BOOT_TASK_NAME]: FOREIGN_TASK_XML } });
  legacy.fsImpl.files.set(LAUNCHER, GENERATED_LAUNCHER);
  const legacySettled = [];
  await legacy.service.requestDisable({ replace: true, onSettled: (ok2, extra2) => legacySettled.push([ok2, extra2]) });
  delete legacy.tasks[BOOT_TASK_NAME];
  await answer(legacy, 0);
  assert.equal(legacySettled[0][0], false);
  assert.equal(legacy.fsImpl.files.get(LAUNCHER), GENERATED_LAUNCHER);
  assert.ok(legacy.fsImpl.files.has(path.win32.join(OAR_ROOT, `${LEGACY_BOOT_TASK_NAME}.task.xml.bak`)));
});

test('a confirmed enable writes the record of the sweep it ran, byte for byte, with a BOM', async () => {
  const harness = createHarness();
  await harness.service.requestEnable();
  const record = path.win32.join(OAR_ROOT, BOOT_ELEVATION_SCRIPT_FILENAME);
  assert.equal(harness.fsImpl.files.has(record), false, 'none before the prompt is answered');
  harness.tasks[BOOT_TASK_NAME] = OWN_TASK_XML;
  await answer(harness, 0);
  const written = String(harness.fsImpl.files.get(record));
  assert.equal(written, `\ufeff${sweepOf(harness)}`, 'exactly the sweep that ran');
  assert.ok(written.includes(`/create /tn '${BOOT_TASK_NAME}' /xml '${path.win32.join(OAR_ROOT, BOOT_TASK_XML_FILENAME)}'`));
});

// ─── Task XML read through the OEM pipe ──────────────────────────────────────

// OAR folders schtasks cannot write into a pipe as they are.
const UMLAUT_APPDATA = "C:\\Users\\dev\\J\u00fcrgen O'Brien\\AppData\\Roaming";
const LOOK_ALIKE_APPDATA = 'C:\\Users\\dev\\\u0141ukasz\\AppData\\Roaming';
const HAND_MADE_UMLAUT_TASK_XML = FOREIGN_TASK_XML.replace('C:\\Users\\dev\\other\\thing.cmd', 'C:\\Users\\dev\\J\u00fcrgen\\thing.cmd');

function rootOf(appdata) {
  const root = path.win32.join(appdata, 'oar');
  return { env: { APPDATA: appdata }, root, launcher: path.win32.join(root, BOOT_LAUNCHER_FILENAME) };
}

// A requested enable, its prompt answered with `code`; on 0 the sweep
// registered the XML the service wrote. `beforeAnswer` runs in between.
async function enableConfirmed(harness, root, { replace = false, beforeAnswer = () => {}, code = 0 } = {}) {
  const settled = [];
  const state = await harness.service.requestEnable({ replace, onSettled: (ok, extra) => settled.push([ok, extra]) });
  assert.equal(state.accepted, true, state.refused || state.lastError);
  if (code === 0) harness.tasks[BOOT_TASK_NAME] = harness.fsImpl.files.get(path.win32.join(root, BOOT_TASK_XML_FILENAME)).subarray(2).toString('utf16le');
  beforeAnswer();
  await answer(harness, code, harness.spawns.length - 1);
  return settled[0];
}

test('a non-ASCII OAR folder: the task schtasks garbles is read again as UTF-8, so boot on, status and off work', async () => {
  const { env, root, launcher } = rootOf(UMLAUT_APPDATA);
  const harness = createHarness({ env });
  const [ok, extra] = await enableConfirmed(harness, root);
  assert.equal(ok, true, extra?.error);
  assert.ok(harness.tasks[BOOT_TASK_NAME].includes('J\u00fcrgen O&apos;Brien'));
  assert.ok(oemPipe(harness.tasks[BOOT_TASK_NAME]).includes('J\ufffdrgen'), 'schtasks garbles it');
  assert.ok(harness.exports.includes(BOOT_TASK_NAME), 'read again through the export');
  assert.ok(harness.fsImpl.files.has(launcher), 'the launcher stays');
  const state = await harness.service.getState();
  assert.equal(state.taskStatus, 'ready');
  assert.equal(state.generated, true);
  assert.deepEqual(state.handMade, []);
  assert.equal(state.readError, null);
  assert.equal(describeWindowsAutostart({ boot: state }).mode, 'boot');

  const off = [];
  assert.equal((await harness.service.requestDisable({ onSettled: (...args) => off.push(args) })).accepted, true, 'our own task, not a hand-made one');
  delete harness.tasks[BOOT_TASK_NAME];
  await answer(harness, 0, 1);
  assert.equal(off[0][0], true, off[0][1]?.error);
  assert.equal(harness.fsImpl.files.has(launcher), false);
});

test('an OAR folder with a letter schtasks turns into a look-alike (\u0141 as L) is read again too', async () => {
  const { env, root } = rootOf(LOOK_ALIKE_APPDATA);
  const harness = createHarness({ env });
  const [ok, extra] = await enableConfirmed(harness, root);
  assert.equal(ok, true, extra?.error);
  assert.equal(/[^\x00-\x7f]/.test(oemPipe(harness.tasks[BOOT_TASK_NAME])), false, 'what schtasks writes is plain ASCII');
  assert.ok(oemPipe(harness.tasks[BOOT_TASK_NAME]).includes('\\Lukasz\\'));
  assert.equal((await harness.service.getState()).generated, true);
});

test('--replace over a hand-made task with non-ASCII paths keeps an exact copy of it', async () => {
  const { env, root } = rootOf(UMLAUT_APPDATA);
  const harness = createHarness({ env, tasks: { [BOOT_TASK_NAME]: HAND_MADE_UMLAUT_TASK_XML } });
  assert.deepEqual((await harness.service.getState()).handMade.map((entry) => entry.task), [BOOT_TASK_NAME]);
  const [ok, extra] = await enableConfirmed(harness, root, { replace: true });
  assert.equal(ok, true, extra?.error);
  const copy = harness.fsImpl.files.get(path.win32.join(root, `${BOOT_TASK_NAME}.task.xml.bak`));
  assert.equal(copy.subarray(2).toString('utf16le'), HAND_MADE_UMLAUT_TASK_XML, 'the copy is the task as it is, not as schtasks wrote it');
});

test('a task that cannot be read again after a confirmed enable: registered, not verified; the launcher stays and nothing is claimed', async () => {
  const { env, root, launcher } = rootOf(UMLAUT_APPDATA);
  const harness = createHarness({ env });
  const [ok, extra] = await enableConfirmed(harness, root, { beforeAnswer: () => { harness.control.exportFails = true; } });
  assert.equal(ok, false, 'no success');
  assert.equal(extra.unverified, true);
  assert.equal(extra.declined, undefined);
  assert.match(extra.error, /confirmed and the boot task should be registered, but it could not be read back to check \(the task could not be exported/);
  assert.doesNotMatch(extra.error, /put back|is not registered|is registered/);
  assert.ok(String(harness.fsImpl.files.get(launcher)).includes('server.js'), 'the new launcher stays');
  assert.ok(harness.logs.some((line) => line.includes('Access is denied')), 'the detail is in the log');

  const state = await harness.service.getState();
  assert.equal(state.taskStatus, 'unknown', 'never missing');
  assert.deepEqual(state.handMade, [], 'never hand-made');
  assert.match(state.lastError, /could not be read back/);
  assert.equal(describeWindowsAutostart({ boot: state }).mode, 'unknown');
  const disable = await harness.service.requestDisable({ replace: true });
  assert.equal(disable.accepted, false);
  assert.match(disable.refused, /could not be read/);
  assert.equal((await harness.service.requestEnable({ replace: true })).accepted, false);
  assert.equal(harness.spawns.length, 1, 'nothing more is elevated');
});

test('a task that cannot be read again after a confirmed disable is never claimed removed: launcher, task XML and copy stay', async () => {
  const { env, root, launcher } = rootOf(UMLAUT_APPDATA);
  const harness = createHarness({ env });
  await enableConfirmed(harness, root);
  const settled = [];
  assert.equal((await harness.service.requestDisable({ onSettled: (...args) => settled.push(args) })).accepted, true);
  harness.control.exportFails = true;
  await answer(harness, 0, 1);
  const [[ok, extra]] = settled;
  assert.equal(ok, false);
  assert.equal(extra.unverified, true);
  assert.match(extra.error, /should be removed, but it could not be read back/);
  assert.ok(harness.fsImpl.files.has(launcher));
  assert.ok(harness.fsImpl.files.has(path.win32.join(root, BOOT_TASK_XML_FILENAME)));
  assert.ok(harness.fsImpl.files.has(path.win32.join(root, `${BOOT_TASK_NAME}.task.xml.bak`)));
});

test('a failed --replace sweep never says an unreadable task was put back', async () => {
  const { env, root } = rootOf(UMLAUT_APPDATA);
  const harness = createHarness({ env, tasks: { [BOOT_TASK_NAME]: HAND_MADE_UMLAUT_TASK_XML } });
  const [ok, extra] = await enableConfirmed(harness, root, {
    replace: true, code: SWEEP_FAILED_EXIT_CODE, beforeAnswer: () => { harness.control.exportFails = true; },
  });
  assert.equal(ok, false);
  assert.match(extra.error, /Afterwards: scheduled task \\oar-relay could not be read, so whether it is registered is not known\./);
  assert.doesNotMatch(extra.error, /put back|\\oar-relay is registered/);
  assert.ok(harness.fsImpl.files.has(path.win32.join(root, `${BOOT_TASK_NAME}.task.xml.bak`)), 'the copy stays');
});

test('a pre-rebrand task that cannot be read stops every change (it would be deleted without a copy)', async () => {
  const harness = createHarness({ tasks: { [LEGACY_BOOT_TASK_NAME]: HAND_MADE_UMLAUT_TASK_XML }, control: { exportFails: true } });
  const state = await harness.service.getState();
  assert.match(state.readError, /could not be exported/);
  assert.equal(describeWindowsAutostart({ boot: state }).mode, 'unknown');
  const enable = await harness.service.requestEnable({ replace: true });
  assert.equal(enable.accepted, false);
  assert.match(enable.refused, /could not be read/);
  assert.equal(harness.spawns.length, 0);
});

test('plain ASCII from schtasks under an ASCII OAR folder is taken as it is; a `?` in it is read again', async () => {
  const harness = createHarness({ tasks: { [LEGACY_BOOT_TASK_NAME]: FOREIGN_TASK_XML } });
  await harness.service.getState();
  await enableConfirmed(harness, OAR_ROOT, { replace: true });
  await harness.service.getState();
  assert.deepEqual(harness.exports, [], 'no second read');

  const cjk = FOREIGN_TASK_XML.replace('C:\\Users\\dev\\other\\thing.cmd', 'C:\\Users\\dev\\\u65e5\u672c\\thing.cmd');
  const question = createHarness({ tasks: { [BOOT_TASK_NAME]: cjk } });
  await enableConfirmed(question, OAR_ROOT, { replace: true });
  assert.ok(question.exports.includes(BOOT_TASK_NAME), 'schtasks wrote ?? for it');
  const copy = question.fsImpl.files.get(path.win32.join(OAR_ROOT, `${BOOT_TASK_NAME}.task.xml.bak`));
  assert.equal(copy.subarray(2).toString('utf16le'), cjk, 'its copy is exact');
});

test('--replace over a hand-made task whose copy cannot be read changes nothing: no sweep, no .bak, the task stays', async () => {
  const { env, root } = rootOf(UMLAUT_APPDATA);
  for (const action of ['requestEnable', 'requestDisable']) {
    // Read for the state (export 1), not for the copy (export 2).
    const harness = createHarness({ env, tasks: { [BOOT_TASK_NAME]: HAND_MADE_UMLAUT_TASK_XML }, control: { exportFails: (name, count) => count >= 2 } });
    const state = await harness.service[action]({ replace: true });
    assert.equal(state.accepted, false, action);
    assert.match(state.lastError, /Could not keep a copy of an entry before changing it, so nothing was changed/, action);
    assert.equal(harness.spawns.length, 0, `${action}: nothing elevated, nothing deleted`);
    assert.deepEqual([...harness.fsImpl.files.keys()].filter((file) => file.startsWith(root)), [], `${action}: no .bak, launcher or task XML`);
    assert.equal(harness.tasks[BOOT_TASK_NAME], HAND_MADE_UMLAUT_TASK_XML, `${action}: the task stays`);
    assert.ok(harness.logs.some((line) => line.includes('could not keep a copy') && line.includes('could not be exported')), action);
  }
});

test('one export per task at a time: reads while it runs share it, another task gets its own, a failed one is not kept', async () => {
  const { env } = rootOf(UMLAUT_APPDATA);
  let release;
  const control = { gates: { [LEGACY_BOOT_TASK_NAME]: new Promise((resolve) => { release = resolve; }) } };
  const harness = createHarness({ env, control, tasks: { [LEGACY_BOOT_TASK_NAME]: HAND_MADE_UMLAUT_TASK_XML } });
  const settle = async () => { for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const first = harness.service.getState();
  const second = harness.service.getState();
  await settle();
  assert.deepEqual(harness.exports, [LEGACY_BOOT_TASK_NAME], 'two reads, one export');
  harness.tasks[BOOT_TASK_NAME] = HAND_MADE_UMLAUT_TASK_XML;
  const third = harness.service.getState();
  await settle();
  assert.deepEqual(harness.exports, [LEGACY_BOOT_TASK_NAME, BOOT_TASK_NAME], 'our task its own; its legacy read joins the one running');
  release();
  for (const state of await Promise.all([first, second, third])) assert.equal(state.legacyTaskPresent, true);

  delete control.gates;
  control.exportFails = true;
  assert.match((await harness.service.getState()).readError, /could not be exported/);
  control.exportFails = false;
  const count = harness.exports.length;
  assert.equal((await harness.service.getState()).readError, null, 'read again once the failed export settled');
  assert.equal(harness.exports.length, count + 2);
});

// ─── A query that fails is no missing task ───────────────────────────────────

// What unelevated schtasks says of a task only an administrator may read.
const ACCESS_DENIED = { code: 1, stdout: '', stderr: 'ERROR: Access is denied.' };

test('a query that fails while a confirmed enable is verified is unverified, not missing: the launcher stays', async () => {
  for (const [what, failure] of [['access denied', ACCESS_DENIED], ['timed out', { code: 1, stdout: '', stderr: '', startError: 'killed=true signal=SIGTERM' }]]) {
    const harness = createHarness();
    const [ok, extra] = await enableConfirmed(harness, OAR_ROOT, {
      beforeAnswer: () => { harness.control.queryFails = (name) => (name === BOOT_TASK_NAME ? failure : null); },
    });
    assert.equal(ok, false, what);
    assert.equal(extra.unverified, true, what);
    assert.match(extra.error, /should be registered, but it could not be read back to check/, what);
    assert.doesNotMatch(extra.error, /put back|is not registered/, what);
    assert.ok(String(harness.fsImpl.files.get(LAUNCHER)).includes('server.js'), `${what}: the launcher stays`);
  }
});

test('after a prompt nobody answered, the message says only what is so: no put back', async () => {
  const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: FOREIGN_TASK_XML } });
  const settled = [];
  await harness.service.requestEnable({ replace: true, onSettled: (ok, extra) => settled.push([ok, extra]) });
  harness.timers.fire(120_000);
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setImmediate(resolve));
  const [[ok, extra]] = settled;
  assert.equal(ok, false);
  assert.match(extra.error, /could not be registered \(no answer at the administrator prompt within 2 minutes\)\. Afterwards: scheduled task \\oar-relay is registered\./);
  assert.doesNotMatch(extra.error, /put back/);
});

test('a task only an administrator can read is unreadable, never none: status names it, boot is refused, nothing is deleted', async () => {
  // Its file may be denied too (unelevated, it is), or seen.
  for (const taskFileErrors of [{ [BOOT_TASK_NAME]: 'EPERM' }, {}]) {
    const what = taskFileErrors[BOOT_TASK_NAME] || 'file seen';
    const harness = createHarness({ tasks: { [BOOT_TASK_NAME]: FOREIGN_TASK_XML }, control: { taskFileErrors, queryFails: (name) => (name === BOOT_TASK_NAME ? ACCESS_DENIED : null) } });
    const state = await harness.service.getState();
    assert.equal(state.taskStatus, 'unknown', what);
    assert.match(state.readError, /^scheduled task \\oar-relay could not be read; the relay log has the details\.$/, what);
    assert.ok(harness.logs.some((line) => line.includes('Access is denied')), `${what}: the detail is in the log`);
    assert.equal(describeWindowsAutostart({ boot: state }).mode, 'unknown', what);
    for (const replace of [false, true]) {
      const enable = await harness.service.requestEnable({ replace });
      assert.equal(enable.accepted, false, what);
      assert.match(enable.refused, /scheduled task \\oar-relay could not be read/, what);
      assert.equal((await harness.service.requestDisable({ replace })).accepted, false, what);
    }
    assert.equal(harness.spawns.length, 0, `${what}: nothing elevated, nothing deleted`);
    assert.deepEqual([...harness.fsImpl.files.keys()].filter((file) => file.startsWith(OAR_ROOT)), [], `${what}: no launcher, XML or copy`);
    assert.equal(harness.tasks[BOOT_TASK_NAME], FOREIGN_TASK_XML, what);
  }

  // A task that is not there still reads as none.
  const none = createHarness({ control: { queryFails: () => ({ code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' }) } });
  assert.equal((await none.service.getState()).taskStatus, 'missing');
});

test('the export reads the task by its literal name in the root folder, as UTF-8', () => {
  assert.equal(
    buildTaskExportCommand("it's"),
    "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; [Console]::Out.Write((Export-ScheduledTask -TaskName 'it''s' -TaskPath '\\'))",
  );
});