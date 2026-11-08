/**
 * reasoning-stream.mjs — capture the Copilot SDK's assistant reasoning ("thoughts")
 * and incremental assistant text via session.on(...) subscriptions, and relay them to
 * the web server.
 *
 * The SDK exposes reasoning as session EVENTS (not hooks):
 *   - assistant.reasoning        complete reasoning block (fires regardless of streaming flag)
 *   - assistant.reasoning_delta  token-level reasoning deltas (requires streaming:true at join)
 *   - assistant.message_delta    token-level assistant text deltas (requires streaming:true)
 *
 * Events are still delivered to handlers registered via on() while sendAndWait is in flight,
 * so we can capture reasoning without abandoning the stable sendAndWait turn path.
 *
 * Guards mirror question-routing-hooks.mjs: only relay while a relay turn is active and an
 * active message exists. Sub-agent thoughts (event.agentId set) are dropped to start.
 */

// Coalesce reasoning deltas to avoid request floods: emit when >= this many new chars
// accumulated or a sentence/line boundary is reached.
const REASONING_DELTA_MIN_CHARS = 24;
const MAX_THOUGHT_CHARS = 16 * 1024;

function shouldEmitDelta(nextText, previousText) {
  const next = String(nextText || "");
  const prev = String(previousText || "");
  if (!next) return false;
  if (!prev) return true;
  if (next === prev) return false;
  const delta = next.length - prev.length;
  if (delta >= REASONING_DELTA_MIN_CHARS) return true;
  if (delta > 0 && /[\n.!?:)]$/.test(next)) return true;
  if (delta <= 0) return true;
  return false;
}

function capThought(text) {
  const value = String(text || "");
  if (value.length <= MAX_THOUGHT_CHARS) return value;
  return value.slice(0, MAX_THOUGHT_CHARS);
}

