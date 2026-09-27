import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  normalizeRemoteOrigin,
  remoteOriginBadgeText,
  remoteOriginLink,
  renderConversationOriginMarkerHtml,
  renderRemoteOriginBadgeHtml,
} from './remote-relay-origin-view.mjs';

const ORIGIN = {
  kind: 'agent',
  relayId: 'relay-a',
  relayName: 'win-test',
  relayUrl: 'https://relay-a.example.test',
  conversationId: 'conv-a',
  conversationTitle: 'report builder',
  provider: 'claude',
  model: 'claude-sonnet-5',
  hops: 1,
};

function parse(html) {
  return new JSDOM(`<body>${html}</body>`).window.document.body;
}

test('the badge reads "↗ from relay · “title” · model" and links to the source session', () => {
  assert.equal(remoteOriginBadgeText(ORIGIN), '↗ from win-test · “report builder” · claude-sonnet-5');
  assert.equal(remoteOriginLink(ORIGIN), 'https://relay-a.example.test/?conv=conv-a');
  const body = parse(renderRemoteOriginBadgeHtml(ORIGIN));
  const link = body.querySelector('.msg-origin a.msg-origin-badge');
  assert.ok(link);
  assert.equal(link.getAttribute('href'), 'https://relay-a.example.test/?conv=conv-a');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.match(link.getAttribute('rel'), /noopener/);
  assert.equal(link.textContent, '↗ from win-test · “report builder” · claude-sonnet-5');
});

test('missing parts are left out', () => {
  assert.equal(remoteOriginBadgeText({ relayName: 'linux-test' }), '↗ from linux-test');
  assert.equal(remoteOriginBadgeText({ relayName: 'linux-test', model: 'gpt-5.6-luna' }), '↗ from linux-test · gpt-5.6-luna');
  assert.equal(remoteOriginBadgeText({ relayId: 'relay-b', conversationTitle: 'sidebar polish' }), '↗ from relay-b · “sidebar polish”');
  // No relay URL: a plain badge, no link.
  const body = parse(renderRemoteOriginBadgeHtml({ relayName: 'linux-test' }));
  assert.equal(body.querySelector('a'), null);
  assert.equal(body.querySelector('span.msg-origin-badge').textContent, '↗ from linux-test');
  // A relay URL without a conversation opens the relay itself.
  assert.equal(remoteOriginLink({ relayName: 'x', relayUrl: 'https://relay-b.example.test/' }), 'https://relay-b.example.test/');
});

test('no badge without an origin that names a relay', () => {
  for (const origin of [null, undefined, 'x', [], {}, { model: 'm' }]) {
    assert.equal(renderRemoteOriginBadgeHtml(origin), '');
    assert.equal(normalizeRemoteOrigin(origin), null);
  }
});

test('the shared view gets the badge without the link', () => {
  const body = parse(renderRemoteOriginBadgeHtml(ORIGIN, { linkable: false }));
  assert.equal(body.querySelector('a'), null);
  assert.equal(body.querySelector('.msg-origin-badge').textContent, remoteOriginBadgeText(ORIGIN));
});

test('only http(s) relay URLs become links, and every field renders inertly', () => {
  const hostile = {
    relayName: '<img src=x onerror=alert(1)>',
    relayUrl: 'javascript:alert(1)',
    conversationTitle: '"><script>alert(1)</script>',
    model: '<b>m</b>',
  };
  const body = parse(renderRemoteOriginBadgeHtml(hostile));
  assert.equal(body.querySelector('a'), null);
  assert.equal(body.querySelector('img'), null);
  assert.equal(body.querySelector('script'), null);
  assert.equal(body.querySelector('b'), null);
  assert.match(body.textContent, /<img src=x onerror=alert\(1\)>/);

  const quoted = parse(renderRemoteOriginBadgeHtml({ relayName: 'a', relayUrl: 'https://relay-b.example.test', conversationId: '" onclick="x' }));
  const link = quoted.querySelector('a');
  assert.equal(link.getAttribute('onclick'), null);
  assert.equal(link.getAttribute('href'), 'https://relay-b.example.test/?conv=%22%20onclick%3D%22x');
});

test('the sidebar marker names the relay that started the conversation', () => {
  const body = parse(renderConversationOriginMarkerHtml({ id: 'c1', title: 'report builder', origin: ORIGIN }));
  const marker = body.querySelector('.conv-origin-marker');
  assert.equal(marker.textContent, '↗ win-test');
  assert.match(marker.getAttribute('title'), /win-test/);
  assert.equal(renderConversationOriginMarkerHtml({ id: 'c2', title: 'local' }), '');
  assert.equal(renderConversationOriginMarkerHtml(null), '');
  assert.equal(parse(renderConversationOriginMarkerHtml({ origin: { relayName: '<i>x</i>' } })).querySelector('i'), null);
});
