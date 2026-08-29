import test from 'node:test';
import assert from 'node:assert/strict';

import { createPreviewTool } from './cursor-preview-tool.mjs';
import { PREVIEW_TOOL_DESCRIPTION, PREVIEW_TOOL_INPUT_SCHEMA } from '../../shared/preview-tool-core.mjs';

function recordingApi(reply = {}) {
  const calls = [];
  return {
    calls,
    api: async (method, routePath, body) => {
      calls.push({ method, routePath, body });
      return reply;
    },
  };
}

test('tool registers under the shared name, description and schema', () => {
  const tool = createPreviewTool({ api: recordingApi().api });
  assert.equal(tool.name, 'preview');
  assert.equal(tool.description, PREVIEW_TOOL_DESCRIPTION);
  assert.equal(tool.inputSchema, PREVIEW_TOOL_INPUT_SCHEMA);
  assert.equal(typeof tool.execute, 'function');
});

test('execute round-trips a create through the relay API with the live conversation id', async () => {
  const stub = recordingApi({
    url: 'https://preview.example/test_abc/',
    basePath: '/test_abc/',
    preview: { token: 'b'.repeat(32), mode: 'port' },
  });
  let conversationId = 'conv-1';
  const tool = createPreviewTool({ api: stub.api, getConversationId: () => conversationId });

  await tool.execute({ action: 'create', port: 5173, label: 'web app' });
  conversationId = 'conv-2';
  const result = await tool.execute({ action: 'create', port: 4000 });

  assert.deepEqual(stub.calls[0], {
    method: 'POST',
    routePath: '/api/previews',
    body: { conversationId: 'conv-1', label: 'web app', port: 5173 },
  });
  assert.equal(stub.calls[1].body.conversationId, 'conv-2', 'the id is read per call, not captured');
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.url, 'https://preview.example/test_abc/');
  assert.equal(result.structuredContent.basePath, '/test_abc/');
  assert.match(result.structuredContent.hint, /link is public/);
  assert.deepEqual(result.content, [{
    type: 'text',
    text: JSON.stringify(result.structuredContent),
  }]);
});

test('execute reports a refused call as an answer, not a failure', async () => {
  const stub = recordingApi();
  const tool = createPreviewTool({ api: stub.api, getConversationId: () => 'conv-1' });
  const result = await tool.execute({ action: 'create' });
  assert.equal(stub.calls.length, 0, 'invalid input never reaches the relay');
  assert.equal(result.structuredContent.ok, false);
  assert.match(result.structuredContent.error, /port .* or a dir/);
});

test('a disabled preview lane comes back as a quotable error', async () => {
  const tool = createPreviewTool({
    api: async () => { throw new Error('Preview lane is disabled'); },
    getConversationId: () => 'conv-1',
  });
  const result = await tool.execute({ action: 'list' });
  assert.deepEqual(result.structuredContent, { ok: false, error: 'Preview lane is disabled' });
});

test('a throwing conversation-id resolver returns text instead of killing the run', async () => {
  const tool = createPreviewTool({
    api: recordingApi().api,
    getConversationId: () => { throw new Error('no active turn'); },
  });
  const result = await tool.execute({ action: 'list' });
  assert.equal(result.structuredContent, undefined);
  assert.match(result.content[0].text, /^preview failed: no active turn\./);
});
