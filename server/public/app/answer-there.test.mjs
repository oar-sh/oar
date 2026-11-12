import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import {
  ANSWER_THERE_CONFIRM_DELAY_MS,
  ANSWER_THERE_SIGNED_OUT,
  answerThereBody,
  answerThereChoices,
  answerThereRefusal,
  answerThereSignInHint,
  createConfirmGate,
  isSignedOutRefusal,
  preselectedOption,
  readAnswerThereParams,
  startAnswerThere,
} from './answer-there.js';

// `?answer=<id>&option=<n>` on the relay that holds the question (agent auth
// §13.2, 1a): the link answers nothing; Confirm, after the guard, posts this
// relay's own option text. The question ids and texts are made up.

const CARD = {
  id: 'q-card-0001', kind: 'approval', conversationId: 'conv-1', sdkSessionId: 'sdk-1', status: 'pending',
  prompt: 'Safety check: edit /srv/sample-app/.env\n- OLD=1\n+ NEW=2', choices: ['Allow', 'Deny'],
  context: { header: 'Safety check' }, createdAt: '2026-11-11T11:00:00.000Z',
};
const ASK = { id: 'ask_abc123', kind: 'ask', status: 'pending', question: 'Ship on Friday?', options: ['Yes', 'No'], detail: 'Why: <b>x</b>' };

test('the parameters: an id of a question\'s shape, an integer option or none', () => {
  assert.deepEqual(readAnswerThereParams('https://b.example.test/?answer=q-1&option=1'), { present: true, valid: true, qid: 'q-1', option: 1 });
  assert.deepEqual(readAnswerThereParams('https://b.example.test/'), { present: false, valid: false, qid: '', option: null });
  assert.equal(readAnswerThereParams('https://b.example.test/?answer=q-1').option, null);
  for (const bad of ['1.5', '-1', 'x', '1e1', '100', '0x1']) {
    assert.equal(readAnswerThereParams(`https://b.example.test/?answer=q-1&option=${encodeURIComponent(bad)}`).option, null, bad);
  }
  for (const bad of ['', '../x', 'a b', '<b>', 'x'.repeat(161)]) {
    const read = readAnswerThereParams(`https://b.example.test/?answer=${encodeURIComponent(bad)}&option=0`);
    assert.equal(read.present, true);
    assert.equal(read.valid, false, bad);
    assert.equal(read.qid, '');
  }
});

test('the sign-in box says what it is for while ?answer= waits', () => {
  assert.equal(answerThereSignInHint('https://b.example.test/?answer=q-1&option=1', 'linux-test'), 'Sign in to linux-test to answer');
  assert.equal(answerThereSignInHint('https://b.example.test/?answer=q-1', ''), 'Sign in to this relay to answer');
  assert.equal(answerThereSignInHint('https://b.example.test/', 'linux-test'), '');
  assert.equal(answerThereSignInHint('https://b.example.test/?settings=relays', 'linux-test'), '');
});

test('this relay\'s copy decides: options, what is preselected, what is posted', () => {
  assert.deepEqual(answerThereChoices(CARD), ['Allow', 'Deny']);
  assert.deepEqual(answerThereChoices(ASK), ['Yes', 'No']);
  assert.equal(preselectedOption(CARD, 1), 1);
  assert.equal(preselectedOption(CARD, 2), null, 'out of range: nothing preselected');
  assert.equal(preselectedOption(CARD, null), null);
  assert.deepEqual(answerThereBody(CARD, 1), { answer: 'Deny', sdk_session_id: 'sdk-1' });
  assert.deepEqual(answerThereBody(ASK, 0), { choice: 'Yes', answer: '' });
  assert.equal(answerThereBody(CARD, 5), null);
  assert.equal(answerThereRefusal(CARD), '');
  assert.equal(answerThereRefusal({ ...CARD, status: 'answered' }), 'answered');
  assert.equal(answerThereRefusal({ ...CARD, context: { multiSelect: true } }), 'fields');
  assert.equal(answerThereRefusal({ ...CARD, requestSchema: { properties: { name: { type: 'string' } } } }), 'fields');
  assert.equal(answerThereRefusal({ ...CARD, choices: [] }), 'typed');
});

