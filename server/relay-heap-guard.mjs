import fs from 'fs';
import os from 'os';
import path from 'path';
import v8 from 'v8';

import { resolveDataDir } from './services/data-dir-resolution.mjs';

// The config.json key an operator sets to pin the runtime's heap (MB). A key
// and not an env var: a shell's NODE_OPTIONS is lost on the next relaunch by
// systemd, an autostart launcher or the CLI extension; config.json is read by
// every one of them.
export const HEAP_LIMIT_CONFIG_KEY = 'heapLimitMb';
export const MIN_HEAP_LIMIT_MB = 512;
const DEFAULT_FLOOR_MB = 2048;
const DEFAULT_CAP_MB = 8192;
const DEFAULT_RAM_SHARE = 0.6;
// v8's heap_size_limit is old space plus the young generation, while
// --max-old-space-size sets old space only: compare like with like. Node 24
// reserves 3 × 64 MB semi-spaces (old space 2048 → heap_size_limit 2240);
// older Nodes reserve less, which only sets this floor a little low.
const YOUNG_GENERATION_ALLOWANCE_MB = 192;
const MB = 1024 * 1024;

const HEAP_FLAG = /^--max[-_]old[-_]space[-_]size(?:=(.*))?$/;
// Node 24.11+: the old space as a percentage of the memory Node sees.
const HEAP_PERCENTAGE_FLAG = /^--max[-_]old[-_]space[-_]size[-_]percentage(?:=(.*))?$/;
const SNAPSHOT_FLAG = /^--heapsnapshot[-_]near[-_]heap[-_]limit(?:=|$)/;
const DIAGNOSTIC_DIR_FLAG = /^--diagnostic[-_]dir(?:=(.*))?$/;

/**
 * NODE_OPTIONS as Node splits it (ParseNodeOptionsEnvVar): on spaces, except
 * inside double quotes, which are taken off; inside them a backslash escapes
 * the next character. A single quote is an ordinary character.
 */
