import test from 'node:test';
import assert from 'node:assert/strict';

import { findRemoteRelayMentions, isAddressHost, mentionQueryAt, remoteRelayAliases } from './remote-relay-mentions.mjs';

const relays = [
  { id: 'id-linux', name: 'linux-test', url: 'https://relay-b.example.test' },
  { id: 'id-win', name: 'win-test', url: 'http://127.0.0.1:13351' },
  { id: 'id-short', name: 'example.test', url: 'https://relay-c.example.org' },
];

const ids = (text, options) => findRemoteRelayMentions(text, relays, options).map((match) => match.relayId);

test('aliases are the name and the URL host, lowercased', () => {
  assert.deepEqual(remoteRelayAliases({ name: 'Linux-Test', url: 'https://Relay-B.example.test/oar' }), ['linux-test', 'relay-b.example.test']);
  assert.deepEqual(remoteRelayAliases({ name: 'x', url: 'not a url' }), ['x']);
  assert.deepEqual(remoteRelayAliases({ name: 'lan-test', url: 'http://devbox:3333' }), ['lan-test', 'devbox'], 'a single-label DNS name counts');
});

test('loopback and IP-literal URL hosts are no aliases', () => {
  assert.deepEqual(remoteRelayAliases({ name: 'win-test', url: 'http://127.0.0.1:13351' }), ['win-test']);
  assert.deepEqual(remoteRelayAliases({ name: 'lab-relay', url: 'http://localhost:8123' }), ['lab-relay']);
  assert.deepEqual(remoteRelayAliases({ name: 'v6-test', url: 'http://[::1]:8123' }), ['v6-test']);
  assert.deepEqual(remoteRelayAliases({ name: 'lan-test', url: 'http://192.168.10.20:3333' }), ['lan-test']);
  assert.deepEqual(remoteRelayAliases({ name: 'v6-lan', url: 'http://[fd00::20]:3333' }), ['v6-lan']);
  for (const host of ['localhost', 'box.localhost', '127.0.0.1', '10.0.0.1', '[::1]', '::1', '[fd00::20]']) {
    assert.equal(isAddressHost(host), true, host);
  }
  for (const host of ['relay-b.example.test', 'devbox', 'localhost-relay.example.test', '1.example.test', '']) {
    assert.equal(isAddressHost(host), false, host);
  }

  const local = [
    { id: 'id-lab', name: 'lab-relay', url: 'http://localhost:8123' },
    { id: 'id-win', name: 'win-test', url: 'http://127.0.0.1:13351' },
  ];
  const found = (text) => findRemoteRelayMentions(text, local).map((match) => match.relayId);
  assert.deepEqual(found('curl localhost:3000/api/status'), []);
  assert.deepEqual(found('ping 127.0.0.1 and http://127.0.0.1:13351/'), []);
  assert.deepEqual(found('ask lab-relay'), ['id-lab'], 'the name still counts');
});

test('a relay named after its address needs the @', () => {
  const unnamed = [{ id: 'id-lan', name: '192.168.10.20', url: 'http://192.168.10.20:3333' }];
  const found = (text) => findRemoteRelayMentions(text, unnamed).map((match) => match.relayId);
  assert.deepEqual(found('ssh 192.168.10.20 and look'), []);
  assert.deepEqual(found('ask @192.168.10.20 to run it'), ['id-lan']);
  assert.deepEqual(found('mail@192.168.10.20'), [], 'an @ inside a word is no mention');
});

test('an @-mention or the plain name counts, case-insensitively', () => {
  assert.deepEqual(ids('please ask @linux-test to run the suite'), ['id-linux']);
  assert.deepEqual(ids('what is Linux-Test doing?'), ['id-linux']);
  assert.deepEqual(ids('linux-test'), ['id-linux']);
  assert.deepEqual(ids('(@win-test)'), ['id-win']);
});

test('the URL host counts, also inside a pasted URL', () => {
  assert.deepEqual(ids('look at relay-b.example.test'), ['id-linux']);
  assert.deepEqual(ids('see https://relay-b.example.test/?conv=1 there'), ['id-linux']);
});

test('longer names and hosts do not count', () => {
  assert.deepEqual(ids('linux-tests are green'), []);
  assert.deepEqual(ids('the linux-test.backup folder'), []);
  assert.deepEqual(ids('sub.relay-b.example.test'), []);
  assert.deepEqual(ids('my_linux-test'), []);
  assert.deepEqual(ids('relay-c.example.test'), [], 'a relay named example.test is not mentioned by a longer host');
});

test('a sentence-ending dot or comma still ends the token', () => {
  assert.deepEqual(ids('ask linux-test.'), ['id-linux']);
  assert.deepEqual(ids('ask linux-test, then win-test'), ['id-linux', 'id-win']);
  assert.deepEqual(ids('ask example.test.'), ['id-short']);
});

test('results come in order of appearance, once per relay', () => {
  const matches = findRemoteRelayMentions('win-test then linux-test then win-test', relays);
  assert.deepEqual(matches.map((match) => match.relayId), ['id-win', 'id-linux']);
  assert.equal(matches[0].index, 0);
});

test('this relay\'s own name is ignored', () => {
  assert.deepEqual(ids('win-test and linux-test', { selfNames: ['Win-Test'] }), ['id-linux']);
});

test('an alias shared by two relays is ambiguous and ignored', () => {
  const twins = [
    { id: 'a', name: 'twin', url: 'https://a.example.test' },
    { id: 'b', name: 'twin', url: 'https://b.example.test' },
  ];
  assert.deepEqual(findRemoteRelayMentions('ask twin', twins), []);
  assert.deepEqual(findRemoteRelayMentions('ask a.example.test', twins).map((match) => match.relayId), ['a']);
});

test('file references are not relay mentions', () => {
  assert.deepEqual(ids('`@file:C:/work/demo/linux-test-notes.md`'), []);
});

test('nothing to find in empty input', () => {
  assert.deepEqual(findRemoteRelayMentions('', relays), []);
  assert.deepEqual(findRemoteRelayMentions('linux-test', []), []);
});

test('the composer query is the @word before the caret', () => {
  assert.deepEqual(mentionQueryAt('ask @lin', 8), { start: 4, end: 8, query: 'lin' });
  assert.deepEqual(mentionQueryAt('@', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(mentionQueryAt('ask (@Win', 9), { start: 5, end: 9, query: 'win' });
  assert.equal(mentionQueryAt('mail me at a@b', 14), null, 'an @ inside a word is not a mention');
  assert.equal(mentionQueryAt('ask lin', 7), null);
  assert.equal(mentionQueryAt('ask @lin now', 12), null, 'the caret has left the token');
});
