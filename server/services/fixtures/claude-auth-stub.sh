#!/bin/sh
# Stand-in for the `claude` CLI auth subcommands, injected through
# COPILOT_WEB_RELAY_CLAUDE_AUTH_BIN so the auth service can be exercised without
# touching the host's real Claude login.
#
# Mirrors the shapes observed on CLI 2.1.247:
#   auth status --json -> one line of JSON
#   auth login         -> browser notice, an OSC-8 + SGR wrapped authorize URL,
#                         then `Paste code here if prompted > ` and a blocking read
#   auth logout        -> removes the credentials file
#
# Fake credentials file path comes from CLAUDE_AUTH_STUB_CRED_FILE; "logged in"
# means that file exists.

CRED_FILE="${CLAUDE_AUTH_STUB_CRED_FILE:-}"
AUTH_URL="${CLAUDE_AUTH_STUB_URL:-https://claude.com/oauth/authorize?code=true&client_id=stub-client&code_challenge=Xk3nQ7pLm2vB8sT1wY6zR0aC5dF9gH4jK7lN2oP3qS8&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback}"

command="$1 $2"

case "$command" in
  "auth status")
    if [ -n "$CRED_FILE" ] && [ -f "$CRED_FILE" ]; then
      printf '{"loggedIn":true,"authMethod":"claudeai","apiProvider":null,"email":"stub@example.com","orgId":"org_stub","orgName":"Stub Org","subscriptionType":"max"}\n'
    else
      printf '{"loggedIn":false,"authMethod":null,"apiProvider":null,"email":null,"orgId":null,"orgName":null,"subscriptionType":null}\n'
    fi
    exit 0
    ;;
  "auth login")
    printf 'Opening browser to sign in…\n'
    # OSC-8 hyperlink (target + visible label) wrapped in SGR colour codes, the
    # exact shape the real CLI emits under a PTY.
    printf 'If the browser did not open, visit: \033]8;;%s\033\\\033[4;34m%s\033[0m\033]8;;\033\\\n' "$AUTH_URL" "$AUTH_URL"
    printf '\033[2mPaste code here if prompted > \033[0m'
    if ! read -r submitted_code; then
      printf '\nAborted.\n'
      exit 1
    fi
    if [ "$submitted_code" = "goodcode" ]; then
      if [ -n "$CRED_FILE" ]; then
        # Deliberately short fake tokens: anything with 20+ characters after
        # `sk-ant-` trips the secret scanner in server/test-hygiene.test.mjs.
        printf '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-stub","refreshToken":"sk-ant-ort01-stub"}}\n' > "$CRED_FILE"
      fi
      printf '\nLogin successful. Logged in as stub@example.com\n'
      exit 0
    fi
    printf '\nOAuth error: invalid_grant - the authorization code is invalid or has expired.\n' >&2
    exit 1
    ;;
  "auth logout")
    if [ -n "$CRED_FILE" ]; then
      rm -f "$CRED_FILE"
    fi
    printf 'Logged out.\n'
    exit 0
    ;;
  *)
    printf 'claude-auth-stub: unsupported command: %s\n' "$*" >&2
    exit 2
    ;;
esac
