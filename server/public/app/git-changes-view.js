import { escHtml, currentConvId } from './store.js';
import { loadGitStatus, loadGitDiff, requestGitPull } from './api-client.js';
import {
  parseUnifiedDiff,
  collapseContextLines,
  describeGitFileStatus,
  summarizeGitStatusHeader,
} from './git-diff-model.mjs';

const CHANGES_MODE_CONTEXT_LINES = 3;

const gitState = {
  loading: false,
  error: '',
  status: null,
  notice: '',
  pulling: false,
  requestSeq: 0,
  diff: {
    path: '',
    status: '',
    untracked: false,
    loading: false,
    error: '',
    parsed: null,
    mode: 'changes',
    requestSeq: 0,
  },
};

function getGitElements() {
  return {
    modal: document.getElementById('git-changes-modal'),
    branch: document.getElementById('git-changes-branch'),
    meta: document.getElementById('git-changes-meta'),
    notice: document.getElementById('git-changes-notice'),
    list: document.getElementById('git-changes-list'),
    pullBtn: document.getElementById('git-changes-pull'),
    refreshBtn: document.getElementById('git-changes-refresh'),
    closeBtn: document.getElementById('git-changes-close'),
    diffModal: document.getElementById('git-diff-modal'),
    diffTitle: document.getElementById('git-diff-title'),
    diffMeta: document.getElementById('git-diff-meta'),
    diffBody: document.getElementById('git-diff-body'),
    diffModeFull: document.getElementById('git-diff-mode-full'),
    diffModeChanges: document.getElementById('git-diff-mode-changes'),
    diffCloseBtn: document.getElementById('git-diff-close'),
  };
}

function renderGitChanges() {
  const { branch, meta, notice, list, pullBtn } = getGitElements();
  if (!list) return;

  const status = gitState.status;
  if (branch) {
    if (gitState.loading && !status) {
      branch.textContent = 'Loading…';
    } else if (status && status.isRepo === false) {
      branch.textContent = 'Not a git repository';
    } else {
      branch.textContent = summarizeGitStatusHeader(status) || '(no branch)';
    }
  }
  if (meta) {
    const bits = [];
    const upstream = String(status?.upstream || '').trim();
    if (upstream) bits.push(upstream);
    if (status?.isRepo !== false) {
      const count = Array.isArray(status?.files) ? status.files.length : 0;
      bits.push(`${count} changed file${count === 1 ? '' : 's'}`);
    }
    meta.textContent = bits.join(' · ');
  }
  if (notice) {
    notice.textContent = gitState.error || gitState.notice || '';
    notice.classList.toggle('error', !!gitState.error);
    notice.hidden = !gitState.error && !gitState.notice;
  }
  if (pullBtn) {
    pullBtn.disabled = gitState.pulling || gitState.loading || !status || status.isRepo === false;
    pullBtn.textContent = gitState.pulling ? 'Pulling…' : '⬇ Pull';
  }

  if (gitState.loading && !status) {
    list.innerHTML = '<div class="git-changes-empty">Loading changes…</div>';
    return;
  }
  if (status && status.isRepo === false) {
    list.innerHTML = '<div class="git-changes-empty">The current workspace root is not a git repository.</div>';
    return;
  }
  const files = Array.isArray(status?.files) ? status.files : [];
  if (!files.length) {
    list.innerHTML = `<div class="git-changes-empty">${escHtml(gitState.error || 'Working tree clean — no changes.')}</div>`;
    return;
  }
  list.innerHTML = files.map((file) => {
    const statusCode = String(file.status || '').toUpperCase();
    const label = describeGitFileStatus(statusCode);
    const fullPath = String(file.path || '');
    const slashIndex = fullPath.lastIndexOf('/');
    const fileName = slashIndex === -1 ? fullPath : fullPath.slice(slashIndex + 1);
    const dirName = slashIndex === -1 ? '' : fullPath.slice(0, slashIndex);
    const nameClass = file.deleted ? 'git-changes-file-name deleted' : 'git-changes-file-name';
    const dirRow = dirName ? `<span class="git-changes-file-dir">${escHtml(dirName)}</span>` : '';
    const renameNote = file.renamed && file.origPath
      ? `<span class="git-changes-file-orig">← ${escHtml(file.origPath)}</span>`
      : '';
    return `
      <button type="button" class="git-changes-file" data-git-diff-path="${escHtml(fullPath)}" data-git-status="${escHtml(statusCode)}" data-git-untracked="${file.untracked ? '1' : '0'}" title="${escHtml(`${label} · ${fullPath}`)}">
        <span class="git-changes-file-status status-${escHtml(statusCode)}">${escHtml(statusCode)}</span>
        <span class="git-changes-file-text">
          <span class="${nameClass}">${escHtml(fileName)}</span>
          ${dirRow}
          ${renameNote}
        </span>
      </button>
    `;
  }).join('');
}

