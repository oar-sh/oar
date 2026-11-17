import test from 'node:test';
import assert from 'node:assert/strict';

// onCurrentConvChange: the one signal for every switch of the open
// conversation, whichever view calls setCurrentConv (the worker log view
// closes on it).
//
// store.js touches window/document at import time — the same browser-global
// stub the other store-importing suites install.
globalThis.window = {
  location: { pathname: '/' },
  innerHeight: 0,
  addEventListener() {},
};
globalThis.document = {
  documentElement: { clientHeight: 0 },
  addEventListener() {},
  getElementById() { return null; },
};
globalThis.sessionStorage = { getItem() { return ''; }, setItem() {} };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

const store = await import('./store.js');

test('a listener fires once per change of the open conversation, with the new and previous id', () => {
  store.setCurrentConv('conv-a');
  const calls = [];
  const off = store.onCurrentConvChange((id, previous) => calls.push([id, previous]));
  store.setCurrentConv('conv-b');
  assert.deepEqual(calls, [['conv-b', 'conv-a']]);
  assert.equal(store.currentConvId, 'conv-b', 'the listener runs after the change');
  store.setCurrentConv(null);
  assert.deepEqual(calls.at(-1), [null, 'conv-b']);
  off();
});

test('setting the same id again fires nothing', () => {
  store.setCurrentConv('conv-same');
  const calls = [];
  const off = store.onCurrentConvChange((id) => calls.push(id));
  store.setCurrentConv('conv-same');
  assert.deepEqual(calls, []);
  off();
});

test('after unsubscribing a listener no longer fires; a throwing listener breaks neither the switch nor the next listener', () => {
  store.setCurrentConv('conv-1');
  const calls = [];
  const offThrowing = store.onCurrentConvChange(() => { throw new Error('view gone'); });
  const off = store.onCurrentConvChange((id) => calls.push(id));
  store.setCurrentConv('conv-2');
  assert.equal(store.currentConvId, 'conv-2');
  assert.deepEqual(calls, ['conv-2']);
  off();
  offThrowing();
  store.setCurrentConv('conv-3');
  assert.deepEqual(calls, ['conv-2']);
  assert.equal(typeof store.onCurrentConvChange('not a function'), 'function');
});
