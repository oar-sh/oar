import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mediaCaption,
  mediaCopyTarget,
  mediaViewerGallery,
  mediaViewerItem,
} from './media-gallery-model.mjs';
import { extendGallery, galleryCanStep, galleryPositionLabel } from './viewer-gallery.mjs';

// The address the relay hands out: the route with the item's tag (a made-up one here).
const mediaUrl = (id) => `/api/media/${id}/content?t=${`tag${id}`.padEnd(22, 'x')}`;

const item = (id, extra = {}) => ({
  id,
  conversationId: 'c1',
  conversationTitle: 'Garden plans',
  messageId: `m${id}`,
  sender: 'agent',
  origin: 'embedded',
  mediaKind: 'image',
  mime: 'image/png',
  name: `p${id}.png`,
  timestamp: '2026-10-01T10:00:00.000Z',
  occurrences: 1,
  contentUrl: mediaUrl(id),
  remoteUrl: null,
  path: `/srv/demo/p${id}.png`,
  archived: false,
  ...extra,
});

test('a media item becomes an upload-style viewer item with its own address', () => {
  assert.deepEqual(mediaViewerItem(item(3), '/base'), {
    key: 'media:3',
    source: 'upload',
    href: `/base${mediaUrl(3)}`,
    name: 'p3.png',
    mime: 'image/png',
    size: 0,
    media: item(3),
  });
  const remote = mediaViewerItem(item(4, { contentUrl: null, remoteUrl: 'https://images.example.test/a.jpg', mime: null }));
  assert.equal(remote.href, 'https://images.example.test/a.jpg');
  assert.equal(remote.mime, 'image/png', 'a remote picture still opens as a picture');
});

test('the caption names the session, the date, the sender and repeats', () => {
  const caption = mediaCaption(item(1, { occurrences: 3, archived: true, sender: 'me' }), { locale: 'en-US' });
  assert.match(caption, /^Garden plans · Oct 1, 2026, \d{2}:\d{2}\s[AP]M · 👤 You · in 3 messages · archived$/);
  assert.match(mediaCaption(item(2, { origin: 'generated' })), /✨ Generated/);
  assert.match(mediaCaption(item(2, { remoteUrl: 'https://x.example.test/a.png' })), /🤖 Agent 🌐/);
});

test('copy offers the path of a local file, the link of a remote one, nothing for uploads', () => {
  assert.deepEqual(mediaCopyTarget(item(1)), { label: 'Copy path', text: '/srv/demo/p1.png' });
  assert.deepEqual(mediaCopyTarget(item(1, { path: null, remoteUrl: 'https://x.example.test/a.png' })), { label: 'Copy link', text: 'https://x.example.test/a.png' });
  assert.equal(mediaCopyTarget(item(1, { path: null })), null);
});

test('the viewer gallery describes each item with Open in session and Copy', async () => {
  const opened = [];
  const copied = [];
  const gallery = mediaViewerGallery([item(1), item(2)], 1, {
    openInSession: (media) => opened.push([media.conversationId, media.messageId]),
    copyText: (text) => copied.push(text),
  });
  const details = gallery.describe(gallery.items[1]);
  assert.deepEqual(details.actions.map((action) => action.label), ['Open in session', 'Copy path']);
  await details.actions[0].run();
  await details.actions[1].run();
  assert.deepEqual(opened, [['c1', 'm2']]);
  assert.deepEqual(copied, ['/srv/demo/p2.png']);
  assert.equal(gallery.describe({ name: 'other' }), null);
});

test('a paged gallery steps past its last loaded item by loading the next page', async () => {
  let calls = 0;
  const gallery = mediaViewerGallery([item(1), item(2)], 1, {
    hasMore: true,
    loadMore: async () => {
      calls += 1;
      return { items: [item(2), item(3)], hasMore: false };
    },
  });
  assert.equal(galleryPositionLabel(gallery), '2 / 2+');
  assert.equal(galleryCanStep(gallery, 1), true);
  assert.equal(galleryCanStep(gallery, -1), true);
  const page = await gallery.loadMore();
  const extended = extendGallery(gallery, page);
  assert.equal(calls, 1);
  assert.deepEqual(extended.items.map((entry) => entry.key), ['media:1', 'media:2', 'media:3'], 'an item already loaded is not added twice');
  assert.equal(extended.hasMore, false);
  assert.equal(galleryPositionLabel(extended), '2 / 3');
  assert.equal(galleryCanStep({ ...extended, index: 2 }, 1), false);
});

test('a page that adds nothing ends the paging', () => {
  const gallery = mediaViewerGallery([item(1)], 0, { hasMore: true, loadMore: async () => null });
  const extended = extendGallery(gallery, { items: [mediaViewerItem(item(1))], hasMore: true });
  assert.equal(extended.hasMore, false);
  assert.equal(galleryCanStep(extended, 1), false);
});
