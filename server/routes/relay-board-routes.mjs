'use strict';

import { persistConversationPreferences, readPlanOnly } from '../services/conversation-preferences-service.mjs';
import { fallbackReasoningEffort } from '../services/conversation-model-fallback.mjs';
import {
  PLAN_BOARD_APPROVE_ONLY,
  isPendingPlanBoard,
  planBoardActionLabel,
  planBoardFollowupMode,
  planBoardFollowupText,
} from '../../shared/plan-board-actions.mjs';

function normalizeId(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeBoardText(value, fallback = '') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.slice(0, 12_000);
}

function normalizeBoardType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'generic';
  return text.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'generic';
}


function normalizeBoardActions(rawActions) {
  const input = Array.isArray(rawActions) ? rawActions : [];
  const normalized = [];
  const seen = new Set();
  for (const entry of input) {
    const item = (typeof entry === 'string')
      ? { id: entry }
      : (entry && typeof entry === 'object' ? entry : null);
    if (!item) continue;
    const id = String(item.id || item.actionId || item.value || '').trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = String(item.label || item.title || planBoardActionLabel(id)).trim().slice(0, 120) || planBoardActionLabel(id);
    const mode = normalizeId(item.mode);
    const prompt = normalizeBoardText(item.prompt || '', '');
    normalized.push({
      id,
      label,
      mode: mode || null,
      prompt: prompt || null,
    });
  }
  return normalized.slice(0, 8);
}

