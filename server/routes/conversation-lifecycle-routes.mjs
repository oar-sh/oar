'use strict';

// The routes that end or restart one conversation: compact, delete,
// archive (one conversation or a session group), unarchive, registered by
// registerSessionsRoutes.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { sessionLaunchMutex } from '../services/session-launch-mutex-service.mjs';
import { admitRemoteRelayRequest, readRemoteRelayRequest } from '../services/remote-relay-inbound.mjs';
import { notPerson } from '../services/relay-principal.mjs';
import { removeClaudeSessionLeftovers } from '../services/claude-session-leftovers.mjs';
import { DEEPSEEK_USAGE_CHECKPOINTS_TABLE } from '../migrations/0024-deepseek-usage-totals.mjs';
import { claudeProjectDirSlug } from '../services/claude-session-root-service.mjs';
import { buildTerminalFailureTextForChat } from './messages-helpers.mjs';
import { mapSubagentRunHeader } from '../services/subagent-timeline-service.mjs';
import { QUEUE_WAKE_FUNCTION } from '../services/queue-wake-hook.mjs';
import { QUEUE_ROW_SESSION_SQL, notHeldForUsageLimit } from '../repositories/message-repository.mjs';
import { createWorkerSessionLiveness } from '../services/worker-session-liveness.mjs';
import { compactRefusalBody } from '../services/conversation-compaction-service.mjs';
import { isCopilotProviderType } from '../services/copilot-settings-service.mjs';

/**
 * Registers the routes; returns `{ archiveConversationNow }`, the archive of
 * one conversation that both archive routes run.
 */
