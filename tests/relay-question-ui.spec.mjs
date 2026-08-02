import path from "path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { relayToken, relayBaseUrl, relayDbPath } from "./e2e-env.mjs";

function relayOrigin() {
  return new URL(relayBaseUrl()).origin;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readSdkDeleteRequest(sdkSessionId) {
  const db = new DatabaseSync(relayDbPath(), { readOnly: true });
  try {
    return db.prepare(
      `SELECT sdk_session_id, conversation_id, status, retry_count, requested_at
       FROM sdk_delete_requests
       WHERE sdk_session_id = ?`
    ).get(sdkSessionId);
  } finally {
    db.close();
  }
}

function makeInlineSvgDataUrl(width, height, fill = "#4ade80") {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="${fill}"/>
      <rect x="12" y="12" width="${Math.max(0, width - 24)}" height="${Math.max(0, height - 24)}" rx="18" fill="rgba(255,255,255,0.32)"/>
    </svg>
  `.trim();
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function buildLongText(prefix) {
  return Array.from({ length: 80 }, (_, index) => `${prefix} line ${String(index + 1).padStart(2, "0")}`).join("\n");
}

async function openRepoBrowserFromComposer(page) {
  const desktopBtn = page.locator("#repo-browser-desktop-btn");
  if (await desktopBtn.isVisible().catch(() => false)) {
    await desktopBtn.click();
    return;
  }
  const mobileBtn = page.locator("#repo-browser-input-btn");
  if (await mobileBtn.isVisible().catch(() => false)) {
    await mobileBtn.click();
    return;
  }
  await page.click("#repo-browser-fab");
}

async function dequeueSpecificMessage(request, headers, messageId, maxAttempts = 30) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const dequeued = await request.get("/api/pending", { headers });
    expect(dequeued.ok()).toBeTruthy();
    const pendingBody = await dequeued.json();
    const msg = pendingBody?.message || null;
    if (!msg) {
      await sleep(250);
      continue;
    }
    if (String(msg.id || "") === String(messageId || "")) return pendingBody;
    await request.post("/api/requeue", {
      headers,
      data: { messageId: String(msg.id || "") },
    }).catch(() => {});
    await sleep(120);
  }
  throw new Error(`Timed out waiting to dequeue target message ${String(messageId || "").slice(0, 8)}`);
}

test("renders and answers relay question card in the web UI", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const seedText = `Playwright relay seed ${stamp}`;
  const questionPrompt = `Playwright question ${stamp}: Which option should I use?`;
  let conversationId = "";
  let messageId = "";
  let questionId = "";

  try {
    const queued = await request.post("/api/message", {
      headers,
      data: {
        text: seedText,
        relayMode: "autopilot",
        model: "gpt-5.4-mini",
        reasoningEffort: "high",
      },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    expect(conversationId).toBeTruthy();
    expect(messageId).toBeTruthy();

    const pendingBody = await dequeueSpecificMessage(request, headers, messageId);
    expect(String(pendingBody?.message?.id || "")).toBe(messageId);

    const created = await request.post("/api/relay-question", {
      headers,
      data: {
        queueId: messageId,
        messageId,
        conversationId,
        mode: "autopilot",
        prompt: questionPrompt,
        choices: ["Option A", "Option B", "Option C", "Option D"],
        allowFreeform: false,
        context: {
          source: "playwright-e2e",
          rationale: "Verifying relay question dialog rendering and answer flow.",
        },
      },
    });
    expect(created.ok()).toBeTruthy();
    const createdBody = await created.json();
    questionId = String(createdBody?.question?.id || "");
    expect(questionId).toBeTruthy();

    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");

    const pendingBanner = page.locator("#pending-question-banner");
    await expect(pendingBanner).toBeVisible();
    await pendingBanner.click();

    const questionCard = page.locator(".relay-question-container", { hasText: questionPrompt });
    await expect(questionCard).toBeVisible();
    await expect(questionCard.getByRole("button", { name: "Option A" })).toBeVisible();

    await questionCard.getByRole("button", { name: "Option A" }).click();
    // After answering, the card disappears (only pending questions are shown as cards).
    // The transient notice "Answer received" is shown briefly.
    // Verify the answer was recorded via the API.
    await expect(questionCard).not.toBeVisible({ timeout: 10000 });

    const questionState = await request.get(`/api/relay-question/${questionId}`, { headers });
    expect(questionState.ok()).toBeTruthy();
    const stateBody = await questionState.json();
    expect(String(stateBody?.question?.status || "")).toBe("answered");
    expect(String(stateBody?.question?.answer || "")).toBe("Option A");
  } finally {
    if (messageId && conversationId) {
      await request.post("/api/response", {
        headers,
        data: {
          messageId,
          conversationId,
          text: "playwright cleanup",
          model: "gpt-5.4-mini",
          reasoningEffort: "high",
          mode: "autopilot",
        },
      }).catch(() => {});
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});

test("shrinks image attachment frames to the rendered image width", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const imageDataUrl = makeInlineSvgDataUrl(320, 180, "#60a5fa");
  let conversationId = "";
  let messageId = "";

  try {
    const queued = await request.post("/api/message", {
      headers,
      data: {
        text: "",
        relayMode: "ask",
        model: "gpt-5.4-mini",
        attachments: [
          {
            name: "preview.svg",
            type: "image/svg+xml",
            dataUrl: imageDataUrl,
          },
        ],
      },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    expect(conversationId).toBeTruthy();
    expect(messageId).toBeTruthy();

    await page.addInitScript((id) => {
      localStorage.setItem("copilot_last_conv", id);
    }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");

    const message = page.locator(`.msg[data-message-id="${messageId}"]`);
    await expect(message).toBeVisible();

    const attachment = message.locator(".msg-attachment-image");
    const image = attachment.locator("img");
    await expect(attachment).toBeVisible();
    await expect(image).toBeVisible();

    const [attachmentBox, imageBox] = await Promise.all([
      attachment.boundingBox(),
      image.boundingBox(),
    ]);
    expect(attachmentBox).not.toBeNull();
    expect(imageBox).not.toBeNull();
    expect(attachmentBox.width).toBeLessThanOrEqual(imageBox.width + 48);
  } finally {
    if (conversationId) {
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});

test("serves workspace files and blocks unsafe paths", async ({ request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };

  const unauthorized = await request.get("/api/files/README.md");
  expect(unauthorized.status()).toBe(401);

  const authorized = await request.get("/api/files/README.md", { headers });
  expect(authorized.ok()).toBeTruthy();
  expect(String(authorized.headers()["content-type"] || "")).toContain("text/markdown");
  expect(await authorized.text()).toContain("Copilot");

  const viaTokenQuery = await request.get(`/api/files/server/server.js?token=${encodeURIComponent(token)}`);
  expect(viaTokenQuery.ok()).toBeTruthy();

  const previewReadme = await request.get("/api/files-preview/README.md", { headers });
  expect(previewReadme.ok()).toBeTruthy();
  const previewBody = await previewReadme.json();
  expect(String(previewBody?.kind || "")).toBe("markdown");
  expect(String(previewBody?.path || "")).toBe("README.md");
  expect(String(previewBody?.content || "")).toContain("Copilot");

  const traversal = await request.get("/api/files/%2E%2E%2Fpackage.json", { headers });
  expect(traversal.status()).toBe(400);

  const nonFile = await request.get("/api/files/server", { headers });
  expect(nonFile.status()).toBe(400);
});

test("does not retarget workspace root from chat cd commands", async ({ request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  let conversationId = "";
  let messageId = "";

  try {
    const beforeStatus = await request.get("/api/status", { headers });
    expect(beforeStatus.ok()).toBeTruthy();
    const beforeBody = await beforeStatus.json();
    const beforeRootPath = String(beforeBody?.workspaceRootPath || "");
    expect(beforeRootPath).toBeTruthy();

    const queued = await request.post("/api/message", {
      headers,
      data: {
        text: "cd X:\\system",
        relayMode: "ask",
        model: "gpt-5.4-mini",
      },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    expect(queuedBody?.workspaceRootChanged).toBeFalsy();
    expect(String(queuedBody?.workspaceRootPath || "")).toBe(beforeRootPath);
    expect(String(queuedBody?.workspaceRootWarning || "")).toContain("locked to startup directory");

    const afterStatus = await request.get("/api/status", { headers });
    expect(afterStatus.ok()).toBeTruthy();
    const afterBody = await afterStatus.json();
    expect(String(afterBody?.workspaceRootPath || "")).toBe(beforeRootPath);
  } finally {
    if (messageId && conversationId) {
      await request.post("/api/response", {
        headers,
        data: {
          messageId,
          conversationId,
          text: "playwright cleanup",
          model: "gpt-5.4-mini",
          mode: "ask",
        },
      }).catch(() => {});
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});

test("bridges web delete requests to SDK session delete queue", async ({ request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const sdkSessionId = `playwright-sdk-delete-${stamp}`;
  let conversationId = "";
  let messageId = "";
  let relayPaused = false;

  try {
    const queued = await request.post("/api/message", {
      headers,
      data: {
        text: `sdk-delete-bridge-seed-${stamp}`,
        relayMode: "autopilot",
        model: "gpt-5.4-mini",
      },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    expect(conversationId).toBeTruthy();
    expect(messageId).toBeTruthy();

    const synced = await request.post("/api/session-sync", {
      headers,
      data: {
        sdk_session_id: sdkSessionId,
        conversation_id: conversationId,
      },
    });
    expect(synced.ok()).toBeTruthy();

    const paused = await request.post("/api/relay/pause", { headers });
    expect(paused.ok()).toBeTruthy();
    relayPaused = true;
    await sleep(2500);

    const deleted = await request.delete(`/api/conversation/${conversationId}`, { headers });
    expect(deleted.ok()).toBeTruthy();
    const deletedBody = await deleted.json();
    expect(Boolean(deletedBody?.ok)).toBeTruthy();

    const pendingRow = readSdkDeleteRequest(sdkSessionId);
    expect(String(pendingRow?.sdk_session_id || "")).toBe(sdkSessionId);
    expect(String(pendingRow?.conversation_id || "")).toBe(conversationId);

    const completed = await request.post("/api/sdk-session-delete/result", {
      headers,
      data: {
        sdk_session_id: sdkSessionId,
        ok: true,
      },
    });
    expect(completed.ok()).toBeTruthy();

    const missingConversation = await request.get(`/api/conversation/${conversationId}`, { headers });
    expect(missingConversation.status()).toBe(404);
  } finally {
    if (relayPaused) {
      await request.post("/api/relay/resume", { headers }).catch(() => {});
    }
    if (conversationId) {
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
    await request.post("/api/sdk-session-delete/result", {
      headers,
      data: {
        sdk_session_id: sdkSessionId,
        ok: true,
      },
    }).catch(() => {});
  }
});

test("linkifies workspace file mentions in assistant messages and question cards", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const seedText = `File-link test seed ${stamp}`;
  const absoluteRespawnPath = `${process.cwd()}\\server\\respawn.bat`;
  const prompt = `Can you open README.md and ${absoluteRespawnPath}?`;
  const responseText = `Please read README.md, then inspect ${absoluteRespawnPath}.`;
  let conversationId = "";
  let messageId = "";

  try {
    const queued = await request.post("/api/message", {
      headers,
      data: {
        text: seedText,
        relayMode: "autopilot",
        model: "gpt-5.4-mini",
      },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    expect(conversationId).toBeTruthy();
    expect(messageId).toBeTruthy();

    const dequeuedBody = await dequeueSpecificMessage(request, headers, messageId);
    expect(String(dequeuedBody?.message?.id || "")).toBe(messageId);

    const createdQuestion = await request.post("/api/relay-question", {
      headers,
      data: {
        queueId: messageId,
        messageId,
        conversationId,
        mode: "autopilot",
        prompt,
        choices: ["Done"],
        allowFreeform: false,
      },
    });
    expect(createdQuestion.ok()).toBeTruthy();

    const responded = await request.post("/api/response", {
      headers,
      data: {
        messageId,
        conversationId,
        text: responseText,
        model: "gpt-5.4-mini",
        mode: "autopilot",
      },
    });
    expect(responded.ok()).toBeTruthy();

    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await page.evaluate(async (id) => {
      await window.openConversation(id);
    }, conversationId);

    const assistantReadmeLink = page.locator(".msg.assistant .msg-bubble a", { hasText: "README.md" }).first();
    await expect(assistantReadmeLink).toBeVisible();
    await expect(assistantReadmeLink).toHaveAttribute("href", /\/api\/files\/README\.md$/);
    await expect(assistantReadmeLink).toHaveAttribute("target", "_blank");

    const assistantRespawnLink = page.locator(".msg.assistant .msg-bubble a", { hasText: "respawn.bat" }).first();
    await expect(assistantRespawnLink).toBeVisible();
    await expect(assistantRespawnLink).toHaveAttribute("href", /\/api\/files\/server\/respawn\.bat$/);
    await expect(assistantRespawnLink).not.toHaveAttribute("href", /\/api\/files\/git\/copilot\/server\/respawn\.bat$/);

    const questionReadmeLink = page.locator(".relay-question-body a", { hasText: "README.md" }).first();
    await expect(questionReadmeLink).toBeVisible();
    await expect(questionReadmeLink).toHaveAttribute("href", /\/api\/files\/README\.md$/);
  } finally {
    if (messageId && conversationId) {
      await request.post("/api/response", {
        headers,
        data: {
          messageId,
          conversationId,
          text: "playwright cleanup",
          model: "gpt-5.4-mini",
          mode: "autopilot",
        },
      }).catch(() => {});
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});

test("renders fenced codeblocks in user messages", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const codeText = `Code fence test ${stamp}\n\n\`\`\`js\nconst answer = 42;\nconsole.log(answer);\n\`\`\``;
  let conversationId = "";
  let messageId = "";

  try {
    const queued = await request.post("/api/message", {
      headers,
      data: {
        text: codeText,
        relayMode: "ask",
        model: "gpt-5.4-mini",
      },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    expect(conversationId).toBeTruthy();
    expect(messageId).toBeTruthy();

    await page.addInitScript((id) => {
      localStorage.setItem("copilot_last_conv", id);
    }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");

    const message = page.locator(`.msg[data-message-id="${messageId}"]`);
    await expect(message).toBeVisible();

    const codeBlock = message.locator(".msg-bubble pre code");
    await expect(codeBlock).toBeVisible();
    await expect(codeBlock).toContainText("const answer = 42;");
    await expect(codeBlock).toContainText("console.log(answer);");
  } finally {
    if (conversationId) {
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});

test("renders a video preview viewer with preload and start time options", async ({ page }) => {
  const token = relayToken();
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");

  await page.evaluate(() => {
    window.openUploadedAttachmentViewer(
      "sample.webm",
      "data:video/webm;base64,AAAA",
      "video/webm",
      { startSeconds: 12.5, preload: "auto" },
    );
  });

  await expect(page.locator("#file-preview-modal")).toHaveClass(/visible/);
  await expect(page.locator("#file-preview-body")).toHaveClass(/video-preview-mode/);

  const video = page.locator(".file-preview-video");
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute("controls", "");
  await expect(video).toHaveAttribute("preload", "auto");
  await expect(page.locator(".file-preview-video-shell")).toHaveAttribute("data-start-seconds", "12.5");
});

test("renders user fenced codeblocks in mobile viewport with horizontal scroll", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const longJson = JSON.stringify({
    key: `mobile-codeblock-${stamp}-${"x".repeat(260)}`,
  });
  const codeText = `Mobile code fence test ${stamp}\n\n\`\`\`json\n${longJson}\n\`\`\``;
  let conversationId = "";
  let messageId = "";

  try {
    const queued = await request.post("/api/message", {
      headers,
      data: {
        text: codeText,
        relayMode: "ask",
        model: "gpt-5.4-mini",
      },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    expect(conversationId).toBeTruthy();
    expect(messageId).toBeTruthy();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((id) => {
      localStorage.setItem("copilot_last_conv", id);
    }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");

    const message = page.locator(`.msg[data-message-id="${messageId}"]`);
    await expect(message).toBeVisible();

    const codeBlock = message.locator(".msg-bubble pre code");
    await expect(codeBlock).toBeVisible();
    await expect(codeBlock).toContainText(`mobile-codeblock-${stamp}`);

    const preMetrics = await message.locator(".msg-bubble pre").evaluate((el) => ({
      whiteSpace: window.getComputedStyle(el).whiteSpace,
      overflowX: window.getComputedStyle(el).overflowX,
    }));
    expect(preMetrics.whiteSpace).toBe("pre");
    expect(preMetrics.overflowX).toBe("auto");
  } finally {
    if (conversationId) {
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});

test("keeps the active conversation visible when startup refreshes resolve late", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const seedText = `Delayed refresh seed ${stamp}`;
  const responseText = `Delayed refresh response ${stamp}`;
  let conversationId = "";
  let messageId = "";
  let conversationsFetchCount = 0;

  try {
    const queued = await request.post("/api/message", {
      headers,
      data: {
        text: seedText,
        relayMode: "autopilot",
        model: "gpt-5.4-mini",
      },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    expect(conversationId).toBeTruthy();
    expect(messageId).toBeTruthy();

    const responded = await request.post("/api/response", {
      headers,
      data: {
        messageId,
        conversationId,
        text: responseText,
        model: "gpt-5.4-mini",
        mode: "autopilot",
      },
    });
    expect(responded.ok()).toBeTruthy();

    await page.route("**/api/conversations", async (route) => {
      conversationsFetchCount += 1;
      if (conversationsFetchCount === 1) {
        await sleep(1200);
      }
      await route.continue();
    });

    await page.addInitScript((id) => {
      localStorage.setItem("copilot_last_conv", id);
    }, conversationId);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");

    await expect(page.locator(".msg.user .msg-bubble", { hasText: seedText })).toBeVisible();
    await expect(page.locator(".msg.assistant .msg-bubble", { hasText: responseText })).toBeVisible();
    await expect(page.locator(".empty-state")).toHaveCount(0);
  } finally {
    if (messageId && conversationId) {
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});

test("does not reuse the previous reply text in a new thinking bubble", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const firstSeed = `Thinking reset seed ${stamp}`;
  const secondSeed = `Thinking reset follow-up ${stamp}`;
  let conversationId = "";
  let relayPaused = false;

  try {
    await page.addInitScript(() => {
      localStorage.removeItem("copilot_last_conv");
    });
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await page.fill("#msg-input", firstSeed);
    await page.click("#send-btn");
    await expect(page.locator(".msg.assistant .msg-bubble")).toBeVisible({ timeout: 30000 });
    conversationId = String(await page.evaluate(() => localStorage.getItem("copilot_last_conv") || "") || "").trim();

    const firstAssistantBubble = page.locator(".msg.assistant .msg-bubble").last();
    const previousReplyText = String(await firstAssistantBubble.textContent() || "").trim();
    expect(previousReplyText).toBeTruthy();

    const paused = await request.post("/api/relay/pause", { headers });
    expect(paused.ok()).toBeTruthy();
    relayPaused = true;

    await page.fill("#msg-input", secondSeed);
    await page.click("#send-btn");
    await expect(page.locator("#thinking-indicator")).toBeVisible();
    await expect(page.locator("#thinking-indicator .thinking-text")).not.toContainText(previousReplyText);

  } finally {
    if (relayPaused) {
      await request.post("/api/relay/resume", { headers }).catch(() => {});
    }
    if (conversationId) {
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});

test("shows Copilot usage from the usage modal", async ({ page }) => {
  const token = relayToken();
  let usageRequests = 0;

  await page.route("**/api/usage", async (route) => {
    usageRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        resetDate: "2026-06-01",
        chat: { unlimited: false, remaining: 12, entitlement: 20 },
        premiumInteractions: { remaining: 3, entitlement: 1500, percentRemaining: 0.2 },
      }),
    });
  });

  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");

  await page.click("#chat-actions-menu-btn");
  await expect(page.locator("#chat-actions-menu")).toBeVisible();
  await page.click("#chat-menu-usage");
  await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
  await expect(page.locator("#summary-modal-title")).toHaveText("Copilot Usage");
  await expect(page.locator("#summary-modal-subtitle")).toHaveText("Resets 2026-06-01");
  await expect(page.locator("#summary-modal-body")).toContainText("12 remaining");
  await expect(page.locator("#chat-menu-usage")).toContainText("Check Usage");
  expect(usageRequests).toBe(1);
});

test("shows a compact CWD picker menu for long known CWD lists", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const seedText = `cwd-menu-seed-${stamp}`;
  const manualPath = `C:\\manual\\workspace-${stamp}`;
  let conversationId = "";
  let messageId = "";
  let postedRootPath = "";

  try {
    const queued = await request.post("/api/message", {
      headers,
      data: {
        text: seedText,
        relayMode: "ask",
        model: "gpt-5.4-mini",
      },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    expect(conversationId).toBeTruthy();
    expect(messageId).toBeTruthy();

    const recentRoots = Array.from({ length: 20 }, (_, index) => `C:\\workspaces\\recent-${String(index + 1).padStart(2, "0")}`);
    await page.route("**/api/status", async (route) => {
      const response = await route.fetch();
      if (!response.ok()) {
        await route.fulfill({ response });
        return;
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        await route.fulfill({ response });
        return;
      }
      body.recentWorkspaceRoots = recentRoots;
      await route.fulfill({
        response,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

    await page.addInitScript((id) => {
      localStorage.setItem("copilot_last_conv", id);
    }, conversationId);
    await page.route("**/api/conversation/*/workspace-root", async (route) => {
      const payload = route.request().postDataJSON();
      postedRootPath = String(payload?.rootPath || "").trim();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          conversationId,
          configuredWorkspaceRootPath: postedRootPath,
          configuredWorkspaceRootName: path.basename(postedRootPath),
          currentWorkspaceRootPath: `C:\\workspaces\\current-${stamp}`,
          currentWorkspaceRootName: `current-${stamp}`,
          recentWorkspaceRoots: [postedRootPath, ...recentRoots],
        }),
      });
    });
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");

    await page.click("#chat-actions-menu-btn");
    await page.click("#chat-menu-change-cwd");
    await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
    await expect(page.locator("#summary-modal-title")).toHaveText("Change CWD");
    await expect(page.locator("#change-cwd-manual-path")).toHaveAttribute("placeholder", "Manual path");
    await expect(page.locator("#change-cwd-manual-path")).toHaveValue("");
    // No settling delay: the picker binds synchronously, so the trigger must
    // work on the first frame (there used to be a 350ms dead window here).
    const trigger = page.locator("#change-cwd-menu-trigger");
    const menu = page.locator("#change-cwd-menu");
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(menu).toBeVisible();

    const optionItems = page.locator("#change-cwd-menu .change-cwd-menu-item");
    await expect.poll(async () => optionItems.count()).toBeGreaterThanOrEqual(20);
    const menuDimensions = await menu.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    }));
    expect(menuDimensions.scrollHeight).toBeGreaterThan(menuDimensions.clientHeight);

    const pickedOption = optionItems.nth(12);
    const pickedPath = String(await pickedOption.getAttribute("data-path") || "").trim();
    expect(pickedPath).toContain("recent-");
    await pickedOption.click();

    await expect(menu).toBeHidden();
    await expect(page.locator("#change-cwd-selected-path")).toHaveValue(pickedPath);
    await expect(trigger).toHaveAttribute("title", pickedPath);
    await expect(page.locator("#change-cwd-details")).toContainText(pickedPath);
    await expect(page.locator("button.summary-btn", { hasText: "Save next-launch CWD" })).toBeVisible();
    await page.locator("#change-cwd-manual-path").fill(` ${manualPath} `);
    await expect(page.locator("#change-cwd-details")).toContainText(manualPath);
    await page.locator("button.summary-btn", { hasText: "Save next-launch CWD" }).click();
    await expect(page.locator("#summary-modal")).not.toHaveClass(/visible/);
    expect(postedRootPath).toBe(manualPath);

    await page.click("#chat-actions-menu-btn");
    await page.click("#chat-menu-change-cwd");
    await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
    await trigger.click();
    await expect(menu).toBeVisible();
  } finally {
    if (messageId && conversationId) {
      await request.post("/api/response", {
        headers,
        data: {
          messageId,
          conversationId,
          text: "playwright cleanup",
          model: "gpt-5.4-mini",
          mode: "ask",
        },
      }).catch(() => {});
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});

test("shows current context from the context button", async ({ page }) => {
  const token = relayToken();
  let contextRequests = 0;
  let refreshResolvedByCopilotSession = false;

  await page.route("**/api/context**", async (route) => {
    contextRequests += 1;
    const url = route.request().url();
    if (contextRequests > 1 && /\/api\/context\/context-copilot-session\b/.test(url)) {
      refreshResolvedByCopilotSession = true;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        conversationId: null,
        runtimeSessionId: "context-runtime-session",
        copilotSessionId: "context-copilot-session",
        snapshot: {
          used_percent: 42,
          used_total_tokens: 42000,
          max_context_tokens: 100000,
        },
        eventsPath: "/tmp/session-state/events.jsonl",
        error: null,
        text: "Current Context\nPrompt/Input: 42,000 tokens\nCompletion/Output: 8,000 tokens",
      }),
    });
  });

  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");

  await page.click("#context-btn");
  await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
  await expect(page.locator("#summary-modal-title")).toHaveText("Current Context");
  await expect(page.locator("#summary-modal-subtitle")).toHaveText("Copilot session context-");
  await expect(page.locator("#summary-modal-body")).toContainText("Prompt/Input: 42,000 tokens");
  await expect(page.locator("#summary-modal-body")).not.toContainText("```text");
  await page.click("#summary-modal-refresh");
  await expect.poll(() => contextRequests).toBeGreaterThanOrEqual(2);
  expect(refreshResolvedByCopilotSession).toBeTruthy();
  await expect(page.locator("#context-btn")).toHaveText("🧠");
  expect(contextRequests).toBeGreaterThanOrEqual(2);
});

test("updates the input context bar after assistant turns", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  let conversationId = "";
  let messageId = "";
  let contextRequests = 0;

  try {
    const queued = await request.post("/api/message", {
      headers,
      data: {
        text: `context-bar-seed-${stamp}`,
        relayMode: "autopilot",
        model: "gpt-5.4-mini",
      },
    });
    expect(queued.ok()).toBeTruthy();
    const queuedBody = await queued.json();
    conversationId = String(queuedBody?.conversationId || "");
    messageId = String(queuedBody?.messageId || "");
    expect(conversationId).toBeTruthy();
    expect(messageId).toBeTruthy();

    await page.route("**/api/context/**", async (route) => {
      const url = route.request().url();
      if (!url.includes(`/api/context/${conversationId}`)) {
        await route.continue();
        return;
      }
      contextRequests += 1;
      const usedPercent = contextRequests === 1 ? 20 : 90;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          conversationId,
          runtimeSessionId: "context-bar-runtime",
          snapshot: {
            used_percent: usedPercent,
            used_total_tokens: usedPercent * 1000,
            max_context_tokens: 256000,
          },
          eventsPath: null,
          error: null,
          text: "",
        }),
      });
    });

    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await page.evaluate(async (id) => {
      await window.openConversation(id);
    }, conversationId);

    await page.waitForFunction(() => {
      const ratio = Number(document.getElementById("input-area")?.dataset.contextUsageRatio || "0");
      return ratio >= 0.19 && ratio <= 0.21;
    });
    const topBarStyle = await page.evaluate(() => {
      const style = getComputedStyle(document.getElementById("input-area"), "::before");
      return {
        height: style.height,
        backgroundImage: style.backgroundImage,
        boxShadow: style.boxShadow,
      };
    });
    expect(topBarStyle.height).toBe("1px");
    expect(topBarStyle.backgroundImage).toContain("gradient");
    expect(topBarStyle.boxShadow).not.toBe("none");

    const responded = await request.post("/api/response", {
      headers,
      data: {
        messageId,
        conversationId,
        text: "context bar update check",
        model: "gpt-5.4-mini",
        mode: "autopilot",
      },
    });
    expect(responded.ok()).toBeTruthy();

    await page.waitForFunction(() => {
      const ratio = Number(document.getElementById("input-area")?.dataset.contextUsageRatio || "0");
      return ratio >= 0.89;
    });
    expect(contextRequests).toBeGreaterThanOrEqual(2);
  } finally {
    if (messageId && conversationId) {
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});

test("binds install listener before auth flow", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => window.__installButtonBound === true);
});

test("hides install/fullscreen controls in installed app mode", async ({ page }) => {
  const token = relayToken();

  await page.addInitScript(() => {
    window.__fullscreenCalls = 0;
    const originalMatchMedia = window.matchMedia.bind(window);
    function fakeMedia(query, matches) {
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() { return false; },
      };
    }
    window.matchMedia = (query) => {
      if (query === "(display-mode: standalone)") return fakeMedia(query, true);
      if (query === "(display-mode: fullscreen)") return fakeMedia(query, false);
      return originalMatchMedia(query);
    };
    Element.prototype.requestFullscreen = function requestFullscreen() {
      window.__fullscreenCalls += 1;
      return Promise.reject(new Error("blocked"));
    };
  });

  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");

  await expect(page.locator("#install-btn")).toBeHidden();
  await expect(page.locator("#fullscreen-btn")).toBeHidden();

  await page.click("#chat-title");
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => Number(window.__fullscreenCalls || 0))).toBe(0);
});

