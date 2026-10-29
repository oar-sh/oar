/**
 * A simulated `npm i -g` update from a packed 0.9.19 to a packed 0.9.20, in
 * temp global prefixes ("Verification"): the real tarballs,
 * the real npm, the real preinstall, the installed relays started the way a
 * launcher starts them.
 *
 *  A. pinned data folder (every launcher of a global install): the new
 *     version runs on the copilot.db 0.9.19 left, no oar.db appears, and its
 *     first start writes a pre-update backup;
 *  B. unpinned (a relay before 0.9.14 that ran on the database inside the
 *     package): the new package's preinstall copies that database out before
 *     npm deletes the old package, and the new relay takes it over, still
 *     named copilot.db;
 *  C. fresh: the new package on an empty data folder creates oar.db.
 *
 * Slow (two packs, three global installs, five relay starts) and needs the
 * npm registry or a warm npm cache, so it is not part of `npm test`:
 *
 *   node --test tests/packed-update/packed-update.test.mjs
 *
 * Everything lives under OAR_PACKED_UPDATE_TMP (else the OS temp folder),
 * removed at the end. The relay skips its backup on a disk that would keep
 * less than max(1 GiB, 5 %) free, so a small tmpfs /tmp cannot run this:
 * point OAR_PACKED_UPDATE_TMP (or TMPDIR) at a larger disk, e.g.
 * OAR_PACKED_UPDATE_TMP=/home/dev/.cache/oar-packed-update.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import { NPM_ALLOW_SCRIPTS_ARG } from "../../server/services/oar-cli-helpers.mjs";
import { buildRelayServerEnv, repoRoot, reserveFreePort, sleep, waitForServerReady } from "../relay-server-harness.mjs";

// 0.9.19 as released (the merge before the db-file work) and this branch.
const OLD_REF = "30e3605";
const NEW_REF = "HEAD";
const PACKAGE_NAME = "@oar-sh/oar";
const SLOW = { timeout: 15 * 60_000 };
const GIB = 1024 ** 3;
// What the three installs and the npm cache take on the disk before the
// backup is written, beyond the relay's own rule.
const INSTALL_HEADROOM = GIB;

const skipReason = process.platform === "win32" // host-platform: a real npm global prefix and its retire path on this host
  ? "Linux/macOS only: a global prefix on Windows has no lib/ (node_modules sits in the prefix) and npm's retire path differs"
  : false;

const tmpBase = path.resolve(process.env.OAR_PACKED_UPDATE_TMP || os.tmpdir());

// The relay's backup rule (db-backup-service.mjs checkBackupSpace): free
// minus the database must stay at max(1 GiB, 5 % of the disk). Failing, not
// skipping: a skipped run would look like a passed one.
function assertTempHasRoom() {
  fs.mkdirSync(tmpBase, { recursive: true });
  const stats = fs.statfsSync(tmpBase);
  const free = Number(stats.bavail) * Number(stats.bsize);
  const total = Number(stats.blocks) * Number(stats.bsize);
  const need = Math.max(GIB, 0.05 * total) + INSTALL_HEADROOM;
  const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
  assert.ok(free >= need, `${tmpBase} has ${mb(free)} free of ${mb(total)}; this test needs ${mb(need)} `
    + `(the relay skips its backup below max(1 GiB, 5 % of the disk), plus ${mb(INSTALL_HEADROOM)} for the installs). `
    + "Set OAR_PACKED_UPDATE_TMP (or TMPDIR) to a folder on a larger disk.");
}

// Nothing of the host's relay may reach the installs or the relays: a test
// run from a relay session inherits its config path, data and log folders,
// root and tokens. npm's own npm_* (set under `npm run`) go too.
const HOST_ENV = /^(COPILOT_|OAR_|CLAUDE|GROK_|CURSOR_|DEEPSEEK|ANTHROPIC|npm_)/i;
function hostlessEnv(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([key]) => !HOST_ENV.test(key)));
}

let root = "";
const children = new Set();

function run(command, args, { cwd, env = hostlessEnv(), timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${command} ${args.join(" ")} failed: ${error.message}\n--- stdout ---\n${String(stdout).slice(-4000)}\n--- stderr ---\n${String(stderr).slice(-4000)}`;
        reject(error);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// The tracked files of a commit, packed as the release would be (never the
// working tree: whatever is uncommitted there is not the version).
async function packRef(ref, name) {
  const src = path.join(root, `src-${name}`);
  const out = path.join(root, `pack-${name}`);
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const tar = path.join(root, `${name}.tar`);
  await run("git", ["-C", repoRoot, "archive", "--format=tar", "-o", tar, ref]);
  await run("tar", ["-xf", tar, "-C", src]);
  fs.rmSync(tar, { force: true });
  const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", out], { cwd: src });
  const [packed] = JSON.parse(stdout);
  const tgz = path.join(out, packed.filename);
  assert.ok(fs.existsSync(tgz), `npm pack of ${ref} wrote no tarball`);
  const version = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8")).version;
  fs.rmSync(src, { recursive: true, force: true });
  return { tgz, version };
}

const packageDirOf = (prefix) => path.join(prefix, "lib", "node_modules", ...PACKAGE_NAME.split("/"));

// `npm i -g` as `oar update` runs it (the allow-scripts flag lets the
// preinstall and better-sqlite3's install run), with the state root the
// preinstall copies a rescued database into.
async function npmInstallGlobal({ prefix, tgz, stateRoot }) {
  fs.mkdirSync(prefix, { recursive: true });
  return run("npm", [
    "install", "-g", "--prefix", prefix, NPM_ALLOW_SCRIPTS_ARG, "--no-audit", "--no-fund", "--prefer-offline", tgz,
  ], { cwd: root, env: { ...hostlessEnv(), OAR_STATE_ROOT: stateRoot } });
}

/**
 * A state root laid out as tests/relay-server-harness.mjs createStateRoot
 * does, but with this test's own config.json (written by the caller).
 */
