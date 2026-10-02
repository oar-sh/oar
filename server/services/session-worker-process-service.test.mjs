import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionWorkerProcessInspector } from './session-worker-process-service.mjs';

test('process inspector finds posix session worker processes by session id', () => {
  const execFileSyncImpl = (command, args) => {
    assert.equal(command, 'ps');
    assert.deepEqual(args, ['-eo', 'pid=,ppid=,comm=,args=', '-ww']);
    return Buffer.from([
      `101 1 node gh copilot -- --allow-all --session-id abc-123`,
      `102 1 bash /bin/bash -lc echo nope`,
      `103 1 copilot /usr/bin/copilot --allow-all --resume=def-456`,
    ].join('\n'));
  };
  const inspector = createSessionWorkerProcessInspector({
    platform: 'linux',
    execFileSyncImpl,
  });

  const abc = inspector.findProcessForSession('abc-123');
  const def = inspector.findProcessForSession('def-456');

  assert.equal(abc?.processId, 101);
  assert.match(abc?.commandLine || '', /--session-id abc-123/);
  assert.equal(def?.processId, 103);
  assert.match(def?.commandLine || '', /--resume=def-456/);
});

test('process inspector recognizes node session worker processes by session id', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'linux',
    execFileSyncImpl(command, args) {
      assert.equal(command, 'ps');
      assert.deepEqual(args, ['-eo', 'pid=,ppid=,comm=,args=', '-ww']);
      return Buffer.from([
        `104 1 node node /x/server/claude-worker/claude-session-worker.mjs --session-id claude-1`,
        `105 1 node node /x/server/cursor-worker/cursor-session-worker.mjs --session-id abc`,
        `107 1 node node /x/server/grok-worker/grok-session-worker.mjs --session-id grok-1`,
      ].join('\n'));
    },
  });

  assert.equal(inspector.findProcessForSession('claude-1')?.processId, 104);
  assert.equal(inspector.findProcessForSession('abc')?.processId, 105);
  // grok-session-worker was missing from the marker list until 2026-08-31 —
  // same class of miss as the tmux-server bug: kill no-ops, duplicate spawns.
  assert.equal(inspector.findProcessForSession('grok-1')?.processId, 107);
});

test('process inspector recognizes the copilot SDK engine worker', () => {
  // It carries none of the copilot CLI markers (no --allow-all, no
  // @github/copilot path), so without its own arm the kill route no-ops and
  // process reuse spawns a duplicate worker every turn.
  const inspector = createSessionWorkerProcessInspector({
    platform: 'linux',
    execFileSyncImpl: () => Buffer.from([
      `106 1 node node /x/server/copilot-worker/copilot-sdk-session-worker.mjs --session-id sdk-1`,
    ].join('\n')),
  });

  assert.equal(inspector.findProcessForSession('sdk-1')?.processId, 106);
});

test('the tmux server is still excluded when it adopted an SDK worker argv', () => {
  // The new arm must not reopen the tmux-server match: the server keeps the
  // argv of whichever session started it, and killing it tears down every
  // tmux-hosted worker on the socket.
  const inspector = createSessionWorkerProcessInspector({
    platform: 'linux',
    execFileSyncImpl: () => Buffer.from([
      `304 1 tmux: server tmux new-session -d -s sdk-2 sh -lc exec 'node' '/x/server/copilot-worker/copilot-sdk-session-worker.mjs' --session-id 'sdk-2'`,
      `305 1 tmux tmux new-session -d -s sdk-2 sh -lc exec 'node' '/x/server/copilot-worker/copilot-sdk-session-worker.mjs' --session-id 'sdk-2'`,
      `306 304 node node /x/server/copilot-worker/copilot-sdk-session-worker.mjs --session-id sdk-2`,
    ].join('\n')),
  });

  const matches = inspector.findProcessesForSession('sdk-2');
  assert.deepEqual(matches.map((proc) => proc.processId), [306]);
});

test('process inspector ignores relay server process on linux path form', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'linux',
    execFileSyncImpl(command, args) {
      assert.equal(command, 'ps');
      assert.deepEqual(args, ['-eo', 'pid=,ppid=,comm=,args=', '-ww']);
      return Buffer.from([
        `201 1 node /home/user/project/server/server.js --allow-all --session-id abc-123`,
        `202 1 node gh copilot -- --allow-all --session-id abc-123`,
      ].join('\n'));
    },
  });

  const matches = inspector.findProcessesForSession('abc-123');
  assert.deepEqual(matches.map((proc) => proc.processId), [202]);
});

