import { expect, test } from "@playwright/test";
import { relayBaseUrl, relayToken } from "./e2e-env.mjs";
import { respondAsWorker, settleFakeWorkers, startConversation, attemptOf } from "./helpers/fake-worker.mjs";
import { localhostOrigin, signInByCode } from "./helpers/browser-signin.mjs";

// Page policy, Stage A (server/services/app-shell-csp.mjs): the app runs with
// nothing loaded from, or sent to, any origin but its own, at an IP address
// and at a host name alike. The page records every `securitypolicyviolation`
// event (and every console message the browser words as a policy refusal)
// from before its first script; the test fails on any.

test.afterAll(() => settleFakeWorkers());

const REMOTE_IMAGE = "https://tracker.example.test/pixel.png?leak=secret";

const MARKDOWN_REPLY = [
  "Here is the summary.",
  "",
  "```js",
  "const answer = items.map((item) => item.id).filter(Boolean);",
  "```",
  "",
  "Inline math $E = mc^2$ and a display:",
  "",
  "$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$",
  "",
  "Water is $\\ce{H2O}$ and $\\ce{2H2 + O2 -> 2H2O}$.",
  "",
  `![remote chart](${REMOTE_IMAGE})`,
].join("\n");

function relayOf() {
  const base = new URL(relayBaseUrl());
  return { baseUrl: base.origin, token: relayToken(), port: base.port };
}

async function installViolationRecorder(page) {
  const consoleRefusals = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/content security policy|violates the following|refused to (?:load|connect|apply|frame|execute)/i.test(text)) {
      consoleRefusals.push(text.slice(0, 300));
    }
  });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations.push({
        directive: event.effectiveDirective,
        blocked: String(event.blockedURI || "").slice(0, 200),
        source: String(event.sourceFile || "").slice(0, 200),
        line: event.lineNumber,
        disposition: event.disposition,
      });
    });
  });
  return async () => {
    const events = await page.evaluate(() => window.__cspViolations || []).catch(() => []);
    return { events, consoleRefusals };
  };
}

