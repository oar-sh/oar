/**
 * Launching an isolated relay server.
 *
 * This is the isolation contract for e2e, extracted from run-e2e.mjs so the two
 * callers cannot drift apart:
 *
 *  - `run-e2e.mjs` boots the one server every spec shares; and
 *  - a spec that needs a *differently configured* relay (tests/copilot-engine.spec.mjs
 *    needs one with session-worker routing on, which the shared server pins off)
 *    boots its own throwaway server with the same isolation guarantees.
 *
 * The guarantee that matters: a test server must see none of the host's state —
 * not its config file, not its home directory, not its session-state dir, not
 * its Copilot/Claude credentials. A spec that passes in-suite but fails alone is
 * usually a leak in exactly this env block.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(__dirname, "..");
export const serverScript = path.join(repoRoot, "server", "server.js");

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = Number(addr?.port || 0);
      server.close((error) => {
        if (error) return reject(error);
        if (!port) return reject(new Error("Unable to allocate free test port"));
        resolve(port);
      });
    });
  });
}

export async function waitForServerReady(baseUrl, authToken, proc, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const statusUrl = `${baseUrl}/api/status`;

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Server exited before readiness (code=${proc.exitCode})`);
    }
    try {
      const response = await fetch(statusUrl, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }

  throw new Error(`Timed out waiting for server readiness at ${statusUrl}`);
}

export function stopProcess(proc) {
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    proc.once("exit", finish);
    try { proc.kill("SIGTERM"); } catch {}

    setTimeout(() => {
      if (proc.exitCode === null) {
        try { proc.kill("SIGKILL"); } catch {}
      }
      finish();
    }, 2000);
  });
}

/**
 * A temp state root with the per-server directories laid out inside it. Every
 * home-derived path the relay reads points in here, so the server can address
 * nothing the developer actually uses.
 */
export function createStateRoot() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-remote-e2e-"));
  const dataDir = path.join(stateRoot, "data");
  const claudeConfigDir = path.join(stateRoot, "claude-config");
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  // "Logged in" for the stub CLI means this file exists; specs seed and read it
  // to control the starting account state (tests/claude-auth.spec.mjs).
  const claudeCredFile = path.join(claudeConfigDir, "credentials.json");
  // A stand-in for the CLI's bundled `copilot-sdk` directory. Nothing imports
  // it (no SDK worker is ever spawned here), but its presence in the launch env
  // is what the Copilot engine setting checks, so pinning it keeps the relay's
  // answer independent of whether the host has a Copilot CLI installed.
  const sdkStubDir = path.join(stateRoot, "copilot-sdk-stub");
  fs.mkdirSync(sdkStubDir, { recursive: true });
  fs.writeFileSync(path.join(sdkStubDir, "extension.js"), "// e2e stub — never imported\n");
  return { stateRoot, dataDir, claudeConfigDir, claudeCredFile, sdkStubDir };
}

export function removeStateRoot(stateRoot) {
  try { fs.rmSync(stateRoot, { recursive: true, force: true }); } catch {}
}

/**
 * The server environment. `overrides` is applied last so a spec-owned server can
 * deliberately relax one pin (routing, the SDK path) without copying the block.
 */