export function registerConversationLifecycleRoutes(app, deps, shared) {
  const {
    auth,
    io,
    db,
    stmts,
    parseAttachments,
    hydrateAttachment,
    backgroundTaskStore,
    closeConversationPreviews,
    createCompactedConversation,
    collectOrphanedUploadsFromConversation,
    deleteOrphanedUploads,
    sdkSessionImportService,
    sessionWorkerSupervisor,
    sessionWorkerRegistry,
    sessionWorkerProcessInspector,
    resolveSessionStateRoot,
    DEFAULT_RELAY_MODE,
  } = deps;
  const {
    failQueueMessage,
    cleanupGeneratedImagesForConversation,
    claudeCloudSessionService,
    conversationGroups,
    remoteRelayInbound,
    sessionWorkerStopOverrides,
    usageLimitPauseService,
    relayEventService,
    relayScheduleService,
    relayAskService,
    formatQuestionRow,
    sessionActivityTracker,
    tokenUsageService,
    backgroundWorkView,
    resolveClaudeSessionRoot,
    resolveDeepSeekSessionRoot,
    deepseekClaudeConfigDir,
    shares,
    emitGroupChanged,
    isPidAlive,
    stopIdleWorkspaceRootSession,
    resolveConversationTitle,
    isCopilotEnabled = () => true,
  } = shared;

  const CLI_SESSION_DELETE_TIMEOUT_MS = 10_000;
  // The archive's process probe, all sessions together (a test sets it shorter).
  const processProbeTimeoutMs = Number(deps.archiveProcessProbeTimeoutMs) > 0 ? Number(deps.archiveProcessProbeTimeoutMs) : 5_000;
  const LIVE_WORKER_STATUSES = new Set(['starting', 'ready', 'processing']);
  // A session id that is safe to join into a path under the session-state root.
  const SESSION_FOLDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  const markConversationDeleted = db.prepare(`UPDATE conversations SET status = 'deleted', updated_at = ? WHERE id = ?`);
  const countProcessingConversationQueueRows = db.prepare(`
    SELECT COUNT(*) AS count
    FROM queue
    WHERE conversation_id = ?
      AND status = 'processing'
  `);
  const listProcessingConversationRows = db.prepare(`
    SELECT *
    FROM queue
    WHERE conversation_id = ?
      AND status = 'processing'
    ORDER BY timestamp ASC, rowid ASC
  `);
  // The rows an archive cancels: those still waiting for a worker.
  const listQueuedConversationRows = db.prepare(`
    SELECT *
    FROM queue
    WHERE conversation_id = ?
      AND status IN ('pending', 'parked')
    ORDER BY timestamp ASC, rowid ASC
  `);
  // The sessions whose workers take the conversation's pending rows, by the
  // waker's own rule (listPendingWorkerOwnerSessionIds): a follow-up held at
  // the usage limit waits for its reset, not for a worker. Prepared on first
  // use, at the first unarchive.
  let listPendingConversationSessionIds = null;
  const LIST_PENDING_CONVERSATION_SESSION_IDS_SQL = `
    SELECT DISTINCT ${QUEUE_ROW_SESSION_SQL} AS sdk_session_id
    FROM queue q
    LEFT JOIN runtime_sessions rs
      ON rs.id = q.runtime_session_id
    LEFT JOIN conversations c
      ON c.id = q.conversation_id
    WHERE q.conversation_id = ?
      AND q.status = 'pending'
      ${notHeldForUsageLimit('q.')}
  `;
  // The wake through the queue triggers' own function, prepared on first use.
  let wakeQueueStatement = null;
  const findOtherLiveConversationForSdkSession = db.prepare(`
    SELECT id
    FROM conversations
    WHERE sdk_session_id = ?
      AND id != ?
      AND status != 'deleted'
    LIMIT 1
  `);
  // Asked on each delete: the usage service creates the table at its own
  // start, which may come after these routes'.
  const findDeepSeekUsageCheckpointsTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`);
  const hardDeleteConversationRows = db.transaction((conversationId) => {
    if (typeof stmts.deleteConvQuestions?.run === 'function') {
      stmts.deleteConvQuestions.run(conversationId);
    } else {
      db.prepare(`DELETE FROM relay_questions WHERE conversation_id = ?`).run(conversationId);
    }
    if (typeof stmts.deleteConvBoards?.run === 'function') {
      stmts.deleteConvBoards.run(conversationId);
    } else {
      db.prepare(`DELETE FROM relay_boards WHERE conversation_id = ?`).run(conversationId);
    }
    if (typeof stmts.deleteConvStreamEvents?.run === 'function') {
      stmts.deleteConvStreamEvents.run(conversationId);
    } else {
      db.prepare(`DELETE FROM relay_stream_events WHERE conversation_id = ?`).run(conversationId);
    }
    if (typeof stmts.deleteConvThoughts?.run === 'function') {
      stmts.deleteConvThoughts.run(conversationId);
    } else {
      db.prepare(`DELETE FROM relay_thought WHERE conversation_id = ?`).run(conversationId);
    }
    if (typeof stmts.deleteConvPreviewCards?.run === 'function') {
      stmts.deleteConvPreviewCards.run(conversationId);
    } else {
      db.prepare(`DELETE FROM preview_cards WHERE conversation_id = ?`).run(conversationId);
    }
    db.prepare(`DELETE FROM queue WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM runtime_sessions WHERE conversation_id = ?`).run(conversationId);
    // A DeepSeek conversation's usage checkpoints are only good for diffing its
    // later reports; the totals and days they fed stay, as history.
    if (findDeepSeekUsageCheckpointsTable.get(DEEPSEEK_USAGE_CHECKPOINTS_TABLE)) {
      db.prepare(`DELETE FROM ${DEEPSEEK_USAGE_CHECKPOINTS_TABLE} WHERE conversation_id = ?`).run(conversationId);
    }
    // Its turns' tokens go with it; the day sums behind Check Usage stay.
    tokenUsageService?.forgetConversation?.(conversationId);
    // The share access log goes with it; the share rows follow the foreign key.
    shares().forgetConversation(conversationId);
    db.prepare(`DELETE FROM conversations WHERE id = ?`).run(conversationId);
  });

  function shortId(value) {
    const text = String(value || '').trim();
    if (!text) return 'none';
    return `${text.slice(0, 8)}…`;
  }

  /**
   * Whether a conversation is still working, which blocks deleting it: a turn
   * is running (including one waiting on a question card or an approval) or
   * background tasks are live. Both only count while the session's worker is
   * alive: a dead worker runs nothing, and the processing rows or task set it
   * left behind would otherwise make the conversation undeletable. A session
   * the registry has never seen may still be running a turn, so its
   * processing rows count.
   *
   * A worker's pid decides whether it is alive; its status only when it has
   * none. A turn that fails marks a worker that is still running 'error',
   * and it stays so until its next turn, background tasks and all.
   */
  function isWorkerAlive(worker) {
    return !!worker && (worker.pid
      ? isPidAlive(worker.pid)
      : LIVE_WORKER_STATUSES.has(String(worker.status || '').trim().toLowerCase()));
  }

  function describeConversationActivity(conversationId, workerSessionId) {
    const worker = sessionWorkerRegistry?.getWorker?.(workerSessionId) || null;
    const workerAlive = isWorkerAlive(worker);
    const processingCount = Number(countProcessingConversationQueueRows.get(conversationId)?.count || 0);
    const taskKeys = [...new Set([conversationId, workerSessionId])];
    let liveTasks = workerAlive ? taskKeys.flatMap((key) => backgroundTaskStore?.get?.(key) || []) : [];
    // No published set, but the worker says it has background work the
    // relay was never told the details of: that counts, with no Stop button.
    if (workerAlive && !liveTasks.length && backgroundWorkView) liveTasks = backgroundWorkView.panelTasks(...taskKeys);
    return {
      turnRunning: processingCount > 0 && (workerAlive || !worker),
      backgroundTaskCount: liveTasks.length,
      // Tasks the panel shows no Stop button for (Copilot detached shells).
      unstoppableTaskCount: liveTasks.filter((task) => task?.stoppable === false).length,
    };
  }

  function withDeadline(promise, timeoutMs, label) {
    let timer = null;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /**
   * The Claude CLI's footprint for one session: its transcript
   * (`<projectDir>/<nativeSessionId>.jsonl`) and the per-session folder beside
   * it. Nothing else in the project folder is touched — it holds every other
   * session of that workspace and the project memory.
   */
  function deleteClaudeCliSession({ conversation, runtimeSession, resolveRoot = resolveClaudeSessionRoot }) {
    const nativeSessionId = String(runtimeSession?.claude_native_session_id || '').trim();
    if (!nativeSessionId || typeof resolveRoot !== 'function') return { deleted: null };
    const anchors = resolveRoot({
      claudeNativeSessionId: nativeSessionId,
      workspaceRootPath: String(
        conversation?.runtime_workspace_root_path || conversation?.configured_workspace_root_path || '',
      ).trim(),
    });
    if (!anchors?.projectDirPath) return { deleted: null };
    const projectDir = path.resolve(anchors.projectDirPath);
    const targets = [anchors.transcriptPath, anchors.sessionRootExists ? anchors.sessionRootPath : '']
      .filter(Boolean)
      .map((target) => path.resolve(target))
      .filter((target) => path.dirname(target) === projectDir
        && [nativeSessionId, `${nativeSessionId}.jsonl`].includes(path.basename(target)));
    for (const target of targets) fs.rmSync(target, { recursive: true, force: true });
    return { deleted: targets.length > 0, projectDirPath: projectDir };
  }

  /**
   * A DeepSeek conversation's Claude Code session: the transcript as for
   * Claude, then what the killed CLI left in the relay's own config directory
   * (its hook environment, registration, shell snapshot, and the project
   * folder once no session is left in it).
   */
  function deleteDeepSeekCliSession({ conversation, runtimeSession }) {
    const outcome = deleteClaudeCliSession({ conversation, runtimeSession, resolveRoot: resolveDeepSeekSessionRoot });
    const configRoot = String(deepseekClaudeConfigDir || '').trim();
    const nativeSessionId = String(runtimeSession?.claude_native_session_id || '').trim();
    if (!configRoot || !nativeSessionId) return { deleted: outcome.deleted };
    const workspaceRoot = String(conversation?.runtime_workspace_root_path || conversation?.configured_workspace_root_path || '').trim();
    const projectDirPath = outcome.projectDirPath
      || (workspaceRoot ? path.join(configRoot, 'projects', claudeProjectDirSlug(workspaceRoot)) : '');
    const removed = removeClaudeSessionLeftovers({ configRoot, nativeSessionId, projectDirPath });
    return { deleted: outcome.deleted === null && removed.length ? true : outcome.deleted };
  }

  /**
   * The Copilot session, through the runtime's own deleteSession(). Nothing
   * retries one that fails: its state stays in the session-state folder.
   * `copilotOff`: a Copilot chat while Copilot is switched off, for which the
   * runtime is not started; its state stays there too.
   */
  async function deleteCopilotCliSession({ sdkSessionId, copilotOff = false }) {
    const stateRoot = String(resolveSessionStateRoot?.() || '').trim();
    const sessionDir = stateRoot && SESSION_FOLDER_ID_PATTERN.test(sdkSessionId) ? path.join(stateRoot, sdkSessionId) : '';
    // A conversation deleted before its first turn has no session on disk yet
    // (the runtime would answer "Session file not found").
    if (sessionDir && !fs.existsSync(sessionDir)) return { deleted: null };
    if (copilotOff) {
      console.warn(`[delete] Copilot session ${shortId(sdkSessionId)} was kept: Copilot is switched off on this relay`);
      return { deleted: false };
    }
    if (typeof sdkSessionImportService?.deleteSession !== 'function') return { deleted: null };
    try {
      await withDeadline(
        sdkSessionImportService.deleteSession(sdkSessionId),
        CLI_SESSION_DELETE_TIMEOUT_MS,
        'Copilot deleteSession()',
      );
      return { deleted: true };
    } catch (error) {
      const reason = String(error?.message || error);
      if (/Session file not found/i.test(reason)) {
        // The runtime keeps no session for it, only this session's own
        // folder (a run that never wrote its session file): nothing to retry.
        if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
        return { deleted: sessionDir ? true : null };
      }
      console.warn(`[delete] Copilot session ${shortId(sdkSessionId)} was not deleted: ${reason}`);
      return { deleted: false };
    }
  }

  /** The conversation's CLI-side session, per provider; null where the relay keeps none. */
  async function deleteCliSession({ conversation, conversationId, sdkSessionId, runtimeSession }) {
    const provider = String(runtimeSession?.provider_type || '').trim().toLowerCase();
    try {
      if (provider === 'claude' || provider === 'claude-api') return deleteClaudeCliSession({ conversation, runtimeSession });
      if (provider === 'deepseek') return deleteDeepSeekCliSession({ conversation, runtimeSession });
      if (!sdkSessionId) return { deleted: null };
      if (!provider || provider === 'github' || provider === 'openai') {
        return await deleteCopilotCliSession({ sdkSessionId, copilotOff: isCopilotProviderType(provider) && !isCopilotEnabled() });
      }
      return { deleted: null };
    } catch (error) {
      // The conversation is already tombstoned: a file the OS will not let go
      // of must not leave it half deleted.
      console.warn(`[delete] CLI session of ${shortId(conversationId)} was not deleted: ${error?.message || error}`);
      return { deleted: false };
    }
  }

  app.post('/api/conversation/:id/compact', auth, (req, res) => {
    const sourceConversationId = req.params.id;
    const compacted = createCompactedConversation(sourceConversationId);
    if (!compacted) return res.status(404).json({ error: 'Conversation not found' });
    // Its provider cannot take a new chat now: nothing was created or archived.
    if (compacted.ok === false) return res.status(compacted.status).json(compactRefusalBody(compacted, sourceConversationId));
    io.emit('conversation_compacted', compacted);
    res.json({
      ok: true,
      sourceConversationId: compacted.sourceConversationId,
      compactedConversationId: compacted.targetConversationId,
      conversationId: compacted.targetConversationId,
      runtimeSessionId: compacted.runtimeSessionId,
      summarySeedPreview: compacted.summarySeed.slice(0, 240),
    });
  });

  // DELETE /api/conversation/:id — delete conversation
  app.delete('/api/conversation/:id', auth, async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing conversation id' });

    const existing = stmts.getConvAnyStatus.get(id);
    if (!existing) {
      return res.json({ ok: true, alreadyDeleted: true });
    }

    try {
      // Session workers are keyed by the SDK session id, which is the
      // conversation id until a session is bound. Serialized with launches and
      // relaunches of that session, and with a second delete of it.
      const workerSessionId = String(existing.sdk_session_id || '').trim() || id;
      const outcome = await sessionLaunchMutex.runExclusive(
        workerSessionId,
        () => deleteConversationNow(id),
      );
      return res.status(outcome.statusCode).json(outcome.body);
    } catch (error) {
      console.warn(`[archive] Delete failed for ${id}: ${error?.message || error}`);
      return res.status(500).json({ error: 'Failed to delete conversation' });
    }
  });

  /** DELETE /api/conversation/:id under its session's lock; see the route. */
  async function deleteConversationNow(id) {
    const existing = stmts.getConvAnyStatus.get(id);
    if (!existing) return { statusCode: 200, body: { ok: true, alreadyDeleted: true } };
    const sdkSessionId = String(existing.sdk_session_id || '').trim() || null;
    const workerSessionId = sdkSessionId || id;

    const activity = describeConversationActivity(id, workerSessionId);
    if (activity.turnRunning) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: 'conversation-active',
          reason: 'turn-running',
          message: 'This conversation is still working on a reply. Stop it, then delete it.',
        },
      };
    }
    if (activity.backgroundTaskCount > 0) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: 'conversation-active',
          reason: 'background-tasks',
          // Kill session stops the session's worker, and the delete counts no
          // tasks for a conversation whose worker is gone.
          message: activity.unstoppableTaskCount > 0
            ? 'Background tasks are still running in this conversation, and some have no Stop button. Use Kill session in its ︙ menu, then delete it.'
            : 'Background tasks are still running in this conversation. Stop them in the task panel, then delete it.',
        },
      };
    }

    // A worker and CLI session that another live conversation still uses
    // stay; only this conversation's own data goes.
    const sharedWithConversationId = sdkSessionId
      ? String(findOtherLiveConversationForSdkSession.get(sdkSessionId, id)?.id || '').trim() || null
      : null;
    // A Copilot session the relay only imported, and never ran, belongs to
    // whoever started it in the CLI. Deleting the conversation hides and
    // tombstones it, and nothing more: the relay started no process for it
    // (the process scan would find that user's own `copilot --resume`), and
    // its CLI session stays. Asked before the stop, which removes the registry
    // entry that shows the relay has run it.
    const importedOnly = !!sdkSessionId && sdkSessionImportService?.isImportedOnly?.(sdkSessionId) === true;

    // An idle worker is stopped before anything is deleted: the route used to
    // leave it running (and holding its workspace) until the relay restarted.
    // Nothing is touched when it will not die.
    let workerStopped = false;
    if (!sharedWithConversationId && !importedOnly) {
      const stopped = await stopIdleWorkspaceRootSession({
        sdkSessionId: workerSessionId,
        worker: sessionWorkerRegistry?.getWorker?.(workerSessionId) || null,
        sessionWorkerSupervisor,
        sessionWorkerRegistry,
        sessionWorkerProcessInspector,
        stopOverrides: sessionWorkerStopOverrides,
      });
      if (!stopped.ok) {
        console.warn(`[delete] Not deleted ${id}: its worker did not stop (${stopped.error || 'unknown'}; remaining pids ${(stopped.remainingPids || []).join(',') || 'none'}).`);
        return {
          statusCode: 409,
          body: {
            ok: false,
            error: 'worker-stop-failed',
            message: "Couldn't stop this conversation's session, so nothing was deleted. Try again in a moment.",
            remainingPids: stopped.remainingPids || [],
          },
        };
      }
      workerStopped = (stopped.stoppedPids || []).length > 0;
      // Re-armed after the stop, which can outlast the kill block's grace
      // window: nothing may respawn a worker for the rows deleted below.
      sessionWorkerSupervisor?.markKilled?.(workerSessionId);
      try { sessionActivityTracker?.forget?.(id); } catch {}
      if (typeof backgroundTaskStore?.forget === 'function') backgroundTaskStore.forget(id, workerSessionId);
      else for (const key of new Set([id, workerSessionId])) backgroundTaskStore?.replace?.(key, []);
    }

    // A Claude Cloud conversation takes its cloud session along: archived
    // there, nothing destroyed. Started here, while the binding can still be
    // read, and not waited for: the delete never depends on Anthropic.
    if (!sharedWithConversationId) {
      claudeCloudSessionService?.archiveSessionInBackground?.({
        conversationId: id,
        runtimeSession: stmts.getRuntimeSessionByConversation?.get?.(id) || null,
      });
    }

    const deletedAt = new Date().toISOString();
    markConversationDeleted.run(deletedAt, id);
    // A deleted conversation takes its public preview links with it (archive
    // keeps them: an archived conversation can come back).
    try {
      closeConversationPreviews?.(id);
    } catch (error) {
      console.warn(`[preview] closing the previews of a deleted conversation failed: ${error?.message || error}`);
    }
    // Tombstones keep the SDK session importer from bringing it back.
    stmts.markDeletedSdkSession.run(sdkSessionId || id, deletedAt);
    if (sdkSessionId && sdkSessionId !== id) stmts.markDeletedSdkSession.run(id, deletedAt);

    const cliSession = sharedWithConversationId || importedOnly
      ? { deleted: null }
      : await deleteCliSession({
        conversation: existing,
        conversationId: id,
        sdkSessionId,
        runtimeSession: stmts.getRuntimeSessionByConversation?.get?.(id) || null,
      });

    cleanupGeneratedImagesForConversation({
      conversationId: id,
      sdkSessionId,
      messageRows: stmts.getMessages?.all?.(id) || [],
      parseAttachments,
      hydrateAttachment,
      resolveSessionStateRoot,
    });
    const orphanedUploads = collectOrphanedUploadsFromConversation(id);
    // Before the row goes: a head leaves its group with its title frozen as
    // the name, and a group left empty is removed.
    const leftGroupId = conversationGroups?.forgetConversation?.(id, deletedAt) || null;
    const wasShared = !!shares().findActiveShare(id);
    hardDeleteConversationRows(id);
    remoteRelayInbound?.repository?.forgetConversation?.(id);
    deleteOrphanedUploads(orphanedUploads);
    io.emit('conversation_deleted', { conversationId: id });
    if (wasShared) io.emit('share_revoked', { conversationId: id });
    if (leftGroupId) emitGroupChanged(leftGroupId, [id]);
    try { relayEventService?.noteConversationGone?.(id, { deleted: true }); } catch {}
    try { relayScheduleService?.noteConversationGone?.(id, { deleted: true }); } catch {}
    try { relayAskService?.noteConversationGone?.(id); } catch {}
    return { statusCode: 200, body: { ok: true, workerStopped, cliSessionDeleted: cliSession.deleted } };
  }

  // POST /api/conversation/:id/archive — archive conversation. The chat
  // leaves the sidebar's live list (it is kept, and comes back with
  // /unarchive); its idle worker is stopped like a deleted chat's; a Claude
  // Cloud chat's cloud session is archived with it. A chat that is working
  // is not archived: stop it first.
  app.post('/api/conversation/:id/archive', auth, async (req, res) => {
    if (!admitRemoteRelayRequest(req, res, remoteRelayInbound)) return;
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing conversation id' });
    try {
      const outcome = await archiveConversationNow(id);
      return res.status(outcome.statusCode).json(outcome.body);
    } catch (error) {
      console.warn(`[archive] Archive failed for ${id}: ${error?.message || error}`);
      return res.status(500).json({ error: 'Failed to archive conversation' });
    }
  });

  /** POST /api/conversation/:id/archive under its session's lock; see the route. */
  async function archiveConversationNow(id) {
      const existing = stmts.getConvAnyStatus.get(id);
      if (!existing || String(existing.status || '').trim() === 'deleted') {
        return { statusCode: 200, body: { ok: true, alreadyDeleted: true } };
      }
      if (Number(existing.archived || 0) === 1) return { statusCode: 200, body: { ok: true, alreadyArchived: true } };
      const sdkSessionId = String(existing.sdk_session_id || '').trim() || null;
      const workerSessionId = sdkSessionId || id;
      return sessionLaunchMutex.runExclusive(workerSessionId, async () => {
        const activity = describeConversationActivity(id, workerSessionId);
        if (activity.turnRunning) {
          return {
            statusCode: 409,
            body: {
              ok: false,
              error: 'conversation-active',
              reason: 'turn-running',
              message: 'This conversation is still working on a reply. Stop it, then archive it.',
            },
          };
        }
        if (activity.backgroundTaskCount > 0) {
          return {
            statusCode: 409,
            body: {
              ok: false,
              error: 'conversation-active',
              reason: 'background-tasks',
              message: activity.unstoppableTaskCount > 0
                ? 'Background tasks are still running in this conversation, and some have no Stop button. Use Kill session in its ︙ menu, then archive it.'
                : 'Background tasks are still running in this conversation. Stop them in the task panel, then archive it.',
            },
          };
        }
        // A worker another live conversation still uses stays.
        const sharedWithConversationId = sdkSessionId
          ? String(findOtherLiveConversationForSdkSession.get(sdkSessionId, id)?.id || '').trim() || null
          : null;
        const importedOnly = !!sdkSessionId && sdkSessionImportService?.isImportedOnly?.(sdkSessionId) === true;
        // The session the archive stops, if it stops one.
        const stoppedSessionId = !sharedWithConversationId && !importedOnly ? workerSessionId : null;
        let workerStopped = false;
        if (stoppedSessionId) {
          const stopped = await stopIdleWorkspaceRootSession({
            sdkSessionId: workerSessionId,
            worker: sessionWorkerRegistry?.getWorker?.(workerSessionId) || null,
            sessionWorkerSupervisor,
            sessionWorkerRegistry,
            sessionWorkerProcessInspector,
            stopOverrides: sessionWorkerStopOverrides,
          });
          if (!stopped.ok) {
            console.warn(`[archive] Not archived ${id}: its worker did not stop (${stopped.error || 'unknown'}; remaining pids ${(stopped.remainingPids || []).join(',') || 'none'}).`);
            return {
              statusCode: 409,
              body: {
                ok: false,
                error: 'worker-stop-failed',
                message: "Couldn't stop this conversation's session, so it was not archived. Try again in a moment.",
                remainingPids: stopped.remainingPids || [],
              },
            };
          }
          workerStopped = (stopped.stoppedPids || []).length > 0;
          // Nothing may respawn a worker for an archived chat.
          sessionWorkerSupervisor?.markKilled?.(workerSessionId);
        }
        // The turns of sessions the archive did not stop: the process probe
        // says which have no worker. It awaits, so it runs before the window
        // below, which checks each turn is still on the attempt it probed.
        const probedRows = listProcessingConversationRows.all(id)
          .filter((row) => sessionOfRow(row, workerSessionId) !== stoppedSessionId);
        const deadSessionIds = await probeDeadSessions([...new Set(probedRows.map((row) => sessionOfRow(row, workerSessionId)))]);
        const deadAttempts = new Map(probedRows
          .filter((row) => deadSessionIds.has(sessionOfRow(row, workerSessionId)))
          .map((row) => [String(row.id), String(row.attempt_id || '')]));
        // From here to the last failed turn nothing awaits: the queue cannot
        // hand a queued message to a worker between the archive and its
        // cancel, nor the dead-worker sweep requeue a turn failed below.
        const orphanedRows = listOrphanedTurnRows(id, workerSessionId, stoppedSessionId, deadAttempts);
        const archivedAt = new Date().toISOString();
        const cancelled = db.transaction(() => {
          db.prepare(`UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ?`).run(archivedAt, id);
          return cancelQueuedRowsOnArchive(id, archivedAt);
        })();
        io.emit('conversation_archived', { conversationId: id, archived: true });
        announceArchiveCancel(id, cancelled);
        const failedMessageIds = failOrphanedTurnsOnArchive(id, orphanedRows, workerSessionId);
        // The archive stands: a note that cannot be written ends nothing below.
        try {
          noteArchiveOutcome(id, { ...cancelled, failedCount: failedMessageIds.length });
        } catch (error) {
          console.warn(`[archive] The archive note of ${shortId(id)} was not written: ${error?.message || error}`);
        }
        // Its subscriptions end, and so does its place in others'.
        try { relayEventService?.noteConversationGone?.(id); } catch {}
        // So do its schedules.
        try { relayScheduleService?.noteConversationGone?.(id); } catch {}
        try { relayAskService?.noteConversationGone?.(id); } catch {}
        // The cloud session of a Claude Cloud conversation is archived with it;
        // best effort and not waited for.
        if (!sharedWithConversationId) {
          try {
            claudeCloudSessionService?.archiveSessionInBackground?.({
              conversationId: id,
              runtimeSession: stmts.getRuntimeSessionByConversation?.get?.(id) || null,
            });
          } catch (error) {
            console.warn(`[archive] Cloud session archive not started for ${id}: ${error?.message || error}`);
          }
        }
        return { statusCode: 200, body: { ok: true, workerStopped, cancelledMessageIds: cancelled.messageIds, failedMessageIds } };
      });
  }

  /**
   * Inside an archive's transaction: cancels the conversation's queued
   * messages, so no worker starts for them in the archived chat. A pending or
   * parked row goes as POST /api/conversation/:id/cancel-queued-turn cancels
   * it: the pending questions of its earlier attempts are cancelled and the
   * row is deleted. A follow-up held at the usage limit goes last, as the
   * pause banner's Cancel drops it (its follow-up message, the relay's own
   * text, goes with it). Returns what announceArchiveCancel tells the
   * clients and what noteArchiveOutcome counts.
   */
  function cancelQueuedRowsOnArchive(conversationId, at) {
    const queuedMessageIds = [];
    const questions = [];
    const cancelRows = (skip) => {
      for (const row of listQueuedConversationRows.all(conversationId)) {
        if (skip(row)) continue;
        const messageId = String(row.id);
        // Read while they can be: the row's delete takes its questions along
        // (relay_questions.queue_id cascades). Every card of the row goes,
        // those with no attempt too.
        for (const question of stmts.cancelPendingQuestionsForRow?.all?.(at, messageId) || []) {
          const updated = stmts.getQuestion?.get?.(question.id) || null;
          if (updated && typeof formatQuestionRow === 'function') questions.push(formatQuestionRow(updated));
        }
        stmts.deleteQueueById.run(messageId);
        queuedMessageIds.push(messageId);
      }
    };
    // The follow-up held at the usage limit is the pause service's to drop.
    cancelRows((row) => !!usageLimitPauseService && row.usage_limit_pause != null);
    const pause = usageLimitPauseService?.cancel?.({ conversationId }) || null;
    const pausedMessageId = pause?.cancelled ? String(pause.messageId || '').trim() : '';
    // Anything the pause service left (none but its one follow-up is held).
    if (usageLimitPauseService) cancelRows(() => false);
    const messageIds = pausedMessageId ? [...queuedMessageIds, pausedMessageId] : queuedMessageIds;
    return { messageIds, queuedMessageIds, pausedMessageId, questions };
  }

  /** After the archive committed: each cancelled row and its questions. */
  function announceArchiveCancel(conversationId, { queuedMessageIds, questions }) {
    // The usage-limit pause's cancel announced its row itself.
    for (const messageId of queuedMessageIds) {
      io.emit('message_status', { messageId, conversationId, status: 'cancelled' });
    }
    for (const question of questions) io.emit('relay_question_updated', { question });
  }

  /** The session that runs a queue row: its owner, else the conversation's. */
  function sessionOfRow(row, workerSessionId) {
    return String(row.owner_sdk_session_id || '').trim() || workerSessionId;
  }

  // The runtime's own probe (services/worker-session-liveness.mjs), with this
  // relay's worker sockets when the runtime hands them over.
  const workerSessionLiveness = createWorkerSessionLiveness({
    hasLiveWorkerSocket: (sessionId) => deps.hasLiveWorkerSocket?.(sessionId) === true,
    getWorkerPid: (sessionId) => sessionWorkerRegistry?.getWorker?.(sessionId)?.pid,
    isPidAlive: (pid) => isPidAlive(pid),
    findProcessForSession: typeof sessionWorkerProcessInspector?.findProcessForSessionAsync === 'function'
      ? (sessionId) => sessionWorkerProcessInspector.findProcessForSessionAsync(sessionId)
      : null,
  });

  /**
   * Which of these sessions have no worker left: the turns of sessions the
   * archive did not stop. A live worker socket, the registry's pid, then the
   * process list, whose lookups share one read (the inspector shares a
   * running read), bounded together. A session whose lookup fails or runs
   * out of time, or with no process list at all, is not shown dead: its turn
   * is left to the dead-worker sweep, and so are all of them when any lookup
   * runs out of time.
   */
  async function probeDeadSessions(sessionIds) {
    const dead = new Set();
    const { states, unanswered } = await workerSessionLiveness.probeAll(sessionIds, {
      timeoutMs: processProbeTimeoutMs,
      onLookupError: (sessionId, error) => {
        console.warn(`[archive] The process list could not be read for ${shortId(sessionId)}: ${error?.message || error}`);
      },
    });
    if (unanswered) {
      console.warn(`[archive] The process list did not answer within ${processProbeTimeoutMs} ms: the turns of ${unanswered} session${unanswered === 1 ? '' : 's'} are left to the sweep.`);
      return dead;
    }
    for (const [sessionId, state] of states) if (state === 'dead') dead.add(sessionId);
    return dead;
  }

  /**
   * The conversation's processing rows that no worker will end. The session
   * the archive stopped passed the activity check, so no registry entry for
   * it means no worker (the stop removes it; a turn an idle worker claimed
   * meanwhile is its last). Any other session's turn, another owner's or a
   * shared or imported session's, is one the probe showed dead and that is
   * still on the attempt it probed.
   */
  function listOrphanedTurnRows(conversationId, workerSessionId, stoppedSessionId, deadAttempts) {
    return listProcessingConversationRows.all(conversationId).filter((row) => {
      const sessionId = sessionOfRow(row, workerSessionId);
      if (sessionId !== stoppedSessionId) return deadAttempts.get(String(row.id)) === String(row.attempt_id || '');
      const worker = sessionWorkerRegistry?.getWorker?.(sessionId) || null;
      return !worker || !isWorkerAlive(worker);
    });
  }

  /**
   * After the archive committed, in the same tick: each turn no worker will
   * end fails as a dead turn does (failure reply, partial output linked,
   * sub-agent runs and question cards ended, relay events), with no push and
   * with the stopped worker left alone. A row whose failure throws is still
   * marked failed, so nothing requeues it, and said so to the clients. The
   * background sub-agent runs of each dead session close as the dead-worker
   * sweep closes them, which no longer visits the session. Returns the
   * failed rows' ids.
   */
  function failOrphanedTurnsOnArchive(conversationId, rows, workerSessionId) {
    const failedMessageIds = [];
    for (const row of rows) {
      const messageId = String(row.id);
      const failure = {
        kind: 'terminal',
        error: 'conversation-archived',
        code: 'conversation-archived',
        stableCode: 'relay.conversation-archived',
        message: 'This chat was archived while this reply was not finished.',
        guidance: 'Unarchive the chat and send the message again to continue.',
        failedAt: new Date().toISOString(),
      };
      let failed = false;
      try {
        failed = !!failQueueMessage({
          queueRow: row,
          messageId,
          conversationId,
          relayMode: String(row.relay_mode || '').trim() || DEFAULT_RELAY_MODE || 'agent',
          model: null,
          responseText: buildTerminalFailureTextForChat(failure),
          failureRecord: failure,
          settleWorker: false,
        });
      } catch (error) {
        console.warn(`[archive] Failing the turn ${shortId(messageId)} of ${shortId(conversationId)} threw: ${error?.message || error}`);
        failed = markOrphanedTurnFailed(conversationId, messageId, failure);
      }
      if (!failed) continue;
      failedMessageIds.push(messageId);
      // failQueueMessage closes the cards of earlier attempts; no worker is
      // left to take an answer for the last one, or for one with no attempt.
      try {
        for (const question of stmts.cancelPendingQuestionsForRow?.all?.(new Date().toISOString(), messageId) || []) {
          const updated = stmts.getQuestion?.get?.(question.id) || null;
          if (updated && typeof formatQuestionRow === 'function') io.emit('relay_question_updated', { question: formatQuestionRow(updated) });
        }
      } catch (error) {
        console.warn(`[archive] The question cards of the turn ${shortId(messageId)} of ${shortId(conversationId)} were not cancelled: ${error?.message || error}`);
      }
    }
    const deadSessionIds = new Set(rows.map((row) => String(row.owner_sdk_session_id || '').trim() || workerSessionId));
    for (const sessionId of deadSessionIds) {
      try {
        closeStrandedBackgroundRuns(stmts.listRunningBackgroundSubagentRunsForSession?.all?.(sessionId, sessionId) || []);
      } catch (error) {
        console.warn(`[archive] The background sub-agent runs of ${shortId(sessionId)} were not closed: ${error?.message || error}`);
      }
    }
    return failedMessageIds;
  }

  /**
   * The fallback for a turn whose failQueueMessage threw: the row is marked
   * failed with the archive's record, unless the throw came after its own
   * commit. Either way a failed row is announced once, so an open page does
   * not keep showing it running. Returns whether the row is failed.
   */
  function markOrphanedTurnFailed(conversationId, messageId, failure) {
    try {
      stmts.setFailed.run(JSON.stringify(failure), messageId);
      if (String(stmts.findQById?.get?.(messageId)?.status || '') !== 'failed') return false;
      io.emit('message_status', { messageId, conversationId, status: 'failed' });
      return true;
    } catch (error) {
      console.warn(`[archive] The turn ${shortId(messageId)} of ${shortId(conversationId)} was not marked failed: ${error?.message || error}`);
      return false;
    }
  }

  /**
   * Background sub-agent runs a dead worker can no longer end: marked failed,
   * each announced with its full header and its own turn, as the dead-worker
   * sweep does.
   */
  function closeStrandedBackgroundRuns(runs) {
    if (!runs.length) return;
    const at = new Date().toISOString();
    for (const run of runs) {
      stmts.updateSubagentRunStatus?.run?.('failed', at, at, run.id);
      const closed = stmts.getSubagentRun?.get?.(run.id) || { ...run, status: 'failed', completed_at: at };
      const header = mapSubagentRunHeader(closed, { stoppable: false });
      if (header) {
        io.emit('subagent_status', { ...header, timestamp: at, queueMessageId: header.messageId, reconciled: true });
      }
    }
  }

  /**
   * One note in the transcript, after the failure replies, says what the
   * archive ended and cancelled; it is no queue row. None when it did
   * neither.
   */
  function noteArchiveOutcome(conversationId, { queuedMessageIds, pausedMessageId, failedCount }) {
    const count = queuedMessageIds.length;
    const cancelledWhat = [
      count ? `${count} queued message${count === 1 ? '' : 's'}` : '',
      pausedMessageId ? 'the usage-limit follow-up' : '',
    ].filter(Boolean).join(' and ');
    const parts = [
      failedCount ? `ended ${failedCount} unfinished repl${failedCount === 1 ? 'y' : 'ies'}` : '',
      cancelledWhat ? `cancelled ${cancelledWhat}` : '',
    ].filter(Boolean);
    if (!parts.length) return;
    const at = new Date().toISOString();
    const note = { id: randomUUID(), text: `[System Message] Archived: ${parts.join('; ')}.`, timestamp: at };
    stmts.insertMsg.run(note.id, conversationId, 'assistant', note.text, null, null, null, at, null, null, null);
    io.emit('assistant_message', {
      conversationId,
      sourceMessageId: null,
      messageId: note.id,
      message: { role: 'assistant', text: note.text, model: null, mode: null, timestamp: note.timestamp },
    });
  }

  // POST /api/conversation-groups/:id/archive — archive every live member of
  // a session group that can be archived now. A member with a running turn
  // or background work is skipped and named in the answer, so the owner can
  // stop it ("Stop all running") and archive again.
  app.post('/api/conversation-groups/:id/archive', auth, async (req, res) => {
    if (notPerson(req, readRemoteRelayRequest(req, remoteRelayInbound))) {
      return res.status(403).json({ error: 'Session groups are managed by this relay\'s owner only.' });
    }
    const groupId = String(req.params.id || '').trim();
    const group = groupId ? conversationGroups?.getGroup?.(groupId) : null;
    if (!group) return res.status(404).json({ ok: false, error: 'Group not found' });
    const archived = [];
    const skipped = [];
    // Each archived member's ended turns, as its single archive answers them.
    const failedMessageIds = {};
    try {
      for (const member of conversationGroups.membersOf(groupId)) {
        if (member.archived) continue;
        const outcome = await archiveConversationNow(member.id);
        if (outcome.statusCode === 200) {
          archived.push(member.id);
          failedMessageIds[member.id] = outcome.body?.failedMessageIds || [];
        } else {
          skipped.push({
            id: member.id,
            title: resolveConversationTitle({ title: member.title, titleSource: 'auto' }),
            reason: String(outcome.body?.reason || outcome.body?.error || 'refused'),
          });
        }
      }
    } catch (error) {
      console.warn(`[archive] Group archive failed for ${groupId}: ${error?.message || error}`);
      return res.status(500).json({ ok: false, error: 'Failed to archive the group', archived, skipped, failedMessageIds });
    }
    if (archived.length) emitGroupChanged(groupId, archived);
    return res.json({ ok: true, archived, skipped, failedMessageIds });
  });

  // POST /api/conversation/:id/unarchive — back to the live list. A Claude
  // Cloud chat's cloud session is brought back too, so the next message
  // reaches it. A row left pending in the chat goes at once: the route
  // launches its session's worker and wakes the queue
  // (wakeQueueAfterUnarchive); with nothing queued, the next delivery
  // launches a stopped worker.
  app.post('/api/conversation/:id/unarchive', auth, (req, res) => {
    if (!admitRemoteRelayRequest(req, res, remoteRelayInbound)) return;
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing conversation id' });
    try {
      const existing = stmts.getConvAnyStatus.get(id);
      if (!existing || String(existing.status || '').trim() === 'deleted') {
        return res.status(404).json({ ok: false, error: 'Conversation not found' });
      }
      if (Number(existing.archived || 0) !== 1) return res.json({ ok: true, alreadyLive: true });
      db.prepare(`UPDATE conversations SET archived = 0, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
      io.emit('conversation_archived', { conversationId: id, archived: false });
      wakeQueueAfterUnarchive(id);
      try {
        claudeCloudSessionService?.unarchiveSessionInBackground?.({
          conversationId: id,
          runtimeSession: stmts.getRuntimeSessionByConversation?.get?.(id) || null,
        });
      } catch (error) {
        console.warn(`[archive] Cloud session unarchive not started for ${id}: ${error?.message || error}`);
      }
      return res.json({ ok: true });
    } catch (error) {
      console.warn(`[archive] Unarchive failed for ${id}: ${error?.message || error}`);
      return res.status(500).json({ error: 'Failed to unarchive conversation' });
    }
  });

  /**
   * A row left pending in the archived chat may go now, but the unarchive
   * writes no queue row, so the queue's own triggers do not fire and the row
   * would wait for the backstop poll. The sessions that own such rows get
   * their worker as a send's does (the archive's kill marker cleared), and the
   * queue wakes through the triggers' own function, so a worker that is
   * already connected is handed the row at once.
   */
  function wakeQueueAfterUnarchive(conversationId) {
    let sessionIds = [];
    try {
      if (!listPendingConversationSessionIds) listPendingConversationSessionIds = db.prepare(LIST_PENDING_CONVERSATION_SESSION_IDS_SQL);
      sessionIds = listPendingConversationSessionIds.all(conversationId)
        .map((row) => String(row.sdk_session_id || '').trim())
        .filter(Boolean);
    } catch (error) {
      console.warn(`[archive] The queued rows of ${shortId(conversationId)} were not read after the unarchive: ${error?.message || error}`);
      return;
    }
    if (!sessionIds.length) return;
    for (const sessionId of sessionIds) {
      if (typeof sessionWorkerSupervisor?.ensureWorker !== 'function') break;
      // As the primer does: a Claude API chat whose key, switch or cap went
      // bad while it was archived gets its rows failed with the usual note
      // instead of a worker (server-runtime.mjs, failClaudeApiRowsWithoutLaunch).
      // A check that throws costs this session its launch only.
      try {
        if (deps.failClaudeApiRowsWithoutLaunch?.(sessionId)) continue;
      } catch (error) {
        console.warn(`[archive] No worker for ${shortId(sessionId)} after the unarchive: the Claude API check failed: ${error?.message || error}`);
        continue;
      }
      // The same for a Copilot chat while Copilot is switched off: its rows
      // fail with the switch's note, and no Copilot worker starts
      // (server-runtime.mjs, failCopilotRowsWithoutLaunch).
      try {
        if (deps.failCopilotRowsWithoutLaunch?.(sessionId)) continue;
      } catch (error) {
        console.warn(`[archive] No worker for ${shortId(sessionId)} after the unarchive: the Copilot check failed: ${error?.message || error}`);
        continue;
      }
      try {
        sessionWorkerSupervisor.clearRestartSchedule?.(sessionId, { resetKilledMarker: true });
        void Promise.resolve(sessionWorkerSupervisor.ensureWorker(sessionId)).then((result) => {
          if (!result?.ok) console.warn(`[archive] No worker for ${shortId(sessionId)} after the unarchive: ${result?.error || 'refused'}`);
        }).catch((error) => {
          console.warn(`[archive] No worker for ${shortId(sessionId)} after the unarchive: ${error?.message || error}`);
        });
      } catch (error) {
        console.warn(`[archive] No worker for ${shortId(sessionId)} after the unarchive: ${error?.message || error}`);
      }
    }
    // The function is registered before the triggers, and a trigger that fails
    // to install takes only the triggers down (queue-wake-hook.mjs): the call
    // then still wakes the queue, beside the 500 ms poll that replaces the
    // triggers. Where the hook never registered it, the call fails and the
    // poll alone hands the row out.
    try {
      if (!wakeQueueStatement) wakeQueueStatement = db.prepare(`SELECT ${QUEUE_WAKE_FUNCTION}(?)`);
      wakeQueueStatement.get('unarchive');
    } catch {}
  }

  return { archiveConversationNow };
}
