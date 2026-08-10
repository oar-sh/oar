import {
  BASE,
  escHtml,
  formatBytes,
  FILE_PREVIEW_MAX_BYTES,
  MAX_UPLOAD_ATTACHMENTS,
  REPO_IMAGE_EXTENSIONS,
  currentConvId,
  selectedAttachments,
  filePreviewState,
  repoBrowserState,
  workspaceRootPath,
  showTransientRelayNotice,
  getConversationCurrentWorkspaceRootPath,
} from './store.js';
import {
  uploadAttachment,
  loadWorkspaceFilePreview,
  loadDriveFilePreview,
  loadRepoTree,
  loadRepoChildren,
  loadDrivesRoots,
  loadDriveChildren,
  loadSessionRootTree,
} from './api-client.js';
import {
  extractPastedFiles,
  extractDroppedFiles,
  isGenericClipboardName,
  pastedFileName,
  planAttachmentMerge,
  overCapNoticeText,
} from './composer-paste.mjs';
import { reencodeReason, downscaleImageFile, browserDownscaleDeps } from './image-downscale.mjs';
import { imageAttachmentWarningText } from './model-vision-support.mjs';
import {
  normalizeWorkspaceMentionPath,
  normalizeDriveBrowserPath,
  driveFileHrefFromPath,
  workspacePreviewApiPath,
  drivePreviewApiPath,
  renderMarkdownPreview,
  rewriteLocalAssetUrlsInNode,
  buildReferenceToken,
  copyTextToClipboard,
  copyReferenceTokenToClipboard,
  eventClosest,
} from './router.js';
import { markdownHeadingId, resolveFilePreviewLink } from './file-preview-navigation.mjs';
import { openExternalNavigation } from './external-link-policy.mjs';
import {
  deepestExistingAncestor,
  planRepoRehydration,
  repoAncestorPaths,
} from './repo-browser-tree-state.mjs';
import {
  writeRepoBrowserHeavyPreference,
  writeRepoBrowserHiddenPreference,
} from './repo-browser-preferences.mjs';

function currentConversationId() {
  return String(currentConvId || '').trim();
}

function isVideoMimeType(mimeType) {
  return String(mimeType || '').toLowerCase().startsWith('video/');
}

function normalizeVideoPreviewOptions(options = {}) {
  const startSeconds = Math.max(0, Number(options?.startSeconds ?? options?.startAtSeconds ?? 0) || 0);
  const preload = String(options?.preload || 'metadata').toLowerCase();
  return {
    startSeconds,
    preload: preload === 'auto' ? 'auto' : 'metadata',
    autoplay: options?.autoplay === true,
  };
}

function currentWorkspaceRootPathForSelection() {
  return String(getConversationCurrentWorkspaceRootPath(currentConversationId()) || workspaceRootPath || '').trim();
}

function currentWorkspaceScopeSuffix() {
  const convId = currentConversationId();
  return convId ? `?conversationId=${encodeURIComponent(convId)}` : '';
}

function setFilePreviewState(next) {
  Object.assign(filePreviewState, next);
}

function setRepoBrowserState(next) {
  Object.assign(repoBrowserState, next);
}

let repoBrowserReloadQueued = false;
// A refresh (hidden/heavy toggle, Refresh button) refetches a lazy tree, so the
// expansion it wants to restore has to be re-applied once the new root lands.
// The restore is parked here rather than chained onto refreshRepoBrowser's own
// await, because loadRepoBrowserTree returns immediately when another load is
// already in flight — see the tail of loadRepoBrowserTree.
let pendingRepoBrowserRestore = null;
let repoBrowserRefreshSeq = 0;
let repoBrowserRenderSuspended = 0;
let repoBrowserRenderDirty = false;
let lastTreeScrolledPath = null;
const filePreviewHistory = [];

function takePendingRepoBrowserRestore() {
  const restore = pendingRepoBrowserRestore;
  pendingRepoBrowserRestore = null;
  return restore;
}

/**
 * Rehydrating a branch calls renderRepoBrowser twice per directory, so a deep
 * restore would otherwise rebuild the tree's innerHTML dozens of times and
 * flicker. Renders are collapsed into one at the end instead.
 */
async function withSuspendedRepoRender(fn) {
  repoBrowserRenderSuspended += 1;
  try {
    return await fn();
  } finally {
    repoBrowserRenderSuspended -= 1;
    if (repoBrowserRenderSuspended === 0 && repoBrowserRenderDirty) {
      repoBrowserRenderDirty = false;
      renderRepoBrowser();
    }
  }
}

function resolveAttachmentContentUrl(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  if (/^(?:https?:|data:|blob:)/i.test(value)) return value;
  const normalizedBase = String(BASE || '').trim().replace(/\/+$/, '');
  if (normalizedBase && value.startsWith(`${normalizedBase}/`)) return value;
  if (value.startsWith('/')) return `${BASE}${value}`;
  return value;
}

function flushQueuedRepoBrowserReload() {
  if (!repoBrowserState.open) {
    repoBrowserReloadQueued = false;
    return;
  }
  if (!repoBrowserReloadQueued || repoBrowserState.loading) return;
  repoBrowserReloadQueued = false;
  void loadRepoBrowserTree();
}

export function renderAttachmentMarkup(attachments, { messageId = '' } = {}) {
  return `<div class="msg-attachments">${
    attachments.map((att) => {
      const name = escHtml(att?.name || 'attachment');
      const type = escHtml(att?.type || 'file');
      const rawUrl = att?.dataUrl
        ? att.dataUrl
        : att?.contentUrl
          ? resolveAttachmentContentUrl(att.contentUrl)
          : '';
      const isImage = String(att?.type || '').startsWith('image/');
      const isVideo = isVideoMimeType(att?.type);
      const sizeText = Number(att?.size || 0) > 0 ? ` · ${formatBytes(Number(att.size || 0))}` : '';
      const continuity = att?.generatedImage?.continuity;
      const continuityActions = continuity?.canEdit && messageId
        ? `<div class="msg-image-continuity-actions">
            <button type="button" onclick="setImageEditTarget(${escHtml(JSON.stringify({
              messageId,
              imageId: att.generatedImage.imageId,
              nodeId: continuity.nodeId,
              name: att.name || 'generated image',
            }))})">Edit this image</button>
            ${continuity.parentMessageId
              ? `<button type="button" onclick="jumpToImageParent(${escHtml(JSON.stringify(continuity.parentMessageId))})">Edited from previous image</button>`
              : ''}
          </div>`
        : '';
      if ((isImage || isVideo) && rawUrl) {
        const jsName = escHtml(JSON.stringify(att?.name || 'attachment'));
        const jsUrl = escHtml(JSON.stringify(rawUrl));
        const jsType = escHtml(JSON.stringify(att?.type || 'image/jpeg'));
        const openHandler = `openUploadedAttachmentViewer(${jsName},${jsUrl},${jsType})`;
        return `
          <div class="msg-attachment msg-attachment-${isVideo ? 'video' : 'image'}">
            ${isVideo
              ? `<div class="msg-attachment-video-chip">🎞️</div>`
              : `<img src="${escHtml(rawUrl)}" alt="${name}" loading="eager" decoding="async" onclick="${openHandler}">`}
            <div class="msg-attachment-meta"><a href="#" onclick="${openHandler};return false;">${name}</a> · ${type}${sizeText} · <a href="#" onclick="${openHandler};return false;">open</a>${continuityActions}</div>
          </div>`;
      }
      if (rawUrl) {
        return `
          <div class="msg-attachment">
            <div class="msg-attachment-meta">📎 <a href="${escHtml(rawUrl)}" target="_blank" rel="noopener noreferrer">${name}</a> · ${type}${sizeText}</div>
          </div>`;
      }
      return `
        <div class="msg-attachment">
          <div class="msg-attachment-meta">📎 ${name} · ${type}${sizeText}</div>
        </div>`;
    }).join('')
  }</div>`;
}

export function renderAttachmentPreview() {
  const el = document.getElementById('attachment-preview');
  if (!selectedAttachments.length) {
    el.innerHTML = '';
    el.classList.remove('visible');
    window.syncComposerControlState?.();
    syncComposerAttachmentWarning();
    return;
  }

  el.innerHTML = selectedAttachments.map((att, idx) => {
    const state = String(att?.uploadState || 'uploaded');
    const thumb = att.isImage && att.previewUrl
      ? `<img src="${escHtml(att.previewUrl)}" alt="${escHtml(att.name)}">`
      : `<div class="attachment-preview-meta" style="height:88px;display:flex;align-items:center;justify-content:center">📎</div>`;
    const overlay = state === 'pending' || state === 'uploading'
      ? `<div class="attachment-preview-status attachment-preview-status-uploading" role="status" aria-label="Uploading ${escHtml(att.name)}"><span class="attachment-preview-spinner"></span></div>`
      : state === 'error'
        ? `<button type="button" class="attachment-preview-status attachment-preview-status-error" onclick="retryAttachmentUpload(${idx})" title="${escHtml(att.error || 'Upload failed')} — click to retry">⟳</button>`
        : '';
    return `
    <div class="attachment-preview-item attachment-preview-${escHtml(state)}">
      <button class="attachment-preview-remove" onclick="removeAttachment(${idx})" title="Remove">×</button>
      ${thumb}
      ${overlay}
      <div class="attachment-preview-meta">${escHtml(att.name)}${att.size ? ` · ${formatBytes(att.size)}` : ''}</div>
    </div>
  `;
  }).join('');
  el.classList.add('visible');
  window.syncComposerControlState?.();
  syncComposerAttachmentWarning();
}

function syncComposerAttachmentWarning() {
  const el = document.getElementById('composer-attachment-warning');
  if (!el) return;
  const modelId = document.getElementById('model-select')?.value || '';
  const text = imageAttachmentWarningText(modelId, selectedAttachments);
  el.textContent = text;
  el.hidden = !text;
}

export function refreshComposerAttachmentWarning() {
  syncComposerAttachmentWarning();
}

function releaseAttachmentPreviewUrl(attachment) {
  // Hydrated draft attachments point at a server URL, which must not be revoked.
  if (!attachment?.previewUrl) return;
  if (attachment.previewUrlIsObjectUrl === false) return;
  URL.revokeObjectURL(attachment.previewUrl);
}