test("uses integrated mobile explorer/upload controls beside mode/model rows", async ({ page }) => {
  const token = relayToken();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");

  const explorerBtn = page.locator("#repo-browser-input-btn");
  const modeSelect = page.locator("#mode-select");
  const uploadBtn = page.locator("#attach-btn");
  const modelSelect = page.locator("#model-select");
  const attachmentPreview = page.locator("#attachment-preview");

  await expect(explorerBtn).toBeVisible();
  await expect(page.locator("#repo-browser-fab")).toBeHidden();
  await expect(attachmentPreview).toBeHidden();

  const explorerBox = await explorerBtn.boundingBox();
  const modeBox = await modeSelect.boundingBox();
  const uploadBox = await uploadBtn.boundingBox();
  const modelBox = await modelSelect.boundingBox();
  expect(explorerBox).toBeTruthy();
  expect(modeBox).toBeTruthy();
  expect(uploadBox).toBeTruthy();
  expect(modelBox).toBeTruthy();

  expect(Math.abs(explorerBox.y - modeBox.y)).toBeLessThan(6);
  expect(explorerBox.x).toBeLessThan(modeBox.x);
  expect(Math.abs(uploadBox.y - modelBox.y)).toBeLessThan(6);
  expect(uploadBox.x).toBeLessThan(modelBox.x);

  await explorerBtn.click();
  await expect(page.locator("#repo-browser-modal")).toHaveClass(/visible/);
});