export function buildRelayServerEnv({
  stateRoot,
  dataDir,
  claudeConfigDir,
  claudeCredFile,
  sdkStubDir,
  allowCli = false,
  overrides = {},
} = {}) {
  // The test server must never spawn real Copilot CLI clients or Claude workers.
  // Set RELAY_E2E_ALLOW_CLI=1 explicitly (with user permission) to test live turns.
  const disableCliSpawn = allowCli ? "" : "1";

  return {
    ...process.env,
    COPILOT_WORKSPACE_ROOT: repoRoot,
    COPILOT_WEB_RELAY_DATA_DIR: dataDir,
    COPILOT_WEB_RELAY_CONFIG: path.join(stateRoot, "config.json"),
    // Pin session-worker routing OFF rather than inheriting whatever the host's
    // live config enables (features.mjs reads the config file
    // COPILOT_WEB_RELAY_CONFIG points at, but an explicit pin keeps specs
    // deterministic even so). Routing-on cannot work for queue specs here:
    // owned rows are only released to a live worker lifecycle, and this server
    // runs with CLI spawn disabled, so every owned dequeue would block on
    // "spawn-failed". The routing queue logic itself is covered by the
    // route-level suites (messages-routes-session-worker*.test.mjs); the spec
    // helpers still send x-relay-session-id whenever a queue response carries an
    // ownerSessionId, so a future routed harness works without spec changes.
    COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED: "0",
    // Pinned for the same reason routing is: without it the relay derives the
    // path from whatever Copilot CLI the host happens to have installed, and the
    // Copilot engine setting would refuse (or accept) differently per machine.
    COPILOT_SDK_PATH: sdkStubDir,
    // The startup SDK-session import sweep reads ~/.copilot/session-state:
    // on a developer host it would import the live relay's real Copilot
    // sessions into the "isolated" test server (seen as stray sidebar
    // conversations and startup DB contention). Point every home-derived
    // path at the temp state root so the server can see none of the
    // host's provider state.
    COPILOT_SESSION_STATE_DIR: path.join(stateRoot, "session-state"),
    HOME: stateRoot,
    USERPROFILE: stateRoot,
    // The Claude CLI reads CLAUDE_CONFIG_DIR ahead of HOME, and the relay
    // now passes it straight through to `claude auth …`; without an
    // override the "isolated" server would address the developer's real
    // Claude credentials.
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    // Second belt: even with RELAY_E2E_ALLOW_CLI=1 the auth subcommands hit
    // a stub that only touches the temp state root, never the real CLI.
    COPILOT_WEB_RELAY_CLAUDE_AUTH_BIN: path.join(repoRoot, "server", "services", "fixtures", "claude-auth-stub.sh"),
    CLAUDE_AUTH_STUB_CRED_FILE: claudeCredFile,
    // The CLI kill switch below would otherwise refuse the auth spawns too.
    // This opt-in is only honoured together with the stub path above, so the
    // real `claude` still can never run here — see claude-auth-service.mjs.
    COPILOT_WEB_RELAY_CLAUDE_AUTH_ALLOW_STUB_SPAWN: "1",
    ...(disableCliSpawn ? { COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: disableCliSpawn } : {}),
    ...overrides,
  };
}

/**
 * Boot an isolated relay and wait for it to answer /api/status.
 *
 * Resolves to a handle carrying the paths a caller needs plus `stop()`, which
 * kills the process and removes the state root. A boot failure cleans up and
 * throws with the server's own output attached — the only way to see why a
 * server that never became ready gave up.
 */
export async function startRelayServer({
  token,
  port,
  ownerPid = process.pid,
  allowCli = false,
  overrides = {},
} = {}) {
  const resolvedPort = port || await reserveFreePort();
  const baseUrl = `http://127.0.0.1:${resolvedPort}`;
  const paths = createStateRoot();

  let stdout = "";
  let stderr = "";

  const proc = spawn(
    process.execPath,
    [serverScript, "--token", token, "--port", String(resolvedPort), "--owner-pid", String(ownerPid)],
    {
      cwd: repoRoot,
      env: buildRelayServerEnv({ ...paths, allowCli, overrides }),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  proc.stdout?.on("data", (chunk) => {
    stdout += String(chunk || "");
    if (stdout.length > 10_000) stdout = stdout.slice(-10_000);
  });
  proc.stderr?.on("data", (chunk) => {
    stderr += String(chunk || "");
    if (stderr.length > 10_000) stderr = stderr.slice(-10_000);
  });

  const handle = {
    proc,
    port: resolvedPort,
    baseUrl,
    token,
    ...paths,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    cleanupStateRoot: () => removeStateRoot(paths.stateRoot),
    stop: async () => {
      await stopProcess(proc);
      removeStateRoot(paths.stateRoot);
    },
  };

  try {
    await waitForServerReady(baseUrl, token, proc);
  } catch (error) {
    await stopProcess(proc);
    removeStateRoot(paths.stateRoot);
    const suffix = [
      "[relay-server-harness] Server startup failed.",
      stdout ? `--- server stdout ---\n${stdout}` : "",
      stderr ? `--- server stderr ---\n${stderr}` : "",
    ].filter(Boolean).join("\n");
    throw new Error(`${error?.message || String(error)}\n${suffix}`);
  }

  return handle;
}
