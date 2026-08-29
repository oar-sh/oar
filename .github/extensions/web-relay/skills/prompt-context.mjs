import {
  applyPreviewInstructions,
  createPreviewInstructionsProvider,
} from "../../../../shared/preview-instructions.mjs";

export { createPreviewInstructionsProvider };

export function buildPrompt(message) {
  const text = String(message?.text || "").trim();
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) return text;

  const attachmentNote = attachments.map((att) => {
    const name = att?.name ? String(att.name) : "attachment";
    const type = att?.type ? String(att.type) : "file";
    if (type.startsWith("image/")) return `${name} (${type}, inline image attachment)`;
    const reference = att?.path ? ` @${att.path}` : "";
    return `${name} (${type})${reference}`;
  }).join(", ");
  const suffix = `\n\n[Attached file${attachments.length === 1 ? "" : "s"}: ${attachmentNote}]`;
  return text ? `${text}${suffix}` : suffix.trimStart();
}

function normalizeRelayMode(mode) {
  const value = String(mode || "agent").trim().toLowerCase();
  if (value === "plan" || value === "ask" || value === "autopilot" || value === "agent") return value;
  return "agent";
}

function buildModeInstructionText(mode) {
  if (mode === "plan") {
    return [
      "Draft a concise plan only.",
      "Use read-only inspection tools (glob, rg, view) only when they materially improve plan quality; otherwise draft from provided context.",
      "Do not edit repository files or run mutating commands unless the user explicitly asks for implementation.",
      "If clarification is required, pause and ask through the web relay.",
      "These instructions remain in effect until relay mode changes.",
    ].join(" ");
  }
  if (mode === "ask") {
    return [
      "Prioritize clarification questions before doing any implementation work.",
      "If the request is ambiguous or underspecified, pause and ask through the web relay before making assumptions.",
      "Do not make broad assumptions when a question would materially change the result.",
      "These instructions remain in effect until relay mode changes.",
    ].join(" ");
  }
  if (mode === "autopilot") {
    return [
      "Act directly on the request and use tools when needed.",
      "Keep moving unless user input is truly blocking.",
      "These instructions remain in effect until relay mode changes.",
    ].join(" ");
  }
  return [
    "Proceed as an interactive coding agent and use tools as needed.",
    "If you need clarification, pause and ask through the web relay instead of stalling silently.",
    "These instructions remain in effect until relay mode changes.",
  ].join(" ");
}

export function buildModeMarker(mode) {
  return `[Relay mode: ${normalizeRelayMode(mode)}]`;
}

export function buildModePrompt(mode, toolInstructions = "", options = {}) {
  const normalizedMode = normalizeRelayMode(mode);
  const includeInstructions = options?.includeInstructions !== false;
  const parts = [buildModeMarker(normalizedMode)];
  if (includeInstructions) {
    parts.push(buildModeInstructionText(normalizedMode));
    if (toolInstructions) {
      parts.push(toolInstructions);
    }
  }
  return parts.join(" ");
}

export function buildPromptWithMode(message, toolInstructions = "", options = {}) {
  const modePrompt = buildModePrompt(message?.relayMode, toolInstructions, options);
  const body = buildPrompt(message);
  return [modePrompt, body].filter(Boolean).join(" ");
}

/**
 * The relay's prompt prefix builder: tool guidance rides along only when the
 * relay mode changed, so repeat turns in one mode stay cheap.
 */
export function createRelayPromptBuilder({
  toolInstructions = "",
  getPreviewInstructions = null,
} = {}) {
  let lastPromptedRelayMode = null;
  return async function buildPromptWithRelayContext(message) {
    const relayMode = normalizeRelayMode(message?.relayMode);
    const includeInstructions = lastPromptedRelayMode !== relayMode;
    let instructions = "";
    if (includeInstructions) {
      // Guidance is advisory: a preview lookup that fails must cost the block,
      // never the turn.
      const previewBlock = typeof getPreviewInstructions === "function"
        ? await Promise.resolve().then(getPreviewInstructions).catch(() => "")
        : "";
      instructions = applyPreviewInstructions(toolInstructions, previewBlock);
    }
    const prompt = buildPromptWithMode({ ...message, relayMode }, instructions, { includeInstructions });
    lastPromptedRelayMode = relayMode;
    return prompt;
  };
}

export function stripPromptPrefix(text, promptPrefix = "") {
  const value = String(text || "").trim();
  if (!value) return "";
  const prompt = String(promptPrefix || "").trim();
  if (!prompt) return value;
  if (!value.startsWith(prompt)) return value;
  const remainder = value.slice(prompt.length).trim();
  return remainder || "";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function whitespaceFlexiblePattern(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => escapeRegExp(part))
    .join("\\s+");
}

function stripPromptPrefixFlexible(text, promptPrefix = "") {
  const value = String(text || "").trim();
  const prompt = String(promptPrefix || "").trim();
  if (!value || !prompt) return value;
  const pattern = new RegExp(`^${whitespaceFlexiblePattern(prompt)}\\s*`, "i");
  const stripped = value.replace(pattern, "").trim();
  return stripped || "";
}

export function stripPromptContextPrefix(text, message, toolInstructions = "", promptPrefix = "") {
  const value = String(text || "").trim();
  if (!value) return "";
  const candidates = [
    String(promptPrefix || "").trim(),
    buildPromptWithMode(message, toolInstructions),
    buildPromptWithMode(message, toolInstructions, { includeInstructions: false }),
    buildModeMarker(message?.relayMode),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const stripped = stripPromptPrefix(value, candidate);
    if (stripped !== value) return stripped;
    const flexibleStripped = stripPromptPrefixFlexible(value, candidate);
    if (flexibleStripped !== value) return flexibleStripped;
  }
  return value;
}
