// The composer's @mention popup for remote relays: typing "@" at the start of a
// word lists the relays this relay is paired with, and picking one inserts
// "@name " — the mention that unlocks that relay for the conversation's agent
// (docs/plans/2026-09-27-remote-relays.md, decisions 9 and 10).
//
// A sibling of slash-autocomplete.mjs with the same key contract: nothing is
// highlighted by default, so plain Enter keeps its newline and Ctrl/Cmd+Enter
// keeps sending; only an arrow-selected row makes Enter accept; Tab accepts
// the highlighted row or the top one. The popup closes as soon as the typed
// token matches no relay — "@file:" and friends are never touched — and it
// never opens while the slash menu is open, so exactly one popup owns the keys.

import { mentionQueryAt, mentionTokenEnd } from './remote-relay-shared.mjs';
import {
  ensureRemoteRelaysLoaded,
  getRemoteRelays,
  getRemoteRelaysSnapshot,
  remoteRelayStatus,
  subscribeRemoteRelays,
} from './remote-relays-store.mjs';
import { isSlashAutocompleteOpen } from './slash-autocomplete.mjs';

const POPUP_ID = 'mention-autocomplete-popup';
const OPTION_ID_PREFIX = 'mention-autocomplete-option-';

let openState = null; // { items, start } while the popup is visible
let selectedIndex = -1;
// The composer that typed "@" before the list was loaded; the load re-runs it.
let pendingInput = null;

function popupEl() {
  return document.getElementById(POPUP_ID);
}

function composerInput() {
  return document.getElementById('msg-input');
}

