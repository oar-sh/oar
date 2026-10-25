import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { sleep, startRelayServer } from "./relay-server-harness.mjs";

/**
 * Dragging sessions in the sidebar, with a mouse on a desktop viewport and
 * with a finger (real touch input through the DevTools protocol) on a phone,
 * each against a relay of its own:
 *
 *  - a member dragged within its group takes the place the line showed; a
 *    second page sees the new order through the relay's event;
 *  - a loose row joins a group at a place, a member leaves its group onto a
 *    loose row, a member moves to another group through its head, and a
 *    loose row dropped onto another makes a new group of the two;
 *  - a folded head opens under a drag that waits on it, and folds again when
 *    the row went elsewhere;
 *  - the list scrolls by itself near its edge; Escape gives the row back;
 *  - nothing drags under a filter or in the Archived view;
 *  - on the phone a long press released in place still opens the menu, and a
 *    plain swipe still scrolls the list.
 *
 * No model runs: every chat gets its first message and a reply through the
 * API. Titles are invented.
 */

const FILLER_COUNT = 34;
const UNFOLD_WAIT_MS = 900;

function createApi(getRelay) {
  return async function api(route, { method = "GET", body } = {}) {
    const relay = getRelay();
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
  };
}

/** Mouse: press, a few pixels to start the drag, then glide. */
function mouseDragger(page) {
  let last = null;
  return {
    async begin(point) {
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      last = { x: point.x, y: point.y + 8 };
      await page.mouse.move(last.x, last.y, { steps: 2 });
    },
    async move(point) {
      await page.mouse.move(point.x, point.y, { steps: 8 });
      last = point;
    },
    async end() {
      await page.mouse.up();
    },
  };
}

/** A finger through CDP (Playwright's touchscreen only taps): hold, move past the slop, glide. */
async function touchDragger(page) {
  const cdp = await page.context().newCDPSession(page);
  let last = null;
  const touch = (type, point) => cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: point ? [{ x: point.x, y: point.y, id: 1, radiusX: 2, radiusY: 2, force: 1 }] : [],
  });
  const glide = async (to, steps) => {
    const from = last;
    for (let step = 1; step <= steps; step += 1) {
      const point = { x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps };
      await touch("touchMove", point);
      await sleep(16);
    }
    last = to;
  };
  return {
    async begin(point, { hold = true } = {}) {
      last = point;
      await touch("touchStart", point);
      if (!hold) return;
      await sleep(700);
      await glide({ x: point.x, y: point.y + 16 }, 3);
    },
    move: (point, steps = 8) => glide(point, steps),
    async end() {
      await touch("touchEnd", null);
    },
    touch,
  };
}

