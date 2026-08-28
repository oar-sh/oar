import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';

import {
  createPreviewRegistry,
  normalizePreviewsConfig,
} from './preview-registry-service.mjs';
import { createPreviewHealthProbe, probeTcpPort } from './preview-health-probe.mjs';

function previewConfig() {
  return normalizePreviewsConfig({
    enabled: true,
    publicBaseUrl: 'https://preview.example.com',
  }, { env: {}, relayPort: 3333, relayHostnames: ['relay.example.com'] });
}

function laneRegistry(onChange) {
  return createPreviewRegistry({ config: previewConfig(), onChange });
}

test('probeTcpPort reports a listening port as online and a closed one as offline', async (t) => {
  const server = net.createServer((socket) => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  assert.equal(await probeTcpPort({ host: '127.0.0.1', port }), true);

  server.close();
  await once(server, 'close');
  assert.equal(await probeTcpPort({ host: '127.0.0.1', port }), false);
});

test('a probe opens no HTTP request against the app', async (t) => {
  // The dev server's request log should stay clean: liveness is a bare TCP
  // connect, never a GET that shows up as phantom traffic.
  const requests = [];
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => requests.push(chunk.toString('utf8')));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  assert.equal(await probeTcpPort({ host: '127.0.0.1', port: server.address().port }), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(requests, []);
});

test('probeNow marks the registry and emits only on a transition', async () => {
  const changes = [];
  const registry = laneRegistry((event) => changes.push(event.reason));
  const { preview } = registry.create({ port: 5173 });

  let online = true;
  const probeCalls = [];
  const health = createPreviewHealthProbe({
    registry,
    probe: (target) => { probeCalls.push(target); return Promise.resolve(online); },
  });

  assert.equal(await health.probeNow(preview.token), true);
  assert.equal(registry.get(preview.token).online, true);
  assert.deepEqual(probeCalls, [{ host: '127.0.0.1', port: 5173, timeoutMs: 250 }]);

  await health.probeNow(preview.token);
  assert.deepEqual(changes, ['created', 'health']);

  online = false;
  await health.probeNow(preview.token);
  assert.equal(registry.get(preview.token).online, false);
  assert.deepEqual(changes, ['created', 'health', 'health']);
});

test('probeNow on an unknown token is a no-op', async () => {
  const registry = laneRegistry();
  const health = createPreviewHealthProbe({
    registry,
    probe: () => { throw new Error('must not probe an unknown token'); },
  });
  assert.equal(await health.probeNow('a'.repeat(32)), null);
});

test('a sweep probes every live preview', async () => {
  const registry = laneRegistry();
  registry.create({ port: 5001 });
  registry.create({ port: 5002 });

  const probed = [];
  const health = createPreviewHealthProbe({
    registry,
    probe: ({ port }) => { probed.push(port); return Promise.resolve(true); },
  });
  await health.sweep();
  assert.deepEqual(probed.sort(), [5001, 5002]);
});

test('an empty registry sweeps without probing', async () => {
  const registry = laneRegistry();
  const health = createPreviewHealthProbe({
    registry,
    probe: () => { throw new Error('must not probe with an empty registry'); },
  });
  await health.sweep();
});

test('sweeps do not overlap', async () => {
  const registry = laneRegistry();
  registry.create({ port: 5001 });

  let inFlight = 0;
  let maxInFlight = 0;
  let release = null;
  const health = createPreviewHealthProbe({
    registry,
    probe: () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        release = () => { inFlight -= 1; resolve(true); };
      });
    },
  });

  const first = health.sweep();
  await health.sweep(); // returns immediately while the first is still in flight
  release();
  await first;
  assert.equal(maxInFlight, 1);
});

test('start/stop drive an unref-ed interval', () => {
  const registry = laneRegistry();
  const intervals = [];
  const cleared = [];
  const health = createPreviewHealthProbe({
    registry,
    setIntervalImpl: (fn, ms) => {
      const handle = { fn, ms, unrefCalls: 0, unref() { this.unrefCalls += 1; } };
      intervals.push(handle);
      return handle;
    },
    clearIntervalImpl: (handle) => cleared.push(handle),
  });

  health.start();
  health.start(); // idempotent
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 15_000);
  // An idle relay must not be held awake by a probe with nothing to do.
  assert.equal(intervals[0].unrefCalls, 1);
  assert.equal(health.running, true);

  health.stop();
  assert.deepEqual(cleared, [intervals[0]]);
  assert.equal(health.running, false);
  health.stop();
  assert.equal(cleared.length, 1);
});