async function refreshGitChanges() {
  gitState.loading = true;
  gitState.error = '';
  renderGitChanges();
  const reqId = ++gitState.requestSeq;
  const payload = await loadGitStatus(currentConvId);
  if (reqId !== gitState.requestSeq) return;
  gitState.loading = false;
  if (!payload || payload.ok === false) {
    gitState.error = payload?.error || 'Failed to load git status.';
  } else {
    gitState.status = payload;
    gitState.error = '';
  }
  renderGitChanges();
}

async function runGitPull() {
  if (gitState.pulling) return;
  gitState.pulling = true;
  gitState.notice = '';
  gitState.error = '';
  renderGitChanges();
  const result = await requestGitPull(currentConvId);
  gitState.pulling = false;
  if (result?.ok) {
    const output = String(result.output || '').trim();
    const lastLine = output.split('\n').filter(Boolean).pop() || 'Pull complete.';
    gitState.notice = `Pull: ${lastLine}`;
  } else {
    gitState.error = `Pull failed: ${result?.error || 'unknown error'}`;
  }
  renderGitChanges();
  await refreshGitChanges();
}

export function openGitChangesModal() {
  const { modal } = getGitElements();
  if (!modal) return;
  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');
  gitState.notice = '';
  renderGitChanges();
  void refreshGitChanges();
}

export function closeGitChangesModal() {
  const { modal } = getGitElements();
  if (!modal) return;
  modal.classList.remove('visible');
  modal.setAttribute('aria-hidden', 'true');
}

function diffLineRowHtml(line) {
  if (line.type === 'gap') {
    return `<div class="git-diff-line gap"><span class="git-diff-gutter"></span><span class="git-diff-gutter"></span><span class="git-diff-text">⋯ ${line.count} unchanged line${line.count === 1 ? '' : 's'}</span></div>`;
  }
  const oldNo = line.oldLine == null ? '' : String(line.oldLine);
  const newNo = line.newLine == null ? '' : String(line.newLine);
  const marker = line.type === 'add' ? '+' : (line.type === 'del' ? '-' : ' ');
  return `<div class="git-diff-line ${line.type}"><span class="git-diff-gutter">${oldNo}</span><span class="git-diff-gutter">${newNo}</span><span class="git-diff-text">${escHtml(`${marker} ${line.text}`)}</span></div>`;
}

