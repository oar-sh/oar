// A served file is the file as it is on disk now: length, validators and
// bytes from one handle, and headers no cache on the way may ignore. Runs the
// real serveFileWithRangeSupport against temp files with a recording response.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import {
  applyNoStoreHeaders,
  downloadNameOverride,
  fileVersionToken,
  serveFileWithRangeSupport,
  withFileVersion,
} from './file-serving.mjs';

function tempFile(t, name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-file-serving-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, name);
  if (content !== undefined) fs.writeFileSync(filePath, content);
  return filePath;
}

// Node's own rule for a header value: no control characters, nothing outside
// Latin-1. The recording response refuses the same values.
const INVALID_HEADER_CHAR = /[^\t\x20-\x7e\x80-\xff]/;

class RecordingResponse extends Writable {
  constructor({ rejectHeader = null } = {}) {
    super();
    this.headers = {};
    this.statusCode = 200;
    this.chunks = [];
    this.headersSent = false;
    this.jsonBody = null;
    this.rejectHeader = rejectHeader;
    this.done = new Promise((resolve) => this.once('finish', resolve));
  }

  setHeader(name, value) {
    if (INVALID_HEADER_CHAR.test(String(value)) || this.rejectHeader?.(name, value)) {
      throw Object.assign(new TypeError(`Invalid character in header content ["${name}"]`), { code: 'ERR_INVALID_CHAR' });
    }
    this.headers[name.toLowerCase()] = String(value);
  }
  status(code) { this.statusCode = code; return this; }
  json(body) { this.jsonBody = body; this.end(); return this; }
  _write(chunk, _encoding, callback) { this.headersSent = true; this.chunks.push(chunk); callback(); }
  get body() { return Buffer.concat(this.chunks); }
}

async function serve(filePath, { meta, headers = {}, query = {}, options = {}, rejectHeader = null } = {}) {
  const res = new RecordingResponse({ rejectHeader });
  serveFileWithRangeSupport({ headers, query }, res, filePath, meta || { contentType: 'application/pdf' }, options);
  await res.done;
  return res;
}

test('the version token is stable for an unchanged file and changes with size or time', () => {
  const base = { mtimeMs: 1_790_000_000_123.75, size: 4096 };
  assert.equal(fileVersionToken(base), fileVersionToken({ ...base }));
  assert.match(fileVersionToken(base), /^[0-9a-z]+-[0-9a-z]+$/);
  assert.notEqual(fileVersionToken(base), fileVersionToken({ ...base, size: 4097 }));
  assert.notEqual(fileVersionToken(base), fileVersionToken({ ...base, mtimeMs: base.mtimeMs + 1 }));
  // Same size, written a second later: still a new version.
  assert.notEqual(fileVersionToken(base), fileVersionToken({ ...base, mtimeMs: base.mtimeMs + 1000 }));
  assert.equal(fileVersionToken({}), '');
  assert.equal(fileVersionToken({ mtimeMs: NaN, size: 1 }), '');
});

test('withFileVersion appends v= with the right separator and leaves a URL alone without a version', () => {
  assert.equal(withFileVersion('/api/drives/file?path=C%3A%2Fa.pdf', 'abc-1'), '/api/drives/file?path=C%3A%2Fa.pdf&v=abc-1');
  assert.equal(withFileVersion('/api/files/docs/a.pdf', 'abc-1'), '/api/files/docs/a.pdf?v=abc-1');
  assert.equal(withFileVersion('/api/files/docs/a.pdf', ''), '/api/files/docs/a.pdf');
});

test('a download name is taken only as a plain name with the file\'s own extension', () => {
  assert.equal(downloadNameOverride('report (1005-0719).pdf', 'report.pdf'), 'report (1005-0719).pdf');
  assert.equal(downloadNameOverride('REPORT (1005-0719).PDF', 'report.pdf'), 'REPORT (1005-0719).PDF');
  assert.equal(downloadNameOverride('report.html', 'report.pdf'), '', 'another extension is refused');
  assert.equal(downloadNameOverride('report', 'report.pdf'), '');
  assert.equal(downloadNameOverride('../report.pdf', 'report.pdf'), '');
  assert.equal(downloadNameOverride('a\\b.pdf', 'report.pdf'), '');
  assert.equal(downloadNameOverride('a"b.pdf', 'report.pdf'), '');
  assert.equal(downloadNameOverride('a\r\nb.pdf', 'report.pdf'), '');
  assert.equal(downloadNameOverride(`${'x'.repeat(250)}.pdf`, 'report.pdf'), '');
  assert.equal(downloadNameOverride('', 'report.pdf'), '');
  assert.equal(downloadNameOverride('Makefile (1005-0719)', 'Makefile'), 'Makefile (1005-0719)');
});

