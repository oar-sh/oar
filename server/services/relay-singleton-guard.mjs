import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { createRequire } from "module";

// An EPERM is a process this user may not signal: alive.
export function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

let processTimes;
// When a process started, in ms, or null when that cannot be told. Windows
// asks the kernel (GetProcessTimes through koffi, which the Copilot SDK
// brings): PowerShell fails in ConstrainedLanguage mode and with a broken
// TEMP. Elsewhere `ps`.
export function processStartedAt(pid, { platform = process.platform } = {}) {
  try {
    if (platform !== "win32") {
      // `lstart`, the full date; LC_ALL=C to parse; unparsable: cannot tell.
      const result = spawnSync("ps", ["-o", "lstart=", "-p", String(Number(pid))], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C" } });
      const ms = Date.parse(String(result.stdout || "").trim());
      return Number.isFinite(ms) ? ms : null;
    }
    if (!processTimes) {
      const koffi = createRequire(import.meta.url)("koffi");
      const kernel32 = koffi.load("kernel32.dll");
      processTimes = {
        open: kernel32.func("void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)"),
        times: kernel32.func("bool __stdcall GetProcessTimes(void *h, _Out_ uint64_t *a, _Out_ uint64_t *b, _Out_ uint64_t *c, _Out_ uint64_t *d)"),
        close: kernel32.func("bool __stdcall CloseHandle(void *h)"),
      };
    }
    const handle = processTimes.open(0x1000, false, Number(pid)); // PROCESS_QUERY_LIMITED_INFORMATION
    if (!handle) return null;
    try {
      const created = [0n];
      if (!processTimes.times(handle, created, [0n], [0n], [0n])) return null;
      return Number(BigInt(created[0]) / 10000n) - 11644473600000; // FILETIME: 100 ns since 1601
    } finally {
      processTimes.close(handle);
    }
  } catch {
    return null;
  }
}

let bootId;
// Linux's id of the running boot, '' elsewhere or when unreadable.
export function currentBootId({ platform = process.platform, readFile = fs.readFileSync } = {}) {
  if (platform !== "linux") return "";
  try {
    bootId ??= String(readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return bootId;
  } catch {
    return "";
  }
}

/**
 * A process's start as the system keeps it, which no later clock step moves:
 * Windows' creation time (exact), Linux's start in ticks since boot with the
 * boot id, elsewhere `ps` (to the second). Null when it cannot be told.
 */
export function processIdentity(pid, { platform = process.platform, readFile = fs.readFileSync } = {}) {
  try {
    if (platform === "linux") {
      const stat = String(readFile(`/proc/${Number(pid)}/stat`, "utf8"));
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; // field 22, starttime
      return /^\d+$/.test(ticks) ? { start: `ticks:${ticks}`, bootId: currentBootId({ platform, readFile }) } : null;
    }
    const ms = processStartedAt(pid, { platform });
    if (ms === null) return null;
    return { start: platform === "win32" ? `win:${ms}` : ms };
  } catch {
    return null;
  }
}

// Exact for the kernel's own values, to the second for `ps`.
function sameStart(a, b) {
  return typeof a === "number" && typeof b === "number" ? Math.abs(a - b) <= 1000 : a === b;
}

/**
 * Whether the relay a lock names may still run; true when that cannot be
 * told: better a refused start than two relays. A lock this version wrote
 * (format 2) never goes by the clock: a live pid (EPERM counts) holds it
 * when its start matches the recorded holder, or when either start is
 * unknown; it is stale when the pid's start differs, or when the boot id it
 * recorded (Linux) is not the running one. Only a lock without the format
 * (0.9.13's) goes by the clock, the one case a clock step can mislead:
 * written before the last boot, or older than the pid's process by more
 * than 5 s (a reused pid), it is stale.
 */
export function lockHolderMayRun({
  lock,
  isProcessAlive = defaultIsProcessAlive,
  identityOf = processIdentity,
  bootIdOf = currentBootId,
  startedAtOf = processStartedAt,
  bootTime = Date.now() - os.uptime() * 1000,
}) {
  const pid = Number.parseInt(String(lock?.pid ?? ""), 10);
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) return false;
  if (lock?.format >= 2 || lock?.holder) {
    const current = lock.holder ? identityOf(pid) : null;
    const recordedBoot = lock.holder?.bootId || lock.bootId;
    const runningBoot = current?.bootId || bootIdOf();
    if (recordedBoot && runningBoot && recordedBoot !== runningBoot) return false;
    return !current || sameStart(lock.holder.start, current.start);
  }
  const lockedAt = Date.parse(String(lock?.startedAt || ""));
  if (Number.isFinite(lockedAt) && lockedAt < bootTime) return false;
  const startedAt = startedAtOf(pid);
  if (Number.isFinite(lockedAt) && startedAt !== null && startedAt > lockedAt + 5000) return false;
  return true;
}

function hashToken(value) {
  const token = String(value || "").trim();
  if (!token) return "";
  return crypto.createHash("sha256").update(token).digest("hex");
}

function safeReadLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    // Prefer the hashed field; fall back to hashing a legacy plaintext `token`
    // so a lock written by an older build still matches (and is rewritten 0600).
    const tokenHash = typeof parsed?.tokenHash === "string" && parsed.tokenHash
      ? parsed.tokenHash
      : hashToken(parsed?.token);
    return {
      pid: Number.parseInt(String(parsed?.pid ?? ""), 10),
      tokenHash,
      startedAt: typeof parsed?.startedAt === "string" ? parsed.startedAt : null,
      holder: parsed?.holder && typeof parsed.holder === "object" ? parsed.holder : null,
      format: Number(parsed?.format) || 0,
      bootId: typeof parsed?.bootId === "string" ? parsed.bootId : "",
    };
  } catch {
    return null;
  }
}