export function removeAttachment(idx) {
  const [removed] = selectedAttachments.splice(idx, 1);
  releaseAttachmentPreviewUrl(removed);
  renderAttachmentPreview();
  // Persisting the remaining list lets the server diff it and release the draft
  // reference itself. Going through the normal draft save keeps removals ordered
  // against in-flight draft writes instead of racing them.
  window.persistComposerAttachments?.();
}

export function clearAttachments() {
  for (const att of selectedAttachments) {
    releaseAttachmentPreviewUrl(att);
  }
  selectedAttachments.length = 0;
  renderAttachmentPreview();
}

/**
 * Replaces composer attachments wholesale, used when hydrating a conversation's
 * cached draft attachments. Object URLs from the outgoing set are released.
 */
export function setComposerAttachments(attachments = []) {
  for (const att of selectedAttachments) {
    releaseAttachmentPreviewUrl(att);
  }
  selectedAttachments.length = 0;
  selectedAttachments.push(...(Array.isArray(attachments) ? attachments.filter(Boolean) : []));
  renderAttachmentPreview();
}

let attachmentIdSeq = 0;

function nextAttachmentId() {
  attachmentIdSeq += 1;
  return `att-${Date.now()}-${attachmentIdSeq}`;
}

async function prepareIncomingFile(file, { source, now, index }) {
  const rawType = String(file?.type || '').trim().toLowerCase() || 'application/octet-stream';
  const isImage = rawType.startsWith('image/');

  // Clipboard bitmaps arrive unnamed (or as a generic "image.png"), so they get a
  // timestamped name that survives the round trip to the server.
  const needsGeneratedName = source === 'paste' && isGenericClipboardName(file?.name);
  let prepared = file;
  // Re-encode when the image is oversized, and also when its format is one the
  // model cannot read (a small WebP would otherwise arrive invisible).
  if (isImage && reencodeReason(file)) {
    prepared = await downscaleImageFile(file, {}, browserDownscaleDeps());
  }

  const finalType = String(prepared?.type || rawType).trim().toLowerCase() || 'application/octet-stream';
  const finalIsImage = finalType.startsWith('image/');
  const name = needsGeneratedName
    ? pastedFileName(finalType, now, index)
    : String(prepared?.name || file?.name || 'upload');

  return {
    id: nextAttachmentId(),
    name,
    type: finalType,
    size: Number(prepared?.size || 0),
    file: prepared,
    isImage: finalIsImage,
    previewUrl: finalIsImage ? URL.createObjectURL(prepared) : '',
    previewUrlIsObjectUrl: finalIsImage,
    uploadState: 'pending',
    uploaded: null,
    error: '',
  };
}

async function startAttachmentUpload(attachment, ownerConversationId = currentConversationId()) {
  if (!attachment?.file) return;
  attachment.uploadState = 'uploading';
  attachment.error = '';
  renderAttachmentPreview();
  try {
    const payload = await uploadAttachment(attachment);
    if (!payload?.attachment) throw new Error('Upload returned no attachment');
    // The entry may have been removed, or the user may have moved to another
    // conversation, while the upload was in flight.
    if (!selectedAttachments.includes(attachment)) return;
    attachment.uploaded = payload.attachment;
    attachment.sha256 = payload.attachment.sha256;
    attachment.uploadState = 'uploaded';
    attachment.error = '';
    renderAttachmentPreview();
    if (currentConversationId() !== ownerConversationId) return;
    window.persistComposerAttachments?.();
  } catch (e) {
    if (!selectedAttachments.includes(attachment)) return;
    attachment.uploadState = 'error';
    attachment.error = e?.message || 'Upload failed';
    renderAttachmentPreview();
    showTransientRelayNotice(`Upload failed for ${attachment.name}. Click the chip to retry.`);
  }
}

export function retryAttachmentUpload(idx) {
  const attachment = selectedAttachments[idx];
  if (!attachment || attachment.uploadState !== 'error') return;
  void startAttachmentUpload(attachment);
}

/**
 * Single ingestion path shared by the file picker, paste and drag-and-drop.
 * Files are normalized, optionally downscaled, capped, and uploaded immediately
 * so that pressing Send never has to wait on the network.
 */
export async function ingestFiles(files, { source = 'picker' } = {}) {
  const inputFiles = Array.from(files || []).filter(Boolean);
  if (!inputFiles.length) return [];

  // Downscaling a large image takes long enough for the user to switch
  // conversations, and the result must never land in the wrong composer.
  const ownerConversationId = currentConversationId();
  const now = new Date();
  const prepared = [];
  for (let index = 0; index < inputFiles.length; index += 1) {
    prepared.push(await prepareIncomingFile(inputFiles[index], { source, now, index }));
  }

  if (currentConversationId() !== ownerConversationId) {
    for (const item of prepared) releaseAttachmentPreviewUrl(item);
    return [];
  }

  const plan = planAttachmentMerge(selectedAttachments, prepared, MAX_UPLOAD_ATTACHMENTS);
  const rejected = prepared.filter((item) => !plan.acceptedAdditions.includes(item));
  for (const item of rejected) {
    releaseAttachmentPreviewUrl(item);
  }

  selectedAttachments.length = 0;
  selectedAttachments.push(...plan.accepted);
  renderAttachmentPreview();

  if (plan.droppedCount > 0) {
    showTransientRelayNotice(overCapNoticeText(plan.droppedCount, MAX_UPLOAD_ATTACHMENTS));
  }

  await Promise.all(plan.acceptedAdditions.map(
    (attachment) => startAttachmentUpload(attachment, ownerConversationId),
  ));
  return plan.acceptedAdditions;
}

export async function handleAttachmentInput(files) {
  return ingestFiles(files, { source: 'picker' });
}

export async function handleComposerPaste(event) {
  const { files } = extractPastedFiles(event?.clipboardData);
  if (!files.length) return false;
  // Only claim the event once a file is actually present, so pasting plain text
  // keeps its native behaviour.
  event.preventDefault?.();
  await ingestFiles(files, { source: 'paste' });
  return true;
}

export async function handleComposerDrop(event) {
  const { files } = extractDroppedFiles(event?.dataTransfer);
  if (!files.length) return false;
  event.preventDefault?.();
  await ingestFiles(files, { source: 'drop' });
  return true;
}

export async function uploadAttachments(files) {
  const items = Array.isArray(files) ? files : [];
  const uploaded = [];
  for (const item of items) {
    if (!item) continue;
    // Eagerly uploaded attachments already hold their server payload; only
    // entries that never made it (offline, failed, still queued) are retried.
    if (item.uploaded?.sha256) {
      uploaded.push(item.uploaded);
      continue;
    }
    if (!item.file) continue;
    const payload = await uploadAttachment(item);
    if (!payload?.attachment) throw new Error('Upload returned no attachment');
    item.uploaded = payload.attachment;
    item.sha256 = payload.attachment.sha256;
    item.uploadState = 'uploaded';
    uploaded.push(payload.attachment);
  }
  return uploaded;
}

function updateFilePreviewUiState() {
  const previewBtn = document.getElementById('file-preview-mode-preview');
  const rawBtn = document.getElementById('file-preview-mode-raw');
  const htmlBtn = document.getElementById('file-preview-html-toggle');
  const warning = document.getElementById('file-preview-warning');
  const payload = filePreviewState.payload;
  const isMarkdown = payload?.kind === 'markdown';
  const isUpload = filePreviewState.source === 'upload';
  previewBtn.style.display = isUpload ? 'none' : '';
  rawBtn.style.display = isUpload ? 'none' : '';
  previewBtn.classList.toggle('active', filePreviewState.mode === 'preview');
  rawBtn.classList.toggle('active', filePreviewState.mode === 'raw');
  htmlBtn.style.display = (!isUpload && isMarkdown && filePreviewState.mode === 'preview') ? 'inline-block' : 'none';
  htmlBtn.classList.toggle('active', filePreviewState.allowHtml);
  htmlBtn.textContent = filePreviewState.allowHtml ? 'Show literal HTML' : 'Show HTML layout';
  warning.classList.toggle('visible', isMarkdown && filePreviewState.allowHtml && filePreviewState.mode === 'preview');
  const backBtn = document.getElementById('file-preview-back');
  backBtn.hidden = filePreviewHistory.length === 0;
  backBtn.disabled = filePreviewHistory.length === 0;
}

function snapshotFilePreviewState() {
  const bodyEl = document.getElementById('file-preview-body');
  return {
    path: filePreviewState.path,
    source: filePreviewState.source,
    mode: filePreviewState.mode,
    allowHtml: filePreviewState.allowHtml,
    loading: filePreviewState.loading,
    error: filePreviewState.error,
    payload: filePreviewState.payload,
    viewerOptions: filePreviewState.viewerOptions,
    scrollTop: Number(bodyEl?.scrollTop || 0),
  };
}

function scrollMarkdownPreviewToFragment(rawFragment) {
  const fragment = markdownHeadingId(rawFragment);
  if (!fragment) return;
  const article = document.querySelector('#file-preview-body .file-preview-markdown');
  const target = Array.from(article?.querySelectorAll('[id]') || []).find((element) => element.id === fragment);
  target?.scrollIntoView({ block: 'start' });
}

function assignMarkdownHeadingIds(article) {
  const counts = new Map();
  for (const heading of article.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const baseId = markdownHeadingId(heading.textContent);
    if (!baseId) continue;
    const count = counts.get(baseId) || 0;
    counts.set(baseId, count + 1);
    heading.id = count ? `${baseId}-${count}` : baseId;
  }
}

function teardownImageZoom() {
  const c = imgZoom.container;
  const img = imgZoom.imgEl;
  const onImgLoad = imgZoom.onImgLoad;
  window.removeEventListener('resize', _imgZoomOnResize);
  if (img && onImgLoad) img.removeEventListener('load', onImgLoad);
  if (c) {
    c.removeEventListener('wheel', _imgZoomWheel);
    c.removeEventListener('mousedown', _imgZoomMouseDown);
    c.removeEventListener('dblclick', _imgZoomDblClick);
    c.removeEventListener('touchstart', _imgZoomTouchStart);
    c.removeEventListener('touchmove', _imgZoomTouchMove);
    c.removeEventListener('touchend', _imgZoomTouchEnd);
    imgZoom.container = null;
  }
  imgZoom.imgEl = null;
  imgZoom.onImgLoad = null;
  imgZoom.baseW = 0;
  imgZoom.baseH = 0;
  _cancelImgZoomCrispen();
  const bodyEl = document.getElementById('file-preview-body');
  if (bodyEl) bodyEl.classList.remove('image-zoom-mode');
}

