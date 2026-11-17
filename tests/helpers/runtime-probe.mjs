/**
 * Preloaded (`node --import`) into a runtime started by
 * tests/helpers/runtime-boot.mjs: what the boot test and the inventory script
 * (scripts/server-runtime-inventory.mjs) learn about server/server-runtime.mjs
 * from the outside, with no line of the runtime changed.
 *
 * - The database guard: a better-sqlite3 database file outside the state root
 *   (RUNTIME_PROBE_ROOT) is refused before it opens; ':memory:' passes.
 * - Writes outside the state root (fs, sync, callback and promise forms) are
 *   recorded, not refused.
 * - Routes in registration order (express.application's verb methods, `all`
 *   and `use`); the keys of the objects handed to each register…() call of a
 *   server/routes module (runtime-probe-hooks.mjs wraps those exports); the
 *   runtime's exports (runtime-probe-launcher.mjs).
 * - Timers (setTimeout, setInterval) and listeners (process, the relay's HTTP
 *   server) that are active right after the relay's listen callback and when
 *   the process exits. The probe's own are left out.
 *
 * Everything is written as JSON to RUNTIME_PROBE_OUT: after start, and again
 * at exit. Nothing here changes what the runtime does, except the refusal.
 */

import fs from 'node:fs';
import { createRequire, register, syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import path from 'node:path';
import timers from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stateRoot = String(process.env.RUNTIME_PROBE_ROOT || '').trim();
const outFile = String(process.env.RUNTIME_PROBE_OUT || '').trim();
const relayPort = Number(process.env.RUNTIME_PROBE_PORT || 0);
if (!stateRoot || !outFile || !relayPort) {
  throw new Error('runtime-probe: RUNTIME_PROBE_ROOT, RUNTIME_PROBE_OUT and RUNTIME_PROBE_PORT are required');
}

const original = {
  writeFileSync: fs.writeFileSync,
  renameSync: fs.renameSync,
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
};

const comparable = (value) => {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const rootKey = comparable(stateRoot);
export function insideStateRoot(target) {
  const key = comparable(target);
  return key === rootKey || key.startsWith(rootKey + path.sep);
}

const state = {
  pid: process.pid,
  stateRoot,
  exports: null,
  databases: [],
  refusedDatabases: [],
  writesOutside: [],
  routes: [],
  registerCalls: [],
  afterStart: null,
  atExit: null,
};

function save() {
  try {
    const tmp = `${outFile}.tmp`;
    original.writeFileSync.call(fs, tmp, `${JSON.stringify(state, null, 2)}\n`);
    original.renameSync.call(fs, tmp, outFile);
  } catch (error) {
    process.stderr.write(`[runtime-probe] could not write ${outFile}: ${error?.message || error}\n`);
  }
}

// ─── The database guard ─────────────────────────────────────────────────────
// Every import of 'better-sqlite3' resolves to a module whose default export
// is this class (runtime-probe-hooks.mjs), so each `new Database(…)` in the
// runtime and its services passes the check before anything opens.
let guardedDatabase = null;
export function guardedDatabaseClass() {
  if (guardedDatabase) return guardedDatabase;
  const requireFromServer = createRequire(path.join(repoRoot, 'server', 'server-runtime.mjs'));
  const Database = requireFromServer('better-sqlite3');
  guardedDatabase = class GuardedDatabase extends Database {
    constructor(filename, ...rest) {
      const name = typeof filename === 'string' ? filename : '';
      const inMemory = !name || name === ':memory:' || Buffer.isBuffer(filename);
      if (!inMemory) {
        if (!insideStateRoot(name)) {
          state.refusedDatabases.push(path.resolve(name));
          save();
          throw new Error(`[runtime-probe] refused to open a database outside the state root: ${path.resolve(name)}`);
        }
        state.databases.push(path.relative(stateRoot, path.resolve(name)).split(path.sep).join('/'));
      }
      super(filename, ...rest);
    }
  };
  return guardedDatabase;
}

// ─── Writes outside the state root ──────────────────────────────────────────
{
  const noteWrite = (fn, target) => {
    if (target === undefined || target === null || typeof target === 'number') return;
    const text = target instanceof URL ? fileURLToPath(target) : String(target);
    if (!text || insideStateRoot(text)) return;
    state.writesOutside.push(`${fn} ${path.resolve(text)}`);
  };
  const writesFlag = (flags) => {
    if (flags === undefined || flags === null) return false;
    if (typeof flags === 'number') return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0;
    return /[wa+]/.test(String(flags));
  };
  // name → which arguments are written to
  const targets = {
    writeFileSync: [0], appendFileSync: [0], mkdirSync: [0], mkdtempSync: [0], rmSync: [0], rmdirSync: [0],
    unlinkSync: [0], renameSync: [0, 1], copyFileSync: [1], cpSync: [1], symlinkSync: [1], linkSync: [1],
    truncateSync: [0], chmodSync: [0], utimesSync: [0], createWriteStream: [0],
    writeFile: [0], appendFile: [0], mkdir: [0], mkdtemp: [0], rm: [0], rmdir: [0], unlink: [0],
    rename: [0, 1], copyFile: [1], cp: [1], symlink: [1], link: [1], truncate: [0], chmod: [0], utimes: [0],
  };
  const wrapAll = (target, label) => {
    for (const [name, positions] of Object.entries(targets)) {
      const fn = target[name];
      if (typeof fn !== 'function') continue;
      target[name] = function probedWrite(...args) {
        for (const index of positions) noteWrite(`${label}${name}`, args[index]);
        return fn.apply(this, args);
      };
    }
    for (const name of ['openSync', 'open']) {
      const fn = target[name];
      if (typeof fn !== 'function') continue;
      target[name] = function probedOpen(...args) {
        if (writesFlag(args[1])) noteWrite(`${label}${name}`, args[0]);
        return fn.apply(this, args);
      };
    }
  };
  // The probe's own file goes through the originals kept above.
  wrapAll(fs, 'fs.');
  wrapAll(fs.promises, 'fs.promises.');
}

// ─── Timers ─────────────────────────────────────────────────────────────────
// Active timers by kind, delay and whether they hold the process. A timeout
// leaves the set when it fires or is cleared; an interval when it is cleared.
const activeTimers = new Map();
{
  const track = (kind, create) => function probedTimer(callback, delay, ...args) {
    let handle;
    const wrapped = typeof callback === 'function' && kind === 'setTimeout'
      ? function probedTimeoutCallback(...cbArgs) {
        activeTimers.delete(handle);
        return callback.apply(this, cbArgs);
      }
      : callback;
    handle = create(wrapped, delay, ...args);
    // Where it was set: the inventory reads the delay argument there to tell
    // a constant delay from a computed one.
    const site = String(new Error().stack || '').split('\n')[2]?.trim() || '';
    activeTimers.set(handle, { kind, delay: Number(delay) || 0, site });
    return handle;
  };
  const untrack = (clear) => function probedClear(handle) {
    if (handle && typeof handle === 'object') activeTimers.delete(handle);
    else if (handle !== undefined && handle !== null) {
      for (const key of activeTimers.keys()) {
        if (Number(key) === Number(handle)) activeTimers.delete(key);
      }
    }
    return clear(handle);
  };
  const setTimeoutProbe = track('setTimeout', original.setTimeout);
  const setIntervalProbe = track('setInterval', original.setInterval);
  const clearTimeoutProbe = untrack(original.clearTimeout);
  const clearIntervalProbe = untrack(original.clearInterval);
  globalThis.setTimeout = setTimeoutProbe;
  globalThis.setInterval = setIntervalProbe;
  globalThis.clearTimeout = clearTimeoutProbe;
  globalThis.clearInterval = clearIntervalProbe;
  timers.setTimeout = setTimeoutProbe;
  timers.setInterval = setIntervalProbe;
  timers.clearTimeout = clearTimeoutProbe;
  timers.clearInterval = clearIntervalProbe;
}
syncBuiltinESMExports();

function timerSnapshot() {
  return [...activeTimers.entries()].map(([handle, entry]) => ({
    ...entry,
    ref: typeof handle?.hasRef === 'function' ? handle.hasRef() : true,
  }));
}

// ─── Listeners ──────────────────────────────────────────────────────────────
let relayServer = null;
const ownProcessListeners = new Set();
function listenerCounts(emitter, own = new Set()) {
  if (!emitter) return null;
  const counts = {};
  for (const name of emitter.eventNames()) {
    const count = emitter.listeners(name).filter((fn) => !own.has(fn)).length;
    if (count) counts[String(name)] = count;
  }
  return counts;
}
function snapshot() {
  return {
    timers: timerSnapshot(),
    processListeners: listenerCounts(process, ownProcessListeners),
    serverListeners: listenerCounts(relayServer),
    serverListening: relayServer ? relayServer.listening : null,
  };
}

// The relay's server is the one that listens on its port; its listen
// callback runs the start-up's last synchronous steps, and the snapshot
// after start is taken right after it returns.
{
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function probedListen(...args) {
    const port = Number(typeof args[0] === 'object' && args[0] ? args[0].port : args[0]);
    if (port === relayPort && !relayServer) {
      relayServer = this;
      const last = args.length - 1;
      if (typeof args[last] === 'function') {
        const callback = args[last];
        args[last] = function probedListening(...cbArgs) {
          try {
            return callback.apply(this, cbArgs);
          } finally {
            state.afterStart = snapshot();
            save();
          }
        };
      }
    }
    return listen.apply(this, args);
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────
{
  const requireFromServer = createRequire(path.join(repoRoot, 'server', 'server-runtime.mjs'));
  const express = requireFromServer('express');
  const proto = express.application;
  const apps = new Map();
  const appIndex = (app) => {
    if (!apps.has(app)) apps.set(app, apps.size);
    return apps.get(app);
  };
  const pathText = (value) => {
    if (Array.isArray(value)) return value.map(pathText).join(',');
    if (value instanceof RegExp) return String(value);
    return typeof value === 'string' ? value : null;
  };
  const record = (app, method, routePath, handlers = null) => {
    state.routes.push({ app: appIndex(app), method, path: routePath, ...(handlers ? { handlers } : {}) });
  };
  for (const method of [...http.METHODS.map((name) => name.toLowerCase()), 'all']) {
    const fn = proto[method];
    if (typeof fn !== 'function') continue;
    proto[method] = function probedRoute(...args) {
      if (!(method === 'get' && args.length === 1)) record(this, method.toUpperCase(), pathText(args[0]) ?? '?');
      return fn.apply(this, args);
    };
  }
  const use = proto.use;
  proto.use = function probedUse(...args) {
    // Middleware is told apart by its functions' names (a move keeps them).
    const mount = pathText(args[0]);
    const handlers = args.flat(Infinity).filter((arg) => typeof arg === 'function').map((fn) => fn.name || 'anonymous');
    record(this, 'USE', mount ?? '/', handlers);
    return use.apply(this, args);
  };
}

// ─── Register calls and exports ─────────────────────────────────────────────
/** Called by the wrappers runtime-probe-hooks.mjs puts around server/routes modules. */
export function recordRegisterCall(name, args) {
  state.registerCalls.push({
    name,
    args: args.map((arg, index) => {
      if (index === 0) return { kind: arg === undefined ? 'undefined' : 'app' };
      if (arg && typeof arg === 'object' && !Array.isArray(arg)) return { kind: 'object', keys: Object.keys(arg).sort() };
      return { kind: arg === null ? 'null' : typeof arg };
    }),
  });
}

/** Called by runtime-probe-launcher.mjs once the runtime module has evaluated. */
export function recordExports(names) {
  state.exports = [...names].sort();
  save();
}

register(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime-probe-hooks.mjs')), {
  data: { probeUrl: import.meta.url, runtimeUrl: pathToFileURL(path.join(repoRoot, 'server', 'server-runtime.mjs')).href },
});

const onExit = () => {
  state.atExit = { ...snapshot(), resources: process.getActiveResourcesInfo().filter((kind) => kind !== 'Timeout').sort() };
  save();
};
ownProcessListeners.add(onExit);
process.on('exit', onExit);
save();
