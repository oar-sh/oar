import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_THOUGHT_FOLD_CHOICES,
  THOUGHTS_EXPANDED_CHANGE_EVENT,
  THOUGHTS_EXPANDED_STORAGE_KEY,
  THOUGHTS_EXPANDED_TOGGLE_ID,
  isThoughtsExpanded,
  parseThoughtsExpandedSetting,
  rememberThoughtFoldChoice,
  serializeThoughtsExpandedSetting,
  syncThoughtsExpandedToggle,
  thoughtFoldOpen,
  updateThoughtsExpandedSetting,
} from './thoughts-preference.mjs';

function fakeStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    values,
  };
}

function fakeButton(value) {
  const classes = new Set();
  const attributes = new Map();
  return {
    dataset: { thoughtsExpanded: value },
    classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    setAttribute: (name, v) => attributes.set(name, v),
    getAttribute: (name) => attributes.get(name),
  };
}

// The Settings checkbox and the 🧠 modal's two buttons, both visible.
function fakeDocument() {
  const checkbox = { checked: null };
  const buttons = [fakeButton('on'), fakeButton('off')];
  return {
    checkbox,
    buttons,
    getElementById: (id) => (id === THOUGHTS_EXPANDED_TOGGLE_ID ? checkbox : null),
    querySelectorAll: (selector) => (selector.includes('.ctx-thoughts-btn') ? buttons : []),
  };
}

function fakeTarget() {
  const events = [];
  return { events, dispatchEvent: (event) => { events.push(event); return true; } };
}

test('the setting is on unless it was switched off', () => {
  for (const stored of [null, undefined, '', '1', 'true', 'garbage']) {
    assert.equal(parseThoughtsExpandedSetting(stored), true, String(stored));
  }
  assert.equal(parseThoughtsExpandedSetting('0'), false);
  assert.equal(parseThoughtsExpandedSetting(' FALSE '), false);
  for (const value of [true, false]) {
    assert.equal(parseThoughtsExpandedSetting(serializeThoughtsExpandedSetting(value)), value);
  }
});

test('a browser that never saw the setting has it on, and stores nothing by reading it', () => {
  const store = fakeStore();
  assert.equal(isThoughtsExpanded(store), true);
  assert.equal(store.values.size, 0);
});

test('switching it off is stored, ticks the checkbox off, presses Collapsed and tells the page', () => {
  const store = fakeStore();
  const doc = fakeDocument();
  const target = fakeTarget();
  updateThoughtsExpandedSetting(false, { doc, store, target });

  assert.equal(store.values.get(THOUGHTS_EXPANDED_STORAGE_KEY), '0');
  assert.equal(isThoughtsExpanded(store), false);
  assert.equal(doc.checkbox.checked, false);
  const [expandedBtn, collapsedBtn] = doc.buttons;
  assert.equal(expandedBtn.classList.contains('is-active'), false);
  assert.equal(expandedBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(collapsedBtn.classList.contains('is-active'), true);
  assert.equal(collapsedBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(target.events.length, 1);
  assert.equal(target.events[0].type, THOUGHTS_EXPANDED_CHANGE_EVENT);
  assert.deepEqual(target.events[0].detail, { expanded: false });

  // A reload: a fresh page, the same storage.
  const reloaded = fakeDocument();
  syncThoughtsExpandedToggle(reloaded, store);
  assert.equal(reloaded.checkbox.checked, false);

  updateThoughtsExpandedSetting(true, { doc: reloaded, store, target });
  assert.equal(store.values.get(THOUGHTS_EXPANDED_STORAGE_KEY), '1');
  assert.equal(reloaded.checkbox.checked, true);
  assert.equal(reloaded.buttons[0].classList.contains('is-active'), true);
  assert.deepEqual(target.events[1].detail, { expanded: true });
});

test('storage that throws leaves the setting on, and a page without the controls is left alone', () => {
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  const doc = fakeDocument();
  assert.equal(isThoughtsExpanded(broken), true);
  assert.doesNotThrow(() => updateThoughtsExpandedSetting(false, { doc, store: broken, target: null }));
  assert.equal(doc.checkbox.checked, true);
  assert.doesNotThrow(() => syncThoughtsExpandedToggle({ getElementById: () => null }, fakeStore()));
  assert.doesNotThrow(() => syncThoughtsExpandedToggle(null, fakeStore()));
});

test('a hand fold wins either way, the rest follows the setting', () => {
  assert.equal(thoughtFoldOpen({ choice: 'folded', expanded: true }), false);
  assert.equal(thoughtFoldOpen({ choice: 'open', expanded: false }), true);
  assert.equal(thoughtFoldOpen({ expanded: true }), true);
  assert.equal(thoughtFoldOpen({ expanded: false }), false);
});

test('fold choices are capped, the oldest goes first, and a repeat moves to the end', () => {
  const choices = new Map();
  rememberThoughtFoldChoice(choices, 'a', false, 3);
  rememberThoughtFoldChoice(choices, 'b', true, 3);
  rememberThoughtFoldChoice(choices, 'c', true, 3);
  rememberThoughtFoldChoice(choices, 'a', true, 3);
  rememberThoughtFoldChoice(choices, 'd', false, 3);
  assert.deepEqual([...choices], [['c', 'open'], ['a', 'open'], ['d', 'folded']]);
  rememberThoughtFoldChoice(choices, '', true, 3);
  assert.equal(choices.size, 3);
  assert.equal(MAX_THOUGHT_FOLD_CHOICES, 500);
});