function makeState(name) {
  const stateRoot = path.join(root, `state-${name}`);
  const paths = {
    stateRoot,
    dataDir: path.join(stateRoot, "data"),
    claudeConfigDir: path.join(stateRoot, "claude-config"),
    claudeCredFile: path.join(stateRoot, "claude-config", "credentials.json"),
    sdkStubDir: path.join(stateRoot, "copilot-sdk-stub"),
    cliBinDir: path.join(stateRoot, "cli-bin"),
    localAppDataDir: path.join(stateRoot, "AppData", "Local"),
    grokAuthFile: path.join(stateRoot, ".grok", "auth.json"),
    grokLoginAuthorizedFile: path.join(stateRoot, "grok-login-authorized"),
    grokLoginDeniedFile: path.join(stateRoot, "grok-login-denied"),
    workspace: path.join(stateRoot, "workspace"),
    configPath: path.join(stateRoot, "config.json"),
  };
  for (const dir of [paths.claudeConfigDir, paths.sdkStubDir, paths.cliBinDir, paths.localAppDataDir, path.dirname(paths.grokAuthFile), paths.workspace]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(paths.sdkStubDir, "extension.js"), "// stub, never imported\n");
  return paths;
}

function writeConfig(state, extra = {}) {
  fs.writeFileSync(state.configPath, `${JSON.stringify({
    authToken: "", port: 3333, pollIntervalMs: 3000, conversationSessionMode: "isolated", localhostOnly: true, ...extra,
  }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The installed relay started as a launcher starts it. `pinned: false`
 * leaves COPILOT_WEB_RELAY_DATA_DIR out, so the relay picks its data folder
 * itself (0.9.19: the package's server/data).
 */
async function startInstalledRelay({ pkg, state, pinned = true }) {
  const token = randomUUID();
  const port = await reserveFreePort();
  const harnessEnv = buildRelayServerEnv(state);
  // The harness's pins, without what it passes through from the host.
  const env = hostlessEnv(harnessEnv);
  for (const [key, value] of Object.entries(harnessEnv)) {
    if (HOST_ENV.test(key) && process.env[key] !== value) env[key] = value;
  }
  Object.assign(env, {
    COPILOT_WEB_RELAY_ROOT: pkg,
    COPILOT_WORKSPACE_ROOT: state.workspace,
    COPILOT_WEB_RELAY_CONFIG: state.configPath,
    COPILOT_WEB_RELAY_LOG_DIR: path.join(state.stateRoot, "logs"),
    OAR_STATE_ROOT: state.stateRoot,
    OAR_NO_UPDATE_CHECK: "1",
    COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: "1",
  });
  if (pinned) env.COPILOT_WEB_RELAY_DATA_DIR = state.dataDir;
  else delete env.COPILOT_WEB_RELAY_DATA_DIR;

  const proc = spawn(process.execPath, [
    path.join(pkg, "server", "server.js"), "--token", token, "--port", String(port), "--owner-pid", String(process.pid),
  ], { cwd: state.workspace, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(proc);
  let output = "";
  const keep = (chunk) => { output = (output + String(chunk)).slice(-20_000); };
  proc.stdout.on("data", keep);
  proc.stderr.on("data", keep);
  proc.once("exit", () => children.delete(proc));
  const relay = { proc, token, baseUrl: `http://127.0.0.1:${port}`, get output() { return output; } };
  try {
    await waitForServerReady(relay.baseUrl, token, proc, 180_000);
  } catch (error) {
    await stopRelay(relay);
    throw new Error(`${error.message}\n--- relay output ---\n${output}`);
  }
  return relay;
}

// SIGTERM and time to close the database cleanly; SIGKILL only after that.
async function stopRelay(relay) {
  const { proc } = relay;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  try { proc.kill("SIGTERM"); } catch {}
  const done = await Promise.race([exited.then(() => true), sleep(20_000).then(() => false)]);
  if (!done) {
    try { proc.kill("SIGKILL"); } catch {}
    await exited;
  }
}

async function about(relay) {
  const response = await fetch(`${relay.baseUrl}/api/about`, { headers: { Authorization: `Bearer ${relay.token}` } });
  assert.equal(response.status, 200, `GET /api/about answered ${response.status}`);
  return response.json();
}

const dbFiles = (dir, name) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.startsWith(name)).sort() : []);

