'use strict';

/**
 * The asking side of questions that don't block on paired relays: while an
 * ask this relay's agent put on a paired relay is open there (a mirror row,
 * relay-ask-service.mjs), this relay asks that relay every few seconds how it
 * stands (POST /api/relay-asks/remote/status) and closes what closed there;
 * the ask service tells the conversation that asked. Only this relay calls,
 * so a pairing in one direction is enough. A relay that does not answer is
 * asked less often until it does; nothing is lost meanwhile, the asks wait
 * there.
 */

import { REMOTE_RELAY_ERROR_CODES } from '../../shared/remote-relay-contract.mjs';
import { RELAY_ASK_LIMITS } from '../../shared/relay-asks.mjs';

// The routes a relay serves its paired relays for asks (routes/relay-ask-routes.mjs).
export const RELAY_ASK_REMOTE_PATHS = Object.freeze({
  ask: '/api/relay-asks/remote/ask',
  status: '/api/relay-asks/remote/status',
  withdraw: '/api/relay-asks/remote/withdraw',
  answer: '/api/relay-asks/remote/answer',
  dismiss: '/api/relay-asks/remote/dismiss',
  inbox: '/api/relay-asks/remote/inbox',
});

const LOG_PREFIX = '[relay-asks]';

function toText(value) {
  return String(value ?? '').trim();
}

/**
 * A paired relay that predates asks answers their routes with Express's HTML
 * 404: no JSON, no code. A 404 of these routes always carries one.
 */
export function isMissingRelayAskRoute(error) {
  return toText(error?.code) === REMOTE_RELAY_ERROR_CODES.notFound && !toText(error?.remoteBody?.code);
}

export function relayWithoutAsksText(name) {
  return `Relay "${toText(name) || 'the paired relay'}" runs an OAR version without questions that don't block; it needs an update before its sessions can be asked for from here.`;
}

export function createRelayAskLinkService({
  asks,
  // `get(id)`: the registry entry (address and token) of a paired relay.
  registry,
  // `request(relay, method, path, { body, timeoutMs })`: remote-relay-client.mjs.
  client,
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer = (timer) => clearTimeout(timer),
  logger = console,
  pollMs = RELAY_ASK_LIMITS.remotePollMs,
  failingPollMs = RELAY_ASK_LIMITS.remotePollFailingMs,
  timeoutMs = 15_000,
} = {}) {
  if (!asks) throw new Error('asks is required');
  // paired relay id → { timer, running, again }
  const links = new Map();
  let started = false;

  function warn(line) {
    try { logger?.warn?.(`${LOG_PREFIX} ${line}`); } catch {}
  }

  function linkState(relayId) {
    if (!links.has(relayId)) links.set(relayId, { timer: null, running: null, again: false });
    return links.get(relayId);
  }

  function forget(relayId) {
    const link = links.get(relayId);
    if (link?.timer) clearTimer(link.timer);
    links.delete(relayId);
  }

  function schedule(relayId, delayMs) {
    if (!started) return;
    const link = linkState(relayId);
    if (link.timer) clearTimer(link.timer);
    link.timer = setTimer(() => {
      link.timer = null;
      void fetchNow(relayId);
    }, Math.max(0, delayMs));
  }

  async function fetchOnce(relayId) {
    const ids = asks.pendingMirrorIds(relayId);
    if (!ids.length) return { ok: true, idle: true };
    const relay = registry?.get?.(relayId) || null;
    if (!relay) {
      asks.noteRelayRemoved(relayId);
      return { ok: false, removed: true };
    }
    let response;
    try {
      response = await client.request(relay, 'POST', RELAY_ASK_REMOTE_PATHS.status, { body: { ids }, timeoutMs });
    } catch (error) {
      return { ok: false, error: toText(error?.message || error).slice(0, 300) || 'no answer' };
    }
    if (!response || !Array.isArray(response.asks)) return { ok: false, error: 'unexpected answer' };
    asks.applyRemoteStatus(relayId, { relayName: toText(relay.name), statuses: response.asks });
    return { ok: true };
  }

  /** Asks a paired relay now (one already running is followed by one more). Never throws. */
  function fetchNow(relayId) {
    const id = toText(relayId);
    const link = linkState(id);
    if (link.timer) {
      clearTimer(link.timer);
      link.timer = null;
    }
    if (link.running) {
      link.again = true;
      return link.running;
    }
    link.running = (async () => {
      let result;
      try {
        result = await fetchOnce(id);
      } catch (error) {
        warn(`status from paired relay ${id.slice(0, 12)} failed: ${toText(error?.message || error).slice(0, 200)}`);
        result = { ok: false };
      } finally {
        link.running = null;
      }
      if (result.removed) {
        forget(id);
      } else if (link.again) {
        link.again = false;
        schedule(id, 0);
      } else if (asks.pendingMirrorIds(id).length) {
        schedule(id, result.ok ? pollMs : failingPollMs);
      } else {
        forget(id);
      }
      return result;
    })();
    return link.running;
  }

  /** An ask was just put on that relay: look for its answer from now on. */
  function noteAsked(relayId) {
    const id = toText(relayId);
    if (!id || links.get(id)?.timer || links.get(id)?.running) return;
    schedule(id, pollMs);
  }

  function start() {
    if (started) return;
    started = true;
    let delay = 0;
    for (const relayId of asks.mirrorRelays()) {
      schedule(relayId, delay);
      delay += 250;
    }
  }

  function stop() {
    started = false;
    for (const link of links.values()) {
      if (link.timer) clearTimer(link.timer);
      link.timer = null;
    }
  }

  return { start, stop, fetchNow, noteAsked, isPolling: (relayId) => links.has(toText(relayId)) };
}
