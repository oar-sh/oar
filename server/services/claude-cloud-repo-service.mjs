'use strict';

// The suggestions of the New Chat → Claude Cloud repository and branch fields.
//
// Repositories come from two places: Anthropic's list of what the Claude
// GitHub app can reach (cached for a minute, read with the Claude CLI's login
// through the injected cloud client) and the repositories of earlier cloud
// chats on this relay (`conversations.cloud_source_json`, newest first). The
// two are one list: a recent repository that Anthropic does not list is kept
// and marked unreachable, so the modal can warn before the first message.
//
// Branches come from `git ls-remote --symref <url> HEAD refs/heads/*` (the https URL),
// run on the host without a shell and without any prompt (an https remote
// the host cannot read fails at once instead of asking for a password). The
// environment switch OAR_CLAUDE_CLOUD_BRANCH_LOOKUP=off turns the lookup off
// altogether; the test harness pins it so that no e2e run talks to GitHub.
//
// The Claude Cloud switch is the consent to use the CLI's login, so nothing
// is asked of Anthropic while the provider is off, and nothing read before is
// handed out. Git needs no login and is not gated by it.

import { execFile as nodeExecFile } from 'child_process';

import { ClaudeCloudError } from '../../shared/claude-cloud/credentials.mjs';
import { isValidBranchName, normalizeGitHubRepoUrl } from '../../shared/claude-cloud/repo-url.mjs';
import { parseCloudSourceJson } from './claude-cloud-session-service.mjs';

export const CLAUDE_CLOUD_BRANCH_LOOKUP_ENV = 'OAR_CLAUDE_CLOUD_BRANCH_LOOKUP';

const DEFAULT_CACHE_MS = 60_000;
const GIT_COMMAND_TIMEOUT_MS = 15_000;
const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_BRANCHES = 500;
const MAX_ERROR_CHARS = 300;
const GENERIC_LIST_ERROR = 'The repositories could not be read from Claude Cloud.';
const DISABLED_MESSAGE = 'Claude Cloud is switched off.';
const LOOKUP_OFF_MESSAGE = 'Branch lookup is switched off on this relay.';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** A time as the sort needs it: milliseconds, or -Infinity for none. */
function timeOf(iso) {
  const ms = Date.parse(String(iso || ''));
  return Number.isFinite(ms) ? ms : -Infinity;
}

/**
 * Whether branches may be looked up with git: every value of
 * OAR_CLAUDE_CLOUD_BRANCH_LOOKUP but `off`, `0` and `false` says yes.
 */
export function readBranchLookupSwitch(env = process.env) {
  const value = toText(env?.[CLAUDE_CLOUD_BRANCH_LOOKUP_ENV]).toLowerCase();
  return !['off', '0', 'false', 'no'].includes(value);
}

/**
 * The recent cloud sources as the service takes them, read from the session
 * repository's guarded statement: `[{ repoUrl, branch, updatedAt }]`, newest
 * first, without rows whose JSON names no repository. Empty on a schema
 * without the column.
 */
export function listRecentCloudSourcesFromStatements(stmts) {
  if (typeof stmts?.listRecentCloudSources?.all !== 'function') return [];
  const out = [];
  for (const row of stmts.listRecentCloudSources.all()) {
    const source = parseCloudSourceJson(row?.cloud_source_json);
    if (!source) continue;
    out.push({ repoUrl: source.repoUrl, branch: source.branch, updatedAt: toText(row?.updated_at) || null });
  }
  return out;
}

/** What the browser may show about a failed read; never more than the client's own words. */
function describeListError(error) {
  const code = error instanceof ClaudeCloudError ? toText(error.code) || 'error' : 'error';
  const text = error instanceof ClaudeCloudError
    ? String(error.message || '').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\s+/g, ' ').trim()
    : '';
  const message = text ? (text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text) : GENERIC_LIST_ERROR;
  return { code, message };
}

/**
 * What git said about a failed ls-remote: its `fatal:` line when there is
 * one, else its first line, without the prefix and without credentials in
 * front of a host.
 */
function describeGitFailure(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const line = lines.find((entry) => /^(?:fatal|error):/i.test(entry)) || lines[0] || '';
  const text = line
    .replace(/^(?:fatal|error|remote):\s*/i, '')
    .replace(/\/\/[^/@\s]*@/g, '//')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

/**
 * The repository named by a picker value: a bare `owner/name` (what the list
 * shows) or any form normalizeGitHubRepoUrl takes. Null for anything else.
 */
export function resolveRepositoryInput(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  // Exactly owner/name in GitHub's own characters: an account name has no
  // dot, so a host (`example.com/repo`) never reads as one.
  const bare = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(text);
  return normalizeGitHubRepoUrl(bare ? `https://github.com/${text}` : text);
}

/**
 * The branches in `git ls-remote --symref --heads` output: `{ branches,
 * defaultBranch }`, the default first, the rest in code-point order, at most
 * MAX_BRANCHES names. The default is the `ref: refs/heads/X\tHEAD` line;
 * without one (an older git, a detached HEAD on the remote) it is null.
 */
export function parseLsRemoteHeads(stdout) {
  const names = new Set();
  let defaultBranch = null;
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const symref = line.match(/^ref:\s*refs\/heads\/(\S+)\s+HEAD$/);
    if (symref) {
      if (isValidBranchName(symref[1])) defaultBranch = symref[1];
      continue;
    }
    const head = line.match(/^[0-9a-f]{4,64}\s+refs\/heads\/(.+)$/i);
    if (head && isValidBranchName(head[1])) names.add(head[1]);
  }
  const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const branches = defaultBranch && names.has(defaultBranch)
    ? [defaultBranch, ...sorted.filter((name) => name !== defaultBranch)]
    : sorted;
  return { branches: branches.slice(0, MAX_BRANCHES), defaultBranch };
}

