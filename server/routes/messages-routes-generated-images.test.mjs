import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import {
  cleanupPersistedGeneratedImagesForAssistantResponse,
  normalizeGeneratedImageResponses,
  registerMessagesRoutes,
  shouldAcceptAssistantResponsePayload,
  persistGeneratedImagesForAssistantResponse,
} from './messages-routes.mjs';
import { captureRoutes, invokeRoute, makeRouteDeps, recordingStmts } from './messages-routes-test-harness.mjs';

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5Hh9kAAAAASUVORK5CYII=';
const REPO_ROOT = process.cwd();

test('assistant response validation accepts image-only turns', () => {
  const images = normalizeGeneratedImageResponses([
    { mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64, name: 'pixel' },
  ]);
  assert.equal(shouldAcceptAssistantResponsePayload({
    text: '',
    terminalFailure: null,
    generatedImages: images,
  }), true);
});

test('persistGeneratedImagesForAssistantResponse stores files in session-state with attachment metadata', () => {
  const testRoot = path.join(REPO_ROOT, '.test-artifacts', `generated-images-${process.pid}`);
  fs.rmSync(testRoot, { recursive: true, force: true });
  try {
    const images = normalizeGeneratedImageResponses([
      { mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64, name: 'pixel' },
    ]);
    const attachments = persistGeneratedImagesForAssistantResponse({
      images,
      messageId: 'assistant-response-1',
      conversationId: 'conv-1',
      sdkSessionId: 'sdk-session-1',
      resolveSessionStateRoot: () => testRoot,
    });
    assert.equal(attachments.length, 1);
    const attachment = attachments[0];
    assert.equal(attachment.type, 'image/png');
    assert.equal(attachment.generatedImage?.messageId, 'assistant-response-1');
    assert.match(String(attachment.contentUrl || ''), /^\/api\/generated-image\/conv-1\/assistant-response-1\/img-01\/content$/);
    const relativePath = String(attachment.generatedImage?.relativePath || '');
    const absolutePath = path.join(testRoot, 'sdk-session-1', 'generated-images', relativePath);
    assert.equal(fs.existsSync(absolutePath), true);
    assert.equal(fs.statSync(absolutePath).size > 0, true);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('persistGeneratedImagesForAssistantResponse rejects path traversal by sanitizing identifiers', () => {
  const testRoot = path.join(REPO_ROOT, '.test-artifacts', `generated-images-audit-${process.pid}`);
  fs.rmSync(testRoot, { recursive: true, force: true });
  try {
    const images = normalizeGeneratedImageResponses([
      { mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64, name: 'pixel' },
    ]);
    const attachments = persistGeneratedImagesForAssistantResponse({
      images,
      messageId: '../assistant-response-1',
      conversationId: '../../conv-1',
      sdkSessionId: '../sdk-session-1',
      resolveSessionStateRoot: () => testRoot,
    });
    const relativePath = String(attachments[0]?.generatedImage?.relativePath || '');
    assert.equal(relativePath.includes('..'), false);
    const absolutePath = path.join(testRoot, 'sdk-session-1', 'generated-images', relativePath);
    assert.equal(fs.existsSync(absolutePath), true);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('cleanupPersistedGeneratedImagesForAssistantResponse removes persisted files', () => {
  const testRoot = path.join(REPO_ROOT, '.test-artifacts', `generated-images-cleanup-${process.pid}`);
  fs.rmSync(testRoot, { recursive: true, force: true });
  try {
    const images = normalizeGeneratedImageResponses([
      { mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64, name: 'pixel' },
    ]);
    const attachments = persistGeneratedImagesForAssistantResponse({
      images,
      messageId: 'assistant-response-cleanup',
      conversationId: 'conv-cleanup',
      sdkSessionId: 'sdk-session-cleanup',
      resolveSessionStateRoot: () => testRoot,
    });
    const relativePath = String(attachments[0]?.generatedImage?.relativePath || '');
    const absolutePath = path.join(testRoot, 'sdk-session-cleanup', 'generated-images', relativePath);
    assert.equal(fs.existsSync(absolutePath), true);
    cleanupPersistedGeneratedImagesForAssistantResponse({
      attachments,
      resolveSessionStateRoot: () => testRoot,
    });
    assert.equal(fs.existsSync(absolutePath), false);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('persistGeneratedImagesForAssistantResponse cleans up already-written files when a later write fails', () => {
  const testRoot = path.join(REPO_ROOT, '.test-artifacts', `generated-images-partial-failure-${process.pid}`);
  fs.rmSync(testRoot, { recursive: true, force: true });
  const originalRenameSync = fs.renameSync;
  let renameCount = 0;
  fs.renameSync = (...args) => {
    renameCount += 1;
    if (renameCount === 2) {
      const error = new Error('simulated rename failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRenameSync(...args);
  };
  try {
    const images = normalizeGeneratedImageResponses([
      { mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64, name: 'pixel-a' },
      { mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64, name: 'pixel-b' },
    ]);
    assert.throws(() => persistGeneratedImagesForAssistantResponse({
      images,
      messageId: 'assistant-response-partial-failure',
      conversationId: 'conv-partial-failure',
      sdkSessionId: 'sdk-session-partial-failure',
      resolveSessionStateRoot: () => testRoot,
    }), /simulated rename failure/);
    const generatedImageRoot = path.join(testRoot, 'sdk-session-partial-failure', 'generated-images');
    assert.equal(fs.existsSync(generatedImageRoot), true);
    const leftoverPngFiles = fs.readdirSync(generatedImageRoot, { recursive: true })
      .filter((entry) => String(entry).endsWith('.png'));
    const leftoverTmpFiles = fs.readdirSync(generatedImageRoot, { recursive: true })
      .filter((entry) => String(entry).endsWith('.tmp'));
    assert.deepEqual(leftoverPngFiles, []);
    assert.deepEqual(leftoverTmpFiles, []);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

// A JPEG header (SOI, then a baseline frame of 1536x1024) and no more.
const JPEG_HEADER_BASE64 = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x00, 0x06, 0x00, 0x03,
  0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
]).toString('base64');

test('a generated image attachment carries its pixel size, and its header names its type', () => {
  const testRoot = path.join(REPO_ROOT, '.test-artifacts', `generated-images-size-${process.pid}`);
  fs.rmSync(testRoot, { recursive: true, force: true });
  try {
    const images = normalizeGeneratedImageResponses([
      { mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64, name: 'pixel' },
      // Named PNG, is a JPEG: the header wins, the extension follows.
      { mimeType: 'image/png', data: JPEG_HEADER_BASE64, name: 'photo' },
      { mimeType: 'image/gif', data: Buffer.from('GIF89a-not-read').toString('base64'), name: 'anim' },
    ]);
    const attachments = persistGeneratedImagesForAssistantResponse({
      images,
      messageId: 'assistant-response-size',
      conversationId: 'conv-size',
      sdkSessionId: 'sdk-session-size',
      resolveSessionStateRoot: () => testRoot,
    });
    assert.deepEqual(attachments.map((a) => [a.type, a.width, a.height]), [
      ['image/png', 1, 1],
      ['image/jpeg', 1536, 1024],
      ['image/gif', undefined, undefined],
    ]);
    assert.match(attachments[1].name, /\.jpg$/);
    assert.match(attachments[1].generatedImage.relativePath, /img-02\.jpg$/);
    assert.equal('width' in attachments[2], false);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

async function postImageResponse(t, { queueRow, body }) {
  const testRoot = path.join(REPO_ROOT, '.test-artifacts', `generated-images-reply-${process.pid}`);
  fs.rmSync(testRoot, { recursive: true, force: true });
  t.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));
  const { calls, stmts } = recordingStmts({
    findQById: { get: () => queueRow },
    getRuntimeSessionByConversation: { get: () => ({ provider_type: 'openai' }) },
    getConvAnyStatus: { get: () => ({ id: 'conv-1', status: 'active', sdk_session_id: 'conv-1' }) },
  });
  let uuidCounter = 0;
  const deps = makeRouteDeps({
    ts: () => '00:00:00.000',
    uuidv4: () => `uuid-${++uuidCounter}`,
    io: { emit() {} },
    stmts,
    db: {
      prepare: () => ({ run: () => ({ changes: 1 }), get: () => null, all: () => [] }),
      transaction: (fn) => (...args) => fn(...args),
    },
    MAX_UPLOAD_ATTACHMENTS: 6,
    resolveSessionStateRoot: () => testRoot,
    readSessionTranscriptMessages: () => [],
    relayActivityForResponse: () => [],
    relayActivityForQueueMessage: () => [],
    relayThoughtsForResponse: () => [],
    relayThoughtsForQueueMessage: () => [],
    sanitizeActivityText: (value) => String(value || ''),
    hydrateAttachment: (attachment) => attachment,
    parseAttachments: () => [],
    inFlightStateForConversation: () => null,
    emitToClientsExceptSessionId: () => {},
    queueCounts: () => ({ pendingCount: 0, processingCount: 0 }),
    runtimeState: {},
    config: {},
  });
  const captured = await invokeRoute(captureRoutes(deps, registerMessagesRoutes), 'POST', '/api/response', { body });
  const insert = calls.find((call) => call.stmt === 'insertMsg');
  return { captured, text: insert?.args[3], attachments: JSON.parse(insert?.args[6] || '[]') };
}

test('an image turn without text gets the reply line as its text', async (t) => {
  const { captured, text, attachments } = await postImageResponse(t, {
    queueRow: { id: 'q-1', conversation_id: 'conv-1', status: 'processing', relay_mode: 'agent', model: 'gpt-image-2', retry_count: 0 },
    body: {
      messageId: 'q-1',
      conversationId: 'conv-1',
      text: '',
      model: 'gpt-image-2',
      generatedImages: [
        { mimeType: 'image/png', data: JPEG_HEADER_BASE64 },
        { mimeType: 'image/png', data: JPEG_HEADER_BASE64 },
      ],
    },
  });
  assert.equal(captured.status, 200);
  assert.equal(text, '2 images · 1536x1024 · gpt-image-2');
  assert.deepEqual(attachments.map((a) => [a.width, a.height]), [[1536, 1024], [1536, 1024]]);
});

test('the model\'s own text stays, and a turn of another model gets no reply line', async (t) => {
  const own = await postImageResponse(t, {
    queueRow: { id: 'q-1', conversation_id: 'conv-1', status: 'processing', relay_mode: 'agent', model: 'gpt-image-2', retry_count: 0 },
    body: { messageId: 'q-1', conversationId: 'conv-1', text: 'Here is the kite.', model: 'gpt-image-2', generatedImages: [{ mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 }] },
  });
  assert.equal(own.text, 'Here is the kite.');

  const chat = await postImageResponse(t, {
    queueRow: { id: 'q-2', conversation_id: 'conv-1', status: 'processing', relay_mode: 'agent', model: 'gpt-5.4-mini', retry_count: 0 },
    body: { messageId: 'q-2', conversationId: 'conv-1', text: '', model: 'gpt-5.4-mini', generatedImages: [{ mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 }] },
  });
  assert.equal(chat.text, '');
});
