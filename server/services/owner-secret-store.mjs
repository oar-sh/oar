'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  AGENT_TOKEN_KINDS,
  CLI_AGENT_SUBJECT,
  agentKeyBytes,
  hashOwnerToken,
  hashesMatch,
  mintAgentKey,
  mintAgentTokenWithKey,
  mintOwnerToken,
  ownerTokenMatchesHash,
  verifyAgentTokenWithKey,
} from '../../shared/relay-credentials.mjs';
import { deriveFileCapabilityKey } from './file-capability.mjs';
import { deriveMediaTagKey } from './media-tag.mjs';

// Where the relay's own secrets live: `<dataDir>/relay-secrets.json`, owner
// only (0600 where the OS has modes), written whole through a temp file and a
// rename. It holds the SHA-256 of the owner token, never the token, and the
// agentKey the agent tokens are derived from:
//
//   { version: 1,
//     owner: { hash, createdAt, rotatedAt, legacyPlaintext, rotatedVia? },
//     agentKey }
//
// First start of this version: the owner token moves out of config.json (and
// out of relay-previous.json; a `--token` on the command line is taken when
// the config has none). If this file cannot be written the relay runs on the
// hash in memory, leaves the config as it is and says so once.
//
// Once this file exists, a `--token` never overrides it: a supervisor started
// by an earlier version keeps its `--token <old>` and passes it to every
// runtime it starts again, which would bring the old token back after a
// rotation. Such a value is ignored with a warning (one equal to the stored
// token is just warned about), and the person is asked to stop and start
// the relay once (argvTokenGiven).
//
// `rotateOwnerToken` is the single way to a new owner token, for the relay's
// route and for `oar setup --new-token`: it writes the file, swaps the hash in
// memory (the old token fails at once) and tells the listeners. agentKey does
// not change with it, so agent tokens, and the turns that hold them, survive.
//
// The relay keeps a copy of the hash in app_settings and compares it at boot
// (reconcileWithSettings): a hash that changed with no OAR rotation means
// someone wrote this file by hand, which is reported, not prevented. Both
// rotations write the copy: the relay's right after the file, `oar setup
// --new-token` itself (it opens the database). What the file says about who
// rotated is not believed, with one exception: a rotation by the relay
// (`rotatedVia: 'relay'`) later than the copy is a relay that stopped between
// the file and the copy, and is taken without an alarm. A process that can
// write this file can write that too: detection, not a boundary.

export const RELAY_SECRETS_FILE = 'relay-secrets.json';
export const RELAY_SECRETS_VERSION = 1;
// app_settings keys of the boot comparison.
export const OWNER_HASH_SETTING_KEY = 'auth_owner_token_hash';
export const OWNER_ALERT_SETTING_KEY = 'auth_owner_token_alert';
// Who wrote a rotation: the relay itself, or `oar setup --new-token`.
export const ROTATED_VIA = Object.freeze({ relay: 'relay', cli: 'cli', config: 'config' });

const HEX_64 = /^[0-9a-f]{64}$/;
// The error bootstrap throws when the file exists but cannot be read (EACCES,
// EBUSY, EISDIR, ...): the relay must not start on a new token over it.
export const RELAY_SECRETS_UNREADABLE = 'ERELAYSECRETSUNREADABLE';

function toText(value) {
  return String(value ?? '').trim();
}

export function relaySecretsPath(dataDir) {
  return path.join(String(dataDir || ''), RELAY_SECRETS_FILE);
}

/** The file's contents when they are usable, else null (absent, unreadable or malformed). */
export function parseRelaySecrets(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const owner = parsed.owner && typeof parsed.owner === 'object' ? parsed.owner : null;
  const hash = toText(owner?.hash).toLowerCase();
  if (!HEX_64.test(hash)) return null;
  const agentKey = agentKeyBytes(parsed.agentKey) ? toText(parsed.agentKey) : '';
  return {
    version: Number(parsed.version) || RELAY_SECRETS_VERSION,
    owner: {
      hash,
      createdAt: toText(owner.createdAt) || null,
      rotatedAt: toText(owner.rotatedAt) || null,
      legacyPlaintext: owner.legacyPlaintext === true,
      ...(toText(owner.rotatedVia) ? { rotatedVia: toText(owner.rotatedVia) } : {}),
    },
    agentKey,
  };
}

