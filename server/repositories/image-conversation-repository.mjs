'use strict';

const IMAGE_SCHEMA_VERSION = 1;

export function migrateImageConversationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_sessions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('native', 'legacy_verified', 'legacy_reconstructed')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status = 'active'),
      schema_version INTEGER NOT NULL DEFAULT ${IMAGE_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_image_sessions_conversation_updated
      ON image_sessions(conversation_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS image_operations (
      id TEXT PRIMARY KEY,
      image_session_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL UNIQUE,
      queue_message_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('generate', 'edit', 'legacy_edit')),
      parent_node_id TEXT,
      prompt TEXT NOT NULL,
      selected_image_model TEXT NOT NULL,
      orchestration_model TEXT,
      provider TEXT NOT NULL,
      execution_mode TEXT NOT NULL CHECK (execution_mode IN ('native_responses', 'direct_images')),
      parameters_json TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      replaces_operation_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (image_session_id) REFERENCES image_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (replaces_operation_id) REFERENCES image_operations(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_image_operations_session_created
      ON image_operations(image_session_id, created_at);

    CREATE TABLE IF NOT EXISTS image_nodes (
      id TEXT PRIMARY KEY,
      image_session_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      attachment_image_id TEXT NOT NULL,
      output_index INTEGER NOT NULL CHECK (output_index >= 0),
      created_at TEXT NOT NULL,
      UNIQUE (operation_id, output_index),
      UNIQUE (assistant_message_id, attachment_image_id),
      FOREIGN KEY (image_session_id) REFERENCES image_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (operation_id) REFERENCES image_operations(id) ON DELETE CASCADE,
      FOREIGN KEY (assistant_message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_image_nodes_session_created
      ON image_nodes(image_session_id, created_at);

    CREATE TABLE IF NOT EXISTS image_edges (
      image_session_id TEXT NOT NULL,
      parent_node_id TEXT NOT NULL,
      child_node_id TEXT NOT NULL UNIQUE,
      operation_id TEXT NOT NULL,
      relation TEXT NOT NULL CHECK (relation = 'edit'),
      created_at TEXT NOT NULL,
      PRIMARY KEY (parent_node_id, child_node_id),
      CHECK (parent_node_id != child_node_id),
      FOREIGN KEY (image_session_id) REFERENCES image_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_node_id) REFERENCES image_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (child_node_id) REFERENCES image_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (operation_id) REFERENCES image_operations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS image_operation_assets (
      operation_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      role TEXT NOT NULL CHECK (role IN ('reference', 'mask')),
      upload_id TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      media_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (operation_id, ordinal),
      FOREIGN KEY (operation_id) REFERENCES image_operations(id) ON DELETE CASCADE,
      FOREIGN KEY (content_sha256) REFERENCES uploaded_files(sha256) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS image_operation_attempts (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
      status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed_terminal', 'failed_retryable', 'uncertain')),
      provider TEXT NOT NULL,
      capability_snapshot_json TEXT NOT NULL,
      provider_request_id TEXT,
      provider_conversation_id TEXT,
      provider_response_id TEXT,
      http_status INTEGER,
      error_code TEXT,
      error_message TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE (operation_id, attempt_number),
      FOREIGN KEY (operation_id) REFERENCES image_operations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_image_attempts_operation
      ON image_operation_attempts(operation_id, attempt_number DESC);

    CREATE TABLE IF NOT EXISTS image_provider_state (
      id TEXT PRIMARY KEY,
      image_session_id TEXT NOT NULL,
      head_node_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      endpoint_fingerprint TEXT NOT NULL,
      provider_conversation_id TEXT,
      provider_response_id TEXT,
      context_version INTEGER NOT NULL CHECK (context_version > 0),
      reconstruction_mode TEXT NOT NULL CHECK (reconstruction_mode IN ('native', 'verified_replay', 'image_only')),
      safe_state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (head_node_id, provider, endpoint_fingerprint),
      FOREIGN KEY (image_session_id) REFERENCES image_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (head_node_id) REFERENCES image_nodes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS image_provider_capabilities (
      endpoint_fingerprint TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      supports_responses INTEGER,
      supports_conversations INTEGER,
      supports_conversation_delete INTEGER,
      supports_guaranteed_idempotency INTEGER NOT NULL DEFAULT 0,
      probe_status TEXT NOT NULL CHECK (probe_status IN ('supported', 'partial', 'unsupported', 'error')),
      safe_reason_code TEXT,
      checked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS image_provider_deletion_tombstones (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      endpoint_fingerprint TEXT NOT NULL,
      provider_conversation_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'retrying', 'deleted', 'unsupported', 'abandoned')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      next_attempt_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (provider, endpoint_fingerprint, provider_conversation_id)
    );
  `);

  const queueColumns = new Set(db.prepare(`PRAGMA table_info(queue)`).all().map((column) => column.name));
  if (!queueColumns.has('image_operation_id')) {
    db.exec(`ALTER TABLE queue ADD COLUMN image_operation_id TEXT`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_queue_image_operation
      ON queue(image_operation_id)
      WHERE image_operation_id IS NOT NULL;
  `);
}

export function createImageConversationRepository(db) {
  const statements = {
    insertSession: db.prepare(`
      INSERT INTO image_sessions (id, conversation_id, origin, status, schema_version, created_at, updated_at)
      VALUES (@id, @conversationId, @origin, 'active', @schemaVersion, @createdAt, @updatedAt)
    `),
    touchSession: db.prepare(`UPDATE image_sessions SET updated_at = ? WHERE id = ?`),
    getSession: db.prepare(`SELECT * FROM image_sessions WHERE id = ?`),
    insertOperation: db.prepare(`
      INSERT INTO image_operations (
        id, image_session_id, source_message_id, queue_message_id, kind, parent_node_id,
        prompt, selected_image_model, orchestration_model, provider, execution_mode,
        parameters_json, request_fingerprint, idempotency_key, replaces_operation_id, created_at
      ) VALUES (
        @id, @imageSessionId, @sourceMessageId, @queueMessageId, @kind, @parentNodeId,
        @prompt, @selectedImageModel, @orchestrationModel, @provider, @executionMode,
        @parametersJson, @requestFingerprint, @idempotencyKey, @replacesOperationId, @createdAt
      )
    `),
    getOperation: db.prepare(`
      SELECT operation.*, session.conversation_id
      FROM image_operations operation
      JOIN image_sessions session ON session.id = operation.image_session_id
      WHERE operation.id = ?
    `),
    getOperationByQueueMessageId: db.prepare(`
      SELECT operation.*, session.conversation_id
      FROM image_operations operation
      JOIN image_sessions session ON session.id = operation.image_session_id
      WHERE operation.queue_message_id = ?
    `),
    linkQueueOperation: db.prepare(`UPDATE queue SET image_operation_id = ? WHERE id = ? AND image_operation_id IS NULL`),
    insertAsset: db.prepare(`
      INSERT INTO image_operation_assets (
        operation_id, ordinal, role, upload_id, content_sha256, media_type, created_at
      ) VALUES (@operationId, @ordinal, @role, @uploadId, @contentSha256, @mediaType, @createdAt)
    `),
    listAssets: db.prepare(`
      SELECT asset.*, file.original_name, file.size_bytes
      FROM image_operation_assets asset
      JOIN uploaded_files file ON file.sha256 = asset.content_sha256
      WHERE asset.operation_id = ?
      ORDER BY asset.ordinal ASC
    `),
    getNode: db.prepare(`
      SELECT node.*, session.conversation_id
      FROM image_nodes node
      JOIN image_sessions session ON session.id = node.image_session_id
      WHERE node.id = ?
    `),
    getNodeByAttachment: db.prepare(`
      SELECT node.*, session.conversation_id
      FROM image_nodes node
      JOIN image_sessions session ON session.id = node.image_session_id
      WHERE node.assistant_message_id = ? AND node.attachment_image_id = ?
    `),
    insertNode: db.prepare(`
      INSERT INTO image_nodes (
        id, image_session_id, operation_id, assistant_message_id, attachment_image_id, output_index, created_at
      ) VALUES (@id, @imageSessionId, @operationId, @assistantMessageId, @attachmentImageId, @outputIndex, @createdAt)
    `),
    insertEdge: db.prepare(`
      INSERT INTO image_edges (
        image_session_id, parent_node_id, child_node_id, operation_id, relation, created_at
      ) VALUES (@imageSessionId, @parentNodeId, @childNodeId, @operationId, 'edit', @createdAt)
    `),
    findPathToNode: db.prepare(`
      WITH RECURSIVE descendants(node_id) AS (
        SELECT child_node_id FROM image_edges WHERE parent_node_id = ?
        UNION
        SELECT edge.child_node_id
        FROM image_edges edge
        JOIN descendants ON edge.parent_node_id = descendants.node_id
      )
      SELECT 1 AS found FROM descendants WHERE node_id = ? LIMIT 1
    `),
    getLatestAttempt: db.prepare(`
      SELECT * FROM image_operation_attempts
      WHERE operation_id = ?
      ORDER BY attempt_number DESC
      LIMIT 1
    `),
    insertAttempt: db.prepare(`
      INSERT INTO image_operation_attempts (
        id, operation_id, attempt_number, status, provider, capability_snapshot_json, started_at
      ) VALUES (@id, @operationId, @attemptNumber, 'started', @provider, @capabilitySnapshotJson, @startedAt)
    `),
    finishAttempt: db.prepare(`
      UPDATE image_operation_attempts
      SET status = @status,
          provider_request_id = @providerRequestId,
          provider_conversation_id = @providerConversationId,
          provider_response_id = @providerResponseId,
          http_status = @httpStatus,
          error_code = @errorCode,
          error_message = @errorMessage,
          completed_at = @completedAt
      WHERE id = @id AND status = 'started'
    `),
    listNodesForOperation: db.prepare(`
      SELECT node.*, message.attachments, message.text, message.model, message.mode, message.timestamp
      FROM image_nodes node
      JOIN messages message ON message.id = node.assistant_message_id
      WHERE node.operation_id = ?
      ORDER BY node.output_index ASC
    `),
    getParentEdge: db.prepare(`SELECT * FROM image_edges WHERE child_node_id = ?`),
    listProviderStatesForConversation: db.prepare(`
      SELECT DISTINCT state.provider, state.endpoint_fingerprint, state.provider_conversation_id
      FROM image_provider_state state
      JOIN image_sessions session ON session.id = state.image_session_id
      WHERE session.conversation_id = ? AND state.provider_conversation_id IS NOT NULL
    `),
    insertDeletionTombstone: db.prepare(`
      INSERT INTO image_provider_deletion_tombstones (
        id, provider, endpoint_fingerprint, provider_conversation_id, status,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (@id, @provider, @endpointFingerprint, @providerConversationId, 'pending', 0, @nextAttemptAt, @createdAt, @updatedAt)
      ON CONFLICT(provider, endpoint_fingerprint, provider_conversation_id) DO NOTHING
    `),
  };

  function insertEdgeChecked(edge) {
    const parent = statements.getNode.get(edge.parentNodeId);
    const child = statements.getNode.get(edge.childNodeId);
    if (!parent || !child) throw new Error('Image lineage node not found');
    if (parent.image_session_id !== child.image_session_id || parent.image_session_id !== edge.imageSessionId) {
      throw new Error('Image lineage nodes must belong to the same image session');
    }
    if (parent.conversation_id !== child.conversation_id) {
      throw new Error('Image lineage nodes must belong to the same conversation');
    }
    if (Date.parse(parent.created_at) > Date.parse(child.created_at)) {
      throw new Error('Image lineage parent cannot postdate its child');
    }
    if (statements.findPathToNode.get(edge.childNodeId, edge.parentNodeId)) {
      throw new Error('Image lineage cycle detected');
    }
    return statements.insertEdge.run(edge);
  }

  return {
    ...statements,
    imageSchemaVersion: IMAGE_SCHEMA_VERSION,
    insertEdgeChecked,
  };
}
