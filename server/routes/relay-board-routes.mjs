'use strict';

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

function labelForAction(actionId) {
  const id = String(actionId || '').trim().toLowerCase();
  if (id === 'autopilot') return 'Implement in autopilot';
  if (id === 'autopilot_fleet') return 'Implement with autopilot fleet';
  if (id === 'interactive') return 'Stop here and prompt myself';
  if (id === 'exit_only') return 'Stop here';
  return id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()) || 'Select';
}

function defaultPromptForAction(actionId, board = null) {
  const summary = String(board?.body || '').trim();
  if (actionId === 'autopilot') {
    return `Please implement the approved plan now.\n\nPlan summary:\n${summary}`;
  }
  if (actionId === 'autopilot_fleet') {
    return `Please implement the approved plan using autopilot_fleet where useful.\n\nPlan summary:\n${summary}`;
  }
  if (actionId === 'interactive') {
    return `I approved the plan. Let's proceed interactively with implementation.\n\nPlan summary:\n${summary}`;
  }
  return '';
}

function modeForAction(actionId, fallbackMode) {
  if (actionId === 'autopilot' || actionId === 'autopilot_fleet') return 'autopilot';
  if (actionId === 'interactive') return 'agent';
  return fallbackMode;
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
    const label = String(item.label || item.title || labelForAction(id)).trim().slice(0, 120) || labelForAction(id);
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
    stmts,
    uuidv4,
    normalizeRelayMode,
    resolveRequestedModel,
    DEFAULT_RELAY_MODE,
    DEFAULT_MODEL,
    formatRelayBoardRow,
    pushDispatchService,
  } = deps;

  app.get('/api/relay-boards', auth, (req, res) => {
    const conversationId = req.query.conversationId ? String(req.query.conversationId) : null;
    const status = String(req.query.status || 'pending').trim() || 'pending';
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
    const normalizedRecommended = normalizeId(recommendedAction);
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
    const actions = Array.isArray(board?.actions) ? board.actions : [];
    const selected = actions.find((item) => String(item?.id || '').trim().toLowerCase() === actionId.toLowerCase());
    if (!selected) return res.status(400).json({ error: 'Unknown board action' });

    const now = new Date().toISOString();
    const shouldDismiss = actionId.toLowerCase() === 'exit_only';
    if (shouldDismiss) {
      stmts.dismissBoard.run(actionId, now, now, boardId);
    } else {
      stmts.markBoardAction.run(actionId, now, now, boardId);
    }

    let queuedMessageId = null;
    if (!shouldDismiss) {
      const followupPrompt = normalizeBoardText(selected.prompt || defaultPromptForAction(actionId.toLowerCase(), board), '');
      if (followupPrompt) {
        const relayMode = normalizeRelayMode(selected.mode || modeForAction(actionId.toLowerCase(), board.mode)) || DEFAULT_RELAY_MODE;
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
        const resolvedReasoningEffort = modelResolution?.ok
          ? String(modelResolution.reasoningEffort || '').trim() || null
          : null;
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
        stmts.insertQ.run(
          queuedMessageId,
          convId,
          runtimeSession?.id || null,
          0,
          resolvedBaseModel,
          resolvedVariantModel,
          resolvedReasoningEffort,
          relayMode,
          followupPrompt,
          null,
          now,
          null,
          null,
          null,
          null,
        );
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
      }
    }

    const updated = formatRelayBoardRow(stmts.getBoard.get(boardId));
    io.emit('relay_board_updated', { board: updated });
    io.emit('relay_board_changed', { conversationId: updated?.conversationId || null, boardId });
    return res.json({
      ok: true,
      board: updated,
      queuedMessageId,
    });
  });
}
