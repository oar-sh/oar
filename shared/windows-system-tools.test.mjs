import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeExecError,
  describeSpawnEnvironment,
  envPathKey,
  normalizeTempEnv,
  readEnvValue,
  windowsCmdPath,
  windowsSystemRoot,
  windowsSystemToolPath,
} from './windows-system-tools.mjs';

// existsImpl is always injected: nothing here looks at the machine running it.
const exists = (paths) => (candidate) => paths.includes(candidate);

test('environment names match without regard to case, as Windows reads them', () => {
  assert.equal(readEnvValue({ Path: 'C:\\Windows' }, 'PATH'), 'C:\\Windows');
  assert.equal(readEnvValue({ SYSTEMROOT: 'D:\\Windows' }, 'SystemRoot'), 'D:\\Windows');
  assert.equal(readEnvValue({}, 'PATH'), '');
  assert.equal(envPathKey({ Path: 'x' }, 'win32'), 'Path');
  assert.equal(envPathKey({ PATH: 'x', Path: 'y' }, 'win32'), 'PATH');
  assert.equal(envPathKey({}, 'win32'), 'Path');
  assert.equal(envPathKey({ Path: 'x' }, 'linux'), 'PATH');
});

test('the system root comes from SystemRoot, then windir, then C:\\Windows', () => {
  assert.equal(windowsSystemRoot({ SystemRoot: 'D:\\Win' }), 'D:\\Win');
  assert.equal(windowsSystemRoot({ windir: 'E:\\Win' }), 'E:\\Win');
  assert.equal(windowsSystemRoot({}), 'C:\\Windows');
});

test('Windows programs resolve under System32 when they are there, else stay bare', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  const present = exists([
    'C:\\Windows\\System32\\schtasks.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ]);
  assert.equal(windowsSystemToolPath('schtasks', { env, existsImpl: present }), 'C:\\Windows\\System32\\schtasks.exe');
  assert.equal(windowsSystemToolPath('powershell.exe', { env, existsImpl: present }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(windowsSystemToolPath('powershell', { env, existsImpl: present }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(windowsSystemToolPath('taskkill', { env, existsImpl: present }), 'taskkill', 'missing file: the bare name, as before');
  assert.equal(windowsSystemToolPath('whoami', { env, existsImpl: () => { throw new Error('EACCES'); } }), 'whoami');
});

test('cmd.exe is %ComSpec%, else the one under the system root', () => {
  assert.equal(windowsCmdPath({ env: { COMSPEC: 'D:\\cmd.exe' }, existsImpl: exists([]) }), 'D:\\cmd.exe');
  assert.equal(windowsCmdPath({ env: { SystemRoot: 'C:\\Windows' }, existsImpl: exists(['C:\\Windows\\System32\\cmd.exe']) }), 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(windowsCmdPath({ env: {}, existsImpl: exists([]) }), 'cmd.exe');
});

test('the spawn environment line names PATH, and SystemRoot and ComSpec on Windows', () => {
  assert.equal(
    describeSpawnEnvironment({ Path: 'C:\\Windows;C:\\Program Files\\nodejs', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'win32'),
    'PATH=C:\\Windows;C:\\Program Files\\nodejs SystemRoot=(not set) ComSpec=C:\\Windows\\System32\\cmd.exe',
  );
  assert.equal(describeSpawnEnvironment({}, 'linux'), 'PATH=(not set)');
});

test('an exec error reads as code, signal, message and stderr on one line', () => {
  const error = Object.assign(new Error('Command failed: powershell.exe -NoProfile\nmore'), {
    code: 1,
    stderr: Buffer.from('Get-CimInstance : Access denied\r\n  at line 1'),
  });
  assert.equal(describeExecError(error), 'code=1 Command failed: powershell.exe -NoProfile stderr=Get-CimInstance : Access denied at line 1');
  assert.equal(describeExecError(Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })), 'code=ENOENT spawn x ENOENT');
  assert.equal(describeExecError(Object.assign(new Error('timed out'), { signal: 'SIGTERM', killed: true })), 'signal=SIGTERM timed out');
  assert.equal(describeExecError(null), 'unknown error');
});

test('a quoted TEMP loses its quotes; one that is not there becomes the user temp folder', () => {
  const folders = new Set(['C:\\My Temp', 'C:\\Users\\dev\\AppData\\Local\\Temp']);
  const existsImpl = (dir) => folders.has(dir);
  const env = { Temp: '"C:\\My Temp"', TMP: 'Q:\\temp', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' };
  const changes = normalizeTempEnv({ env, platform: 'win32', existsImpl });
  assert.equal(env.Temp, 'C:\\My Temp', 'the key keeps its case');
  assert.equal(env.TMP, 'C:\\Users\\dev\\AppData\\Local\\Temp');
  assert.deepEqual(changes, ['TEMP "C:\\My Temp" -> C:\\My Temp', 'TMP Q:\\temp -> C:\\Users\\dev\\AppData\\Local\\Temp']);
  // Good values, and other platforms, are left alone.
  const good = { TEMP: 'C:\\My Temp', TMP: 'C:\\My Temp' };
  assert.deepEqual(normalizeTempEnv({ env: good, platform: 'win32', existsImpl }), []);
  assert.deepEqual(good, { TEMP: 'C:\\My Temp', TMP: 'C:\\My Temp' });
  const posix = { TMPDIR: '/tmp', TEMP: '"/odd"' };
  assert.deepEqual(normalizeTempEnv({ env: posix, platform: 'linux', existsImpl }), []);
  assert.equal(posix.TEMP, '"/odd"');
  // No folder to fall back on: only the quotes go.
  const bare = { TEMP: '"Q:\\gone"' };
  normalizeTempEnv({ env: bare, platform: 'win32', existsImpl: () => false });
  assert.equal(bare.TEMP, 'Q:\\gone');
  // The user's temp folder is used only when it is there.
  const noFallback = { TEMP: 'Q:\\gone', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' };
  assert.deepEqual(normalizeTempEnv({ env: noFallback, platform: 'win32', existsImpl: () => false }), []);
  assert.equal(noFallback.TEMP, 'Q:\\gone');
});
