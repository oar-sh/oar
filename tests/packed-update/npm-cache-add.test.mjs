import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addToNpmCache, npmPreferringOffline, onlineNpmArgs, onlineNpmOptions } from "./npm-cache-add.mjs";
import { npmCommandOf, writeNpmCiLauncher } from "./npm-ci-online-retry.mjs";

const SPECS = ["@scope-fixture/sdk@1.2.3", "dep-fixture@4.5.6"];
const OPTIONS = { cwd: "/home/dev/packed", env: { npm_config_cache: "/home/dev/.npm" } };

function fakeNpm(outcomes) {
  const calls = [];
  const npm = async (args, options) => {
    calls.push({ args, options });
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { npm, calls };
}

const npmError = (output) => Object.assign(new Error("npm cache add failed"), { output });

test("from the cache first: one add with --prefer-offline when it works", async () => {
  const { npm, calls } = fakeNpm([{ stdout: "", stderr: "" }]);
  await addToNpmCache(npm, SPECS, OPTIONS);
  assert.deepEqual(calls, [{ args: ["cache", "add", "--prefer-offline", ...SPECS], options: OPTIONS }]);
});

test("ETARGET from a stale cached packument: retried once online, without --prefer-offline", async () => {
  const { npm, calls } = fakeNpm([
    npmError("npm error code ETARGET\nnpm error notarget No matching version found for @scope-fixture/sdk@1.2.3.\n"),
    { stdout: "", stderr: "" },
  ]);
  await addToNpmCache(npm, SPECS, OPTIONS);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { args: ["cache", "add", "--prefer-online", ...SPECS], options: OPTIONS });
  assert.equal(calls[1].args.includes("--prefer-offline"), false);
});

test("only once: a second ETARGET is the caller's", async () => {
  const second = npmError("npm error code ETARGET\n");
  const { npm, calls } = fakeNpm([npmError("npm error code ETARGET\n"), second]);
  await assert.rejects(addToNpmCache(npm, SPECS, OPTIONS), (error) => error === second);
  assert.equal(calls.length, 2);
});

test("any other failure is not retried (a missing registry is the caller's skip)", async () => {
  for (const output of ["npm error code ENOTFOUND\n", "npm error code E404\n"]) {
    const failure = npmError(output);
    const { npm, calls } = fakeNpm([failure]);
    await assert.rejects(addToNpmCache(npm, SPECS, OPTIONS), (error) => error === failure);
    assert.equal(calls.length, 1, output);
  }
  // No output: the message is read.
  const { npm, calls } = fakeNpm([new Error("npm cache add failed: ETARGET"), { stdout: "" }]);
  await addToNpmCache(npm, SPECS, OPTIONS);
  assert.equal(calls.length, 2);
});

test("one helper for every npm run: the global install's --prefer-offline becomes --prefer-online on ETARGET", async () => {
  const args = ["install", "-g", "--prefix", "/home/dev/prefix", "--no-audit", "--no-fund", "--prefer-offline", "/home/dev/pack/oar.tgz"];
  const options = { cwd: "/home/dev/packed", env: { npm_config_cache: "/home/dev/.npm", OAR_STATE_ROOT: "/home/dev/state" } };
  const { npm, calls } = fakeNpm([npmError("npm error code ETARGET\n"), { stdout: "" }]);
  await npmPreferringOffline(npm, args, options);
  assert.deepEqual(calls[0], { args, options });
  assert.deepEqual(calls[1].args, ["install", "-g", "--prefix", "/home/dev/prefix", "--no-audit", "--no-fund", "--prefer-online", "/home/dev/pack/oar.tgz"]);
  assert.deepEqual(calls[1].options, options);
  // Another failure is the caller's, untouched.
  const failure = npmError("npm error code E404\n");
  const other = fakeNpm([failure]);
  await assert.rejects(npmPreferringOffline(other.npm, args, options), (error) => error === failure);
  assert.equal(other.calls.length, 1);
});

