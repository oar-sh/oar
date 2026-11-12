import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// sanitizePreviewHtml is DOM-bound (template parsing, element replacement), so
// this suite runs on a real JSDOM document rather than the global stubs the
// pure-string router suites use.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.sessionStorage = { getItem() { return ''; }, setItem() {} };

const { setServerPlatform } = await import('./store.js');
const { sanitizePreviewHtml, rewriteLocalAssetUrlsInNode } = await import('./router.js');

function sanitizedElement(html) {
  const host = document.createElement('div');
  host.innerHTML = sanitizePreviewHtml(html);
  return host.firstElementChild;
}

test('linux relay: safe root-relative image src is left for the post-insert rewriter', () => {
  setServerPlatform('linux');
  const el = sanitizedElement('<img src="/home/dev/shot.png" alt="shot">');
  assert.equal(el.tagName, 'IMG');
  assert.equal(el.getAttribute('src'), '/home/dev/shot.png');
});

test('linux relay: media-extension image becomes a player with controls', () => {
  setServerPlatform('linux');
  const video = sanitizedElement('<img src="/home/dev/demo.mp4" alt="demo clip">');
  assert.equal(video.tagName, 'VIDEO');
  assert.equal(video.getAttribute('src'), '/home/dev/demo.mp4');
  assert.equal(video.getAttribute('controls'), '');
  assert.equal(video.getAttribute('preload'), 'metadata');
  assert.equal(video.getAttribute('title'), 'demo clip');

  const audio = sanitizedElement('<img src="/home/dev/note.mp3">');
  assert.equal(audio.tagName, 'AUDIO');
  assert.equal(audio.getAttribute('src'), '/home/dev/note.mp3');
});

// Windows path shapes below are drive-route inputs for a win32-platform relay,
// exercised cross-platform through setServerPlatform('win32').
test('win32 relay: bare absolute path src resolves to the drive-file route instead of being stripped', () => {
  setServerPlatform('win32');
  const img = sanitizedElement('<img src="C:\\Users\\dev\\shot.png">');
  assert.equal(img.tagName, 'IMG');
  // A file by path waits for its capability (`k`): no src, nothing loads yet.
  assert.equal(img.getAttribute('src'), null);
  assert.equal(img.getAttribute('data-oar-file-src'), '/api/drives/file?path=C%3A%2FUsers%2Fdev%2Fshot.png');
});

test('win32 relay: bare-path media becomes a player pointing at the drive-file route', () => {
  setServerPlatform('win32');
  const video = sanitizedElement('<img src="C:\\Users\\dev\\demo.mp4" alt="demo">');
  assert.equal(video.tagName, 'VIDEO');
  assert.equal(video.getAttribute('src'), null);
  assert.equal(video.getAttribute('data-oar-file-src'), '/api/drives/file?path=C%3A%2FUsers%2Fdev%2Fdemo.mp4');
  assert.equal(video.getAttribute('controls'), '');
});

test('linux relay: a foreign-platform path degrades to a dead workspace href, never an executable URL', () => {
  setServerPlatform('linux');
  // Drive-lettered shape is a win32 relay's input; the resolver's existing
  // workspace fallback maps it to a same-origin file URL that 404s — the same
  // treatment rewriteLocalAssetUrlsInNode gives such paths elsewhere.
  const img = sanitizedElement('<img src="C:\\Users\\dev\\shot.png" alt="x">');
  assert.equal(img.tagName, 'IMG');
  assert.equal(img.getAttribute('data-oar-file-src'), '/api/files/Users/dev/shot.png');
});

test('unsafe srcs are still stripped and data images still allowed', () => {
  setServerPlatform('linux');
  const bad = sanitizedElement('<img src="javascript:alert(1)">');
  assert.equal(bad.getAttribute('src'), null);
  const data = sanitizedElement('<img src="data:image/png;base64,AAAA">');
  assert.equal(data.getAttribute('src'), 'data:image/png;base64,AAAA');
  // data: never upgrades to a media element.
  assert.equal(data.tagName, 'IMG');
});

test('raw video/audio tags pass with a whitelisted attribute set only', () => {
  setServerPlatform('linux');
  const video = sanitizedElement(
    '<video src="https://example.com/clip.mp4" controls preload="metadata" autoplay onclick="x()" width="320"></video>',
  );
  assert.equal(video.tagName, 'VIDEO');
  assert.equal(video.getAttribute('src'), 'https://example.com/clip.mp4');
  assert.equal(video.getAttribute('controls'), '');
  assert.equal(video.getAttribute('width'), '320');
  assert.equal(video.getAttribute('autoplay'), null);
  assert.equal(video.getAttribute('onclick'), null);

  const badSrc = sanitizedElement('<audio src="javascript:alert(1)" controls></audio>');
  assert.equal(badSrc.getAttribute('src'), null);
});

test('disallowed tags are still flattened to text', () => {
  setServerPlatform('linux');
  const host = document.createElement('div');
  host.innerHTML = sanitizePreviewHtml('<script>alert(1)</script><p>ok</p>');
  assert.equal(host.querySelector('script'), null);
  assert.equal(host.querySelector('p').textContent, 'ok');
});

