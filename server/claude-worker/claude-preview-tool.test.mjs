import test from 'node:test';
import assert from 'node:assert/strict';

import { PREVIEW_TOOL_ZOD_SHAPE, createPreviewToolDefinition } from './claude-preview-tool.mjs';
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

test('the definition carries the shared name/description and a zod shape', () => {
  const definition = createPreviewToolDefinition({ api: recordingApi().api });
  assert.equal(definition.name, 'preview');
  assert.equal(definition.description, PREVIEW_TOOL_DESCRIPTION);
  assert.equal(definition.inputSchema, PREVIEW_TOOL_ZOD_SHAPE);
  assert.equal(typeof definition.handler, 'function');

  assert.deepEqual(
    Object.keys(PREVIEW_TOOL_ZOD_SHAPE),
    Object.keys(PREVIEW_TOOL_INPUT_SCHEMA.properties),
    'the zod mirror must cover exactly the shared schema fields',
  );
  for (const [field, schema] of Object.entries(PREVIEW_TOOL_ZOD_SHAPE)) {
    assert.equal(
      schema.description,
      PREVIEW_TOOL_INPUT_SCHEMA.properties[field].description,
      `${field} description must come from the shared schema`,
    );
    assert.equal(
      schema.safeParse(undefined).success,
      field !== 'action',
      `${field} optionality must match the shared schema`,
    );
  }
  assert.equal(PREVIEW_TOOL_ZOD_SHAPE.action.safeParse('create').success, true);
  assert.equal(PREVIEW_TOOL_ZOD_SHAPE.action.safeParse('destroy').success, false);
});

test('the handler round-trips a create and returns an MCP text result', async () => {
  const stub = recordingApi({
    url: 'https://preview.example/test_abc/',
    basePath: '/test_abc/',
    preview: { token: 'c'.repeat(32), mode: 'port' },
  });
  const definition = createPreviewToolDefinition({ api: stub.api, getConversationId: () => 'conv-1' });

  const result = await definition.handler({ action: 'create', port: 5173, label: 'web app' }, {});

  assert.deepEqual(stub.calls, [{
    method: 'POST',
    routePath: '/api/previews',
    body: { conversationId: 'conv-1', label: 'web app', port: 5173 },
  }]);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.url, 'https://preview.example/test_abc/');
  assert.equal(payload.basePath, '/test_abc/');
  assert.match(payload.hint, /link is public/);
});

test('the conversation id is resolved per call', async () => {
  const stub = recordingApi({ previews: [] });
  let conversationId = 'conv-1';
  const definition = createPreviewToolDefinition({ api: stub.api, getConversationId: () => conversationId });

  await definition.handler({ action: 'close' }, {});
  conversationId = 'conv-2';
  await definition.handler({ action: 'close' }, {});

  assert.match(stub.calls[0].routePath, /conversationId=conv-1$/);
  assert.match(stub.calls[1].routePath, /conversationId=conv-2$/);
});

test('a disabled lane and a bad input both come back as quotable JSON, never a throw', async () => {
  const disabled = createPreviewToolDefinition({
    api: async () => { throw new Error('Preview lane is disabled'); },
  });
  assert.deepEqual(
    JSON.parse((await disabled.handler({ action: 'list' }, {})).content[0].text),
    { ok: false, error: 'Preview lane is disabled' },
  );

  const refused = createPreviewToolDefinition({ api: recordingApi().api });
  const payload = JSON.parse((await refused.handler({ action: 'create' }, {})).content[0].text);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /port .* or a dir/);
});

test('a throwing conversation-id resolver fails the call as a result, not an exception', async () => {
  const definition = createPreviewToolDefinition({
    api: recordingApi().api,
    getConversationId: () => { throw new Error('no active turn'); },
  });
  const payload = JSON.parse((await definition.handler({ action: 'list' }, {})).content[0].text);
  assert.deepEqual(payload, { ok: false, error: 'no active turn' });
});
