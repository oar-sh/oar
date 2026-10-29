import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";

import { applySchema } from "../server/db-schema.mjs";
import {
  buildRelayServerEnv,
  createStateRoot,
  removeStateRoot,
  reserveFreePort,
  serverScript,
  startRelayServer,
} from "./relay-server-harness.mjs";

// Each test boots its OWN relay on a temp data dir and looks at which
// database file it runs on: oar.db for a new one, copilot.db where an
// earlier version left one, and the start's rule when both are there. No
// browser: the relay's files and /api/about are the whole story.

const roots = [];
// Each test starts one relay or more that back up or compare database files
// first: on a disk under load (after the browser specs) that takes seconds.
test.setTimeout(180_000);
const SLOW_START = { readyTimeoutMs: 120_000 };

test.afterAll(() => {
  for (const root of roots) removeStateRoot(root);
});

function seededState() {
  const state = createStateRoot();
  roots.push(state.stateRoot);
  fs.mkdirSync(state.dataDir, { recursive: true });
  return state;
}

// A database with the production schema and one conversation, message and
// setting changed at `at`.
function writeDatabase(file, { marker, at }) {
  const db = new Database(file);
  try {
    db.pragma("journal_mode = WAL");
    applySchema(db);
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('relay_name', ?, ?)").run(marker, at);
    db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(`c-${marker}`, marker, at, at);
    db.prepare("INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, ?, 'user', ?, ?)").run(`m-${marker}`, `c-${marker}`, marker, at);
  } finally {
    db.close();
  }
}

// The database files of both names, with their bytes (the runtime makes
// its folders before the lock; those are not what is compared).
function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).filter((name) => /^(oar|copilot)\.db/.test(name)).sort().map((name) => [
    name,
    createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex"),
  ]));
}

async function about(relay) {
  const response = await fetch(`${relay.baseUrl}/api/about`, { headers: { Authorization: `Bearer ${relay.token}` } });
  expect(response.status).toBe(200);
  return response.json();
}

test("a fresh data dir: the relay creates oar.db, and no copilot.db appears", async () => {
  const state = createStateRoot();
  roots.push(state.stateRoot);
  const relay = await startRelayServer({ token: randomUUID(), state, ...SLOW_START });
  try {
    expect((await about(relay)).relay.dbPath).toBe(path.join(state.dataDir, "oar.db"));
  } finally {
    await relay.kill();
  }
  expect(fs.existsSync(path.join(state.dataDir, "oar.db"))).toBe(true);
  expect(fs.readdirSync(state.dataDir).filter((name) => name.startsWith("copilot.db"))).toEqual([]);
});

test("a data dir with copilot.db: the relay runs on it, and no oar.db appears", async () => {
  const state = seededState();
  writeDatabase(path.join(state.dataDir, "copilot.db"), { marker: "earlier", at: "2026-10-01T09:00:00.000Z" });
  const relay = await startRelayServer({ token: randomUUID(), state, ...SLOW_START });
  try {
    const answer = await about(relay);
    expect(answer.relay.dbPath).toBe(path.join(state.dataDir, "copilot.db"));
    expect(answer.stats.conversations).toBe(1);
  } finally {
    await relay.kill();
  }
  expect(fs.readdirSync(state.dataDir).filter((name) => name.startsWith("oar.db"))).toEqual([]);
});

test("both, oar.db newer: copilot.db is set aside as copilot.db.older-<time>, the relay runs on oar.db", async () => {
  const state = seededState();
  writeDatabase(path.join(state.dataDir, "oar.db"), { marker: "current", at: "2026-11-01T09:00:00.000Z" });
  writeDatabase(path.join(state.dataDir, "copilot.db"), { marker: "stray", at: "2026-10-01T09:00:00.000Z" });
  const relay = await startRelayServer({ token: randomUUID(), state, ...SLOW_START });
  try {
    expect((await about(relay)).relay.dbPath).toBe(path.join(state.dataDir, "oar.db"));
  } finally {
    await relay.kill();
  }
  const names = fs.readdirSync(state.dataDir);
  expect(names.filter((name) => /^copilot\.db\.older-[0-9T-]+Z$/.test(name))).toHaveLength(1);
  expect(names).not.toContain("copilot.db");
});

