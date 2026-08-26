// SQLite schema DDL and upgrade migrations for the copilot-remote database.
//
// Extracted verbatim from server-runtime.mjs so tests can build a real replica
// of the production schema instead of hand-copying CREATE TABLE statements.
// applySchema(db) runs the exact same code path production boot uses: the
// CREATE TABLE IF NOT EXISTS block for fresh databases, then the ALTER TABLE
// upgrade sequence for existing ones. On a fresh :memory: database the ALTERs
// are all no-ops (every column already exists), so the end state is the true
// final schema either way.
import { rebuildRecentWorkspaceRootsTable } from './migrations/0002-recent-workspace-roots-path-key.mjs';
import { ensurePushSubscriptionsTable } from './migrations/0003-push-subscriptions.mjs';
import { migrateImageConversationSchema } from './repositories/image-conversation-repository.mjs';

// Mirrors DEFAULT_RELAY_MODE in server-runtime.mjs; used only by the one-time
// legacy per-mode preference carry-over below.
const DEFAULT_RELAY_MODE = 'agent';

// Base DDL for a fresh database. Existing databases reach the same shape via
// the upgrade sequence in applySchema below.
export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    title_source TEXT NOT NULL DEFAULT 'auto',
    sdk_session_id TEXT,
    preferred_relay_mode TEXT,
    preferred_model TEXT,
    preferred_reasoning_effort TEXT,
    auto_compact_window INTEGER,
    configured_workspace_root_path TEXT,
    runtime_workspace_root_path TEXT,
    archived   INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'active',
    compacted_into TEXT,
    compacted_from TEXT,
    summary_seed TEXT,
    seed_pending INTEGER NOT NULL DEFAULT 0,
    draft_text TEXT,
    draft_updated_at TEXT,
    draft_updated_by_client_id TEXT,
    draft_attachments TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    text            TEXT NOT NULL,
    model           TEXT,
    mode            TEXT,
    attachments     TEXT,
    model_requested TEXT,
    model_actual    TEXT,
    model_origin    TEXT,
    hidden_from_shares INTEGER NOT NULL DEFAULT 0,
    share_hidden_at TEXT,
    timestamp       TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, timestamp);

  CREATE TABLE IF NOT EXISTS queue (
    id                  TEXT PRIMARY KEY,
    conversation_id     TEXT NOT NULL,
    runtime_session_id  TEXT,
    is_new_conversation INTEGER NOT NULL DEFAULT 0,
    model               TEXT,
    model_variant_id    TEXT,
    reasoning_effort    TEXT,
    context_tier        TEXT,
    relay_mode          TEXT NOT NULL DEFAULT 'agent',
    text                TEXT NOT NULL,
    attachments         TEXT,
    status              TEXT NOT NULL DEFAULT 'pending',
    timestamp           TEXT NOT NULL,
    processing_at       TEXT,
    response_message_id TEXT,
    response            TEXT,
    retry_count         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TEXT,
    owner_sdk_session_id TEXT,
    owner_assigned_at   TEXT,
    owner_lease_expires_at TEXT,
    owner_last_claimed_at TEXT,
    parked_at           TEXT,
    parked_target_session_id TEXT,
    parked_transaction_id TEXT,
    parked_reason       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status, timestamp);

  CREATE TABLE IF NOT EXISTS message_usage_snapshots (
    response_message_id TEXT PRIMARY KEY,
    queue_message_id TEXT,
    conversation_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'live',
    stale INTEGER NOT NULL DEFAULT 0,
    premium_remaining REAL,
    premium_entitlement REAL,
    premium_used_percent REAL,
    premium_delta_used REAL,
    chat_remaining REAL,
    chat_entitlement REAL,
    chat_used_percent REAL,
    chat_delta_used REAL,
    plan_remaining REAL,
    plan_entitlement REAL,
    plan_used_percent REAL,
    plan_delta_used REAL,
    captured_at TEXT NOT NULL,
    FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_message_usage_conv_time ON message_usage_snapshots(conversation_id, captured_at DESC);
  CREATE INDEX IF NOT EXISTS idx_message_usage_queue_id ON message_usage_snapshots(queue_message_id);

  CREATE TABLE IF NOT EXISTS runtime_sessions (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE,
    sdk_session_id  TEXT,
    strategy        TEXT NOT NULL DEFAULT 'isolated',
    runtime_key     TEXT NOT NULL,
    model           TEXT,
    provider_type   TEXT NOT NULL DEFAULT 'github',
    provider_model  TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TEXT NOT NULL,
    last_used_at    TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_runtime_sessions_last_used ON runtime_sessions(last_used_at DESC);

  CREATE TABLE IF NOT EXISTS deleted_sdk_sessions (
    sdk_session_id TEXT PRIMARY KEY,
    deleted_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sdk_delete_requests (
    sdk_session_id TEXT PRIMARY KEY,
    conversation_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    processing_at TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sdk_delete_requests_status
    ON sdk_delete_requests(status, requested_at, next_attempt_at);

  CREATE TABLE IF NOT EXISTS sdk_session_imports (
    sdk_session_id TEXT PRIMARY KEY,
    conversation_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    source_started_at TEXT,
    source_modified_at TEXT,
    updated_at TEXT NOT NULL,
    last_error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sdk_session_imports_status
    ON sdk_session_imports(status, updated_at);

  -- Copilot SDK sessions the relay created as execution vehicles for existing
  -- conversations. The startup import sweep must never surface these as new
  -- conversations: their history already lives in the conversation they ran
  -- for (that duplication is how "shadow" conversations like a stray
  -- "procees" appeared in the conversation list).
  CREATE TABLE IF NOT EXISTS relay_session_links (
    sdk_session_id  TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );

  -- path_key is the dedupe key: on Windows it is the whole path lower-cased, so
  -- "C:\Git\Repo" and "c:\git\repo" occupy one row instead of two. See
  -- migrations/0002-recent-workspace-roots-path-key.mjs for existing databases.
  CREATE TABLE IF NOT EXISTS recent_workspace_roots (
    path_key     TEXT PRIMARY KEY,
    path         TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_recent_workspace_roots_last_seen
    ON recent_workspace_roots(last_seen_at DESC);

  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL
  );

  -- Web Push subscriptions, one row per subscribed browser installation. See
  -- migrations/0003-push-subscriptions.mjs for existing databases.
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id             TEXT PRIMARY KEY,
    device_id      TEXT NOT NULL,
    device_label   TEXT,
    endpoint       TEXT NOT NULL UNIQUE,
    keys_json      TEXT NOT NULL,
    preferences_json TEXT NOT NULL,
    user_agent     TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_success_at TEXT,
    last_error     TEXT,
    failure_count  INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_push_subscriptions_device
    ON push_subscriptions(device_id);

  CREATE TABLE IF NOT EXISTS model_selector_state (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    source       TEXT,
    refreshed_at TEXT,
    error        TEXT,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS model_variants (
    variant_id       TEXT PRIMARY KEY,
    base_model_id    TEXT NOT NULL,
    provider         TEXT NOT NULL,
    label            TEXT NOT NULL,
    release_status   TEXT,
    reasoning_effort TEXT,
    context_limit_tokens INTEGER,
    long_context_limit_tokens INTEGER,
    pricing_json     TEXT,
    enabled          INTEGER NOT NULL DEFAULT 1,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    updated_at       TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_model_variants_enabled
    ON model_variants(enabled, provider, sort_order, variant_id);

  CREATE TABLE IF NOT EXISTS relay_control_requests (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    conversation_id TEXT,
    queue_message_id TEXT,
    sdk_session_id  TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    request         TEXT,
    result          TEXT,
    error           TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    completed_at    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_relay_control_requests_status
    ON relay_control_requests(status, sdk_session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_relay_control_requests_queue
    ON relay_control_requests(queue_message_id, type, status, created_at);

  CREATE TABLE IF NOT EXISTS relay_questions (
    id              TEXT PRIMARY KEY,
    queue_id        TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    relay_mode      TEXT NOT NULL DEFAULT 'agent',
    prompt          TEXT NOT NULL,
    choices         TEXT,
    request         TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    answer          TEXT,
    structured_answer TEXT,
    request_schema  TEXT,
    sdk_session_id  TEXT,
    owner_worker_id TEXT,
    continuation_id TEXT,
    continuation_question_id TEXT,
    created_at      TEXT NOT NULL,
    answered_at     TEXT,
    expires_at      TEXT NOT NULL,
    FOREIGN KEY (queue_id) REFERENCES queue(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_relay_questions_status ON relay_questions(status, expires_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_relay_questions_conversation ON relay_questions(conversation_id, status, created_at);

  CREATE TABLE IF NOT EXISTS relay_boards (
    id                TEXT PRIMARY KEY,
    queue_id          TEXT NOT NULL,
    conversation_id   TEXT NOT NULL,
    message_id        TEXT NOT NULL,
    board_type        TEXT NOT NULL,
    relay_mode        TEXT NOT NULL DEFAULT 'agent',
    title             TEXT NOT NULL,
    body              TEXT NOT NULL,
    actions_json      TEXT,
    recommended_action TEXT,
    context_json      TEXT,
    status            TEXT NOT NULL DEFAULT 'pending',
    selected_action   TEXT,
    acted_at          TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    FOREIGN KEY (queue_id) REFERENCES queue(id) ON DELETE CASCADE,
    UNIQUE(message_id, board_type)
  );

  CREATE INDEX IF NOT EXISTS idx_relay_boards_status ON relay_boards(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_relay_boards_conversation ON relay_boards(conversation_id, status, created_at);

  CREATE TABLE IF NOT EXISTS relay_activity (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_message_id    TEXT NOT NULL,
    response_message_id TEXT,
    conversation_id     TEXT NOT NULL,
    relay_mode          TEXT NOT NULL DEFAULT 'agent',
    text                TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    metadata_json       TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_relay_activity_queue ON relay_activity(queue_message_id, id);
  CREATE INDEX IF NOT EXISTS idx_relay_activity_response ON relay_activity(response_message_id, id);

  CREATE TABLE IF NOT EXISTS relay_stream_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_message_id    TEXT NOT NULL,
    response_message_id TEXT,
    conversation_id     TEXT NOT NULL,
    relay_mode          TEXT NOT NULL DEFAULT 'agent',
    seq                 INTEGER NOT NULL,
    text                TEXT NOT NULL DEFAULT '',
    done                INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    UNIQUE(queue_message_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_relay_stream_events_queue
    ON relay_stream_events(queue_message_id, seq);
  CREATE INDEX IF NOT EXISTS idx_relay_stream_events_response
    ON relay_stream_events(response_message_id, seq);
  CREATE INDEX IF NOT EXISTS idx_relay_stream_events_conversation
    ON relay_stream_events(conversation_id, queue_message_id, seq);

  CREATE TABLE IF NOT EXISTS relay_thought (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_message_id    TEXT NOT NULL,
    response_message_id TEXT,
    conversation_id     TEXT NOT NULL,
    relay_mode          TEXT NOT NULL DEFAULT 'agent',
    reasoning_id        TEXT,
    seq                 INTEGER NOT NULL,
    text                TEXT NOT NULL,
    done                INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    UNIQUE(queue_message_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_relay_thought_queue
    ON relay_thought(queue_message_id, seq);
  CREATE INDEX IF NOT EXISTS idx_relay_thought_response
    ON relay_thought(response_message_id, seq);

  CREATE TABLE IF NOT EXISTS subagent_runs (
    id                  TEXT PRIMARY KEY,
    queue_message_id    TEXT NOT NULL,
    conversation_id     TEXT NOT NULL,
    parent_subagent_id  TEXT,
    display_name        TEXT,
    status              TEXT NOT NULL DEFAULT 'running',
    started_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    completed_at        TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_subagent_runs_queue
    ON subagent_runs(queue_message_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_subagent_runs_conversation
    ON subagent_runs(conversation_id, status);

  -- Final workflow digests attached to the assistant message that reports a
  -- background workflow's completion (the transcript's "Finished background
  -- task" card). Written inside the /api/response finalize transaction, so the
  -- rows key directly on the response message id — no queue-id resolution
  -- needed. digest_json is the sanitized workflowProgress contract, ≤ a few KB.
  -- Also declared in the upgrade db.exec below for existing databases.
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id                  TEXT PRIMARY KEY,
    response_message_id TEXT NOT NULL,
    conversation_id     TEXT NOT NULL,
    run_index           INTEGER NOT NULL DEFAULT 0,
    digest_json         TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_workflow_runs_response
    ON workflow_runs(response_message_id, run_index);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation
    ON workflow_runs(conversation_id);

  CREATE TABLE IF NOT EXISTS uploaded_files (
    sha256        TEXT PRIMARY KEY,
    original_name TEXT,
    mime_type     TEXT,
    size_bytes    INTEGER NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS upload_refs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_sha256     TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    UNIQUE(file_sha256, message_id),
    FOREIGN KEY (file_sha256) REFERENCES uploaded_files(sha256) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_upload_refs_conv ON upload_refs(conversation_id, file_sha256);
  CREATE INDEX IF NOT EXISTS idx_upload_refs_sha ON upload_refs(file_sha256);

  CREATE TABLE IF NOT EXISTS conversation_shares (
    token            TEXT PRIMARY KEY,
    conversation_id  TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    last_accessed_at TEXT,
    revoked_at       TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conversation_shares_conversation
    ON conversation_shares(conversation_id, revoked_at, created_at DESC);

  CREATE TABLE IF NOT EXISTS status_events (
    id           TEXT PRIMARY KEY,
    timestamp    INTEGER NOT NULL,
    type         TEXT NOT NULL,
    source       TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_status_events_timeline
    ON status_events(timestamp DESC, id DESC);
`;

// Creates all tables/indexes/triggers and runs the column-backfill migrations.
// Byte-for-byte the schema/migration section previously inlined in
// server-runtime.mjs — same statements, same order, same tolerance for
// already-migrated databases.
export function applySchema(db) {
db.exec(SCHEMA_SQL);
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(text, content='messages', content_rowid='rowid');

  CREATE TRIGGER IF NOT EXISTS messages_fts_after_insert
  AFTER INSERT ON messages
  BEGIN
    INSERT INTO messages_fts(rowid, text)
    VALUES (new.rowid, new.text);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_after_delete
  AFTER DELETE ON messages
  BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text)
    VALUES ('delete', old.rowid, old.text);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_after_update
  AFTER UPDATE OF text ON messages
  BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text)
    VALUES ('delete', old.rowid, old.text);
    INSERT INTO messages_fts(rowid, text)
    VALUES (new.rowid, new.text);
  END;
`);
// The extension-backed history queue is superseded by the local SDK importer.
db.exec(`DROP TABLE IF EXISTS sdk_history_fetch_requests`);
// Only rebuild the FTS index if the virtual table is empty (first migration or new DB).
// A full rebuild is O(N) in message count and blocks the sync event loop, so we skip it
// when existing trigger-maintained rows are already present.
{
  const ftsRowCount = db.prepare(`SELECT COUNT(*) AS cnt FROM messages_fts`).get()?.cnt || 0;
  if (ftsRowCount === 0) {
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);
  }
}

// Backfill schema for pre-model databases.
const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name);
if (!messageColumns.includes('attachments')) {
  db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`);
}
if (!messageColumns.includes('mode')) {
  db.exec(`ALTER TABLE messages ADD COLUMN mode TEXT`);
}
if (!messageColumns.includes('model_requested')) {
  db.exec(`ALTER TABLE messages ADD COLUMN model_requested TEXT`);
}
if (!messageColumns.includes('model_actual')) {
  db.exec(`ALTER TABLE messages ADD COLUMN model_actual TEXT`);
}
if (!messageColumns.includes('model_origin')) {
  db.exec(`ALTER TABLE messages ADD COLUMN model_origin TEXT`);
}
if (!messageColumns.includes('hidden_from_shares')) {
  db.exec(`ALTER TABLE messages ADD COLUMN hidden_from_shares INTEGER NOT NULL DEFAULT 0`);
}
if (!messageColumns.includes('share_hidden_at')) {
  db.exec(`ALTER TABLE messages ADD COLUMN share_hidden_at TEXT`);
}
if (!messageColumns.includes('executed_provider')) {
  // Which provider actually ran the turn, derived from the authenticated
  // responder identity — never from the response payload. A value that
  // differs from the conversation's provider marks a cross-provider
  // execution (e.g. the Copilot relay answering a Cursor conversation).
  db.exec(`ALTER TABLE messages ADD COLUMN executed_provider TEXT`);
}
if (!messageColumns.includes('kind')) {
  // 'continuation' marks an assistant message the CLI produced on its own
  // after a background task settled (no user prompt); the client badges it.
  db.exec(`ALTER TABLE messages ADD COLUMN kind TEXT`);
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_share_visibility
  ON messages(conversation_id, hidden_from_shares, timestamp)
`);

const sdkSessionImportColumns = db.prepare(`PRAGMA table_info(sdk_session_imports)`).all().map((c) => c.name);
if (!sdkSessionImportColumns.includes('source_started_at')) {
  db.exec(`ALTER TABLE sdk_session_imports ADD COLUMN source_started_at TEXT`);
}
if (!sdkSessionImportColumns.includes('source_modified_at')) {
  db.exec(`ALTER TABLE sdk_session_imports ADD COLUMN source_modified_at TEXT`);
}

const queueColumns = db.prepare(`PRAGMA table_info(queue)`).all().map((c) => c.name);
if (!queueColumns.includes('model')) {
  db.exec(`ALTER TABLE queue ADD COLUMN model TEXT`);
}
if (!queueColumns.includes('model_variant_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN model_variant_id TEXT`);
}
if (!queueColumns.includes('reasoning_effort')) {
  db.exec(`ALTER TABLE queue ADD COLUMN reasoning_effort TEXT`);
}
if (!queueColumns.includes('context_tier')) {
  db.exec(`ALTER TABLE queue ADD COLUMN context_tier TEXT`);
}
if (!queueColumns.includes('runtime_session_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN runtime_session_id TEXT`);
}
if (!queueColumns.includes('relay_mode')) {
  db.exec(`ALTER TABLE queue ADD COLUMN relay_mode TEXT NOT NULL DEFAULT 'agent'`);
}
if (!queueColumns.includes('attachments')) {
  db.exec(`ALTER TABLE queue ADD COLUMN attachments TEXT`);
}
if (!queueColumns.includes('retry_count')) {
  db.exec(`ALTER TABLE queue ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
}
if (!queueColumns.includes('next_attempt_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN next_attempt_at TEXT`);
}
if (!queueColumns.includes('owner_sdk_session_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN owner_sdk_session_id TEXT`);
}
if (!queueColumns.includes('owner_assigned_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN owner_assigned_at TEXT`);
}
if (!queueColumns.includes('owner_lease_expires_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN owner_lease_expires_at TEXT`);
}
if (!queueColumns.includes('owner_last_claimed_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN owner_last_claimed_at TEXT`);
}
if (!queueColumns.includes('response_message_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN response_message_id TEXT`);
}
if (!queueColumns.includes('parked_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN parked_at TEXT`);
}
if (!queueColumns.includes('parked_target_session_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN parked_target_session_id TEXT`);
}
if (!queueColumns.includes('kind')) {
  // 'continuation' rows are synthetic turns for the Claude worker's
  // background-task continuations: born 'processing', never deliverable, and
  // torn down (not requeued) when their worker disappears.
  db.exec(`ALTER TABLE queue ADD COLUMN kind TEXT`);
}

// recent_workspace_roots gained a case-normalized primary key (path_key). The
// CREATE TABLE IF NOT EXISTS above only covers fresh databases, so upgrade an
// existing one in place before any statement referencing path_key is prepared.
const recentWorkspaceRootsRebuild = rebuildRecentWorkspaceRootsTable(db);
if (recentWorkspaceRootsRebuild.applied) {
  console.log(`[workspace-root] rebuilt recent CWD history: ${recentWorkspaceRootsRebuild.rowsBefore} row(s) -> ${recentWorkspaceRootsRebuild.rowsAfter} distinct directory/ies`);
}
// The CREATE TABLE IF NOT EXISTS above covers fresh databases; this upgrades
// an existing one before the push dispatch service prepares its statements.
const pushSubscriptionsMigration = ensurePushSubscriptionsTable(db);
if (pushSubscriptionsMigration.applied) {
  console.log(`[push] created push_subscriptions table`);
}
if (!queueColumns.includes('parked_transaction_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN parked_transaction_id TEXT`);
}
if (!queueColumns.includes('parked_reason')) {
  db.exec(`ALTER TABLE queue ADD COLUMN parked_reason TEXT`);
}
db.exec(`UPDATE queue SET relay_mode = 'agent' WHERE relay_mode IS NULL OR relay_mode = ''`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_next_attempt ON queue(status, next_attempt_at, timestamp)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_owner_pending ON queue(status, owner_sdk_session_id, next_attempt_at, timestamp)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_parked_release ON queue(status, parked_transaction_id, parked_target_session_id, parked_at, timestamp)`);
migrateImageConversationSchema(db);

const runtimeSessionColumns = db.prepare(`PRAGMA table_info(runtime_sessions)`).all().map((c) => c.name);
if (runtimeSessionColumns.length) {
  if (!runtimeSessionColumns.includes('strategy')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN strategy TEXT NOT NULL DEFAULT 'isolated'`);
  }
  if (!runtimeSessionColumns.includes('sdk_session_id')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN sdk_session_id TEXT`);
  }
  if (!runtimeSessionColumns.includes('runtime_key')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN runtime_key TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE runtime_sessions SET runtime_key = id WHERE runtime_key IS NULL OR runtime_key = ''`);
  }
  if (!runtimeSessionColumns.includes('model')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN model TEXT`);
  }
  if (!runtimeSessionColumns.includes('provider_type')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'github'`);
  }
  if (!runtimeSessionColumns.includes('provider_model')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN provider_model TEXT`);
  }
  if (!runtimeSessionColumns.includes('claude_native_session_id')) {
    // Native Claude Agent SDK session id captured from the worker's first
    // turn; passed back as `resume` so Claude conversations survive worker
    // restarts.
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN claude_native_session_id TEXT`);
  }
  if (!runtimeSessionColumns.includes('cursor_agent_id')) {
    // Cursor Agent SDK durable agent id; replayed on queue messages so Cursor
    // conversations survive worker restarts.
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN cursor_agent_id TEXT`);
  }
  if (!runtimeSessionColumns.includes('grok_native_session_id')) {
    // ACP session id from Grok agent session/new; replayed via session/load so
    // Grok conversations survive worker restarts.
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN grok_native_session_id TEXT`);
  }
  if (!runtimeSessionColumns.includes('context_usage_json')) {
    // Latest context-window breakdown reported by the Claude Agent SDK. Claude
    // sessions have no Copilot events.jsonl to tail, so this is the only source
    // of context data for them.
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN context_usage_json TEXT`);
  }
  if (!runtimeSessionColumns.includes('context_usage_captured_at')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN context_usage_captured_at TEXT`);
  }
  if (!runtimeSessionColumns.includes('status')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  }
  if (!runtimeSessionColumns.includes('created_at')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))`);
  }
  if (!runtimeSessionColumns.includes('last_used_at')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN last_used_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))`);
  }
}

const conversationColumns = db.prepare(`PRAGMA table_info(conversations)`).all().map((c) => c.name);
if (!conversationColumns.includes('archived')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
}
if (!conversationColumns.includes('sdk_session_id')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN sdk_session_id TEXT`);
}
if (!conversationColumns.includes('preferred_relay_mode')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN preferred_relay_mode TEXT`);
}
if (!conversationColumns.includes('preferred_model')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN preferred_model TEXT`);
}
if (!conversationColumns.includes('preferred_reasoning_effort')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN preferred_reasoning_effort TEXT`);
  // One-time carry-over from the retired per-mode preference maps: seed the flat
  // preference from the entry stored for the conversation's preferred mode.
  if (conversationColumns.includes('preferred_models_by_mode')) {
    const legacyRows = db.prepare(`
      SELECT id, preferred_relay_mode, preferred_models_by_mode, preferred_reasoning_by_mode
      FROM conversations
      WHERE preferred_models_by_mode IS NOT NULL OR preferred_reasoning_by_mode IS NOT NULL
    `).all();
    const seedFlatPreference = db.prepare(`UPDATE conversations SET preferred_model = ?, preferred_reasoning_effort = ? WHERE id = ?`);
    for (const legacyRow of legacyRows) {
      let modelsByMode = {};
      let reasoningByMode = {};
      try { modelsByMode = JSON.parse(legacyRow.preferred_models_by_mode || '{}') || {}; } catch { modelsByMode = {}; }
      try { reasoningByMode = JSON.parse(legacyRow.preferred_reasoning_by_mode || '{}') || {}; } catch { reasoningByMode = {}; }
      const mode = String(legacyRow.preferred_relay_mode || '').trim() || DEFAULT_RELAY_MODE;
      const model = String(modelsByMode?.[mode] || '').trim() || null;
      const effort = String(reasoningByMode?.[mode] || '').trim().toLowerCase() || null;
      if (model || effort) seedFlatPreference.run(model, effort, legacyRow.id);
    }
  }
}
if (!conversationColumns.includes('auto_compact_window')) {
  // Token count (not a percent); NULL = "Auto", i.e. the model-tuned default
  // the Claude CLI picks on its own. See shared/auto-compact-window.mjs.
  db.exec(`ALTER TABLE conversations ADD COLUMN auto_compact_window INTEGER`);
}
if (!conversationColumns.includes('configured_workspace_root_path')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN configured_workspace_root_path TEXT`);
}
if (!conversationColumns.includes('runtime_workspace_root_path')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN runtime_workspace_root_path TEXT`);
}
if (!conversationColumns.includes('compacted_into')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN compacted_into TEXT`);
}
if (!conversationColumns.includes('compacted_from')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN compacted_from TEXT`);
}
if (!conversationColumns.includes('summary_seed')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN summary_seed TEXT`);
}
if (!conversationColumns.includes('seed_pending')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN seed_pending INTEGER NOT NULL DEFAULT 0`);
}
if (!conversationColumns.includes('status')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
}
if (!conversationColumns.includes('title_source')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto'`);
}
if (!conversationColumns.includes('draft_text')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN draft_text TEXT`);
}
if (!conversationColumns.includes('draft_updated_at')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN draft_updated_at TEXT`);
}
if (!conversationColumns.includes('draft_updated_by_client_id')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN draft_updated_by_client_id TEXT`);
}
if (!conversationColumns.includes('draft_attachments')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN draft_attachments TEXT`);
}

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_sessions_sdk_session_id ON runtime_sessions(sdk_session_id) WHERE sdk_session_id IS NOT NULL AND sdk_session_id != ''`);

const relayQuestionColumns = db.prepare(`PRAGMA table_info(relay_questions)`).all().map((c) => c.name);
if (relayQuestionColumns.length && !relayQuestionColumns.includes('sdk_session_id')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN sdk_session_id TEXT`);
}
if (relayQuestionColumns.length && !relayQuestionColumns.includes('owner_worker_id')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN owner_worker_id TEXT`);
}
if (relayQuestionColumns.length && !relayQuestionColumns.includes('continuation_id')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN continuation_id TEXT`);
}
if (relayQuestionColumns.length && !relayQuestionColumns.includes('continuation_question_id')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN continuation_question_id TEXT`);
}
if (relayQuestionColumns.length && !relayQuestionColumns.includes('structured_answer')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN structured_answer TEXT`);
}
if (relayQuestionColumns.length && !relayQuestionColumns.includes('request_schema')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN request_schema TEXT`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_relay_questions_continuation ON relay_questions(continuation_id, continuation_question_id, status, created_at)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS subagent_runs (
    id                  TEXT PRIMARY KEY,
    queue_message_id    TEXT NOT NULL,
    conversation_id     TEXT NOT NULL,
    parent_subagent_id  TEXT,
    display_name        TEXT,
    status              TEXT NOT NULL DEFAULT 'running',
    started_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    completed_at        TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_subagent_runs_queue
    ON subagent_runs(queue_message_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_subagent_runs_conversation
    ON subagent_runs(conversation_id, status);
`);

// Existing databases pick up the workflow_runs side table here; fresh ones get
// it from the main schema block above (same dual-declaration pattern as
// subagent_runs).
db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id                  TEXT PRIMARY KEY,
    response_message_id TEXT NOT NULL,
    conversation_id     TEXT NOT NULL,
    run_index           INTEGER NOT NULL DEFAULT 0,
    digest_json         TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_response
    ON workflow_runs(response_message_id, run_index);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation
    ON workflow_runs(conversation_id);
`);

const relayActivityColumns = db.prepare(`PRAGMA table_info(relay_activity)`).all().map((c) => c.name);
if (relayActivityColumns.length && !relayActivityColumns.includes('subagent_run_id')) {
  db.exec(`ALTER TABLE relay_activity ADD COLUMN subagent_run_id TEXT`);
}
// Structured payload for activity rows that the transcript renders as more
// than prose — today only the Claude compaction boundary
// ({kind:'compact_boundary', preTokens, postTokens}), which becomes a
// full-width break row instead of a line inside the tool-activity details.
if (relayActivityColumns.length && !relayActivityColumns.includes('metadata_json')) {
  db.exec(`ALTER TABLE relay_activity ADD COLUMN metadata_json TEXT`);
}
const relayThoughtColumns = db.prepare(`PRAGMA table_info(relay_thought)`).all().map((c) => c.name);
if (relayThoughtColumns.length && !relayThoughtColumns.includes('subagent_run_id')) {
  db.exec(`ALTER TABLE relay_thought ADD COLUMN subagent_run_id TEXT`);
}
db.exec(`
  DELETE FROM relay_thought
  WHERE id IN (
    SELECT older.id
    FROM relay_thought AS older
    JOIN relay_thought AS newer
      ON older.queue_message_id = newer.queue_message_id
     AND older.reasoning_id = newer.reasoning_id
     AND older.reasoning_id IS NOT NULL
     AND older.reasoning_id != ''
     AND (
       older.seq < newer.seq
       OR (older.seq = newer.seq AND older.id < newer.id)
     )
  )
`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_thought_queue_reasoning
    ON relay_thought(queue_message_id, reasoning_id)
    WHERE reasoning_id IS NOT NULL AND reasoning_id != ''
`);
const relayStreamEventColumns = db.prepare(`PRAGMA table_info(relay_stream_events)`).all().map((c) => c.name);
if (relayStreamEventColumns.length && !relayStreamEventColumns.includes('subagent_run_id')) {
  db.exec(`ALTER TABLE relay_stream_events ADD COLUMN subagent_run_id TEXT`);
}
const modelVariantColumns = db.prepare(`PRAGMA table_info(model_variants)`).all().map((c) => c.name);
if (modelVariantColumns.length && !modelVariantColumns.includes('context_limit_tokens')) {
  db.exec(`ALTER TABLE model_variants ADD COLUMN context_limit_tokens INTEGER`);
}
if (modelVariantColumns.length && !modelVariantColumns.includes('long_context_limit_tokens')) {
  db.exec(`ALTER TABLE model_variants ADD COLUMN long_context_limit_tokens INTEGER`);
}
if (modelVariantColumns.length && !modelVariantColumns.includes('pricing_json')) {
  db.exec(`ALTER TABLE model_variants ADD COLUMN pricing_json TEXT`);
}
}
