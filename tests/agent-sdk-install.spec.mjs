import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { repoRoot, startRelayServer } from "./relay-server-harness.mjs";

/**
 * The Agent SDK rows in Settings: the relay installs the Claude and Cursor
 * SDKs on demand, and a row shows the state, the versions and the live log
 * with the one button its state calls for.
 *
 * Nothing reaches a registry: `server/services/fixtures/agent-sdk-install-stub`
 * stands in for `npm ci` (the store runs it in the folder it installs, and it
 * writes the package.json files the store checks), and the store's folder is
 * a scratch folder inside this relay's state root. The harness already sets
 * the stub opt-in (COPILOT_WEB_RELAY_CLI_INSTALL_ALLOW_STUB_SPAWN); the store
 * honours it only together with its own stub command.
 *
 * Its own relay: an install changes the store's folder, which a shared relay's
 * other specs must not see.
 */

const fixtures = path.join(repoRoot, "server", "services", "fixtures");
const pinOf = (sdk) => JSON.parse(fs.readFileSync(path.join(repoRoot, "server", "agent-sdks", sdk, "pin.json"), "utf8"));
const CURSOR_PINNED = pinOf("cursor").dependencies["@cursor/sdk"];
const CLAUDE_PINNED = pinOf("claude").dependencies["@anthropic-ai/claude-agent-sdk"];

test.describe.serial("Agent SDK rows", () => {
  test.describe.configure({ timeout: 120_000 });

  let relay = null;

  const rowOf = (page, id) => page.locator(`#agent-sdk-${id}-row`);
  const statusOf = (page, id) => rowOf(page, id).locator('[data-part="status"]');
  const buttonOf = (page, id, action) => rowOf(page, id).locator(`button[data-action="${action}"]`);

  function authHeaders() {
    return { Authorization: `Bearer ${relay.token}` };
  }

  async function loadApp(page) {
    await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openSettingsModal === "function");
  }

  async function openSettings(page, tab, providerTab) {
    await page.evaluate(([t, p]) => window.openSettingsModal(t, p), [tab, providerTab]);
    await expect(page.locator("#settings-modal")).toHaveClass(/visible/);
  }

  test.beforeAll(async () => {
    // host-platform: the store spawns the launcher the relay's own OS can run.
    const stubExt = process.platform === "win32" ? ".cmd" : ".sh"; // host-platform: launcher per OS
    relay = await startRelayServer({
      token: randomUUID(),
      overrides: ({ stateRoot }) => ({
        COPILOT_WEB_RELAY_AGENT_SDK_INSTALL_COMMAND: path.join(fixtures, `agent-sdk-install-stub${stubExt}`),
        OAR_SDK_DIR: path.join(stateRoot, "sdks"),
        // This checkout's devDependencies must not stand in for the store.
        OAR_AGENT_SDK_SOURCE: "store",
        // A few seconds of "installing", so the state and the log are seen.
        AGENT_SDK_STUB_SLEEP: "3",
      }),
    });
  });

  test.afterAll(async () => {
    if (relay) await relay.stop();
    relay = null;
  });

  test("Claude's SDK shows in the Claude, Claude API and DeepSeek tabs, not installed", async ({ page }) => {
    await loadApp(page);
    for (const [providerTab, rowId] of [["claude", "claude"], ["claude-api", "claude-api"], ["deepseek", "deepseek"]]) {
      await openSettings(page, "providers", providerTab);
      await expect(rowOf(page, rowId)).toBeVisible();
      await expect(rowOf(page, rowId).locator('[data-part="label"]')).toHaveText("Claude Agent SDK");
      await expect(statusOf(page, rowId)).toHaveText(`Not installed · pinned ${CLAUDE_PINNED} · none installed`);
      await expect(buttonOf(page, rowId, "install")).toBeVisible();
    }
  });

  test("Install streams the log and lands on the installed version, with Reinstall", async ({ page, request }) => {
    await loadApp(page);
    await openSettings(page, "providers", "cursor");
    await expect(statusOf(page, "cursor")).toHaveText(`Not installed · pinned ${CURSOR_PINNED} · none installed`);

    await buttonOf(page, "cursor", "install").click();
    await expect(statusOf(page, "cursor")).toHaveText(/^Installing…/);
    await expect(buttonOf(page, "cursor", "cancel")).toBeVisible();
    await rowOf(page, "cursor").locator('[data-part="log-details"] summary').click();
    await expect(rowOf(page, "cursor").locator('[data-part="log"]')).toContainText("npm ci (stub) for cursor");

    await expect(statusOf(page, "cursor")).toHaveText(`Installed · pinned ${CURSOR_PINNED} · installed ${CURSOR_PINNED}`, { timeout: 60_000 });
    await expect(statusOf(page, "cursor")).toHaveAttribute("data-state", "active");
    await expect(buttonOf(page, "cursor", "reinstall")).toBeVisible();
    await expect(buttonOf(page, "cursor", "install")).toBeHidden();

    const payload = await (await request.get(`${relay.baseUrl}/api/agent-sdks/status`, { headers: authHeaders() })).json();
    expect(payload.sdks.cursor.state).toBe("ready");
    expect(payload.sdks.cursor.installed).toBe(CURSOR_PINNED);
    // In the scratch folder, under its versioned name, with its marker.
    expect(path.dirname(path.dirname(payload.sdks.cursor.dir))).toBe(path.join(relay.stateRoot, "sdks"));
    expect(fs.existsSync(path.join(payload.sdks.cursor.dir, "oar-sdk.json"))).toBe(true);
    // Claude's SDK was not touched.
    expect(payload.sdks.claude.state).toBe("missing");
  });

  test("the Windows helper row shows on a Windows relay only", async ({ page }) => {
    await loadApp(page);
    await openSettings(page, "general");
    // host-platform: koffi exists only on Windows, and the relay under test runs on this host's OS.
    if (process.platform === "win32") { // host-platform: koffi is a Windows-only store entry
      await expect(rowOf(page, "koffi")).toBeVisible();
      await expect(rowOf(page, "koffi").locator('[data-part="label"]')).toHaveText("Windows helper (koffi)");
      await expect(buttonOf(page, "koffi", "reinstall")).toBeHidden();
    } else {
      await expect(rowOf(page, "koffi")).toBeHidden();
    }
  });

  test("refuses an unknown SDK", async ({ request }) => {
    const unknown = await request.post(`${relay.baseUrl}/api/agent-sdks/install`, {
      headers: authHeaders(),
      data: { sdk: "cursor; rm -rf /" },
    });
    expect(unknown.status()).toBe(400);
    expect((await unknown.json()).error).toBe("Unknown agent SDK");
  });

  // Its own test: Playwright's request context keeps the auth cookie an
  // authenticated call in the same test would have set.
  test("the agent SDK endpoints reject unauthenticated access", async ({ request }) => {
    expect((await request.get(`${relay.baseUrl}/api/agent-sdks/status`)).status()).toBe(401);
  });
});
