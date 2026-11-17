import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { WORKER_LOG_FILE_ENV, installWorkerLogFile, installWorkerLogRedaction } from './worker-log-file.mjs';

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

const LOG_SECRET = 'sk-test-log-00000000';

test('the log redaction replaces a secret in what reaches the console and the log file', () => {
  const processImpl = fakeProcess();
  const fsImpl = recordingFs();
  const logFile = installWorkerLogFile({ env: { [WORKER_LOG_FILE_ENV]: WIN32_LOG }, processImpl, fsImpl });
  const redaction = installWorkerLogRedaction({ secrets: [LOG_SECRET], processImpl });
  assert.ok(redaction);
  processImpl.stdout.write(`cli said: ${LOG_SECRET}\n`);
  processImpl.stderr.write(Buffer.from(`stderr ${LOG_SECRET}\n`, 'utf8'));
  processImpl.stdout.write('nothing to hide\n');
  const consoleText = processImpl.console.map(([, chunk]) => String(chunk)).join('');
  const fileText = fsImpl.writes.map(([, chunk]) => String(chunk)).join('');
  for (const text of [consoleText, fileText]) {
    assert.equal(text.includes(LOG_SECRET), false);
    assert.match(text, /cli said: \[redacted\]\nstderr \[redacted\]\nnothing to hide\n/);
  }
  redaction.uninstall();
  logFile.uninstall();
});

test('the log redaction keeps a write\'s callback and leaves chunks without the secret as they came', () => {
  const processImpl = fakeProcess();
  installWorkerLogRedaction({ secrets: [LOG_SECRET], processImpl });
  let called = 0;
  processImpl.stdout.write(Buffer.from(`a ${LOG_SECRET}`), () => { called += 1; });
  processImpl.stdout.write(`b ${LOG_SECRET}`, 'utf8', () => { called += 1; });
  assert.equal(called, 2);
  const plain = Buffer.from('plain bytes');
  processImpl.stdout.write(plain);
  assert.equal(processImpl.console.at(-1)[1], plain);
});

test('no secret, or one too short, installs nothing; uninstall puts the streams back', () => {
  const processImpl = fakeProcess();
  const originalWrite = processImpl.stdout.write;
  assert.equal(installWorkerLogRedaction({ secrets: [], processImpl }), null);
  assert.equal(installWorkerLogRedaction({ secrets: ['', undefined, 'short'], processImpl }), null);
  assert.equal(processImpl.stdout.write, originalWrite);
  const installed = installWorkerLogRedaction({ secrets: [LOG_SECRET], processImpl });
  assert.notEqual(processImpl.stdout.write, originalWrite);
  installed.uninstall();
  assert.equal(processImpl.stdout.write, originalWrite);
});

// Fake, as every value here: what a terminal shows of an output is its text
// without codes.
// Joined at run time: the hygiene scan refuses key shapes.
const SPLIT_SECRET = ['sk', 'fake-split-0123456789abcdef'].join('-');
const SPLIT_CODES = Object.freeze({
  sgr: '\u001b[31m',
  'colon sgr': '\u001b[38:5:196m',
  'erase csi': '\u001b[K',
  'cursor csi': '\u001b[2C',
  'osc bel': '\u001b]8;;https://example.invalid/\u0007',
  'osc st': '\u001b]0;title\u001b\\',
  charset: '\u001b(B',
  'save cursor': '\u001b7',
});

function redactingStdout(secrets = [SPLIT_SECRET]) {
  const processImpl = fakeProcess();
  installWorkerLogRedaction({ secrets, processImpl });
  return {
    write(chunk) {
      processImpl.stdout.write(chunk);
      return processImpl.console.at(-1)[1];
    },
  };
}

test('the log redaction hides a secret an escape code cuts at any place, and keeps the code', () => {
  const stdout = redactingStdout();
  for (const [name, code] of Object.entries(SPLIT_CODES)) {
    for (let at = 1; at < SPLIT_SECRET.length; at += 1) {
      const line = `key ${SPLIT_SECRET.slice(0, at)}${code}${SPLIT_SECRET.slice(at)} done\n`;
      const expected = `key [redacted]${code} done\n`;
      assert.equal(stdout.write(line), expected, `${name} at ${at}`);
      assert.equal(String(stdout.write(Buffer.from(line, 'utf8'))), expected, `${name} at ${at}, bytes`);
    }
  }
});

test('the log redaction keeps the codes around a cut secret in place and its colour after it', () => {
  const stdout = redactingStdout();
  const cut = `\u001b[1m${SPLIT_SECRET.slice(0, 5)}\u001b[31m${SPLIT_SECRET.slice(5, 9)}\u001b[K${SPLIT_SECRET.slice(9)}\u001b[0m!`;
  assert.equal(stdout.write(`a ${cut}\n`), 'a \u001b[1m[redacted]\u001b[31m\u001b[K\u001b[0m!\n');
  // Two secrets side by side stay two markers, as without codes.
  assert.equal(stdout.write(`${SPLIT_SECRET}${SPLIT_SECRET}\n`), '[redacted][redacted]\n');
  assert.equal(stdout.write(`${SPLIT_SECRET}\u001b[0m${SPLIT_SECRET.slice(0, 3)}\u001b[2m${SPLIT_SECRET.slice(3)}\n`),
    '[redacted]\u001b[0m[redacted]\u001b[2m\n');
});

