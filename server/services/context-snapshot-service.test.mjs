import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createContextSnapshotService, resolveFallbackContextLimitTokens } from './context-snapshot-service.mjs';

test('uses catalog context metadata when session events omit the model limit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-remote-context-'));
  const sessionId = 'session-1';
  const sessionDir = path.join(root, sessionId);
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), `${JSON.stringify({
    type: 'assistant.message',
    timestamp: '2026-07-11T00:00:00.000Z',
    data: {
      currentModel: 'gpt-5.6-terra',
      outputTokens: 100,
    },
  })}\n`);

  try {
    const service = createContextSnapshotService({
      fs,
      path,
      resolveSessionStateRoot: () => root,
      getModelContextLimitTokens: (modelId) => modelId === 'gpt-5.6-terra' ? 272000 : null,
    });
    const result = service.readContextFromSessionEvents(sessionId, sessionId);

    assert.equal(result.snapshot.max_context_tokens, 272000);
    assert.equal(result.snapshot.used_percent, 0.04);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uses the GPT-5.6 fallback context limit when catalog metadata is unavailable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-remote-context-'));
  const sessionId = 'session-5.6';
  const sessionDir = path.join(root, sessionId);
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), `${JSON.stringify({
    type: 'assistant.message',
    timestamp: '2026-07-11T00:00:00.000Z',
    data: {
      currentModel: 'gpt-5.6-terra',
      outputTokens: 100,
    },
  })}\n`);

  try {
    const service = createContextSnapshotService({
      fs,
      path,
      resolveSessionStateRoot: () => root,
    });
    const result = service.readContextFromSessionEvents(sessionId, sessionId);

    assert.equal(result.snapshot.max_context_tokens, 272000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bracketed [1m] model ids resolve to the long context window', () => {
  assert.equal(resolveFallbackContextLimitTokens('claude-opus-5[1m]'), 1000000);
  assert.equal(resolveFallbackContextLimitTokens('CLAUDE-OPUS-5[1M]'), 1000000);
  assert.equal(resolveFallbackContextLimitTokens('claude-opus-5'), 200000);
  assert.equal(resolveFallbackContextLimitTokens('claude-sonnet-5'), 200000);
});

test('an unknown bracketed suffix falls back to the base model window', () => {
  assert.equal(resolveFallbackContextLimitTokens('claude-opus-5[fast]'), 200000);
  assert.equal(resolveFallbackContextLimitTokens('totally-unknown[1m]'), 1000000);
  assert.equal(resolveFallbackContextLimitTokens('totally-unknown'), null);
  assert.equal(resolveFallbackContextLimitTokens(''), null);
});

test('estimated usage percent is clamped to a full window', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-remote-context-'));
  const sessionId = 'session-estimate';
  const sessionDir = path.join(root, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  // Cumulative assistant output far exceeding the window; compaction keeps the
  // real context bounded, so the gauge must not read past 100%.
  const lines = Array.from({ length: 40 }, () => JSON.stringify({
    type: 'assistant.message',
    timestamp: '2026-07-11T00:00:00.000Z',
    data: { currentModel: 'claude-opus-5', outputTokens: 20000 },
  })).join('\n');
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), `${lines}\n`);

  try {
    const service = createContextSnapshotService({ fs, path, resolveSessionStateRoot: () => root });
    const result = service.readContextFromSessionEvents(sessionId, sessionId);
    assert.equal(result.snapshot.used_percent, 100);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