test("mobile send blurs composer and keeps newest message in view", async ({ page }) => {
  const token = relayToken();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");

  await page.route("**/api/message", async (route) => {
    const payload = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        messageId: String(payload.messageId || "mobile-send-msg"),
        conversationId: String(payload.conversationId || "mobile-send-conv"),
        runtimeSessionId: "mobile-send-runtime",
      }),
    });
  });

  await page.evaluate(() => {
    const box = document.getElementById("messages");
    for (let i = 0; i < 35; i += 1) {
      window.appendMessage(
        {
          role: "assistant",
          text: `history seed ${i}`,
          model: "gpt-5.4-mini",
          mode: "agent",
          timestamp: new Date().toISOString(),
          attachments: [],
        },
        false,
        `seed-${i}`,
        true,
      );
    }
    box.scrollTop = 0;
  });

  const input = page.locator("#msg-input");
  await input.click();
  await input.fill("Scroll and blur check");
  await expect(input).toBeFocused();

  await page.click("#send-btn");

  await page.waitForFunction(() => !document.body.classList.contains("keyboard-open"));
  await page.waitForFunction(() => document.activeElement?.id !== "msg-input");
  await expect(page.locator(".msg.user .msg-bubble", { hasText: "Scroll and blur check" })).toBeVisible();

  const atBottom = await page.evaluate(() => {
    const box = document.getElementById("messages");
    return box.scrollTop + box.clientHeight >= box.scrollHeight - 12;
  });
  expect(atBottom).toBeTruthy();
});

