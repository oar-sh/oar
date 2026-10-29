'use strict';

/**
 * What a relay restart (or shutdown) waits for, holds and leaves running,
 * read from the state the relay already has:
 *
 *  - waitingFor: the sessions with a processing turn. A queued restart waits
 *    for these and only these (relay-shutdown-gate.mjs); "Restart now" does
 *    not wait for them.
 *  - held: pending and parked messages. While a restart is queued none of
 *    them is handed to a worker; they run after it.
 *  - backgroundTasks: sessions with running background work of a live
 *    worker (shell, monitor, sub-agents; the task panel's data, through
 *    background-work-view.mjs), each with whether it survives.
 *
 * Whether background work survives is a property of the session workers,
 * not of the relay runtime: every worker is its own process (tmux, a
 * detached process, a console window on Windows) and keeps its tasks when
 * the runtime exits. A restart (exit 75) is taken by the relay's own
 * supervisor or by the Copilot CLI extension, which start a new runtime;
 * the workers report back to it. Under a systemd user service the
 * supervisor hands that restart to systemd, which stops and starts the
 * whole service, and a shutdown stops it: systemd ends every process of the
 * service then. The workers this relay starts there run in scopes of their
 * own (worker-scope.mjs) and keep running; a worker on a tmux server or in a
 * process started before 0.9.20, inside the service, may stop once. A Claude Cloud session runs at
 * Anthropic and is never affected. `oar restart` and `oar stop` come through
 * here too (they ask the relay); only their `--now` goes to systemd directly.
 */

import fs from 'node:fs';

const MAX_ROWS = 50;

function toText(value) {
  return String(value ?? '').trim();
}

/**
 * How this relay process is run, from its environment and argv: whether a
 * systemd service runs it (`unit`: the service, `userManager`: a user's
 * systemd runs it, not the system's), and whether an outer supervisor (the
 * Copilot CLI extension, `--supervised`) owns its restarts. The supervisor
 * and the runtime ask the same way.
 */
export function detectRelayHosting({
  env = process.env,
  argv = process.argv,
  platform = process.platform,
  readCgroup = () => fs.readFileSync('/proc/self/cgroup', 'utf8'),
} = {}) {
  // systemd sets INVOCATION_ID for the processes of a unit, and a service's
  // cgroup ends in `.service` (a terminal's shell sits in a `.scope`). Every
  // process the service starts inherits INVOCATION_ID; one in a scope of its
  // own (a session worker) is not the service.
  let systemd = false;
  let unit = '';
  let userManager = false;
  if (platform === 'linux' && toText(env?.INVOCATION_ID)) {
    let cgroup = '';
    try { cgroup = String(readCgroup() || ''); } catch {}
    // The unified line (`0::/…`, the only one on cgroup v2) when it names a
    // service, else v1's `name=systemd` hierarchy: on a hybrid host the
    // unified line may be a bare `0::/` that says nothing. Controller lines
    // (`10:memory:/…`) are not systemd's view: on a hybrid host they stop at
    // `user@<uid>.service`.
    const isService = (entry) => /\.service\/?$/.test(entry || '');
    const lines = cgroup.split('\n').map((entry) => entry.trim());
    const unified = lines.find((entry) => entry.startsWith('0::'));
    const named = lines.find((entry) => /^\d+:name=systemd:/.test(entry));
    const line = isService(unified) ? unified : isService(named) ? named : '';
    if (line) {
      systemd = true;
      const cgroupPath = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1).replace(/\/$/, '');
      unit = cgroupPath.split('/').pop();
      userManager = /\/user@\d+\.service\//.test(cgroupPath);
    }
  }
  const supervised = Array.isArray(argv) && argv.includes('--supervised');
  return { systemd, supervised, platform, unit, userManager };
}

/**
 * Whether the session workers outlive this action, and why, in one line each.
 * `hosting.workerScopes`: whether this relay starts its workers in scopes of
 * their own (worker-scope.mjs `inUse`); unset counts as no.
 */
export function describeRestartSurvival({ action = 'restart', hosting = {} } = {}) {
  const restart = action === 'restart';
  // Under a user service a restart is handed to systemd, which restarts the
  // whole service; elsewhere only the runtime is started anew.
  const wholeService = hosting.systemd && (!restart || hosting.userManager);
  if (wholeService && hosting.workerScopes !== true) {
    return {
      action: restart ? 'restart' : 'shutdown',
      workersSurvive: false,
      summary: `The relay runs as a systemd service: ${restart ? 'a restart restarts' : 'shutting it down stops'} the service and every process in it, `
        + 'and this relay could not start its session workers outside it, so they and their background tasks may stop too '
        + '(a worker in a tmux session the service did not start keeps running).',
    };
  }
  if (wholeService) {
    return {
      action: restart ? 'restart' : 'shutdown',
      workersSurvive: true,
      summary: `The relay runs as a systemd service: ${restart ? 'a restart restarts' : 'shutting it down stops'} the service and every process in it. `
        + 'Session workers this relay started run in scopes of their own and keep running, with their background tasks; '
        + `they report back ${restart ? 'to the new relay within a minute' : 'when it starts again'}. A worker on a tmux server or in a process started before OAR 0.9.20, inside the service, may stop once.`,
    };
  }
  if (restart) {
    return {
      action: 'restart',
      workersSurvive: true,
      summary: 'Session workers are separate processes and keep running through a relay restart, with their background tasks; '
        + 'they report back to the new relay within a minute.',
    };
  }
  return {
    action: 'shutdown',
    workersSurvive: true,
    summary: 'Session workers are separate processes and keep running while the relay is down, with their background tasks; '
      + 'they report back when it starts again.',
  };
}

