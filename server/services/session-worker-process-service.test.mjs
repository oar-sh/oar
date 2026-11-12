import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProcessIdentityReader,
  createSessionWorkerProcessInspector,
  identityOfListedWorker,
  isSameProcess,
  judgeSessionWorkerProcess,
  mayReuseSessionWorkerRow,
  parseProcStatStartTime,
  parsePsStartAndArgs,
} from './session-worker-process-service.mjs';

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
    systemToolPath: (name) => `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\${name}`,
    execFileSyncImpl(command, args) {
      assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
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
    systemToolPath: (name) => `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\${name}`,
    execFileSyncImpl(command, args) {
      assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
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

test('identityOfListedWorker: on Windows the fresh row is the identity, with no read; elsewhere the reader is asked', async () => {
  const reads = [];
  const identityOf = async (pid, options) => { reads.push([pid, options]); return { pid, startTime: '42', commandLine: 'node x --session-id abc-123' }; };
  const row = { processId: 7001, commandLine: 'node claude-session-worker.mjs --session-id abc-123', createdAt: 1762941600000 };
  assert.deepEqual(await identityOfListedWorker(row, { platform: 'win32', identityOf }), { pid: 7001, startTime: '1762941600000', commandLine: row.commandLine });
  assert.deepEqual(await identityOfListedWorker({ ...row, createdAt: 0 }, { platform: 'win32', identityOf }), { pid: 7001, startTime: null, commandLine: row.commandLine });
  assert.deepEqual(reads, [], 'no read on Windows');
  assert.equal(mayReuseSessionWorkerRow({ row, current: await identityOfListedWorker(row, { platform: 'win32' }), sdkSessionId: 'abc-123' }), true);

  assert.deepEqual(await identityOfListedWorker({ processId: 4242 }, { platform: 'linux', identityOf }), { pid: 4242, startTime: '42', commandLine: 'node x --session-id abc-123' });
  assert.deepEqual(reads, [[4242, { fresh: true }]]);
  assert.deepEqual(await identityOfListedWorker({ processId: 4242 }, { platform: 'linux', identityOf: async () => { throw new Error('unreadable'); } }), { pid: 4242, startTime: null, commandLine: null });
  assert.deepEqual(await identityOfListedWorker({ processId: 4242 }, { platform: 'darwin' }), { pid: 4242, startTime: null, commandLine: null });
  assert.equal(await identityOfListedWorker({ processId: 0 }, { platform: 'win32' }), null);
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

test('the POSIX process list is read with a bounded ps', async () => {
  const runs = [];
  const inspector = createSessionWorkerProcessInspector({
    platform: 'linux',
    execFileSyncImpl() { throw new Error('the synchronous reader must not run'); },
    execFileImpl(command, args, options, callback) {
      runs.push({ command, args, options });
      callback(null, '4242 1 node node /home/dev/oar/server/claude-worker/claude-session-worker.mjs --session-id abc-123\n');
    },
  });
  assert.equal((await inspector.findProcessForSessionAsync('abc-123', { fresh: true }))?.processId, 4242);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, 'ps');
  assert.equal(runs[0].options.timeout, 5000);
  assert.ok(runs[0].options.maxBuffer > 0);
});

test('a fresh read never joins a read that began before it; notBefore takes only a read begun after it', async () => {
  let clock = 2_000_000;
  let run = 0;
  // Each run answers with its own list: the first one still names the
  // session's old worker, the later ones its new one.
  const { inspector, calls } = asyncWindowsInspector({
    nowMs: () => clock,
    snapshotCacheMs: 1_500,
    output: () => {
      run += 1;
      return Buffer.from(JSON.stringify([{ processId: run === 1 ? 7001 : 7002, parentProcessId: 1, name: 'node.exe', commandLine: 'node claude-session-worker.mjs --session-id abc-123' }]));
    },
  });
  // A read starts (a sweep, say) before the caller's stop and spawn are over.
  const early = inspector.findProcessForSessionAsync('abc-123');
  clock += 10;
  const fresh = inspector.findProcessForSessionAsync('abc-123', { fresh: true });
  // A caller without a wish joins the read already running.
  const plain = inspector.findProcessForSessionAsync('abc-123');
  const [a, b, c] = await Promise.all([early, fresh, plain]);
  assert.equal(calls.length, 2, 'the fresh caller got a read of its own');
  assert.equal(a?.processId, 7001);
  assert.equal(b?.processId, 7002, 'the fresh read names what runs after the caller');
  assert.equal(c?.processId, 7001);
  // The cache holds the read that began last, whichever finished last.
  assert.equal((await inspector.findProcessForSessionAsync('abc-123'))?.processId, 7002);
  assert.equal(calls.length, 2);

  // notBefore: the cached read (begun at 2_000_010) is used only for a time
  // before it began.
  assert.equal((await inspector.findProcessForSessionAsync('abc-123', { notBefore: 2_000_009 }))?.processId, 7002);
  assert.equal(calls.length, 2, 'begun after notBefore: reused');
  await inspector.findProcessForSessionAsync('abc-123', { notBefore: 2_000_010 });
  assert.equal(calls.length, 3, 'begun at notBefore, possibly before it: read again');
  // A read running since before notBefore is not joined either.
  clock += 5;
  const running = inspector.readProcessSnapshot({ fresh: true });
  const later = inspector.readProcessSnapshot({ notBefore: clock });
  await Promise.all([running, later]);
  assert.equal(calls.length, 5);
});

test('fresh callers share one read that begins after them all: on Windows one CIM query at a time', async () => {
  let clock = 3_000_000;
  let run = 0;
  let active = 0;
  let most = 0;
  let failNext = false;
  const calls = [];
  const inspector = createSessionWorkerProcessInspector({
    platform: 'win32',
    now: () => clock,
    snapshotCacheMs: 1_500,
    execFileSyncImpl() { throw new Error('the synchronous reader must not run'); },
    execFileImpl(command, args, options, callback) {
      calls.push(command);
      run += 1;
      const mine = run;
      const fail = failNext;
      failNext = false;
      active += 1;
      most = Math.max(most, active);
      setTimeout(() => {
        active -= 1;
        if (fail) {
          callback(new Error('powershell.exe timed out'));
          return;
        }
        callback(null, Buffer.from(JSON.stringify([{ processId: 7000 + mine, parentProcessId: 1, name: 'node.exe', commandLine: 'node claude-session-worker.mjs --session-id abc-123' }])));
      }, 5);
    },
  });
  const pids = (list) => list.map((proc) => proc.processId);

  // A read runs (a sweep, say); three fresh callers come while it does.
  const early = inspector.readProcessSnapshot();
  clock += 10;
  const fresh = [
    inspector.readProcessSnapshot({ fresh: true }),
    inspector.findProcessesForSessionAsync('abc-123', { fresh: true }),
    inspector.findWindowsProcessTreeForSessionAsync('abc-123', { fresh: true }),
  ];
  assert.equal(calls.length, 1, 'the next read waits for the running one');
  const [first, ...rest] = await Promise.all([early, ...fresh]);
  assert.deepEqual(pids(first), [7001]);
  assert.deepEqual(rest.map(pids), [[7002], [7002], [7002]], 'all three share the read that began after them');
  assert.equal(calls.length, 2);
  assert.equal(most, 1, 'never two reads at once');

  // Nothing runs: the first fresh caller starts a read at once, the ones
  // after it (a millisecond later) share the next one.
  clock += 10;
  const a = inspector.readProcessSnapshot({ fresh: true });
  assert.equal(calls.length, 3);
  clock += 1;
  const later = [inspector.readProcessSnapshot({ fresh: true }), inspector.readProcessSnapshot({ fresh: true })];
  assert.deepEqual([pids(await a), ...(await Promise.all(later)).map(pids)], [[7003], [7004], [7004]]);
  assert.equal(calls.length, 4);
  assert.equal(most, 1);

  // A running read that fails still lets the next one begin.
  clock += 2_000;
  failNext = true;
  const failing = inspector.readProcessSnapshot();
  clock += 10;
  const afterFailure = inspector.readProcessSnapshot({ fresh: true });
  await assert.rejects(failing, /timed out/);
  assert.deepEqual(pids(await afterFailure), [7006]);
  assert.equal(calls.length, 6);
  assert.equal(most, 1);
});

test('the async read keeps the event loop running and records what it did', async () => {
  let clock = 5_000;
  const warnings = [];
  const { inspector, calls } = asyncWindowsInspector({
    // Long enough for three ticks of a 5 ms interval at Windows' 15.6 ms
    // timer granularity, with room to spare on a loaded machine.
    delayMs: 200,
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

// ─── Process identity ────────────────────────────────────────────────────────

test('parseProcStatStartTime reads field 22, past a command name with spaces and parentheses', () => {
  // Fields 3-21 then 22 (starttime) and a few more.
  const tail = 'S 1 4100 4100 0 -1 4194560 3071 0 0 0 12 3 0 0 20 0 11 0 987654 1131913216 12544';
  assert.equal(parseProcStatStartTime(`4242 (node) ${tail}`), '987654');
  assert.equal(parseProcStatStartTime(`4242 (we(ird) name)) ${tail}`), '987654');
  assert.equal(parseProcStatStartTime('4242 (node) S 1'), null);
  assert.equal(parseProcStatStartTime(''), null);
});

test('parsePsStartAndArgs splits lstart from the command line', () => {
  assert.deepEqual(
    parsePsStartAndArgs('Thu Nov 12 10:00:00 2026     node claude-session-worker.mjs --session-id sid-ps\n'),
    { startTime: 'Thu Nov 12 10:00:00 2026', commandLine: 'node claude-session-worker.mjs --session-id sid-ps' },
  );
  assert.deepEqual(parsePsStartAndArgs('Mon Nov  2 09:05:01 2026 '), { startTime: 'Mon Nov 2 09:05:01 2026', commandLine: '' });
  assert.equal(parsePsStartAndArgs('\n'), null);
  assert.deepEqual(parsePsStartAndArgs('garbled'), { startTime: null, commandLine: null });
});

test('identity on Linux and Termux: /proc stat and cmdline; a missing pid is null; an unreadable one unknown', async () => {
  const stat = '4242 (node) S 1 4100 4100 0 -1 4194560 3071 0 0 0 12 3 0 0 20 0 11 0 987654 1131913216 12544';
  for (const platform of ['linux', 'android']) {
    const reads = [];
    const identityOf = createProcessIdentityReader({
      platform,
      readFileImpl: async (file) => {
        reads.push(file);
        if (file === '/proc/4242/stat') return stat;
        if (file === '/proc/4242/cmdline') return 'node\0/home/dev/oar/server/claude-session-worker.mjs\0--session-id\0sid-proc\0';
        throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
      },
      execFileImpl: () => { throw new Error('ps is not run on /proc systems'); },
    });
    assert.deepEqual(await identityOf(4242), {
      pid: 4242,
      startTime: '987654',
      commandLine: 'node /home/dev/oar/server/claude-session-worker.mjs --session-id sid-proc',
    }, platform);
    assert.deepEqual(reads, ['/proc/4242/stat', '/proc/4242/cmdline'], platform);
    assert.equal(await identityOf(4343), null, platform);
    assert.equal(await identityOf(0), null, platform);
  }
  const denied = createProcessIdentityReader({
    platform: 'linux',
    readFileImpl: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  });
  assert.deepEqual(await denied(4242), { pid: 4242, startTime: null, commandLine: null });
});

test('identity on macOS: one ps run with lstart and args under the C locale; exit 1 with no output is no process', async () => {
  const runs = [];
  const identityOf = createProcessIdentityReader({
    platform: 'darwin',
    readFileImpl: async () => { throw new Error('/proc is not read on macOS'); },
    execFileImpl: (command, args, options, callback) => {
      runs.push({ command, args, locale: options?.env?.LC_ALL, timeout: options?.timeout });
      if (args.at(-1) === '4242') callback(null, 'Thu Nov 12 10:00:00 2026 node claude-session-worker.mjs --session-id sid-mac\n', '');
      else if (args.at(-1) === '4343') callback(Object.assign(new Error('exit 1'), { code: 1 }), '', '');
      else callback(Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' }), '', '');
    },
  });
  assert.deepEqual(await identityOf(4242), {
    pid: 4242,
    startTime: 'Thu Nov 12 10:00:00 2026',
    commandLine: 'node claude-session-worker.mjs --session-id sid-mac',
  });
  // Bounded: a ps that hangs is an unknown, not a stalled recycle or stop.
  assert.deepEqual(runs[0], { command: 'ps', args: ['-ww', '-o', 'lstart=', '-o', 'args=', '-p', '4242'], locale: 'C', timeout: 5000 });
  assert.equal(await identityOf(4343), null);
  assert.deepEqual(await identityOf(4444), { pid: 4444, startTime: null, commandLine: null });
});

test('identity on Windows: the process list\'s createdAt and command line, read as asked', async () => {
  const asked = [];
  let fail = false;
  const identityOf = createProcessIdentityReader({
    platform: 'win32',
    readProcessSnapshot: async (options) => {
      asked.push(options);
      if (fail) throw new Error('windows-process-snapshot-unreadable');
      return [
        { processId: 4242, parentProcessId: 1, name: 'node.exe', commandLine: 'node claude-session-worker.mjs --session-id sid-win', createdAt: 1762941600000 },
        { processId: 4343, parentProcessId: 1, name: 'svchost.exe', commandLine: '', createdAt: 0 },
      ];
    },
  });
  assert.deepEqual(await identityOf(4242, { fresh: true }), { pid: 4242, startTime: '1762941600000', commandLine: 'node claude-session-worker.mjs --session-id sid-win' });
  assert.deepEqual(await identityOf(4343), { pid: 4343, startTime: null, commandLine: '' });
  assert.equal(await identityOf(4444), null);
  assert.deepEqual(asked, [{ fresh: true }, { fresh: false }, { fresh: false }]);
  fail = true;
  assert.deepEqual(await identityOf(4242), { pid: 4242, startTime: null, commandLine: null });
  // No list to read: nothing is known.
  assert.deepEqual(await createProcessIdentityReader({ platform: 'win32' })(4242), { pid: 4242, startTime: null, commandLine: null });
});

test('isSameProcess needs the pid and a known, equal start time', () => {
  assert.equal(isSameProcess({ pid: 7, startTime: '100' }, { pid: 7, startTime: '100' }), true);
  assert.equal(isSameProcess({ pid: 7, startTime: '100' }, { pid: 7, startTime: '101' }), false);
  assert.equal(isSameProcess({ pid: 7, startTime: '100' }, { pid: 8, startTime: '100' }), false);
  assert.equal(isSameProcess({ pid: 7, startTime: null }, { pid: 7, startTime: null }), false);
  assert.equal(isSameProcess(null, { pid: 7, startTime: '100' }), false);
});

test('judgeSessionWorkerProcess: gone, another process, the session\'s own, or not known', () => {
  const sdkSessionId = 'sid-judge';
  const ours = { pid: 7, startTime: '100', commandLine: 'node claude-session-worker.mjs --session-id sid-judge' };
  assert.equal(judgeSessionWorkerProcess(null, { sdkSessionId }), 'gone');
  assert.equal(judgeSessionWorkerProcess(ours, { sdkSessionId }), 'ours');
  assert.equal(judgeSessionWorkerProcess(ours, { sdkSessionId, before: { pid: 7, startTime: '100' } }), 'ours');
  // Its pid handed out again: another start time.
  assert.equal(judgeSessionWorkerProcess(ours, { sdkSessionId, before: { pid: 7, startTime: '99' } }), 'other');
  // A process whose command line names another session, or none (a zombie).
  assert.equal(judgeSessionWorkerProcess({ ...ours, commandLine: 'node claude-session-worker.mjs --session-id sid-else' }, { sdkSessionId }), 'other');
  assert.equal(judgeSessionWorkerProcess({ ...ours, commandLine: '' }, { sdkSessionId }), 'other');
  assert.equal(judgeSessionWorkerProcess({ pid: 7, startTime: null, commandLine: null }, { sdkSessionId }), 'unverified');
  assert.equal(judgeSessionWorkerProcess({ pid: 7, startTime: '100', commandLine: null }, { sdkSessionId, before: { pid: 7, startTime: '100' } }), 'unverified');
});
