#!/bin/sh
# POSIX launcher for cli-install-stub.mjs (the logic lives there;
# cli-install-stub.cmd is the Windows twin).
exec node "$(dirname "$0")/cli-install-stub.mjs" "$@"
