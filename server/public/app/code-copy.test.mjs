import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// code-copy.mjs is DOM-bound through and through (element injection, a
// document-level delegated listener, Clipboard API with an execCommand
// fallback), so it gets a real DOM instead of the global stubs the other
// browser-module suites use.
//
// One JSDOM instance for the whole file: the module binds its delegated
// listener once per import, so every test must share the document that
// listener is attached to.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
// Node ships a read-only `navigator` getter; replace it so the module sees
// the JSDOM one (whose clipboard the tests stub per-case).
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});

const { attachCodeCopyButtons } = await import('./code-copy.mjs');

const clipboardWrites = [];
Object.defineProperty(dom.window.navigator, 'clipboard', {
  value: {
    writeText: async (text) => {
      clipboardWrites.push(text);
    },
  },
  configurable: true,
});

function renderBlock(codeText) {
  const host = document.createElement('div');
  host.innerHTML = `<pre><code>${codeText}</code></pre>`;
  document.body.appendChild(host);
  return host;
}

function click(element) {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  // The delegated handler is async (clipboard write); let its microtasks run.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('attach injects one button per code block and anchors the pre', () => {
  const host = renderBlock('const a = 1;');
  attachCodeCopyButtons(host);
  const pre = host.querySelector('pre');
  assert.equal(pre.querySelectorAll('.code-copy-btn').length, 1);
  assert.ok(pre.classList.contains('has-code-copy'), 'the positioning anchor class rides along');
  // Idempotent: streaming re-enhancement passes hit the same nodes again.
  attachCodeCopyButtons(host);
  attachCodeCopyButtons(pre);
  assert.equal(pre.querySelectorAll('.code-copy-btn').length, 1, 'repeat passes must not stack buttons');
  host.remove();
});

test('a pre without code (or a non-element root) is left alone', () => {
  const host = document.createElement('div');
  host.innerHTML = '<pre>bare preformatted text</pre>';
  document.body.appendChild(host);
  attachCodeCopyButtons(host);
  assert.equal(host.querySelectorAll('.code-copy-btn').length, 0);
  attachCodeCopyButtons(null);
  attachCodeCopyButtons(undefined);
  host.remove();
});

test('clicking copies the code text, not the button label, and shows feedback', async () => {
  const host = renderBlock('echo "hello phone"');
  attachCodeCopyButtons(host);
  const btn = host.querySelector('.code-copy-btn');
  clipboardWrites.length = 0;
  await click(btn);
  assert.deepEqual(clipboardWrites, ['echo "hello phone"'], 'the button label must never ride along');
  assert.equal(btn.textContent, '✓ Copied');
  assert.ok(btn.classList.contains('is-copied'));
  host.remove();
});

test('delegation survives nodes injected after the listener was bound', async () => {
  // Transcript bubbles are re-rendered constantly; the delegated listener on
  // the document is what keeps later-injected buttons working.
  const host = renderBlock('later block');
  attachCodeCopyButtons(host);
  clipboardWrites.length = 0;
  await click(host.querySelector('.code-copy-btn'));
  assert.deepEqual(clipboardWrites, ['later block']);
  host.remove();
});

test('the execCommand fallback covers a missing Clipboard API', async () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(dom.window.navigator, 'clipboard');
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: undefined, configurable: true });
  const execCalls = [];
  dom.window.document.execCommand = (command) => {
    execCalls.push([command, document.querySelector('textarea')?.value]);
    return true;
  };
  try {
    const host = renderBlock('fallback text');
    attachCodeCopyButtons(host);
    const btn = host.querySelector('.code-copy-btn');
    await click(btn);
    assert.deepEqual(execCalls, [['copy', 'fallback text']], 'the hidden textarea carries the code text');
    assert.equal(btn.textContent, '✓ Copied');
    assert.equal(document.querySelector('textarea'), null, 'the helper textarea is removed');
    host.remove();
  } finally {
    Object.defineProperty(dom.window.navigator, 'clipboard', clipboardDescriptor);
    delete dom.window.document.execCommand;
  }
});

test('a failed copy says so instead of claiming success', async () => {
  const original = dom.window.navigator.clipboard.writeText;
  dom.window.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  // No execCommand either, so both paths fail.
  try {
    const host = renderBlock('unreachable');
    attachCodeCopyButtons(host);
    const btn = host.querySelector('.code-copy-btn');
    await click(btn);
    assert.equal(btn.textContent, 'Copy failed');
    assert.equal(btn.classList.contains('is-copied'), false);
    host.remove();
  } finally {
    dom.window.navigator.clipboard.writeText = original;
  }
});
