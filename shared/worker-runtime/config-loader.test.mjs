import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import { applySchema } from "../../server/db-schema.mjs";
import { RESCUE_DIR_NAME, adoptEarlierDatabase } from "../../server/services/earlier-database-service.mjs";
import { carryOverPackageConfig, resolveRelayPaths, resolveRelayServerUrl } from "./config-loader.mjs";
import { useScratchProcessEnv } from "../../server/services/scratch-env-test-harness.mjs";
// Home and state folders of this process point into a scratch folder.
useScratchProcessEnv();

function withConfig(config, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-relay-config-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
  try {
    return callback(configPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveRelayServerUrl uses the configured local relay port", () => {
  withConfig({ port: 22222, localhostOnly: true }, (configPath) => {
    assert.equal(resolveRelayServerUrl({ configPath, env: {} }), "http://127.0.0.1:22222");
  });
});

test("resolveRelayServerUrl maps wildcard bind hosts to loopback", () => {
  withConfig({ port: 4444, host: "0.0.0.0" }, (configPath) => {
    assert.equal(resolveRelayServerUrl({ configPath, env: {} }), "http://127.0.0.1:4444");
  });
});

test("resolveRelayServerUrl accepts an explicit HTTP endpoint override", () => {
  withConfig({ port: 3333 }, (configPath) => {
    assert.equal(
      resolveRelayServerUrl({
        configPath,
        env: { COPILOT_WEB_RELAY_SERVER_URL: "https://127.0.0.1:24443/base?ignored=true" },
      }),
      "https://127.0.0.1:24443",
    );
  });
});

// ─── A global install's extension relay: the state root's folders ───────────

// An installed package (no .git) with the extension, as `npm i -g` lays it
// out, and a default state root (APPDATA\oar; the platform is injected).
function withInstalledPackage(callback, { checkout = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-relay-paths-"));
  const packageRoot = path.join(root, "npm", "node_modules", "@oar-sh", "oar");
  const extension = path.join(packageRoot, ".github", "extensions", "web-relay", "extension.mjs");
  fs.mkdirSync(path.dirname(extension), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "server"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "server", "server.js"), "");
  if (checkout) fs.mkdirSync(path.join(packageRoot, ".git"));
  const stateRoot = path.join(root, "appdata", "oar");
  try {
    return callback({ root, packageRoot, extensionUrl: pathToFileURL(extension).href, stateRoot, env: { APPDATA: path.join(root, "appdata") } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a global install's extension pins the relay to the state root's config, data and logs", () => {
  withInstalledPackage(({ packageRoot, extensionUrl, stateRoot, env }) => {
    const paths = resolveRelayPaths(extensionUrl, { env, platform: "win32" });
    assert.equal(paths.SERVER_DIR, path.join(packageRoot, "server"));
    assert.equal(paths.CONFIG_PATH, path.join(stateRoot, "config.json"));
    assert.equal(paths.LOG_DIR, path.join(stateRoot, "logs"));
    assert.deepEqual(paths.RELAY_ENV, {
      COPILOT_WEB_RELAY_ROOT: packageRoot,
      COPILOT_WEB_RELAY_CONFIG: path.join(stateRoot, "config.json"),
      COPILOT_WEB_RELAY_DATA_DIR: path.join(stateRoot, "data"),
      COPILOT_WEB_RELAY_LOG_DIR: path.join(stateRoot, "logs"),
    });
  });
});

test("what the environment names wins, and a checkout keeps its own server/ folders", () => {
  withInstalledPackage(({ root, extensionUrl, env }) => {
    const own = { ...env, COPILOT_WEB_RELAY_CONFIG: path.join(root, "own.json"), COPILOT_WEB_RELAY_DATA_DIR: path.join(root, "own-data") };
    const paths = resolveRelayPaths(extensionUrl, { env: own, platform: "win32" });
    assert.equal(paths.CONFIG_PATH, path.join(root, "own.json"));
    assert.equal(paths.RELAY_ENV.COPILOT_WEB_RELAY_DATA_DIR, path.join(root, "own-data"));
  });
  withInstalledPackage(({ packageRoot, extensionUrl, env }) => {
    const paths = resolveRelayPaths(extensionUrl, { env, platform: "win32" });
    assert.equal(paths.CONFIG_PATH, path.join(packageRoot, "server", "config.json"));
    assert.equal(paths.LOG_DIR, path.join(packageRoot, "server", "logs"));
    assert.deepEqual(paths.RELAY_ENV, {});
  }, { checkout: true });
});

test("the config the package held is carried over once, never over one in the state root", () => {
  withInstalledPackage(({ packageRoot, stateRoot }) => {
    const serverDir = path.join(packageRoot, "server");
    const configPath = path.join(stateRoot, "config.json");
    const dataDir = path.join(stateRoot, "data");
    fs.writeFileSync(path.join(serverDir, "config.json"), '{"port":4444}');
    assert.equal(carryOverPackageConfig({ serverDir, configPath, dataDir }), path.join(serverDir, "config.json"));
    assert.equal(fs.readFileSync(configPath, "utf8"), '{"port":4444}');
    fs.writeFileSync(path.join(serverDir, "config.json"), '{"port":5555}');
    assert.equal(carryOverPackageConfig({ serverDir, configPath, dataDir }), null);
    assert.equal(fs.readFileSync(configPath, "utf8"), '{"port":4444}', "never overwritten");
    assert.ok(fs.existsSync(path.join(serverDir, "config.json")), "copied, not moved");
  });
});

test("after an update, the config the install-time rescue saved is the one carried over", () => {
  withInstalledPackage(({ packageRoot, stateRoot }) => {
    const dataDir = path.join(stateRoot, "data");
    const rescues = path.join(dataDir, RESCUE_DIR_NAME);
    for (const [name, port] of [["2026-10-19T10-00-00-000Z", 1111], ["2026-10-20T10-00-00-000Z", 2222], ["2026-10-21T10-00-00-000Z.partial", 3333]]) {
      fs.mkdirSync(path.join(rescues, name), { recursive: true });
      fs.writeFileSync(path.join(rescues, name, "config.json"), JSON.stringify({ port }));
    }
    const configPath = path.join(stateRoot, "config.json");
    carryOverPackageConfig({ serverDir: path.join(packageRoot, "server"), configPath, dataDir });
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).port, 2222, "the newest finished rescue");
  });
});

test("the old layout of a plain gh copilot relay is taken over on its first pinned start", () => {
  withInstalledPackage(({ packageRoot, extensionUrl, stateRoot, env }) => {
    const serverDir = path.join(packageRoot, "server");
    // What the unpinned extension relay left inside the package.
    fs.writeFileSync(path.join(serverDir, "config.json"), '{"port":4545,"authToken":"package-token"}');
    fs.mkdirSync(path.join(serverDir, "data"), { recursive: true });
    const marker = new Database(path.join(serverDir, "data", "copilot.db"));
    applySchema(marker);
    marker.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 'extension-marker', '2026-10-20T09:00:00.000Z', '2026-10-20T09:00:00.000Z')").run();
    marker.close();

    const paths = resolveRelayPaths(extensionUrl, { env, platform: "win32" });
    carryOverPackageConfig({ serverDir, configPath: paths.CONFIG_PATH, dataDir: paths.RELAY_ENV.COPILOT_WEB_RELAY_DATA_DIR });
    const relayEnv = { ...env, ...paths.RELAY_ENV };
    const result = adoptEarlierDatabase({
      dataDir: relayEnv.COPILOT_WEB_RELAY_DATA_DIR,
      uploadDir: path.join(relayEnv.COPILOT_WEB_RELAY_DATA_DIR, "uploads"),
      serverDir,
      configPath: paths.CONFIG_PATH,
      packageRoot,
      Database,
      env: relayEnv,
      platform: "win32",
      isProcessAlive: () => false,
      processStartedAt: () => null,
      bootTime: 0,
      logger: {},
      sleep: () => {},
    });
    assert.equal(result.status, "adopted");
    const pinned = new Database(path.join(stateRoot, "data", "copilot.db"), { readonly: true });
    assert.equal(pinned.prepare("SELECT title FROM conversations").get().title, "extension-marker");
    pinned.close();
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateRoot, "config.json"), "utf8")).authToken, "package-token");
  });
});

