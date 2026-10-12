'use strict';

/**
 * The watching side of relay event subscriptions on paired relays: while
 * this relay holds subscriptions on a paired relay (or an end it has not
 * delivered there yet), it fetches that relay's events every few seconds
 * over the pairing and hands them to the event service, which delivers them
 * like the events of this relay's own sessions. Only this relay calls, so a
 * pairing in one direction is enough.
 *
 * A fetch (POST /api/relay-events/remote/pull) acknowledges what the last
 * one stored, carries the ends and watcher names the other relay must
 * learn, and comes back with new events and the subscriptions' state; the
 * event service writes all of it and the cursor in one transaction, so
 * nothing is lost or delivered twice when either relay restarts.
 *
 * A link with no answer for remoteGapMs (failing fetches, or this relay
 * down) is lost from its last answer on. The first fetch after that, every
 * page of it, is held and delivered as one replayed row per watcher with
 * link_lost and link_restored around it. A shorter outage only delays.
 */

import { REMOTE_RELAY_ERROR_CODES } from '../../shared/remote-relay-contract.mjs';
import { RELAY_EVENT_LIMITS } from '../../shared/relay-events.mjs';

export const RELAY_EVENT_REMOTE_SUBSCRIBE_PATH = '/api/relay-events/remote/subscribe';
export const RELAY_EVENT_REMOTE_PULL_PATH = '/api/relay-events/remote/pull';

const LOG_PREFIX = '[relay-events]';
// Pages of one fetch before the next tick goes on (remotePullBatch each).
const MAX_PAGES_PER_FETCH = 50;

function toText(value) {
  return String(value ?? '').trim();
}

/**
 * A paired relay that predates cross-relay subscriptions answers their
 * routes with Express's HTML 404: no JSON, no code. A 404 of these routes
 * always carries one.
 */
export function isMissingRelayEventRoute(error) {
  return toText(error?.code) === REMOTE_RELAY_ERROR_CODES.notFound && !toText(error?.remoteBody?.code);
}

export function relayWithoutCrossRelayEventsText(name) {
  return `Relay "${toText(name) || 'the paired relay'}" runs an OAR version without event subscriptions across relays; it needs an update before its sessions can be watched from here.`;
}

function describeFailure(relay, error) {
  if (isMissingRelayEventRoute(error)) return relayWithoutCrossRelayEventsText(relay?.name);
  return toText(error?.message || error).slice(0, 300) || 'no answer';
}

function isPullAnswer(response) {
  return !!response && typeof response === 'object' && Array.isArray(response.events) && Array.isArray(response.subscriptions);
}

