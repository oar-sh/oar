import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { createRelaySingletonGuard, defaultIsProcessAlive, lockHolderMayRun, processIdentity, processStartedAt } from './relay-singleton-guard.mjs';
import { scratchEnv } from './scratch-env-test-harness.mjs';

// Every folder made here is removed at the end: a run used to leave one per test in the temp dir.
const tempDirs = [];
after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

function tmpLock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lock-'));
  tempDirs.push(dir);
  return path.join(dir, 'relay-server.lock');
}

test('the lock file stores a hash, never the plaintext auth token', () => {
  const lockPath = tmpLock();
  const token = 'super-secret-token-value';
  const guard = createRelaySingletonGuard({ lockPath, pid: 1234, token, isProcessAlive: () => false });
  guard.acquire();

  const raw = fs.readFileSync(lockPath, 'utf8');
  assert.doesNotMatch(raw, /super-secret-token-value/, 'plaintext token must not appear on disk');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.token, undefined, 'no plaintext token field');
  assert.equal(parsed.tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
});

test('the lock file is created owner-only (0600) on POSIX', { skip: process.platform === 'win32' }, () => {
  const lockPath = tmpLock();
  const guard = createRelaySingletonGuard({ lockPath, pid: 1234, token: 't', isProcessAlive: () => false });
  guard.acquire();
  const mode = fs.statSync(lockPath).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('a live process holding the lock with the same token is detected as already running', () => {
  const lockPath = tmpLock();
  const opts = { lockPath, pid: 4242, token: 'tok', isProcessAlive: () => true, identityOf: () => null, bootIdOf: () => '' };
  createRelaySingletonGuard(opts).acquire();
  assert.throws(() => createRelaySingletonGuard(opts).acquire(), /already running/);
});

test('a stale lock from a dead process is recovered', () => {
  const lockPath = tmpLock();
  createRelaySingletonGuard({ lockPath, pid: 1, token: 'tok', isProcessAlive: () => false }).acquire();
  // A second acquire with the pid reported dead should recover and succeed.
  const payload = createRelaySingletonGuard({ lockPath, pid: 2, token: 'tok', isProcessAlive: () => false }).acquire();
  assert.equal(payload.pid, 2);
});

test('a legacy plaintext-token lock still matches for ownership', () => {
  const lockPath = tmpLock();
  const token = 'legacy-token';
  // Simulate an old build's lock file with a plaintext token field.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999, token, startedAt: 'x' }));
  const guard = createRelaySingletonGuard({ lockPath, pid: 1000, token, isProcessAlive: () => true });
  assert.throws(() => guard.acquire(), /already running/, 'legacy token must hash-match');
});

test('release only removes the lock the current process owns', () => {
  const lockPath = tmpLock();
  createRelaySingletonGuard({ lockPath, pid: 5, token: 'a', isProcessAlive: () => false }).acquire();
  // A different token/pid must not release someone else's lock.
  const other = createRelaySingletonGuard({ lockPath, pid: 6, token: 'b', isProcessAlive: () => false });
  assert.equal(other.release(), false);
  assert.ok(fs.existsSync(lockPath));
});

test('release leaves a lock another relay wrote, with the same token too', () => {
  const lockPath = tmpLock();
  const options = { lockPath, token: 'config-token', logger: {}, isProcessAlive: () => false, identityOf: () => null, bootIdOf: () => '' };
  const first = createRelaySingletonGuard({ ...options, pid: 100 });
  first.acquire();
  // Its lock went, and a second relay on the same config took one.
  fs.unlinkSync(lockPath);
  createRelaySingletonGuard({ ...options, pid: 200 }).acquire();
  assert.equal(first.release(), false);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, 200);
  // Its own pid with another token: not its lock either.
  fs.writeFileSync(lockPath, JSON.stringify({ format: 2, pid: 100, tokenHash: 'another', holder: null }));
  assert.equal(first.release(), false);
  assert.equal(fs.existsSync(lockPath), true);
});

// ─── A lock that cannot be read ──────────────────────────────────────────────

// File times and the guard's clock, from one whole second: nothing here
// asks the real clock, and a filesystem keeps a whole second exactly (Linux
// stores ms set through utimes as ns, often 0.001 ms off).
const AT = Date.parse('2026-10-21T08:00:00.000Z');
const secondsFromAt = (seconds) => new Date(AT + seconds * 1000);
const setTime = (file, seconds) => fs.utimesSync(file, secondsFromAt(seconds), secondsFromAt(seconds));
// Each look at the clock is 100 ms later: the retries take no time.
const steppingClock = () => { let at = AT; return () => (at += 100); };
const quiet = { logger: {}, identityOf: () => null, bootIdOf: () => '', isProcessAlive: () => true };

test('a lock is never there half written: a start in that moment sees none of it or all of it', () => {
  const lockPath = tmpLock();
  const realWrite = fs.writeFileSync;
  const seen = [];
  fs.writeFileSync = (...args) => { seen.push(fs.existsSync(lockPath)); return realWrite(...args); };
  try {
    createRelaySingletonGuard({ lockPath, pid: 100, token: 'tok', ...quiet }).acquire();
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.ok(seen.length >= 1);
  assert.deepEqual(seen.filter(Boolean), [], 'no lock file while its content was written');
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, 100);
  assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), ['relay-server.lock'], 'nothing staged left');
});

