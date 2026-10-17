import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { relayDbPath, relayToken } from "./e2e-env.mjs";

// Path privacy in shared views, against the shared e2e relay (default mode:
// hide the path, show the file name). One turn names a host path in its tool
// line and its reply; a sub-agent of it reads a file by its absolute path.
//
// "Preview as shared" opens from the ⋯ menu without making a share link: the
// redactions are highlighted, a relative path that is left is flagged, and no
// absolute path reaches the page. A share link shows the same text without
// any highlight. In the shared view a sub-agent row opens the viewer
// read-only, its record filtered too, with no Stop. Settings → Sharing sets
// the mode, and a share link follows it.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dequeue(request, headers, messageId, ownerSessionId) {
  const dequeueHeaders = ownerSessionId ? { ...headers, "x-relay-session-id": ownerSessionId } : headers;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const dequeued = await request.get("/api/pending", { headers: dequeueHeaders });
    expect(dequeued.ok()).toBeTruthy();
    const message = (await dequeued.json())?.message || null;
    if (message && String(message.id) === messageId) return;
    if (message) await request.post("/api/requeue", { headers, data: { messageId: String(message.id) } }).catch(() => {});
    await sleep(200);
  }
  throw new Error("the queued message was never handed out");
}

const HOST_FILE = "/home/dev/work/demo/src/app.js";
const HOST_CHILD_FILE = "/home/dev/work/demo/lib/parser.js";

