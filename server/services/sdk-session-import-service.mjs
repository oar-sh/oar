'use strict';

function text(value) {
  return String(value || '').trim();
}

function iso(value, fallback = null) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function sessionIdOf(session) {
  return text(session?.sessionId || session?.id || session?.session_id);
}

function sessionMetadata(session) {
  return session?.metadata || session || {};
}

function sourceTimestamps(session) {
  const metadata = sessionMetadata(session);
  return {
    startedAt: iso(
      metadata.startTime
      || metadata.start_time
      || metadata.createdAt
      || metadata.created_at
      || session?.startTime
      || session?.createdAt,
    ),
    modifiedAt: iso(
      metadata.modifiedTime
      || metadata.modified_time
      || metadata.updatedAt
      || metadata.updated_at
      || session?.modifiedTime
      || session?.updatedAt,
    ),
  };
}

function sessionTitle(session, messages) {
  const metadata = session?.metadata || session || {};
  const summary = text(metadata.summary || metadata.title || metadata.name);
  if (summary) return summary.slice(0, 240);
  const firstUser = (Array.isArray(messages) ? messages : []).find((message) => message?.role === 'user');
  return text(firstUser?.text).replace(/\s+/g, ' ').slice(0, 240) || 'Session';
}

async function normalizeEvents(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.sessions)) return value.sessions;
  if (Array.isArray(value?.events)) return value.events;
  if (value?.[Symbol.asyncIterator]) {
    const events = [];
    for await (const event of value) events.push(event);
    return events;
  }
  if (value?.[Symbol.iterator]) return [...value];
  return [];
}

function boundedError(error) {
  return text(error?.message || error).slice(0, 1000) || 'Unknown SDK session import failure';
}

