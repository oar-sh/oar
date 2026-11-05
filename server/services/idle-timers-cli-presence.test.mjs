import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLI_ONLINE_WINDOW_MS,
  CLI_ONLINE_WINDOW_WITH_WORKER_SOCKETS_MS,
  createCliPresence,
} from './idle-timers.mjs';

function setup() {
  let clock = 1_000_000;
  const timers = new Map();
  let nextId = 1;
  let expired = 0;
  const presence = createCliPresence({
    now: () => clock,
    onExpired: () => { expired += 1; },
    setTimeoutImpl: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimeoutImpl: (id) => { timers.delete(id); },
  });
  function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
    }
    clock = until;
  }
  return { presence, advance, timerCount: () => timers.size, expired: () => expired };
}

test('the windows are 10 s without and 45 s with worker sockets', () => {
  assert.equal(CLI_ONLINE_WINDOW_MS, 10_000);
  assert.equal(CLI_ONLINE_WINDOW_WITH_WORKER_SOCKETS_MS, 45_000);
});

test('nothing is armed before the first touch, and nothing expires', () => {
  const { presence, advance, timerCount, expired } = setup();
  assert.equal(presence.isFresh(), false);
  assert.equal(timerCount(), 0);
  advance(60_000);
  assert.equal(expired(), 0);
});

test('a touch is fresh for 10 s with no worker socket, then expires once', () => {
  const { presence, advance, timerCount, expired } = setup();
  presence.touch();
  assert.equal(presence.isFresh(), true);
  assert.equal(timerCount(), 1);
  advance(9_999);
  assert.equal(expired(), 0);
  advance(1);
  assert.equal(expired(), 1);
  assert.equal(presence.isFresh(), false);
  assert.equal(timerCount(), 0, 'offline arms no timer');
  advance(120_000);
  assert.equal(expired(), 1);
});

test('with a worker socket open a touch lasts 45 s', () => {
  const { presence, advance, expired } = setup();
  presence.noteWorkerSocketCount(2);
  presence.touch();
  advance(44_999);
  assert.equal(expired(), 0);
  assert.equal(presence.isFresh(), true);
  advance(1);
  assert.equal(expired(), 1);
});

test('touches keep one deadline timer, which re-arms for the remainder', () => {
  const { presence, advance, timerCount, expired } = setup();
  presence.noteWorkerSocketCount(1);
  presence.touch();
  for (let i = 0; i < 10; i += 1) {
    advance(30_000);
    presence.touch();
    assert.equal(timerCount(), 1);
  }
  assert.equal(expired(), 0);
  advance(45_000);
  assert.equal(expired(), 1);
});

test('the last worker socket closing shortens the window to 10 s', () => {
  const { presence, advance, expired } = setup();
  presence.noteWorkerSocketCount(1);
  presence.touch();
  advance(5_000);
  presence.noteWorkerSocketCount(0);
  assert.equal(expired(), 0, 'still inside 10 s');
  advance(5_000);
  assert.equal(expired(), 1);
});

test('a socket closing after more than 10 s of silence expires at once', () => {
  const { presence, advance, expired } = setup();
  presence.noteWorkerSocketCount(1);
  presence.touch();
  advance(20_000);
  assert.equal(expired(), 0);
  presence.noteWorkerSocketCount(0);
  assert.equal(expired(), 1);
  assert.equal(presence.isFresh(), false);
});

test('clear forgets the touch without calling onExpired', () => {
  const { presence, advance, timerCount, expired } = setup();
  presence.touch();
  presence.clear();
  assert.equal(timerCount(), 0);
  assert.equal(presence.isFresh(), false);
  advance(60_000);
  assert.equal(expired(), 0);
});
