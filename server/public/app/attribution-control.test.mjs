import test from 'node:test';
import assert from 'node:assert/strict';

import { attributionEffectText, renderAttributionControlHtml } from './attribution-control.mjs';

// platform-agnostic: the row shows the folder path as text and never
// interprets its shape; the win32 path below only checks the escaping.

test('the row names the folder, selects the folder override and explains the effect', () => {
  const html = renderAttributionControlHtml({
    path: 'C:\\Users\\dev\\demo',
    attributionMode: 'off',
    providerMode: 'oar',
    effectiveMode: 'off',
    attributionExample: '',
  });
  assert.match(html, /data-workspace-root="C:\\Users\\dev\\demo"/);
  assert.match(html, /<option value="off" selected>Off — none<\/option>/);
  assert.match(html, /<option value="">Inherit \(provider: OAR\)<\/option>/);
  assert.match(html, /carry no attribution line/);
});

test('inherit is selected when the folder has no override, and the trailer is shown', () => {
  const html = renderAttributionControlHtml({
    path: '/home/dev/demo',
    attributionMode: null,
    providerMode: 'oar',
    effectiveMode: 'oar',
    attributionExample: 'Co-authored-by: Open Agent Relay (Claude Sonnet 5) <no-reply@oar.sh>',
  });
  assert.match(html, /<option value="" selected>Inherit \(provider: OAR\)<\/option>/);
  assert.match(html, /Commits end with: Co-authored-by: Open Agent Relay \(Claude Sonnet 5\) &lt;no-reply@oar\.sh&gt;/);
  assert.equal(renderAttributionControlHtml(null), '');
  assert.equal(renderAttributionControlHtml({ path: '' }), '');
});

test('the effect text follows the effective mode', () => {
  assert.match(attributionEffectText({ effectiveMode: 'vanilla' }), /Claude Code's own/);
  assert.match(attributionEffectText({ effectiveMode: 'off' }), /no attribution line/);
  assert.match(attributionEffectText({ effectiveMode: 'oar', attributionExample: 'X' }), /Commits end with: X/);
});
