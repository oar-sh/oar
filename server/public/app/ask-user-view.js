import {
  conversations,
  currentConvId,
  fmtDate,
  escHtml,
  relayQuestions,
  relayQuestionDrafts,
} from './store.js';
import { loadRelayQuestions as loadRelayQuestionsApi, answerRelayQuestion, answerRelayQuestionStructured } from './api-client.js';
import { renderLinkedPlainText } from './router.js';
import { schemaFieldsFromQuestion } from './question-schema-view.mjs';

let relayQuestionRenderHash = '';
let renderedRelayQuestionIds = new Set();
const relayQuestionStructuredDrafts = new Map();
const RELAY_QUESTION_AUTO_SCROLL_THRESHOLD_PX = 80;

function distanceFromBottom(el) {
  if (!el) return Number.POSITIVE_INFINITY;
  return Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
}

function captureFocusedQuestionControl(messagesEl) {
  const active = document.activeElement;
  if (!active || typeof active.closest !== 'function') return null;
  if (!messagesEl?.contains(active)) return null;
  const questionNode = active.closest('.relay-question-container');
  if (!questionNode) return null;
  const questionId = String(questionNode.dataset.questionId || '').trim();
  if (!questionId) return null;
  return {
    questionId,
    controlId: String(active.id || '').trim(),
    controlName: String(active.getAttribute?.('name') || '').trim(),
    controlKey: String(active.dataset?.relayFocusKey || '').trim(),
    tagName: String(active.tagName || '').toLowerCase(),
    type: String(active.type || '').toLowerCase(),
    selectionStart: Number.isInteger(active.selectionStart) ? active.selectionStart : null,
    selectionEnd: Number.isInteger(active.selectionEnd) ? active.selectionEnd : null,
  };
}

function restoreFocusedQuestionControl(messagesEl, snapshot) {
  if (!messagesEl || !snapshot?.questionId) return;
  const questionNode = messagesEl.querySelector(`.relay-question-container[data-question-id="${CSS.escape(snapshot.questionId)}"]`);
  if (!questionNode) return;
  let target = null;
  if (snapshot.controlId) {
    target = questionNode.querySelector(`#${CSS.escape(snapshot.controlId)}`);
  }
  if (!target && snapshot.controlName) {
    target = questionNode.querySelector(`[name="${CSS.escape(snapshot.controlName)}"]`);
  }
  if (!target && snapshot.controlKey) {
    target = questionNode.querySelector(`[data-relay-focus-key="${CSS.escape(snapshot.controlKey)}"]`);
  }
  if (!target) return;
  if (typeof target.focus === 'function') {
    target.focus({ preventScroll: true });
  }
  const isTextControl = target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && ['text', 'email', 'url', 'search', 'tel'].includes(String(target.type || '').toLowerCase()));
  if (!isTextControl) return;
  const hasSelection = Number.isInteger(snapshot.selectionStart) && Number.isInteger(snapshot.selectionEnd);
  if (!hasSelection || typeof target.setSelectionRange !== 'function') return;
  const max = String(target.value || '').length;
  const start = Math.max(0, Math.min(snapshot.selectionStart, max));
  const end = Math.max(0, Math.min(snapshot.selectionEnd, max));
  target.setSelectionRange(start, end);
}

export function upsertRelayQuestion(question) {
  if (!question || !question.id) return;
  relayQuestions.set(question.id, question);
  updatePendingQuestionBanner();
  window.renderConvList?.();
  renderRelayQuestions();
}

export async function loadRelayQuestions(conversationId) {
  const pendingRes = await loadRelayQuestionsApi('pending');
  if (!pendingRes) return;
  const pending = Array.isArray(pendingRes?.questions) ? pendingRes.questions.filter((q) => q && q.id) : [];
  const next = new Map(pending.map((q) => [q.id, q]));
  for (const [id, q] of relayQuestions.entries()) {
    if (q.status === 'answered' && !next.has(id)) next.set(id, q);
  }
  for (const questionId of relayQuestionDrafts.keys()) {
    const question = next.get(questionId);
    if (!question || question.status !== 'pending') {
      relayQuestionDrafts.delete(questionId);
    }
  }
  for (const questionId of relayQuestionStructuredDrafts.keys()) {
    const question = next.get(questionId);
    if (!question || question.status !== 'pending') {
      relayQuestionStructuredDrafts.delete(questionId);
    }
  }
  relayQuestions.clear();
  for (const [id, q] of next.entries()) relayQuestions.set(id, q);
  updatePendingQuestionBanner();
  window.renderConvList?.();

  if (!conversationId && pending.length) {
    const latest = pending
      .slice()
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
    const targetConversationId = String(latest?.conversationId || '').trim();
    if (targetConversationId && targetConversationId !== currentConvId && conversations[targetConversationId]) {
      await window.openConversation?.(targetConversationId);
      return;
    }
  }

  renderRelayQuestions();
}

