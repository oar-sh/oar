import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// preview-cards.mjs builds real DOM nodes (never innerHTML — a preview label is
// agent-supplied text), so it gets a real document rather than element stubs.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});

const clipboardWrites = [];
Object.defineProperty(dom.window.navigator, 'clipboard', {
  value: { writeText: async (text) => { clipboardWrites.push(text); } },
  configurable: true,
});

// apiFetch goes through the global fetch; intercepting there keeps the module
// graph real (no loader mocks) while still capturing the DELETE.
const fetchCalls = [];
let fetchResponder = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
globalThis.fetch = async (url, options = {}) => {
  fetchCalls.push({ url: String(url), method: options.method || 'GET' });
  return fetchResponder();
};

const { setNetworkRequestsEnabled } = await import('./api-client.js');
setNetworkRequestsEnabled(true);

const {
  buildPreviewRow,
  buildTranscriptPreviewCard,
  closePreview,
  getPreviews,
  getPreviewsForConversation,
  mergeConversationPreviews,
  renderPreviewRowsInto,
  setPreviews,
  subscribePreviews,
} = await import('./preview-cards.mjs');

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

function preview(overrides = {}) {
  return {
    token: TOKEN_A,
    conversationId: 'conv-1',
    label: 'web app',
    targetHost: '127.0.0.1',
    targetPort: 5173,
    url: `https://preview.example.com/test_${TOKEN_A}/`,
    basePath: `/test_${TOKEN_A}/`,
    createdAt: 1000,
    online: true,
    ...overrides,
  };
}

test.beforeEach(() => {
  setPreviews([]);
  fetchCalls.length = 0;
  clipboardWrites.length = 0;
  fetchResponder = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
});

test('setPreviews replaces the whole set and notifies subscribers', () => {
  const seen = [];
  const unsubscribe = subscribePreviews((entries) => seen.push(entries.length));
  setPreviews([preview(), preview({ token: TOKEN_B, targetPort: 5174 })]);
  assert.equal(getPreviews().length, 2);

  setPreviews([preview()]);
  assert.equal(getPreviews().length, 1);
  assert.deepEqual(seen, [2, 1]);
  unsubscribe();
});

test('entries without a token are discarded', () => {
  setPreviews([preview(), { label: 'no token' }, null, 'nonsense']);
  assert.equal(getPreviews().length, 1);
});

test('a conversation payload merges instead of replacing the global set', () => {
  // Opening a conversation must not erase other sessions' cards.
  setPreviews([preview({ token: TOKEN_B, conversationId: 'conv-2', targetPort: 5174 })]);
  mergeConversationPreviews('conv-1', [preview()]);

  assert.deepEqual(
    getPreviews().map((entry) => entry.conversationId).sort(),
    ['conv-1', 'conv-2'],
  );
  assert.deepEqual(getPreviewsForConversation('conv-1').map((e) => e.token), [TOKEN_A]);
  assert.deepEqual(getPreviewsForConversation(''), []);

  // An empty payload clears just that conversation.
  mergeConversationPreviews('conv-1', []);
  assert.deepEqual(getPreviews().map((entry) => entry.conversationId), ['conv-2']);
});

test('a preview row renders the label, target and public-link warning', () => {
  const row = buildPreviewRow(preview());
  assert.equal(row.querySelector('.preview-label').textContent, 'web app');
  assert.match(row.querySelector('.preview-detail').textContent, /:5173/);
  assert.match(row.querySelector('.preview-warning').textContent, /public link/i);
  assert.equal(row.dataset.token, TOKEN_A);
});

