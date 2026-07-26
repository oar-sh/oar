import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  dequeuePendingMessageForWorkerLoop,
  normalizeOpenAIImageApiGeneratedImages,
  normalizeOpenAIImageGenerateRequestBody,
  resolveOpenAIImageEditAttachment,
  resolveOpenAIReasoningEffort,
  shouldRequireNewOpenAIConversation,
  validateSubagentRunBinding,
} from './messages-routes.mjs';

test('OpenAI reasoning uses model capabilities instead of always forcing none', () => {
  assert.deepEqual(resolveOpenAIReasoningEffort(''), {
    ok: true,
    effort: 'none',
    supported: ['none'],
  });
  assert.deepEqual(resolveOpenAIReasoningEffort('none'), {
    ok: true,
    effort: 'none',
    supported: ['none'],
  });
  assert.deepEqual(resolveOpenAIReasoningEffort('', 'gpt-image-2'), {
    ok: true,
    effort: 'auto',
    supported: ['auto', 'low', 'medium', 'high'],
  });
  assert.deepEqual(resolveOpenAIReasoningEffort('high', 'gpt-5.6-luna'), {
    ok: true,
    effort: 'high',
    supported: ['none', 'low', 'medium', 'high', 'xhigh'],
  });
  assert.deepEqual(resolveOpenAIReasoningEffort('high', 'codex-5.3'), {
    ok: true,
    effort: 'high',
    supported: ['none', 'low', 'medium', 'high', 'xhigh'],
  });
  assert.deepEqual(resolveOpenAIReasoningEffort('xhigh', 'gpt-4o'), {
    ok: false,
    effort: null,
    supported: ['none'],
    error: 'OpenAI model "gpt-4o" does not support reasoning effort "xhigh"',
  });
});

test('overlapping GitHub models do not require a new OpenAI conversation', () => {
  assert.equal(shouldRequireNewOpenAIConversation({
    shouldCreateConversation: false,
    runtimeUsesOpenAI: false,
    requestedConfiguredOpenAIModel: true,
    githubModelAvailable: true,
  }), false);
  assert.equal(shouldRequireNewOpenAIConversation({
    shouldCreateConversation: false,
    runtimeUsesOpenAI: false,
    requestedConfiguredOpenAIModel: true,
    githubModelAvailable: false,
  }), true);
});

test('dequeuePendingMessageForWorkerLoop returns session-killed without calling ensureWorker', async () => {
  let ensureCalled = 0;
  const result = await dequeuePendingMessageForWorkerLoop({
    db: null,
    stmts: {},
    nowIso: new Date().toISOString(),
    routingEnabled: true,
    requesterSessionId: 'kill-blocked-session',
    sessionWorkerSupervisor: {
      isKillBlocked() {
        return true;
      },
      ensureWorker() {
        ensureCalled += 1;
        return { ok: true };
      },
      getWorkerState() {
        return { sdkSessionId: 'kill-blocked-session', status: 'ready', workerId: 'worker-123' };
      },
      getLifecycleState() {
        return { retryCount: 0, uiState: 'white' };
      },
    },
  });

  assert.equal(result.message, null);
  assert.equal(result.blockedReason, 'session-killed');
  assert.equal(result.attempts, 0);
  assert.equal(ensureCalled, 0);
});

test('dequeuePendingMessageForWorkerLoop does not clear kill marker before ensureWorker', async () => {
  let clearRestartCalls = 0;
  let ensureCalls = 0;
  const result = await dequeuePendingMessageForWorkerLoop({
    db: null,
    stmts: {},
    nowIso: new Date().toISOString(),
    routingEnabled: true,
    requesterSessionId: 'ensure-blocked-session',
    sessionWorkerSupervisor: {
      isKillBlocked() {
        return false;
      },
      clearRestartSchedule() {
        clearRestartCalls += 1;
      },
      ensureWorker() {
        ensureCalls += 1;
        return {
          ok: false,
          error: 'session-killed',
          worker: { sdkSessionId: 'ensure-blocked-session', status: 'error' },
          lifecycle: { retryCount: 1 },
        };
      },
      getWorkerState() {
        return null;
      },
    },
  });

  assert.equal(result.message, null);
  assert.equal(result.blockedReason, 'session-killed');
  assert.equal(clearRestartCalls, 0);
  assert.equal(ensureCalls, 1);
});

