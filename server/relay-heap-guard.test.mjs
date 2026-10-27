import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  availableMemory,
  createHeapWatch,
  defaultHeapLimitMb,
  displayPath,
  formatMemoryLine,
  nodeDefaultOldSpaceMb,
  operatorHeapLimit,
  relayRuntimeNodeFlags,
  relayRuntimeNodeFlagsOrNone,
  splitNodeOptions,
  startRelayMemoryLog,
} from './relay-heap-guard.mjs';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const HOME = '/home/dev';
const ENV = { COPILOT_WEB_RELAY_DATA_DIR: '/home/dev/.oar/data', COPILOT_WEB_RELAY_CONFIG: '/home/dev/.oar/config.json' };
const DIAGNOSTICS = path.join(path.resolve('/home/dev/.oar/data'), 'diagnostics');
const SHOWN = ['~', '.oar', 'data', 'diagnostics'].join(path.sep);

// A file system with one config.json, a drive with `free` bytes and the
// snapshots already in the diagnostics folder; records the folders made and
// the modes set.
function fakeFs({ config, free = 100 * GB, snapshots = [], mkdirError = '' } = {}) {
  const made = [];
  const chmods = [];
  const statfsDirs = [];
  return {
    made,
    chmods,
    statfsDirs,
    readFileSync() {
      if (config === undefined) throw Object.assign(new Error('no config'), { code: 'ENOENT' });
      return JSON.stringify(config);
    },
    mkdirSync(dir, options) {
      if (mkdirError) throw Object.assign(new Error(mkdirError), { code: mkdirError });
      made.push({ dir, options });
    },
    chmodSync(dir, mode) { chmods.push({ dir, mode }); },
    statfsSync(dir) { statfsDirs.push(dir); return { bavail: free / 4096, bsize: 4096 }; },
    readdirSync: () => snapshots,
  };
}

function flagsFor({ env = ENV, execArgv = [], totalMem = 8 * GB, constrainedMem = 0, platform = 'linux', fs: fsImpl = fakeFs() } = {}) {
  const logs = [];
  const result = relayRuntimeNodeFlags({
    env,
    execArgv,
    serverDir: '/home/dev/oar/server',
    totalMem,
    constrainedMem,
    heapSizeLimit: 2240 * MB,
    fsImpl,
    platform,
    homeDir: HOME,
    logger: { log: (line) => logs.push(line) },
  });
  return { ...result, logs };
}

test('the default is 60 % of RAM in 64 MB steps, between 2048 and 8192 MB', () => {
  assert.equal(defaultHeapLimitMb({ totalMem: 3.9 * GB }), 2368);
  assert.equal(defaultHeapLimitMb({ totalMem: 8 * GB }), 4864);
  assert.equal(defaultHeapLimitMb({ totalMem: 32 * GB }), 8192);
  assert.equal(defaultHeapLimitMb({ totalMem: 2 * GB }), 2048);
  assert.equal(defaultHeapLimitMb({ totalMem: 3.9 * GB, nodeDefaultMb: 4144 }), 4144, "never under Node's own default");
});

test("Node's default old space leaves the young generation out of v8's heap limit", () => {
  assert.equal(nodeDefaultOldSpaceMb(4288 * MB), 4096, 'Node 24 on a 64 GB box');
});

test('a container or cgroup limit under the RAM is the memory the default is taken from', () => {
  assert.deepEqual(availableMemory({ totalMem: 32 * GB, constrainedMem: 4 * GB }), { bytes: 4 * GB, label: 'memory limit' });
  // No undefined here: it would read this host's own process.constrainedMemory().
  for (const none of [0, null, Number.MAX_SAFE_INTEGER, 2 ** 64, NaN]) {
    assert.deepEqual(availableMemory({ totalMem: 32 * GB, constrainedMem: none }), { bytes: 32 * GB, label: 'RAM' }, String(none));
  }
  const capped = flagsFor({ totalMem: 32 * GB, constrainedMem: 4 * GB });
  assert.equal(capped.heapLimitMb, 2432);
  assert.ok(capped.logs.includes('[relay] heap limit 2432 MB (default: 60% of 4.0 GB memory limit)'), capped.logs.join('\n'));
  assert.equal(flagsFor({ totalMem: 32 * GB, constrainedMem: 1.5 * GB }).heapLimitMb, 1536, 'never above the memory there is');
});