test('process inspector never matches the shared tmux server for a session id', () => {
  // The tmux server adopts the argv of the first `tmux new-session` that
  // started it, so its command line carries that session's id and worker
  // script path forever. Killing it would destroy every tmux-hosted worker.
  const inspector = createSessionWorkerProcessInspector({
    platform: 'linux',
    execFileSyncImpl(command, args) {
      assert.equal(command, 'ps');
      assert.deepEqual(args, ['-eo', 'pid=,ppid=,comm=,args=', '-ww']);
      return Buffer.from([
        // comm "tmux: server" splits into name "tmux:" + cmd "server tmux ..."
        `301 1 tmux: server tmux new-session -d -s sess-1 sh -lc export FOO='bar'; exec 'node' '/x/server/claude-worker/claude-session-worker.mjs' --session-id 'sess-1'`,
        // A plain tmux client invocation carrying the same session id.
        `302 1 tmux tmux new-session -d -s sess-1 sh -lc exec 'node' '/x/server/claude-worker/claude-session-worker.mjs' --session-id 'sess-1'`,
        // The actual worker for the session — the only legitimate match.
        `303 301 node node /x/server/claude-worker/claude-session-worker.mjs --session-id sess-1`,
      ].join('\n'));
    },
  });

  const matches = inspector.findProcessesForSession('sess-1');
  assert.deepEqual(matches.map((proc) => proc.processId), [303]);
});

test('process inspector ignores relay server process on windows path form', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl(command, args) {
      assert.equal(command, 'powershell.exe');
      assert.deepEqual(args, ['-NoProfile', '-Command', [
        '$list = Get-CimInstance Win32_Process | ForEach-Object {',
        '  [pscustomobject]@{',
        '    processId = [int]$_.ProcessId;',
        '    parentProcessId = [int]$_.ParentProcessId;',
        '    name = [string]$_.Name;',
        '    commandLine = [string]$_.CommandLine;',
        '    createdAt = $(if ($_.CreationDate) { [int64](($_.CreationDate.ToUniversalTime() - [datetime]"1970-01-01").TotalMilliseconds) } else { [int64]0 });',
        '  }',
        '};',
        '$json = [string]($list | ConvertTo-Json -Depth 3 -Compress);',
        '$bytes = [System.Text.Encoding]::UTF8.GetBytes($json);',
        '$stdout = [Console]::OpenStandardOutput();',
        '$stdout.Write($bytes, 0, $bytes.Length);',
        '$stdout.Flush()',
      ].join(' ')]);
      return Buffer.from(JSON.stringify([
        {
          processId: 301,
          parentProcessId: 1,
          name: 'node.exe',
          commandLine: 'node C:\\repo\\server\\server.js --allow-all --session-id abc-123',
        },
        {
          processId: 302,
          parentProcessId: 1,
          name: 'gh.exe',
          commandLine: 'gh copilot -- --allow-all --session-id abc-123',
        },
      ]));
    },
  });

  const matches = inspector.findWindowsProcessesForSession('abc-123');
  assert.deepEqual(matches.map((proc) => proc.processId), [302]);
});

test('process inspector parses quoted session-id flag tokens on windows command lines', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl() {
      return Buffer.from(JSON.stringify([
        {
          processId: 401,
          parentProcessId: 1,
          name: 'gh.exe',
          commandLine: '"gh" "copilot" "--" "--allow-all" "--session-id" "abc-123"',
        },
      ]));
    },
  });

  const match = inspector.findProcessForSession('abc-123');
  assert.equal(match?.processId, 401);
});

test('process inspector prefers gh/copilot over transient cmd wrapper on windows', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl() {
      return Buffer.from(JSON.stringify([
        {
          processId: 501,
          parentProcessId: 1,
          name: 'cmd.exe',
          commandLine: 'C:\\Windows\\System32\\cmd.exe /d /s /c ""gh" "copilot" "--" "--allow-all" "--session-id" "abc-123""',
        },
        {
          processId: 502,
          parentProcessId: 501,
          name: 'gh.exe',
          commandLine: '"gh" "copilot" "--" "--allow-all" "--session-id" "abc-123"',
        },
      ]));
    },
  });

  const match = inspector.findProcessForSession('abc-123');
  assert.equal(match?.processId, 502);
});

test('process inspector does not treat wrapper-only cmd.exe as live worker on windows', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl() {
      return Buffer.from(JSON.stringify([
        {
          processId: 601,
          parentProcessId: 1,
          name: 'cmd.exe',
          commandLine: 'C:\\Windows\\System32\\cmd.exe /d /s /c ""gh" "copilot" "--" "--allow-all" "--session-id" "abc-123""',
        },
      ]));
    },
  });

  const match = inspector.findProcessForSession('abc-123');
  assert.equal(match, null);
});

