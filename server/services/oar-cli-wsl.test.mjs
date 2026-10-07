// WSL detection and the Windows-side port check, with fake files and a fake
// interop: nothing here asks a real Windows.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWindowsPortCheck,
  isWsl,
  isWslNat,
  parseNetstatListeners,
  windowsListeningPorts,
  windowsPortWarning,
  windowsSystemDir,
} from './oar-cli-wsl.mjs';

const noFile = () => { throw new Error('ENOENT'); };
const wslEnv = { WSL_DISTRO_NAME: 'Distro' };

// `netstat -ano` as an English and as a German Windows print it.
const NETSTAT_EN = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1040',
  '  TCP    127.0.0.1:3333         0.0.0.0:0              LISTENING       7312',
  '  TCP    192.168.7.20:5040      0.0.0.0:0              LISTENING       900',
  '  TCP    192.168.7.20:50123     203.0.113.9:443        ESTABLISHED     4120',
  '  TCP    [::]:135               [::]:0                 LISTENING       1040',
  '  TCP    [::1]:3334             [::]:0                 LISTENING       7400',
  '  TCP    [::1]:3333             [::]:0                 LISTENING       7312',
  '  UDP    0.0.0.0:5353           *:*                                    2200',
  '',
].join('\r\n');
const NETSTAT_DE = [
  'Aktive Verbindungen',
  '',
  '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
  '  TCP    0.0.0.0:3333           0.0.0.0:0              ABH�REN         7312',
  '  TCP    192.168.7.20:50123     203.0.113.9:443        HERGESTELLT     4120',
].join('\r\n');

test('WSL is recognised by its environment or its kernel name, and only on Linux', () => {
  assert.equal(isWsl({ env: wslEnv, platform: 'linux', readFileImpl: noFile }), true);
  assert.equal(isWsl({ env: { WSL_INTEROP: '/run/WSL/8_interop' }, platform: 'linux', readFileImpl: noFile }), true);
  assert.equal(isWsl({ env: {}, platform: 'linux', readFileImpl: () => '5.15.153.1-microsoft-standard-WSL2\n' }), true);
  assert.equal(isWsl({ env: {}, platform: 'linux', readFileImpl: () => '6.8.0-45-generic\n' }), false);
  assert.equal(isWsl({ env: {}, platform: 'linux', readFileImpl: noFile }), false);
  assert.equal(isWsl({ env: wslEnv, platform: 'win32', readFileImpl: noFile }), false);
});

test('the Windows system folder follows the automount root of wsl.conf', () => {
  assert.equal(windowsSystemDir({ readFileImpl: noFile }), '/mnt/c/Windows/System32');
  const conf = ['# comment', '[boot]', 'systemd=true', 'root = /ignored/', '[automount]', 'enabled = true', 'root = /windir/', ''].join('\n');
  assert.equal(windowsSystemDir({ readFileImpl: () => conf }), '/windir/c/Windows/System32');
  assert.equal(windowsSystemDir({ readFileImpl: () => '[automount]\nroot = "/"\n' }), '/c/Windows/System32');
  assert.equal(windowsSystemDir({ readFileImpl: () => '[network]\nhostname = box\n' }), '/mnt/c/Windows/System32');
});

test('listeners are read from netstat by their shape, in any system language', () => {
  const english = parseNetstatListeners(NETSTAT_EN);
  assert.deepEqual(english.get(3333), [7312]);
  assert.deepEqual(english.get(3334), [7400]);
  assert.deepEqual(english.get(135), [1040]);
  // A listener on one LAN address is not what a browser's localhost reaches,
  // and a connection is no listener.
  assert.equal(english.has(5040), false);
  assert.equal(english.has(50123), false);
  assert.equal(english.has(5353), false);
  assert.deepEqual(parseNetstatListeners(NETSTAT_DE).get(3333), [7312]);
  assert.equal(parseNetstatListeners('').size, 0);
});

