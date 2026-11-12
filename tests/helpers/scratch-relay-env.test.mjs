import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  SCRATCH_RELAY_FORBIDDEN_ENV,
  createScratchRelayEnv,
  inheritedEnvKeys,
  scratchRelayDescendants,
  stillRunning,
} from "./scratch-relay-env.mjs";

// A host environment full of what a scratch relay must not see. The values
// are made up; each is a marker that must not turn up in the built env.
const HOST = Object.freeze({
  PATH: "/home/dev/.npm-global/bin:/usr/bin:/bin",
  HOME: "/home/dev",
  USERPROFILE: "/home/dev",
  TMPDIR: "/home/dev/tmp-host",
  LANG: "C.UTF-8",
  COPILOT_WEB_RELAY_DATA_DIR: "/home/dev/.oar/host-data",
  COPILOT_WEB_RELAY_CONFIG: "/home/dev/.oar/host-config.json",
  COPILOT_WEB_RELAY_PORT_MARKER: "host-marker-port",
  COPILOT_SESSION_STATE_DIR: "/home/dev/.copilot/session-state",
  OAR_AGENT_TOKEN: "host-marker-agent",
  OAR_RELAY_URL: "http://127.0.0.1:3999",
  ANTHROPIC_API_KEY: "host-marker-anthropic",
  CLAUDE_CODE_OAUTH_TOKEN: "host-marker-claude",
  CLAUDE_CONFIG_DIR: "/home/dev/.claude",
  OPENAI_API_KEY: "host-marker-openai",
  GITHUB_TOKEN: "host-marker-github",
  GH_TOKEN: "host-marker-gh",
  XAI_API_KEY: "host-marker-xai",
  DEEPSEEK_API_KEY: "host-marker-deepseek",
  CURSOR_API_KEY: "host-marker-cursor",
});