test('process inspector prefers newest non-wrapper worker when multiple candidates match', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl() {
      return Buffer.from(JSON.stringify([
        {
          processId: 700,
          parentProcessId: 1,
          name: 'gh.exe',
          commandLine: 'gh copilot -- --allow-all --session-id abc-123',
        },
        {
          processId: 701,
          parentProcessId: 1,
          name: 'gh.exe',
          commandLine: 'gh copilot -- --allow-all --session-id abc-123',
        },
      ]));
    },
  });

  const match = inspector.findProcessForSession('abc-123');
  assert.equal(match?.processId, 701);
});

test('process inspector finds windows session process tree for kill', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl() {
      return Buffer.from(JSON.stringify([
        {
          processId: 800,
          parentProcessId: 1,
          name: 'cmd.exe',
          commandLine: 'cmd.exe /d /s /c "gh copilot -- --allow-all --session-id abc-123"',
        },
        {
          processId: 801,
          parentProcessId: 800,
          name: 'gh.exe',
          commandLine: 'gh copilot -- --allow-all --session-id abc-123',
        },
        {
          processId: 802,
          parentProcessId: 801,
          name: 'node.exe',
          commandLine: 'node tool-child-without-session-arg.js',
        },
        {
          processId: 803,
          parentProcessId: 800,
          name: 'conhost.exe',
          commandLine: '\\??\\C:\\Windows\\system32\\conhost.exe 0x4',
        },
        {
          processId: 804,
          parentProcessId: 1,
          name: 'gh.exe',
          commandLine: 'gh copilot -- --allow-all --session-id def-456',
        },
      ]));
    },
  });

  const pids = inspector.findWindowsProcessTreeForSession('abc-123')
    .map((proc) => proc.processId)
    .sort((left, right) => left - right);

  assert.deepEqual(pids, [800, 801, 802, 803]);
});

test('a process older than its "parent" is not killed with it: windows hands a pid out again', () => {
  // Windows keeps the pid of a worker's creator in the worker for good. The
  // creator ended long ago and its pid (910) now belongs to a tool process of
  // the session that is being killed: the older worker is no child of it.
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl() {
      return Buffer.from(JSON.stringify([
        {
          processId: 900,
          parentProcessId: 1,
          name: 'node.exe',
          commandLine: 'node claude-session-worker.mjs --session-id abc-123',
          createdAt: 5_000_000,
        },
        {
          processId: 910,
          parentProcessId: 900,
          name: 'node.exe',
          commandLine: 'node tool-child-without-session-arg.js',
          createdAt: 5_000_500,
        },
        {
          processId: 911,
          parentProcessId: 910,
          name: 'node.exe',
          commandLine: 'node grandchild.js',
          createdAt: 5_000_900,
        },
        {
          // Started two days earlier by a process that had pid 910 then.
          processId: 920,
          parentProcessId: 910,
          name: 'node.exe',
          commandLine: 'node claude-session-worker.mjs --session-id def-456',
          createdAt: 1_000_000,
        },
        {
          processId: 921,
          parentProcessId: 920,
          name: 'claude.exe',
          commandLine: 'claude --output-format stream-json',
          createdAt: 1_000_400,
        },
        {
          // Not a worker, and older than its "parent" as well.
          processId: 930,
          parentProcessId: 910,
          name: 'python.exe',
          commandLine: 'python long-job.py',
          createdAt: 2_000_000,
        },
      ]));
    },
  });

  const pids = inspector.findWindowsProcessTreeForSession('abc-123')
    .map((proc) => proc.processId)
    .sort((left, right) => left - right);

  assert.deepEqual(pids, [900, 910, 911]);
});

test('the worker of another session is never part of a session tree, whatever its start time says', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl() {
      return Buffer.from(JSON.stringify([
        {
          processId: 940,
          parentProcessId: 1,
          name: 'node.exe',
          commandLine: 'node copilot-session-worker.mjs --session-id abc-123',
        },
        {
          // No start times known: the pid alone would make it a child.
          processId: 941,
          parentProcessId: 940,
          name: 'node.exe',
          commandLine: 'node claude-session-worker.mjs --session-id def-456',
        },
        {
          processId: 942,
          parentProcessId: 941,
          name: 'claude.exe',
          commandLine: 'claude --output-format stream-json',
        },
        {
          processId: 943,
          parentProcessId: 940,
          name: 'copilot.exe',
          commandLine: 'copilot --headless --resume 7d0e-runtime-session',
        },
      ]));
    },
  });

  const pids = inspector.findWindowsProcessTreeForSession('abc-123')
    .map((proc) => proc.processId)
    .sort((left, right) => left - right);

  // The runtime the worker started carries a session id of its own and stays
  // part of the tree; the other session's worker and what it started do not.
  assert.deepEqual(pids, [940, 943]);
});

