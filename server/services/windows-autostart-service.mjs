import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export const WINDOWS_AUTOSTART_FILENAME = 'copilot-remote-web-relay.cmd';

function escapeBatchValue(value) {
  return String(value || '').replaceAll('%', '%%');
}

export function resolveWindowsStartupDirectory(env = process.env, pathImpl = path) {
  const appData = String(env?.APPDATA || '').trim();
  if (!appData) {
    throw new Error('Windows autostart requires the current user APPDATA directory.');
  }
  return pathImpl.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function buildWindowsAutostartScript({
  packageRoot,
  nodePath = process.execPath,
  configPath = '',
  pathImpl = path,
} = {}) {
  const resolvedPackageRoot = pathImpl.resolve(String(packageRoot || ''));
  if (!String(packageRoot || '').trim()) {
    throw new Error('Windows autostart requires the copilot-remote package root.');
  }
  const resolvedNodePath = pathImpl.resolve(String(nodePath || ''));
  if (!String(nodePath || '').trim()) {
    throw new Error('Windows autostart requires the Node.js executable path.');
  }
  const serverPath = pathImpl.join(resolvedPackageRoot, 'server', 'server.js');
  const lines = [
    '@echo off',
    'title Copilot Remote Web Relay',
  ];
  if (String(configPath || '').trim()) {
    lines.push(`set "COPILOT_WEB_RELAY_CONFIG=${escapeBatchValue(pathImpl.resolve(configPath))}"`);
  }
  lines.push(
    `cd /d "${escapeBatchValue(resolvedPackageRoot)}"`,
    `"${escapeBatchValue(resolvedNodePath)}" "${escapeBatchValue(serverPath)}"`,
    '',
  );
  return lines.join('\r\n');
}

export function createWindowsAutostartService({
  platform = process.platform,
  env = process.env,
  packageRoot,
  nodePath = process.execPath,
  configPath = '',
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  const supported = platform === 'win32';

  function entryPath() {
    return pathImpl.join(
      resolveWindowsStartupDirectory(env, pathImpl),
      WINDOWS_AUTOSTART_FILENAME,
    );
  }

  function getState() {
    return {
      supported,
      enabled: supported ? fsImpl.existsSync(entryPath()) : false,
      platform,
    };
  }

  function setEnabled(enabled) {
    if (!supported) {
      throw new Error('Windows autostart is only available on Windows.');
    }
    if (typeof enabled !== 'boolean') {
      throw new TypeError('Windows autostart enabled state must be a boolean.');
    }

    const targetPath = entryPath();
    const existed = fsImpl.existsSync(targetPath);
    if (!enabled) {
      if (existed) fsImpl.unlinkSync(targetPath);
      return { ...getState(), changed: existed };
    }

    const script = buildWindowsAutostartScript({
      packageRoot,
      nodePath,
      configPath,
      pathImpl,
    });
    if (existed && fsImpl.readFileSync(targetPath, 'utf8') === script) {
      return { ...getState(), changed: false };
    }

    fsImpl.mkdirSync(pathImpl.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      fsImpl.writeFileSync(temporaryPath, script, { encoding: 'utf8', flag: 'wx' });
      fsImpl.renameSync(temporaryPath, targetPath);
    } finally {
      if (fsImpl.existsSync(temporaryPath)) fsImpl.unlinkSync(temporaryPath);
    }
    return { ...getState(), changed: true };
  }

  return {
    getState,
    setEnabled,
  };
}