test('the Confirm guard: 800 ms visible and focused without a break, and an input event in this window', () => {
  let clock = 0;
  let visible = true;
  let focused = true;
  const gate = createConfirmGate({ now: () => clock, isVisible: () => visible, hasFocus: () => focused });
  gate.sample();
  clock = ANSWER_THERE_CONFIRM_DELAY_MS + 10;
  assert.equal(gate.isOpen(), false, 'no input yet');
  gate.noteInput({ isTrusted: false });
  assert.equal(gate.isOpen(), false, 'a script\'s event does not count');
  gate.noteInput({ isTrusted: true });
  assert.equal(gate.isOpen(), true);
  // Focus lost: the wait starts again.
  focused = false;
  gate.sample();
  focused = true;
  clock += 100;
  assert.equal(gate.isOpen(), false);
  clock += ANSWER_THERE_CONFIRM_DELAY_MS;
  assert.equal(gate.isOpen(), true);
  visible = false;
  assert.equal(gate.isOpen(), false);
});

function page(href) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: href });
  const { window } = dom;
  const replaced = [];
  const history = { state: null, replaceState: (state, title, url) => { replaced.push(url); window.history.replaceState(state, title, url); } };
  let closed = false;
  const win = Object.assign(Object.create(null), {
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    close: () => { closed = true; },
    get closed() { return closed; },
  });
  return { dom, window, doc: window.document, history, win, replaced, isClosed: () => closed };
}

