import {
  BASE,
  escHtml,
  workspaceRootName,
  workspaceRootEntrySet,
  WORKSPACE_FILE_EXTENSIONS,
  serverPlatform,
} from './store.js';
import { scanInlineDollars, splitAtLiteralDollars } from './math-dollars.mjs';

export function workspaceMentionRegex() {
  return /(?:[A-Za-z]:[\\/])?(?:\.{1,2}[\\/])?(?:[A-Za-z0-9._-]+[\\/])*[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,16}/g;
}

export function normalizeWorkspaceMentionPath(rawText) {
  const original = String(rawText || '');
  const cleaned = original
    .trim()
    .replace(/^['"`([{<]+/, '')
    .replace(/[)\]}>:;,.!?'"`]+$/, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
  if (!cleaned) return '';
  const lowered = cleaned.toLowerCase();
  if (lowered.startsWith('http://') || lowered.startsWith('https://') || lowered.startsWith('api/')) return '';
  const hadDrivePrefix = /^[A-Za-z]:[\\/]/.test(original.trim());
  const hadLeadingSlash = /^[\\/]/.test(original.trim());
  let parts = cleaned.split('/').filter(Boolean);
  if (!parts.length) return '';
  if (/^[a-z]:$/i.test(parts[0])) {
    parts = parts.slice(1);
  }
  if (!parts.length) return '';
  if (workspaceRootName) {
    const idx = parts.findIndex((part) => part.toLowerCase() === workspaceRootName);
    if (idx >= 0) {
      parts = parts.slice(idx + 1);
    }
  }
  if (!parts.length) return '';
  if ((hadDrivePrefix || hadLeadingSlash) && !workspaceRootEntrySet.has(parts[0].toLowerCase())) {
    const firstRootIdx = parts.findIndex((part) => workspaceRootEntrySet.has(part.toLowerCase()));
    if (firstRootIdx > 0) {
      parts = parts.slice(firstRootIdx);
    }
  }
  if (!parts.length) return '';
  if (parts.some((part) => part === '.' || part === '..')) return '';
  return parts.join('/');
}

export function isLikelyWorkspaceFileMention(rawText) {
  const normalized = normalizeWorkspaceMentionPath(rawText);
  if (!normalized) return false;
  const ext = normalized.includes('.') ? normalized.slice(normalized.lastIndexOf('.') + 1).toLowerCase() : '';
  return WORKSPACE_FILE_EXTENSIONS.has(ext);
}

export function workspaceFilePathFromText(rawText) {
  if (!isLikelyWorkspaceFileMention(rawText)) return '';
  return normalizeWorkspaceMentionPath(rawText);
}

export function workspaceFileHrefFromPath(rawPath) {
  const normalized = normalizeWorkspaceMentionPath(rawPath);
  if (!normalized) return '';
  const encodedPath = normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  if (!encodedPath) return '';
  return `${BASE}/api/files/${encodedPath}`;
}

export function workspaceFileHref(rawText) {
  const normalized = workspaceFilePathFromText(rawText);
  return normalized ? workspaceFileHrefFromPath(normalized) : '';
}

export function workspacePreviewApiPath(rawPath) {
  const normalized = normalizeWorkspaceMentionPath(rawPath);
  if (!normalized) return '';
  const encodedPath = normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `/api/files-preview/${encodedPath}`;
}

export function normalizeDriveBrowserPath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '';
  }
  const withoutNulls = decoded.replace(/\0/g, '');

  if (serverPlatform !== 'win32') {
    const linuxNorm = withoutNulls
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .trimEnd()
      .replace(/(.)\/$/, '$1');
    if (!linuxNorm.startsWith('/')) return '';
    if (linuxNorm.includes('/../') || linuxNorm.endsWith('/..')) return '';
    return linuxNorm || '/';
  }

  const normalized = withoutNulls
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .trim()
    .replace(/\/+$/, '');
  if (!normalized) return '';
  if (!/^[A-Za-z]:(?:\/.*)?$/.test(normalized)) return '';
  const drive = `${normalized.slice(0, 1).toUpperCase()}:`;
  const rest = normalized.slice(2).replace(/^\/+/, '');
  return rest ? `${drive}/${rest}` : drive;
}

