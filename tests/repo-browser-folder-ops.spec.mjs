import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// Explorer edits: the New-folder row, in-place rename and the delete
// confirmation, driven through the context menu and the toolbar.
//
// Every listing and every write is stubbed via page.route against an in-memory
// tree, so these specs never touch the host filesystem and no host path can
// leak into an assertion.
// platform-agnostic: the stub paths below are opaque strings to the client.
// Only the CWD pick joins one with the relay's real workspace root, and a
// drive-letter root makes that a native path with `\`, so those assertions
// accept either separator.

function makeTree() {
  // path -> { type, children: [names] } for the workspace stub.
  return new Map([
    ["", { type: "dir", children: ["alpha", "docs", "notes.md"] }],
    ["alpha", { type: "dir", children: ["beta", "readme.md"] }],
    ["alpha/beta", { type: "dir", children: ["leaf.txt"] }],
    ["alpha/beta/leaf.txt", { type: "file" }],
    ["alpha/readme.md", { type: "file" }],
    ["docs", { type: "dir", children: [] }],
    ["notes.md", { type: "file" }],
  ]);
}

function nodeFor(tree, pathValue) {
  const entry = tree.get(pathValue);
  const name = pathValue.split("/").pop() || "repo";
  if (!entry || entry.type !== "dir") return null;
  return {
    path: pathValue,
    name,
    type: "dir",
    childrenLoaded: true,
    lazy: false,
    children: entry.children.map((childName) => {
      const childPath = pathValue ? `${pathValue}/${childName}` : childName;
      const child = tree.get(childPath);
      return child.type === "dir"
        ? { path: childPath, name: childName, type: "dir", children: [], childrenLoaded: false, lazy: true }
        : { path: childPath, name: childName, type: "file", size: 12, previewKind: "code", ext: `.${childName.split(".").pop()}` };
    }),
  };
}

function removeSubtree(tree, pathValue) {
  for (const key of [...tree.keys()]) {
    if (key === pathValue || key.startsWith(`${pathValue}/`)) tree.delete(key);
  }
}

function parentOf(pathValue) {
  const index = pathValue.lastIndexOf("/");
  return index === -1 ? "" : pathValue.slice(0, index);
}

// The write routes, with the same answers the relay gives.
function installStubs(page, tree, log) {
  const json = (route, body, status = 200) => route.fulfill({ status, json: body });
  return Promise.all([
    page.route("**/api/repo/tree*", (route) => json(route, { ok: true, rootName: "repo", nodeCount: 1, maxNodes: 5000, truncated: false, root: nodeFor(tree, "") })),
    page.route("**/api/repo/list*", (route) => {
      const url = new URL(route.request().url());
      return json(route, { ok: true, node: nodeFor(tree, url.searchParams.get("path") || "") });
    }),
    page.route("**/api/repo/mkdir", (route) => {
      const body = route.request().postDataJSON();
      log.push(["mkdir", body]);
      const target = body.path ? `${body.path}/${body.name}` : body.name;
      if (tree.has(target)) return json(route, { error: "That name is already taken" }, 409);
      tree.set(target, { type: "dir", children: [] });
      tree.get(body.path).children.push(body.name);
      return json(route, { ok: true, path: target });
    }),
    page.route("**/api/repo/rename", (route) => {
      const body = route.request().postDataJSON();
      log.push(["rename", body]);
      const parent = parentOf(body.path);
      const target = parent ? `${parent}/${body.newName}` : body.newName;
      if (tree.has(target)) return json(route, { error: "That name is already taken" }, 409);
      const entry = tree.get(body.path);
      for (const key of [...tree.keys()]) {
        if (key === body.path || key.startsWith(`${body.path}/`)) {
          tree.set(target + key.slice(body.path.length), tree.get(key));
          tree.delete(key);
        }
      }
      const siblings = tree.get(parent).children;
      siblings[siblings.indexOf(body.path.split("/").pop())] = body.newName;
      void entry;
      return json(route, { ok: true, path: target });
    }),
    page.route("**/api/repo/delete", (route) => {
      const body = route.request().postDataJSON();
      log.push(["delete", body]);
      const entry = tree.get(body.path);
      if (!entry) return json(route, { error: "Not found" }, 404);
      if (body.dryRun) {
        const below = [...tree.keys()].filter((key) => key.startsWith(`${body.path}/`));
        const dirs = below.filter((key) => tree.get(key).type === "dir").length;
        return json(route, { ok: true, kind: entry.type, files: below.length - dirs, dirs, capped: false });
      }
      removeSubtree(tree, body.path);
      const parent = parentOf(body.path);
      const siblings = tree.get(parent).children;
      siblings.splice(siblings.indexOf(body.path.split("/").pop()), 1);
      return json(route, { ok: true });
    }),
  ]);
}

