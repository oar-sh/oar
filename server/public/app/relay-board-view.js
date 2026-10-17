import {
  IS_SHARED_VIEW,
  currentConvId,
  escHtml,
  relayBoards,
  scrollBottom,
} from './store.js';
import {
  boardBodyShownInReply,
  boardOutcomeLine,
  boardRenderKey,
  boardsOfConversation,
} from './relay-board-inline.mjs';
import {
  loadRelayBoards as loadRelayBoardsApi,
  submitRelayBoardAction as submitRelayBoardActionApi,
} from './api-client.js';
import { renderMarkdownPreview } from './router.js';
import { attachCodeCopyButtons } from './code-copy.mjs';
import { beginOwnSend, followsTranscriptEnd, refreshJumpButton, scrollAfterOwnSend } from './transcript-jump-bottom-view.mjs';

// The conversation whose settled boards (acted on, dismissed) are loaded. They
// are asked for per conversation: only the pending ones matter everywhere.
let boardHistoryLoadedFor = '';
let boardHistoryLoading = '';

export function upsertRelayBoard(board) {
  if (!board || !board.id) return;
  relayBoards.set(board.id, board);
  window.renderConvList?.();
  showNewRelayBoards();
}

// A board that arrives is shown to a reader who is at the end. Anyone further
// up stays where they are; the jump-to-bottom button says that it waits.
// "At the end" is read here, once, before the board is on the page: the
// render itself reads no layout, it also runs inside a rebuild of the
// transcript, where a read would clamp the scroll position to the few rows
// that are on the page at that moment.
function showNewRelayBoards() {
  const atEnd = followsTranscriptEnd();
  if (renderRelayBoards() && atEnd) scrollBottom();
}

export async function loadRelayBoards() {
  const pendingRes = await loadRelayBoardsApi('pending');
  if (!pendingRes) return;
  const pending = Array.isArray(pendingRes?.boards) ? pendingRes.boards.filter((board) => board && board.id) : [];
  // The settled boards of the conversation on screen stay: they are part of
  // its transcript, and this list does not carry them.
  for (const [id, board] of relayBoards.entries()) {
    if (board?.status === 'pending' || board?.conversationId !== currentConvId) relayBoards.delete(id);
  }
  for (const board of pending) relayBoards.set(board.id, board);
  window.renderConvList?.();
  showNewRelayBoards();
}

async function loadBoardHistory(conversationId) {
  if (IS_SHARED_VIEW || !conversationId || boardHistoryLoading === conversationId) return;
  boardHistoryLoading = conversationId;
  try {
    const res = await loadRelayBoardsApi('all', conversationId);
    if (!res || currentConvId !== conversationId) return;
    for (const board of Array.isArray(res.boards) ? res.boards : []) {
      if (board && board.id) relayBoards.set(board.id, board);
    }
    boardHistoryLoadedFor = conversationId;
    renderRelayBoards();
  } finally {
    if (boardHistoryLoading === conversationId) boardHistoryLoading = '';
  }
}

/** Where a board is shown: its turn's reply, the live bubble of its turn, or nowhere yet. */
function findBoardHost(el, board) {
  const source = String(board?.messageId || board?.queueId || '').trim();
  if (!source) return null;
  const replies = el.querySelectorAll(`.msg.assistant[data-source-message-id="${CSS.escape(source)}"]`);
  // The turn's own reply is the last row that answers the message; a steer's
  // marker above it is not a reply.
  for (let index = replies.length - 1; index >= 0; index -= 1) {
    const bubble = replies[index].querySelector(':scope > .msg-bubble');
    if (bubble && !replies[index].classList.contains('relay-board-container')) return { bubble, live: false };
  }
  const live = document.getElementById('thinking-indicator');
  if (live && String(live.dataset.messageId || '') === source) {
    const bubble = live.querySelector(':scope > .thinking-bubble');
    if (bubble) return { bubble, live: true };
  }
  return null;
}

function renderedText(html) {
  const probe = document.createElement('div');
  probe.innerHTML = html;
  return probe.textContent || '';
}

/** What the bubble says without the board in it. */
function bubbleTextWithoutBoards(bubble) {
  const copy = bubble.cloneNode(true);
  copy.querySelectorAll('.relay-board-inline').forEach((node) => node.remove());
  return copy.textContent || '';
}

