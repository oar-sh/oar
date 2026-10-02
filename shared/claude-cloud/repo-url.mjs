// Repository, branch and model strings for Claude Cloud sessions.
//
// A cloud session clones a GitHub repository by its https URL and, when one is
// named, checks out a branch. Both arrive as free text (the New Chat fields,
// an `origin` remote read from a folder), so everything is brought to one form
// here before it is stored or sent: the server validates with these, the
// browser shows what they return, the client sends it.
//
// Pure functions, no I/O.

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
// GitHub's own rules: an account name is letters, digits and single hyphens
// (never leading), at most 39 characters; a repository name is letters,
// digits, `.`, `_` and `-`, at most 100.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_BRANCH_LENGTH = 255;

function ownerAndRepoFromPath(pathText) {
  const parts = String(pathText || '').split('/').filter(Boolean);
  // Exactly owner/repo: a pasted page URL (…/tree/main, /orgs/<name>/…) would
  // otherwise be read as some other repository.
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!OWNER_PATTERN.test(owner) || owner.endsWith('-')) return null;
  if (!REPO_PATTERN.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

/**
 * The canonical https form of a GitHub repository reference, or null when the
 * text is not one. Accepts `https://github.com/owner/repo` (with `.git`, a
 * trailing slash, or credentials in front of the host, which are dropped),
 * `git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo`,
 * `git://…` and the scheme-less `github.com/owner/repo`.
 */
export function normalizeGitHubRepoUrl(input) {
  const text = String(input ?? '').trim();
  if (!text || /\s/.test(text)) return null;

  let host = '';
  let pathText = '';
  // scp-like: [user@]host:owner/repo(.git). A scheme is followed by `//`, so
  // `https://…` and `ssh://…` never match here.
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
  const parsed = ownerAndRepoFromPath(pathText);
  if (!parsed) return null;
  const slug = `${parsed.owner}/${parsed.repo}`;
  return { repoUrl: `https://github.com/${slug}`, owner: parsed.owner, repo: parsed.repo, slug };
}

/**
 * Whether git would accept the text as a branch name (the rules of
 * `git check-ref-format --branch`). Nothing is trimmed: a name with a space
 * around it is not a branch name.
 */
export function isValidBranchName(value) {
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
 * A model id without its tier suffix: "claude-opus-5[1m]" → "claude-opus-5".
 * The cloud takes plain ids only.
 */
export function stripModelTierSuffix(model) {
  return String(model ?? '').trim().replace(/\s*\[[^\]]*\]$/, '').trim();
}

function encodeRefForUrl(ref) {
  return ref.split('/').map((part) => encodeURIComponent(part)).join('/');
}

/**
 * Where GitHub shows what a pushed branch changed: the compare page against
 * `base`, the compare page against the default branch when no base is known,
 * and the branch itself when it is the base (a compare of a branch with itself
 * is empty). Null when the slug or the branch is not usable.
 */
export function compareUrl(slug, base, branch) {
  const repo = normalizeGitHubRepoUrl(`https://github.com/${String(slug ?? '').trim()}`);
  if (!repo || !isValidBranchName(branch)) return null;
  const head = encodeRefForUrl(branch);
  if (base === branch) return `${repo.repoUrl}/tree/${head}`;
  if (!isValidBranchName(base)) return `${repo.repoUrl}/compare/${head}`;
  return `${repo.repoUrl}/compare/${encodeRefForUrl(base)}...${head}`;
}
