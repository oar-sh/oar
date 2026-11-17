#!/usr/bin/env node
/**
 * The inventory of server/server-runtime.mjs, read from a real start
 * (tests/helpers/runtime-boot.mjs runBootCycle, the boot test's cycle, with
 * tests/helpers/runtime-probe.mjs preloaded): its exports; the keys of every
 * object it hands to a register…() call of a server/routes module; the routes
 * in registration order; timers and listeners as counts per kind after the
 * start and at exit. One fact per line, so two runs compare line by line.
 *
 *   node scripts/server-runtime-inventory.mjs           print it
 *   node scripts/server-runtime-inventory.mjs --check   compare with the fixture (exit 1 on a difference)
 *   node scripts/server-runtime-inventory.mjs --write   write the fixture (a deliberate behaviour change only)
 *   node scripts/server-runtime-inventory.mjs --sites   print each timer's call site too (not comparable)
 *
 * Read-only: the runtime runs in a temp state root that is removed after.
 * The fixture is identity, not a log: see its header (INVENTORY_HEADER).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { callArgumentsAt } from './js-scan.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INVENTORY_FIXTURE = path.join(repoRoot, 'scripts', 'fixtures', 'server-runtime-inventory.txt');

export const INVENTORY_HEADER = `# server/server-runtime.mjs inventory, from scripts/server-runtime-inventory.mjs.
#
# This file is identity, not a log. A commit that only moves code out of
# server-runtime.mjs leaves it as it is: a moved name keeps a path (a
# re-export), the register…() calls get the same keys, the routes come in the
# same order, the timer and listener counts stay. If the comparison
# (server/server-runtime-boot.test.mjs) fails on a move, the move is wrong,
# not this file. It changes only in a commit that changes behaviour on purpose
# (a route, an export, a deps key, a timer or a listener added or removed);
# that commit says why in its message, and its checker reviews this diff.
# Regenerate with: node scripts/server-runtime-inventory.mjs --write
#
# The one exception, a limit of how this file is read: a register…() call
# moved out of server-runtime.mjs into a wiring module loses its "register"
# and "keyset" lines (only calls made by server-runtime.mjs are wrapped), and
# a constant delay passed through a factory parameter reads "computed" (the
# delay is read at the call site). Such a move changes this file; its commit
# names the move and shows that the routes and timers are otherwise unchanged.
#
# Lines: "export", "register <call> arg<n> <kind>" and "keyset <id> <key>"
# (each distinct key list once), "route <METHOD> <path>" in registration
# order (a USE line names its functions), "timer <when> <kind> <delay> <ref|unref> x<count>" and
# "listener <when> <emitter> <event> x<count>". <when> is after-start (right
# after the relay's listen callback) or at-exit (after its own shutdown).
# A delay is shown where the call site passes a constant (a number or an
# UPPER_CASE name); a jittered or computed one counts by kind alone
# ("computed"). Timeouts under 1 s are left out (their lifetime races the
# moment of the count), and so are the probe's own timers and listeners.
# Platform: one file for Windows and Linux; the entries that differ are
# listed in PLATFORM_ONLY in the script and left out on both.
#
# The start runs isolated (tests/helpers/scratch-relay-env.mjs), on an empty
# database, so these start-up paths are skipped or idle and are outside this
# file's reach (a move inside them needs the checker's reading):
# - COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN=1: no session worker launch
#   (session-worker-launch-service), no CLI install or version probe
#   (cli-install-service), no Claude or Grok sign-in spawn, no agent SDK
#   install (agent-sdk-store reconcile), no Windows autostart refresh
#   (windows-autostart-service, windows-boot-autostart-service).
# - OAR_NO_UPDATE_CHECK=1: no update-check service and no 12 h poller.
# - OAR_CLAUDE_CLOUD_API_BASE_URL and OAR_ANTHROPIC_API_BASE_URL at a dead
#   loopback port, OAR_CLAUDE_CLOUD_BRANCH_LOOKUP=off: no Claude API or Cloud
#   call succeeds (none is made at start on an empty database).
# - OAR_HOST_SUSPEND_DRY_RUN=1: a host suspend only logs (none at start).
# - OAR_BOOT_REPORTING_WINDOW_MS=0: the boot reporting window is zero.
# - An empty CLI bin folder and a stub Copilot SDK path: no provider CLI is
#   found, so no Copilot model discovery or SDK session import runs a CLI.
# - The empty database and default config: no conversation, so no worker
#   priming, turn recovery, dead-worker sweep or restored task acts on a row;
#   no paired relay (health loop idle); no tunnel; preview lane off; no push
#   subscription; no provider enabled.
# - COPILOT_WEB_RELAY_CLAUDE_AUTH_ALLOW_STUB_SPAWN, _CLI_INSTALL_ALLOW_STUB_SPAWN
#   and _GROK_AUTH_ALLOW_STUB_SPAWN: spawns re-enabled for the test stubs
#   only, and only when a request asks (none at start).
# - localhostOnly: the relay listens on 127.0.0.1; the LAN listen (0.0.0.0,
#   the network address in the banner) is not taken.
# - COPILOT_SESSION_STATE_DIR is an empty folder: the startup SDK session
#   import finds nothing to import.
# - The database start paths run on an empty data folder: settleDatabaseFile
#   finds no files to settle, adoptEarlierDatabase answers not-applicable (a
#   checkout), maybeBackupBeforeStart has no database to copy,
#   mergeStrayMigratedUploads has nothing to merge.
# - relay-secrets.json does not exist yet, so the first-start bootstrap
#   writes it; the start with an existing secrets file (and an ignored
#   --token) is not taken.
#
# What this file cannot see, whatever the flags:
# - the resources still open at exit (sockets and handles: their count races
#   the shutdown);
# - setImmediate, timers/promises and AbortSignal.timeout (only setTimeout and
#   setInterval are counted);
# - socket.io middleware and event handlers (io.use, io.on, socket.on);
# - the order among the anonymous "/" middlewares (each reads "anonymous");
# - and timers set inside node_modules are counted, so a dependency bump can
#   change a line here without any change in server-runtime.mjs.
`;

// Entries that exist on one platform only: left out on both, so one fixture
// serves both. Each is a line prefix of the formatted inventory.
export const PLATFORM_ONLY = [];

const parseSite = (site) => {
  const match = /\(?((?:file:\/\/\/?)?[^()\s][^()]*?):(\d+):(\d+)\)?$/.exec(String(site || '').replace(/^at\s+/, ''));
  if (!match) return null;
  const file = match[1].startsWith('file:') ? fileURLToPath(match[1]) : match[1];
  return { file, line: Number(match[2]), column: Number(match[3]) };
};

/**
 * The text of the second argument of the call that starts at `offset`
 * (setTimeout(fn, delay) or setInterval(fn, delay)), or null when it cannot
 * be told.
 */