function buildBoardSection(board, { duplicate, standalone = false }) {
  const section = document.createElement('div');
  section.className = `relay-board-inline${standalone ? ' relay-board-card' : ''}`;
  section.dataset.boardId = board.id;
  section.dataset.boardKey = boardRenderKey(board, { duplicate });

  const title = String(board.title || 'Plan ready for review').trim();
  const parts = [];
  if (!duplicate) {
    parts.push(`<div class="relay-board-head">${escHtml(title)}</div>`);
    parts.push(`<div class="relay-board-body">${renderMarkdownPreview(board.body || '', false)}</div>`);
  }
  const actions = Array.isArray(board.actions) ? board.actions : [];
  const outcome = boardOutcomeLine(board);
  if (outcome) {
    parts.push(`<div class="relay-board-outcome">${escHtml(outcome)}</div>`);
  } else if (actions.length && !IS_SHARED_VIEW) {
    const recommendedAction = String(board.recommendedAction || '').trim().toLowerCase();
    parts.push(`<div class="relay-board-actions">${
      actions.map((action) => {
        const actionId = String(action?.id || '').trim().toLowerCase();
        if (!actionId) return '';
        const actionLabel = String(action?.label || actionId).trim();
        const isRecommended = recommendedAction && actionId === recommendedAction;
        return `<button type="button" class="relay-board-action${isRecommended ? ' relay-board-action-recommended' : ''}" data-action-id="${escHtml(actionId)}" onclick="submitRelayBoardAction('${escHtml(board.id)}', this.dataset.actionId)">${escHtml(actionLabel)}</button>`;
      }).join('')
    }</div>`);
  }
  section.innerHTML = parts.join('');
  section.querySelectorAll('pre code').forEach((node) => hljs.highlightElement(node));
  attachCodeCopyButtons(section);
  return section;
}

/** Below what the reply says, above its attachments, tool lines and subagents. */
function placeBoardSection(bubble, section, { live }) {
  const before = live
    ? bubble.querySelector(':scope > .dots, :scope > #thinking-activity, :scope > .subagent-bubbles-container')
    : bubble.querySelector(':scope > .msg-attachments, :scope > .msg-activity, :scope > .msg-workflow-runs, :scope > .msg-preview-cards, :scope > .msg-bubble-actions');
  if (before) bubble.insertBefore(section, before);
  else bubble.appendChild(section);
}

/**
 * Put every board of the conversation on screen where it belongs. Runs after
 * every render of the transcript, which rebuilds the bubbles: a board that is
 * in place and unchanged is left alone, so a selection inside it survives.
 */
export function renderRelayBoards() {
  const el = document.getElementById('messages');
  if (!el) return;
  if (currentConvId && boardHistoryLoadedFor !== currentConvId) void loadBoardHistory(currentConvId).catch(() => {});
  const boards = boardsOfConversation(relayBoards.values(), currentConvId);
  const placed = new Set();
  let added = false;

  for (const board of boards) {
    const host = findBoardHost(el, board);
    const pending = board.status === 'pending';
    let target = host?.bubble || null;
    let standalone = false;
    if (!target) {
      // No bubble to live in (its turn is further up than the page has
      // loaded): a pending board still has to be answerable.
      if (!pending) continue;
      let wrapper = el.querySelector(`.relay-board-container[data-board-id="${CSS.escape(board.id)}"]`);
      if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.className = 'msg relay-board-container';
        wrapper.dataset.boardId = board.id;
        el.appendChild(wrapper);
      }
      target = wrapper;
      standalone = true;
    }
    const duplicate = !standalone && boardBodyShownInReply(
      renderedText(renderMarkdownPreview(board.body || '', false)),
      bubbleTextWithoutBoards(target),
    );
    const key = boardRenderKey(board, { duplicate });
    const existing = target.querySelector(`:scope > .relay-board-inline[data-board-id="${CSS.escape(board.id)}"]`);
    placed.add(existing && existing.dataset.boardKey === key ? existing : null);
    if (existing && existing.dataset.boardKey === key) continue;
    const section = buildBoardSection(board, { duplicate, standalone });
    if (existing) existing.replaceWith(section);
    else if (standalone) target.appendChild(section);
    else placeBoardSection(target, section, { live: host.live });
    placed.add(section);
    added = added || pending;
  }

  // What is on screen and no longer belongs there: a board that moved from
  // the live bubble into the reply, or one of another conversation.
  el.querySelectorAll('.relay-board-inline').forEach((node) => { if (!placed.has(node)) node.remove(); });
  el.querySelectorAll('.relay-board-container').forEach((node) => { if (!node.querySelector('.relay-board-inline')) node.remove(); });
  refreshJumpButton();
  return added;
}

export async function submitRelayBoardAction(boardId, actionId) {
  const id = String(boardId || '').trim();
  const nextActionId = String(actionId || '').trim();
  if (!id || !nextActionId) return;
  const card = document.querySelector(`.relay-board-inline[data-board-id="${CSS.escape(id)}"]`);
  const controls = card ? card.querySelectorAll('button') : [];
  controls.forEach((control) => { control.disabled = true; });
  const send = beginOwnSend();

  try {
    const r = await submitRelayBoardActionApi(id, nextActionId);
    if (!r?.board) throw new Error('Failed to submit board action');
    // Kept once it is settled: the reply goes on showing the plan and says
    // what was chosen.
    relayBoards.set(id, r.board);
    window.renderConvList?.();
    renderRelayBoards();
    scrollAfterOwnSend(send);
  } catch (error) {
    controls.forEach((control) => { control.disabled = false; });
    alert(error.message || 'Failed to submit board action');
  }
}

