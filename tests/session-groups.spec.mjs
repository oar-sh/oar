import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * Session groups in the sidebar, on a desktop and on a phone viewport, each
 * against a relay of its own (the agent-sessions setting is switched on):
 *
 *  - a session an agent creates with the relay_tool tool sits under the
 *    session that created it: the head row with a fold button and a pill that
 *    sums up the members, the members indented, open while a member works;
 *  - the fold is the user's and survives a reload; a waiting card in a folded
 *    member shows on the head and its pill opens that member;
 *  - a member's new activity lifts the whole group above a newer lone chat;
 *  - the title filter shows a matching member under its head as context;
 *  - the row menu (right-click, a long press on the phone) carries the group
 *    actions; a lone chat joins a new group through the picker, and leaves it;
 *  - "Archive group" archives the idle members and names the one still working;
 *    the live list then shows the group under a synthetic head, the Archived
 *    view the head row with the archived member; "Stop all running" asks the
 *    working member to stop.
 *
 * No model runs. The spec plays the worker where one is needed: it takes a
 * message off the queue (GET /api/pending) and posts cards and replies as a
 * worker would. Titles are invented.
 */

const APPROVAL_TIMEOUT = 20_000;

function createApi(getRelay) {
  return async function api(route, { method = "GET", body, headers = {} } = {}) {
    const relay = getRelay();
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  };
}

async function waitForApprovalCard(api, conversationId) {
  const deadline = Date.now() + APPROVAL_TIMEOUT;
  while (Date.now() < deadline) {
    const { payload } = await api(`/api/relay-questions?status=pending&conversationId=${encodeURIComponent(conversationId)}`);
    const card = (payload?.questions || []).find((question) => question?.context?.source === "remote_relay");
    if (card) return card;
    await sleep(150);
  }
  throw new Error(`No approval card appeared for conversation ${conversationId.slice(0, 8)}`);
}

/** Takes a conversation's queued message as its worker would: the turn is then processing. */
async function dequeueAsOwner(api, conversationId, messageId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const dequeued = await api("/api/pending", { headers: { "x-relay-session-id": conversationId } });
    if (String(dequeued.payload?.message?.id || "") === messageId) return;
    await sleep(250);
  }
  throw new Error(`The message of ${conversationId.slice(0, 8)} was never handed out`);
}

