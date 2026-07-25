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
} from './api-client.js';
import {
  normalizeWorkspaceMentionPath,
  normalizeDriveBrowserPath,
  driveFileHrefFromPath,
  workspacePreviewApiPath,
  drivePreviewApiPath,
  renderMarkdownPreview,
  buildReferenceToken,
  copyTextToClipboard,
  copyReferenceTokenToClipboard,
  eventClosest,
} from './router.js';

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
    return;
  }

  el.innerHTML = selectedAttachments.map((att, idx) => `
    <div class="attachment-preview-item">
      <button class="attachment-preview-remove" onclick="removeAttachment(${idx})" title="Remove">×</button>
      ${att.isImage && att.previewUrl ? `<img src="${att.previewUrl}" alt="${escHtml(att.name)}">` : `<div class="attachment-preview-meta" style="height:88px;display:flex;align-items:center;justify-content:center">📎</div>`}
      <div class="attachment-preview-meta">${escHtml(att.name)}${att.size ? ` · ${formatBytes(att.size)}` : ''}</div>
    </div>
  `).join('');
  el.classList.add('visible');
  window.syncComposerControlState?.();
}

export function removeAttachment(idx) {
  const [removed] = selectedAttachments.splice(idx, 1);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  renderAttachmentPreview();
}

export function clearAttachments() {
  for (const att of selectedAttachments) {
    if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
  }
  selectedAttachments.length = 0;
  renderAttachmentPreview();
}

export async function handleAttachmentInput(files) {
  const inputFiles = Array.from(files || []);
  if (!inputFiles.length) return;

  const next = [];
  for (const file of inputFiles) {
    next.push({
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: Number(file.size || 0),
      file,
      isImage: String(file.type || '').startsWith('image/'),
      previewUrl: String(file.type || '').startsWith('image/') ? URL.createObjectURL(file) : '',
    });
  }

  const merged = selectedAttachments.concat(next);
  const dropped = merged.slice(MAX_UPLOAD_ATTACHMENTS);
  for (const att of dropped) {
    if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
  }
  selectedAttachments.length = 0;
  selectedAttachments.push(...merged.slice(0, MAX_UPLOAD_ATTACHMENTS));
  renderAttachmentPreview();
}

