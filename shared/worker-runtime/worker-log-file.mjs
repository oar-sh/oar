// The worker log for launches that cannot redirect the worker's output.
//
// On Linux the launcher redirects a Node worker's stdout/stderr into
// `<log dir>/worker-<session id>.log` (`>> file 2>&1` under tmux, an inherited
// descriptor on the detached path). On Windows the worker runs in its own
// console window behind `cmd /c start`: no descriptor of the launcher reaches
// it, and a shell redirect would empty the window. So the launcher names the
// file in `COPILOT_WEB_RELAY_WORKER_LOG_FILE` and the worker copies what it
// writes to stdout/stderr into it, while the console keeps showing the same
// lines.
//
// Out of reach from inside the process: what Node prints natively (a V8 fatal
// error such as heap exhaustion, a module that fails to load before this is
// installed) and what a child process writes to an inherited console.
import fs from 'fs';

export const WORKER_LOG_FILE_ENV = 'COPILOT_WEB_RELAY_WORKER_LOG_FILE';

// Colours are for the console; the Linux file never has them, because there
// stdout is not a terminal.
const ANSI_STYLE_PATTERN = /\u001b\[[0-9;]*m/g;

/**
 * Copies stdout/stderr into the log file the launcher named. Returns null when
 * no file was named or it cannot be opened: best-effort like the launcher's
 * side, a log problem must never stop a worker.
 */
export function installWorkerLogFile({
  env = process.env,
  processImpl = process,
  fsImpl = fs,
} = {}) {
  const logPath = String(env?.[WORKER_LOG_FILE_ENV] || '').trim();
  // Not inherited: the provider CLI, the agent's shells and anything started
  // from them must not write into this worker's log.
  if (env && WORKER_LOG_FILE_ENV in env) delete env[WORKER_LOG_FILE_ENV];
  if (!logPath) return null;

  let fd = null;
  try {
    fd = fsImpl.openSync(logPath, 'a');
  } catch {
    return null;
  }

  // Synchronous on purpose: the last lines before a process.exit() are the
  // ones an incident needs.
  const append = (chunk, encoding) => {
    if (fd === null) return;
    try {
      if (typeof chunk === 'string') {
        const text = chunk.replace(ANSI_STYLE_PATTERN, '');
        if (text) fsImpl.writeSync(fd, text, null, typeof encoding === 'string' ? encoding : 'utf8');
      } else if (chunk instanceof Uint8Array) {
        fsImpl.writeSync(fd, chunk);
      }
    } catch {
      // A file that stopped taking writes (disk full, handle gone) is given up.
      try { fsImpl.closeSync(fd); } catch {}
      fd = null;
    }
  };

  const restores = [];
  for (const stream of [processImpl.stdout, processImpl.stderr]) {
    if (!stream || typeof stream.write !== 'function') continue;
    const originalWrite = stream.write;
    const teeWrite = function teeWrite(chunk, encoding, callback) {
      append(chunk, encoding);
      return originalWrite.call(this, chunk, encoding, callback);
    };
    stream.write = teeWrite;
    restores.push(() => {
      if (stream.write === teeWrite) stream.write = originalWrite;
    });
  }

  // Without an uncaughtException handler Node prints the error natively, past
  // the streams above. With one (the worker crash guard) the handler logs it.
  const onUncaught = (error, origin) => {
    if (processImpl.listenerCount('uncaughtException') > 0) return;
    append(`${origin || 'uncaughtException'}: ${error?.stack || error?.message || error}\n`);
  };
  processImpl.on?.('uncaughtExceptionMonitor', onUncaught);

  return {
    logPath,
    uninstall() {
      for (const restore of restores) restore();
      processImpl.off?.('uncaughtExceptionMonitor', onUncaught);
      if (fd !== null) {
        try { fsImpl.closeSync(fd); } catch {}
        fd = null;
      }
    },
  };
}
