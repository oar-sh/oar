'use strict';

// server-runtime.mjs boots a live server on import, so what it does at start
// about the Copilot Extension engine it no longer has is pinned by source
// inspection, like the other runtime suites. The lines themselves are covered
// by services/retired-copilot-extension.test.mjs, the lookup by
// copilot-sdk-runtime.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8').replace(/\r\n/g, '\n');

const timesIn = (text) => runtimeSource.split(text).length - 1;

test('a stored copilot_engine=extension is named once at start, as a top-level statement', () => {
  assert.match(runtimeSource, /\nimport \{ cleanUpCopilotWrapperAtStart, retiredCopilotEngineLine \} from '\.\/services\/retired-copilot-extension\.mjs';\n/);
  assert.equal(timesIn('retiredCopilotEngineLine('), 1);
  assert.match(runtimeSource, /\nconst retiredEngineLine = retiredCopilotEngineLine\(\{ readSetting: readAppSettingValue \}\);\nif \(retiredEngineLine\) console\.warn\(`\$\{runtimeLogPrefix\(\)\}\$\{retiredEngineLine\}`\);\n/);
});

test('the generated wrapper is removed once at start, as a top-level statement', () => {
  assert.match(runtimeSource, /\nimport \{ removeGeneratedCopilotWrapper \} from '\.\/services\/oar-cli-helpers\.mjs';\n/);
  assert.equal(timesIn('removeGeneratedCopilotWrapper('), 1);
  assert.equal(timesIn('cleanUpCopilotWrapperAtStart('), 1);
  assert.match(runtimeSource, /\ncleanUpCopilotWrapperAtStart\(\{ remove: \(\) => removeGeneratedCopilotWrapper\(\), log: \(line\) => console\.warn\(`\$\{runtimeLogPrefix\(\)\}\$\{line\}`\) \}\);\n/);
});

test('the runtime reads and writes no engine setting: the engine is the SDK worker', () => {
  assert.doesNotMatch(runtimeSource, /copilot_engine|getCopilotEngine|setCopilotProviderSettings|relayCliLauncherService/);
  assert.match(runtimeSource, /function getCopilotProviderSettings\(\) \{\n  return \{ engine: 'sdk', engines: \['sdk'\] \};\n\}/);
});

test('the SDK is looked up on every Copilot launch, after every other provider has returned', () => {
  const from = runtimeSource.indexOf('\nfunction buildSessionWorkerLaunchEnvForSession(');
  const launchSource = runtimeSource.slice(from, runtimeSource.indexOf('\nfunction buildSessionWorkerLaunchEnvWithAgentToken(', from));
  const lookup = 'const sdkPath = resolveCopilotSdkLaunchPath({ config, env: sessionWorkerLaunchEnv });';
  assert.equal(launchSource.split(lookup).length, 2);
  // Nothing resolves it once for the whole run. The only other call in the
  // file is the body of the CLI install service's `findCopilotSdk` arrow,
  // a property of that service's construction, which the service calls per
  // install; an IIFE, a memo(() => …) or any other call fails here.
  const launchTo = from + launchSource.length;
  const constructionFrom = runtimeSource.indexOf('\nconst cliInstallService = createCliInstallService({');
  const constructionTo = runtimeSource.indexOf('\n});\n', constructionFrom);
  const perInstall = '\n  findCopilotSdk: () => ';
  for (let at = runtimeSource.indexOf('resolveCopilotSdkLaunchPath('); at !== -1; at = runtimeSource.indexOf('resolveCopilotSdkLaunchPath(', at + 1)) {
    if (at >= from && at < launchTo) continue;
    assert.ok(at > constructionFrom && at < constructionTo, `nothing resolves it once for the whole run (offset ${at})`);
    assert.equal(runtimeSource.slice(at - perInstall.length, at), perInstall, `nothing resolves it once for the whole run (offset ${at})`);
  }
  for (const provider of ['claude-cloud', 'claude', 'cursor', 'deepseek', 'claude-api', 'grok']) {
    const branch = launchSource.indexOf(`if (providerType === '${provider}') {`);
    assert.notEqual(branch, -1, provider);
    assert.ok(branch < launchSource.indexOf(lookup), `${provider} returns before the lookup`);
  }
  assert.equal(launchSource.slice(launchSource.indexOf(lookup)).split('sdkPath,').length + launchSource.slice(launchSource.indexOf(lookup)).split('sdkPath }').length - 2, 2, 'both Copilot launches carry it');
});