export function driveFileHrefFromPath(rawPath) {
  const normalized = normalizeDriveBrowserPath(rawPath);
  if (!normalized) return '';
  return `${BASE}/api/drives/file?path=${encodeURIComponent(normalized)}`;
}

/**
 * Recognize this app's own file-serving hrefs (the shapes
 * driveFileHrefFromPath / workspaceFileHrefFromPath emit, which embedded
 * message media points at after rewriting) and give back the original file
 * path, so a click on an inline image can reopen it in the file viewer.
 */
export function parseAppFileHref(rawSrc) {
  const value = String(rawSrc || '').trim();
  if (!value) return null;
  let parsed = null;
  try {
    parsed = new URL(value, window.location.origin);
  } catch {
    return null;
  }
  if (parsed.origin !== window.location.origin) return null;
  const base = String(BASE || '');
  const pathname = parsed.pathname || '';
  const appPath = base && pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  if (appPath === '/api/drives/file') {
    const path = String(parsed.searchParams.get('path') || '').trim();
    return path ? { kind: 'drive', path } : null;
  }
  if (appPath.startsWith('/api/files/')) {
    const path = appPath.slice('/api/files/'.length)
      .split('/')
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      })
      .join('/');
    return path ? { kind: 'workspace', path } : null;
  }
  return null;
}

export function drivePreviewApiPath(rawPath) {
  const normalized = normalizeDriveBrowserPath(rawPath);
  if (!normalized) return '';
  return `/api/drives/files-preview?path=${encodeURIComponent(normalized)}`;
}

export function normalizeReferencePathForToken(kind, rawPath, source = 'workspace') {
  const tokenKind = String(kind || '').trim().toLowerCase();
  if (tokenKind !== 'file' && tokenKind !== 'folder') return '';
  const root = String(source || '').trim().toLowerCase();
  if (root === 'drives' || root === 'session') return normalizeDriveBrowserPath(rawPath);
  return normalizeWorkspaceMentionPath(rawPath);
}

export function buildReferenceToken(kind, rawPath, source = 'workspace') {
  const tokenKind = String(kind || '').trim().toLowerCase();
  if (tokenKind !== 'file' && tokenKind !== 'folder') return '';
  const normalizedPath = normalizeReferencePathForToken(tokenKind, rawPath, source);
  if (!normalizedPath) return '';
  return `@${tokenKind}:${normalizedPath}`;
}

export function buildWrappedReferenceToken(kind, rawPath, source = 'workspace') {
  const token = buildReferenceToken(kind, rawPath, source);
  if (!token) return '';
  return `\`${token}\``;
}

export async function copyTextToClipboard(value) {
  const text = String(value || '');
  if (!text) return false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', 'readonly');
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  document.body.appendChild(input);
  input.select();
  try {
    document.execCommand('copy');
    return true;
  } finally {
    document.body.removeChild(input);
  }
}

export async function copyReferenceTokenToClipboard(kind, rawPath, source = 'workspace') {
  const wrapped = buildWrappedReferenceToken(kind, rawPath, source);
  if (!wrapped) return false;
  try {
    await copyTextToClipboard(wrapped);
    return true;
  } catch {
    return false;
  }
}

