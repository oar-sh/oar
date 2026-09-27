'use strict';

import { execFile } from 'node:child_process';

/**
 * Open GitHub Actions runs for a set of workspace roots, via the `gh` CLI the
 * host already has (same credentials the agents use). Nothing in the relay
 * models CI, so this is a best-effort outside view: a repo whose runs cannot
 * be read counts as "unknown" and blocks for a grace period, after which it is
 * ignored rather than keeping the host awake forever over a GitHub outage.
 */

const DEFAULT_CACHE_MS = 20 * 1000;
const DEFAULT_UNKNOWN_GRACE_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20 * 1000;
const RUN_LIST_LIMIT = 30;

const OPEN_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

/** `git@github.com:o/r.git`, `https://github.com/o/r`, `ssh://git@github.com/o/r.git` → `o/r`. */
export function parseGitHubRepoSlug(remoteUrl) {
  const text = String(remoteUrl || '').trim();
  if (!text) return null;
  const match = text.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

export function isOpenCiRunStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (!value) return false;
  return OPEN_RUN_STATUSES.has(value) || value !== 'completed';
}

function execText(execFileImpl, file, args, { cwd = undefined, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    try {
      execFileImpl(file, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        if (error) {
          const detail = String(stderr || error.message || '').trim().split('\n')[0] || 'command failed';
          reject(new Error(detail.slice(0, 200)));
          return;
        }
        resolve(String(stdout || ''));
      });
    } catch (error) {
      if (settled) return;
      settled = true;
      reject(error);
    }
  });
}