export function createSdkSessionImportService({
  db,
  stmts,
  createClient,
  parseSessionEventsToMessages,
  replaceRetrievableHistory,
  ensureRuntimeSessionBinding,
  logger = console,
} = {}) {
  if (!db || !stmts || typeof createClient !== 'function') throw new Error('SDK session importer requires database, statements, and a client factory');
  let runtime = null;
  let activeRun = null;
  const countConversationMessages = db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE conversation_id = ?
  `);

  const upsertConversation = db.prepare(`
    INSERT INTO conversations (id, title, sdk_session_id, configured_workspace_root_path, runtime_workspace_root_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      sdk_session_id = excluded.sdk_session_id,
      title = CASE WHEN conversations.title_source = 'manual' THEN conversations.title ELSE excluded.title END,
      configured_workspace_root_path = COALESCE(conversations.configured_workspace_root_path, excluded.configured_workspace_root_path),
      runtime_workspace_root_path = COALESCE(conversations.runtime_workspace_root_path, excluded.runtime_workspace_root_path),
      updated_at = excluded.updated_at
  `);

  async function getRuntime() {
    if (!runtime) runtime = await createClient();
    return runtime;
  }

  function isTombstoned(sdkSessionId) {
    return !!stmts.getDeletedSdkSession.get(sdkSessionId);
  }

  function claim(sdkSessionId, session, { force = false } = {}) {
    const now = new Date().toISOString();
    return db.transaction(() => {
      const existing = stmts.getSdkSessionImport.get(sdkSessionId);
      const { modifiedAt } = sourceTimestamps(session);
      const hasNewerSource = modifiedAt
        && (!existing?.source_modified_at || modifiedAt > existing.source_modified_at);
      if (!force && existing?.status === 'completed' && !hasNewerSource) {
        return { claimed: null, category: 'unchanged' };
      }
      stmts.upsertSdkSessionImport.run(sdkSessionId, existing?.conversation_id || sdkSessionId, now);
      const claimed = stmts.claimSdkSessionImport.run(
        now,
        now,
        sdkSessionId,
        force || hasNewerSource ? 1 : 0,
      );
      if (claimed.changes === 0) return { claimed: null, category: 'unchanged' };
      return {
        claimed: stmts.getSdkSessionImport.get(sdkSessionId),
        category: existing?.status === 'completed' ? 'changed' : 'new',
      };
    })();
  }

  function persistCompletedImport({ sdkSessionId, session, messages }) {
    const now = new Date().toISOString();
    const metadata = sessionMetadata(session);
    const { startedAt: sourceStartedAt, modifiedAt: sourceModifiedAt } = sourceTimestamps(session);
    const updatedAt = sourceModifiedAt || now;
    const createdAt = sourceStartedAt || updatedAt;
    const workspaceRoot = text(metadata.workspaceRootPath || metadata.workspace_root_path || metadata.cwd) || null;
    const title = sessionTitle(session, messages);
    db.transaction(() => {
      upsertConversation.run(sdkSessionId, title, sdkSessionId, workspaceRoot, workspaceRoot, createdAt, updatedAt);
      ensureRuntimeSessionBinding(sdkSessionId, null, updatedAt, sdkSessionId);
      replaceRetrievableHistory(sdkSessionId, messages);
      stmts.completeSdkSessionImport.run(
        sdkSessionId,
        now,
        sourceStartedAt,
        sourceModifiedAt,
        now,
        sdkSessionId,
      );
    })();
  }

  async function importSession(session, { force = false } = {}) {
    const sdkSessionId = sessionIdOf(session);
    if (!sdkSessionId) return { status: 'skipped', category: 'unchanged', reason: 'missing-session-id' };
    if (isTombstoned(sdkSessionId)) return { sdkSessionId, status: 'skipped', category: 'tombstoned', reason: 'tombstoned' };
    // Sessions the relay created to execute an existing conversation's turns
    // are vehicles, not conversations: their history already lives in the
    // conversation they ran for. Importing them creates duplicate "shadow"
    // conversations in the list.
    const relayLink = stmts.getRelaySessionLink?.get?.(sdkSessionId) || null;
    if (relayLink && text(relayLink.conversation_id) && text(relayLink.conversation_id) !== sdkSessionId) {
      return { sdkSessionId, status: 'skipped', category: 'relay-owned', reason: 'relay-execution-session' };
    }
    // The SDK-engine workers (Copilot SDK, Claude, Cursor, Grok) run a
    // conversation's turns in a CLI session that shares the conversation's OWN
    // id — the exact equality the guard above reads as "external". A runtime
    // binding for that conversation means the relay executes it and already
    // owns its history: importing would overwrite relay messages with the raw
    // runtime transcript, instruction preambles included (burn-in incident
    // 2026-08-31: "[Relay mode: autopilot] …" surfaced as user bubbles and
    // conversation titles after a restart). This also protects an imported
    // conversation the user later CONTINUED in the relay — from that moment
    // the relay's history is authoritative, not the CLI transcript.
    const runtimeSession = stmts.getRuntimeSessionByConversation?.get?.(sdkSessionId) || null;
    if (runtimeSession) {
      return { sdkSessionId, status: 'skipped', category: 'relay-owned', reason: 'relay-execution-session' };
    }
    // Same protection when a live conversation already claims this session id
    // as its transcript binding under a different conversation id.
    const owningConversation = stmts.getConvBySdkSessionId?.get?.(sdkSessionId) || null;
    if (owningConversation && text(owningConversation.id) && text(owningConversation.id) !== sdkSessionId) {
      return { sdkSessionId, status: 'skipped', category: 'bound-elsewhere', reason: 'session-bound-to-existing-conversation' };
    }
    const claimed = claim(sdkSessionId, session, { force });
    if (!claimed.claimed) return { sdkSessionId, status: 'skipped', category: claimed.category, reason: 'unchanged-or-active' };

    let resumed = null;
    try {
      const client = await getRuntime();
      resumed = await client.client.resumeSession(sdkSessionId, {
        suppressResumeEvent: true,
        availableTools: [],
      });
      const events = await normalizeEvents(await resumed.getEvents());
      const messages = parseSessionEventsToMessages?.(events);
      if (!Array.isArray(messages)) throw new Error('SDK session import returned an invalid history snapshot');
      const existingMessageCount = Number(countConversationMessages.get(sdkSessionId)?.count || 0);
      if (messages.length === 0 && existingMessageCount > 0) {
        throw new Error('SDK session import returned an empty history snapshot for an existing conversation');
      }
      persistCompletedImport({ sdkSessionId, session, messages });
      return { sdkSessionId, status: 'completed', category: claimed.category, messageCount: messages.length };
    } catch (error) {
      stmts.failSdkSessionImport.run(new Date().toISOString(), boundedError(error), sdkSessionId);
      return { sdkSessionId, status: 'failed', category: 'failed', error: boundedError(error) };
    } finally {
      try { await resumed?.stop?.(); } catch {}
      try { await resumed?.dispose?.(); } catch {}
    }
  }

  async function runStartupImport() {
    if (activeRun) return activeRun;
    activeRun = (async () => {
      const summary = {
        listed: 0,
        new: 0,
        changed: 0,
        unchanged: 0,
        failed: 0,
        tombstoned: 0,
        'relay-owned': 0,
        'bound-elsewhere': 0,
      };
      try {
        stmts.resetInterruptedSdkSessionImports.run(new Date().toISOString());
        const client = await getRuntime();
        const sessions = await normalizeEvents(await client.client.listSessions());
        summary.listed = sessions.length;
        for (const session of sessions) {
          const result = await importSession(session);
          summary[result.category] = Number(summary[result.category] || 0) + 1;
        }
      } catch (error) {
        summary.failed += 1;
        summary.error = boundedError(error);
      } finally {
        activeRun = null;
      }
      logger.info?.(
        `[sdk-session-import] listed=${summary.listed} new=${summary.new} changed=${summary.changed}`
        + ` unchanged=${summary.unchanged} failed=${summary.failed} tombstoned=${summary.tombstoned}`
        + ` relay-owned=${summary['relay-owned']} bound-elsewhere=${summary['bound-elsewhere']}`,
      );
      return summary;
    })();
    return activeRun;
  }

  async function refreshConversation(conversation) {
    const sdkSessionId = text(conversation?.sdk_session_id || conversation?.sdkSessionId || conversation?.id);
    if (!sdkSessionId || isTombstoned(sdkSessionId)) {
      const error = new Error('Conversation not found');
      error.statusCode = 404;
      throw error;
    }
    return importSession({ sessionId: sdkSessionId, metadata: conversation }, { force: true });
  }

  return {
    runStartupImport,
    importSession,
    refreshConversation,
    async dispose() {
      const current = runtime;
      runtime = null;
      await current?.dispose?.();
    },
  };
}
