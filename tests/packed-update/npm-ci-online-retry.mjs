/**
 * The packed-update test's stand-in for the agent SDK store's `npm ci`. The
 * test hands it to the relays it starts as
 * COPILOT_WEB_RELAY_AGENT_SDK_INSTALL_COMMAND (through a launcher it writes:
 * writeNpmCiLauncher), so the relay's own code is not changed for it.
 *
 * It runs what the store would run, taken from the installed package itself
 * (agentSdkNpmArgs, resolveNpmInvocation), in the folder the store installs
 * (the working directory) and with the environment the store passes: from
 * the cache, as the test's npm_config_prefer_offline=true asks, and once more
 * online when a stale cached packument names no such version (ETARGET;
 * npm-cache-add.mjs). npm's output goes through as it comes: the store reads
 * it for progress.
 *
 *   node npm-ci-online-retry.mjs <package dir> <sdk id>
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { npmPreferringOffline } from "./npm-cache-add.mjs";

/** How to run npm here: `{ command, prefix, env }`, as the package resolves it. */
export function npmCommandOf({ resolveNpmInvocation, platform, env, execPath, exists = fs.existsSync }) {
  if (platform === "win32") {
    // npm.cmd needs a shell; the npm next to this Node runs as a script.
    const cli = path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (exists(cli)) return { command: execPath, prefix: [cli], env };
    return { command: env.ComSpec || "cmd.exe", prefix: ["/d", "/s", "/c", "npm"], env };
  }
  const resolved = resolveNpmInvocation({ execPath, platform, env });
  return { command: resolved.command, prefix: [], env: resolved.env || env };
}

/**
 * Writes the launcher the store runs as its install command (it passes the
 * SDK id only): this script with `packageDir`, under this Node. Returns its
 * path, for COPILOT_WEB_RELAY_AGENT_SDK_INSTALL_COMMAND.
 */
export function writeNpmCiLauncher({ dir, packageDir, platform, execPath = process.execPath, script = fileURLToPath(import.meta.url) }) {
  fs.mkdirSync(dir, { recursive: true });
  if (platform === "win32") {
    const file = path.join(dir, "sdk-npm-ci.cmd");
    fs.writeFileSync(file, `@"${execPath}" "${script}" "${packageDir}" %*\r\n`);
    return file;
  }
  const file = path.join(dir, "sdk-npm-ci.sh");
  const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(file, `#!/bin/sh\nexec ${quote(execPath)} ${quote(script)} ${quote(packageDir)} "$@"\n`, { mode: 0o755 });
  return file;
}

function runNpm({ command, prefix }, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    const keep = (sink) => (chunk) => {
      sink.write(chunk);
      output = (output + String(chunk)).slice(-200_000);
    };
    child.stdout.on("data", keep(process.stdout));
    child.stderr.on("data", keep(process.stderr));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve({ output });
      else reject(Object.assign(new Error(`npm ${args[0]} exited with ${signal || code}`), { output, exitCode: code }));
    });
  });
}

async function main() {
  const [packageDir] = process.argv.slice(2);
  const module = (rel) => import(pathToFileURL(path.join(packageDir, ...rel.split("/"))).href);
  const { agentSdkNpmArgs } = await module("server/services/agent-sdk-store.mjs");
  const { resolveNpmInvocation } = await module("server/services/oar-cli-helpers.mjs");
  const npm = npmCommandOf({
    resolveNpmInvocation,
    platform: process.platform, // host-platform: runs npm on this host
    env: { ...process.env },
    execPath: process.execPath,
  });
  try {
    await npmPreferringOffline((args, options) => runNpm(npm, args, options), agentSdkNpmArgs(), { cwd: process.cwd(), env: npm.env });
  } catch (error) {
    if (!error?.output) process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = Number.isInteger(error?.exitCode) && error.exitCode > 0 ? error.exitCode : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