test.describe("Repo browser folder operations", () => {
  const token = relayToken();
  let tree;
  let log;

  test.beforeEach(async ({ page }) => {
    tree = makeTree();
    log = [];
    await installStubs(page, tree, log);
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => window.openRepoBrowser());
    await expect(page.locator("#repo-browser-modal")).toHaveClass(/visible/);
  });

  test("the toolbar button creates a folder in the open folder and navigates into it", async ({ page }) => {
    await page.locator('#repo-tree [data-repo-open-dir="alpha"]').click();
    await expect(page.locator("#repo-folder")).toContainText("readme.md");

    await page.locator("#repo-new-folder-btn").click();
    const input = page.locator("#repo-folder [data-repo-new-folder-input]");
    await expect(input).toBeFocused();

    // An empty name is refused in place; a taken name shows the relay's message.
    await input.press("Enter");
    await expect(page.locator(".repo-inline-edit-error")).toHaveText("Enter a name");
    await input.fill("beta");
    await input.press("Enter");
    await expect(page.locator(".repo-inline-edit-error")).toHaveText("That name is already taken");

    await input.fill("gamma");
    await input.press("Enter");
    await expect(page.locator('#repo-tree [data-repo-open-dir="alpha/gamma"]')).toBeVisible();
    await expect(page.locator('#repo-tree [data-repo-open-dir="alpha/gamma"]')).toHaveClass(/active/);
    await expect(page.locator("#repo-folder-breadcrumb")).toContainText("gamma");
    await expect(page.locator("#repo-folder [data-repo-new-folder-input]")).toHaveCount(0);
    expect(log.filter(([op]) => op === "mkdir").map(([, body]) => [body.path, body.name])).toEqual([["alpha", "beta"], ["alpha", "gamma"]]);
  });

  test("Escape cancels the New-folder row without closing the explorer", async ({ page }) => {
    await page.locator("#repo-new-folder-btn").click();
    const input = page.locator("#repo-folder [data-repo-new-folder-input]");
    await input.fill("half-typed");
    await input.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(page.locator("#repo-browser-modal")).toHaveClass(/visible/);
    expect(log).toEqual([]);
  });

  test("the context menu renames a folder in place and keeps the selection below it", async ({ page }) => {
    await page.locator('#repo-tree [data-repo-open-dir="alpha"]').click();
    await page.locator('#repo-tree [data-repo-open-dir="alpha/beta"]').click();
    await expect(page.locator("#repo-folder")).toContainText("leaf.txt");

    await page.locator('#repo-tree [data-repo-open-dir="alpha/beta"]').click({ button: "right" });
    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();
    await menu.locator('[data-menu-item="rename"]').click();

    const input = page.locator('#repo-tree [data-repo-rename-input]');
    await expect(input).toBeFocused();
    await input.fill("delta");
    await input.press("Enter");

    await expect(page.locator('#repo-tree [data-repo-open-dir="alpha/delta"]')).toBeVisible();
    await expect(page.locator('#repo-tree [data-repo-open-dir="alpha/delta"]')).toHaveClass(/active/);
    await expect(page.locator('#repo-tree [data-repo-open-dir="alpha/beta"]')).toHaveCount(0);
    await expect(page.locator("#repo-folder")).toContainText("leaf.txt");
    expect(log.filter(([op]) => op === "rename").map(([, body]) => [body.path, body.newName])).toEqual([["alpha/beta", "delta"]]);
  });

  test("a file is renamed from the folder pane and an unchanged name is a cancel", async ({ page }) => {
    await page.locator('#repo-tree [data-repo-open-dir="alpha"]').click();
    const row = page.locator('#repo-folder [data-repo-open-file="alpha/readme.md"]');
    await row.click({ button: "right" });
    await page.locator('.context-menu [data-menu-item="rename"]').click();
    const input = page.locator('#repo-folder [data-repo-rename-input]');
    await expect(input).toBeFocused();
    await input.press("Enter");
    await expect(input).toHaveCount(0);
    expect(log.filter(([op]) => op === "rename")).toEqual([]);

    // The rename row focuses itself and selects the stem on the next frame.
    // A fill that ran first had that selection land in the middle of it, and
    // replaced the stem alone: "guide.md.md". Typing starts once it is focused.
    await row.click({ button: "right" });
    await page.locator('.context-menu [data-menu-item="rename"]').click();
    await expect(input).toBeFocused();
    await input.fill("guide.md");
    await input.press("Enter");
    await expect(page.locator('#repo-folder [data-repo-open-file="alpha/guide.md"]')).toBeVisible();
    await expect(page.locator("#file-preview-modal")).not.toHaveClass(/visible/);
  });

  test("deleting a non-empty folder needs its name typed; the modal closes and the tree updates", async ({ page }) => {
    await page.locator('#repo-tree [data-repo-open-dir="alpha"]').click({ button: "right" });
    await page.locator('.context-menu [data-menu-item="delete"]').click();

    const modal = page.locator("#summary-modal");
    await expect(modal).toHaveClass(/visible/);
    await expect(modal).toContainText("2 files and 1 folder");
    const confirm = modal.locator("[data-repo-delete-confirm]");
    await expect(confirm).toBeDisabled();

    const nameInput = modal.locator("[data-repo-delete-confirm-input]");
    await nameInput.fill("alpha");
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(modal).not.toHaveClass(/visible/);
    await expect(page.locator('#repo-tree [data-repo-open-dir="alpha"]')).toHaveCount(0);
    await expect(page.locator('#repo-tree [data-repo-open-dir="docs"]')).toBeVisible();
    expect(log.filter(([op, body]) => op === "delete" && !body.dryRun).map(([, body]) => body.path)).toEqual(["alpha"]);
  });

  test("deleting a file asks once and needs no typed name", async ({ page }) => {
    await page.locator('#repo-folder [data-repo-open-file="notes.md"]').click({ button: "right" });
    await page.locator('.context-menu [data-menu-item="delete"]').click();
    const modal = page.locator("#summary-modal");
    await expect(modal).toContainText("Delete the file");
    await expect(modal.locator("[data-repo-delete-confirm-input]")).toHaveCount(0);
    await modal.locator("[data-repo-delete-confirm]").click();
    await expect(modal).not.toHaveClass(/visible/);
    await expect(page.locator('#repo-folder [data-repo-open-file="notes.md"]')).toHaveCount(0);
  });

  test("in CWD-pick mode a new folder can be created and picked, but not renamed or deleted", async ({ page }) => {
    await page.locator(".repo-browser-close").click();
    await page.evaluate(() => window.openChangeCwdModal());
    await page.locator("#change-cwd-browse-btn").click();
    const explorer = page.locator("#repo-browser-modal");
    await expect(explorer).toHaveClass(/cwd-pick-mode/);
    // The picker opens on the drives root; this spec stubs the workspace tree.
    await page.locator("#repo-root-workspace-btn").click();
    await page.locator('#repo-tree [data-repo-open-dir="docs"]').click();

    await page.locator('#repo-tree [data-repo-open-dir="docs"]').click({ button: "right" });
    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-menu-item="rename"]')).toHaveCount(0);
    await expect(menu.locator('[data-menu-item="delete"]')).toHaveCount(0);
    await menu.locator('[data-menu-item="new-folder"]').click();

    const input = page.locator("#repo-folder [data-repo-new-folder-input]");
    await input.fill("project");
    await input.press("Enter");
    await expect(page.locator("#repo-cwd-pick-path")).toContainText(/docs[\\/]project/);
    await page.locator("#repo-cwd-pick-confirm").click();
    await expect(explorer).not.toHaveClass(/visible/);
    await expect(page.locator("#change-cwd-manual-path")).toHaveValue(/docs[\\/]project$/);
  });
});
