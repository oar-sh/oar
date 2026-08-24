import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRelayDotState } from './relay-dot-state.mjs';

const MANAGED_CONNECTED = { mode: 'managed', connected: true };
const MANAGED_DOWN = { mode: 'managed', connected: false };

test('an unreachable relay is grey regardless of tunnel state', () => {
  for (const tunnel of [null, MANAGED_CONNECTED, MANAGED_DOWN]) {
    const state = resolveRelayDotState({ relayOnline: false, cliOnline: true, cloudflaredTunnel: tunnel });
    assert.equal(state.className, 'offline');
    assert.equal(state.title, 'Web relay unreachable');
  }
});

test('a reachable relay with no tunnel configured stays green', () => {
  const state = resolveRelayDotState({ relayOnline: true, cliOnline: true, cloudflaredTunnel: null });
  assert.equal(state.className, 'online');
  assert.equal(state.title, 'Web relay reachable');
});

test('a connected Cloudflare tunnel turns the dot amber', () => {
  const state = resolveRelayDotState({ relayOnline: true, cliOnline: true, cloudflaredTunnel: MANAGED_CONNECTED });
  assert.equal(state.className, 'online tunnelled');
  assert.match(state.title, /via Cloudflare Tunnel/);
});

test('the legacy enabled flag counts as managed', () => {
  const state = resolveRelayDotState({
    relayOnline: true,
    cliOnline: true,
    cloudflaredTunnel: { enabled: true, connected: true },
  });
  assert.equal(state.className, 'online tunnelled');
});

test('a disabled tunnel is ignored even when it reports connected', () => {
  const state = resolveRelayDotState({
    relayOnline: true,
    cliOnline: true,
    cloudflaredTunnel: { mode: 'disabled', connected: true },
  });
  assert.equal(state.className, 'online');
  assert.equal(state.title, 'Web relay reachable');
});

test('a managed but disconnected tunnel stays green and says so', () => {
  // Grey would claim the relay is unreachable, which is false: it still answers
  // locally. The tooltip carries the bad news instead.
  const state = resolveRelayDotState({ relayOnline: true, cliOnline: true, cloudflaredTunnel: MANAGED_DOWN });
  assert.equal(state.className, 'online');
  assert.equal(state.title, 'Web relay reachable; Cloudflare tunnel disconnected');
});

test('a disconnected tunnel surfaces its last error', () => {
  const state = resolveRelayDotState({
    relayOnline: true,
    cliOnline: true,
    cloudflaredTunnel: { mode: 'managed', connected: false, lastError: 'auth-or-config' },
  });
  assert.equal(state.title, 'Web relay reachable; Cloudflare tunnel disconnected (auth-or-config)');
});

test('an offline CLI is reported alongside the tunnel reach', () => {
  const state = resolveRelayDotState({ relayOnline: true, cliOnline: false, cloudflaredTunnel: MANAGED_CONNECTED });
  assert.equal(state.className, 'online tunnelled');
  assert.equal(state.title, 'Web relay reachable via Cloudflare Tunnel; CLI offline');
});

test('worker counts keep their existing wording and pluralisation', () => {
  assert.equal(
    resolveRelayDotState({ relayOnline: true, cliOnline: true, processingCount: 1 }).title,
    'Web relay reachable; 1 session worker processing',
  );
  assert.equal(
    resolveRelayDotState({ relayOnline: true, cliOnline: true, processingCount: 2 }).title,
    'Web relay reachable; 2 session workers processing',
  );
  assert.equal(
    resolveRelayDotState({ relayOnline: true, cliOnline: true, errorCount: 3 }).title,
    'Web relay reachable; 3 session workers degraded',
  );
  assert.equal(
    resolveRelayDotState({ relayOnline: true, cliOnline: true, questionCount: 1 }).title,
    'Web relay reachable; 1 session worker waiting on a question',
  );
});

test('worker precedence is processing, then degraded, then question', () => {
  const state = resolveRelayDotState({
    relayOnline: true,
    cliOnline: true,
    processingCount: 1,
    errorCount: 1,
    questionCount: 1,
  });
  assert.equal(state.title, 'Web relay reachable; 1 session worker processing');
});

test('worker counts combine with the tunnel reach', () => {
  const state = resolveRelayDotState({
    relayOnline: true,
    cliOnline: true,
    cloudflaredTunnel: MANAGED_CONNECTED,
    processingCount: 2,
  });
  assert.equal(state.title, 'Web relay reachable via Cloudflare Tunnel; 2 session workers processing');
});

test('the tone mirrors the dot colour for the mobile burger bars', () => {
  // The burger keys off `tone` alone, so every state must name one.
  assert.equal(resolveRelayDotState({ relayOnline: false, cliOnline: true }).tone, 'offline');
  assert.equal(resolveRelayDotState({ relayOnline: true, cliOnline: true }).tone, 'online');
  assert.equal(
    resolveRelayDotState({ relayOnline: true, cliOnline: true, cloudflaredTunnel: MANAGED_CONNECTED }).tone,
    'tunnelled',
  );
  assert.equal(
    resolveRelayDotState({ relayOnline: true, cliOnline: true, cloudflaredTunnel: MANAGED_DOWN }).tone,
    'online',
  );
  assert.equal(
    resolveRelayDotState({ relayOnline: true, cliOnline: false, cloudflaredTunnel: MANAGED_CONNECTED }).tone,
    'tunnelled',
  );
});

test('a malformed tunnel payload is treated as absent', () => {
  for (const tunnel of ['managed', 42, [], undefined]) {
    const state = resolveRelayDotState({ relayOnline: true, cliOnline: true, cloudflaredTunnel: tunnel });
    assert.equal(state.className, 'online');
  }
});
