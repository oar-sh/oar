import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AUTO_COMPACT_CLOSE_SAVE_KEY,
  AUTO_COMPACT_CLOSE_SAVE_MAX_AGE_MS,
  autoCompactCloseSaveAction,
  rememberAutoCompactCloseSave,
  takeAutoCompactCloseSave,
} from './auto-compact-close-save.mjs';

function memoryStorage({ refuseWrites = false } = {}) {
  const items = new Map();
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => {
      if (refuseWrites) throw new Error('QuotaExceededError');
      items.set(key, String(value));
    },
    removeItem: (key) => { items.delete(key); },
  };
}

const NOW = 1_800_000_000_000;

test('a closing page keeps its save, and the next start takes it once', () => {
  const storage = memoryStorage();
  assert.equal(rememberAutoCompactCloseSave(storage, { conversationId: 'conv-a', window: 300000, base: null, nowMs: NOW }), true);
  assert.deepEqual(takeAutoCompactCloseSave(storage, { nowMs: NOW + 1000 }), { conversationId: 'conv-a', window: 300000, base: null, at: NOW });
  assert.equal(storage.items.has(AUTO_COMPACT_CLOSE_SAVE_KEY), false);
  assert.equal(takeAutoCompactCloseSave(storage, { nowMs: NOW + 2000 }), null);
});

test('back to Auto is a save too; a window that is no stop, or no change, is not kept', () => {
  const storage = memoryStorage();
  assert.equal(rememberAutoCompactCloseSave(storage, { conversationId: 'conv-a', window: null, base: 200000, nowMs: NOW }), true);
  assert.deepEqual(takeAutoCompactCloseSave(storage, { nowMs: NOW }), { conversationId: 'conv-a', window: null, base: 200000, at: NOW });
  assert.equal(rememberAutoCompactCloseSave(storage, { conversationId: 'conv-a', window: 123456, base: null, nowMs: NOW }), false);
  assert.equal(rememberAutoCompactCloseSave(storage, { conversationId: 'conv-a', window: 300000, base: 300000, nowMs: NOW }), false);
  assert.equal(rememberAutoCompactCloseSave(storage, { conversationId: 'conv-a', window: 300000, base: undefined, nowMs: NOW }), false);
  assert.equal(rememberAutoCompactCloseSave(storage, { conversationId: '  ', window: 300000, base: null, nowMs: NOW }), false);
  assert.equal(rememberAutoCompactCloseSave(storage, { conversationId: 'x'.repeat(201), window: 300000, base: null, nowMs: NOW }), false);
  assert.equal(storage.items.size, 0);
});

test('a storage that refuses, or none, keeps nothing and throws nothing', () => {
  assert.equal(rememberAutoCompactCloseSave(memoryStorage({ refuseWrites: true }), { conversationId: 'conv-a', window: 300000, base: null, nowMs: NOW }), false);
  assert.equal(rememberAutoCompactCloseSave(null, { conversationId: 'conv-a', window: 300000, base: null, nowMs: NOW }), false);
  assert.equal(takeAutoCompactCloseSave(null, { nowMs: NOW }), null);
});

test('a kept save too old, from the future, or unreadable is dropped (and removed)', () => {
  const storage = memoryStorage();
  rememberAutoCompactCloseSave(storage, { conversationId: 'conv-a', window: 300000, base: null, nowMs: NOW });
  assert.equal(takeAutoCompactCloseSave(storage, { nowMs: NOW + AUTO_COMPACT_CLOSE_SAVE_MAX_AGE_MS + 1 }), null);
  assert.equal(storage.items.size, 0);

  rememberAutoCompactCloseSave(storage, { conversationId: 'conv-a', window: 300000, base: null, nowMs: NOW });
  assert.equal(takeAutoCompactCloseSave(storage, { nowMs: NOW - 1 }), null);

  for (const raw of ['{', '"text"', JSON.stringify({ conversationId: 'conv-a', window: 123, base: null, at: NOW }), JSON.stringify({ conversationId: 'conv-a', window: 300000, at: NOW })]) {
    storage.items.set(AUTO_COMPACT_CLOSE_SAVE_KEY, raw);
    assert.equal(takeAutoCompactCloseSave(storage, { nowMs: NOW }), null, raw);
    assert.equal(storage.items.size, 0);
  }
});

test('the next start sends it only while the relay still holds what the closing page saw', () => {
  const entry = { conversationId: 'conv-a', window: 300000, base: null, at: NOW };
  // The closing page's request got through.
  assert.equal(autoCompactCloseSaveAction(entry, 300000), 'done');
  // It did not: the relay still holds the value the page saw.
  assert.equal(autoCompactCloseSaveAction(entry, null), 'send');
  assert.equal(autoCompactCloseSaveAction(entry, undefined), 'send');
  // Changed elsewhere since: that change stays.
  assert.equal(autoCompactCloseSaveAction(entry, 500000), 'drop');
  assert.equal(autoCompactCloseSaveAction({ ...entry, window: null, base: 200000 }, 200000), 'send');
  assert.equal(autoCompactCloseSaveAction({ ...entry, window: null, base: 200000 }, null), 'done');
  assert.equal(autoCompactCloseSaveAction(null, null), 'drop');
});

// bootstrap.js sends the close-time save from `pagehide`; a module that does
// not parse (a name imported twice after a merge, say) starts no app at all.
test('bootstrap.js, which sends the close-time save, parses as a module', () => {
  const file = fileURLToPath(new URL('./bootstrap.js', import.meta.url));
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(checked.status, 0, String(checked.stderr || '').split('\n').slice(0, 5).join('\n'));
});
