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

// After a long press opened its menu on release, the click the release makes
// must not reach the element underneath (it would open the row). Only that
// click: the next press ends the guard.
const RELEASE_CLICK_GUARD_MS = 400;

/**
 * Long-press as the touch equivalent of right-click, on every descendant of
 * `root` that matches `selector`. Android fires no `contextmenu` for a long
 * press on a non-selectable element. Cancelled by movement, so it never fires
 * mid-scroll; mouse pointers are left to the real `contextmenu` event.
 * `handler(target, x, y)`.
 *
 * With `lift`, the press lifts the element at the delay instead
 * (`lift.onLift(target, x, y)`), and what the finger does next decides:
 * released without moving, the handler runs (the menu opens on release); moved
 * past the slop, `lift.onMove(target, x, y, event)` is offered the gesture (a
 * drag) and the press ends here when it returns true. `lift.onEnd(target)`
 * follows every lift that did not turn into a move. `lift.canLift(target)`
 * false keeps the plain long press for that press (the handler at the delay,
 * a move cancels). A browser `contextmenu` during a touch press is swallowed,
 * so the menu opens once. A page sent to the background ends the press
 * without a menu.
 */
export function bindLongPress(root, selector, handler, {
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  now = () => Date.now(),
  lift = null,
} = {}) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let pressed = null;
  let lifted = false;
  let swallowClicksUntil = 0;
  const cancel = () => {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
    const target = pressed;
    const wasLifted = lifted;
    pressed = null;
    lifted = false;
    if (wasLifted) lift?.onEnd?.(target);
  };
  const release = () => {
    if (!lifted) {
      cancel();
      return;
    }
    const target = pressed;
    cancel();
    swallowClicksUntil = now() + RELEASE_CLICK_GUARD_MS;
    handler(target, startX, startY);
  };
  root.addEventListener('pointerdown', (event) => {
    swallowClicksUntil = 0;
    if (event.pointerType === 'mouse') return;
    const target = event.target?.closest?.(selector);
    if (!target || !root.contains(target)) return;
    cancel();
    startX = event.clientX;
    startY = event.clientY;
    pressed = target;
    timer = setTimeoutImpl(() => {
      timer = null;
      if (!lift || lift.canLift?.(pressed) === false) {
        const firing = pressed;
        pressed = null;
        handler(firing, startX, startY);
        return;
      }
      lifted = true;
      lift.onLift?.(pressed, startX, startY);
    }, LONG_PRESS_MS);
  }, { passive: true });
  root.addEventListener('pointermove', (event) => {
    if (!pressed) return;
    if (Math.abs(event.clientX - startX) <= LONG_PRESS_SLOP_PX && Math.abs(event.clientY - startY) <= LONG_PRESS_SLOP_PX) return;
    if (!lifted) {
      cancel();
      return;
    }
    // A lifted element moved: a drag, when the owner takes it.
    const target = pressed;
    if (lift.onMove?.(target, startX, startY, event) === true) {
      pressed = null;
      lifted = false;
    }
  }, { passive: true });
  if (!lift) {
    for (const name of ['pointerup', 'pointercancel', 'pointerleave']) {
      root.addEventListener(name, cancel, { passive: true });
    }
    return cancel;
  }
  root.addEventListener('pointerup', release, { passive: true });
  // A cancel while lifted (the browser claimed a long press of its own) still
  // opens the menu: the finger was held without moving.
  root.addEventListener('pointercancel', release, { passive: true });
  root.addEventListener('pointerleave', () => {
    if (!lifted) cancel();
  }, { passive: true });
  root.ownerDocument?.addEventListener('visibilitychange', () => {
    if (root.ownerDocument.hidden) cancel();
  });
  root.addEventListener('contextmenu', (event) => {
    if (!pressed) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  root.addEventListener('click', (event) => {
    // A click from the keyboard (Enter, Space) is never the release's.
    if (event.detail === 0 || now() >= swallowClicksUntil) return;
    swallowClicksUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  return cancel;
}