test('where the folder takes no hard links (FAT, exFAT), the lock is written in place', () => {
  const lockPath = tmpLock();
  const realLink = fs.linkSync;
  fs.linkSync = () => { throw Object.assign(new Error('not supported'), { code: 'EPERM' }); };
  try {
    createRelaySingletonGuard({ lockPath, pid: 100, token: 'tok', ...quiet }).acquire();
  } finally {
    fs.linkSync = realLink;
  }
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, 100);
  assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), ['relay-server.lock'], 'nothing staged left');
  assert.throws(() => createRelaySingletonGuard({ lockPath, pid: 200, token: 'tok', ...quiet }).acquire(), /already running/);
});

test('a start that finds a lock just created and not readable yet is refused, naming it', () => {
  const lockPath = tmpLock();
  fs.writeFileSync(lockPath, '');
  setTime(lockPath, 0);
  let sleeps = 0;
  assert.throws(
    () => createRelaySingletonGuard({ lockPath, pid: 100, token: 'tok', ...quiet, clock: steppingClock(), sleep: () => { sleeps += 1; } }).acquire(),
    (error) => error.code === 'ERELAYLOCKED' && error.message.includes(lockPath),
  );
  assert.ok(sleeps >= 5, 'read again for a while first');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '', 'left as it is');
});

test('an empty lock a power loss left, or one from before a clock step back, is recovered', () => {
  for (const offset of [-60, 60]) {
    const lockPath = tmpLock();
    fs.writeFileSync(lockPath, '');
    setTime(lockPath, offset);
    const warnings = [];
    const payload = createRelaySingletonGuard({
      lockPath, pid: 100, token: 'tok', ...quiet, logger: { warn: (line) => warnings.push(line) }, clock: steppingClock(), sleep: () => {},
    }).acquire();
    assert.equal(payload.pid, 100, String(offset));
    assert.match(warnings.join('\n'), /Recovered stale singleton lock/);
  }
});

test('a lock unreadable for a moment (a scan) is read again, and then held by its live holder', () => {
  const lockPath = tmpLock();
  fs.writeFileSync(lockPath, '');
  const sleep = () => fs.writeFileSync(lockPath, JSON.stringify({ format: 2, pid: 7348, tokenHash: 'other', startedAt: LOCKED_AT, holder: null }));
  assert.throws(
    () => createRelaySingletonGuard({ lockPath, pid: 100, token: 'tok', ...quiet, clock: steppingClock(), sleep }).acquire(),
    (error) => error.code === 'ERELAYLOCKED' && /pid=7348/.test(error.message),
  );
});

// ─── Two starts recovering the same stale lock ───────────────────────────────

const STALE = { format: 2, pid: 6161, tokenHash: 'x', startedAt: '2026-10-20T19:00:15.000Z', holder: null };
const lockFiles = (lockPath) => fs.readdirSync(path.dirname(lockPath));

