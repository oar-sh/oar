import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// The unit DOM cannot compute styles, so pin the CSS contract: with
// interactive-widget=resizes-content the on-screen keyboard shrinks the
// viewport, so a viewport unit in the phone-landscape text rule shrinks the
// text whenever the keyboard opens.
test('phone-landscape text size reads the screen, never the viewport', () => {
  const query = '@media (pointer: coarse) and (orientation: landscape) and (max-height: 500px)';
  const rules = [];
  for (let at = html.indexOf(query); at !== -1; at = html.indexOf(query, at + 1)) {
    const innerOpen = html.indexOf('{', html.indexOf('{', at) + 1);
    rules.push(html.slice(at, html.indexOf('}', innerOpen) + 1));
  }
  const textRule = rules.find((rule) => /font-size\s*:/.test(rule));
  assert.ok(textRule, 'the coarse-landscape text-size rule exists');
  assert.match(textRule, /var\(--screen-short-side\)/);
  assert.doesNotMatch(textRule, /\d(?:vh|svh|lvh|dvh|vmin|vmax|vw)\b/);
  assert.match(textRule, /\[data-phone-screen\]/, 'tablets (no data-phone-screen) keep their own size');
});

test('the screen short side is set before first paint', () => {
  assert.match(html, /applyScreenShortSideEarly[\s\S]*?setProperty\('--screen-short-side'/);
  assert.match(html, /toggleAttribute\('data-phone-screen', shortSide <= 500\)/);
});

// The zoom scales the whole UI: the stylesheet's px sizes are written as
// calc(Npx * var(--ui-scale)), and --ui-scale follows --font-scale.
test('the stylesheet derives --ui-scale from --font-scale and sizes with it', () => {
  assert.match(html, /--ui-scale:\s*var\(--font-scale,\s*1\)/);
  const styleStart = html.indexOf('<style>\n  * { box-sizing');
  const css = html.slice(styleStart, html.indexOf('</style>', styleStart));
  const scaled = (css.match(/calc\(-?\d+(?:\.\d+)?px \* var\(--ui-scale\)\)/g) || []).length;
  assert.ok(scaled > 1000, `px sizes scale with --ui-scale (${scaled})`);
  // Breakpoints cannot use var(): none of them was rewritten.
  assert.doesNotMatch(css, /@media[^{]*var\(--ui-scale\)/);
  // The iOS focus-zoom floor keeps its literal 16px.
  assert.match(css, /max\(16px, 1rem\)/);
});

test('getUiScale reads the inline --font-scale and falls back to 1', async () => {
  const { getUiScale } = await import('./font-scaling.js');
  assert.equal(getUiScale(), 1, 'no document: 1');
  const values = {};
  globalThis.document = {
    documentElement: {
      style: { getPropertyValue: (name) => values[name] ?? '' },
    },
  };
  try {
    assert.equal(getUiScale(), 1, 'nothing set yet: 1');
    values['--font-scale'] = '1.3';
    assert.equal(getUiScale(), 1.3);
    values['--font-scale'] = '0.7500';
    assert.equal(getUiScale(), 0.75);
    values['--font-scale'] = 'abc';
    assert.equal(getUiScale(), 1, 'garbage: 1');
    values['--font-scale'] = '9';
    assert.equal(getUiScale(), 1.5, 'clamped to the zoom range');
  } finally {
    delete globalThis.document;
  }
});
