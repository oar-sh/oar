'use strict';

// Paired relays' cards, watched from here: every ~20 s, even with no
// browser open, this relay reads the Inbox of each paired relay
// (GET /api/relay-asks/remote/inbox) and
//
// - tells its browsers when the set of pending remote items changed (the
//   socket event `inbox_remote_changed`, no payload), so the sidebar badge is
//   current without waiting for the Inbox's own poll;
// - with a device that takes question pushes here, asks with `?push=1` and
//   pushes a card a turn there waits on (an approval, a blocking ask_user)
//   when that relay says this one claimed it just now (`notice: 'you'`,
//   `claimed: 'now'`). One push per card: the card's relay pushes first,
//   and only one paired relay ever holds the claim.
//
// A sweep with neither question subscribers nor a connected browser does
// nothing. Everything here is in memory: after a restart, a card this relay
// claimed before comes back `claimed: 'before'` and is not pushed again.

import { INBOX_REMOTE_CHANGED_EVENT } from '../../shared/relay-asks.mjs';
import { REMOTE_INBOX_CLAIMS, REMOTE_INBOX_NOTICES } from '../../shared/remote-relay-contract.mjs';
import { RELAY_ASK_REMOTE_PATHS } from './relay-ask-link-service.mjs';
import { PUSH_SEND_TIMEOUT_MS } from './push-dispatch-service.mjs';

export const REMOTE_INBOX_CHANGED_EVENT = INBOX_REMOTE_CHANGED_EVENT;
export const REMOTE_INBOX_WATCH_INTERVAL_MS = 20_000;
export const REMOTE_INBOX_WATCH_JITTER_MS = 3_000;
const REQUEST_TIMEOUT_MS = 5_000;
const CONCURRENCY = 4;
// Pushes per paired relay and sweep; the rest go on the next sweep.
const PUSHES_PER_RELAY = 3;
// Registry states that mean "do not even try" (as for the Inbox).
const UNREACHABLE_STATES = new Set(['offline', 'unauthorized']);
const PUSHED_KINDS = new Set(['approval', 'ask_user']);
// A sweep waits this long for one push at most: a push that never settles
// must not hold the sweep, and with it every later one (the next is
// scheduled when a sweep ends). The send itself fails after its own timeout.
const PUSH_WAIT_MS = PUSH_SEND_TIMEOUT_MS + 5_000;

function toText(value) {
  return String(value ?? '').trim();
}

/**
 * @param {object} options
 * @param {{ list: () => object[] }} options.registry the pairings
 * @param {{ request: Function }} options.client calls a paired relay
 * @param {{ hasQuestionSubscribers: () => boolean, notifyRemoteCard: Function }} options.push
 * @param {() => boolean} options.hasSockets a browser is connected here
 * @param {(event: string) => void} options.emit to every browser
 */
