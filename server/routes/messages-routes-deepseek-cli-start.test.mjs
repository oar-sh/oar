import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { makeRouteDeps, invokePost } from './messages-routes-test-harness.mjs';
import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';

// POST /api/claude-native-session with `cliStartedAt`: a DeepSeek worker
// reports each CLI start, and the relay records it in its own config dir for
// the delete to find that CLI's shell snapshot (claude-session-leftovers.mjs).

const NOW = '2026-10-25T08:00:00.000Z';

function setup(providerType) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  stmts.insertConv.run('conv-1', 'Chat', NOW, NOW);
  stmts.insertRuntimeSession.run('rs-conv-1', 'conv-1', 'isolated', 'rs-conv-1', 'model', NOW, NOW, 'conv-1', providerType, 'model');
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-cli-start-'));
  return { stmts, configDir, deps: makeRouteDeps({ stmts, deepseekClaudeConfigDir: configDir }) };
}

const recorded = (configDir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, 'oar-cli-starts.json'), 'utf8')).sessions;
  } catch {
    return null;
  }
};

test('a DeepSeek worker\'s CLI starts are recorded per session, each once', async () => {
  const { stmts, configDir, deps } = setup('deepseek');
  try {
    const startedAt = Date.parse(NOW);
    for (const at of [startedAt, startedAt + 600_000, startedAt + 600_000]) {
      const answer = await invokePost('/api/claude-native-session', deps, { conversationId: 'conv-1', claudeNativeSessionId: 'native-1', cliStartedAt: at });
      assert.equal(answer.status, 200);
    }
    assert.deepEqual(recorded(configDir), { 'native-1': [startedAt, startedAt + 600_000] });
    assert.equal(stmts.getRuntimeSessionByConversation.get('conv-1').claude_native_session_id, 'native-1');
    // No time, or one far in the future, records nothing more.
    await invokePost('/api/claude-native-session', deps, { conversationId: 'conv-1', claudeNativeSessionId: 'native-1' });
    await invokePost('/api/claude-native-session', deps, { conversationId: 'conv-1', claudeNativeSessionId: 'native-1', cliStartedAt: Date.now() + 3_600_000 });
    assert.deepEqual(recorded(configDir), { 'native-1': [startedAt, startedAt + 600_000] });
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('a Claude conversation\'s CLI start is not recorded: the relay does not own ~/.claude', async () => {
  const { configDir, deps } = setup('claude');
  try {
    const answer = await invokePost('/api/claude-native-session', deps, { conversationId: 'conv-1', claudeNativeSessionId: 'native-1', cliStartedAt: Date.parse(NOW) });
    assert.equal(answer.status, 200);
    assert.equal(recorded(configDir), null);
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
