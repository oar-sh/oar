import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "@playwright/test";

import { createStateRoot, removeStateRoot, startRelayServer } from "./relay-server-harness.mjs";

// Each test boots its OWN relay on a temp data dir whose database another
// version ran on last (db_last_run says so): the relay backs it up before
// its migrations, into the harness's temp backup folder, and keeps the last
// two. No browser: the files and /api/about are the whole story.

const roots = [];
// Each test starts one relay or more that back up or compare database files
// first: on a disk under load (after the browser specs) that takes seconds.
test.setTimeout(180_000);
const SLOW_START = { readyTimeoutMs: 120_000 };

// The relay skips a backup when its disk would keep less than max(1 GiB,
// 5 %) free (as the plan says); a small temp disk (a tmpfs /tmp) cannot run
// these. TMPDIR on a larger disk can.
const tmpStats = fs.statfsSync(os.tmpdir());
const tmpHasRoom = tmpStats.bavail * tmpStats.bsize >= Math.max(1024 ** 3, 0.05 * tmpStats.blocks * tmpStats.bsize) + 64 * 1024 ** 2;
test.skip(!tmpHasRoom, `${os.tmpdir()} has less free space than a backup leaves free: the backup specs need TMPDIR on a disk with more than 1 GiB free (a gate run counts this skip as a failure)`);

test.afterAll(() => {
  for (const root of roots) removeStateRoot(root);
});

// A database as an old version left it: only app_settings (the migrations
// of this version add every other table), and the version that ran on it.
function seedOldDatabase(state, version) {
  fs.mkdirSync(state.dataDir, { recursive: true });
  const db = new Database(path.join(state.dataDir, "oar.db"));
  try {
    db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('db_last_run', ?, '2026-10-01T00:00:00.000Z')")
      .run(JSON.stringify({ version, commit: null, at: "2026-10-01T00:00:00.000Z" }));
  } finally {
    db.close();
  }
}

function setLastRunVersion(state, version) {
  const db = new Database(path.join(state.dataDir, "oar.db"));
  try {
    db.prepare("UPDATE app_settings SET value = ? WHERE key = 'db_last_run'").run(JSON.stringify({ version, commit: null, at: "x" }));
  } finally {
    db.close();
  }
}

const backups = (state) => (fs.existsSync(state.dbBackupsDir) ? fs.readdirSync(state.dbBackupsDir).filter((name) => name.endsWith(".db")).sort() : []);

function tables(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  } finally {
    db.close();
  }
}

test("the first start of a new version backs the database up before its migrations; a restart backs up nothing", async () => {
  const state = createStateRoot();
  roots.push(state.stateRoot);
  seedOldDatabase(state, "0.9.1");
  let relay = await startRelayServer({ token: randomUUID(), state, ...SLOW_START });
  try {
    expect(backups(state)).toHaveLength(1);
    const [file] = backups(state);
    expect(file).toMatch(/^oar-0\.9\.1-\d{8}-\d{6}-pre-update\.db$/);
    expect(tables(path.join(state.dbBackupsDir, file))).toEqual(["app_settings"]);
    expect(fs.readdirSync(state.dbBackupsDir).filter((name) => /-(wal|shm)$|\.partial$/.test(name))).toEqual([]);
    expect(relay.stdout + relay.stderr).toMatch(/\[backup\] written .*oar-0\.9\.1-.*-pre-update\.db \(.* MB, quick_check ok, .* s\)/);
    const about = await (await fetch(`${relay.baseUrl}/api/about`, { headers: { Authorization: `Bearer ${relay.token}` } })).json();
    expect(about.backups).toMatchObject({ enabled: true, keep: 2, dir: state.dbBackupsDir, kept: 1, lastResult: { status: "written", file } });
  } finally {
    await relay.kill();
  }
  expect(tables(path.join(state.dataDir, "oar.db"))).toContain("conversations");

  relay = await startRelayServer({ token: randomUUID(), state, port: relay.port, ...SLOW_START });
  await relay.kill();
  expect(backups(state)).toHaveLength(1);
});

test("three version changes with keep 2 leave the newest two", async () => {
  const state = createStateRoot();
  roots.push(state.stateRoot);
  seedOldDatabase(state, "0.9.1");
  for (const version of [null, "0.9.2", "0.9.3"]) {
    if (version) setLastRunVersion(state, version);
    const relay = await startRelayServer({ token: randomUUID(), state, ...SLOW_START });
    await relay.kill();
  }
  expect(backups(state).map((name) => name.replace(/\d{8}-\d{6}/, "T"))).toEqual([
    "oar-0.9.2-T-pre-update.db",
    "oar-0.9.3-T-pre-update.db",
  ]);
});
