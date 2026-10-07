import test from 'node:test';
import assert from 'node:assert/strict';

import {
  galleryAt,
  galleryFromFolder,
  galleryNeighborIndex,
  galleryNeighbors,
  galleryPositionLabel,
} from './viewer-gallery.mjs';

const children = [
  { type: 'dir', path: 'docs/img', name: 'img' },
  { type: 'file', path: 'docs/a.png', name: 'a.png' },
  { type: 'file', path: 'docs/b.md', name: 'b.md' },
  { type: 'file', path: 'docs/c.pdf', name: 'c.pdf' },
];

test('a gallery is the folder\'s files in order, open at the clicked one, folders skipped', () => {
  const gallery = galleryFromFolder(children, 'docs/b.md', { source: 'workspace' });
  assert.deepEqual(gallery.items.map((item) => item.path), ['docs/a.png', 'docs/b.md', 'docs/c.pdf']);
  assert.equal(gallery.index, 1);
  assert.equal(gallery.source, 'workspace');
  assert.equal(galleryPositionLabel(gallery), '2 / 3');
});

test('no gallery for a file outside the listing or without neighbours', () => {
  assert.equal(galleryFromFolder(children, 'elsewhere/x.png'), null);
  assert.equal(galleryFromFolder([children[1]], 'docs/a.png'), null);
  assert.equal(galleryFromFolder(null, 'docs/a.png'), null);
  assert.equal(galleryPositionLabel(null), '');
});

test('neighbours stop at the ends; the list never wraps', () => {
  const first = galleryFromFolder(children, 'docs/a.png');
  assert.equal(galleryNeighborIndex(first, -1), -1);
  assert.equal(galleryNeighborIndex(first, 1), 1);
  const last = galleryAt(first, 2);
  assert.equal(last.index, 2);
  assert.equal(galleryNeighborIndex(last, 1), -1);
  assert.equal(galleryAt(first, 3), null);
  assert.deepEqual(galleryNeighbors(galleryAt(first, 1)).map((item) => item.path), ['docs/c.pdf', 'docs/a.png']);
  assert.deepEqual(galleryNeighbors(first).map((item) => item.path), ['docs/b.md']);
});
