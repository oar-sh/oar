import fs from "fs";
import os from "os";
import path from "path";
import { expect, test } from "@playwright/test";
import { relayToken } from "./e2e-env.mjs";

// A file that changed on disk is downloaded as it is now, under the same
// path: the bytes and their length come from one read, the answers carry
// headers no cache may ignore, and the Download link (address and saved name)
// changes with the file.
//
// The file lives in a temp folder made for the test and is reached through the
// drive route. Its path never appears in an assertion.
// platform-agnostic: the path is built by the host's own path module and only
// handed to the relay, which runs on the same host.

const FIRST = "%PDF-1.4\nfirst version\n";
const SECOND = "%PDF-1.4\nsecond version, written over the first and a good deal longer than it\n";

test.describe("downloading a file that changed", () => {
  const token = relayToken();
  const auth = { Authorization: `Bearer ${token}` };
  let dir = "";
  let filePath = "";
  let webPath = "";

  test.beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "oar-e2e-download-"));
    filePath = path.join(dir, "letter.pdf");
    webPath = filePath.replace(/\\/g, "/");
    fs.writeFileSync(filePath, FIRST);
  });

  test.afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fileUrl = () => `/api/drives/file?path=${encodeURIComponent(webPath)}`;
  const previewUrl = () => `/api/drives/files-preview?path=${encodeURIComponent(webPath)}`;

  function expectNoStore(response) {
    const headers = response.headers();
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["cdn-cache-control"]).toBe("no-store");
    expect(headers["cloudflare-cdn-cache-control"]).toBe("no-store");
  }

  test("the same path yields the new bytes at once, whole, with headers that forbid caching", async ({ request }) => {
    const first = await request.get(fileUrl(), { headers: auth });
    expect(first.status()).toBe(200);
    expect(await first.text()).toBe(FIRST);
    expect(first.headers()["content-length"]).toBe(String(Buffer.byteLength(FIRST)));
    expectNoStore(first);
    const firstTag = first.headers().etag;
    expect(firstTag).toMatch(/^W\/"[0-9a-z]+-[0-9a-z]+"$/);
    expect(first.headers()["last-modified"]).toBeTruthy();

    // Written over and asked for again without a pause: the relay's metadata
    // of the first version is still fresh in its cache at this point.
    fs.writeFileSync(filePath, SECOND);
    const second = await request.get(fileUrl(), { headers: auth });
    expect(second.status()).toBe(200);
    expect(await second.text()).toBe(SECOND);
    expect(second.headers()["content-length"]).toBe(String(Buffer.byteLength(SECOND)));
    expect(second.headers().etag).not.toBe(firstTag);
    expectNoStore(second);

    // A range is cut from the file as it is now.
    const range = await request.get(fileUrl(), { headers: { ...auth, Range: "bytes=9-22" } });
    expect(range.status()).toBe(206);
    expect(await range.text()).toBe(SECOND.slice(9, 23));
    expect(range.headers()["content-range"]).toBe(`bytes 9-22/${Buffer.byteLength(SECOND)}`);
    expectNoStore(range);
  });

  test("answers without a file are not cacheable either", async ({ request }) => {
    fs.rmSync(filePath);
    const missing = await request.get(fileUrl(), { headers: auth });
    expect(missing.status()).toBe(404);
    expectNoStore(missing);

    const unauthenticated = await request.get(fileUrl(), { headers: { Authorization: "Bearer wrong" } });
    expect(unauthenticated.status()).toBe(401);
    expectNoStore(unauthenticated);

    const invalid = await request.get("/api/drives/file?path=", { headers: auth });
    expect(invalid.status()).toBe(400);
    expectNoStore(invalid);
  });

  test("the preview names the file's version, and the version changes with the file", async ({ request }) => {
    const first = await (await request.get(previewUrl(), { headers: auth })).json();
    expect(first.version).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
    expect(first.rawUrl).toContain(`&v=${first.version}`);
    expect(first.mtimeMs).toBeGreaterThan(0);

    fs.writeFileSync(filePath, SECOND);
    const response = await request.get(previewUrl(), { headers: auth });
    expectNoStore(response);
    const second = await response.json();
    expect(second.version).not.toBe(first.version);
    expect(second.size).toBe(Buffer.byteLength(SECOND));
    expect(second.rawUrl).toContain(`&v=${second.version}`);
  });

  test("the Download link gets a new address and a stamped name, and saves the new file", async ({ page }) => {
    await page.goto(`/?token=${encodeURIComponent(token)}`);
    await page.waitForLoadState("networkidle");
    const openPreview = () => page.evaluate(async (target) => {
      const view = await import("/app/attachments-view.js");
      await view.openDriveFilePreview(target);
    }, webPath);
    const link = page.locator("#file-preview-open-raw");
    const versionOf = async () => new URL(await link.getAttribute("href"), "http://relay.invalid").searchParams.get("v");

    await openPreview();
    await expect(link).toHaveAttribute("href", /[?&]v=[0-9a-z]+-[0-9a-z]+/);
    await expect(link).toHaveAttribute("download", /^letter \(\d{4}-\d{4}\)\.pdf$/);
    const firstVersion = await versionOf();

    fs.writeFileSync(filePath, SECOND);
    await openPreview();
    await expect.poll(versionOf).not.toBe(firstVersion);
    const savedAs = await link.getAttribute("download");
    expect(savedAs).toMatch(/^letter \(\d{4}-\d{4}\)\.pdf$/);

    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    expect(download.suggestedFilename()).toBe(savedAs);
    expect(fs.readFileSync(await download.path(), "utf8")).toBe(SECOND);
  });
});