for (const profile of [
  { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, touch: false },
  { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, touch: true },
]) {
  test.describe.serial(`session groups on a ${profile.name} viewport`, () => {
    test.describe.configure({ timeout: 120_000 });
    test.use(profile.use);

    let relay = null;
    const api = createApi(() => relay);
    const tool = (conversationId, action, args = {}) => api("/api/remote-relays/tool", { method: "POST", body: { conversationId, action, args } });
    const seeded = { lead: "", leadMessage: "", docs: "", docsMessage: "", tests: "", testsMessage: "", solo: "" };

    const row = (page, id) => page.locator(`#conv-list .conv-item[data-conversation-id="${id}"]`);
    const listedIds = (page) => page.locator("#conv-list .conv-item").evaluateAll((nodes) => nodes.map((node) => node.dataset.conversationId || `group:${node.dataset.groupId}`));
    const openSidebar = async (page) => {
      if (profile.touch) await page.evaluate(() => window.toggleSidebar?.(true));
    };
    const openApp = async (page) => {
      await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
      await page.waitForLoadState("networkidle");
      await page.waitForFunction(() => typeof window.openConversation === "function");
      await openSidebar(page);
    };
    /**
     * Measures a head row: every descendant's rectangle lies inside the
     * row's, and the title and the meta line do not touch the archive and
     * delete icons. The row's own rectangle never grows with an overflowing
     * child (overflow is visible), so only the children can show it.
     */
    const expectHeadRowContained = async (locator, label, inject = null) => {
      const report = await locator.evaluate((node, injected) => {
        // The injected state is written here, in the same turn as the
        // measurement, so a re-render in between cannot swap it out.
        if (injected?.pill) {
          const summary = node.querySelector(".conv-group-summary");
          summary.textContent = injected.pill;
          summary.className = `conv-group-summary conv-group-summary-${/waiting/.test(injected.pill) ? "waiting" : "running"}`;
        }
        if (injected?.title) {
          const titleNode = node.querySelector(".conv-title");
          for (const child of [...titleNode.childNodes]) if (child.nodeType === 3) child.textContent = injected.title;
        }
        const rect = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
        const row = rect(node);
        const inside = (a, b) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
        const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        // What is drawn: a descendant's rectangle cut to its clipping
        // ancestors (the title's ellipsis hides what runs past it).
        const drawn = (el) => {
          let r = rect(el);
          for (let parent = el.parentElement; parent && parent !== node.parentElement; parent = parent.parentElement) {
            const overflow = getComputedStyle(parent).overflowX;
            if (overflow === "hidden" || overflow === "clip" || overflow === "auto" || overflow === "scroll") {
              const p = rect(parent);
              r = { left: Math.max(r.left, p.left), right: Math.min(r.right, p.right), top: Math.max(r.top, p.top), bottom: Math.min(r.bottom, p.bottom) };
            }
          }
          return r;
        };
        const outside = [];
        for (const el of node.querySelectorAll("*")) {
          const r = drawn(el);
          if (r.right - r.left <= 0 || r.bottom - r.top <= 0) continue;
          if (!inside(r, row)) outside.push(`${el.className || el.tagName} ${Math.round(r.left)}..${Math.round(r.right)}`);
        }
        // Nothing drawn (the icons and their own content aside) may sit under
        // an icon: not the title, not the meta line, not a chip pushed out
        // of the meta line into the gutter.
        const iconNodes = [...node.querySelectorAll(".conv-archive, .conv-delete")];
        const icons = iconNodes.map(rect);
        const overlaps = [];
        for (const el of node.querySelectorAll("*")) {
          if (iconNodes.some((icon) => icon === el || icon.contains(el))) continue;
          const r = drawn(el);
          if (r.right - r.left <= 0 || r.bottom - r.top <= 0) continue;
          if (icons.some((icon) => intersects(r, icon))) overlaps.push(`${el.className || el.tagName} ${Math.round(r.left)}..${Math.round(r.right)}`);
        }
        const pill = node.querySelector(".conv-group-summary");
        return { row: `${Math.round(row.left)}..${Math.round(row.right)}`, outside, overlaps, icons: icons.map((i) => `${Math.round(i.left)}..${Math.round(i.right)}`), pill: pill ? pill.textContent : null };
      }, inject);
      if (inject?.pill) expect(report.pill, `${label}: the measured pill is the injected one`).toBe(inject.pill);
      expect(report.outside, `${label}: children outside the row ${report.row}`).toEqual([]);
      expect(report.overlaps, `${label}: something under the icons ${report.icons.join(", ")}`).toEqual([]);
    };
    const openRowMenu = async (page, locator) => {
      if (profile.touch) {
        await locator.evaluate(async (node) => {
          const box = node.getBoundingClientRect();
          const init = { bubbles: true, pointerType: "touch", clientX: box.x + 20, clientY: box.y + 10, pointerId: 7 };
          node.dispatchEvent(new PointerEvent("pointerdown", init));
          // A long press opens the menu when the finger lifts.
          await new Promise((resolve) => setTimeout(resolve, 650));
          node.dispatchEvent(new PointerEvent("pointerup", init));
        });
      } else {
        await locator.click({ button: "right" });
      }
      const menu = page.locator(".context-menu");
      await expect(menu).toBeVisible({ timeout: 5000 });
      return menu;
    };

    test.beforeAll(async () => {
      relay = await startRelayServer({ token: randomUUID() });
      const named = await api("/api/settings/pwa-app-name", { method: "POST", body: { appName: "linux-test" } });
      expect(named.status).toBe(200);
      const enabled = await api("/api/settings/agent-sessions", { method: "POST", body: { enabled: true } });
      expect(enabled.status).toBe(200);

      // The session that creates the others, with its turn running (the
      // approval card needs a turn to sit on).
      const queued = await api("/api/message", { method: "POST", body: { text: `Release lead ${Date.now()}`, relayMode: "agent", model: "gpt-5.4-mini" } });
      expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
      seeded.lead = queued.payload.conversationId;
      seeded.leadMessage = queued.payload.messageId;
      const synced = await api("/api/session-sync", { method: "POST", body: { sdk_session_id: seeded.lead, conversation_id: seeded.lead } });
      expect(synced.status).toBe(200);
      await dequeueAsOwner(api, seeded.lead, seeded.leadMessage);

      const first = tool(seeded.lead, "create_session", { relay: "this", text: "write the docs for the release", title: "Docs pass", wait_seconds: 0 });
      const card = await waitForApprovalCard(api, seeded.lead);
      const allowed = await api(`/api/relay-question/${encodeURIComponent(card.id)}/answer`, {
        method: "POST",
        body: { answer: "Allow", ...(card.sdkSessionId ? { sdk_session_id: card.sdkSessionId } : {}) },
      });
      expect(allowed.status).toBe(200);
      const docs = await first;
      expect(docs.status, JSON.stringify(docs.payload)).toBe(200);
      seeded.docs = docs.payload.session;
      seeded.docsMessage = docs.payload.message_id;
      const tests = await tool(seeded.lead, "create_session", { relay: "this", text: "run the tests for the release", title: "Tests pass", wait_seconds: 0 });
      expect(tests.status, JSON.stringify(tests.payload)).toBe(200);
      seeded.tests = tests.payload.session;
      seeded.testsMessage = tests.payload.message_id;

      // A lone chat, newer than everything in the group.
      const solo = await api("/api/message", { method: "POST", body: { text: "Lone chat about the site", relayMode: "agent", model: "gpt-5.4-mini" } });
      expect(solo.status).toBe(200);
      seeded.solo = solo.payload.conversationId;
      const replied = await api("/api/response", { method: "POST", body: { messageId: solo.payload.messageId, conversationId: seeded.solo, text: "reply", model: "gpt-5.4-mini", mode: "agent" } });
      expect(replied.status).toBe(200);
    });

    test.afterAll(async () => {
      if (relay) await relay.stop();
      relay = null;
    });

    test("a created session sits under its creator: head row, fold button, pill, indented members", async ({ page }) => {
      // The relay already groups them.
      const list = await api("/api/conversations");
      const byId = Object.fromEntries(list.payload.conversations.map((entry) => [entry.id, entry]));
      expect(byId[seeded.lead].groupRole).toBe("head");
      expect(byId[seeded.docs].groupRole).toBe("member");
      expect(byId[seeded.tests].groupId).toBe(byId[seeded.lead].groupId);
      expect(list.payload.groups[byId[seeded.lead].groupId].displayName).toBe(byId[seeded.lead].title);

      await openApp(page);
      // The lone chat is newest; then the group, head first, members newest first.
      await expect.poll(() => listedIds(page)).toEqual([seeded.solo, seeded.lead, seeded.tests, seeded.docs]);
      const head = row(page, seeded.lead);
      await expect(head).toHaveClass(/conv-group-head/);
      await expect(head.locator(".conv-group-fold")).toHaveAttribute("aria-expanded", "true");
      // Both members have their first turn queued: running.
      // The head's own turn runs and both members have theirs queued: the
      // pill counts every row of the group, the head included.
      await expect(head.locator(".conv-group-summary")).toHaveText("3 · 3 running");
      await expect(row(page, seeded.docs)).toHaveClass(/conv-group-member/);
      await expect(row(page, seeded.tests)).toHaveClass(/conv-group-member/);
      const headBox = await head.boundingBox();
      const memberBox = await row(page, seeded.docs).boundingBox();
      expect(memberBox.x).toBeGreaterThan(headBox.x + 6);
      // Nothing of the head row leaves it or sits under its icons: running only.
      await expectHeadRowContained(head, "running only");
      await head.hover();
      await expectHeadRowContained(head, "running only, hovered");
    });

    test("the head row keeps every pill state inside it, with and without hover", async ({ page }) => {
      await openApp(page);
      const head = row(page, seeded.lead);
      await expect(head.locator(".conv-group-summary")).toBeVisible();
      // The renderer's markup, with the texts a group can produce, written
      // into the live row; each is measured at once, before the next poll
      // redraws the list.
      const states = [
        ["running only", "3 · 2 running", null],
        ["waiting only", "3 · 1 waiting for you", null],
        ["both", "3 · 1 waiting for you, 2 running", null],
        ["long counts", "12 · 3 waiting for you, 10 running", null],
        ["long title", "3 · 1 waiting for you, 2 running", "A very long title for the release lead session that does not end soon"],
      ];
      for (const [label, pill, title] of states) {
        await expectHeadRowContained(head, label, { pill, title });
        await head.hover();
        await expectHeadRowContained(head, `${label}, hovered`, { pill, title });
        await page.mouse.move(0, 0);
      }
      // A hand-named group: the synthetic head with the longest pill.
      const made = await api("/api/conversation-groups", { method: "POST", body: { name: "A hand-named batch with a long name for the test", conversationIds: [seeded.solo] } });
      expect(made.status).toBe(200);
      const synthetic = page.locator('#conv-list .conv-group-synthetic');
      await expect(synthetic).toHaveCount(1);
      await expectHeadRowContained(synthetic, "hand-named group", { pill: "12 · 3 waiting for you, 10 running" });
      const dissolved = await api(`/api/conversation-groups/${encodeURIComponent(made.payload.group.id)}`, { method: "DELETE" });
      expect(dissolved.status).toBe(200);
      await expect(synthetic).toHaveCount(0);
    });

    test("the fold is the user's and survives a reload; a waiting card in a folded member shows on the head", async ({ page }) => {
      await openApp(page);
      const head = row(page, seeded.lead);
      await head.locator(".conv-group-fold").click();
      await expect.poll(() => listedIds(page)).toEqual([seeded.solo, seeded.lead]);
      await expect(head.locator(".conv-group-fold")).toHaveAttribute("aria-expanded", "false");
      await page.reload();
      await page.waitForLoadState("networkidle");
      await openSidebar(page);
      await expect.poll(() => listedIds(page)).toEqual([seeded.solo, seeded.lead]);

      // The docs member's turn is taken by "its worker", which asks a question.
      await dequeueAsOwner(api, seeded.docs, seeded.docsMessage);
      const asked = await api("/api/relay-question", {
        method: "POST",
        body: {
          queueId: seeded.docsMessage,
          messageId: seeded.docsMessage,
          conversationId: seeded.docs,
          mode: "agent",
          prompt: "Which branch holds the docs?",
          choices: ["main", "release"],
          allowFreeform: true,
          timeout_ms: 120000,
          context: { source: "playwright-e2e", rationale: "A waiting card in a folded member." },
        },
      });
      expect(asked.status, JSON.stringify(asked.payload)).toBe(200);
      const pill = row(page, seeded.lead).locator(".conv-group-summary");
      await expect(pill).toHaveText("3 · 1 waiting for you, 2 running", { timeout: 10_000 });
      await expect(pill).toHaveClass(/conv-group-summary-waiting/);
      await expect(pill).toHaveAttribute("data-open-waiting", seeded.docs);
      await expect.poll(() => listedIds(page)).toEqual([seeded.solo, seeded.lead]);
      // Running and waiting at once, folded: still nothing leaves the row.
      await expectHeadRowContained(row(page, seeded.lead), "running and waiting, folded");
      await row(page, seeded.lead).hover();
      await expectHeadRowContained(row(page, seeded.lead), "running and waiting, folded, hovered");
      // Its tap opens the member the card sits in.
      await pill.click();
      await expect(page.locator("#chat-title")).toHaveText("Docs pass");
      // The open conversation's group is shown open, whatever the fold.
      await openSidebar(page);
      await expect.poll(() => listedIds(page)).toEqual([seeded.solo, seeded.lead, seeded.tests, seeded.docs]);

      // The answer, so the card is gone for the next tests.
      const answered = await api(`/api/relay-question/${encodeURIComponent(asked.payload.question.id)}/answer`, { method: "POST", body: { answer: "main" } });
      expect(answered.status).toBe(200);
    });

    test("a turn that ends in a member while another chat is open clears its running state at once", async ({ page }) => {
      await openApp(page);
      await page.evaluate((id) => window.openConversation(id), seeded.solo);
      await expect(page.locator("#chat-title")).toHaveText(/Lone chat/);
      await openSidebar(page);
      const pill = row(page, seeded.lead).locator(".conv-group-summary");
      await expect(pill).toHaveText("3 · 3 running");
      await expect(row(page, seeded.tests)).toHaveClass(/conv-working/);
      await expect(page.locator("#conv-list .conv-processing-dots")).toHaveCount(0);
      // The tests member answers: its turn ends while the lone chat is open.
      // No list fetch follows; the pill, the working mark and the menu must follow
      // the live event alone.
      const replied = await api("/api/response", { method: "POST", body: { messageId: seeded.testsMessage, conversationId: seeded.tests, text: "all green", model: "gpt-5.4-mini", mode: "agent" } });
      expect(replied.status).toBe(200);
      await expect(pill).toHaveText("3 · 2 running", { timeout: 10_000 });
      await expect(row(page, seeded.tests)).not.toHaveClass(/conv-working/);
      const menu = await openRowMenu(page, row(page, seeded.lead));
      await expect(menu.locator('[data-menu-item="group-stop"]')).toHaveText("Stop all running (2)");
      await page.keyboard.press("Escape");

      // Background work after the turn: the member's worker (alive: it
      // heartbeats under its session id, so the status poll lists it)
      // publishes a running task (background_only), then an empty set. Both
      // reach the row through the live event, with no list fetch.
      const beat = await api("/api/heartbeat", { method: "POST", body: {}, headers: { "x-relay-session-id": seeded.tests } });
      expect(beat.status).toBe(200);
      const published = await api("/api/background-tasks", { method: "POST", body: { conversationId: seeded.tests, tasks: [{ taskId: "task-build", taskType: "shell", description: "npm run build", startedAt: Date.now() }] } });
      expect(published.status).toBe(200);
      await expect(pill).toHaveText("3 · 3 running", { timeout: 10_000 });
      await expect(row(page, seeded.tests)).toHaveClass(/conv-working/);
      const withTask = await openRowMenu(page, row(page, seeded.lead));
      await expect(withTask.locator('[data-menu-item="group-stop"]')).toHaveText("Stop all running (3)");
      await page.keyboard.press("Escape");
      const cleared = await api("/api/background-tasks", { method: "POST", body: { conversationId: seeded.tests, tasks: [] } });
      expect(cleared.status).toBe(200);
      await expect(pill).toHaveText("3 · 2 running", { timeout: 10_000 });
      await expect(row(page, seeded.tests)).not.toHaveClass(/conv-working/);
    });

    test("a member's activity lifts the group above the newer lone chat; the filter shows a member under its head", async ({ page }) => {
      await openApp(page);
      // No fold choice and nothing open, so the default fold rule decides.
      await page.evaluate(() => {
        localStorage.removeItem("copilot_conv_group_folds");
        localStorage.removeItem("copilot_last_conv");
      });
      await page.reload();
      await page.waitForLoadState("networkidle");
      await openSidebar(page);
      await expect.poll(() => listedIds(page)).toEqual([seeded.lead, seeded.tests, seeded.docs, seeded.solo]);
      await expect(row(page, seeded.lead).locator(".conv-group-summary")).toHaveText("3 · 2 running");

      await page.locator("#conv-filter-input").fill("tests");
      await expect.poll(() => listedIds(page)).toEqual([seeded.lead, seeded.tests]);
      await page.locator("#conv-filter-input").fill("lone");
      await expect.poll(() => listedIds(page)).toEqual([seeded.solo]);
      await page.locator("#conv-filter-clear").click();
      await expect.poll(() => listedIds(page)).toEqual([seeded.lead, seeded.tests, seeded.docs, seeded.solo]);
    });

    test("the lone chat joins a new group through the row menu and the picker, and leaves it again", async ({ page }) => {
      await openApp(page);
      const menu = await openRowMenu(page, row(page, seeded.solo));
      await expect(menu.locator('[data-menu-item="group-add"]')).toBeVisible();
      const menuBox = await menu.boundingBox();
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
      await menu.locator('[data-menu-item="group-add"]').click();
      const picker = page.locator("#conv-group-picker");
      await expect(picker).toBeVisible();
      await expect(picker.locator("[data-group-choice]")).toHaveCount(1);
      await picker.locator("#conv-group-create-input").fill("Sample batch");
      await picker.locator("[data-group-create]").click();
      // A synthetic head "Sample batch" with the lone chat under it (open: a
      // new group of one idle member folds, but the open chat is in it).
      const synthetic = page.locator('#conv-list .conv-group-synthetic');
      await expect(synthetic).toHaveCount(1);
      await expect(synthetic.locator(".conv-title")).toContainText("Sample batch");
      await expect(synthetic.locator(".conv-group-summary")).toHaveText("1 session");
      const listed = await api("/api/conversations");
      const soloRow = listed.payload.conversations.find((entry) => entry.id === seeded.solo);
      expect(soloRow.groupRole).toBe("member");
      expect(listed.payload.groups[soloRow.groupId].name).toBe("Sample batch");

      // Folded (idle): the fold button on the synthetic head shows the member.
      await expect(row(page, seeded.solo)).toHaveCount(0);
      await synthetic.locator(".conv-group-fold").click();
      await expect(row(page, seeded.solo)).toHaveClass(/conv-group-member/);

      // The synthetic head's menu carries the group actions only.
      const groupMenu = await openRowMenu(page, synthetic);
      await expect(groupMenu.locator('[data-menu-item="group-rename"]')).toBeVisible();
      await expect(groupMenu.locator('[data-menu-item="group-archive"]')).toBeVisible();
      await expect(groupMenu.locator('[data-menu-item="open"]')).toHaveCount(0);
      await page.keyboard.press("Escape");

      const memberMenu = await openRowMenu(page, row(page, seeded.solo));
      await memberMenu.locator('[data-menu-item="group-remove"]').click();
      await expect(synthetic).toHaveCount(0);
      await expect(row(page, seeded.solo)).not.toHaveClass(/conv-group-member/);
      const after = await api("/api/conversations");
      expect(after.payload.conversations.find((entry) => entry.id === seeded.solo).groupId).toBeNull();
      expect(Object.keys(after.payload.groups)).toHaveLength(1);
    });

    test("Archive group archives the idle members and names the one still working; Stop all asks it to stop", async ({ page }) => {
      // The head's own turn ends: only the docs member is still working.
      const replied = await api("/api/response", { method: "POST", body: { messageId: seeded.leadMessage, conversationId: seeded.lead, text: "planned", model: "gpt-5.4-mini", mode: "agent" } });
      expect(replied.status).toBe(200);
      await openApp(page);
      const menu = await openRowMenu(page, row(page, seeded.lead));
      await expect(menu.locator('[data-menu-item="group-archive"]')).toHaveText("Archive group (3)");
      await expect(menu.locator('[data-menu-item="group-stop"]')).toHaveText("Stop all running (1)");
      await menu.locator('[data-menu-item="group-archive"]').click();
      const confirm = page.locator("#summary-modal [data-confirm]");
      await expect(confirm).toBeVisible();
      await confirm.click();
      // The docs member is still working (its turn is processing): kept and named.
      await expect(page.locator("#relay-toast")).toContainText("Docs pass", { timeout: 10_000 });
      await expect.poll(async () => {
        const list = await api("/api/conversations?archived=true");
        return Object.fromEntries(list.payload.conversations.map((entry) => [entry.id, entry.archived]));
      }).toEqual(expect.objectContaining({ [seeded.lead]: true, [seeded.tests]: true, [seeded.docs]: false }));
      // The live list: the working member under a synthetic head named after the archived head.
      await expect(page.locator("#conv-list .conv-group-synthetic .conv-title")).toContainText("Release lead");
      await expect(row(page, seeded.docs)).toHaveClass(/conv-group-member/);
      await expect(row(page, seeded.lead)).toHaveCount(0);
      // The Archived view: the head row heads its archived member, folded
      // (nothing runs there) until unfolded.
      await page.locator("#conv-archived-toggle").click();
      await expect(row(page, seeded.lead)).toHaveClass(/conv-group-head/);
      await expect(row(page, seeded.lead).locator(".conv-group-fold")).toHaveAttribute("aria-expanded", "false");
      await expect(row(page, seeded.tests)).toHaveCount(0);
      await row(page, seeded.lead).locator(".conv-group-fold").click();
      await expect(row(page, seeded.tests)).toHaveClass(/conv-group-member/);
      await page.locator("#conv-archived-banner .conv-archived-back").click();

      const stopMenu = await openRowMenu(page, page.locator("#conv-list .conv-group-synthetic"));
      await expect(stopMenu.locator('[data-menu-item="group-stop"]')).toHaveText("Stop all running (1)");
      await stopMenu.locator('[data-menu-item="group-stop"]').click();
      await page.locator("#summary-modal [data-confirm]").click();
      await expect(page.locator("#relay-toast")).toContainText("Stop requested for 1 turn", { timeout: 10_000 });
    });

    test("a group action on a row beyond the first page shows without a reload; a dissolved group leaves the picker", async ({ page }) => {
      // Enough newer chats that the lone chat sits on the second page.
      for (let index = 0; index < 42; index += 1) {
        const queued = await api("/api/message", { method: "POST", body: { text: `Filler chat ${index}`, relayMode: "agent", model: "gpt-5.4-mini" } });
        expect(queued.status).toBe(200);
        const replied = await api("/api/response", { method: "POST", body: { messageId: queued.payload.messageId, conversationId: queued.payload.conversationId, text: "reply", model: "gpt-5.4-mini", mode: "agent" } });
        expect(replied.status).toBe(200);
      }
      await openApp(page);
      await expect(row(page, seeded.solo)).toHaveCount(0);
      // Scroll the list to its end until the second page is in.
      await expect.poll(async () => {
        await page.locator("#conv-list").evaluate((node) => { node.scrollTop = node.scrollHeight; });
        return row(page, seeded.solo).count();
      }, { timeout: 15_000 }).toBe(1);
      await row(page, seeded.solo).scrollIntoViewIfNeeded();
      const menu = await openRowMenu(page, row(page, seeded.solo));
      await menu.locator('[data-menu-item="group-add"]').click();
      const picker = page.locator("#conv-group-picker");
      await expect(picker).toBeVisible();
      await picker.locator("#conv-group-create-input").fill("Deep batch");
      await picker.locator("[data-group-create]").click();
      const synthetic = page.locator('#conv-list .conv-group-synthetic', { hasText: "Deep batch" });
      await expect(synthetic).toHaveCount(1, { timeout: 15_000 });
      await synthetic.locator(".conv-group-fold").click();
      await expect(row(page, seeded.solo)).toHaveClass(/conv-group-member/);
      const listed = await api("/api/conversations?limit=100");
      const groupId = listed.payload.conversations.find((entry) => entry.id === seeded.solo).groupId;
      expect(groupId).toBeTruthy();

      // Dissolved elsewhere: the picker no longer offers it.
      const dissolved = await api(`/api/conversation-groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
      expect(dissolved.status).toBe(200);
      await expect(synthetic).toHaveCount(0, { timeout: 15_000 });
      await expect.poll(async () => {
        await page.locator("#conv-list").evaluate((node) => { node.scrollTop = node.scrollHeight; });
        return row(page, seeded.solo).count();
      }, { timeout: 15_000 }).toBe(1);
      const again = await openRowMenu(page, row(page, seeded.solo));
      await again.locator('[data-menu-item="group-add"]').click();
      await expect(page.locator("#conv-group-picker")).toBeVisible();
      await expect(page.locator("#conv-group-picker [data-group-choice]", { hasText: "Deep batch" })).toHaveCount(0);
      await page.keyboard.press("Escape");
    });
  });
}
