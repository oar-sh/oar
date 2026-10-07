import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { chatMediaGallery, chatMediaItemFromNode } from './viewer-chat-gallery.mjs';

// A stand-in for router.js's parseAppFileHref: the app's own file addresses.
function parseAppFileHref(src) {
  const url = new URL(src, 'http://relay.invalid/');
  if (url.pathname === '/api/drives/file') return { kind: 'drive', path: url.searchParams.get('path') };
  if (url.pathname.startsWith('/api/files/')) return { kind: 'workspace', path: decodeURIComponent(url.pathname.slice('/api/files/'.length)) };
  return null;
}

function messagesWith(html) {
  const dom = new JSDOM(`<!doctype html><div id="messages">${html}</div>`);
  return dom.window.document.getElementById('messages');
}

const conversation = `
  <div class="msg user"><div class="msg-bubble">
    <div class="msg-attachments">
      <div class="msg-attachment msg-attachment-image" data-media-name="shot.png" data-media-url="/api/upload/abc/content" data-media-type="image/png">
        <img src="/api/upload/abc/content" alt="shot.png">
        <div class="msg-attachment-meta"><a href="#" data-media-open>shot.png</a></div>
      </div>
      <div class="msg-attachment"><div class="msg-attachment-meta">📎 <a href="/api/upload/def/content">notes.pdf</a></div></div>
    </div>
  </div></div>
  <div class="msg assistant"><div class="msg-bubble">
    <p>See <img src="/api/drives/file?path=C%3A%2Fwork%2Fplot.png&amp;v=1" alt="plot"> and <img src="/api/files/docs%2Fdiagram.svg" alt="diagram"></p>
    <img src="data:image/gif;base64,R0lGOD" alt="tiny">
  </div></div>
  <div class="msg user"><div class="msg-bubble">
    <div class="msg-attachment msg-attachment-video" data-media-name="clip.webm" data-media-url="/api/upload/ghi/content" data-media-type="video/webm">
      <div class="msg-attachment-video-chip">🎞️</div>
    </div>
  </div></div>`;

test('the gallery walks every attachment and embedded picture in conversation order', () => {
  const root = messagesWith(conversation);
  const plot = root.querySelector('img[alt="plot"]');
  const gallery = chatMediaGallery(root, plot, { parseAppFileHref });
  assert.equal(gallery.source, 'chat');
  assert.deepEqual(gallery.items.map((item) => `${item.source}:${item.path || item.href}`), [
    'upload:/api/upload/abc/content',
    'drives:C:/work/plot.png',
    'workspace:docs/diagram.svg',
    'upload:data:image/gif;base64,R0lGOD',
    'upload:/api/upload/ghi/content',
  ]);
  assert.equal(gallery.index, 1);
  assert.deepEqual(gallery.items[1], { source: 'drives', path: 'C:/work/plot.png', name: 'plot.png' });
  assert.deepEqual(gallery.items[4], { source: 'upload', href: '/api/upload/ghi/content', name: 'clip.webm', mime: 'video/webm' });
  // The PDF chip is a plain link, not media, and the attachment's own
  // thumbnail is counted once (as the attachment), not again as a picture.
  assert.equal(gallery.items.length, 5);
});

test('a tap anywhere on an attachment opens at that attachment', () => {
  const root = messagesWith(conversation);
  const link = root.querySelector('[data-media-open]');
  const gallery = chatMediaGallery(root, link, { parseAppFileHref });
  assert.equal(gallery.index, 0);
  const chip = root.querySelector('.msg-attachment-video-chip');
  assert.equal(chatMediaGallery(root, chip, { parseAppFileHref }).index, 4);
});

test('without embedded pictures (the shared view) only attachments remain', () => {
  const root = messagesWith(conversation);
  const chip = root.querySelector('.msg-attachment-video-chip');
  const gallery = chatMediaGallery(root, chip, { includeEmbedded: false, parseAppFileHref });
  assert.deepEqual(gallery.items.map((item) => item.name), ['shot.png', 'clip.webm']);
  assert.equal(gallery.index, 1);
});

test('one lone picture is no gallery, and a node that is not media is none either', () => {
  const root = messagesWith('<div class="msg-bubble"><img src="data:image/png;base64,AAAA" alt="only"></div>');
  assert.equal(chatMediaGallery(root, root.querySelector('img'), { parseAppFileHref }), null);
  assert.equal(chatMediaItemFromNode(root.querySelector('.msg-bubble'), { parseAppFileHref }), null);
  assert.deepEqual(chatMediaItemFromNode(root.querySelector('img'), { parseAppFileHref }), {
    source: 'upload', href: 'data:image/png;base64,AAAA', name: 'only', mime: 'image/png',
  });
});
