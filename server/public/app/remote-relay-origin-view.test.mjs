import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  ORIGIN_TITLE_MAX,
  ORIGIN_TITLE_MAX_SIDEBAR,
  isLocalAgentOrigin,
  localAgentOriginModel,
  normalizeRemoteOrigin,
  remoteOriginBadgeText,
  remoteOriginLink,
  renderConversationHeaderOriginHtml,
  renderConversationOriginMarkerHtml,
  renderRemoteOriginBadgeHtml,
  truncateOriginTitle,
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

// ─── An agent on this relay (origin.local) ───────────────────────────────────

// What the relay stores for a conversation an agent on it created: the paired
// relay's fields may ride along, `local` is what tells the two apart.
const LOCAL_ORIGIN = {
  kind: 'agent',
  local: true,
  relayId: 'relay-a',
  relayName: 'win-test',
  relayUrl: 'https://relay-a.example.test',
  conversationId: 'conv-lead',
  conversationTitle: 'release checklist',
  provider: 'claude',
  model: 'claude-sonnet-5',
};
const CREATED = { id: 'conv-made', title: 'docs pass', origin: LOCAL_ORIGIN };
const LIST = {
  'conv-lead': { id: 'conv-lead', title: 'release checklist' },
  'conv-made': CREATED,
};

test('only `local: true` makes an origin a local one', () => {
  assert.equal(isLocalAgentOrigin(LOCAL_ORIGIN), true);
  assert.equal(isLocalAgentOrigin({ local: true }), true);
  for (const origin of [ORIGIN, { ...ORIGIN, local: false }, { ...ORIGIN, local: 'true' }, { ...ORIGIN, local: 1 }, null, undefined, 'x', [], {}]) {
    assert.equal(isLocalAgentOrigin(origin), false);
    assert.equal(localAgentOriginModel(origin, { conversations: LIST }), null);
  }
});

test('an origin without `local` renders exactly as before, whatever else is passed', () => {
  const conversation = { id: 'c1', title: 'report builder', origin: ORIGIN };
  const list = { 'conv-a': { id: 'conv-a', title: 'report builder' } };
  assert.equal(
    renderConversationOriginMarkerHtml(conversation, { conversations: list }),
    renderConversationOriginMarkerHtml(conversation),
  );
  assert.equal(
    renderConversationOriginMarkerHtml(conversation),
    '<span class="conv-origin-marker" title="Started by an agent on relay win-test">↗ win-test</span>',
  );
  assert.equal(renderRemoteOriginBadgeHtml(ORIGIN, { conversations: list }), renderRemoteOriginBadgeHtml(ORIGIN));
  assert.equal(remoteOriginBadgeText(ORIGIN, { conversations: list }), remoteOriginBadgeText(ORIGIN));
  assert.equal(renderConversationHeaderOriginHtml(conversation, { conversations: list }), '');
});

test('titles are cut to one line with an ellipsis', () => {
  assert.equal(truncateOriginTitle('release checklist'), 'release checklist');
  assert.equal(truncateOriginTitle('  release\n  checklist  '), 'release checklist');
  assert.equal(truncateOriginTitle('release checklist', 10), 'release c…');
  // No blank before the ellipsis.
  assert.equal(truncateOriginTitle('release checklist', 9), 'release…');
  assert.equal(truncateOriginTitle('abcdefghij', 10), 'abcdefghij');
  // By code point: no half emoji.
  assert.equal(truncateOriginTitle('📦📦📦📦📦', 3), '📦📦…');
  assert.equal(truncateOriginTitle(null), '');
  const long = 'x'.repeat(200);
  assert.equal(Array.from(truncateOriginTitle(long)).length, ORIGIN_TITLE_MAX);
  assert.equal(Array.from(truncateOriginTitle(long, ORIGIN_TITLE_MAX_SIDEBAR)).length, ORIGIN_TITLE_MAX_SIDEBAR);
});

