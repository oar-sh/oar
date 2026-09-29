import test from 'node:test';
import assert from 'node:assert/strict';

import { createProcessLister, parseProcStat, parsePsLine } from './process-list-service.mjs';
import { createSessionWorkerProcessInspector } from './session-worker-process-service.mjs';

// `/proc/<pid>/stat` as Linux writes it: pid, (name), state, parent, group,
// session, ... and the start time as field 22.
function statLine({ pid, name = 'node', state = 'S', ppid = 1, pgid = pid, sid = pid, start = 5_000 }) {
  return `${pid} (${name}) ${state} ${ppid} ${pgid} ${sid} 0 -1 4194304 100 0 0 0 1 2 0 0 20 0 1 0 ${start} 1000000 200 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 1 0 0 0 0 0\n`;
}

function fakeProc(files) {
  return {
    readdirSyncImpl: (dir) => {
      assert.equal(dir, '/proc');
      return ['acpi', 'self', 'cpuinfo', ...Object.keys(files).map((file) => file.split('/')[2])
        .filter((name, index, all) => all.indexOf(name) === index)];
    },
    readFileSyncImpl: (file) => {
      if (!(file in files)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      return files[file];
    },
  };
}

test('a stat line gives the pid, the parent and the start time', () => {
  assert.deepEqual(parseProcStat(statLine({ pid: 4200, name: 'bash', ppid: 4100, sid: 4200, start: 292_000_000 })), {
    processId: 4200,
    parentProcessId: 4100,
    name: 'bash',
    createdAt: 292_000_000,
    sessionLeader: true,
  });
  assert.equal(parseProcStat(statLine({ pid: 4201, ppid: 4200, sid: 4200 })).sessionLeader, false);
});

test('a process name with spaces and parentheses does not shift the fields', () => {
  const parsed = parseProcStat(statLine({ pid: 4300, name: 'tmux: server (1) x', ppid: 77, start: 123 }));
  assert.equal(parsed.name, 'tmux: server (1) x');
  assert.equal(parsed.parentProcessId, 77);
  assert.equal(parsed.createdAt, 123);
});

test('a process that has ended and waits to be collected is not running', () => {
  assert.equal(parseProcStat(statLine({ pid: 4400, state: 'Z' })), null);
  assert.equal(parseProcStat(statLine({ pid: 4400, state: 'X' })), null);
  assert.equal(parseProcStat(''), null);
  assert.equal(parseProcStat('not a stat line'), null);
});

test('linux: the list is read from /proc, without starting a process', () => {
  const lister = createProcessLister({
    platform: 'linux',
    execFileImpl: () => { throw new Error('no process may be started for the list'); },
    ...fakeProc({
      '/proc/4100/stat': statLine({ pid: 4100, ppid: 9001, sid: 9000, start: 300 }),
      '/proc/4200/stat': statLine({ pid: 4200, name: 'bash', ppid: 4100, sid: 4200, start: 400 }),
      '/proc/4200/cmdline': '/bin/bash\0--norc\0-c\0make test\0',
      '/proc/4400/stat': statLine({ pid: 4400, state: 'Z', ppid: 4100 }),
    }),
  });

  assert.equal(lister.orphansKeepParent, false);
  assert.deepEqual(lister.list().map((proc) => [proc.processId, proc.parentProcessId, proc.createdAt]), [
    [4100, 9001, 300],
    [4200, 4100, 400],
  ]);
  assert.equal(lister.read(4200).createdAt, 400);
  assert.equal(lister.describe(4200), '/bin/bash --norc -c make test');
});

test('linux: a process that ended between the listing and the read is not in the list', () => {
  const files = { '/proc/4100/stat': statLine({ pid: 4100 }) };
  const lister = createProcessLister({
    platform: 'linux',
    readdirSyncImpl: () => ['4100', '4200'],
    readFileSyncImpl: fakeProc(files).readFileSyncImpl,
  });

  assert.deepEqual(lister.list().map((proc) => proc.processId), [4100]);
  assert.equal(lister.read(4200), null);
  assert.equal(lister.describe(4200), '');
});

test('a ps line gives the pid, the parent, the start time and the command', () => {
  const parsed = parsePsLine(' 4200  4100 Ss   Tue Sep 29 13:56:49 2026 /bin/bash --norc -c make test');
  assert.equal(parsed.processId, 4200);
  assert.equal(parsed.parentProcessId, 4100);
  assert.equal(parsed.commandLine, '/bin/bash --norc -c make test');
  assert.equal(parsed.createdAt, new Date(2026, 8, 29, 13, 56, 49).getTime());
  // One digit for the day is padded with a space.
  assert.equal(
    parsePsLine('    7     1 S    Thu Oct  1 08:00:00 2026 /usr/sbin/cron').createdAt,
    new Date(2026, 9, 1, 8, 0, 0).getTime(),
  );
  assert.equal(parsePsLine(' 4400  4100 Z    Tue Sep 29 13:56:49 2026 [sh] <defunct>'), null);
  assert.equal(parsePsLine(''), null);
});

test('other posix platforms ask ps, once per list', async () => {
  const calls = [];
  const lister = createProcessLister({
    platform: 'darwin',
    readdirSyncImpl: () => { throw new Error('there is no /proc to read'); },
    execFileImpl: (command, args, options, done) => {
      calls.push({ command, args, options });
      done(null, [
        ' 4100  9001 S    Tue Sep 29 13:56:40 2026 node /home/dev/copilot/app.js --headless',
        ' 4200  4100 Ss   Tue Sep 29 13:56:49 2026 /bin/bash --norc -c make test',
        '',
      ].join('\n'));
    },
  });

  const list = await lister.list();

  assert.deepEqual(list.map((proc) => [proc.processId, proc.parentProcessId]), [[4100, 9001], [4200, 4100]]);
  assert.equal(lister.read, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ps');
  assert.deepEqual(calls[0].args, ['-axww', '-o', 'pid=,ppid=,stat=,lstart=,args=']);
  // The start time is parsed as a date, so it is asked for in one language.
  assert.equal(calls[0].options.env.LC_ALL, 'C');
  assert.ok(calls[0].options.timeout > 0);
});

test('a ps that fails rejects the list', async () => {
  const lister = createProcessLister({
    platform: 'darwin',
    execFileImpl: (_command, _args, _options, done) => done(new Error('spawn ps ENOENT')),
  });
  await assert.rejects(lister.list(), /spawn ps ENOENT/);
});

// Unverified on Windows: the PowerShell answer below has the shape the
// relay's process inspector already reads there.
const WINDOWS_ANSWER = JSON.stringify([
  { processId: 4100, parentProcessId: 9001, name: 'node.exe', commandLine: 'node C:\\Users\\dev\\copilot\\app.js --headless', createdAt: 1_790_000_000_000 },
  { processId: 4200, parentProcessId: 4100, name: 'pwsh.exe', commandLine: 'pwsh -Command npm test', createdAt: 1_790_000_005_000 },
  { processId: 0, parentProcessId: 0, name: 'System Idle Process', commandLine: '', createdAt: 0 },
]);

test('windows: the list comes from the inspector, read without holding the thread', async () => {
  const calls = [];
  const lister = createProcessLister({
    platform: 'win32',
    readdirSyncImpl: () => { throw new Error('there is no /proc to read'); },
    execFileImpl: (command, args, options, done) => {
      calls.push({ command, args, options });
      done(null, WINDOWS_ANSWER);
    },
  });

  assert.equal(lister.orphansKeepParent, true);
  assert.equal(lister.read, undefined);
  const list = await lister.list();

  assert.deepEqual(list.map((proc) => [proc.processId, proc.parentProcessId, proc.createdAt]), [
    [4100, 9001, 1_790_000_000_000],
    [4200, 4100, 1_790_000_005_000],
  ]);
  assert.equal(list[1].commandLine, 'pwsh -Command npm test');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.match(calls[0].args.at(-1), /Get-CimInstance Win32_Process/);
  assert.match(calls[0].args.at(-1), /CreationDate/);
  assert.equal(calls[0].options.windowsHide, true);
  assert.ok(calls[0].options.timeout > 0);
});

test('windows: the list asks for what the inspector asks for', async () => {
  // One script, so the worker and the relay read the same fields.
  let asked = '';
  let askedSync = '';
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl: (_command, args) => { askedSync = args.at(-1); return Buffer.from('[]'); },
    execFileImpl: (_command, args, _options, done) => { asked = args.at(-1); done(null, '[]'); },
  });

  inspector.getWindowsProcessSnapshot();
  assert.deepEqual(await createProcessLister({ platform: 'win32', inspector }).list(), []);

  assert.ok(asked);
  assert.equal(asked, askedSync);
});

test('windows: a list that cannot be read or parsed rejects', async () => {
  const failing = createProcessLister({
    platform: 'win32',
    execFileImpl: (_command, _args, _options, done) => done(new Error('powershell.exe timed out')),
  });
  await assert.rejects(failing.list(), /timed out/);

  const garbled = createProcessLister({
    platform: 'win32',
    execFileImpl: (_command, _args, _options, done) => done(null, 'Get-CimInstance : Access denied'),
  });
  await assert.rejects(garbled.list(), SyntaxError);
});

test('the async windows list is empty on other platforms and starts nothing', async () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'linux',
    execFileImpl: () => { throw new Error('no process may be started'); },
  });
  assert.deepEqual(await inspector.readWindowsProcessSnapshot(), []);
});