function fnv1a32(value) {
  const text = String(value || "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function shouldSkipCompleteReasoning(nextText, previousText) {
  const next = String(nextText || "");
  const previous = String(previousText || "");
  if (!next) return true;
  if (!previous) return false;
  if (next === previous) return true;
  if (!next.startsWith(previous)) return false;
  const growth = next.length - previous.length;
  return growth >= 0 && growth < REASONING_DELTA_MIN_CHARS;
}

function toolThoughtReasoningId(messageId, phase, toolRequests, messageContent) {
  const tools = (Array.isArray(toolRequests) ? toolRequests : []).map((request) => ({
    id: String(request?.id || request?.toolCallId || "").trim() || null,
    name: String(request?.name || request?.toolName || request?.tool || "").trim() || null,
  }));
  const fingerprintInput = JSON.stringify({
    phase: String(phase || "").trim().toLowerCase(),
    tools,
    content: String(messageContent || "").trim(),
  });
  return `message:${messageId}:tool:${fnv1a32(fingerprintInput)}`;
}

export function createReasoningStreamHandlers({
  api,
  dbg = () => {},
  getRelayTurnActive,
  getActiveMessage,
  notifySubagentAgentId,
} = {}) {
  // reasoningId -> accumulated reasoning text (for delta coalescing)
  const reasoningAccum = new Map();
  // reasoningId -> last emitted reasoning text (so we only emit meaningful changes)
  const reasoningLastSent = new Map();
  // messageId -> last assistant.message.reasoningText we emitted (dedupe repeated final envelopes)
  const messageReasoningLastSent = new Map();
  // cumulative assistant text seen via message deltas + last value pushed to /api/stream
  let messageTextAccum = "";
  let messageTextLastSent = "";
  let maxReadableReasoningChars = 0;

  function relayContext() {
    if (!getRelayTurnActive?.()) return null;
    const activeMsg = getActiveMessage?.();
    if (!activeMsg?.id) return null;
    return activeMsg;
  }

  function extractAgentId(event) {
    const agentId = event?.agentId || event?.data?.agentId || null;
    return agentId ? String(agentId).trim() : null;
  }

  function isRootAgentEvent(event) {
    return !extractAgentId(event);
  }

  function reasoningIdFor(event) {
    return String(event?.data?.reasoningId || event?.reasoningId || "reasoning").trim() || "reasoning";
  }

  function noteReadableReasoning(text) {
    const length = String(text || "").length;
    if (length > maxReadableReasoningChars) {
      maxReadableReasoningChars = length;
    }
    return length;
  }

  function isClaudeModel(event) {
    const model = String(event?.data?.model || event?.model || "").trim().toLowerCase();
    return model.includes("claude");
  }

  async function postThought(activeMsg, { reasoningId, text, done, subagentRunId = null }) {
    try {
      await api("POST", "/api/thought", {
        messageId: activeMsg.id,
        conversationId: activeMsg.conversationId,
        mode: activeMsg.relayMode || "agent",
        reasoningId,
        text: capThought(text),
        done: !!done,
        subagentRunId: subagentRunId || undefined,
      });
    } catch (error) {
      dbg("relay thought publish failed", `msgId=${activeMsg.id}`, `reasoningId=${reasoningId}`, error?.message || String(error));
    }
  }

  async function onReasoning(event) {
    const activeMsg = relayContext();
    if (!activeMsg) return;
    const subagentRunId = extractAgentId(event);
    if (subagentRunId) await notifySubagentAgentId?.(subagentRunId);
    const reasoningId = reasoningIdFor(event);
    const text = String(event?.data?.content ?? event?.data?.text ?? "");
    if (!text) return;
    const lastSent = reasoningLastSent.get(reasoningId) || "";
    if (shouldSkipCompleteReasoning(text, lastSent)) {
      reasoningAccum.delete(reasoningId);
      return;
    }
    // The complete block is authoritative — clear delta bookkeeping for this id.
    reasoningAccum.delete(reasoningId);
    reasoningLastSent.set(reasoningId, text);
    noteReadableReasoning(text);
    await postThought(activeMsg, { reasoningId, text, done: true, subagentRunId });
  }

  async function onReasoningDelta(event) {
    const activeMsg = relayContext();
    if (!activeMsg) return;
    const subagentRunId = extractAgentId(event);
    if (subagentRunId) await notifySubagentAgentId?.(subagentRunId);
    const reasoningId = reasoningIdFor(event);
    const deltaContent = String(event?.data?.deltaContent ?? event?.data?.delta ?? "");
    if (!deltaContent) return;
    // Capped before the gate: past the cap the text stops changing, so the
    // same 16 KiB is not posted again and the accumulator stops growing.
    const accumulated = capThought((reasoningAccum.get(reasoningId) || "") + deltaContent);
    reasoningAccum.set(reasoningId, accumulated);
    const lastSent = reasoningLastSent.get(reasoningId) || "";
    if (!shouldEmitDelta(accumulated, lastSent)) return;
    reasoningLastSent.set(reasoningId, accumulated);
    noteReadableReasoning(accumulated);
    await postThought(activeMsg, { reasoningId, text: accumulated, done: false, subagentRunId });
  }

  async function onMessage(event) {
    const activeMsg = relayContext();
    if (!activeMsg) return;
    const subagentRunId = extractAgentId(event);
    if (subagentRunId) await notifySubagentAgentId?.(subagentRunId);
    const messageId = String(event?.data?.messageId || event?.messageId || "").trim();
    const phase = String(event?.data?.phase || event?.phase || "").trim().toLowerCase();
    const toolRequests = Array.isArray(event?.data?.toolRequests) ? event.data.toolRequests : [];
    const messageContent = String(event?.data?.content ?? event?.data?.text ?? "");
    const reasoningText = String(event?.data?.reasoningText ?? "");
    if (!messageId) return;

    const lastSent = messageReasoningLastSent.get(messageId) || "";
    const hasToolThought = toolRequests.length > 0 && !phase.includes("final") && !!messageContent;
    if (hasToolThought) {
      if (lastSent === messageContent) return;
      messageReasoningLastSent.set(messageId, messageContent);
      noteReadableReasoning(messageContent);
      await postThought(activeMsg, {
        reasoningId: toolThoughtReasoningId(messageId, phase, toolRequests, messageContent),
        text: messageContent,
        done: true,
        subagentRunId,
      });
      return;
    }

    if (!reasoningText || lastSent === reasoningText) return;

    const previousMax = maxReadableReasoningChars;
    const reasoningChars = reasoningText.length;
    const readableReasoningAlreadySeen = previousMax > 0;
    const isMeaningfulUpgrade = reasoningChars > (previousMax + REASONING_DELTA_MIN_CHARS);
    const shouldPublish = !readableReasoningAlreadySeen || (!isClaudeModel(event) && isMeaningfulUpgrade);
    if (!shouldPublish) return;

    messageReasoningLastSent.set(messageId, reasoningText);
    noteReadableReasoning(reasoningText);
    await postThought(activeMsg, {
      reasoningId: `message:${messageId}`,
      text: reasoningText,
      done: true,
      subagentRunId,
    });
  }

  async function onMessageDelta(event) {
    const activeMsg = relayContext();
    if (!activeMsg) return;
    const subagentRunId = extractAgentId(event);
    if (subagentRunId) await notifySubagentAgentId?.(subagentRunId);
    const deltaContent = String(event?.data?.deltaContent ?? event?.data?.delta ?? "");
    if (!deltaContent) return;
    messageTextAccum += deltaContent;
    if (!shouldEmitDelta(messageTextAccum, messageTextLastSent)) return;
    messageTextLastSent = messageTextAccum;
    try {
      await api("POST", "/api/stream", {
        messageId: activeMsg.id,
        conversationId: activeMsg.conversationId,
        mode: activeMsg.relayMode || "agent",
        text: messageTextAccum,
        done: false,
        subagentRunId: subagentRunId || undefined,
      });
    } catch (error) {
      dbg("relay stream (message_delta) publish failed", `msgId=${activeMsg.id}`, error?.message || String(error));
    }
  }

  // Clear per-turn accumulators. Call when a relay turn ends.
  function reset() {
    reasoningAccum.clear();
    reasoningLastSent.clear();
    messageReasoningLastSent.clear();
    messageTextAccum = "";
    messageTextLastSent = "";
    maxReadableReasoningChars = 0;
  }

  // Subscribe to the session events. Returns an unsubscribe function.
  function attach(session) {
    if (!session || typeof session.on !== "function") {
      dbg("reasoning-stream attach skipped: session.on unavailable");
      return () => {};
    }
    const subscriptions = [
      session.on("assistant.reasoning", onReasoning),
      session.on("assistant.reasoning_delta", onReasoningDelta),
      session.on("assistant.message", onMessage),
      session.on("assistant.message_delta", onMessageDelta),
    ];
    dbg("reasoning-stream attached", `sessionId=${session?.sessionId || "(none)"}`);
    return () => {
      for (const unsubscribe of subscriptions) {
        try {
          if (typeof unsubscribe === "function") unsubscribe();
        } catch (error) {
          dbg("reasoning-stream unsubscribe failed", error?.message || String(error));
        }
      }
    };
  }

  return { onReasoning, onReasoningDelta, onMessage, onMessageDelta, reset, attach };
}
