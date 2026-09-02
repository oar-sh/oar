#!/bin/sh
# Stand-in for a vendor CLI installer, injected through
# COPILOT_WEB_RELAY_CLI_INSTALL_COMMAND so the install flow can be exercised end
# to end without ever fetching from x.ai / claude.ai or writing to the host's
# real bin directories.
#
# The install service calls it as:  cli-install-stub.sh <provider> <action>
# (both values come from the frozen descriptor table, never from a request
# body). It prints installer-shaped progress, then writes a fake binary into
# CLI_INSTALL_STUB_BIN_DIR — which the relay is pointed at through
# COPILOT_WEB_RELAY_CLI_BIN_DIR — so the resolve -> bind -> broadcast chain runs
# against something real.
#
#   CLI_INSTALL_STUB_BIN_DIR   where the fake binary lands (required)
#   CLI_INSTALL_STUB_VERSION   version the fake binary reports (default 9.9.9)
#   CLI_INSTALL_STUB_FAIL      non-empty -> print an error and exit 1
#   CLI_INSTALL_STUB_SLEEP     seconds to stall mid-install (cancel/timeout tests)

provider="$1"
action="$2"
bin_dir="${CLI_INSTALL_STUB_BIN_DIR:-}"
version="${CLI_INSTALL_STUB_VERSION:-9.9.9}"

printf 'Installing %s (%s)…\n' "$provider" "$action"
printf 'Resolving latest release for linux-x86_64\n'

if [ -n "${CLI_INSTALL_STUB_SLEEP:-}" ]; then
  sleep "$CLI_INSTALL_STUB_SLEEP"
fi

if [ -n "${CLI_INSTALL_STUB_FAIL:-}" ]; then
  printf 'error: download failed (stub)\n' >&2
  exit 1
fi

if [ -z "$bin_dir" ]; then
  printf 'cli-install-stub: CLI_INSTALL_STUB_BIN_DIR is not set\n' >&2
  exit 2
fi

mkdir -p "$bin_dir"
target="$bin_dir/$provider"

# The fake binary answers exactly the probes cli-install-service runs: the
# version banner in each descriptor's shape, `update --check --json` for Grok,
# and `doctor` for Claude.
cat > "$target" <<STUB
#!/bin/sh
case "\$1 \$2" in
  "--version ")
    case "$provider" in
      grok)    printf 'grok %s (stubcommit) [stable]\n' "$version" ;;
      claude)  printf '%s (Claude Code)\n' "$version" ;;
      *)       printf '%s\n' "$version" ;;
    esac
    exit 0
    ;;
  "update --check")
    printf '{"currentVersion":"%s","latestVersion":"%s","updateAvailable":false,"installer":"internal","channel":"stable","autoUpdate":null,"error":null}\n' "$version" "$version"
    exit 0
    ;;
  "doctor ")
    printf 'Running: native (%s)\n' "$version"
    printf 'Path: %s\n' "$target"
    printf 'Auto-updates: enabled\n'
    exit 0
    ;;
esac
printf 'cli-stub: unsupported command: %s\n' "\$*" >&2
exit 2
STUB
chmod +x "$target"

printf 'Installed %s %s to %s\n' "$provider" "$version" "$target"
exit 0