function teardownVideoPreview() {
  const video = videoPreview.videoEl;
  const onLoadedMetadata = videoPreview.onLoadedMetadata;
  const onError = videoPreview.onError;
  const onCanPlay = videoPreview.onCanPlay;
  if (video) {
    if (onLoadedMetadata) video.removeEventListener('loadedmetadata', onLoadedMetadata);
    if (onError) video.removeEventListener('error', onError);
    if (onCanPlay) video.removeEventListener('canplay', onCanPlay);
    try {
      video.pause();
    } catch {}
  }
  videoPreview.videoEl = null;
  videoPreview.onLoadedMetadata = null;
  videoPreview.onError = null;
  videoPreview.onCanPlay = null;
  const bodyEl = document.getElementById('file-preview-body');
  if (bodyEl) bodyEl.classList.remove('video-preview-mode');
}

function setupImageZoom(container) {
  imgZoom.container = container;
  imgZoom.imgEl = container.querySelector('img');
  // Stale from the previously viewed image, and wrong for this one.
  imgZoom.baseW = 0;
  imgZoom.baseH = 0;
  imgZoom.minScale = 1;
  imgZoom.scale = 1;
  imgZoom.panX = 0;
  imgZoom.panY = 0;
  imgZoom.dragging = false;
  imgZoom.pinching = false;
  imgZoom.lastTapMs = 0;
  container.addEventListener('wheel', _imgZoomWheel, { passive: false });
  container.addEventListener('mousedown', _imgZoomMouseDown);
  container.addEventListener('dblclick', _imgZoomDblClick);
  container.addEventListener('touchstart', _imgZoomTouchStart, { passive: false });
  container.addEventListener('touchmove', _imgZoomTouchMove, { passive: false });
  container.addEventListener('touchend', _imgZoomTouchEnd);
  window.addEventListener('resize', _imgZoomOnResize);
  if (imgZoom.imgEl) {
    imgZoom.onImgLoad = () => _recomputeImgZoomMinScale({ resetToMin: true });
    imgZoom.imgEl.addEventListener('load', imgZoom.onImgLoad, { once: true });
  }
  requestAnimationFrame(() => _recomputeImgZoomMinScale({ resetToMin: true }));
}

let imgZoom = {
  scale: 1,
  panX: 0,
  panY: 0,
  minScale: 1,
  dragging: false,
  lastX: 0,
  lastY: 0,
  pinching: false,
  pinchDist0: 0,
  pinchScale0: 1,
  pinchPanX0: 0,
  pinchPanY0: 0,
  pinchCX: 0,
  pinchCY: 0,
  lastTapMs: 0,
  container: null,
  imgEl: null,
  onImgLoad: null,
  baseW: 0,
  baseH: 0,
};
let videoPreview = {
  videoEl: null,
  onLoadedMetadata: null,
  onError: null,
  onCanPlay: null,
};
const IMG_ZOOM_MIN_FLOOR = 0.05;
const IMG_ZOOM_MAX = 8;
const IMG_ZOOM_EPS = 0.001;

function _isAtImgZoomMin() {
  return Math.abs(imgZoom.scale - imgZoom.minScale) <= IMG_ZOOM_EPS;
}

/**
 * The image's laid-out size at scale 1, measured once with the zoom styles
 * removed. Deriving it from the live rect instead would be circular now that
 * zooming changes the element's layout size rather than only its transform.
 */
function _measureImgBaseSize() {
  const img = imgZoom.container?.querySelector('img');
  if (!img) return null;
  const prev = { width: img.style.width, height: img.style.height, maxWidth: img.style.maxWidth, maxHeight: img.style.maxHeight, transform: img.style.transform };
  img.style.width = '';
  img.style.height = '';
  img.style.maxWidth = '';
  img.style.maxHeight = '';
  img.style.transform = '';
  const rect = img.getBoundingClientRect();
  img.style.width = prev.width;
  img.style.height = prev.height;
  img.style.maxWidth = prev.maxWidth;
  img.style.maxHeight = prev.maxHeight;
  img.style.transform = prev.transform;
  if (!rect.width || !rect.height) return null;
  imgZoom.baseW = rect.width;
  imgZoom.baseH = rect.height;
  return { baseW: rect.width, baseH: rect.height };
}

function _getImgBaseSize() {
  if (imgZoom.baseW && imgZoom.baseH) return { baseW: imgZoom.baseW, baseH: imgZoom.baseH };
  return _measureImgBaseSize();
}

let imgZoomCrispenTimer = null;

function _cancelImgZoomCrispen() {
  if (!imgZoomCrispenTimer) return;
  clearTimeout(imgZoomCrispenTimer);
  imgZoomCrispenTimer = null;
}

// Re-layout only once the gesture stops, so a wheel spin does not trigger a
// full resample of a large bitmap on every tick.
function _scheduleImgZoomCrispen() {
  _cancelImgZoomCrispen();
  imgZoomCrispenTimer = setTimeout(() => {
    imgZoomCrispenTimer = null;
    if (!imgZoom.container) return;
    _applyImgZoom({ crisp: true });
  }, 180);
}

function _recomputeImgZoomMinScale({ resetToMin = false } = {}) {
  if (!imgZoom.container) return;
  const cW = imgZoom.container.clientWidth;
  const cH = imgZoom.container.clientHeight;
  const size = _getImgBaseSize();
  if (!cW || !cH || !size || !size.baseW || !size.baseH) return;
  const fitScaleX = cW / size.baseW;
  const fitScaleY = cH / size.baseH;
  const nextMinScale = Math.max(IMG_ZOOM_MIN_FLOOR, Math.min(1, fitScaleX, fitScaleY));
  const wasAtMin = _isAtImgZoomMin();
  imgZoom.minScale = nextMinScale;
  if (resetToMin || wasAtMin || imgZoom.scale < imgZoom.minScale) {
    imgZoom.scale = imgZoom.minScale;
    imgZoom.panX = 0;
    imgZoom.panY = 0;
  }
  _clampImgZoom();
  _applyImgZoom();
}

/**
 * Zooming happens in two stages.
 *
 * While the user is actively zooming, a CSS transform is used: it is GPU cheap
 * and stays smooth even on an 8-megapixel screenshot. Once the gesture settles,
 * the image is re-laid-out at its zoomed size instead, which forces the browser
 * to resample from the full-resolution bitmap.
 *
 * The second stage matters because a transform only magnifies whatever raster
 * the compositor already has. Desktop Chromium happens to re-rasterise and stays
 * sharp, but that is not guaranteed — devices that cap decoded image resolution
 * to save memory, which is common on phones, keep magnifying the reduced raster
 * and fine text turns to mush.
 */
function _applyImgZoom({ crisp = false } = {}) {
  const img = imgZoom.container?.querySelector('img');
  if (!img) return;

  const size = _getImgBaseSize();
  const atRest = Math.abs(imgZoom.scale - imgZoom.minScale) <= IMG_ZOOM_EPS
    && imgZoom.panX === 0 && imgZoom.panY === 0;
  const panOnly = imgZoom.panX === 0 && imgZoom.panY === 0
    ? ''
    : `translate(${imgZoom.panX}px,${imgZoom.panY}px)`;

  if (crisp && size && !atRest) {
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    img.style.width = `${size.baseW * imgZoom.scale}px`;
    img.style.height = `${size.baseH * imgZoom.scale}px`;
    img.style.transform = panOnly;
  } else {
    img.style.maxWidth = '';
    img.style.maxHeight = '';
    img.style.width = '';
    img.style.height = '';
    img.style.transform = atRest
      ? ''
      : `${panOnly} scale(${imgZoom.scale})`.trim();
    _scheduleImgZoomCrispen();
  }
  imgZoom.container.style.cursor = imgZoom.dragging ? 'grabbing'
    : imgZoom.scale > (imgZoom.minScale + IMG_ZOOM_EPS) ? 'grab' : 'zoom-in';
}

function _clampImgZoom() {
  imgZoom.scale = Math.max(imgZoom.minScale, Math.min(IMG_ZOOM_MAX, imgZoom.scale));
  const size = _getImgBaseSize();
  if (size && imgZoom.container) {
    const cW = imgZoom.container.clientWidth;
    const cH = imgZoom.container.clientHeight;
    const scaledW = size.baseW * imgZoom.scale;
    const scaledH = size.baseH * imgZoom.scale;
    const maxPanX = Math.max(0, (scaledW - cW) / 2);
    const maxPanY = Math.max(0, (scaledH - cH) / 2);
    imgZoom.panX = Math.max(-maxPanX, Math.min(maxPanX, imgZoom.panX));
    imgZoom.panY = Math.max(-maxPanY, Math.min(maxPanY, imgZoom.panY));
  }
  if (imgZoom.scale <= imgZoom.minScale + IMG_ZOOM_EPS) {
    imgZoom.scale = imgZoom.minScale;
    imgZoom.panX = 0;
    imgZoom.panY = 0;
  }
}

function _zoomAtPoint(factor, cxFromCenter, cyFromCenter) {
  const old = imgZoom.scale;
  imgZoom.scale = old * factor;
  if (imgZoom.scale !== old) {
    imgZoom.panX = cxFromCenter - (cxFromCenter - imgZoom.panX) * (imgZoom.scale / old);
    imgZoom.panY = cyFromCenter - (cyFromCenter - imgZoom.panY) * (imgZoom.scale / old);
  }
  _clampImgZoom();
  _applyImgZoom();
}

function _ptFromCenter(clientX, clientY) {
  const r = imgZoom.container.getBoundingClientRect();
  return { cx: clientX - r.left - r.width / 2, cy: clientY - r.top - r.height / 2 };
}

function _imgZoomWheel(e) {
  e.preventDefault();
  const { cx, cy } = _ptFromCenter(e.clientX, e.clientY);
  _zoomAtPoint(e.deltaY < 0 ? 1.15 : 1 / 1.15, cx, cy);
}

