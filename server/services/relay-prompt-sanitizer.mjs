'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { renderMathInstructionBlock } from '../../shared/math-instructions.mjs';
import { renderMediaEmbedInstructionBlock } from '../../shared/media-embed-instructions.mjs';
import {
  compileWordSequence,
  matchLeadingWordSequence,
  removeWordSequences,
} from '../public/app/whitespace-flexible-match.mjs';

const DEFAULT_RELAY_TOOL_GUIDANCE = [
  '# Relay Tool Guidance',
  'For any user-facing question or clarification, use the ask_user tool so the web relay can render question cards and buttons. Never ask questions in plain assistant text.',
  'When using ask_user, ALWAYS include a `choices` array with 2-6 answer options so the web relay can render clickable buttons. Only omit choices when the question genuinely requires freeform text input.',
  'In autopilot, still call ask_user when user input is truly blocking, because the relay bridge can surface the question even when the direct SDK question hook is bypassed.',
  'For relay restarts in extension-managed mode, require explicit user permission first, then use the authenticated localhost API `POST /api/relay/shutdown`. Do not restart by killing processes or using respawn scripts.',
  'Note: shutdown is queued and only completes when the current turn finishes, so it is pointless to wait for it to interrupt an active turn.',
  'Use `restart: true` in the request body when the user wants a real relay restart rather than a plain shutdown. Example request body: `{ "reason": "manual-restart", "requestedBy": "localhost-api", "restart": true }`.',
  'Never pass `immediate` in that request body: it restarts without waiting for the running turns, which only the user may decide, with Restart now in the web UI.',
].join(' ');

function loadRelayToolGuidance() {
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const guidancePath = path.resolve(moduleDir, '..', 'relay-tools.md');
    const content = fs.readFileSync(guidancePath, 'utf8');
    const parts = String(content || '')
      .split(/\r?\n/)
      .map((line) => String(line || '').trim())
      .filter(Boolean);
    return parts.length ? parts.join(' ') : DEFAULT_RELAY_TOOL_GUIDANCE;
  } catch {
    return DEFAULT_RELAY_TOOL_GUIDANCE;
  }
}

const RELAY_TOOL_GUIDANCE = loadRelayToolGuidance();
// Prompts stored before the `immediate` line was added carry the guidance
// without it.
const IMMEDIATE_GUIDANCE_LINE = 'Never pass `immediate` in that request body: it restarts without waiting for the running turns, which only the user may decide, with Restart now in the web UI.';
const PREVIOUS_RELAY_TOOL_GUIDANCE = RELAY_TOOL_GUIDANCE.replace(` ${IMMEDIATE_GUIDANCE_LINE}`, '');

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

// The prefixes are matched word by word (any whitespace between words, any
// case), never through a RegExp built from them: the guidance runs to
// thousands of words, and compiling such a regex overflows the stack.
// They depend only on the mode, so they are built once per mode and reused:
// a long conversation sanitises every message on each history load.
const PROMPT_PREFIX_CACHE = new Map();

function promptPrefixCacheKey(mode) {
  const requestedMode = String(mode || '').trim().toLowerCase();
  return requestedMode && MODE_MARKERS[requestedMode] ? requestedMode : '';
}

// The prefixes tried for a mode, in order: the full one with the current and
// the legacy mode instructions, each with the current and then the previous
// guidance, then the bare marker. No mode tries every mode's.
function promptPrefixTexts(cacheKey) {
  const modes = cacheKey ? [cacheKey] : Object.keys(MODE_MARKERS);
  return modes.flatMap((key) => {
    const marker = MODE_MARKERS[key];
    return [
      `${marker} ${MODE_INSTRUCTIONS[key]} ${RELAY_TOOL_GUIDANCE}`,
      `${marker} ${LEGACY_MODE_INSTRUCTIONS[key]} ${RELAY_TOOL_GUIDANCE}`,
      `${marker} ${MODE_INSTRUCTIONS[key]} ${PREVIOUS_RELAY_TOOL_GUIDANCE}`,
      `${marker} ${LEGACY_MODE_INSTRUCTIONS[key]} ${PREVIOUS_RELAY_TOOL_GUIDANCE}`,
      marker,
    ];
  });
}

function buildPromptPrefixes(mode) {
  const cacheKey = promptPrefixCacheKey(mode);
  const cached = PROMPT_PREFIX_CACHE.get(cacheKey);
  if (cached) return cached;
  const prefixes = promptPrefixTexts(cacheKey).map((text) => compileWordSequence(text));
  PROMPT_PREFIX_CACHE.set(cacheKey, prefixes);
  return prefixes;
}

/** The prefix texts stripRelayPromptContext tries for `mode`, in order. */
export function relayPromptPrefixTextsForTests(mode = '') {
  return promptPrefixTexts(promptPrefixCacheKey(mode));
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

// The once-per-worker media-embed guidance rides ahead of the mode marker on
// the Cursor/Grok prompt paths, so it is dropped before the prefixes are
// matched. Machine-injected verbatim, never user-authored. Matched word by
// word like the prefixes, every occurrence.
const MEDIA_EMBED_BLOCK_WORDS = compileWordSequence(renderMediaEmbedInstructionBlock());
// The formula guidance (shared/math-instructions.mjs) rides right behind it.
const MATH_BLOCK_WORDS = compileWordSequence(renderMathInstructionBlock());

// A steered message's hidden note (shared/steer-note.mjs) leads the prompt the
// runtime stored, right after any mode marker. Matched by its stable opening
// words, because the browser copy of this module cannot import shared/.
const STEER_NOTE_PATTERN = /^\s*\[Sent while you were still working on my previous message\.[^\]\n]*\]\s*/;

// The Claude worker's slash-command guard (shared/slash-command-guard.mjs): a
// zero-width space in front of a "/x" it delivers as text. trim() keeps it, so
// it is matched on its own, and only where it guards a "/".
const SLASH_COMMAND_GUARD_PATTERN = /^\u200B(?=\s*\/)/;

function stripLeadingRelayNotes(text) {
  const stripped = String(text || '').replace(STEER_NOTE_PATTERN, '').replace(SLASH_COMMAND_GUARD_PATTERN, '');
  return stripped.trim() ? stripped.trim() : String(text || '').trim();
}

export function stripRelayPromptContext(text, relayMode = '', attachments = []) {
  const value = removeWordSequences(
    removeWordSequences(stripAttachmentPromptArtifacts(text), MEDIA_EMBED_BLOCK_WORDS),
    MATH_BLOCK_WORDS,
  ).trim();
  if (!value) return '';
  for (const prefix of buildPromptPrefixes(relayMode)) {
    const end = matchLeadingWordSequence(value, prefix);
    if (end < 0) continue;
    const stripped = value.slice(end).trim();
    if (stripped && stripped !== value) return stripLeadingRelayNotes(stripped);
  }
  return stripLeadingRelayNotes(value);
}
