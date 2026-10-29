'use strict';

import fs from 'node:fs';
import path from 'node:path';

// What the About OAR modal shows: the running build, the providers that are
// on, what this relay has stored over its life, and how it is doing now.
//
// The totals read every message row, so they are never read on the request
// path in one go: the messages table is walked in rowid ranges with a turn of
// the event loop between them (a range of 10 000 rows takes a few tens of
// milliseconds on a cold cache), and the result is kept for a minute. Every
// other field is a cached value the relay already holds, so nothing here
// spawns a process.

export const ABOUT_TOTALS_CACHE_MS = 60_000;
export const ABOUT_MESSAGE_CHUNK_ROWS = 10_000;

// The packages each provider's workers run on, read from node_modules once.
export const ABOUT_PROVIDER_SDK_PACKAGES = Object.freeze({
  github: '@github/copilot-sdk',
  claude: '@anthropic-ai/claude-agent-sdk',
  cursor: '@cursor/sdk',
});

export const ABOUT_PROVIDER_LABELS = Object.freeze({
  github: 'GitHub Copilot',
  openai: 'OpenAI',
  claude: 'Claude Code',
  'claude-cloud': 'Claude Cloud',
  cursor: 'Cursor',
  grok: 'Grok',
  deepseek: 'DeepSeek',
  'claude-api': 'Claude API',
});

// The CLI each provider runs, keyed as the CLI install service keys them.
const PROVIDER_CLI_IDS = Object.freeze({ github: 'copilot', claude: 'claude', grok: 'grok' });

const ACTIVE_WORKER_STATUSES = new Set(['starting', 'ready', 'processing']);

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

function toCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function toAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeProviderId(value) {
  const text = String(value || '').trim().toLowerCase();
  return text || 'github';
}