test('the view: the full card, radios with the option preselected, Confirm gated, posts this relay\'s option text, then closes', async () => {
  const p = page('https://b.example.test/?answer=q-card-0001&option=1');
  let clock = 0;
  const posted = [];
  // jsdom's dispatched events are untrusted; the page itself counts only a person's.
  const root = await startAnswerThere({
    location: p.window.location, history: p.history, doc: p.doc, win: p.win, hasFocus: () => true, trusted: () => true, relayName: 'lab-relay',
    now: () => clock,
    fetchQuestion: async (id) => (id === CARD.id ? CARD : null),
    postAnswer: async (id, body) => { posted.push({ id, body }); return { ok: true }; },
  });
  assert.equal(root.querySelector('h1').textContent, 'Answer on lab-relay');
  assert.equal(root.querySelector('.relay-question-header').textContent, 'Safety check');
  assert.equal(root.querySelector('.relay-question-body').textContent, CARD.prompt, 'the path and the diff, as text');
  const radios = [...root.querySelectorAll('input[type="radio"]')];
  assert.deepEqual(radios.map((radio) => radio.parentElement.textContent.trim()), ['Allow', 'Deny']);
  assert.deepEqual(radios.map((radio) => radio.checked), [false, true]);
  const confirm = root.querySelector('.answer-there-confirm');
  assert.equal(confirm.disabled, true);
  assert.deepEqual(p.replaced, [], 'the parameters stay until used');

  // A submit before the guard opens does nothing.
  root.querySelector('form').dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(posted, []);

  clock = ANSWER_THERE_CONFIRM_DELAY_MS;
  p.window.dispatchEvent(new p.window.Event('pointermove'));
  assert.equal(confirm.disabled, false);
  const submit = new p.window.Event('submit', { bubbles: true, cancelable: true });
  root.querySelector('form').dispatchEvent(submit);
  assert.equal(submit.defaultPrevented, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(posted, [{ id: 'q-card-0001', body: { answer: 'Deny', sdk_session_id: 'sdk-1' } }]);
  assert.equal(p.isClosed(), true, 'the window closes itself');
  assert.match(root.textContent, /Answered: Deny\. You can close this window\./);
  assert.equal(root.querySelector('.answer-there-back').getAttribute('href'), './', 'a relative link, no return address');
  assert.equal(p.window.location.search, '', 'the parameters left the address');
});

test('an out-of-range option preselects nothing; Confirm needs a pick', async () => {
  const p = page('https://b.example.test/?answer=ask_abc123&option=7');
  let clock = 0;
  const root = await startAnswerThere({
    location: p.window.location, history: p.history, doc: p.doc, win: p.win, hasFocus: () => true, trusted: () => true, now: () => clock,
    fetchQuestion: async () => ASK, postAnswer: async () => ({ ok: true }),
  });
  assert.deepEqual([...root.querySelectorAll('input[type="radio"]')].map((radio) => radio.checked), [false, false]);
  assert.equal(root.querySelector('.answer-there-detail').textContent, 'Why: <b>x</b>');
  assert.equal(root.querySelectorAll('b').length, 0);
  clock = 5_000;
  p.window.dispatchEvent(new p.window.Event('keydown'));
  assert.equal(root.querySelector('.answer-there-confirm').disabled, true, 'nothing picked');
  root.querySelector('input[type="radio"]').checked = true;
  root.querySelector('form').dispatchEvent(new p.window.Event('change', { bubbles: true }));
  assert.equal(root.querySelector('.answer-there-confirm').disabled, false);
  p.doc.getElementById('answer-there-view')?.remove();
});

test('already answered: says so on this relay, no options', async () => {
  const p = page('https://b.example.test/?answer=q-card-0001&option=0');
  const root = await startAnswerThere({
    location: p.window.location, history: p.history, doc: p.doc, win: p.win, hasFocus: () => true, trusted: () => true, relayName: 'lab-relay',
    fetchQuestion: async () => ({ ...CARD, status: 'answered' }), postAnswer: async () => assert.fail('nothing is posted'),
  });
  assert.match(root.querySelector('.answer-there-status').textContent, /^Already answered on lab-relay\.$/);
  assert.equal(root.querySelectorAll('input[type="radio"]').length, 0);
  assert.equal(root.querySelector('.answer-there-confirm'), null);
  assert.equal(p.window.location.search, '');
});

test('a bad id asks nothing of the relay; no link, no view', async () => {
  const p = page('https://b.example.test/?answer=..%2Fx&option=0');
  let asked = 0;
  const root = await startAnswerThere({
    location: p.window.location, history: p.history, doc: p.doc, win: p.win, hasFocus: () => true, trusted: () => true,
    fetchQuestion: async () => { asked += 1; return CARD; }, postAnswer: async () => ({ ok: true }),
  });
  assert.equal(asked, 0);
  assert.match(root.textContent, /This link does not name a question\./);
  const none = page('https://b.example.test/?conv=c-1');
  assert.equal(await startAnswerThere({ location: none.window.location, history: none.history, doc: none.doc, win: none.win, fetchQuestion: async () => CARD }), null);
});

test('a refused answer says why and keeps the view; a 409 says it was answered meanwhile', async () => {
  const p = page('https://b.example.test/?answer=q-card-0001&option=0');
  let clock = 0;
  let answer = { ok: false, status: 400, error: 'This question takes one of its choices, not typed text' };
  const root = await startAnswerThere({
    location: p.window.location, history: p.history, doc: p.doc, win: p.win, hasFocus: () => true, trusted: () => true, relayName: 'lab-relay', now: () => clock,
    fetchQuestion: async () => CARD, postAnswer: async () => answer,
  });
  clock = 1_000;
  p.window.dispatchEvent(new p.window.Event('pointerdown'));
  root.querySelector('form').dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(root.querySelector('.answer-there-status').textContent, answer.error);
  assert.equal(p.isClosed(), false);
  answer = { ok: false, status: 409 };
  root.querySelector('form').dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(root.querySelector('.answer-there-status').textContent, 'Already answered on lab-relay.');
});

test('a page script\'s event does not open Confirm', async () => {
  const p = page('https://b.example.test/?answer=q-card-0001&option=0');
  const root = await startAnswerThere({
    location: p.window.location, history: p.history, doc: p.doc, win: p.win, hasFocus: () => true, now: () => 10_000,
    fetchQuestion: async () => CARD, postAnswer: async () => assert.fail('nothing is posted'),
  });
  p.window.dispatchEvent(new p.window.Event('pointermove'));
  p.window.dispatchEvent(new p.window.Event('keydown'));
  assert.equal(root.querySelector('.answer-there-confirm').disabled, true);
  root.remove();
});

test('signed out here: 401, or a cookie without its session key (403 AUTH_SESSION_PROOF); other refusals are not', () => {
  assert.equal(isSignedOutRefusal(401), true);
  assert.equal(isSignedOutRefusal(403, 'AUTH_SESSION_PROOF'), true);
  assert.equal(isSignedOutRefusal(403, 'AUTH_CROSS_SITE'), false);
  assert.equal(isSignedOutRefusal(403, 'AUTH_COOKIE_UPGRADE'), false, 'an old cookie is traded, not signed out');
  assert.equal(isSignedOutRefusal(404), false);
  assert.equal(isSignedOutRefusal(409), false);
});

test('a cookie without its key: the view steps aside for the sign-in box, the parameters stay, and it opens again after the sign-in', async () => {
  const p = page('https://b.example.test/?answer=q-card-0001&option=1');
  let signedIn = false;
  let toldSignedOut = 0;
  const deps = () => ({
    location: p.window.location, history: p.history, doc: p.doc, win: p.win, hasFocus: () => true, trusted: () => true, relayName: 'lab-relay',
    fetchQuestion: async () => (signedIn ? CARD : ANSWER_THERE_SIGNED_OUT),
    postAnswer: async () => ({ ok: true }),
    onSignedOut: () => { toldSignedOut += 1; },
  });
  assert.equal(await startAnswerThere(deps()), null);
  assert.equal(toldSignedOut, 1);
  assert.equal(p.doc.getElementById('answer-there-view'), null, 'no view over the sign-in box');
  assert.deepEqual(p.replaced, [], 'the parameters wait in the address');
  assert.equal(answerThereSignInHint(p.window.location.href, 'lab-relay'), 'Sign in to lab-relay to answer');

  // Signed in (with a key): the page starts the view again from the address.
  signedIn = true;
  const root = await startAnswerThere(deps());
  assert.ok(root);
  assert.deepEqual([...root.querySelectorAll('input[type="radio"]')].map((radio) => radio.checked), [false, true], 'option 1 still preselected');
  root.remove();
});

test('an answer refused as signed out keeps the parameters and hands over to the sign-in box', async () => {
  const p = page('https://b.example.test/?answer=q-card-0001&option=0');
  let clock = 0;
  let toldSignedOut = 0;
  const root = await startAnswerThere({
    location: p.window.location, history: p.history, doc: p.doc, win: p.win, hasFocus: () => true, trusted: () => true, now: () => clock,
    fetchQuestion: async () => CARD,
    postAnswer: async () => ({ ok: false, status: 403, error: 'refused', signedOut: true }),
    onSignedOut: () => { toldSignedOut += 1; },
  });
  clock = 1_000;
  p.window.dispatchEvent(new p.window.Event('pointermove'));
  root.querySelector('form').dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(toldSignedOut, 1);
  assert.equal(p.doc.getElementById('answer-there-view'), null);
  assert.equal(p.isClosed(), false);
  assert.match(p.window.location.search, /answer=q-card-0001&option=0/);
});

test('the page wires both calls through the proof-sending client and the sign-in box', () => {
  const source = readFileSync(new URL('./bootstrap.js', import.meta.url), 'utf8');
  const start = source.indexOf('function startAnswerThereFromLocation()');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.ok(start > 0);
  assert.match(body, /fetchQuestion: async \(id\) => \{[\s\S]*apiFetch\(`\/api\/relay-question\//);
  assert.match(body, /postAnswer: async \(id, body\) => \{[\s\S]*apiFetch\(`\/api\/relay-question\/\$\{encodeURIComponent\(id\)\}\/answer`/);
  assert.doesNotMatch(body, /[^.]fetch\(/, 'no bare fetch: apiFetch adds the session key');
  assert.match(body, /onSignedOut: \(\) => handleSignedOut\(null\)/);
});
