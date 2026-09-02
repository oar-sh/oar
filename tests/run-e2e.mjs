import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";

import {
  repoRoot,
  startRelayServer,
  stopProcess,
} from "./relay-server-harness.mjs";

const playwrightCli = path.join(repoRoot, "node_modules", "@playwright", "test", "cli.js");
const token = randomUUID();

async function main() {
  let shutdownRequested = false;

  // Isolate the test server's state (db, singleton lock, uploads, config) from a
  // live relay running out of the same checkout. The env block that does the
  // isolating lives in relay-server-harness.mjs, shared with the specs that boot
  // their own differently-configured relay.
  const relay = await startRelayServer({
    token,
    allowCli: Boolean(String(process.env.RELAY_E2E_ALLOW_CLI || "").trim()),
  });

  const shutdown = async (exitCode) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    await relay.stop();
    process.exit(exitCode);
  };

  const onSigInt = () => { void shutdown(130); };
  const onSigTerm = () => { void shutdown(143); };
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  const testProc = spawn(
    process.execPath,
    [playwrightCli, "test", "--config", "tests/playwright.config.mjs", ...process.argv.slice(2)],
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
  process.exit(testExitCode);
}

main().catch((error) => {
  console.error(`[run-e2e] ${error?.message || String(error)}`);
  process.exit(1);
});
