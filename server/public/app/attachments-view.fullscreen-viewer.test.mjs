import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// attachments-view.js touches window/document at module scope, so the viewer's
// wiring is asserted against the source, as attachments-view.repo-refresh does.
// The tap and controls logic themselves have their own suites
// (viewer-tap.test.mjs, viewer-controls-state.test.mjs).
function readSource(relativePath) {
  return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function functionBody(source, name) {
  const start = [`export function ${name}(`, `export async function ${name}(`]
    .map((signature) => source.indexOf(signature))
    .find((index) => index !== -1) ?? -1;
  assert.notEqual(start, -1, `expected to find exported function ${name}`);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

const source = readSource('./attachments-view.js');
const html = readSource('../index.html');

test('a PDF is a card with a new-tab button and a download, never the "binary" dead end', () => {
  const render = functionBody(source, 'renderFilePreview');
  const pdfBranch = /if \(payload\.kind === 'pdf'\) \{([\s\S]*?)\n  \}/.exec(render)?.[1] || '';
  assert.ok(pdfBranch, 'renderFilePreview must branch on kind pdf');
  assert.match(pdfBranch, /data-viewer-open-tab="\$\{escHtml\(inlineHref\)\}"/, 'the new-tab button carries the plain inline address');
  assert.match(pdfBranch, /downloadAnchorMarkup\(download, plainName\)/);
  // The new-tab button goes through the external-navigation helper (opener
  // severed), via delegation on the body rather than a window global.
  assert.match(source, /eventClosest\(event, '\[data-viewer-open-tab\]'\)[\s\S]*?openExternalNavigation\(openTab\.getAttribute\('data-viewer-open-tab'\)/);
});

test('audio plays in the viewer and video/audio playback drives the controls fade', () => {
  const render = functionBody(source, 'renderFilePreview');
  assert.match(render, /if \(payload\.kind === 'audio'\) \{[\s\S]*?<audio class="file-preview-audio" controls preload="metadata"/);
  assert.match(render, /bodyEl\.classList\.add\('audio-preview-mode'\)/);
  // Both players report play/pause/ended to the controls state.
  assert.match(source, /function followMediaPlayback\(media\) \{[\s\S]*?'play'[\s\S]*?setPlaying\(true\)[\s\S]*?'pause'[\s\S]*?setPlaying\(false\)[\s\S]*?'ended'[\s\S]*?setPlaying\(false\)/);
  const audioBranch = /if \(payload\.kind === 'audio'\) \{([\s\S]*?)\n  \}/.exec(render)?.[1] || '';
  const videoBranch = /if \(payload\.kind === 'video'\) \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  const rawText/.exec(render)?.[1] || '';
  assert.match(audioBranch, /followMediaPlayback\(audio\)/);
  assert.match(videoBranch, /followMediaPlayback\(video\)/);
  // An upload is classified by its MIME type, audio and PDF included.
  assert.match(source, /function uploadPreviewKind\(mimeType\) \{[\s\S]*?isAudioMimeType\(type\)\) return 'audio';[\s\S]*?'application\/pdf'\) return 'pdf';/);
});

test('the raw mode exists for text only and the Preview/Raw buttons hide for media', () => {
  const render = functionBody(source, 'renderFilePreview');
  const rawIndex = render.indexOf("if (filePreviewState.mode === 'raw')");
  const videoIndex = render.indexOf("if (payload.kind === 'video')");
  const imageIndex = render.indexOf("if (payload.kind === 'image')");
  assert.ok(rawIndex > videoIndex && rawIndex > imageIndex, 'media branches return before the raw switch is consulted');
  assert.match(source, /const hasTextModes = !isUpload && TEXT_PREVIEW_KINDS\.has\(payload\?\.kind\);[\s\S]*?previewBtn\.style\.display = hasTextModes \? '' : 'none';/);
});

test('a tap on the content toggles the floating controls, a mouse only revives them during playback', () => {
  assert.match(source, /const viewerTap = createTapRecognizer\(\{\s*onTap: \(\) => viewerControls\.toggle\(\)/);
  assert.match(source, /hasSelection: \(\) => String\(window\.getSelection\?\.\(\)\?\.toString\(\) \|\| ''\)\.length > 0/);
  assert.match(source, /for \(const eventName of \['pointerdown', 'pointermove', 'pointerup', 'pointercancel'\]\)[\s\S]*?viewerTap\.handle\(event\)/);
  assert.match(source, /event\.pointerType === 'mouse' && viewerControls\.playing/);
  // Hidden controls are a class on the modal; opening and closing reset it.
  assert.match(source, /classList\.toggle\('controls-hidden', !visible\)/);
  const close = functionBody(source, 'closeFilePreview');
  assert.match(close, /viewerControls\.reset\(\)/);
  assert.match(close, /classList\.remove\('visible', 'controls-hidden', 'media-mode'\)/);
  assert.match(source, /function showFilePreviewModal\(\) \{[\s\S]*?if \(!wasVisible\) \{\s*viewerControls\.reset\(\);/);
});

test('a gallery is built from the folder a file was opened from, and stepped by buttons, keys and swipes', () => {
  assert.match(functionBody(source, 'openWorkspaceFilePreviewFromRepo'), /const gallery = repoFolderGallery\(rawPath\);/);
  assert.match(source, /function repoFolderGallery\(openedPath\) \{[\s\S]*?galleryFromFolder\(node\.children, openedPath/);
  const step = functionBody(source, 'stepFilePreviewGallery');
  assert.match(step, /galleryNeighborIndex\(gallery, delta\)/);
  assert.match(step, /return openGalleryItem\(next\.items\[index\], next\);/);
  // An item is opened by what it is: an upload by its address, a file by its path.
  const openItem = functionBody(source, 'openGalleryItem');
  assert.match(openItem, /if \(source === 'upload'\) \{\s*openUploadedAttachmentViewer\(item\.name, item\.href, item\.mime, \{ gallery \}\);/);
  assert.match(openItem, /return open\(item\.path, \{ gallery, viaGallery: true \}\)/);
  // Chat media: attachments carry their address and type for the gallery
  // collector, and the conversation's click handler opens through the gallery.
  const attachmentMarkup = functionBody(source, 'renderAttachmentMarkup');
  assert.match(attachmentMarkup, /data-media-name="\$\{name\}" data-media-url="\$\{escHtml\(rawUrl\)\}" data-media-type=/);
  assert.doesNotMatch(attachmentMarkup, /openUploadedAttachmentViewer\(/, 'no inline open handler: the conversation delegates the click');
  const conversationView = readSource('./conversation-view.js');
  assert.match(conversationView, /function handleChatMediaClick\(event\) \{[\s\S]*?chatMediaGallery\(getMessagesElement\(\), node, options\)[\s\S]*?void openGalleryItem\(item, gallery\);/);
  assert.match(conversationView, /messagesEl\.addEventListener\('click', handleChatMediaClick\)/);
  // A stale answer (an earlier, slower request) is never shown.
  assert.match(source, /const seq = \+\+filePreviewLoadSeq;[\s\S]*?if \(seq !== filePreviewLoadSeq\) return false;/);
  // Keys and buttons.
  assert.match(source, /event\.key !== 'ArrowLeft' && event\.key !== 'ArrowRight'[\s\S]*?stepFilePreviewGallery\(event\.key === 'ArrowRight' \? 1 : -1\)/);
  assert.match(source, /getElementById\('file-preview-prev'\)\.addEventListener\('click'/);
  // A swipe is a finger's, only when an image is not zoomed in, and never
  // starts on a player or inside a block that scrolls sideways itself.
  assert.match(source, /const viewerSwipe = createSwipeRecognizer\(\{\s*canStart: \(event\) => event\.pointerType !== 'mouse'[\s\S]*?insideHorizontalScroller\(event\.target\)/);
  assert.match(source, /horizontalEnabled: \(\) => Boolean\(filePreviewState\.gallery\) && imageZoomAtRest\(\)/);
  assert.match(source, /if \(swipe === 'left'\) void stepFilePreviewGallery\(1\);\s*else if \(swipe === 'right'\) void stepFilePreviewGallery\(-1\);/);
  // Neighbours are fetched ahead and their images primed under the viewer's own address.
  assert.match(source, /function prefetchGalleryNeighbors\(\) \{[\s\S]*?galleryNeighbors\(gallery\)[\s\S]*?image\.src = previewRawHref\(source/);
  assert.match(functionBody(source, 'closeFilePreview'), /galleryPayloadCache\.clear\(\)/);
});

test('the back gesture closes the viewer, and a swipe down dismisses what does not scroll', () => {
  // One history entry per opening, taken out again on any other close, and
  // every popstate goes to the helper that tells the user's back from ours.
  assert.match(source, /const viewerHistory = createViewerHistory\(\{\s*history: window\.history,\s*onBack: \(\) => closeFilePreview\(\),/);
  assert.match(source, /window\.addEventListener\('popstate', \(\) => viewerHistory\.onPopState\(\)\)/);
  assert.match(source, /function showFilePreviewModal\(\) \{[\s\S]*?if \(!wasVisible\) \{[\s\S]*?viewerHistory\.opened\(\);/);
  assert.match(functionBody(source, 'closeFilePreview'), /if \(wasVisible\) viewerHistory\.closed\(\);/);
  // Swipe down: media and cards only, never a zoomed-in image, never text.
  assert.match(source, /function viewerDismissableBySwipe\(\) \{\s*return !viewerDismissing && !TEXT_PREVIEW_KINDS\.has\(filePreviewState\.payload\?\.kind\) && imageZoomAtRest\(\);/);
  assert.match(source, /verticalEnabled: viewerDismissableBySwipe,/);
  assert.match(source, /if \(axis === 'y' && swipe === 'down'\) \{\s*dismissFilePreviewWithSlide\(\);/);
  assert.match(source, /function dismissFilePreviewWithSlide\(\) \{[\s\S]*?translateY\(100vh\)[\s\S]*?closeFilePreview\(\);/);
  assert.match(functionBody(source, 'closeFilePreview'), /clearViewerDragStyles\(\)/);
});

test('the viewer fills the screen with floating chrome, and the three open paths share one entry', () => {
  assert.match(html, /#file-preview-modal \{\s*position: fixed; inset: 0;/);
  assert.match(html, /\.file-preview-dialog \{\s*position: absolute; inset: 0;/);
  assert.match(html, /#file-preview-modal\.controls-hidden \.file-preview-chrome \{ opacity: 0; pointer-events: none; \}/);
  assert.match(html, /#file-preview-modal\.media-mode \{ background: #000; \}/);
  // The body comes first in the markup so the chrome paints above it.
  assert.match(html, /<div id="file-preview-body" class="file-preview-body"><\/div>\s*<div id="file-preview-chrome-top"/);
  // Workspace and drive files share one loading path, which shows the modal;
  // an uploaded attachment needs no load and shows it directly.
  assert.match(source, /async function openFilePreviewFromSource\([\s\S]*?showFilePreviewModal\(\);/);
  for (const name of ['openWorkspaceFilePreview', 'openDriveFilePreview']) {
    assert.match(functionBody(source, name), /return openFilePreviewFromSource\(/, `${name} opens through the shared entry`);
  }
  assert.match(functionBody(source, 'openUploadedAttachmentViewer'), /showFilePreviewModal\(\)/);
  assert.doesNotMatch(source, /if \(event\.target\.id === 'file-preview-modal'\) closeFilePreview\(\)/, 'there is no backdrop to click any more');
});
