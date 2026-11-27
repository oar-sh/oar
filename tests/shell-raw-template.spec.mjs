import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { relayBaseUrl } from "./e2e-env.mjs";

/*
 * The page template is only ever sent rendered, by the app shell routes. Other
 * spellings of its path must not reach the static handler's copy, which has
 * no page policy and would work out its base path from the address. Every
 * request the page makes stays on the relay's origin, and no script from
 * another host runs.
 */

const SPELLINGS = [
  "//index.html",
  "/%69ndex.html",
  "/app/..%2Findex.html",
  "//elsewhere.test/..%2Findex.html",
  "//elsewhere.test/..%2F..%2Findex.html",
  "/%5Celsewhere.test/..%2Findex.html",
];

for (const spelling of SPELLINGS) {
  test(`the raw template is not served at ${spelling}`, async ({ page }) => {
    const origin = new URL(relayBaseUrl()).origin;
    const offOrigin = [];
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (new URL(url).origin !== origin) {
        offOrigin.push(url);
        // What another host would answer: a script that marks the page.
        return route.fulfill({ status: 200, contentType: "text/javascript", body: "window.__fromElsewhere = true;" });
      }
      return route.continue();
    });

    const response = await page.goto(`${origin}${spelling}`, { waitUntil: "load" });
    const status = response ? response.status() : 0;
    const body = response ? await response.text() : "";

    expect(body, "the raw template").not.toContain("__COPILOT_APP_CONFIG");
    expect(status, "status").not.toBe(200);
    expect(offOrigin, "requests to another origin").toEqual([]);
    expect(await page.evaluate(() => window.__fromElsewhere === true)).toBe(false);
  });
}

/*
 * The template's own base path handling, should a page with it ever be served
 * again: the template is handed to the browser directly (the relay no longer
 * sends it raw). A hostile address, and a hostile configured base, must both
 * leave every request on this origin, although the page writes the base into
 * HTML where the parser decodes character references.
 */
const TEMPLATE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "public", "index.html"),
  "utf8",
);
const CONFIG_LINE = "window.__COPILOT_APP_CONFIG = { basePath: '' };";

const HOSTILE = [
  { name: "address", pagePath: "/&sol;elsewhere.test/x", basePath: "" },
  { name: "address, backslash reference", pagePath: "/&bsol;elsewhere.test/x", basePath: "" },
  { name: "configured base", pagePath: "/probe-configured/", basePath: "/&sol;elsewhere.test/x" },
];

for (const { name, pagePath, basePath } of HOSTILE) {
  test(`a hostile base path (${name}) keeps every request on this origin`, async ({ page }) => {
    expect(TEMPLATE).toContain(CONFIG_LINE);
    const origin = new URL(relayBaseUrl()).origin;
    const pageUrl = new URL(pagePath, origin).href;
    const html = TEMPLATE.replace(CONFIG_LINE, `window.__COPILOT_APP_CONFIG = { basePath: ${JSON.stringify(basePath)} };`);
    const offOrigin = [];
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (new URL(url).origin !== origin) {
        offOrigin.push(url);
        return route.fulfill({ status: 200, contentType: "text/javascript", body: "window.__fromElsewhere = true;" });
      }
      if (url === pageUrl) return route.fulfill({ status: 200, contentType: "text/html", body: html });
      return route.continue();
    });

    await page.goto(pageUrl, { waitUntil: "load" });
    expect(new URL(page.url()).pathname).toBe(new URL(pageUrl).pathname);
    expect(offOrigin, "requests to another origin").toEqual([]);
    expect(await page.evaluate(() => window.__fromElsewhere === true)).toBe(false);
    const sources = await page.evaluate(() => [...document.querySelectorAll("script[src], link[href]")].map((el) => el.src || el.href));
    expect(sources.length).toBeGreaterThan(5);
    for (const source of sources) expect(new URL(source).origin, source).toBe(origin);
  });
}
