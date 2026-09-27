import {
  formatStoreMemoryActivity,
  formatToolResultActivity as formatSharedToolResultActivity,
  formatVoteMemoryActivity,
} from "../../../../shared/tool-activity.mjs";
import { isRemoteRelayToolName } from "../../../../shared/remote-relay-tool-core.mjs";
import { summarizeRemoteRelayCall } from "../../../../shared/remote-relay-contract.mjs";

export function normalizeActivityText(value, maxToolDetailLength = 140) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.replace(/\s+/g, " ").slice(0, maxToolDetailLength);
}

export function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

export function parsedQuestionSources(request) {
  const parsedToolArgs = parseMaybeJson(request?.toolArgs);
  const parsedInput = parseMaybeJson(request?.input);
  const parsedArguments = parseMaybeJson(request?.arguments);
  const parsedArgs = parseMaybeJson(request?.args);
  const parsedBody = parseMaybeJson(request?.body);
  const parsedRequest = parseMaybeJson(request?.request);
  return [
    request,
    parsedToolArgs,
    parsedInput,
    parsedArguments,
    parsedArgs,
    parsedBody,
    parsedRequest,
    parsedBody?.input,
    parsedBody?.arguments,
    parsedRequest?.input,
    parsedRequest?.arguments,
  ].filter(Boolean);
}

export function toolArgsSnapshot(request) {
  const candidates = [
    request?.toolArgs,
    request?.arguments,
    request?.args,
    request?.input,
    request?.payload,
    request?.toolInput,
    request?.toolCall?.arguments,
    request?.toolCall?.input,
  ];
  for (const value of candidates) {
    const parsed = parseMaybeJson(value);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return {};
}

export function extractToolName(request) {
  const candidates = [
    request?.toolName,
    request?.name,
    request?.tool?.name,
    request?.tool?.id,
    request?.toolCall?.name,
    request?.toolCall?.toolName,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function extractToolDetail(request, maxToolDetailLength = 140) {
  const args = toolArgsSnapshot(request);
  const name = extractToolName(request).toLowerCase();
  const candidateText = normalizeActivityText(
    args.question ||
    args.prompt ||
    args.description ||
    args.intent ||
    args.pattern ||
    args.path ||
    args.query ||
    args.url ||
    args.command ||
    "",
    maxToolDetailLength,
  );

  if (name.includes("ask_user") && candidateText) return `question=\"${candidateText}\"`;
  if ((name.includes("glob") || name.includes("rg") || name.includes("grep")) && candidateText) return `query=\"${candidateText}\"`;
  if (name.includes("powershell") && candidateText) return `command=\"${candidateText}\"`;
  if (candidateText) return candidateText;
  return "";
}

export function formatToolActivity(request, maxToolDetailLength = 140) {
  const rawName = extractToolName(request);
  if (!rawName) return null;

  const lower = rawName.toLowerCase();
  const detail = extractToolDetail(request, maxToolDetailLength);

  if (lower.includes("store_memory")) {
    return formatStoreMemoryActivity(rawName, toolArgsSnapshot(request));
  }
  if (lower.includes("vote_memory")) {
    return formatVoteMemoryActivity(rawName, toolArgsSnapshot(request));
  }

  if (lower.includes("search (glob)") || /(^|[.\s_-])glob($|[.\s_-])/.test(lower)) {
    return detail ? `Search (glob): ${detail}` : "Search (glob)";
  }
  if (lower.includes("search (grep)") || /(^|[.\s_-])(rg|grep)($|[.\s_-])/.test(lower)) {
    return detail ? `Search (grep): ${detail}` : "Search (grep)";
  }
  if (lower.includes("web_search") || lower.includes("web search")) {
    return detail ? `Web Search: ${detail}` : "Web Search";
  }
  if (lower.includes("web_fetch") || lower.includes("web fetch")) {
    return detail ? `Web Fetch: ${detail}` : "Web Fetch";
  }
  if (lower.includes("ask_user")) {
    return detail ? `Tool (ask_user): ${detail}` : "Tool (ask_user)";
  }
  if (lower.includes("report_intent")) {
    return detail ? `● ${detail}` : "● Working…";
  }
  // The OAR MCP server's tool reaches the CLI as `oar-remote_relay`: show the
  // same line every other engine writes for it.
  if (isRemoteRelayToolName(rawName)) {
    return `Tool (remote_relay): ${summarizeRemoteRelayCall(toolArgsSnapshot(request))}`;
  }
  return detail ? `Tool (${rawName}): ${detail}` : `Tool (${rawName})`;
}

export function formatToolResultActivity(request, result, maxToolDetailLength = 140) {
  return formatSharedToolResultActivity(extractToolName(request), result, maxToolDetailLength);
}

export function isAskUserTool(request) {
  return extractToolName(request).toLowerCase().includes("ask_user");
}

export function extractQuestionPrompt(request) {
  const candidates = [];
  for (const source of parsedQuestionSources(request)) {
    candidates.push(
      source?.prompt,
      source?.text,
      source?.message,
      source?.question,
      source?.content,
      source?.instruction,
    );
  }

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  if (request && typeof request === "object") {
    const keys = Object.keys(request).slice(0, 8);
    if (keys.length) {
      return `Clarification needed (${keys.join(", ")})`;
    }
  }

  return "Clarification needed";
}

export function extractQuestionChoices(request) {
  const rawCandidates = [];
  for (const source of parsedQuestionSources(request)) {
    rawCandidates.push(
      source?.choices,
      source?.options,
      source?.items,
      source?.suggestions,
    );
    // Also check JSON Schema format: requestedSchema.properties.*.oneOf or enum
    const schema = source?.requestedSchema;
    if (schema?.properties) {
      for (const prop of Object.values(schema.properties)) {
        if (Array.isArray(prop?.oneOf)) {
          rawCandidates.push(prop.oneOf);
        }
        if (Array.isArray(prop?.enum)) {
          rawCandidates.push(prop.enum);
        }
      }
    }
  }

  const raw = rawCandidates.find((value) => Array.isArray(value)) || [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((choice) => {
      if (typeof choice === "string") return choice.trim();
      if (choice && typeof choice === "object") {
        // Support JSON Schema oneOf format: {const: "value", title: "Display Label"}
        return String(choice.title || choice.label || choice.text || choice.value || choice.const || "").trim();
      }
      return "";
    })
    .filter(Boolean)
    .slice(0, 8);
}

export function buildAskUserQuestionRequest(request) {
  const args = toolArgsSnapshot(request);
  return {
    prompt:
      args?.question ||
      args?.prompt ||
      args?.message ||
      request?.question ||
      request?.prompt ||
      "Clarification needed",
    choices: extractQuestionChoices({ ...request, ...args }),
    allow_freeform: args?.allow_freeform,
    request,
  };
}

export function serializeRequest(request) {
  if (!request || typeof request !== "object") return null;
  const seen = new WeakSet();
  try {
    return JSON.stringify(request, (key, value) => {
      if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
  } catch {
    return null;
  }
}
