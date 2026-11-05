import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  HELD_DETAILS_MAX_BYTES,
  HELD_DETAILS_MAX_IDS,
  HELD_DETAILS_SHAPE,
  createHeldDetailsStore,
  detailsVersion,
  parseHeldDetailsParam,
  thoughtFingerprint,
} from './held-details.mjs';

// The page's store of finished replies' details and the relay's reading of
// the poll's `heldDetails` param.

// A version in the current form for the short labels below ('4.10' → tool
// rows 4, highest row 10, no thoughts).
const V = (label) => {
  const [n, max] = label.split('.');
  return detailsVersion({ activityCount: n, activityMaxRowId: max });
};

const reply = (id, version, n = 3) => ({
  id,
  role: 'assistant',
  text: `Reply ${id}`,
  detailsVersion: version,
  activities: Array.from({ length: n }, (_, i) => ({ text: `Tool (view): ${id}-${i}.js`, subagentRunId: null, turnSeq: i * 2 + 2 })),
  thoughts: [{ reasoningId: `r-${id}`, text: `Thinking about ${id}`, done: true, turnSeq: 1 }],
});
const ask = (id) => ({ id, role: 'user', text: `Ask ${id}` });
const held = (id) => ({ id, role: 'assistant', text: `Reply ${id}`, activities: [], thoughts: [], detailsHeld: true });

test('the version: shape tag, tool rows, thought rows and a fingerprint of the thoughts', () => {
  assert.equal(HELD_DETAILS_SHAPE, 's1');
  const thoughts = [{ rowid: 7, done: 0, text: 'Reading the widget cache' }, { rowid: 9, done: 1, text: 'Eviction drops the oldest' }];
  const version = detailsVersion({ activityCount: 6, activityMaxRowId: 42, thoughtCount: 2, thoughtMaxRowId: 9, thoughtHash: thoughtFingerprint(thoughts) });
  assert.match(version, /^s1\.6\.42\.2\.9\.[0-9a-f]{8}$/);
  assert.equal(detailsVersion(), 's1.0.0.0.0.00000000');
  // Row order does not matter; every change of text or done does, the same
  // length and the same moment included.
  const base = thoughtFingerprint(thoughts);
  assert.equal(thoughtFingerprint([...thoughts].reverse()), base);
  assert.notEqual(thoughtFingerprint([{ ...thoughts[0], done: 1 }, thoughts[1]]), base, 'done flips');
  assert.notEqual(thoughtFingerprint([{ ...thoughts[0], text: 'Reading the widget cachf' }, thoughts[1]]), base, 'same length, other text');
  assert.notEqual(thoughtFingerprint([{ ...thoughts[0], text: 'Reading the widget cache.' }, thoughts[1]]), base, 'a chunk more');
});

test('the param: id~version entries; junk and versions of another form dropped; over 200 entries or 8 KB ignored', () => {
  const v1 = V('6.42');
  const v2 = V('0.0');
  assert.deepEqual([...parseHeldDetailsParam(`reply-1~${v1},reply_2~${v2}`)], [['reply-1', v1], ['reply_2', v2]]);
  assert.deepEqual([...parseHeldDetailsParam(`bad id~${v1},${'a'.repeat(65)}~${v1},ok~x.1,~${v1},plain,ok-2~${v2}`)], [['ok-2', v2]]);
  // A page left open across the upgrade still holds the two-part versions:
  // they never match, the replies go out in full.
  assert.equal(parseHeldDetailsParam('reply-1~6.42,reply_2~0.0'), null);
  assert.deepEqual([...parseHeldDetailsParam(`reply-1~6.42,reply_2~${v2}`)], [['reply_2', v2]]);
  for (const raw of [undefined, null, '', 'junk', [`a~${v1}`]]) assert.equal(parseHeldDetailsParam(raw), null, String(raw));
  const tooMany = Array.from({ length: HELD_DETAILS_MAX_IDS + 1 }, (_, i) => `id-${i}~${v1}`).join(',');
  assert.equal(parseHeldDetailsParam(tooMany), null);
  const tooBig = Array.from({ length: 120 }, (_, i) => `${'b'.repeat(64)}~${V(`${i}.1`)}`).join(',');
  assert.ok(tooBig.length > HELD_DETAILS_MAX_BYTES);
  assert.equal(parseHeldDetailsParam(tooBig), null);
});