test('by default the runtime gets a heap limit, one snapshot near it, and the diagnostics folder', () => {
  const fs = fakeFs({ snapshots: ['Heap.1.heapsnapshot', 'notes.txt'] });
  const { flags, heapLimitMb, logs, diagnosticDir } = flagsFor({ fs, totalMem: 3.9 * GB });
  assert.equal(heapLimitMb, 2368);
  assert.deepEqual(flags, ['--max-old-space-size=2368', '--heapsnapshot-near-heap-limit=1', `--diagnostic-dir=${DIAGNOSTICS}`]);
  assert.equal(diagnosticDir, DIAGNOSTICS);
  assert.deepEqual(fs.made, [{ dir: DIAGNOSTICS, options: { recursive: true, mode: 0o700 } }]);
  assert.deepEqual(fs.chmods, [{ dir: DIAGNOSTICS, mode: 0o700 }], 'a folder that was there is made owner-only too');
  assert.ok(logs.includes('[relay] heap limit 2368 MB (default: 60% of 3.9 GB RAM)'), logs.join('\n'));
  assert.ok(logs.includes(`[relay] heap snapshots near the limit go to ${SHOWN} (1 already there)`), logs.join('\n'));
  assert.ok(!logs.some((line) => line.includes(path.resolve(HOME))), 'no home path in the log');
});

test('on Windows the folder keeps the permissions it inherits', () => {
  const fs = fakeFs();
  flagsFor({ fs, platform: 'win32' });
  assert.deepEqual(fs.chmods, []);
});

test('NODE_OPTIONS is split as Node splits it, quotes taken off', () => {
  assert.deepEqual(splitNodeOptions('--max-old-space-size="3000"  "--trace-warnings" --diagnostic-dir="/home/dev/my dir"'), [
    '--max-old-space-size=3000',
    '--trace-warnings',
    '--diagnostic-dir=/home/dev/my dir',
  ]);
  assert.deepEqual(splitNodeOptions("'--max-old-space-size=3000'"), ["'--max-old-space-size=3000'"], 'a single quote is a character');
  assert.deepEqual(splitNodeOptions('"--title=a\\"b" --max-old-space-size=3000'), ['--title=a"b', '--max-old-space-size=3000']);
  assert.deepEqual(splitNodeOptions('--diagnostic-dir=/tmp/o\'b --max-old-space-size=3000'), ["--diagnostic-dir=/tmp/o'b", '--max-old-space-size=3000']);
  assert.deepEqual(splitNodeOptions(''), []);
});

test("an apostrophe or an escaped quote does not hide the operator's heap limit", () => {
  for (const nodeOptions of ["--diagnostic-dir=/tmp/o'b --max-old-space-size=3000", '"--title=a\\"b" --max-old-space-size=3000']) {
    assert.deepEqual(operatorHeapLimit({ nodeOptions }), { mb: 3000, source: 'NODE_OPTIONS' }, nodeOptions);
  }
  assert.equal(operatorHeapLimit({ nodeOptions: "'--max-old-space-size=3000'" }), null, 'Node rejects it: not a heap value');
});

test('a percentage wins over a size, as in Node', () => {
  assert.deepEqual(operatorHeapLimit({ execArgv: ['--max-old-space-size=3000'], nodeOptions: '--max-old-space-size-percentage=25' }), { percentage: 25, source: 'NODE_OPTIONS' });
  const { heapLimitMb, flags } = flagsFor({ execArgv: ['--max-old-space-size=3000', '--max-old-space-size-percentage=25'] });
  assert.equal(heapLimitMb, 2048, '25% of 8 GB');
  assert.ok(!flags.some((flag) => /max[-_]old[-_]space/.test(flag)), String(flags));
});