export function isSafePreviewUrl(url, allowDataImage = false) {
  const value = String(url || '').trim();
  if (!value) return false;
  if (value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true;
  try {
    const parsed = new URL(value, window.location.origin);
    const protocol = String(parsed.protocol || '').toLowerCase();
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') return true;
    if (allowDataImage && protocol === 'data:' && /^data:image\/(?:avif|gif|jpe?g|png|webp);/i.test(value)) return true;
  } catch {}
  return false;
}

const PREVIEW_ALLOWED_TAGS = new Set([
  'a', 'article', 'audio', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'div', 'em',
  'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img',
  'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'video',
]);
const PREVIEW_GLOBAL_ATTRIBUTES = new Set(['dir', 'lang', 'title']);
const PREVIEW_ALIGNMENT_VALUES = new Set(['left', 'center', 'right', 'justify']);
const PREVIEW_VERTICAL_ALIGNMENT_VALUES = new Set(['top', 'middle', 'bottom', 'baseline']);
const PREVIEW_DIMENSION_VALUE = /^(?:[1-9]\d{0,3}|100(?:\.0+)?%)$/;
const PREVIEW_SPAN_VALUE = /^[1-9]\d{0,2}$/;

function isAllowedPreviewAttribute(tagName, name, value) {
  if (PREVIEW_GLOBAL_ATTRIBUTES.has(name)) return true;
  if (name === 'href') return tagName === 'a' && isSafePreviewUrl(value, false);
  if (name === 'src') {
    if (tagName === 'img') return isSafePreviewUrl(value, true);
    return (tagName === 'video' || tagName === 'audio') && isSafePreviewUrl(value, false);
  }
  if (name === 'alt') return tagName === 'img';
  if (name === 'controls' || name === 'muted' || name === 'loop') {
    return (tagName === 'video' || tagName === 'audio') && value === '';
  }
  if (name === 'playsinline') return tagName === 'video' && value === '';
  if (name === 'preload') return (tagName === 'video' || tagName === 'audio')
    && ['none', 'metadata', 'auto'].includes(value.toLowerCase());
  if (name === 'target') return tagName === 'a' && value === '_blank';
  if (name === 'rel') return tagName === 'a';
  if (name === 'align') return ['div', 'p', 'table', 'td', 'th', 'tr'].includes(tagName)
    && PREVIEW_ALIGNMENT_VALUES.has(value.toLowerCase());
  if (name === 'valign') return ['td', 'th', 'tr'].includes(tagName)
    && PREVIEW_VERTICAL_ALIGNMENT_VALUES.has(value.toLowerCase());
  if (name === 'width' || name === 'height') return ['img', 'table', 'td', 'th', 'video'].includes(tagName)
    && PREVIEW_DIMENSION_VALUE.test(value);
  if (name === 'rowspan' || name === 'colspan') return ['td', 'th'].includes(tagName)
    && PREVIEW_SPAN_VALUE.test(value);
  if (name === 'cellspacing' || name === 'cellpadding') return tagName === 'table'
    && /^(?:0|[1-9]\d{0,2})$/.test(value);
  if (name === 'loading') return tagName === 'img' && ['eager', 'lazy'].includes(value.toLowerCase());
  if (name === 'decoding') return tagName === 'img' && ['async', 'auto', 'sync'].includes(value.toLowerCase());
  if (name === 'open') return tagName === 'details' && value === '';
  return false;
}

const EMBED_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'm4v', 'mov']);
const EMBED_AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'ogg', 'opus', 'wav', 'flac']);