function hostOf(relay) {
  const explicit = String(relay?.host || '').trim().toLowerCase();
  if (explicit) return explicit;
  try {
    return new URL(String(relay?.url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The popup rows for `query` (the text after "@", lowercase): relays whose name
 * or URL host starts with it. `insert` is what a pick writes: "@name", or
 * "@host" when the name is empty or shared by two relays (a shared name is
 * ambiguous and would unlock nothing).
 */
export function mentionCandidates(relays, query = '') {
  const list = Array.isArray(relays) ? relays : [];
  const wanted = String(query || '').trim().toLowerCase();
  const nameCounts = new Map();
  for (const relay of list) {
    const key = String(relay?.name || '').trim().toLowerCase();
    if (key) nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }
  const items = [];
  for (const relay of list) {
    const id = String(relay?.id || '').trim();
    const name = String(relay?.name || '').trim();
    const host = hostOf(relay);
    if (!id || (!name && !host)) continue;
    if (wanted && !name.toLowerCase().startsWith(wanted) && !host.startsWith(wanted)) continue;
    const ambiguous = !!name && nameCounts.get(name.toLowerCase()) > 1;
    const insertName = (!name || ambiguous) && host ? host : name;
    items.push({
      id,
      name: name || host,
      host,
      status: remoteRelayStatus(relay),
      insert: `@${insertName}`,
    });
  }
  return items;
}

export function isMentionAutocompleteOpen() {
  return openState !== null;
}

function syncInputAria(input) {
  const target = input || composerInput();
  if (!target) return;
  if (!openState) {
    target.removeAttribute('aria-activedescendant');
    target.setAttribute('aria-expanded', 'false');
    return;
  }
  target.setAttribute('aria-controls', POPUP_ID);
  target.setAttribute('aria-expanded', 'true');
  if (selectedIndex >= 0) target.setAttribute('aria-activedescendant', `${OPTION_ID_PREFIX}${selectedIndex}`);
  else target.removeAttribute('aria-activedescendant');
}

export function closeMentionAutocomplete() {
  const wasOpen = openState !== null;
  openState = null;
  selectedIndex = -1;
  const popup = popupEl();
  if (popup) {
    popup.classList.remove('visible');
    popup.setAttribute('aria-hidden', 'true');
    popup.textContent = '';
  }
  if (wasOpen) syncInputAria(null);
}

function renderPopup(input) {
  const popup = popupEl();
  if (!popup || !openState) return;
  popup.textContent = '';
  openState.items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'slash-item mention-item';
    if (index === selectedIndex) row.classList.add('slash-item-selected');
    row.id = `${OPTION_ID_PREFIX}${index}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
    row.dataset.index = String(index);
    row.dataset.relayId = item.id;

    const dot = document.createElement('span');
    dot.className = 'remote-relay-dot';
    dot.dataset.status = item.status;
    dot.setAttribute('aria-hidden', 'true');
    row.appendChild(dot);

    // textContent throughout: names come from other relays.
    const nameEl = document.createElement('span');
    nameEl.className = 'slash-item-name';
    nameEl.textContent = item.name;
    row.appendChild(nameEl);

    if (item.host && item.host !== item.name.toLowerCase()) {
      const hostEl = document.createElement('span');
      hostEl.className = 'slash-item-desc';
      hostEl.textContent = item.host;
      row.appendChild(hostEl);
    }
    popup.appendChild(row);
  });
  popup.classList.add('visible');
  popup.setAttribute('aria-hidden', 'false');
  syncInputAria(input);
}

/**
 * Recomputes the popup for the composer's text and caret. The composer calls
 * this from its input handler, after the slash menu had its turn.
 */
export function updateMentionAutocomplete(input) {
  if (!input) return;
  if (isSlashAutocompleteOpen()) {
    pendingInput = null;
    closeMentionAutocomplete();
    return;
  }
  const text = String(input.value || '');
  const caret = Number.isFinite(input.selectionStart) ? input.selectionStart : text.length;
  const selectionEnd = Number.isFinite(input.selectionEnd) ? input.selectionEnd : caret;
  const query = selectionEnd === caret ? mentionQueryAt(text, caret) : null;
  if (!query) {
    pendingInput = null;
    closeMentionAutocomplete();
    return;
  }
  if (!getRemoteRelaysSnapshot()) {
    // First "@" of the page: fetch the list, and come back once it is here.
    pendingInput = input;
    closeMentionAutocomplete();
    void ensureRemoteRelaysLoaded();
    return;
  }
  pendingInput = null;
  const items = mentionCandidates(getRemoteRelays(), query.query);
  if (!items.length) {
    closeMentionAutocomplete();
    return;
  }
  // A rebuild replaces the rows, so a highlight only survives on the same relay.
  const previous = selectedIndex >= 0 ? openState?.items?.[selectedIndex] : null;
  openState = { items, start: query.start };
  selectedIndex = previous ? items.findIndex((item) => item.id === previous.id) : -1;
  renderPopup(input);
}

function acceptItem(input, index) {
  const item = openState?.items?.[index];
  if (!item || !input) return false;
  const value = String(input.value || '');
  const caret = Number.isFinite(input.selectionStart) ? input.selectionStart : value.length;
  // Re-read the token at the caret: the caret may have moved since the popup
  // was drawn, and a stale range must never overwrite unrelated text.
  const query = mentionQueryAt(value, caret);
  if (!query || query.start !== openState.start) {
    closeMentionAutocomplete();
    return false;
  }
  const end = mentionTokenEnd(value, caret);
  const after = value.slice(end);
  const inserted = /^\s/.test(after) ? item.insert : `${item.insert} `;
  input.value = `${value.slice(0, query.start)}${inserted}${after}`;
  const nextCaret = query.start + item.insert.length + 1;
  input.selectionStart = nextCaret;
  input.selectionEnd = nextCaret;
  closeMentionAutocomplete();
  input.focus();
  // Re-runs the composer's input pipeline (autoResize, draft sync, the menus).
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/**
 * Offers a keydown to the popup. Returns true when consumed; the composer's
 * handleKey calls this after the slash menu's handler and stops on true.
 */
export function handleMentionAutocompleteKey(event, input) {
  if (!openState || event?.isComposing) return false;

  if (event.key === 'Escape') {
    closeMentionAutocomplete();
    event.preventDefault();
    // Swallowed so document-level Escape handlers (modals, pickers) stay put.
    event.stopPropagation();
    return true;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const count = openState.items.length;
    if (!count) return false;
    if (event.key === 'ArrowDown') {
      selectedIndex = selectedIndex >= count - 1 ? 0 : selectedIndex + 1;
    } else {
      // ↑ from the top row returns to "nothing highlighted", so plain Enter's
      // newline stays reachable without Escape.
      selectedIndex = selectedIndex <= 0 ? -1 : selectedIndex - 1;
    }
    renderPopup(input);
    event.preventDefault();
    return true;
  }

  if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (!openState.items.length) return false;
    // A pick the caret no longer supports closes the popup and lets the key through.
    if (!acceptItem(input, selectedIndex >= 0 ? selectedIndex : 0)) return false;
    event.preventDefault();
    return true;
  }

  if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (selectedIndex < 0) return false;
    if (!acceptItem(input, selectedIndex)) return false;
    event.preventDefault();
    return true;
  }

  return false;
}

export function initMentionAutocomplete() {
  const popup = popupEl();
  if (!popup || popup.dataset.bound === '1') return;
  popup.dataset.bound = '1';
  // pointerdown, not click: the textarea loses focus on the tap, and a click
  // handler would race the focus-driven close.
  popup.addEventListener('pointerdown', (event) => {
    const row = event.target?.closest?.('.mention-item');
    if (!row || !openState) return;
    event.preventDefault();
    const input = composerInput();
    if (input) acceptItem(input, Number(row.dataset.index));
  });
  document.addEventListener('pointerdown', (event) => {
    if (!openState) return;
    const target = event.target;
    if (popupEl()?.contains(target)) return;
    if (composerInput()?.contains?.(target)) return;
    closeMentionAutocomplete();
  });
  // The list arrived (lazy load) or changed (remote_relays_updated): redraw
  // for the composer that is waiting on it or showing it.
  subscribeRemoteRelays(() => {
    const waiting = pendingInput;
    pendingInput = null;
    if (waiting && document.activeElement === waiting) {
      updateMentionAutocomplete(waiting);
      return;
    }
    if (openState) updateMentionAutocomplete(composerInput());
  });
}
