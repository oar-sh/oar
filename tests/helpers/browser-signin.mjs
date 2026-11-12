import fs from "node:fs";
import path from "node:path";

import { expect } from "@playwright/test";

import { mintAgentTokenWithKey } from "../../shared/relay-credentials.mjs";

// Shared steps of the security UX specs (agent auth §13.5): calls to a test
// relay with its token, a page signed in by a single-use sign-in code (never
// `?token=` in the address), the app ready. No value of a token, code,
// cookie or session key is ever printed: a failed call reports its status
// and route only.

// Where the app keeps the session's proof key (app/session-proof.mjs): the
// relay wants it next to the cookie on every API call.
const SESSION_PROOF_HEADER = "X-OAR-Session-Proof";
const SESSION_PROOF_STORAGE_KEY = "oar_session_proof";
const SESSION_PROOF_DB_NAME = "oar-session-proof";
const SESSION_PROOF_DB_STORE = "proof";
const SESSION_PROOF_DB_KEY = "current";

/** `(route, { method, body, headers }) → { status, payload }` with the relay's token. */
export function apiOf(relay) {
  return async (route, { method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method,
      headers: { Authorization: `Bearer ${relay.token}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json().catch(() => null) };
  };
}

/**
 * An API call from inside `page`, as the app makes it: the page's cookie
 * and the session's proof key from its localStorage. `route` is relative to
 * the page (`api/auth/notices`). `{ status, payload }`.
 */
export async function pageApi(page, route, { method = "GET", body } = {}) {
  return page.evaluate(async ({ route: path, method: verb, body: data, header, storageKey }) => {
    const response = await fetch(path, {
      method: verb,
      credentials: "same-origin",
      headers: { "content-type": "application/json", [header]: localStorage.getItem(storageKey) || "" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, payload: await response.json().catch(() => null) };
  }, { route, method, body, header: SESSION_PROOF_HEADER, storageKey: SESSION_PROOF_STORAGE_KEY });
}

/**
 * Forgets the session's proof key of `origin` in `context` (localStorage and
 * the service worker's IndexedDB copy) and keeps its cookie: a browser with
 * the cookie and no key, as after its site data was half cleared. Done on a
 * static file of that origin, so no app starts there meanwhile.
 */
export async function dropSessionProof(context, origin) {
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/sw.js`);
    await page.evaluate(async ({ storageKey, dbName, dbStore, dbKey }) => {
      localStorage.removeItem(storageKey);
      await new Promise((resolve) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(dbStore)) request.result.createObjectStore(dbStore);
        };
        request.onerror = () => resolve();
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(dbStore, "readwrite");
          tx.objectStore(dbStore).delete(dbKey);
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); resolve(); };
        };
      });
    }, { storageKey: SESSION_PROOF_STORAGE_KEY, dbName: SESSION_PROOF_DB_NAME, dbStore: SESSION_PROOF_DB_STORE, dbKey: SESSION_PROOF_DB_KEY });
  } finally {
    await page.close();
  }
}

/** A fresh single-use sign-in code of `relay` (the person's route). */
export async function mintSignInCode(relay) {
  const { status, payload } = await apiOf(relay)("/api/auth/signin-codes", { method: "POST", body: {} });
  expect(status, "POST /api/auth/signin-codes").toBe(200);
  expect(typeof payload?.code, "a code came back").toBe("string");
  return payload.code;
}

/** The app is up and the sign-in box gone. */
export async function waitForApp(page) {
  await page.waitForFunction(() => typeof window.openSettingsModal === "function");
  await expect(page.locator("#app")).toHaveClass(/visible/);
  await expect(page.locator("#auth-gate")).toBeHidden();
}

/**
 * Signs `page` in to `relay` at `origin` (its base URL, or another name for
 * it such as `http://localhost:<port>`) with a sign-in code. `extra`: more
 * query parameters, kept in the address after the code leaves it.
 */
export async function signInByCode(page, relay, { origin = relay.baseUrl, extra = "" } = {}) {
  const code = await mintSignInCode(relay);
  await page.goto(`${origin}/?signin=${encodeURIComponent(code)}${extra ? `&${extra}` : ""}`);
  await waitForApp(page);
  expect(new URL(page.url()).searchParams.has("signin"), "the code left the address").toBe(false);
  // The code's sign-in answered the session's key, and the page kept it.
  expect(await page.evaluate((key) => /^oark1_/.test(localStorage.getItem(key) || ""), SESSION_PROOF_STORAGE_KEY), "the session key was kept").toBe(true);
}

/** `http://localhost:<port>`: the same relay under another site, with its own cookie jar. */
export function localhostOrigin(relay) {
  return `http://localhost:${relay.port}`;
}

function findFile(root, name, depth = 4) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory() && depth > 0) {
      const found = findFile(full, name, depth - 1);
      if (found) return found;
    }
  }
  return "";
}

/**
 * The `oar` command's own agent token (the `cli` kind), as `oar agent-token`
 * derives it from the relay's agent key; for the terminal sign-in route.
 */
export function cliAgentToken(relay) {
  const file = findFile(relay.stateRoot, "relay-secrets.json");
  if (!file) throw new Error("The test relay has no secrets file yet");
  const { agentKey } = JSON.parse(fs.readFileSync(file, "utf8"));
  return mintAgentTokenWithKey(agentKey, { kind: "c" });
}

/** The Inbox open in the page (the sidebar drawer opened first on a narrow page). */
export async function openInbox(page) {
  const button = page.locator("#inbox-btn");
  const reachable = () => button.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    if (!rect.width || rect.left < 0 || rect.right > window.innerWidth) return false;
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(top && (top === node || node.contains(top)));
  });
  await expect(page.locator("#startup-loading")).toHaveCount(0);
  if (!(await reachable())) await page.locator("#sidebar-toggle").click();
  await expect.poll(reachable).toBe(true);
  await button.click();
  await expect(page.locator(".inbox-view")).toBeVisible();
}
