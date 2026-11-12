import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { sleep, startRelayServer } from "./relay-server-harness.mjs";
import { apiOf, dropSessionProof, localhostOrigin, openInbox, signInByCode, waitForApp } from "./helpers/browser-signin.mjs";

/**
 * Answering a paired relay's question in a popup (agent auth §13.2, 1a), on
 * two relays of their own: A, where the browser is, reached as `localhost`,
 * and B, reached as `127.0.0.1`, so the two have separate cookie jars and
 * are different sites. A knows B; an ask about a session on B waits on B.
 *
 * - A's Inbox shows the ask with option buttons ("answers on linux-test")
 *   and "Open there"; a button opens B's page in a popup;
 * - with B's cookie but not its session key (signed out on B), the popup
 *   shows B's sign-in box with the parameters kept, then the question with
 *   the option picked; Confirm waits for the guard; after Confirm the popup
 *   closes and A's card follows;
 * - the address alone answers nothing;
 * - a forged cross-site POST with B's cookie is refused (403), and so is
 *   the cookie replayed without its key (403 AUTH_SESSION_PROOF);
 * - a bad id or option: no question, or nothing preselected.
 *
 * No screenshot, video or trace: tokens and codes must not end up in a test
 * artefact.
 */

test.use({ screenshot: "off", video: "off", trace: "off" });