function parseContext(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function registerRelayBoardRoutes(app, deps) {
  const {
    auth,
    io,
    db,
    stmts,
    uuidv4,
    normalizeRelayMode,
    resolveRequestedModel,
    resolveRequestedReasoningEffort,
    DEFAULT_RELAY_MODE,
    DEFAULT_MODEL,
    formatRelayBoardRow,
    pushDispatchService,
    relayEventService,
  } = deps;

  /**
   * The effort the follow-up runs with when the model id carries none: the
   * conversation's own, clamped to the levels the model has. A model the
   * catalog cannot check (another provider's) takes it as it is.
   */
  function conversationEffortFor(conversationId, model) {
    const preferred = String(stmts.getConvAnyStatus?.get?.(conversationId)?.preferred_reasoning_effort || '').trim().toLowerCase();
    if (!preferred) return null;
    if (typeof resolveRequestedReasoningEffort !== 'function') return preferred;
    const check = resolveRequestedReasoningEffort(model, preferred);
    if (check?.ok) return String(check.effort || '').trim() || null;
    const supported = Array.isArray(check?.supported) ? check.supported : [];
    return supported.length ? (fallbackReasoningEffort([preferred], supported) || null) : preferred;
  }

  /**
   * The session goes on in the mode that was chosen on the board: after
   * "Implement in autopilot" the composer says Autopilot, and the next message
   * carries the work on instead of planning again. The model and the effort
   * stay as they are. Advisory: the follow-up is queued whatever happens here.
   */
  function followChosenMode(conversationId, relayMode, updatedAt) {
    try {
      const existing = stmts.getConvAnyStatus?.get?.(conversationId) || null;
      if (!existing || String(existing.status || '').trim() === 'deleted') return;
      if ((normalizeRelayMode(existing.preferred_relay_mode) || '') === relayMode) return;
      const persisted = persistConversationPreferences({
        db,
        stmts,
        conversationId,
        preferredRelayMode: relayMode,
        preferredModel: existing.preferred_model,
        preferredReasoningEffort: existing.preferred_reasoning_effort,
        updatedAt,
      });
      if (!persisted.ok) return;
      // No sender: the page that pressed the button has to follow as well.
      io.emit('conversation_preferences_updated', {
        conversationId,
        preferredRelayMode: persisted.preferredRelayMode,
        preferredModel: persisted.preferredModel,
        preferredReasoningEffort: persisted.preferredReasoningEffort,
        autoCompactWindow: persisted.autoCompactWindow ?? null,
        thinkingEnabled: persisted.thinkingEnabled ?? null,
        thinkingDisplay: persisted.thinkingDisplay ?? null,
        updatedAt: persisted.updatedAt,
        senderClientId: null,
      });
    } catch {}
  }

  app.get('/api/relay-boards', auth, (req, res) => {
    const conversationId = req.query.conversationId ? String(req.query.conversationId) : null;
    const status = String(req.query.status || 'pending').trim() || 'pending';
    // Every board of one conversation, settled ones included: a reply goes on
    // showing the plan it offered and what was chosen. Per conversation only.
    if (status === 'all') {
      if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
      const all = stmts.listBoardsForConversation.all(conversationId);
      return res.json({ boards: all.map(formatRelayBoardRow).filter(Boolean) });
    }
    const rows = stmts.listBoards.all(status, conversationId, conversationId);
    res.json({ boards: rows.map(formatRelayBoardRow).filter(Boolean) });
  });

  app.get('/api/relay-board/:id', auth, (req, res) => {
    const row = stmts.getBoard.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ board: formatRelayBoardRow(row) });
  });

  app.post('/api/relay-board', auth, (req, res) => {
    const {
      queueId,
      messageId,
      conversationId,
      mode,
      boardType,
      title,
      body,
      actions,
      recommendedAction,
      context,
    } = req.body || {};
    const q = stmts.findQById.get(queueId || messageId);
    if (!q || q.status !== 'processing') {
      return res.status(409).json({ error: 'No active relay turn' });
    }

    const effectiveMessageId = normalizeId(messageId) || q.id;
    const normalizedBoardType = normalizeBoardType(boardType || 'generic');
    const existing = stmts.findBoardByMessageType.get(effectiveMessageId, normalizedBoardType);
    if (existing) {
      return res.json({ board: formatRelayBoardRow(existing), reused: true });
    }

    const now = new Date().toISOString();
    const boardId = uuidv4();
    const relayMode = normalizeRelayMode(mode || q.relay_mode) || DEFAULT_RELAY_MODE;
    const normalizedActions = normalizeBoardActions(actions);
    // A plan-only session's plan card recommends "Approve plan", whatever the
    // worker or the Copilot CLI recommended.
    const boardConversationId = normalizeId(conversationId) || q.conversation_id;
    const planOnly = normalizedBoardType === 'plan_ready'
      && readPlanOnly(stmts.getConvAnyStatus?.get?.(boardConversationId));
    const normalizedRecommended = planOnly ? PLAN_BOARD_APPROVE_ONLY : normalizeId(recommendedAction);
    const boardContext = parseContext(context);

    stmts.insertBoard.run(
      boardId,
      q.id,
      normalizeId(conversationId) || q.conversation_id,
      effectiveMessageId,
      normalizedBoardType,
      relayMode,
      normalizeBoardText(title, 'Plan ready for review'),
      normalizeBoardText(body, ''),
      normalizedActions.length ? JSON.stringify(normalizedActions) : null,
      normalizedRecommended,
      boardContext ? JSON.stringify(boardContext) : null,
      now,
      now,
    );

    const board = formatRelayBoardRow(stmts.getBoard.get(boardId));
    io.emit('relay_board', { board });
    void pushDispatchService?.notifyBoard?.(board);
    io.emit('relay_board_changed', { conversationId: board?.conversationId || null, boardId });
    return res.json({ board });
  });

  app.post('/api/relay-board/:id/action', auth, (req, res) => {
    const boardId = normalizeId(req.params.id);
    const actionId = normalizeId(req.body?.actionId || req.body?.action_id);
    const clientId = normalizeId(req.body?.clientId || req.body?.client_id);
    if (!boardId || !actionId) return res.status(400).json({ error: 'Missing board/action id' });

    const row = stmts.getBoard.get(boardId);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (String(row.status || '').trim().toLowerCase() !== 'pending') {
      return res.status(409).json({ error: `Board already ${row.status}` });
    }

    const board = formatRelayBoardRow(row);
    const conversationRow = stmts.getConvAnyStatus?.get?.(String(board?.conversationId || '').trim()) || null;
    if (conversationRow && String(conversationRow.status || '').trim() === 'deleted') {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const actions = Array.isArray(board?.actions) ? board.actions : [];
    const chosen = actionId.toLowerCase();
    // "Approve plan" is taken on any pending plan card, also one stored
    // before the button existed.
    const selected = actions.find((item) => String(item?.id || '').trim().toLowerCase() === chosen)
      || (chosen === PLAN_BOARD_APPROVE_ONLY && isPendingPlanBoard(board)
        ? { id: PLAN_BOARD_APPROVE_ONLY, label: planBoardActionLabel(PLAN_BOARD_APPROVE_ONLY), mode: planBoardFollowupMode(PLAN_BOARD_APPROVE_ONLY) }
        : null);
    if (!selected) return res.status(400).json({ error: 'Unknown board action' });

    const now = new Date().toISOString();
    const shouldDismiss = chosen === 'exit_only';
    const approveOnly = chosen === PLAN_BOARD_APPROVE_ONLY;
    // Only a pending card is settled: a second press (here or in the Inbox)
    // finds it settled already and queues nothing.
    const settledRow = shouldDismiss
      ? stmts.dismissBoard.run(chosen, now, now, boardId)
      : stmts.markBoardAction.run(chosen, now, now, boardId);
    if (Number(settledRow?.changes) !== 1) {
      const current = stmts.getBoard.get(boardId);
      return res.status(409).json({ error: `Board already ${current?.status || 'settled'}`, board: formatRelayBoardRow(current) });
    }

    let queuedMessageId = null;
    if (!shouldDismiss) {
      // approve_only says exactly its line; the others may carry their own.
      const followupPrompt = normalizeBoardText(approveOnly ? planBoardFollowupText(chosen) : (selected.prompt || planBoardFollowupText(chosen)), '');
      if (followupPrompt) {
        // approve_only runs this one turn in agent mode (plan mode blocks
        // the writes its plan-only steps need); the session stays in plan.
        const relayMode = normalizeRelayMode(approveOnly
          ? planBoardFollowupMode(chosen)
          : (selected.mode || planBoardFollowupMode(chosen) || board.mode)) || DEFAULT_RELAY_MODE;
        const convId = String(board?.conversationId || '').trim();
        const runtimeSession = stmts.getRuntimeSessionByConversation?.get?.(convId) || null;
        const latestModel = stmts.getLatestConversationModel?.get?.(convId)?.model || null;
        const modelResolution = typeof resolveRequestedModel === 'function'
          ? resolveRequestedModel(latestModel || DEFAULT_MODEL)
          : { ok: true, model: latestModel || DEFAULT_MODEL, modelVariantId: latestModel || DEFAULT_MODEL, reasoningEffort: null };
        const resolvedBaseModel = modelResolution?.ok ? String(modelResolution.model || '').trim() : (latestModel || DEFAULT_MODEL);
        const resolvedVariantModel = modelResolution?.ok
          ? String(modelResolution.modelVariantId || latestModel || resolvedBaseModel).trim()
          : String(latestModel || resolvedBaseModel).trim();
        const resolvedReasoningEffort = (modelResolution?.ok
          ? String(modelResolution.reasoningEffort || '').trim() || null
          : null) || conversationEffortFor(convId, resolvedBaseModel);
        queuedMessageId = uuidv4();
        stmts.insertMsg.run(
          queuedMessageId,
          convId,
          'user',
          followupPrompt,
          resolvedVariantModel,
          relayMode,
          null,
          now,
          resolvedVariantModel || null,
          null,
          String(resolvedVariantModel || '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual',
        );
        stmts.updateConvTime.run(now, convId);
        // One value per placeholder of the queue insert: the context tier
        // (none: the follow-up runs on the conversation's own) and, where the
        // queue has the column, the image operation. Two short, the insert
        // threw and the action answered 500 with the board already marked.
        const queueArgs = [
          queuedMessageId,
          convId,
          runtimeSession?.id || null,
          0,
          resolvedBaseModel,
          resolvedVariantModel,
          resolvedReasoningEffort,
          null,
          relayMode,
          followupPrompt,
          null,
          now,
          null,
          null,
          null,
          null,
        ];
        if (stmts.queueHasImageOperationId) queueArgs.push(null);
        stmts.insertQ.run(...queueArgs);
        io.emit('user_message', {
          conversationId: convId,
          messageId: queuedMessageId,
          senderClientId: clientId || null,
          message: {
            role: 'user',
            text: followupPrompt,
            model: resolvedVariantModel,
            modelOrigin: String(resolvedVariantModel || '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual',
            mode: relayMode,
            attachments: [],
            timestamp: now,
          },
        });
        if (!approveOnly) followChosenMode(convId, relayMode, now);
      }
    }

    const updated = formatRelayBoardRow(stmts.getBoard.get(boardId));
    try {
      relayEventService?.noteBoardSettled?.(String(updated?.conversationId || board?.conversationId || ''), {
        boardId,
        boardType: updated?.boardType || board?.boardType || null,
        action: chosen,
        actionLabel: String(selected.label || '').trim() || planBoardActionLabel(chosen),
        title: updated?.title || board?.title || '',
        queuedMessageId,
      });
    } catch {}
    io.emit('relay_board_updated', { board: updated });
    io.emit('relay_board_changed', { conversationId: updated?.conversationId || null, boardId });
    return res.json({
      ok: true,
      board: updated,
      queuedMessageId,
    });
  });
}