test('validateSubagentRunBinding rejects conversation mismatches', () => {
  const result = validateSubagentRunBinding({
    queueRow: { id: 'msg-1', conversation_id: 'conv-A' },
    messageId: 'msg-1',
    conversationId: 'conv-B',
    existingRun: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'Queue message conversation mismatch');
});

test('validateSubagentRunBinding rejects existing run binding mismatches', () => {
  const result = validateSubagentRunBinding({
    queueRow: { id: 'msg-1', conversation_id: 'conv-A' },
    messageId: 'msg-1',
    conversationId: 'conv-A',
    existingRun: { queue_message_id: 'msg-2', conversation_id: 'conv-A' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'Subagent run message mismatch');
});

test('validateSubagentRunBinding returns authoritative conversation id when valid', () => {
  const result = validateSubagentRunBinding({
    queueRow: { id: 'msg-1', conversation_id: 'conv-A' },
    messageId: 'msg-1',
    conversationId: 'conv-A',
    existingRun: { queue_message_id: 'msg-1', conversation_id: 'conv-A' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.conversationId, 'conv-A');
});

test('normalizeOpenAIImageGenerateRequestBody accepts direct generation parameters', () => {
  const parsed = normalizeOpenAIImageGenerateRequestBody({
    messageId: 'msg-1',
    conversationId: 'conv-1',
    model: 'gpt-image-1',
    prompt: 'draw a lighthouse',
    n: 2,
    size: '1024x1024',
    quality: 'high',
  }, { maxImages: 4 });
  assert.equal(parsed.messageId, 'msg-1');
  assert.equal(parsed.n, 2);
  assert.equal(parsed.size, '1024x1024');
  assert.equal(parsed.quality, 'high');
  assert.deepEqual(parsed.attachments, []);
});

test('resolveOpenAIImageEditAttachment parses first image attachment data URL', () => {
  const image = resolveOpenAIImageEditAttachment([
    { name: 'photo.png', type: 'image/png', dataUrl: 'data:image/png;base64,aGVsbG8=' },
  ], { maxImageBytes: 1024 });
  assert.ok(image);
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.bytes.toString('utf8'), 'hello');
});

test('resolveOpenAIImageEditAttachment rejects paths outside allowed upload root', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-image-edit-'));
  const uploadRoot = path.join(tempRoot, 'uploads');
  const outsidePath = path.join(tempRoot, 'outside.png');
  fs.mkdirSync(uploadRoot, { recursive: true });
  fs.writeFileSync(outsidePath, Buffer.from('hello'));
  assert.throws(() => {
    resolveOpenAIImageEditAttachment([
      { name: 'outside.png', type: 'image/png', path: outsidePath },
    ], {
      maxImageBytes: 1024,
      allowedRootPath: uploadRoot,
    });
  }, /outside the upload directory/i);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('resolveOpenAIImageEditAttachment accepts persisted generated image paths', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-generated-image-'));
  const generatedPath = path.join(
    stateRoot,
    'session-1',
    'generated-images',
    'conversation-1',
    'message-1',
    'img-01.png',
  );
  fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
  fs.writeFileSync(generatedPath, Buffer.from('generated'));
  const image = resolveOpenAIImageEditAttachment([
    { name: 'img-01.png', type: 'image/png', path: generatedPath },
  ], {
    maxImageBytes: 1024,
    allowedRootPath: path.join(stateRoot, 'uploads'),
    allowedGeneratedImagesRootPath: stateRoot,
  });
  assert.equal(image.bytes.toString('utf8'), 'generated');
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test('resolveOpenAIImageEditAttachment rejects non-generated files in session state', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-session-state-'));
  const unrelatedPath = path.join(stateRoot, 'session-1', 'files', 'private.txt');
  fs.mkdirSync(path.dirname(unrelatedPath), { recursive: true });
  fs.writeFileSync(unrelatedPath, Buffer.from('private'));
  assert.throws(() => {
    resolveOpenAIImageEditAttachment([
      { name: 'private.png', type: 'image/png', path: unrelatedPath },
    ], {
      maxImageBytes: 1024,
      allowedGeneratedImagesRootPath: stateRoot,
    });
  }, /outside the upload directory/i);
  fs.rmSync(stateRoot, { recursive: true, force: true });
});

test('normalizeOpenAIImageApiGeneratedImages normalizes OpenAI image API output', () => {
  const normalized = normalizeOpenAIImageApiGeneratedImages({
    data: [
      { b64_json: 'aGVsbG8=', revised_prompt: 'refined prompt' },
    ],
  });
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].data, 'aGVsbG8=');
  assert.equal(normalized[0].mimeType, 'image/png');
  assert.equal(normalized[0].revisedPrompt, 'refined prompt');
});