test('a heap limit in execArgv or NODE_OPTIONS wins and is not added again', () => {
  for (const [execArgv, nodeOptions, mb, source] of [
    [['--max-old-space-size=3000'], '', 3000, 'execArgv'],
    [['--max_old_space_size', '3100'], '', 3100, 'execArgv'],
    [[], '--enable-source-maps --max-old-space-size=4096', 4096, 'NODE_OPTIONS'],
    [[], '--max-old-space-size="3192"', 3192, 'NODE_OPTIONS'],
    [[], '"--max-old-space-size=3192"', 3192, 'NODE_OPTIONS'],
    [['--max-old-space-size=3000'], '--max-old-space-size=4096', 3000, 'execArgv'],
  ]) {
    const { flags, heapLimitMb, logs } = flagsFor({ execArgv, env: { ...ENV, NODE_OPTIONS: nodeOptions }, fs: fakeFs({ config: { heapLimitMb: 6000 } }) });
    assert.equal(heapLimitMb, mb, nodeOptions);
    assert.ok(!flags.some((flag) => /max[-_]old[-_]space/.test(flag)), `no duplicate: ${flags}`);
    assert.ok(logs.includes(`[relay] heap limit ${mb} MB (from ${source})`), logs.join('\n'));
  }
  assert.deepEqual(operatorHeapLimit({ execArgv: [], nodeOptions: '' }), null);
});

test("an operator's --max-old-space-size-percentage counts as their heap limit", () => {
  for (const [execArgv, nodeOptions, source] of [
    [['--max-old-space-size-percentage=50'], '', 'execArgv'],
    [[], '--max-old-space-size-percentage="50"', 'NODE_OPTIONS'],
  ]) {
    const { flags, heapLimitMb, logs } = flagsFor({ execArgv, env: { ...ENV, NODE_OPTIONS: nodeOptions } });
    assert.ok(!flags.some((flag) => /max[-_]old[-_]space/.test(flag)), `nothing added: ${flags}`);
    assert.equal(heapLimitMb, 4096);
    assert.ok(logs.includes(`[relay] heap limit 4096 MB (50% of 8.0 GB RAM, from ${source})`), logs.join('\n'));
  }
});

test("config.json's heapLimitMb is honoured, capped at the memory there is, and an invalid one ignored", () => {
  const set = flagsFor({ fs: fakeFs({ config: { heapLimitMb: 3072 } }) });
  assert.equal(set.flags[0], '--max-old-space-size=3072');
  assert.ok(set.logs.includes('[relay] heap limit 3072 MB (from config heapLimitMb)'));
  const tooBig = flagsFor({ fs: fakeFs({ config: { heapLimitMb: 65536 } }) });
  assert.equal(tooBig.flags[0], '--max-old-space-size=8192');
  assert.ok(tooBig.logs.includes('[relay] config heapLimitMb=65536 is more than the 8.0 GB RAM; using 8192 MB'), tooBig.logs.join('\n'));
  for (const invalid of [100, 'lots', 2048.5]) {
    const { flags, logs } = flagsFor({ fs: fakeFs({ config: { heapLimitMb: invalid } }) });
    assert.equal(flags[0], '--max-old-space-size=4864', String(invalid));
    assert.ok(logs.some((line) => line.startsWith(`[relay] config heapLimitMb=${JSON.stringify(invalid)} ignored`)), String(invalid));
  }
});

test('without a pinned data dir the diagnostics folder follows config dataDir', () => {
  const fs = fakeFs({ config: { dataDir: '/home/dev/oar-data' } });
  const { diagnosticDir } = flagsFor({ env: { COPILOT_WEB_RELAY_CONFIG: '/home/dev/.oar/config.json' }, fs });
  assert.equal(diagnosticDir, path.join(path.resolve('/home/dev/oar-data'), 'diagnostics'));
});

test("an operator's --heapsnapshot-near-heap-limit and --diagnostic-dir are kept as they are", () => {
  const fs = fakeFs();
  const own = path.resolve('/srv/dumps');
  const { flags, diagnosticDir, snapshot, logs } = flagsFor({
    fs,
    execArgv: ['--heapsnapshot-near-heap-limit=3'],
    env: { ...ENV, NODE_OPTIONS: `--diagnostic-dir=${own}` },
  });
  assert.deepEqual(flags, ['--max-old-space-size=4864'], 'neither added again');
  assert.equal(snapshot, true);
  assert.equal(diagnosticDir, own);
  assert.deepEqual(fs.made, [], "the operator's folder is not made");
  assert.deepEqual(fs.chmods, [], "nor changed");
  assert.deepEqual(fs.statfsDirs, [own], 'its drive is the one checked');
  assert.ok(logs.includes(`[relay] heap snapshots near the limit go to ${own} (0 already there)`), logs.join('\n'));
});

