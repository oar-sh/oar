import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { relayToken, relayDbPath } from "./e2e-env.mjs";

// Two browser contexts on one conversation stand in for two devices. Before
// the fix an idle device re-saved its stale (usually empty) composer over the
// other device's draft on every 3s question/status poll, unversioned.

function readDraftText(conversationId) {
  const db = new DatabaseSync(relayDbPath(), { readOnly: true });
  try {
    const row = db.prepare(`SELECT draft_text FROM conversations WHERE id = ?`).get(conversationId);
    return String(row?.draft_text || "");
  } finally {
    db.close();
  }
}

async function createConversation(request, headers, text) {
  const created = await request.post("/api/message", {
    headers,
    data: { text, relayMode: "ask", model: "gpt-5.4-mini" },
  });
  expect(created.ok()).toBeTruthy();
  const conversationId = String((await created.json())?.conversationId || "");
  expect(conversationId).toBeTruthy();
  return conversationId;
}

async function openDevice(browser, token, conversationId) {
  const context = await browser.newContext();
  await context.addInitScript((id) => {
    localStorage.setItem("copilot_last_conv", id);
  }, conversationId);
  const page = await context.newPage();
  const draftPatches = [];
  page.on("request", (req) => {
    if (req.method() === "PATCH" && req.url().includes(`/api/conversation/${conversationId}/draft`)) {
      draftPatches.push(req.postDataJSON());
    }
  });
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("#msg-input")).toBeVisible();
  // The seeding message's bubble means the conversation (and its draft) loaded.
  await expect(page.locator(".msg").first()).toBeVisible();
  return { context, page, draftPatches };
}

test("an idle, focused device never overwrites the draft typed on another device", async ({ browser, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const conversationId = await createConversation(request, headers, "draft sync idle device");

  const deviceA = await openDevice(browser, token, conversationId);
  const deviceB = await openDevice(browser, token, conversationId);
  try {
    await deviceB.page.click("#msg-input");

    await deviceA.page.fill("#msg-input", "typed on device A");
    await expect.poll(() => readDraftText(conversationId), { timeout: 10_000 }).toBe("typed on device A");

    // B was focused but untouched, so it follows A's draft.
    await expect(deviceB.page.locator("#msg-input")).toHaveValue("typed on device A");

    // Let several question (3s) and worker-status (4s) poll ticks pass.
    await deviceB.page.waitForTimeout(7_000);
    expect(readDraftText(conversationId)).toBe("typed on device A");
    expect(deviceB.draftPatches, "the idle device never saves a draft").toEqual([]);
    await expect(deviceA.page.locator("#msg-input")).toHaveValue("typed on device A");
  } finally {
    await deviceA.context.close();
    await deviceB.context.close();
  }
});

test("a simultaneous edit keeps the newest keystroke and offers the other text back", async ({ browser, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const conversationId = await createConversation(request, headers, "draft sync simultaneous edit");

  const deviceA = await openDevice(browser, token, conversationId);
  const deviceB = await openDevice(browser, token, conversationId);
  try {
    // Hold B's first save in flight so A's save lands in between: B's request
    // then carries a base version the server has already moved past.
    let releaseB;
    const bReleased = new Promise((resolve) => { releaseB = resolve; });
    let bHeld;
    const bIsHeld = new Promise((resolve) => { bHeld = resolve; });
    let heldOnce = false;
    await deviceB.page.route(`**/api/conversation/${conversationId}/draft`, async (route) => {
      if (!heldOnce) {
        heldOnce = true;
        bHeld();
        await bReleased;
      }
      await route.continue();
    });

    await deviceB.page.fill("#msg-input", "typed on device B");
    await bIsHeld;

    await deviceA.page.fill("#msg-input", "typed on device A");
    await expect.poll(() => readDraftText(conversationId), { timeout: 10_000 }).toBe("typed on device A");
    // B is mid-edit: A's broadcast must not clobber its unsaved text.
    await expect(deviceB.page.locator("#msg-input")).toHaveValue("typed on device B");

    releaseB();

    // B's stale save conflicts; B holds the newest keystroke, so it re-saves
    // on top of A's version and offers A's text back.
    await expect.poll(() => readDraftText(conversationId), { timeout: 10_000 }).toBe("typed on device B");
    const restore = deviceB.page.locator("#relay-toast .relay-toast-action");
    await expect(restore).toBeVisible();
    await expect(deviceB.page.locator("#relay-toast")).toContainText("another device");
    expect(deviceB.draftPatches.at(-1)?.draftText).toBe("typed on device B");

    // A had not typed since its save, so it silently follows.
    await expect(deviceA.page.locator("#msg-input")).toHaveValue("typed on device B");

    await restore.click();
    await expect(deviceB.page.locator("#msg-input")).toHaveValue("typed on device A");
    await expect.poll(() => readDraftText(conversationId), { timeout: 10_000 }).toBe("typed on device A");
    await expect(deviceA.page.locator("#msg-input")).toHaveValue("typed on device A");
  } finally {
    await deviceA.context.close();
    await deviceB.context.close();
  }
});
