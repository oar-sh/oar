#!/bin/sh
# Stand-in for the `grok` CLI, injected through GROK_CLI_COMMAND so the auth
# service (and the CLI install/probe path) can be exercised without touching the
# host's real Grok login.
#
# Mirrors the shapes probed live on Grok Build 1.0.13 (2026-08-31):
#   --version            -> `grok 1.0.13 (5e9a58528b76)`
#   update --check --json-> the machine-readable update payload
#   login --device-auth  -> a device URL carrying the code, the code again on its
#                           own line, one grey (SGR 90) warning line, then
#                           `Waiting for authorization...` and a poll loop. No
#                           TTY, no stdin read: the real CLI ignores stdin and
#                           exits by itself once the browser authorises.
#   logout               -> removes the fake auth.json
#
# The poll loop stands in for the browser: it exits 0 when GROK_STUB_SUCCESS_SENTINEL
# appears (writing the fake auth store) and non-zero when GROK_STUB_FAILURE_SENTINEL
# does. "Logged in" means GROK_STUB_AUTH_FILE exists, matching what
# readGrokCliAuthKey() actually looks at.

set -u

VERSION="${GROK_STUB_VERSION:-1.0.13}"
AUTH_FILE="${GROK_STUB_AUTH_FILE:-}"
DEVICE_CODE="${GROK_STUB_DEVICE_CODE:-D7SV-M4TR}"
DEVICE_URL="${GROK_STUB_DEVICE_URL:-https://accounts.x.ai/oauth2/device?user_code=${DEVICE_CODE}}"
SUCCESS_SENTINEL="${GROK_STUB_SUCCESS_SENTINEL:-}"
FAILURE_SENTINEL="${GROK_STUB_FAILURE_SENTINEL:-}"
TIMEOUT_SECONDS="${GROK_STUB_TIMEOUT_SECONDS:-60}"
POLL_SECONDS="${GROK_STUB_POLL_SECONDS:-0.2}"
UPDATE_AVAILABLE="${GROK_STUB_UPDATE_AVAILABLE:-false}"
LATEST_VERSION="${GROK_STUB_LATEST_VERSION:-$VERSION}"

command="${1:-} ${2:-}"

case "$command" in
  "--version "*|"--version")
    printf 'grok %s (5e9a58528b76)\n' "$VERSION"
    exit 0
    ;;
  "update --check")
    printf '{"currentVersion":"%s","latestVersion":"%s","updateAvailable":%s,"installer":"internal","channel":"stable","autoUpdate":null,"error":null}\n' \
      "$VERSION" "$LATEST_VERSION" "$UPDATE_AVAILABLE"
    exit 0
    ;;
  "login --device-auth")
    # Byte-for-byte the banner the real CLI printed under piped stdio, including
    # the blank lines and the one grey warning line — the escape-stripping in the
    # URL/code scrape is tested against exactly this.
    printf '\nTo sign in, open this URL in your browser:\n\n  %s\n\n' "$DEVICE_URL"
    printf '  (Could not open browser automatically — open the URL above manually.)\n\n'
    printf 'Confirm this code in your browser:\n\n  %s\n\n' "$DEVICE_CODE"
    printf '\033[90mOnly continue with a code you requested. Do not share it with anyone.\033[0m\n\n'
    printf 'Waiting for authorization...\n'
    deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
    while [ "$(date +%s)" -le "$deadline" ]; do
      if [ -n "$FAILURE_SENTINEL" ] && [ -f "$FAILURE_SENTINEL" ]; then
        printf '\nAuthorization failed: the device code expired.\n' >&2
        exit 1
      fi
      if [ -n "$SUCCESS_SENTINEL" ] && [ -f "$SUCCESS_SENTINEL" ]; then
        if [ -n "$AUTH_FILE" ]; then
          # Deliberately short fake key: anything 32+ characters long trips the
          # secret scanner in server/test-hygiene.test.mjs.
          printf '{"https://auth.x.ai::stub":{"key":"grok-stub-key","create_time":"2026-08-31T00:00:00Z","expires_at":"2099-01-01T00:00:00Z"}}\n' > "$AUTH_FILE"
        fi
        printf '\nSigned in.\n'
        exit 0
      fi
      sleep "$POLL_SECONDS"
    done
    printf '\nTimed out waiting for authorization.\n' >&2
    exit 1
    ;;
  "logout "*|"logout")
    if [ -n "$AUTH_FILE" ]; then
      rm -f "$AUTH_FILE"
    fi
    printf 'Signed out.\n'
    exit 0
    ;;
  *)
    printf 'grok-stub: unsupported command: %s\n' "$*" >&2
    exit 2
    ;;
esac
