// Pure helpers for the Claude Cloud provider (`claude-cloud`): the New Chat
// repository/branch fields and their warning lines, the conversation's cloud
// line, the composer's model list and the image-only attachment rule.
//
// DOM-free on purpose, like remote-relay-origin-view.mjs: the callers
// (journal-view.js, claude-cloud-conversation-ui.js, attachments-view.js,
// bootstrap.js) own the elements, this module owns the decisions.
//
// The repository, branch and compare-link rules mirror
// shared/claude-cloud/repo-url.mjs, which the browser cannot import (only
// server/public is served); claude-cloud-ui.test.mjs holds the two together.
// They exist to say what is wrong before a round trip; the server validates
// again and its answer is the one that counts.

export const CLAUDE_CLOUD_PROVIDER = 'claude-cloud';
export const CLAUDE_CLOUD_LABEL = 'Claude Cloud';
export const CLAUDE_CLOUD_MARKER = '☁';
export const CLAUDE_CODE_WEB_URL = 'https://claude.ai/code';
export const CLAUDE_CLOUD_SETTINGS_PATH = 'Settings → Providers → Claude Cloud';

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isClaudeCloudProviderType(providerType = '') {
  return String(providerType || '').trim().toLowerCase() === CLAUDE_CLOUD_PROVIDER;
}

export function isClaudeCloudConversation(conversation = null) {
  return isClaudeCloudProviderType(
    conversation?.runtimeProviderType ?? conversation?.runtime_provider_type ?? '',
  );
}

// ── Repository and branch inputs ──

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_BRANCH_LENGTH = 255;