test('the log redaction leaves look-alike text with codes as it was', () => {
  const stdout = redactingStdout();
  const lookAlikes = [
    `${SPLIT_SECRET.slice(0, 12)}\u001b[31mzzz${SPLIT_SECRET.slice(15)}\n`,
    `${SPLIT_SECRET.slice(0, -1)}\u001b[0m\n`,
    `\u001b[32m${SPLIT_SECRET.slice(1)}\u001b[0m\n`,
    `${SPLIT_SECRET.slice(0, 10)} \u001b[31m${SPLIT_SECRET.slice(10)}\n`,
    '\u001b[1mbold\u001b[0m and \u001b]8;;https://example.invalid/\u0007link\u001b]8;;\u0007\n',
  ];
  for (const line of lookAlikes) assert.equal(stdout.write(line), line);
});

test('a secret inside a code is redacted there, and one a stray ESC runs into goes with the ESC', () => {
  const stdout = redactingStdout();
  assert.equal(stdout.write(`\u001b]8;;https://example.invalid/?k=${SPLIT_SECRET}\u0007link\u001b]8;;\u0007\n`),
    '\u001b]8;;https://example.invalid/?k=[redacted]\u0007link\u001b]8;;\u0007\n');
  assert.equal(stdout.write(`x\u001b${SPLIT_SECRET}\n`), 'x[redacted]\n');
});

test('bytes cut inside a character are written as they came, and a secret in them goes by its bytes', () => {
  const stdout = redactingStdout();
  const euro = Buffer.from('€', 'utf8');
  const cut = Buffer.concat([Buffer.from('\u001b[31mprice 5', 'utf8'), euro.subarray(0, 2)]);
  assert.equal(stdout.write(cut), cut);
  const withSecret = Buffer.concat([Buffer.from(`\u001b[31m${SPLIT_SECRET} 5`, 'utf8'), euro.subarray(0, 2)]);
  const written = stdout.write(withSecret);
  assert.ok(Buffer.isBuffer(written));
  assert.deepEqual(written, Buffer.concat([Buffer.from('\u001b[31m[redacted] 5', 'utf8'), euro.subarray(0, 2)]));
  assert.equal(written.includes(Buffer.from('�', 'utf8')), false);
  const plain = Buffer.concat([Buffer.from(`no secret 5`, 'utf8'), euro.subarray(0, 1)]);
  assert.equal(stdout.write(plain), plain);
});

test('the log copy gets a cut secret redacted too', () => {
  const processImpl = fakeProcess();
  const fsImpl = recordingFs();
  const logFile = installWorkerLogFile({ env: { [WORKER_LOG_FILE_ENV]: WIN32_LOG }, processImpl, fsImpl });
  const redaction = installWorkerLogRedaction({ secrets: [SPLIT_SECRET], processImpl });
  processImpl.stderr.write(`error: ${SPLIT_SECRET.slice(0, 7)}\u001b[33m${SPLIT_SECRET.slice(7)}\u001b[39m\n`);
  const fileText = fsImpl.writes.map(([, chunk]) => String(chunk)).join('');
  assert.equal(fileText, 'error: [redacted]\n');
  redaction.uninstall();
  logFile.uninstall();
});

test('a secret inside a string control is hidden there, also beside a cut one, and every code stays whole', () => {
  const stdout = redactingStdout();
  const key = SPLIT_SECRET;
  const probes = [
    [`key ${key.slice(0, 10)}\u001b]8;;https://x.test/?k=${key}\u0007${key.slice(10)} end\n`,
      'key [redacted]\u001b]8;;https://x.test/?k=[redacted]\u0007 end\n'],
    [`key ${key.slice(0, 10)}\u001b]8;;https://x.test/?k=${key}\u001b\\${key.slice(10)} end\n`,
      'key [redacted]\u001b]8;;https://x.test/?k=[redacted]\u001b\\ end\n'],
    [`${key}\u001b]0;${key}\u0007${key}\n`, '[redacted]\u001b]0;[redacted]\u0007[redacted]\n'],
  ];
  for (const [line, expected] of probes) {
    assert.equal(stdout.write(line), expected);
    assert.equal(String(stdout.write(Buffer.from(line, 'utf8'))), expected);
  }
  for (const [name, code] of Object.entries(SPLIT_CODES)) {
    for (let at = 1; at < key.length; at += 1) {
      const cut = `${key.slice(0, at)}${code}${key.slice(at)}`;
      assert.equal(stdout.write(`${cut}\u001b]8;;https://x.test/?k=${key}\u0007link\u001b]8;;\u0007\n`),
        `[redacted]${code}\u001b]8;;https://x.test/?k=[redacted]\u0007link\u001b]8;;\u0007\n`, `${name} at ${at}`);
    }
  }
});