test("with a config in the state root, the carry-over does not even try to write", () => {
  withInstalledPackage(({ packageRoot, stateRoot }) => {
    const serverDir = path.join(packageRoot, "server");
    const configPath = path.join(stateRoot, "config.json");
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(configPath, '{"port":1}');
    fs.writeFileSync(path.join(serverDir, "config.json"), '{"port":2}');
    const writes = [];
    const spy = {
      ...fs,
      mkdirSync: (...args) => { writes.push(["mkdirSync", args[0]]); return fs.mkdirSync(...args); },
      copyFileSync: (...args) => { writes.push(["copyFileSync", args[1]]); return fs.copyFileSync(...args); },
    };
    assert.equal(carryOverPackageConfig({ serverDir, configPath, dataDir: path.join(stateRoot, "data"), fsImpl: spy }), null);
    assert.deepEqual(writes, []);
    assert.equal(fs.readFileSync(configPath, "utf8"), '{"port":1}');
  });
});

test("with a dataDir in config.json, the extension's relay still runs on the state root's data folder", () => {
  withInstalledPackage(({ root, extensionUrl, stateRoot, env }) => {
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.writeFileSync(path.join(stateRoot, "config.json"), JSON.stringify({ dataDir: path.join(root, "own-data") }));
    const paths = resolveRelayPaths(extensionUrl, { env, platform: "win32" });
    assert.equal(paths.RELAY_ENV.COPILOT_WEB_RELAY_DATA_DIR, path.join(stateRoot, "data"));
  });
});
