import fs from "fs";
import path from "path";
import crypto from "crypto";

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
  logger = console,
}) {
  const lockFilePath = path.resolve(String(lockPath || ""));
  const currentPid = Number.parseInt(String(pid || process.pid), 10);
  const currentTokenHash = hashToken(token);
  const processAlive = typeof isProcessAlive === "function"
    ? isProcessAlive
    : (candidatePid) => {
      if (!Number.isInteger(candidatePid) || candidatePid <= 0) return false;
      try {
        process.kill(candidatePid, 0);
        return true;
      } catch {
        return false;
      }
    };

  function writeLock() {
    fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });
    const payload = {
      pid: currentPid,
      // Store only a hash of the auth token: the guard needs equality for the
      // self-ownership check, never the token itself. Keeps the master
      // credential out of a file that has historically been world-readable.
      tokenHash: currentTokenHash,
      startedAt: now(),
    };
    const fd = fs.openSync(lockFilePath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
    return payload;
  }

  function acquire() {
    try {
      return writeLock();
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const existingLock = safeReadLock(lockFilePath);
    const existingPid = Number.isInteger(existingLock?.pid) ? existingLock.pid : null;
    const existingTokenHash = typeof existingLock?.tokenHash === "string" ? existingLock.tokenHash : "";
    const existingStartedAt = existingLock?.startedAt || "unknown";

    if (existingPid && processAlive(existingPid)) {
      if (existingTokenHash && existingTokenHash === currentTokenHash) {
        throw new Error(`Relay already running (pid=${existingPid}, startedAt=${existingStartedAt}).`);
      }
      throw new Error(
        `Relay appears to be owned by another live process (pid=${existingPid}, startedAt=${existingStartedAt}).`
      );
    }

    try {
      fs.unlinkSync(lockFilePath);
      logger?.warn?.(`[server] Recovered stale singleton lock: ${lockFilePath}`);
    } catch (unlinkError) {
      if (unlinkError?.code !== "ENOENT") throw unlinkError;
    }

    return writeLock();
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
