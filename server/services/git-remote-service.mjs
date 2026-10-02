'use strict';

import { execFile as nodeExecFile } from 'child_process';

import { normalizeGitHubRepoUrl } from '../../shared/claude-cloud/repo-url.mjs';
import { createGitChangesService } from './git-changes-service.mjs';

// What a folder's git checkout says about where it lives on GitHub: the
// remote, the branch, and how far the checkout is from what was pushed. The
// New Chat modal fills the repository and branch of a Claude Cloud chat from
// it and warns about work the cloud clone will not have (commits that were
// never pushed, uncommitted changes).
//
// Read-only: `git status` and `git remote get-url`, nothing else. The route
// validates the folder before calling in.

const GIT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_REMOTE = 'origin';

const NO_GIT = Object.freeze({
  hasGit: false,
  remoteUrl: null,
  repoUrl: null,
  slug: null,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  dirty: false,
});

/**
 * A remote URL as the browser may see it: credentials in front of the host
 * (`https://user:secret@host/…`) are dropped. The scp form keeps its `git@`.
 */
export function redactRemoteUrlCredentials(remoteUrl) {
  const text = String(remoteUrl || '').trim();
  if (!text) return '';
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return text;
  try {
    const url = new URL(text);
    if (!url.username && !url.password) return text;
    // ssh://git@host/… names the transport user, not a secret.
    if (url.protocol === 'ssh:' && !url.password) return text;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return text.replace(/\/\/[^/@\s]*@/, '//');
  }
}

/** The remote a tracking ref such as `fork/main` lives on, or ''. */
function remoteOfUpstream(upstream) {
  const text = String(upstream || '').trim();
  const slash = text.indexOf('/');
  return slash > 0 ? text.slice(0, slash) : '';
}

export function createGitRemoteService({
  execFileImpl = nodeExecFile,
  gitChangesService = createGitChangesService({ execFileImpl }),
} = {}) {
  function readRemoteUrl(rootPath, remoteName) {
    return new Promise((resolve) => {
      try {
        execFileImpl('git', ['remote', 'get-url', remoteName], {
          cwd: rootPath,
          timeout: GIT_COMMAND_TIMEOUT_MS,
          windowsHide: true,
        }, (error, stdout) => {
          // No such remote is an answer, not a failure.
          resolve(error ? '' : String(stdout || '').trim().split(/\r?\n/)[0] || '');
        });
      } catch {
        resolve('');
      }
    });
  }

  /**
   * `{ ok, hasGit, remoteUrl, repoUrl, slug, branch, upstream, ahead, behind,
   * dirty }` for a folder; `hasGit: false` when it is not a git checkout.
   */
  async function describe(rootPath) {
    const status = await gitChangesService.getStatus(rootPath);
    if (!status?.ok) return { ok: false, error: status?.error || 'Failed to read git status' };
    if (status.isRepo === false) return { ok: true, ...NO_GIT };

    const upstream = String(status.upstream || '').trim();
    let remoteUrl = await readRemoteUrl(rootPath, DEFAULT_REMOTE);
    const upstreamRemote = remoteOfUpstream(upstream);
    if (!remoteUrl && upstreamRemote && upstreamRemote !== DEFAULT_REMOTE) {
      remoteUrl = await readRemoteUrl(rootPath, upstreamRemote);
    }
    // One validator for the modal and for the bootstrap that follows it: a
    // remote the bootstrap would refuse is shown as "no GitHub remote".
    const repo = normalizeGitHubRepoUrl(remoteUrl);
    const branch = status.detached ? '' : String(status.branch || '').trim();
    return {
      ok: true,
      hasGit: true,
      remoteUrl: redactRemoteUrlCredentials(remoteUrl) || null,
      repoUrl: repo?.repoUrl || null,
      slug: repo?.slug || null,
      branch: branch || null,
      upstream: upstream || null,
      ahead: Number(status.ahead || 0),
      behind: Number(status.behind || 0),
      dirty: Array.isArray(status.files) && status.files.length > 0,
    };
  }

  return { describe };
}
