import { extractToolName, toolArgsSnapshot, parseMaybeJson } from "./tool-activity.mjs";

function extractAgentIdFromRequest(request) {
  const agentId = request?.agentId || request?.data?.agentId || null;
  return agentId ? String(agentId).trim() : null;
}

function extractToolCallId(request) {
  const candidates = [
    request?.toolCallId,
    request?.id,
    request?.toolCall?.id,
    request?.toolCall?.toolCallId,
  ];
  for (const value of candidates) {
    const id = String(value || "").trim();
    if (id) return id;
  }
  return null;
}

function isSubagentSpawnTool(request) {
  const name = extractToolName(request).toLowerCase();
  if (!name) return false;
  return name.includes("execution_subagent")
    || name === "task"
    || name.includes("subagent")
    || name.includes("launch_subagent");
}

function extractSubagentDisplayName(request) {
  const args = toolArgsSnapshot(request);
  const candidates = [
    args?.description,
    args?.subagent_type,
    args?.subagentType,
    args?.name,
    args?.title,
    args?.agent_type,
    args?.agentType,
  ];
  for (const value of candidates) {
    const text = String(value || "").trim();
    if (text) return text.slice(0, 120);
  }
  return null;
}

function extractSubagentRunIdFromArgs(request) {
  const args = toolArgsSnapshot(request);
  const candidates = [
    args?.subagentRunId,
    args?.runId,
    args?.agentId,
    args?.resume,
    args?.id,
  ];
  for (const value of candidates) {
    const id = String(value || "").trim();
    if (id) return id;
  }
  return null;
}

function extractSubagentRunIdFromResult(result) {
  const parsed = parseMaybeJson(result);
  const sources = [result, parsed, parsed?.data, parsed?.result, parsed?.output].filter(Boolean);
  for (const source of sources) {
    if (typeof source === "string") {
      const id = source.trim();
      if (/^[0-9a-f-]{8,}$/i.test(id)) return id;
      continue;
    }
    if (!source || typeof source !== "object") continue;
    const candidates = [
      source.subagentRunId,
      source.agentId,
      source.runId,
      source.id,
      source.agent?.id,
      source.agent?.agentId,
    ];
    for (const value of candidates) {
      const id = String(value || "").trim();
      if (id) return id;
    }
  }
  return null;
}

