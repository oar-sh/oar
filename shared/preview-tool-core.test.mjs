import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PREVIEW_TOOL_DESCRIPTION,
  PREVIEW_TOOL_INPUT_SCHEMA,
  PREVIEW_TOOL_NAME,
  executePreviewTool,
  renderPreviewInstructionBlock,
  validatePreviewToolInput,
} from './preview-tool-core.mjs';

const TOKEN = 'a'.repeat(32);

function fakeApi(routes) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path.split('?')[0]}`;
    const handler = routes[key];
    if (!handler) throw new Error(`Unexpected API call: ${key}`);
    return typeof handler === 'function' ? handler({ method, path, body }) : handler;
  };
  return { api, calls };
}

// ─── validation ───────────────────────────────────────────────────────────────

test('validate: action is required and gated', () => {
  assert.equal(validatePreviewToolInput({}).ok, false);
  assert.equal(validatePreviewToolInput({ action: 'destroy' }).ok, false);
  assert.equal(validatePreviewToolInput({ action: 'list' }).ok, true);
});

test('validate: create needs exactly one of port/dir', () => {
  assert.match(validatePreviewToolInput({ action: 'create' }).error, /port .* or a dir/);
  assert.match(
    validatePreviewToolInput({ action: 'create', port: 5173, dir: './dist' }).error,
    /not both/,
  );
  assert.deepEqual(
    validatePreviewToolInput({ action: 'create', port: 5173, label: 'app' }),
    { ok: true, action: 'create', port: 5173, label: 'app' },
  );
  assert.deepEqual(
    validatePreviewToolInput({ action: 'create', dir: './dist' }),
    { ok: true, action: 'create', dir: './dist', label: '' },
  );
});

test('validate: port bounds mirror the API', () => {
  for (const port of [80, 0, 70000, 'abc', 1.5]) {
    assert.equal(validatePreviewToolInput({ action: 'create', port }).ok, false, `port ${port}`);
  }
});

test('validate: close token must be 32-hex when present', () => {
  assert.equal(validatePreviewToolInput({ action: 'close' }).ok, true);
  assert.equal(validatePreviewToolInput({ action: 'close', token: TOKEN }).ok, true);
  assert.equal(validatePreviewToolInput({ action: 'close', token: 'short' }).ok, false);
});

// ─── execute ──────────────────────────────────────────────────────────────────

test('execute create(port) posts and returns url + base-path hint', async () => {
  const { api, calls } = fakeApi({
    'POST /api/previews': {
      url: `https://p.example.com/test_${TOKEN}/`,
      basePath: `/test_${TOKEN}/`,
      preview: { token: TOKEN, mode: 'port' },
    },
  });
  const result = await executePreviewTool(
    { action: 'create', port: 5173, label: 'web app' },
    { api, conversationId: 'conv-1' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.url, `https://p.example.com/test_${TOKEN}/`);
  assert.equal(result.token, TOKEN);
  assert.match(result.hint, /Serve the app under/);
  assert.match(result.hint, /public/);
  assert.deepEqual(calls[0].body, { conversationId: 'conv-1', label: 'web app', port: 5173 });
});

test('execute create(dir) posts dir and returns the static hint', async () => {
  const { api, calls } = fakeApi({
    'POST /api/previews': {
      url: `https://p.example.com/test_${TOKEN}/`,
      basePath: `/test_${TOKEN}/`,
      preview: { token: TOKEN, mode: 'static' },
    },
  });
  const result = await executePreviewTool(
    { action: 'create', dir: './dist' },
    { api, conversationId: 'conv-1' },
  );
  assert.equal(result.mode, 'static');
  assert.match(result.hint, /served as-is/);
  assert.deepEqual(calls[0].body, { conversationId: 'conv-1', label: undefined, dir: './dist' });
});

test('execute list maps previews to a compact model-facing shape', async () => {
  const { api } = fakeApi({
    'GET /api/previews': {
      enabled: true,
      previews: [
        { token: TOKEN, label: 'app', url: 'https://p/x/', mode: 'port', targetPort: 5173, online: true, conversationId: 'conv-1' },
        { token: 'b'.repeat(32), label: 'site', url: 'https://p/y/', mode: 'static', rootDir: '/repo/dist', online: true, conversationId: null },
      ],
    },
  });
  const result = await executePreviewTool({ action: 'list' }, { api });
  assert.equal(result.ok, true);
  assert.deepEqual(result.previews.map((entry) => entry.target), ['localhost:5173', '/repo/dist']);
});

test('execute close with no token resolves the single live preview', async () => {
  const { api, calls } = fakeApi({
    'GET /api/previews': { previews: [{ token: TOKEN, label: 'app' }] },
    'DELETE /api/previews/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': { ok: true, preview: { label: 'app' } },
  });
  const result = await executePreviewTool({ action: 'close' }, { api, conversationId: 'conv-1' });
  assert.deepEqual(result, { ok: true, closed: { token: TOKEN, label: 'app' } });
  assert.match(calls[0].path, /conversationId=conv-1/);
});

test('execute close is explicit when zero or many previews are live', async () => {
  const none = fakeApi({ 'GET /api/previews': { previews: [] } });
  assert.match(
    (await executePreviewTool({ action: 'close' }, { api: none.api, conversationId: 'c' })).error,
    /No live previews/,
  );

  const many = fakeApi({
    'GET /api/previews': {
      previews: [{ token: TOKEN, label: 'a' }, { token: 'b'.repeat(32), label: 'b' }],
    },
  });
  const result = await executePreviewTool({ action: 'close' }, { api: many.api, conversationId: 'c' });
  assert.equal(result.ok, false);
  assert.match(result.error, /pass the token/);
  assert.equal(result.previews.length, 2);
});

test('execute reports API failures as answers, not throws', async () => {
  const { api } = fakeApi({
    'POST /api/previews': () => { throw new Error('Preview lane is disabled'); },
  });
  const result = await executePreviewTool({ action: 'create', port: 5173 }, { api });
  assert.deepEqual(result, { ok: false, error: 'Preview lane is disabled' });

  const missing = await executePreviewTool({ action: 'list' }, {});
  assert.equal(missing.ok, false);
});

// ─── instruction block ────────────────────────────────────────────────────────

test('the instruction block is generated from the tool description', () => {
  const block = renderPreviewInstructionBlock({ publicBaseUrl: 'https://p.example.com' });
  // The description IS the block's opening — one source of truth by construction.
  assert.equal(block.includes(PREVIEW_TOOL_DESCRIPTION), true);
  assert.match(block, /POST \/api\/previews/);
  assert.match(block, /GET \/api\/previews/);
  assert.match(block, /DELETE \/api\/previews\/:token/);
  assert.match(block, /https:\/\/p\.example\.com\/test_<token>\//);
  assert.match(block, /workspace root/);
});

test('schema and name stay in the shape adapters rely on', () => {
  assert.equal(PREVIEW_TOOL_NAME, 'preview');
  assert.deepEqual(PREVIEW_TOOL_INPUT_SCHEMA.required, ['action']);
  assert.deepEqual(
    Object.keys(PREVIEW_TOOL_INPUT_SCHEMA.properties).sort(),
    ['action', 'dir', 'label', 'port', 'token'],
  );
});
