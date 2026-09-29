'use strict';

// The relay's console, kept in a file.
//
// The relay writes what it does to its console: a terminal, a tmux pane, a
// service manager's journal or nothing at all, depending on how it was
// started. After an incident or a restart that output is what one wants to
// read, so the runtime copies it into `<log dir>/relay-console.log`, with a
// time stamp per line and a size limit.
//
// The copy is taken from the console's methods rather than from stdout: the
// terminal console (tty-console) redraws its prompt on stdout, and none of
// that belongs in a log.

import fs from 'fs';
import path from 'path';
import { format } from 'util';

export const RELAY_CONSOLE_LOG_FILE = 'relay-console.log';
export const RELAY_CONSOLE_LOG_DISABLE_ENV = 'OAR_NO_CONSOLE_LOG';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 3;
const LEVELS = Object.freeze(['log', 'info', 'warn', 'error', 'debug']);
const ANSI_STYLE_PATTERN = /\u001b\[[0-9;]*m/g;
// A token in a URL, whatever its value: the page is opened with `?token=`.
const TOKEN_PARAM_PATTERN = /([?&]token=)[^&\s"'<>]+/gi;
const SECRET_MIN_LENGTH = 6;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Where the console log goes: the log directory the environment names, else
 * `logs` under a data directory the environment names (a relay with its own
 * data keeps its own log), else `logs` next to the server.
 */
export function resolveRelayConsoleLogPath({ env = process.env, serverDir, pathImpl = path } = {}) {
  const logDir = String(env?.COPILOT_WEB_RELAY_LOG_DIR || '').trim();
  const dataDir = String(env?.COPILOT_WEB_RELAY_DATA_DIR || '').trim();
  const dir = logDir
    || (dataDir ? pathImpl.join(dataDir, 'logs') : pathImpl.join(String(serverDir || process.cwd()), 'logs'));
  return pathImpl.join(pathImpl.resolve(dir), RELAY_CONSOLE_LOG_FILE);
}

/**
 * Copies what the relay writes to its console into `logPath`. Returns null
 * when it is switched off or the file cannot be opened: a log problem must
 * never stop the relay.
 *
 * `{ logPath, setSecrets(values), rewrap(), write(level, text), uninstall() }`:
 * `setSecrets` names values that are never written (the auth token, once the
 * config is read), or a function that returns them, asked at every write so
 * a token that changes is covered; `rewrap` puts the copy in front again
 * after something else replaced the console's methods.
 */
export function installRelayConsoleLog({
  logPath,
  env = process.env,
  consoleImpl = console,
  processImpl = process,
  fsImpl = fs,
  now = () => new Date(),
  maxBytes = DEFAULT_MAX_BYTES,
  keep = DEFAULT_KEEP,
} = {}) {
  if (String(env?.[RELAY_CONSOLE_LOG_DISABLE_ENV] || '').trim() === '1') return null;
  const target = String(logPath || '').trim();
  if (!target) return null;

  let fd = null;
  let size = 0;
  let secretSource = () => [];
  let secretKey = '';
  let secretPattern = null;

  function open() {
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fd = fsImpl.openSync(target, 'a');
    try {
      size = Number(fsImpl.fstatSync(fd).size) || 0;
    } catch {
      size = 0;
    }
  }

  function close() {
    if (fd === null) return;
    try { fsImpl.closeSync(fd); } catch {}
    fd = null;
  }

  // relay-console.log → .1 → .2 …; the oldest of `keep` is dropped.
  function rotate() {
    close();
    try {
      for (let index = keep; index >= 1; index -= 1) {
        const from = index === 1 ? target : `${target}.${index - 1}`;
        const to = `${target}.${index}`;
        if (!fsImpl.existsSync(from)) continue;
        try { fsImpl.rmSync(to, { force: true }); } catch {}
        fsImpl.renameSync(from, to);
      }
    } catch {
      // A file that cannot be moved (held open elsewhere) is written on.
    }
    open();
  }

  function currentSecretPattern() {
    let values = [];
    try {
      values = secretSource() || [];
    } catch {}
    const secrets = (Array.isArray(values) ? values : [values])
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length >= SECRET_MIN_LENGTH);
    const key = secrets.join('\n');
    if (key !== secretKey) {
      secretKey = key;
      secretPattern = secrets.length ? new RegExp(secrets.map(escapeRegExp).join('|'), 'g') : null;
    }
    return secretPattern;
  }

  function scrub(text) {
    const out = String(text).replace(ANSI_STYLE_PATTERN, '').replace(TOKEN_PARAM_PATTERN, '$1[token]');
    const secrets = currentSecretPattern();
    return secrets ? out.replace(secrets, '[token]') : out;
  }

  // Synchronous on purpose: the last lines before an exit are the ones an
  // incident needs.
  function write(level, text) {
    if (fd === null) return;
    try {
      const stamp = now().toISOString();
      const tag = level === 'log' ? '' : `${String(level).toUpperCase()} `;
      const lines = scrub(text).split(/\r?\n/).map((line) => `${stamp} ${tag}${line}\n`).join('');
      if (size > 0 && size + Buffer.byteLength(lines) > maxBytes) rotate();
      if (fd === null) return;
      size += fsImpl.writeSync(fd, lines);
    } catch {
      // A file that stopped taking writes (disk full, handle gone) is given up.
      close();
    }
  }

  try {
    open();
    if (size > maxBytes) rotate();
  } catch {
    close();
    return null;
  }

  const wrapped = new Map();
  function wrap() {
    for (const level of LEVELS) {
      const current = consoleImpl[level];
      if (typeof current !== 'function' || current.relayConsoleLog === true) continue;
      const copy = function relayConsoleCopy(...args) {
        try {
          write(level, format(...args));
        } catch {}
        return current.apply(this, args);
      };
      copy.relayConsoleLog = true;
      copy.inner = current;
      consoleImpl[level] = copy;
      wrapped.set(level, copy);
    }
  }
  wrap();

  // Without a handler Node prints an uncaught error natively, past the console.
  const onUncaught = (error, origin) => {
    write('error', `${origin || 'uncaughtException'}: ${error?.stack || error?.message || error}`);
  };
  processImpl.on?.('uncaughtExceptionMonitor', onUncaught);

  return {
    logPath: target,
    write,
    rewrap: wrap,
    setSecrets(values = []) {
      secretSource = typeof values === 'function' ? values : () => values;
    },
    uninstall() {
      for (const [level, copy] of wrapped) {
        if (consoleImpl[level] === copy) consoleImpl[level] = copy.inner;
      }
      wrapped.clear();
      processImpl.off?.('uncaughtExceptionMonitor', onUncaught);
      close();
    },
  };
}
