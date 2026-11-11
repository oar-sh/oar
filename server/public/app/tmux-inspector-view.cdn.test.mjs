import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// xterm.js moved to the @xterm scope after 5.3.0: the unscoped xterm@5.5.0 and
// xterm-addon-fit@0.10.0 never existed, and their CDN URLs answer 404.
const read = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const indexHtml = await read('../index.html');
const loaderSource = await read('./tmux-inspector-view.js');
// The view's imports bind to the page's elements; jsdom runs no page scripts.
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const {
  XTERM_STYLE_CANDIDATES,
  XTERM_SCRIPT_CANDIDATES,
  XTERM_FIT_SCRIPT_CANDIDATES,
} = await import('./tmux-inspector-view.js');

const PINNED = [
  { file: '@xterm/xterm@5.5.0/css/xterm.css', candidates: XTERM_STYLE_CANDIDATES },
  { file: '@xterm/xterm@5.5.0/lib/xterm.js', candidates: XTERM_SCRIPT_CANDIDATES },
  { file: '@xterm/addon-fit@0.10.0/lib/addon-fit.js', candidates: XTERM_FIT_SCRIPT_CANDIDATES },
];
const SRI = /^sha384-[A-Za-z0-9+/]{64}$/;

test('the page loads the scoped xterm packages at the pinned version, each with a hash', () => {
  const tags = indexHtml.split('\n').filter((line) => /xterm/.test(line) && /<(link|script)\b/.test(line));
  assert.equal(tags.length, PINNED.length, 'one tag per file: the stylesheet, xterm and the fit addon');
  for (const { file } of PINNED) {
    const tag = tags.find((line) => line.includes(`"https://cdn.jsdelivr.net/npm/${file}"`));
    assert.ok(tag, `${file} is loaded`);
    const integrity = tag.match(/integrity="([^"]+)"/)?.[1] || '';
    assert.match(integrity, SRI, `${file} carries a sha384 integrity`);
    assert.ok(tag.includes('crossorigin="anonymous"'), `${file}: a cross-origin integrity check needs crossorigin`);
  }
});

test('the lazy loader falls back to the same files and hashes as the page', () => {
  for (const { file, candidates } of PINNED) {
    assert.deepEqual(candidates.map(({ url }) => url), [
      `https://cdn.jsdelivr.net/npm/${file}`,
      `https://unpkg.com/${file}`,
    ]);
    const tag = indexHtml.split('\n').find((line) => line.includes(`"https://cdn.jsdelivr.net/npm/${file}"`));
    const integrity = tag?.match(/integrity="([^"]+)"/)?.[1];
    for (const candidate of candidates) {
      assert.equal(candidate.integrity, integrity, `${candidate.url}: the page's hash, so either CDN must serve the same bytes`);
    }
  }
});

test('no unscoped xterm URL is left', () => {
  for (const [name, source] of [['index.html', indexHtml], ['tmux-inspector-view.js', loaderSource]]) {
    assert.doesNotMatch(source, /\/(?:npm\/|unpkg\.com\/)xterm(?:-addon-[a-z-]+)?@/, `${name} names an unscoped xterm package`);
  }
});
