/**
 * A simulated `npm i -g` update from a packed 0.9.19 (and 0.9.23) to a
 * packed build of this branch, in temp global prefixes ("Verification"): the
 * real tarballs, the real npm, the installed relays started the way a
 * launcher starts them.
 *
 *  A. pinned data folder (every launcher of a global install): the new
 *     version runs on the copilot.db 0.9.19 left, no oar.db appears, and its
 *     first start writes a pre-update backup; the update leaves no agent SDK
 *     (nor koffi, nor zod) in the package's tree;
 *  C. fresh: the new package on an empty data folder creates oar.db;
 *  D. agent SDKs on demand: on a database 0.9.19 left, with a conversation on
 *     the claude provider, the updated relay's first start installs the
 *     Claude SDK into <OAR_SDK_DIR>/claude/<version>-<hash8>/ (koffi too on
 *     Windows) and nothing for Cursor; at the next start a queued turn of that
 *     conversation launches a worker with that folder, and the worker loads
 *     the SDK from it. The worker is a stand-in (COPILOT_WEB_RELAY_CLAUDE_WORKER_PATH)
 *     that records what it was launched with: a real Claude worker needs a
 *     login.
 *  E. a worker kept running across the update: 0.9.23 (the last version with
 *     the agent SDKs in its own tree) runs a Claude chat on a stand-in worker
 *     that lives on the package's own worker runtime, states 0.9.23's build
 *     id and fails a turn once the SDK in the package is gone, as a real
 *     worker does. The update takes that SDK; the new relay starts with a
 *     message queued for the chat, the old worker reconnects and asks for
 *     work. The message goes to a new worker on the store's SDK folder (the
 *     recycle replaces the old one, which is fenced until then), and no turn
 *     fails.
 *
 * The new package is stamped with HEAD's commit as `gitHead` when it has
 * none, so it states a build id other than 0.9.23's at the same version.
 *
 * (B, a relay before 0.9.14 on the database inside the package, was rescued
 * by a preinstall from 0.9.14 to 0.9.22; 0.9.23 has none.)
 *
 * Slow (two packs, two global installs, five relay starts and one SDK
 * install) and needs the npm registry or a warm npm cache, so it is not part
 * of `npm test`:
 *
 *   node --test tests/packed-update/packed-update.test.mjs
 *
 * The npm cache is the one npm uses here (npm_config_cache is passed on to
 * the installs and to the relays' SDK store). The setup puts the Claude SDK
 * pins (and koffi's on Windows) in it with `npm cache add --prefer-offline`
 * (once more with `--prefer-online` when a stale cached packument names no
 * such version, as for the global installs), and the relays install with
 * npm_config_prefer_offline=true, through npm-ci-online-retry.mjs (the same
 * one online repeat):
 * the first run downloads them once (the Claude SDK's platform package is the
 * bulk, about a hundred MB), later runs read the cache. Without a registry and without that
 * cache every case is skipped, with the reason.
 *
 * The packs are of commits (OLD_REF, SDK_IN_PACKAGE_REF, and NEW_REF =
 * HEAD), never the working tree: commit what the run is meant to see, or
 * point OAR_PACKED_UPDATE_NEW_TGZ at a tarball `npm pack` wrote from the
 * working tree, which then stands for NEW_REF.
 *
 * Everything lives under OAR_PACKED_UPDATE_TMP (else the OS temp folder),
 * removed at the end. The relay skips its backup on a disk that would keep
 * less than max(1 GiB, 5 %) free, so a small tmpfs /tmp cannot run this:
 * point OAR_PACKED_UPDATE_TMP (or TMPDIR) at a larger disk, e.g.
 * OAR_PACKED_UPDATE_TMP=/home/dev/.cache/oar-packed-update. The SDK store
 * refuses a folder longer than 120 characters, so keep that path short.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import { buildRelayServerEnv, repoRoot, reserveFreePort, sleep, waitForServerReady } from "../relay-server-harness.mjs";
import { addToNpmCache, npmPreferringOffline } from "./npm-cache-add.mjs";
import { writeNpmCiLauncher } from "./npm-ci-online-retry.mjs";

// 0.9.19 as released (the merge before the db-file work) and this branch.
const OLD_REF = "30e3605";
const NEW_REF = "HEAD";
// 0.9.23 as released: the head of its release branch, merged back into main
// as "v0.9.23 published" (the public release commit differs only in CI
// files, which are not packed). The last version with the agent SDKs in its
// own tree.
const SDK_IN_PACKAGE_REF = "b606fa58";
// A tarball packed from the working tree (`npm pack`), used instead of a
// pack of NEW_REF: what is not committed yet can run here too.
const NEW_TGZ = process.env.OAR_PACKED_UPDATE_NEW_TGZ ? path.resolve(process.env.OAR_PACKED_UPDATE_NEW_TGZ) : "";
const PACKAGE_NAME = "@oar-sh/oar";
const SLOW = { timeout: 15 * 60_000 };
// D may install 0.9.19 and the update itself (when A did not get there),
// waits for the SDK install (the store gives npm 10 minutes) and starts the
// relay twice.
const SLOWER = { timeout: 35 * 60_000 };
const SDK_INSTALL_WAIT_MS = 11 * 60_000;
const WORKER_LAUNCH_WAIT_MS = 3 * 60_000;
const GIB = 1024 ** 3;
// What the installs and the npm cache take on the disk before the
// backup is written, beyond the relay's own rule.
const INSTALL_HEADROOM = GIB;
// What 0.9.19 had in its tree and this version installs on demand (or, for
// the Copilot SDK, not at all).
const ON_DEMAND_PACKAGES = ["@anthropic-ai/claude-agent-sdk", "@cursor/sdk", "@github/copilot-sdk", "koffi", "zod"];

const tmpBase = path.resolve(process.env.OAR_PACKED_UPDATE_TMP || os.tmpdir());

// Room for the installs, and with `backup` (case A, which judges the backup)
// the relay's backup rule (db-backup-service.mjs checkBackupSpace): free
// minus the database must stay at max(1 GiB, 5 % of the disk). Failing, not
// skipping: a skipped run would look like a passed one.
function assertTempHasRoom({ backup = true } = {}) {
  fs.mkdirSync(tmpBase, { recursive: true });
  const stats = fs.statfsSync(tmpBase);
  const free = Number(stats.bavail) * Number(stats.bsize);
  const total = Number(stats.blocks) * Number(stats.bsize);
  const need = (backup ? Math.max(GIB, 0.05 * total) : 0) + INSTALL_HEADROOM;
  const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
  assert.ok(free >= need, `${tmpBase} has ${mb(free)} free of ${mb(total)}; this test needs ${mb(need)} `
    + `(${backup ? "the relay skips its backup below max(1 GiB, 5 % of the disk), plus " : ""}${mb(INSTALL_HEADROOM)} for the installs). `
    + "Set OAR_PACKED_UPDATE_TMP (or TMPDIR) to a folder on a larger disk.");
}

// Nothing of the host's relay may reach the installs or the relays: a test
// run from a relay session inherits its config path, data and log folders,
// root and tokens. npm's own npm_* (set under `npm run`) go too, except what
// says where packages come from and which cache they go to.
const HOST_ENV = /^(COPILOT_|OAR_|CLAUDE|GROK_|CURSOR_|DEEPSEEK|ANTHROPIC|npm_)/i;
const KEPT_NPM_ENV = /^npm_config_(cache|registry|@[^_]+:registry|offline|prefer_offline|prefer_online|proxy|https_proxy|http_proxy|noproxy|no_proxy|cafile|strict_ssl)$/i;
function hostlessEnv(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([key]) => !HOST_ENV.test(key) || KEPT_NPM_ENV.test(key)));
}

let root = "";
const children = new Set();
// The npm cache and registry npm uses here; the relays (whose HOME is their
// state root) get them explicitly.
let npmSettings = null;
// Why nothing can run here (no registry and no cache, a clone without
// OLD_REF), or null.
let suiteSkip = null;
// A copy of the copilot.db 0.9.19 left in case A, before the marker: D's
// "database the previous version left", without a third install.
let oldDbSnapshot = "";

function run(command, args, { cwd, env = hostlessEnv(), timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${command} ${args.join(" ")} failed: ${error.message}\n--- stdout ---\n${String(stdout).slice(-4000)}\n--- stderr ---\n${String(stderr).slice(-4000)}`;
        error.output = `${stdout}\n${stderr}`;
        reject(error);
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// host-platform: npm is a .cmd on Windows, which execFile cannot start
// without a shell; the npm next to this Node runs as a script instead.
function npm(args, options) {
  if (process.platform === "win32") { // host-platform: the packed install runs on this host
    const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(cli)) return run(process.execPath, [cli, ...args], options);
    return run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm", ...args], options);
  }
  return run("npm", args, options);
}

// host-platform: Windows' own tar (bsdtar); a Git for Windows tar earlier
// in PATH reads "R:\..." as a remote host.
const TAR = process.platform === "win32" // host-platform: the packed install runs on this host
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
  : "tar";

// The tracked files of a commit (never the working tree: whatever is
// uncommitted there is not the version). LF line ends, as a release packed
// on Linux has them.
async function extractRef(ref, name) {
  const src = path.join(root, `src-${name}`);
  fs.mkdirSync(src, { recursive: true });
  const tar = path.join(root, `${name}.tar`);
  await run("git", ["-C", repoRoot, "-c", "core.autocrlf=false", "archive", "--format=tar", "-o", tar, ref]);
  await run(TAR, ["-xf", tar, "-C", src]);
  fs.rmSync(tar, { force: true });
  return src;
}

// The files of a tarball `npm pack` wrote (OAR_PACKED_UPDATE_NEW_TGZ).
async function extractTarball(tgz, name) {
  const dir = path.join(root, `src-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  await run(TAR, ["-xzf", tgz, "-C", dir]);
  const src = path.join(dir, "package");
  assert.ok(fs.existsSync(path.join(src, "package.json")), `${tgz} holds no package/package.json`);
  return src;
}

/**
 * Packs a tree as the release would be, then removes it. `gitHead` (a commit
 * id) is stamped into its package.json when it has none: the build id is then
 * `<version>+<commit12>` rather than the version alone (shared/build-id.mjs),
 * so a build at the same version as the one it updates still states another
 * build, as the release after it will.
 */
