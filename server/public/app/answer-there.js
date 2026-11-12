// `?answer=<id>&option=<n>`: one question of this relay, opened from a paired
// relay's Inbox in a popup (agent auth §13.2, 1a). The link answers nothing.
// This page shows the question in full, with this relay's own card text (a
// Safety check's path and diff included), its options as radios with option
// n picked, and Confirm and Cancel. Confirm posts the option text of this
// relay's copy of the question, never anything the other relay sent, and
// only after the view has been on screen and focused for 800 ms and the
// person moved the pointer or pressed a key in this window: a double-click
// on the other relay's page cannot land on Confirm.
//
// Signed out, the sign-in box comes first and the parameters wait in the
// address; once used they are taken out. A browser with this relay's cookie
// but not its session key is signed out too (the relay refuses the cookie
// alone with 403 AUTH_SESSION_PROOF): the view steps aside with the
// parameters kept, the sign-in box says "Sign in to <relay> to answer", and
// the view opens again after the sign-in. There is no return address: after
// the answer the window closes itself, or says it may be closed.

import { ANSWER_THERE_QID_PATTERN } from './remote-relay-links.mjs';

export const ANSWER_THERE_CONFIRM_DELAY_MS = 800;
const PARAMS = ['answer', 'option'];
const VIEW_ID = 'answer-there-view';
const GATE_TICK_MS = 100;

function toText(value) {
  return String(value ?? '').trim();
}

/**
 * A refusal that means this browser is not signed in here: 401, or 403
 * AUTH_SESSION_PROOF (the cookie came without its session key, or with a
 * key that is not its own).
 */
export function isSignedOutRefusal(status, code = '') {
  const number = Number(status) || 0;
  return number === 401 || (number === 403 && toText(code) === 'AUTH_SESSION_PROOF');
}

// What fetchQuestion and postAnswer answer when the relay said "signed out".
export const ANSWER_THERE_SIGNED_OUT = Object.freeze({ signedOut: true });

/**
 * The link's parameters: `{ present, valid, qid, option }`. `option` is an
 * integer index, or null when absent or not a plain number (then nothing is
 * preselected); `valid` says the id has the shape of a question id.
 */
export function readAnswerThereParams(href) {
  let url;
  try {
    url = new URL(String(href || ''));
  } catch {
    return { present: false, valid: false, qid: '', option: null };
  }
  if (!url.searchParams.has('answer')) return { present: false, valid: false, qid: '', option: null };
  const qid = toText(url.searchParams.get('answer'));
  const rawOption = toText(url.searchParams.get('option'));
  const option = /^\d{1,2}$/.test(rawOption) ? Number(rawOption) : null;
  const valid = ANSWER_THERE_QID_PATTERN.test(qid);
  return { present: true, valid, qid: valid ? qid : '', option };
}

/**
 * The sign-in box's line while `?answer=` waits in the address: "Sign in to
 * <relay> to answer" (the relay's name from the app config), or ''.
 */
export function answerThereSignInHint(href, relayName = '') {
  if (!readAnswerThereParams(href).present) return '';
  return `Sign in to ${toText(relayName) || 'this relay'} to answer`;
}

/** Takes `answer` and `option` out of the address (the entry keeps its state). */
export function stripAnswerThereParams({ location = window.location, history = window.history, title = document.title } = {}) {
  let url;
  try {
    url = new URL(String(location?.href || ''));
  } catch {
    return false;
  }
  if (!PARAMS.some((param) => url.searchParams.has(param))) return false;
  for (const param of PARAMS) url.searchParams.delete(param);
  history?.replaceState?.(history?.state ?? null, title, `${url.pathname}${url.search}${url.hash}`);
  return true;
}

function isAsk(question) {
  return toText(question?.kind) === 'ask' || /^ask_/.test(toText(question?.id));
}

/** This relay's option texts for the question: an ask's options, a card's choices. */
export function answerThereChoices(question) {
  const list = isAsk(question) ? question?.options : question?.choices;
  return (Array.isArray(list) ? list : []).map(toText).filter(Boolean);
}