// 'video' | 'audio' | '' for an already-safe embed src; drive/workspace hrefs
// carry the real file path in their `path` query parameter.
function mediaKindForEmbedSource(src) {
  const value = String(src || '').trim();
  if (!value || value.toLowerCase().startsWith('data:')) return '';
  let candidate = value;
  try {
    const parsed = new URL(value, window.location.origin);
    candidate = parsed.searchParams.get('path') || parsed.pathname;
  } catch {}
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(String(candidate || '').trim());
  const extension = match ? match[1].toLowerCase() : '';
  if (EMBED_VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (EMBED_AUDIO_EXTENSIONS.has(extension)) return 'audio';
  return '';
}

function convertImageToMediaElement(img, mediaTag, src) {
  const media = document.createElement(mediaTag);
  media.setAttribute('src', src);
  media.setAttribute('controls', '');
  media.setAttribute('preload', 'metadata');
  const alt = String(img.getAttribute('alt') || '').trim();
  if (alt) media.setAttribute('title', alt);
  if (mediaTag === 'video') {
    for (const dimension of ['width', 'height']) {
      const value = String(img.getAttribute(dimension) || '').trim();
      if (value) media.setAttribute(dimension, value);
    }
  }
  img.replaceWith(media);
  return media;
}

export function sanitizePreviewHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html || '');
  const nodes = Array.from(template.content.querySelectorAll('*'));
  for (const el of nodes) {
    let element = el;
    let tagName = String(element.tagName || '').toLowerCase();
    if (tagName === 'img' || tagName === 'video' || tagName === 'audio') {
      // Bare local absolute paths (C:\...\shot.png, /home/user/shot.png) are
      // resolved to the drive/workspace file route HERE, before the generic
      // attribute filter would strip them — this is what lets agents embed
      // media by plain path instead of a hand-encoded /api/drives/file URL.
      const rawSrc = String(element.getAttribute('src') || '').trim();
      // Only genuine local-path shapes may be resolved; anything else that
      // fails the safe-URL check (javascript:, vbscript:, …) must simply die,
      // not be laundered into a workspace href by the resolver.
      const looksLocalAbsolute = /^[A-Za-z]:[\\/]/.test(rawSrc) || rawSrc.startsWith('\\');
      const safeSrc = rawSrc && isSafePreviewUrl(rawSrc, tagName === 'img')
        ? rawSrc
        : (looksLocalAbsolute ? resolveLocalAssetUrl(rawSrc) : '');
      if (safeSrc && safeSrc !== rawSrc) element.setAttribute('src', safeSrc);
      else if (!safeSrc && rawSrc) element.removeAttribute('src');
      if (tagName === 'img') {
        const mediaTag = mediaKindForEmbedSource(safeSrc);
        if (mediaTag) {
          element = convertImageToMediaElement(element, mediaTag, safeSrc);
          tagName = mediaTag;
        }
      }
    }
    if (!PREVIEW_ALLOWED_TAGS.has(tagName)) {
      element.replaceWith(document.createTextNode(element.textContent || ''));
      continue;
    }
    const attrs = Array.from(element.attributes || []);
    for (const attr of attrs) {
      const name = String(attr.name || '').toLowerCase();
      const value = String(attr.value || '').trim();
      if (!isAllowedPreviewAttribute(tagName, name, value)) {
        element.removeAttribute(attr.name);
      }
    }
    if (tagName === 'a') {
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return template.innerHTML;
}

const COMPATIBILITY_DISPLAY_MATH_COMMAND = /\\(?:frac|sqrt|sum|prod|int|iint|iiint|lim|log|ln|sin|cos|tan|theta|alpha|beta|gamma|delta|lambda|mu|pi|sigma|phi|omega|vec|hat|bar|overline|underline|left|right|begin|end|text|mathrm|mathbf|mathbb|mathcal|ce)\b/i;
const INLINE_MATH_COMMAND = /\\(?:frac|sqrt|sum|prod|int|iint|iiint|lim|log|ln|sin|cos|tan|cot|sec|csc|arcsin|arccos|theta|alpha|beta|gamma|delta|lambda|mu|pi|rho|sigma|phi|omega|Omega|Gamma|Delta|Lambda|Pi|Sigma|Phi|Psi|Omega|vec|hat|bar|overline|underline|left|right|text|mathrm|mathbf|mathbb|mathcal|operatorname|circ|degree|times|cdot|pm|mp|leq|geq|neq|approx|equiv|infty|partial|nabla|forall|exists|rightarrow|longmapsto|to|mapsto|ce)\b/;
const STRICT_INLINE_SCRIPT = /(?:\^[{]|\^[-+]?\d|_[{]|_[-+]?\d)/;
const URL_LIKE_TEXT = /\b(?:https?|ftp):\/\/|www\./i;
const MARKDOWN_ESCAPABLE_TEX_CHARACTERS = new Set(Array.from('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'));

function isStrictInlineMathCandidate(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 240 || URL_LIKE_TEXT.test(text)) return false;
  return INLINE_MATH_COMMAND.test(text) || STRICT_INLINE_SCRIPT.test(text);
}

function findClosingParenthesis(source, openingIndex) {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] === '(') depth += 1;
    if (source[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function normalizeInlineMathDelimiters(line) {
  let output = '';
  let index = 0;
  let inCode = false;
  // Only real dollar maths is skipped over; a price's `$` opens nothing.
  const dollarMathEnds = new Map(scanInlineDollars(line).spans);

  while (index < line.length) {
    const char = line[index];
    if (char === '`') {
      inCode = !inCode;
      output += char;
      index += 1;
      continue;
    }
    if (inCode) {
      output += char;
      index += 1;
      continue;
    }
    if (char === '$' && dollarMathEnds.has(index)) {
      const closeIndex = dollarMathEnds.get(index);
      output += line.slice(index, closeIndex + 1);
      index = closeIndex + 1;
      continue;
    }
    if (char === '\\' && line[index + 1] === '(') {
      const closeIndex = line.indexOf('\\)', index + 2);
      if (closeIndex >= 0) {
        output += `$${line.slice(index + 2, closeIndex).trim()}$`;
        index = closeIndex + 2;
        continue;
      }
    }
    if (char !== '(' || line[index - 1] === '\\') {
      output += char;
      index += 1;
      continue;
    }
    const closeIndex = findClosingParenthesis(line, index);
    if (closeIndex < 0) {
      output += char;
      index += 1;
      continue;
    }
    const candidate = line.slice(index + 1, closeIndex);
    if (!isStrictInlineMathCandidate(candidate)) {
      output += char;
      index += 1;
      continue;
    }
    output += `$${candidate.trim()}$`;
    index = closeIndex + 1;
  }

  return output;
}

function protectMarkdownEscapesInMath(source) {
  const lines = String(source ?? '').split('\n');
  let inFence = false;

  return lines.map((line) => {
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;

    let output = '';
    let index = 0;
    let inCode = false;
    const dollarMathEnds = new Map(scanInlineDollars(line).spans);
    while (index < line.length) {
      if (line[index] === '`') {
        inCode = !inCode;
        output += line[index];
        index += 1;
        continue;
      }
      if (inCode || line[index] !== '$' || line[index - 1] === '\\') {
        output += line[index];
        index += 1;
        continue;
      }
      const delimiter = line[index + 1] === '$' ? '$$' : '$';
      // A single `$` that is a plain dollar sign (a price) opens no formula.
      const closeIndex = delimiter === '$'
        ? (dollarMathEnds.has(index) ? dollarMathEnds.get(index) : -1)
        : line.indexOf(delimiter, index + delimiter.length);
      if (closeIndex < 0) {
        output += line[index];
        index += 1;
        continue;
      }
      const formula = line.slice(index + delimiter.length, closeIndex);
      const protectedFormula = formula.replace(/\\(.)/g, (match, character) => (
        MARKDOWN_ESCAPABLE_TEX_CHARACTERS.has(character) ? `\\\\${character}` : match
      ));
      output += `${delimiter}${protectedFormula}${delimiter}`;
      index = closeIndex + delimiter.length;
    }
    return output;
  }).join('\n');
}

export function normalizeMathDelimiters(source) {
  const lines = String(source ?? '').split('\n');
  const normalized = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      normalized.push(line);
      continue;
    }
    if (inFence || /^(?: {4}|\t)/.test(line)) {
      normalized.push(line);
      continue;
    }

    line = normalizeInlineMathDelimiters(line)
      .replace(/\\\[([^\n]+?)\\\]/g, (_match, formula) => `$$${formula.trim()}$$`);
    const delimiter = line.trim();
    const closingDelimiter = delimiter === '$$'
      ? '$$'
      : delimiter === '\\['
        ? '\\]'
        : delimiter === '['
          ? ']'
          : '';
    if (!closingDelimiter) {
      normalized.push(line);
      continue;
    }

    let closingIndex = index + 1;
    while (closingIndex < lines.length && lines[closingIndex].trim() !== closingDelimiter) closingIndex += 1;
    if (closingIndex >= lines.length) {
      normalized.push(line);
      continue;
    }

    const formula = lines.slice(index + 1, closingIndex).join('\n');
    if (delimiter === '[' && !COMPATIBILITY_DISPLAY_MATH_COMMAND.test(formula)) {
      normalized.push(line);
      continue;
    }
    normalized.push(`$$${formula.trim().replace(/[ \t]*\n[ \t]*/g, ' ')}$$`);
    index = closingIndex;
  }

  return protectMarkdownEscapesInMath(normalized.join('\n'));
}

const MATH_IGNORED_TAGS = ['pre', 'code', 'script', 'style', 'textarea', 'option', 'a'];
const LITERAL_DOLLAR_CLASS = 'literal-dollar';

/**
 * KaTeX's auto-render pairs any two `$` in a block, so "$5 … $9" would become
 * one formula. Each plain dollar sign (see math-dollars.mjs) is moved into a
 * span of its own that auto-render skips; with no partner in its text node,
 * it stays a dollar sign.
 */
function isolateLiteralDollars(container) {
  const ignored = MATH_IGNORED_TAGS.join(',');
  const walker = document.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */);
  const textNodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue.includes('$') && !node.parentElement?.closest(ignored)) textNodes.push(node);
  }
  for (const node of textNodes) {
    const parts = splitAtLiteralDollars(node.nodeValue);
    if (!parts.some((part) => part.literal)) continue;
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (!part.literal) {
        fragment.appendChild(document.createTextNode(part.text));
        continue;
      }
      const span = document.createElement('span');
      span.className = LITERAL_DOLLAR_CLASS;
      span.textContent = part.text;
      fragment.appendChild(span);
    }
    node.parentNode.replaceChild(fragment, node);
  }
}