for (const profile of [
  { name: "desktop", use: { viewport: { width: 1280, height: 800 } }, touch: false },
  { name: "phone", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, touch: true },
]) {
  test.describe.serial(`dragging sessions in the sidebar on a ${profile.name} viewport`, () => {
    test.describe.configure({ timeout: 120_000 });
    test.use(profile.use);

    let relay = null;
    const api = createApi(() => relay);
    const ids = {};
    const groups = {};

    const makeChat = async (text) => {
      const queued = await api("/api/message", { method: "POST", body: { text, relayMode: "agent", model: "gpt-5.4-mini" } });
      expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
      const conversationId = queued.payload.conversationId;
      const replied = await api("/api/response", { method: "POST", body: { messageId: queued.payload.messageId, conversationId, text: "reply", model: "gpt-5.4-mini", mode: "agent" } });
      expect(replied.status).toBe(200);
      return conversationId;
    };
    const makeGroup = async (name, conversationIds) => {
      const made = await api("/api/conversation-groups", { method: "POST", body: { name, conversationIds } });
      expect(made.status, JSON.stringify(made.payload)).toBe(200);
      return made.payload.group.id;
    };
    const relayRows = async () => {
      const { payload } = await api("/api/conversations?limit=100");
      return Object.fromEntries(payload.conversations.map((entry) => [entry.id, entry]));
    };
    const groupOf = async (id) => (await relayRows())[id]?.groupId || null;

    const row = (page, id) => page.locator(`#conv-list .conv-item[data-conversation-id="${id}"]`);
    const head = (page, groupId) => page.locator(`#conv-list .conv-group-synthetic[data-group-id="${groupId}"]`);
    const membersInList = (page, groupId) => page.locator(`#conv-list .conv-item.conv-group-member[data-group-id="${groupId}"]`)
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.conversationId));
    const pointIn = async (locator, fraction = 0.5) => {
      // In the page, in one go: a re-render may swap the row between steps.
      await locator.evaluate((node) => node.scrollIntoView({ block: "nearest" }));
      const box = await locator.boundingBox();
      return { x: box.x + Math.min(box.width / 2, 120), y: box.y + box.height * fraction };
    };
    const dragger = (page) => (profile.touch ? touchDragger(page) : mouseDragger(page));
    /**
     * Scrolls the list so the two rows sit around its middle: a drop target
     * near the list's edge would scroll the list under the pointer.
     */
    const frame = async (source, target) => {
      await source.evaluate((node, other) => {
        const list = document.getElementById("conv-list");
        const a = node.getBoundingClientRect();
        const b = other.getBoundingClientRect();
        const box = list.getBoundingClientRect();
        list.scrollTop += (Math.min(a.top, b.top) + Math.max(a.bottom, b.bottom)) / 2 - (box.top + box.height / 2);
      }, await target.elementHandle());
    };
    /** One drag from the middle of `source` to `fraction` of `target`'s height. */
    const drag = async (page, source, target, fraction) => {
      await frame(source, target);
      const hand = await dragger(page);
      await hand.begin(await pointIn(source));
      await expect(page.locator(".conv-drag-ghost")).toHaveCount(1);
      await hand.move(await pointIn(target, fraction));
      await hand.end();
      await expect(page.locator(".conv-drag-ghost")).toHaveCount(0);
    };
    const openApp = async (page) => {
      const folds = JSON.stringify({ [groups.alpha]: "open", [groups.beta]: "open", [groups.gamma]: "folded" });
      await page.addInitScript((value) => { localStorage.setItem("copilot_conv_group_folds", value); }, folds);
      await page.goto(`${relay.baseUrl}/?token=${encodeURIComponent(relay.token)}`);
      await page.waitForLoadState("networkidle");
      await page.waitForFunction(() => typeof window.openConversation === "function");
      if (profile.touch) await page.evaluate(() => window.toggleSidebar?.(true));
      await expect(row(page, ids.loose1)).toBeVisible();
      // The drawer slides in: a finger placed before it stops lands beside the row.
      const list = page.locator("#conv-list");
      await expect.poll(async () => {
        const before = await list.boundingBox();
        await sleep(120);
        const after = await list.boundingBox();
        return !!before && !!after && before.x === after.x && after.x >= 0;
      }).toBe(true);
    };

    test.beforeAll(async () => {
      test.setTimeout(120_000);
      relay = await startRelayServer({ token: randomUUID() });
      // Older chats first, so the ones the tests move sit at the top.
      for (let index = 1; index <= FILLER_COUNT; index += 1) {
        ids[`filler${index}`] = await makeChat(`Filler chat ${String(index).padStart(2, "0")}`);
      }
      await sleep(1100);
      for (const name of ["alpha1", "alpha2", "alpha3", "beta1", "beta2", "gamma1"]) {
        ids[name] = await makeChat(`Batch chat ${name}`);
      }
      groups.alpha = await makeGroup("Alpha batch", [ids.alpha1, ids.alpha2, ids.alpha3]);
      groups.beta = await makeGroup("Beta batch", [ids.beta1, ids.beta2]);
      groups.gamma = await makeGroup("Gamma batch", [ids.gamma1]);
      for (let index = 1; index <= 6; index += 1) ids[`loose${index}`] = await makeChat(`Loose chat ${index}`);
    });

    test.afterAll(async () => {
      if (relay) await relay.stop();
      relay = null;
    });

    test("a member dragged within its group takes the place shown, and a second page follows", async ({ page }) => {
      await openApp(page);
      const other = await page.context().newPage();
      await openApp(other);
      const title = await page.locator("#chat-title").textContent();
      const before = await membersInList(page, groups.alpha);
      expect(before).toHaveLength(3);
      // The last member onto the upper part of the first: it goes first.
      await drag(page, row(page, before[2]), row(page, before[0]), 0.2);
      const expected = [before[2], before[0], before[1]];
      await expect.poll(() => membersInList(page, groups.alpha)).toEqual(expected);
      const rows = await relayRows();
      const positions = expected.map((id) => rows[id].groupPosition);
      expect(positions.every((value) => typeof value === "number"), JSON.stringify(positions)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      await expect(page.locator("#conv-list-announce")).toHaveText(/^Moved “.+” within “Alpha batch”$/);
      // The drop opened nothing.
      await expect(page.locator("#chat-title")).toHaveText(title || "");
      // The other page, through the relay's event.
      await expect.poll(() => membersInList(other, groups.alpha)).toEqual(expected);
      await other.close();
    });

    test("a loose row joins a group where it is dropped", async ({ page }) => {
      await openApp(page);
      const before = await membersInList(page, groups.alpha);
      // The lower part of the first member: right after it.
      await drag(page, row(page, ids.loose1), row(page, before[0]), 0.8);
      await expect.poll(() => membersInList(page, groups.alpha)).toEqual([before[0], ids.loose1, before[1], before[2]]);
      expect(await groupOf(ids.loose1)).toBe(groups.alpha);
      await expect(page.locator("#conv-list-announce")).toHaveText(/^Moved “Loose chat 1” to “Alpha batch”$/);
    });

    test("a member dropped onto a loose row leaves its group", async ({ page }) => {
      await openApp(page);
      await drag(page, row(page, ids.loose1), row(page, ids.loose2), 0.1);
      await expect.poll(() => groupOf(ids.loose1)).toBe(null);
      await expect(row(page, ids.loose1)).not.toHaveClass(/conv-group-member/);
      await expect(page.locator("#conv-list-announce")).toHaveText("Removed “Loose chat 1” from its group");
    });

    test("a member dropped onto another group's head moves to the top of that group", async ({ page }) => {
      await openApp(page);
      await drag(page, row(page, ids.beta1), head(page, groups.alpha), 0.8);
      await expect.poll(() => groupOf(ids.beta1)).toBe(groups.alpha);
      await expect.poll(async () => (await membersInList(page, groups.alpha))[0]).toBe(ids.beta1);
      expect(await membersInList(page, groups.beta)).toEqual([ids.beta2]);
    });

    test("a loose row dropped onto the middle of another makes a new group of the two, shown open", async ({ page }) => {
      await openApp(page);
      await drag(page, row(page, ids.loose3), row(page, ids.loose4), 0.5);
      await expect.poll(() => groupOf(ids.loose3)).not.toBe(null);
      const newGroup = await groupOf(ids.loose3);
      expect(await groupOf(ids.loose4)).toBe(newGroup);
      expect([groups.alpha, groups.beta, groups.gamma]).not.toContain(newGroup);
      await expect(head(page, newGroup)).toBeVisible();
      await expect.poll(async () => (await membersInList(page, newGroup)).sort()).toEqual([ids.loose3, ids.loose4].sort());
      await expect(page.locator("#conv-list-announce")).toHaveText("New group with “Loose chat 4” and “Loose chat 3”");
    });

    test("a folded head opens under a waiting drag, and folds again when the row went elsewhere", async ({ page }) => {
      await openApp(page);
      await expect(row(page, ids.gamma1)).toHaveCount(0);
      await frame(row(page, ids.loose5), head(page, groups.gamma));
      // Hovered, then let go on a loose row's edge (nothing happens there).
      let hand = await dragger(page);
      await hand.begin(await pointIn(row(page, ids.loose5)));
      await hand.move(await pointIn(head(page, groups.gamma), 0.3));
      await sleep(UNFOLD_WAIT_MS);
      await expect(row(page, ids.gamma1)).toHaveCount(1);
      await hand.move(await pointIn(row(page, ids.loose6), 0.1));
      await hand.end();
      await expect(row(page, ids.gamma1)).toHaveCount(0);
      expect(await groupOf(ids.loose5)).toBe(null);
      // Hovered, then dropped under its member: it goes in and the group stays open.
      await frame(row(page, ids.loose5), head(page, groups.gamma));
      hand = await dragger(page);
      await hand.begin(await pointIn(row(page, ids.loose5)));
      await hand.move(await pointIn(head(page, groups.gamma), 0.3));
      await sleep(UNFOLD_WAIT_MS);
      await hand.move(await pointIn(row(page, ids.gamma1), 0.8));
      await hand.end();
      await expect.poll(() => groupOf(ids.loose5)).toBe(groups.gamma);
      await expect.poll(() => membersInList(page, groups.gamma)).toEqual([ids.gamma1, ids.loose5]);
    });

    test("a session created in a hand-ordered group, or moved in by its menu, shows first under the head", async ({ page }, testInfo) => {
      await openApp(page);
      const before = await membersInList(page, groups.alpha);
      const rowsBefore = await relayRows();
      expect(before.every((id) => typeof rowsBefore[id].groupPosition === "number"), "Alpha batch has a hand order").toBe(true);
      // The menu's route (agents' update_session and a clerk's placing use it too).
      const moved = await api(`/api/conversation/${encodeURIComponent(ids.loose4)}/group`, { method: "PUT", body: { groupId: groups.alpha } });
      expect(moved.status, JSON.stringify(moved.payload)).toBe(200);
      await expect.poll(() => membersInList(page, groups.alpha)).toEqual([ids.loose4, ...before]);
      // A session started with the group chosen (create_session's `group`).
      const bootstrap = await api("/api/conversation/bootstrap", { method: "POST", body: { title: "Started in Alpha batch", model: "gpt-5.4-mini", group: groups.alpha } });
      expect(bootstrap.status, JSON.stringify(bootstrap.payload)).toBe(200);
      const created = bootstrap.payload.conversationId;
      expect(await groupOf(created)).toBe(groups.alpha);
      // The row is listed once it has a message and a reply, as the other chats here.
      const queued = await api("/api/message", { method: "POST", body: { conversationId: created, text: "Started in Alpha batch", relayMode: "agent", model: "gpt-5.4-mini" } });
      expect(queued.status, JSON.stringify(queued.payload)).toBe(200);
      const replied = await api("/api/response", { method: "POST", body: { messageId: queued.payload.messageId, conversationId: created, text: "reply", model: "gpt-5.4-mini", mode: "agent" } });
      expect(replied.status).toBe(200);
      await expect.poll(() => membersInList(page, groups.alpha)).toEqual([created, ids.loose4, ...before]);
      const rows = await relayRows();
      expect(rows[created].groupPosition).toBeLessThan(rows[ids.loose4].groupPosition);
      expect(rows[ids.loose4].groupPosition).toBeLessThan(Math.min(...before.map((id) => rows[id].groupPosition)));
      await page.screenshot({ path: testInfo.outputPath(`group-new-on-top-${profile.name}.png`) });
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
      await page.screenshot({ path: testInfo.outputPath(`group-new-on-top-${profile.name}-light.png`) });
      await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
    });

    test("Escape gives the row back; the list scrolls by itself near its edge", async ({ page }) => {
      await openApp(page);
      const before = await membersInList(page, groups.alpha);
      await frame(row(page, before[1]), row(page, ids.loose6));
      let hand = await dragger(page);
      await hand.begin(await pointIn(row(page, before[1])));
      await hand.move(await pointIn(row(page, ids.loose6), 0.5));
      await expect(page.locator("#conv-list .conv-drop-before, #conv-list .conv-drop-after")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(page.locator(".conv-drag-ghost")).toHaveCount(0);
      await expect(page.locator("#conv-list .conv-drag-source")).toHaveCount(0);
      await hand.end();
      await sleep(300);
      expect(await groupOf(before[1])).toBe(groups.alpha);
      expect(await membersInList(page, groups.alpha)).toEqual(before);

      // Near the bottom edge the list scrolls down while the row is held.
      const list = page.locator("#conv-list");
      await list.evaluate((node) => { node.scrollTop = 0; });
      const box = await list.boundingBox();
      hand = await dragger(page);
      await hand.begin(await pointIn(row(page, ids.loose6)));
      await hand.move({ x: box.x + Math.min(box.width / 2, 120), y: box.y + box.height - 8 });
      await expect.poll(() => list.evaluate((node) => node.scrollTop), { timeout: 5000 }).toBeGreaterThan(150);
      await page.keyboard.press("Escape");
      await hand.end();
      expect(await groupOf(ids.loose6)).toBe(null);
    });

    test("nothing drags under a filter or in the Archived view", async ({ page }) => {
      await openApp(page);
      await page.locator("#conv-filter-input").fill("Loose chat");
      await expect(head(page, groups.beta)).toHaveCount(0);
      const hand = await dragger(page);
      await hand.begin(await pointIn(row(page, ids.loose6)));
      await hand.move(await pointIn(row(page, ids.loose2), 0.5));
      await expect(page.locator(".conv-drag-ghost")).toHaveCount(0);
      await hand.end();
      // On touch the held row was never dragged: its menu opens on release.
      if (profile.touch) {
        await expect(page.locator(".context-menu")).toBeVisible();
        await page.keyboard.press("Escape");
      }
      expect(await groupOf(ids.loose6)).toBe(null);
      await page.locator("#conv-filter-input").fill("");

      for (const id of [ids.filler1, ids.filler2]) {
        expect((await api(`/api/conversation/${encodeURIComponent(id)}/archive`, { method: "POST", body: {} })).status).toBe(200);
      }
      await page.locator("#conv-archived-toggle").click();
      await expect(row(page, ids.filler1)).toBeVisible();
      const archivedHand = await dragger(page);
      await archivedHand.begin(await pointIn(row(page, ids.filler2)));
      await archivedHand.move(await pointIn(row(page, ids.filler1), 0.5));
      await expect(page.locator(".conv-drag-ghost")).toHaveCount(0);
      await archivedHand.end();
      if (profile.touch) {
        await expect(page.locator(".context-menu")).toBeVisible();
        await page.keyboard.press("Escape");
      }
      const archived = await api("/api/conversations?archived=only&limit=100");
      const byId = Object.fromEntries(archived.payload.conversations.map((entry) => [entry.id, entry]));
      expect(byId[ids.filler1].groupId || null).toBe(null);
      expect(byId[ids.filler2].groupId || null).toBe(null);
      await page.locator("#conv-archived-banner .conv-archived-back").click();
    });

    if (profile.touch) {
      test("a long press released in place opens the menu; a plain swipe scrolls the list", async ({ page }) => {
        await openApp(page);
        const title = await page.locator("#chat-title").textContent();
        const hand = await dragger(page);
        const point = await pointIn(row(page, ids.loose6));
        await hand.begin(point, { hold: false });
        await sleep(700);
        await expect(page.locator(".context-menu")).toHaveCount(0);
        await expect(row(page, ids.loose6)).toHaveClass(/conv-drag-lifted/);
        await hand.end();
        const menu = page.locator(".context-menu");
        await expect(menu).toBeVisible();
        await expect(menu.locator('[data-menu-item="group-add"]')).toBeVisible();
        await expect(page.locator("#chat-title")).toHaveText(title || "");
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0);

        // A swipe: no hold, the finger moves at once.
        const list = page.locator("#conv-list");
        await list.evaluate((node) => { node.scrollTop = 0; });
        const start = await pointIn(row(page, ids.loose6));
        const swipe = await dragger(page);
        await swipe.begin({ x: start.x, y: start.y + 300 }, { hold: false });
        await swipe.move({ x: start.x, y: start.y }, 10);
        await swipe.end();
        await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(50);
        await sleep(700);
        await expect(page.locator(".context-menu")).toHaveCount(0);
        await expect(page.locator(".conv-drag-ghost")).toHaveCount(0);
      });
    } else {
      test("a click without a move still opens the conversation", async ({ page }) => {
        await openApp(page);
        await row(page, ids.loose2).click();
        await expect(page.locator("#chat-title")).toHaveText("Loose chat 2");
      });
    }
  });
}