/**
 * Why this view cannot answer the question, or '': 'answered' (not pending
 * any more), 'fields' (a card with fields or several picks: its session
 * answers it), 'typed' (no options to pick from).
 */
export function answerThereRefusal(question) {
  if (toText(question?.status) !== 'pending') return 'answered';
  const schema = question?.requestSchema;
  const hasFields = schema && typeof schema === 'object' && schema.properties && Object.keys(schema.properties).length > 0;
  if (hasFields || question?.context?.multiSelect === true) return 'fields';
  if (!answerThereChoices(question).length) return 'typed';
  return '';
}

/** The option to preselect: `option` when it names one of this relay's choices, else null. */
export function preselectedOption(question, option) {
  const count = answerThereChoices(question).length;
  return Number.isInteger(option) && option >= 0 && option < count ? option : null;
}

/** The answer route's body for `choice`, from this relay's copy of the question. */
export function answerThereBody(question, index) {
  const choices = answerThereChoices(question);
  const choice = Number.isInteger(index) ? choices[index] : undefined;
  if (!choice) return null;
  if (isAsk(question)) return { choice, answer: '' };
  return { answer: choice, ...(toText(question?.sdkSessionId) ? { sdk_session_id: toText(question.sdkSessionId) } : {}) };
}

/**
 * Confirm's guard (§13.4, DoubleClickjacking): open once the view has been
 * visible and focused for `delayMs` without a break, and a pointer move or
 * a key press happened in this window since it showed.
 */
export function createConfirmGate({
  delayMs = ANSWER_THERE_CONFIRM_DELAY_MS,
  now = () => Date.now(),
  isVisible = () => document.visibilityState !== 'hidden',
  hasFocus = () => (typeof document.hasFocus === 'function' ? document.hasFocus() : true),
} = {}) {
  let since = null;
  let input = false;
  function sample() {
    if (isVisible() && hasFocus()) {
      if (since === null) since = now();
    } else {
      since = null;
    }
  }
  return {
    /** A trusted pointer or key event in this window. */
    noteInput(event) {
      if (event && event.isTrusted === false) return;
      input = true;
    },
    /** Visibility or focus changed: a break restarts the wait. */
    sample,
    isOpen() {
      sample();
      return input && since !== null && now() - since >= delayMs;
    },
  };
}

function node(doc, tag, className = '', text = null) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== null && text !== undefined) element.textContent = String(text);
  return element;
}

