// What the transcript shows while no conversation is open. No DOM here;
// conversation-view.js draws the result into the `.empty-state` node.
//
// Three variants: `setup` when the relay has no provider known to be ready
// (the fresh-install case: point to Settings → Providers, do not pretend
// Copilot is set up), `first-chat` when a provider is ready and there are no
// conversations yet, and `pick` when conversations exist but none is open.
// A readiness answer that is unknown counts as ready, as everywhere else.

import { isSetupRequired } from './provider-readiness.mjs';

export const SETUP_HEADING = 'Set up a provider';
export const SETUP_TEXT = 'Turn on Claude, Cursor, OpenAI, Grok or DeepSeek in Settings → Providers, or sign in to the Copilot CLI on the relay host.';

const ACTIONS = Object.freeze({
  openSettings: (primary) => ({ id: 'empty-state-open-settings', action: 'open-settings', label: primary ? 'Open Settings' : 'Settings', primary, link: !primary }),
  newChat: (primary) => ({ id: 'empty-state-new-chat', action: 'new-chat', label: '+ New chat', primary, link: false }),
  showConversations: () => ({ id: 'empty-state-show-conversations', action: 'show-conversations', label: 'Show conversations', primary: false, link: false }),
});

/**
 * @param {object} input
 * @param {object|null} [input.readiness] resolveProviderReadiness()'s answer
 * @param {number} [input.conversationCount] live conversations the client knows
 * @param {boolean} [input.mobile] the sidebar is an off-canvas drawer
 * @returns {{ variant: 'setup' | 'first-chat' | 'pick', icon: string, heading: string, text: string, actions: Array<{ id: string, action: string, label: string, primary: boolean, link: boolean }> }}
 */
export function resolveNoConversationState({ readiness = null, conversationCount = 0, mobile = false } = {}) {
  if (isSetupRequired(readiness)) {
    return {
      variant: 'setup',
      icon: '⚙️',
      heading: SETUP_HEADING,
      text: SETUP_TEXT,
      actions: [ACTIONS.openSettings(true), ACTIONS.newChat(false)],
    };
  }
  const count = Math.max(0, Number(conversationCount) || 0);
  if (count === 0) {
    return {
      variant: 'first-chat',
      icon: '🚀',
      heading: 'Start your first chat',
      text: 'Pick a model and a folder, and go.',
      actions: [ACTIONS.newChat(true), ACTIONS.openSettings(false)],
    };
  }
  const actions = [ACTIONS.newChat(true)];
  if (mobile) actions.push(ACTIONS.showConversations());
  actions.push(ACTIONS.openSettings(false));
  return {
    variant: 'pick',
    icon: '💬',
    heading: 'No conversation open',
    text: 'Pick one from the list or start a new one.',
    actions,
  };
}