async function apiPost(route, body) {
  const response = await fetch(`${relayBaseUrl()}${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${relayToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok, `POST ${route}`).toBeTruthy();
  return response.json();
}

const origins = [
  ["127.0.0.1", () => relayOf().baseUrl],
  ["localhost", () => localhostOrigin(relayOf())],
];

for (const [label, originOf] of origins) {
  test(`the app runs under its page policy with no violation at ${label}`, async ({ page }) => {
    const origin = originOf();
    const relay = relayOf();
    const stamp = `${Date.now()}-${label}`;
    const report = await installViolationRecorder(page);
    let conversationId = "";
    let held = "";
    try {
      // The shell answers with the policy, on every route that renders it.
      const { APP_SHELL_CSP } = await import("../server/services/app-shell-csp.mjs");
      for (const route of ["/", "/index.html", "/share-preview/csp-check"]) {
        const shell = await fetch(`${origin}${route}`);
        expect(shell.status, route).toBe(200);
        expect(shell.headers.get("content-security-policy"), route).toBe(APP_SHELL_CSP);
      }

      // A chat with a first turn already answered.
      const started = await startConversation({ text: `Policy check ${stamp}` });
      conversationId = started.conversationId;
      await started.worker.take(started.messageId);
      expect((await respondAsWorker(started.messageId, { conversationId, model: "gpt-5.4-mini", mode: "agent", text: "Ready." })).ok).toBeTruthy();

      await page.addInitScript((id) => { window.localStorage.setItem("copilot_last_conv", id); }, conversationId);
      await signInByCode(page, relay, { origin });
      await expect(page.locator(".msg.assistant .msg-bubble").last()).toContainText("Ready.");

      // Send a message from the composer; the fake worker answers with markdown.
      await page.locator("#msg-input").fill("Show me the summary");
      await page.locator("#send-btn").click();
      const taken = await started.worker.take();
      held = taken.id;
      const answered = await respondAsWorker(taken.id, { conversationId, model: "gpt-5.4-mini", mode: "agent", text: MARKDOWN_REPLY });
      held = "";
      expect(answered.ok).toBeTruthy();

      const bubble = page.locator(".msg.assistant .msg-bubble").last();
      await expect(bubble).toContainText("Here is the summary.");
      // What renders. Soft and short: a library that did not load must not
      // use up the test's time before the violations below are counted.
      const soft = { timeout: 4_000 };
      await expect.soft(bubble.locator("pre code"), "code block").toContainText("items.map", soft);
      // highlight.js ran: its token spans are there, not just the plain text.
      await expect.soft(bubble.locator("pre code [class*='hljs-']").first(), "highlighted code").toBeVisible(soft);
      await expect.soft(bubble.locator(".katex"), "math").not.toHaveCount(0, soft);
      await expect.soft(bubble.locator(".katex-display"), "display math").toHaveCount(1, soft);
      await expect.soft(bubble.locator(".katex").filter({ hasText: "H" }).first(), "mhchem").toBeVisible(soft);
      // The remote picture is a link, not an image, and asks the network for nothing.
      await expect.soft(bubble.locator("img"), "no image").toHaveCount(0, soft);
      const remoteLink = bubble.locator(`a[href="${REMOTE_IMAGE}"]`);
      await expect.soft(remoteLink, "remote image as link").toHaveText("remote chart", soft);
      await expect.soft(remoteLink).toHaveAttribute("target", "_blank", soft);
      await expect.soft(remoteLink).toHaveAttribute("rel", "noopener noreferrer", soft);

      // Settings.
      await page.evaluate(() => window.openSettingsModal("general"));
      await expect(page.locator("#settings-panel-general")).toBeVisible();
      await page.evaluate(() => window.openSettingsModal("security"));
      await expect(page.locator("#settings-panel-security")).toBeVisible();
      await page.evaluate(() => window.closeSettingsModal());
      await expect(page.locator("#settings-panel-security")).toBeHidden();

      // An ask-user card, answered.
      const queued = await apiPost("/api/message", { conversationId, text: `Ask me something ${stamp}`, relayMode: "agent", model: "gpt-5.4-mini" });
      const second = await started.worker.take(queued.messageId);
      held = second.id;
      const prompt = `Pick one ${stamp}`;
      const asked = await apiPost("/api/relay-question", {
        ...attemptOf(second.id),
        queueId: second.id,
        messageId: second.id,
        conversationId,
        mode: "agent",
        prompt,
        choices: ["Option A", "Option B"],
        allowFreeform: false,
        timeout_ms: 120000,
        context: { source: "playwright-e2e", rationale: "Page policy check." },
      });
      expect(asked?.question?.id).toBeTruthy();
      const banner = page.locator("#pending-question-banner");
      await expect(banner).toBeVisible();
      await banner.click();
      const card = page.locator(".relay-question-container", { hasText: prompt });
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "Option A" }).click();
      await expect(card).not.toBeVisible();
      await respondAsWorker(second.id, { conversationId, model: "gpt-5.4-mini", mode: "agent", text: "Done." });
      held = "";

      // The media gallery lists that remote picture (the relay indexes the
      // reply when the gallery asks): a placeholder naming the site, nothing
      // loaded from it; opened, a link out.
      await page.evaluate(() => window.toggleMediaView());
      const gallery = page.locator('#messages .media-gallery[data-scope="global"]');
      const placeholder = gallery.locator(".media-tile-remote", { hasText: "tracker.example.test" }).first();
      await expect(placeholder, "remote picture as a placeholder tile").toBeVisible({ timeout: 15_000 });
      await expect(gallery.locator(".media-tile-remote img, .media-tile-remote video"), "no picture requested").toHaveCount(0);
      await placeholder.click();
      const openOut = page.locator("#file-preview-body").getByRole("link", { name: "Open on tracker.example.test" });
      await expect(openOut).toHaveAttribute("href", REMOTE_IMAGE);
      await expect(openOut).toHaveAttribute("rel", "noopener noreferrer");
      await expect(page.locator("#file-preview-body").locator("img, video")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.locator("#file-preview-modal")).not.toHaveClass(/visible/);

      // Let late requests (fonts, the socket's upgrade) happen, then count.
      await page.waitForLoadState("networkidle");
      const { events, consoleRefusals } = await report();
      expect(
        { violations: events.map((e) => `${e.directive} ${e.blocked}`), console: consoleRefusals },
        `policy violations at ${label}`,
      ).toEqual({ violations: [], console: [] });
    } finally {
      // What was refused, printed even when a step above failed first.
      const seen = await report();
      if (seen.events.length || seen.consoleRefusals.length) {
        console.log(`CSP VIOLATIONS at ${label}: ${JSON.stringify({ events: seen.events.map((e) => `${e.directive} ${e.blocked}`), console: seen.consoleRefusals.map((t) => t.slice(0, 160)) })}`);
      }
      if (held) await respondAsWorker(held, { conversationId, model: "gpt-5.4-mini", mode: "agent", text: "cleanup" }).catch(() => {});
      if (conversationId) {
        await fetch(`${relayBaseUrl()}/api/conversation/${conversationId}/archive`, {
          method: "POST",
          headers: { Authorization: `Bearer ${relayToken()}` },
        }).catch(() => {});
      }
    }
  });
}