test("both, copilot.db newer: exit 78 naming both files, the lock released, every file as it was", async () => {
  const state = seededState();
  writeDatabase(path.join(state.dataDir, "oar.db"), { marker: "current", at: "2026-10-01T09:00:00.000Z" });
  writeDatabase(path.join(state.dataDir, "copilot.db"), { marker: "downgraded", at: "2026-11-01T09:00:00.000Z" });
  const before = snapshot(state.dataDir);
  const port = await reserveFreePort();
  const proc = spawn(process.execPath, [serverScript, "--token", randomUUID(), "--port", String(port), "--owner-pid", String(process.pid)], {
    env: buildRelayServerEnv(state),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk; });
  proc.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => proc.once("exit", resolve));
  expect(code).toBe(78);
  expect(output).toMatch(/\[data\] Not starting: .*copilot\.db has changes newer than .*oar\.db\./);
  expect(fs.existsSync(path.join(state.dataDir, "relay-server.lock"))).toBe(false);
  expect(snapshot(state.dataDir)).toEqual(before);
});

test("a copilot.db an earlier version's start alone wrote, beside a used oar.db: set aside, the relay runs on oar.db", async () => {
  // A real start on an empty folder, renamed to copilot.db: what 0.9.19 does
  // after a downgrade that skipped the rename back (the rows it writes are
  // the same).
  const state = createStateRoot();
  roots.push(state.stateRoot);
  const first = await startRelayServer({ token: randomUUID(), state, ...SLOW_START });
  await first.kill();
  // 0.9.19 writes no db_last_run (0.9.20's backup step does).
  const started = new Database(path.join(state.dataDir, "oar.db"));
  started.prepare("DELETE FROM app_settings WHERE key = 'db_last_run'").run();
  started.close();
  for (const side of ["", "-wal", "-shm"]) {
    const from = path.join(state.dataDir, `oar.db${side}`);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(state.dataDir, `copilot.db${side}`));
  }
  writeDatabase(path.join(state.dataDir, "oar.db"), { marker: "used", at: "2026-10-01T09:00:00.000Z" });
  const relay = await startRelayServer({ token: randomUUID(), state, ...SLOW_START });
  try {
    const answer = await about(relay);
    expect(answer.relay.dbPath).toBe(path.join(state.dataDir, "oar.db"));
    expect(answer.stats.conversations).toBe(1);
    expect(relay.stdout + relay.stderr).toMatch(/copilot\.db holds start-up settings only and no chats/);
  } finally {
    await relay.kill();
  }
  expect(fs.readdirSync(state.dataDir).filter((name) => /^copilot\.db\.older-[0-9T-]+Z$/.test(name))).toHaveLength(1);
});

test("an oar.db-wal left beside copilot.db (a rename back that missed it): exit 78 naming it, nothing changed", async () => {
  const state = seededState();
  writeDatabase(path.join(state.dataDir, "copilot.db"), { marker: "downgraded", at: "2026-11-01T09:00:00.000Z" });
  fs.writeFileSync(path.join(state.dataDir, "oar.db-wal"), "frames of an earlier oar.db");
  const before = snapshot(state.dataDir);
  const port = await reserveFreePort();
  const proc = spawn(process.execPath, [serverScript, "--token", randomUUID(), "--port", String(port), "--owner-pid", String(process.pid)], {
    env: buildRelayServerEnv(state),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk; });
  proc.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => proc.once("exit", resolve));
  expect(code).toBe(78);
  expect(output).toMatch(/\[data\] Not starting: .*oar\.db-wal is there without .*oar\.db\..*Move it into a folder of your own/);
  expect(fs.existsSync(path.join(state.dataDir, "relay-server.lock"))).toBe(false);
  expect(snapshot(state.dataDir)).toEqual(before);
});