function renderMathInHtml(html) {
  const renderMathInElement = globalThis.renderMathInElement;
  if (typeof renderMathInElement !== 'function' || !globalThis.document?.createElement) return html;

  const container = document.createElement('div');
  container.innerHTML = html;
  try {
    isolateLiteralDollars(container);
    renderMathInElement(container, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$', right: '$', display: false },
      ],
      ignoredTags: MATH_IGNORED_TAGS,
      ignoredClasses: [LITERAL_DOLLAR_CLASS],
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    });
  } catch (error) {
    console.warn('[markdown] could not render mathematical notation', error);
    return html;
  }
  // The original Markdown was sanitized before this pass. KaTeX generates its own
  // layout styles, which are necessary for fractions, scripts, and matrices.
  return container.innerHTML;
}

export function renderMarkdownPreview(source, allowEmbeddedHtml) {
  const sourceText = normalizeMathDelimiters(source);
  const fallbackEscaped = `<p>${escHtml(sourceText).replace(/\n/g, '<br>')}</p>`;
  const markdown = globalThis.marked;
  if (!markdown || typeof markdown.parse !== 'function' || typeof markdown.Renderer !== 'function') {
    return fallbackEscaped;
  }
  if (allowEmbeddedHtml) {
    const parsed = markdown.parse(sourceText);
    if (typeof parsed !== 'string') return fallbackEscaped;
    return renderMathInHtml(sanitizePreviewHtml(parsed));
  }
  const renderer = new markdown.Renderer();
  renderer.html = (htmlToken) => {
    if (typeof htmlToken === 'string') return escHtml(htmlToken);
    if (htmlToken && typeof htmlToken === 'object') {
      return escHtml(htmlToken.raw ?? htmlToken.text ?? '');
    }
    return '';
  };
  const parsed = markdown.parse(sourceText, { renderer });
  if (typeof parsed !== 'string') return fallbackEscaped;
  return renderMathInHtml(sanitizePreviewHtml(parsed));
}

