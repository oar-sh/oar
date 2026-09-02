// Stand-in for a vendor CLI installer, injected through
// COPILOT_WEB_RELAY_CLI_INSTALL_COMMAND so the install flow can be exercised end
// to end without ever fetching from x.ai / claude.ai or writing to the host's
// real bin directories.
//
// Node port of cli-install-stub.sh so Windows can run it too; the platform
// wrappers next to it (`cli-install-stub.sh`, `cli-install-stub.cmd`) just exec
// this file.
//
// The install service calls it as:  cli-install-stub <provider> <action>
// (both values come from the frozen descriptor table, never from a request
// body). It prints installer-shaped progress, then writes a fake binary into
// CLI_INSTALL_STUB_BIN_DIR — which the relay is pointed at through
// COPILOT_WEB_RELAY_CLI_BIN_DIR — so the resolve -> bind -> broadcast chain runs
// against something real. The fake binary is itself a Node script behind a
// platform launcher: a bare `#!/bin/sh` file on POSIX, a `<provider>.cmd` shim
// on Windows (which also exercises the services' batch-launcher spawn path,
// the same shape a real npm-installed CLI has there).
//
//   CLI_INSTALL_STUB_BIN_DIR   where the fake binary lands (required)
//   CLI_INSTALL_STUB_VERSION   version the fake binary reports (default 9.9.9)
//   CLI_INSTALL_STUB_FAIL      non-empty -> print an error and exit 1
//   CLI_INSTALL_STUB_SLEEP     seconds to stall mid-install (cancel/timeout tests)

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [provider = '', action = ''] = process.argv.slice(2);
const binDir = process.env.CLI_INSTALL_STUB_BIN_DIR || '';
const version = process.env.CLI_INSTALL_STUB_VERSION || '9.9.9';
const out = (text) => process.stdout.write(text);
const err = (text) => process.stderr.write(text);

out(`Installing ${provider} (${action})…\n`);
out('Resolving latest release for linux-x86_64\n');

const stallSeconds = Number(process.env.CLI_INSTALL_STUB_SLEEP || '0');
if (stallSeconds > 0) {
  await new Promise((resolve) => setTimeout(resolve, stallSeconds * 1000));
}

if (process.env.CLI_INSTALL_STUB_FAIL) {
  err('error: download failed (stub)\n');
  process.exit(1);
}

if (!binDir) {
  err('cli-install-stub: CLI_INSTALL_STUB_BIN_DIR is not set\n');
  process.exit(2);
}

fs.mkdirSync(binDir, { recursive: true });

// The fake binary answers exactly the probes cli-install-service runs: the
// version banner in each descriptor's shape, `update --check --json` for Grok,
// and `doctor` for Claude. The answering logic is one Node script; only the
// launcher in front of it differs per platform.
// host-platform: the launcher must match the platform the relay under test
// runs on — an extensionless shebang file on POSIX, a .cmd shim on Windows.
const windows = process.platform === 'win32';
const target = path.join(binDir, windows ? `${provider}.cmd` : provider);

const implPath = path.join(binDir, `${provider}-fake-cli.mjs`);
const impl = `import process from 'node:process';
const [first = '', second = ''] = process.argv.slice(2);
const command = \`\${first} \${second}\`.trimEnd();
if (command === '--version') {
  const banners = {
    grok: 'grok ${version} (stubcommit) [stable]\\n',
    claude: '${version} (Claude Code)\\n',
  };
  process.stdout.write(banners['${provider}'] || '${version}\\n');
  process.exit(0);
}
if (command === 'update --check') {
  process.stdout.write('{"currentVersion":"${version}","latestVersion":"${version}","updateAvailable":false,"installer":"internal","channel":"stable","autoUpdate":null,"error":null}\\n');
  process.exit(0);
}
if (command === 'doctor') {
  process.stdout.write('Running: native (${version})\\n');
  process.stdout.write('Path: ${JSON.stringify(target).slice(1, -1)}\\n');
  process.stdout.write('Auto-updates: enabled\\n');
  process.exit(0);
}
process.stderr.write(\`cli-stub: unsupported command: \${process.argv.slice(2).join(' ')}\\n\`);
process.exit(2);
`;
fs.writeFileSync(implPath, impl);
if (windows) {
  fs.writeFileSync(target, `@node "%~dp0${provider}-fake-cli.mjs" %*\r\n`);
} else {
  fs.writeFileSync(target, `#!/bin/sh\nexec node "$(dirname "$0")/${provider}-fake-cli.mjs" "$@"\n`);
  fs.chmodSync(target, 0o755);
}

out(`Installed ${provider} ${version} to ${target}\n`);
process.exit(0);