test('a start that takes a stale lock while another is judging it keeps it: the other is refused', () => {
  for (const links of [true, false]) {
    const lockPath = tmpLock();
    fs.writeFileSync(lockPath, JSON.stringify(STALE));
    const realLink = fs.linkSync;
    if (!links) fs.linkSync = () => { throw Object.assign(new Error('not supported'), { code: 'EPERM' }); };
    const b = createRelaySingletonGuard({ lockPath, pid: 200, token: 'tok-b', ...quiet, isProcessAlive: (pid) => pid === 200 });
    let taken = null;
    // C looks at the stale lock's pid; in that moment B recovers it.
    const c = createRelaySingletonGuard({
      lockPath, pid: 300, token: 'tok-c', ...quiet,
      isProcessAlive: (pid) => { if (pid === 6161 && !taken) taken = b.acquire(); return pid === 200 || pid === 300; },
    });
    try {
      assert.throws(() => c.acquire(), (error) => error.code === 'ERELAYLOCKED' && error.message.includes(lockPath), String(links));
    } finally {
      fs.linkSync = realLink;
    }
    assert.equal(taken.pid, 200);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, 200, 'B\'s lock, put back');
    assert.deepEqual(lockFiles(lockPath), ['relay-server.lock'], 'nothing left beside it');
  }
});

test('a stale lock another start recovered first is taken from the top, a bounded number of times', () => {
  const lockPath = tmpLock();
  fs.writeFileSync(lockPath, JSON.stringify(STALE));
  let removed = false;
  const payload = createRelaySingletonGuard({
    lockPath, pid: 300, token: 'tok', ...quiet,
    isProcessAlive: (pid) => { if (pid === 6161 && !removed) { removed = true; fs.unlinkSync(lockPath); } return false; },
  }).acquire();
  assert.equal(payload.pid, 300);
  // Gone each time it is to be moved, yet there again: refused, not a loop.
  const realRename = fs.renameSync;
  let renames = 0;
  fs.renameSync = (from, to) => {
    if (from !== lockPath) return realRename(from, to);
    renames += 1;
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  };
  try {
    const again = tmpLock();
    fs.writeFileSync(again, JSON.stringify(STALE));
    fs.renameSync = ((rename) => (from, to) => (from === again ? rename(lockPath, to) : realRename(from, to)))(fs.renameSync);
    assert.throws(() => createRelaySingletonGuard({ lockPath: again, pid: 300, token: 'tok', ...quiet, isProcessAlive: () => false }).acquire(), (error) => error.code === 'ERELAYLOCKED');
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(renames, 3);
});

test('a stale lock that cannot be moved aside (held open) is tried briefly, then counted as held', () => {
  const lockPath = tmpLock();
  fs.writeFileSync(lockPath, JSON.stringify(STALE));
  const realRename = fs.renameSync;
  const sleeps = [];
  fs.renameSync = (from, to) => {
    if (from === lockPath) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realRename(from, to);
  };
  try {
    assert.throws(
      () => createRelaySingletonGuard({ lockPath, pid: 300, token: 'tok', ...quiet, isProcessAlive: () => false, sleep: (ms) => sleeps.push(ms) }).acquire(),
      (error) => error.code === 'ERELAYLOCKED' && error.message.includes(lockPath),
    );
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(sleeps, [50, 100, 200, 400, 800]);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), STALE, 'never unlinked unseen');
});

test('an empty stale lock is recovered when it is still the one judged, and left when it changed', () => {
  const lockPath = tmpLock();
  fs.writeFileSync(lockPath, '');
  setTime(lockPath, -60);
  assert.equal(createRelaySingletonGuard({ lockPath, pid: 300, token: 'tok', ...quiet, clock: steppingClock(), sleep: () => {} }).acquire().pid, 300);
  assert.deepEqual(lockFiles(lockPath), ['relay-server.lock']);
  // Judged empty and old; by the move it was rewritten (another start).
  const changed = tmpLock();
  fs.writeFileSync(changed, '');
  setTime(changed, -60);
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (from === changed) fs.writeFileSync(changed, '{"pid":');
    return realRename(from, to);
  };
  try {
    assert.throws(() => createRelaySingletonGuard({ lockPath: changed, pid: 300, token: 'tok', ...quiet, clock: steppingClock(), sleep: () => {} }).acquire(), (error) => error.code === 'ERELAYLOCKED');
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.readFileSync(changed, 'utf8'), '{"pid":', 'put back as it was');
});