test('no-store is said to the browser and to the CDN', () => {
  const res = new RecordingResponse();
  applyNoStoreHeaders(res);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['cdn-cache-control'], 'no-store');
  assert.equal(res.headers['cloudflare-cdn-cache-control'], 'no-store');
});

test('a whole file is sent with its length, validators and no-store headers', async (t) => {
  const filePath = tempFile(t, 'letter.pdf', '%PDF-1.4 first version');
  const stat = fs.statSync(filePath);
  const res = await serve(filePath);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), '%PDF-1.4 first version');
  assert.equal(res.headers['content-length'], String(stat.size));
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['cdn-cache-control'], 'no-store');
  assert.equal(res.headers['cloudflare-cdn-cache-control'], 'no-store');
  assert.equal(res.headers.etag, `W/"${fileVersionToken(stat)}"`);
  assert.equal(res.headers['last-modified'], new Date(stat.mtimeMs).toUTCString());
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.match(res.headers['content-disposition'], /filename="letter\.pdf"/);
});

test('content addressed by its bytes may be kept, with ranges and safe headers as for any file', async (t) => {
  const filePath = tempFile(t, 'clip.mp4', '0123456789');
  const immutable = 'private, max-age=31536000, immutable';
  const whole = await serve(filePath, { meta: { contentType: 'video/mp4' }, options: { cacheControl: immutable } });
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.headers['cache-control'], immutable);
  assert.equal(whole.headers['cdn-cache-control'], undefined);
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.equal(whole.headers['content-type'], 'video/mp4');
  assert.match(whole.headers['content-security-policy'], /sandbox/);

  const part = await serve(filePath, { meta: { contentType: 'video/mp4' }, headers: { range: 'bytes=4-6' }, options: { cacheControl: immutable } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.body.toString(), '456');
  assert.equal(part.headers['cache-control'], immutable);
});

test('a file that grew since its metadata was read is sent whole, not cut to the old size', async (t) => {
  // The regression: Content-Length came from a cached stat while the stream
  // read the file as it is now, so the new file arrived cut to the old length.
  const filePath = tempFile(t, 'letter.pdf', 'old');
  const staleMeta = { kind: 'file', size: 3, mtimeMs: 1, contentType: 'application/pdf' };
  fs.writeFileSync(filePath, 'the new and much longer version');
  const res = await serve(filePath, { meta: staleMeta });
  assert.equal(res.body.toString(), 'the new and much longer version');
  assert.equal(res.headers['content-length'], String(Buffer.byteLength('the new and much longer version')));
  assert.equal(res.headers.etag, `W/"${fileVersionToken(fs.statSync(filePath))}"`);
});

test('a file that shrank since its metadata was read announces its real, smaller length', async (t) => {
  const filePath = tempFile(t, 'letter.pdf', 'a long first version of the file');
  const staleMeta = { kind: 'file', size: 32, mtimeMs: 1, contentType: 'application/pdf' };
  fs.writeFileSync(filePath, 'short');
  const res = await serve(filePath, { meta: staleMeta });
  assert.equal(res.body.toString(), 'short');
  assert.equal(res.headers['content-length'], '5');
});

test('a range is checked against the file as it is now', async (t) => {
  const filePath = tempFile(t, 'clip.bin', '0123456789');
  const staleMeta = { kind: 'file', size: 4, mtimeMs: 1, contentType: 'application/octet-stream' };

  // Past the stale size, inside the real one: served.
  const inside = await serve(filePath, { meta: staleMeta, headers: { range: 'bytes=6-9' } });
  assert.equal(inside.statusCode, 206);
  assert.equal(inside.body.toString(), '6789');
  assert.equal(inside.headers['content-range'], 'bytes 6-9/10');
  assert.equal(inside.headers['content-length'], '4');
  assert.equal(inside.headers['cache-control'], 'no-store');

  const openEnded = await serve(filePath, { meta: staleMeta, headers: { range: 'bytes=8-' } });
  assert.equal(openEnded.body.toString(), '89');
  assert.equal(openEnded.headers['content-range'], 'bytes 8-9/10');

  const outside = await serve(filePath, { meta: staleMeta, headers: { range: 'bytes=10-12' } });
  assert.equal(outside.statusCode, 416);
  assert.equal(outside.headers['content-range'], 'bytes */10');
  assert.equal(outside.body.length, 0);

  const malformed = await serve(filePath, { meta: staleMeta, headers: { range: 'lines=1-2' } });
  assert.equal(malformed.statusCode, 416);
});

