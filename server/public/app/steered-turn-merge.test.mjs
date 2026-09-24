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
  FOLDED_MSG_CLASS,
  STEER_STOPPED_MSG_CLASS,
  STEERED_MSG_CLASS,
  STEERED_CONTINUATION_CLASS,
} = await import('./steered-turn-merge.mjs');
const { SEPARATOR_CLASS } = await import('./transcript-separators.mjs');

function container() {
  const el = document.getElementById('messages');
  el.innerHTML = '';
  return el;
}

function addMsg(el, { role, absorbed = false, folded = false, stopped = false } = {}) {
  const node = document.createElement('div');
  node.className = `msg ${role}`;
  if (absorbed) node.classList.add(ABSORBED_MSG_CLASS);
  if (folded) node.classList.add(FOLDED_MSG_CLASS);
  if (stopped) node.classList.add(STEER_STOPPED_MSG_CLASS);
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

test('the fold shape (multi-steer): each steer is marked by its own stub, nothing merges forward', () => {
  // Multi-steering fold, in reload order (each reply anchors under its own
  // prompt): the turn's one answer under q1, then each steered row with its
  // folded stub right below it.
  const el = container();
  addMsg(el, { role: 'user' });                     // q1
  const answer = addMsg(el, { role: 'assistant' }); // the turn's one result
  const q2 = addMsg(el, { role: 'user' });
  const q2Stub = addMsg(el, { role: 'assistant', folded: true });
  const q3 = addMsg(el, { role: 'user' });
  const q3Stub = addMsg(el, { role: 'assistant', folded: true });

  assert.equal(syncSteeredTurnMerge(el), 2, 'only the two steered rows are classed');
  assert.equal(q2.classList.contains(STEERED_MSG_CLASS), true);
  assert.equal(q3.classList.contains(STEERED_MSG_CLASS), true);
  assert.equal(answer.classList.contains(STEERED_CONTINUATION_CLASS), false);
  assert.equal(q2Stub.classList.contains(STEERED_CONTINUATION_CLASS), false, 'a marker is not a continuing reply');
  assert.equal(q3Stub.classList.contains(STEERED_CONTINUATION_CLASS), false);
});

test('the next ordinary message after a fold is a normal turn', () => {
  // The 0.9.2 bug: the fold stub was kind='absorbed', so the NEXT message was
  // styled steered and its reply merged into a finished turn.
  const el = container();
  addMsg(el, { role: 'user' });
  addMsg(el, { role: 'assistant' });
  addMsg(el, { role: 'user' });
  addMsg(el, { role: 'assistant', folded: true });
  const c = addMsg(el, { role: 'user' });
  const cReply = addMsg(el, { role: 'assistant' });

  syncSteeredTurnMerge(el);
  assert.equal(c.classList.contains(STEERED_MSG_CLASS), false);
  assert.equal(cReply.classList.contains(STEERED_CONTINUATION_CLASS), false);
});

test('a steer cut off by Stop is marked steered and its marker never merges forward', () => {
  const el = container();
  addMsg(el, { role: 'user' });
  addMsg(el, { role: 'assistant' });
  const steered = addMsg(el, { role: 'user' });
  const stoppedStub = addMsg(el, { role: 'assistant', stopped: true });
  const next = addMsg(el, { role: 'user' });

  syncSteeredTurnMerge(el);
  assert.equal(steered.classList.contains(STEERED_MSG_CLASS), true);
  assert.equal(stoppedStub.classList.contains(STEERED_CONTINUATION_CLASS), false);
  assert.equal(next.classList.contains(STEERED_MSG_CLASS), false);
});

test('a marker across a separator does not claim the user row above it', () => {
  const el = container();
  const user = addMsg(el, { role: 'user' });
  addSeparator(el);
  addMsg(el, { role: 'assistant', folded: true });
  syncSteeredTurnMerge(el);
  assert.equal(user.classList.contains(STEERED_MSG_CLASS), false);
});