async function packTree(src, name, { gitHead = null } = {}) {
  const out = path.join(root, `pack-${name}`);
  fs.mkdirSync(out, { recursive: true });
  const manifestFile = path.join(src, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (gitHead && !manifest.gitHead) {
    manifest.gitHead = gitHead;
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const { stdout } = await npm(["pack", "--json", "--pack-destination", out], { cwd: src });
  const [packed] = JSON.parse(stdout);
  const tgz = path.join(out, packed.filename);
  assert.ok(fs.existsSync(tgz), `npm pack of ${name} wrote no tarball`);
  fs.rmSync(src, { recursive: true, force: true });
  const commit = typeof manifest.gitHead === "string" && /^[0-9a-f]{40}$/i.test(manifest.gitHead) ? manifest.gitHead : null;
  return { tgz, version: manifest.version, buildId: commit ? `${manifest.version}+${commit.slice(0, 12)}` : manifest.version };
}

async function packRef(ref, name) {
  return packTree(await extractRef(ref, name), name);
}

// host-platform: a global prefix on Windows has no lib/.
const packageDirOf = (prefix) => (process.platform === "win32" // host-platform: the packed install runs on this host
  ? path.join(prefix, "node_modules", ...PACKAGE_NAME.split("/"))
  : path.join(prefix, "lib", "node_modules", ...PACKAGE_NAME.split("/")));
const isNewInstall = (prefix) => Boolean(prefix) && fs.existsSync(path.join(packageDirOf(prefix), "server", "services", "agent-sdk-store.mjs"));

// `npm i -g` as `oar update` runs it, with the test's state root. 0.9.19
// still has better-sqlite3 12, whose install script fetches its binary, and
// koffi (through the Copilot SDK): its install takes both. This version has
// no install script left in its tree, and its `oar update` passes no
// --allow-scripts.
const OLD_ALLOW_SCRIPTS_ARG = "--allow-scripts=better-sqlite3,koffi";
// From the cache, and once online when a stale cached packument names no
// such version (ETARGET; npm-cache-add.mjs).
async function npmInstallGlobal({ prefix, tgz, stateRoot, allowScripts = null }) {
  fs.mkdirSync(prefix, { recursive: true });
  return npmPreferringOffline(npm, [
    "install", "-g", "--prefix", prefix, ...(allowScripts ? [allowScripts] : []), "--no-audit", "--no-fund", "--prefer-offline", tgz,
  ], { cwd: root, env: { ...hostlessEnv(), OAR_STATE_ROOT: stateRoot, ...npmEnv() } });
}

/**
 * The relays' SDK store installs from the cache (npm_config_prefer_offline),
 * where a stale cached packument can name no such version as well. In this
 * test only, the store's install command is npm-ci-online-retry.mjs: the
 * store's own `npm ci`, once more online on ETARGET. The relay's code is not
 * changed for it (the command is the store's existing install hook).
 */
function sdkInstallEnv(state, pkg) {
  const launcher = writeNpmCiLauncher({
    dir: path.join(state.stateRoot, "sdk-npm-ci"),
    packageDir: pkg,
    platform: process.platform, // host-platform: the launcher runs on this host
  });
  return { COPILOT_WEB_RELAY_AGENT_SDK_INSTALL_COMMAND: launcher };
}

function npmEnv() {
  return npmSettings ? { npm_config_cache: npmSettings.cache, npm_config_registry: npmSettings.registry } : {};
}

/**
 * A state root laid out as tests/relay-server-harness.mjs createStateRoot
 * does, but with this test's own config.json (written by the caller), and a
 * folder of its own for the agent SDK store (OAR_SDK_DIR).
 */
function makeState(name) {
  const stateRoot = path.join(root, `state-${name}`);
  const paths = {
    stateRoot,
    dataDir: path.join(stateRoot, "data"),
    sdkDir: path.join(stateRoot, "sdks"),
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
 * The installed relay started as a launcher starts it. `allowSpawn` lifts the
 * harness's spawn kill switch (the SDK store runs npm, the launch gate starts
 * workers); `env` is applied last.
 */
async function startInstalledRelay({ pkg, state, allowSpawn = false, env: extraEnv = {}, port: fixedPort = null, token: fixedToken = null }) {
  const token = fixedToken || randomUUID();
  const port = fixedPort || await reserveFreePort();
  const harnessEnv = buildRelayServerEnv({ ...state, allowCli: allowSpawn });
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
    OAR_SDK_DIR: state.sdkDir,
    OAR_NO_UPDATE_CHECK: "1",
    COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: "1",
    COPILOT_WEB_RELAY_DATA_DIR: state.dataDir,
    ...npmEnv(),
  });
  if (allowSpawn) delete env.COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN;
  Object.assign(env, extraEnv);

  const proc = spawn(process.execPath, [
    path.join(pkg, "server", "server.js"), "--token", token, "--port", String(port), "--owner-pid", String(process.pid),
  ], { cwd: state.workspace, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  children.add(proc);
  let output = "";
  const keep = (chunk) => { output = (output + String(chunk)).slice(-400_000); };
  proc.stdout.on("data", keep);
  proc.stderr.on("data", keep);
  proc.once("exit", () => children.delete(proc));
  const relay = { proc, token, baseUrl: `http://127.0.0.1:${port}`, get output() { return output; } };
  try {
    await waitForServerReady(relay.baseUrl, token, proc, 180_000);
  } catch (error) {
    await stopRelay(relay);
    throw new Error(`${error.message}\n--- relay output ---\n${output.slice(-20_000)}`);
  }
  return relay;
}

// host-platform: a process and what it started. Windows has no process
// groups; taskkill /T follows the parent ids (an npm the store started).
async function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") { // host-platform: the packed install runs on this host
    await run("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 30_000 }).catch(() => {});
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
}

// SIGTERM and time to close the database cleanly; SIGKILL only after that.
// Windows has no SIGTERM (Node ends the process at once): the tree goes, so
// no npm of the SDK store outlives its relay.
async function stopRelay(relay) {
  const { proc } = relay;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  if (process.platform === "win32") { // host-platform: the packed install runs on this host
    await killTree(proc.pid);
    try { proc.kill("SIGKILL"); } catch {}
    await exited;
    return;
  }
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

// The store's status route, or null where this build has none (an HTML
// fallback page or a 404).
async function agentSdkStatus(relay) {
  try {
    const response = await fetch(`${relay.baseUrl}/api/agent-sdks/status`, { headers: { Authorization: `Bearer ${relay.token}` } });
    if (!response.ok || !String(response.headers.get("content-type") || "").includes("json")) return null;
    const body = await response.json();
    return body && typeof body.sdks === "object" ? body : null;
  } catch {
    return null;
  }
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

// A conversation bound to the claude provider (its runtime session), as a
// Claude chat of the previous version leaves it. Invented names.
const FIXTURE_MODEL = "claude-fixture-model";
function addClaudeConversation(dbFile, { conversationId, sdkSessionId, title }) {
  const db = new Database(dbFile, { fileMustExist: true });
  try {
    const at = new Date().toISOString();
    db.prepare("INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(conversationId, title, sdkSessionId, at, at);
    db.prepare(`INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, strategy, runtime_key, model, provider_type, provider_model, status, created_at, last_used_at)
      VALUES (?, ?, ?, 'isolated', ?, ?, 'claude', ?, 'active', ?, ?)`)
      .run(`rs-${conversationId}`, conversationId, sdkSessionId, `runtime-key-${conversationId}`, FIXTURE_MODEL, FIXTURE_MODEL, at, at);
  } finally {
    db.close();
  }
}

// A turn queued for that conversation's worker (the relay is stopped): the
// next start primes the worker for it.
function addPendingTurn(dbFile, { conversationId, sdkSessionId }) {
  const db = new Database(dbFile, { fileMustExist: true });
  const id = `q-${randomUUID()}`;
  try {
    db.prepare(`INSERT INTO queue (id, conversation_id, runtime_session_id, model, relay_mode, text, status, timestamp, owner_sdk_session_id)
      VALUES (?, ?, ?, ?, 'agent', ?, 'pending', ?, ?)`)
      .run(id, conversationId, `rs-${conversationId}`, FIXTURE_MODEL, "fixture turn, read by a stand-in worker only", new Date().toISOString(), sdkSessionId);
  } finally {
    db.close();
  }
  return id;
}

// Resolves once a writer can open the database a stopped relay left: on
// Windows a killed relay's files can refuse one for a moment after its exit
// (SQLITE_IOERR_TRUNCATE on the -shm).
async function waitForWritableDatabase(dbFile, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const db = new Database(dbFile, { fileMustExist: true });
      try {
        db.exec("BEGIN IMMEDIATE; ROLLBACK;");
      } finally {
        db.close();
      }
      return;
    } catch (error) {
      if (!/^SQLITE_(IOERR|BUSY|LOCKED|CANTOPEN)/.test(String(error?.code || "")) || Date.now() > deadline) throw error;
      await sleep(500);
    }
  }
}

// The queue rows of a conversation (id → status), read through a copy as
// titlesIn does.
function queueStatusesIn(dbFile, conversationId) {
  const scratch = fs.mkdtempSync(path.join(root, "read-"));
  try {
    for (const suffix of ["", "-wal"]) {
      if (fs.existsSync(`${dbFile}${suffix}`)) fs.copyFileSync(`${dbFile}${suffix}`, path.join(scratch, `db${suffix}`));
    }
    const db = new Database(path.join(scratch, "db"), { fileMustExist: true });
    try {
      return Object.fromEntries(db.prepare("SELECT id, status FROM queue WHERE conversation_id = ?").all(conversationId).map((row) => [row.id, row.status]));
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
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

function copyDatabase(from, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const suffix of ["", "-wal"]) {
    if (fs.existsSync(`${from}${suffix}`)) fs.copyFileSync(`${from}${suffix}`, path.join(toDir, `copilot.db${suffix}`));
  }
  return path.join(toDir, "copilot.db");
}

// ─── The npm cache ──────────────────────────────────────────────────────────

const NETWORK_FAILURE = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTCACHED)\b/;

function hostLibc() {
  if (process.platform !== "linux") return null; // host-platform: the packed install runs on this host
  try { return process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl"; } catch { return null; }
}

const listAllows = (list, value) => {
  if (!Array.isArray(list) || !list.length) return true;
  if (list.includes(`!${value}`)) return false;
  const allowed = list.filter((item) => !String(item).startsWith("!"));
  return !allowed.length || allowed.includes(value);
};

// The packages a pins lockfile installs on this host, as name@version.
function hostSpecsOf(lock) {
  const libc = hostLibc();
  const specs = new Set();
  for (const [key, entry] of Object.entries(lock?.packages || {})) {
    if (!key || entry?.dev || entry?.link) continue;
    if (!listAllows(entry.os, process.platform) || !listAllows(entry.cpu, process.arch)) continue; // host-platform: the packed install runs on this host
    if (entry.libc && libc && !listAllows(entry.libc, libc)) continue;
    specs.add(`${key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length)}@${entry.version}`);
  }
  return [...specs];
}

/**
 * Puts what the relay's SDK store will install (the Claude pins, koffi's on
 * Windows; as the new tree `newSrc` has them) in the npm cache, from the
 * cache when it is there, and once online when a stale cached packument
 * names no such version (ETARGET; npm-cache-add.mjs). A failure for want of
 * a registry sets the suite's skip reason.
 */
async function warmAgentSdkCache(newSrc) {
  const ids = ["claude", ...(process.platform === "win32" ? ["koffi"] : [])]; // host-platform: the packed install runs on this host
  const specs = [];
  for (const id of ids) {
    // pin-lock.json; package-lock.json in a tree from before the rename.
    const folder = path.join(newSrc, "server", "agent-sdks", id);
    const lockFile = ["pin-lock.json", "package-lock.json"].map((name) => path.join(folder, name)).find((file) => fs.existsSync(file));
    const lock = fs.readFileSync(lockFile || path.join(folder, "pin-lock.json"), "utf8");
    specs.push(...hostSpecsOf(JSON.parse(lock)));
  }
  try {
    await addToNpmCache(npm, specs, { cwd: root, env: { ...hostlessEnv(), ...npmEnv() } });
  } catch (error) {
    const code = String(error.output || error.message).match(NETWORK_FAILURE)?.[1];
    if (!code) throw error;
    suiteSkip = `no npm registry and no warm npm cache here (npm cache add of the agent SDK pins failed with ${code}; cache ${npmSettings.cache})`;
  }
}

// ─── The stand-in worker ────────────────────────────────────────────────────

/**
 * A Claude worker stand-in, launched by the relay through
 * COPILOT_WEB_RELAY_CLAUDE_WORKER_PATH: it records its pid first (for the
 * clean-up), then the SDK folder it was launched with, loads the SDK through
 * the package's own loader (what the real worker's adapter does) and stays
 * up a while, so the relay's launch check sees it running. Its file name
 * ends in `-session-worker`, as every node worker's does: the relay's process
 * lookup (session-worker-process-service.mjs) finds a worker by that name.
 */
function writeStubWorker(state, pkg) {
  const dir = path.join(state.stateRoot, "worker-stub");
  const recordsDir = path.join(state.stateRoot, "worker-records");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  const loaderUrl = pathToFileURL(path.join(pkg, "server", "agent-sdk-loader.mjs")).href;
  const script = path.join(dir, "claude-stand-in-session-worker.mjs");
  fs.writeFileSync(script, `import fs from "node:fs";
import path from "node:path";

const recordsDir = ${JSON.stringify(recordsDir)};
fs.writeFileSync(path.join(recordsDir, \`\${process.pid}.started\`), "");
const at = process.argv.indexOf("--session-id");
const record = {
  pid: process.pid,
  sessionId: at >= 0 ? process.argv[at + 1] : null,
  kind: process.env.COPILOT_WEB_RELAY_WORKER_KIND || null,
  dir: process.env.OAR_AGENT_SDK_DIR_CLAUDE || null,
};
try {
  const { loadAgentSdk } = await import(${JSON.stringify(loaderUrl)});
  const sdk = await loadAgentSdk("claude");
  record.loaded = { query: typeof sdk.query, zObject: typeof sdk.z?.object };
} catch (error) {
  record.loadError = String(error?.stack || error);
}
const file = path.join(recordsDir, \`\${process.pid}.json\`);
fs.writeFileSync(\`\${file}.tmp\`, JSON.stringify(record));
fs.renameSync(\`\${file}.tmp\`, file);
setTimeout(() => process.exit(0), 120_000);
`);
  return { script, recordsDir };
}

const readRecords = (recordsDir) => (fs.existsSync(recordsDir)
  ? fs.readdirSync(recordsDir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(recordsDir, name), "utf8")))
  : []);

/**
 * A Claude worker stand-in that lives (case E), launched by the relay
 * through COPILOT_WEB_RELAY_CLAUDE_WORKER_PATH. It runs the package's own
 * worker runtime (the relay link, the heartbeat, the API client), loaded at
 * its start as a real worker's code is, so it outlives an update of the
 * package and keeps speaking the protocol of the version it started on. It
 * states that version's build id and the claude kind in its hello and its
 * heartbeats, and reports its holds as a real Claude worker between turns
 * does, with its Claude Code child gone (cliAlive false).
 *
 * A turn delivered to it is answered while the SDK it would start Claude
 * Code from is there: the store folder it was launched with (this version),
 * else the package's own tree (0.9.23). Once that folder is gone the turn
 * fails, as a real worker's does when its SDK cannot start the CLI.
 *
 * It records its pid first (for the clean-up), then what it was launched
 * with and every delivery, in <recordsDir>/<pid>.json. Its file name ends in
 * `-session-worker`, as a real worker's does: on POSIX the relay finds the
 * processes it stops by that name in the process list, and a stand-in it
 * could not find would never be stopped by the recycle.
 */
function writeLiveStubWorker(state, pkg) {
  const dir = path.join(state.stateRoot, "worker-stub");
  const recordsDir = path.join(state.stateRoot, "worker-records");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  const script = path.join(dir, "claude-live-stand-in-session-worker.mjs");
  fs.writeFileSync(script, `import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pkg = ${JSON.stringify(pkg)};
const recordsDir = ${JSON.stringify(recordsDir)};
fs.writeFileSync(path.join(recordsDir, \`\${process.pid}.started\`), "");
const at = process.argv.indexOf("--session-id");
const sessionId = at >= 0 ? process.argv[at + 1] : null;
const load = (rel) => import(pathToFileURL(path.join(pkg, ...rel.split("/"))).href);
// All of its code, loaded now: an update may take the package's files later.
const [{ resolveRelayServerUrl, loadAgentToken, loadTokenFromConfig }, { createApiClient }, { createWorkerWebSocketLink }, { createHeartbeatController }, { resolveBuildId }] = await Promise.all([
  load("shared/worker-runtime/config-loader.mjs"),
  load("shared/worker-runtime/api-client.mjs"),
  load("shared/worker-runtime/worker-websocket-link.mjs"),
  load("shared/worker-runtime/heartbeat.mjs"),
  load("shared/build-id.mjs"),
]);
const kind = String(process.env.COPILOT_WEB_RELAY_WORKER_KIND || "claude").trim() || "claude";
const buildId = resolveBuildId(pkg).id;
const sdkDir = process.env.OAR_AGENT_SDK_DIR_CLAUDE || null;
const sdkPackageDir = path.join(sdkDir || pkg, "node_modules", "@anthropic-ai", "claude-agent-sdk");
const record = { pid: process.pid, sessionId, kind, buildId, dir: sdkDir, sdkPackageDir, sdkPresentAtStart: fs.existsSync(sdkPackageDir), deliveries: [] };
if (sdkDir) {
  try {
    const { loadAgentSdk } = await load("server/agent-sdk-loader.mjs");
    const sdk = await loadAgentSdk("claude");
    record.loaded = { query: typeof sdk.query, zObject: typeof sdk.z?.object };
  } catch (error) {
    record.loadError = String(error?.stack || error);
  }
}
const file = path.join(recordsDir, \`\${process.pid}.json\`);
const save = () => {
  fs.writeFileSync(\`\${file}.tmp\`, JSON.stringify(record));
  fs.renameSync(\`\${file}.tmp\`, file);
};
save();

const configPath = String(process.env.COPILOT_WEB_RELAY_CONFIG || "");
const serverUrl = resolveRelayServerUrl({ configPath });
// The session's agent token (this version); a package from before it read the
// owner token from the config.
const token = String(process.env.OAR_AGENT_TOKEN || "").trim()
  || (typeof loadAgentToken === "function" ? loadAgentToken({ env: process.env, configPath }) : "")
  || (typeof loadTokenFromConfig === "function" ? loadTokenFromConfig(configPath) : "");
const api = createApiClient({
  serverUrl,
  token,
  getHeaders: () => ({
    "X-Relay-Process-Pid": String(process.pid),
    "X-Relay-Parent-Pid": String(process.ppid),
    "X-Relay-Session-Id": sessionId,
    "X-Relay-Conversation-Id": sessionId,
  }),
});
let active = null;
const steering = () => ({
  turnActive: Boolean(active), canSteer: false, holdReason: null, messageId: active, supported: false, autoCompactWindow: null,
  releasable: !active, releaseHold: active ? "turn" : null, backgroundTaskCount: 0, cliAlive: false,
});
let heartbeatTimer = null;
const heartbeat = createHeartbeatController({
  api, buildId, workerKind: kind, pollMs: 10_000, getSessionReady: () => true,
  getHeartbeatTimer: () => heartbeatTimer, setHeartbeatTimer: (timer) => { heartbeatTimer = timer; },
  getActiveQueueMessageId: () => active, getActiveQueueMessageIds: () => (active ? [active] : []), getSteeringState: steering,
});
const link = createWorkerWebSocketLink({
  serverUrl, token, getSessionReady: () => true, getSessionId: () => sessionId, getPid: () => process.pid,
  workerKind: kind, buildId, onServerHello: () => heartbeat.requestPulse(),
  onDeliver: async (pending) => {
    const message = pending?.message;
    if (!message?.id) return false;
    active = message.id;
    const entry = { id: message.id, at: new Date().toISOString() };
    const attempt = message.attemptId ? { attemptId: message.attemptId } : {};
    try {
      if (fs.existsSync(sdkPackageDir)) {
        await api("POST", "/api/response", { messageId: message.id, conversationId: message.conversationId, text: \`A stand-in worker (pid \${process.pid}) answered.\`, ...attempt });
        entry.outcome = "answered";
      } else {
        await api("POST", "/api/response", {
          messageId: message.id, conversationId: message.conversationId, text: "",
          terminalError: { code: "claude-code-not-found", message: \`Claude Code could not be started: \${sdkPackageDir} is gone.\` },
          ...attempt,
        });
        entry.outcome = "failed";
      }
    } catch (error) {
      entry.outcome = "error";
      entry.error = String(error?.message || error);
    } finally {
      active = null;
      record.deliveries.push(entry);
      save();
      heartbeat.requestPulse();
    }
    return true;
  },
});
heartbeat.startHeartbeat();
link.start();
setTimeout(() => process.exit(0), 30 * 60_000);
`);
  return { script, recordsDir };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Polls `probe` until it returns something; fails at once when the relay exits.
async function waitFor(relay, probe, { timeoutMs, what }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = probe();
    if (found) return found;
    if (relay.proc.exitCode !== null) throw new Error(`the relay exited (${relay.proc.exitCode}) while waiting for ${what}\n${relay.output.slice(-20_000)}`);
    await sleep(500);
  }
  throw new Error(`no ${what} within ${Math.round(timeoutMs / 1000)} s\n--- relay output ---\n${relay.output.slice(-20_000)}`);
}

// Every stand-in worker and every npm an SDK install left, under `base`.
async function killLeftovers(base) {
  if (!base || !fs.existsSync(base)) return;
  const pids = new Set();
  for (const state of fs.readdirSync(base).filter((name) => name.startsWith("state-"))) {
    const recordsDir = path.join(base, state, "worker-records");
    if (fs.existsSync(recordsDir)) {
      for (const name of fs.readdirSync(recordsDir)) if (name.endsWith(".started")) pids.add(Number.parseInt(name, 10));
    }
    const sdkDir = path.join(base, state, "sdks");
    if (!fs.existsSync(sdkDir)) continue;
    for (const id of fs.readdirSync(sdkDir)) {
      let names = [];
      try { names = fs.readdirSync(path.join(sdkDir, id)); } catch { continue; }
      for (const name of names.filter((entry) => /\.partial-[0-9a-f]+$/.test(entry))) {
        try { pids.add(Number(JSON.parse(fs.readFileSync(path.join(sdkDir, id, name, ".owner.json"), "utf8")).pid)); } catch {}
      }
    }
  }
  for (const pid of pids) await killTree(pid);
}

/** The installed package's own store paths module (the relay's checks). */
async function storePathsOf(pkg) {
  return import(pathToFileURL(path.join(pkg, "server", "services", "agent-sdk-paths.mjs")).href);
}

/**
 * Waits until the store's pinned folder of `pin` checks out (marker and
 * files, as the relay judges it); fails at once on the store's failure line.
 */
async function waitForAgentSdk(relay, { sdkDir, pin, paths }) {
  const dir = path.join(sdkDir, pin.id, pin.dirName);
  const failure = new RegExp(`\\[agent-sdk\\] ${pin.id}: (?!installing )(.+)`);
  const deadline = Date.now() + SDK_INSTALL_WAIT_MS;
  while (Date.now() < deadline) {
    if (paths.isValidAgentSdkInstall(dir, { pin })) return dir;
    const failed = relay.output.match(failure);
    if (failed) throw new Error(`the ${pin.id} SDK install failed: ${failed[1]}\n--- relay output ---\n${relay.output.slice(-20_000)}`);
    if (relay.proc.exitCode !== null) throw new Error(`the relay exited (${relay.proc.exitCode}) before the ${pin.id} SDK was installed\n${relay.output.slice(-20_000)}`);
    await sleep(1000);
  }
  throw new Error(`no finished ${pin.id} SDK in ${dir} after ${SDK_INSTALL_WAIT_MS / 60_000} minutes\n--- relay output ---\n${relay.output.slice(-20_000)}`);
}

async function waitForWorkerRecord(relay, recordsDir) {
  const deadline = Date.now() + WORKER_LAUNCH_WAIT_MS;
  while (Date.now() < deadline) {
    const records = readRecords(recordsDir);
    if (records.length) return records[0];
    const failed = relay.output.match(/could not be installed: .+|is not available on this platform|worker launcher: session=\S+ (?:cannot start|could not start)[^\n]*/);
    if (failed) throw new Error(`no worker launched: ${failed[0]}\n--- relay output ---\n${relay.output.slice(-20_000)}`);
    if (relay.proc.exitCode !== null) throw new Error(`the relay exited (${relay.proc.exitCode}) before a worker launched\n${relay.output.slice(-20_000)}`);
    await sleep(500);
  }
  throw new Error(`no worker launched within ${WORKER_LAUNCH_WAIT_MS / 1000} s\n--- relay output ---\n${relay.output.slice(-20_000)}`);
}

const VERSION_FOLDER = /^\d[\w.+-]*-[0-9a-f]{8}$/;
const versionFolders = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => VERSION_FOLDER.test(name)) : []);

describe("packed npm updates (0.9.19, 0.9.23) -> this branch", () => {
  let oldPack;
  let newPack;
  let prefixA = "";

  before(async () => {
    assertTempHasRoom({ backup: false });
    root = fs.mkdtempSync(path.join(tmpBase, "oar-packed-update-"));
    try {
      await run("git", ["-C", repoRoot, "cat-file", "-e", `${OLD_REF}^{commit}`]);
    } catch {
      suiteSkip = `${OLD_REF} (0.9.19) is not in this clone (a shallow clone?): fetch the full history`;
      return;
    }
    const config = async (key) => (await npm(["config", "get", key], { cwd: root })).stdout.trim();
    npmSettings = { cache: await config("cache"), registry: await config("registry") };
    const newSrc = NEW_TGZ ? await extractTarball(NEW_TGZ, "new") : await extractRef(NEW_REF, "new");
    await warmAgentSdkCache(newSrc);
    if (suiteSkip) return;
    oldPack = await packRef(OLD_REF, "old");
    // A tarball of the working tree states HEAD's commit too: what counts is
    // that its build id is not the version alone.
    const head = (await run("git", ["-C", repoRoot, "rev-parse", `${NEW_REF}^{commit}`])).stdout.trim();
    newPack = await packTree(newSrc, "new", { gitHead: head });
    if (NEW_TGZ) console.log(`# new package: ${NEW_TGZ} (OAR_PACKED_UPDATE_NEW_TGZ), build ${newPack.buildId}`);
  }, SLOW);

  after(async () => {
    for (const proc of children) {
      if (process.platform === "win32") await killTree(proc.pid); // host-platform: the packed install runs on this host
      try { proc.kill("SIGKILL"); } catch {}
    }
    await killLeftovers(root);
    // Let the killed processes release their files before the folder goes.
    await sleep(children.size || process.platform === "win32" ? 1500 : 0); // host-platform: the packed install runs on this host
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });

  // 0.9.19 into `prefix`, started once on `state` and stopped: its copilot.db.
  async function installOldAndRunOnce({ prefix, state }) {
    const pkg = packageDirOf(prefix);
    await npmInstallGlobal({ prefix, tgz: oldPack.tgz, stateRoot: state.stateRoot, allowScripts: OLD_ALLOW_SCRIPTS_ARG });
    assert.ok(!fs.existsSync(path.join(pkg, "server", "services", "database-file.mjs")), "the old install is 0.9.19 (no database-file.mjs)");
    assert.ok(fs.existsSync(path.join(pkg, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json")), "0.9.19 has the Claude SDK in its tree");
    const old = await startInstalledRelay({ pkg, state });
    await stopRelay(old);
    // 0.9.19 knows one name only.
    assert.ok(fs.existsSync(path.join(state.dataDir, "copilot.db")), `0.9.19 left no copilot.db\n${old.output.slice(-20_000)}`);
    assert.deepEqual(dbFiles(state.dataDir, "oar.db"), []);
  }

  test("A: pinned data folder: this version runs on 0.9.19's copilot.db and backs it up first", SLOW, async (t) => {
    if (suiteSkip) return t.skip(suiteSkip);
    assertTempHasRoom({ backup: true });
    const state = makeState("a");
    const backupsDir = path.join(state.stateRoot, "backups");
    // dbBackups is unknown to 0.9.19, which ignores it.
    writeConfig(state, { dbBackups: { dir: backupsDir } });
    prefixA = path.join(root, "prefix-a");
    const pkg = packageDirOf(prefixA);

    await installOldAndRunOnce({ prefix: prefixA, state });
    oldDbSnapshot = copyDatabase(path.join(state.dataDir, "copilot.db"), path.join(root, "old-db"));
    addMarker(path.join(state.dataDir, "copilot.db"), "marker-a");

    // The update, without --allow-scripts.
    await npmInstallGlobal({ prefix: prefixA, tgz: newPack.tgz, stateRoot: state.stateRoot });
    assert.ok(isNewInstall(prefixA), "the update installed the new package");
    // The agent SDKs, koffi and zod are no longer in the package's tree.
    const left = ON_DEMAND_PACKAGES.filter((name) => fs.existsSync(path.join(pkg, "node_modules", ...name.split("/"))));
    assert.deepEqual(left, [], `still in ${path.join(pkg, "node_modules")} after the update`);

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
    assert.equal(backups.length, 1, `one backup in ${backupsDir}: ${JSON.stringify(backups)}; last result ${JSON.stringify(manifest?.lastResult)}\n${relay.output.slice(-20_000)}`);
    assert.match(backups[0], expected);
    assert.deepEqual(manifest.backups.map((entry) => entry.file), [backups[0]]);
    assert.equal(manifest.lastResult?.status, "written");
    // The backup is of the old relay's data.
    assert.deepEqual(titlesIn(path.join(backupsDir, backups[0])), ["marker-a"]);
  });

  test("C: fresh data folder: this version creates oar.db, no copilot.db", SLOW, async (t) => {
    if (suiteSkip) return t.skip(suiteSkip);
    const state = makeState("c");
    writeConfig(state, { dbBackups: { dir: path.join(state.stateRoot, "backups") } });
    // The new install of case A; installed here when A stopped before it.
    if (!prefixA) prefixA = path.join(root, "prefix-a");
    const pkg = packageDirOf(prefixA);
    if (!isNewInstall(prefixA)) {
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

  test("D: agent SDKs on demand: the updated relay installs the Claude SDK for a Claude chat, and its worker launches from that folder", SLOWER, async (t) => {
    if (suiteSkip) return t.skip(suiteSkip);
    const state = makeState("d");
    writeConfig(state, { dbBackups: { dir: path.join(state.stateRoot, "backups") } });
    assert.ok(state.sdkDir.length <= 100, `${state.sdkDir} is too long for the SDK store; set OAR_PACKED_UPDATE_TMP to a shorter folder`);

    // A database 0.9.19 left (A's, copied before its marker), and the
    // updated install of A; both made here when A did not get that far.
    let prefix = prefixA;
    if (oldDbSnapshot && fs.existsSync(oldDbSnapshot)) {
      copyDatabase(oldDbSnapshot, state.dataDir);
    } else {
      prefix = path.join(root, "prefix-d");
      await installOldAndRunOnce({ prefix, state });
    }
    if (!isNewInstall(prefix)) await npmInstallGlobal({ prefix, tgz: newPack.tgz, stateRoot: state.stateRoot });
    const pkg = packageDirOf(prefix);
    const dbFile = path.join(state.dataDir, "copilot.db");

    const fixture = { conversationId: `c-${randomUUID()}`, sdkSessionId: randomUUID(), title: "Lantern harbour field notes" };
    addClaudeConversation(dbFile, fixture);
    const stub = writeStubWorker(state, pkg);
    const relayEnv = {
      // Workers launched by the relay, with the stand-in for Claude's.
      COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED: "1",
      COPILOT_WEB_RELAY_CLAUDE_WORKER_PATH: stub.script,
      // The SDKs from the cache the setup filled, and once online for a
      // version a stale cached packument does not know (sdkInstallEnv).
      npm_config_prefer_offline: "true",
      ...sdkInstallEnv(state, pkg),
    };

    const paths = await storePathsOf(pkg);
    const pin = paths.readAgentSdkPin("claude");
    const expectedDir = path.join(state.sdkDir, "claude", pin.dirName);
    assert.match(pin.dirName, new RegExp(`^${pin.version.replace(/\./g, "\\.")}-[0-9a-f]{8}$`));

    // The first start: the store's start-up pass installs the Claude SDK
    // because the conversation is on the claude provider; the start does not
    // wait for it.
    const first = await startInstalledRelay({ pkg, state, allowSpawn: true, env: relayEnv });
    let status = null;
    try {
      assert.equal(await waitForAgentSdk(first, { sdkDir: state.sdkDir, pin, paths }), expectedDir);
      // The relay's own check of Windows locks gets koffi the same way.
      if (process.platform === "win32") await waitForAgentSdk(first, { sdkDir: state.sdkDir, pin: paths.readAgentSdkPin("koffi"), paths }); // host-platform: the packed install runs on this host
      status = await agentSdkStatus(first);
    } finally {
      await stopRelay(first);
    }
    assert.ok(first.output.includes(`[agent-sdk] claude: installing ${pin.version} (start-up)`), `the start-up pass installed it\n${first.output.slice(-20_000)}`);
    const marker = paths.readAgentSdkMarker(expectedDir);
    assert.deepEqual({ id: marker?.id, version: marker?.version, hash: marker?.hash }, { id: "claude", version: pin.version, hash: pin.hash });
    assert.deepEqual(versionFolders(path.join(state.sdkDir, "claude")), [pin.dirName]);
    // No Cursor chat, Cursor not enabled: no Cursor SDK.
    assert.deepEqual(versionFolders(path.join(state.sdkDir, "cursor")), []);
    // Nothing was installed into the package itself.
    assert.ok(!fs.existsSync(path.join(pkg, "node_modules", "@anthropic-ai", "claude-agent-sdk")));
    if (status) {
      assert.equal(status.sdks?.claude?.state, "ready", JSON.stringify(status.sdks?.claude));
      assert.equal(path.resolve(status.sdks.claude.dir), expectedDir);
      assert.equal(path.resolve(status.root), path.resolve(state.sdkDir));
    } else {
      t.diagnostic("GET /api/agent-sdks/status is not in this build; judged by the folder and its marker");
    }

    // The next start, with a turn queued for the conversation: the launch
    // gate passes the ready folder, the worker loads the SDK from it.
    addPendingTurn(dbFile, fixture);
    // The same token: once relay-secrets.json exists a --token that differs is ignored.
    const second = await startInstalledRelay({ pkg, state, allowSpawn: true, env: relayEnv, token: first.token });
    let record;
    try {
      record = await waitForWorkerRecord(second, stub.recordsDir);
    } finally {
      await stopRelay(second);
      await killLeftovers(root);
    }
    assert.equal(record.sessionId, fixture.sdkSessionId, JSON.stringify(record));
    assert.equal(record.kind, "claude", JSON.stringify(record));
    assert.equal(record.dir && path.resolve(record.dir), expectedDir, `OAR_AGENT_SDK_DIR_CLAUDE of the worker\n${second.output.slice(-20_000)}`);
    assert.equal(record.loadError, undefined, record.loadError);
    assert.deepEqual(record.loaded, { query: "function", zObject: "function" });
    // The worker holds a lease on the folder it runs on, so no clean-up
    // takes it while it runs.
    const leases = fs.readdirSync(path.join(state.sdkDir, "claude", ".leases", pin.dirName));
    assert.ok(leases.some((name) => name.startsWith(`${record.pid}-`)), `a lease of the worker (pid ${record.pid}) in ${JSON.stringify(leases)}`);
  });

  test("E: a 0.9.23 Claude worker kept running across the update: the first message after it goes to a new worker on the store's SDK, and no turn fails", SLOWER, async (t) => {
    if (suiteSkip) return t.skip(suiteSkip);
    try {
      await run("git", ["-C", repoRoot, "cat-file", "-e", `${SDK_IN_PACKAGE_REF}^{commit}`]);
    } catch {
      return t.skip(`${SDK_IN_PACKAGE_REF} (0.9.23) is not in this clone (a shallow clone?): fetch the full history`);
    }
    const state = makeState("e");
    assert.ok(state.sdkDir.length <= 100, `${state.sdkDir} is too long for the SDK store; set OAR_PACKED_UPDATE_TMP to a shorter folder`);
    // One port and one token for both relays, in config.json too: the worker
    // finds its relay, and the new relay after the update, from there.
    const port = await reserveFreePort();
    const token = randomUUID();
    writeConfig(state, { dbBackups: { dir: path.join(state.stateRoot, "backups") }, port, authToken: token });
    const prefix = path.join(root, "prefix-e");
    const pkg = packageDirOf(prefix);

    // 0.9.23, started once for its database.
    const oldPack23 = await packRef(SDK_IN_PACKAGE_REF, "e-old");
    assert.equal(oldPack23.version, "0.9.23");
    assert.notEqual(newPack.buildId, oldPack23.buildId, "the new package states another build id");
    await npmInstallGlobal({ prefix, tgz: oldPack23.tgz, stateRoot: state.stateRoot, allowScripts: "--allow-scripts=koffi" });
    const oldSdkDir = path.join(pkg, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    assert.ok(fs.existsSync(path.join(oldSdkDir, "package.json")), "0.9.23 has the Claude SDK in its tree");
    const once = await startInstalledRelay({ pkg, state, port, token });
    await stopRelay(once);
    const dbFile = ["oar.db", "copilot.db"].map((name) => path.join(state.dataDir, name)).find((file) => fs.existsSync(file));
    assert.ok(dbFile, `0.9.23 left no database in ${state.dataDir}\n${once.output.slice(-20_000)}`);
    await waitForWritableDatabase(dbFile);

    const fixture = { conversationId: `c-${randomUUID()}`, sdkSessionId: randomUUID(), title: "Copperfield tide tables" };
    addClaudeConversation(dbFile, fixture);
    const firstTurn = addPendingTurn(dbFile, fixture);
    const stub = writeLiveStubWorker(state, pkg);
    const relayEnv = {
      COPILOT_REMOTE_SESSION_WORKER_ROUTING_ENABLED: "1",
      COPILOT_WEB_RELAY_CLAUDE_WORKER_PATH: stub.script,
      npm_config_prefer_offline: "true",
      ...sdkInstallEnv(state, pkg),
    };
    const deliveryOf = (id) => () => {
      for (const record of readRecords(stub.recordsDir)) {
        const delivery = (record.deliveries || []).find((entry) => entry.id === id);
        if (delivery) return { record, delivery };
      }
      return null;
    };

    // The 0.9.23 relay launches its worker for the queued turn, which answers.
    const old = await startInstalledRelay({ pkg, state, allowSpawn: true, port, token, env: relayEnv });
    let before;
    try {
      before = await waitFor(old, deliveryOf(firstTurn), { timeoutMs: WORKER_LAUNCH_WAIT_MS, what: "answer from the 0.9.23 worker" });
    } finally {
      await stopRelay(old);
    }
    const oldWorker = before.record;
    assert.equal(before.delivery.outcome, "answered", JSON.stringify(before));
    assert.equal(oldWorker.kind, "claude");
    assert.equal(oldWorker.buildId, oldPack23.buildId, "the worker states 0.9.23's build id");
    assert.equal(oldWorker.dir, null, "0.9.23 passes no SDK folder");
    assert.equal(oldWorker.sdkPresentAtStart, true);
    assert.equal(queueStatusesIn(dbFile, fixture.conversationId)[firstTurn], "done");
    assert.ok(isAlive(oldWorker.pid), "the 0.9.23 worker outlives its relay, as workers do across a restart");

    // The update, while that worker runs: the SDK it would start Claude Code
    // from leaves the package.
    await npmInstallGlobal({ prefix, tgz: newPack.tgz, stateRoot: state.stateRoot });
    assert.ok(isNewInstall(prefix), "the update installed the new package");
    assert.ok(!fs.existsSync(oldSdkDir), `${oldSdkDir} is gone after the update`);
    assert.ok(isAlive(oldWorker.pid), "the 0.9.23 worker still runs after the update");

    // A message queued for the conversation, and the new relay: the old worker
    // reconnects and asks for work, and the store installs the Claude SDK.
    await waitForWritableDatabase(dbFile);
    const nextTurn = addPendingTurn(dbFile, fixture);
    const paths = await storePathsOf(pkg);
    const pin = paths.readAgentSdkPin("claude");
    const expectedDir = path.join(state.sdkDir, "claude", pin.dirName);
    const relay = await startInstalledRelay({ pkg, state, allowSpawn: true, port, token, env: relayEnv });
    const startedAt = Date.now();
    let after;
    try {
      after = await waitFor(relay, deliveryOf(nextTurn), { timeoutMs: SDK_INSTALL_WAIT_MS + WORKER_LAUNCH_WAIT_MS, what: "delivery of the first message after the update" });
    } finally {
      await stopRelay(relay);
      await killLeftovers(root);
    }
    t.diagnostic(`first message after the update delivered ${Math.round((Date.now() - startedAt) / 1000)} s after the relay was up`);
    const output = relay.output;

    // Delivered to a new worker, on the store's folder, and answered.
    assert.notEqual(after.record.pid, oldWorker.pid, `the old worker got the message (${after.delivery.outcome})\n${output.slice(-20_000)}`);
    assert.equal(after.delivery.outcome, "answered", JSON.stringify(after));
    assert.equal(after.record.kind, "claude");
    assert.equal(after.record.buildId, newPack.buildId, "the new worker runs the new build");
    assert.equal(after.record.dir && path.resolve(after.record.dir), expectedDir, `OAR_AGENT_SDK_DIR_CLAUDE of the new worker\n${output.slice(-20_000)}`);
    assert.equal(after.record.loadError, undefined, after.record.loadError);
    assert.deepEqual(after.record.loaded, { query: "function", zObject: "function" });
    // The old worker got nothing after the update and was recycled.
    const oldAfter = readRecords(stub.recordsDir).find((record) => record.pid === oldWorker.pid);
    assert.deepEqual(oldAfter.deliveries.map((entry) => entry.id), [firstTurn], "the 0.9.23 worker got no message after the update");
    assert.ok(!isAlive(oldWorker.pid), "the 0.9.23 worker was stopped");
    const sid8 = fixture.sdkSessionId.slice(0, 8);
    assert.ok(output.includes(`[worker-recycle] recycling ${sid8} kind=claude from=${oldPack23.buildId} to=${newPack.buildId}`), `the recycle replaced it\n${output.slice(-20_000)}`);
    for (const line of output.split(/\r?\n/).filter((entry) => entry.includes("[worker-recycle]") || entry.includes(`session=${sid8}`)).slice(0, 40)) {
      t.diagnostic(line.trim().slice(0, 300));
    }
    // No turn failed.
    const statuses = queueStatusesIn(dbFile, fixture.conversationId);
    assert.deepEqual(statuses, { [firstTurn]: "done", [nextTurn]: "done" }, JSON.stringify(statuses));
  });
});
