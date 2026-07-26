import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  WINDOWS_AUTOSTART_FILENAME,
  buildWindowsAutostartScript,
  createWindowsAutostartService,
  resolveWindowsStartupDirectory,
} from './windows-autostart-service.mjs';

function createTestContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-remote-autostart-'));
  const appData = path.join(root, 'User Data', 'Roaming');
  const packageRoot = path.join(root, 'Installed Apps', 'copilot-remote');
  const nodePath = path.join(root, 'Node JS', 'node.exe');
  const startupDirectory = resolveWindowsStartupDirectory({ APPDATA: appData });
  const entryPath = path.join(startupDirectory, WINDOWS_AUTOSTART_FILENAME);
  const service = createWindowsAutostartService({
    platform: 'win32',
    env: { APPDATA: appData },
    packageRoot,
    nodePath,
  });
  return {
    root,
    packageRoot,
    nodePath,
    startupDirectory,
    entryPath,
    service,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('resolveWindowsStartupDirectory uses the current user APPDATA directory', () => {
  assert.equal(
    resolveWindowsStartupDirectory({ APPDATA: 'C:\\Users\\Example\\AppData\\Roaming' }, path.win32),
    'C:\\Users\\Example\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
  );
  assert.throws(
    () => resolveWindowsStartupDirectory({}, path.win32),
    /APPDATA/,
  );
});

test('buildWindowsAutostartScript quotes installed paths and escapes percent expansion', () => {
  const script = buildWindowsAutostartScript({
    packageRoot: 'C:\\Apps\\Copilot Remote %USER%',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    configPath: 'C:\\Users\\Example\\AppData\\Local\\copilot-remote\\config.json',
    pathImpl: path.win32,
  });
  assert.match(script, /title Copilot Remote Web Relay/);
  assert.match(
    script,
    /set "COPILOT_WEB_RELAY_CONFIG=C:\\Users\\Example\\AppData\\Local\\copilot-remote\\config\.json"/,
  );
  assert.match(script, /cd \/d "C:\\Apps\\Copilot Remote %%USER%%"/);
  assert.match(
    script,
    /"C:\\Program Files\\nodejs\\node\.exe" "C:\\Apps\\Copilot Remote %%USER%%\\server\\server\.js"/,
  );
  assert.equal(script.includes('relay.mjs'), false);
});

test('setEnabled installs, preserves, and removes only the owned Startup entry', () => {
  const context = createTestContext();
  try {
    fs.mkdirSync(context.startupDirectory, { recursive: true });
    const unrelatedPath = path.join(context.startupDirectory, 'unrelated.cmd');
    fs.writeFileSync(unrelatedPath, '@echo off\r\n', 'utf8');

    assert.deepEqual(context.service.getState(), {
      supported: true,
      enabled: false,
      platform: 'win32',
    });

    const enabled = context.service.setEnabled(true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.changed, true);
    const installedScript = fs.readFileSync(context.entryPath, 'utf8');
    assert.match(installedScript, new RegExp(context.nodePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(installedScript, /server[\\/]server\.js/);

    const enabledAgain = context.service.setEnabled(true);
    assert.equal(enabledAgain.changed, false);
    assert.equal(fs.readFileSync(context.entryPath, 'utf8'), installedScript);

    fs.writeFileSync(context.entryPath, '@echo off\r\nrem stale installation\r\n', 'utf8');
    const repaired = context.service.setEnabled(true);
    assert.equal(repaired.changed, true);
    assert.equal(fs.readFileSync(context.entryPath, 'utf8'), installedScript);

    const disabled = context.service.setEnabled(false);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.changed, true);
    assert.equal(fs.existsSync(context.entryPath), false);
    assert.equal(fs.existsSync(unrelatedPath), true);

    const disabledAgain = context.service.setEnabled(false);
    assert.equal(disabledAgain.changed, false);
  } finally {
    context.cleanup();
  }
});

test('non-Windows state is unsupported and mutation is rejected', () => {
  const service = createWindowsAutostartService({
    platform: 'linux',
    env: {},
    packageRoot: '/opt/copilot-remote',
    nodePath: '/usr/bin/node',
  });
  assert.deepEqual(service.getState(), {
    supported: false,
    enabled: false,
    platform: 'linux',
  });
  assert.throws(() => service.setEnabled(true), /only available on Windows/);
});
