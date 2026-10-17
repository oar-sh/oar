// "Preview as shared": the relay marks, in the payload of its preview routes,
// every redaction (U+E000 … U+E001, the text a viewer gets in between) and
// every leftover that still looks like a path (U+E002 … U+E003). See
// server/services/share-path-redaction.mjs. This module turns the marks into
// highlights wherever the transcript put the text: reply markdown, thoughts,
// tool lines, code blocks, the sub-agent viewer. A highlight can be split by
// the elements a renderer put inside it (syntax highlighting); each piece is
// marked on its own. Marks inside attributes (a title, a link) are dropped.

export const PREVIEW_MARK_CHARS = Object.freeze({
  redactedStart: '',
  redactedEnd: '',
  suspectStart: '',
  suspectEnd: '',
});

const ANY_MARK_RE = /[-]/;
const ALL_MARKS_RE = /[-]/g;
const BLOCK_SELECTOR = 'p, li, pre, div, td, th, h1, h2, h3, h4, h5, h6, blockquote, summary';
const MARK_KINDS = {
  '': { open: 'redacted' },
  '': { close: 'redacted' },
  '': { open: 'suspect' },
  '': { close: 'suspect' },
};
const CLASS_BY_KIND = {
  redacted: 'share-preview-redacted',
  suspect: 'share-preview-suspect',
};
const TITLE_BY_KIND = {
  redacted: 'Hidden from shared viewers: they see this instead',
  suspect: 'Still looks like a path: shared viewers see it as it is',
};

/** The text without any mark. */
export function stripPreviewMarks(text) {
  return String(text ?? '').replace(ALL_MARKS_RE, '');
}

/**
 * The pieces of a text between marks, each with the highlight it stands in
 * (null for plain text). `state` carries an open highlight from the text
 * before (a highlight split across nodes) and is updated in place.
 */
export function splitPreviewMarks(text, state = { kind: null }) {
  const pieces = [];
  let buffer = '';
  const flush = () => {
    if (buffer) pieces.push({ text: buffer, kind: state.kind });
    buffer = '';
  };
  for (const ch of String(text ?? '')) {
    const mark = MARK_KINDS[ch];
    if (!mark) {
      buffer += ch;
      continue;
    }
    flush();
    if (mark.open) state.kind = mark.open;
    else if (mark.close && state.kind === mark.close) state.kind = null;
  }
  flush();
  return pieces;
}

function markElement(doc, piece) {
  const element = doc.createElement('mark');
  element.className = CLASS_BY_KIND[piece.kind];
  element.title = TITLE_BY_KIND[piece.kind];
  element.textContent = piece.text;
  return element;
}

function rewriteTextNode(node, state) {
  const value = node.nodeValue || '';
  if (!ANY_MARK_RE.test(value) && !state.kind) return;
  const pieces = splitPreviewMarks(value, state);
  const doc = node.ownerDocument;
  const fragment = doc.createDocumentFragment();
  for (const piece of pieces) {
    fragment.appendChild(piece.kind ? markElement(doc, piece) : doc.createTextNode(piece.text));
  }
  node.parentNode?.replaceChild(fragment, node);
}

function stripAttributes(root) {
  const elements = root.nodeType === 1 ? [root, ...root.querySelectorAll('*')] : [...(root.querySelectorAll?.('*') || [])];
  for (const element of elements) {
    for (const attribute of [...(element.attributes || [])]) {
      if (ANY_MARK_RE.test(attribute.value)) element.setAttribute(attribute.name, stripPreviewMarks(attribute.value));
    }
  }
}

/** Turn every mark under `root` into a highlight. Idempotent. */
export function applyPreviewMarks(root) {
  if (!root) return;
  if (root.nodeType === 3) {
    if (root.parentElement) applyPreviewMarks(root.parentElement);
    return;
  }
  const doc = root.ownerDocument || root;
  if (ANY_MARK_RE.test(root.textContent || '')) {
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
      acceptNode(node) {
        const tag = String(node.parentElement?.tagName || '').toUpperCase();
        // Mark characters are never part of a script or a style; leave them.
        return tag === 'SCRIPT' || tag === 'STYLE' ? 2 /* FILTER_REJECT */ : 1 /* FILTER_ACCEPT */;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    // An open highlight runs on in document order; a block element ends it.
    let state = { kind: null };
    let block = null;
    for (const node of nodes) {
      const nodeBlock = node.parentElement?.closest?.(BLOCK_SELECTOR) || null;
      if (nodeBlock !== block) {
        state = { kind: null };
        block = nodeBlock;
      }
      rewriteTextNode(node, state);
    }
  }
  stripAttributes(root);
}

/**
 * Keep marking whatever the page renders under `root` (the transcript is
 * rebuilt as the preview polls, the sub-agent viewer fills in). Only what
 * changed is looked at. Returns a stop function.
 */
export function watchPreviewMarks(root, { schedule = (fn) => requestAnimationFrame(fn) } = {}) {
  if (!root || typeof MutationObserver !== 'function') return () => {};
  const changed = new Set();
  let pending = false;
  let observer = null;
  const observe = () => observer.observe(root, {
    childList: true, subtree: true, characterData: true, attributes: true,
  });
  const run = () => {
    pending = false;
    observer.disconnect();
    try {
      for (const node of changed) {
        if (node.isConnected) applyPreviewMarks(node);
      }
      changed.clear();
      if (ANY_MARK_RE.test(document.title || '')) document.title = stripPreviewMarks(document.title);
    } finally {
      observe();
    }
  };
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'childList') record.addedNodes.forEach((node) => changed.add(node));
      else if (record.type === 'characterData') changed.add(record.target);
      else if (record.type === 'attributes' && ANY_MARK_RE.test(record.target.getAttribute?.(record.attributeName) || '')) changed.add(record.target);
    }
    if (pending || !changed.size) return;
    pending = true;
    schedule(run);
  });
  applyPreviewMarks(root);
  observe();
  return () => observer.disconnect();
}
