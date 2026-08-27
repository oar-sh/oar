import {
  currentConvId,
  escHtml,
  fmtDate,
  relayBoards,
} from './store.js';
import {
  loadRelayBoards as loadRelayBoardsApi,
  submitRelayBoardAction as submitRelayBoardActionApi,
} from './api-client.js';
import { renderMarkdownPreview } from './router.js';
import { attachCodeCopyButtons } from './code-copy.mjs';

let relayBoardRenderHash = '';

export function upsertRelayBoard(board) {
  if (!board || !board.id) return;
  relayBoards.set(board.id, board);
  window.renderConvList?.();
  renderRelayBoards();
}

export async function loadRelayBoards() {
  const pendingRes = await loadRelayBoardsApi('pending');
  if (!pendingRes) return;
  const pending = Array.isArray(pendingRes?.boards) ? pendingRes.boards.filter((board) => board && board.id) : [];
  relayBoards.clear();
  for (const board of pending) relayBoards.set(board.id, board);
  window.renderConvList?.();
  renderRelayBoards();
}

export function renderRelayBoards() {
  const el = document.getElementById('messages');
  if (!el) return;
  const boards = Array.from(relayBoards.values())
    .filter((board) => board && board.conversationId === currentConvId && board.status === 'pending')
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

  const nextHash = JSON.stringify(
    boards.map((board) => ({
      id: board.id,
      status: board.status,
      title: board.title || '',
      body: board.body || '',
      createdAt: board.createdAt || '',
      actions: Array.isArray(board.actions) ? board.actions.map((action) => action?.id || '') : [],
      recommendedAction: board.recommendedAction || '',
    })),
  );
  const existingCards = el.querySelectorAll('.relay-board-container');
  if (relayBoardRenderHash === nextHash && existingCards.length === boards.length) return;
  relayBoardRenderHash = nextHash;

  existingCards.forEach((node) => node.remove());
  if (!boards.length) return;

  for (const board of boards) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg relay-board-container';
    wrapper.dataset.boardId = board.id;

    const modeTag = board.mode ? ` <span class="msg-mode">${escHtml(board.mode)}</span>` : '';
    const boardType = String(board.boardType || 'board').trim().replace(/[_-]+/g, ' ');
    const title = String(board.title || 'Plan ready for review').trim();
    const bodyHtml = renderMarkdownPreview(board.body || '', false);
    const actions = Array.isArray(board.actions) ? board.actions : [];
    const recommendedAction = String(board.recommendedAction || '').trim().toLowerCase();
    const actionHtml = actions.length
      ? `<div class="relay-board-actions">${
          actions.map((action) => {
            const actionId = String(action?.id || '').trim().toLowerCase();
            if (!actionId) return '';
            const actionLabel = String(action?.label || actionId).trim();
            const isRecommended = recommendedAction && actionId === recommendedAction;
            return `<button class="relay-board-action${isRecommended ? ' relay-board-action-recommended' : ''}" data-action-id="${escHtml(actionId)}" onclick="submitRelayBoardAction('${board.id}', this.dataset.actionId)">${escHtml(actionLabel)}</button>`;
          }).join('')
        }</div>`
      : '';

    wrapper.innerHTML = `
      <div class="relay-board-card">
        <div class="relay-board-head">${escHtml(title)}${modeTag} · ${escHtml(boardType)} · ${fmtDate(board.createdAt)}</div>
        <div class="relay-board-body">${bodyHtml}</div>
        ${actionHtml}
      </div>`;
    wrapper.querySelectorAll('pre code').forEach((node) => hljs.highlightElement(node));
    attachCodeCopyButtons(wrapper);
    el.appendChild(wrapper);
  }
  window.scrollBottom?.();
}

export async function submitRelayBoardAction(boardId, actionId) {
  const id = String(boardId || '').trim();
  const nextActionId = String(actionId || '').trim();
  if (!id || !nextActionId) return;
  const card = document.querySelector(`.relay-board-container[data-board-id="${id}"]`);
  const controls = card ? card.querySelectorAll('button') : [];
  controls.forEach((control) => { control.disabled = true; });

  try {
    const r = await submitRelayBoardActionApi(id, nextActionId);
    if (!r?.board) throw new Error('Failed to submit board action');
    relayBoards.set(id, r.board);
    if (String(r.board.status || '').toLowerCase() !== 'pending') {
      relayBoards.delete(id);
    }
    window.renderConvList?.();
    renderRelayBoards();
    window.showTransientRelayNotice?.(`✅ Action selected: ${nextActionId}`);
  } catch (error) {
    controls.forEach((control) => { control.disabled = false; });
    alert(error.message || 'Failed to submit board action');
  }
}