// A fake interop: netstat and tasklist answer from the given tables.
function fakeWindows({ netstat = NETSTAT_EN, names = {}, calls = [] } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, timeout: options?.timeout });
    if (command.endsWith('netstat.exe')) return netstat === null ? { status: 1 } : { status: 0, stdout: netstat };
    if (command.endsWith('tasklist.exe')) {
      const pid = args[1].replace('PID eq ', '');
      return { status: 0, stdout: names[pid] ? `"${names[pid]}","${pid}","Console","1","51.200 K"\r\n` : 'INFO: No tasks are running.\r\n' };
    }
    return { status: 1 };
  };
}

test('a Windows program on the port is named; the first free port is the next one', () => {
  const calls = [];
  const check = createWindowsPortCheck({
    env: wslEnv,
    platform: 'linux',
    readFileImpl: noFile,
    spawnSyncImpl: fakeWindows({ names: { 7312: 'node.exe', 7400: 'wslrelay.exe' }, calls }),
  });
  assert.equal(check(3333), 'node.exe');
  // WSL's own forwarder stands for a program inside WSL, which the distro sees itself.
  assert.equal(check(3334), null);
  assert.equal(check(3335), null);
  const netstatCalls = calls.filter((call) => call.command.endsWith('netstat.exe'));
  assert.equal(netstatCalls.length, 1, 'the listener list is read once');
  assert.equal(netstatCalls[0].command, '/mnt/c/Windows/System32/netstat.exe');
  assert.deepEqual(netstatCalls[0].args, ['-ano']);
  assert.ok(calls.every((call) => call.timeout <= 4000));
});

test('a holder whose name Windows does not tell still holds the port', () => {
  const check = createWindowsPortCheck({ env: wslEnv, platform: 'linux', readFileImpl: noFile, spawnSyncImpl: fakeWindows() });
  assert.equal(check(3333), 'a Windows program');
});

test('without interop the check knows nothing and holds nothing against a port', () => {
  const base = { env: wslEnv, platform: 'linux', readFileImpl: noFile };
  assert.equal(windowsListeningPorts({ ...base, spawnSyncImpl: () => ({ status: null, error: new Error('ENOENT') }) }), null);
  assert.equal(createWindowsPortCheck({ ...base, spawnSyncImpl: () => ({ status: null, error: new Error('ENOENT') }) })(3333), null);
  assert.equal(createWindowsPortCheck({ ...base, spawnSyncImpl: () => { throw new Error('spawn failed'); } })(3333), null);
  assert.equal(createWindowsPortCheck({ ...base, spawnSyncImpl: fakeWindows({ netstat: null }) })(3333), null);
});

test('outside WSL Windows is never asked', () => {
  const calls = [];
  const check = createWindowsPortCheck({ env: {}, platform: 'linux', readFileImpl: noFile, spawnSyncImpl: fakeWindows({ calls }) });
  assert.equal(check(3333), null);
  assert.deepEqual(calls, []);
});

test('WSL counts as NAT unless it reports mirrored networking', () => {
  const base = { env: wslEnv, platform: 'linux', readFileImpl: noFile };
  assert.equal(isWslNat({ ...base, spawnSyncImpl: () => ({ status: 0, stdout: 'nat\n' }) }), true);
  assert.equal(isWslNat({ ...base, spawnSyncImpl: () => ({ status: 0, stdout: 'mirrored\n' }) }), false);
  assert.equal(isWslNat({ ...base, spawnSyncImpl: () => { throw new Error('no wslinfo'); } }), true);
  assert.equal(isWslNat({ env: {}, platform: 'linux', readFileImpl: noFile, spawnSyncImpl: () => ({ status: 0, stdout: 'nat\n' }) }), false);
});

test('the warning names the port, the holder and the way out', () => {
  const warning = windowsPortWarning(3333, 'node.exe');
  assert.match(warning, /Windows holds port 3333 \(node\.exe\)/);
  assert.match(warning, /oar setup --port/);
});