function renderGitDiff() {
  const { diffTitle, diffMeta, diffBody, diffModeFull, diffModeChanges } = getGitElements();
  if (!diffBody) return;
  const diff = gitState.diff;
  if (diffTitle) diffTitle.textContent = diff.path || 'Diff';
  if (diffModeFull) diffModeFull.classList.toggle('active', diff.mode === 'full');
  if (diffModeChanges) diffModeChanges.classList.toggle('active', diff.mode === 'changes');

  if (diffMeta) {
    const bits = [describeGitFileStatus(diff.status)];
    if (diff.parsed && !diff.parsed.isBinary) {
      bits.push(`+${diff.parsed.additions}`, `−${diff.parsed.deletions}`);
    }
    diffMeta.textContent = bits.join(' · ');
  }

  if (diff.loading) {
    diffBody.innerHTML = '<div class="git-changes-empty">Loading diff…</div>';
    return;
  }
  if (diff.error) {
    diffBody.innerHTML = `<div class="git-changes-empty">${escHtml(diff.error)}</div>`;
    return;
  }
  const parsed = diff.parsed;
  if (!parsed) {
    diffBody.innerHTML = '';
    return;
  }
  if (parsed.isBinary) {
    diffBody.innerHTML = '<div class="git-changes-empty">Binary file — no text diff available.</div>';
    return;
  }
  if (parsed.isEmpty) {
    diffBody.innerHTML = '<div class="git-changes-empty">No textual changes detected for this file.</div>';
    return;
  }
  const lines = diff.mode === 'changes'
    ? collapseContextLines(parsed.lines, CHANGES_MODE_CONTEXT_LINES)
    : parsed.lines;
  diffBody.innerHTML = `<div class="git-diff-lines">${lines.map(diffLineRowHtml).join('')}</div>`;
}

export async function openGitDiffViewer(path, { status = '', untracked = false } = {}) {
  const { diffModal } = getGitElements();
  if (!diffModal) return;
  const diff = gitState.diff;
  diff.path = String(path || '');
  diff.status = String(status || '');
  diff.untracked = !!untracked;
  diff.loading = true;
  diff.error = '';
  diff.parsed = null;
  diffModal.classList.add('visible');
  diffModal.setAttribute('aria-hidden', 'false');
  renderGitDiff();

  const reqId = ++diff.requestSeq;
  const payload = await loadGitDiff(diff.path, { conversationId: currentConvId, untracked: diff.untracked });
  if (reqId !== diff.requestSeq) return;
  diff.loading = false;
  if (!payload || payload.ok === false) {
    diff.error = payload?.error || 'Failed to load diff.';
  } else {
    diff.parsed = parseUnifiedDiff(payload.patch);
  }
  renderGitDiff();
}

export function closeGitDiffViewer() {
  const { diffModal } = getGitElements();
  if (!diffModal) return;
  diffModal.classList.remove('visible');
  diffModal.setAttribute('aria-hidden', 'true');
  gitState.diff.requestSeq += 1;
}

export function setGitDiffMode(mode) {
  gitState.diff.mode = mode === 'full' ? 'full' : 'changes';
  renderGitDiff();
}

function bindGitChangesEvents() {
  const {
    modal, list, pullBtn, refreshBtn, closeBtn,
    diffModal, diffModeFull, diffModeChanges, diffCloseBtn,
  } = getGitElements();
  if (!modal || !diffModal) return;
  if (modal.dataset.bound === '1') return;
  modal.dataset.bound = '1';

  closeBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    closeGitChangesModal();
  });
  refreshBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    void refreshGitChanges();
  });
  pullBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    void runGitPull();
  });
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeGitChangesModal();
  });
  list?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-git-diff-path]') : null;
    if (!target) return;
    const path = String(target.getAttribute('data-git-diff-path') || '').trim();
    if (!path) return;
    void openGitDiffViewer(path, {
      status: String(target.getAttribute('data-git-status') || ''),
      untracked: target.getAttribute('data-git-untracked') === '1',
    });
  });

  diffCloseBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    closeGitDiffViewer();
  });
  diffModal.addEventListener('click', (event) => {
    if (event.target === diffModal) closeGitDiffViewer();
  });
  diffModeFull?.addEventListener('click', (event) => {
    event.preventDefault();
    setGitDiffMode('full');
  });
  diffModeChanges?.addEventListener('click', (event) => {
    event.preventDefault();
    setGitDiffMode('changes');
  });

  // Capture-phase so the diff viewer wins over the shared Escape chain in
  // attachments-view.js; closing the diff keeps the changes modal open.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (diffModal.classList.contains('visible')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeGitDiffViewer();
      return;
    }
    if (modal.classList.contains('visible')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeGitChangesModal();
    }
  }, true);
}

export function initGitChangesView() {
  bindGitChangesEvents();
}
