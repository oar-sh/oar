import assert from 'node:assert/strict';
import test from 'node:test';

import { markdownHeadingId, resolveFilePreviewLink } from './file-preview-navigation.mjs';

test('resolves Markdown file links relative to the current preview path', () => {
  assert.deepEqual(
    resolveFilePreviewLink('DEVELOPING.md', 'README.md'),
    { kind: 'file', path: 'DEVELOPING.md', fragment: '' },
  );
  assert.deepEqual(
    resolveFilePreviewLink('../guide.md#Quick start', 'docs/setup/install.md'),
    { kind: 'file', path: 'docs/guide.md', fragment: 'Quick start' },
  );
});

test('keeps same-document heading links inside the viewer', () => {
  assert.deepEqual(
    resolveFilePreviewLink('#In action', 'README.md'),
    { kind: 'fragment', fragment: 'In action' },
  );
  assert.equal(markdownHeadingId('In action!'), 'in-action');
  assert.equal(markdownHeadingId('Über café'), 'uber-cafe');
});

test('does not resolve external or root-relative links as workspace files', () => {
  assert.deepEqual(resolveFilePreviewLink('https://github.com', 'README.md'), { kind: 'external', href: 'https://github.com' });
  assert.deepEqual(resolveFilePreviewLink('/DEVELOPING.md', 'README.md'), { kind: 'none' });
  assert.deepEqual(resolveFilePreviewLink('../../outside.md', 'README.md'), { kind: 'none' });
});
