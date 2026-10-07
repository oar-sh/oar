import test from 'node:test';
import assert from 'node:assert/strict';

import { appendUrlParam, buildDownloadLink, stampedDownloadName, versionedFileHref } from './file-version.mjs';

// 5 October 2026, 07:19 local time, whatever zone the test runs in.
const MTIME = new Date(2026, 9, 5, 7, 19, 30).getTime();

test('a parameter is appended with the separator the URL needs', () => {
  assert.equal(appendUrlParam('/api/files/a.pdf', 'v', 'x-1'), '/api/files/a.pdf?v=x-1');
  assert.equal(appendUrlParam('/api/drives/file?path=C%3A%2Fa.pdf', 'v', 'x-1'), '/api/drives/file?path=C%3A%2Fa.pdf&v=x-1');
  assert.equal(appendUrlParam('/api/files/a.pdf', 'as', 'a (1005-0719).pdf'), '/api/files/a.pdf?as=a%20(1005-0719).pdf');
  assert.equal(appendUrlParam('/api/files/a.pdf', 'v', ''), '/api/files/a.pdf');
  assert.equal(appendUrlParam('', 'v', 'x'), '');
});

test('a file href gets its version once', () => {
  assert.equal(versionedFileHref('/api/drives/file?path=C%3A%2Fa.pdf', 'm1-s1'), '/api/drives/file?path=C%3A%2Fa.pdf&v=m1-s1');
  assert.equal(versionedFileHref('/api/drives/file?path=C%3A%2Fa.pdf&v=m1-s1', 'm2-s2'), '/api/drives/file?path=C%3A%2Fa.pdf&v=m1-s1');
  assert.equal(versionedFileHref('/api/drives/file?path=C%3A%2Fa.pdf', undefined), '/api/drives/file?path=C%3A%2Fa.pdf');
});

test('a changed file has another address', () => {
  const href = '/api/drives/file?path=C%3A%2Fdocs%2Fletter.pdf';
  assert.notEqual(versionedFileHref(href, 'm1-s1'), versionedFileHref(href, 'm2-s1'));
});

test('the saved name carries the time the file was last changed', () => {
  assert.equal(stampedDownloadName('letter.pdf', MTIME), 'letter (1005-0719).pdf');
  assert.equal(stampedDownloadName('archive.tar.gz', MTIME), 'archive.tar (1005-0719).gz');
  assert.equal(stampedDownloadName('Makefile', MTIME), 'Makefile (1005-0719)');
  assert.equal(stampedDownloadName('.env', MTIME), '.env (1005-0719)');
  assert.equal(stampedDownloadName('letter.pdf', MTIME + 60_000), 'letter (1005-0720).pdf');
  assert.equal(stampedDownloadName('letter.pdf', null), 'letter.pdf');
  assert.equal(stampedDownloadName('letter.pdf', 0), 'letter.pdf');
  assert.equal(stampedDownloadName('', MTIME), '');
});

test('the download link has the versioned address and asks the relay for the stamped name', () => {
  const link = buildDownloadLink({
    href: '/api/drives/file?path=C%3A%2Fdocs%2Fletter.pdf', name: 'letter.pdf', version: 'm1-s1', mtimeMs: MTIME,
  });
  assert.equal(link.downloadName, 'letter (1005-0719).pdf');
  assert.equal(link.href, '/api/drives/file?path=C%3A%2Fdocs%2Fletter.pdf&v=m1-s1&as=letter%20(1005-0719).pdf');

  // Nothing known about the file (an older relay's preview): today's link.
  const plain = buildDownloadLink({ href: '/api/files/docs/letter.pdf', name: 'letter.pdf' });
  assert.deepEqual(plain, { href: '/api/files/docs/letter.pdf', downloadName: 'letter.pdf' });
});