test('no snapshot when the folder cannot be made or its drive is short; the heap limit stays', () => {
  const unmade = flagsFor({ fs: fakeFs({ mkdirError: 'EACCES' }) });
  assert.deepEqual(unmade.flags, ['--max-old-space-size=4864']);
  assert.equal(unmade.snapshot, false);
  assert.ok(unmade.logs.includes(`[relay] no heap snapshot near the limit: cannot prepare ${SHOWN} (EACCES)`), unmade.logs.join('\n'));

  const short = flagsFor({ fs: fakeFs({ free: 9000 * MB }) });
  assert.deepEqual(short.flags, ['--max-old-space-size=4864', `--diagnostic-dir=${DIAGNOSTICS}`]);
  assert.ok(short.logs.includes(`[relay] no heap snapshot near the limit: ${SHOWN} has 9000 MB free, under twice the heap limit`), short.logs.join('\n'));
});

test('a heap guard that fails starts the runtime without flags, with a line', () => {
  const logs = [];
  const result = relayRuntimeNodeFlagsOrNone(() => { throw new Error('statfs exploded'); }, { logger: { log: (line) => logs.push(line) } });
  assert.deepEqual(result, { flags: [] });
  assert.deepEqual(logs, ['[relay] starting the runtime without heap flags: statfs exploded']);
});

test('log paths name the home folder as ~', () => {
  assert.equal(displayPath('/home/dev/.oar/data/diagnostics', HOME), SHOWN);
  assert.equal(displayPath('/srv/oar/diagnostics', HOME), path.resolve('/srv/oar/diagnostics'));
  assert.equal(displayPath('/home/devil/x', HOME), path.resolve('/home/devil/x'), 'only the home folder itself');
});

test('the memory line, in MB', () => {
  assert.equal(
    formatMemoryLine({ rss: 812 * MB, heapUsed: 640.4 * MB, heapLimit: 2416 * MB }),
    '[relay] memory rss=812 heapUsed=640 heapLimit=2416',
  );
});

test('the 80 % line fires once per crossing, and again only after a drop below', () => {
  const logs = [];
  const watch = createHeapWatch({ logger: { log: (line) => logs.push(line) } });
  const limit = 1000 * MB;
  const fired = [500, 810, 900, 850, 700, 820, 790, 800].map((used) => watch.check({ heapUsed: used * MB, heapLimit: limit }));
  assert.deepEqual(fired, [false, true, false, false, false, true, false, true]);
  assert.equal(logs[0], '[relay] memory high: heapUsed=810 is over 80% of heapLimit=1000');
  assert.equal(logs.length, 3);
});

test('the memory log logs at once, runs on unref\'d timers and stops when they are cleared', async () => {
  const logs = [];
  let samples = 0;
  const timers = startRelayMemoryLog({
    logger: { log: (line) => logs.push(line) },
    memoryUsage: () => { samples += 1; return { rss: 100 * MB, heapUsed: 50 * MB }; },
    heapLimit: () => 1000 * MB,
    logIntervalMs: 5,
    watchIntervalMs: 5,
  });
  assert.deepEqual(logs, ['[relay] memory rss=100 heapUsed=50 heapLimit=1000']);
  assert.equal(timers.log.hasRef(), false);
  assert.equal(timers.check.hasRef(), false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(samples > 2, 'both timers ran');
  clearInterval(timers.log);
  clearInterval(timers.check);
  const stoppedAt = samples;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(samples, stoppedAt, 'cleared timers run no more');
});

test('the runtime keeps both memory timers in runtimeTimers, which shutdown clears', () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'server-runtime.mjs'), 'utf8');
  const start = source.indexOf('const runtimeTimers = {');
  const block = source.slice(start, source.indexOf('};', start));
  assert.match(block, /memoryLog: null,/);
  assert.match(block, /memoryWatch: null,/);
  assert.match(source, /runtimeTimers\.memoryLog = memoryTimers\.log;/);
  assert.match(source, /runtimeTimers\.memoryWatch = memoryTimers\.check;/);
  assert.match(source, /function clearRuntimeTimers\(\) \{\r?\n {2}for \(const timer of Object\.values\(runtimeTimers\)\)/);
});