export function eventTargetElement(event) {
  const target = event?.target;
  if (target instanceof Element) return target;
  if (target && target.nodeType === Node.TEXT_NODE && target.parentElement) return target.parentElement;
  return null;
}

export function eventClosest(event, selector) {
  const target = eventTargetElement(event);
  if (target) {
    const closest = target.closest(selector);
    if (closest) return closest;
  }
  const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
  for (const entry of path) {
    if (entry instanceof Element && entry.matches(selector)) return entry;
  }
  return null;
}

export function buildLinkedTextFragment(text) {
  const source = String(text || '');
  const regex = workspaceMentionRegex();
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  let changed = false;
  let match = null;
  while ((match = regex.exec(source)) !== null) {
    const mention = match[0];
    const workspacePath = workspaceFilePathFromText(mention);
    const href = workspacePath ? workspaceFileHrefFromPath(workspacePath) : '';
    if (!workspacePath || !href) continue;
    if (match.index > lastIndex) {
      fragment.appendChild(document.createTextNode(source.slice(lastIndex, match.index)));
    }
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.className = 'workspace-file-link';
    anchor.dataset.workspacePath = workspacePath;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = mention;
    fragment.appendChild(anchor);
    lastIndex = match.index + mention.length;
    changed = true;
  }
  if (!changed) return null;
  if (lastIndex < source.length) {
    fragment.appendChild(document.createTextNode(source.slice(lastIndex)));
  }
  return fragment;
}

