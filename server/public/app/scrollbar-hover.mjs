// Desktop scrollbars are thin and hard to grab. With a mouse, the scrollbar of
// the scroll area under the pointer widens to twice its width while the
// pointer is on it, and goes back 2.5 s after the pointer left it. The track
// always has the wide width (index.html), so nothing in the page moves when
// the thumb grows.

export const SCROLLBAR_WIDE_CLASS = 'scrollbar-wide';
export const SCROLLBAR_LINGER_MS = 2500;
// How far left of the scrollbar the pointer already counts as on it.
const REACH_PX = 4;

/**
 * Whether a pointer at `clientX` is on the vertical scrollbar of a scroll
 * area: `rect` is its border box, `barWidth` the room its scrollbar takes
 * (offsetWidth - clientWidth, borders included, which errs on the wide side).
 */
export function pointerOnScrollbar({ clientX, rect, barWidth, reach = REACH_PX } = {}) {
  if (!rect || !(barWidth > 0)) return false;
  return clientX >= rect.right - barWidth - reach && clientX <= rect.right;
}

function scrollAreaUnderPointer(target, clientX) {
  for (let node = target; node && node.nodeType === 1; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight) continue;
    const barWidth = node.offsetWidth - node.clientWidth;
    if (pointerOnScrollbar({ clientX, rect: node.getBoundingClientRect(), barWidth })) return node;
  }
  return null;
}

export function initScrollbarHover({ doc = document, win = window, lingerMs = SCROLLBAR_LINGER_MS } = {}) {
  let canHover = false;
  try { canHover = win.matchMedia('(hover: hover) and (pointer: fine)').matches; } catch {}
  if (!canHover) return () => {};
  const timers = new Map();
  const widen = (node) => {
    clearTimeout(timers.get(node));
    timers.delete(node);
    node.classList.add(SCROLLBAR_WIDE_CLASS);
  };
  const release = (node) => {
    if (timers.has(node)) return;
    timers.set(node, setTimeout(() => {
      timers.delete(node);
      node.classList.remove(SCROLLBAR_WIDE_CLASS);
    }, lingerMs));
  };
  const onMove = (event) => {
    const hovered = scrollAreaUnderPointer(event.target, event.clientX);
    if (hovered) widen(hovered);
    for (const node of doc.querySelectorAll(`.${SCROLLBAR_WIDE_CLASS}`)) {
      if (node !== hovered) release(node);
    }
  };
  // Dragging the thumb sends no pointer moves to the page; the scrolling it
  // causes keeps the scrollbar wide for as long as it lasts.
  const onScroll = (event) => {
    const node = event.target;
    if (node?.classList?.contains(SCROLLBAR_WIDE_CLASS) && timers.has(node)) {
      clearTimeout(timers.get(node));
      timers.delete(node);
      release(node);
    }
  };
  const onLeave = () => {
    for (const node of doc.querySelectorAll(`.${SCROLLBAR_WIDE_CLASS}`)) release(node);
  };
  doc.addEventListener('mousemove', onMove, { passive: true });
  doc.addEventListener('scroll', onScroll, { passive: true, capture: true });
  doc.documentElement.addEventListener('mouseleave', onLeave, { passive: true });
  return () => {
    doc.removeEventListener('mousemove', onMove);
    doc.removeEventListener('scroll', onScroll, { capture: true });
    doc.documentElement.removeEventListener('mouseleave', onLeave);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