test("mobile chat title exposes and copies the sdk session id", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const seedText = `session-title-copy-${stamp}`;
  const sdkSessionId = `session-title-sdk-${stamp}`;
  let conversationId = "";
  let messageId = "";

  try {
    const queued = await request.post("/api/message", {
      headers,
      data: {
        text: seedText,
        relayMode: "autopilot",
        model: "gpt-5.4-mini",
      },
    });
    expect(queued.ok()).toBeTruthy();
    const body = await queued.json();
    conversationId = String(body?.conversationId || "");
    messageId = String(body?.messageId || "");
    const synced = await request.post("/api/session-sync", {
      headers,
      data: {
        sdk_session_id: sdkSessionId,
        conversation_id: conversationId,
      },
    });
    expect(synced.ok()).toBeTruthy();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => {
      window.__copiedSessionId = "";
      const clipboard = navigator.clipboard || {};
      clipboard.writeText = async (value) => {
        window.__copiedSessionId = String(value || "");
      };
      Object.defineProperty(navigator, "clipboard", {
        value: clipboard,
        configurable: true,
      });
    });
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(async (id) => {
      await window.openConversation(id);
    }, conversationId);

    const title = page.locator("#chat-title");

    await expect(title).toHaveAttribute("data-copilot-session-id", sdkSessionId);
    await title.evaluate((el) => el.click());
    await expect.poll(async () => page.evaluate(() => window.__copiedSessionId || "")).toBe(sdkSessionId);
  } finally {
    if (messageId && conversationId) {
      await request.post("/api/response", {
        headers,
        data: {
          messageId,
          conversationId,
          text: "playwright cleanup",
          model: "gpt-5.4-mini",
          mode: "autopilot",
        },
      }).catch(() => {});
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});

