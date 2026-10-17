// Drag and drop of conversation rows in the sidebar: the pointer side. One
// implementation for mouse and touch. A mouse drag starts after a few pixels
// with the primary button held on a row (not on its buttons or its pill); a
// finger lifts a row with a long press (context-menu.mjs) and drags it once it
// moves. Where a row lands is decided by conversation-group-drag.mjs; the
// sidebar does the call and the re-render (`onDrop`).
//
// While a row is lifted or dragged the owner holds its re-renders
// (`onHold(true)`), so the rows under the finger stay the ones measured; only
// a hover-unfold re-renders (`rerender()`), after which the marks are put
// back. A folded head hovered for a moment opens for the rest of the drag
// (`setDragOpen(groupId, true)`), and closes again unless the row went in.

import { NO_DROP, autoScrollStep, resolveDropTarget } from './conversation-group-drag.mjs';

const MOUSE_DRAG_THRESHOLD_PX = 4;
const UNFOLD_HOVER_MS = 600;
const CLICK_GUARD_MS = 400;
// A held list is let go after the click a release makes, or after this
// long when none comes (a touch release that was no tap).
const RELEASE_FALLBACK_MS = 300;
// The parts of a row that are controls of their own.
const NOT_A_HANDLE = 'button, a, input, textarea, select, [data-open-waiting], [role="button"]';
const DROP_CLASSES = ['conv-drop-before', 'conv-drop-after', 'conv-drop-inside', 'conv-drop-group', 'conv-drop-new-group'];