function readFileText(fsImpl, filePath) {
  try {
    return String(fsImpl.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

/**
 * The commit a git checkout has checked out, read from its .git files rather
 * than from a `git` process: HEAD, then the loose ref, then packed-refs. A
 * linked worktree's .git is a file naming its git dir, whose refs live in the
 * common dir. Anything unexpected reads as null. `pathImpl` is the host's path
 * module; tests pass path.posix and path.win32.
 */
export function readGitCommit(root, { fsImpl = fs, pathImpl = path } = {}) {
  if (!root) return null;
  const dotGit = pathImpl.join(root, '.git');
  let gitDir = dotGit;
  const pointer = readFileText(fsImpl, dotGit);
  if (pointer !== null) {
    const match = pointer.match(/^gitdir:\s*(.+)$/m);
    if (!match) return null;
    gitDir = pathImpl.resolve(root, match[1].trim());
  }
  const head = readFileText(fsImpl, pathImpl.join(gitDir, 'HEAD'));
  if (head === null) return null;
  const headText = head.trim();
  if (COMMIT_PATTERN.test(headText)) return headText.toLowerCase();
  const refMatch = headText.match(/^ref:\s*(\S+)$/);
  if (!refMatch) return null;
  const ref = refMatch[1];
  const commonDirText = readFileText(fsImpl, pathImpl.join(gitDir, 'commondir'));
  const commonDir = commonDirText ? pathImpl.resolve(gitDir, commonDirText.trim()) : gitDir;
  for (const dir of new Set([gitDir, commonDir])) {
    const loose = readFileText(fsImpl, pathImpl.join(dir, ...ref.split('/')));
    if (loose && COMMIT_PATTERN.test(loose.trim())) return loose.trim().toLowerCase();
  }
  const packed = readFileText(fsImpl, pathImpl.join(commonDir, 'packed-refs')) || '';
  for (const line of packed.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === ref && COMMIT_PATTERN.test(hash || '')) return hash.toLowerCase();
  }
  return null;
}

/** The commit this build came from: the checkout's HEAD, else a `gitHead` stamp in package.json. */
export function resolveBuildCommit(packageRoot, { fsImpl = fs, pathImpl = path } = {}) {
  const fromGit = readGitCommit(packageRoot, { fsImpl, pathImpl });
  if (fromGit) return fromGit;
  try {
    const stamp = String(JSON.parse(readFileText(fsImpl, pathImpl.join(packageRoot, 'package.json')) || '{}')?.gitHead || '').trim();
    return COMMIT_PATTERN.test(stamp) ? stamp.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function readInstalledPackageVersion(packageRoot, packageName, { fsImpl = fs } = {}) {
  if (!packageRoot || !packageName) return null;
  try {
    const manifest = JSON.parse(readFileText(fsImpl, path.join(packageRoot, 'node_modules', ...packageName.split('/'), 'package.json')) || '');
    return String(manifest?.version || '').trim() || null;
  } catch {
    return null;
  }
}

function tableExists(db, name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function columnExists(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row?.name === column);
  } catch {
    return false;
  }
}

/**
 * Lifetime totals from the relay's database. Async on purpose: the message
 * walk yields between rowid ranges, so a database of hundreds of megabytes
 * never holds the event loop for long.
 *
 * A reply counts as one turn. Its provider is the one that ran it
 * (`messages.executed_provider`), else the provider its conversation is bound
 * to, else Copilot, which is what a conversation without a binding runs on.
 */
export async function collectAboutTotals(db, {
  chunkRows = ABOUT_MESSAGE_CHUNK_ROWS,
  yieldToLoop = yieldToEventLoop,
  nowIso = () => new Date().toISOString(),
} = {}) {
  const conversations = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived,
           MIN(created_at) AS first_created_at
    FROM conversations
    WHERE status != 'deleted'
  `).get() || {};

  const conversationProvider = new Map();
  for (const row of db.prepare(`SELECT conversation_id, provider_type FROM runtime_sessions`).iterate()) {
    conversationProvider.set(String(row.conversation_id), normalizeProviderId(row.provider_type));
  }

  const chunk = db.prepare(`
    SELECT conversation_id, executed_provider,
           COUNT(*) AS messages,
           SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) AS turns
    FROM messages
    WHERE rowid > ? AND rowid <= ?
    GROUP BY conversation_id, executed_provider
  `);
  const maxRowId = Number(db.prepare(`SELECT MAX(rowid) AS max_rowid FROM messages`).get()?.max_rowid || 0);
  const size = Math.max(1, Math.trunc(Number(chunkRows) || ABOUT_MESSAGE_CHUNK_ROWS));
  let messages = 0;
  let turns = 0;
  const turnsByProvider = new Map();
  for (let low = 0; low < maxRowId; low += size) {
    if (low > 0) await yieldToLoop();
    for (const row of chunk.all(low, low + size)) {
      messages += toCount(row.messages);
      const rowTurns = toCount(row.turns);
      if (!rowTurns) continue;
      turns += rowTurns;
      const provider = row.executed_provider
        ? normalizeProviderId(row.executed_provider)
        : (conversationProvider.get(String(row.conversation_id)) || 'github');
      turnsByProvider.set(provider, (turnsByProvider.get(provider) || 0) + rowTurns);
    }
  }
  await yieldToLoop();

  return {
    conversations: {
      total: toCount(conversations.total),
      archived: toCount(conversations.archived),
      firstCreatedAt: conversations.first_created_at || null,
    },
    messages,
    turns,
    turnsByProvider: Array.from(turnsByProvider, ([id, count]) => ({ id, turns: count }))
      .sort((a, b) => b.turns - a.turns || a.id.localeCompare(b.id)),
    usage: collectUsageTotals(db),
    computedAt: nowIso(),
  };
}

/**
 * What the providers report and the relay keeps, summed: Copilot's premium
 * requests per reply, Cursor's and Grok's token and cost totals per billing
 * cycle, Claude Cloud's cost per session. A provider with nothing stored is
 * left out; Claude Code and OpenAI turns store no usage at all.
 */
export function collectUsageTotals(db) {
  const usage = {};
  if (tableExists(db, 'message_usage_snapshots')) {
    const row = db.prepare(`
      SELECT SUM(CASE WHEN premium_delta_used > 0 THEN premium_delta_used ELSE 0 END) AS premium,
             SUM(CASE WHEN premium_delta_used > 0 THEN 1 ELSE 0 END) AS premium_turns
      FROM message_usage_snapshots
    `).get() || {};
    if (toCount(row.premium_turns)) {
      usage.github = { premiumRequests: toAmount(row.premium), turns: toCount(row.premium_turns) };
    }
  }
  if (tableExists(db, 'cursor_usage_cycle_totals')) {
    const row = db.prepare(`
      SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output,
             SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write,
             SUM(total_tokens) AS total, SUM(run_count) AS runs,
             SUM(raw_cost_cents) AS raw_cents, SUM(charged_cents) AS charged_cents
      FROM cursor_usage_cycle_totals
    `).get() || {};
    if (toAmount(row.total) || toAmount(row.runs) || toAmount(row.raw_cents)) {
      usage.cursor = {
        inputTokens: toAmount(row.input),
        outputTokens: toAmount(row.output),
        cacheReadTokens: toAmount(row.cache_read),
        cacheWriteTokens: toAmount(row.cache_write),
        totalTokens: toAmount(row.total),
        runs: toCount(row.runs),
        rawCostUsd: toAmount(row.raw_cents) / 100,
        chargedUsd: toAmount(row.charged_cents) / 100,
      };
    }
  }
  if (tableExists(db, 'grok_usage_cycle_totals')) {
    const row = db.prepare(`
      SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(total_tokens) AS total,
             SUM(turn_count) AS turns, SUM(cost_usd) AS cost
      FROM grok_usage_cycle_totals
    `).get() || {};
    if (toAmount(row.total) || toAmount(row.turns) || toAmount(row.cost)) {
      usage.grok = {
        inputTokens: toAmount(row.input),
        outputTokens: toAmount(row.output),
        totalTokens: toAmount(row.total),
        turns: toCount(row.turns),
        costUsd: toAmount(row.cost),
      };
    }
  }
  if (columnExists(db, 'runtime_sessions', 'claude_cloud_cost_usd')) {
    const row = db.prepare(`
      SELECT SUM(claude_cloud_cost_usd) AS cost, COUNT(claude_cloud_cost_usd) AS sessions
      FROM runtime_sessions
      WHERE claude_cloud_cost_usd IS NOT NULL
    `).get() || {};
    if (toCount(row.sessions)) {
      usage['claude-cloud'] = { costUsd: toAmount(row.cost), sessions: toCount(row.sessions) };
    }
  }
  // Every provider's tokens per turn, all time (token_usage_days, migration
  // 0036): fresh input, output, cache writes and cache reads apart, each
  // null while no turn reported it, the first day, and whether days copied
  // at the upgrade are in it. An own key's turns (Copilot) are kept apart
  // from the plan's.
  if (tableExists(db, 'token_usage_days')) {
    const rows = db.prepare(`
      SELECT provider, billing, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
             SUM(cache_write_tokens) AS cache_write, SUM(cache_read_tokens) AS cache_read, MIN(day) AS since,
             MIN(CASE WHEN source = 'turns' THEN day END) AS first_turns_day,
             MAX(CASE WHEN source = 'backfill' THEN 1 ELSE 0 END) AS backfilled
      FROM token_usage_days
      GROUP BY provider, billing
      ORDER BY provider, billing
    `).all();
    const nullable = (value) => (value === null || value === undefined ? null : toAmount(value));
    for (const row of rows) {
      const tokens = {
        inputTokens: nullable(row.input),
        outputTokens: nullable(row.output),
        cacheWriteTokens: nullable(row.cache_write),
        cacheReadTokens: nullable(row.cache_read),
        since: row.since || null,
        // Days copied at the upgrade (0036) hold cache writes inside input;
        // the first counted turn's day is where that stops.
        backfilled: Number(row.backfilled) === 1,
        firstTurnsDay: row.first_turns_day || null,
      };
      const entry = usage[row.provider] || (usage[row.provider] = {});
      if (row.billing) {
        (entry.ownKeyTokens || (entry.ownKeyTokens = [])).push({ billing: row.billing, ...tokens });
      } else {
        entry.tokens = tokens;
      }
    }
  }
  return usage;
}

function defaultIsPidAlive(pidValue) {
  const pid = Number(pidValue);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return String(error?.code || '').toUpperCase() === 'EPERM';
  }
}

async function fileSize(fsImpl, filePath) {
  try {
    const stat = await fsImpl.promises.stat(filePath);
    return Number(stat.size) || 0;
  } catch {
    return 0;
  }
}

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db
 * @param {string|null} [deps.dbPath] the database file; its -wal file is counted too
 * @param {string} deps.version
 * @param {string|null} [deps.commit]
 * @param {string} [deps.installMethod]
 * @param {string} deps.startedAt ISO time this relay process started
 * @param {() => object} [deps.getProviderSettings] `{ github: { enabled, engine }, claude: { enabled }, … }`
 * @param {() => object} [deps.getCachedCliProviders] the CLI install service's cached rows, by CLI id
 * @param {() => boolean} [deps.isRelayCliOnline] the Copilot relay CLI is connected
 * @param {() => object[]} [deps.listWorkers] the session worker registry's entries
 * @param {() => object|null} [deps.getUpdateState] buildUpdateStatePayload()
 * @param {object} [deps.sdkVersions] package version by provider id; read from node_modules when absent
 * @param {() => object|null} [deps.describeBackups] the database backups (db-backup-service.mjs describeBackups)
 */
export function createAboutService({
  db,
  dbPath = null,
  describeBackups = null,
  version = '0.0.0',
  commit = null,
  installMethod = null,
  startedAt,
  packageRoot = null,
  getProviderSettings = () => ({}),
  getCachedCliProviders = () => ({}),
  isRelayCliOnline = () => false,
  listWorkers = () => [],
  getUpdateState = () => null,
  sdkVersions = null,
  isPidAlive = defaultIsPidAlive,
  fsImpl = fs,
  now = Date.now,
  cacheMs = ABOUT_TOTALS_CACHE_MS,
  collectTotals = (database) => collectAboutTotals(database),
} = {}) {
  let cachedTotals = null;
  let totalsInFlight = null;
  let resolvedSdkVersions = sdkVersions;
  const providerForConversation = db.prepare(`SELECT provider_type FROM runtime_sessions WHERE conversation_id = ?`);

  function sdkVersionFor(providerId) {
    if (!resolvedSdkVersions) {
      resolvedSdkVersions = {};
      for (const [id, packageName] of Object.entries(ABOUT_PROVIDER_SDK_PACKAGES)) {
        resolvedSdkVersions[id] = readInstalledPackageVersion(packageRoot, packageName, { fsImpl });
      }
    }
    return resolvedSdkVersions[providerId] || null;
  }

  function readTotals() {
    if (cachedTotals && now() - cachedTotals.at < cacheMs) return Promise.resolve(cachedTotals.value);
    if (totalsInFlight) return totalsInFlight;
    totalsInFlight = Promise.resolve()
      .then(() => collectTotals(db))
      .then((value) => {
        cachedTotals = { at: now(), value };
        return value;
      })
      .finally(() => { totalsInFlight = null; });
    return totalsInFlight;
  }

  function runningWorkersByProvider() {
    const counts = new Map();
    let total = 0;
    for (const worker of listWorkers() || []) {
      const status = String(worker?.status || '').trim().toLowerCase();
      if (!ACTIVE_WORKER_STATUSES.has(status) || !isPidAlive(worker?.pid)) continue;
      total += 1;
      const conversationId = String(worker?.conversationId || '').trim();
      const provider = conversationId
        ? normalizeProviderId(providerForConversation.get(conversationId)?.provider_type)
        : 'unassigned';
      counts.set(provider, (counts.get(provider) || 0) + 1);
    }
    return { total, counts };
  }

  function describeProviders(workerCounts) {
    const settings = getProviderSettings() || {};
    const cli = getCachedCliProviders() || {};
    const relayCliOnline = isRelayCliOnline() === true;
    const rows = [];
    for (const id of Object.keys(ABOUT_PROVIDER_LABELS)) {
      const entry = settings[id];
      if (!entry || entry.enabled !== true) continue;
      const engine = id === 'github' ? (entry.engine === 'sdk' ? 'sdk' : 'extension') : null;
      // Copilot on the extension engine and OpenAI run in the relay CLI; every
      // other provider runs one worker process per active session.
      const viaRelayCli = id === 'openai' || (id === 'github' && engine === 'extension');
      const runningWorkers = workerCounts.get(id) || 0;
      const cliRow = PROVIDER_CLI_IDS[id] ? cli[PROVIDER_CLI_IDS[id]] : null;
      const showSdk = id !== 'github' || engine === 'sdk';
      rows.push({
        id,
        label: ABOUT_PROVIDER_LABELS[id],
        engine,
        cliVersion: cliRow?.installed ? (cliRow.version || null) : null,
        cliCheckedAt: cliRow?.checkedAt || null,
        sdkPackage: showSdk ? (ABOUT_PROVIDER_SDK_PACKAGES[id] || null) : null,
        sdkVersion: showSdk ? sdkVersionFor(id) : null,
        state: viaRelayCli
          ? (relayCliOnline ? 'online' : 'offline')
          : (runningWorkers > 0 ? 'online' : 'idle'),
        runningWorkers,
      });
    }
    return rows;
  }

  function describeUpdate() {
    const state = getUpdateState() || null;
    const check = state?.check || null;
    const checkEnabled = !!check && check.autoCheckEnabled === true && state?.checkKilled !== true;
    return {
      checkEnabled,
      checkKilled: state?.checkKilled === true,
      available: checkEnabled && check.available === true,
      latestVersion: checkEnabled && check.available === true ? (check.version || null) : null,
      notesUrl: checkEnabled && check.available === true ? (check.notesUrl || null) : null,
      lastCheckedAt: checkEnabled ? (check.lastCheckedAt || null) : null,
    };
  }

  async function describe() {
    const totals = await readTotals();
    const workers = runningWorkersByProvider();
    const [dbFileBytes, walBytes] = dbPath
      ? await Promise.all([fileSize(fsImpl, dbPath), fileSize(fsImpl, `${dbPath}-wal`)])
      : [0, 0];
    const startedAtMs = Date.parse(startedAt);
    const uptimeSeconds = Number.isFinite(startedAtMs) ? Math.max(0, Math.floor((now() - startedAtMs) / 1000)) : null;
    return {
      version,
      commit: commit || null,
      installMethod: installMethod || null,
      startedAt: startedAt || null,
      uptimeSeconds,
      providers: describeProviders(workers.counts),
      stats: {
        conversations: totals.conversations.total,
        archivedConversations: totals.conversations.archived,
        firstConversationAt: totals.conversations.firstCreatedAt,
        messages: totals.messages,
        turns: totals.turns,
        turnsByProvider: totals.turnsByProvider.map((row) => ({
          ...row,
          label: ABOUT_PROVIDER_LABELS[row.id] || row.id,
        })),
        computedAt: totals.computedAt,
      },
      usage: totals.usage,
      relay: {
        uptimeSeconds,
        // The full path: which of the two database names this relay runs on.
        dbPath: dbPath || null,
        dbBytes: dbFileBytes + walBytes,
        dbFileBytes,
        walBytes,
        runningWorkers: workers.total,
      },
      update: describeUpdate(),
      backups: readBackups(),
    };
  }

  // The last backup and how many are kept, for one row; never the listing.
  function readBackups() {
    if (!describeBackups) return null;
    try {
      const backups = describeBackups();
      return {
        enabled: backups.enabled,
        keep: backups.keep,
        dir: backups.dir,
        problem: backups.problem,
        kept: backups.own.length,
        lastResult: backups.lastResult,
      };
    } catch {
      return null;
    }
  }

  return { describe };
}