export function splitNodeOptions(value) {
  const args = [];
  let current = '';
  let inString = false;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    let char = text[index];
    if (char === '\\' && inString && index + 1 < text.length) {
      index += 1;
      char = text[index];
    } else if (char === ' ' && !inString) {
      if (current) args.push(current);
      current = '';
      continue;
    } else if (char === '"') {
      inString = !inString;
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

// The value the last `flag` in an arg list sets (`=V` or V as the next arg),
// as in Node; undefined when none sets it.
function lastFlagValue(args, flag) {
  let found;
  for (let index = 0; index < args.length; index += 1) {
    const match = flag.exec(String(args[index]));
    if (match) found = match[1] !== undefined ? match[1] : String(args[index + 1] ?? '');
  }
  return found;
}

function positiveNumber(value) {
  const number = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * The heap limit the operator set in execArgv or NODE_OPTIONS: `{ mb }` for
 * --max-old-space-size, `{ percentage }` for --max-old-space-size-percentage,
 * with its `source`; null when neither sets one. As in Node, a percentage
 * wins over a size wherever each is set, and execArgv over NODE_OPTIONS.
 */
export function operatorHeapLimit({ execArgv = [], nodeOptions = '' } = {}) {
  const sources = [['execArgv', Array.from(execArgv || [])], ['NODE_OPTIONS', splitNodeOptions(nodeOptions)]];
  for (const [source, args] of sources) {
    const percentage = positiveNumber(lastFlagValue(args, HEAP_PERCENTAGE_FLAG));
    if (percentage) return { percentage, source };
  }
  for (const [source, args] of sources) {
    const mb = positiveNumber(lastFlagValue(args, HEAP_FLAG));
    if (mb) return { mb: Math.floor(mb), source };
  }
  return null;
}

/**
 * The memory this host gives the relay: a container's or cgroup's limit
 * (process.constrainedMemory) when it is set and under the RAM, else the RAM.
 * Without a limit it reports 0, nothing, or a huge number: ignored.
 */
export function availableMemory({ totalMem = os.totalmem(), constrainedMem = process.constrainedMemory?.() } = {}) {
  const total = Number(totalMem) || 0;
  const constrained = Number(constrainedMem);
  if (Number.isFinite(constrained) && constrained > 0 && constrained < total) {
    return { bytes: constrained, label: 'memory limit' };
  }
  return { bytes: total, label: 'RAM' };
}

/**
 * 60 % of RAM in whole 64 MB steps, between 2048 and 8192 MB, and never under
 * Node's own default (`nodeDefaultMb`, old space only). 60 % leaves room for
 * the CLI workers and for writing a heap snapshot: a heap that fills RAM ends
 * in the kernel's OOM killer, which leaves neither a snapshot nor a log line.
 */
export function defaultHeapLimitMb({ totalMem = os.totalmem(), nodeDefaultMb = 0 } = {}) {
  const share = Math.floor((Number(totalMem) || 0) * DEFAULT_RAM_SHARE / MB / 64) * 64;
  const clamped = Math.min(DEFAULT_CAP_MB, Math.max(DEFAULT_FLOOR_MB, share));
  return Math.max(clamped, Math.floor(Number(nodeDefaultMb) || 0));
}

/** Node's default old-space limit, from this process's v8 heap limit. */
export function nodeDefaultOldSpaceMb(heapSizeLimit = v8.getHeapStatistics().heap_size_limit) {
  return Math.max(0, Math.floor(Number(heapSizeLimit) / MB) - YOUNG_GENERATION_ALLOWANCE_MB);
}

function resolveConfigPath(env, serverDir) {
  const fromEnv = String(env?.COPILOT_WEB_RELAY_CONFIG || '').trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(String(serverDir || ''), 'config.json');
}

/**
 * config.json's heapLimitMb: `{ mb }`, `{ invalid }` for a value that is not a
 * whole number of at least MIN_HEAP_LIMIT_MB, or null when it sets none. An
 * unreadable config sets none: the runtime reports config problems itself.
 */
export function configuredHeapLimit({ configPath, fsImpl = fs } = {}) {
  let parsed = null;
  try { parsed = JSON.parse(fsImpl.readFileSync(configPath, 'utf8')); } catch { return null; }
  const value = parsed?.[HEAP_LIMIT_CONFIG_KEY];
  if (value === undefined || value === null || value === '') return null;
  const mb = Number(value);
  return Number.isInteger(mb) && mb >= MIN_HEAP_LIMIT_MB ? { mb } : { invalid: value };
}

// Free bytes on the disk of `dir`, or null when unknown. Also used by the
// database backup's space check (db-backup-service.mjs), with diskBytes.
export function freeBytes(dir, fsImpl) {
  try {
    if (typeof fsImpl.statfsSync !== 'function') return null;
    const stats = fsImpl.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

// The size of the disk of `dir`, or null when unknown.
export function diskBytes(dir, fsImpl) {
  try {
    if (typeof fsImpl.statfsSync !== 'function') return null;
    const stats = fsImpl.statfsSync(dir);
    return Number(stats.blocks) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/** A path for the log: `~` for the home folder, so a log line names no user. */
export function displayPath(target, homeDir = os.homedir()) {
  const resolved = path.resolve(String(target || ''));
  const home = String(homeDir || '').trim() ? path.resolve(String(homeDir)) : '';
  if (!home) return resolved;
  const relative = path.relative(home, resolved);
  if (relative === '') return '~';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return resolved;
  return `~${path.sep}${relative}`;
}

function countSnapshots(dir, fsImpl) {
  try {
    return fsImpl.readdirSync(dir).filter((name) => name.endsWith('.heapsnapshot')).length;
  } catch {
    return 0;
  }
}

/**
 * The Node flags every relay runtime starts with: a known heap limit, and one
 * heap snapshot near it, written to `<data dir>/diagnostics`.
 *
 * The heap limit comes from execArgv or NODE_OPTIONS when the operator set
 * one there (nothing added), else config.json's heapLimitMb, else
 * defaultHeapLimitMb; neither of the last two goes above the memory the host
 * gives the relay (availableMemory). The diagnostics folder is made 0700 (a
 * snapshot holds the auth token and provider keys); a --diagnostic-dir or
 * --heapsnapshot-near-heap-limit the operator set is kept as it is. When the
 * folder cannot be made, or its drive has less than twice the heap limit
 * free (the database lives there too), no snapshot is asked for. Says what
 * it chose on `logger`, with the home folder as `~`.
 */
export function relayRuntimeNodeFlags({
  env = process.env,
  execArgv = process.execArgv,
  serverDir,
  totalMem = os.totalmem(),
  constrainedMem = process.constrainedMemory?.(),
  heapSizeLimit = v8.getHeapStatistics().heap_size_limit,
  fsImpl = fs,
  platform = process.platform,
  homeDir = os.homedir(),
  logger = console,
} = {}) {
  const log = (line) => logger?.log?.(line);
  const operatorArgs = [...Array.from(execArgv || []), ...splitNodeOptions(env?.NODE_OPTIONS)];
  const memory = availableMemory({ totalMem, constrainedMem });
  const memoryMb = Math.floor(memory.bytes / MB / 64) * 64;
  const memoryText = `${(memory.bytes / 1024 ** 3).toFixed(1)} GB ${memory.label}`;
  const flags = [];

  let heapLimitMb;
  let source;
  const operator = operatorHeapLimit({ execArgv, nodeOptions: env?.NODE_OPTIONS });
  if (operator?.mb) {
    heapLimitMb = operator.mb;
    source = `from ${operator.source}`;
  } else if (operator?.percentage) {
    heapLimitMb = Math.floor(memory.bytes * operator.percentage / 100 / MB);
    source = `${operator.percentage}% of ${memoryText}, from ${operator.source}`;
  } else {
    const configured = configuredHeapLimit({ configPath: resolveConfigPath(env, serverDir), fsImpl });
    if (configured?.invalid !== undefined) {
      log(`[relay] config ${HEAP_LIMIT_CONFIG_KEY}=${JSON.stringify(configured.invalid)} ignored: expected a whole number of MB, at least ${MIN_HEAP_LIMIT_MB}`);
    }
    if (configured?.mb) {
      heapLimitMb = configured.mb;
      source = `from config ${HEAP_LIMIT_CONFIG_KEY}`;
      if (memoryMb >= MIN_HEAP_LIMIT_MB && heapLimitMb > memoryMb) {
        log(`[relay] config ${HEAP_LIMIT_CONFIG_KEY}=${heapLimitMb} is more than the ${memoryText}; using ${memoryMb} MB`);
        heapLimitMb = memoryMb;
      }
    } else {
      heapLimitMb = defaultHeapLimitMb({ totalMem: memory.bytes, nodeDefaultMb: nodeDefaultOldSpaceMb(heapSizeLimit) });
      if (memoryMb >= MIN_HEAP_LIMIT_MB) heapLimitMb = Math.min(heapLimitMb, memoryMb);
      source = `default: ${Math.round(DEFAULT_RAM_SHARE * 100)}% of ${memoryText}`;
    }
    flags.push(`--max-old-space-size=${heapLimitMb}`);
  }
  log(`[relay] heap limit ${heapLimitMb} MB (${source})`);

  // The operator's --diagnostic-dir is theirs: checked, never made or changed.
  const operatorDir = lastFlagValue(operatorArgs, DIAGNOSTIC_DIR_FLAG);
  const diagnosticDir = operatorDir
    ? path.resolve(operatorDir)
    : path.join(resolveDataDir({ env, configPath: resolveConfigPath(env, serverDir), serverDir, fsImpl }), 'diagnostics');
  const shownDir = displayPath(diagnosticDir, homeDir);
  let snapshot = false;
  try {
    if (!operatorDir) {
      fsImpl.mkdirSync(diagnosticDir, { recursive: true, mode: 0o700 });
      // mkdir leaves a folder that was there as it was.
      if (platform !== 'win32') fsImpl.chmodSync?.(diagnosticDir, 0o700);
    }
    const free = freeBytes(diagnosticDir, fsImpl);
    if (operatorArgs.some((arg) => SNAPSHOT_FLAG.test(arg))) {
      snapshot = true;
    } else if (free !== null && free < 2 * heapLimitMb * MB) {
      log(`[relay] no heap snapshot near the limit: ${shownDir} has ${Math.floor(free / MB)} MB free, under twice the heap limit`);
    } else {
      flags.push('--heapsnapshot-near-heap-limit=1');
      snapshot = true;
    }
    if (!operatorDir) flags.push(`--diagnostic-dir=${diagnosticDir}`);
    if (snapshot) {
      log(`[relay] heap snapshots near the limit go to ${shownDir} (${countSnapshots(diagnosticDir, fsImpl)} already there)`);
    }
  } catch (error) {
    log(`[relay] no heap snapshot near the limit: cannot prepare ${shownDir} (${error?.code || error?.message || error})`);
  }

  return { flags, heapLimitMb, source, diagnosticDir, snapshot };
}

/**
 * relayRuntimeNodeFlags' flags, or none when it fails: a runtime must start
 * even when its heap guard cannot be worked out.
 */
export function relayRuntimeNodeFlagsOrNone(nodeFlags, options = {}) {
  try {
    return nodeFlags(options);
  } catch (error) {
    options.logger?.log?.(`[relay] starting the runtime without heap flags: ${error?.message || error}`);
    return { flags: [] };
  }
}

function toMb(bytes) {
  return Math.round((Number(bytes) || 0) / MB);
}

/** `[relay] memory rss=<MB> heapUsed=<MB> heapLimit=<MB>` */
export function formatMemoryLine({ rss, heapUsed, heapLimit }) {
  return `[relay] memory rss=${toMb(rss)} heapUsed=${toMb(heapUsed)} heapLimit=${toMb(heapLimit)}`;
}

/**
 * Says once when heapUsed crosses `threshold` of the heap limit, and again
 * only after it has been back under it. `check` returns whether it said so.
 */
export function createHeapWatch({ threshold = 0.8, logger = console } = {}) {
  let above = false;
  return {
    check({ heapUsed, heapLimit }) {
      const over = Number(heapLimit) > 0 && Number(heapUsed) >= threshold * Number(heapLimit);
      const crossed = over && !above;
      above = over;
      if (crossed) {
        logger?.log?.(`[relay] memory high: heapUsed=${toMb(heapUsed)} is over ${Math.round(threshold * 100)}% of heapLimit=${toMb(heapLimit)}`);
      }
      return crossed;
    },
  };
}

/**
 * The runtime's memory in the status log: a line now and every 10 minutes,
 * and a silent check every minute that says when heapUsed crosses 80 % of
 * the limit. Both timers are unref'd; returns them for runtimeTimers.
 */
export function startRelayMemoryLog({
  logger = console,
  memoryUsage = () => process.memoryUsage(),
  heapLimit = () => v8.getHeapStatistics().heap_size_limit,
  logIntervalMs = 10 * 60 * 1000,
  watchIntervalMs = 60 * 1000,
} = {}) {
  const watch = createHeapWatch({ logger });
  const sample = () => {
    const { rss, heapUsed } = memoryUsage();
    return { rss, heapUsed, heapLimit: heapLimit() };
  };
  const logLine = () => {
    const now = sample();
    logger?.log?.(formatMemoryLine(now));
    watch.check(now);
  };
  logLine();
  const log = setInterval(logLine, logIntervalMs);
  log.unref?.();
  const check = setInterval(() => watch.check(sample()), watchIntervalMs);
  check.unref?.();
  return { log, check };
}
