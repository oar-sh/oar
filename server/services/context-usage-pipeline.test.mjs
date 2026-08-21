import test from 'node:test';
import assert from 'node:assert/strict';

import { readStoredClaudeContextUsage } from './claude-context-usage.mjs';
import { buildContextUsageView } from './context-usage-view.mjs';
import { renderAutoCompactControlHtml, renderContextUsageHtml } from '../public/app/context-usage-view.mjs';

/**
 * End-to-end over the whole context pipeline, mirroring what
 * `resolveContextPayload` in sessions-routes does for a Claude session:
 * worker payload → persisted row → snapshot → view payload → modal HTML.
 */

// Exactly what the worker POSTs to /api/claude-context-usage.
const workerPayload = {
  model: 'claude-opus-5[1m]',
  contextUsage: {
    model: 'claude-opus-5[1m]',
    totalTokens: 247100,
    maxTokens: 1000000,
    rawMaxTokens: 1000000,
    percentage: 24.71,
    categories: [
      { name: 'System prompt', tokens: 4800, color: 'gray' },
      { name: 'System tools', tokens: 19200, color: 'blue' },
      { name: 'Skills', tokens: 1800, color: 'green' },
      { name: 'Messages', tokens: 221300, color: 'orange' },
    ],
    skills: { totalSkills: 12, includedSkills: 12, tokens: 1800 },
    // Measured shape of a live claude-opus-5 row: a token-count threshold plus
    // its provenance.
    autoCompactThreshold: 967000,
    autocompactSource: 'auto',
    isAutoCompactEnabled: true,
    apiUsage: {
      input_tokens: 120,
      output_tokens: 640,
      cache_read_input_tokens: 240000,
      cache_creation_input_tokens: 7000,
    },
  },
  modelUsage: { 'claude-opus-5[1m]': { contextWindow: 1000000, inputTokens: 120 } },
};

function storedRow(payload = workerPayload) {
  return {
    id: 'rs-1',
    sdk_session_id: 'sess-1',
    provider_type: 'claude',
    provider_model: 'claude-opus-5[1m]',
    context_usage_json: JSON.stringify(payload),
    context_usage_captured_at: '2026-08-01T00:00:00.000Z',
  };
}

test('a Claude worker payload renders the reference modal', () => {
  const { snapshot, contextUsage } = readStoredClaudeContextUsage(storedRow());
  const view = buildContextUsageView({ snapshot, contextUsage });
  const html = renderContextUsageHtml(view);

  assert.match(html, /claude-opus-5\[1m\]/);
  assert.match(html, /247\.1k \/ 1\.0M tokens \(25%\)/);
  assert.match(html, /System prompt[\s\S]*4\.8k[\s\S]*0\.5%/);
  assert.match(html, /System tools[\s\S]*19\.2k[\s\S]*1\.9%/);
  assert.match(html, /Skills[\s\S]*1\.8k[\s\S]*0\.2%/);
  assert.match(html, /Messages[\s\S]*221\.3k[\s\S]*22\.1%/);
  // 752.9k of the window is unused, but 33k of that is the reserve above the
  // auto-compact threshold — free space is what a conversation may still
  // occupy, so the buffer is carved out rather than counted twice.
  assert.match(html, /Free space[\s\S]*719\.9k[\s\S]*72\.0%/);
});

test('the composer indicator ratio is derived from the same payload', () => {
  const { snapshot, contextUsage } = readStoredClaudeContextUsage(storedRow());
  const view = buildContextUsageView({ snapshot, contextUsage });
  // Mirrors readContextUsageRatio's preferred branch in public/app/store.js.
  const ratio = view.percentage / 100;
  assert.ok(ratio > 0.24 && ratio < 0.25, `expected ~0.247, got ${ratio}`);
});

test('a Claude session with no captured turn yields no view', () => {
  const { snapshot, contextUsage } = readStoredClaudeContextUsage({
    id: 'rs-2',
    provider_type: 'claude',
    context_usage_json: null,
  });
  assert.equal(snapshot, null);
  assert.equal(buildContextUsageView({ snapshot, contextUsage }), null);
  assert.equal(renderContextUsageHtml(null), '');
});

test('the window comes from modelUsage when the breakdown omits it', () => {
  const payload = {
    ...workerPayload,
    contextUsage: { ...workerPayload.contextUsage, maxTokens: null, rawMaxTokens: null, percentage: null },
  };
  const { snapshot, contextUsage } = readStoredClaudeContextUsage(storedRow(payload));
  const view = buildContextUsageView({ snapshot, contextUsage });
  assert.equal(view.maxTokens, 1000000, 'a [1m] session must not be reported as 200k');
  assert.equal(view.percentage, 24.71);
});

test('the auto-compact control rides the same payload the modal renders', () => {
  const { snapshot, contextUsage } = readStoredClaudeContextUsage(storedRow());
  const view = buildContextUsageView({ snapshot, contextUsage });
  // Mirrors what bootstrap's loadContextSummaryAndRender appends for a Claude
  // conversation, with the stored preference from resolveContextPayload.
  const html = renderAutoCompactControlHtml({
    autoCompactWindow: 200000,
    autoCompactThreshold: view.autoCompactThreshold,
    autocompactSource: view.autocompactSource,
    isAutoCompactEnabled: view.isAutoCompactEnabled,
    maxTokens: view.maxTokens,
  });
  assert.equal(view.autoCompactThreshold, 967000, 'tokens, not a percent');
  // Still recorded end to end, just not rendered: it tracks the active window,
  // not the model's limit.
  assert.equal(view.rawMaxTokens, 1000000);
  assert.match(html, /id="ctx-autocompact-value">200k</);
  assert.match(html, /compacts at 967\.0k of 1\.0M tokens · auto \(model-tuned\)/);
});

test('the buffer derived for a Claude session is the reserve above the threshold', () => {
  // Regression: the old percent formula made this 0 for every real payload.
  const { snapshot } = readStoredClaudeContextUsage(storedRow());
  assert.equal(snapshot.buffer_tokens, 33000);
});
