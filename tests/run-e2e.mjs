import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const serverScript = path.join(repoRoot, "server", "server.js");
const playwrightCli = path.join(repoRoot, "node_modules", "@playwright", "test", "cli.js");
const token = randomUUID();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function reserveFreePort() {
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

async function waitForServerReady(baseUrl, authToken, proc, timeoutMs = 30_000) {
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

function stopProcess(proc) {
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

async function main() {
  const port = await reserveFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverStdout = "";
  let serverStderr = "";
  let shutdownRequested = false;

  // Isolate the test server's state (db, singleton lock, uploads, config) from a
  // live relay running out of the same checkout.
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-remote-e2e-"));
  const dataDir = path.join(stateRoot, "data");
  const claudeConfigDir = path.join(stateRoot, "claude-config");
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  // "Logged in" for the stub CLI means this file exists; specs seed and read it
  // to control the starting account state (tests/claude-auth.spec.mjs).
  const claudeCredFile = path.join(claudeConfigDir, "credentials.json");

  // The test server must never spawn real Copilot CLI clients or Claude workers.
  // Set RELAY_E2E_ALLOW_CLI=1 explicitly (with user permission) to test live turns.
  const disableCliSpawn = String(process.env.RELAY_E2E_ALLOW_CLI || "").trim() ? "" : "1";

  // Pin session-worker routing OFF rather than inheriting whatever the host's
  // live config enables (features.mjs reads the config file
  // COPILOT_WEB_RELAY_CONFIG points at, but an explicit pin keeps specs
  // deterministic even so). Routing-on cannot work here: owned rows are only
  // released to a live worker lifecycle, and this server runs with CLI spawn
  // disabled, so every owned dequeue would block on "spawn-failed". The
  // routing queue logic itself is covered by the route-level suites
  // (messages-routes-session-worker*.test.mjs); the spec helpers still send
  // x-relay-session-id whenever a queue response carries an ownerSessionId,
  // so a future routed harness works without spec changes.

  const serverProc = spawn(
    process.execPath,
    [serverScript, "--token", token, "--port", String(port), "--owner-pid", String(process.pid)],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        COPILOT_WORKSPACE_ROOT: repoRoot,
        COPILOT_WEB_RELAY_DATA_DIR: dataDir,
        COPILOT_WEB_RELAY_CONFIG: path.join(stateRoot, "config.json"),
        COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED: "0",
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
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  serverProc.stdout?.on("data", (chunk) => {
    serverStdout += String(chunk || "");
    if (serverStdout.length > 10_000) serverStdout = serverStdout.slice(-10_000);
  });
  serverProc.stderr?.on("data", (chunk) => {
    serverStderr += String(chunk || "");
    if (serverStderr.length > 10_000) serverStderr = serverStderr.slice(-10_000);
  });

  const cleanupStateRoot = () => {
    try { fs.rmSync(stateRoot, { recursive: true, force: true }); } catch {}
  };

  const shutdown = async (exitCode) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    await stopProcess(serverProc);
    cleanupStateRoot();
    process.exit(exitCode);
  };

  const onSigInt = () => { void shutdown(130); };
  const onSigTerm = () => { void shutdown(143); };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  try {
    await waitForServerReady(baseUrl, token, serverProc);
  } catch (error) {
    await stopProcess(serverProc);
    cleanupStateRoot();
    const suffix = [
      "[run-e2e] Server startup failed.",
      serverStdout ? `--- server stdout ---\n${serverStdout}` : "",
      serverStderr ? `--- server stderr ---\n${serverStderr}` : "",
    ].filter(Boolean).join("\n");
    throw new Error(`${error?.message || String(error)}\n${suffix}`);
  }

  const testProc = spawn(
    process.execPath,
    [playwrightCli, "test", "--config", "tests/playwright.config.mjs", ...process.argv.slice(2)],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PLAYWRIGHT_BASE_URL: baseUrl,
        RELAY_TEST_TOKEN: token,
        RELAY_TEST_DATA_DIR: dataDir,
        RELAY_TEST_CLAUDE_CRED_FILE: claudeCredFile,
      },
      stdio: "inherit",
      windowsHide: false,
    },
  );

  const testExitCode = await new Promise((resolve) => {
    testProc.once("exit", (code) => resolve(Number.isFinite(Number(code)) ? Number(code) : 1));
    testProc.once("error", () => resolve(1));
  });

  process.off("SIGINT", onSigInt);
  process.off("SIGTERM", onSigTerm);
  await stopProcess(serverProc);
  cleanupStateRoot();
  process.exit(testExitCode);
}

main().catch((error) => {
  console.error(`[run-e2e] ${error?.message || String(error)}`);
  process.exit(1);
});
