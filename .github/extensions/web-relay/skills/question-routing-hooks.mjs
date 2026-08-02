import { extractToolName, parseMaybeJson, toolArgsSnapshot } from "./tool-activity.mjs";
import {
  extractRequestedSchema,
  schemaFields,
  validateStructuredAnswer,
  flatAnswerToStructured,
  summarizeStructuredAnswer,
} from "../../../../shared/question-schema.mjs";

function extractSubagentRunIdFromRequest(request) {
  const agentId = request?.agentId || request?.data?.agentId || null;
  const id = agentId ? String(agentId).trim() : "";
  return id || null;
}

function isReportIntentTool(request) {
  const name = extractToolName(request).toLowerCase();
  return name.includes("report_intent") || name === "report_intent";
}

function extractReportIntentText(request) {
  const args = toolArgsSnapshot(request);
  const candidates = [
    args?.intent,
    args?.description,
    args?.message,
    args?.text,
    args?.content,
    args?.summary,
    args?.thought,
    args?.reasoning,
  ];
  for (const value of candidates) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

export function createQuestionRoutingHooks({
  api,
  dbg,
  forwardRelayQuestion,
  isAskUserTool,
  normalizeActivityText,
  formatToolActivity,
  formatToolResultActivity,
  extractQuestionChoices,
  maxToolDetailLength = 140,
  getRelayTurnActive,
  getActiveMessage,
  setLastAskUserBridge,
  getLastActivityText,
  setLastActivityText,
  setPendingAskUserRequest,
  }) {
  const allowToolUse = { permissionDecision: "allow" };

  function normalizePlanBoardActions(rawActions, recommendedAction = "") {
    const ids = Array.isArray(rawActions)
      ? rawActions
        .map((entry) => {
          if (typeof entry === "string") return entry.trim().toLowerCase();
          if (entry && typeof entry === "object") {
            return String(entry.id || entry.actionId || entry.value || "").trim().toLowerCase();
          }
          return "";
        })
        .filter(Boolean)
      : [];
    const sourceIds = ids.length ? ids : ["autopilot", "interactive", "exit_only"];
    const seen = new Set();
    const deduped = [];
    for (const id of sourceIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      deduped.push(id);
    }
    const recommended = String(recommendedAction || "").trim().toLowerCase();
    return {
      actions: deduped.map((id) => {
        if (id === "autopilot_fleet") return { id, label: "Implement with autopilot fleet", mode: "autopilot" };
        if (id === "autopilot") return { id, label: "Implement in autopilot", mode: "autopilot" };
        if (id === "interactive") return { id, label: "Stop here and prompt myself", mode: "agent" };
        if (id === "exit_only") return { id, label: "Stop here", mode: "agent" };
        return { id, label: id.replace(/[_-]+/g, " "), mode: null };
      }),
      recommendedAction: recommended || null,
    };
  }

  function firstNonEmptyPlanField(...values) {
    for (const value of values) {
      const text = String(value || "").trim();
      if (text) return text;
    }
    return "";
  }

  function extractPlanBoardArgs(request) {
    const parsedBody = parseMaybeJson(request?.body);
    const parsedPayload = parseMaybeJson(request?.payload);
    const parsedRequest = parseMaybeJson(request?.request);
    const parsedToolCall = parseMaybeJson(request?.toolCall);
    const rawCandidates = [
      toolArgsSnapshot(request),
      parseMaybeJson(request?.input),
      parseMaybeJson(request?.arguments),
      parseMaybeJson(request?.args),
      parseMaybeJson(request?.toolArgs),
      parseMaybeJson(request?.toolInput),
      parsedBody,
      parsedPayload,
      parsedRequest,
      parsedToolCall,
      toolArgsSnapshot(parsedBody),
      toolArgsSnapshot(parsedPayload),
      toolArgsSnapshot(parsedRequest),
      toolArgsSnapshot(parsedToolCall),
      parseMaybeJson(parsedBody?.input),
      parseMaybeJson(parsedBody?.arguments),
      parseMaybeJson(parsedPayload?.input),
      parseMaybeJson(parsedPayload?.arguments),
      parseMaybeJson(parsedRequest?.input),
      parseMaybeJson(parsedRequest?.arguments),
      parseMaybeJson(parsedToolCall?.input),
      parseMaybeJson(parsedToolCall?.arguments),
    ];
    const seen = new Set();
    const candidates = rawCandidates.filter((value) => {
      if (!value || typeof value !== "object") return false;
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
    for (const candidate of candidates) {
      if (firstNonEmptyPlanField(candidate.summary, candidate.result, candidate.output, candidate.message)) {
        return candidate;
      }
    }
    return candidates[0] || null;
  }

  function buildPlanBoardPayloadFromRequest(request, activeMsg) {
    const toolName = extractToolName(request).toLowerCase();
    const relayMode = String(activeMsg?.relayMode || "").trim().toLowerCase();
    if (!activeMsg?.id) return null;
    if (toolName !== "exit_plan_mode" && !(toolName === "task_complete" && relayMode === "plan")) return null;

    const args = extractPlanBoardArgs(request);
    if (!args || typeof args !== "object") return null;

    const summary = firstNonEmptyPlanField(args.summary, args.result, args.output, args.message);
    if (!summary) return null;

    const normalized = normalizePlanBoardActions(args.actions, args.recommendedAction);
    return {
      queueId: activeMsg.id,
      messageId: activeMsg.id,
      conversationId: activeMsg.conversationId,
      mode: activeMsg.relayMode || "agent",
      boardType: "plan_ready",
      title: "Plan ready for review",
      body: summary,
      actions: normalized.actions,
      recommendedAction: normalized.recommendedAction,
      context: {
        source: toolName,
        queueMessageId: activeMsg.id || null,
        conversationId: activeMsg.conversationId || null,
        relayMode: activeMsg.relayMode || "agent",
      },
    };
  }

  function answerActivityText(answer) {
    const normalized = normalizeActivityText(answer, maxToolDetailLength) || String(answer || "").trim();
    const escaped = normalized.replace(/"/g, "'");
    return {
      normalized,
      text: normalized
        ? `Tool (ask_user): user answered "${escaped}"`
        : "Tool (ask_user): answered via web relay",
    };
  }

  function timeoutActivityText() {
    return {
      normalized: "",
      text: "Tool (ask_user): user did not respond before timeout; continuing according to relay mode",
    };
  }

  async function onPreToolUse(request) {
    if (!getRelayTurnActive()) {
      return allowToolUse;
    }

    const activeMsg = getActiveMessage();
    const planBoardPayload = buildPlanBoardPayloadFromRequest(request, activeMsg);
    if (planBoardPayload) {
      await api("POST", "/api/relay-board", planBoardPayload).catch((error) => {
        dbg("plan board publish failed", `msgId=${activeMsg.id}`, error?.message || String(error));
      });
    }

    if (isAskUserTool(request) && activeMsg?.id) {
      const extractedChoices = extractQuestionChoices(request);
      dbg("onPreToolUse: detected ask_user tool", `msgId=${activeMsg.id}`, "waiting for onUserInputRequest callback...");
      dbg("onPreToolUse: ask_user request keys=", Object.keys(request || {}).join(","), "toolArgs=", JSON.stringify(request?.toolArgs)?.slice(0, 300), "choices=", JSON.stringify(extractedChoices));
      setLastAskUserBridge(null);
      setPendingAskUserRequest?.(null);
      dbg("onPreToolUse: ask_user fallback staging disabled; waiting for SDK callbacks", `msgId=${activeMsg.id}`);
      await api("POST", "/api/activity", {
        messageId: activeMsg.id,
        conversationId: activeMsg.conversationId,
        mode: activeMsg.relayMode || "agent",
        text: "Tool (ask_user): clarification requested in web relay",
        subagentRunId: extractSubagentRunIdFromRequest(request) || undefined,
      }).catch(() => {});
    }

    const reportIntentTool = isReportIntentTool(request);
    const activityText = formatToolActivity(request, maxToolDetailLength);
    if (!reportIntentTool && activityText && activeMsg?.id && activityText !== getLastActivityText()) {
      setLastActivityText(activityText);
      await api("POST", "/api/activity", {
        messageId: activeMsg.id,
        conversationId: activeMsg.conversationId,
        mode: activeMsg.relayMode || "agent",
        text: activityText,
        subagentRunId: extractSubagentRunIdFromRequest(request) || undefined,
      }).catch(() => {});
    }

    // Route report_intent full text through thought pipeline (avoids 140-char activity truncation)
    if (reportIntentTool && activeMsg?.id) {
      const fullIntentText = extractReportIntentText(request);
      if (fullIntentText) {
        await api("POST", "/api/thought", {
          messageId: activeMsg.id,
          conversationId: activeMsg.conversationId,
          mode: activeMsg.relayMode || "agent",
          reasoningId: `intent-${Date.now()}`,
          text: fullIntentText,
          done: true,
          subagentRunId: extractSubagentRunIdFromRequest(request) || undefined,
        }).catch((error) => {
          dbg("report_intent thought publish failed", `msgId=${activeMsg.id}`, error?.message || String(error));
        });
      }
    }

    return allowToolUse;
  }

  async function onPostToolUse(request, result) {
    if (!getRelayTurnActive()) return;
    const activeMsg = getActiveMessage();
    if (!activeMsg?.id) return;
    const activityText = formatToolResultActivity(request, result, maxToolDetailLength);
    if (!activityText || activityText === getLastActivityText()) return;
    setLastActivityText(activityText);
    await api("POST", "/api/activity", {
      messageId: activeMsg.id,
      conversationId: activeMsg.conversationId,
      mode: activeMsg.relayMode || "agent",
      text: activityText,
      subagentRunId: extractSubagentRunIdFromRequest(request) || undefined,
    }).catch((error) => {
      dbg("tool result activity publish failed", `msgId=${activeMsg.id}`, error?.message || String(error));
    });
  }

  async function onUserInputRequest(request) {
    const activeMsg = getActiveMessage();
    if (!getRelayTurnActive() || !activeMsg?.id) {
      dbg(
        "ask_user bridge skipped: no active relay turn",
        `relayTurnActive=${String(getRelayTurnActive())}`,
        `hasActiveMessage=${String(!!activeMsg?.id)}`,
      );
      // Throw so the CLI runtime knows input is unavailable.
      // With onUserInputRequest registered at top level (requestUserInput: true), the CLI will not
      // show a terminal prompt for relay turns — this error only fires for non-relay CLI turns.
      throw new Error("ask_user: no active relay turn — user input unavailable outside web relay context.");
    }

    dbg(
      "forwarding user input request for msgId",
      activeMsg.id,
      "mode",
      activeMsg.relayMode || "agent",
      "keys",
      Object.keys(request || {}).join(","),
    );

    await api("POST", "/api/activity", {
      messageId: activeMsg.id,
      conversationId: activeMsg.conversationId,
      mode: activeMsg.relayMode || "agent",
      text: "Tool (ask_user): question posted; waiting for user answer",
      subagentRunId: extractSubagentRunIdFromRequest(request) || undefined,
    }).catch(() => {});

    setPendingAskUserRequest?.(null); // Normal bridge is handling it — clear so autopilot path is skipped
    const result = await forwardRelayQuestion(request);
    const answer = String(result?.answer || "");
    setLastAskUserBridge({
      source: "onUserInputRequest",
      at: Date.now(),
      messageId: activeMsg.id,
    });
    const activity = result?.timedOut ? timeoutActivityText() : answerActivityText(answer);
    await api("POST", "/api/activity", {
      messageId: activeMsg.id,
      conversationId: activeMsg.conversationId,
      mode: activeMsg.relayMode || "agent",
      text: activity.text,
      subagentRunId: extractSubagentRunIdFromRequest(request) || undefined,
    }).catch(() => {});

    dbg(
      "relay question answered for msgId",
      activeMsg.id,
      "answerLen",
      String(answer.length),
      `answer="${activity.normalized}"`,
    );

    return {
      answer,
      wasFreeform: !extractQuestionChoices(request).length,
    };
  }

  function buildDefaultsContent(schema) {
    const fields = schemaFields(schema);
    if (!fields.length) return null;
    const content = {};
    for (const field of fields) {
      if (field.hasDefault) {
        content[field.name] = field.default;
      } else if (field.required) {
        // A required field has no default — cannot synthesize a complete answer.
        return null;
      }
    }
    return content;
  }

  function buildElicitationContent(schema, result) {
    // Prefer the validated structured answer captured by the relay UI.
    if (result?.structuredAnswer && typeof result.structuredAnswer === "object") {
      const validation = validateStructuredAnswer(schema, result.structuredAnswer);
      return validation.ok ? validation.value : result.structuredAnswer;
    }
    // Fall back to mapping a flat string answer onto a single-field schema.
    const flat = String(result?.answer || "").trim();
    if (flat) {
      const mapped = flatAnswerToStructured(schema, flat);
      if (mapped) return mapped;
      const fields = schemaFields(schema);
      if (fields.length === 1) return { [fields[0].name]: flat };
    }
    return null;
  }

  async function onElicitationRequest(request) {
    const activeMsg = getActiveMessage();
    if (!getRelayTurnActive() || !activeMsg?.id) {
      dbg(
        "elicitation bridge skipped: no active relay turn",
        `relayTurnActive=${String(getRelayTurnActive())}`,
        `hasActiveMessage=${String(!!activeMsg?.id)}`,
      );
      throw new Error("ask_user: no active relay turn — user input unavailable outside web relay context.");
    }

    const schema = extractRequestedSchema(request);
    const fieldCount = schema ? schemaFields(schema).length : 0;
    dbg(
      "forwarding elicitation request for msgId",
      activeMsg.id,
      "mode",
      activeMsg.relayMode || "agent",
      "fields",
      String(fieldCount),
    );

    await api("POST", "/api/activity", {
      messageId: activeMsg.id,
      conversationId: activeMsg.conversationId,
      mode: activeMsg.relayMode || "agent",
      text: fieldCount > 1
        ? `Tool (ask_user): ${fieldCount}-field form posted; waiting for user answer`
        : "Tool (ask_user): question posted; waiting for user answer",
    }).catch(() => {});

    setPendingAskUserRequest?.(null);
    const result = await forwardRelayQuestion(request);
    setLastAskUserBridge({
      source: "onElicitationRequest",
      at: Date.now(),
      messageId: activeMsg.id,
    });

    if (result?.timedOut) {
      const defaults = buildDefaultsContent(schema);
      const activity = timeoutActivityText();
      await api("POST", "/api/activity", {
        messageId: activeMsg.id,
        conversationId: activeMsg.conversationId,
        mode: activeMsg.relayMode || "agent",
        text: activity.text,
      }).catch(() => {});
      if (defaults) {
        dbg("elicitation timed out for msgId", activeMsg.id, "— accepting schema defaults");
        return { action: "accept", content: defaults };
      }
      dbg("elicitation timed out for msgId", activeMsg.id, "— declining");
      return { action: "decline" };
    }

    const content = buildElicitationContent(schema, result);
    if (!content) {
      dbg("elicitation produced no usable content for msgId", activeMsg.id, "— declining");
      await api("POST", "/api/activity", {
        messageId: activeMsg.id,
        conversationId: activeMsg.conversationId,
        mode: activeMsg.relayMode || "agent",
        text: "Tool (ask_user): no answer captured; continuing according to relay mode",
      }).catch(() => {});
      return { action: "decline" };
    }

    const summary = summarizeStructuredAnswer(schema, content) || String(result?.answer || "");
    const escaped = summary.replace(/"/g, "'");
    await api("POST", "/api/activity", {
      messageId: activeMsg.id,
      conversationId: activeMsg.conversationId,
      mode: activeMsg.relayMode || "agent",
      text: summary ? `Tool (ask_user): user answered "${escaped}"` : "Tool (ask_user): answered via web relay",
    }).catch(() => {});

    dbg(
      "elicitation answered for msgId",
      activeMsg.id,
      "fields",
      String(Object.keys(content).length),
      `summary="${summary.slice(0, 120)}"`,
    );

    return { action: "accept", content };
  }

  return {
    onPreToolUse,
    onPostToolUse,
    onUserInputRequest,
    onElicitationRequest,
  };
}
