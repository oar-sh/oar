import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test } from "@playwright/test";

import { repoRoot, startRelayServer } from "./relay-server-harness.mjs";

/**
 * Installing a provider CLI from Settings → Providers, and the chat-error CTA
 * that sends a user there.
 *
 * The dead end this covers: a Grok turn fails with `relay.grok-cli-missing` and
 * the only fix used to be a shell on the relay host. Everything below runs
 * against stubs — `server/services/fixtures/cli-install-stub.sh` stands in for
 * `curl -fsSL https://x.ai/cli/install.sh | bash`, and it writes its fake binary
 * into the one directory the relay is allowed to resolve from
 * (COPILOT_WEB_RELAY_CLI_BIN_DIR) — so no vendor URL is ever fetched and the
 * host's own grok/claude/copilot are invisible to this relay. That pin lives in
 * relay-server-harness.mjs; without it an isolated relay reports (and probes)
 * whatever the developer has installed, because it inherits the host PATH.
 *
 * This spec boots its **own** relay rather than sharing the suite's: a
 * successful install rewrites config.json's `cliBinaries`, binds
 * GROK_CLI_COMMAND / CLAUDE_CODE_EXECUTABLE into the relay's process env and
 * hoists PATH — all of which the shared server's Grok-account spec
 * (tests/grok-auth.spec.mjs, which drives the stub `grok login`) needs left
 * alone.
 */

// The Node script directly (not its .sh/.cmd launcher): the spec invokes it
// through process.execPath, which works identically on every platform.
const INSTALL_STUB = path.join(repoRoot, "server", "services", "fixtures", "cli-install-stub.mjs");
// The stub's default version, i.e. what a relay-run install produces.
const INSTALLED_VERSION = "9.9.9";
// A deliberately older one, seeded straight from the same fixture, to reach the
// "already installed → Update" row without a first install.
const OLDER_VERSION = "1.0.0";

// The exact shape buildTerminalFailureTextForChat() (messages-routes.mjs)
// renders a `grok.cli_missing` turn failure as. The message half is verbatim
// from classifyGrokError() (grok-sdk-adapter.mjs); the trailing stable code is
// the only handle the client has for attaching a fix-it button.
const GROK_CLI_MISSING_TEXT = "Grok CLI was not found on PATH. Install it from Settings → Providers → Grok. "
  + "Error code: relay.grok-cli-missing. Retry the message. "
  + "If this keeps failing, restart the relay and include the error code.";

// `claude doctor` on a host whose npm global folder is not writable, verbatim
// from the plan's live audit (§2.3). No fixture covers this: cli-install-stub.sh
// writes a *native* install, and this is the one case that earns its own
// affordance, so the spec writes the binary that reports it.
const NPM_GLOBAL_CLAUDE_STUB_IMPL = `// Written by tests/cli-install.spec.mjs. Answers only the two probes
// cli-install-service.mjs runs against Claude. The doctor payload is verbatim
// from the plan's live audit of an npm-global host, Linux path included.
if (process.argv[2] === "--version") {
  process.stdout.write("2.1.247 (Claude Code)\\n");
  process.exit(0);
}
if (process.argv[2] === "doctor") {
  process.stdout.write(\`Running: npm-global (2.1.247)
Path: /usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude
Auto-updates: enabled
Last update attempt: failed (no_permissions) - 2026-08-26
1 warning found
- Can't auto-update: npm global folder isn't writable
  Fix: Run claude install to switch to the native installer (no sudo)
\`);
  process.exit(0);
}
process.stderr.write(\`claude-stub: unsupported command: \${process.argv.slice(2).join(" ")}\\n\`);
process.exit(2);
`;

/**
 * Writes the npm-global Claude stand-in as a Node script behind a platform
 * launcher — the same one-logic-two-launchers shape as the checked-in fixtures,
 * because Windows cannot spawn a shebang script at all.
 */
function writeNpmGlobalClaudeStub(binDir) {
  const implPath = path.join(binDir, "claude-npm-fake-cli.mjs");
  fs.writeFileSync(implPath, NPM_GLOBAL_CLAUDE_STUB_IMPL);
  // host-platform: the launcher must match the platform the relay under test
  // spawns on; the .cmd shim is also exactly what a real npm global install
  // puts on a Windows PATH.
  if (process.platform === "win32") { // host-platform: launcher must match the spawning OS
    const target = path.join(binDir, "claude.cmd");
    fs.writeFileSync(target, `@node "%~dp0claude-npm-fake-cli.mjs" %*\r\n`);
    return target;
  }
  const target = path.join(binDir, "claude");
  fs.writeFileSync(target, `#!/bin/sh\nexec node "$(dirname "$0")/claude-npm-fake-cli.mjs" "$@"\n`);
  fs.chmodSync(target, 0o755);
  return target;
}