test("the store's npm ci (offline by its environment): the repeat drops npm_config_prefer_offline and asks for --prefer-online", async () => {
  const args = ["ci", "--no-workspaces", "--ignore-scripts", "--loglevel=http"];
  const options = { cwd: "/home/dev/sdks/claude/.partial", env: { PATH: "/usr/bin", npm_config_prefer_offline: "true", NPM_CONFIG_PREFER_OFFLINE: "true", npm_config_cache: "/home/dev/.npm" } };
  const { npm, calls } = fakeNpm([npmError("npm error notarget No matching version found\nnpm error code ETARGET\n"), { stdout: "" }]);
  await npmPreferringOffline(npm, args, options);
  assert.deepEqual(calls[0], { args, options }, "the first run is the store's own");
  assert.deepEqual(calls[1].args, [...args, "--prefer-online"]);
  assert.deepEqual(calls[1].options, { cwd: options.cwd, env: { PATH: "/usr/bin", npm_config_cache: "/home/dev/.npm" } });
  assert.equal(options.env.npm_config_prefer_offline, "true", "the caller's options are not changed");
  // The pieces on their own.
  assert.deepEqual(onlineNpmArgs(["ci", "--prefer-online"]), ["ci", "--prefer-online"]);
  assert.deepEqual(onlineNpmOptions({ cwd: "/home/dev" }), { cwd: "/home/dev" });
});

test("the store's install command in the test: a launcher that runs the stand-in under this Node with the package folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-ci-launcher-"));
  try {
    const posix = writeNpmCiLauncher({ dir, packageDir: "/home/dev/prefix/lib/node_modules/@oar-sh/oar", platform: "linux", execPath: "/home/dev/node/bin/node", script: "/home/dev/oar/tests/packed-update/npm-ci-online-retry.mjs" });
    assert.equal(path.basename(posix), "sdk-npm-ci.sh");
    assert.equal(fs.readFileSync(posix, "utf8"), "#!/bin/sh\nexec '/home/dev/node/bin/node' '/home/dev/oar/tests/packed-update/npm-ci-online-retry.mjs' '/home/dev/prefix/lib/node_modules/@oar-sh/oar' \"$@\"\n");
    const windows = writeNpmCiLauncher({ dir, packageDir: "C:\\Users\\dev\\prefix\\node_modules\\@oar-sh\\oar", platform: "win32", execPath: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\Users\\dev\\oar\\tests\\packed-update\\npm-ci-online-retry.mjs" });
    assert.equal(path.basename(windows), "sdk-npm-ci.cmd");
    assert.equal(fs.readFileSync(windows, "utf8"), "@\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\Users\\dev\\oar\\tests\\packed-update\\npm-ci-online-retry.mjs\" \"C:\\Users\\dev\\prefix\\node_modules\\@oar-sh\\oar\" %*\r\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the stand-in runs the npm the package resolves; on win32 the npm next to this Node", () => {
  const resolveNpmInvocation = ({ execPath, env }) => ({ command: `${path.posix.dirname(execPath)}/npm`, env: { ...env, PATH: "/home/dev/node/bin" } });
  assert.deepEqual(
    npmCommandOf({ resolveNpmInvocation, platform: "linux", env: { PATH: "" }, execPath: "/home/dev/node/bin/node" }),
    { command: "/home/dev/node/bin/npm", prefix: [], env: { PATH: "/home/dev/node/bin" } },
  );
  const win32 = npmCommandOf({ resolveNpmInvocation, platform: "win32", env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, execPath: "C:\\nodejs\\node.exe", exists: () => true });
  assert.equal(win32.command, "C:\\nodejs\\node.exe");
  assert.deepEqual(win32.prefix, ["C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"]);
  const noCli = npmCommandOf({ resolveNpmInvocation, platform: "win32", env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, execPath: "C:\\nodejs\\node.exe", exists: () => false });
  assert.deepEqual(noCli, { command: "C:\\Windows\\System32\\cmd.exe", prefix: ["/d", "/s", "/c", "npm"], env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" } });
});