test('post-insert rewriter now covers video and audio srcs', () => {
  setServerPlatform('linux');
  const root = document.createElement('div');
  root.innerHTML = '<video src="/home/dev/demo.mp4"></video><audio src="/home/dev/note.mp3"></audio>';
  rewriteLocalAssetUrlsInNode(root, { preferDrive: true });
  assert.equal(root.querySelector('video').getAttribute('src'), null);
  assert.equal(
    root.querySelector('video').getAttribute('data-oar-file-src'),
    '/api/drives/file?path=%2Fhome%2Fdev%2Fdemo.mp4',
  );
  assert.equal(
    root.querySelector('audio').getAttribute('data-oar-file-src'),
    '/api/drives/file?path=%2Fhome%2Fdev%2Fnote.mp3',
  );
});

test('parseAppFileHref recognizes own file hrefs and nothing else', async () => {
  const { parseAppFileHref } = await import('./router.js');
  assert.deepEqual(
    parseAppFileHref('/api/drives/file?path=C%3A%2FUsers%2Fdev%2Fshot.png'),
    { kind: 'drive', path: 'C:/Users/dev/shot.png' },
  );
  assert.deepEqual(
    parseAppFileHref('/api/files/sub/dir%20x/shot.png?scope=abc'),
    { kind: 'workspace', path: 'sub/dir x/shot.png' },
  );
  // Foreign origins, data URIs, and unrelated same-origin routes never match.
  assert.equal(parseAppFileHref('https://example.com/api/drives/file?path=x.png'), null);
  assert.equal(parseAppFileHref('data:image/png;base64,AAAA'), null);
  assert.equal(parseAppFileHref('/api/previews'), null);
  assert.equal(parseAppFileHref(''), null);
});

test('with a capability in the cache, a file src carries its k at once', async () => {
  setServerPlatform('linux');
  const { configureFileCapabilities, resetFileCapabilities, signFileUrls } = await import('./file-capability.mjs');
  resetFileCapabilities();
  const exp = (Math.floor(Date.now() / 1000) + 600).toString(36);
  const k = `fc1.bs_test.${exp}.${'m'.repeat(43)}`;
  configureFileCapabilities({ base: '', mint: async (urls) => ({ urls: urls.map((url) => `${url}${url.includes('?') ? '&' : '?'}k=${k}`) }) });
  await signFileUrls(['/api/drives/file?path=%2Fhome%2Fdev%2Fshot.png']);
  const img = sanitizedElement('<img src="/home/dev/shot.png">');
  // The bare path is resolved by the post-insert rewriter on Linux; the route form directly:
  const direct = sanitizedElement('<img src="/api/drives/file?path=%2Fhome%2Fdev%2Fshot.png">');
  assert.equal(direct.getAttribute('src'), `/api/drives/file?path=%2Fhome%2Fdev%2Fshot.png&k=${k}`);
  assert.equal(direct.getAttribute('data-oar-file-src'), null);
  assert.equal(img.getAttribute('src'), '/home/dev/shot.png');
  resetFileCapabilities();
  configureFileCapabilities({ mint: null });
});

test('a workspace file link drawn again carries the k the page holds for it', async () => {
  setServerPlatform('linux');
  const { linkifyWorkspaceMentionsInNode, renderLinkedPlainText } = await import('./router.js');
  const { configureFileCapabilities, resetFileCapabilities, signFileUrls } = await import('./file-capability.mjs');
  const linkedHref = () => {
    const host = document.createElement('div');
    host.textContent = 'Please read README.md first.';
    linkifyWorkspaceMentionsInNode(host);
    return host.querySelector('a')?.getAttribute('href') || '';
  };
  const plainHref = () => {
    const host = document.createElement('div');
    host.innerHTML = renderLinkedPlainText('Please read README.md first.');
    return host.querySelector('a')?.getAttribute('href') || '';
  };
  const rewrittenHref = () => {
    const host = document.createElement('div');
    host.innerHTML = '<a href="README.md">readme</a>';
    rewriteLocalAssetUrlsInNode(host);
    return host.querySelector('a')?.getAttribute('href') || '';
  };
  resetFileCapabilities();
  // No k yet: the plain address, which the document policy signs later.
  assert.equal(linkedHref(), '/api/files/README.md');
  assert.equal(plainHref(), '/api/files/README.md');
  assert.equal(rewrittenHref(), '/api/files/README.md');
  const exp = (Math.floor(Date.now() / 1000) + 600).toString(36);
  const k = `fc1.bs_test.${exp}.${'m'.repeat(43)}`;
  configureFileCapabilities({ base: '', mint: async (urls) => ({ urls: urls.map((url) => `${url}?k=${k}`) }) });
  await signFileUrls(['/api/files/README.md']);
  // Once the page holds one, every builder puts it in at once: the same text renders the same.
  assert.equal(linkedHref(), `/api/files/README.md?k=${k}`);
  assert.equal(plainHref(), `/api/files/README.md?k=${k}`);
  assert.equal(rewrittenHref(), `/api/files/README.md?k=${k}`);
  resetFileCapabilities();
  configureFileCapabilities({ mint: null });
});