test.describe.serial("Provider CLI install rows", () => {
  // A relay boot plus three stubbed installs that each stall deliberately.
  test.describe.configure({ timeout: 180_000 });

  let relay = null;

  const status = (page, id) => page.locator(`#cli-${id}-status`);
  const installBtn = (page, id) => page.locator(`#cli-${id}-install-btn`);
  const updateBtn = (page, id) => page.locator(`#cli-${id}-update-btn`);
  const migrateBtn = (page, id) => page.locator(`#cli-${id}-migrate-btn`);
  const cancelBtn = (page, id) => page.locator(`#cli-${id}-cancel-btn`);
  const dismissBtn = (page, id) => page.locator(`#cli-${id}-dismiss-btn`);
  const note = (page, id) => page.locator(`#cli-${id}-note`);
  const logSummary = (page, id) => page.locator(`#cli-${id}-log-summary`);
  const logBody = (page, id) => page.locator(`#cli-${id}-log`);

  function authHeaders() {
    return { Authorization: `Bearer ${relay.token}` };
  }

  async function loadApp(page) {
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForLoadState("networkidle");
    // networkidle can fire before the app modules finish binding their globals.
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
  }

  // Opening the modal force-refreshes the CLI rows, which is also how a spec
  // makes the relay re-probe a binary it seeded behind the panel's back.
  async function openProviderSettings(page, providerId) {
    await page.evaluate((id) => window.openSettingsModal("providers", id), providerId);
    await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
    await expect(page.locator(`#settings-provider-panel-${providerId}`)).toBeVisible();
  }

  /** "Already installed", produced by the same fixture the relay runs. */
  function seedInstalledBinary(providerId, version) {
    execFileSync(process.execPath, [INSTALL_STUB, providerId, "install"], {
      env: {
        ...process.env,
        CLI_INSTALL_STUB_BIN_DIR: relay.cliBinDir,
        CLI_INSTALL_STUB_VERSION: version,
        // The seed must not inherit the relay's stall.
        CLI_INSTALL_STUB_SLEEP: "",
      },
      stdio: "ignore",
    });
  }

  /**
   * Runs an action from the row and watches the install while it is still
   * running: the stub stalls for a few seconds after printing its first lines,
   * so the partially-streamed log is observable rather than only its final
   * state.
   */
  async function runActionFromRow(page, providerId, action, confirmLabel) {
    await page.locator(`#cli-${providerId}-${action}-btn`).click();
    await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
    await page.locator("#summary-modal-body button", { hasText: confirmLabel }).click();
    await expect(page.locator("#summary-modal")).not.toHaveClass(/visible/);

    await expect(logSummary(page, providerId)).toHaveText(/^Running · /);
    await expect(cancelBtn(page, providerId)).toBeVisible();
    // The log is a <details>; open it so its text is actually rendered.
    await page.locator(`#cli-${providerId}-log-details summary`).click();
    // Streamed, not delivered in one lump at the end: these two lines are
    // printed before the stub stalls, the third only after it.
    await expect(logBody(page, providerId)).toContainText("Resolving latest release");
    await expect(logBody(page, providerId)).not.toContainText("Installed ");

    await expect(logSummary(page, providerId)).toHaveText(/^Finished · /, { timeout: 30_000 });
  }

  test.beforeAll(async () => {
    relay = await startRelayServer({
      token: randomUUID(),
      overrides: {
        // A few seconds of stall per install, so "running" and the partial log
        // are observable through the UI instead of being a sub-100ms flicker.
        CLI_INSTALL_STUB_SLEEP: "3",
      },
    });
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
  });

  test("reports every provider as not installed, and says why Copilot has no button", async ({ page }) => {
    await loadApp(page);
    await openProviderSettings(page, "grok");

    // The host has a real grok/claude/copilot; the relay must see none of them.
    await expect(status(page, "grok")).toHaveText("Not installed");
    await expect(status(page, "grok")).toHaveAttribute("data-state", "unconfigured");
    await expect(installBtn(page, "grok")).toBeVisible();
    await expect(installBtn(page, "grok")).toBeEnabled();
    // update/migrate run the installed binary, so they cannot exist yet.
    await expect(updateBtn(page, "grok")).toBeHidden();
    await expect(migrateBtn(page, "grok")).toBeHidden();

    await openProviderSettings(page, "copilot");
    await expect(status(page, "copilot")).toHaveText("Not installed");
    // Detect-only: the npm-global CLI cannot be installed from here, and the row
    // says so instead of offering a button that could only ever fail.
    await expect(installBtn(page, "copilot")).toBeHidden();
    await expect(note(page, "copilot")).toContainText("Managed with npm on this host");
  });

  test("a failed Grok turn offers Install Grok CLI, and it opens the confirm sheet", async ({ page }) => {
    const conversationId = `cli-install-cta-${Date.now()}`;
    const db = new DatabaseSync(path.join(relay.dataDir, "copilot.db"));
    try {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO conversations (id, title, archived, status, created_at, updated_at)
        VALUES (?, ?, 0, 'active', ?, ?)
      `).run(conversationId, "Grok CLI missing", now, now);
      db.prepare(`
        INSERT INTO messages (id, conversation_id, role, text, model, mode, attachments, timestamp)
        VALUES (?, ?, 'assistant', ?, NULL, NULL, NULL, ?)
      `).run(`${conversationId}-msg`, conversationId, GROK_CLI_MISSING_TEXT, now);
    } finally {
      db.close();
    }

    try {
      await loadApp(page);
      await page.evaluate(async (id) => { await window.openConversation(id); }, conversationId);

      const bubble = page.locator(".msg.assistant .msg-bubble", { hasText: "relay.grok-cli-missing" });
      await expect(bubble).toBeVisible();
      const ctas = bubble.locator(".msg-error-cta button");
      await expect(ctas).toHaveText(["Install Grok CLI", "Grok settings"]);

      await ctas.first().click();
      // The CTA lands where the state lives: the Grok panel renders the log.
      await expect(page.locator("#settings-provider-panel-grok")).toBeVisible();
      // And it opens the confirm sheet — never a bare `curl | bash` from a chat
      // bubble. The command named is the vendor's own literal, even though the
      // stub is what this relay will actually run.
      await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
      await expect(page.locator("#summary-modal-title")).toHaveText("Install Grok CLI");
      // host-platform: the sheet quotes the descriptor entry for the platform
      // the relay under test runs on, so the expected literal follows it.
      const windowsRelay = process.platform === "win32"; // host-platform: sheet quotes this platform's descriptor
      await expect(page.locator("#summary-modal-body")).toContainText(
        windowsRelay
          ? "irm https://x.ai/cli/install.ps1 | iex"
          : "curl -fsSL https://x.ai/cli/install.sh | bash",
      );
      await expect(page.locator("#summary-modal-body")).toContainText(
        windowsRelay ? "%USERPROFILE%\\.grok\\bin" : "~/.grok/bin",
      );
      await expect(page.locator("#summary-modal-body")).toContainText("without sudo");

      await page.locator("#summary-modal-body button", { hasText: "Cancel" }).click();
      await expect(page.locator("#summary-modal")).not.toHaveClass(/visible/);
    } finally {
      await fetch(`${relay.baseUrl}/api/conversation/${conversationId}`, {
        method: "DELETE",
        headers: authHeaders(),
      }).catch(() => {});
    }
  });

  test("Install streams the log and lands on a row with the version and path", async ({ page, request }) => {
    await loadApp(page);
    await openProviderSettings(page, "grok");
    await runActionFromRow(page, "grok", "install", "Install");

    // host-platform: the stub installs the same launcher shape a real install
    // leaves behind on each platform, so the resolved path carries .cmd on a
    // Windows relay.
    const installedPath = path.join(relay.cliBinDir, process.platform === "win32" ? "grok.cmd" : "grok"); // host-platform: launcher shape per OS
    await expect(logBody(page, "grok")).toContainText(`Installed grok ${INSTALLED_VERSION}`);
    await expect(status(page, "grok")).toContainText(INSTALLED_VERSION);
    await expect(status(page, "grok")).toContainText(installedPath);
    // `grok update --check --json` really ran against the freshly installed
    // binary, so the row can say which side of an update it is on.
    await expect(status(page, "grok")).toContainText("up to date");
    await expect(status(page, "grok")).toHaveAttribute("data-state", "active");
    // Installed means Update from here on, never Install again.
    await expect(installBtn(page, "grok")).toBeHidden();
    await expect(updateBtn(page, "grok")).toBeVisible();

    const payload = await (await request.get(`${relay.baseUrl}/api/cli/status`, {
      headers: authHeaders(),
    })).json();
    expect(payload.providers.grok.installed).toBe(true);
    expect(payload.providers.grok.version).toBe(INSTALLED_VERSION);
    expect(payload.providers.grok.path).toBe(installedPath);
    // Bound, so a worker spawned now resolves this copy — the whole point of
    // installing without a relay restart.
    expect(payload.providers.grok.bound).toBe(installedPath);
    const config = JSON.parse(fs.readFileSync(path.join(relay.stateRoot, "config.json"), "utf8"));
    expect(config.cliBinaries.grok).toBe(installedPath);
    // The merge left the rest of config.json alone; a blind rewrite here would
    // drop the auth token and lock out every paired client.
    expect(config).toHaveProperty("port");

    // Dismiss is the same route as cancel, and clears the settled outcome.
    await dismissBtn(page, "grok").click();
    await expect(page.locator("#cli-grok-log-details")).toBeHidden();
  });

  test("an older install offers Update, and updating replaces it in place", async ({ page }) => {
    seedInstalledBinary("grok", OLDER_VERSION);

    await loadApp(page);
    await openProviderSettings(page, "grok");
    await expect(status(page, "grok")).toContainText(OLDER_VERSION);
    await expect(updateBtn(page, "grok")).toBeVisible();
    await expect(installBtn(page, "grok")).toBeHidden();

    // `grok update`, not a re-run of the install script: the CLI self-updates
    // (`installer: "internal"` in its update check).
    await updateBtn(page, "grok").click();
    await expect(page.locator("#summary-modal-title")).toHaveText("Update Grok CLI");
    await expect(page.locator("#summary-modal-body")).toContainText("grok update");
    await page.locator("#summary-modal-body button", { hasText: "Update" }).click();
    await expect(page.locator("#summary-modal")).not.toHaveClass(/visible/);

    await expect(logSummary(page, "grok")).toHaveText(/^Finished · grok update$/, { timeout: 30_000 });
    await expect(status(page, "grok")).toContainText(INSTALLED_VERSION);
    await expect(status(page, "grok")).not.toContainText(OLDER_VERSION);
    await dismissBtn(page, "grok").click();
  });

  test("an npm-global Claude that cannot auto-update offers the native installer", async ({ page }) => {
    writeNpmGlobalClaudeStub(relay.cliBinDir);

    await loadApp(page);
    await openProviderSettings(page, "claude");
    await expect(status(page, "claude")).toContainText("2.1.247");
    await expect(status(page, "claude")).toContainText("npm-global");
    // The doctor warning is quoted verbatim — they are the CLI's own words, and
    // the migration note spells out the consequence rather than hiding it.
    await expect(note(page, "claude")).toContainText("npm global folder isn't writable");
    await expect(note(page, "claude")).toContainText("The npm copy stays where it is");
    await expect(migrateBtn(page, "claude")).toBeVisible();
    await expect(migrateBtn(page, "claude")).toHaveText("Switch to native installer");

    await runActionFromRow(page, "claude", "migrate", "Switch to the native installer");

    // The migration really replaced what the relay resolves, so the row stops
    // offering it — it is never a standing option, only the fix for this case.
    await expect(status(page, "claude")).toContainText(INSTALLED_VERSION);
    await expect(status(page, "claude")).toContainText("native");
    await expect(migrateBtn(page, "claude")).toBeHidden();
    await expect(note(page, "claude")).toBeHidden();
    await dismissBtn(page, "claude").click();
  });

  test("refuses an unknown provider and a detect-only one", async ({ request }) => {
    // The id is looked up in the frozen descriptor table; there is no path from
    // a request body to a command.
    const unknown = await request.post(`${relay.baseUrl}/api/cli/install`, {
      headers: authHeaders(),
      data: { provider: "grok; rm -rf /", action: "install" },
    });
    expect(unknown.status()).toBe(400);
    expect((await unknown.json()).error).toBe("Unknown CLI provider");

    const detectOnly = await request.post(`${relay.baseUrl}/api/cli/install`, {
      headers: authHeaders(),
      data: { provider: "copilot", action: "install" },
    });
    expect(detectOnly.status()).toBe(400);
    expect((await detectOnly.json()).error).toMatch(/Managed with npm/);

    const unknownAction = await request.post(`${relay.baseUrl}/api/cli/install`, {
      headers: authHeaders(),
      data: { provider: "grok", action: "uninstall" },
    });
    expect(unknownAction.status()).toBe(400);
    expect((await unknownAction.json()).error).toBe("Unknown install action");
  });

  // Its own test on purpose: the relay hands an authenticated caller an auth
  // cookie, and Playwright's request context keeps a cookie jar — so an
  // "anonymous" call made after an authenticated one in the same test would
  // carry that cookie and pass with a 200.
  test("the CLI endpoints reject unauthenticated access", async ({ request }) => {
    const anonymous = await request.get(`${relay.baseUrl}/api/cli/status`);
    expect(anonymous.status()).toBe(401);
  });
});