test('process inspector keeps normal windows worker lookup limited to matching processes', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl() {
      return Buffer.from(JSON.stringify([
        {
          processId: 900,
          parentProcessId: 1,
          name: 'gh.exe',
          commandLine: 'gh copilot -- --allow-all --session-id abc-123',
        },
        {
          processId: 901,
          parentProcessId: 900,
          name: 'node.exe',
          commandLine: 'node tool-child-without-session-arg.js',
        },
      ]));
    },
  });

  assert.deepEqual(
    inspector.findWindowsProcessesForSession('abc-123').map((proc) => proc.processId),
    [900],
  );
});

test('process inspector windows stop command expands descendants before stopping pids', () => {
  let stopScript = '';
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl(command, args) {
      assert.equal(command, 'powershell.exe');
      stopScript = String(args?.[2] || '');
      return Buffer.from('');
    },
  });

  const stopped = inspector.stopWindowsPids([1001, 1002, 1001]);

  assert.deepEqual(stopped, [1001, 1002]);
  assert.match(stopScript, /Get-CimInstance Win32_Process/);
  assert.match(stopScript, /-ErrorAction Stop/);
  assert.match(stopScript, /parentProcessId/);
  // Descendants are taken by start time too, and never another session's worker.
  assert.match(stopScript, /CreationDate/);
  assert.match(stopScript, /\$proc\.createdAt -lt \$parentCreatedAt/);
  assert.match(stopScript, /if \(\$proc\.worker\) \{ continue \}/);
  assert.match(stopScript, /Stop-Process -Id \$id -Force/);
  assert.match(stopScript, /exit 0/);
});

test('a control byte in another command line does not make the windows process list unreadable', () => {
  // Under an OEM console code page PowerShell writes "→" as 0x1A and "•" as
  // 0x07 (2026-10-01: one such command line stopped every launch on a relay).
  const json = JSON.stringify([
    { processId: 501, parentProcessId: 1, name: 'bash.exe', commandLine: 'bash -c "echo @ next; echo # done"' },
    { processId: 502, parentProcessId: 1, name: 'node.exe', commandLine: 'node C:\\repo\\server\\claude-worker\\claude-session-worker.mjs --session-id abc-123' },
  ]).replace('@', '\u001a').replace('#', '\u0007');
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl: () => Buffer.from(json, 'latin1'),
  });

  assert.equal(inspector.findProcessForSession('abc-123')?.processId, 502);
  assert.deepEqual(inspector.findWindowsProcessTreeForSession('abc-123').map((proc) => proc.processId), [502]);
});

test('a windows process list that is not JSON at all says so', () => {
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileSyncImpl: () => Buffer.from('[{"processId": 1, "name": '),
  });

  assert.throws(
    () => inspector.findProcessForSession('abc-123'),
    { message: /^windows-process-snapshot-unreadable: / },
  );
});

// ─── the asynchronous readers (relay side) ───────────────────────────────────

function windowsListJson(extra = []) {
  return Buffer.from(JSON.stringify([
    { processId: 7001, parentProcessId: 1, name: 'node.exe', commandLine: 'node C:\\repo\\server\\claude-worker\\claude-session-worker.mjs --session-id abc-123' },
    ...extra,
  ]));
}

function asyncWindowsInspector({ delayMs = 5, nowMs = () => Date.now(), output = windowsListJson(), fail = null, ...rest } = {}) {
  const calls = [];
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    now: nowMs,
    execFileSyncImpl() { throw new Error('the synchronous reader must not run'); },
    execFileImpl(command, args, options, callback) {
      calls.push({ command, args, options });
      setTimeout(() => (fail ? callback(fail) : callback(null, typeof output === 'function' ? output() : output)), delayMs);
    },
    ...rest,
  });
  return { inspector, calls };
}