test.describe.serial("answer in a popup", () => {
  test.describe.configure({ timeout: 180_000, retries: 0 });

  let relayA = null;
  let relayB = null;
  let context = null;
  let page = null;
  const suffix = Date.now();
  const sessions = {};

  const apiA = (...args) => apiOf(relayA)(...args);
  const apiB = (...args) => apiOf(relayB)(...args);
  const toolA = (conversationId, action, args = {}) => apiA("/api/remote-relays/tool", { method: "POST", body: { conversationId, action, args } });

  async function conversation(api, text) {
    const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
    expect(queued.status, `POST /api/message ${queued.status}`).toBe(200);
    return queued.payload.conversationId;
  }

  /** An ask from A's lead about B's session: stored on B, pending. */
  async function askOnB(question, options) {
    const asked = await toolA(sessions.lead, "ask", { relay: "linux-test", session: sessions.far, question, options });
    expect(asked.status, JSON.stringify(asked.payload)).toBe(200);
    const id = asked.payload.question_id;
    const onB = await apiB(`/api/relay-question/${encodeURIComponent(id)}`);
    expect(onB.payload?.question?.status).toBe("pending");
    return id;
  }

  const questionOnB = async (id) => (await apiB(`/api/relay-question/${encodeURIComponent(id)}`)).payload?.question;

  test.beforeAll(async ({ browser }) => {
    relayA = await startRelayServer({ token: randomUUID() });
    relayB = await startRelayServer({ token: randomUUID() });
    expect((await apiA("/api/settings/pwa-app-name", { method: "POST", body: { appName: "win-test" } })).status).toBe(200);
    expect((await apiB("/api/settings/pwa-app-name", { method: "POST", body: { appName: "linux-test" } })).status).toBe(200);
    expect((await apiA("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } })).status).toBe(200);
    expect((await apiA("/api/settings/remote-relays", { method: "POST", body: { publicUrl: relayA.baseUrl } })).status).toBe(200);
    const added = await apiA("/api/remote-relays", { method: "POST", body: { url: relayB.baseUrl, token: relayB.token } });
    expect(added.payload?.ok, JSON.stringify(added.payload)).toBe(true);
    // B says its page takes ?answer= (capabilities.answerLink); A stored it.
    const identity = await apiB("/api/relay/identity");
    expect(identity.payload?.capabilities?.answerLink).toBe(true);
    const listed = await apiA("/api/remote-relays");
    expect(listed.payload.relays.find((relay) => relay.url === relayB.baseUrl)?.answerLink).toBe(true);
    sessions.lead = await conversation(apiA, `migration lead ${suffix}: plan the work with linux-test`);
    sessions.far = await conversation(apiB, `far worker ${suffix}`);
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    // A as `localhost`: a site of its own; B stays `127.0.0.1`.
    await signInByCode(page, relayA, { origin: localhostOrigin(relayA) });
  });

  test.afterAll(async () => {
    await context?.close().catch(() => {});
    await Promise.all([relayA?.stop(), relayB?.stop()]);
    relayA = null;
    relayB = null;
  });

  test("the address alone answers nothing", async () => {
    const id = await askOnB("Rotate the logs tonight?", ["Tonight", "Tomorrow"]);
    sessions.untouched = id;
    // The shell, unauthenticated: a page, no side effect.
    const shell = await fetch(`${relayB.baseUrl}/?answer=${encodeURIComponent(id)}&option=0`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-security-policy") || "").toContain("frame-ancestors 'self'");
    // A page signed in on B, left alone with the address: still pending.
    const idle = await context.newPage();
    try {
      await signInByCode(idle, relayB, { extra: `answer=${encodeURIComponent(id)}&option=0` });
      const view = idle.locator("#answer-there-view");
      await expect(view).toBeVisible();
      await expect(view.locator(".answer-there-confirm")).toBeDisabled();
      await sleep(1_500);
      await expect(view.locator(".answer-there-confirm")).toBeDisabled();
      expect((await questionOnB(id)).status).toBe("pending");
      await view.locator(".answer-there-cancel").click();
      await expect(view).toHaveCount(0);
      expect(new URL(idle.url()).searchParams.has("answer"), "the parameters are gone once used").toBe(false);
      expect((await questionOnB(id)).status).toBe("pending");
    } finally {
      await idle.close();
    }
  });

  test("a forged cross-site POST with B's cookie is refused", async () => {
    const cookie = (await context.cookies(relayB.baseUrl)).find((entry) => entry.name === "copilot_auth");
    expect(cookie, "the context holds a B session from the last test").toBeTruthy();
    const forged = await fetch(`${relayB.baseUrl}/api/relay-question/${encodeURIComponent(sessions.untouched)}/answer`, {
      method: "POST",
      headers: {
        Cookie: `copilot_auth=${cookie.value}`,
        Origin: localhostOrigin(relayA),
        "Sec-Fetch-Site": "cross-site",
        "content-type": "application/json",
      },
      body: JSON.stringify({ choice: "Tonight", answer: "" }),
    });
    expect(forged.status).toBe(403);
    // The cookie replayed by a server (no Origin, no Sec-Fetch-Site), without the session's key.
    const replayed = await fetch(`${relayB.baseUrl}/api/relay-question/${encodeURIComponent(sessions.untouched)}/answer`, {
      method: "POST",
      headers: { Cookie: `copilot_auth=${cookie.value}`, "content-type": "application/json" },
      body: JSON.stringify({ choice: "Tonight", answer: "" }),
    });
    expect(replayed.status).toBe(403);
    expect((await replayed.json()).code).toBe("AUTH_SESSION_PROOF");
    expect((await questionOnB(sessions.untouched)).status).toBe("pending");
    // B's cookie stays and its key goes: signed out on B, for the sign-in box in the next test.
    await dropSessionProof(context, relayB.baseUrl);
    expect((await context.cookies(relayB.baseUrl)).some((entry) => entry.name === "copilot_auth"), "the cookie is still there").toBe(true);
  });

  test("tap → popup → B's sign-in → the card with the option picked → Confirm → closed, A follows", async () => {
    const id = await askOnB("Run the migration tonight?", ["Tonight", "Tomorrow"]);
    await openInbox(page);
    // Listed under B (A's own section never holds it).
    const card = page.locator(`.inbox-relay:not([data-relay-id="self"]) .inbox-item[data-item-id="${id}"]`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator(".inbox-answer-there-hint")).toHaveText("answers on linux-test");
    await expect(card.locator(".inbox-open-there-button")).toHaveText("Open there");
    const choice = card.locator('[data-inbox-action="answer-there"][data-option="1"]');
    await expect(choice).toHaveText("Tomorrow");
    await expect(choice).toHaveAttribute("data-url", `${relayB.baseUrl}/?answer=${id}&option=1`);

    const popupOpened = context.waitForEvent("page");
    await choice.click();
    const popup = await popupOpened;
    await popup.waitForLoadState("domcontentloaded");
    expect(new URL(popup.url()).origin).toBe(relayB.baseUrl);
    // No opener: the popup cannot reach A's window.
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    // Nothing answered by the click.
    expect((await questionOnB(id)).status).toBe("pending");

    // B's cookie without its key is signed out on B: its sign-in box, a form, with the parameters kept.
    await expect(popup.locator("#auth-gate")).toBeVisible();
    expect(new URL(popup.url()).searchParams.get("answer")).toBe(id);
    await expect(popup.locator("#auth-username")).toHaveValue("linux-test");
    await expect(popup.locator("#auth-context")).toHaveText("Sign in to linux-test to answer");
    await popup.locator("#token-input").fill(relayB.token);
    await popup.locator("#token-input").press("Enter");
    await waitForApp(popup);

    const view = popup.locator("#answer-there-view");
    await expect(view).toBeVisible();
    await expect(view.locator("h1")).toHaveText("Answer on linux-test");
    await expect(view.locator(".relay-question-body")).toHaveText("Run the migration tonight?");
    const radios = view.locator('input[type="radio"]');
    await expect(radios).toHaveCount(2);
    await expect(radios.nth(1)).toBeChecked();
    await expect(radios.nth(0)).not.toBeChecked();
    const confirm = view.locator(".answer-there-confirm");
    await expect(confirm).toBeDisabled();
    // A person's pointer in the window, then the 800 ms guard.
    await popup.bringToFront();
    await popup.mouse.move(40, 40);
    await popup.mouse.move(60, 80);
    await expect(confirm).toBeEnabled({ timeout: 5_000 });
    expect((await questionOnB(id)).status).toBe("pending");

    const closed = popup.waitForEvent("close", { timeout: 10_000 }).then(() => true).catch(() => false);
    await confirm.click();
    await expect.poll(async () => (await questionOnB(id)).status, { timeout: 10_000 }).toBe("answered");
    expect((await questionOnB(id)).choice).toBe("Tomorrow");
    if (!(await closed)) {
      await expect(popup.locator(".answer-there-status")).toContainText("You can close this window.");
      await popup.close();
    }

    // Back on A: the Inbox reloads on focus; the card is answered.
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator(`.inbox-relay:not([data-relay-id="self"]) .inbox-item[data-item-id="${id}"]`)).toHaveAttribute("data-status", "answered", { timeout: 20_000 });
  });

  test("already answered, a bad id, an option out of range", async () => {
    const answered = await askOnB("Keep the cache warm?", ["Yes", "No"]);
    const done = await apiB(`/api/relay-question/${encodeURIComponent(answered)}/answer`, { method: "POST", body: { choice: "Yes", answer: "" } });
    expect(done.status).toBe(200);
    const open = await context.newPage();
    try {
      // The context is signed in on B since the popup's sign-in.
      await open.goto(`${relayB.baseUrl}/?answer=${encodeURIComponent(answered)}&option=1`);
      await waitForApp(open);
      const view = open.locator("#answer-there-view");
      await expect(view.locator(".answer-there-status")).toHaveText("Already answered on linux-test.");
      await expect(view.locator('input[type="radio"]')).toHaveCount(0);
      await expect(view.locator(".answer-there-confirm")).toHaveCount(0);

      await open.goto(`${relayB.baseUrl}/?answer=${encodeURIComponent("../x")}&option=0`);
      await waitForApp(open);
      await expect(open.locator("#answer-there-view .answer-there-status")).toHaveText("This link does not name a question.");
      expect(new URL(open.url()).searchParams.has("answer")).toBe(false);

      for (const option of ["7", "-1", "1.5", "x"]) {
        await open.goto(`${relayB.baseUrl}/?answer=${encodeURIComponent(sessions.untouched)}&option=${encodeURIComponent(option)}`);
        await waitForApp(open);
        const radios = open.locator('#answer-there-view input[type="radio"]');
        await expect(radios).toHaveCount(2);
        await expect(open.locator('#answer-there-view input[type="radio"]:checked')).toHaveCount(0);
      }
      expect((await questionOnB(sessions.untouched)).status).toBe("pending");
    } finally {
      await open.close();
    }
  });
});