export function createGitHubCiActivityService({
  execFileImpl = execFile,
  now = () => Date.now(),
  cacheMs = DEFAULT_CACHE_MS,
  unknownGraceMs = DEFAULT_UNKNOWN_GRACE_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = console,
} = {}) {
  // root → { slug: string|null, at }
  const slugByRoot = new Map();
  // slug → { runs, error, at, unknownSince, inFlight }
  const runsBySlug = new Map();

  async function resolveSlug(root) {
    const key = String(root || '').trim();
    if (!key) return null;
    const cached = slugByRoot.get(key);
    if (cached && cached.at !== null && now() - cached.at < 10 * cacheMs) return cached.slug;
    let slug = null;
    try {
      const url = await execText(execFileImpl, 'git', ['-C', key, 'remote', 'get-url', 'origin'], { timeoutMs });
      slug = parseGitHubRepoSlug(url);
    } catch {
      slug = null;
    }
    slugByRoot.set(key, { slug, at: now() });
    return slug;
  }

  async function fetchRuns(slug) {
    const entry = runsBySlug.get(slug) || { runs: [], error: null, at: null, unknownSince: null, inFlight: null };
    runsBySlug.set(slug, entry);
    if (entry.inFlight) return entry.inFlight;
    if (entry.at !== null && now() - entry.at < cacheMs) return entry;
    entry.inFlight = (async () => {
      try {
        const out = await execText(execFileImpl, 'gh', [
          'run', 'list', '-R', slug, '--limit', String(RUN_LIST_LIMIT),
          '--json', 'status,name,headBranch,databaseId,event',
        ], { timeoutMs });
        const parsed = JSON.parse(out || '[]');
        entry.runs = (Array.isArray(parsed) ? parsed : [])
          .filter((run) => run && isOpenCiRunStatus(run.status))
          .map((run) => ({
            id: run.databaseId ?? null,
            name: String(run.name || 'workflow').slice(0, 120),
            headBranch: String(run.headBranch || '').slice(0, 160),
            status: String(run.status || '').slice(0, 40),
            event: String(run.event || '').slice(0, 40),
          }));
        entry.error = null;
        entry.unknownSince = null;
      } catch (error) {
        entry.error = String(error?.message || error || 'gh failed').slice(0, 200);
        if (entry.unknownSince === null) entry.unknownSince = now();
        try { logger.warn?.(`[host-suspend] CI state for ${slug} unknown: ${entry.error}`); } catch {}
      } finally {
        entry.at = now();
        entry.inFlight = null;
      }
      return entry;
    })();
    return entry.inFlight;
  }

  /**
   * @param {string[]} workspaceRoots
   * @returns {Promise<{ repos: Array<{ repo, runs }>, unknown: Array<{ repo, error, since, ignored }>, blockers: Array<object> }>}
   */
  async function describeRuns(workspaceRoots = []) {
    const roots = [...new Set((Array.isArray(workspaceRoots) ? workspaceRoots : []).map((r) => String(r || '').trim()).filter(Boolean))];
    const slugs = new Set();
    for (const root of roots) {
      const slug = await resolveSlug(root);
      if (slug) slugs.add(slug);
    }
    const repos = [];
    const unknown = [];
    const blockers = [];
    for (const slug of slugs) {
      const entry = await fetchRuns(slug);
      if (entry.error) {
        const since = entry.unknownSince === null ? now() : entry.unknownSince;
        const ignored = now() - since >= unknownGraceMs;
        unknown.push({ repo: slug, error: entry.error, since: new Date(since).toISOString(), ignored });
        if (!ignored) {
          blockers.push({ kind: 'ci-unknown', detail: `CI state of ${slug} unknown (${entry.error})`, title: slug });
        }
        continue;
      }
      if (entry.runs.length) {
        repos.push({ repo: slug, runs: entry.runs.map((r) => ({ ...r })) });
        const what = entry.runs.slice(0, 4).map((r) => `${r.name} on ${r.headBranch || '?'} (${r.status})`).join(', ');
        blockers.push({ kind: 'ci', title: slug, count: entry.runs.length, detail: what });
      }
    }
    return { repos, unknown, blockers };
  }

  /**
   * Last known picture without touching git/gh — for synchronous collectors
   * that kick describeRuns() off in the background. A root or repo that has
   * never been resolved yet reports a `ci-checking` blocker so the host does
   * not sleep during the very first lookup.
   */
  function snapshot(workspaceRoots = []) {
    const blockers = [];
    const repos = [];
    const unknown = [];
    const slugs = new Set();
    let checking = 0;
    // Several busy conversations usually share one workspace; count it once.
    const roots = new Set((Array.isArray(workspaceRoots) ? workspaceRoots : []).map((root) => String(root || '').trim()));
    for (const key of roots) {
      if (!key) continue;
      const cached = slugByRoot.get(key);
      if (!cached) { checking += 1; continue; }
      if (cached.slug) slugs.add(cached.slug);
    }
    for (const slug of slugs) {
      const entry = runsBySlug.get(slug);
      if (!entry || entry.at === null) { checking += 1; continue; }
      if (entry.error) {
        const since = entry.unknownSince === null ? now() : entry.unknownSince;
        const ignored = now() - since >= unknownGraceMs;
        unknown.push({ repo: slug, error: entry.error, since: new Date(since).toISOString(), ignored });
        if (!ignored) blockers.push({ kind: 'ci-unknown', title: slug, detail: `CI state of ${slug} unknown (${entry.error})` });
        continue;
      }
      if (entry.runs.length) {
        repos.push({ repo: slug, runs: entry.runs.map((r) => ({ ...r })) });
        const what = entry.runs.slice(0, 4).map((r) => `${r.name} on ${r.headBranch || '?'} (${r.status})`).join(', ');
        blockers.push({ kind: 'ci', title: slug, count: entry.runs.length, detail: what });
      }
    }
    if (checking > 0) {
      blockers.push({ kind: 'ci-checking', count: checking, detail: `Checking CI state of ${checking} workspace${checking === 1 ? '' : 's'}` });
    }
    return { repos, unknown, blockers };
  }

  return { describeRuns, snapshot, parseGitHubRepoSlug };
}