test('concurrent async readers share one PowerShell run, and the cache serves the next caller', async () => {
  let clock = 1_000_000;
  const { inspector, calls } = asyncWindowsInspector({ nowMs: () => clock, snapshotCacheMs: 1_500 });
  const [a, b, tree] = await Promise.all([
    inspector.findProcessForSessionAsync('abc-123'),
    inspector.findProcessesForSessionAsync('abc-123'),
    inspector.findWindowsProcessTreeForSessionAsync('abc-123'),
  ]);
  assert.equal(calls.length, 1, 'one run for three concurrent callers');
  assert.equal(a?.processId, 7001);
  assert.deepEqual(b.map((proc) => proc.processId), [7001]);
  assert.deepEqual(tree.map((proc) => proc.processId), [7001]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.ok(calls[0].options.timeout > 0, 'the read has a timeout');

  clock += 1_000;
  await inspector.findProcessForSessionAsync('abc-123');
  assert.equal(calls.length, 1, 'inside the cache window the result is reused');
  await inspector.findProcessForSessionAsync('abc-123', { fresh: true });
  assert.equal(calls.length, 2, 'fresh: true reads again');
  clock += 2_000;
  await inspector.findProcessForSessionAsync('abc-123');
  assert.equal(calls.length, 3, 'after the window the list is read again');
});

test('the async read keeps the event loop running and records what it did', async () => {
  let clock = 5_000;
  const warnings = [];
  const { inspector, calls } = asyncWindowsInspector({
    delayMs: 60,
    nowMs: () => clock,
    slowReadMs: 2_000,
    logger: { warn: (line) => warnings.push(line) },
  });
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 5);
  const pending = inspector.findProcessForSessionAsync('abc-123');
  clock += 2_500;
  const found = await pending;
  clearInterval(ticker);
  assert.equal(found?.processId, 7001);
  assert.ok(ticks >= 3, `the event loop ticked while PowerShell ran (${ticks})`);
  assert.equal(calls.length, 1);
  const last = inspector.getLastRead();
  assert.equal(last.processes, 1);
  assert.equal(last.durationMs, 2_500);
  assert.equal(last.error, null);
  assert.equal(warnings.length, 1, 'a slow read is logged once');
  assert.match(warnings[0], /took 2500 ms for 1 processes/);
});

test('a timed-out or unreadable async read rejects and is recorded; the next call reads again', async () => {
  const timeout = Object.assign(new Error('powershell.exe timed out'), { killed: true, code: null });
  const { inspector, calls } = asyncWindowsInspector({ fail: timeout });
  await assert.rejects(inspector.findProcessForSessionAsync('abc-123'), /timed out/);
  assert.match(inspector.getLastRead().error, /timed out/);
  await assert.rejects(inspector.findWindowsProcessTreeForSessionAsync('abc-123'), /timed out/);
  assert.equal(calls.length, 2, 'a failure is not cached');

  const garbled = asyncWindowsInspector({ output: Buffer.from('[{"processId": 1, "name": ') });
  await assert.rejects(garbled.inspector.findProcessesForSessionAsync('abc-123'), { message: /^windows-process-snapshot-unreadable: / });
});

test('the async readers answer empty for a missing session id and on the other platform without a run', async () => {
  const { inspector, calls } = asyncWindowsInspector();
  assert.equal(await inspector.findProcessForSessionAsync(''), null);
  assert.deepEqual(await inspector.findWindowsProcessTreeForSessionAsync(null), []);
  assert.equal(calls.length, 0);

  const posixCalls = [];
  const posix = createSessionWorkerProcessInspector({
    platform: 'linux',
    execFileImpl(command, args, options, callback) {
      posixCalls.push(command);
      callback(null, Buffer.from('  501     1 node node /srv/oar/server/grok-worker/grok-session-worker.mjs --session-id abc-123\n  502   501 sh sh -c sleep 1\n'));
    },
  });
  const found = await posix.findProcessForSessionAsync('abc-123');
  assert.equal(found?.processId, 501);
  assert.deepEqual(posixCalls, ['ps']);
  assert.deepEqual(await posix.findWindowsProcessTreeForSessionAsync('abc-123'), [], 'no windows tree on posix');
});

test('stopWindowsPidsAsync runs the same stop script off the thread and reports a failure', async () => {
  const calls = [];
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileImpl(command, args, options, callback) {
      calls.push({ command, args, options });
      callback(null, '');
    },
  });
  assert.deepEqual(await inspector.stopWindowsPidsAsync([1001, '1002', 1001, 'x']), [1001, 1002]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[2], /Stop-Process -Id \$id -Force/);
  assert.match(calls[0].args[2], /\$ids = @\(1001,1002\)/);
  assert.ok(calls[0].options.timeout >= 10_000);
  assert.deepEqual(await inspector.stopWindowsPidsAsync([]), []);

  const failing = createSessionWorkerProcessInspector({
    platform: 'win32',
    execFileImpl(_command, _args, _options, callback) { callback(new Error('Access denied')); },
  });
  await assert.rejects(failing.stopWindowsPidsAsync([1001]), /Access denied/);
});