export function delayArgumentAt(source, offset) {
  const open = source.indexOf('(', offset);
  if (open < 0 || open - offset > 64) return null;
  const call = callArgumentsAt(source, open);
  return call && call.args.length >= 2 ? call.args[1] : null;
}

/** True when the delay argument is a constant: numbers, UPPER_CASE names and arithmetic of those. */
export function isConstantDelay(text) {
  if (!text) return false;
  return /^[\d_A-Z\s*+\-().]+$/.test(text) && !/^\s*$/.test(text) && !/\b[a-z]/.test(text);
}

const sourceCache = new Map();
function delayIsConstant(site) {
  const at = parseSite(site);
  if (!at) return false;
  let source = sourceCache.get(at.file);
  if (source === undefined) {
    try { source = fs.readFileSync(at.file, 'utf8'); } catch { source = null; }
    sourceCache.set(at.file, source);
  }
  if (!source) return false;
  const lines = source.split('\n');
  if (at.line < 1 || at.line > lines.length) return false;
  let offset = 0;
  for (let i = 0; i < at.line - 1; i += 1) offset += lines[i].length + 1;
  return isConstantDelay(delayArgumentAt(source, offset + at.column - 1));
}

const SHORT_TIMEOUT_MS = 1_000;

function timerLines(when, timers = [], { sites = false } = {}) {
  const counts = new Map();
  for (const timer of timers) {
    if (timer.kind === 'setTimeout' && timer.delay < SHORT_TIMEOUT_MS) continue;
    const delay = delayIsConstant(timer.site) ? `${timer.delay}ms` : 'computed';
    const key = `timer ${when} ${timer.kind} ${delay} ${timer.ref ? 'ref' : 'unref'}${sites ? ` ${timer.site}` : ''}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => `${key} x${count}`).sort();
}

function listenerLines(when, emitter, counts) {
  return Object.entries(counts || {}).map(([event, count]) => `listener ${when} ${emitter} ${event} x${count}`).sort();
}

/** The inventory lines (without the header) of one probe record. */
export function formatInventory(probe, { sites = false } = {}) {
  const lines = [];
  const exportsList = probe.exports || [];
  if (!exportsList.length) lines.push('export (none)');
  for (const name of exportsList) lines.push(`export ${name}`);

  const keysets = new Map();
  for (const call of probe.registerCalls || []) {
    call.args.forEach((arg, index) => {
      if (arg.kind !== 'object') {
        lines.push(`register ${call.name} arg${index} ${arg.kind}`);
        return;
      }
      const signature = arg.keys.join('\n');
      if (!keysets.has(signature)) keysets.set(signature, `K${keysets.size + 1}`);
      lines.push(`register ${call.name} arg${index} object keyset=${keysets.get(signature)}`);
    });
  }
  for (const [signature, id] of keysets) {
    const keys = signature ? signature.split('\n') : [];
    if (!keys.length) lines.push(`keyset ${id} (empty)`);
    for (const key of keys) lines.push(`keyset ${id} ${key}`);
  }

  const apps = new Set((probe.routes || []).map((route) => route.app));
  for (const route of probe.routes || []) {
    const handlers = route.handlers ? ` [${route.handlers.join(', ')}]` : '';
    lines.push(`route ${apps.size > 1 ? `app${route.app} ` : ''}${route.method} ${route.path}${handlers}`);
  }

  for (const [when, snapshot] of [['after-start', probe.afterStart], ['at-exit', probe.atExit]]) {
    lines.push(...timerLines(when, snapshot?.timers, { sites }));
    lines.push(...listenerLines(when, 'process', snapshot?.processListeners));
    lines.push(...listenerLines(when, 'server', snapshot?.serverListeners));
  }
  return lines.filter((line) => !PLATFORM_ONLY.some((prefix) => line.startsWith(prefix)));
}

export function inventoryText(probe) {
  return `${INVENTORY_HEADER}\n${formatInventory(probe).join('\n')}\n`;
}

/**
 * The lines only `expected` has ("- …") and only `actual` has ("+ …"), in
 * order (a longest-common-subsequence diff, so one inserted route is one
 * line). Header lines are not compared.
 */
export function inventoryDiff(expected, actual, { limit = 80 } = {}) {
  const strip = (text) => String(text).split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  const want = strip(expected);
  const got = strip(actual);
  const width = got.length + 1;
  const common = new Uint32Array((want.length + 1) * width);
  for (let i = want.length - 1; i >= 0; i -= 1) {
    for (let j = got.length - 1; j >= 0; j -= 1) {
      common[i * width + j] = want[i] === got[j]
        ? common[(i + 1) * width + j + 1] + 1
        : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while ((i < want.length || j < got.length) && out.length < limit) {
    if (i < want.length && j < got.length && want[i] === got[j]) { i += 1; j += 1; }
    else if (j < got.length && (i === want.length || common[i * width + j + 1] >= common[(i + 1) * width + j])) out.push(`+ ${got[j++]}`);
    else out.push(`- ${want[i++]}`);
  }
  if (i < want.length || j < got.length) out.push('…');
  return out;
}

async function main(argv) {
  const { runBootCycle } = await import('../tests/helpers/runtime-boot.mjs');
  const run = await runBootCycle();
  if (!run.probe?.afterStart || !run.probe?.atExit) throw new Error(`the probe recorded no start or exit\n${run.output}`);
  if (argv.includes('--sites')) {
    process.stdout.write(`${formatInventory(run.probe, { sites: true }).join('\n')}\n`);
    return 0;
  }
  const text = inventoryText(run.probe);
  if (argv.includes('--write')) {
    fs.mkdirSync(path.dirname(INVENTORY_FIXTURE), { recursive: true });
    fs.writeFileSync(INVENTORY_FIXTURE, text);
    process.stdout.write(`wrote ${path.relative(repoRoot, INVENTORY_FIXTURE)}\n`);
    return 0;
  }
  if (argv.includes('--check')) {
    const diff = inventoryDiff(fs.readFileSync(INVENTORY_FIXTURE, 'utf8'), text);
    if (!diff.length) {
      process.stdout.write('inventory matches the fixture\n');
      return 0;
    }
    process.stdout.write(`inventory differs from the fixture:\n${diff.join('\n')}\n`);
    return 1;
  }
  process.stdout.write(text);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