export function linkifyWorkspaceMentionsInNode(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node?.nodeValue || !String(node.nodeValue).trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = String(parent.tagName || '').toUpperCase();
      if (tag === 'A' || tag === 'CODE' || tag === 'PRE' || tag === 'SCRIPT' || tag === 'STYLE') {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.closest?.('.msg-attachment')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    const fragment = buildLinkedTextFragment(node.nodeValue || '');
    if (fragment) node.parentNode.replaceChild(fragment, node);
  }
}

function shouldRewriteLocalAssetUrl(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return false;
  const lowered = value.toLowerCase();
  const normalizedBase = String(BASE || '').trim().replace(/\/+$/, '').toLowerCase();
  if (
    lowered.startsWith('/api/')
    || lowered.startsWith('api/')
    || (normalizedBase && lowered.startsWith(`${normalizedBase}/api/`))
  ) {
    return false;
  }
  if (
    lowered.startsWith('http://')
    || lowered.startsWith('https://')
    || lowered.startsWith('data:')
    || lowered.startsWith('blob:')
    || lowered.startsWith('#')
  ) {
    return false;
  }
  return true;
}

function resolveLocalAssetUrl(rawValue, { preferDrive = false } = {}) {
  const value = String(rawValue || '').trim();
  if (!shouldRewriteLocalAssetUrl(value)) return '';
  const looksAbsolute = /^[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value);
  if (preferDrive || looksAbsolute) {
    const drivePath = normalizeDriveBrowserPath(value);
    if (drivePath) return driveFileHrefFromPath(drivePath);
  }
  const workspacePath = normalizeWorkspaceMentionPath(value);
  if (workspacePath) return workspaceFileHrefFromPath(workspacePath);
  if (!looksAbsolute) {
    const drivePath = normalizeDriveBrowserPath(value);
    if (drivePath) return driveFileHrefFromPath(drivePath);
  }
  return '';
}

export function rewriteLocalAssetUrlsInNode(root, options = {}) {
  if (!(root instanceof Element)) return;
  const preferDrive = options?.preferDrive === true;
  const rewriteAnchors = options?.rewriteAnchors !== false;
  const images = Array.from(root.querySelectorAll('img[src], video[src], audio[src]'));
  for (const img of images) {
    const rawSrc = img.getAttribute('src') || '';
    const nextSrc = resolveLocalAssetUrl(rawSrc, { preferDrive });
    if (nextSrc) img.setAttribute('src', nextSrc);
  }
  if (!rewriteAnchors) return;
  const anchors = Array.from(root.querySelectorAll('a[href]'));
  for (const anchor of anchors) {
    const rawHref = anchor.getAttribute('href') || '';
    const nextHref = resolveLocalAssetUrl(rawHref, { preferDrive });
    if (!nextHref) continue;
    anchor.setAttribute('href', nextHref);
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
  }
}

export function renderLinkedPlainText(text) {
  const source = String(text || '');
  const regex = workspaceMentionRegex();
  let html = '';
  let lastIndex = 0;
  let match = null;
  while ((match = regex.exec(source)) !== null) {
    const mention = match[0];
    const workspacePath = workspaceFilePathFromText(mention);
    const href = workspacePath ? workspaceFileHrefFromPath(workspacePath) : '';
    html += escHtml(source.slice(lastIndex, match.index));
    if (workspacePath && href) {
      html += `<a href="${escHtml(href)}" class="workspace-file-link" data-workspace-path="${escHtml(workspacePath)}" target="_blank" rel="noopener noreferrer">${escHtml(mention)}</a>`;
    } else {
      html += escHtml(mention);
    }
    lastIndex = match.index + mention.length;
  }
  html += escHtml(source.slice(lastIndex));
  return html;
}
