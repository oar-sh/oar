import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCopilotPromptContextBuilder,
  loadDefaultRelayToolInstructions,
  withRelayContext,
} from './copilot-prompt-context.mjs';

const TOOLS = '# Relay Tool Guidance\n\nUse ask_user.\n\n## Preview servers\n\nstatic placeholder text\n\n## After\n\nkept';

/** Build and immediately commit, as a successful send does. */
async function buildCommitted(build, message) {
  const context = await build(message);
  context.commit();
  return context.prefix;
}

test('the preview block replaces the static section of the tool guidance', async () => {
  const build = createCopilotPromptContextBuilder({
    toolInstructions: TOOLS,
    getPreviewInstructions: () => '## Preview servers\n\nLIVE preview text',
  });

  const { prefix } = await build({ relayMode: 'agent' });

  assert.match(prefix, /LIVE preview text/);
  assert.doesNotMatch(prefix, /static placeholder text/);
  // Sections after the preview block survive the swap.
  assert.match(prefix, /## After/);
});

test('the preview block is asked for the message\'s conversation', async () => {
  const asked = [];
  const build = createCopilotPromptContextBuilder({
    toolInstructions: TOOLS,
    getPreviewInstructions: (options) => {
      asked.push(options);
      return `## Preview servers\n\nGET /api/previews?conversationId=${options?.conversationId}`;
    },
  });

  const { prefix } = await build({ relayMode: 'agent', conversationId: 'conv-7' });

  assert.deepEqual(asked, [{ conversationId: 'conv-7' }]);
  assert.match(prefix, /conversationId=conv-7/);
});

test('a disabled preview lane drops the section rather than advertising a 503', async () => {
  const build = createCopilotPromptContextBuilder({
    toolInstructions: TOOLS,
    getPreviewInstructions: () => '',
  });

  const { prefix } = await build({ relayMode: 'agent' });

  assert.doesNotMatch(prefix, /static placeholder text/);
  assert.doesNotMatch(prefix, /Preview servers/);
  assert.match(prefix, /Use ask_user/);
});

test('the heavy guidance rides along only when the relay mode changes', async () => {
  const build = createCopilotPromptContextBuilder({
    toolInstructions: TOOLS,
    getPreviewInstructions: () => '',
  });

  const first = await buildCommitted(build, { relayMode: 'agent' });
  assert.match(first, /Use ask_user/);
  assert.match(first, /Embedding media in replies/);

  // Same mode again: the marker stays, the instructions do not repeat.
  const second = await buildCommitted(build, { relayMode: 'agent' });
  assert.equal(second, '[Relay mode: agent]');

  // A mode change re-sends them, because the standing instructions changed.
  const third = await buildCommitted(build, { relayMode: 'plan' });
  assert.match(third, /^\[Relay mode: plan\]/);
  assert.match(third, /Draft a concise plan only/);
  assert.match(third, /Use ask_user/);
});

test('an uncommitted build does not count as prompted (failed-send retry)', async () => {
  // Audit #32: the mode used to be recorded as prompted while BUILDING the
  // prefix, so a send that failed left the builder believing the runtime had
  // read guidance it never received — and the same-mode retry omitted it.
  const build = createCopilotPromptContextBuilder({ toolInstructions: TOOLS, getPreviewInstructions: () => '' });

  const first = await build({ relayMode: 'agent' });
  assert.match(first.prefix, /Use ask_user/);
  // The send failed: commit never runs. The retry must carry the guidance again.
  const retry = await build({ relayMode: 'agent' });
  assert.match(retry.prefix, /Use ask_user/);

  // Once a send lands, repeats go back to the cheap marker.
  retry.commit();
  const { prefix } = await build({ relayMode: 'agent' });
  assert.equal(prefix, '[Relay mode: agent]');
});

test('the mode marker is always present, and media embedding is taught even with no tools doc', async () => {
  const build = createCopilotPromptContextBuilder({ toolInstructions: '', getPreviewInstructions: null });
  const first = await buildCommitted(build, { relayMode: 'autopilot' });
  assert.match(first, /^\[Relay mode: autopilot\] Act directly on the request and use tools when needed\./);
  assert.match(first, /Embedding media in replies/);
  assert.equal(await buildCommitted(build, { relayMode: 'autopilot' }), '[Relay mode: autopilot]');
});

test('an unknown relay mode falls back to agent rather than inventing one', async () => {
  const build = createCopilotPromptContextBuilder({ toolInstructions: '' });
  const { prefix } = await build({ relayMode: 'nonsense' });
  assert.match(prefix, /^\[Relay mode: agent\]/);
});

test('a preview lookup that throws costs the block, never the turn', async () => {
  const build = createCopilotPromptContextBuilder({
    toolInstructions: TOOLS,
    getPreviewInstructions: () => { throw new Error('relay unreachable'); },
  });

  const { prefix } = await build({ relayMode: 'agent' });
  assert.match(prefix, /Use ask_user/);
  assert.doesNotMatch(prefix, /Preview servers/);
});

test('the prefix is joined to the body without swallowing either', () => {
  assert.equal(withRelayContext('[Relay mode: agent]', 'do the thing'), '[Relay mode: agent] do the thing');
  assert.equal(withRelayContext('', 'do the thing'), 'do the thing');
  assert.equal(withRelayContext('[Relay mode: agent]', ''), '[Relay mode: agent]');
});

test('the real relay-tools doc is found on disk, and an override is honoured', () => {
  // The extension's own path resolver is anchored to its directory depth and
  // resolves to the wrong place from server/copilot-worker/, so this is the
  // regression guard for that.
  const loaded = loadDefaultRelayToolInstructions({ env: {} });
  assert.match(loaded, /Relay Tool Guidance/);
  assert.match(loaded, /## Preview servers/);

  assert.equal(loadDefaultRelayToolInstructions({ env: { COPILOT_WEB_RELAY_TOOLS: '/nonexistent/x.md' } }), '');
});
