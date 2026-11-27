import { expect, test } from "@playwright/test";

/**
 * The relay itself: the versioned browser libraries are kept by the browser
 * (their path carries the version), the page and the rest of the shell are
 * not, and the CDN headers stay no-store for both.
 */
test("vendor files are cached immutably and the shell is not", async ({ request }) => {
  const vendor = await request.get("/vendor/katex@0.19.1/dist/fonts/KaTeX_Main-Regular.woff2");
  expect(vendor.status()).toBe(200);
  expect(vendor.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(vendor.headers()["cdn-cache-control"]).toBe("no-store");

  for (const route of ["/", "/index.html", "/sw.js", "/app-icon.svg", "/app/bootstrap.js"]) {
    const response = await request.get(route);
    expect(response.status(), route).toBe(200);
    expect(response.headers()["cache-control"], route).toBe("no-store");
  }
});
