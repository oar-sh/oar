import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRelayServerUrl } from "./config-loader.mjs";

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