test('an empty file is answered with length 0', async (t) => {
  const filePath = tempFile(t, 'empty.txt', '');
  const res = await serve(filePath, { meta: { contentType: 'text/plain' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-length'], '0');
  assert.equal(res.body.length, 0);
});

test('a file that is gone is a 404, and the stale metadata is dropped', async (t) => {
  const filePath = tempFile(t, 'gone.pdf');
  const dropped = [];
  const res = await serve(filePath, {
    meta: { kind: 'file', size: 10, contentType: 'application/pdf' },
    options: { cacheDelete: (p) => dropped.push(p) },
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.jsonBody, { error: 'File not found' });
  assert.deepEqual(dropped, [filePath]);
});

test('a folder under the file\'s path is a 404, not a hang', async (t) => {
  const filePath = tempFile(t, 'now-a-folder');
  fs.mkdirSync(filePath);
  const res = await serve(filePath, { meta: { kind: 'file', size: 10, contentType: 'text/plain' } });
  assert.equal(res.statusCode, 404);
});

test('as= names the download when it keeps the extension, and is ignored otherwise', async (t) => {
  const filePath = tempFile(t, 'letter.pdf', '%PDF-1.4');
  const stamped = await serve(filePath, { query: { as: 'letter (1005-0719).pdf' } });
  assert.match(stamped.headers['content-disposition'], /filename="letter \(1005-0719\)\.pdf"/);
  const refused = await serve(filePath, { query: { as: 'letter.html' } });
  assert.match(refused.headers['content-disposition'], /filename="letter\.pdf"/);
});

function handleTrackingFs() {
  const open = new Set();
  const fsImpl = {
    ...fs,
    openSync: (...args) => { const fd = fs.openSync(...args); open.add(fd); return fd; },
    closeSync: (fd) => { open.delete(fd); return fs.closeSync(fd); },
    createReadStream: (target, options) => {
      const stream = fs.createReadStream(target, options);
      stream.once('close', () => open.delete(options.fd));
      return stream;
    },
  };
  // The read stream closes its handle a tick or more after the response ends.
  const settled = async () => {
    for (let waited = 0; open.size && waited < 2000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return open.size;
  };
  return { fsImpl, open, settled };
}

test('every handle is closed again, whatever the answer', async (t) => {
  const filePath = tempFile(t, 'clip.bin', '0123456789');
  const { fsImpl, settled } = handleTrackingFs();
  await serve(filePath, { options: { fsImpl } });
  await serve(filePath, { headers: { range: 'bytes=2-5' }, options: { fsImpl } });
  await serve(filePath, { headers: { range: 'bytes=50-60' }, options: { fsImpl } });
  assert.equal(await settled(), 0);
});

test('a file whose name has characters outside Latin-1 is served, with its name intact', async (t) => {
  // The regression: `filename="レポート.pdf"` made setHeader throw, so the file
  // could not be served at all, and the handle opened just before leaked.
  const filePath = tempFile(t, 'レポート.pdf', '%PDF-1.4 report');
  const { fsImpl, settled } = handleTrackingFs();
  const res = await serve(filePath, { options: { fsImpl } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), '%PDF-1.4 report');
  assert.equal(
    res.headers['content-disposition'],
    `inline; filename="file.pdf"; filename*=UTF-8''%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88.pdf`,
  );
  assert.equal(await settled(), 0);

  // The same through `as=`, the user-controlled download name.
  const asked = await serve(filePath, { query: { as: 'レポート (1005-0719).pdf' }, options: { fsImpl } });
  assert.equal(asked.statusCode, 200);
  assert.equal(
    asked.headers['content-disposition'],
    `inline; filename="(1005-0719).pdf"; filename*=UTF-8''%E3%83%AC%E3%83%9D%E3%83%BC%E3%83%88%20%281005-0719%29.pdf`,
  );
  assert.equal(await settled(), 0);

  // And a name the given `safeName` carries, as the upload routes pass it.
  const emoji = await serve(filePath, { meta: { contentType: 'text/plain' }, options: { fsImpl, safeName: 'demo 🎉.txt' } });
  assert.equal(emoji.statusCode, 200);
  assert.equal(emoji.headers['content-disposition'], `attachment; filename="demo.txt"; filename*=UTF-8''demo%20%F0%9F%8E%89.txt`);
  assert.equal(await settled(), 0);
});

test('a header the response refuses closes the handle and answers 500', async (t) => {
  const filePath = tempFile(t, 'clip.bin', '0123456789');
  const { fsImpl, open, settled } = handleTrackingFs();
  const res = await serve(filePath, {
    options: { fsImpl },
    rejectHeader: (name) => name.toLowerCase() === 'content-disposition',
  });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.jsonBody, { error: 'Failed to read file' });
  assert.equal(res.body.length, 0);
  assert.equal(await settled(), 0, `handles still open: ${[...open]}`);
});
