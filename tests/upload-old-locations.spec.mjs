import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { startRelayServer } from "./relay-server-harness.mjs";

// This spec boots its OWN relay with the data dir chosen by config.json alone
// (no COPILOT_WEB_RELAY_DATA_DIR), the shape of a checkout that points at a
// release install's data. Uploads earlier versions left in <server>/uploads or
// in the state root's uploads/ must still be served after the update, read in
// place: nothing there is moved, copied over or deleted.

const serverUploads = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "uploads");

let relay = null;
const placed = [];

function startRelay(state = null) {
  return startRelayServer({
    token: state ? relay.token : randomUUID(),
    ...(state ? { port: relay.port, state } : {}),
    overrides: ({ stateRoot }) => {
      fs.mkdirSync(path.join(stateRoot, "install", "data"), { recursive: true });
      fs.writeFileSync(
        path.join(stateRoot, "config.json"),
        `${JSON.stringify({ dataDir: path.join(stateRoot, "install", "data"), localhostOnly: true, dbBackups: { dir: path.join(stateRoot, "db-backups") } }, null, 2)}\n`,
        { mode: 0o600 },
      );
      return { COPILOT_WEB_RELAY_DATA_DIR: "" };
    },
  });
}

async function upload(content, name) {
  const response = await fetch(`${relay.baseUrl}/api/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${relay.token}`, "content-type": "text/plain", "x-file-name": name },
    body: content,
  });
  expect(response.status).toBe(200);
  return (await response.json()).attachment;
}

async function content(sha256) {
  const response = await fetch(`${relay.baseUrl}/api/upload/${sha256}/content`, {
    headers: { Authorization: `Bearer ${relay.token}` },
  });
  return { status: response.status, text: response.status === 200 ? await response.text() : "" };
}

test.afterAll(async () => {
  for (const file of placed) fs.rmSync(file, { force: true });
  await relay?.kill();
});

test("uploads left in <server>/uploads or the state root's uploads/ are served after the update, in place", async () => {
  relay = await startRelay();
  const dataDir = path.join(relay.state.stateRoot, "install", "data");
  const strayUploads = path.join(relay.state.stateRoot, "install", "uploads");
  const uploadDir = path.join(dataDir, "uploads");

  const inServer = await upload(`left in the checkout ${randomUUID()}`, "checkout.txt");
  const inStray = await upload(`left by a migration ${randomUUID()}`, "migrated.txt");
  expect(fs.existsSync(path.join(uploadDir, inServer.sha256))).toBe(true);

  // Put each blob where an earlier version kept it, as if it had never been in
  // the upload dir.
  await relay.kill();
  fs.mkdirSync(strayUploads, { recursive: true });
  const serverCopy = path.join(serverUploads, inServer.sha256);
  const strayCopy = path.join(strayUploads, inStray.sha256);
  fs.renameSync(path.join(uploadDir, inServer.sha256), serverCopy);
  placed.push(serverCopy);
  fs.renameSync(path.join(uploadDir, inStray.sha256), strayCopy);
  const before = { server: fs.readFileSync(serverCopy, "utf8"), stray: fs.readFileSync(strayCopy, "utf8") };

  relay = await startRelay(relay.state);
  const fromServer = await content(inServer.sha256);
  expect(fromServer.status).toBe(200);
  expect(createHash("sha256").update(fromServer.text).digest("hex")).toBe(inServer.sha256);
  const fromStray = await content(inStray.sha256);
  expect(fromStray.status).toBe(200);
  expect(createHash("sha256").update(fromStray.text).digest("hex")).toBe(inStray.sha256);

  // Read in place: the old copies are where they were, unchanged, and not
  // copied into the upload dir.
  expect(fs.readFileSync(serverCopy, "utf8")).toBe(before.server);
  expect(fs.readFileSync(strayCopy, "utf8")).toBe(before.stray);
  expect(fs.existsSync(path.join(uploadDir, inServer.sha256))).toBe(false);
  expect(fs.existsSync(path.join(uploadDir, inStray.sha256))).toBe(false);

  // Uploading the same bytes again keeps a copy in the upload dir (the old
  // folders can go with an update), and the old copy stays as it was.
  await upload(before.server, "checkout-again.txt");
  expect(fs.existsSync(path.join(uploadDir, inServer.sha256))).toBe(true);
  expect(fs.readFileSync(serverCopy, "utf8")).toBe(before.server);
  const fresh = await upload(`new after the update ${randomUUID()}`, "new.txt");
  expect(fs.existsSync(path.join(uploadDir, fresh.sha256))).toBe(true);
  expect((await content(fresh.sha256)).status).toBe(200);
});
