'use strict';

function parseAttachmentList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function createImageContextService({
  db,
  repository,
  uuidv4,
} = {}) {
  if (!db || !repository || typeof uuidv4 !== 'function') {
    throw new Error('Image context service dependencies are required');
  }

  const getMessage = db.prepare(`
    SELECT id, conversation_id, role, attachments, timestamp
    FROM messages
    WHERE id = ?
  `);

  function resolveGeneratedAttachmentTarget({
    conversationId,
    target,
    createdAt,
  } = {}) {
    const messageId = String(target?.messageId || '').trim();
    const imageId = String(target?.imageId || '').trim();
    const requestedNodeId = String(target?.nodeId || '').trim();
    if (!conversationId || !messageId || !imageId) {
      throw new Error('Image edit target requires messageId and imageId');
    }

    const message = getMessage.get(messageId);
    if (!message || message.conversation_id !== conversationId || message.role !== 'assistant') {
      throw new Error('Image edit target is not available in this conversation');
    }
    const attachment = parseAttachmentList(message.attachments).find((entry) => (
      String(entry?.generatedImage?.imageId || '').trim() === imageId
    ));
    if (!attachment?.generatedImage) {
      throw new Error('Image edit target is not a generated image');
    }

    let node = repository.getNodeByAttachment.get(messageId, imageId);
    if (node && requestedNodeId && node.id !== requestedNodeId) {
      throw new Error('Image edit target node does not match the generated image');
    }
    if (node) {
      return { node, attachment, reconstructionMode: 'native' };
    }

    const now = String(createdAt || new Date().toISOString());
    const imageSessionId = `img_session_${uuidv4()}`;
    const bridgeOperationId = `img_op_${uuidv4()}`;
    const nodeId = `img_node_${uuidv4()}`;
    repository.insertSession.run({
      id: imageSessionId,
      conversationId,
      origin: 'legacy_reconstructed',
      schemaVersion: repository.imageSchemaVersion,
      createdAt: message.timestamp || now,
      updatedAt: now,
    });
    repository.insertOperation.run({
      id: bridgeOperationId,
      imageSessionId,
      sourceMessageId: messageId,
      queueMessageId: `legacy:${messageId}:${imageId}`,
      kind: 'legacy_edit',
      parentNodeId: null,
      prompt: '',
      selectedImageModel: 'legacy-generated-image',
      orchestrationModel: null,
      provider: 'openai',
      executionMode: 'direct_images',
      parametersJson: '{}',
      requestFingerprint: `legacy:${messageId}:${imageId}`,
      idempotencyKey: bridgeOperationId,
      replacesOperationId: null,
      createdAt: message.timestamp || now,
    });
    repository.insertNode.run({
      id: nodeId,
      imageSessionId,
      operationId: bridgeOperationId,
      assistantMessageId: messageId,
      attachmentImageId: imageId,
      outputIndex: 0,
      createdAt: message.timestamp || now,
    });
    node = repository.getNode.get(nodeId);
    return { node, attachment, reconstructionMode: 'image_only' };
  }

  return {
    resolveGeneratedAttachmentTarget,
  };
}