test("mobile conversation switch does not refocus composer", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const stamp = Date.now();
  const seedA = `focus-switch-a-${stamp}`;
  const seedB = `focus-switch-b-${stamp}`;
  let convA = "";
  let convB = "";
  let msgA = "";
  let msgB = "";

  try {
    const first = await request.post("/api/message", {
      headers,
      data: { text: seedA, relayMode: "autopilot", model: "gpt-5.4-mini" },
    });

    expect(first.ok()).toBeTruthy();
    const firstBody = await first.json();
    convA = String(firstBody?.conversationId || "");
    msgA = String(firstBody?.messageId || "");

    const second = await request.post("/api/message", {
      headers,
      data: { text: seedB, relayMode: "autopilot", model: "gpt-5.4-mini" },
    });
    expect(second.ok()).toBeTruthy();
    const secondBody = await second.json();
    convB = String(secondBody?.conversationId || "");
    msgB = String(secondBody?.messageId || "");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");

    await page.click("#sidebar-toggle");
    await page.locator(".conv-item", { hasText: seedA }).first().click();
    await page.click("#sidebar-toggle");
    await page.locator(".conv-item", { hasText: seedB }).first().click();

    await page.waitForFunction(() => document.activeElement?.id !== "msg-input");
    const keyboardOpen = await page.evaluate(() => document.body.classList.contains("keyboard-open"));
    expect(keyboardOpen).toBeFalsy();
  } finally {
    const finalize = async (conversationId, messageId) => {
      if (!conversationId || !messageId) return;
      await request.post("/api/response", {
        headers,
        data: {
          messageId,
          conversationId,
          text: "playwright cleanup",
          model: "gpt-5.4-mini",
          mode: "autopilot",
        },
      }).catch(() => {});
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    };
    await finalize(convA, msgA);
    await finalize(convB, msgB);
  }
});