/**
 * The picture for one action. `queueRows` is the queue grouped by
 * conversation and status ({ conversation_id, status, cnt, title });
 * `backgroundBlockers` the `background` rows of background-work-view.mjs.
 */
export function buildRestartPicture({
  action = 'restart',
  queueRows = [],
  backgroundBlockers = [],
  // Tasks held since a relay restart (background-task-store.mjs
  // `listRestored`, mapped to conversations): `{ conversationId, description }`.
  heldTasks = [],
  hosting = {},
  providerOf = () => '',
  titleOf = (conversationId) => toText(conversationId).slice(0, 8),
} = {}) {
  const survival = describeRestartSurvival({ action, hosting });
  const turns = new Map();
  const held = new Map();
  for (const row of Array.isArray(queueRows) ? queueRows : []) {
    const conversationId = toText(row?.conversation_id);
    const count = Number(row?.cnt || 0);
    if (!conversationId || !(count > 0)) continue;
    const status = toText(row?.status);
    const target = status === 'processing' ? turns : (status === 'pending' || status === 'parked') ? held : null;
    if (!target) continue;
    const entry = target.get(conversationId) || { conversationId, title: toText(row?.title) || titleOf(conversationId), count: 0 };
    entry.count += count;
    target.set(conversationId, entry);
  }
  const waitingFor = [...turns.values()].slice(0, MAX_ROWS).map((entry) => ({
    conversationId: entry.conversationId,
    title: entry.title,
    turns: entry.count,
  }));
  const heldConversations = [...held.values()];
  const backgroundTasks = (Array.isArray(backgroundBlockers) ? backgroundBlockers : [])
    .filter((blocker) => blocker && blocker.kind === 'background' && toText(blocker.conversationId))
    .slice(0, MAX_ROWS)
    .map((blocker) => {
      const conversationId = toText(blocker.conversationId);
      const cloud = toText(providerOf(conversationId)).toLowerCase() === 'claude-cloud';
      const survives = cloud || survival.workersSurvive;
      return {
        conversationId,
        title: toText(blocker.title) || titleOf(conversationId),
        count: Number(blocker.count) > 0 ? Math.trunc(Number(blocker.count)) : 1,
        detail: toText(blocker.detail).slice(0, 400),
        survives,
        why: cloud
          ? 'runs in the cloud'
          : survives ? 'its worker keeps running' : 'its worker may stop with the service',
      };
    });
  // Held since the last restart: neither running nor ended as far as the
  // relay knows, until the worker's set confirms them. Whether they survive
  // the next one is not known either.
  const listed = new Set(backgroundTasks.map((task) => task.conversationId));
  const unconfirmed = new Map();
  for (const entry of Array.isArray(heldTasks) ? heldTasks : []) {
    const conversationId = toText(entry?.conversationId);
    if (!conversationId || listed.has(conversationId)) continue;
    const list = unconfirmed.get(conversationId) || [];
    list.push(toText(entry?.description) || 'task');
    unconfirmed.set(conversationId, list);
  }
  for (const [conversationId, descriptions] of unconfirmed) {
    if (backgroundTasks.length >= MAX_ROWS) break;
    const count = descriptions.length;
    backgroundTasks.push({
      conversationId,
      title: titleOf(conversationId),
      count,
      detail: `${count} task${count === 1 ? '' : 's'} not yet confirmed since the last relay restart: ${descriptions.slice(0, 3).map((text) => text.slice(0, 80)).join('; ')}`,
      survives: null,
      why: 'its worker has not confirmed it since the last restart',
    });
  }
  return {
    waitingFor,
    held: {
      count: heldConversations.reduce((sum, entry) => sum + entry.count, 0),
      conversations: heldConversations.slice(0, MAX_ROWS).map((entry) => ({
        conversationId: entry.conversationId,
        title: entry.title,
        count: entry.count,
      })),
    },
    backgroundTasks,
    survival,
  };
}

/** The live collector over the relay's database and background-work view. */
export function createRestartPictureCollector({
  db,
  backgroundWorkView = null,
  // () => [{ conversationId, description }]: tasks held since a restart.
  listHeldTasks = () => [],
  hosting = detectRelayHosting(),
  // Whether the workers start in scopes of their own (worker-scope.mjs `inUse`).
  workerScopes = () => false,
  providerOf = () => '',
  titleOf = undefined,
} = {}) {
  let listQueue = null;
  try {
    listQueue = db?.prepare(`
      SELECT q.conversation_id, q.status, COUNT(*) AS cnt, MAX(c.title) AS title
      FROM queue q LEFT JOIN conversations c ON c.id = q.conversation_id
      WHERE q.status IN ('pending','processing','parked')
      GROUP BY q.conversation_id, q.status
    `) || null;
  } catch {}
  return function collectRestartPicture({ action = 'restart' } = {}) {
    let queueRows = [];
    try { queueRows = listQueue?.all() || []; } catch {}
    let backgroundBlockers = [];
    try { backgroundBlockers = backgroundWorkView?.backgroundBlockers?.() || []; } catch {}
    let heldTasks = [];
    try { heldTasks = listHeldTasks() || []; } catch {}
    let scopes;
    try { scopes = workerScopes(); } catch {}
    return buildRestartPicture({
      action, queueRows, backgroundBlockers, heldTasks, hosting: { ...hosting, workerScopes: scopes }, providerOf, ...(titleOf ? { titleOf } : {}),
    });
  };
}