test('a lock rewritten with the same pid and token but another start time is not the one judged: it stays', () => {
  const lockPath = tmpLock();
  fs.writeFileSync(lockPath, JSON.stringify(STALE));
  const newer = JSON.stringify({ ...STALE, startedAt: '2026-10-21T08:00:00.000Z' });
  let rewritten = false;
  // While its pid is looked at, the relay of that pid writes its lock anew.
  const isProcessAlive = (pid) => {
    if (pid === 6161 && !rewritten) { rewritten = true; fs.unlinkSync(lockPath); fs.writeFileSync(lockPath, newer); }
    return false;
  };
  assert.throws(() => createRelaySingletonGuard({ lockPath, pid: 300, token: 'tok', ...quiet, isProcessAlive }).acquire(), (error) => error.code === 'ERELAYLOCKED');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), newer);
});

test('an unreadable lock with the same size but another time by the move is not the one judged: it stays', () => {
  const lockPath = tmpLock();
  fs.writeFileSync(lockPath, '');
  setTime(lockPath, -60);
  const realRename = fs.renameSync;
  // Read back as the guard reads it: the time the file has, not the one set.
  let changedTo = null;
  fs.renameSync = (from, to) => {
    if (from === lockPath) { setTime(lockPath, -120); changedTo = fs.statSync(lockPath).mtimeMs; }
    return realRename(from, to);
  };
  try {
    assert.throws(() => createRelaySingletonGuard({ lockPath, pid: 300, token: 'tok', ...quiet, clock: steppingClock(), sleep: () => {} }).acquire(), (error) => error.code === 'ERELAYLOCKED');
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '');
  assert.notEqual(changedTo, null);
  assert.equal(fs.statSync(lockPath).mtimeMs, changedTo, 'put back as it was');
});

test('a lock that appeared before a fresh one could be put back stays byte for byte; the moved one is kept', () => {
  for (const links of [true, false]) {
    const lockPath = tmpLock();
    fs.writeFileSync(lockPath, JSON.stringify(STALE));
    const realLink = fs.linkSync;
    const realRename = fs.renameSync;
    if (!links) fs.linkSync = () => { throw Object.assign(new Error('not supported'), { code: 'EPERM' }); };
    const b = createRelaySingletonGuard({ lockPath, pid: 200, token: 'tok-b', ...quiet, isProcessAlive: (pid) => pid === 200 });
    let taken = null;
    const third = '{"pid": 400, "tokenHash": "d"}\n';
    // C judges the stale lock; B takes it meanwhile; once C has moved B's
    // aside, a third start writes its own.
    const c = createRelaySingletonGuard({
      lockPath, pid: 300, token: 'tok-c', ...quiet,
      isProcessAlive: (pid) => {
        if (pid === 6161 && !taken) {
          taken = b.acquire();
          fs.renameSync = (from, to) => {
            realRename(from, to);
            if (from === lockPath && path.basename(to).startsWith('relay-server.lock.stale-300-')) fs.writeFileSync(lockPath, third);
          };
        }
        return pid === 200 || pid === 300;
      },
    });
    try {
      assert.throws(() => c.acquire(), (error) => error.code === 'ERELAYLOCKED', String(links));
    } finally {
      fs.linkSync = realLink;
      fs.renameSync = realRename;
    }
    assert.equal(fs.readFileSync(lockPath, 'utf8'), third, `the third start's lock stays (${links})`);
    const kept = lockFiles(lockPath).filter((name) => name.startsWith('relay-server.lock.stale-300-'));
    assert.equal(kept.length, 1, 'the moved lock is kept');
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(lockPath), kept[0]), 'utf8')).pid, 200);
  }
});

