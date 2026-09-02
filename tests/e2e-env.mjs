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

// Fake credentials file the Claude auth stub CLI treats as "logged in".
// Lives under the test server's isolated CLAUDE_CONFIG_DIR, never the host's.
export function relayClaudeCredFile() {
  return requireEnv("RELAY_TEST_CLAUDE_CRED_FILE");
}

// Fake Grok auth store the stub CLI writes and readGrokCliAuthKey() reads.
// Lives under the test server's isolated HOME, never the host's ~/.grok.
export function relayGrokAuthFile() {
  return requireEnv("RELAY_TEST_GROK_AUTH_FILE");
}

// The stub's stand-in for authorising (or refusing) the device code in a
// browser: `grok login --device-auth` polls for these and then exits.
export function relayGrokLoginAuthorizedFile() {
  return requireEnv("RELAY_TEST_GROK_LOGIN_AUTHORIZED_FILE");
}

export function relayGrokLoginDeniedFile() {
  return requireEnv("RELAY_TEST_GROK_LOGIN_DENIED_FILE");
}

export function relayDbPath() {
  return path.join(relayDataDir(), "copilot.db");
}
