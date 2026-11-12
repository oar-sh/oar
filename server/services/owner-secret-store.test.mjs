import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  OWNER_ALERT_SETTING_KEY,
  OWNER_HASH_SETTING_KEY,
  RELAY_SECRETS_UNREADABLE,
  ROTATED_VIA,
  announceGeneratedToken,
  createOwnerSecretStore,
  relaySecretsPath,
  writeRelaySecretsFile,
} from './owner-secret-store.mjs';
import { createRelaySingletonGuard } from './relay-singleton-guard.mjs';
import {
  AGENT_TOKEN_PREFIX,
  OWNER_TOKEN_PREFIX,
  hashOwnerToken,
  isRelayCredential,
  mintAgentTokenWithKey,
  parseAgentToken,
  redactRelayCredentials,
  verifyAgentTokenWithKey,
} from '../../shared/relay-credentials.mjs';

// Values built at run time: no credential-shaped literal lives in the source.
const LEGACY_TOKEN = crypto.randomUUID();
const quiet = { log() {}, warn() {} };

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-owner-secrets-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  const previousPath = path.join(dataDir, 'relay-previous.json');
  return { dir, dataDir, configPath, previousPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function settingsStore() {
  const values = new Map();
  return {
    values,
    readSetting: (key) => values.get(key) ?? '',
    writeSetting: (key, value) => { values.set(key, value); },
  };
}

function captureLogger() {
  const lines = [];
  return { lines, log: (line) => lines.push(String(line)), warn: (line) => lines.push(String(line)) };
}

test('first start: the token leaves config.json and relay-previous.json, only its hash is stored, and it still signs in', () => {
  const env = scratch();
  try {
    writeJson(env.configPath, { authToken: LEGACY_TOKEN, port: 4321, localhostOnly: true });
    writeJson(env.previousPath, { port: 4320, authToken: LEGACY_TOKEN });
    const logger = captureLogger();
    const store = createOwnerSecretStore({ dataDir: env.dataDir, logger });
    const boot = store.bootstrap({ config: readJson(env.configPath), configPath: env.configPath, previousPath: env.previousPath });

    assert.equal(boot.change, 'migrated');
    assert.equal(boot.generatedToken, '');
    const config = readJson(env.configPath);
    assert.equal(config.authToken, undefined, 'no authToken in the config');
    assert.equal(config.port, 4321, 'the rest of the config is kept');
    assert.equal(readJson(env.previousPath).authToken, undefined, 'no token in relay-previous.json');
    assert.equal(readJson(env.previousPath).port, 4320);

    const raw = fs.readFileSync(relaySecretsPath(env.dataDir), 'utf8');
    assert.ok(!raw.includes(LEGACY_TOKEN), 'the secrets file holds no plain token');
    const secrets = JSON.parse(raw);
    assert.equal(secrets.version, 1);
    assert.equal(secrets.owner.hash, hashOwnerToken(LEGACY_TOKEN));
    assert.equal(secrets.owner.legacyPlaintext, true);
    assert.equal(secrets.owner.rotatedAt, null);
    assert.ok(secrets.agentKey.length >= 43);
    if (process.platform !== 'win32') { // host-platform: POSIX file modes exist only off Windows
      assert.equal(fs.statSync(relaySecretsPath(env.dataDir)).mode & 0o777, 0o600);
    }

    assert.equal(store.verifyOwnerToken(LEGACY_TOKEN), true, 'the old token still signs in');
    assert.equal(store.verifyOwnerToken(`${LEGACY_TOKEN}x`), false);
    assert.equal(store.verifyOwnerToken(''), false);
    assert.equal(store.legacyTokenThisBoot(), LEGACY_TOKEN, 'known on this boot only (pairing conversion)');
    assert.equal(store.migratedOwnerToken(), LEGACY_TOKEN, 'the migration boot converts the `own` pairings');
    assert.ok(logger.lines.every((line) => !line.includes(LEGACY_TOKEN)), 'never logged');

    // The next start reads the file and needs nothing from the config.
    const next = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    assert.equal(next.bootstrap({ config: readJson(env.configPath), configPath: env.configPath }).change, 'loaded');
    assert.equal(next.verifyOwnerToken(LEGACY_TOKEN), true);
    assert.equal(next.legacyTokenThisBoot(), '');
  } finally {
    env.cleanup();
  }
});

test('a config that cannot be rewritten: the relay runs on the hash with a warning', () => {
  const env = scratch();
  try {
    writeJson(env.configPath, { authToken: LEGACY_TOKEN, port: 4321 });
    const logger = captureLogger();
    const fsImpl = {
      ...fs,
      renameSync(from, to) {
        if (path.resolve(to) === path.resolve(env.configPath)) {
          const error = new Error('read-only');
          error.code = 'EROFS';
          throw error;
        }
        return fs.renameSync(from, to);
      },
    };
    const store = createOwnerSecretStore({ dataDir: env.dataDir, fsImpl, logger });
    store.bootstrap({ config: readJson(env.configPath), configPath: env.configPath });
    assert.equal(store.verifyOwnerToken(LEGACY_TOKEN), true);
    assert.ok(fs.existsSync(relaySecretsPath(env.dataDir)));
    assert.ok(logger.lines.some((line) => /config\.json still holds the token/.test(line)));
  } finally {
    env.cleanup();
  }
});

test('a secrets file that cannot be written: in-memory hash, config left alone, one warning', () => {
  const env = scratch();
  try {
    writeJson(env.configPath, { authToken: LEGACY_TOKEN, port: 4321 });
    const logger = captureLogger();
    const fsImpl = {
      ...fs,
      writeFileSync(file, ...rest) {
        if (String(file).includes('relay-secrets.json')) {
          const error = new Error('no space');
          error.code = 'ENOSPC';
          throw error;
        }
        return fs.writeFileSync(file, ...rest);
      },
    };
    const store = createOwnerSecretStore({ dataDir: env.dataDir, fsImpl, logger });
    const boot = store.bootstrap({ config: readJson(env.configPath), configPath: env.configPath });
    assert.equal(boot.persisted, false);
    assert.equal(store.isPersisted(), false);
    assert.equal(store.verifyOwnerToken(LEGACY_TOKEN), true);
    assert.equal(readJson(env.configPath).authToken, LEGACY_TOKEN, 'no lockout: the config keeps the token');
    assert.equal(logger.lines.filter((line) => /could not be written/.test(line)).length, 1);
  } finally {
    env.cleanup();
  }
});

test('a secrets file that exists but cannot be read stops the start; nothing is written over it', () => {
  const env = scratch();
  try {
    writeJson(env.configPath, { authToken: LEGACY_TOKEN });
    const store = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    store.bootstrap({ config: readJson(env.configPath), configPath: env.configPath });
    const file = relaySecretsPath(env.dataDir);
    const before = fs.readFileSync(file, 'utf8');

    for (const code of ['EACCES', 'EBUSY', 'EPERM']) {
      const writes = [];
      const fsImpl = {
        ...fs,
        readFileSync(target, ...rest) {
          if (path.resolve(String(target)) === path.resolve(file)) throw Object.assign(new Error(code), { code });
          return fs.readFileSync(target, ...rest);
        },
        writeFileSync(target, ...rest) { writes.push(String(target)); return fs.writeFileSync(target, ...rest); },
        renameSync(from, to) { writes.push(String(to)); return fs.renameSync(from, to); },
      };
      const next = createOwnerSecretStore({ dataDir: env.dataDir, fsImpl, logger: quiet });
      assert.throws(
        () => next.bootstrap({ config: {}, configPath: env.configPath, argvToken: crypto.randomUUID() }),
        (error) => error.code === RELAY_SECRETS_UNREADABLE && error.message.includes(file) && error.message.includes(code),
      );
      assert.deepEqual(writes, [], `${code}: nothing written`);
      assert.equal(next.hasOwner(), false, 'no token in force');
      assert.throws(() => next.rotateOwnerToken({ reason: 'test' }), 'no rotation over it either');
      assert.deepEqual(writes, []);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the file is untouched');

    // The same holds for a folder where the file should be (EISDIR).
    const odd = scratch();
    try {
      fs.mkdirSync(relaySecretsPath(odd.dataDir));
      const store2 = createOwnerSecretStore({ dataDir: odd.dataDir, logger: quiet });
      assert.throws(() => store2.bootstrap({ config: {}, configPath: odd.configPath }), { code: RELAY_SECRETS_UNREADABLE });
      assert.equal(fs.statSync(relaySecretsPath(odd.dataDir)).isDirectory(), true);
    } finally {
      odd.cleanup();
    }
  } finally {
    env.cleanup();
  }
});

test('the secrets file is written to a temp file, synced to disk, then renamed', () => {
  const env = scratch();
  try {
    const calls = [];
    const fsImpl = {
      ...fs,
      writeFileSync(target, ...rest) { calls.push(['write', path.basename(String(target))]); return fs.writeFileSync(target, ...rest); },
      fsyncSync(fd) { calls.push(['fsync']); return fs.fsyncSync(fd); },
      renameSync(from, to) { calls.push(['rename', path.basename(String(to))]); return fs.renameSync(from, to); },
    };
    const file = relaySecretsPath(env.dataDir);
    writeRelaySecretsFile(file, { version: 1, owner: { hash: hashOwnerToken(LEGACY_TOKEN) }, agentKey: '' }, { fsImpl });
    const write = calls.findIndex(([kind]) => kind === 'write');
    const fsync = calls.findIndex(([kind]) => kind === 'fsync');
    const rename = calls.findIndex(([kind]) => kind === 'rename');
    assert.ok(write >= 0 && fsync > write && rename > fsync, `write, fsync, rename in that order: ${JSON.stringify(calls)}`);
    assert.match(calls[write][1], /\.tmp$/);
    assert.equal(calls[rename][1], 'relay-secrets.json');
    assert.equal(readJson(file).owner.hash, hashOwnerToken(LEGACY_TOKEN));
  } finally {
    env.cleanup();
  }
});

test('fresh install: an oaro1_ token is generated once, only its hash is written', () => {
  const env = scratch();
  try {
    const store = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    const boot = store.bootstrap({ config: {}, configPath: env.configPath });
    assert.equal(boot.change, 'generated');
    assert.ok(boot.generatedToken.startsWith(OWNER_TOKEN_PREFIX));
    assert.equal(boot.generatedToken.length, OWNER_TOKEN_PREFIX.length + 43);
    assert.ok(!fs.readFileSync(relaySecretsPath(env.dataDir), 'utf8').includes(boot.generatedToken));
    assert.equal(store.verifyOwnerToken(boot.generatedToken), true);
    assert.equal(readJson(relaySecretsPath(env.dataDir)).owner.legacyPlaintext, false);
  } finally {
    env.cleanup();
  }
});

test('--token: taken on the first start only; once relay-secrets.json exists it is ignored with a warning', () => {
  const env = scratch();
  try {
    // First start with no config token: the command line's token moves in.
    const first = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    assert.equal(first.bootstrap({ config: {}, configPath: env.configPath, argvToken: LEGACY_TOKEN }).change, 'migrated');
    assert.equal(first.verifyOwnerToken(LEGACY_TOKEN), true);
    assert.equal(first.argvTokenGiven(), true);

    const other = crypto.randomUUID();
    const logger = captureLogger();
    const second = createOwnerSecretStore({ dataDir: env.dataDir, logger });
    second.bootstrap({ config: {}, configPath: env.configPath, argvToken: other });
    assert.equal(second.verifyOwnerToken(other), false, 'argv never overrides the stored hash');
    assert.equal(second.verifyOwnerToken(LEGACY_TOKEN), true);
    assert.equal(second.ownerTokenHash(), hashOwnerToken(LEGACY_TOKEN));
    assert.equal(second.storedOwnerHash(), hashOwnerToken(LEGACY_TOKEN));
    assert.equal(second.legacyTokenThisBoot(), '', 'an ignored value is no legacy token');
    assert.equal(second.argvTokenGiven(), true, 'the person is told to stop and start once');
    assert.ok(logger.lines.some((line) => /visible to other processes/.test(line)));
    assert.ok(logger.lines.some((line) => /is ignored/.test(line)));
    assert.ok(logger.lines.every((line) => !line.includes(other)), 'never logged');

    // The same value as stored: a warning only.
    const same = captureLogger();
    const third = createOwnerSecretStore({ dataDir: env.dataDir, logger: same });
    third.bootstrap({ config: {}, configPath: env.configPath, argvToken: LEGACY_TOKEN });
    assert.equal(third.verifyOwnerToken(LEGACY_TOKEN), true);
    assert.ok(!same.lines.some((line) => /is ignored/.test(line)));

    // A file that is there but malformed is not a first start either.
    fs.writeFileSync(relaySecretsPath(env.dataDir), '{ not json');
    const fourth = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    fourth.bootstrap({ config: {}, configPath: env.configPath, argvToken: other });
    assert.equal(fourth.verifyOwnerToken(other), false);
  } finally {
    env.cleanup();
  }
});

test('B1: --token of an earlier supervisor + rotate + self-restart: the new token stays valid, the old one is refused', () => {
  const env = scratch();
  try {
    // 0.9.26's launcher: the token in config.json and on the supervisor's argv.
    writeJson(env.configPath, { authToken: LEGACY_TOKEN });
    const boot = (argvToken) => {
      const store = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
      store.bootstrap({ config: readJson(env.configPath), configPath: env.configPath, argvToken });
      return store;
    };
    const updated = boot(LEGACY_TOKEN);
    const { token } = updated.rotateOwnerToken({ reason: 'test', via: ROTATED_VIA.relay });
    // The old supervisor relaunches the runtime with its own argv (exit 75).
    const restarted = boot(LEGACY_TOKEN);
    assert.equal(restarted.verifyOwnerToken(token), true, 'the new token stays valid');
    assert.equal(restarted.verifyOwnerToken(LEGACY_TOKEN), false, 'the old token is refused');
    assert.equal(restarted.argvTokenGiven(), true);
  } finally {
    env.cleanup();
  }
});

test('agent tokens: per session and cli, derived from agentKey, tampered or foreign ones refused', () => {
  const env = scratch();
  try {
    const store = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    store.bootstrap({ config: {}, configPath: env.configPath });
    const session = store.mintAgentToken({ kind: 's', subject: 'conv-123' });
    const cli = store.mintAgentToken({ kind: 'c' });
    assert.ok(session.startsWith(`${AGENT_TOKEN_PREFIX}s.`));
    assert.ok(cli.startsWith(`${AGENT_TOKEN_PREFIX}c.`));
    assert.deepEqual(store.verifyAgentToken(session), { kind: 's', subject: 'conv-123' });
    assert.deepEqual(store.verifyAgentToken(cli), { kind: 'c', subject: 'cli' });
    assert.equal(store.mintAgentToken({ kind: 's', subject: 'conv-123' }), session, 'derived: the same every time');

    // Tampering: another subject with the same MAC, a flipped MAC byte, another kind.
    const parsed = parseAgentToken(session);
    const otherSubject = `${AGENT_TOKEN_PREFIX}s.${Buffer.from('conv-999').toString('base64url')}.${parsed.mac.toString('base64url')}`;
    assert.equal(store.verifyAgentToken(otherSubject), null);
    const flipped = session.slice(0, -2) + (session.at(-2) === 'A' ? 'B' : 'A') + session.at(-1);
    assert.equal(store.verifyAgentToken(flipped), null);
    // The MAC's last character carries two unused bits: setting them spells
    // the same bytes another way, and is refused. One token, one spelling.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(session.at(-1));
    assert.equal(last & 3, 0, 'a minted MAC is canonical');
    for (const unused of [1, 2, 3]) {
      const respelled = `${session.slice(0, -1)}${alphabet[last | unused]}`;
      assert.deepEqual(Buffer.from(respelled.split('.').at(-1), 'base64url'), parsed.mac, 'the same bytes');
      assert.equal(parseAgentToken(respelled), null);
      assert.equal(store.verifyAgentToken(respelled), null);
    }
    assert.equal(store.verifyAgentToken(session.replace(`${AGENT_TOKEN_PREFIX}s.`, `${AGENT_TOKEN_PREFIX}c.`)), null);
    assert.equal(store.verifyAgentToken('oara1_s.x.y'), null);
    assert.equal(store.verifyAgentToken(''), null);
    // A token of another relay (another key) is not ours.
    const foreignKey = crypto.randomBytes(32);
    assert.equal(store.verifyAgentToken(mintAgentTokenWithKey(foreignKey, { kind: 's', subject: 'conv-123' })), null);
    assert.deepEqual(verifyAgentTokenWithKey(foreignKey, mintAgentTokenWithKey(foreignKey, { kind: 's', subject: 'a' })), { kind: 's', subject: 'a' });
    // An agent token is never an owner token.
    assert.equal(store.verifyOwnerToken(session), false);
  } finally {
    env.cleanup();
  }
});

test('rotateOwnerToken: the old token fails at once, the new one works, agent tokens and listeners carry on', () => {
  const env = scratch();
  try {
    writeJson(env.configPath, { authToken: LEGACY_TOKEN });
    const store = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    store.bootstrap({ config: readJson(env.configPath), configPath: env.configPath });
    const agentToken = store.mintAgentToken({ kind: 's', subject: 'conv-1' });
    const events = [];
    store.onRotate((event) => events.push(event));

    const { token, rotatedAt } = store.rotateOwnerToken({ reason: 'test', via: ROTATED_VIA.relay });
    assert.ok(token.startsWith(OWNER_TOKEN_PREFIX));
    assert.equal(store.verifyOwnerToken(LEGACY_TOKEN), false, 'the old token is refused at once');
    assert.equal(store.verifyOwnerToken(token), true);
    assert.deepEqual(store.verifyAgentToken(agentToken), { kind: 's', subject: 'conv-1' }, 'agentKey does not rotate');
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'test');
    const secrets = readJson(relaySecretsPath(env.dataDir));
    assert.equal(secrets.owner.hash, hashOwnerToken(token));
    assert.equal(secrets.owner.rotatedAt, rotatedAt);
    assert.equal(secrets.owner.legacyPlaintext, false);
    assert.ok(!JSON.stringify(secrets).includes(token));

    // A process started after the rotation agrees.
    const later = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    later.load();
    assert.equal(later.verifyOwnerToken(token), true);
    assert.equal(later.verifyOwnerToken(LEGACY_TOKEN), false);
  } finally {
    env.cleanup();
  }
});

test('a rotation whose write fails leaves the old token working', () => {
  const env = scratch();
  try {
    writeJson(env.configPath, { authToken: LEGACY_TOKEN });
    let failWrites = false;
    const fsImpl = {
      ...fs,
      writeFileSync(file, ...rest) {
        if (failWrites && String(file).includes('relay-secrets.json')) throw Object.assign(new Error('disk'), { code: 'EIO' });
        return fs.writeFileSync(file, ...rest);
      },
    };
    const store = createOwnerSecretStore({ dataDir: env.dataDir, fsImpl, logger: quiet });
    store.bootstrap({ config: readJson(env.configPath), configPath: env.configPath });
    failWrites = true;
    assert.throws(() => store.rotateOwnerToken({ reason: 'test' }));
    assert.equal(store.verifyOwnerToken(LEGACY_TOKEN), true);
  } finally {
    env.cleanup();
  }
});

test('changed outside OAR: a hand-written owner hash raises the alert; a CLI rotation that records itself does not', () => {
  const env = scratch();
  try {
    writeJson(env.configPath, { authToken: LEGACY_TOKEN });
    const settings = settingsStore();
    const store = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    store.bootstrap({ config: readJson(env.configPath), configPath: env.configPath });
    assert.deepEqual(store.reconcileWithSettings(settings), { alert: null });
    assert.equal(JSON.parse(settings.values.get(OWNER_HASH_SETTING_KEY)).hash, hashOwnerToken(LEGACY_TOKEN));

    // `oar setup --new-token` rotates through the same store, from the CLI.
    const cli = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    cli.load();
    const rotated = cli.rotateOwnerToken({ reason: 'oar setup --new-token', via: ROTATED_VIA.cli });
    assert.equal(cli.recordOwnerHash(settings), true, 'the CLI writes the database copy itself');
    const afterCli = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    afterCli.bootstrap({ config: {}, configPath: env.configPath });
    assert.equal(afterCli.reconcileWithSettings(settings).alert, null);
    assert.equal(afterCli.verifyOwnerToken(rotated.token), true);

    // A process writes its own owner hash into the file.
    const file = relaySecretsPath(env.dataDir);
    const tampered = readJson(file);
    tampered.owner.hash = hashOwnerToken(crypto.randomUUID());
    delete tampered.owner.rotatedVia;
    writeJson(file, tampered);
    const logger = captureLogger();
    const afterTamper = createOwnerSecretStore({ dataDir: env.dataDir, logger });
    afterTamper.bootstrap({ config: {}, configPath: env.configPath });
    const { alert } = afterTamper.reconcileWithSettings(settings);
    assert.equal(alert?.reason, 'file');
    assert.ok(logger.lines.some((line) => /changed outside OAR/.test(line)));
    assert.equal(JSON.parse(settings.values.get(OWNER_ALERT_SETTING_KEY)).reason, 'file', 'kept until acknowledged');

    // The alert stays on the next boot, until it is cleared.
    const nextBoot = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    nextBoot.bootstrap({ config: {}, configPath: env.configPath });
    assert.equal(nextBoot.reconcileWithSettings(settings).alert?.reason, 'file');
    nextBoot.clearAlert(settings);
    assert.equal(nextBoot.ownerTokenAlert(), null);
  } finally {
    env.cleanup();
  }
});

test('an authToken that reappears in config.json becomes the owner token, is moved out again and reported', () => {
  const env = scratch();
  try {
    writeJson(env.configPath, { authToken: LEGACY_TOKEN });
    const settings = settingsStore();
    const first = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    first.bootstrap({ config: readJson(env.configPath), configPath: env.configPath });
    first.reconcileWithSettings(settings);

    const handEdited = crypto.randomUUID();
    writeJson(env.configPath, { ...readJson(env.configPath), authToken: handEdited });
    const second = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    const boot = second.bootstrap({ config: readJson(env.configPath), configPath: env.configPath });
    assert.equal(boot.change, 'config-reappeared');
    assert.equal(second.verifyOwnerToken(handEdited), true);
    assert.equal(second.verifyOwnerToken(LEGACY_TOKEN), false);
    assert.equal(readJson(env.configPath).authToken, undefined);
    assert.equal(second.reconcileWithSettings(settings).alert?.reason, 'config');
  } finally {
    env.cleanup();
  }
});

test('the singleton guard accepts a pre-upgrade lock by the stored hash', () => {
  const env = scratch();
  try {
    writeJson(env.configPath, { authToken: LEGACY_TOKEN });
    const store = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    store.bootstrap({ config: readJson(env.configPath), configPath: env.configPath });
    const lockPath = path.join(env.dataDir, 'relay-server.lock');
    // An older build's lock: the plain token.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999, token: LEGACY_TOKEN, startedAt: 'x' }));
    const guard = createRelaySingletonGuard({ lockPath, pid: 1000, tokenHash: store.ownerTokenHash(), isProcessAlive: () => true });
    assert.throws(() => guard.acquire(), /already running/, 'the same owner hash: the same relay');
    // A lock written with the hash releases for the same pid and hash.
    fs.rmSync(lockPath);
    createRelaySingletonGuard({ lockPath, pid: 5, token: LEGACY_TOKEN, isProcessAlive: () => false }).acquire();
    assert.equal(createRelaySingletonGuard({ lockPath, pid: 5, tokenHash: store.ownerTokenHash(), isProcessAlive: () => false }).release(), true);
  } finally {
    env.cleanup();
  }
});

test('credential prefixes are redacted by shape and recognised for the preview proxy', () => {
  const owner = `${OWNER_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const agent = mintAgentTokenWithKey(crypto.randomBytes(32), { kind: 's', subject: 'conv-1' });
  const proof = `oark1_${crypto.randomBytes(32).toString('base64url')}`;
  const text = `owner=${owner} agent ${agent} key ${proof} done`;
  const redacted = redactRelayCredentials(text);
  assert.ok(!redacted.includes(owner) && !redacted.includes(agent) && !redacted.includes(proof));
  assert.equal(redacted, 'owner=[token] agent [token] key [token] done');
  assert.equal(isRelayCredential(owner), true);
  assert.equal(isRelayCredential(agent), true);
  assert.equal(isRelayCredential(proof), true, 'a browser session\'s proof key too');
  assert.equal(isRelayCredential(LEGACY_TOKEN), false);
});

test('a fresh headless first start prints no token; a terminal sees it once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-headless-'));
  try {
    const store = createOwnerSecretStore({ dataDir: path.join(dir, 'data'), logger: quiet });
    const boot = store.bootstrap({ config: {}, configPath: path.join(dir, 'config.json') });
    assert.ok(boot.generatedToken.startsWith(OWNER_TOKEN_PREFIX));
    // No terminal: stdout goes to a log file agents can read.
    const written = [];
    const logged = [];
    assert.equal(announceGeneratedToken(boot.generatedToken, { isTTY: false, write: (text) => written.push(text), log: (line) => logged.push(line) }), 'withheld');
    assert.deepEqual(written, []);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].includes(boot.generatedToken), false);
    assert.match(logged[0], /oar setup --new-token/);
    // A terminal: shown once.
    const shown = [];
    assert.equal(announceGeneratedToken(boot.generatedToken, { isTTY: true, write: (text) => shown.push(text), log: () => assert.fail('no log line') }), 'shown');
    assert.equal(shown.length, 1);
    assert.ok(shown[0].includes(boot.generatedToken));
    // A start that made no token says nothing.
    assert.equal(announceGeneratedToken('', { isTTY: true, write: () => assert.fail(), log: () => assert.fail() }), 'none');
    // Recovery with no browser session: a new token (oar setup --new-token
    // goes through rotateOwnerToken); the agent key, and with it every agent
    // token, survives it.
    const agentKeyBefore = JSON.parse(fs.readFileSync(relaySecretsPath(path.join(dir, 'data')), 'utf8')).agentKey;
    const rotated = store.rotateOwnerToken({ reason: 'oar setup --new-token', via: ROTATED_VIA.cli });
    assert.notEqual(rotated.token, boot.generatedToken);
    assert.equal(store.verifyOwnerToken(boot.generatedToken), false);
    assert.equal(store.verifyOwnerToken(rotated.token), true);
    assert.equal(JSON.parse(fs.readFileSync(relaySecretsPath(path.join(dir, 'data')), 'utf8')).agentKey, agentKeyBefore);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S6: a rotatedVia "cli" in the file is not believed; only a recorded rotation is', () => {
  const env = scratch();
  try {
    writeJson(env.configPath, { authToken: LEGACY_TOKEN });
    const settings = settingsStore();
    const store = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    store.bootstrap({ config: readJson(env.configPath), configPath: env.configPath });
    store.reconcileWithSettings(settings);

    // A process writes its own hash and says the CLI did it, just now.
    const file = relaySecretsPath(env.dataDir);
    const forged = readJson(file);
    forged.owner = { ...forged.owner, hash: hashOwnerToken(crypto.randomUUID()), rotatedVia: ROTATED_VIA.cli, rotatedAt: new Date(Date.now() + 60_000).toISOString() };
    writeJson(file, forged);
    const next = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet });
    next.bootstrap({ config: {}, configPath: env.configPath });
    assert.equal(next.reconcileWithSettings(settings).alert?.reason, 'file', 'the alarm is raised');
  } finally {
    env.cleanup();
  }
});

test('S6: a relay that stopped between the file and the database copy raises no alarm; an older relay rotation does', () => {
  const env = scratch();
  try {
    writeJson(env.configPath, { authToken: LEGACY_TOKEN });
    const settings = settingsStore();
    let clock = Date.parse('2026-11-01T10:00:00.000Z');
    const now = () => new Date(clock);
    const store = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet, now });
    store.bootstrap({ config: readJson(env.configPath), configPath: env.configPath });
    store.reconcileWithSettings(settings);

    // Rotation by the relay; the copy is never written (a crash, a database
    // that refused the write).
    clock += 60_000;
    const { token } = store.rotateOwnerToken({ reason: 'test', via: ROTATED_VIA.relay });
    const logger = captureLogger();
    clock += 60_000;
    const restarted = createOwnerSecretStore({ dataDir: env.dataDir, logger, now });
    restarted.bootstrap({ config: {}, configPath: env.configPath });
    assert.equal(restarted.reconcileWithSettings(settings).alert, null, 'no false alarm');
    assert.equal(JSON.parse(settings.values.get(OWNER_HASH_SETTING_KEY)).hash, hashOwnerToken(token), 'the copy is brought up to date');
    assert.ok(logger.lines.some((line) => /rotated by this relay after the database last recorded it/.test(line)));

    // A "relay" rotation older than the copy (a database restored from a
    // backup newer than the file, or a forged file) is not one.
    const file = relaySecretsPath(env.dataDir);
    const older = readJson(file);
    older.owner = { ...older.owner, hash: hashOwnerToken(crypto.randomUUID()), rotatedVia: ROTATED_VIA.relay, rotatedAt: '2026-01-01T00:00:00.000Z' };
    writeJson(file, older);
    const third = createOwnerSecretStore({ dataDir: env.dataDir, logger: quiet, now });
    third.bootstrap({ config: {}, configPath: env.configPath });
    assert.equal(third.reconcileWithSettings(settings).alert?.reason, 'file');
  } finally {
    env.cleanup();
  }
});

test('S6: a failed database copy is logged, not swallowed', () => {
  const env = scratch();
  try {
    const logger = captureLogger();
    const store = createOwnerSecretStore({ dataDir: env.dataDir, logger });
    store.bootstrap({ config: {}, configPath: env.configPath });
    assert.equal(store.recordOwnerHash({ writeSetting: () => { throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }); } }), false);
    assert.ok(logger.lines.some((line) => /could not be written \(SQLITE_BUSY\)/.test(line)));
  } finally {
    env.cleanup();
  }
});
