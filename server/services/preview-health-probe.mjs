'use strict';

import net from 'net';

// Liveness for preview cards. Previews never auto-close, so the card has to say
// whether the dev server behind it is still up — a TCP connect is enough and,
// unlike an HTTP request, leaves nothing in the app's request log.

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 250;

export function probeTcpPort({ host, port, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, connect = net.connect } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (online) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(online);
    };
    const socket = connect({ host, port });
    socket.setTimeout?.(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export function createPreviewHealthProbe({
  registry,
  intervalMs = DEFAULT_INTERVAL_MS,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  probe = probeTcpPort,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let timer = null;
  let sweeping = false;

  async function probeNow(token) {
    const entry = registry.get(token);
    if (!entry) return null;
    // Static previews have no upstream to die; they are online by definition.
    if (entry.mode === 'static') return true;
    const online = await probe({
      host: entry.targetHost,
      port: entry.targetPort,
      timeoutMs: connectTimeoutMs,
    });
    registry.markHealth(entry.token, online);
    return online;
  }

  async function sweep() {
    // A slow sweep must not overlap itself; with the registry capped at 8
    // previews and a 250ms connect budget, one pass is bounded at ~2s anyway.
    if (sweeping) return;
    const previews = registry.list().filter((entry) => entry.mode !== 'static');
    if (previews.length === 0) return;
    sweeping = true;
    try {
      await Promise.all(previews.map((entry) => probeNow(entry.token)));
    } finally {
      sweeping = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setIntervalImpl(() => { sweep().catch(() => {}); }, intervalMs);
    // An idle relay should not be held awake by a probe that has nothing to do.
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearIntervalImpl(timer);
    timer = null;
  }

  return { start, stop, sweep, probeNow, get running() { return Boolean(timer); } };
}