test('files a crashed recovery left beside the lock are removed once their process is gone', () => {
  const lockPath = tmpLock();
  for (const name of ['relay-server.lock.stale-999991-ab12cd34', 'relay-server.lock.999991-ab12cd34.tmp', 'relay-server.lock.stale-4242-ab12cd34']) {
    fs.writeFileSync(path.join(path.dirname(lockPath), name), '');
  }
  createRelaySingletonGuard({ lockPath, pid: 300, token: 'tok', ...quiet, isProcessAlive: (pid) => pid === 4242 }).acquire();
  assert.deepEqual(lockFiles(lockPath).sort(), ['relay-server.lock', 'relay-server.lock.stale-4242-ab12cd34']);
});

test('a held lock says how to clear it: stop the relay when its holder is known, delete the lock only when not', () => {
  const known = identityLock({ start: 'win:1' });
  assert.throws(() => acquireOver(known, { identityOf: () => ({ start: 'win:1' }) }), (error) => /held by relay process 7348: oar stop, or end process 7348\./.test(error.message) && !/delete/.test(error.message));
  const unknown = identityLock({ start: 'win:1' });
  assert.throws(() => acquireOver(unknown, { identityOf: () => null }), /If no relay is running, end process 7348 or delete the lock\./);
});

// ─── A lock an unclean end left behind ───────────────────────────────────────

// A lock written by a relay at `lockedAt`, now named by a live pid.
function leftLock(lockedAt) {
  const lockPath = tmpLock();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 7348, tokenHash: crypto.createHash('sha256').update('tok').digest('hex'), startedAt: lockedAt }));
  return lockPath;
}
const LOCKED_AT = '2026-10-20T19:00:15.000Z';
// Nothing here asks the host: its pids, boot id and identities are stubbed.
const acquireOver = (lockPath, options) => createRelaySingletonGuard({
  lockPath, pid: 100, token: 'tok', logger: {}, isProcessAlive: () => true, identityOf: () => null, bootIdOf: () => '', ...options,
}).acquire();

test('a lock from before the last boot is stale, even with its pid alive again', () => {
  const lockPath = leftLock(LOCKED_AT);
  const payload = acquireOver(lockPath, { bootTime: Date.parse(LOCKED_AT) + 60_000, startedAtOf: () => Date.parse(LOCKED_AT) + 90_000 });
  assert.equal(payload.pid, 100, 'the start goes ahead');
});

test('a lock since the boot whose pid started before it is held: the start refuses, naming the lock', () => {
  const lockPath = leftLock(LOCKED_AT);
  assert.throws(
    () => acquireOver(lockPath, { bootTime: Date.parse(LOCKED_AT) - 60_000, startedAtOf: () => Date.parse(LOCKED_AT) - 1000 }),
    (error) => {
      assert.equal(error.code, 'ERELAYLOCKED');
      assert.ok(error.message.includes(lockPath), error.message);
      return true;
    },
  );
});

test('a pid that started after the lock was written is not its holder', () => {
  const lockPath = leftLock(LOCKED_AT);
  const payload = acquireOver(lockPath, { bootTime: Date.parse(LOCKED_AT) - 60_000, startedAtOf: () => Date.parse(LOCKED_AT) + 60_000 });
  assert.equal(payload.pid, 100);
});

test('when the start time cannot be told, a live pid holds the lock', () => {
  const lockPath = leftLock(LOCKED_AT);
  assert.throws(() => acquireOver(lockPath, { bootTime: Date.parse(LOCKED_AT) - 60_000, startedAtOf: () => null }), /already running/);
});

test('a pid this user may not signal (EPERM) counts as alive', () => {
  assert.equal(defaultIsProcessAlive(process.pid), true);
  const realKill = process.kill;
  try {
    process.kill = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
    assert.equal(defaultIsProcessAlive(4), true);
    process.kill = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
    assert.equal(defaultIsProcessAlive(4), false);
  } finally {
    process.kill = realKill;
  }
  assert.equal(lockHolderMayRun({ lock: { pid: 4, startedAt: LOCKED_AT }, isProcessAlive: () => true, startedAtOf: () => null, bootTime: 0 }), true);
});