/** `value` is the state root or a path below it. */
function inside(root, value) {
  const relative = path.relative(root, String(value));
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

test("a scratch relay's env is built from nothing: own state, own config and port, nothing of the host's", async (t) => {
  const scratch = await createScratchRelayEnv({ hostEnv: HOST, platform: "linux" });
  t.after(() => scratch.cleanup());
  const { env, stateRoot } = scratch;

  const text = JSON.stringify(env);
  for (const [key, value] of Object.entries(HOST)) {
    if (["LANG"].includes(key)) continue;
    assert.equal(text.includes(value), false, `${key}'s host value is not in the env`);
  }
  assert.equal(env.LANG, "C.UTF-8", "the locale passes through");
  assert.deepEqual(inheritedEnvKeys(env), []);
  for (const key of ["OAR_AGENT_TOKEN", "OAR_RELAY_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "XAI_API_KEY", "DEEPSEEK_API_KEY", "CURSOR_API_KEY", "COPILOT_WEB_RELAY_PORT_MARKER"]) {
    assert.equal(key in env, false, key);
  }
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "");

  for (const key of ["COPILOT_WEB_RELAY_DATA_DIR", "COPILOT_WEB_RELAY_CONFIG", "COPILOT_WEB_RELAY_LOG_DIR", "COPILOT_SESSION_STATE_DIR", "CLAUDE_CONFIG_DIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "COPILOT_WORKSPACE_ROOT"]) {
    assert.ok(inside(stateRoot, env[key]), `${key} lies inside the state root`);
  }
  assert.equal(env.COPILOT_WEB_RELAY_DATA_DIR, scratch.dataDir);
  assert.equal(env.COPILOT_WEB_RELAY_CONFIG, scratch.configPath);
  assert.equal(env.COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN, "1", "no agent CLI starts under it");
  assert.equal(env.OAR_NO_UPDATE_CHECK, "1");

  // PATH: node through a link in the state root, then the system folders.
  const parts = env.PATH.split(":");
  const nodeDir = parts.slice(0, -2).join(":");
  assert.deepEqual(parts.slice(-2), ["/usr/bin", "/bin"]);
  if (process.platform !== "win32") { // host-platform: the link is made on this host's file system (Windows needs a privilege for it)
    assert.ok(inside(stateRoot, nodeDir));
    assert.equal(fs.realpathSync(path.join(nodeDir, "node")), fs.realpathSync(process.execPath));
  }

  const config = JSON.parse(fs.readFileSync(scratch.configPath, "utf8"));
  assert.equal(config.port, scratch.port);
  assert.equal(config.localhostOnly, true);
  assert.equal(scratch.baseUrl, `http://127.0.0.1:${scratch.port}`);
  assert.ok(scratch.serverScript.endsWith(path.join("server", "server.js")));
});

test("two scratch relays share nothing; config keys and overrides are the caller's", async (t) => {
  const marker = "scratch-fixture-config-value";
  const one = await createScratchRelayEnv({ hostEnv: HOST, platform: "linux", config: { authToken: marker } });
  const two = await createScratchRelayEnv({
    hostEnv: HOST,
    platform: "linux",
    root: "/home/dev/builds/oar-older",
    overrides: { OAR_ANTHROPIC_API_BASE_URL: "http://127.0.0.1:9", OAR_SCRATCH_FIXTURE: "1" },
  });
  t.after(() => { one.cleanup(); two.cleanup(); });
  assert.notEqual(one.stateRoot, two.stateRoot);
  assert.notEqual(one.port, two.port);
  assert.notEqual(one.env.COPILOT_WEB_RELAY_DATA_DIR, two.env.COPILOT_WEB_RELAY_DATA_DIR);
  // A build from before agent auth reads its token from the config.
  assert.equal(JSON.parse(fs.readFileSync(one.configPath, "utf8")).authToken === marker, true);
  assert.equal(JSON.stringify(one.env).includes(marker), false, "never in the env");
  // Another build: its own server script and root.
  assert.equal(two.env.COPILOT_WEB_RELAY_ROOT, "/home/dev/builds/oar-older");
  assert.equal(two.serverScript, path.join("/home/dev/builds/oar-older", "server", "server.js"));
  assert.equal(two.env.OAR_SCRATCH_FIXTURE, "1");
  assert.deepEqual(inheritedEnvKeys(two.env, { overrides: { OAR_SCRATCH_FIXTURE: "1" } }), []);
  // A key set by neither is reported.
  assert.deepEqual(inheritedEnvKeys({ ...one.env, OPENAI_BASE_URL: "x", CLAUDE_FIXTURE: "y" }).sort(), ["CLAUDE_FIXTURE", "OPENAI_BASE_URL"]);
  assert.equal(SCRATCH_RELAY_FORBIDDEN_ENV.test("COPILOT_SESSION_STATE_DIR"), true);
  // cleanup removes the state root.
  one.cleanup();
  assert.equal(fs.existsSync(one.stateRoot), false);
});

test("win32: node's own folder and the system folders, and what Windows needs to start a process", async (t) => {
  const scratch = await createScratchRelayEnv({
    hostEnv: { ...HOST, SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", PATHEXT: ".COM;.EXE" },
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
  });
  t.after(() => scratch.cleanup());
  assert.equal(scratch.env.PATH.split(";")[1].endsWith("System32"), true);
  assert.equal(scratch.env.PATH.includes(".npm-global"), false);
  assert.equal(scratch.env.SystemRoot, "C:\\Windows");
  assert.equal(scratch.env.PATHEXT, ".COM;.EXE");
  assert.deepEqual(inheritedEnvKeys(scratch.env), []);
});

test("child processes: listed while the parent runs, none still running after a stop", { skip: process.platform === "win32" ? "the Windows process list is read through PowerShell (about a second); the lister has its own tests" : false }, async (t) => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  await new Promise((resolve) => child.once("spawn", resolve));
  const below = await scratchRelayDescendants(process.pid);
  const found = below.filter((proc) => proc.processId === child.pid);
  assert.equal(found.length, 1, "the child is listed under this process");
  assert.deepEqual(stillRunning(found).map((proc) => proc.processId), [child.pid]);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.deepEqual(stillRunning(found), []);
});

test("stillRunning: a process the signal cannot reach for lack of permission still counts", () => {
  const signal = (pid) => {
    if (pid === 11) return true;
    const error = new Error(pid === 12 ? "not permitted" : "no such process");
    error.code = pid === 12 ? "EPERM" : "ESRCH";
    throw error;
  };
  assert.deepEqual(stillRunning([{ processId: 11 }, { processId: 12 }, { processId: 13 }], { signal }).map((proc) => proc.processId), [11, 12]);
  assert.deepEqual(stillRunning(null), []);
});
