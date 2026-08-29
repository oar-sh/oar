import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PREVIEW_INSTRUCTION_HEADING } from '../shared/preview-instructions.mjs';
import { PREVIEW_TOOL_DESCRIPTION } from '../shared/preview-tool-core.mjs';

// relay-tools.md ships the preview guidance to Copilot CLI sessions whose relay
// cannot be asked about its lane, so its wording has to stay the wording the
// generated block uses — a drift here means two different features with one name.
const RELAY_TOOLS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'relay-tools.md',
);

function readPreviewSection() {
  const lines = fs.readFileSync(RELAY_TOOLS_PATH, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === PREVIEW_INSTRUCTION_HEADING);
  assert.notEqual(start, -1, `relay-tools.md has no "${PREVIEW_INSTRUCTION_HEADING}" section`);
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
  assert.ok(readPreviewSection().includes(PREVIEW_TOOL_DESCRIPTION));
});

test('the relay-tools.md preview section names the API the block teaches', () => {
  const section = readPreviewSection();
  for (const verb of ['POST /api/previews', 'GET /api/previews', 'DELETE /api/previews/:token']) {
    assert.ok(section.includes(verb), `preview section is missing ${verb}`);
  }
});
