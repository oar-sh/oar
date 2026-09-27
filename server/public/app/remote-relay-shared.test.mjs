import test from 'node:test';
import assert from 'node:assert/strict';

import * as mirror from './remote-relay-shared.mjs';
import {
  REMOTE_PROMPT_HEADER_PATTERN,
  REMOTE_RELAY_DEFAULT_PERMISSION,
  REMOTE_RELAY_PERMISSIONS,
  REMOTE_RELAY_SOCKET_EVENT,
  formatRemotePromptHeader,
  normalizeRemoteRelayPermission,
  remoteConversationUrl,
  stripRemotePromptHeader,
  withRemotePromptHeader,
} from '../../../shared/remote-relay-contract.mjs';
import { isAddressHost, mentionQueryAt, remoteRelayAliases } from '../../../shared/remote-relay-mentions.mjs';

// The browser cannot import shared/, so remote-relay-shared.mjs is a hand-kept
// copy. These assertions fail the moment either side changes without the other.

test('the constants match the shared contract', () => {
  assert.deepEqual([...mirror.REMOTE_RELAY_PERMISSIONS], [...REMOTE_RELAY_PERMISSIONS]);
  assert.equal(mirror.REMOTE_RELAY_DEFAULT_PERMISSION, REMOTE_RELAY_DEFAULT_PERMISSION);
  assert.equal(mirror.REMOTE_RELAY_SOCKET_EVENT, REMOTE_RELAY_SOCKET_EVENT);
  assert.equal(mirror.REMOTE_PROMPT_HEADER_PATTERN.source, REMOTE_PROMPT_HEADER_PATTERN.source);
  assert.equal(mirror.REMOTE_PROMPT_HEADER_PATTERN.flags, REMOTE_PROMPT_HEADER_PATTERN.flags);
});

test('permission normalisation agrees', () => {
  for (const value of ['read', 'PROMPT', ' full ', '', null, undefined, 'admin', 3]) {
    assert.equal(mirror.normalizeRemoteRelayPermission(value), normalizeRemoteRelayPermission(value), String(value));
  }
});

test('header stripping agrees, for headers the contract writes', () => {
  const origins = [
    { relayName: 'win-test', conversationTitle: 'report builder', model: 'claude-sonnet-5' },
    { relayName: 'linux-test' },
    { relayName: 'relay "quoted" ]', conversationTitle: 'a ] b', model: '' },
  ];
  for (const origin of origins) {
    const text = withRemotePromptHeader('run the suite\nand report back', origin);
    assert.equal(mirror.stripRemotePromptHeader(text), stripRemotePromptHeader(text));
    assert.equal(mirror.stripRemotePromptHeader(text), 'run the suite\nand report back');
    assert.equal(mirror.stripRemotePromptHeader(formatRemotePromptHeader(origin)), stripRemotePromptHeader(formatRemotePromptHeader(origin)));
  }
  for (const text of ['', 'plain text', 'see [Remote prompt from an agent on relay "x" · acting for the user]\n\nlater']) {
    assert.equal(mirror.stripRemotePromptHeader(text), stripRemotePromptHeader(text));
  }
});

test('conversation links agree', () => {
  const cases = [
    ['https://relay-b.example.test', 'conv-1'],
    ['https://relay-b.example.test/', 'a b'],
    ['https://relay-b.example.test/oar/', ''],
    ['', 'conv-1'],
  ];
  for (const [base, id] of cases) {
    assert.equal(mirror.remoteConversationUrl(base, id), remoteConversationUrl(base, id), `${base} ${id}`);
  }
});

test('aliases and the composer mention query agree', () => {
  const relays = [
    { name: 'linux-test', url: 'https://relay-b.example.test/x' },
    { name: 'Win-Test', url: 'http://127.0.0.1:3351' },
    { name: 'lab-relay', url: 'http://localhost:8123' },
    { name: 'v6-test', url: 'http://[::1]:8123' },
    { name: '', url: 'http://192.168.10.20:3333' },
    { name: '', url: 'not a url' },
  ];
  for (const relay of relays) {
    assert.deepEqual(mirror.remoteRelayAliases(relay), remoteRelayAliases(relay));
  }
  for (const host of ['localhost', 'lab.localhost', '10.0.0.1', '[::1]', 'fd00::1', 'relay-b.example.test', 'devbox', '']) {
    assert.equal(mirror.isAddressHost(host), isAddressHost(host), host);
  }
  const inputs = [
    ['@', 1], ['@lin', 4], ['ask @linux-te', 13], ['mail@example', 12], ['(@win', 5],
    ['@file:', 6], ['@file:src/a.js', 14], ['x @a.b-c_d', 10], ['@lin more', 4], ['@lin more', 9],
    ['', 0], ['@@x', 3], ['"@q', 3],
  ];
  for (const [text, caret] of inputs) {
    assert.deepEqual(mirror.mentionQueryAt(text, caret), mentionQueryAt(text, caret), `${text} @${caret}`);
  }
});

test('mentionTokenEnd runs over the rest of the word the caret sits in', () => {
  assert.equal(mirror.mentionTokenEnd('@linux-test more', 4), 11);
  assert.equal(mirror.mentionTokenEnd('@lin', 4), 4);
  assert.equal(mirror.mentionTokenEnd('@lin:x', 4), 4);
});
