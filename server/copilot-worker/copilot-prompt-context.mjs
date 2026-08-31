// Relay prompt context for the SDK worker: the mode marker, the mode's
// standing instructions, the relay tool guidance, and the live preview-lane
// block.
//
// This mirrors the extension's `createRelayPromptBuilder`
// (`.github/extensions/web-relay/skills/prompt-context.mjs`) and reuses its
// text verbatim through `buildModePrompt`, so a conversation reads the same
// guidance whichever engine ran it. It does NOT reuse the extension's builder
// wholesale for one reason: that builder also composes the message BODY via its
// own `buildPrompt`, which renders attachments as a text note. This worker
// passes real `MessageOptions.attachments` to the runtime
// (`buildCopilotMessageOptions`), so only the PREFIX is wanted here.
//
// Why the relay tool doc applies to this worker at all: `server/relay-tools.md`
// tells the model to ask through `ask_user` rather than in plain prose, and to
// restart the relay through the authenticated localhost API. Both are now true
// on the SDK path — `onUserInputRequest` is bridged to the relay question
// cards. The preview section is the part that must be live rather than static,
// which is exactly what `applyPreviewInstructions` swaps in.
import path from 'path';
import { fileURLToPath } from 'url';

import {
  applyPreviewInstructions,
  createPreviewInstructionsProvider,
} from '../../shared/preview-instructions.mjs';
import { buildModePrompt } from '../../.github/extensions/web-relay/skills/prompt-context.mjs';
import { loadRelayInstructionsFromFile } from '../../.github/extensions/web-relay/runtime/config-loader.mjs';

export { createPreviewInstructionsProvider, loadRelayInstructionsFromFile };

/**
 * Read `server/relay-tools.md`, honouring the same `COPILOT_WEB_RELAY_TOOLS`
 * override the extension uses.
 *
 * The path is resolved relative to THIS module rather than through the
 * extension's `resolveRelayPaths`, whose `../../../server` walk is anchored to
 * the extension's own directory depth and resolves to the wrong place from
 * `server/copilot-worker/`. A missing file yields '' (the loader swallows the
 * error), which degrades to "no tool guidance", never to a failed turn.
 */
export function loadDefaultRelayToolInstructions({ env = process.env } = {}) {
  const override = String(env.COPILOT_WEB_RELAY_TOOLS || '').trim();
  const toolsPath = override
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay-tools.md');
  return loadRelayInstructionsFromFile(toolsPath);
}

/**
 * Build the per-turn relay context prefix.
 *
 * The heavy guidance rides along only when the relay mode CHANGED, matching the
 * extension: repeat turns in one mode stay cheap, and the model is not re-read
 * its standing instructions every message. The mode marker itself is always
 * present.
 *
 * `agentMode` is threaded to the runtime natively as well
 * (`copilotAgentModeForRelayMode`); the text is not a substitute for it but a
 * reinforcement, same as on the extension path.
 */
export function createCopilotPromptContextBuilder({
  toolInstructions = '',
  getPreviewInstructions = null,
} = {}) {
  let lastPromptedRelayMode = null;
  return async function buildRelayContextPrefix(message) {
    const relayMode = String(message?.relayMode || 'agent').trim().toLowerCase() || 'agent';
    const includeInstructions = lastPromptedRelayMode !== relayMode;
    let instructions = '';
    if (includeInstructions) {
      // Advisory: a preview lookup that fails costs the block, never the turn.
      const previewBlock = typeof getPreviewInstructions === 'function'
        ? await Promise.resolve().then(getPreviewInstructions).catch(() => '')
        : '';
      instructions = applyPreviewInstructions(toolInstructions, previewBlock);
    }
    const prefix = buildModePrompt(relayMode, instructions, { includeInstructions });
    lastPromptedRelayMode = relayMode;
    return prefix;
  };
}

/** Prepend the relay context prefix to a message body built elsewhere. */
export function withRelayContext(prefix, body) {
  return [String(prefix || '').trim(), String(body || '').trim()].filter(Boolean).join(' ');
}