test('no code path updates a tool row\'s text: tool rows only ever grow in number', () => {
  const root = new URL('../../', import.meta.url);
  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'public') continue;
      const next = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
      if (entry.isDirectory()) walk(next);
      else if (/\.m?js$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name)) sources.push(next);
    }
  };
  walk(root);
  const updates = [];
  for (const file of sources) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/UPDATE\s+relay_activity\s+SET([\s\S]*?)(?:WHERE|`)/gi)) updates.push(match[1]);
  }
  assert.ok(updates.length > 0, 'the link to the response is an update');
  for (const set of updates) assert.doesNotMatch(set, /\btext\b|\bturn_seq\b|\bsubagent_run_id\b/, set.trim());
});

test('filled from a full load, named in the poll, restored from the store', () => {
  const store = createHeldDetailsStore();
  const full = { messages: [ask('a0'), reply('r0', V('4.10')), ask('a1'), reply('r1', V('4.20'))] };
  store.noteApplied('conv-1', full, { full: true });
  assert.equal(store.param('conv-1'), `r1~${V('4.20')},r0~${V('4.10')}`, 'newest first');

  const poll = { messages: [ask('a0'), held('r0'), ask('a1'), held('r1'), ask('a2'), reply('r2', V('4.30'))] };
  assert.equal(store.restore('conv-1', poll), true);
  assert.deepEqual(poll.messages[1].activities, full.messages[1].activities);
  assert.deepEqual(poll.messages[1].thoughts, full.messages[1].thoughts);
  assert.equal(poll.messages[1].detailsVersion, V('4.10'));
  assert.equal('detailsHeld' in poll.messages[1], false);
  store.noteApplied('conv-1', poll, { shownIds: poll.messages.map((m) => m.id) });
  assert.equal(store.param('conv-1'), `r2~${V('4.30')},r1~${V('4.20')},r0~${V('4.10')}`, 'the reply that finished is held from now on');
});

test('restore fills the poll answer in place, so the kept window the page redraws from is whole', async () => {
  const { createConversationPayloadCache } = await import('./conversation-payload-cache.mjs');
  const store = createHeldDetailsStore();
  const cache = createConversationPayloadCache();
  store.noteApplied('conv-1', { messages: [ask('a0'), reply('r0', V('4.10'))] }, { full: true });
  const poll = { messages: [ask('a0'), held('r0')] };
  assert.equal(store.restore('conv-1', poll), true);
  // journal-view keeps the payload it applies, this very object.
  cache.remember('conv-1', poll);
  const kept = cache.peekWindow('conv-1').messages.find((m) => m.id === 'r0');
  assert.equal(kept.detailsHeld, undefined);
  assert.equal(kept.activities.length, 3);
  assert.equal(kept.thoughts.length, 1);
  assert.equal(kept.detailsVersion, V('4.10'));
});

test('a changed version replaces the held copy', () => {
  const store = createHeldDetailsStore();
  store.noteApplied('conv-1', { messages: [reply('r0', V('4.10'))] }, { full: true });
  const late = reply('r0', V('5.31'), 4);
  store.noteApplied('conv-1', { messages: [late] }, { shownIds: ['r0'] });
  assert.equal(store.param('conv-1'), `r0~${V('5.31')}`);
  const poll = { messages: [held('r0')] };
  store.restore('conv-1', poll);
  assert.equal(poll.messages[0].activities.length, 4);
});

test('the store follows the window: rows no longer shown go; a conversation switch clears it', () => {
  const store = createHeldDetailsStore();
  store.noteApplied('conv-1', { messages: [reply('r0', V('1.1')), reply('r1', V('1.2')), reply('r2', V('1.3'))] }, { full: true });
  store.noteApplied('conv-1', { messages: [reply('r1', V('1.2')), reply('r2', V('1.3'))] }, { shownIds: ['r1', 'r2'] });
  assert.equal(store.has('r0'), false);
  assert.equal(store.size(), 2);
  // An older page joins what is held.
  store.noteApplied('conv-1', { messages: [reply('r-old', V('2.2'))] });
  assert.equal(store.has('r-old'), true);
  // Another conversation: nothing held, nothing named.
  assert.equal(store.param('conv-2'), '');
  assert.equal(store.size(), 0);
});

test('a reply from an older relay (no version) or a held stub is never stored', () => {
  const store = createHeldDetailsStore();
  const old = reply('r0', undefined);
  delete old.detailsVersion;
  store.noteApplied('conv-1', { messages: [old, held('r1')] }, { full: true });
  assert.equal(store.size(), 0);
  assert.equal(store.param('conv-1'), '');
});

test('no drop loop: a dropped poll forces one full poll; a second drop turns the param off until a full load', () => {
  const store = createHeldDetailsStore();
  store.noteApplied('conv-1', { messages: [reply('r0', V('1.1'))] }, { full: true });
  assert.notEqual(store.param('conv-1'), '');
  // The relay says it holds a reply the store does not have: dropped.
  assert.equal(store.restore('conv-1', { messages: [held('r-unknown')] }), false);
  assert.equal(store.param('conv-1'), '', 'the next poll asks for everything');
  // That full poll is answered (nothing held in it).
  assert.equal(store.restore('conv-1', { messages: [reply('r0', V('1.1'))] }), true);
  assert.notEqual(store.param('conv-1'), '', 'then the param again');
  // Dropped again: off.
  assert.equal(store.restore('conv-1', { messages: [held('r-unknown')] }), false);
  for (let i = 0; i < 3; i += 1) assert.equal(store.param('conv-1'), '', 'off');
  // A full load turns it back on.
  store.noteApplied('conv-1', { messages: [reply('r0', V('1.1'))] }, { full: true });
  assert.equal(store.param('conv-1'), `r0~${V('1.1')}`);
  // A poll the store answered ends a run of drops.
  assert.equal(store.restore('conv-1', { messages: [held('r-unknown')] }), false);
  assert.equal(store.param('conv-1'), '');
  assert.equal(store.restore('conv-1', { messages: [held('r0')] }), true);
  assert.equal(store.restore('conv-1', { messages: [held('r-unknown')] }), false);
  assert.equal(store.param('conv-1'), '', 'one full poll again, not off');
  assert.notEqual(store.param('conv-1'), '');
});

test('the param stays within 8 KB and 200 entries, the newest kept', () => {
  const store = createHeldDetailsStore();
  const messages = Array.from({ length: 260 }, (_, i) => reply(`${'r'.repeat(50)}${String(i).padStart(4, '0')}`, V(`${i}.${i * 7}`), 1));
  store.noteApplied('conv-1', { messages }, { full: true });
  const param = store.param('conv-1');
  assert.ok(param.length <= HELD_DETAILS_MAX_BYTES);
  const entries = param.split(',');
  assert.ok(entries.length <= HELD_DETAILS_MAX_IDS);
  assert.ok(entries[0].startsWith(messages.at(-1).id), 'the newest first');
  assert.ok(parseHeldDetailsParam(param), 'the relay accepts it');
});

test('only the live poll sends the param, and the socket never fills the store', () => {
  const source = (name) => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
  const bootstrap = source('./bootstrap.js');
  assert.equal((bootstrap.match(/heldDetailsStore\.param\(/g) || []).length, 1);
  assert.match(bootstrap, /const heldDetails = heldDetailsStore\.param\(currentId\);[\s\S]*?loadConversation\(currentId, \{ limit: requestLimit, heldDetails \}\)[\s\S]*?if \(!heldDetailsStore\.restore\(currentId, response\)\) return;[\s\S]*?fromPoll: true,/);
  assert.doesNotMatch(source('./socket-handlers.js'), /heldDetails/);
  assert.doesNotMatch(source('./api-client.js').replace(/heldDetails = String\(options\.heldDetails \|\| ''\)[\s\S]*?params\.set\('heldDetails', heldDetails\);/, ''), /heldDetails/);
});
