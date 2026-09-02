#!/bin/sh
# POSIX launcher for grok-stub.mjs (the logic lives there; grok-stub.cmd is the
# Windows twin).
exec node "$(dirname "$0")/grok-stub.mjs" "$@"
