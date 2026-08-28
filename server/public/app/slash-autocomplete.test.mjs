import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// The menu builds real DOM nodes and reads caret positions, so it gets a real
// document; one JSDOM instance for the file since init binds document-level
// listeners once.
const dom = new JSDOM(`<!doctype html><html><body>
  <textarea id="msg-input"></textarea>
  <div id="slash-autocomplete-popup" aria-hidden="true" role="listbox"></div>
</body></html>`, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.Event = dom.window.Event;

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const { setPreviews } = await import('./preview-cards.mjs');
const {
  closeSlashAutocomplete,
  handleSlashAutocompleteKey,
  initSlashAutocomplete,
  isSlashAutocompleteOpen,
  updateSlashAutocomplete,
} = await import('./slash-autocomplete.mjs');

initSlashAutocomplete();

const TOKEN = 'a1b2c3d4' + 'e'.repeat(24);

const input = document.getElementById('msg-input');
const popup = document.getElementById('slash-autocomplete-popup');

function type(text, caret = text.length) {
  input.value = text;
  input.selectionStart = caret;
  input.selectionEnd = caret;
  updateSlashAutocomplete(input, { conversationId: 'conv-1' });
}

function key(name, modifiers = {}) {
  const event = new dom.window.KeyboardEvent('keydown', { key: name, cancelable: true, ...modifiers });
  const handled = handleSlashAutocompleteKey(event, input);
  return { handled, defaultPrevented: event.defaultPrevented };
}

function rows() {
  return [...popup.querySelectorAll('.slash-item')];
}

function selectedRow() {
  return popup.querySelector('.slash-item-selected');
}

test.beforeEach(() => {
  setPreviews([]);
  closeSlashAutocomplete();
  input.value = '';
});

test('typing "/" opens the menu; clearing closes it', () => {
  type('/');
  assert.equal(isSlashAutocompleteOpen(), true);
  assert.equal(popup.classList.contains('visible'), true);
  assert.deepEqual(rows().map((row) => row.querySelector('.slash-item-name').textContent), ['/compact', '/preview']);

  type('hello');
  assert.equal(isSlashAutocompleteOpen(), false);
  assert.equal(popup.classList.contains('visible'), false);
});

test('nothing is highlighted by default and plain Enter falls through', () => {
  type('/pre');
  assert.equal(selectedRow(), null);
  const enter = key('Enter');
  assert.equal(enter.handled, false);
});

test('arrows move the highlight, wrap down, and return to none via up', () => {
  type('/');
  key('ArrowDown');
  assert.equal(selectedRow().querySelector('.slash-item-name').textContent, '/compact');
  key('ArrowDown');
  assert.equal(selectedRow().querySelector('.slash-item-name').textContent, '/preview');
  key('ArrowDown');
  assert.equal(selectedRow().querySelector('.slash-item-name').textContent, '/compact');
  key('ArrowUp');
  key('ArrowUp');
  assert.equal(selectedRow(), null);
});

test('Enter accepts the arrow-selected row and reopens the next level', () => {
  type('/pre');
  key('ArrowDown');
  const enter = key('Enter');
  assert.equal(enter.handled, true);
  assert.equal(input.value, '/preview ');
  assert.equal(input.selectionStart, 9);
  // The accept dispatched an input event; the composer pipeline would call
  // update — simulate that hop and the subcommand level appears.
  updateSlashAutocomplete(input, { conversationId: 'conv-1' });
  assert.deepEqual(
    rows().map((row) => row.querySelector('.slash-item-name').textContent),
    ['list', 'close', '<port>', '<dir>'],
  );
});

test('Ctrl+Enter is never consumed, selected or not', () => {
  type('/pre');
  key('ArrowDown');
  assert.equal(key('Enter', { ctrlKey: true }).handled, false);
  assert.equal(key('Enter', { metaKey: true }).handled, false);
});

test('Tab accepts the top match with no selection', () => {
  type('/com');
  const tab = key('Tab');
  assert.equal(tab.handled, true);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(input.value, '/compact ');
});

test('hint rows are skipped by arrows and not Tab-insertable', () => {
  type('/preview x');
  assert.equal(isSlashAutocompleteOpen(), false);
  type('/preview ');
  // 2 subcommands + 2 hints; arrows cycle only the 2 insertables.
  key('ArrowDown');
  key('ArrowDown');
  assert.equal(selectedRow().querySelector('.slash-item-name').textContent, 'close');
  key('ArrowDown');
  assert.equal(selectedRow().querySelector('.slash-item-name').textContent, 'list');
});

test('live preview tokens complete for close, labels rendered inert', () => {
  setPreviews([{
    token: TOKEN,
    conversationId: 'conv-1',
    label: '<img src=x onerror=alert(1)>',
    url: 'https://p/x/',
  }]);
  type('/preview close ');
  const row = rows()[0];
  assert.equal(row.querySelector('.slash-item-name').textContent, TOKEN.slice(0, 8));
  const desc = row.querySelector('.slash-item-desc');
  assert.equal(desc.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(desc.querySelector('img'), null);

  key('Tab');
  assert.equal(input.value, `/preview close ${TOKEN} `);
});

test('Escape closes and swallows the event', () => {
  type('/');
  const esc = key('Escape');
  assert.equal(esc.handled, true);
  assert.equal(esc.defaultPrevented, true);
  assert.equal(isSlashAutocompleteOpen(), false);
  // A second Escape with the menu closed is not consumed.
  assert.equal(key('Escape').handled, false);
});

test('tapping a row accepts it', () => {
  type('/pre');
  const row = rows()[0];
  row.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  assert.equal(input.value, '/preview ');
});

test('a keydown with the menu closed is never consumed', () => {
  type('plain text');
  for (const name of ['ArrowDown', 'Tab', 'Enter', 'Escape']) {
    assert.equal(key(name).handled, false, `${name} must pass through`);
  }
});

test('the highlight survives a rebuild only when the same item still exists', () => {
  type('/');
  key('ArrowDown');
  key('ArrowDown');
  assert.equal(selectedRow().querySelector('.slash-item-name').textContent, '/preview');
  type('/pre');
  assert.equal(selectedRow().querySelector('.slash-item-name').textContent, '/preview');
  type('/com');
  assert.equal(selectedRow(), null);
});
