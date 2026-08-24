import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createActiveDeviceTracker,
  DEVICE_VISIBILITY_STALE_MS,
} from './push-active-device-service.mjs';

function fakeSocket({ recovered = false, connected = true, data = {} } = {}) {
  const handlers = new Map();
  return {
    connected,
    recovered,
    data,
    on(event, handler) {
      handlers.set(event, handler);
    },
    receive(event, payload) {
      handlers.get(event)?.(payload);
    },
  };
}

function trackerWith(sockets, { staleMs, now } = {}) {
  return createActiveDeviceTracker({
    getSockets: () => sockets.values(),
    ...(staleMs !== undefined ? { staleMs } : {}),
    ...(now ? { now } : {}),
  });
}

test('no sockets means no active device', () => {
  const tracker = trackerWith([]);
  assert.equal(tracker.hasActiveDevice(), false);
});

test('a connected socket without a heartbeat is not active', () => {
  const socket = fakeSocket();
  const tracker = trackerWith([socket]);
  tracker.registerSocket(socket);
  assert.equal(tracker.hasActiveDevice(), false);
});

test('visible heartbeat marks the device active; hidden heartbeat clears it', () => {
  const socket = fakeSocket();
  const tracker = trackerWith([socket]);
  tracker.registerSocket(socket);

  socket.receive('device_visibility', { deviceId: 'device-1', visible: true });
  assert.equal(tracker.hasActiveDevice(), true);
  assert.equal(socket.data.deviceId, 'device-1');

  socket.receive('device_visibility', { deviceId: 'device-1', visible: false });
  assert.equal(tracker.hasActiveDevice(), false);
});

test('a disconnected socket no longer counts even with a fresh visible heartbeat', () => {
  const socket = fakeSocket();
  const tracker = trackerWith([socket]);
  tracker.registerSocket(socket);
  socket.receive('device_visibility', { deviceId: 'device-1', visible: true });
  assert.equal(tracker.hasActiveDevice(), true);

  socket.connected = false;
  assert.equal(tracker.hasActiveDevice(), false);
});

test('a visible heartbeat goes stale after the staleness window', () => {
  let currentTime = 1_000_000;
  const socket = fakeSocket();
  const tracker = trackerWith([socket], { now: () => currentTime });
  tracker.registerSocket(socket);
  socket.receive('device_visibility', { deviceId: 'device-1', visible: true });
  assert.equal(tracker.hasActiveDevice(), true);

  currentTime += DEVICE_VISIBILITY_STALE_MS;
  assert.equal(tracker.hasActiveDevice(), true, 'exactly at the window edge still counts');

  currentTime += 1;
  assert.equal(tracker.hasActiveDevice(), false, 'past the window the heartbeat is stale');
});

test('any active device is enough, across multiple sockets', () => {
  const hidden = fakeSocket();
  const visible = fakeSocket();
  const tracker = trackerWith([hidden, visible]);
  tracker.registerSocket(hidden);
  tracker.registerSocket(visible);
  hidden.receive('device_visibility', { deviceId: 'device-1', visible: false });
  visible.receive('device_visibility', { deviceId: 'device-2', visible: true });
  assert.equal(tracker.hasActiveDevice(), true);
});

// The connectionStateRecovery hazard: a recovered socket carries the restored
// socket.data from before the phone slept, including deviceVisible=true. If it
// were trusted, a pocketed phone would suppress push for every device.
test('recovery-restored deviceVisible=true is reset on registration', () => {
  const socket = fakeSocket({
    recovered: true,
    data: { deviceVisible: true, deviceVisibleAt: Date.now(), deviceId: 'device-1' },
  });
  const tracker = trackerWith([socket]);
  tracker.registerSocket(socket);
  assert.equal(socket.data.deviceVisible, false, 'restored visibility must be cleared');
  assert.equal(tracker.hasActiveDevice(), false);

  // The client's connect-time heartbeat re-asserts visibility one round trip later.
  socket.receive('device_visibility', { deviceId: 'device-1', visible: true });
  assert.equal(tracker.hasActiveDevice(), true);
});

// Second, independent guard for the same hazard: even if the restored flag
// survived (e.g. a future refactor drops the reset), the restored timestamp is
// old and fails the freshness check on its own.
test('a stale restored timestamp fails the freshness check even if the flag survives', () => {
  let currentTime = 10_000_000;
  const socket = fakeSocket({
    recovered: false, // registration reset not triggered
    data: {
      deviceVisible: true,
      deviceVisibleAt: currentTime - DEVICE_VISIBILITY_STALE_MS - 60_000,
      deviceId: 'device-1',
    },
  });
  const tracker = trackerWith([socket], { now: () => currentTime });
  assert.equal(tracker.hasActiveDevice(), false);
});

test('a visible flag without a timestamp is not trusted', () => {
  const socket = fakeSocket({ data: { deviceVisible: true } });
  const tracker = trackerWith([socket]);
  assert.equal(tracker.hasActiveDevice(), false);
});
