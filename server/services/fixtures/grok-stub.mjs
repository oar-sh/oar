// Stand-in for the `grok` CLI, injected through GROK_CLI_COMMAND so the auth
// service (and the CLI install/probe path) can be exercised without touching the
// host's real Grok login.
//
// Node port of grok-stub.sh so Windows can run it too (no shebang support, .sh
// not in PATHEXT); the platform wrappers next to it (`grok-stub.sh`,
// `grok-stub.cmd`) just exec this file. Batch was rejected as the port target
// because the poll interval is sub-second and `timeout /t` can't sleep below 1s.
//
// Mirrors the shapes probed live on Grok Build 1.0.13 (2026-08-31):
//   --version            -> `grok 1.0.13 (5e9a58528b76)`
//   update --check --json-> the machine-readable update payload
//   login --device-auth  -> a device URL carrying the code, the code again on its
//                           own line, one grey (SGR 90) warning line, then
//                           `Waiting for authorization...` and a poll loop. No
//                           TTY, no stdin read: the real CLI ignores stdin and
//                           exits by itself once the browser authorises.
//   logout               -> removes the fake auth.json
//
// The poll loop stands in for the browser: it exits 0 when GROK_STUB_SUCCESS_SENTINEL
// appears (writing the fake auth store) and non-zero when GROK_STUB_FAILURE_SENTINEL
// does. "Logged in" means GROK_STUB_AUTH_FILE exists, matching what
// readGrokCliAuthKey() actually looks at.

import fs from 'node:fs';
import process from 'node:process';

const env = process.env;
const VERSION = env.GROK_STUB_VERSION || '1.0.13';
const AUTH_FILE = env.GROK_STUB_AUTH_FILE || '';
const DEVICE_CODE = env.GROK_STUB_DEVICE_CODE || 'D7SV-M4TR';
const DEVICE_URL = env.GROK_STUB_DEVICE_URL
  || `https://accounts.x.ai/oauth2/device?user_code=${DEVICE_CODE}`;
const SUCCESS_SENTINEL = env.GROK_STUB_SUCCESS_SENTINEL || '';
const FAILURE_SENTINEL = env.GROK_STUB_FAILURE_SENTINEL || '';
const TIMEOUT_SECONDS = Number(env.GROK_STUB_TIMEOUT_SECONDS || '60');
const POLL_SECONDS = Number(env.GROK_STUB_POLL_SECONDS || '0.2');
const UPDATE_AVAILABLE = env.GROK_STUB_UPDATE_AVAILABLE || 'false';
const LATEST_VERSION = env.GROK_STUB_LATEST_VERSION || VERSION;

const [first = '', second = ''] = process.argv.slice(2);
const out = (text) => process.stdout.write(text);
const err = (text) => process.stderr.write(text);
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

if (first === '--version') {
  out(`grok ${VERSION} (5e9a58528b76)\n`);
  process.exit(0);
} else if (first === 'update' && second === '--check') {
  out(`{"currentVersion":"${VERSION}","latestVersion":"${LATEST_VERSION}","updateAvailable":${UPDATE_AVAILABLE},"installer":"internal","channel":"stable","autoUpdate":null,"error":null}\n`);
  process.exit(0);
} else if (first === 'login' && second === '--device-auth') {
  // Byte-for-byte the banner the real CLI printed under piped stdio, including
  // the blank lines and the one grey warning line — the escape-stripping in the
  // URL/code scrape is tested against exactly this.
  out(`\nTo sign in, open this URL in your browser:\n\n  ${DEVICE_URL}\n\n`);
  out('  (Could not open browser automatically — open the URL above manually.)\n\n');
  out(`Confirm this code in your browser:\n\n  ${DEVICE_CODE}\n\n`);
  out('\x1b[90mOnly continue with a code you requested. Do not share it with anyone.\x1b[0m\n\n');
  out('Waiting for authorization...\n');
  const deadline = Date.now() + TIMEOUT_SECONDS * 1000;
  while (Date.now() <= deadline) {
    if (FAILURE_SENTINEL && fs.existsSync(FAILURE_SENTINEL)) {
      err('\nAuthorization failed: the device code expired.\n');
      process.exit(1);
    }
    if (SUCCESS_SENTINEL && fs.existsSync(SUCCESS_SENTINEL)) {
      if (AUTH_FILE) {
        // Deliberately short fake key: anything 32+ characters long trips the
        // secret scanner in server/test-hygiene.test.mjs.
        fs.writeFileSync(AUTH_FILE, '{"https://auth.x.ai::stub":{"key":"grok-stub-key","create_time":"2026-08-31T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}}\n');
      }
      out('\nSigned in.\n');
      process.exit(0);
    }
    await sleep(POLL_SECONDS);
  }
  err('\nTimed out waiting for authorization.\n');
  process.exit(1);
} else if (first === 'logout') {
  if (AUTH_FILE) {
    fs.rmSync(AUTH_FILE, { force: true });
  }
  out('Signed out.\n');
  process.exit(0);
} else {
  err(`grok-stub: unsupported command: ${process.argv.slice(2).join(' ')}\n`);
  process.exit(2);
}