export function createSubagentLifecycleHandlers({
  api,
  dbg = () => {},
  getRelayTurnActive,
  getActiveMessage,
} = {}) {
  /** @type {Map<string, { status: string, parentSubagentId: string|null, displayName: string|null, messageId: string }>} */
  const knownRuns = new Map();
  /** @type {Map<string, { parentSubagentId: string|null, displayName: string|null }>} */
  const pendingByToolCallId = new Map();
  /** @type {Array<{ parentSubagentId: string|null, displayName: string|null, toolCallId: string|null }>} */
  const pendingSpawns = [];

  async function postSubagentRun(activeMsg, payload) {
    if (!activeMsg?.id || !activeMsg?.conversationId) return;
    const subagentRunId = String(payload?.subagentRunId || "").trim();
    if (!subagentRunId) return;
    try {
      await api("POST", "/api/subagent-run", {
        messageId: activeMsg.id,
        conversationId: activeMsg.conversationId,
        subagentRunId,
        parentSubagentId: payload?.parentSubagentId || undefined,
        displayName: payload?.displayName || undefined,
        status: payload?.status || "running",
      });
    } catch (error) {
      dbg(
        "subagent-run publish failed",
        `msgId=${activeMsg.id}`,
        `runId=${subagentRunId.slice(0, 8)}`,
        error?.message || String(error),
      );
    }
  }

  async function registerSubagentRun(activeMsg, subagentRunId, {
    parentSubagentId = null,
    displayName = null,
    status = "running",
  } = {}) {
    const id = String(subagentRunId || "").trim();
    if (!id || !activeMsg?.id) return;

    const normalizedParent = parentSubagentId ? String(parentSubagentId).trim() : null;
    const normalizedName = displayName ? String(displayName).trim().slice(0, 120) : null;
    const existing = knownRuns.get(id);
    const nextStatus = String(status || "running").trim().toLowerCase();

    if (existing
      && existing.status === nextStatus
      && existing.parentSubagentId === normalizedParent
      && existing.displayName === normalizedName
      && existing.messageId === activeMsg.id) {
      return;
    }

    knownRuns.set(id, {
      status: nextStatus,
      parentSubagentId: normalizedParent,
      displayName: normalizedName,
      messageId: activeMsg.id,
    });

    await postSubagentRun(activeMsg, {
      subagentRunId: id,
      parentSubagentId: normalizedParent,
      displayName: normalizedName,
      status: nextStatus,
    });
  }

  function consumePendingSpawn({ parentSubagentId = null, toolCallId = null } = {}) {
    if (toolCallId && pendingByToolCallId.has(toolCallId)) {
      const pending = pendingByToolCallId.get(toolCallId);
      pendingByToolCallId.delete(toolCallId);
      return pending;
    }
    if (pendingSpawns.length === 1) {
      return pendingSpawns.shift();
    }
    if (pendingSpawns.length > 1) {
      const idx = pendingSpawns.findIndex((entry) => entry.parentSubagentId === parentSubagentId);
      if (idx >= 0) return pendingSpawns.splice(idx, 1)[0];
    }
    return null;
  }

  async function ensureFromAgentId(subagentRunId, {
    parentSubagentId = null,
    displayName = null,
    toolCallId = null,
  } = {}) {
    if (!getRelayTurnActive?.()) return;
    const activeMsg = getActiveMessage?.();
    if (!activeMsg?.id) return;

    const id = String(subagentRunId || "").trim();
    if (!id) return;

    let resolvedParent = parentSubagentId ? String(parentSubagentId).trim() : null;
    let resolvedName = displayName ? String(displayName).trim().slice(0, 120) : null;

    if (!knownRuns.has(id)) {
      const pending = consumePendingSpawn({ parentSubagentId: resolvedParent, toolCallId });
      if (pending) {
        resolvedParent = resolvedParent || pending.parentSubagentId || null;
        resolvedName = resolvedName || pending.displayName || null;
      }
    } else {
      // Re-discovery of a known run (e.g. its next tool call) must not demote
      // it to a root or rename it — keep the established parent/name.
      const existing = knownRuns.get(id);
      resolvedParent = resolvedParent || existing.parentSubagentId || null;
      resolvedName = resolvedName || existing.displayName || null;
    }

    await registerSubagentRun(activeMsg, id, {
      parentSubagentId: resolvedParent,
      displayName: resolvedName || `Subagent ${id.slice(0, 8)}`,
      status: "running",
    });
  }

  async function onPreToolUse(request) {
    if (!getRelayTurnActive?.()) return;
    const activeMsg = getActiveMessage?.();
    if (!activeMsg?.id) return;

    const callerAgentId = extractAgentIdFromRequest(request);
    if (callerAgentId) {
      await ensureFromAgentId(callerAgentId, { parentSubagentId: null });
    }

    if (!isSubagentSpawnTool(request)) return;

    const toolCallId = extractToolCallId(request);
    const parentSubagentId = callerAgentId || null;
    const displayName = extractSubagentDisplayName(request);
    const runIdFromArgs = extractSubagentRunIdFromArgs(request);

    const pending = { parentSubagentId, displayName, toolCallId };
    pendingSpawns.push(pending);
    if (toolCallId) pendingByToolCallId.set(toolCallId, pending);

    if (runIdFromArgs) {
      await registerSubagentRun(activeMsg, runIdFromArgs, {
        parentSubagentId,
        displayName: displayName || `Subagent ${runIdFromArgs.slice(0, 8)}`,
        status: "running",
      });
      if (toolCallId) pendingByToolCallId.delete(toolCallId);
      const idx = pendingSpawns.indexOf(pending);
      if (idx >= 0) pendingSpawns.splice(idx, 1);
    }
  }

  async function onPostToolUse(request, result) {
    if (!getRelayTurnActive?.()) return;
    const activeMsg = getActiveMessage?.();
    if (!activeMsg?.id) return;

    if (!isSubagentSpawnTool(request)) return;

    const toolCallId = extractToolCallId(request);
    const parentSubagentId = extractAgentIdFromRequest(request) || null;
    const displayName = extractSubagentDisplayName(request);
    const runId = extractSubagentRunIdFromResult(result) || extractSubagentRunIdFromArgs(request);
    if (!runId) return;

    if (toolCallId) pendingByToolCallId.delete(toolCallId);
    const idx = pendingSpawns.findIndex((entry) => entry.toolCallId === toolCallId);
    if (idx >= 0) pendingSpawns.splice(idx, 1);

    await registerSubagentRun(activeMsg, runId, {
      parentSubagentId,
      displayName: displayName || `Subagent ${runId.slice(0, 8)}`,
      status: "running",
    });
  }

  async function finalizeTurn(activeMsg) {
    if (!activeMsg?.id) return;
    const messageId = activeMsg.id;
    for (const [runId, entry] of knownRuns.entries()) {
      if (entry.messageId !== messageId) continue;
      if (entry.status === "cancelled" || entry.status === "failed") continue;
      if (entry.status === "completed") continue;
      await postSubagentRun(activeMsg, {
        subagentRunId: runId,
        parentSubagentId: entry.parentSubagentId,
        displayName: entry.displayName,
        status: "completed",
      });
    }
  }

  function reset() {
    knownRuns.clear();
    pendingByToolCallId.clear();
    pendingSpawns.length = 0;
  }

  function attach(session) {
    if (!session || typeof session.on !== "function") return () => {};
    const eventNames = [
      "agent.start",
      "agent.end",
      "agent.spawn",
      "execution.subagent.start",
      "execution.subagent.end",
    ];
    const subscriptions = [];
    for (const eventName of eventNames) {
      subscriptions.push(session.on(eventName, async (event) => {
        const activeMsg = getActiveMessage?.();
        if (!getRelayTurnActive?.() || !activeMsg?.id) return;
        const subagentRunId = extractAgentIdFromRequest(event)
          || String(event?.data?.subagentRunId || event?.data?.runId || "").trim()
          || null;
        if (!subagentRunId) return;
        const parentSubagentId = String(event?.data?.parentAgentId || event?.data?.parentSubagentId || "").trim() || null;
        const displayName = String(event?.data?.displayName || event?.data?.name || "").trim() || null;
        const isEnd = eventName.includes(".end");
        if (isEnd) {
          await registerSubagentRun(activeMsg, subagentRunId, {
            parentSubagentId,
            displayName,
            status: "completed",
          });
          return;
        }
        await ensureFromAgentId(subagentRunId, { parentSubagentId, displayName });
      }));
    }
    return () => {
      for (const unsubscribe of subscriptions) {
        try {
          if (typeof unsubscribe === "function") unsubscribe();
        } catch {
          // ignore
        }
      }
    };
  }

  return {
    ensureFromAgentId,
    onPreToolUse,
    onPostToolUse,
    finalizeTurn,
    reset,
    attach,
  };
}
