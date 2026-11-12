import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import {
  repoRoot,
  startRelayServer,
  stopProcess,
} from "./relay-server-harness.mjs";
import { snapshotWorktreeData, worktreeDataChanges } from "../scripts/worktree-data-guard.mjs";

const playwrightCli = path.join(repoRoot, "node_modules", "@playwright", "test", "cli.js");
const token = randomUUID();
const relayLogReporter = path.join(repoRoot, "tests", "relay-log-reporter.mjs");

// A --reporter given on the command line replaces the config's list, the
// relay log reporter with it: it is added back.
function withRelayLogReporter(args) {
  return args.map((arg, index) => {
    if (arg.startsWith("--reporter=")) return `${arg},${relayLogReporter}`;
    if (index > 0 && args[index - 1] === "--reporter") return `${arg},${relayLogReporter}`;
    return arg;
  });
}

// A relay booted on an empty database has no provider known to be ready, so
// the app points to Settings instead of offering a Copilot chat: the empty
// screen, New Chat and the composer all change. The specs here assume today's
// ready relay, so the shared one is marked "Copilot ready" once after boot: a
// snapshot post from a non-authoritative source naming a curated model changes
// the catalog's `source` (the readiness signal) and nothing else. The
// fresh-install specs boot their own relay and never see this.
async function markRelayCopilotReady(relay) {
  const response = await fetch(`${relay.baseUrl}/api/models/snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ source: "e2e-harness:copilot-ready", models: ["gpt-5.4-mini"] }),
  });
  if (!response.ok) {
    throw new Error(`could not mark the test relay Copilot-ready: HTTP ${response.status}`);
  }
}

async function main() {
  let shutdownRequested = false;
  // Nothing a spec does may leave a database or a backup in this checkout.
  const worktreeBefore = snapshotWorktreeData(repoRoot);

  // The relay's output, redacted, for the report of a spec that fails
  // (relay-log-reporter.mjs). Kept when the run fails.
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "oar-e2e-relay-log-"));
  const logFile = path.join(logDir, "relay.log");

  // Isolate the test server's state (db, singleton lock, uploads, config) from a
  // live relay running out of the same checkout. The env block that does the
  // isolating lives in relay-server-harness.mjs, shared with the specs that boot
  // their own differently-configured relay.
  const relay = await startRelayServer({
    token,
    logFile,
    logTailBytes: 64 * 1024,
    allowCli: Boolean(String(process.env.RELAY_E2E_ALLOW_CLI || "").trim()),
    // A cold start on a CI runner (a fresh checkout, the module cache empty)
    // takes longer than the harness's 30 s default.
    readyTimeoutMs: 120_000,
  });
  await markRelayCopilotReady(relay);

  const shutdown = async (exitCode) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    await relay.stop();
    fs.rmSync(logDir, { recursive: true, force: true });
    process.exit(exitCode);
  };

  const onSigInt = () => { void shutdown(130); };
  const onSigTerm = () => { void shutdown(143); };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  const testProc = spawn(
    process.execPath,
    [playwrightCli, "test", "--config", "tests/playwright.config.mjs", ...withRelayLogReporter(process.argv.slice(2))],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PLAYWRIGHT_BASE_URL: relay.baseUrl,
        RELAY_TEST_TOKEN: token,
        RELAY_TEST_DATA_DIR: relay.dataDir,
        RELAY_TEST_CLAUDE_CRED_FILE: relay.claudeCredFile,
        // The CLI-install specs boot their own relay (an install rewrites config
        // and rebinds env), so only the Grok-account paths are published here.
        RELAY_TEST_GROK_AUTH_FILE: relay.grokAuthFile,
        RELAY_TEST_GROK_LOGIN_AUTHORIZED_FILE: relay.grokLoginAuthorizedFile,
        RELAY_TEST_GROK_LOGIN_DENIED_FILE: relay.grokLoginDeniedFile,
        RELAY_TEST_LOG_FILE: logFile,
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
  await stopProcess(relay.proc);
  relay.cleanupStateRoot();
  if (testExitCode === 0) fs.rmSync(logDir, { recursive: true, force: true });
  else console.error(`\nThe test relay's output (redacted): ${logFile}`);
  const leftBehind = worktreeDataChanges(worktreeBefore, snapshotWorktreeData(repoRoot));
  if (leftBehind.length) {
    console.error(`\nA spec left files in this checkout (use a temp folder; or a relay running from this checkout made them): ${leftBehind.join(", ")}`);
    process.exit(testExitCode || 1);
  }
  process.exit(testExitCode);
}

main().catch((error) => {
  console.error(`[run-e2e] ${error?.message || String(error)}`);
  process.exit(1);
});
