import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { WORKER_LOG_FILE_ENV, installWorkerLogFile } from './worker-log-file.mjs';

const WIN32_LOG = path.win32.join('C:\\work\\demo', 'logs', 'worker-abc-123.log');

function fakeProcess() {
  const processImpl = new EventEmitter();
  processImpl.console = [];
  for (const name of ['stdout', 'stderr']) {
    processImpl[name] = {
      write(chunk, encoding, callback) {
        processImpl.console.push([name, chunk]);
        if (typeof callback === 'function') callback();
        return true;
      },
    };
  }
  return processImpl;
}

function recordingFs({ failOpen = false, failWrite = false } = {}) {
  const fsImpl = {
    opens: [],
    writes: [],
    closes: [],
    openSync(filePath, flags) {
      fsImpl.opens.push([filePath, flags]);
      if (failOpen) throw new Error('access denied');
      return 7;
    },
    writeSync(fd, chunk) {
      if (failWrite) throw new Error('disk full');
      fsImpl.writes.push([fd, chunk]);
    },
    closeSync(fd) { fsImpl.closes.push(fd); },
  };
  return fsImpl;
}

test('without a named log file the worker streams are left alone', () => {
  const processImpl = fakeProcess();
  const originalWrite = processImpl.stdout.write;
  const fsImpl = recordingFs();
  assert.equal(installWorkerLogFile({ env: {}, processImpl, fsImpl }), null);
  assert.equal(processImpl.stdout.write, originalWrite);
  assert.equal(fsImpl.opens.length, 0);
  assert.equal(processImpl.listenerCount('uncaughtExceptionMonitor'), 0);
});

test('stdout and stderr reach the console and the appended log file, in order', () => {
  const processImpl = fakeProcess();
  const fsImpl = recordingFs();
  const env = { [WORKER_LOG_FILE_ENV]: WIN32_LOG };
  const installed = installWorkerLogFile({ env, processImpl, fsImpl });

  assert.equal(installed.logPath, WIN32_LOG);
  assert.deepEqual(fsImpl.opens, [[WIN32_LOG, 'a']]);
  let flushed = false;
  assert.equal(processImpl.stdout.write('[demo-worker] starting\n', 'utf8', () => { flushed = true; }), true);
  processImpl.stderr.write('demo-worker fatal: boom\n');
  processImpl.stdout.write(Buffer.from('raw bytes\n'));

  assert.equal(flushed, true, 'the console write keeps its callback');
  assert.deepEqual(processImpl.console.map(([name]) => name), ['stdout', 'stderr', 'stdout']);
  assert.deepEqual(fsImpl.writes.map(([, chunk]) => String(chunk)), [
    '[demo-worker] starting\n',
    'demo-worker fatal: boom\n',
    'raw bytes\n',
  ]);
});

test('the log file variable is not passed on to child processes', () => {
  const env = { [WORKER_LOG_FILE_ENV]: WIN32_LOG, PATH: 'C:/work/bin' };
  installWorkerLogFile({ env, processImpl: fakeProcess(), fsImpl: recordingFs() });
  assert.deepEqual(env, { PATH: 'C:/work/bin' });
});

test('console colours stay out of the file', () => {
  const processImpl = fakeProcess();
  const fsImpl = recordingFs();
  installWorkerLogFile({ env: { [WORKER_LOG_FILE_ENV]: WIN32_LOG }, processImpl, fsImpl });
  processImpl.stdout.write('{ ok: \u001b[33mtrue\u001b[39m }\n');
  assert.equal(processImpl.console[0][1], '{ ok: \u001b[33mtrue\u001b[39m }\n');
  assert.equal(fsImpl.writes[0][1], '{ ok: true }\n');
});

test('a log file that cannot be opened leaves the worker untouched', () => {
  const processImpl = fakeProcess();
  const originalWrite = processImpl.stderr.write;
  const installed = installWorkerLogFile({
    env: { [WORKER_LOG_FILE_ENV]: WIN32_LOG },
    processImpl,
    fsImpl: recordingFs({ failOpen: true }),
  });
  assert.equal(installed, null);
  assert.equal(processImpl.stderr.write, originalWrite);
});

test('a failing log write is given up and never reaches the worker', () => {
  const processImpl = fakeProcess();
  const fsImpl = recordingFs({ failWrite: true });
  installWorkerLogFile({ env: { [WORKER_LOG_FILE_ENV]: WIN32_LOG }, processImpl, fsImpl });
  assert.equal(processImpl.stdout.write('first\n'), true);
  assert.equal(processImpl.stdout.write('second\n'), true);
  assert.deepEqual(processImpl.console.map(([, chunk]) => chunk), ['first\n', 'second\n']);
  assert.deepEqual(fsImpl.closes, [7], 'closed once, then left alone');
});

test('an uncaught error is logged only while no handler would log it', () => {
  const processImpl = fakeProcess();
  const fsImpl = recordingFs();
  installWorkerLogFile({ env: { [WORKER_LOG_FILE_ENV]: WIN32_LOG }, processImpl, fsImpl });

  const early = new Error('early failure');
  processImpl.emit('uncaughtExceptionMonitor', early, 'uncaughtException');
  assert.equal(fsImpl.writes.length, 1);
  assert.match(fsImpl.writes[0][1], /^uncaughtException: Error: early failure\n/);

  // The worker crash guard is installed: it prints the error through stderr.
  processImpl.on('uncaughtException', () => {});
  processImpl.emit('uncaughtExceptionMonitor', new Error('late failure'), 'uncaughtException');
  assert.equal(fsImpl.writes.length, 1);
});

test('uninstall restores the streams and closes the file', () => {
  const processImpl = fakeProcess();
  const originalWrite = processImpl.stdout.write;
  const fsImpl = recordingFs();
  const installed = installWorkerLogFile({ env: { [WORKER_LOG_FILE_ENV]: WIN32_LOG }, processImpl, fsImpl });
  installed.uninstall();
  assert.equal(processImpl.stdout.write, originalWrite);
  assert.equal(processImpl.listenerCount('uncaughtExceptionMonitor'), 0);
  assert.deepEqual(fsImpl.closes, [7]);
  processImpl.stdout.write('after\n');
  assert.equal(fsImpl.writes.length, 0);
});

test('a restarted worker appends to the file the previous one left', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-worker-log-'));
  const logPath = path.join(dir, 'worker-abc-123.log');
  try {
    for (const run of ['first', 'second']) {
      const processImpl = fakeProcess();
      const installed = installWorkerLogFile({ env: { [WORKER_LOG_FILE_ENV]: logPath }, processImpl });
      processImpl.stdout.write(`[demo-worker] ${run} run\n`);
      processImpl.stderr.write(Buffer.from(`${run} warning\n`));
      installed.uninstall();
    }
    assert.equal(
      fs.readFileSync(logPath, 'utf8'),
      '[demo-worker] first run\nfirst warning\n[demo-worker] second run\nsecond warning\n',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