test("chat title color matches active conversation list color", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const seedText = `title-color-sync-${Date.now()}`;
  let conversationId = "";
  let messageId = "";

  try {
    const queued = await request.post("/api/message", {
      headers,
      data: {
        text: seedText,
        relayMode: "autopilot",
        model: "gpt-5.4-mini",
      },
    });
    expect(queued.ok()).toBeTruthy();
    const payload = await queued.json();
    conversationId = String(payload?.conversationId || "");
    messageId = String(payload?.messageId || "");

    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(async (id) => {
      await window.openConversation(id);
    }, conversationId);
    await expect(page.locator(".conv-item.active .conv-title")).toHaveCount(1);

    const colors = await page.evaluate(() => {
      const listTitle = document.querySelector(".conv-item.active .conv-title");
      const chatTitle = document.getElementById("chat-title");
      if (!listTitle || !chatTitle) return null;
      return {
        list: getComputedStyle(listTitle).color,
        chat: getComputedStyle(chatTitle).color,
      };
    });
    expect(colors).toBeTruthy();
    expect(colors.chat).toBe(colors.list);
  } finally {
    if (messageId && conversationId) {
      await request.post("/api/response", {
        headers,
        data: {
          messageId,
          conversationId,
          text: "playwright cleanup",
          model: "gpt-5.4-mini",
          mode: "autopilot",
        },
      }).catch(() => {});
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});

test("supports drives explorer root and drive file preview API", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };

  const drivesRootsRes = await request.get("/api/drives/roots", { headers });
  expect(drivesRootsRes.ok()).toBeTruthy();
  const drivesRootsBody = await drivesRootsRes.json();
  const drives = Array.isArray(drivesRootsBody?.root?.children) ? drivesRootsBody.root.children : [];
  expect(drives.length).toBeGreaterThan(0);

  const drivePath = String(drives[0]?.path || "");
  expect(drivePath).toMatch(/^[A-Za-z]:$/);

  const readmeDrivePath = `${process.cwd().replace(/\\/g, "/")}/README.md`;
  const drivePreviewRes = await request.get(`/api/drives/files-preview?path=${encodeURIComponent(readmeDrivePath)}`, { headers });
  expect(drivePreviewRes.ok()).toBeTruthy();
  const drivePreviewBody = await drivePreviewRes.json();
  expect(String(drivePreviewBody?.name || "")).toBe("README.md");
  expect(String(drivePreviewBody?.path || "")).toContain("/README.md");
  expect(String(drivePreviewBody?.rawUrl || "")).toContain("/api/drives/file?path=");

  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");
  await openRepoBrowserFromComposer(page);
  await page.click("#repo-root-drives-btn");

  await expect(page.locator("#repo-root-drives-btn")).toHaveClass(/active/);
  await expect(page.locator("#repo-toggle-heavy-btn")).toBeDisabled();
  await expect(page.locator("#repo-toggle-hidden-btn")).toContainText("Hidden/System");
  await expect(page.locator("#repo-tree")).toContainText(drivePath);
});

