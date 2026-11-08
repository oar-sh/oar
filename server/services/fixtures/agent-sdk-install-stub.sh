#!/bin/sh
# POSIX launcher for agent-sdk-install-stub.mjs (the logic lives there;
# agent-sdk-install-stub.cmd is the Windows twin).
exec node "$(dirname "$0")/agent-sdk-install-stub.mjs" "$@"
