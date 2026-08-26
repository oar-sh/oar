import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeClaudeContextUsage,
  resolveModelUsageEntry,
  buildClaudeContextSnapshot,
  readStoredClaudeContextUsage,
} from './claude-context-usage.mjs';

// Mirrors the reference breakdown: 4.8k + 19.2k + 1.8k + 221.3k = 247.1k of 1M.
function sdkResponse(overrides = {}) {
  return {
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
      { name: 'Free space', tokens: 752900, color: 'dim' },
    ],
    skills: { totalSkills: 12, includedSkills: 12, tokens: 1800 },
    isAutoCompactEnabled: false,
    apiUsage: {
      input_tokens: 120,
      output_tokens: 640,
      cache_read_input_tokens: 240000,
      cache_creation_input_tokens: 7000,
    },
    ...overrides,
  };
}

test('normalize keeps categories but drops free space', () => {
  const usage = normalizeClaudeContextUsage(sdkResponse());
  assert.deepEqual(usage.categories.map((c) => c.name), [
    'System prompt', 'System tools', 'Skills', 'Messages',
  ]);
  assert.equal(usage.totalTokens, 247100);
  assert.equal(usage.maxTokens, 1000000);
  assert.equal(usage.model, 'claude-opus-5[1m]');
  assert.equal(usage.apiUsage.cacheReadTokens, 240000);
});

test('normalize rejects unusable input instead of throwing', () => {
  assert.equal(normalizeClaudeContextUsage(null), null);
  assert.equal(normalizeClaudeContextUsage('nope'), null);
  assert.equal(normalizeClaudeContextUsage({}), null);
  assert.equal(normalizeClaudeContextUsage({ categories: [] }), null);
});

test('normalize falls back to rawMaxTokens', () => {
  const usage = normalizeClaudeContextUsage(sdkResponse({ maxTokens: null, rawMaxTokens: 200000 }));
  assert.equal(usage.maxTokens, 200000);
});

test('snapshot maps categories onto the shared contract', () => {
  const snapshot = buildClaudeContextSnapshot({
    contextUsage: sdkResponse(),
    model: 'claude-opus-5[1m]',
    sdkSessionId: 'sess-1',
    capturedAt: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(snapshot.used_total_tokens, 247100);
  assert.equal(snapshot.max_context_tokens, 1000000);
  assert.equal(snapshot.used_percent, 24.71);
  assert.equal(snapshot.free_tokens, 752900);
  assert.equal(snapshot.system_tokens, 4800);
  // System tools + Skills both count as tool definitions.
  assert.equal(snapshot.tools_tokens, 21000);
  assert.equal(snapshot.messages_tokens, 221300);
  assert.equal(snapshot.system_tools_tokens, 25800);
  assert.equal(snapshot.cache_read_tokens, 240000);
  assert.equal(snapshot.cache_write_tokens, 7000);
  assert.equal(snapshot.captured_at, '2026-08-01T00:00:00.000Z');
  assert.equal(snapshot.estimate_kind, null);
});

test('snapshot falls back to modelUsage.contextWindow when maxTokens is absent', () => {
  const snapshot = buildClaudeContextSnapshot({
    contextUsage: sdkResponse({ maxTokens: null, rawMaxTokens: null, percentage: null }),
    modelUsage: { 'claude-opus-5[1m]': { contextWindow: 1000000, inputTokens: 5 } },
    model: 'claude-opus-5[1m]',
  });
  assert.equal(snapshot.max_context_tokens, 1000000);
  assert.equal(snapshot.used_percent, 24.71);
});

test('snapshot returns null when there is nothing to report', () => {
  assert.equal(buildClaudeContextSnapshot({ contextUsage: null }), null);
  assert.equal(buildClaudeContextSnapshot({}), null);
});

test('resolveModelUsageEntry matches by id, else the lone entry', () => {
  const byId = resolveModelUsageEntry({ 'claude-opus-5': { contextWindow: 200000 } }, 'claude-opus-5');
  assert.equal(byId.contextWindow, 200000);

  const lone = resolveModelUsageEntry({ 'some-other-id': { contextWindow: 400000 } }, 'claude-opus-5');
  assert.equal(lone.contextWindow, 400000, 'a spelling mismatch must not lose the window');

  const ambiguous = resolveModelUsageEntry({ a: { contextWindow: 1 }, b: { contextWindow: 2 } }, 'c');
  assert.equal(ambiguous, null);
  assert.equal(resolveModelUsageEntry(null, 'x'), null);
});

// autoCompactThreshold is a TOKEN COUNT, verified against live
// runtime_sessions.context_usage_json rows (claude-opus-5: max 1000000 /
// threshold 967000; claude-haiku-4-5: 200000 / 167000). This test previously
// passed 92 and expected 80000, i.e. it encoded a percent reading; the old
// formula turned real payloads hugely negative and clamped every Claude
// session's buffer to 0.
test('auto-compact threshold becomes the buffer', () => {
  const snapshot = buildClaudeContextSnapshot({
    contextUsage: sdkResponse({ isAutoCompactEnabled: true, autoCompactThreshold: 967000 }),
  });
  assert.equal(snapshot.buffer_tokens, 33000);

  const haiku = buildClaudeContextSnapshot({
    contextUsage: sdkResponse({
      maxTokens: 200000,
      rawMaxTokens: 200000,
      isAutoCompactEnabled: true,
      autoCompactThreshold: 167000,
    }),
  });
  assert.equal(haiku.buffer_tokens, 33000);
});

test('the threshold and its source survive normalization as measured', () => {
  const usage = normalizeClaudeContextUsage(sdkResponse({
    maxTokens: 967000,
    rawMaxTokens: 967000,
    autoCompactThreshold: 934000,
    autocompactSource: 'model-default',
    isAutoCompactEnabled: true,
  }));
  assert.equal(usage.autoCompactThreshold, 934000, 'a token count, not a percent');
  assert.equal(usage.rawMaxTokens, 967000);
  assert.equal(usage.autocompactSource, 'model-default');
  assert.equal(usage.isAutoCompactEnabled, true);
});

test('a payload without auto-compact fields reports them as absent', () => {
  const usage = normalizeClaudeContextUsage(sdkResponse());
  assert.equal(usage.autoCompactThreshold, null);
  assert.equal(usage.autocompactSource, null);
  assert.equal(
    buildClaudeContextSnapshot({ contextUsage: sdkResponse() }).buffer_tokens,
    null,
  );
});

test('readStoredClaudeContextUsage parses the persisted row', () => {
  const row = {
    id: 'rs-1',
    sdk_session_id: 'sess-9',
    context_usage_json: JSON.stringify({ model: 'claude-opus-5[1m]', contextUsage: sdkResponse() }),
    context_usage_captured_at: '2026-08-01T01:00:00.000Z',
  };
  const { snapshot, contextUsage } = readStoredClaudeContextUsage(row);
  assert.equal(snapshot.used_total_tokens, 247100);
  assert.equal(snapshot.copilot_session_id, 'sess-9');
  assert.equal(snapshot.runtime_session_id, 'rs-1');
  assert.equal(contextUsage.categories.length, 4);
});

test('readStoredClaudeContextUsage tolerates missing and corrupt blobs', () => {
  assert.deepEqual(readStoredClaudeContextUsage({}), { snapshot: null, contextUsage: null });
  assert.deepEqual(
    readStoredClaudeContextUsage({ context_usage_json: '{not json' }),
    { snapshot: null, contextUsage: null },
  );
});