function cssEscape(value) {
  const text = String(value ?? '');
  return globalThis.CSS?.escape ? globalThis.CSS.escape(text) : text.replace(/["\\]/g, '\\$&');
}

/** A sidebar row's item key: its conversation id, or `group:<id>` for a synthetic head. */
export function conversationRowKey(row) {
  const id = String(row?.dataset?.conversationId || '').trim();
  return id || `group:${String(row?.dataset?.groupId || '').trim()}`;
}

/**
 * Binds the drag to `list`. `isEnabled()` says whether rows may move now (not
 * in the Archived view, not under a filter); `describeItems()` gives the
 * rendered list as conversation-group-drag.mjs items. Returns `{ canLift,
 * lift, unlift, beginTouchDrag, cancel, isActive }` for the long press to
 * drive.
 */
export function bindConversationListDrag(list, {
  isEnabled = () => true,
  describeItems = () => [],
  onHold = () => {},
  rerender = () => {},
  setDragOpen = () => {},
  onDrop = () => {},
  documentRef = document,
  windowRef = window,
  releaseFallbackMs = RELEASE_FALLBACK_MS,
} = {}) {
  let session = null;
  let mousePress = null;
  // A finger on a row: the list holds still from the touch on, so the row
  // the long press lifts is the one on screen, and its release reaches the
  // list (a re-render would take the touched node out of it).
  let touchPress = null;
  let liftedRow = null;
  let holding = false;
  let swallowClicksUntil = 0;
  // The row a finger holds keeps its own guard against scrolling: a
  // re-render (a hover-unfold) takes it out of the list, and touch events
  // still go to the node the finger first touched, so a guard on the list
  // alone would no longer see them.
  let guardedRow = null;
  const blockTouchMove = (event) => {
    if (event.cancelable) event.preventDefault();
  };
  const guardRow = (row) => {
    if (guardedRow === row) return;
    unguardRow();
    guardedRow = row;
    row?.addEventListener('touchmove', blockTouchMove, { passive: false });
  };
  const unguardRow = () => {
    guardedRow?.removeEventListener('touchmove', blockTouchMove, { passive: false });
    guardedRow = null;
  };

  // `holding`: what this module wants; `held`: what the owner was told. A
  // release waits for the click it makes, so a tap lands on the row it was
  // on rather than on one a re-render put there; a drop lets go at once.
  let held = false;
  let releaseTimer = null;
  const settleRelease = () => {
    if (releaseTimer !== null) clearTimeout(releaseTimer);
    releaseTimer = null;
    windowRef.removeEventListener('click', onReleaseClick, true);
    if (!holding && held) {
      held = false;
      onHold(false);
    }
  };
  function onReleaseClick() {
    setTimeout(settleRelease, 0);
  }
  const hold = (on, { now = false } = {}) => {
    if (holding !== on) holding = on;
    if (on) {
      if (releaseTimer !== null) clearTimeout(releaseTimer);
      releaseTimer = null;
      windowRef.removeEventListener('click', onReleaseClick, true);
      if (!held) {
        held = true;
        onHold(true);
      }
      return;
    }
    if (!held) return;
    if (now) {
      settleRelease();
      return;
    }
    if (releaseTimer !== null) return;
    windowRef.addEventListener('click', onReleaseClick, true);
    releaseTimer = setTimeout(settleRelease, releaseFallbackMs);
  };

  const rowFor = (key) => {
    if (!key) return null;
    if (key.startsWith('group:')) return list.querySelector(`.conv-group-synthetic[data-group-id="${cssEscape(key.slice(6))}"]`);
    return list.querySelector(`.conv-item[data-conversation-id="${cssEscape(key)}"]`);
  };

  const draggableRow = (target) => {
    const row = target?.closest?.('.conv-item');
    if (!row || !list.contains(row) || !row.dataset.conversationId) return null;
    const control = target.closest(NOT_A_HANDLE);
    if (control && control !== row && row.contains(control)) return null;
    return row;
  };

  // ── Lift (a long press on touch) ──
  /** Whether a long press may lift this row: a row with a conversation, while dragging is on. */
  function canLift(row) {
    return !!row?.dataset?.conversationId && isEnabled();
  }

  function lift(row) {
    unlift();
    if (!canLift(row)) return false;
    liftedRow = row;
    hold(true);
    guardRow(row);
    row.classList.add('conv-drag-lifted');
    windowRef.navigator?.vibrate?.(10);
    return true;
  }

  function unlift() {
    if (!liftedRow) return;
    liftedRow.classList.remove('conv-drag-lifted');
    rowFor(conversationRowKey(liftedRow))?.classList.remove('conv-drag-lifted');
    liftedRow = null;
    if (!session) {
      unguardRow();
      if (touchPress === null) hold(false);
    }
  }

  // ── The drag ──
  function markSource() {
    if (!session) return;
    for (const node of list.querySelectorAll('.conv-drag-source')) {
      if (node.dataset.conversationId !== session.id) node.classList.remove('conv-drag-source');
    }
    rowFor(session.id)?.classList.add('conv-drag-source');
  }

  function clearMarks() {
    for (const name of DROP_CLASSES) {
      for (const node of list.querySelectorAll(`.${name}`)) node.classList.remove(name);
    }
  }

  function paint() {
    clearMarks();
    const result = session?.result || NO_DROP;
    list.dataset.dropAction = result.action;
    if (result.action === 'none' || !result.indicator) return;
    const row = rowFor(result.indicator.itemId);
    if (result.groupId) {
      for (const node of list.querySelectorAll(`.conv-item[data-group-id="${cssEscape(result.groupId)}"]`)) node.classList.add('conv-drop-group');
    }
    if (!row) return;
    if (result.action === 'new-group') row.classList.add('conv-drop-new-group');
    else if (result.indicator.edge === 'before') row.classList.add('conv-drop-before');
    else if (result.indicator.edge === 'after') row.classList.add('conv-drop-after');
    else row.classList.add('conv-drop-inside');
  }

  /** What the pointer is over: `{ key, y }` on a row, `{ below: true }` under the last one, or null. */
  function hoverAt(x, y) {
    const box = list.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null;
    const rows = [...list.querySelectorAll('.conv-item')];
    if (!rows.length) return null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      // The gap under a row (its margin) counts as that row's bottom.
      if (y < rect.top) return { key: conversationRowKey(row), y: 0 };
      if (y <= rect.bottom + 2) return { key: conversationRowKey(row), y: rect.height > 0 ? (y - rect.top) / rect.height : 0.5 };
    }
    return { below: true };
  }

  function update(x, y) {
    if (!session) return;
    session.x = x;
    session.y = y;
    session.ghost.style.transform = `translate(${Math.round(x - session.offsetX)}px, ${Math.round(y - session.offsetY)}px)`;
    const hover = hoverAt(x, y);
    if (!hover && session.pointerType !== 'mouse') {
      // A finger that leaves the list gives the row back.
      end(false);
      return;
    }
    const items = describeItems();
    session.result = resolveDropTarget({ items, draggedId: session.id, hover });
    paint();
    const hovered = hover?.key ? items.find((item) => item.key === hover.key) : null;
    const foldedGroupId = hovered?.kind === 'head' && hovered.open === false ? hovered.groupId : null;
    if (foldedGroupId === session.unfoldGroupId) return;
    if (session.unfoldTimer) clearTimeout(session.unfoldTimer);
    session.unfoldTimer = null;
    session.unfoldGroupId = foldedGroupId;
    if (!foldedGroupId) return;
    session.unfoldTimer = setTimeout(() => {
      if (!session) return;
      session.unfoldTimer = null;
      session.unfolded.add(foldedGroupId);
      setDragOpen(foldedGroupId, true);
      rerender();
      markSource();
      session.unfoldGroupId = null;
      update(session.x, session.y);
    }, UNFOLD_HOVER_MS);
  }

  function frame() {
    if (!session) return;
    const box = list.getBoundingClientRect();
    const step = autoScrollStep(session.y, box.top, box.bottom);
    if (step) {
      const before = list.scrollTop;
      list.scrollTop = before + step;
      if (list.scrollTop !== before) update(session.x, session.y);
    }
    if (session) session.frame = windowRef.requestAnimationFrame(frame);
  }

  function makeGhost(row, rect) {
    const ghost = row.cloneNode(true);
    ghost.removeAttribute('onclick');
    ghost.removeAttribute('id');
    for (const node of ghost.querySelectorAll('button, [onclick], [id]')) {
      if (node.matches('button')) node.remove();
      else {
        node.removeAttribute('onclick');
        node.removeAttribute('id');
      }
    }
    ghost.classList.remove('conv-drag-lifted', 'conv-drag-source', ...DROP_CLASSES);
    ghost.classList.add('conv-drag-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.removeAttribute('data-conversation-id');
    ghost.removeAttribute('data-group-id');
    ghost.style.width = `${Math.round(rect.width)}px`;
    return ghost;
  }

  const onMove = (event) => {
    if (!session || event.pointerId !== session.pointerId) return;
    update(event.clientX, event.clientY);
  };
  const onUp = (event) => {
    if (!session || event.pointerId !== session.pointerId) return;
    end(true);
  };
  const onCancel = (event) => {
    if (!session || event.pointerId !== session.pointerId) return;
    end(false);
  };
  const onKey = (event) => {
    if (!session || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    end(false);
  };
  const onBlur = () => end(false);

  function begin(row, startX, startY, event) {
    if (session || !isEnabled()) return false;
    const id = String(row?.dataset?.conversationId || '').trim();
    if (!id || !describeItems().some((item) => item.conversationId === id)) return false;
    // The row on screen now: a mouse press may have outlived a re-render.
    const shown = rowFor(id) || row;
    const rect = shown.getBoundingClientRect();
    const ghost = makeGhost(shown, rect);
    ghost.style.left = '0px';
    ghost.style.top = '0px';
    documentRef.body.append(ghost);
    session = {
      id,
      title: row.querySelector('.conv-title')?.textContent?.trim() || '',
      pointerId: event.pointerId,
      pointerType: event.pointerType || 'mouse',
      ghost,
      offsetX: startX - rect.left,
      offsetY: startY - rect.top,
      x: startX,
      y: startY,
      result: NO_DROP,
      unfoldTimer: null,
      unfoldGroupId: null,
      unfolded: new Set(),
      frame: 0,
    };
    hold(true);
    if (session.pointerType !== 'mouse') guardRow(row);
    if (liftedRow) {
      liftedRow.classList.remove('conv-drag-lifted');
      liftedRow = null;
    }
    markSource();
    list.classList.add('conv-list-dragging');
    // No page scroll, pull-to-refresh or drawer gesture under the finger.
    list.style.touchAction = 'none';
    try { list.setPointerCapture?.(event.pointerId); } catch {}
    documentRef.addEventListener('pointermove', onMove, true);
    documentRef.addEventListener('pointerup', onUp, true);
    documentRef.addEventListener('pointercancel', onCancel, true);
    documentRef.addEventListener('keydown', onKey, true);
    windowRef.addEventListener('blur', onBlur);
    update(event.clientX, event.clientY);
    if (session) session.frame = windowRef.requestAnimationFrame(frame);
    return true;
  }

  function end(commit) {
    const ended = session;
    if (!ended) return;
    session = null;
    if (ended.frame) windowRef.cancelAnimationFrame(ended.frame);
    if (ended.unfoldTimer) clearTimeout(ended.unfoldTimer);
    documentRef.removeEventListener('pointermove', onMove, true);
    documentRef.removeEventListener('pointerup', onUp, true);
    documentRef.removeEventListener('pointercancel', onCancel, true);
    documentRef.removeEventListener('keydown', onKey, true);
    windowRef.removeEventListener('blur', onBlur);
    try { list.releasePointerCapture?.(ended.pointerId); } catch {}
    ended.ghost.remove();
    clearMarks();
    delete list.dataset.dropAction;
    for (const node of list.querySelectorAll('.conv-drag-source, .conv-drag-lifted')) node.classList.remove('conv-drag-source', 'conv-drag-lifted');
    list.classList.remove('conv-list-dragging');
    list.style.touchAction = '';
    unguardRow();
    swallowClicksUntil = Date.now() + CLICK_GUARD_MS;
    const result = commit ? ended.result : NO_DROP;
    const landed = result.action !== 'none' ? result.groupId : null;
    for (const groupId of ended.unfolded) {
      if (groupId !== landed) setDragOpen(groupId, false);
    }
    hold(false, { now: true });
    if (result.action !== 'none') onDrop(result, ended.id);
  }

  // Mouse: a press on a row becomes a drag after a few pixels.
  list.addEventListener('pointerdown', (event) => {
    if (session) return;
    if (event.pointerType !== 'mouse') {
      const row = event.target?.closest?.('.conv-item');
      if (!row || !list.contains(row)) return;
      touchPress = event.pointerId;
      hold(true);
      return;
    }
    if (event.button !== 0) return;
    const row = draggableRow(event.target);
    mousePress = row && isEnabled() ? { row, x: event.clientX, y: event.clientY, pointerId: event.pointerId } : null;
  });
  const endTouchPress = (event) => {
    if (touchPress === null || (event && event.pointerId !== touchPress)) return;
    touchPress = null;
    if (!session && !liftedRow) hold(false);
  };
  // Captured on the document, ahead of the long press's own release.
  documentRef.addEventListener('pointerup', endTouchPress, true);
  documentRef.addEventListener('pointercancel', endTouchPress, true);
  windowRef.addEventListener('blur', () => endTouchPress(null));
  list.addEventListener('pointermove', (event) => {
    if (session || !mousePress || event.pointerId !== mousePress.pointerId) return;
    if ((event.buttons & 1) === 0) {
      mousePress = null;
      return;
    }
    if (Math.hypot(event.clientX - mousePress.x, event.clientY - mousePress.y) <= MOUSE_DRAG_THRESHOLD_PX) return;
    const press = mousePress;
    mousePress = null;
    if (begin(press.row, press.x, press.y, event)) event.preventDefault();
  });
  for (const name of ['pointerup', 'pointercancel']) {
    list.addEventListener(name, () => { mousePress = null; });
  }
  // The click that ends a drag opens nothing; the next press is the user's again.
  windowRef.addEventListener('pointerdown', () => { swallowClicksUntil = 0; }, true);
  windowRef.addEventListener('click', (event) => {
    // A click from the keyboard (Enter, Space) is never the drag's.
    if (event.detail === 0 || Date.now() >= swallowClicksUntil) return;
    swallowClicksUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  // A lifted or dragged row keeps the finger: the list does not scroll under it.
  list.addEventListener('touchmove', (event) => {
    if ((session || liftedRow) && event.cancelable) event.preventDefault();
  }, { passive: false });

  // A page sent to the background gives the row back: a drag ends as a
  // cancel, and a finger's hold ends without a menu.
  documentRef.addEventListener('visibilitychange', () => {
    if (!documentRef.hidden) return;
    end(false);
    touchPress = null;
    if (liftedRow) {
      liftedRow.classList.remove('conv-drag-lifted');
      liftedRow = null;
    }
    unguardRow();
    hold(false, { now: true });
  });

  return {
    canLift,
    lift,
    unlift,
    /** A lifted row moved: start the drag from where the press began. */
    beginTouchDrag(row, startX, startY, event) {
      if (!begin(row, startX, startY, event)) return false;
      return true;
    },
    cancel() { end(false); },
    isActive() { return !!session; },
  };
}
