import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createUsageLimitPauseService } from './usage-limit-pause-service.mjs';

// Which conversations a refusal at the Claude usage limit pauses: the ones
// bound to Claude Code, locally or in the cloud. The rest of the service is
// covered by claude-usage-limit.routes-integration.test.mjs.

const NOW = Date.parse('2026-10-02T10:00:00.000Z');

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  return createUsageLimitPauseService({ db, stmts, now: () => NOW, logger: { log() {}, warn() {} } });
}

const refusal = {
  kind: 'claude-usage-limit',
  code: 'claude-usage-limit',
  rateLimitType: 'five_hour',
  resetsAt: '2026-10-02T11:00:00.000Z',
  message: "You've hit your session limit",
};

test('a refusal pauses Claude and Claude Cloud conversations, nothing else', () => {
  const service = setup();
  for (const providerType of ['claude', 'claude-cloud', 'Claude-Cloud ']) {
    const plan = service.planPause({ terminalError: refusal, conversationId: 'conv-1', providerType });
    assert.ok(plan, providerType);
    assert.equal(plan.rateLimitType, 'five_hour');
    assert.equal(plan.auto, true);
    assert.match(plan.noteText, /^⏸ Paused: the Claude 5-hour limit is reached\./);
  }
  for (const providerType of ['cursor', 'github', 'grok', 'openai', '', null]) {
    assert.equal(service.planPause({ terminalError: refusal, conversationId: 'conv-1', providerType }), null, String(providerType));
  }
  assert.equal(service.planPause({ terminalError: { kind: 'other' }, conversationId: 'conv-1', providerType: 'claude-cloud' }), null);
});
