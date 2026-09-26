const RELAY_TOOL_GUIDANCE = [
  '# Relay Tool Guidance',
  'For any user-facing question or clarification, use the ask_user tool so the web relay can render question cards and buttons. Never ask questions in plain assistant text.',
  'When using ask_user, ALWAYS include a `choices` array with 2-6 answer options so the web relay can render clickable buttons. Only omit choices when the question genuinely requires freeform text input.',
  'In autopilot, still call ask_user when user input is truly blocking, because the relay bridge can surface the question even when the direct SDK question hook is bypassed.',
  'For relay restarts in extension-managed mode, require explicit user permission first, then use the authenticated localhost API `POST /api/relay/shutdown`. Do not restart by killing processes or using respawn scripts.',
  'Note: shutdown is queued and only completes when the current turn finishes, so it is pointless to wait for it to interrupt an active turn.',
  'Use `restart: true` in the request body when the user wants a real relay restart rather than a plain shutdown. Example request body: `{ "reason": "manual-restart", "requestedBy": "localhost-api", "restart": true }`.',
].join(' ');

const MODE_MARKERS = {
  plan: '[Relay mode: plan]',
  ask: '[Relay mode: ask]',
  autopilot: '[Relay mode: autopilot]',
  agent: '[Relay mode: agent]',
};

const MODE_INSTRUCTIONS = {
  plan: [
    'Draft a concise plan only.',
    'Use read-only inspection tools (glob, rg, view) only when they materially improve plan quality; otherwise draft from provided context.',
    'Do not edit repository files or run mutating commands unless the user explicitly asks for implementation.',
    'If clarification is required, pause and ask through the web relay.',
    'These instructions remain in effect until relay mode changes.',
  ].join(' '),
  ask: [
    'Prioritize clarification questions before doing any implementation work.',
    'If the request is ambiguous or underspecified, pause and ask through the web relay before making assumptions.',
    'Do not make broad assumptions when a question would materially change the result.',
    'These instructions remain in effect until relay mode changes.',
  ].join(' '),
  autopilot: [
    'Act directly on the request and use tools when needed.',
    'Keep moving unless user input is truly blocking.',
    'These instructions remain in effect until relay mode changes.',
  ].join(' '),
  agent: [
    'Proceed as an interactive coding agent and use tools as needed.',
    'If you need clarification, pause and ask through the web relay instead of stalling silently.',
    'These instructions remain in effect until relay mode changes.',
  ].join(' '),
};

const LEGACY_MODE_INSTRUCTIONS = {
  plan: [
    'Draft a concise plan only.',
    'Do not edit files or run tools unless the user explicitly asks for implementation.',
    'If clarification is required, pause and ask through the web relay.',
  ].join(' '),
  ask: [
    'Prioritize clarification questions before doing any implementation work.',
    'If the request is ambiguous or underspecified, pause and ask through the web relay before making assumptions.',
    'Do not make broad assumptions when a question would materially change the result.',
  ].join(' '),
  autopilot: [
    'Act directly on the request and use tools when needed.',
    'Keep moving unless user input is truly blocking.',
  ].join(' '),
  agent: [
    'Proceed as an interactive coding agent and use tools as needed.',
    'If you need clarification, pause and ask through the web relay instead of stalling silently.',
  ].join(' '),
};

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function whitespaceFlexiblePattern(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => escapeRegExp(part))
    .join('\\s+');
}

function buildPromptPrefixPatterns(mode) {
  const requestedMode = String(mode || '').trim().toLowerCase();
  const modes = requestedMode && MODE_MARKERS[requestedMode]
    ? [requestedMode]
    : Object.keys(MODE_MARKERS);
  return modes.flatMap((key) => {
    const marker = MODE_MARKERS[key];
    const currentFullPrefix = `${marker} ${MODE_INSTRUCTIONS[key]} ${RELAY_TOOL_GUIDANCE}`;
    const legacyFullPrefix = `${marker} ${LEGACY_MODE_INSTRUCTIONS[key]} ${RELAY_TOOL_GUIDANCE}`;
    return [
      new RegExp(`^${whitespaceFlexiblePattern(currentFullPrefix)}\\s*`, 'i'),
      new RegExp(`^${whitespaceFlexiblePattern(legacyFullPrefix)}\\s*`, 'i'),
      new RegExp(`^${whitespaceFlexiblePattern(marker)}\\s*`, 'i'),
    ];
  });
}

function stripAttachmentPromptArtifacts(text) {
  return String(text || '')
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, '')
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gi, '')
    .replace(/\[Attached file references\][\s\S]*?\[\/Attached file references\]/gi, '')
    .replace(/\[Attached image(?:s)?\s*:[\s\S]*?\]/gi, '')
    .replace(/\[Attached file\s*:[\s\S]*?\]/gi, '')
    .trim();
}

// The once-per-worker media-embed guidance (shared/media-embed-instructions.mjs)
// can precede the mode marker on the Cursor/Grok prompt paths. This module is
// served to the browser and cannot import shared/, so the block is matched
// structurally — the heading plus its single paragraph — rather than verbatim.
const MEDIA_EMBED_BLOCK_PATTERN = /##\s*Embedding media in replies\s+[\s\S]*?(?=\n\s*\n|$)/gi;

// A steered message's hidden note (shared/steer-note.mjs) leads the prompt the
// runtime stored, right after any mode marker. Matched by its stable opening
// words, because the browser copy of this module cannot import shared/.
const STEER_NOTE_PATTERN = /^\s*\[Sent while you were still working on my previous message\.[^\]\n]*\]\s*/;

// The Claude worker's slash-command guard (shared/slash-command-guard.mjs): a
// zero-width space in front of a "/x" it delivers as text. trim() keeps it, so
// it is matched on its own, and only where it guards a "/".
const SLASH_COMMAND_GUARD_PATTERN = /^​(?=\s*\/)/;

function stripLeadingRelayNotes(text) {
  const stripped = String(text || '').replace(STEER_NOTE_PATTERN, '').replace(SLASH_COMMAND_GUARD_PATTERN, '');
  return stripped.trim() ? stripped.trim() : String(text || '').trim();
}

export function stripRelayPromptContext(text, relayMode = '') {
  const value = stripAttachmentPromptArtifacts(text)
    .replace(MEDIA_EMBED_BLOCK_PATTERN, '')
    .trim();
  if (!value) return '';
  const patterns = buildPromptPrefixPatterns(relayMode);
  for (const pattern of patterns) {
    const stripped = value.replace(pattern, '').trim();
    if (stripped && stripped !== value) return stripLeadingRelayNotes(stripped);
  }
  return stripLeadingRelayNotes(value);
}
