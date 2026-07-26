import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import {
  cleanupPersistedGeneratedImagesForAssistantResponse,
  normalizeGeneratedImageResponses,
  shouldAcceptAssistantResponsePayload,
  persistGeneratedImagesForAssistantResponse,
} from './messages-routes.mjs';

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