async function seedTurn(request, headers, stamp) {
  const queued = await request.post("/api/message", {
    headers,
    data: { text: `Fix the report builder ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" },
  });
  expect(queued.ok()).toBeTruthy();
  const body = await queued.json();
  const conversationId = String(body?.conversationId || "");
  const messageId = String(body?.messageId || "");
  await dequeue(request, headers, messageId, String(body?.ownerSessionId || ""));
  const runId = `toolu_share_${stamp}`;
  expect((await request.post("/api/activity", { headers, data: { messageId, conversationId, mode: "agent", text: `Read ${HOST_FILE}` } })).ok()).toBeTruthy();
  expect((await request.post("/api/subagent-run", {
    headers,
    data: { messageId, conversationId, subagentRunId: runId, displayName: "Survey the parser", status: "running", subagentType: "Explore", timelineOwner: "worker" },
  })).ok()).toBeTruthy();
  expect((await request.post("/api/subagent-timeline", {
    headers,
    data: {
      conversationId,
      subagentRunId: runId,
      entries: [
        { key: "w:1", kind: "thought", text: `Start with ${HOST_CHILD_FILE}.`, done: true },
        { key: "w:2", kind: "tool_call", toolName: "Read", toolUseId: "toolu_read_1", text: JSON.stringify({ file_path: HOST_CHILD_FILE }) },
        { key: "w:3", kind: "text", text: `Done with ${HOST_CHILD_FILE}.` },
      ],
      header: { status: "completed" },
    },
  })).ok()).toBeTruthy();
  expect((await request.post("/api/response", {
    headers,
    data: { messageId, conversationId, text: `Fixed ${HOST_FILE}; src/util.js needs a look too.`, model: "gpt-5.4-mini", mode: "agent" },
  })).ok()).toBeTruthy();
  return { conversationId, runId };
}

function shareCount(conversationId) {
  const db = new DatabaseSync(relayDbPath(), { timeout: 5_000, readOnly: true });
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM conversation_shares WHERE conversation_id = ?").get(conversationId)?.n || 0);
  } finally {
    db.close();
  }
}

async function openOwnerPage(page, token, conversationId) {
  await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForFunction(() => typeof window.openConversation === "function");
  await expect(page.locator("#cli-dot")).toHaveClass("online");
}

test.describe("path privacy in shared views", () => {
  test("preview as shared marks the redactions and makes no share link; the share link shows the same, unmarked", async ({ page, request, browser }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const { conversationId } = await seedTurn(request, headers, Date.now());

    await openOwnerPage(page, token, conversationId);
    // The owner's own view shows the whole path.
    await expect(page.locator("#messages .msg.assistant").last()).toContainText(HOST_FILE);

    await page.locator("#chat-actions-menu-btn").click();
    const entry = page.locator("#chat-menu-preview-shared");
    await expect(entry).toBeVisible();
    const [preview] = await Promise.all([page.context().waitForEvent("page"), entry.click()]);
    await preview.waitForLoadState("domcontentloaded");
    expect(new URL(preview.url()).pathname).toBe(`/share-preview/${conversationId}`);

    await expect(preview.locator("#share-preview-banner")).toBeVisible();
    const reply = preview.locator("#messages .msg.assistant").last();
    await expect(reply).toContainText("Fixed app.js;");
    await expect(reply.locator("mark.share-preview-redacted").first()).toHaveText("app.js");
    await expect(reply.locator("mark.share-preview-suspect").first()).toHaveText("src/util.js");
    await expect(preview.locator("#messages")).not.toContainText("/home/dev");
    // No mark character is left over anywhere on the page.
    expect(await preview.evaluate(() => /[-]/.test(document.body.innerText))).toBe(false);
    expect(shareCount(conversationId), "the preview made a share link").toBe(0);
    await preview.close();

    const share = await request.post(`/api/conversation/${conversationId}/share`, { headers });
    expect(share.ok()).toBeTruthy();
    const shareToken = String((await share.json())?.token || "");
    const sharedContext = await browser.newContext();
    try {
      const sharedPage = await sharedContext.newPage();
      await sharedPage.goto(`/shared/${shareToken}`);
      const sharedReply = sharedPage.locator("#messages .msg.assistant").last();
      await expect(sharedReply).toContainText("Fixed app.js; src/util.js needs a look too.");
      await expect(sharedPage.locator("mark.share-preview-redacted, mark.share-preview-suspect")).toHaveCount(0);
      await expect(sharedPage.locator("#share-preview-banner")).toBeHidden();
      await expect(sharedPage.locator("#messages")).not.toContainText("/home/dev");
    } finally {
      await sharedContext.close();
      await request.delete(`/api/conversation/${conversationId}/share`, { headers }).catch(() => {});
    }
  });

  test("a sub-agent opens read-only in the shared view, its record filtered", async ({ request, browser }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const { conversationId, runId } = await seedTurn(request, headers, Date.now());
    const share = await request.post(`/api/conversation/${conversationId}/share`, { headers });
    expect(share.ok()).toBeTruthy();
    const shareToken = String((await share.json())?.token || "");
    const sharedContext = await browser.newContext();
    try {
      const sharedPage = await sharedContext.newPage();
      await sharedPage.goto(`/shared/${shareToken}`);
      const row = sharedPage.locator(`.msg .subagent-row[data-subagent-row="${runId}"]`);
      await expect(row).toBeVisible();
      await row.locator("[data-subagent-open]").click();
      const modal = sharedPage.locator("#subagent-viewer-modal");
      await expect(modal).toHaveClass(/visible/);
      await expect(sharedPage.locator("#subagent-viewer-title")).toHaveText("Survey the parser");
      await expect(modal.locator(".sav-entry")).toHaveCount(3);
      await expect(modal).toContainText("parser.js");
      await expect(modal).not.toContainText("/home/dev");
      await expect(sharedPage.locator("#subagent-viewer-stop")).toBeHidden();
      await sharedPage.keyboard.press("Escape");
      await expect(modal).not.toHaveClass(/visible/);

      // The share's route refuses a run that is not this conversation's.
      const foreign = await sharedContext.request.get(`/api/shared/${shareToken}/subagent/toolu_not_here`);
      expect(foreign.status()).toBe(404);
    } finally {
      await sharedContext.close();
      await request.delete(`/api/conversation/${conversationId}/share`, { headers }).catch(() => {});
    }
  });

  test("Settings › Sharing sets the mode, and a share link follows it", async ({ page, request, browser }) => {
    const token = relayToken();
    const headers = { Authorization: `Bearer ${token}` };
    const { conversationId } = await seedTurn(request, headers, Date.now());
    const share = await request.post(`/api/conversation/${conversationId}/share`, { headers });
    expect(share.ok()).toBeTruthy();
    const shareToken = String((await share.json())?.token || "");
    try {
      await openOwnerPage(page, token, conversationId);
      await page.waitForFunction(() => typeof window.openSettingsModal === "function");
      await page.evaluate(() => window.openSettingsModal("shares"));
      const section = page.locator("#shares-path-privacy-section");
      await expect(section).toBeVisible();
      await expect(section).toContainText("best-effort");
      await expect(section.locator('input[value="filename"]')).toBeChecked();
      await section.getByLabel("Hide paths and file names").check();
      await expect(page.locator("#settings-shares-path-privacy-status")).toContainText("Saved");
      const setting = await request.get("/api/settings/share-path-privacy", { headers });
      expect((await setting.json()).mode).toBe("hide");

      const sharedContext = await browser.newContext();
      try {
        const sharedPage = await sharedContext.newPage();
        await sharedPage.goto(`/shared/${shareToken}`);
        await expect(sharedPage.locator("#messages .msg.assistant").last()).toContainText("Fixed ‹hidden›;");
        await expect(sharedPage.locator("#messages")).not.toContainText("app.js");
      } finally {
        await sharedContext.close();
      }

      await section.getByLabel("Show every path and file name").check();
      await expect(page.locator("#settings-shares-path-privacy-status")).toContainText("Saved");
      const shown = await request.get(`/api/shared/${shareToken}`);
      expect(JSON.stringify(await shown.json())).toContain(HOST_FILE);
    } finally {
      await request.post("/api/settings/share-path-privacy", { headers, data: { mode: "filename" } }).catch(() => {});
      await request.delete(`/api/conversation/${conversationId}/share`, { headers }).catch(() => {});
    }
  });
});
