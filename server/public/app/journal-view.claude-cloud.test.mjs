import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// The New Chat modal with the Claude Cloud provider, on the real index.html in
// JSDOM (harness as in conversation-view.transcript-dom.test.mjs): the option
// appears only when the relay says the provider is enabled, picking it swaps
// the effort row for Repository and Branch, a folder fills them, and the
// bootstrap request carries `cloudSource`.
const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
  const timer = nativeSetInterval(...args);
  timer?.unref?.();
  return timer;
};
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLDetailsElement = window.HTMLDetailsElement;
globalThis.NodeFilter = window.NodeFilter;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.CSS = { escape: (value) => String(value).replace(/["\\]/g, '\\$&') };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

const REPO_URL = 'https://github.com/example-org/sample-repo';
// platform-agnostic: the folder is only sent to the relay, never resolved here.
const FOLDER = '/home/dev/sample-repo';
const CLOUD_SETTINGS = {
  enabled: true,
  defaultModel: 'claude-sonnet-5-5',
  environmentId: 'env_01EXAMPLEaaaaaaaaaaaaaaaa',
  environments: [{ id: 'env_01EXAMPLEaaaaaaaaaaaaaaaa', name: 'Default' }],
  environmentsError: null,
  account: { loggedIn: true, email: 'dev@example.com', orgName: 'Example Org', subscriptionType: 'max' },
  token: { source: 'file', hasToken: true, expiresAt: '2099-01-01T00:00:00.000Z' },
  models: ['claude-opus-5', 'claude-sonnet-5-5'],
};
const CATALOG = {
  models: ['auto', 'gpt-5.4-mini'],
  currentModel: 'gpt-5.4-mini',
  defaultModel: 'gpt-5.4-mini',
  providersByModel: { 'gpt-5.4-mini': ['github-copilot'] },
  reasoningByModel: { auto: ['low', 'medium', 'high'], 'gpt-5.4-mini': ['low', 'medium', 'high'] },
  modelMetadataByModel: {},
  metadataValid: true,
  reasoningMetadataValid: true,
};

// Routed by path. A route answers a payload, or { status, body } to fail.
const requests = [];
const routes = {
  '/api/models': () => CATALOG,
  '/api/settings/claude-cloud': () => CLOUD_SETTINGS,
  '/api/git/remote': () => ({
    ok: true, root: FOLDER, hasGit: true, remoteUrl: `${REPO_URL}.git`, repoUrl: REPO_URL,
    slug: 'example-org/sample-repo', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0, dirty: true,
  }),
  '/api/conversation/bootstrap': () => ({ conversationId: 'conv-new', preferredModel: 'claude-sonnet-5-5', preferredReasoningEffort: 'none' }),
  '/api/conversation/conv-new': () => ({
    id: 'conv-new',
    title: 'New Conversation',
    messages: [],
    runtimeSession: { providerType: 'claude-cloud', providerModel: 'claude-sonnet-5-5' },
    cloud: { repoUrl: REPO_URL, slug: 'example-org/sample-repo', branch: 'main', sessionUrl: null, pushedBranches: [], costUsd: null },
  }),
};
globalThis.fetch = async (url, opts = {}) => {
  const parsed = new URL(String(url), 'http://localhost');
  const entry = {
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams),
    method: String(opts.method || 'GET'),
    body: opts.body ? JSON.parse(opts.body) : null,
  };
  requests.push(entry);
  // Every other read the modal and the opened conversation make answers empty.
  const answer = routes[parsed.pathname] ? await routes[parsed.pathname](entry) : {};
  const status = answer && typeof answer.status === 'number' ? answer.status : 200;
  const payload = answer && typeof answer.status === 'number' ? answer.body : answer;
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
};

const store = await import('./store.js');
const journal = await import('./journal-view.js');
const { conversations } = store;

const el = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => sleep(0);
const optionValues = (id) => Array.from(el(id).options).map((option) => option.value);
const requestsTo = (path) => requests.filter((request) => request.path === path);
const warningKinds = () => [...el('new-conversation-cloud-warnings').children].map((node) => node.dataset.kind);
const modalVisible = () => el('new-conversation-model-modal').classList.contains('visible');

async function selectProvider(value) {
  el('new-conversation-provider-select').value = value;
  el('new-conversation-provider-select').dispatchEvent(new window.Event('change'));
  await flush();
  await flush();
}

async function pickFolder(path) {
  el('new-conversation-cwd-select').value = '__custom__';
  el('new-conversation-cwd-select').dispatchEvent(new window.Event('change'));
  el('new-conversation-cwd-manual').value = path;
  el('new-conversation-cwd-manual').dispatchEvent(new window.Event('input'));
  // The lookup is debounced: the manual path fires on every keystroke.
  await sleep(450);
}

test('without the provider the modal looks exactly as before', async () => {
  for (const answer of [() => ({ status: 404, body: { error: 'Not found' } }), () => ({ ...CLOUD_SETTINGS, enabled: false })]) {
    routes['/api/settings/claude-cloud'] = answer;
    await journal.newConversation();
    assert.equal(modalVisible(), true);
    assert.deepEqual(optionValues('new-conversation-provider-select'), ['github']);
    assert.equal(el('new-conversation-provider-row').hidden, true);
    assert.equal(el('new-conversation-cloud-row').hidden, true);
    assert.equal(el('new-conversation-reasoning-row').hidden, false);
    assert.deepEqual(optionValues('new-conversation-reasoning-select'), ['low', 'medium', 'high']);
    assert.equal(requestsTo('/api/git/remote').length, 0);
    journal.closeNewConversationModelModal();
  }
  routes['/api/settings/claude-cloud'] = () => CLOUD_SETTINGS;
});

test('picking Claude Cloud swaps the effort row for Repository and Branch', async () => {
  await journal.newConversation();
  assert.deepEqual(optionValues('new-conversation-provider-select'), ['github', 'claude-cloud']);
  assert.equal(el('new-conversation-provider-select').selectedOptions[0].value, 'github');
  assert.equal(el('new-conversation-provider-row').hidden, false);
  assert.equal(el('new-conversation-cloud-row').hidden, true);

  await selectProvider('claude-cloud');
  assert.equal(el('new-conversation-cloud-row').hidden, false);
  assert.equal(el('new-conversation-reasoning-row').hidden, true);
  assert.equal(el('new-conversation-context-row').style.display, 'none');
  assert.equal(el('new-conversation-size-row').style.display, 'none');
  // The tab's models, its default selected, no Auto.
  assert.deepEqual(optionValues('new-conversation-model-select'), ['claude-opus-5', 'claude-sonnet-5-5']);
  assert.equal(el('new-conversation-model-select').value, 'claude-sonnet-5-5');
  assert.match(el('new-conversation-provider-help').textContent, /^Claude Cloud chats run in a sandbox at Anthropic/);
  assert.match(el('new-conversation-cwd-status').textContent, /^The chat runs in the cloud\./);
  // No folder picked and no relay default: nothing to look up, nothing to warn about.
  await sleep(450);
  assert.equal(requestsTo('/api/git/remote').length, 0);
  assert.equal(el('new-conversation-cloud-repo').value, '');
  assert.deepEqual(warningKinds(), []);
});

test('a picked folder fills the fields and says what the cloud clone will miss', async () => {
  await pickFolder(FOLDER);
  assert.deepEqual(requestsTo('/api/git/remote').map((request) => request.query), [{ root: FOLDER }]);
  assert.equal(el('new-conversation-cloud-repo').value, REPO_URL);
  assert.equal(el('new-conversation-cloud-branch').value, 'main');
  assert.deepEqual(warningKinds(), ['unpushed', 'dirty']);
  assert.equal(
    el('new-conversation-cloud-warnings').children[0].textContent,
    '2 commits not pushed — the cloud clone will not have them.',
  );
  assert.match(el('new-conversation-cwd-status').textContent, /^Repository and branch are read from /);

  // Another branch of the same repository: the unpushed commits are not on it.
  el('new-conversation-cloud-branch').value = 'release';
  el('new-conversation-cloud-branch').dispatchEvent(new window.Event('input'));
  assert.deepEqual(warningKinds(), ['dirty']);
});

test('a field that cannot be right is reported before anything is sent', async () => {
  el('new-conversation-cloud-branch').value = 'not a branch';
  await journal.confirmNewConversationModel();
  assert.equal(requestsTo('/api/conversation/bootstrap').length, 0);
  assert.equal(el('new-conversation-cloud-error').hidden, false);
  assert.equal(el('new-conversation-cloud-error').textContent, 'Not a valid branch name.');
  assert.equal(el('new-conversation-cloud-branch').getAttribute('aria-invalid'), 'true');
  assert.equal(el('new-conversation-cloud-repo').hasAttribute('aria-invalid'), false);
  assert.equal(modalVisible(), true);

  // Editing the field answers the error.
  el('new-conversation-cloud-branch').value = 'main';
  el('new-conversation-cloud-branch').dispatchEvent(new window.Event('input'));
  assert.equal(el('new-conversation-cloud-error').hidden, true);
  assert.equal(el('new-conversation-cloud-branch').hasAttribute('aria-invalid'), false);
});

test('a server rejection is shown next to the field it is about', async () => {
  routes['/api/conversation/bootstrap'] = () => ({
    status: 400,
    body: { error: 'The relay only takes repositories it can see.', code: 'claude_cloud_repo_invalid' },
  });
  await journal.confirmNewConversationModel();
  const [request] = requestsTo('/api/conversation/bootstrap');
  assert.deepEqual(request.body, {
    model: 'claude-sonnet-5-5',
    providerType: 'claude-cloud',
    relayMode: 'agent',
    workspaceRootPath: FOLDER,
    cloudSource: { repoUrl: REPO_URL, branch: 'main' },
    title: 'New Conversation',
  });
  assert.equal(modalVisible(), true);
  assert.equal(el('new-conversation-cloud-error').textContent, 'The relay only takes repositories it can see.');
  assert.equal(el('new-conversation-cloud-repo').getAttribute('aria-invalid'), 'true');
  assert.equal(el('new-conversation-model-confirm').disabled, false);
});

test('a started cloud chat opens with its cloud field and leaves the last-used model alone', async () => {
  localStorage.setItem('copilot_selected_model', 'gpt-5.4-mini');
  localStorage.setItem('copilot_selected_reasoning_effort', 'high');
  requests.length = 0;
  routes['/api/conversation/bootstrap'] = () => ({ conversationId: 'conv-new', preferredModel: 'claude-sonnet-5-5', preferredReasoningEffort: 'none' });
  // A shorthand typed on a phone is sent as the https URL; no branch means the default one.
  el('new-conversation-cloud-repo').value = 'example-org/sample-repo';
  el('new-conversation-cloud-branch').value = '';
  await journal.confirmNewConversationModel();
  assert.deepEqual(requestsTo('/api/conversation/bootstrap')[0].body.cloudSource, { repoUrl: REPO_URL });
  assert.equal(modalVisible(), false);
  assert.equal(conversations['conv-new'].runtimeProviderType, 'claude-cloud');
  assert.deepEqual(conversations['conv-new'].cloud, {
    repoUrl: REPO_URL, slug: 'example-org/sample-repo', branch: 'main', sessionUrl: null, pushedBranches: [], costUsd: null,
  });
  assert.equal(localStorage.getItem('copilot_selected_model'), 'gpt-5.4-mini');
  assert.equal(localStorage.getItem('copilot_selected_reasoning_effort'), 'high');
});

test('the next open starts from empty cloud fields, and Copilot keeps its effort row', async () => {
  await journal.newConversation();
  assert.equal(el('new-conversation-provider-select').value, 'github');
  assert.equal(el('new-conversation-cloud-row').hidden, true);
  assert.equal(el('new-conversation-reasoning-row').hidden, false);
  assert.equal(el('new-conversation-cloud-repo').value, '');
  assert.equal(el('new-conversation-cloud-branch').value, '');
  assert.equal(el('new-conversation-cloud-error').hidden, true);
  assert.deepEqual(warningKinds(), []);
  assert.match(el('new-conversation-cwd-status').textContent, /^This chat starts in /);
  journal.closeNewConversationModelModal();
});

// ── Repository and branch suggestions ──

const REPO_LIST = {
  ok: true,
  complete: true,
  source: 'anthropic',
  repos: [
    { slug: 'example-org/sample-repo', owner: 'example-org', name: 'sample-repo', repoUrl: REPO_URL, defaultBranch: 'main', private: true, archived: false, pushedAt: '2031-02-01T10:00:00Z', recentAt: '2031-03-01T10:00:00Z', accessible: true },
    { slug: 'example-org/docs-site', owner: 'example-org', name: 'docs-site', repoUrl: 'https://github.com/example-org/docs-site', defaultBranch: 'trunk', private: false, archived: false, pushedAt: '2031-01-15T09:30:00Z', recentAt: null, accessible: true },
    { slug: 'sample-user/tiny-tool', owner: 'sample-user', name: 'tiny-tool', repoUrl: 'https://github.com/sample-user/tiny-tool', defaultBranch: 'main', private: true, archived: false, pushedAt: '2030-12-20T18:00:00Z', recentAt: null, accessible: true },
  ],
};
const BRANCHES = { 'example-org/docs-site': { defaultBranch: 'trunk', branches: ['trunk', 'dev/edits', 'release'] } };
routes['/api/claude-cloud/repos'] = () => REPO_LIST;
routes['/api/claude-cloud/branches'] = (entry) => {
  const known = BRANCHES[entry.query.repo];
  return known
    ? { ok: true, slug: entry.query.repo, repoUrl: `https://github.com/${entry.query.repo}`, ...known }
    : { ok: false, slug: entry.query.repo, error: { code: 'unreachable', message: 'could not read the branches' } };
};
const suggestionTexts = (field) => [...el(`new-conversation-cloud-${field}-list`).querySelectorAll('.new-conversation-cloud-suggest-item')]
  .map((item) => [item.firstChild.textContent, item.querySelector('.new-conversation-cloud-suggest-meta')?.textContent || '']);
const type = (field, value) => {
  el(`new-conversation-cloud-${field}`).value = value;
  el(`new-conversation-cloud-${field}`).dispatchEvent(new window.Event('input'));
};
const key = (field, name) => el(`new-conversation-cloud-${field}`).dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));

