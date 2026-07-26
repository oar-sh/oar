import test from 'node:test';
import assert from 'node:assert/strict';

const listenerTarget = { addEventListener() {} };
globalThis.window = {
  location: { pathname: '/' },
  innerHeight: 0,
  addEventListener() {},
};
globalThis.document = {
  documentElement: { clientHeight: 0 },
  addEventListener() {},
  getElementById() { return listenerTarget; },
  createElement() {
    let value = '';
    return {
      content: { querySelectorAll() { return []; } },
      set innerHTML(next) { value = next; },
      get innerHTML() { return value; },
    };
  },
};
globalThis.sessionStorage = {
  getItem() { return ''; },
  setItem() {},
};
globalThis.marked = {
  setOptions() {},
  Renderer: class {},
  parse(source) {
    return `<p><strong>rendered</strong> ${String(source || '')}</p>`;
  },
};

const { renderThoughtsMarkup, setLiveThinkingThoughtState } = await import('./conversation-view.js');

test('renders each final thought as markdown content under one collapsed thoughts panel', () => {
  const markup = renderThoughtsMarkup([
    { reasoningId: 'section-1', text: 'First paragraph.\n\nSecond paragraph.' },
    { reasoningId: 'section-2', text: '- one\n- two' },
  ]);

  assert.match(markup, /<details class="msg-thoughts">/);
  assert.match(markup, /💭 Thoughts \(2\)/);
  assert.match(markup, /data-reasoning-id="section-1"/);
  assert.match(markup, /data-reasoning-id="section-2"/);
  assert.match(markup, /<strong>rendered<\/strong> First paragraph/);
  assert.match(markup, /<strong>rendered<\/strong> - one/);
});

test('keeps live thought rows expanded until the active turn is replaced', () => {
  const row = { dataset: {}, open: false };

  setLiveThinkingThoughtState(row, true);

  assert.equal(row.dataset.done, '1');
  assert.equal(row.open, true);
});