test('a label can never execute as markup', () => {
  const row = buildPreviewRow(preview({ label: '<img src=x onerror=alert(1)>' }));
  const label = row.querySelector('.preview-label');
  assert.equal(label.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(label.querySelector('img'), null);
});

test('Open is a new-tab link that cannot reach back into this window', () => {
  const open = buildPreviewRow(preview()).querySelector('.preview-open');
  assert.equal(open.tagName, 'A');
  assert.equal(open.getAttribute('href'), `https://preview.example.com/test_${TOKEN_A}/`);
  assert.equal(open.getAttribute('target'), '_blank');
  // The preview runs app code on another origin; it gets no window handle.
  assert.equal(open.getAttribute('rel'), 'noopener noreferrer');
});

test('Copy link writes the public URL to the clipboard', async () => {
  const copy = buildPreviewRow(preview()).querySelector('.preview-copy');
  copy.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(clipboardWrites, [`https://preview.example.com/test_${TOKEN_A}/`]);
  assert.equal(copy.textContent, 'Copied');
});

test('the online badge tracks health, and an unprobed preview shows none', () => {
  const online = buildPreviewRow(preview({ online: true }));
  assert.equal(online.querySelector('.preview-badge').textContent, 'online');
  assert.equal(online.classList.contains('preview-row-offline'), false);

  const offline = buildPreviewRow(preview({ online: false }));
  assert.equal(offline.querySelector('.preview-badge').textContent, 'offline');
  assert.equal(offline.classList.contains('preview-row-offline'), true);
  assert.match(offline.querySelector('.preview-detail').textContent, /dev server not responding/);

  // Never probed: no badge rather than a guess.
  const unknown = buildPreviewRow(preview({ online: null }));
  assert.equal(unknown.querySelector('.preview-badge'), null);
});

test('the settings variant names the owning session', () => {
  const row = buildPreviewRow(preview({ conversationId: 'conv-abcdef123456' }), { withConversation: true });
  assert.match(row.querySelector('.preview-detail').textContent, /session conv-abc/);

  const panelRow = buildPreviewRow(preview({ conversationId: 'conv-abcdef123456' }));
  assert.doesNotMatch(panelRow.querySelector('.preview-detail').textContent, /session/);
});

test('Close calls the API and removes the card optimistically', async () => {
  setPreviews([preview(), preview({ token: TOKEN_B, targetPort: 5174 })]);
  const row = buildPreviewRow(preview());
  row.querySelector('.preview-close').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(fetchCalls.map((call) => call.method), ['DELETE']);
  assert.match(fetchCalls[0].url, new RegExp(`/api/previews/${TOKEN_A}$`));
  assert.deepEqual(getPreviews().map((entry) => entry.token), [TOKEN_B]);
});

test('a failed close leaves the card in place so it can be retried', async () => {
  // apiFetch swallows failures and resolves to null, so a card dropped on a
  // failed DELETE would hide a link that is still publicly reachable.
  for (const responder of [
    () => { throw new Error('network down'); },
    () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
  ]) {
    fetchResponder = responder;
    setPreviews([preview()]);
    await closePreview(TOKEN_A);
    assert.deepEqual(getPreviews().map((entry) => entry.token), [TOKEN_A]);
  }
});

test('a transcript card for a live preview links; a closed one badges instead', () => {
  // Live: the snapshot's token is still in the registry.
  setPreviews([preview()]);
  const live = buildTranscriptPreviewCard(preview());
  assert.equal(live.classList.contains('msg-preview-card-closed'), false);
  const open = live.querySelector('.preview-open');
  assert.equal(open.getAttribute('href'), `https://preview.example.com/test_${TOKEN_A}/`);
  assert.equal(open.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(live.querySelector('.preview-copy') !== null, true);

  // Closed: registry no longer has the token — the persisted snapshot still
  // renders, but with the dead link dropped for a badge.
  setPreviews([]);
  const closed = buildTranscriptPreviewCard(preview());
  assert.equal(closed.classList.contains('msg-preview-card-closed'), true);
  assert.equal(closed.querySelector('.preview-open'), null);
  assert.equal(closed.querySelector('.preview-badge').textContent, 'closed');
  assert.equal(closed.querySelector('.preview-label').textContent, 'web app');

  assert.equal(buildTranscriptPreviewCard(null), null);
  assert.equal(buildTranscriptPreviewCard({ label: 'no token' }), null);
});

test('a transcript card drawn before the registry arrived turns live when it does, and closed when the preview goes', () => {
  // A page load renders the transcript first and learns the live previews
  // after; the card must not stay "closed" for a link that still works.
  setPreviews([]);
  const holder = document.createElement('div');
  document.body.appendChild(holder);
  holder.appendChild(buildTranscriptPreviewCard(preview()));
  assert.ok(holder.querySelector('.msg-preview-card-closed'));

  setPreviews([preview()]);
  const live = holder.querySelector('.msg-preview-card');
  assert.equal(live.classList.contains('msg-preview-card-closed'), false);
  assert.equal(live.querySelector('.preview-open').getAttribute('href'), `https://preview.example.com/test_${TOKEN_A}/`);
  assert.equal(holder.querySelectorAll('.msg-preview-card').length, 1);

  setPreviews([]);
  assert.ok(holder.querySelector('.msg-preview-card-closed'));
  assert.equal(holder.querySelectorAll('.msg-preview-card').length, 1);
  holder.remove();
});

test('a transcript card opens and copies the live link after the public address changed', async () => {
  // The snapshot was published under the old address; the restored registry
  // rebuilt the link from the current settings.
  const moved = `https://moved.example.com/test_${TOKEN_A}/`;
  setPreviews([preview({ url: moved })]);
  const card = buildTranscriptPreviewCard(preview());
  assert.equal(card.querySelector('.preview-open').getAttribute('href'), moved);
  clipboardWrites.length = 0;
  card.querySelector('.preview-copy').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(clipboardWrites, [moved]);

  // A card already on screen follows when the registry learns the new address.
  setPreviews([preview()]);
  const holder = document.createElement('div');
  document.body.appendChild(holder);
  holder.appendChild(buildTranscriptPreviewCard(preview()));
  assert.equal(holder.querySelector('.preview-open').getAttribute('href'), `https://preview.example.com/test_${TOKEN_A}/`);
  setPreviews([preview({ url: moved })]);
  assert.equal(holder.querySelector('.preview-open').getAttribute('href'), moved);
  assert.equal(holder.querySelectorAll('.msg-preview-card').length, 1);
  holder.remove();
  setPreviews([]);
});

test('the settings variant shows when a preview was published and last opened', () => {
  const now = 10 * 3_600_000;
  const opened = buildPreviewRow(
    preview({ createdAt: now - 3 * 3_600_000, lastHitAt: now - 5 * 60_000 }),
    { withConversation: true, withAge: true, now },
  );
  assert.match(opened.querySelector('.preview-detail').textContent, /published 3 h ago · last opened 5 min ago/);

  const unopened = buildPreviewRow(preview({ createdAt: now }), { withAge: true, now: now + 3 * 86_400_000 });
  assert.match(unopened.querySelector('.preview-detail').textContent, /published 3 d ago · never opened/);

  const panelRow = buildPreviewRow(preview({ lastHitAt: 2000 }));
  assert.doesNotMatch(panelRow.querySelector('.preview-detail').textContent, /published|opened/);
});

test('a shared transcript card without token or link renders a note, never a link', () => {
  setPreviews([preview()]);
  const card = buildTranscriptPreviewCard({ label: 'web app', mode: 'port', redacted: true });
  assert.ok(card.classList.contains('msg-preview-card-redacted'));
  assert.equal(card.querySelector('.preview-label').textContent, 'web app');
  assert.equal(card.querySelector('.preview-detail').textContent, 'preview link not shared');
  assert.equal(card.querySelector('a'), null);
  assert.equal(card.querySelector('button'), null);
  assert.ok(!card.textContent.includes('test_'));
});

test('renderPreviewRowsInto replaces prior content', () => {
  const container = document.createElement('div');
  container.appendChild(document.createElement('span'));

  const count = renderPreviewRowsInto(container, [preview(), preview({ token: TOKEN_B })]);
  assert.equal(count, 2);
  assert.equal(container.querySelectorAll('.preview-row').length, 2);
  assert.equal(container.querySelectorAll('span').length > 0, true);

  renderPreviewRowsInto(container, []);
  assert.equal(container.children.length, 0);
});

test('a preview the relay could not check yet shows as not served, without a link, and can be closed', () => {
  const held = preview({ online: false, unverified: true });
  setPreviews([held]);
  const row = buildPreviewRow(getPreviews()[0], { withConversation: true });
  assert.match(row.querySelector('.preview-detail').textContent, /not served — could not be checked after the restart/);
  assert.doesNotMatch(row.querySelector('.preview-detail').textContent, /dev server not responding/);
  assert.equal(row.querySelector('.preview-open'), null);
  assert.equal(row.querySelector('.preview-copy'), null);
  assert.notEqual(row.querySelector('.preview-close'), null);

  // Its transcript card offers no link either, until the check passes.
  const card = buildTranscriptPreviewCard(preview());
  assert.equal(card.classList.contains('msg-preview-card-closed'), true);
  assert.equal(card.querySelector('.preview-open'), null);
  document.body.appendChild(card);
  setPreviews([preview({ online: true })]);
  assert.notEqual(document.body.querySelector('.msg-preview-card .preview-open'), null);
  document.body.textContent = '';
  setPreviews([]);
});