// One conversation with a title only this run knows, written into the
// database the old relay left (it is stopped): what proves later that the
// new relay runs on that database and not on a new one.
function addMarker(dbFile, marker) {
  const db = new Database(dbFile, { fileMustExist: true });
  try {
    const at = new Date().toISOString();
    db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(`c-${marker}`, marker, at, at);
  } finally {
    db.close();
  }
}

// The conversation titles of a database, read through a copy (opening the
// file itself would touch its -shm and -wal).
function titlesIn(dbFile) {
  const scratch = fs.mkdtempSync(path.join(root, "read-"));
  try {
    for (const suffix of ["", "-wal"]) {
      if (fs.existsSync(`${dbFile}${suffix}`)) fs.copyFileSync(`${dbFile}${suffix}`, path.join(scratch, `db${suffix}`));
    }
    const db = new Database(path.join(scratch, "db"), { fileMustExist: true });
    try {
      return db.prepare("SELECT title FROM conversations ORDER BY title").all().map((row) => row.title);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

describe("packed npm update 0.9.19 -> 0.9.20", { skip: skipReason }, () => {
  let oldPack;
  let newPack;
  let prefixA = "";

  before(async () => {
    assertTempHasRoom();
    root = fs.mkdtempSync(path.join(tmpBase, "oar-packed-update-"));
    oldPack = await packRef(OLD_REF, "old");
    newPack = await packRef(NEW_REF, "new");
  }, SLOW);

  after(async () => {
    for (const proc of children) {
      try { proc.kill("SIGKILL"); } catch {}
    }
    // Let the killed relays release their files before the folder goes.
    if (children.size) await sleep(500);
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test("A: pinned data folder: 0.9.20 runs on 0.9.19's copilot.db and backs it up first", SLOW, async () => {
    const state = makeState("a");
    const backupsDir = path.join(state.stateRoot, "backups");
    // dbBackups is unknown to 0.9.19, which ignores it.
    writeConfig(state, { dbBackups: { dir: backupsDir } });
    prefixA = path.join(root, "prefix-a");
    const pkg = packageDirOf(prefixA);

    await npmInstallGlobal({ prefix: prefixA, tgz: oldPack.tgz, stateRoot: state.stateRoot });
    assert.ok(!fs.existsSync(path.join(pkg, "server", "services", "database-file.mjs")), "the old install is 0.9.19 (no database-file.mjs)");

    const old = await startInstalledRelay({ pkg, state });
    await stopRelay(old);
    // 0.9.19 knows one name only.
    assert.ok(fs.existsSync(path.join(state.dataDir, "copilot.db")), `0.9.19 left no copilot.db\n${old.output}`);
    assert.deepEqual(dbFiles(state.dataDir, "oar.db"), []);
    addMarker(path.join(state.dataDir, "copilot.db"), "marker-a");

    // The update.
    await npmInstallGlobal({ prefix: prefixA, tgz: newPack.tgz, stateRoot: state.stateRoot });
    assert.ok(fs.existsSync(path.join(pkg, "server", "services", "database-file.mjs")), "the update installed the new package");

    const relay = await startInstalledRelay({ pkg, state });
    let answer;
    try {
      answer = await about(relay);
    } finally {
      await stopRelay(relay);
    }
    // It runs on copilot.db, with the old relay's data, and no oar.db appeared.
    assert.equal(answer.relay.dbPath, path.join(state.dataDir, "copilot.db"), relay.output);
    assert.equal(answer.stats.conversations, 1, relay.output);
    assert.deepEqual(dbFiles(state.dataDir, "oar.db"), [], relay.output);
    assert.deepEqual(titlesIn(path.join(state.dataDir, "copilot.db")), ["marker-a"]);

    // Its first start backed it up: 0.9.19 wrote no db_last_run and there
    // was no in-app update record, so the version is the running one and
    // the reason says the version before is not known.
    const manifestFile = path.join(state.dataDir, "db-backups.json");
    const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : null;
    const backups = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : [];
    const versionRe = newPack.version.replace(/\./g, "\\.");
    const expected = new RegExp(`^oar-${versionRe}-\\d{8}-\\d{6}-pre-update-from-unknown\\.db$`);
    assert.equal(backups.length, 1, `one backup in ${backupsDir}: ${JSON.stringify(backups)}; last result ${JSON.stringify(manifest?.lastResult)}\n${relay.output}`);
    assert.match(backups[0], expected);
    assert.deepEqual(manifest.backups.map((entry) => entry.file), [backups[0]]);
    assert.equal(manifest.lastResult?.status, "written");
    // The backup is of the old relay's data.
    assert.deepEqual(titlesIn(path.join(backupsDir, backups[0])), ["marker-a"]);
  });

  test("B: unpinned 0.9.19 on the package's server/data: the preinstall rescues it, 0.9.20 takes it over as copilot.db", SLOW, async () => {
    const state = makeState("b");
    // No dataDir: without the env pin 0.9.19 runs on <package>/server/data.
    writeConfig(state);
    const prefix = path.join(root, "prefix-b");
    const pkg = packageDirOf(prefix);
    const packageData = path.join(pkg, "server", "data");

    await npmInstallGlobal({ prefix, tgz: oldPack.tgz, stateRoot: state.stateRoot });
    const old = await startInstalledRelay({ pkg, state, pinned: false });
    await stopRelay(old);
    assert.ok(fs.existsSync(path.join(packageData, "copilot.db")), `0.9.19 unpinned left no ${packageData}/copilot.db\n${old.output}`);
    assert.ok(!fs.existsSync(state.dataDir) || dbFiles(state.dataDir, "copilot.db").length === 0, "nothing in the state root's data folder yet");
    addMarker(path.join(packageData, "copilot.db"), "marker-b");

    // The update: npm deletes the old package, its server/data with it; the
    // new package's preinstall copied it out first.
    const install = await npmInstallGlobal({ prefix, tgz: newPack.tgz, stateRoot: state.stateRoot });
    assert.ok(!fs.existsSync(path.join(packageData, "copilot.db")), "npm removed the old package's database");
    const rescueRoot = path.join(state.dataDir, "rescued-package-data");
    const rescues = fs.existsSync(rescueRoot) ? fs.readdirSync(rescueRoot) : [];
    assert.equal(rescues.length, 1, `one rescue copy in ${rescueRoot}: ${JSON.stringify(rescues)}\n--- npm ---\n${install.stdout}\n${install.stderr}`);
    assert.ok(!rescues[0].endsWith(".partial"), rescues[0]);
    const rescuedDb = path.join(rescueRoot, rescues[0], "data", "copilot.db");
    assert.ok(fs.existsSync(rescuedDb), `the rescue holds data/copilot.db: ${JSON.stringify(fs.readdirSync(path.join(rescueRoot, rescues[0], "data")))}`);

    // Pinned now, as every 0.9.20 launcher starts it.
    const relay = await startInstalledRelay({ pkg, state });
    let answer;
    try {
      answer = await about(relay);
    } finally {
      await stopRelay(relay);
    }
    // It took the rescued database over under its old name.
    assert.equal(answer.relay.dbPath, path.join(state.dataDir, "copilot.db"), relay.output);
    assert.equal(answer.stats.conversations, 1, relay.output);
    assert.deepEqual(dbFiles(state.dataDir, "oar.db"), [], relay.output);
    assert.deepEqual(titlesIn(path.join(state.dataDir, "copilot.db")), ["marker-b"]);
    // The rescue copy is kept, renamed as looked at; the decision recorded.
    const left = fs.readdirSync(path.join(rescueRoot, rescues[0], "data"));
    assert.ok(left.some((name) => /^copilot\.db\.adopted-/.test(name)), `rescue copy renamed: ${JSON.stringify(left)}`);
    const checked = JSON.parse(fs.readFileSync(path.join(state.dataDir, "earlier-databases.json"), "utf8"));
    assert.ok(checked.sources.some((entry) => entry.outcome === "adopted"), JSON.stringify(checked));
    // And its first start on it backed it up (default folder: the state root's backups).
    const backups = fs.existsSync(path.join(state.stateRoot, "backups")) ? fs.readdirSync(path.join(state.stateRoot, "backups")) : [];
    assert.equal(backups.filter((name) => /-pre-update-from-unknown\.db$/.test(name)).length, 1, `${JSON.stringify(backups)}\n${relay.output}`);
  });

  test("C: fresh data folder: 0.9.20 creates oar.db, no copilot.db", SLOW, async () => {
    const state = makeState("c");
    writeConfig(state, { dbBackups: { dir: path.join(state.stateRoot, "backups") } });
    // The new install of case A; installed here when A stopped before it.
    if (!prefixA) prefixA = path.join(root, "prefix-a");
    const pkg = packageDirOf(prefixA);
    if (!fs.existsSync(path.join(pkg, "server", "services", "database-file.mjs"))) {
      await npmInstallGlobal({ prefix: prefixA, tgz: newPack.tgz, stateRoot: state.stateRoot });
    }

    const relay = await startInstalledRelay({ pkg, state });
    let answer;
    try {
      answer = await about(relay);
    } finally {
      await stopRelay(relay);
    }
    assert.equal(answer.relay.dbPath, path.join(state.dataDir, "oar.db"), relay.output);
    assert.ok(fs.existsSync(path.join(state.dataDir, "oar.db")));
    assert.deepEqual(dbFiles(state.dataDir, "copilot.db"), []);
    // A new database is not backed up.
    assert.deepEqual(fs.existsSync(path.join(state.stateRoot, "backups")) ? fs.readdirSync(path.join(state.stateRoot, "backups")) : [], []);
  });
});