export function getPendingRelayQuestions() {
  return Array.from(relayQuestions.values())
    .filter((q) => q && q.id && q.status === 'pending')
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

export function getPendingQuestionCountsByConversation() {
  const counts = Object.create(null);
  for (const question of getPendingRelayQuestions()) {
    const conversationId = String(question?.conversationId || '').trim();
    if (!conversationId) continue;
    counts[conversationId] = (counts[conversationId] || 0) + 1;
  }
  return counts;
}

export function updatePendingQuestionBanner() {
  const banner = document.getElementById('pending-question-banner');
  if (!banner) return;
  const pending = getPendingRelayQuestions();
  if (!pending.length) {
    banner.textContent = '';
    banner.classList.remove('visible');
    banner.disabled = true;
    return;
  }

  const latest = pending[pending.length - 1];
  const targetConversationId = String(latest?.conversationId || '').trim();
  banner.dataset.targetConversationId = targetConversationId;
  banner.dataset.targetQuestionId = String(latest?.id || '').trim();
  const count = pending.length;
  const currentCount = currentConvId ? pending.filter((q) => q?.conversationId === currentConvId).length : 0;
  const convTitle = escHtml(conversations[targetConversationId]?.title || targetConversationId || 'conversation');
  banner.innerHTML = currentCount > 0
    ? `❓ ${count} open question${count === 1 ? '' : 's'}`
    : `❓ ${count} open question${count === 1 ? '' : 's'} · latest in ${convTitle}`;
  banner.classList.add('visible');
  banner.disabled = false;
}

export async function openPendingQuestionFromBanner() {
  const banner = document.getElementById('pending-question-banner');
  if (!banner) return;
  const targetConversationId = String(banner.dataset.targetConversationId || '').trim();
  const pending = getPendingRelayQuestions();
  const fallbackConversationId = String(pending[pending.length - 1]?.conversationId || '').trim();
  const nextConversationId = targetConversationId || fallbackConversationId;
  if (!nextConversationId) return;
  if (nextConversationId !== currentConvId) {
    if (!conversations[nextConversationId]) {
      await window.refreshConversations?.();
    }
    await window.openConversation?.(nextConversationId);
    if (String(currentConvId || '').trim() !== nextConversationId) {
      window.showTransientRelayNotice?.('Could not open the latest question conversation yet. Try again in a moment.');
    }
    return;
  }
  renderRelayQuestions();
  window.scrollBottom?.();
}

export function renderRelayQuestions() {
  const el = document.getElementById('messages');
  if (!el) return;
  const previousScrollTop = el.scrollTop;
  const shouldAutoScroll = distanceFromBottom(el) <= RELAY_QUESTION_AUTO_SCROLL_THRESHOLD_PX;
  const focusedControl = captureFocusedQuestionControl(el);
  const questions = Array.from(relayQuestions.values())
    .filter((q) => q && q.conversationId === currentConvId && q.status === 'pending')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const firstNewQuestionId = questions.find((question) => !renderedRelayQuestionIds.has(question.id))?.id || '';
  const nextRenderedQuestionIds = new Set(questions.map((question) => question.id));

  const nextHash = JSON.stringify(
    questions.map((q) => ({
      id: q.id,
      status: q.status,
      prompt: q.prompt || '',
      answer: q.answer || '',
      answeredAt: q.answeredAt || '',
      createdAt: q.createdAt || '',
      choices: Array.isArray(q.choices) ? q.choices : [],
      schema: q.requestSchema || null,
    }))
  );
  const existingCards = el.querySelectorAll('.relay-question-container');
  if (relayQuestionRenderHash === nextHash && existingCards.length === questions.length) return;
  relayQuestionRenderHash = nextHash;

  for (const node of existingCards) {
    const questionId = String(node?.dataset?.questionId || '').trim();
    const question = relayQuestions.get(questionId);
    const fields = schemaFieldsFromQuestion(question);
    if (!questionId || !fields.length) continue;
    relayQuestionStructuredDrafts.set(questionId, collectStructuredAnswer(question));
  }
  existingCards.forEach((node) => node.remove());
  if (!questions.length) {
    renderedRelayQuestionIds = nextRenderedQuestionIds;
    if (!shouldAutoScroll) el.scrollTop = previousScrollTop;
    return;
  }

  for (const question of questions) {
    const wrapper = document.createElement('div');
    wrapper.className = 'msg relay-question-container';
    wrapper.dataset.questionId = question.id;

    const modeTag = question.mode ? ` <span class="msg-mode">${escHtml(question.mode)}</span>` : '';
    const contextText = String(question?.context?.rationale || '').trim();
    const contextHtml = contextText ? `<div class="relay-question-context">${renderLinkedPlainText(contextText)}</div>` : '';
    const fields = schemaFieldsFromQuestion(question);
    const structuredQuestion = fields.length > 0;

    let interactiveHtml = '';
    if (structuredQuestion) {
      interactiveHtml = renderMultiFieldForm(question);
    } else {
      const choices = Array.isArray(question.choices) ? question.choices : [];
      const choiceHtml = choices.length
        ? (question.status === 'pending'
            ? `<div class="relay-question-choices">${
                choices.map((choice) => `<button class="relay-question-choice" data-choice="${escHtml(choice)}" data-relay-focus-key="choice-${escHtml(choice)}" onclick="submitRelayQuestionChoice('${question.id}', this.dataset.choice)">${escHtml(choice)}</button>`).join('')
              }</div>`
            : `<div class="relay-question-choices">${
                choices.map((choice) => `<button class="relay-question-choice" disabled>${escHtml(choice)}</button>`).join('')
              }</div>`)
        : '';
      const showReplyControls = question.status === 'pending';
      const draftText = String(relayQuestionDrafts.get(question.id) || '');
      const replyHtml = showReplyControls
        ? `<div class="relay-question-reply">
            <textarea id="relay-question-input-${question.id}" placeholder="Type a reply… (Ctrl/Cmd+Enter to send)" onkeydown="handleRelayQuestionKey(event, '${question.id}')" oninput="onRelayQuestionDraftInput('${question.id}', this.value)">${escHtml(draftText)}</textarea>
            <button class="relay-question-submit" onclick="submitRelayQuestionAnswer('${question.id}')">Reply</button>
          </div>`
        : '';
      interactiveHtml = `${choiceHtml}${replyHtml}`;
    }

    const answeredHtml = question.status === 'answered' && question.answer
      ? `<div class="relay-question-context"><strong>Your answer:</strong> ${escHtml(question.answer)}</div>`
      : '';
    const statusText = question.status === 'answered'
      ? `Answered${question.answeredAt ? ` · ${fmtDate(question.answeredAt)}` : ''}`
      : `${question.expiresAt ? `Expires ${fmtDate(question.expiresAt)} · ` : ''}Waiting for your answer`;

    wrapper.innerHTML = `
      <div class="relay-question-card${question.status === 'timed_out' ? ' relay-question-timed-out' : ''}">
        <div class="relay-question-head">Copilot question${modeTag} · ${fmtDate(question.createdAt)}</div>
        <div class="relay-question-body">${renderLinkedPlainText(question.prompt || '')}</div>
        ${contextHtml}
        ${answeredHtml}
        ${interactiveHtml}
        <div class="relay-question-status">${statusText}</div>
      </div>`;

    el.appendChild(wrapper);
  }

  renderedRelayQuestionIds = nextRenderedQuestionIds;
  restoreFocusedQuestionControl(el, focusedControl);
  if (firstNewQuestionId) {
    const target = el.querySelector(`.relay-question-container[data-question-id="${CSS.escape(firstNewQuestionId)}"]`);
    target?.scrollIntoView({ block: 'start', inline: 'nearest' });
  } else if (shouldAutoScroll) {
    window.scrollBottom?.();
  } else {
    el.scrollTop = previousScrollTop;
  }
}

function fieldDomId(questionId, index) {
  return `relay-field-${questionId}-${index}`;
}

function renderMultiFieldForm(question) {
  const fields = schemaFieldsFromQuestion(question);
  if (!fields.length) return '';
  const disabled = question.status !== 'pending';
  const draft = relayQuestionStructuredDrafts.get(question.id);
  const submitted = question.structuredAnswer && typeof question.structuredAnswer === 'object'
    ? question.structuredAnswer
    : {};
  const hasSubmitted = Object.keys(submitted).length > 0;
  const sourceValues = hasSubmitted && question.status !== 'pending'
    ? submitted
    : (draft && typeof draft === 'object' ? draft : submitted);

  const fieldHtml = fields.map((field, index) => {
    const id = fieldDomId(question.id, index);
    const current = Object.prototype.hasOwnProperty.call(sourceValues, field.name)
      ? sourceValues[field.name]
      : (field.hasDefault ? field.default : undefined);
    const requiredMark = field.required ? ' <span class="relay-field-required">*</span>' : '';
    const descHtml = field.description
      ? `<div class="relay-field-desc">${escHtml(field.description)}</div>`
      : '';
    const control = renderFieldControl(field, id, current, disabled);
    return `<div class="relay-field" data-field-name="${escHtml(field.name)}" data-field-type="${escHtml(field.type)}" data-field-id="${id}">
        <label class="relay-field-label" for="${id}">${escHtml(field.title)}${requiredMark}</label>
        ${descHtml}
        ${control}
      </div>`;
  }).join('');

  const submitHtml = disabled
    ? ''
    : `<div class="relay-question-reply">
        <div class="relay-field-error" id="relay-form-error-${question.id}"></div>
        <button class="relay-question-submit" onclick="submitRelayStructuredAnswer('${question.id}')">Submit</button>
      </div>`;

  return `<form class="relay-question-form" data-question-id="${question.id}" onsubmit="return false;">${fieldHtml}${submitHtml}</form>`;
}

function renderFieldControl(field, id, current, disabled) {
  const dis = disabled ? ' disabled' : '';
  if (field.type === 'boolean') {
    const checked = current === true || String(current).toLowerCase() === 'true' ? ' checked' : '';
    return `<label class="relay-field-check"><input type="checkbox" id="${id}"${checked}${dis}> Yes</label>`;
  }
  if (field.isMultiSelect && field.choices.length) {
    const selected = Array.isArray(current) ? current.map(String) : [];
    return `<div class="relay-field-multi" id="${id}">${
      field.choices.map((choice, ci) => {
        const checked = selected.includes(String(choice.value)) ? ' checked' : '';
        const focusKey = `multi-${field.name}-${choice.value}`;
        return `<label class="relay-field-check"><input type="checkbox" data-choice-value="${escHtml(String(choice.value))}" data-relay-focus-key="${escHtml(focusKey)}" value="${escHtml(String(choice.value))}"${checked}${dis}> ${escHtml(choice.label)}</label>`;
      }).join('')
    }</div>`;
  }
  if (field.choices.length) {
    const currentStr = current === undefined || current === null ? '' : String(current);
    const options = [`<option value=""${currentStr === '' ? ' selected' : ''}>${field.required ? 'Select…' : '(none)'}</option>`]
      .concat(field.choices.map((choice) => {
        const value = String(choice.value);
        const sel = value === currentStr ? ' selected' : '';
        return `<option value="${escHtml(value)}"${sel}>${escHtml(choice.label)}</option>`;
      }));
    return `<select id="${id}"${dis}>${options.join('')}</select>`;
  }
  if (field.type === 'number' || field.type === 'integer') {
    const val = current === undefined || current === null ? '' : escHtml(String(current));
    const step = field.type === 'integer' ? ' step="1"' : '';
    return `<input type="number" id="${id}" value="${val}"${step}${dis}>`;
  }
  const val = current === undefined || current === null ? '' : escHtml(String(current));
  const inputType = field.format === 'email' ? 'email' : (field.format === 'uri' || field.format === 'url' ? 'url' : 'text');
  return `<input type="${inputType}" id="${id}" value="${val}"${dis}>`;
}

function collectStructuredAnswer(question) {
  const fields = schemaFieldsFromQuestion(question);
  const answer = {};
  fields.forEach((field, index) => {
    const id = fieldDomId(question.id, index);
    if (field.type === 'boolean') {
      const el = document.getElementById(id);
      if (el) answer[field.name] = !!el.checked;
      return;
    }
    if (field.isMultiSelect && field.choices.length) {
      const container = document.getElementById(id);
      const checked = container ? Array.from(container.querySelectorAll('input[type="checkbox"]:checked')) : [];
      const values = checked.map((el) => el.getAttribute('data-choice-value'));
      if (values.length) answer[field.name] = values;
      return;
    }
    const el = document.getElementById(id);
    if (!el) return;
    const raw = String(el.value || '').trim();
    if (!raw) return;
    if (field.type === 'number' || field.type === 'integer') {
      const num = Number(raw);
      if (Number.isFinite(num)) answer[field.name] = field.type === 'integer' ? Math.trunc(num) : num;
      return;
    }
    answer[field.name] = raw;
  });
  return answer;
}

function resolveSingleFieldStructuredAnswer(question, answerText) {
  const fields = schemaFieldsFromQuestion(question);
  if (fields.length !== 1) return null;
  const field = fields[0];
  const raw = String(answerText || '').trim();
  if (!raw) return null;
  if (!field.choices.length) {
    return { [field.name]: raw };
  }

  const exact = field.choices.find((choice) => String(choice.value) === raw || String(choice.label) === raw);
  if (exact) return { [field.name]: String(exact.value) };

  const lowered = raw.toLowerCase();
  const insensitive = field.choices.find((choice) => (
    String(choice.value).toLowerCase() === lowered
    || String(choice.label).toLowerCase() === lowered
  ));
  if (insensitive) return { [field.name]: String(insensitive.value) };

  return { [field.name]: raw };
}

export async function submitRelayStructuredAnswer(questionId) {
  const question = relayQuestions.get(questionId) || null;
  if (!question) return;
  const errorEl = document.getElementById(`relay-form-error-${questionId}`);
  if (errorEl) errorEl.textContent = '';

  const structuredAnswer = collectStructuredAnswer(question);
  const card = document.querySelector(`.relay-question-container[data-question-id="${questionId}"]`);
  const controls = card ? card.querySelectorAll('button, input, select, textarea') : [];
  controls.forEach((el) => { el.disabled = true; });

  try {
    const sdkSessionId = String(question?.sdkSessionId || '').trim();
    const r = await answerRelayQuestionStructured(questionId, structuredAnswer, sdkSessionId || null);
    if (!r?.ok) {
      controls.forEach((el) => { el.disabled = false; });
      const fieldErrors = Array.isArray(r?.fields) ? r.fields.map((f) => f.message).join('; ') : '';
      const message = fieldErrors || r?.error || 'Failed to submit answer';
      if (errorEl) errorEl.textContent = message;
      else alert(message);
      return;
    }
    relayQuestionDrafts.delete(questionId);
    relayQuestionStructuredDrafts.delete(questionId);
    if (r.question) relayQuestions.set(questionId, r.question);
    updatePendingQuestionBanner();
    window.renderConvList?.();
    renderRelayQuestions();
    window.showTransientRelayNotice?.(`✅ Answer received · Agent continuing…`, 7000);
  } catch (e) {
    controls.forEach((el) => { el.disabled = false; });
    if (errorEl) errorEl.textContent = e.message || 'Failed to submit answer';
    else alert(e.message || 'Failed to submit answer');
  }
}

export async function submitRelayQuestionChoice(questionId, choice) {
  await submitRelayQuestionAnswer(questionId, choice);
}

export async function submitRelayQuestionAnswer(questionId, presetAnswer = null) {
  const input = document.getElementById(`relay-question-input-${questionId}`);
  const answer = String(presetAnswer != null ? presetAnswer : (input?.value || '')).trim();
  if (!answer) return;

  const card = document.querySelector(`.relay-question-container[data-question-id="${questionId}"]`);
  const controls = card ? card.querySelectorAll('button, textarea') : [];
  controls.forEach((el) => { el.disabled = true; });

  try {
    const question = relayQuestions.get(questionId) || null;
    const sdkSessionId = String(question?.sdkSessionId || '').trim();
    const singleFieldStructuredAnswer = resolveSingleFieldStructuredAnswer(question, answer);
    const r = singleFieldStructuredAnswer
      ? await answerRelayQuestionStructured(questionId, singleFieldStructuredAnswer, sdkSessionId || null)
      : await answerRelayQuestion(questionId, answer, sdkSessionId || null);
    if (!r?.question) throw new Error('Failed to submit relay question answer');
    relayQuestionDrafts.delete(questionId);
    relayQuestionStructuredDrafts.delete(questionId);
    relayQuestions.set(questionId, r.question);
    updatePendingQuestionBanner();
    window.renderConvList?.();
    renderRelayQuestions();
    window.showTransientRelayNotice?.(`✅ Answer received: ${answer} · Agent continuing…`, 7000);
  } catch (e) {
    controls.forEach((el) => { el.disabled = false; });
    alert(e.message || 'Failed to submit relay question answer');
  }
}

export function onRelayQuestionDraftInput(questionId, value) {
  relayQuestionDrafts.set(String(questionId || ''), String(value || ''));
}

export function handleRelayQuestionKey(e, questionId) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    submitRelayQuestionAnswer(questionId);
  }
}