test('the local model links only while the orchestrating conversation is in the list', () => {
  const linked = localAgentOriginModel(LOCAL_ORIGIN, { conversations: LIST });
  assert.deepEqual(linked, {
    conversationId: 'conv-lead',
    fullTitle: 'release checklist',
    title: 'release checklist',
    model: 'claude-sonnet-5',
    text: 'via agent · “release checklist”',
    linkable: true,
  });
  // Gone from the list, no list at all, or told not to link: plain text.
  assert.equal(localAgentOriginModel(LOCAL_ORIGIN, { conversations: {} }).linkable, false);
  assert.equal(localAgentOriginModel(LOCAL_ORIGIN).linkable, false);
  assert.equal(localAgentOriginModel(LOCAL_ORIGIN, { conversations: LIST, linkable: false }).linkable, false);
  // Never a link to the conversation the marker sits on, or to an object's own members.
  assert.equal(localAgentOriginModel(LOCAL_ORIGIN, { conversations: LIST, ownId: 'conv-lead' }).linkable, false);
  assert.equal(localAgentOriginModel({ local: true, conversationId: 'constructor' }, { conversations: LIST }).linkable, false);
  assert.equal(localAgentOriginModel({ local: true }, { conversations: LIST }).linkable, false);
});

test('the marker shows the orchestrating conversation\'s current title', () => {
  // Renamed since the session was created: the list knows better.
  const renamed = { ...LIST, 'conv-lead': { id: 'conv-lead', title: 'release 2 checklist' } };
  assert.equal(localAgentOriginModel(LOCAL_ORIGIN, { conversations: renamed }).text, 'via agent · “release 2 checklist”');
  // Deleted: the title it had when the session was created.
  assert.equal(localAgentOriginModel(LOCAL_ORIGIN, { conversations: {} }).text, 'via agent · “release checklist”');
  // No title anywhere.
  assert.equal(localAgentOriginModel({ local: true, conversationId: 'conv-lead' }).text, 'via agent');
  const long = localAgentOriginModel({ ...LOCAL_ORIGIN, conversationTitle: 'y'.repeat(90) }, { maxTitleLength: 12 });
  assert.equal(long.text, `via agent · “${'y'.repeat(11)}…”`);
  assert.equal(long.fullTitle, 'y'.repeat(90));
});

test('the sidebar marker of a local origin opens the orchestrating conversation', () => {
  const body = parse(renderConversationOriginMarkerHtml(CREATED, { conversations: LIST }));
  const marker = body.querySelector('button.conv-origin-marker.conv-origin-agent');
  assert.ok(marker, 'a button, not a link to another relay');
  assert.equal(body.querySelector('a'), null);
  assert.equal(marker.getAttribute('type'), 'button');
  assert.equal(marker.textContent, 'via agent · “release checklist”');
  assert.equal(marker.dataset.originConversationId, 'conv-lead');
  assert.equal(marker.getAttribute('onclick'), 'openOriginConversation(event, this)');
  assert.equal(marker.getAttribute('title'), 'Started by an agent in “release checklist”. Opens that conversation.');
  // This relay's own name is not what the marker shows.
  assert.doesNotMatch(marker.textContent, /win-test/);
});

test('the sidebar marker is plain text once the orchestrating conversation is gone', () => {
  for (const options of [{ conversations: { 'conv-made': CREATED } }, {}, { conversations: LIST, linkable: false }]) {
    const body = parse(renderConversationOriginMarkerHtml(CREATED, options));
    assert.equal(body.querySelector('button'), null);
    assert.equal(body.querySelector('a'), null);
    const marker = body.querySelector('span.conv-origin-marker.conv-origin-agent');
    assert.equal(marker.textContent, 'via agent · “release checklist”');
    assert.equal(marker.getAttribute('title'), 'Started by an agent in “release checklist”.');
    assert.equal(marker.hasAttribute('onclick'), false);
  }
  const untitled = parse(renderConversationOriginMarkerHtml({ id: 'c9', origin: { local: true } }));
  assert.equal(untitled.querySelector('.conv-origin-marker').textContent, 'via agent');
  assert.equal(untitled.querySelector('.conv-origin-marker').getAttribute('title'), 'Started by an agent in another conversation on this relay.');
});