export function createRemoteInboxWatchService({
  registry,
  client,
  push,
  hasSockets = () => false,
  emit = () => {},
  logger = console,
  intervalMs = REMOTE_INBOX_WATCH_INTERVAL_MS,
  jitterMs = REMOTE_INBOX_WATCH_JITTER_MS,
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  pushWaitMs = PUSH_WAIT_MS,
} = {}) {
  // `${relayId}:${id}` of the pending items each paired relay listed last.
  let lastPending = null;
  const pendingByRelay = new Map();
  // Cards pushed from here, and cards claimed here but held back by the cap.
  const pushed = new Set();
  const deferred = new Set();
  let timer = null;
  let running = false;
  let stopped = true;
  // Each start() begins a new timer chain; a tick of an older one (a sweep
  // still running across stop() and start()) schedules nothing.
  let generation = 0;

  function safe(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  async function readRelay(relay, withPush) {
    const path = `${RELAY_ASK_REMOTE_PATHS.inbox}${withPush ? '?push=1' : ''}`;
    try {
      const response = await client.request(relay, 'GET', path, { timeoutMs: REQUEST_TIMEOUT_MS });
      return Array.isArray(response?.items) ? response.items : [];
    } catch {
      return null;
    }
  }

  async function pushCards(relay, items) {
    let sent = 0;
    for (const item of items) {
      if (toText(item?.status) !== 'pending' || !PUSHED_KINDS.has(toText(item?.kind))) continue;
      if (item.notice !== REMOTE_INBOX_NOTICES.you) continue;
      const key = `${relay.id}:${toText(item.id)}`;
      if (pushed.has(key)) continue;
      // Claimed by this request, or claimed earlier and held back by the cap.
      if (item.claimed !== REMOTE_INBOX_CLAIMS.now && !deferred.has(key)) continue;
      if (sent >= PUSHES_PER_RELAY) {
        deferred.add(key);
        continue;
      }
      sent += 1;
      pushed.add(key);
      deferred.delete(key);
      let waitTimer = null;
      try {
        await Promise.race([
          Promise.resolve().then(() => push.notifyRemoteCard({ relay, item })),
          new Promise((_resolve, reject) => {
            waitTimer = setTimer(() => reject(new Error(`no answer from the push service in ${Math.round(pushWaitMs / 1000)} s`)), pushWaitMs);
            waitTimer?.unref?.();
          }),
        ]);
      } catch (error) {
        try { logger?.warn?.(`[remote-inbox] push for relay ${toText(relay.name) || relay.id} failed: ${error?.message || error}`); } catch {}
      } finally {
        if (waitTimer) clearTimer(waitTimer);
      }
    }
  }

  /** One sweep; resolves `{ skipped }` or `{ changed, relays }`. */
  async function sweep() {
    const withPush = safe(() => push?.hasQuestionSubscribers?.() === true, false);
    if (!withPush && !safe(() => hasSockets() === true, false)) return { skipped: true };
    const relays = safe(() => registry.list() || [], [])
      .filter((relay) => relay?.id && !UNREACHABLE_STATES.has(toText(relay.lastStatus).toLowerCase()));
    const listed = new Set(relays.map((relay) => relay.id));
    for (const id of pendingByRelay.keys()) {
      if (!listed.has(id)) pendingByRelay.delete(id);
    }
    const queue = [...relays];
    async function worker() {
      while (queue.length) {
        const relay = queue.shift();
        const items = await readRelay(relay, withPush);
        // A relay that did not answer keeps what it listed last.
        if (!items) continue;
        const pending = items.filter((item) => toText(item?.status) === 'pending' && toText(item?.id));
        const keys = new Set(pending.map((item) => `${relay.id}:${toText(item.id)}`));
        pendingByRelay.set(relay.id, keys);
        for (const key of [...pushed, ...deferred]) {
          if (key.startsWith(`${relay.id}:`) && !keys.has(key)) {
            pushed.delete(key);
            deferred.delete(key);
          }
        }
        if (withPush) await pushCards(relay, pending);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    const now = new Set([...pendingByRelay.values()].flatMap((keys) => [...keys]));
    const changed = lastPending === null
      ? now.size > 0
      : now.size !== lastPending.size || [...now].some((key) => !lastPending.has(key));
    lastPending = now;
    if (changed) safe(() => emit(REMOTE_INBOX_CHANGED_EVENT), null);
    return { changed, relays: relays.length };
  }

  function schedule(chain) {
    if (stopped || chain !== generation) return;
    const delay = Math.max(1_000, intervalMs + Math.round((random() * 2 - 1) * jitterMs));
    timer = setTimer(async () => {
      if (chain !== generation) return;
      timer = null;
      if (!running) {
        running = true;
        try {
          await sweep();
        } catch (error) {
          try { logger?.warn?.(`[remote-inbox] sweep failed: ${error?.message || error}`); } catch {}
        } finally {
          running = false;
        }
      }
      schedule(chain);
    }, delay);
    timer?.unref?.();
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    generation += 1;
    schedule(generation);
  }

  function stop() {
    stopped = true;
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { start, stop, sweep };
}
