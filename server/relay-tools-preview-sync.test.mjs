import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PREVIEW_INSTRUCTION_HEADING, applyPreviewInstructions } from '../shared/preview-instructions.mjs';
import { PREVIEW_TOOL_DESCRIPTION, PREVIEW_TOOL_NAME, renderPreviewInstructionBlock } from '../shared/preview-tool-core.mjs';
import { REMOTE_RELAY_ACTIONS, REMOTE_RELAY_TOOL_NAME } from '../shared/remote-relay-contract.mjs';

// relay-tools.md is the tool guidance the Copilot engines read (the extension
// through its prompt builder, the SDK engine through copilot-prompt-context).
// Both swap its preview section for the live block at runtime, but the file's
// wording has to stay the wording the generated block uses — a drift here
// means two different features with one name. Since the extension engine got
// the real `preview` tool (through the OAR MCP server) and the SDK engine did
// not, the section teaches the API as the fallback for a session without it.
const RELAY_TOOLS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'relay-tools.md',
);
const REMOTE_RELAYS_HEADING = '## Remote relays';

function readRelayTools() {
  return fs.readFileSync(RELAY_TOOLS_PATH, 'utf8');
}

function readSection(heading) {
  const lines = readRelayTools().split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(start, -1, `relay-tools.md has no "${heading}" section`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

test('the relay-tools.md preview section quotes the tool description verbatim', () => {
  assert.ok(readSection(PREVIEW_INSTRUCTION_HEADING).includes(PREVIEW_TOOL_DESCRIPTION));
});

test('the relay-tools.md preview section names the API the block teaches', () => {
  const section = readSection(PREVIEW_INSTRUCTION_HEADING);
  for (const verb of ['POST /api/previews', 'GET /api/previews', 'DELETE /api/previews/:token']) {
    assert.ok(section.includes(verb), `preview section is missing ${verb}`);
  }
});

test('the preview section defers to a real preview tool when the session has one', () => {
  const section = readSection(PREVIEW_INSTRUCTION_HEADING);
  assert.ok(section.includes(`If you have a \`${PREVIEW_TOOL_NAME}\` tool, use it.`));
  assert.doesNotMatch(section, /There is no `preview` tool/, 'the extension engine has one now');
});

test('the remote relays section describes the tool and the mention rule', () => {
  const section = readSection(REMOTE_RELAYS_HEADING);
  assert.ok(section.includes(`\`${REMOTE_RELAY_TOOL_NAME}\``));
  // Every action the section names is a contract action.
  const named = [...section.matchAll(/"action":"([a-z_]+)"|`([a-z_]+)`/g)]
    .map((match) => match[1] || match[2])
    .filter((name) => name !== REMOTE_RELAY_TOOL_NAME && name !== 'pendingQuestions' && name !== 'preview');
  assert.ok(named.includes('list_relays'));
  assert.ok(named.includes('answer_question'));
  for (const name of named) assert.ok(REMOTE_RELAY_ACTIONS.includes(name), `${name} is not a contract action`);
  assert.match(section, /locked until the user mentions it/);
  assert.match(section, /@name/);
});

test('the runtime preview swap leaves the remote relays section alone', () => {
  // Both engines replace the preview section with the live block (or drop it
  // when the lane is off); the section after it must survive either way.
  const live = applyPreviewInstructions(readRelayTools(), renderPreviewInstructionBlock({ publicBaseUrl: 'https://previews.example.test' }));
  assert.ok(live.includes(REMOTE_RELAYS_HEADING));
  assert.ok(live.includes('https://previews.example.test'));
  const laneOff = applyPreviewInstructions(readRelayTools(), '');
  assert.ok(laneOff.includes(REMOTE_RELAYS_HEADING));
  assert.equal(laneOff.includes(PREVIEW_INSTRUCTION_HEADING), false);
});
