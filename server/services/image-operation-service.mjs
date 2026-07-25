'use strict';

import crypto from 'crypto';
import { createImageContextService } from './image-context-service.mjs';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function createImageOperationService({
  db,
  repository,
  uuidv4,
} = {}) {
  const contextService = createImageContextService({ db, repository, uuidv4 });

  function createEnqueuedOperation({
    conversationId,
    sourceMessageId,
    queueMessageId,
    prompt,
    selectedImageModel,
    orchestrationModel = null,
    executionMode = 'direct_images',
    parameters = {},
    attachments = [],
    imageTarget = null,
    replacesOperationId = null,
    createdAt = new Date().toISOString(),
  } = {}) {
    const operationId = `img_op_${uuidv4()}`;
    let imageSessionId;
    let parentNodeId = null;
    let reconstructionMode = executionMode === 'native_responses' ? 'native' : 'image_only';
    let kind = 'generate';

    if (imageTarget) {
      const resolved = contextService.resolveGeneratedAttachmentTarget({
        conversationId,
        target: imageTarget,
        createdAt,
      });
      imageSessionId = resolved.node.image_session_id;
      parentNodeId = resolved.node.id;
      reconstructionMode = resolved.reconstructionMode;
      kind = resolved.reconstructionMode === 'image_only' ? 'legacy_edit' : 'edit';
    } else {
      imageSessionId = `img_session_${uuidv4()}`;
      repository.insertSession.run({
        id: imageSessionId,
        conversationId,
        origin: 'native',
        schemaVersion: repository.imageSchemaVersion,
        createdAt,
        updatedAt: createdAt,
      });
    }

    const assets = attachments
      .map((attachment, ordinal) => ({
        ordinal,
        uploadId: String(attachment?.sha256 || '').trim().toLowerCase(),
        contentSha256: String(attachment?.sha256 || '').trim().toLowerCase(),
        mediaType: String(attachment?.type || '').trim().toLowerCase(),
      }))
      .filter((asset) => asset.contentSha256 && asset.mediaType.startsWith('image/'));
    const immutableIntent = {
      conversationId,
      sourceMessageId,
      queueMessageId,
      kind,
      parentNodeId,
      prompt: String(prompt || ''),
      selectedImageModel,
      orchestrationModel,
      provider: 'openai',
      executionMode,
      parameters,
      assets: assets.map(({ contentSha256, mediaType }) => ({ contentSha256, mediaType })),
      replacesOperationId,
    };
    repository.insertOperation.run({
      id: operationId,
      imageSessionId,
      sourceMessageId,
      queueMessageId,
      kind,
      parentNodeId,
      prompt: String(prompt || ''),
      selectedImageModel,
      orchestrationModel,
      provider: 'openai',
      executionMode,
      parametersJson: canonicalJson(parameters),
      requestFingerprint: sha256(canonicalJson(immutableIntent)),
      idempotencyKey: operationId,
      replacesOperationId,
      createdAt,
    });
    for (const asset of assets) {
      repository.insertAsset.run({
        operationId,
        ordinal: asset.ordinal,
        role: 'reference',
        uploadId: asset.uploadId,
        contentSha256: asset.contentSha256,
        mediaType: asset.mediaType,
        createdAt,
      });
    }
    repository.linkQueueOperation.run(operationId, queueMessageId);
    repository.touchSession.run(createdAt, imageSessionId);

    return {
      id: operationId,
      imageSessionId,
      kind,
      parentNodeId,
      mode: executionMode,
      reconstructionMode,
    };
  }

  return {
    createEnqueuedOperation,
  };
}