test('a process start time is read without PowerShell', () => {
  // Windows asks the kernel, elsewhere `ps`: neither needs PowerShell, which
  // ConstrainedLanguage mode or a broken TEMP can break.
  // Put back key by key: assigning process.env a copy leaves the real
  // environment as changed, and os.tmpdir() reads TEMP on POSIX too.
  const saved = { PATH: process.env.PATH, TEMP: process.env.TEMP };
  try {
    process.env.PATH = '';
    process.env.TEMP = '"C:\\not a folder"';
    const startedAt = processStartedAt(process.pid);
    if (process.platform === 'win32') { // host-platform: the kernel call is the Windows path
      assert.ok(startedAt !== null, 'read on Windows');
      assert.ok(Math.abs(startedAt - (Date.now() - process.uptime() * 1000)) < 5000, 'its own start');
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(process.env.TEMP, saved.TEMP, 'TEMP as it was');
  assert.equal(processStartedAt(2 ** 31 - 2), null, 'no such process: cannot tell');
});

// ─── The holder's identity, which no clock step moves ────────────────────────

// A lock as this version writes it, held by pid 7348 started as `start`.
function identityLock(holder) {
  const lockPath = tmpLock();
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 7348, tokenHash: 'x', startedAt: LOCKED_AT, holder }));
  return lockPath;
}
const TWO_HOURS = 2 * 60 * 60 * 1000;

test('the lock records its holder\'s identity', () => {
  const lockPath = tmpLock();
  createRelaySingletonGuard({ lockPath, pid: 100, token: 'tok', logger: {}, identityOf: () => ({ start: 'win:123' }), bootIdOf: () => '' }).acquire();
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).holder, { start: 'win:123' });
});

test('a clock stepped 2 h forward does not make a live holder look stale', () => {
  // Since the step, "now minus uptime" lies after the lock: the clock rule
  // alone would call it stale. The recorded identity still matches.
  for (const start of ['win:1792507221746', 'ticks:4242', Date.parse(LOCKED_AT) - 1000]) {
    const lockPath = identityLock({ start, bootId: 'boot-a' });
    assert.throws(() => acquireOver(lockPath, {
      bootTime: Date.parse(LOCKED_AT) + TWO_HOURS,
      identityOf: () => ({ start, bootId: 'boot-a' }),
      startedAtOf: () => Date.parse(LOCKED_AT) + TWO_HOURS,
    }), /already running|another live process/, String(start));
  }
});

test('a clock stepped back does not make a stale lock look held, nor a held one stale', () => {
  const lockPath = identityLock({ start: 'win:1' });
  assert.throws(() => acquireOver(lockPath, { bootTime: Date.parse(LOCKED_AT) - TWO_HOURS, identityOf: () => ({ start: 'win:1' }) }));
});

test('a pid reused after a boot, or a changed boot id, is not the holder', () => {
  assert.equal(acquireOver(identityLock({ start: 'win:1000' }), { identityOf: () => ({ start: 'win:5000' }) }).pid, 100, 'another process now');
  assert.equal(acquireOver(identityLock({ start: 'ticks:100', bootId: 'boot-a' }), { identityOf: () => ({ start: 'ticks:100', bootId: 'boot-b' }) }).pid, 100, 'another boot, the same ticks');
  assert.throws(() => acquireOver(identityLock({ start: 'ticks:100', bootId: 'boot-a' }), { identityOf: () => null, bootIdOf: () => 'boot-a' }), /already running|another live/, 'cannot tell: refused');
});

test('a 0.9.13 lock goes by the clock: 5 s of slack before a pid counts as reused', () => {
  const at = Date.parse(LOCKED_AT);
  const options = (offset) => ({ bootTime: at - 60_000, startedAtOf: () => at + offset });
  assert.throws(() => acquireOver(leftLock(LOCKED_AT), options(3000)), /already running/, 'within the slack');
  assert.equal(acquireOver(leftLock(LOCKED_AT), options(10_000)).pid, 100, 'past it');
});

test('identities read for this process are stable', { skip: !['win32', 'linux'].includes(process.platform) }, () => {
  const first = processIdentity(process.pid);
  assert.ok(first, 'read');
  assert.deepEqual(processIdentity(process.pid), first);
});

