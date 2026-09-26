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
