// The composer's slash-command autocompletion menu. Rendering and keyboard
// only — what to offer comes from slash-commands.mjs, live preview tokens from
// preview-cards.mjs, and the composer wires both in (conversation-view calls
// update on input and offers every keydown here first).
//
// Enter contract: nothing is highlighted by default, so plain Enter keeps its
// newline and Ctrl/Cmd+Enter keeps sending; only an arrow-selected row makes
// Enter accept. Tab always accepts the top insertable match.

import { completionsFor } from './slash-commands.mjs';
import { getPreviews } from './preview-cards.mjs';

let openState = null; // { items, replaceRange } while the menu is visible
let selectedIndex = -1;

function popupEl() {
  return document.getElementById('slash-autocomplete-popup');
}

export function isSlashAutocompleteOpen() {
  return openState !== null;
}

export function closeSlashAutocomplete() {
  openState = null;
  selectedIndex = -1;
  const popup = popupEl();
  if (!popup) return;
  popup.classList.remove('visible');
  popup.setAttribute('aria-hidden', 'true');
  popup.textContent = '';
}

function insertableIndexes() {
  return (openState?.items || [])
    .map((item, index) => (item.insert !== null ? index : -1))
    .filter((index) => index !== -1);
}

function renderMenu() {
  const popup = popupEl();
  if (!popup || !openState) return;
  popup.textContent = '';
  openState.items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = item.kind === 'hint' ? 'slash-item slash-item-hint' : 'slash-item';
    if (index === selectedIndex) row.classList.add('slash-item-selected');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
    row.dataset.index = String(index);

    const nameEl = document.createElement('span');
    nameEl.className = 'slash-item-name';
    nameEl.textContent = item.display;
    row.appendChild(nameEl);

    if (item.description) {
      // textContent throughout: preview labels are agent-supplied strings.
      const descEl = document.createElement('span');
      descEl.className = 'slash-item-desc';
      descEl.textContent = item.description;
      row.appendChild(descEl);
    }
    popup.appendChild(row);
  });
  popup.classList.add('visible');
  popup.setAttribute('aria-hidden', 'false');
}

function acceptItem(input, index) {
  const item = openState?.items?.[index];
  if (!item || item.insert === null) return false;
  const [start, end] = openState.replaceRange;
  const value = String(input.value || '');
  const inserted = `${item.insert} `;
  input.value = `${value.slice(0, start)}${inserted}${value.slice(end)}`;
  const caret = start + inserted.length;
  input.selectionStart = caret;
  input.selectionEnd = caret;
  input.focus();
  // Re-fires the composer's input pipeline (autoResize + this menu), so
  // accepting a command immediately opens its next completion level.
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/**
 * Recomputes the menu for the current input state. The composer calls this
 * from the textarea's input handler; anything that is not a completable
 * command head closes the menu.
 */
export function updateSlashAutocomplete(input, { conversationId = '' } = {}) {
  if (!input) return;
  const text = String(input.value || '');
  if (!text.startsWith('/')) {
    closeSlashAutocomplete();
    return;
  }
  const caret = Number.isFinite(input.selectionStart) ? input.selectionStart : text.length;
  const next = completionsFor(text, caret, { previews: getPreviews(), conversationId });
  if (!next) {
    closeSlashAutocomplete();
    return;
  }
  // A rebuild replaces the item set, so a stale highlight index must not
  // survive onto a different row.
  const previousSelected = selectedIndex >= 0 ? openState?.items?.[selectedIndex] : null;
  openState = next;
  selectedIndex = previousSelected
    ? next.items.findIndex((item) => item.insert !== null && item.insert === previousSelected.insert)
    : -1;
  renderMenu();
}

/**
 * Offers a keydown to the menu. Returns true when the event was consumed; the
 * composer's own handleKey must call this first and stop on true.
 */
export function handleSlashAutocompleteKey(event, input) {
  if (!openState) return false;

  if (event.key === 'Escape') {
    closeSlashAutocomplete();
    event.preventDefault();
    // Swallowed entirely so the document-level Escape handlers (emoji picker,
    // modals) do not also fire off one keypress.
    event.stopPropagation();
    return true;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const selectable = insertableIndexes();
    if (!selectable.length) return false;
    const position = selectable.indexOf(selectedIndex);
    if (event.key === 'ArrowDown') {
      selectedIndex = position === selectable.length - 1
        ? selectable[0]
        : selectable[position + 1] ?? selectable[0];
    } else {
      // ↑ from the top row returns to the no-highlight state, keeping plain
      // Enter's newline reachable without Escape.
      selectedIndex = position <= 0 ? -1 : selectable[position - 1];
    }
    renderMenu();
    event.preventDefault();
    return true;
  }

  if (event.key === 'Tab') {
    const selectable = insertableIndexes();
    if (!selectable.length) return false;
    const target = selectedIndex >= 0 ? selectedIndex : selectable[0];
    acceptItem(input, target);
    event.preventDefault();
    return true;
  }

  if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
    if (selectedIndex < 0) return false;
    acceptItem(input, selectedIndex);
    event.preventDefault();
    return true;
  }

  return false;
}

export function initSlashAutocomplete() {
  const popup = popupEl();
  if (!popup || popup.dataset.bound === '1') return;
  popup.dataset.bound = '1';
  // pointerdown, not click: the textarea loses focus on the tap, and a click
  // handler would race the focus-driven close.
  popup.addEventListener('pointerdown', (event) => {
    const row = event.target?.closest?.('.slash-item');
    if (!row || !openState) return;
    event.preventDefault();
    const input = document.getElementById('msg-input');
    if (input) acceptItem(input, Number(row.dataset.index));
  });
  document.addEventListener('pointerdown', (event) => {
    if (!openState) return;
    const target = event.target;
    if (popupEl()?.contains(target)) return;
    if (document.getElementById('msg-input')?.contains?.(target)) return;
    closeSlashAutocomplete();
  });
}