function plainText(text) {
  return String(text ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The question as this relay's session shows it: its kind and time, its
 * header, its text (through `renderText`, the card renderer's own linking
 * of workspace paths; plain text otherwise), its rationale and an ask's
 * detail and recommendation.
 */
export function buildAnswerThereCard(doc, question, { renderText = plainText } = {}) {
  const card = node(doc, 'div', 'relay-question-card answer-there-card');
  const kind = isAsk(question) ? 'Question' : (toText(question?.kind) === 'approval' ? 'Approval' : 'Question');
  const when = toText(question?.createdAt);
  const date = when && Number.isFinite(Date.parse(when)) ? new Date(when).toLocaleString() : '';
  card.append(node(doc, 'div', 'relay-question-head', [kind, date].filter(Boolean).join(' · ')));
  const header = toText(question?.context?.header) || toText(question?.header);
  if (header) card.append(node(doc, 'div', 'relay-question-header', header));
  const body = node(doc, 'div', 'relay-question-body');
  body.innerHTML = renderText(String(question?.prompt ?? question?.question ?? ''));
  card.append(body);
  const rationale = toText(question?.context?.rationale);
  if (rationale) {
    const context = node(doc, 'div', 'relay-question-context');
    context.innerHTML = renderText(rationale);
    card.append(context);
  }
  if (toText(question?.detail)) card.append(node(doc, 'pre', 'relay-question-context answer-there-detail', question.detail));
  const recommendation = toText(question?.recommendation);
  if (recommendation) card.append(node(doc, 'div', 'relay-question-context', `Recommended: ${recommendation}`));
  return card;
}

/**
 * Starts the view when the address asks for it. `deps`:
 * - fetchQuestion(id) → the question, or null (not found, refused), or
 *   `{ signedOut: true }` (ANSWER_THERE_SIGNED_OUT);
 * - postAnswer(id, body) → `{ ok, status, error, signedOut }`;
 * - onSignedOut(): this browser is not signed in here; the view has
 *   stepped aside with the parameters still in the address, for the
 *   sign-in box to show and the view to open again after it;
 * - relayName: this relay's name, for "Already answered on <name>";
 * - renderText(text) → HTML (the card renderer's linking), optional;
 * - onLeave(): the view closed without closing the window.
 * Resolves with the view's root, or null when the address asks for nothing.
 */
export async function startAnswerThere({
  location = window.location,
  history = window.history,
  doc = document,
  win = window,
  fetchQuestion,
  postAnswer,
  relayName = '',
  renderText = plainText,
  onLeave = () => {},
  onSignedOut = () => {},
  delayMs = ANSWER_THERE_CONFIRM_DELAY_MS,
  now = () => Date.now(),
  isVisible = () => doc.visibilityState !== 'hidden',
  hasFocus = () => (typeof doc.hasFocus === 'function' ? doc.hasFocus() : true),
  // A person's event (a page script's dispatchEvent is not).
  trusted = (event) => event?.isTrusted === true,
} = {}) {
  const params = readAnswerThereParams(location?.href);
  if (!params.present) return null;
  const name = toText(relayName) || toText(location?.host) || 'this relay';
  doc.getElementById(VIEW_ID)?.remove();
  const root = node(doc, 'section', 'answer-there-view');
  root.id = VIEW_ID;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'answer-there-title');
  const title = node(doc, 'h1', 'answer-there-title', `Answer on ${name}`);
  title.id = 'answer-there-title';
  const content = node(doc, 'div', 'answer-there-content');
  const status = node(doc, 'p', 'answer-there-status', 'Loading the question…');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  root.append(title, content, status);
  doc.body.append(root);

  let gateTimer = null;
  const listeners = [];
  function listen(target, type, handler, options) {
    target?.addEventListener?.(type, handler, options);
    listeners.push(() => target?.removeEventListener?.(type, handler, options));
  }
  function teardown() {
    if (gateTimer) clearInterval(gateTimer);
    gateTimer = null;
    for (const remove of listeners.splice(0)) remove();
  }
  function leave() {
    teardown();
    stripAnswerThereParams({ location, history, title: doc.title });
    root.remove();
    try { onLeave(); } catch {}
  }
  function closeButton(label = 'Close') {
    const button = node(doc, 'button', 'answer-there-close summary-btn', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      try { win.close?.(); } catch {}
      // Still here (a tab the browser will not close): back to the app.
      setTimeout(() => { if (!win.closed) leave(); }, 150);
    });
    return button;
  }
  // Signed out: the view goes, the parameters stay for after the sign-in.
  function stepAsideSignedOut() {
    teardown();
    root.remove();
    try { onSignedOut(); } catch {}
  }
  function finish(text, { buttons = [closeButton()] } = {}) {
    teardown();
    stripAnswerThereParams({ location, history, title: doc.title });
    content.replaceChildren();
    status.textContent = text;
    const row = node(doc, 'div', 'answer-there-actions');
    row.append(...buttons);
    content.append(row);
  }

  if (!params.valid) {
    finish('This link does not name a question.');
    return root;
  }
  let question = null;
  try {
    question = await fetchQuestion(params.qid);
  } catch {
    question = null;
  }
  if (question?.signedOut === true) {
    stepAsideSignedOut();
    return null;
  }
  if (!question || typeof question !== 'object') {
    finish(`This question is not on ${name}, or it is gone.`);
    return root;
  }
  const refusal = answerThereRefusal(question);
  if (refusal === 'answered') {
    finish(`Already answered on ${name}.`);
    content.prepend(buildAnswerThereCard(doc, question, { renderText }));
    return root;
  }
  if (refusal) {
    const open = node(doc, 'a', 'answer-there-open summary-btn', 'Open its session');
    open.href = toText(question.conversationId) ? `./?conv=${encodeURIComponent(toText(question.conversationId))}` : './';
    finish(refusal === 'fields'
      ? 'This question has fields or takes several picks: answer it in its session.'
      : 'This question takes a typed answer: answer it in its session.', { buttons: [open, closeButton()] });
    content.prepend(buildAnswerThereCard(doc, question, { renderText }));
    return root;
  }

  // The full card, the options as radios, Confirm and Cancel.
  const choices = answerThereChoices(question);
  const preselect = preselectedOption(question, params.option);
  const form = node(doc, 'form', 'answer-there-form');
  form.setAttribute('method', 'post');
  form.setAttribute('action', '#');
  const fieldset = node(doc, 'fieldset', 'answer-there-options');
  fieldset.append(node(doc, 'legend', '', 'Your answer'));
  choices.forEach((choice, index) => {
    const label = node(doc, 'label', 'answer-there-option');
    const radio = doc.createElement('input');
    radio.type = 'radio';
    radio.name = 'answer-there-choice';
    radio.value = String(index);
    radio.checked = index === preselect;
    label.append(radio, ` ${choice}`);
    fieldset.append(label);
  });
  const confirm = node(doc, 'button', 'answer-there-confirm summary-btn', 'Confirm');
  confirm.type = 'submit';
  confirm.disabled = true;
  const cancel = node(doc, 'button', 'answer-there-cancel summary-btn', 'Cancel');
  cancel.type = 'button';
  const actions = node(doc, 'div', 'answer-there-actions');
  actions.append(confirm, cancel);
  form.append(fieldset, actions);
  content.append(buildAnswerThereCard(doc, question, { renderText }), form);
  status.textContent = '';
  // Keys go to this view, not to the page behind it.
  title.tabIndex = -1;
  try { title.focus?.({ preventScroll: true }); } catch {}

  const gate = createConfirmGate({ delayMs, now, isVisible, hasFocus });
  let sending = false;
  const picked = () => {
    const checked = form.querySelector('input[name="answer-there-choice"]:checked');
    return checked ? Number(checked.value) : null;
  };
  const sync = () => {
    confirm.disabled = sending || picked() === null || !gate.isOpen();
  };
  for (const type of ['pointermove', 'pointerdown', 'mousemove', 'touchstart', 'keydown']) {
    listen(win, type, (event) => { if (trusted(event)) gate.noteInput(); sync(); }, { capture: true, passive: true });
  }
  for (const type of ['focus', 'blur']) listen(win, type, () => { gate.sample(); sync(); });
  listen(doc, 'visibilitychange', () => { gate.sample(); sync(); });
  form.addEventListener('change', sync);
  gate.sample();
  gateTimer = setInterval(sync, GATE_TICK_MS);
  gateTimer?.unref?.();

  cancel.addEventListener('click', () => {
    try { win.close?.(); } catch {}
    setTimeout(() => { if (!win.closed) leave(); }, 150);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    sync();
    if (confirm.disabled || sending) return;
    const body = answerThereBody(question, picked());
    if (!body) return;
    sending = true;
    sync();
    status.textContent = 'Sending…';
    let result = null;
    try {
      result = await postAnswer(question.id || params.qid, body);
    } catch (error) {
      result = { ok: false, error: error?.message || '' };
    }
    sending = false;
    if (result?.signedOut === true) {
      stepAsideSignedOut();
      return;
    }
    if (result?.ok) {
      teardown();
      stripAnswerThereParams({ location, history, title: doc.title });
      try { win.close?.(); } catch {}
      const back = node(doc, 'a', 'answer-there-back', `Open ${name}`);
      back.href = './';
      content.replaceChildren(buildAnswerThereCard(doc, { ...question, status: 'answered' }, { renderText }));
      status.textContent = `Answered: ${body.choice || body.answer}. You can close this window.`;
      const row = node(doc, 'div', 'answer-there-actions');
      row.append(back);
      content.append(row);
      return;
    }
    if (result?.status === 409) {
      finish(`Already answered on ${name}.`);
      return;
    }
    status.textContent = toText(result?.error) || 'The answer did not go through. Try again.';
    sync();
  });
  return root;
}