export async function uploadAttachments(files) {
  const items = Array.isArray(files) ? files : [];
  const uploaded = [];
  for (const item of items) {
    if (!item?.file) continue;
    const payload = await uploadAttachment(item);
    if (!payload?.attachment) throw new Error('Upload returned no attachment');
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
  htmlBtn.textContent = filePreviewState.allowHtml ? 'Disable embedded HTML' : 'Enable embedded HTML';
  warning.classList.toggle('visible', isMarkdown && filePreviewState.allowHtml && filePreviewState.mode === 'preview');
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

function _getImgBaseSize() {
  const img = imgZoom.container?.querySelector('img');
  if (!img) return null;
  const rect = img.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const scale = imgZoom.scale || 1;
  return { baseW: rect.width / scale, baseH: rect.height / scale };
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

function _applyImgZoom() {
  const img = imgZoom.container?.querySelector('img');
  if (!img) return;
  img.style.transform = (Math.abs(imgZoom.scale - 1) <= IMG_ZOOM_EPS && imgZoom.panX === 0 && imgZoom.panY === 0)
    ? ''
    : `translate(${imgZoom.panX}px,${imgZoom.panY}px) scale(${imgZoom.scale})`;
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
    bodyEl.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
    return;
  }

  const languageClass = payload.language ? `language-${escHtml(payload.language)}` : '';
  bodyEl.innerHTML = `<div class="file-preview-code"><pre><code class="${languageClass}">${escHtml(rawText)}</code></pre></div>`;
  bodyEl.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
}

export async function openWorkspaceFilePreview(rawPath, options = {}) {
  const normalized = normalizeWorkspaceMentionPath(rawPath);
  if (!normalized) return;
  const viewerOptions = normalizeVideoPreviewOptions(options);
  setFilePreviewState({
    path: normalized,
    source: 'workspace',
    mode: 'preview',
    allowHtml: false,
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
    return;
  }
  filePreviewState.loading = false;
  filePreviewState.payload = payload;
  filePreviewState.path = String(payload.path || normalized);
  filePreviewState.viewerOptions = viewerOptions;
  renderFilePreview();
}

export async function openDriveFilePreview(rawPath, options = {}) {
  const normalized = normalizeDriveBrowserPath(rawPath);
  if (!normalized) return;
  const viewerOptions = normalizeVideoPreviewOptions(options);
  setFilePreviewState({
    path: normalized,
    source: 'drives',
    mode: 'preview',
    allowHtml: false,
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
    return;
  }
  filePreviewState.loading = false;
  filePreviewState.payload = payload;
  filePreviewState.path = String(payload.path || normalized);
  filePreviewState.source = 'drives';
  filePreviewState.viewerOptions = viewerOptions;
  renderFilePreview();
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
  const ancestorPaths = new Set(['']);
  if (currentPath) {
    if (currentPath.startsWith('/')) {
      ancestorPaths.add('/');
      const parts = currentPath.split('/').filter(Boolean);
      let rolling = '';
      for (const part of parts) {
        rolling = rolling ? `${rolling}/${part}` : `/${part}`;
        ancestorPaths.add(rolling);
      }
    } else {
      const parts = currentPath.split('/').filter(Boolean);
      let rolling = '';
      for (const part of parts) {
        rolling = rolling ? `${rolling}/${part}` : part;
        ancestorPaths.add(rolling);
      }
    }
  }
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

  folderHost.innerHTML = `<div class="${wrapperClass}">${rows}</div>`;
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
  treeHost.innerHTML = renderRepoTreeNode(root);
  updateRepoTreeSelection();
  syncRepoTreeToCurrentPath();
}

export function renderRepoBrowser() {
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
      ? await loadDriveChildren(normalizeDriveBrowserPath(repoBrowserState.sessionRootPath), repoBrowserState.drivesIncludeHidden)
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
  flushQueuedRepoBrowserReload();
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
  if (!payload || payload.error || !payload.node || !Array.isArray(payload.node.children)) {
    node.children = [];
    node.childrenLoaded = true;
    node.readError = true;
    renderRepoBrowser();
    return false;
  }

  node.children = payload.node.children;
  node.childrenLoaded = true;
  node.lazy = false;
  node.readError = !!payload.node.readError;
  repoBrowserState.nodeMap = repoNodeMapFromTree(repoBrowserState.tree);
  repoBrowserState.nodeCount = repoBrowserState.nodeMap.size;
  renderRepoBrowser();
  return true;
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
  const keepPath = String(repoBrowserState.currentPath || '');
  setRepoBrowserState({
    tree: null,
    nodeMap: new Map(),
    expandedPaths: new Set(),
    collapsedPaths: new Set(),
    currentPath: '',
    loadingPath: '',
    error: '',
  });
  void (async () => {
    await loadRepoBrowserTree();
    if (keepPath) await setRepoCurrentPath(keepPath);
  })();
}

export function setRepoBrowserViewMode(mode) {
  const value = String(mode || '').toLowerCase();
  if (value !== 'list' && value !== 'grid') return;
  repoBrowserState.viewMode = value;
  renderRepoFolder();
  updateRepoToolbarUi();
}

export function toggleRepoBrowserHidden() {
  if (repoBrowserState.activeRoot === 'workspace') {
    repoBrowserState.workspaceIncludeHidden = !repoBrowserState.workspaceIncludeHidden;
  } else {
    repoBrowserState.drivesIncludeHidden = !repoBrowserState.drivesIncludeHidden;
  }
  refreshRepoBrowser();
}

export function toggleRepoBrowserHeavy() {
  if (repoBrowserState.activeRoot !== 'workspace') return;
  repoBrowserState.workspaceIncludeHeavy = !repoBrowserState.workspaceIncludeHeavy;
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
    if (targetPath.startsWith('/')) {
      repoBrowserState.expandedPaths.add('/');
      const parts = targetPath.split('/').filter(Boolean);
      let rolling = '';
      for (const part of parts) {
        rolling = rolling ? `${rolling}/${part}` : `/${part}`;
        repoBrowserState.expandedPaths.add(rolling);
      }
    } else if (targetPath) {
      const parts = targetPath.split('/').filter(Boolean);
      let rolling = '';
      for (const part of parts) {
        rolling = rolling ? `${rolling}/${part}` : part;
        repoBrowserState.expandedPaths.add(rolling);
      }
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
