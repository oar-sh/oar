// A context menu for the conversation list: right-click on a desktop, a long
// press on a phone. One menu at a time, closed by a pointer-down outside it,
// Escape, a scroll or a resize, like a native menu; flipped at the screen
// edge rather than clipped. The entries are buttons, so keyboard users get
// focus on the first one.

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

/** A horizontal rule between groups. */
export const MENU_SEPARATOR = null;

let closeOpenMenu = null;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Close the open menu, if any. */
export function closeContextMenu() {
  closeOpenMenu?.();
}

/**
 * Open a menu at viewport coordinates. `items`: `{ label, onSelect, danger?,
 * disabled?, id? }`, or MENU_SEPARATOR between groups. Returns the menu node.
 */
export function openContextMenu(x, y, items, { documentRef = document, windowRef = window } = {}) {
  closeOpenMenu?.();
  const menu = documentRef.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');

  const close = () => {
    if (closeOpenMenu !== close) return;
    closeOpenMenu = null;
    documentRef.removeEventListener('pointerdown', onOutside, true);
    documentRef.removeEventListener('keydown', onKey, true);
    windowRef.removeEventListener('resize', close);
    windowRef.removeEventListener('scroll', close, true);
    menu.remove();
  };
  const onOutside = (event) => {
    if (!menu.contains(event.target)) close();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...menu.querySelectorAll('button:not([disabled])')];
    if (!buttons.length) return;
    const index = buttons.indexOf(documentRef.activeElement);
    const next = event.key === 'ArrowDown'
      ? buttons[(index + 1) % buttons.length]
      : buttons[(index <= 0 ? buttons.length : index) - 1];
    next.focus();
    event.preventDefault();
  };

  for (const item of items) {
    if (item === MENU_SEPARATOR) {
      const rule = documentRef.createElement('div');
      rule.className = 'context-menu-sep';
      rule.setAttribute('role', 'separator');
      menu.append(rule);
      continue;
    }
    if (!item) continue;
    const entry = documentRef.createElement('button');
    entry.type = 'button';
    entry.className = `context-menu-item${item.danger ? ' context-menu-item-danger' : ''}`;
    entry.setAttribute('role', 'menuitem');
    if (item.id) entry.dataset.menuItem = String(item.id);
    entry.innerHTML = esc(item.label);
    entry.disabled = item.disabled === true;
    entry.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      close();
      item.onSelect?.();
    });
    menu.append(entry);
  }

  documentRef.body.append(menu);
  // Positioned after insertion so the measured size is the real one.
  const rect = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, windowRef.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, windowRef.innerHeight - rect.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  closeOpenMenu = close;
  documentRef.addEventListener('pointerdown', onOutside, true);
  documentRef.addEventListener('keydown', onKey, true);
  windowRef.addEventListener('resize', close);
  windowRef.addEventListener('scroll', close, true);
  queueMicrotask(() => menu.querySelector('button:not([disabled])')?.focus());
  return menu;
}

/**
 * Long-press as the touch equivalent of right-click, on every descendant of
 * `root` that matches `selector`. Android fires no `contextmenu` for a long
 * press on a non-selectable element. Cancelled by movement, so it never fires
 * mid-scroll; mouse pointers are left to the real `contextmenu` event.
 * `handler(target, x, y)`.
 */
export function bindLongPress(root, selector, handler, { setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  const cancel = () => {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
  };
  root.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return;
    const target = event.target?.closest?.(selector);
    if (!target || !root.contains(target)) return;
    startX = event.clientX;
    startY = event.clientY;
    cancel();
    timer = setTimeoutImpl(() => {
      timer = null;
      handler(target, startX, startY);
    }, LONG_PRESS_MS);
  }, { passive: true });
  root.addEventListener('pointermove', (event) => {
    if (Math.abs(event.clientX - startX) > LONG_PRESS_SLOP_PX || Math.abs(event.clientY - startY) > LONG_PRESS_SLOP_PX) cancel();
  }, { passive: true });
  for (const name of ['pointerup', 'pointercancel', 'pointerleave']) {
    root.addEventListener(name, cancel, { passive: true });
  }
  return cancel;
}