/**
 * `cloud`: shared/claude-cloud/api-client.mjs (`listRepositories`).
 * `isEnabled`: whether the Claude Cloud provider is switched on.
 * `listRecentCloudSources`: `() => [{ repoUrl, branch, updatedAt }]`, newest
 * first (see listRecentCloudSourcesFromStatements).
 * `gitBranchLookup`: the environment switch, read once at start by default.
 * `execFileImpl`: child_process.execFile, for tests.
 * `now`: the clock, as a Date or as milliseconds.
 */
export function createClaudeCloudRepoService({
  cloud = null,
  isEnabled = () => false,
  listRecentCloudSources = () => [],
  gitBranchLookup = readBranchLookupSwitch(process.env),
  execFileImpl = nodeExecFile,
  now = () => Date.now(),
  cacheMs = DEFAULT_CACHE_MS,
  logger = console,
} = {}) {
  const keepMs = Number.isFinite(Number(cacheMs)) && Number(cacheMs) > 0 ? Number(cacheMs) : 0;
  let cached = null;
  let inFlight = null;

  function nowMs() {
    const value = now();
    const ms = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(ms) ? ms : Date.now();
  }

  function enabled() {
    try {
      return isEnabled() === true;
    } catch {
      return false;
    }
  }

  /** The recent sources, one per repository (the newest chat wins), newest first. */
  function recentRepositories() {
    let sources = [];
    try {
      sources = listRecentCloudSources();
    } catch (error) {
      logger?.warn?.(`[claude-cloud] recent cloud sources could not be read: ${error?.message || error}`);
      sources = [];
    }
    const bySlug = new Map();
    for (const source of Array.isArray(sources) ? sources : []) {
      const repo = normalizeGitHubRepoUrl(source?.repoUrl);
      if (!repo) continue;
      const key = repo.slug.toLowerCase();
      const recentAt = toText(source?.updatedAt) || null;
      const known = bySlug.get(key);
      if (known && timeOf(known.recentAt) >= timeOf(recentAt)) continue;
      bySlug.set(key, { ...repo, recentAt });
    }
    return [...bySlug.values()].sort((a, b) => timeOf(b.recentAt) - timeOf(a.recentAt));
  }

  /**
   * Anthropic's list and the recent repositories as one list: recent ones
   * first by their last chat, then the rest by their last push. `accessible`
   * is whether Anthropic lists the repository, or null when its list is not
   * at hand (`listed` null).
   */
  function unite(listed) {
    const recent = recentRepositories();
    const recentBySlug = new Map(recent.map((repo) => [repo.slug.toLowerCase(), repo]));
    const out = [];
    const seen = new Set();
    for (const repo of Array.isArray(listed) ? listed : []) {
      const key = String(repo.slug || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({
        slug: repo.slug,
        owner: repo.owner,
        name: repo.name,
        repoUrl: repo.repoUrl,
        defaultBranch: repo.defaultBranch ?? null,
        private: repo.private === true,
        archived: repo.archived === true,
        pushedAt: repo.pushedAt ?? null,
        description: repo.description ?? null,
        recentAt: recentBySlug.get(key)?.recentAt ?? null,
        accessible: true,
      });
    }
    for (const repo of recent) {
      const key = repo.slug.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        slug: repo.slug,
        owner: repo.owner,
        name: repo.repo,
        repoUrl: repo.repoUrl,
        defaultBranch: null,
        private: null,
        archived: null,
        pushedAt: null,
        description: null,
        recentAt: repo.recentAt,
        accessible: listed ? false : null,
      });
    }
    out.sort((a, b) => {
      if (a.recentAt && b.recentAt) return timeOf(b.recentAt) - timeOf(a.recentAt);
      if (a.recentAt || b.recentAt) return a.recentAt ? -1 : 1;
      return timeOf(b.pushedAt) - timeOf(a.pushedAt);
    });
    return out;
  }

  async function fetchList() {
    if (typeof cloud?.listRepositories !== 'function') throw new Error('The cloud client is unavailable.');
    const listed = await cloud.listRepositories();
    return {
      repos: Array.isArray(listed?.repos) ? listed.repos : [],
      complete: listed?.complete !== false,
      fetchedAt: new Date(nowMs()).toISOString(),
    };
  }

  /** Anthropic's list, from the cache when it is fresh enough; rejects when the read fails. */
  function loadList({ force }) {
    if (!force && cached && nowMs() - cached.at < keepMs) return Promise.resolve(cached.value);
    if (!inFlight) {
      inFlight = fetchList()
        .then((value) => {
          cached = { at: nowMs(), value };
          return value;
        })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  /**
   * GET /api/claude-cloud/repos. Resolves `{ ok, repos, complete, fetchedAt,
   * source, error }`: `ok: true` with Anthropic's list united with the recent
   * repositories (`error` set when the read failed and the list is the
   * cached one), `ok: false` with the recent ones alone when nothing is
   * cached, `ok: false` with `claude_cloud_disabled` while the provider is
   * off. Never rejects.
   */
  async function listRepositories({ force = false } = {}) {
    if (!enabled()) {
      cached = null;
      return {
        ok: false,
        repos: [],
        complete: false,
        fetchedAt: null,
        source: null,
        error: { code: 'claude_cloud_disabled', message: DISABLED_MESSAGE },
      };
    }
    let value = null;
    let error = null;
    try {
      value = await loadList({ force: force === true });
    } catch (caught) {
      error = describeListError(caught);
      value = cached?.value || null;
      logger?.warn?.(`[claude-cloud] repository list failed: ${error.code}${value ? ' (serving the cached list)' : ''}`);
    }
    // Switched off while the answer was on its way: it is not handed out.
    if (!enabled()) {
      cached = null;
      return {
        ok: false,
        repos: [],
        complete: false,
        fetchedAt: null,
        source: null,
        error: { code: 'claude_cloud_disabled', message: DISABLED_MESSAGE },
      };
    }
    if (!value) {
      return { ok: false, repos: unite(null), complete: false, fetchedAt: null, source: 'recent', error };
    }
    return {
      ok: true,
      repos: unite(value.repos),
      complete: value.complete,
      fetchedAt: value.fetchedAt,
      source: 'anthropic',
      error,
    };
  }

  function runLsRemote(repoUrl) {
    return new Promise((resolve) => {
      const env = {
        ...process.env,
        // No prompt of any kind: a remote the host cannot read is an answer.
        GIT_TERMINAL_PROMPT: '0',
        // An askpass that prints nothing (echo is on every platform's PATH):
        // git takes the empty answer and fails the authentication at once.
        GIT_ASKPASS: 'echo',
        SSH_ASKPASS: 'echo',
        GCM_INTERACTIVE: 'never',
        GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
      };
      try {
        // HEAD is named explicitly: `--heads` alone leaves out the symref
        // line that says which branch is the default.
        execFileImpl('git', ['ls-remote', '--symref', repoUrl, 'HEAD', 'refs/heads/*'], {
          env,
          timeout: GIT_COMMAND_TIMEOUT_MS,
          maxBuffer: GIT_MAX_OUTPUT_BYTES,
          windowsHide: true,
        }, (error, stdout, stderr) => {
          resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
      } catch (error) {
        resolve({ error, stdout: '', stderr: '' });
      }
    });
  }

  /**
   * GET /api/claude-cloud/branches. `repoInput` is `owner/name` or a GitHub
   * URL. Resolves `{ ok: true, slug, repoUrl, branches, defaultBranch }` or
   * `{ ok: false, slug, error: { code, message } }` with `invalid_repo`,
   * `disabled`, `timeout` or `unreachable`. Never rejects.
   */
  async function listBranches(repoInput) {
    const repo = resolveRepositoryInput(repoInput);
    if (!repo) {
      return {
        ok: false,
        slug: null,
        error: { code: 'invalid_repo', message: 'A GitHub repository (owner/name or its URL) is required.' },
      };
    }
    if (gitBranchLookup === false || gitBranchLookup === 'off') {
      return { ok: false, slug: repo.slug, error: { code: 'disabled', message: LOOKUP_OFF_MESSAGE } };
    }
    const { error, stdout, stderr } = await runLsRemote(repo.repoUrl);
    if (error) {
      // execFile reports its own timeout as a killed child without an exit code.
      const timedOut = error.killed === true && (error.code === null || error.code === undefined || error.signal === 'SIGTERM');
      if (timedOut) {
        return {
          ok: false,
          slug: repo.slug,
          error: { code: 'timeout', message: `GitHub did not answer within ${Math.round(GIT_COMMAND_TIMEOUT_MS / 1000)} s.` },
        };
      }
      const said = describeGitFailure(stderr) || (error.code === 'ENOENT' ? 'git is not installed on this host.' : '');
      return {
        ok: false,
        slug: repo.slug,
        error: { code: 'unreachable', message: said || `The branches of ${repo.slug} could not be read.` },
      };
    }
    const { branches, defaultBranch } = parseLsRemoteHeads(stdout);
    return { ok: true, slug: repo.slug, repoUrl: repo.repoUrl, branches, defaultBranch };
  }

  return { listRepositories, listBranches };
}