export function readRelaySecretsFile(filePath, { fsImpl = fs } = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'missing' : 'unreadable', secrets: null, error };
  }
  const secrets = parseRelaySecrets(raw);
  return secrets ? { status: 'ok', secrets } : { status: 'malformed', secrets: null };
}

// The temp file's bytes reach the disk before the rename makes them the
// file: a power cut after the rename must not leave an empty secrets file.
function fsyncFile(fsImpl, filePath) {
  const fd = fsImpl.openSync(filePath, 'r+');
  try {
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

// The rename itself, made durable (POSIX only; best effort).
function fsyncDirectory(fsImpl, dir, platform) {
  if (platform === 'win32') return;
  let fd = null;
  try {
    fd = fsImpl.openSync(dir, 'r');
    fsImpl.fsyncSync(fd);
  } catch {} finally {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch {} }
  }
}

/** Atomic write: temp file in the same folder, chmod 0600, fsync, rename. Throws on failure. */
export function writeRelaySecretsFile(filePath, secrets, { fsImpl = fs, platform = process.platform } = {}) {
  const dir = path.dirname(filePath);
  fsImpl.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const text = `${JSON.stringify(secrets, null, 2)}\n`;
  try {
    fsImpl.writeFileSync(tmpPath, text, { mode: 0o600 });
    if (platform !== 'win32') {
      try { fsImpl.chmodSync(tmpPath, 0o600); } catch {}
    }
    fsyncFile(fsImpl, tmpPath);
    fsImpl.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fsImpl.unlinkSync(tmpPath); } catch {}
    throw error;
  }
  fsyncDirectory(fsImpl, dir, platform);
  if (platform !== 'win32') {
    try { fsImpl.chmodSync(filePath, 0o600); } catch {}
  }
}

/**
 * The line a relay that refuses to start says when relay-secrets.json exists
 * but cannot be read. Nothing is written over it: a new token there would
 * lock the owner out and hide whatever made the file unreadable.
 */
export function unreadableSecretsMessage(filePath, error) {
  const why = error?.code || error?.message || String(error || 'unknown error');
  return `${filePath} exists but cannot be read (${why}). The relay does not start, and does not replace the file, until it can read it: check the file's owner and permissions, or whether another program holds it open, then start the relay again.`;
}

/**
 * Rewrites a JSON file without `authToken` (read-modify-write through a temp
 * file). Returns true when it changed the file; throws when it could not.
 */
export function stripAuthTokenFromJsonFile(filePath, { fsImpl = fs, platform = process.platform } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (!Object.prototype.hasOwnProperty.call(parsed, 'authToken')) return false;
  const { authToken: _dropped, ...rest } = parsed;
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fsImpl.writeFileSync(tmpPath, `${JSON.stringify(rest, null, 2)}\n`, { mode: 0o600 });
    if (platform !== 'win32') {
      try { fsImpl.chmodSync(tmpPath, 0o600); } catch {}
    }
    fsImpl.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fsImpl.unlinkSync(tmpPath); } catch {}
    throw error;
  }
  return true;
}

/**
 * What a relay's first start says about the token it just made. Shown once,
 * and only to a terminal: a relay started in the background writes its
 * stdout to a log file agents can read. Without a terminal it names the way
 * to get one that can be seen (`oar setup --new-token`, in a terminal).
 */
export function announceGeneratedToken(token, { isTTY = false, write = (text) => process.stdout.write(text), log = console.log } = {}) {
  if (!token) return 'none';
  if (isTTY) {
    write(`[server] New relay token (shown once, keep it in your password manager): ${token}
`);
    return 'shown';
  }
  log('[server] A new relay token was generated and stored as a hash; it is not written to the log. Run `oar setup --new-token` in a terminal to get one you can see.');
  return 'withheld';
}