test('the sidebar cuts the title shorter than the header does', () => {
  const title = 'a rather long conversation title that would push the date out of the row';
  const list = { ...LIST, 'conv-lead': { id: 'conv-lead', title } };
  const sidebar = parse(renderConversationOriginMarkerHtml(CREATED, { conversations: list })).querySelector('button');
  const header = parse(renderConversationHeaderOriginHtml(CREATED, { conversations: list })).querySelector('button');
  assert.equal(sidebar.textContent, `via agent · “${truncateOriginTitle(title, ORIGIN_TITLE_MAX_SIDEBAR)}”`);
  assert.equal(header.textContent, `via agent · “${truncateOriginTitle(title, ORIGIN_TITLE_MAX)}”`);
  assert.ok(sidebar.textContent.length < header.textContent.length);
  // The tooltip carries the whole title.
  assert.match(sidebar.getAttribute('title'), new RegExp(title));
});

test('the header marker exists for a local origin only', () => {
  const header = parse(renderConversationHeaderOriginHtml(CREATED, { conversations: LIST })).querySelector('button.conv-origin-agent');
  assert.equal(header.textContent, 'via agent · “release checklist”');
  assert.equal(header.dataset.originConversationId, 'conv-lead');
  assert.equal(header.classList.contains('conv-origin-marker'), false);
  const gone = parse(renderConversationHeaderOriginHtml(CREATED, { conversations: {} }));
  assert.equal(gone.querySelector('button'), null);
  assert.equal(gone.querySelector('span.conv-origin-agent').textContent, 'via agent · “release checklist”');
  for (const conversation of [null, {}, { id: 'c1' }, { id: 'c1', origin: null }, { id: 'c1', origin: ORIGIN }]) {
    assert.equal(renderConversationHeaderOriginHtml(conversation, { conversations: LIST }), '');
  }
});

test('a local agent\'s message badge reads "via agent" and opens the conversation', () => {
  assert.equal(remoteOriginBadgeText(LOCAL_ORIGIN), 'via agent · “release checklist” · claude-sonnet-5');
  assert.equal(remoteOriginBadgeText({ local: true }), 'via agent');
  const body = parse(renderRemoteOriginBadgeHtml(LOCAL_ORIGIN, { conversations: LIST }));
  const badge = body.querySelector('.msg-origin button.msg-origin-badge.msg-origin-agent');
  assert.ok(badge);
  assert.equal(body.querySelector('a'), null, 'no link to another relay, even with a relay URL in the origin');
  assert.equal(badge.textContent, 'via agent · “release checklist” · claude-sonnet-5');
  assert.equal(badge.dataset.originConversationId, 'conv-lead');
  assert.equal(badge.getAttribute('title'), 'Sent by an agent in “release checklist”. Opens that conversation.');
  // The shared view, or a conversation that is gone: the same text, inert.
  for (const options of [{ conversations: LIST, linkable: false }, { conversations: {} }, {}]) {
    const plain = parse(renderRemoteOriginBadgeHtml(LOCAL_ORIGIN, options));
    assert.equal(plain.querySelector('button'), null);
    assert.equal(plain.querySelector('a'), null);
    assert.equal(plain.querySelector('span.msg-origin-badge').textContent, 'via agent · “release checklist” · claude-sonnet-5');
  }
});

test('every field of a local origin renders inertly', () => {
  const hostile = {
    local: true,
    conversationId: '" onclick="alert(1)',
    conversationTitle: '"><script>alert(1)</script><img src=x onerror=alert(1)>',
    model: '<b>m</b>',
  };
  const list = { [hostile.conversationId]: { id: hostile.conversationId, title: '<i>live</i> "title"' } };
  for (const html of [
    renderConversationOriginMarkerHtml({ id: 'c1', origin: hostile }, { conversations: list }),
    renderConversationHeaderOriginHtml({ id: 'c1', origin: hostile }, { conversations: list }),
    renderRemoteOriginBadgeHtml(hostile, { conversations: list }),
    renderConversationOriginMarkerHtml({ id: 'c1', origin: hostile }),
    renderRemoteOriginBadgeHtml(hostile),
  ]) {
    const body = parse(html);
    for (const tag of ['script', 'img', 'b', 'i']) assert.equal(body.querySelector(tag), null);
    const button = body.querySelector('button');
    if (button) {
      // The id stays one attribute value; the only handler is the app's own.
      assert.equal(button.dataset.originConversationId, hostile.conversationId);
      assert.equal(button.getAttribute('onclick'), 'openOriginConversation(event, this)');
      assert.match(button.textContent, /<i>live<\/i> "title"/);
    } else {
      assert.match(body.textContent, /<script>alert\(1\)<\/script>/);
    }
  }
});