test("opens folder when clicking a tree node", async ({ page }) => {
  const token = relayToken();
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");
  await openRepoBrowserFromComposer(page);

  const firstDir = page.locator('#repo-tree .repo-tree-summary[data-repo-open-dir]:not([data-repo-open-dir=""])').first();
  await expect(firstDir).toBeVisible();
  const dirPath = String(await firstDir.getAttribute("data-repo-open-dir") || "");
  expect(dirPath).toBeTruthy();

  await firstDir.click();

  const selectedLeaf = dirPath.split("/").filter(Boolean).pop() || dirPath;
  await expect(page.locator("#repo-folder-breadcrumb")).toContainText(selectedLeaf);
  await expect(page.locator(`#repo-tree details.repo-tree-node[data-repo-dir-path="${dirPath}"]`)).toHaveJSProperty("open", true);
});

test("keeps previously expanded tree branches open", async ({ page }) => {
  const token = relayToken();
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");
  await openRepoBrowserFromComposer(page);
  await page.waitForSelector('#repo-tree .repo-tree-summary[data-repo-open-dir]:not([data-repo-open-dir=""])', { timeout: 15000 });

  const topDirs = page.locator('#repo-tree .repo-tree-summary[data-repo-open-dir]:not([data-repo-open-dir=""])');
  const topDirCount = await topDirs.count();
  expect(topDirCount).toBeGreaterThanOrEqual(2);
  const firstDirPath = String(await topDirs.nth(0).getAttribute("data-repo-open-dir") || "");
  const secondDirPath = String(await topDirs.nth(1).getAttribute("data-repo-open-dir") || "");
  expect(firstDirPath).toBeTruthy();
  expect(secondDirPath).toBeTruthy();

  await topDirs.nth(0).click();
  await topDirs.nth(1).click();

  await expect(page.locator(`#repo-tree details.repo-tree-node[data-repo-dir-path="${firstDirPath}"]`)).toHaveJSProperty("open", true);
  await expect(page.locator(`#repo-tree details.repo-tree-node[data-repo-dir-path="${secondDirPath}"]`)).toHaveJSProperty("open", true);
});

test("copies folder and file reference tokens from explorer and preview", async ({ page, context }) => {
  const token = relayToken();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: relayOrigin() });
  await page.goto(`/?token=${encodeURIComponent(token)}`);
  await page.waitForLoadState("networkidle");
  await openRepoBrowserFromComposer(page);

  const serverDir = page.locator('#repo-tree .repo-tree-summary[data-repo-open-dir="server"]').first();
  await expect(serverDir).toBeVisible();
  await serverDir.click();

  const publicDir = page.locator('#repo-folder [data-repo-nav-dir="server/public"]').first();
  await expect(publicDir).toBeVisible();
  await publicDir.click();

  let fileView = page.locator('#repo-folder [data-repo-open-file]').first();
  await expect(fileView).toBeVisible();

  const copyFolderBtn = page.locator('#repo-folder-breadcrumb [data-repo-copy-folder]').first();
  await expect(copyFolderBtn).toBeVisible();
  const copiedFolderPath = String(await copyFolderBtn.getAttribute("data-repo-copy-folder") || "");
  await copyFolderBtn.click();
  const folderToken = await page.evaluate(() => navigator.clipboard.readText());
  expect(folderToken).toBe(`\`@folder:${copiedFolderPath}\``);

  await expect(fileView).toBeVisible();
  await fileView.click();
  await expect(page.locator("#file-preview-modal")).toHaveClass(/visible/);
  const fileTitle = page.locator("#file-preview-title");
  const rawToken = String(await fileTitle.getAttribute("data-copy-reference") || "");
  expect(rawToken.startsWith("@file:")).toBeTruthy();
  await fileTitle.click();
  const fileToken = await page.evaluate(() => navigator.clipboard.readText());
  expect(fileToken).toBe(`\`${rawToken}\``);
});

