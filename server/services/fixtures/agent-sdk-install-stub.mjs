// Stand-in for `npm ci` in an agent SDK folder, injected through
// COPILOT_WEB_RELAY_AGENT_SDK_INSTALL_COMMAND (together with
// COPILOT_WEB_RELAY_CLI_INSTALL_ALLOW_STUB_SPAWN) so the store's install runs
// end to end without a registry. The platform launchers next to it
// (`agent-sdk-install-stub.sh`, `agent-sdk-install-stub.cmd`) exec this file.
//
// The store calls it as:  agent-sdk-install-stub <sdk id>
// with the folder it is installing as the working directory, the pins
// (package.json, package-lock.json, entries) already copied in. It prints
// npm-shaped progress and writes the package.json of every top-level package
// the lockfile lists for this host, which is what the store checks before it
// writes its marker. Nothing is downloaded and nothing outside the working
// directory is touched.
//
//   AGENT_SDK_STUB_SLEEP   seconds to stall mid-install (to see "installing")
//   AGENT_SDK_STUB_FAIL    non-empty -> print a network error and exit 1

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [sdk = ''] = process.argv.slice(2);
const out = (text) => process.stdout.write(text);

out(`npm ci (stub) for ${sdk}\n`);
out('npm http fetch GET 200 https://registry.example.test (stub)\n');

const stallSeconds = Number(process.env.AGENT_SDK_STUB_SLEEP || '0');
if (stallSeconds > 0) await new Promise((resolve) => setTimeout(resolve, stallSeconds * 1000));

if (process.env.AGENT_SDK_STUB_FAIL) {
  process.stderr.write('npm error code ENOTFOUND\nnpm error network request to https://registry.example.test failed (stub)\n');
  process.exit(1);
}

const matches = (list, value) => {
  if (!Array.isArray(list) || !list.length) return true;
  if (list.includes(`!${value}`)) return false;
  const allowed = list.filter((item) => !String(item).startsWith('!'));
  return !allowed.length || allowed.includes(value);
};

const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
let added = 0;
for (const [key, entry] of Object.entries(lock.packages || {})) {
  if (!key.startsWith('node_modules/') || key.indexOf('/node_modules/') !== -1) continue;
  // As npm does: an optional platform package lands only on its own host.
  if (!matches(entry?.os, process.platform) || !matches(entry?.cpu, process.arch)) continue;
  const name = key.slice('node_modules/'.length);
  const dir = path.join(process.cwd(), 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name, version: entry?.version || '0.0.0' }, null, 2)}\n`);
  added += 1;
}

out(`added ${added} packages in 0s (stub)\n`);
