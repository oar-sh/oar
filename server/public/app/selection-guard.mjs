// Tracks whether the user is interacting with a container (active text
// selection or pointer drag) so renderers can defer destructive DOM updates
// instead of wiping the selection out from under them.

export function createSelectionGuard() {
  const pointerHolds = new Set();
  const selectionHolds = new Set();
  const releaseCallbacks = new Set();
  let wasHeld = false;

  const anyHeld = () => pointerHolds.size > 0 || selectionHolds.size > 0;
  const update = () => {
    const held = anyHeld();
    if (wasHeld && !held) {
      for (const callback of [...releaseCallbacks]) {
        try { callback(); } catch {}
      }
    }
    wasHeld = held;
  };

  return {
    pointerDown(containerKey) {
      const key = String(containerKey || '').trim();
      if (!key) return;
      pointerHolds.add(key);
      update();
    },
    pointerUp() {
      pointerHolds.clear();
      update();
    },
    setSelectionHolds(containerKeys) {
      selectionHolds.clear();
      for (const containerKey of containerKeys || []) {
        const key = String(containerKey || '').trim();
        if (key) selectionHolds.add(key);
      }
      update();
    },
    isHeld(containerKey) {
      const key = String(containerKey || '').trim();
      if (!key) return anyHeld();
      return pointerHolds.has(key) || selectionHolds.has(key);
    },
    onRelease(callback) {
      if (typeof callback !== 'function') return () => {};
      releaseCallbacks.add(callback);
      return () => releaseCallbacks.delete(callback);
    },
  };
}

export function selectionIntersectsNode(node, doc = globalThis.document) {
  if (!node || typeof doc?.getSelection !== 'function') return false;
  let selection;
  try { selection = doc.getSelection(); } catch { return false; }
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  for (let i = 0; i < selection.rangeCount; i += 1) {
    try {
      if (selection.getRangeAt(i).intersectsNode(node)) return true;
    } catch {}
  }
  return false;
}

export const CHAT_CONTAINER_KEY = 'messages';

export const chatSelectionGuard = createSelectionGuard();

export function isChatInteractionHeld() {
  return chatSelectionGuard.isHeld(CHAT_CONTAINER_KEY);
}

export function bindChatSelectionGuard(doc = globalThis.document) {
  if (!doc?.addEventListener) return;
  const messagesEl = () => doc.getElementById('messages');
  doc.addEventListener('pointerdown', (event) => {
    const el = messagesEl();
    if (el && event.target instanceof Node && el.contains(event.target)) {
      chatSelectionGuard.pointerDown(CHAT_CONTAINER_KEY);
    }
  }, { passive: true });
  const clearPointer = () => chatSelectionGuard.pointerUp();
  doc.addEventListener('pointerup', clearPointer, { passive: true });
  doc.addEventListener('pointercancel', clearPointer, { passive: true });
  doc.addEventListener('selectionchange', () => {
    const el = messagesEl();
    chatSelectionGuard.setSelectionHolds(
      el && selectionIntersectsNode(el, doc) ? [CHAT_CONTAINER_KEY] : [],
    );
  });
}