export function createRelaySingletonGuard({
  lockPath,
  pid,
  token,
  now = () => new Date().toISOString(),
  isProcessAlive,
  // When a pid's process started, and when the machine booted (lockHolderMayRun).
  identityOf = processIdentity,
  bootIdOf = currentBootId,
  startedAtOf = processStartedAt,
  bootTime = Date.now() - os.uptime() * 1000,
  // An unreadable lock is read again for `readRetryMs`; still unreadable,
  // it is stale only when its time is more than `unreadableStaleMs` off.
  readRetryMs = 2000,
  unreadableStaleMs = 10_000,
  clock = Date.now,
  sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  logger = console,
}) {
  const lockFilePath = path.resolve(String(lockPath || ""));
  const currentPid = Number.parseInt(String(pid || process.pid), 10);
  const currentTokenHash = hashToken(token);
  const processAlive = typeof isProcessAlive === "function" ? isProcessAlive : defaultIsProcessAlive;

  // The whole lock goes into a file of its own, linked into place (fails
  // when a lock is there): no start ever reads one half written. Where the
  // folder takes no hard links (FAT, exFAT), created and written in place.
  function writeLock() {
    fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });
    const payload = {
      pid: currentPid,
      // Store only a hash of the auth token: the guard needs equality for the
      // self-ownership check, never the token itself. Keeps the master
      // credential out of a file that has historically been world-readable.
      tokenHash: currentTokenHash,
      startedAt: now(),
      // The holder, as lockHolderMayRun tells it without the clock (null:
      // unknown, which then holds the lock while its pid lives).
      format: 2,
      holder: identityOf(currentPid) || null,
      ...(bootIdOf() ? { bootId: bootIdOf() } : {}),
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    const staged = `${lockFilePath}.${currentPid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
    let linked = false;
    let written = false;
    try {
      fs.writeFileSync(staged, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      written = true;
      fs.linkSync(staged, lockFilePath);
      linked = true;
    } catch (error) {
      if (written && error?.code === "EEXIST") throw error;
    } finally {
      if (written) try { fs.unlinkSync(staged); } catch {}
    }
    if (!linked) {
      const fd = fs.openSync(lockFilePath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, text, "utf8");
      } finally {
        try { fs.closeSync(fd); } catch {}
      }
    }
    return payload;
  }

  // Read again for a while (an antivirus scan, a lock written in place);
  // still unreadable: stale when its time is far off, else held.
  function readLockWithRetry() {
    const deadline = clock() + readRetryMs;
    for (;;) {
      const lock = safeReadLock(lockFilePath);
      if (lock || clock() >= deadline) return lock;
      sleep(100);
    }
  }
  function unreadableLockIsStale() {
    try {
      return Math.abs(clock() - fs.statSync(lockFilePath).mtimeMs) > unreadableStaleMs;
    } catch {
      return true;
    }
  }

  const held = (message) => Object.assign(new Error(message), { code: "ERELAYLOCKED" });
  const RENAME_RETRY_MS = [50, 100, 200, 400, 800];

  // The lock as judged: its fields, or for one that cannot be read its size
  // and time, which a moved-aside file must still have to be the same lock.
  function sameLock(file, judged) {
    try {
      const lock = safeReadLock(file);
      if (judged.lock) return !!lock && ["pid", "tokenHash", "startedAt"].every((key) => Object.is(lock[key], judged.lock[key]));
      const stat = fs.statSync(file);
      return !lock && stat.size === judged.size && stat.mtimeMs === judged.mtimeMs;
    } catch {
      return false;
    }
  }

  // A lock put back after it turned out fresh: linked, else (no hard links)
  // created with its content; a lock there by then wins, the file stays.
  function putBack(moved) {
    try {
      try {
        fs.linkSync(moved, lockFilePath);
      } catch (error) {
        if (error?.code === "EEXIST") throw error;
        fs.writeFileSync(lockFilePath, fs.readFileSync(moved), { flag: "wx", mode: 0o600 });
      }
      fs.unlinkSync(moved);
    } catch (error) {
      logger?.warn?.(`[server] A relay lock moved aside could not be put back (${error?.code || error}); it is in ${moved}.`);
    }
  }

  // Files a crashed recovery or write left beside the lock (`.stale-<pid>-`,
  // `.<pid>-….tmp`), never read: removed once their process is gone.
  function removeLeftovers() {
    const base = path.basename(lockFilePath);
    let names = [];
    try { names = fs.readdirSync(path.dirname(lockFilePath)); } catch {}
    for (const name of names) {
      if (!name.startsWith(`${base}.`)) continue;
      const leftPid = Number(/^\.(?:stale-)?(\d+)-[0-9a-f]+(?:\.tmp)?$/.exec(name.slice(base.length))?.[1]);
      if (leftPid && leftPid !== currentPid && !processAlive(leftPid)) try { fs.unlinkSync(path.join(path.dirname(lockFilePath), name)); } catch {}
    }
  }

  function acquire() {
    const payload = takeLock();
    removeLeftovers();
    return payload;
  }

  // A stale lock is moved aside, never unlinked unseen: the file moved must
  // be the one judged, else another start took the lock meanwhile and it
  // goes back. Gone already (another start recovered it): from the top, at
  // most three times.
  function takeLock() {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return writeLock();
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      const existingLock = readLockWithRetry();
      let judged = { lock: existingLock };
      if (!existingLock) {
        if (!unreadableLockIsStale()) {
          throw held(`A relay lock that cannot be read yet is there, written in the last ${unreadableStaleMs / 1000} s (lock ${lockFilePath}). If no relay is starting, delete it.`);
        }
        try {
          const stat = fs.statSync(lockFilePath);
          judged = { lock: null, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          if (attempt < 3) continue;
          throw held(`The relay lock ${lockFilePath} keeps changing.`);
        }
      }
      const existingPid = Number.isInteger(existingLock?.pid) ? existingLock.pid : null;
      const existingTokenHash = typeof existingLock?.tokenHash === "string" ? existingLock.tokenHash : "";
      const existingStartedAt = existingLock?.startedAt || "unknown";

      // A lock from before the last boot, or whose pid now belongs to a
      // process started after it, is stale (a crash, a power loss, a forced
      // reboot): recovered below.
      if (existingPid && lockHolderMayRun({ lock: existingLock, isProcessAlive: processAlive, identityOf, bootIdOf, startedAtOf, bootTime })) {
        const owner = existingTokenHash && existingTokenHash === currentTokenHash
          ? "Relay already running"
          : "Relay appears to be owned by another live process";
        // Delete the lock only when its holder cannot be told to be a relay.
        const known = existingLock.holder && identityOf(existingPid);
        throw held(`${owner} (pid=${existingPid}, startedAt=${existingStartedAt}; lock ${lockFilePath}). ${known
          ? `It is held by relay process ${existingPid}: oar stop, or end process ${existingPid}.`
          : `If no relay is running, end process ${existingPid} or delete the lock.`}`);
      }

      const moved = `${lockFilePath}.stale-${currentPid}-${crypto.randomBytes(4).toString("hex")}`;
      for (let retry = 0; ; retry += 1) {
        try {
          fs.renameSync(lockFilePath, moved);
          break;
        } catch (error) {
          if (error?.code === "ENOENT") break;
          // Held open (an antivirus scan): briefly, then counted as held.
          if (retry < RENAME_RETRY_MS.length && ["EBUSY", "EPERM", "EACCES"].includes(error?.code)) {
            sleep(RENAME_RETRY_MS[retry]);
            continue;
          }
          throw held(`The stale relay lock ${lockFilePath} could not be moved aside (${error?.code || error}); delete it if no relay is running.`);
        }
      }
      if (!fs.existsSync(moved)) {
        if (attempt < 3) continue;
        throw held(`The relay lock ${lockFilePath} keeps changing.`);
      }
      if (!sameLock(moved, judged)) {
        putBack(moved);
        throw held(`Another relay took the lock ${lockFilePath} while this one recovered it.`);
      }
      try { fs.unlinkSync(moved); } catch {}
      logger?.warn?.(`[server] Recovered stale singleton lock: ${lockFilePath}`);
      try {
        return writeLock();
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (attempt >= 3) throw held(`The relay lock ${lockFilePath} keeps changing.`);
      }
    }
  }

  function release() {
    const existingLock = safeReadLock(lockFilePath);
    if (!existingLock) return false;
    if (existingLock.pid !== currentPid) return false;
    if (String(existingLock.tokenHash || "") !== currentTokenHash) return false;
    try {
      fs.unlinkSync(lockFilePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      throw error;
    }
  }

  return {
    lockFilePath,
    acquire,
    release,
  };
}
