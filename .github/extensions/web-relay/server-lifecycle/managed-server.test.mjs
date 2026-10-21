import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { createManagedServerLifecycle } from "./managed-server.mjs";

// Starts the managed relay against fakes: the first status probe finds no
// relay, the next one finds it ready. Returns the environment it was given.
async function startWith({ relayEnv, processEnv = {} }) {
  const saved = {};
  for (const [key, value] of Object.entries(processEnv)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    let probes = 0;
    const spawned = [];
    const lifecycle = createManagedServerLifecycle({
      api: async () => {
        probes += 1;
        if (probes === 1) throw new Error("connect ECONNREFUSED");
        return { ok: true };
      },
      dbg: () => {},
      fs: { mkdirSync() {}, openSync: () => 99, closeSync() {}, statSync: () => ({ size: 0 }) },
      spawn: (command, args, options) => {
        const child = Object.assign(new EventEmitter(), { exitCode: null, pid: 4242 });
        spawned.push({ command, args, options });
        return child;
      },
      killProcessTree: () => {},
      delay: async () => {},
      token: "managed-token",
      logDir: "logs",
      serverDir: "server",
      serverLogPath: "logs/server.log",
      serverErrPath: "logs/server-err.log",
      relayEnv,
      nodeBin: "node",
      serverStartTimeoutMs: 5000,
    });
    assert.equal(await lifecycle.ensureManagedServer(), true);
    assert.equal(spawned.length, 1);
    return spawned[0].options.env;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const PINS = {
  COPILOT_WEB_RELAY_ROOT: "/prefix/lib/node_modules/@oar-sh/oar",
  COPILOT_WEB_RELAY_CONFIG: "/home/dev/.oar/config.json",
  COPILOT_WEB_RELAY_DATA_DIR: "/home/dev/.oar/data",
  COPILOT_WEB_RELAY_LOG_DIR: "/home/dev/.oar/logs",
};

test("the managed relay of a global install starts on the state root's config, data and logs", async () => {
  const env = await startWith({
    relayEnv: PINS,
    processEnv: { COPILOT_WEB_RELAY_CONFIG: "", COPILOT_WEB_RELAY_DATA_DIR: "", COPILOT_WEB_RELAY_LOG_DIR: "", COPILOT_WEB_RELAY_ROOT: "" },
  });
  for (const [key, value] of Object.entries(PINS)) assert.equal(env[key], value, key);
});

test("what the CLI's own environment names wins over the pins", async () => {
  const env = await startWith({
    relayEnv: PINS,
    processEnv: { COPILOT_WEB_RELAY_DATA_DIR: "/srv/own-data", COPILOT_WEB_RELAY_CONFIG: "", COPILOT_WEB_RELAY_LOG_DIR: "", COPILOT_WEB_RELAY_ROOT: "" },
  });
  assert.equal(env.COPILOT_WEB_RELAY_DATA_DIR, "/srv/own-data");
  assert.equal(env.COPILOT_WEB_RELAY_CONFIG, PINS.COPILOT_WEB_RELAY_CONFIG);
});

test("a managed relay that stops on purpose (exit 78) is not retried; a crash is", async () => {
  for (const [code, retried] of [[78, false], [1, true]]) {
    const logs = [];
    let child = null;
    const lifecycle = createManagedServerLifecycle({
      api: async () => { throw new Error("connect ECONNREFUSED"); },
      dbg: (...parts) => logs.push(parts.join(" ")),
      fs: { mkdirSync() {}, openSync: () => 99, closeSync() {}, statSync: () => ({ size: 0 }) },
      spawn: () => {
        child = Object.assign(new EventEmitter(), { exitCode: null, pid: 4242 });
        setImmediate(() => { child.exitCode = code; child.emit("exit", code, null); });
        return child;
      },
      killProcessTree: () => {},
      delay: async () => { await new Promise((resolve) => setImmediate(resolve)); },
      token: "managed-token",
      logDir: "logs",
      serverDir: "server",
      serverLogPath: "logs/server.log",
      serverErrPath: "logs/server-err.log",
      nodeBin: "node",
      serverStartTimeoutMs: code === 78 ? 60_000 : 50,
    });
    const startedAt = Date.now();
    const error = await lifecycle.ensureManagedServer().then(() => null, (failure) => failure);
    assert.ok(error, `exit ${code} fails the start`);
    if (code === 78) assert.ok(Date.now() - startedAt < 5000, "no wait for a relay that stopped");
    assert.equal(error.relayRetryable !== false, retried, `exit ${code}`);
    assert.ok(!logs.some((line) => line.includes("restart scheduled")) || retried, `exit ${code}: nothing scheduled`);
    await lifecycle.stopManagedServer();
  }
});

test("a checkout's managed relay is started without pins", async () => {
  const env = await startWith({
    relayEnv: {},
    processEnv: { COPILOT_WEB_RELAY_DATA_DIR: "", COPILOT_WEB_RELAY_CONFIG: "" },
  });
  assert.equal(env.COPILOT_WEB_RELAY_DATA_DIR, "");
  assert.equal(env.COPILOT_WEB_RELAY_CONFIG, "");
});
