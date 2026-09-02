import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// Repo browser: reopen persistence + the file-explorer CWD pick mode.
//
// Every tree payload is stubbed via page.route, so these specs never read the
// host filesystem and no host path can leak into an assertion.
// platform-agnostic: the stub paths below are opaque strings to the client —
// they never reach host path semantics.

const WORKSPACE_TREE = {
  ok: true,
  rootName: "repo",
  rootPath: null,
  includeHidden: false,
  includeHeavy: false,
  nodeCount: 3,
  maxNodes: 5000,
  truncated: false,
  root: {
    path: "",
    name: "repo",
    type: "dir",
    childrenLoaded: true,
    lazy: false,
    children: [
      { path: "alpha", name: "alpha", type: "dir", children: [], childrenLoaded: false, lazy: true },
      { path: "docs", name: "docs", type: "dir", children: [], childrenLoaded: false, lazy: true },
    ],
  },
};

function workspaceChildren(pathValue) {
  if (pathValue === "alpha") {
    return {
      ok: true,
      node: {
        path: "alpha",
        name: "alpha",
        type: "dir",
        childrenLoaded: true,
        lazy: false,
        children: [
          { path: "alpha/beta", name: "beta", type: "dir", children: [], childrenLoaded: false, lazy: true },
          { path: "alpha/readme.md", name: "readme.md", type: "file", size: 12, previewKind: "markdown", ext: ".md" },
        ],
      },
    };
  }
  return {
    ok: true,
    node: {
      path: pathValue,
      name: pathValue.split("/").pop() || pathValue,
      type: "dir",
      childrenLoaded: true,
      lazy: false,
      children: [],
    },
  };
}

const DRIVES_ROOT = {
  ok: true,
  rootName: "Drives",
  root: {
    path: "/",
    name: "/",
    type: "dir",
    childrenLoaded: true,
    lazy: false,
    children: [
      { path: "/data", name: "data", type: "dir", children: [], childrenLoaded: false, lazy: true },
      { path: "/srv", name: "srv", type: "dir", children: [], childrenLoaded: false, lazy: true },
    ],
  },
};

function driveChildren(pathValue) {
  return {
    ok: true,
    node: {
      path: pathValue,
      name: pathValue.split("/").pop() || pathValue,
      type: "dir",
      childrenLoaded: true,
      lazy: false,
      children: [],
    },
  };
}

test.describe("Repo browser reopen persistence and CWD pick mode", () => {
  const token = relayToken();

  test.beforeEach(async ({ page }) => {
    await page.route("**/api/repo/tree*", (route) => route.fulfill({ json: WORKSPACE_TREE }));
    await page.route("**/api/repo/list*", (route) => {
      const url = new URL(route.request().url());
      return route.fulfill({ json: workspaceChildren(url.searchParams.get("path") || "") });
    });
    await page.route("**/api/drives/roots*", (route) => route.fulfill({ json: DRIVES_ROOT }));
    await page.route("**/api/drives/list*", (route) => {
      const url = new URL(route.request().url());
      return route.fulfill({ json: driveChildren(url.searchParams.get("path") || "") });
    });
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
  });

  test("reopening the browser keeps loaded branches without a manual Refresh", async ({ page }) => {
    await page.evaluate(() => window.openRepoBrowser());
    const modal = page.locator("#repo-browser-modal");
    await expect(modal).toHaveClass(/visible/);

    // Browse into alpha: its children load lazily.
    await page.locator('#repo-tree [data-repo-open-dir="alpha"]').click();
    await expect(page.locator('#repo-tree [data-repo-open-dir="alpha/beta"]')).toBeVisible();
    await expect(page.locator("#repo-folder")).toContainText("readme.md");

    await page.locator(".repo-browser-close").click();
    await expect(modal).not.toHaveClass(/visible/);

    // The screenshot bug: reopening refetched the lazy tree and stranded the
    // still-expanded selection on placeholders until the Refresh button.
    await page.evaluate(() => window.openRepoBrowser());
    await expect(modal).toHaveClass(/visible/);
    // alpha/beta visible again proves the branch was re-fetched, not left as a
    // placeholder; readme.md in the folder pane proves the selection loaded too.
    await expect(page.locator('#repo-tree [data-repo-open-dir="alpha/beta"]')).toBeVisible();
    await expect(page.locator("#repo-folder")).toContainText("readme.md");
    await expect(page.locator("#repo-folder")).not.toContainText("Open this folder to load entries");
  });

  test("New chat modal: browse button picks a folder from the global tree", async ({ page }) => {
    await page.locator("#new-conv-btn").click();
    await expect(page.locator("#new-conversation-model-modal")).toHaveClass(/visible/);

    await page.locator("#new-conversation-cwd-browse").click();
    const modal = page.locator("#repo-browser-modal");
    await expect(modal).toHaveClass(/visible/);
    await expect(modal).toHaveClass(/cwd-pick-mode/);
    await expect(page.locator("#repo-cwd-pick-bar")).toBeVisible();

    await page.locator('#repo-tree [data-repo-open-dir="/data"]').click();
    await expect(page.locator("#repo-cwd-pick-path")).toContainText("/data");
    await page.locator("#repo-cwd-pick-confirm").click();

    await expect(modal).not.toHaveClass(/visible/);
    await expect(page.locator("#new-conversation-cwd-select")).toHaveValue("__custom__");
    const manual = page.locator("#new-conversation-cwd-manual");
    await expect(manual).toBeVisible();
    await expect(manual).toHaveValue("/data");
    await expect(page.locator("#new-conversation-cwd-status")).toContainText("/data");
  });

  test("Change CWD modal: browse button fills the manual path", async ({ page }) => {
    await page.evaluate(() => window.openChangeCwdModal());
    await expect(page.locator("#summary-modal")).toHaveClass(/visible/);

    await page.locator("#change-cwd-browse-btn").click();
    const modal = page.locator("#repo-browser-modal");
    await expect(modal).toHaveClass(/visible/);
    await expect(modal).toHaveClass(/cwd-pick-mode/);

    await page.locator('#repo-tree [data-repo-open-dir="/data"]').click();
    await page.locator("#repo-cwd-pick-confirm").click();

    await expect(modal).not.toHaveClass(/visible/);
    // The Change CWD modal stayed open underneath and received the path.
    await expect(page.locator("#summary-modal")).toHaveClass(/visible/);
    await expect(page.locator("#change-cwd-manual-path")).toHaveValue("/data");
    await expect(page.locator("#change-cwd-details")).toContainText("/data");
  });

  test("a plain open after a pick shows no pick bar", async ({ page }) => {
    await page.evaluate(() => window.openChangeCwdModal());
    await page.locator("#change-cwd-browse-btn").click();
    await page.locator('#repo-tree [data-repo-open-dir="/data"]').click();
    await page.locator("#repo-cwd-pick-confirm").click();
    await page.evaluate(() => window.closeSummaryModal());

    await page.evaluate(() => window.openRepoBrowser());
    const modal = page.locator("#repo-browser-modal");
    await expect(modal).toHaveClass(/visible/);
    await expect(modal).not.toHaveClass(/cwd-pick-mode/);
    await expect(page.locator("#repo-cwd-pick-bar")).toBeHidden();
  });
});