test('ps gives this process\'s full start date', { skip: process.platform === 'win32' }, () => {
  const startedAt = processStartedAt(process.pid);
  assert.ok(startedAt !== null, 'parsed');
  assert.ok(Math.abs(startedAt - (Date.now() - process.uptime() * 1000)) < 3000, 'today, at its start');
});

test('the relay started on a held lock says so in one line naming it, and exits 78 without being retried', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-held-'));
  tempDirs.push(root);
  const dataDir = path.join(root, 'state', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(root, 'state', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 39921, authToken: 'held-token-0123456789', localhostOnly: true }));
  // Held by this test's own process, as the guard writes it.
  const lockPath = path.join(dataDir, 'relay-server.lock');
  const holder = processIdentity(process.pid);
  fs.writeFileSync(lockPath, JSON.stringify({ format: 2, pid: process.pid, tokenHash: 'x', startedAt: new Date().toISOString(), holder }));
  const server = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
  const run = spawnSync(process.execPath, [server], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: scratchEnv(root, {
      COPILOT_WEB_RELAY_CONFIG: configPath,
      COPILOT_WEB_RELAY_DATA_DIR: dataDir,
      COPILOT_WEB_RELAY_LOG_DIR: path.join(root, 'state', 'logs'),
      COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1',
    }),
  });
  const lines = `${run.stdout}${run.stderr}`.split(/\r?\n/);
  assert.equal(run.status, 78, lines.slice(-6).join('\n'));
  assert.equal(lines.filter((line) => line.includes(lockPath)).length, 1, 'one line naming the lock');
  assert.equal(lines.filter((line) => line.includes('launched runtime')).length, 1, 'started once');
  assert.ok(!lines.some((line) => /crash/.test(line)));
  assert.ok(fs.existsSync(lockPath), 'the held lock is left alone');
});

// ─── Locks this version writes (format 2) never go by the clock ──────────────

test('every lock written carries the format, its holder known or not', () => {
  const lockPath = tmpLock();
  createRelaySingletonGuard({ lockPath, pid: 100, token: 'tok', logger: {}, identityOf: () => null, bootIdOf: () => '' }).acquire();
  const written = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(written.format, 2);
  assert.equal(written.holder, null);
});

test('a format-2 lock whose holder could not be told is held by its live pid, even 2 h after a clock step', () => {
  const lockPath = tmpLock();
  fs.writeFileSync(lockPath, JSON.stringify({ format: 2, pid: 7348, tokenHash: 'x', startedAt: LOCKED_AT, holder: null }));
  assert.throws(() => acquireOver(lockPath, {
    bootTime: Date.parse(LOCKED_AT) + TWO_HOURS,
    startedAtOf: () => Date.parse(LOCKED_AT) + TWO_HOURS,
    identityOf: () => null,
    bootIdOf: () => '',
  }), (error) => error.code === 'ERELAYLOCKED' && error.message.includes(lockPath));
});

test('a format-2 lock from another boot is stale, holder known or not', () => {
  const lockPath = tmpLock();
  fs.writeFileSync(lockPath, JSON.stringify({ format: 2, pid: 7348, tokenHash: 'x', startedAt: LOCKED_AT, holder: null, bootId: 'boot-a' }));
  assert.equal(acquireOver(lockPath, { identityOf: () => null, bootIdOf: () => 'boot-b' }).pid, 100);
});

test('a lock without the format (0.9.13) with a pid reused after a boot is stale, as before', () => {
  const lockPath = leftLock(LOCKED_AT);
  assert.equal(acquireOver(lockPath, { bootTime: Date.parse(LOCKED_AT) + 60_000, identityOf: () => null, startedAtOf: () => Date.parse(LOCKED_AT) + 120_000 }).pid, 100);
});

test('two processes started at different times have different identities', { skip: !['win32', 'linux'].includes(process.platform) }, async () => {
  const { spawn } = await import('child_process');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const own = processIdentity(process.pid);
    const other = processIdentity(child.pid);
    assert.ok(own && other, 'both read');
    assert.notDeepEqual(other, own, 'started later: another identity');
    assert.deepEqual(processIdentity(child.pid), other, 'the same process read twice');
  } finally {
    child.kill();
  }
});
