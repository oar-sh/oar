import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// attachments-view.js touches window/document at module scope, so the paged
// gallery wiring is asserted against the source; the paging logic itself is
// tested in media-gallery-model.test.mjs.
const source = fs.readFileSync(fileURLToPath(new URL('./attachments-view.js', import.meta.url)), 'utf8');

function functionBody(name) {
  const start = source.search(new RegExp(`(export )?(async )?function ${name}\\(`));
  assert.notEqual(start, -1, `expected to find function ${name}`);
  const next = source.slice(start + 1).search(/\n(export )?(async )?function /);
  return source.slice(start, next === -1 ? source.length : start + 1 + next);
}

test('stepping past the last loaded item loads the next page, then goes on into it', () => {
  const step = functionBody('stepFilePreviewGallery');
  assert.match(step, /galleryCanStep\(gallery, delta\)[\s\S]*?await gallery\.loadMore\(\)/);
  assert.match(step, /if \(filePreviewState\.gallery !== gallery\) return false;/, 'a viewer closed or moved meanwhile is left alone');
  assert.match(step, /gallery = extendGallery\(gallery, page \|\| \{ items: \[\], hasMore: false \}\)/);
  assert.match(step, /openGalleryItem\(next\.items\[index\], next\)/);
});

test('the next button and the swipe count a page still to load as somewhere to go', () => {
  assert.match(source, /getElementById\('file-preview-next'\)\.disabled = !galleryCanStep\(gallery, 1\)/);
  assert.match(source, /galleryCanStep\(filePreviewState\.gallery, dx < 0 \? 1 : -1\) \? dx : dx \* 0\.25/);
});

test('a gallery can describe its open item: a caption line and its own buttons', () => {
  const details = functionBody('renderGalleryDetails');
  assert.match(details, /gallery\.describe\(item\)/);
  assert.match(details, /caption\.textContent = details\?\.caption \|\| ''/, 'the caption is text, never markup');
  assert.match(details, /button\.textContent = action\.label/);
  assert.match(details, /querySelectorAll\('\[data-gallery-action\]'\)\.forEach\(\(button\) => button\.remove\(\)\)/, 'buttons of the previous item go');
  assert.match(source, /renderGalleryDetails\(gallery\);/);
});

test('a picture or video on another site opens as a card with a link out: never an <img>/<video>, never prefetched', () => {
  const open = functionBody('openUploadedAttachmentViewer');
  assert.match(open, /kind: options\?\.remote \? 'remote' : uploadPreviewKind\(mimeType\)/);
  assert.match(open, /rawUrl: options\?\.remote \? '' : String\(contentUrl \|\| ''\)/, 'no address to load is kept for it');
  assert.match(functionBody('openGalleryItem'), /remote: item\.remote \|\| null/);
  const render = functionBody('renderFilePreview');
  const card = render.slice(render.indexOf("payload.kind === 'remote'"), render.indexOf("payload.kind === 'binary'"));
  assert.match(card, /mediaRemoteCard\(payload\.remote\)/);
  assert.match(card, /target="_blank" rel="noopener noreferrer"/);
  assert.match(card, /href="\$\{escHtml\(card\.href\)\}"/, 'the address is escaped into the attribute');
  assert.match(card, /card\.href \? `<a /, 'only an address with an href becomes a link');
  assert.doesNotMatch(card, /<img|<video|<audio|fileSrcAttribute/);
  assert.match(render, /payload\.kind === 'remote' \? mediaRemoteCard\(payload\.remote\)\.title/, 'the meta line names the host, not "REMOTE"');
  assert.match(functionBody('prefetchGalleryNeighbors'), /!item\.remote && String\(item\.mime/);
  assert.match(functionBody('renderAttachmentMarkup'), /isRemotePreviewSource\(rawUrl\)/, 'a message attachment on another site is a link, not an <img>');
});
