// The media of a conversation as a gallery: every image, video and audio
// attachment and every picture embedded in a bubble, in the order they
// stand in the conversation, open at the one that was tapped.
//
// It is read from the rendered messages rather than from message records:
// an embedded picture only becomes an address the viewer can open once the
// bubble is rendered (local paths are rewritten then), and the rendered
// order is the conversation's order.

export const CHAT_MEDIA_SELECTOR = '.msg-attachment[data-media-url], .msg-bubble img';

function baseName(filePath) {
  return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || 'image';
}

/** The viewer item behind a media node, or null for a node that is none. */
export function chatMediaItemFromNode(node, { parseAppFileHref } = {}) {
  if (!node) return null;
  const attachment = node.closest?.('.msg-attachment[data-media-url]');
  if (attachment) {
    return {
      source: 'upload',
      href: String(attachment.dataset.mediaUrl || ''),
      name: String(attachment.dataset.mediaName || 'attachment'),
      mime: String(attachment.dataset.mediaType || ''),
    };
  }
  if (String(node.tagName || '').toUpperCase() !== 'IMG') return null;
  const src = String(node.getAttribute('src') || '').trim();
  if (!src) return null;
  const target = parseAppFileHref?.(src) || null;
  if (target?.kind === 'drive') return { source: 'drives', path: target.path, name: baseName(target.path) };
  if (target?.kind === 'workspace') return { source: 'workspace', path: target.path, name: baseName(target.path) };
  // A data: thumbnail or a picture from the web: shown as it is.
  const dataMime = /^data:(image\/[a-z0-9.+-]+)/i.exec(src)?.[1] || '';
  return { source: 'upload', href: src, name: String(node.getAttribute('alt') || 'image'), mime: dataMime || 'image/*' };
}

/**
 * The gallery of `root`'s media open at `clickedNode`, or null when there
 * is nothing else to move to (the viewer then shows the one file).
 * Embedded pictures can be left out (the shared view cannot fetch them).
 */
export function chatMediaGallery(root, clickedNode, { includeEmbedded = true, parseAppFileHref } = {}) {
  if (!root || !clickedNode) return null;
  const clicked = clickedNode.closest?.('.msg-attachment[data-media-url]') || clickedNode;
  const items = [];
  let index = -1;
  for (const node of root.querySelectorAll(CHAT_MEDIA_SELECTOR)) {
    const isAttachment = node.matches('.msg-attachment');
    if (!isAttachment && (node.closest('.msg-attachment') || !includeEmbedded)) continue;
    const item = chatMediaItemFromNode(node, { parseAppFileHref });
    if (!item) continue;
    if (node === clicked) index = items.length;
    items.push(item);
  }
  if (index === -1 || items.length < 2) return null;
  return { source: 'chat', items, index };
}