test("keeps non-image @file references as text-only pending turns", async ({ request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };

  async function finalizePending(conversationId, messageId) {
    await request.post("/api/response", {
      headers,
      data: {
        messageId,
        conversationId,
        text: "playwright cleanup",
        model: "gpt-5.4-mini",
        mode: "autopilot",
      },
    }).catch(() => {});
    await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
  }

  const textRef = await request.post("/api/message", {
    headers,
    data: {
      text: "Please inspect `@file:README.md`",
      relayMode: "autopilot",
      model: "gpt-5.4-mini",
    },
  });
  expect(textRef.ok()).toBeTruthy();
  const textBody = await textRef.json();
  const textPendingBody = await dequeueSpecificMessage(request, headers, String(textBody?.messageId || ""));
  expect(String(textPendingBody?.message?.id || "")).toBe(String(textBody?.messageId || ""));
  expect(Array.isArray(textPendingBody?.message?.attachments) ? textPendingBody.message.attachments.length : 0).toBe(0);
  await finalizePending(String(textBody?.conversationId || ""), String(textBody?.messageId || ""));
});

test("restores the current message scroll position after a browser reload", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const seedText = buildLongText("Reload scroll seed");
  const responseText = buildLongText("Reload scroll response");
  let conversationId = "";
  let messageId = "";

  try {
    const created = await request.post("/api/message", {
      headers,
      data: {
        text: seedText,
        relayMode: "autopilot",
        model: "gpt-5.4-mini",
      },
    });
    expect(created.ok()).toBeTruthy();
    const createdBody = await created.json();
    conversationId = String(createdBody?.conversationId || "").trim();
    messageId = String(createdBody?.messageId || "").trim();
    expect(conversationId).toBeTruthy();
    expect(messageId).toBeTruthy();

    const responded = await request.post("/api/response", {
      headers,
      data: {
        messageId,
        conversationId,
        text: responseText,
        model: "gpt-5.4-mini",
        mode: "autopilot",
      },
    });
    expect(responded.ok()).toBeTruthy();

    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await page.evaluate(async (id) => {
      await window.openConversation(id);
    }, conversationId);

    const messages = page.locator("#messages");
    await expect(messages.locator(".msg").first()).toBeVisible();
    await page.waitForFunction(() => {
      const el = document.getElementById("messages");
      return !!el && (el.scrollHeight > el.clientHeight + 200);
    });

    const initialScrollTop = await messages.evaluate((el) => {
      const available = Math.max(0, el.scrollHeight - el.clientHeight);
      return Math.max(0, Math.floor(available / 2));
    });
    await messages.evaluate((el, target) => {
      el.scrollTop = target;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, initialScrollTop);
    await page.waitForFunction((target) => {
      const el = document.getElementById("messages");
      return !!el && Math.abs(el.scrollTop - target) < 25;
    }, initialScrollTop);

    await page.waitForTimeout(250);
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => document.querySelector("#messages .msg") !== null);

    const restoredScrollTop = await messages.evaluate((el) => el.scrollTop);
    expect(Math.abs(restoredScrollTop - initialScrollTop)).toBeLessThan(25);
    expect(restoredScrollTop).toBeGreaterThan(0);
  } finally {
    if (conversationId) {
      await request.delete(`/api/conversation/${conversationId}`, { headers }).catch(() => {});
    }
  }
});

test("restores message scroll when switching back to a conversation", async ({ page, request }) => {
  const token = relayToken();
  const headers = { Authorization: `Bearer ${token}` };
  const firstSeed = buildLongText("Switch-back seed one");
  const firstResponse = buildLongText("Switch-back response one");
  const secondSeed = "Switch-back seed two";
  const secondResponse = "Switch-back response two";
  let firstConversationId = "";
  let firstMessageId = "";
  let secondConversationId = "";
  let secondMessageId = "";

  try {
    const first = await request.post("/api/message", {
      headers,
      data: {
        text: firstSeed,
        relayMode: "autopilot",
        model: "gpt-5.4-mini",
      },
    });
    expect(first.ok()).toBeTruthy();
    const firstBody = await first.json();
    firstConversationId = String(firstBody?.conversationId || "").trim();
    firstMessageId = String(firstBody?.messageId || "").trim();

    const firstReply = await request.post("/api/response", {
      headers,
      data: {
        messageId: firstMessageId,
        conversationId: firstConversationId,
        text: firstResponse,
        model: "gpt-5.4-mini",
        mode: "autopilot",
      },
    });
    expect(firstReply.ok()).toBeTruthy();

    const second = await request.post("/api/message", {
      headers,
      data: {
        text: secondSeed,
        relayMode: "autopilot",
        model: "gpt-5.4-mini",
      },
    });
    expect(second.ok()).toBeTruthy();
    const secondBody = await second.json();
    secondConversationId = String(secondBody?.conversationId || "").trim();
    secondMessageId = String(secondBody?.messageId || "").trim();

    const secondReply = await request.post("/api/response", {
      headers,
      data: {
        messageId: secondMessageId,
        conversationId: secondConversationId,
        text: secondResponse,
        model: "gpt-5.4-mini",
        mode: "autopilot",
      },
    });
    expect(secondReply.ok()).toBeTruthy();

    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await page.waitForFunction(() => typeof window.openConversation === "function");
    await page.evaluate(async (id) => {
      await window.openConversation(id);
    }, firstConversationId);

    const messages = page.locator("#messages");
    await expect(messages.locator(".msg").first()).toBeVisible();
    await page.waitForFunction(() => {
      const el = document.getElementById("messages");
      return !!el && (el.scrollHeight > el.clientHeight + 200);
    });

    const savedScrollTop = await messages.evaluate((el) => {
      const available = Math.max(0, el.scrollHeight - el.clientHeight);
      return Math.max(0, Math.floor(available / 2));
    });
    await messages.evaluate((el, target) => {
      el.scrollTop = target;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, savedScrollTop);
    await page.waitForFunction((target) => {
      const el = document.getElementById("messages");
      return !!el && Math.abs(el.scrollTop - target) < 25;
    }, savedScrollTop);

    await page.evaluate(async (id) => {
      await window.openConversation(id);
    }, secondConversationId);
    await page.evaluate(async (id) => {
      await window.openConversation(id);
    }, firstConversationId);

    const restoredScrollTop = await messages.evaluate((el) => el.scrollTop);
    expect(Math.abs(restoredScrollTop - savedScrollTop)).toBeLessThan(25);
  } finally {
    if (firstConversationId) {
      await request.delete(`/api/conversation/${firstConversationId}`, { headers }).catch(() => {});
    }
    if (secondConversationId) {
      await request.delete(`/api/conversation/${secondConversationId}`, { headers }).catch(() => {});
    }
  }
});