export function createRelayEventLinkService({
  relayEvents,
  // `get(id)`: the registry entry (address and token) of a paired relay.
  registry,
  // `request(relay, method, path, { body, timeoutMs })`: remote-relay-client.mjs.
  client,
  now = () => Date.now(),
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer = (timer) => clearTimeout(timer),
  logger = console,
  pollMs = RELAY_EVENT_LIMITS.remotePollMs,
  failingPollMs = RELAY_EVENT_LIMITS.remotePollFailingMs,
  gapMs = RELAY_EVENT_LIMITS.remoteGapMs,
  timeoutMs = 15_000,
} = {}) {
  if (!relayEvents) throw new Error('relayEvents is required');
  // paired relay id → { timer, running, again, replay }
  const links = new Map();
  let started = false;

  function warn(line) {
    try { logger?.warn?.(`${LOG_PREFIX} ${line}`); } catch {}
  }

  function linkState(relayId) {
    if (!links.has(relayId)) links.set(relayId, { timer: null, running: null, again: false, replay: null, replayApplied: false });
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

  function wanted(relayId) {
    return relayEvents.remoteRelaysToPoll().includes(relayId);
  }

  function failingForLong(relayId) {
    const first = Date.parse(String(relayEvents.getRemoteLink(relayId).first_fail_at || ''));
    return Number.isFinite(first) && now() - first >= gapMs;
  }

  /** Whether the link has been without an answer long enough to replay: since when. */
  function gapSince(relayId) {
    const health = relayEvents.getRemoteLink(relayId);
    if (health.lost_at) return health.lost_at;
    const lastOk = Date.parse(String(health.last_ok_at || ''));
    return Number.isFinite(lastOk) && now() - lastOk >= gapMs ? health.last_ok_at : null;
  }

  function startReplay(link, relayId, since) {
    const perWatcher = new Map();
    for (const [watcher, subscriptionId] of relayEvents.remoteWatchers(relayId)) {
      perWatcher.set(watcher, { subscriptionId, kept: 0, dropped: 0, ended: [] });
    }
    link.replay = { since, perWatcher };
    link.replayApplied = false;
  }

  function addToReplay(link, relayId, applied) {
    for (const [watcher, info] of applied) {
      let entry = link.replay.perWatcher.get(watcher);
      if (!entry) {
        const subscriptionId = relayEvents.remoteWatchers(relayId).get(watcher);
        if (!subscriptionId) continue;
        entry = { subscriptionId, kept: 0, dropped: 0, ended: [] };
        link.replay.perWatcher.set(watcher, entry);
      }
      entry.kept += Number(info.kept) || 0;
      entry.dropped += Number(info.dropped) || 0;
      entry.ended.push(...(info.ended || []));
    }
  }

  async function fetchPages(relayId, link) {
    const relay = registry?.get?.(relayId) || null;
    if (!relay) {
      // The pairing went without the hook (or before this boot).
      relayEvents.noteRelayRemoved(relayId);
      return { ok: false, removed: true, error: 'The pairing with that relay was removed.' };
    }
    for (let page = 0; page < MAX_PAGES_PER_FETCH; page += 1) {
      const body = relayEvents.buildRemotePull(relayId);
      if (!body.subscriptions.length && !body.ended.length && !link.replay) return { ok: true, idle: true };
      if (!link.replay) {
        const since = gapSince(relayId);
        if (since) startReplay(link, relayId, since);
      }
      let response;
      try {
        response = await client.request(relay, 'POST', RELAY_EVENT_REMOTE_PULL_PATH, { body, timeoutMs });
        if (!isPullAnswer(response)) throw new Error(`Relay "${toText(relay.name)}" gave an unexpected answer to the event fetch`);
      } catch (error) {
        const text = describeFailure(relay, error);
        relayEvents.noteRemoteLinkFailure(relayId, text);
        // Nothing of a replay was written yet: the next fetch starts it again.
        if (link.replay && !link.replayApplied) link.replay = null;
        return { ok: false, error: text, unsupported: isMissingRelayEventRoute(error) };
      }
      const applied = relayEvents.applyRemotePull(relayId, { relayName: relay.name, response, replay: !!link.replay });
      if (link.replay) {
        link.replayApplied = true;
        addToReplay(link, relayId, applied);
      }
      if (response.more !== true) break;
    }
    if (link.replay) {
      const { since, perWatcher } = link.replay;
      link.replay = null;
      link.replayApplied = false;
      relayEvents.noteRemoteLinkRestored(relayId, { relayName: relay.name, since, perWatcher });
    }
    return { ok: true };
  }

  /**
   * Fetches from a paired relay now (a fetch already running is followed by
   * one more). Resolves `{ ok, error?, idle?, unsupported? }`; never throws.
   */
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
        result = await fetchPages(id, link);
      } catch (error) {
        warn(`fetch from paired relay ${id.slice(0, 12)} failed: ${toText(error?.message || error).slice(0, 200)}`);
        result = { ok: false, error: toText(error?.message || error) };
      } finally {
        link.running = null;
      }
      if (result.removed) {
        forget(id);
      } else if (link.again) {
        link.again = false;
        schedule(id, 0);
      } else if (wanted(id)) {
        schedule(id, result.ok ? pollMs : (failingForLong(id) ? failingPollMs : pollMs));
      } else if (!link.replay) {
        forget(id);
      }
      return result;
    })();
    return link.running;
  }

  /** A fetch, waited for at most `waitMs` (list_subscriptions wants fresh state). */
  async function refresh(relayId, { waitMs = 5_000 } = {}) {
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimer(() => resolve({ ok: false, error: 'timeout' }), waitMs);
    });
    try {
      return await Promise.race([fetchNow(relayId), timeout]);
    } finally {
      clearTimer(timer);
    }
  }

  /**
   * The pairing with a relay is being removed (`entry` still has its address
   * and token): one last fetch tells it every subscription ended, then the
   * mirrors end here. A relay that does not answer ends them itself after
   * remoteKeepDays without a fetch.
   */
  async function noteRelayRemoved(entry) {
    const relayId = toText(entry?.id);
    if (!relayId) return;
    forget(relayId);
    const rows = relayEvents.mirrorsOf(relayId);
    if (rows.length && entry?.url) {
      const body = {
        after: Number(relayEvents.getRemoteLink(relayId).cursor) || 0,
        subscriptions: [],
        ended: rows.map((row) => row.remote_subscription_id),
      };
      try {
        await client.request(entry, 'POST', RELAY_EVENT_REMOTE_PULL_PATH, { body, timeoutMs: Math.min(timeoutMs, 10_000) });
      } catch (error) {
        warn(`the paired relay being removed did not take the ends: ${describeFailure(entry, error)}`);
      }
    }
    relayEvents.noteRelayRemoved(relayId);
  }

  /** Boot: fetch from every paired relay this relay holds subscriptions on. */
  function start() {
    if (started) return;
    started = true;
    let delay = 0;
    for (const relayId of relayEvents.remoteRelaysToPoll()) {
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

  return { start, stop, fetchNow, refresh, noteRelayRemoved, isPolling: (relayId) => links.has(toText(relayId)) };
}
