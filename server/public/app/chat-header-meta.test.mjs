import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_META_LONG_CLASS, CHAT_META_SHORT_CLASS, chatMetaLabelHtml, cwdFolderName } from './chat-header-meta.mjs';

test('a meta label carries a long and a short span, in that order', () => {
  assert.equal(
    chatMetaLabelHtml('via agent · “docs pass”', '↗ docs pass'),
    `<span class="${CHAT_META_LONG_CLASS}">via agent · “docs pass”</span><span class="${CHAT_META_SHORT_CLASS}">↗ docs pass</span>`,
  );
});

test('the folder chip is the last folder name of a path', () => {
  // platform-agnostic: display strings only, never resolved as paths.
  assert.equal(cwdFolderName('/home/dev/sample-repo'), 'sample-repo');
  assert.equal(cwdFolderName('/home/dev/sample-repo/'), 'sample-repo');
  assert.equal(cwdFolderName('  /home/dev/sample-repo  '), 'sample-repo');
  assert.equal(cwdFolderName('C:\\Users\\dev\\api'), 'api');
  assert.equal(cwdFolderName('C:\\Users\\dev\\api\\'), 'api');
  assert.equal(cwdFolderName('\\\\fileserver\\share\\proj'), 'proj');
  assert.equal(cwdFolderName('~/work'), 'work');
  assert.equal(cwdFolderName('sample-repo'), 'sample-repo');
});

test('a root stays whole, and nothing gives nothing', () => {
  assert.equal(cwdFolderName('/'), '/');
  assert.equal(cwdFolderName('C:\\'), 'C:\\');
  assert.equal(cwdFolderName('C:/'), 'C:/');
  assert.equal(cwdFolderName(''), '');
  assert.equal(cwdFolderName(null), '');
  assert.equal(cwdFolderName(undefined), '');
});
