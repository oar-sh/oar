#!/bin/sh
# POSIX launcher for claude-auth-stub.mjs (the logic lives there;
# claude-auth-stub.cmd is the Windows twin).
exec node "$(dirname "$0")/claude-auth-stub.mjs" "$@"