test('the Repository field offers the reachable repositories, filtered by what is typed, and a pick brings the default branch', async () => {
  await journal.newConversation();
  await selectProvider('claude-cloud');
  await flush();
  assert.equal(requestsTo('/api/claude-cloud/repos').length, 1, 'read once per open');

  const repo = el('new-conversation-cloud-repo');
  const list = el('new-conversation-cloud-repo-list');
  assert.equal(list.hidden, true);
  repo.focus();
  repo.dispatchEvent(new window.Event('focus'));
  assert.equal(list.hidden, false);
  assert.equal(repo.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(suggestionTexts('repo'), [
    ['example-org/sample-repo', 'used here · private'],
    ['example-org/docs-site', 'public'],
    ['sample-user/tiny-tool', 'private'],
  ]);

  type('repo', 'doc');
  assert.deepEqual(suggestionTexts('repo').map(([label]) => label), ['example-org/docs-site']);
  key('repo', 'ArrowDown');
  assert.equal(list.children[0].getAttribute('aria-selected'), 'true');
  key('repo', 'Enter');
  assert.equal(repo.value, 'example-org/docs-site');
  assert.equal(list.hidden, true);
  // The repository's default branch is preselected, and the host is asked for the rest.
  assert.equal(el('new-conversation-cloud-branch').value, 'trunk');
  await sleep(20);
  assert.deepEqual(requestsTo('/api/claude-cloud/branches').map((request) => request.query), [{ repo: 'example-org/docs-site' }]);

  const branch = el('new-conversation-cloud-branch');
  const branchList = el('new-conversation-cloud-branch-list');
  branch.focus();
  branch.dispatchEvent(new window.Event('focus'));
  assert.equal(branchList.hidden, false);
  assert.deepEqual(suggestionTexts('branch'), [['trunk', 'default'], ['dev/edits', ''], ['release', '']]);
  type('branch', 'rel');
  assert.deepEqual(suggestionTexts('branch').map(([label]) => label), ['release']);
  branchList.children[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(branch.value, 'release');
  assert.equal(branchList.hidden, true);
  assert.deepEqual(warningKinds(), []);

  // Another repository: the typed branch stays, and the branches of a
  // repository the host cannot read leave the field as a text field.
  repo.focus();
  repo.dispatchEvent(new window.Event('focus'));
  type('repo', 'tiny');
  list.children[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(repo.value, 'sample-user/tiny-tool');
  assert.equal(branch.value, 'release');
  await sleep(20);
  assert.equal(requestsTo('/api/claude-cloud/branches').at(-1).query.repo, 'sample-user/tiny-tool');
  branch.focus();
  branch.dispatchEvent(new window.Event('focus'));
  assert.equal(branchList.hidden, true);
  // Emptied, the field takes the default branch of the picked repository.
  type('branch', '');
  type('repo', 'example-org/docs-site');
  await sleep(400);
  assert.equal(branch.value, 'trunk');
});

test('a repository the Claude GitHub app cannot reach is flagged under the field', async () => {
  type('repo', 'someone/else');
  assert.deepEqual(warningKinds(), ['not-accessible']);
  assert.match(el('new-conversation-cloud-warnings').textContent, /no access to someone\/else/);
  type('repo', 'https://github.com/sample-user/tiny-tool');
  assert.deepEqual(warningKinds(), []);
});

test('Escape closes the list and the fields are reset with the modal', async () => {
  const repo = el('new-conversation-cloud-repo');
  const list = el('new-conversation-cloud-repo-list');
  repo.focus();
  repo.dispatchEvent(new window.Event('focus'));
  type('repo', '');
  assert.equal(list.hidden, false);
  key('repo', 'Escape');
  assert.equal(list.hidden, true);
  assert.equal(repo.getAttribute('aria-expanded'), 'false');
  // The modal stays open: Escape closed only the list.
  assert.equal(modalVisible(), true);
  journal.closeNewConversationModelModal();

  const before = requestsTo('/api/claude-cloud/repos').length;
  await journal.newConversation();
  await selectProvider('claude-cloud');
  await flush();
  assert.equal(requestsTo('/api/claude-cloud/repos').length, before + 1, 'read again for the next open');
  assert.equal(el('new-conversation-cloud-repo').value, '');
  assert.equal(el('new-conversation-cloud-branch').value, '');
  assert.equal(el('new-conversation-cloud-branch-list').hidden, true);
  journal.closeNewConversationModelModal();
});

test('when the list cannot be read, the recent repositories are offered with the reason under them', async () => {
  routes['/api/claude-cloud/repos'] = () => ({
    ok: false,
    complete: false,
    repos: [{ slug: 'example-org/sample-repo', defaultBranch: null, private: null, recentAt: '2031-03-01T10:00:00Z', accessible: null }],
    error: { code: 'login_expired', message: 'The Claude login of this relay host has expired.' },
  });
  try {
    await journal.newConversation();
    await selectProvider('claude-cloud');
    await flush();
    const repo = el('new-conversation-cloud-repo');
    const list = el('new-conversation-cloud-repo-list');
    repo.focus();
    repo.dispatchEvent(new window.Event('focus'));
    assert.equal(list.hidden, false);
    assert.deepEqual(suggestionTexts('repo').map(([label]) => label), ['example-org/sample-repo']);
    assert.equal(list.querySelector('.new-conversation-cloud-suggest-note').textContent, 'The Claude login of this relay host has expired.');
    // The note is not an entry: the arrow keys and Enter skip it.
    key('repo', 'ArrowDown');
    key('repo', 'ArrowDown');
    key('repo', 'Enter');
    assert.equal(repo.value, 'example-org/sample-repo');
    // Nothing is known about access while the list is incomplete.
    type('repo', 'someone/else');
    assert.deepEqual(warningKinds(), []);
    journal.closeNewConversationModelModal();
  } finally {
    routes['/api/claude-cloud/repos'] = () => REPO_LIST;
  }
});
