import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PREVIEW_INSTRUCTION_HEADING,
  applyPreviewInstructions,
  createPreviewInstructionsProvider,
} from './preview-instructions.mjs';
import { PREVIEW_TOOL_DESCRIPTION } from './preview-tool-core.mjs';

function createFakeApi(response) {
  const calls = [];
  const api = async (method, routePath) => {
    calls.push(`${method} ${routePath}`);
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(calls.length) : response;
  };
  api.calls = calls;
  return api;
}

test('an enabled lane yields the generated block with the relay public base URL', async () => {
  const api = createFakeApi({ enabled: true, publicBaseUrl: 'https://previews.example.test', previews: [] });
  const block = await createPreviewInstructionsProvider({ api })();
  assert.ok(block.includes(PREVIEW_TOOL_DESCRIPTION));
  assert.ok(block.includes('https://previews.example.test'));
  assert.ok(block.startsWith(PREVIEW_INSTRUCTION_HEADING));
});

test('a disabled lane yields no block', async () => {
  const api = createFakeApi({ enabled: false, publicBaseUrl: '', previews: [] });
  assert.equal(await createPreviewInstructionsProvider({ api })(), '');
});

test('the lookup is cached across turns', async () => {
  const api = createFakeApi({ enabled: true, publicBaseUrl: 'https://previews.example.test', previews: [] });
  const provider = createPreviewInstructionsProvider({ api });
  const first = await provider();
  const second = await provider();
  assert.equal(first, second);
  assert.deepEqual(api.calls, ['GET /api/previews']);
});

test('a disabled answer is cached too', async () => {
  const api = createFakeApi({ enabled: false });
  const provider = createPreviewInstructionsProvider({ api });
  await provider();
  await provider();
  assert.equal(api.calls.length, 1);
});

test('concurrent callers share one lookup', async () => {
  const api = createFakeApi({ enabled: true, publicBaseUrl: 'https://previews.example.test' });
  const provider = createPreviewInstructionsProvider({ api });
  const [a, b] = await Promise.all([provider(), provider()]);
  assert.equal(a, b);
  assert.equal(api.calls.length, 1);
});

test('a failed lookup yields no block and is retried on the next turn', async () => {
  const api = createFakeApi((call) => {
    if (call === 1) throw new Error('HTTP 502 /api/previews');
    return { enabled: true, publicBaseUrl: 'https://previews.example.test' };
  });
  const provider = createPreviewInstructionsProvider({ api });
  assert.equal(await provider(), '');
  assert.ok((await provider()).includes(PREVIEW_TOOL_DESCRIPTION));
  assert.equal(api.calls.length, 2);
});

test('the cache expires after the TTL', async () => {
  const api = createFakeApi({ enabled: true, publicBaseUrl: 'https://previews.example.test' });
  let clock = 1000;
  const provider = createPreviewInstructionsProvider({ api, ttlMs: 500, now: () => clock });
  await provider();
  clock += 200;
  await provider();
  assert.equal(api.calls.length, 1);
  clock += 500;
  await provider();
  assert.equal(api.calls.length, 2);
});

test('no api helper means no block', async () => {
  assert.equal(await createPreviewInstructionsProvider({})(), '');
});

const GUIDANCE = [
  '# Relay Tool Guidance',
  '',
  'Ask questions through the relay.',
  '',
  '## Preview servers',
  '',
  'Hand-written body that the generated block owns.',
  '',
  '## Something else',
  '',
  'Untouched trailing guidance.',
].join('\n');

test('applyPreviewInstructions replaces the preview section and keeps its neighbours', () => {
  const merged = applyPreviewInstructions(GUIDANCE, '## Preview servers\n\nGenerated body.');
  assert.ok(merged.includes('Ask questions through the relay.'));
  assert.ok(merged.includes('Generated body.'));
  assert.ok(!merged.includes('Hand-written body'));
  assert.ok(merged.includes('## Something else'));
  assert.ok(merged.includes('Untouched trailing guidance.'));
  assert.equal(merged.split('## Preview servers').length, 2);
});

test('applyPreviewInstructions drops the section when there is no block', () => {
  const merged = applyPreviewInstructions(GUIDANCE, '');
  assert.ok(!merged.includes('## Preview servers'));
  assert.ok(!merged.includes('Hand-written body'));
  assert.ok(merged.includes('Ask questions through the relay.'));
  assert.ok(merged.includes('Untouched trailing guidance.'));
});

test('applyPreviewInstructions appends when the document has no preview section', () => {
  const merged = applyPreviewInstructions('# Relay Tool Guidance\n\nOnly questions.', '## Preview servers\n\nGenerated body.');
  assert.ok(merged.startsWith('# Relay Tool Guidance'));
  assert.ok(merged.endsWith('Generated body.'));
});
