import path from "path";

// Single source of truth for how e2e specs reach the relay under test.
// Everything comes from env vars set by tests/run-e2e.mjs. There are
// deliberately NO fallbacks to server/config.json, server/data/copilot.db,
// or http://127.0.0.1:3333 — those belong to the live relay, and specs
// must never read from or write to it.

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(
      `${name} is not set. E2E specs only run against the isolated test server — start them via \`npm run test:e2e\`.`
    );
  }
  return value;
}

export function relayToken() {
  return requireEnv("RELAY_TEST_TOKEN");
}

export function relayBaseUrl() {
  return requireEnv("PLAYWRIGHT_BASE_URL");
}

export function relayDataDir() {
  return requireEnv("RELAY_TEST_DATA_DIR");
}

export function relayDbPath() {
  return path.join(relayDataDir(), "copilot.db");
}
