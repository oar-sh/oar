// The context modal's compaction window slider is saved when the modal is
// left. A page that goes away with the modal still open (tab closed, app
// swiped away, a reload) sends that save from `pagehide` as a keepalive
// request, which the browser may still drop with the page. So the save is
// also written here (localStorage is written at once and outlives the page),
// and the next start of the app on this browser sends it once more: only
// while the relay still holds the value the closing page saw (`base`), so a
// change made anywhere else since then is never overwritten, and never after
// AUTO_COMPACT_CLOSE_SAVE_MAX_AGE_MS.

import { AUTO_COMPACT_WINDOW_STOPS, parseAutoCompactWindow } from './auto-compact-window-options.mjs';

export const AUTO_COMPACT_CLOSE_SAVE_KEY = 'oar_auto_compact_close_save';
export const AUTO_COMPACT_CLOSE_SAVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CONVERSATION_ID_MAX = 200;

// A window as the slider has it: one of the stops, null for Auto.
function windowValue(value) {
  if (value === null) return null;
  return AUTO_COMPACT_WINDOW_STOPS.includes(value) ? value : undefined;
}

function conversationIdValue(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= CONVERSATION_ID_MAX ? text : '';
}

/**
 * Keeps the save a closing page sends: `window` for `conversationId`, made
 * while the relay held `base`. False when there is nothing valid to keep or
 * the storage refused it.
 */
export function rememberAutoCompactCloseSave(storage, { conversationId, window, base, nowMs } = {}) {
  const id = conversationIdValue(conversationId);
  const draft = windowValue(window);
  const stored = windowValue(base);
  if (!storage || !id || draft === undefined || stored === undefined || draft === stored) return false;
  try {
    storage.setItem(AUTO_COMPACT_CLOSE_SAVE_KEY, JSON.stringify({
      conversationId: id,
      window: draft,
      base: stored,
      at: Number(nowMs) || 0,
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * The kept save, taken out of the storage (so a second tab starting at the
 * same time does not send it too), or null: none, unreadable, or older than
 * AUTO_COMPACT_CLOSE_SAVE_MAX_AGE_MS.
 */
export function takeAutoCompactCloseSave(storage, { nowMs } = {}) {
  if (!storage) return null;
  let raw = null;
  try {
    raw = storage.getItem(AUTO_COMPACT_CLOSE_SAVE_KEY);
    if (raw !== null) storage.removeItem(AUTO_COMPACT_CLOSE_SAVE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let entry = null;
  try { entry = JSON.parse(raw); } catch { return null; }
  const id = conversationIdValue(entry?.conversationId);
  const draft = windowValue(entry?.window);
  const stored = windowValue(entry?.base);
  const at = Number(entry?.at);
  if (!id || draft === undefined || stored === undefined || !Number.isFinite(at)) return null;
  const age = Number(nowMs) - at;
  if (!(age >= 0 && age <= AUTO_COMPACT_CLOSE_SAVE_MAX_AGE_MS)) return null;
  return { conversationId: id, window: draft, base: stored, at };
}

/**
 * What to do with a kept save now that the relay holds `storedWindow`:
 * 'done' (the closing page's request got through), 'send' (the relay still
 * holds what the closing page saw), or 'drop' (it was changed since).
 */
export function autoCompactCloseSaveAction(entry, storedWindow) {
  if (!entry) return 'drop';
  const current = parseAutoCompactWindow(storedWindow);
  if (current === entry.window) return 'done';
  return current === entry.base ? 'send' : 'drop';
}