export function createOwnerSecretStore({
  dataDir,
  filePath = relaySecretsPath(dataDir),
  fsImpl = fs,
  platform = process.platform,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  logger = console,
} = {}) {
  // What the file holds (or would hold, when it cannot be written).
  let secrets = null;
  let persisted = false;
  // A `--token` came on the command line (ignored unless it moved in on the
  // first start; it is still visible in the process list).
  let argvGiven = false;
  // The plain owner token, known only on the boot that moved it out of the
  // config or argv (pairing conversion, log redaction). Never written.
  let legacyThisBoot = '';
  // What happened to the owner token on this boot: 'loaded' | 'migrated' |
  // 'generated' | 'config-reappeared'.
  let bootChange = null;
  let alert = null;
  const rotateListeners = new Set();

  function stamp() {
    return now().toISOString();
  }

  function persist(next) {
    writeRelaySecretsFile(filePath, next, { fsImpl, platform });
    persisted = true;
  }

  function tryPersist(next, what) {
    try {
      persist(next);
      return true;
    } catch (error) {
      persisted = false;
      logger?.warn?.(`[auth] ${what}: ${filePath} could not be written (${error?.code || error?.message || error}); the relay keeps the token hash in memory for this run.`);
      return false;
    }
  }

  function freshSecrets(hash, { legacyPlaintext, agentKey = mintAgentKey(randomBytes) }) {
    return {
      version: RELAY_SECRETS_VERSION,
      owner: { hash, createdAt: stamp(), rotatedAt: null, legacyPlaintext: legacyPlaintext === true },
      agentKey,
    };
  }

  /** Loads the file without migrating anything (the CLI's view). */
  function load() {
    const read = readRelaySecretsFile(filePath, { fsImpl });
    if (read.status === 'ok') {
      secrets = read.secrets;
      persisted = true;
    }
    return read.status;
  }

  /**
   * First-start migration and boot. `config` is the parsed config.json (its
   * `authToken` is read, never kept), `configPath` the file to rewrite,
   * `argvToken` a `--token` value, `previousPath` relay-previous.json.
   * Returns `{ generatedToken, change }`: a token minted because none existed
   * (the caller shows it once, to a terminal only).
   */
  function bootstrap({ config = {}, configPath = '', argvToken = '', previousPath = '' } = {}) {
    const configToken = toText(config?.authToken);
    const argv = toText(argvToken);
    const read = readRelaySecretsFile(filePath, { fsImpl });
    let generatedToken = '';
    if (read.status === 'unreadable') {
      // Never written over (S5): the caller stops the relay on purpose.
      const error = new Error(unreadableSecretsMessage(filePath, read.error));
      error.code = RELAY_SECRETS_UNREADABLE;
      error.cause = read.error;
      throw error;
    }
    if (read.status === 'malformed') {
      logger?.warn?.(`[auth] ${filePath} could not be understood; it is set aside and the relay starts with a new one.`);
      try { fsImpl.renameSync(filePath, `${filePath}.bad-${Date.now()}`); } catch {}
    }

    if (read.status === 'ok') {
      secrets = read.secrets;
      persisted = true;
      bootChange = 'loaded';
      if (!secrets.agentKey) {
        secrets = { ...secrets, agentKey: mintAgentKey(randomBytes) };
        tryPersist(secrets, 'Adding the agent key');
      }
      if (configToken) {
        if (ownerTokenMatchesHash(configToken, secrets.owner.hash)) {
          // The same token left behind (a config write that failed last time).
          legacyThisBoot = configToken;
        } else {
          // A hand edit put a token back into config.json: it becomes the
          // owner token, and that is reported (reconcileWithSettings).
          legacyThisBoot = configToken;
          bootChange = 'config-reappeared';
          const next = {
            ...secrets,
            owner: { ...secrets.owner, hash: hashOwnerToken(configToken), rotatedAt: stamp(), legacyPlaintext: true, rotatedVia: ROTATED_VIA.config },
          };
          secrets = next;
          tryPersist(next, 'Taking the token found in config.json');
          logger?.warn?.('[auth] config.json held an authToken again; it is now the owner token and was moved out of the config.');
        }
      }
    } else {
      // A file that is there but not understood is not a first start: the
      // command line's token is not taken for it (it may be one rotated away).
      const source = configToken || (read.status === 'missing' ? argv : '');
      if (source) {
        legacyThisBoot = source;
        bootChange = 'migrated';
        secrets = freshSecrets(hashOwnerToken(source), { legacyPlaintext: true });
      } else {
        generatedToken = mintOwnerToken(randomBytes);
        bootChange = 'generated';
        secrets = freshSecrets(hashOwnerToken(generatedToken), { legacyPlaintext: false });
      }
      if (tryPersist(secrets, 'Storing the owner token hash') && configToken) {
        logger?.log?.(`[auth] The owner token moved out of the config into ${filePath} (stored as a hash).`);
      }
    }

    // The config and relay-previous.json lose their plain text once the hash
    // is safely on disk; without that the config is left alone (no lockout).
    if (persisted && configToken && configPath) {
      try {
        stripAuthTokenFromJsonFile(configPath, { fsImpl, platform });
      } catch (error) {
        logger?.warn?.(`[auth] config.json still holds the token: it could not be rewritten (${error?.code || error?.message || error}).`);
      }
    }
    if (persisted && previousPath) {
      try { stripAuthTokenFromJsonFile(previousPath, { fsImpl, platform }); } catch {}
    }

    if (argv) {
      argvGiven = true;
      logger?.warn?.('[auth] --token on the command line is visible to other processes on this host; the relay keeps its token in relay-secrets.json and needs no --token. Stop and start the relay once so it runs without it.');
      if (!ownerTokenMatchesHash(argv, secrets.owner.hash)) {
        logger?.warn?.(`[auth] The --token value is not the relay token stored in ${filePath}; it is ignored.`);
      }
    }
    return { generatedToken, change: bootChange, persisted };
  }

  // The hash in relay-secrets.json (or the one held for it when the file
  // could not be written). Nothing else is ever in force.
  function currentOwnerHash() {
    return secrets?.owner?.hash || '';
  }

  function verifyOwnerToken(value) {
    const expected = currentOwnerHash();
    if (!expected) return false;
    return ownerTokenMatchesHash(value, expected);
  }

  function requireKey() {
    const key = agentKeyBytes(secrets?.agentKey);
    if (!key) throw new Error('The relay has no agent key');
    return key;
  }

  /** `{ kind: 's', subject: conversationId }` or `{ kind: 'c' }` (the cli token). */
  function mintAgentToken({ kind = AGENT_TOKEN_KINDS.session, subject = '' } = {}) {
    return mintAgentTokenWithKey(requireKey(), {
      kind,
      subject: kind === AGENT_TOKEN_KINDS.cli || kind === 'cli' ? CLI_AGENT_SUBJECT : subject,
    });
  }

  function verifyAgentToken(value) {
    const key = agentKeyBytes(secrets?.agentKey);
    if (!key) return null;
    return verifyAgentTokenWithKey(key, value);
  }

  /**
   * The one way to a new owner token. Writes the file first; only then the
   * hash in memory changes, so a failed write leaves the old token working.
   * Resolves `{ token, rotatedAt }`; the plain token goes to the caller once.
   */
  function rotateOwnerToken({ reason = '', via = ROTATED_VIA.relay } = {}) {
    if (!secrets) load();
    if (!secrets) throw new Error('The relay has no owner token to rotate yet; start it once first.');
    const token = mintOwnerToken(randomBytes);
    const rotatedAt = stamp();
    const next = {
      ...secrets,
      owner: {
        ...secrets.owner,
        hash: hashOwnerToken(token),
        rotatedAt,
        legacyPlaintext: false,
        rotatedVia: via,
      },
    };
    persist(next);
    secrets = next;
    legacyThisBoot = '';
    for (const listener of rotateListeners) {
      try { listener({ reason: toText(reason), via, rotatedAt, ownerHash: next.owner.hash }); } catch {}
    }
    return { token, rotatedAt };
  }

  function onRotate(listener) {
    if (typeof listener !== 'function') return () => {};
    rotateListeners.add(listener);
    return () => rotateListeners.delete(listener);
  }

  /**
   * Boot comparison with the copy in app_settings: an owner hash that
   * changed with no OAR rotation (the file written by hand or by a process)
   * raises the alert, which stays until it is acknowledged.
   */
  function reconcileWithSettings({ readSetting, writeSetting } = {}) {
    if (typeof readSetting !== 'function' || typeof writeSetting !== 'function' || !secrets) return { alert };
    const fileHash = secrets.owner.hash;
    let copy = null;
    try { copy = JSON.parse(String(readSetting(OWNER_HASH_SETTING_KEY) || 'null')); } catch {}
    try { alert = JSON.parse(String(readSetting(OWNER_ALERT_SETTING_KEY) || 'null')); } catch { alert = null; }
    const copyHash = toText(copy?.hash).toLowerCase();
    const write = () => {
      try { writeSetting(OWNER_HASH_SETTING_KEY, JSON.stringify({ hash: fileHash, at: stamp() })); } catch {}
    };
    if (!copyHash) {
      write();
      return { alert };
    }
    if (hashesMatch(copyHash, fileHash)) return { alert };
    const rotatedAt = Date.parse(secrets.owner.rotatedAt || '');
    const copiedAt = Date.parse(copy?.at || '');
    // The relay rotated, wrote the file, and stopped (a crash, a database
    // that refused the write) before the copy: not a change outside OAR.
    const unfinishedRelayRotation = bootChange === 'loaded'
      && secrets.owner.rotatedVia === ROTATED_VIA.relay
      && Number.isFinite(rotatedAt) && Number.isFinite(copiedAt) && rotatedAt > copiedAt;
    if (unfinishedRelayRotation) {
      logger?.log?.('[auth] The owner token was rotated by this relay after the database last recorded it; the record is brought up to date.');
    } else {
      const reason = bootChange === 'config-reappeared' ? 'config' : 'file';
      alert = { reason, at: stamp() };
      try { writeSetting(OWNER_ALERT_SETTING_KEY, JSON.stringify(alert)); } catch {}
      logger?.warn?.(reason === 'config'
        ? '[auth] The relay token was changed outside OAR: config.json held a new authToken.'
        : `[auth] The relay token was changed outside OAR: ${filePath} holds another owner hash than this relay last stored.`);
    }
    write();
    return { alert };
  }

  /**
   * Keeps the app_settings copy in step after a rotation (by this relay, or
   * by `oar setup --new-token` through the database). True when written; a
   * failure is logged, never thrown (the rotation itself stands).
   */
  function recordOwnerHash({ writeSetting } = {}) {
    if (typeof writeSetting !== 'function' || !secrets) return false;
    try {
      writeSetting(OWNER_HASH_SETTING_KEY, JSON.stringify({ hash: secrets.owner.hash, at: stamp() }));
      return true;
    } catch (error) {
      logger?.warn?.(`[auth] The owner token's record in the database could not be written (${error?.code || error?.message || error}).`);
      return false;
    }
  }

  function clearAlert({ writeSetting } = {}) {
    alert = null;
    if (typeof writeSetting === 'function') {
      try { writeSetting(OWNER_ALERT_SETTING_KEY, 'null'); } catch {}
    }
  }

  return {
    filePath,
    load,
    bootstrap,
    hasOwner: () => !!currentOwnerHash(),
    ownerTokenHash: currentOwnerHash,
    // The file's hash; what a dismissed notice is tied to.
    storedOwnerHash: currentOwnerHash,
    // A `--token` came on the command line: the process list shows it.
    argvTokenGiven: () => argvGiven,
    verifyOwnerToken,
    mintAgentToken,
    verifyAgentToken,
    hasAgentKey: () => !!agentKeyBytes(secrets?.agentKey),
    // The key file capabilities are signed with (file-capability.mjs),
    // derived from the agentKey; it never leaves the relay.
    fileCapabilityKey: () => deriveFileCapabilityKey(agentKeyBytes(secrets?.agentKey)),
    // The key media tags are made with (media-tag.mjs), its own label.
    mediaTagKey: () => deriveMediaTagKey(agentKeyBytes(secrets?.agentKey)),
    rotateOwnerToken,
    onRotate,
    reconcileWithSettings,
    recordOwnerHash,
    ownerTokenAlert: () => alert,
    clearAlert,
    legacyTokenThisBoot: () => legacyThisBoot,
    // The plain token for the pairing conversion (convertOwnEntries): only
    // on the boot that moved it out of the config ('migrated'). A token put
    // back into the config, or a --token, is not the one `own` pairings used.
    migratedOwnerToken: () => (bootChange === 'migrated' ? legacyThisBoot : ''),
    bootChange: () => bootChange,
    isPersisted: () => persisted,
    status: () => ({
      set: !!currentOwnerHash(),
      hashed: true,
      persisted,
      createdAt: secrets?.owner?.createdAt || null,
      rotatedAt: secrets?.owner?.rotatedAt || null,
      legacyPlaintext: secrets?.owner?.legacyPlaintext === true,
    }),
  };
}