function _imgZoomMouseDown(e) {
  if (e.button !== 0 || _isAtImgZoomMin()) return;
  e.preventDefault();
  imgZoom.dragging = true;
  imgZoom.lastX = e.clientX;
  imgZoom.lastY = e.clientY;
  _applyImgZoom();
  const onMove = (ev) => {
    if (!imgZoom.dragging) return;
    imgZoom.panX += ev.clientX - imgZoom.lastX;
    imgZoom.panY += ev.clientY - imgZoom.lastY;
    imgZoom.lastX = ev.clientX;
    imgZoom.lastY = ev.clientY;
    _clampImgZoom();
    _applyImgZoom();
  };
  const onUp = () => {
    imgZoom.dragging = false;
    _applyImgZoom();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function _imgZoomDblClick(e) {
  const { cx, cy } = _ptFromCenter(e.clientX, e.clientY);
  if (!_isAtImgZoomMin() || imgZoom.panX !== 0 || imgZoom.panY !== 0) {
    imgZoom.scale = imgZoom.minScale;
    imgZoom.panX = 0;
    imgZoom.panY = 0;
    _applyImgZoom();
  } else {
    _zoomAtPoint(3, cx, cy);
  }
}

function _imgZoomTouchStart(e) {
  const now = Date.now();
  if (e.touches.length === 2) {
    e.preventDefault();
    imgZoom.dragging = false;
    imgZoom.pinching = true;
    const t0 = e.touches[0], t1 = e.touches[1];
    imgZoom.pinchDist0 = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
    imgZoom.pinchScale0 = imgZoom.scale;
    imgZoom.pinchPanX0 = imgZoom.panX;
    imgZoom.pinchPanY0 = imgZoom.panY;
    const r = imgZoom.container.getBoundingClientRect();
    imgZoom.pinchCX = (t0.clientX + t1.clientX) / 2 - r.left - r.width / 2;
    imgZoom.pinchCY = (t0.clientY + t1.clientY) / 2 - r.top - r.height / 2;
  } else if (e.touches.length === 1) {
    if (now - imgZoom.lastTapMs < 300) {
      e.preventDefault();
      const { cx, cy } = _ptFromCenter(e.touches[0].clientX, e.touches[0].clientY);
      if (!_isAtImgZoomMin() || imgZoom.panX !== 0 || imgZoom.panY !== 0) {
        imgZoom.scale = imgZoom.minScale;
        imgZoom.panX = 0;
        imgZoom.panY = 0;
        _applyImgZoom();
      } else {
        _zoomAtPoint(3, cx, cy);
      }
      imgZoom.lastTapMs = 0;
      return;
    }
    imgZoom.lastTapMs = now;
    if (!_isAtImgZoomMin()) {
      e.preventDefault();
      imgZoom.dragging = true;
      imgZoom.lastX = e.touches[0].clientX;
      imgZoom.lastY = e.touches[0].clientY;
    }
  }
}

function _imgZoomTouchMove(e) {
  if (imgZoom.pinching && e.touches.length >= 2) {
    e.preventDefault();
    const t0 = e.touches[0], t1 = e.touches[1];
    const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
    const newScale = Math.max(imgZoom.minScale, Math.min(IMG_ZOOM_MAX, imgZoom.pinchScale0 * (dist / imgZoom.pinchDist0)));
    imgZoom.scale = newScale;
    imgZoom.panX = imgZoom.pinchCX - (imgZoom.pinchCX - imgZoom.pinchPanX0) * (newScale / imgZoom.pinchScale0);
    imgZoom.panY = imgZoom.pinchCY - (imgZoom.pinchCY - imgZoom.pinchPanY0) * (newScale / imgZoom.pinchScale0);
    _clampImgZoom();
    _applyImgZoom();
  } else if (imgZoom.dragging && e.touches.length === 1) {
    e.preventDefault();
    imgZoom.panX += e.touches[0].clientX - imgZoom.lastX;
    imgZoom.panY += e.touches[0].clientY - imgZoom.lastY;
    imgZoom.lastX = e.touches[0].clientX;
    imgZoom.lastY = e.touches[0].clientY;
    _clampImgZoom();
    _applyImgZoom();
  }
}

function _imgZoomTouchEnd(e) {
  if (e.touches.length < 2) imgZoom.pinching = false;
  if (e.touches.length === 0) {
    imgZoom.dragging = false;
    _applyImgZoom();
  }
}

function _imgZoomOnResize() {
  if (!imgZoom.container) return;
  // The unzoomed size is container-relative, so it has to be measured again.
  imgZoom.baseW = 0;
  imgZoom.baseH = 0;
  _recomputeImgZoomMinScale({ resetToMin: _isAtImgZoomMin() });
}

export function openUploadedAttachmentViewer(name, contentUrl, mimeType, options = {}) {
  const isImage = String(mimeType || '').startsWith('image/');
  const isVideo = isVideoMimeType(mimeType);
  const viewerOptions = normalizeVideoPreviewOptions(options);
  setFilePreviewState({
    path: String(name || 'attachment'),
    source: 'upload',
    mode: 'preview',
    allowHtml: false,
    loading: false,
    error: '',
    viewerOptions,
    payload: {
      kind: isImage ? 'image' : (isVideo ? 'video' : 'binary'),
      name: String(name || 'attachment'),
      rawUrl: String(contentUrl || ''),
      size: 0,
      contentType: String(mimeType || '').toLowerCase(),
    },
  });
  const modal = document.getElementById('file-preview-modal');
  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');
  renderFilePreview();
}

export function setFilePreviewMode(mode) {
  const nextMode = String(mode || '').toLowerCase();
  if (nextMode !== 'preview' && nextMode !== 'raw') return;
  filePreviewState.mode = nextMode;
  renderFilePreview();
}

export function toggleFilePreviewHtml() {
  if (filePreviewState.payload?.kind !== 'markdown') return;
  filePreviewState.allowHtml = !filePreviewState.allowHtml;
  renderFilePreview();
}

export function renderFilePreview() {
  teardownImageZoom();
  teardownVideoPreview();
  const titleEl = document.getElementById('file-preview-title');
  const metaEl = document.getElementById('file-preview-meta');
  const bodyEl = document.getElementById('file-preview-body');
  const rawLink = document.getElementById('file-preview-open-raw');
  const payload = filePreviewState.payload;
  const rawHref = filePreviewState.source === 'drives'
    || filePreviewState.source === 'session'
    ? driveFileHrefFromPath(filePreviewState.path)
    : filePreviewState.source === 'upload'
      ? String(payload?.rawUrl || '')
      : `${BASE}/api/files/${filePreviewState.path.split('/').map((s) => encodeURIComponent(s)).join('/')}${currentWorkspaceScopeSuffix()}`;
  rawLink.href = rawHref || '#';
  const fallbackName = String(filePreviewState.path || '').split('/').filter(Boolean).pop() || 'download';
  rawLink.setAttribute('download', String(payload?.name || fallbackName));
  rawLink.textContent = 'Download';
  rawLink.setAttribute('title', 'Download file');

  const titlePath = filePreviewState.path || '';
  titleEl.textContent = titlePath || 'File preview';
  const fileReferenceToken = titlePath ? buildReferenceToken('file', titlePath, filePreviewState.source) : '';
  if (fileReferenceToken) {
    titleEl.setAttribute('data-copy-reference', fileReferenceToken);
    titleEl.setAttribute('title', `Click to copy \`${fileReferenceToken}\``);
    titleEl.classList.add('file-preview-title-copyable');
  } else {
    titleEl.removeAttribute('data-copy-reference');
    titleEl.removeAttribute('title');
    titleEl.classList.remove('file-preview-title-copyable');
  }
  updateFilePreviewUiState();

  if (filePreviewState.loading) {
    metaEl.textContent = 'Loading preview...';
    bodyEl.innerHTML = '<div class="file-preview-note">Fetching file preview…</div>';
    return;
  }
  if (filePreviewState.error) {
    metaEl.textContent = 'Preview failed';
    bodyEl.innerHTML = `<pre class="file-preview-code"><code>${escHtml(filePreviewState.error)}</code></pre>`;
    return;
  }
  if (!payload) {
    metaEl.textContent = 'No preview data';
    bodyEl.innerHTML = '<div class="file-preview-note">No preview available.</div>';
    return;
  }

  const kindLabel = String(payload.kind || 'text').toUpperCase();
  const langLabel = payload.language ? ` · ${payload.language}` : '';
  const truncatedLabel = payload.truncated ? ` · truncated to ${formatBytes(FILE_PREVIEW_MAX_BYTES)}` : '';
  metaEl.textContent = `${kindLabel}${langLabel} · ${formatBytes(payload.size || 0)}${truncatedLabel}`;

  if (payload.kind === 'binary') {
    bodyEl.innerHTML = '<div class="file-preview-note">Binary file preview is not shown. Use <b>Download</b> to save the file.</div>';
    return;
  }

  if (payload.kind === 'image') {
    const imageHref = filePreviewState.source === 'upload'
      ? String(payload.rawUrl || '')
      : String(rawHref || payload.rawUrl || '');
    if (imageHref) {
      bodyEl.innerHTML = `<div class="file-preview-image"><img loading="lazy" src="${escHtml(imageHref)}" alt="${escHtml(payload.name || filePreviewState.path || 'image')}"></div>`;
      bodyEl.classList.add('image-zoom-mode');
      setupImageZoom(bodyEl.querySelector('.file-preview-image'));
    } else {
      bodyEl.innerHTML = '<div class="file-preview-note">Image preview unavailable.</div>';
    }
    return;
  }

  if (filePreviewState.mode === 'raw') {
    bodyEl.innerHTML = payload.kind === 'video'
      ? '<div class="file-preview-note">Video files are binary. Use <b>Download</b> to save the file.</div>'
      : `<div class="file-preview-code"><pre><code>${escHtml(String(payload.content || ''))}</code></pre></div>`;
    return;
  }

  if (payload.kind === 'video') {
    const videoHref = String(rawHref || payload.rawUrl || '');
    const viewerOptions = filePreviewState.viewerOptions || {};
    const startSeconds = Math.max(0, Number(viewerOptions.startSeconds || 0) || 0);
    const preload = String(viewerOptions.preload || 'metadata').toLowerCase() === 'auto' ? 'auto' : 'metadata';
    const autoplay = viewerOptions.autoplay === true;
    if (videoHref) {
      bodyEl.innerHTML = `
        <div class="file-preview-video-shell" data-start-seconds="${escHtml(String(startSeconds))}" data-preload="${escHtml(preload)}">
          <video class="file-preview-video" controls playsinline preload="${escHtml(preload)}" src="${escHtml(videoHref)}"></video>
          <div class="file-preview-note">${startSeconds > 0 ? `Will start at ${startSeconds.toFixed(2)}s.` : 'Video preview ready.'} ${preload === 'auto' ? 'Preloading enabled.' : 'Metadata preload enabled.'}</div>
        </div>`;
      bodyEl.classList.add('video-preview-mode');
      const shell = bodyEl.querySelector('.file-preview-video-shell');
      const video = shell?.querySelector('video');
      if (video) {
        videoPreview.videoEl = video;
        videoPreview.onLoadedMetadata = () => {
          if (startSeconds > 0 && Number.isFinite(video.duration) && video.duration > startSeconds) {
            try {
              video.currentTime = startSeconds;
            } catch {}
          }
          if (autoplay) {
            const playPromise = video.play?.();
            if (playPromise && typeof playPromise.catch === 'function') {
              playPromise.catch(() => {});
            }
          }
        };
        videoPreview.onCanPlay = () => {
          if (autoplay && video.paused) {
            const playPromise = video.play?.();
            if (playPromise && typeof playPromise.catch === 'function') {
              playPromise.catch(() => {});
            }
          }
        };
        videoPreview.onError = () => {
          let errorNote = bodyEl.querySelector('.file-preview-video-error');
          if (!errorNote) {
            errorNote = document.createElement('div');
            errorNote.className = 'file-preview-note file-preview-video-error';
            bodyEl.appendChild(errorNote);
          }
          errorNote.innerHTML = 'Video preview unavailable. Use <b>Download</b> to save the file.';
        };
        video.addEventListener('loadedmetadata', videoPreview.onLoadedMetadata, { once: true });
        video.addEventListener('canplay', videoPreview.onCanPlay);
        video.addEventListener('error', videoPreview.onError, { once: true });
      }
    } else {
      bodyEl.innerHTML = '<div class="file-preview-note">Video preview unavailable.</div>';
    }
    return;
  }
 
  const rawText = String(payload.content || '');

  if (payload.kind === 'markdown') {
    const html = renderMarkdownPreview(rawText, filePreviewState.allowHtml);
    bodyEl.innerHTML = `<article class="file-preview-markdown">${html}</article>`;
    const article = bodyEl.querySelector('.file-preview-markdown');
    rewriteLocalAssetUrlsInNode(article, {
      preferDrive: filePreviewState.source === 'drives' || filePreviewState.source === 'session',
      rewriteAnchors: false,
    });
    assignMarkdownHeadingIds(article);
    bodyEl.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
    const fragment = String(filePreviewState.viewerOptions?.fragment || '');
    if (fragment) requestAnimationFrame(() => scrollMarkdownPreviewToFragment(fragment));
    return;
  }

  const languageClass = payload.language ? `language-${escHtml(payload.language)}` : '';
  bodyEl.innerHTML = `<div class="file-preview-code"><pre><code class="${languageClass}">${escHtml(rawText)}</code></pre></div>`;
  bodyEl.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
}

export async function openWorkspaceFilePreview(rawPath, options = {}) {
  const normalized = normalizeWorkspaceMentionPath(rawPath);
  if (!normalized) return;
  const viewerOptions = { ...normalizeVideoPreviewOptions(options), fragment: String(options?.fragment || '') };
  if (!options?.fromViewerLink) filePreviewHistory.length = 0;
  setFilePreviewState({
    path: normalized,
    source: 'workspace',
    mode: 'preview',
    allowHtml: true,
    loading: true,
    error: '',
    payload: null,
    viewerOptions,
  });
  const modal = document.getElementById('file-preview-modal');
  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');
  renderFilePreview();

  const payload = await loadWorkspaceFilePreview(normalized, currentConversationId());
  if (!payload || payload.error) {
    filePreviewState.loading = false;
    filePreviewState.error = payload?.error || 'Failed to load file preview';
    renderFilePreview();
    return false;
  }
  filePreviewState.loading = false;
  filePreviewState.payload = payload;
  filePreviewState.path = String(payload.path || normalized);
  filePreviewState.viewerOptions = viewerOptions;
  renderFilePreview();
  return true;
}

export async function openDriveFilePreview(rawPath, options = {}) {
  const normalized = normalizeDriveBrowserPath(rawPath);
  if (!normalized) return;
  const viewerOptions = { ...normalizeVideoPreviewOptions(options), fragment: String(options?.fragment || '') };
  if (!options?.fromViewerLink) filePreviewHistory.length = 0;
  setFilePreviewState({
    path: normalized,
    source: 'drives',
    mode: 'preview',
    allowHtml: true,
    loading: true,
    error: '',
    payload: null,
    viewerOptions,
  });
  const modal = document.getElementById('file-preview-modal');
  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');
  renderFilePreview();

  const payload = await loadDriveFilePreview(normalized);
  if (!payload || payload.error) {
    filePreviewState.loading = false;
    filePreviewState.error = payload?.error || 'Failed to load drive file preview';
    renderFilePreview();
    return false;
  }
  filePreviewState.loading = false;
  filePreviewState.payload = payload;
  filePreviewState.path = String(payload.path || normalized);
  filePreviewState.source = 'drives';
  filePreviewState.viewerOptions = viewerOptions;
  renderFilePreview();
  return true;
}

export async function openWorkspaceFilePreviewFromRepo(rawPath, options = {}) {
  if (repoBrowserState.activeRoot !== 'workspace') {
    await openDriveFilePreview(rawPath, options);
    return;
  }
  await openWorkspaceFilePreview(rawPath, options);
}

export function closeFilePreview() {
  teardownImageZoom();
  teardownVideoPreview();
  const modal = document.getElementById('file-preview-modal');
  modal.classList.remove('visible');
  modal.setAttribute('aria-hidden', 'true');
  filePreviewHistory.length = 0;
}

export function goBackFilePreview() {
  const previous = filePreviewHistory.pop();
  if (!previous) return;
  setFilePreviewState(previous);
  renderFilePreview();
  requestAnimationFrame(() => {
    const bodyEl = document.getElementById('file-preview-body');
    if (bodyEl) bodyEl.scrollTop = Number(previous.scrollTop || 0);
  });
}

async function openFilePreviewLink(anchor) {
  const target = resolveFilePreviewLink(anchor.getAttribute('href'), filePreviewState.path);
  if (target.kind === 'fragment') {
    scrollMarkdownPreviewToFragment(target.fragment);
    return;
  }
  if (target.kind !== 'file') return;

  const snapshot = snapshotFilePreviewState();
  filePreviewHistory.push(snapshot);
  renderFilePreview();
  const loaded = filePreviewState.source === 'workspace'
    ? await openWorkspaceFilePreview(target.path, { fromViewerLink: true, fragment: target.fragment })
    : await openDriveFilePreview(target.path, { fromViewerLink: true, fragment: target.fragment });
  if (loaded) return;
  filePreviewHistory.pop();
  setFilePreviewState(snapshot);
  renderFilePreview();
}

export function normalizeRepoPath(pathValue) {
  if (pathValue === '' || pathValue === null || pathValue === undefined) return '';
  if (repoBrowserState.activeRoot !== 'workspace') {
    return normalizeDriveBrowserPath(pathValue);
  }
  return normalizeWorkspaceMentionPath(pathValue);
}

function joinWindowsPath(basePath, relativePath) {
  const root = String(basePath || '').trim().replace(/[\\/]+$/, '');
  const rel = String(relativePath || '').trim().replace(/^[\\/]+/, '').replace(/\//g, '\\');
  if (!root) return rel;
  if (!rel) return root;
  return `${root}\\${rel}`;
}

export function getRepoBrowserLaunchCwdPath() {
  const currentPath = String(repoBrowserState.currentPath || '').trim();
  const activeWorkspaceRoot = currentWorkspaceRootPathForSelection();
  if (!currentPath) return activeWorkspaceRoot;
  if (repoBrowserState.activeRoot === 'workspace') {
    return joinWindowsPath(activeWorkspaceRoot, currentPath);
  }
  return normalizeDriveBrowserPath(currentPath) || currentPath.replace(/\\/g, '/');
}

export function repoNodeMapFromTree(root) {
  const map = new Map();
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    const nodePath = String(node.path || '');
    map.set(nodePath, node);
    if (node.type === 'dir' && Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  }
  walk(root);
  return map;
}

export function repoRawHref(pathValue) {
  if (repoBrowserState.activeRoot !== 'workspace') {
    return `${BASE}/api/drives/file?path=${encodeURIComponent(String(pathValue || ''))}`;
  }
  return `${BASE}/api/files/${String(pathValue || '').split('/').map((segment) => encodeURIComponent(segment)).join('/')}${currentWorkspaceScopeSuffix()}`;
}

export function repoIcon(node) {
  if (!node || typeof node !== 'object') return '📄';
  if (node.type === 'dir') {
    if (node.driveType === 'fixed') return '💽';
    if (node.driveType === 'removable') return '💾';
    return '📁';
  }
  const kind = String(node.previewKind || '').toLowerCase();
  if (kind === 'image') return '🖼️';
  if (kind === 'video') return '🎞️';
  if (kind === 'markdown') return '📝';
  if (kind === 'code') return '💻';
  if (kind === 'binary') return '📦';
  return '📄';
}

function updateRepoToolbarUi() {
  const workspaceRootBtn = document.getElementById('repo-root-workspace-btn');
  const drivesRootBtn = document.getElementById('repo-root-drives-btn');
  const sessionRootBtn = document.getElementById('repo-root-session-btn');
  const listBtn = document.getElementById('repo-view-list-btn');
  const gridBtn = document.getElementById('repo-view-grid-btn');
  const hiddenBtn = document.getElementById('repo-toggle-hidden-btn');
  const heavyBtn = document.getElementById('repo-toggle-heavy-btn');
  if (!workspaceRootBtn || !drivesRootBtn || !sessionRootBtn || !listBtn || !gridBtn || !hiddenBtn || !heavyBtn) {
    return;
  }
  const workspaceRoot = repoBrowserState.activeRoot === 'workspace';
  const sessionRoot = repoBrowserState.activeRoot === 'session';
  workspaceRootBtn.classList.toggle('active', workspaceRoot);
  drivesRootBtn.classList.toggle('active', repoBrowserState.activeRoot === 'drives');
  sessionRootBtn.classList.toggle('active', sessionRoot);
  drivesRootBtn.disabled = false;
  sessionRootBtn.disabled = !repoBrowserState.sessionRootPath;
  listBtn.classList.toggle('active', repoBrowserState.viewMode === 'list');
  gridBtn.classList.toggle('active', repoBrowserState.viewMode === 'grid');
  const hiddenEnabled = workspaceRoot
    ? repoBrowserState.workspaceIncludeHidden
    : repoBrowserState.drivesIncludeHidden;
  hiddenBtn.classList.toggle('active', hiddenEnabled);
  hiddenBtn.textContent = workspaceRoot
    ? `Hidden: ${hiddenEnabled ? 'On' : 'Off'}`
    : `Hidden/System: ${hiddenEnabled ? 'On' : 'Off'}`;
  heavyBtn.disabled = !workspaceRoot;
  heavyBtn.classList.toggle('active', workspaceRoot && repoBrowserState.workspaceIncludeHeavy);
  heavyBtn.textContent = workspaceRoot
    ? `Heavy: ${repoBrowserState.workspaceIncludeHeavy ? 'On' : 'Off'}`
    : 'Heavy: n/a';
}

export function renderRepoTreeNode(node) {
  if (!node || typeof node !== 'object') return '';
  const nodePath = String(node.path || '');
  const icon = repoIcon(node);
  if (node.type === 'dir') {
    const children = Array.isArray(node.children)
      ? node.children.filter((child) => child?.type === 'dir')
      : [];
    const currentPath = String(repoBrowserState.currentPath || '');
    const isLinuxRoot = nodePath === '/';
    const isCollapsed = repoBrowserState.collapsedPaths instanceof Set && repoBrowserState.collapsedPaths.has(nodePath);
    const isExpanded = repoBrowserState.expandedPaths instanceof Set && repoBrowserState.expandedPaths.has(nodePath);
    const isOpen = !isCollapsed && (nodePath === ''
      || isExpanded
      || currentPath === nodePath
      || (isLinuxRoot
        ? currentPath.startsWith('/')
        : (currentPath && currentPath.startsWith(`${nodePath}/`))));
    const openAttr = isOpen ? ' open' : '';
    const loading = !!node.loadingChildren;
    const lazyUnloaded = !!node.lazy && !node.childrenLoaded;
    const childrenHtml = loading
      ? ''
      : (lazyUnloaded
        ? '<div class="repo-empty">Expand to load entries…</div>'
        : children.map(renderRepoTreeNode).join(''));
    return `<details class="repo-tree-node" data-repo-dir-path="${escHtml(nodePath)}"${openAttr}>
      <summary class="repo-tree-summary" data-repo-open-dir="${escHtml(nodePath)}">${icon} ${escHtml(node.name || '/')}</summary>
      <div class="repo-tree-children">${childrenHtml}</div>
    </details>`;
  }
  return '';
}

export function updateRepoTreeSelection() {
  const currentPath = String(repoBrowserState.currentPath || '');
  const summaries = document.querySelectorAll('#repo-tree .repo-tree-summary[data-repo-open-dir]');
  summaries.forEach((el) => {
    const pathValue = String(el.getAttribute('data-repo-open-dir') || '');
    el.classList.toggle('active', pathValue === currentPath);
  });
}

export function syncRepoTreeToCurrentPath(collapseOthers = false) {
  const currentPath = String(repoBrowserState.currentPath || '');
  const treeHost = document.getElementById('repo-tree');
  if (!treeHost) return;
  const ancestorPaths = new Set(repoAncestorPaths(currentPath));
  const details = treeHost.querySelectorAll('details.repo-tree-node[data-repo-dir-path]');
  details.forEach((el) => {
    const pathValue = String(el.getAttribute('data-repo-dir-path') || '');
    const isCollapsed = repoBrowserState.collapsedPaths instanceof Set && repoBrowserState.collapsedPaths.has(pathValue);
    const isExpanded = repoBrowserState.expandedPaths instanceof Set && repoBrowserState.expandedPaths.has(pathValue);
    if (!isCollapsed && (ancestorPaths.has(pathValue) || isExpanded)) {
      el.open = true;
    } else if (collapseOthers) {
      el.open = false;
    }
  });
  // Reveal the active node only when the selection actually moved (or on an
  // explicit focus): scrolling on every render yanks the pane back while the
  // user is scrolling it themselves.
  if (currentPath === lastTreeScrolledPath && !collapseOthers) return;
  lastTreeScrolledPath = currentPath;
  const activeEl = treeHost.querySelector('.repo-tree-summary.active, .repo-tree-file.active');
  if (activeEl) {
    activeEl.scrollIntoView({ block: 'nearest' });
  } else {
    const activeSummary = treeHost.querySelector(`.repo-tree-summary[data-repo-open-dir="${CSS.escape(currentPath)}"]`);
    if (activeSummary) activeSummary.scrollIntoView({ block: 'nearest' });
  }
}

export function focusRepoTree() {
  if (repoBrowserState.expandedPaths instanceof Set) {
    repoBrowserState.expandedPaths.clear();
  }
  syncRepoTreeToCurrentPath(true);
}

export function renderRepoBreadcrumb() {
  const rootLabel = repoBrowserState.rootName || 'repo';
  const pathValue = String(repoBrowserState.currentPath || '');
  const host = document.getElementById('repo-folder-breadcrumb');
  if (!host) return;
  const rootSource = repoBrowserState.activeRoot === 'workspace' ? 'workspace' : 'drives';
  const parts = pathValue ? pathValue.split('/').filter(Boolean) : [];
  const chips = [`<button class="repo-crumb" data-repo-nav-dir="">${escHtml(rootLabel)}</button>`];
  let rolling = '';
  for (const part of parts) {
    rolling = rolling ? `${rolling}/${part}` : part;
    chips.push(`<span>/</span><button class="repo-crumb" data-repo-nav-dir="${escHtml(rolling)}">${escHtml(part)}</button>`);
  }
  if (pathValue) {
    chips.push(
      `<button class="repo-crumb repo-copy-ref-btn" data-repo-copy-folder="${escHtml(pathValue)}" data-repo-copy-source="${escHtml(rootSource)}" title="Copy folder reference">Copy \`@folder\`</button>`,
    );
  }
  host.innerHTML = chips.join('');
}

export function renderRepoFolder() {
  const folderHost = document.getElementById('repo-folder');
  const statusHost = document.getElementById('repo-tree-status');
  if (!folderHost || !statusHost) return;
  if (repoBrowserState.loading && !repoBrowserState.tree) {
    folderHost.innerHTML = '<div class="repo-empty">Loading explorer tree…</div>';
    statusHost.textContent = 'Loading…';
    return;
  }
  if (repoBrowserState.error) {
    folderHost.innerHTML = `<div class="repo-empty">${escHtml(repoBrowserState.error)}</div>`;
    statusHost.textContent = 'Error';
    return;
  }
  const nodeLabel = repoBrowserState.activeRoot === 'workspace' ? 'nodes' : 'entries';
  statusHost.textContent = `${repoBrowserState.nodeCount || 0} ${nodeLabel}${repoBrowserState.truncated ? ' (truncated)' : ''}`;
  const currentPath = String(repoBrowserState.currentPath || '');
  let node = repoBrowserState.nodeMap.get(currentPath) || null;
  if (!node || node.type !== 'dir') {
    node = repoBrowserState.nodeMap.get('') || null;
  }
  if (!node || node.type !== 'dir') {
    folderHost.innerHTML = '<div class="repo-empty">No explorer tree available.</div>';
    return;
  }
  if (node.loadingChildren) {
    folderHost.innerHTML = '<div class="repo-empty">Loading folder entries…</div>';
    return;
  }
  if (node.lazy && !node.childrenLoaded) {
    folderHost.innerHTML = '<div class="repo-empty">Open this folder to load entries.</div>';
    return;
  }
  const children = Array.isArray(node.children)
    ? node.children.filter((child) => child?.type !== 'dir')
    : [];
  if (!children.length) {
    folderHost.innerHTML = '<div class="repo-empty">This folder has no files.</div>';
    return;
  }

  const isGrid = repoBrowserState.viewMode === 'grid';
  const wrapperClass = isGrid ? 'repo-folder-grid' : 'repo-folder-list';
  const rows = children.map((child) => {
    const childPath = String(child.path || '');
    const rawHref = repoRawHref(childPath);
    const icon = repoIcon(child);
    if (isGrid) {
      const ext = String(child.ext || '').replace('.', '');
      const isImage = String(child.previewKind || '').toLowerCase() === 'image' || REPO_IMAGE_EXTENSIONS.has(ext.toLowerCase());
      const thumb = isImage && rawHref
        ? `<img loading="lazy" src="${escHtml(rawHref)}" alt="${escHtml(child.name || '')}">`
        : `<span>${icon}</span>`;
      const fileMeta = `${String(child.previewKind || 'file')} · ${formatBytes(child.size || 0)}`;
      return `<div class="repo-card repo-card-clickable" data-repo-open-file="${escHtml(childPath)}">
        <div class="repo-card-thumb">${thumb}</div>
        <div class="repo-card-name" title="${escHtml(child.name || childPath)}">${escHtml(child.name || childPath)}</div>
        <div class="repo-entry-meta">${escHtml(fileMeta)}</div>
      </div>`;
    }

    const mainMeta = `${String(child.previewKind || 'file')} · ${formatBytes(child.size || 0)}`;
    return `<div class="repo-entry-row repo-entry-row-clickable" data-repo-open-file="${escHtml(childPath)}">
      <div class="repo-entry-main">
        <span>${icon}</span>
        <div style="min-width:0">
          <div class="repo-entry-name" title="${escHtml(child.name || childPath)}">${escHtml(child.name || childPath)}</div>
          <div class="repo-entry-meta">${escHtml(mainMeta)}</div>
        </div>
      </div>
    </div>`;
  }).join('');

  const savedScrollTop = folderHost.scrollTop;
  folderHost.innerHTML = `<div class="${wrapperClass}">${rows}</div>`;
  folderHost.scrollTop = savedScrollTop;
}

export function renderRepoTree() {
  const treeHost = document.getElementById('repo-tree');
  if (!treeHost) return;
  if (repoBrowserState.loading && !repoBrowserState.tree) {
    treeHost.innerHTML = '<div class="repo-empty">Loading tree…</div>';
    return;
  }
  if (repoBrowserState.error) {
    treeHost.innerHTML = `<div class="repo-empty">${escHtml(repoBrowserState.error)}</div>`;
    return;
  }
  const root = repoBrowserState.tree;
  if (!root) {
    treeHost.innerHTML = '<div class="repo-empty">Tree unavailable.</div>';
    return;
  }
  // The rebuild resets the pane's scroll to 0; put it back so re-renders
  // (child loads, refreshes) don't rubber-band a scroll in progress.
  const savedScrollTop = treeHost.scrollTop;
  treeHost.innerHTML = renderRepoTreeNode(root);
  updateRepoTreeSelection();
  treeHost.scrollTop = savedScrollTop;
  syncRepoTreeToCurrentPath();
}

export function renderRepoBrowser() {
  if (repoBrowserRenderSuspended > 0) {
    repoBrowserRenderDirty = true;
    return;
  }
  const title = document.querySelector('.repo-browser-title');
  if (title) {
    title.textContent = repoBrowserState.activeRoot === 'workspace'
      ? 'Repository Browser'
      : (repoBrowserState.activeRoot === 'session' ? 'Session Browser' : 'Drives Browser');
  }
  updateRepoToolbarUi();
  renderRepoBreadcrumb();
  renderRepoTree();
  renderRepoFolder();
}

export async function loadRepoBrowserTree() {
  if (repoBrowserState.loading) {
    repoBrowserReloadQueued = true;
    return;
  }
  repoBrowserReloadQueued = false;
  repoBrowserState.loading = true;
  repoBrowserState.loadingPath = '';
  repoBrowserState.error = '';
  renderRepoBrowser();

  const workspaceRoot = repoBrowserState.activeRoot === 'workspace';
  const sessionRoot = repoBrowserState.activeRoot === 'session';
  const requestedConversationId = workspaceRoot ? currentConversationId() : '';
  const payload = workspaceRoot
    ? await loadRepoTree(repoBrowserState.workspaceIncludeHidden, repoBrowserState.workspaceIncludeHeavy, requestedConversationId)
    : (sessionRoot
      ? await loadSessionRootTree(normalizeDriveBrowserPath(repoBrowserState.sessionRootPath), repoBrowserState.drivesIncludeHidden)
      : await loadDrivesRoots());
  if (workspaceRoot && requestedConversationId !== currentConversationId()) {
    repoBrowserState.loading = false;
    repoBrowserReloadQueued = true;
    flushQueuedRepoBrowserReload();
    return;
  }
  const rootNode = payload?.root || payload?.node || null;
  if (!payload || payload.error || !rootNode) {
    repoBrowserState.loading = false;
    repoBrowserState.error = payload?.error || (workspaceRoot ? 'Failed to load repository tree.' : (sessionRoot ? 'Failed to load session tree.' : 'Failed to load drives.'));
    pendingRepoBrowserRestore = null;
    renderRepoBrowser();
    flushQueuedRepoBrowserReload();
    return;
  }

  repoBrowserState.loading = false;
  repoBrowserState.rootName = String(payload.rootName || (workspaceRoot ? 'repo' : (sessionRoot ? repoBrowserState.sessionRootName || 'Session' : 'Drives')));
  repoBrowserState.tree = rootNode;
  repoBrowserState.nodeMap = repoNodeMapFromTree(rootNode);
  repoBrowserState.truncated = !!payload.truncated;
  repoBrowserState.nodeCount = Number(payload.nodeCount || repoBrowserState.nodeMap.size || 0);
  repoBrowserState.maxNodes = Number(payload.maxNodes || repoBrowserState.nodeMap.size || 0);
  if (sessionRoot) {
    repoBrowserState.currentPath = String(rootNode.path || repoBrowserState.sessionRootPath || '');
    if (rootNode && typeof rootNode === 'object') {
      rootNode.childrenLoaded = true;
      rootNode.lazy = false;
    }
  } else if (!workspaceRoot && rootNode?.path && repoBrowserState.nodeMap.has(String(rootNode.path))) {
    repoBrowserState.currentPath = String(rootNode.path);
  } else if (!repoBrowserState.nodeMap.has(repoBrowserState.currentPath)) {
    repoBrowserState.currentPath = '';
  }
  if (repoBrowserState.expandedPaths instanceof Set) {
    const selectedPath = String(repoBrowserState.currentPath || '');
    if (selectedPath) repoBrowserState.expandedPaths.add(selectedPath);
  }
  renderRepoBrowser();
  // Read the queue flag before flushing: flushQueuedRepoBrowserReload re-enters
  // this function synchronously. When another load is already queued, leave the
  // restore parked so that load performs it against the tree it actually
  // fetched — that is what makes a rapid double-toggle safe.
  const restoreNow = repoBrowserReloadQueued ? null : takePendingRepoBrowserRestore();
  flushQueuedRepoBrowserReload();
  if (restoreNow) void applyRepoBrowserRestore(restoreNow);
}

export async function ensureRepoChildrenLoaded(pathValue) {
  if (pathValue === null || pathValue === undefined) return false;
  const normalizedPath = normalizeRepoPath(pathValue);
  const nodePath = normalizedPath || '';
  if (!nodePath && repoBrowserState.activeRoot !== 'workspace') return false;

  const node = repoBrowserState.nodeMap.get(nodePath);
  if (!node || node.type !== 'dir') return false;
  if (node.childrenLoaded) return true;
  if (node.loadingChildren) return false;

  node.loadingChildren = true;
  repoBrowserState.loadingPath = nodePath;
  renderRepoBrowser();
  const treeAtRequest = repoBrowserState.tree;

  const payload = repoBrowserState.activeRoot === 'workspace'
    ? await loadRepoChildren(
      nodePath,
      repoBrowserState.workspaceIncludeHidden,
      repoBrowserState.workspaceIncludeHeavy,
      currentConversationId(),
    )
    : await loadDriveChildren(nodePath, repoBrowserState.drivesIncludeHidden);

  node.loadingChildren = false;
  repoBrowserState.loadingPath = '';
  // The tree can be swapped out mid-fetch by a reload; writing onto the
  // orphaned node object would silently drop the children. Attach to the node
  // that now lives at the same path, or bail if the path is gone.
  const target = repoBrowserState.tree === treeAtRequest
    ? node
    : repoBrowserState.nodeMap.get(nodePath) || null;
  if (!target || target.type !== 'dir') {
    renderRepoBrowser();
    return false;
  }
  target.loadingChildren = false;
  if (!payload || payload.error || !payload.node || !Array.isArray(payload.node.children)) {
    target.children = [];
    target.childrenLoaded = true;
    target.readError = true;
    renderRepoBrowser();
    return false;
  }

  target.children = payload.node.children;
  target.childrenLoaded = true;
  target.lazy = false;
  target.readError = !!payload.node.readError;
  repoBrowserState.nodeMap = repoNodeMapFromTree(repoBrowserState.tree);
  repoBrowserState.nodeCount = repoBrowserState.nodeMap.size;
  renderRepoBrowser();
  return true;
}

/**
 * Re-open, on the freshly fetched tree, whatever was open before a refresh.
 *
 * The chain is walked sequentially on purpose: ensureRepoChildrenLoaded rebuilds
 * nodeMap on every success, and a child directory only becomes reachable once
 * its parent's children have landed.
 */
async function applyRepoBrowserRestore({ path: keepPath = '', seq = 0 } = {}) {
  const expandedPaths = repoBrowserState.expandedPaths instanceof Set
    ? [...repoBrowserState.expandedPaths]
    : [];
  const plan = planRepoRehydration({ currentPath: keepPath, expandedPaths });
  const pathAtStart = String(repoBrowserState.currentPath || '');

  await withSuspendedRepoRender(async () => {
    for (const nodePath of plan) {
      if (seq !== repoBrowserRefreshSeq) return;
      if (!nodePath) continue;
      // A directory that vanished with the filter change is simply unknown to
      // the new nodeMap, and this returns false without touching the network.
      await ensureRepoChildrenLoaded(nodePath);
    }
  });

  if (seq !== repoBrowserRefreshSeq) return;
  if (String(repoBrowserState.currentPath || '') !== pathAtStart) {
    renderRepoBrowser();
    return;
  }
  const resolvedPath = deepestExistingAncestor(keepPath, (candidate) => {
    const node = repoBrowserState.nodeMap.get(candidate);
    return !!node && node.type === 'dir';
  });
  if (resolvedPath) await setRepoCurrentPath(resolvedPath);
  else renderRepoBrowser();
}

export async function ensureDriveChildrenLoaded(pathValue) {
  return ensureRepoChildrenLoaded(pathValue);
}

export async function ensureWorkspaceChildrenLoaded(pathValue) {
  return ensureRepoChildrenLoaded(pathValue);
}

export function setRepoBrowserRoot(root) {
  const nextRoot = String(root || '').trim().toLowerCase();
  if (nextRoot !== 'workspace' && nextRoot !== 'drives' && nextRoot !== 'session') return;
  if (nextRoot === 'session' && !repoBrowserState.sessionRootPath) return;
  if (repoBrowserState.activeRoot === nextRoot) return;
  repoBrowserState.activeRoot = nextRoot;
  // A root switch invalidates any parked restore: the saved path belongs to the
  // tree we are leaving. The Set wipes below are correct here for the same reason.
  pendingRepoBrowserRestore = null;
  setRepoBrowserState({
    tree: null,
    nodeMap: new Map(),
    expandedPaths: new Set(),
    collapsedPaths: new Set(),
    currentPath: '',
    truncated: false,
    nodeCount: 0,
    maxNodes: 0,
    loadingPath: '',
    error: '',
  });
  renderRepoBrowser();
  if (repoBrowserState.open) {
    void loadRepoBrowserTree();
  }
}

export function setRepoBrowserSessionInfo(sessionRootPath, sessionRootName = '') {
  const nextPath = normalizeDriveBrowserPath(sessionRootPath);
  const nextName = String(sessionRootName || '').trim() || 'Session';
  const pathChanged = repoBrowserState.sessionRootPath !== nextPath;
  repoBrowserState.sessionRootPath = nextPath;
  repoBrowserState.sessionRootName = nextName;
  const sessionRootActive = repoBrowserState.activeRoot === 'session';
  if (pathChanged && sessionRootActive) {
    pendingRepoBrowserRestore = null;
    setRepoBrowserState({
      tree: null,
      nodeMap: new Map(),
      expandedPaths: new Set(),
      collapsedPaths: new Set(),
      currentPath: '',
      truncated: false,
      nodeCount: 0,
      maxNodes: 0,
      loadingPath: '',
      error: '',
    });
  }
  if (!nextPath && sessionRootActive) {
    repoBrowserState.activeRoot = 'workspace';
    if (repoBrowserState.open) {
      void loadRepoBrowserTree();
      return;
    }
    renderRepoBrowser();
    return;
  }
  if (repoBrowserState.open) {
    if (sessionRootActive && pathChanged) {
      void loadRepoBrowserTree();
      return;
    }
    renderRepoBrowser();
    return;
  }
  if (sessionRootActive) {
    renderRepoBrowser();
  }
}

export function openRepoBrowser() {
  const modal = document.getElementById('repo-browser-modal');
  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');
  repoBrowserState.open = true;
  if (repoBrowserState.activeRoot === 'workspace') {
    void loadRepoBrowserTree();
  } else if (!repoBrowserState.tree) {
    void loadRepoBrowserTree();
  } else {
    renderRepoBrowser();
  }
}

export function closeRepoBrowser() {
  const modal = document.getElementById('repo-browser-modal');
  modal.classList.remove('visible');
  modal.setAttribute('aria-hidden', 'true');
  repoBrowserState.open = false;
}

export function refreshRepoBrowser() {
  // expandedPaths / collapsedPaths deliberately survive: a refresh refetches the
  // same root, so the user's expansion is still meaningful. applyRepoBrowserRestore
  // re-walks it once the new tree arrives.
  pendingRepoBrowserRestore = {
    path: String(repoBrowserState.currentPath || ''),
    seq: (repoBrowserRefreshSeq += 1),
  };
  setRepoBrowserState({
    tree: null,
    nodeMap: new Map(),
    currentPath: '',
    loadingPath: '',
    error: '',
  });
  void loadRepoBrowserTree();
}

export function refreshRepoBrowserIfWorkspaceOpen() {
  if (!repoBrowserState.open || repoBrowserState.activeRoot !== 'workspace') return;
  refreshRepoBrowser();
}

export function resetWorkspaceRepoBrowserForRootChange() {
  // A CWD change repoints the workspace root, so every cached path (tree,
  // selection, expansion) belongs to a directory the browser no longer shows.
  // Dropping them is what stops the explorer from rendering the old CWD after a
  // relaunch.
  if (repoBrowserState.activeRoot !== 'workspace') return;
  pendingRepoBrowserRestore = null;
  repoBrowserState.expandedPaths = new Set();
  repoBrowserState.collapsedPaths = new Set();
  setRepoBrowserState({
    tree: null,
    nodeMap: new Map(),
    currentPath: '',
    loadingPath: '',
    error: '',
    rootName: 'repo',
  });
  if (repoBrowserState.open) {
    void loadRepoBrowserTree();
  } else {
    renderRepoBrowser();
  }
}

export function setRepoBrowserViewMode(mode) {
  const value = String(mode || '').toLowerCase();
  if (value !== 'list' && value !== 'grid') return;
  repoBrowserState.viewMode = value;
  renderRepoFolder();
  updateRepoToolbarUi();
}

export function toggleRepoBrowserHidden() {
  const nextValue = repoBrowserState.activeRoot === 'workspace'
    ? !repoBrowserState.workspaceIncludeHidden
    : !repoBrowserState.drivesIncludeHidden;
  if (repoBrowserState.activeRoot === 'workspace') {
    repoBrowserState.workspaceIncludeHidden = nextValue;
  } else {
    repoBrowserState.drivesIncludeHidden = nextValue;
  }
  writeRepoBrowserHiddenPreference(repoBrowserState.activeRoot, nextValue);
  refreshRepoBrowser();
}

export function toggleRepoBrowserHeavy() {
  if (repoBrowserState.activeRoot !== 'workspace') return;
  repoBrowserState.workspaceIncludeHeavy = !repoBrowserState.workspaceIncludeHeavy;
  writeRepoBrowserHeavyPreference(repoBrowserState.workspaceIncludeHeavy);
  refreshRepoBrowser();
}

export async function setRepoCurrentPath(pathValue) {
  const rawValue = String(pathValue || '').replace(/\\/g, '/').trim();
  const normalized = normalizeRepoPath(rawValue);
  const targetPath = repoBrowserState.nodeMap.has(rawValue)
    ? rawValue
    : (normalized || '');
  const node = repoBrowserState.nodeMap.get(targetPath);
  if (!node || node.type !== 'dir') return;
  if (repoBrowserState.expandedPaths instanceof Set) {
    for (const ancestor of repoAncestorPaths(targetPath)) {
      if (ancestor) repoBrowserState.expandedPaths.add(ancestor);
    }
  }
  if (repoBrowserState.collapsedPaths instanceof Set) {
    repoBrowserState.collapsedPaths.delete(targetPath);
  }
  repoBrowserState.currentPath = targetPath;
  await ensureRepoChildrenLoaded(targetPath);
  renderRepoBreadcrumb();
  renderRepoFolder();
  updateRepoTreeSelection();
  syncRepoTreeToCurrentPath();
}

document.addEventListener('click', (event) => {
  const anchor = eventClosest(event, 'a.workspace-file-link[data-workspace-path]');
  if (!anchor) return;
  event.preventDefault();
  void openWorkspaceFilePreview(anchor.dataset.workspacePath || '');
});

document.getElementById('file-preview-modal').addEventListener('click', (event) => {
  if (event.target.id === 'file-preview-modal') closeFilePreview();
});

document.getElementById('file-preview-body').addEventListener('click', (event) => {
  const anchor = eventClosest(event, '.file-preview-markdown a[href]');
  if (!anchor) return;
  const target = resolveFilePreviewLink(anchor.getAttribute('href'), filePreviewState.path);
  if (target.kind === 'external') {
    event.preventDefault();
    openExternalNavigation(anchor.href, (url) => {
      window.dispatchEvent(new CustomEvent('copilot:external-link-fallback', { detail: { url } }));
    });
    return;
  }
  event.preventDefault();
  void openFilePreviewLink(anchor);
});

document.getElementById('summary-modal').addEventListener('click', (event) => {
  if (event.target.id === 'summary-modal') window.closeSummaryModal?.();
});

document.getElementById('file-preview-title').addEventListener('click', async (event) => {
  const target = event.currentTarget;
  const token = String(target?.getAttribute('data-copy-reference') || '').trim();
  if (!token) return;
  event.preventDefault();
  const wrapped = `\`${token}\``;
  try {
    await copyTextToClipboard(wrapped);
  } catch {}
});

document.getElementById('repo-browser-modal').addEventListener('click', (event) => {
  if (event.target.id === 'repo-browser-modal') closeRepoBrowser();
});

document.getElementById('repo-tree').addEventListener('click', (event) => {
  const fileButton = eventClosest(event, '[data-repo-open-file]');
  if (fileButton) {
    event.preventDefault();
    void openWorkspaceFilePreviewFromRepo(fileButton.getAttribute('data-repo-open-file') || '');
    return;
  }
  const dirSummary = eventClosest(event, '[data-repo-open-dir]');
  if (dirSummary) {
    event.preventDefault();
    const dirPath = dirSummary.getAttribute('data-repo-open-dir') || '';
    const normalizedDirPath = normalizeRepoPath(dirPath);
    const targetPath = repoBrowserState.nodeMap.has(dirPath) ? dirPath : (normalizedDirPath || '');
    const node = repoBrowserState.nodeMap.get(targetPath);
    const isDir = !!node && node.type === 'dir';
    const isCurrent = String(repoBrowserState.currentPath || '') === targetPath;
    const isCollapsed = repoBrowserState.collapsedPaths instanceof Set && repoBrowserState.collapsedPaths.has(targetPath);
    if (isDir && isCurrent && !isCollapsed && targetPath) {
      if (repoBrowserState.expandedPaths instanceof Set) {
        repoBrowserState.expandedPaths.delete(targetPath);
      }
      repoBrowserState.collapsedPaths.add(targetPath);
      renderRepoTree();
      return;
    }
    if (repoBrowserState.expandedPaths instanceof Set && targetPath) {
      repoBrowserState.expandedPaths.add(targetPath);
    }
    if (repoBrowserState.collapsedPaths instanceof Set) {
      repoBrowserState.collapsedPaths.delete(targetPath);
    }
    void setRepoCurrentPath(dirPath);
  }
});

document.getElementById('repo-folder').addEventListener('click', (event) => {
  const navDir = eventClosest(event, '[data-repo-nav-dir]');
  if (navDir) {
    event.preventDefault();
    void setRepoCurrentPath(navDir.getAttribute('data-repo-nav-dir') || '');
    return;
  }
  const openFile = eventClosest(event, '[data-repo-open-file]');
  if (openFile) {
    event.preventDefault();
    void openWorkspaceFilePreviewFromRepo(openFile.getAttribute('data-repo-open-file') || '');
  }
});

document.getElementById('repo-folder-breadcrumb').addEventListener('click', (event) => {
  const copyFolder = eventClosest(event, '[data-repo-copy-folder]');
  if (copyFolder) {
    event.preventDefault();
    const folderPath = copyFolder.getAttribute('data-repo-copy-folder') || '';
    const source = copyFolder.getAttribute('data-repo-copy-source') || repoBrowserState.activeRoot;
    void copyReferenceTokenToClipboard('folder', folderPath, source);
    return;
  }
  const navDir = eventClosest(event, '[data-repo-nav-dir]');
  if (!navDir) return;
  event.preventDefault();
  void setRepoCurrentPath(navDir.getAttribute('data-repo-nav-dir') || '');
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const modal = document.getElementById('file-preview-modal');
  const repoModal = document.getElementById('repo-browser-modal');
  const summaryModal = document.getElementById('summary-modal');
  if (modal.classList.contains('visible')) closeFilePreview();
  else if (repoModal.classList.contains('visible')) closeRepoBrowser();
  else if (summaryModal.classList.contains('visible')) window.closeSummaryModal?.();
});
