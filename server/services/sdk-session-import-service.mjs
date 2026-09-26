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
  // Live evidence that the relay runs (or ran) a worker for this session in
  // the current process — queue rows alone miss a worker between turns.
  hasRelayExecutionSignal = () => false,
  logger = console,
} = {}) {
  if (!db || !stmts || typeof createClient !== 'function') throw new Error('SDK session importer requires database, statements, and a client factory');
  let runtime = null;
  let activeRun = null;
  let closing = false;
  const countConversationMessages = db.prepare(`
    SELECT COUNT(*) AS count
    FROM messages
    WHERE conversation_id = ?
  `);

  // Ownership ledger (audit #19). The importer creates a runtime binding for
  // every conversation it imports, so "a binding exists" cannot double as "the
  // relay executes this conversation" — that reading froze every imported
  // session after its first import. The ledger's origin column records who the
  // binding belongs to; relay evidence flips it durably below.
  const getImportOwnership = db.prepare(`
    SELECT status, origin
    FROM sdk_session_imports
    WHERE sdk_session_id = ?
  `);
  // Any queue row referencing the session — including done/failed ones that
  // have not been pruned yet — proves the relay queued a turn for it.
  const getQueueEvidence = db.prepare(`
    SELECT 1 AS present
    FROM queue
    WHERE conversation_id = ? OR owner_sdk_session_id = ?
    LIMIT 1
  `);
  // Durable one-way flip: once the relay owns a session, pruned queue rows or
  // a restart must not hand it back to the importer.
  const markImportRelayOwned = db.prepare(`
    UPDATE sdk_session_imports
    SET origin = 'relay', updated_at = ?
    WHERE sdk_session_id = ? AND (origin IS NULL OR origin != 'relay')
  `);
  const markImportOriginImported = db.prepare(`
    UPDATE sdk_session_imports
    SET origin = 'imported'
    WHERE sdk_session_id = ? AND (origin IS NULL OR origin = 'imported')
  `);

  function relayOwnsSession(sdkSessionId) {
    const ledger = getImportOwnership.get(sdkSessionId) || null;
    if (ledger?.origin === 'relay') return true;
    const executed = !!getQueueEvidence.get(sdkSessionId, sdkSessionId)
      || hasRelayExecutionSignal(sdkSessionId) === true;
    if (executed) {
      markImportRelayOwned.run(new Date().toISOString(), sdkSessionId);
      return true;
    }
    // origin = 'imported' is only ever written by a completed import, so it is
    // the one proof the binding belongs to the importer (and it survives a
    // later failed refresh attempt). Anything else — no ledger row, no origin —
    // means the relay created the binding (conversation bootstrap,
    // session-sync) and owns the history.
    return ledger?.origin !== 'imported';
  }

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
    // Refusing after dispose() is what stops a mid-shutdown import from
    // resurrecting a fresh SDK client the server would never tear down.
    if (closing) throw new Error('SDK session importer is shutting down');
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
      // The relay may have queued a turn while this import was reading SDK
      // events; overwriting now would replace relay history with the raw
      // transcript. Re-checked inside the transaction so the decision and the
      // write are one unit. (The durable origin flip happens in the caller —
      // an UPDATE here would roll back with the throw.)
      if (getQueueEvidence.get(sdkSessionId, sdkSessionId) || hasRelayExecutionSignal(sdkSessionId) === true) {
        const error = new Error('Relay queued a turn during import');
        error.code = 'relay-owned';
        throw error;
      }
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
      // The binding above belongs to the import, not to relay execution.
      markImportOriginImported.run(sdkSessionId);
    })();
  }

  async function importSession(session, { force = false } = {}) {
    const sdkSessionId = sessionIdOf(session);
    if (!sdkSessionId) return { status: 'skipped', category: 'unchanged', reason: 'missing-session-id' };
    if (closing) return { sdkSessionId, status: 'skipped', category: 'unchanged', reason: 'importer-closing' };
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
    // binding for that conversation used to be read as relay ownership
    // outright, but the importer itself creates a binding on every completed
    // import — that reading made the first import the last (audit #19). The
    // binding still matters (importing over relay history reproduces the
    // burn-in incident 2026-08-31: "[Relay mode: autopilot] …" surfaced as
    // user bubbles and titles after a restart), so ownership now comes from
    // the ledger: only a binding the importer did NOT account for, or actual
    // relay activity (a queued turn, a live worker), blocks the import.
    const runtimeSession = stmts.getRuntimeSessionByConversation?.get?.(sdkSessionId) || null;
    if (runtimeSession && relayOwnsSession(sdkSessionId)) {
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
      const now = new Date().toISOString();
      if (error?.code === 'relay-owned') {
        // The relay claimed the session mid-import. Flip ownership durably and
        // release the claim so the ledger row is not stuck in 'processing'.
        markImportRelayOwned.run(now, sdkSessionId);
        stmts.failSdkSessionImport.run(now, boundedError(error), sdkSessionId);
        return { sdkSessionId, status: 'skipped', category: 'relay-owned', reason: 'relay-claimed-during-import' };
      }
      stmts.failSdkSessionImport.run(now, boundedError(error), sdkSessionId);
      return { sdkSessionId, status: 'failed', category: 'failed', error: boundedError(error) };
    } finally {
      // SDK 1.0.13's CopilotSession cleanup API; the previous optional
      // stop()/dispose() calls matched nothing and leaked every resume.
      try { await resumed?.disconnect?.(); } catch {}
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
          // A shutdown mid-sweep must stop cleanly between sessions instead of
          // racing dispose() for the runtime.
          if (closing) break;
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

  /**
   * Remove a Copilot session from the runtime's own store, for a conversation
   * deleted in the relay. Goes through the SDK rather than the session-state
   * folder so the runtime's bookkeeping stays consistent. Throws when the
   * runtime cannot do it; the caller decides what that means.
   */
  async function deleteSession(sdkSessionId) {
    const sid = text(sdkSessionId);
    if (!sid) throw new Error('Missing session id');
    const client = await getRuntime();
    if (typeof client?.client?.deleteSession !== 'function') {
      throw new Error('deleteSession() is unavailable in this Copilot runtime');
    }
    await client.client.deleteSession(sid);
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
    deleteSession,
    async dispose() {
      // Flag first: getRuntime() must refuse before the client goes away, or a
      // concurrent import observes runtime = null and creates a replacement
      // while the server is exiting.
      closing = true;
      try { await activeRun; } catch {}
      const current = runtime;
      runtime = null;
      await current?.dispose?.();
    },
  };
}