function ownerAndRepoFromPath(pathText) {
  const parts = String(pathText || '').split('/').filter(Boolean);
  // Exactly owner/repo: a pasted page URL (…/tree/main) names something else.
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!OWNER_PATTERN.test(owner) || owner.endsWith('-')) return null;
  if (!REPO_PATTERN.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

/**
 * A typed or detected repository as `{ repoUrl, owner, repo, slug }`, or null
 * when it does not name a GitHub repository. `repoUrl` is always the https
 * form, which is what the bootstrap request carries.
 *
 * Same forms as the server's normalizeGitHubRepoUrl, plus one it does not
 * take: a bare `owner/repo`, because a full URL is a lot to type on a phone.
 * That is safe only because the https form is what gets sent.
 */
export function normalizeCloudRepoInput(input = '') {
  const text = String(input ?? '').trim();
  if (!text || /\s/.test(text)) return null;

  let parsed = null;
  if (/^[^/:@]+\/[^/:@]+\/?$/.test(text)) {
    parsed = ownerAndRepoFromPath(text);
  } else {
    let host = '';
    let pathText = '';
    // scp-like: [user@]host:owner/repo(.git). A scheme is followed by `//`.
    const scp = text.match(/^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/);
    if (scp) {
      host = scp[1];
      pathText = scp[2];
    } else {
      const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`;
      let url;
      try {
        url = new URL(withScheme);
      } catch {
        return null;
      }
      if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol)) return null;
      host = url.hostname;
      pathText = url.pathname;
    }
    if (!GITHUB_HOSTS.has(host.toLowerCase())) return null;
    parsed = ownerAndRepoFromPath(pathText);
  }
  if (!parsed) return null;
  const slug = `${parsed.owner}/${parsed.repo}`;
  return { repoUrl: `https://github.com/${slug}`, owner: parsed.owner, repo: parsed.repo, slug };
}

// The rules of `git check-ref-format --branch`. Nothing is trimmed: a name
// with a space around it is not a branch name.
export function isValidCloudBranchName(value = '') {
  if (typeof value !== 'string') return false;
  if (!value || value.length > MAX_BRANCH_LENGTH) return false;
  if (value === '@' || value.startsWith('-')) return false;
  // Control characters, space, and the characters git reserves for revisions.
  if (/[\u0000- \u007f~^:?*[\\]/.test(value)) return false;
  if (value.includes('..') || value.includes('@{') || value.includes('//')) return false;
  if (value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false;
  return value.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * What the Start button does with the two fields: either the `cloudSource` to
 * send, or one message per field that needs fixing. An empty branch is valid
 * (the cloud clones the repository's default branch).
 */
export function validateCloudSourceInputs({ repo = '', branch = '' } = {}) {
  const repoText = String(repo ?? '').trim();
  const branchText = String(branch ?? '').trim();
  const errors = {};
  const normalized = normalizeCloudRepoInput(repoText);
  if (!repoText) {
    errors.repo = 'Enter a GitHub repository.';
  } else if (!normalized) {
    errors.repo = 'Not a GitHub repository. Use owner/repo or a github.com URL.';
  }
  if (branchText && !isValidCloudBranchName(branchText)) {
    errors.branch = 'Not a valid branch name.';
  }
  if (errors.repo || errors.branch) {
    return { ok: false, cloudSource: null, slug: normalized?.slug || '', errors };
  }
  return {
    ok: true,
    cloudSource: { repoUrl: normalized.repoUrl, ...(branchText ? { branch: branchText } : {}) },
    slug: normalized.slug,
    errors,
  };
}

/**
 * What the two fields should hold after a folder lookup. A folder with a
 * GitHub remote always fills them (picking a folder is an explicit choice). A
 * folder without one clears only what an earlier lookup put there, so a
 * repository typed by hand survives browsing through folders.
 */
export function resolveCloudSourceAutoFill({ current = {}, lastAutoFill = null, remote = null } = {}) {
  const currentRepo = String(current?.repo ?? '');
  const currentBranch = String(current?.branch ?? '');
  const detectedRepo = String(remote?.repoUrl || '').trim();
  if (detectedRepo) {
    const detected = { repo: detectedRepo, branch: String(remote?.branch || '').trim() };
    return { ...detected, autoFill: detected };
  }
  const untouched = !!lastAutoFill
    && currentRepo.trim() === String(lastAutoFill.repo || '')
    && currentBranch.trim() === String(lastAutoFill.branch || '');
  if (untouched) return { repo: '', branch: '', autoFill: null };
  return { repo: currentRepo, branch: currentBranch, autoFill: lastAutoFill || null };
}

/**
 * The line under the New Chat folder picker while Claude Cloud is selected.
 * The folder is only a way to fill the two fields: nothing runs in it.
 */
export function cloudFolderStatusText(folderPath = '') {
  const path = String(folderPath || '').trim();
  return path
    ? `Repository and branch are read from ${path}. The chat itself runs in the cloud.`
    : 'The chat runs in the cloud. Pick a folder to fill in its repository and branch, or type them below.';
}

function commitCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

/**
 * The warning lines under the Repository and Branch fields.
 *
 * `remote` is the GET /api/git/remote payload for the selected folder (null
 * when no folder was looked up), `lookupFailed` a request that did not come
 * back. The folder's unpushed/dirty state only matters while the fields still
 * name that folder's repository and branch: once the user types another one,
 * the cloud clone has nothing to do with the local checkout. `repoAccess` is
 * what cloudRepoAccess said about the repository in the field.
 */
export function buildCloudSourceWarnings({
  remote = null,
  lookupFailed = false,
  repo = '',
  branch = '',
  environmentId = '',
  checkEnvironment = true,
  repoAccess = 'unknown',
} = {}) {
  const warnings = [];
  if (lookupFailed || (remote && remote.ok === false)) {
    warnings.push({
      kind: 'lookup-failed',
      text: 'Could not read git details for this folder — enter the repository by hand.',
    });
  } else if (remote) {
    const folderRepo = normalizeCloudRepoInput(remote.repoUrl || remote.slug || '');
    if (remote.hasGit === false) {
      warnings.push({
        kind: 'no-git',
        text: 'This folder is not a git repository — enter the repository by hand.',
      });
    } else if (!folderRepo) {
      warnings.push({
        kind: 'no-remote',
        text: String(remote.remoteUrl || '').trim()
          ? 'The remote of this folder is not on GitHub — cloud sessions need a GitHub repository.'
          : 'No GitHub remote in this folder — enter the repository by hand.',
      });
    } else {
      const typedRepo = normalizeCloudRepoInput(repo);
      const sameRepo = !!typedRepo && typedRepo.slug.toLowerCase() === folderRepo.slug.toLowerCase();
      const folderBranch = String(remote.branch || '').trim();
      const sameBranch = sameRepo && !!folderBranch && String(branch ?? '').trim() === folderBranch;
      const ahead = commitCount(remote.ahead);
      if (sameBranch && !String(remote.upstream || '').trim()) {
        warnings.push({
          kind: 'no-upstream',
          text: `Branch ${folderBranch} has no upstream — push it first, the cloud clone only sees GitHub.`,
        });
      } else if (sameBranch && ahead > 0) {
        warnings.push({
          kind: 'unpushed',
          text: ahead === 1
            ? '1 commit not pushed — the cloud clone will not have it.'
            : `${ahead} commits not pushed — the cloud clone will not have them.`,
        });
      }
      if (sameRepo && remote.dirty === true) {
        warnings.push({ kind: 'dirty', text: 'Uncommitted changes stay local.' });
      }
    }
  }
  // A repository the Claude GitHub app cannot reach is refused by the cloud
  // after the first message; the list of reachable ones says so before it.
  if (repoAccess === 'inaccessible') {
    const typedRepo = normalizeCloudRepoInput(repo);
    warnings.push({
      kind: 'not-accessible',
      text: `The Claude GitHub app has no access to ${typedRepo?.slug || 'this repository'} — add it under `
        + 'GitHub → Settings → Applications → Claude, or pick another repository.',
    });
  }
  if (checkEnvironment && !String(environmentId || '').trim()) {
    warnings.push({
      kind: 'no-environment',
      text: `No cloud environment is set — choose one in ${CLAUDE_CLOUD_SETTINGS_PATH}.`,
    });
  }
  return warnings;
}

// ── Repository and branch suggestions ──

const MAX_SUGGESTIONS = 8;

/**
 * Whether the Claude GitHub app can reach the repository in the field:
 * 'accessible', 'inaccessible', or 'unknown' while the list has not loaded,
 * is incomplete, or the field names no repository yet. `repos` is the payload
 * of GET /api/claude-cloud/repos.
 */
export function cloudRepoAccess(repoList = null, repo = '') {
  const typed = normalizeCloudRepoInput(repo);
  if (!typed || !repoList || repoList.ok !== true || repoList.complete !== true) return 'unknown';
  const entries = Array.isArray(repoList.repos) ? repoList.repos : [];
  const match = entries.find((entry) => String(entry?.slug || '').toLowerCase() === typed.slug.toLowerCase());
  if (!match) return 'inaccessible';
  return match.accessible === false ? 'inaccessible' : 'accessible';
}

/**
 * The repositories to offer under the Repository field for what is typed so
 * far: with nothing typed, the ones used in earlier cloud chats first, then
 * the rest as the list has them (most recently pushed first); with text,
 * those whose `owner/name` contains it, a match at the start of the owner or
 * the name before one in the middle. A URL typed or pasted is matched by its
 * `owner/name`. At most `limit` entries.
 */
export function filterCloudRepoSuggestions(repos = [], query = '', { limit = MAX_SUGGESTIONS } = {}) {
  const entries = (Array.isArray(repos) ? repos : []).filter((entry) => entry && String(entry.slug || '').trim());
  const raw = String(query ?? '').trim();
  const needle = (normalizeCloudRepoInput(raw)?.slug || raw).toLowerCase();
  if (!needle) return entries.slice(0, limit);
  const ranked = [];
  for (const entry of entries) {
    const slug = String(entry.slug).toLowerCase();
    const index = slug.indexOf(needle);
    if (index < 0) continue;
    const atStart = index === 0 || slug[index - 1] === '/';
    ranked.push({ entry, rank: slug === needle ? 0 : atStart ? 1 : 2 });
  }
  // A stable sort: the list's own order breaks ties.
  return ranked.sort((left, right) => left.rank - right.rank).map(({ entry }) => entry).slice(0, limit);
}

/** The second line of a repository suggestion: visibility, and that it was used here before. */
export function cloudRepoSuggestionMeta(entry = null) {
  const parts = [];
  if (entry?.recentAt) parts.push('used here');
  if (entry?.accessible === false) parts.push('no access');
  else if (entry?.private === true) parts.push('private');
  else if (entry?.private === false) parts.push('public');
  if (entry?.archived === true) parts.push('archived');
  return parts.join(' · ');
}

/**
 * The branches to offer under the Branch field: with nothing typed, the
 * default branch first and the rest in the order the relay sent them (the
 * default first, then alphabetical); with text, the names that contain it,
 * a match at the start first.
 */
export function filterCloudBranchSuggestions(branches = [], query = '', { defaultBranch = '', limit = MAX_SUGGESTIONS } = {}) {
  const names = [...new Set((Array.isArray(branches) ? branches : []).map((name) => String(name || '').trim()).filter(Boolean))];
  const preferred = String(defaultBranch || '').trim();
  const ordered = preferred && names.includes(preferred)
    ? [preferred, ...names.filter((name) => name !== preferred)]
    : names;
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return ordered.slice(0, limit);
  const ranked = [];
  for (const name of ordered) {
    const index = name.toLowerCase().indexOf(needle);
    if (index < 0) continue;
    ranked.push({ name, rank: name.toLowerCase() === needle ? 0 : index === 0 ? 1 : 2 });
  }
  return ranked.sort((left, right) => left.rank - right.rank).map(({ name }) => name).slice(0, limit);
}

const BOOTSTRAP_ERROR_FALLBACKS = Object.freeze({
  claude_cloud_disabled: {
    field: null,
    text: `Claude Cloud is turned off. Enable it in ${CLAUDE_CLOUD_SETTINGS_PATH}.`,
  },
  claude_cloud_repo_invalid: {
    field: 'repo',
    text: 'The relay did not accept this repository. Use a GitHub repository.',
  },
  claude_cloud_branch_invalid: {
    field: 'branch',
    text: 'The relay did not accept this branch name.',
  },
  claude_cloud_environment_missing: {
    field: null,
    text: `No cloud environment is set. Choose one in ${CLAUDE_CLOUD_SETTINGS_PATH}.`,
  },
});

/**
 * A rejected bootstrap as `{ code, field, text }` for the inline error line,
 * or null when the rejection is not a Claude Cloud one (the caller keeps its
 * usual notice then). The server's own wording wins when it sent any.
 */
export function cloudBootstrapErrorModel({ code = '', message = '' } = {}) {
  const normalizedCode = String(code || '').trim().toLowerCase();
  if (!normalizedCode.startsWith('claude_cloud_')) return null;
  const fallback = BOOTSTRAP_ERROR_FALLBACKS[normalizedCode] || { field: null, text: '' };
  const text = oneLine(message) || fallback.text || 'The relay could not start this cloud chat.';
  return { code: normalizedCode, field: fallback.field, text };
}

// ── New Chat rows and models ──

/**
 * Which optional rows of the New Chat modal a provider shows. `contextTier`
 * only says the row may appear: newConversationContextTierState still decides
 * per model.
 */
export function newChatRowVisibility(providerType = '') {
  const provider = String(providerType || '').trim().toLowerCase();
  const cloud = provider === CLAUDE_CLOUD_PROVIDER;
  return {
    cloudSource: cloud,
    reasoning: !cloud,
    contextTier: !cloud,
    imageSize: provider === 'openai-image',
  };
}

function uniqueModelIds(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = String(value || '').trim();
    const key = id.toLowerCase();
    if (!id || key === 'auto' || seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/** The models a cloud chat may start with: the tab's list plus its default. */
export function claudeCloudModelIds(settings = null) {
  return uniqueModelIds([
    ...(Array.isArray(settings?.models) ? settings.models : []),
    settings?.defaultModel,
  ]);
}

export function claudeCloudDefaultModel(settings = null, models = claudeCloudModelIds(settings)) {
  const preferred = String(settings?.defaultModel || '').trim();
  if (preferred && models.includes(preferred)) return preferred;
  return models[0] || '';
}

function plainModelId(modelId) {
  // Cloud model ids are plain: "claude-opus-5[1m]" is offered as "claude-opus-5".
  return String(modelId || '').trim().replace(/\s*\[[^\]]*\]$/, '').trim();
}

/**
 * The composer's model list for a cloud conversation. The settings list is the
 * authority; until it has loaded (or on a relay that does not tag models for
 * this provider) the Claude rows of the shared catalog stand in. The
 * conversation's own model is always on the list, so the picker can never
 * show (or send) another provider's model for a cloud chat.
 */
export function claudeCloudComposerModelIds({
  settings = null,
  catalogModels = [],
  providersByModel = {},
  conversationModel = '',
} = {}) {
  const own = plainModelId(conversationModel);
  const fromSettings = claudeCloudModelIds(settings);
  if (fromSettings.length) return uniqueModelIds([...fromSettings, own]);
  const servedBy = (modelId) => {
    const providers = providersByModel?.[String(modelId || '').trim().toLowerCase()];
    return Array.isArray(providers) ? providers : [];
  };
  return uniqueModelIds([
    ...(Array.isArray(catalogModels) ? catalogModels : [])
      .filter((modelId) => {
        const providers = servedBy(modelId);
        return providers.includes(CLAUDE_CLOUD_PROVIDER) || providers.includes('claude');
      })
      .map(plainModelId),
    own,
  ]);
}

// ── The conversation's cloud line ──

function encodeRefPath(ref) {
  return String(ref || '').split('/').map((part) => encodeURIComponent(part)).join('/');
}

/**
 * Where GitHub shows what a pushed branch changed:
 * `https://github.com/<slug>/compare/<base>...<branch>`, the compare page
 * against the default branch when no base is known (the chat cloned the
 * default branch), and the branch itself when it is the base (a branch
 * compared with itself is empty). '' when the slug or the branch is unusable.
 */
export function cloudCompareUrl(slug = '', base = '', branch = '') {
  const repo = normalizeCloudRepoInput(`https://github.com/${String(slug ?? '').trim()}`);
  if (!repo || !isValidCloudBranchName(branch)) return '';
  const head = encodeRefPath(branch);
  if (base === branch) return `${repo.repoUrl}/tree/${head}`;
  if (!isValidCloudBranchName(base)) return `${repo.repoUrl}/compare/${head}`;
  return `${repo.repoUrl}/compare/${encodeRefPath(base)}...${head}`;
}

function httpsUrl(value) {
  const text = oneLine(value);
  return /^https:\/\/[^\s"'<>]+$/i.test(text) ? text : '';
}

export function formatCloudCost(costUsd) {
  if (costUsd === null || costUsd === undefined || costUsd === '') return '';
  const cost = Number(costUsd);
  if (!Number.isFinite(cost) || cost <= 0) return '';
  return cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
}

/**
 * The display model of a conversation's `cloud` payload field, or null when it
 * names no repository. One entry per pushed branch, newest report last; a push
 * to the cloned branch itself has nothing to compare against, so it links to
 * that branch instead.
 */
export function buildCloudLineModel(cloud = null) {
  if (!cloud || typeof cloud !== 'object' || Array.isArray(cloud)) return null;
  const repo = normalizeCloudRepoInput(cloud.repoUrl || '') || normalizeCloudRepoInput(cloud.slug || '');
  if (!repo) return null;
  const branch = oneLine(cloud.branch);
  const pushedByBranch = new Map();
  for (const entry of Array.isArray(cloud.pushedBranches) ? cloud.pushedBranches : []) {
    const name = oneLine(typeof entry === 'string' ? entry : entry?.branch);
    if (!name) continue;
    // Re-inserting moves a branch pushed again to the end.
    pushedByBranch.delete(name);
    const url = cloudCompareUrl(repo.slug, branch, name);
    // A name git would not accept cannot be linked; it is not a branch.
    if (!url) continue;
    pushedByBranch.set(name, {
      branch: name,
      at: oneLine(typeof entry === 'string' ? '' : entry?.at),
      sameAsBase: name === branch,
      url,
    });
  }
  return {
    slug: repo.slug,
    repoUrl: repo.repoUrl,
    branch,
    sessionUrl: httpsUrl(cloud.sessionUrl),
    pushed: Array.from(pushedByBranch.values()),
    cost: formatCloudCost(cloud.costUsd),
  };
}

/** The short text for the chat header: "☁ example-org/sample-repo · main". */
export function cloudHeaderLabel(cloud = null) {
  const model = buildCloudLineModel(cloud);
  if (!model) return '';
  return `${CLAUDE_CLOUD_MARKER} ${model.slug}${model.branch ? ` · ${model.branch}` : ''}`;
}

export function renderCloudLineHtml(cloud = null) {
  const model = buildCloudLineModel(cloud);
  if (!model) return '';
  const parts = [
    `<a class="cloud-line-item cloud-line-repo" href="${escapeHtml(model.repoUrl)}" target="_blank" rel="noopener" title="The GitHub repository this chat works on in the cloud">${CLAUDE_CLOUD_MARKER} ${escapeHtml(model.slug)}</a>`,
  ];
  if (model.branch) {
    parts.push(`<span class="cloud-line-item cloud-line-branch" title="Branch the cloud session cloned">${escapeHtml(model.branch)}</span>`);
  }
  if (model.sessionUrl) {
    parts.push(`<a class="cloud-line-item cloud-line-session" href="${escapeHtml(model.sessionUrl)}" target="_blank" rel="noopener" title="Open this session on claude.ai">claude.ai ↗</a>`);
  }
  for (const pushed of model.pushed) {
    const title = pushed.sameAsBase
      ? `Pushed to ${pushed.branch}. Opens the branch on GitHub.`
      : `Pushed branch. Opens the comparison with ${model.branch || 'the default branch'} on GitHub.`;
    parts.push(`<a class="cloud-line-item cloud-line-push" href="${escapeHtml(pushed.url)}" target="_blank" rel="noopener" title="${escapeHtml(title)}">⇡ ${escapeHtml(pushed.branch)}</a>`);
  }
  if (model.cost) {
    parts.push(`<span class="cloud-line-item cloud-line-cost" title="Cost of this cloud session so far, as reported by Anthropic">${escapeHtml(model.cost)}</span>`);
  }
  return parts.join('');
}

/**
 * The `cloud` field after a `claude_cloud_session` event. The event carries
 * the whole field; a payload without one leaves what the client already has.
 */
export function mergeCloudSessionUpdate(currentCloud = null, payloadCloud = undefined) {
  if (payloadCloud === undefined) return currentCloud ?? null;
  if (payloadCloud === null || typeof payloadCloud !== 'object' || Array.isArray(payloadCloud)) return null;
  return { ...(currentCloud && typeof currentCloud === 'object' ? currentCloud : {}), ...payloadCloud };
}

// ── Attachments: inline images only ──

// The limits of server/claude-worker/claude-attachments.mjs, which the cloud
// worker applies too: anything else is refused there with a whole turn lost.
export const CLAUDE_CLOUD_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export const CLAUDE_CLOUD_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const CLAUDE_CLOUD_ATTACH_ACCEPT = CLAUDE_CLOUD_IMAGE_TYPES.join(',');
export const CLAUDE_CLOUD_ATTACH_HINT = 'Attach image (Claude Cloud chats take images only: JPEG, PNG, GIF or WebP up to 5 MB)';

/** '' when a cloud chat can carry the attachment, else 'type' or 'size'. */
export function cloudAttachmentRejection(attachment = null) {
  const type = String(attachment?.type || '').trim().toLowerCase();
  if (!CLAUDE_CLOUD_IMAGE_TYPES.includes(type)) return 'type';
  const size = Number(attachment?.size || 0);
  if (Number.isFinite(size) && size > CLAUDE_CLOUD_MAX_IMAGE_BYTES) return 'size';
  return '';
}

export function partitionCloudAttachments(attachments = []) {
  const accepted = [];
  const rejected = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!attachment) continue;
    const reason = cloudAttachmentRejection(attachment);
    if (reason) rejected.push({ attachment, reason });
    else accepted.push(attachment);
  }
  return { accepted, rejected };
}

export function cloudAttachmentRejectionNotice(rejected = []) {
  const list = Array.isArray(rejected) ? rejected.filter(Boolean) : [];
  if (!list.length) return '';
  const names = list.map((entry) => oneLine(entry?.attachment?.name) || 'file');
  const shown = names.slice(0, 2).join(', ');
  const more = names.length > 2 ? ` and ${names.length - 2} more` : '';
  const onlySize = list.every((entry) => entry?.reason === 'size');
  const rule = onlySize
    ? 'Claude Cloud chats take images up to 5 MB.'
    : 'Claude Cloud chats take images only (JPEG, PNG, GIF or WebP up to 5 MB).';
  return `${rule} Not attached: ${shown}${more}.`;
}
