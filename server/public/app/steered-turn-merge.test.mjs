import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// syncSteeredTurnMerge walks real DOM (classList, sibling traversal), so this
// runs on a JSDOM document rather than the pure-string harness.
const dom = new JSDOM('<!doctype html><html><body><div id="messages"></div></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;

const {
  syncSteeredTurnMerge,
  ABSORBED_MSG_CLASS,
  STEERED_MSG_CLASS,
  STEERED_CONTINUATION_CLASS,
} = await import('./steered-turn-merge.mjs');
const { SEPARATOR_CLASS } = await import('./transcript-separators.mjs');

function container() {
  const el = document.getElementById('messages');
  el.innerHTML = '';
  return el;
}

function addMsg(el, { role, absorbed = false } = {}) {
  const node = document.createElement('div');
  node.className = `msg ${role}`;
  if (absorbed) node.classList.add(ABSORBED_MSG_CLASS);
  el.appendChild(node);
  return node;
}

function addSeparator(el) {
  const node = document.createElement('div');
  node.className = SEPARATOR_CLASS;
  el.appendChild(node);
  return node;
}

test('an absorbed reply, steered user message, and continuing reply form one group', () => {
  const el = container();
  const absorbed = addMsg(el, { role: 'assistant', absorbed: true });
  const steered = addMsg(el, { role: 'user' });
  const continuation = addMsg(el, { role: 'assistant' });

  const changes = syncSteeredTurnMerge(el);
  assert.equal(changes, 2, 'the steered user row and the continuing reply are classed');
  assert.equal(absorbed.classList.contains(ABSORBED_MSG_CLASS), true);
  assert.equal(steered.classList.contains(STEERED_MSG_CLASS), true);
  assert.equal(continuation.classList.contains(STEERED_CONTINUATION_CLASS), true);

  // Idempotent: a second pass over the same DOM changes nothing.
  assert.equal(syncSteeredTurnMerge(el), 0);
});

test('an ordinary turn is left untouched', () => {
  const el = container();
  const user = addMsg(el, { role: 'user' });
  const reply = addMsg(el, { role: 'assistant' });

  assert.equal(syncSteeredTurnMerge(el), 0);
  assert.equal(user.classList.contains(STEERED_MSG_CLASS), false);
  assert.equal(reply.classList.contains(STEERED_CONTINUATION_CLASS), false);
});

test('a separator between the absorbed reply and the next user message breaks the group', () => {
  const el = container();
  addMsg(el, { role: 'assistant', absorbed: true });
  addSeparator(el);
  const laterUser = addMsg(el, { role: 'user' });

  assert.equal(syncSteeredTurnMerge(el), 0, 'the pair does not span a day/compaction break');
  assert.equal(laterUser.classList.contains(STEERED_MSG_CLASS), false);
});

test('the classes un-apply when the absorbed marker is dropped on re-render', () => {
  const el = container();
  const absorbed = addMsg(el, { role: 'assistant', absorbed: true });
  const steered = addMsg(el, { role: 'user' });
  const continuation = addMsg(el, { role: 'assistant' });
  syncSteeredTurnMerge(el);
  assert.equal(steered.classList.contains(STEERED_MSG_CLASS), true);

  // The interrupted reply loses its marker (e.g. a payload re-render without
  // kind='absorbed'): the merge must dissolve, not linger.
  absorbed.classList.remove(ABSORBED_MSG_CLASS);
  const changes = syncSteeredTurnMerge(el);
  assert.equal(changes, 2);
  assert.equal(steered.classList.contains(STEERED_MSG_CLASS), false);
  assert.equal(continuation.classList.contains(STEERED_CONTINUATION_CLASS), false);
});

test('a healed pair split across a history-page boundary classes on the later pass', () => {
  // The steered user row rendered first (live), the absorbed reply prepends
  // above it when the older page loads — the pass after the prepend classes it.
  const el = container();
  const steered = addMsg(el, { role: 'user' });
  assert.equal(syncSteeredTurnMerge(el), 0);
  assert.equal(steered.classList.contains(STEERED_MSG_CLASS), false);

  const absorbed = addMsg(el, { role: 'assistant', absorbed: true });
  el.insertBefore(absorbed, steered);
  const changes = syncSteeredTurnMerge(el);
  assert.equal(changes, 1);
  assert.equal(steered.classList.contains(STEERED_MSG_CLASS), true);
});

test('the fold shape (multi-steer) renders per-message markers, no trio classes', () => {
  // Multi-steering fold: several user rows sent mid-turn, ONE real answer on
  // the original row, then one absorbed stub per steered row. Each stub is its
  // own compact marker; none of the user rows form a replay-handoff trio (the
  // row above each is a user row or the real answer, never an absorbed reply
  // directly above a steered user).
  const el = container();
  addMsg(el, { role: 'user' });                     // q1
  const q2 = addMsg(el, { role: 'user' });          // steered
  const q3 = addMsg(el, { role: 'user' });          // steered
  const answer = addMsg(el, { role: 'assistant' }); // the turn's one result
  addMsg(el, { role: 'assistant', absorbed: true }); // q2's merge stub
  addMsg(el, { role: 'assistant', absorbed: true }); // q3's merge stub

  assert.equal(syncSteeredTurnMerge(el), 0, 'no classes to add or remove');
  assert.equal(q2.classList.contains(STEERED_MSG_CLASS), false);
  assert.equal(q3.classList.contains(STEERED_MSG_CLASS), false);
  assert.equal(answer.classList.contains(STEERED_CONTINUATION_CLASS), false);
});
