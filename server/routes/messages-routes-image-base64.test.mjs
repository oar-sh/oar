// The base64 and data-URL checks on the image paths run as character loops,
// not as regular expressions over a payload of several million characters:
// an unoptimised V8 regexp pushes one backtrack frame per character and
// overflows its 64 MiB stack at 4,194,304 characters with "Maximum call stack
// size exceeded", which is what happened to every gpt-image reply above about
// 3 MB on a relay with some uptime (2026-11-07). The child-process test below
// runs the real functions with V8's regexp optimisation switched off, the
// state a long-running relay is in, on a payload past that boundary.
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isBase64Text,
  normalizeGeneratedImageResponses,
  normalizeOpenAIImageApiGeneratedImages,
  resolveOpenAIImageEditAttachment,
  splitBase64DataUrl,
} from './messages-routes.mjs';

// Past the 4,194,304-character boundary; decodes to 3,375,000 zero bytes.
const BIG_BASE64 = 'A'.repeat(4_500_000);

test('isBase64Text accepts the base64 alphabet, padding and ASCII whitespace, nothing else', () => {
  assert.equal(isBase64Text('iVBORw0KGgo='), true);
  assert.equal(isBase64Text('AB+/\n CD==\r\n'), true);
  // Empty is refused; the callers answer a missing payload with their own message first.
  assert.equal(isBase64Text(''), false);
  assert.equal(isBase64Text('AB-_'), false);
  assert.equal(isBase64Text('data:image/png;base64,AAAA'), false);
  assert.equal(isBase64Text('AAAA\u00a0'), false);
  assert.equal(isBase64Text(BIG_BASE64), true);
});

test('splitBase64DataUrl takes a data URL apart and refuses the other shapes', () => {
  assert.deepEqual(splitBase64DataUrl('data:image/png;base64,AAAA'), { mimeType: 'image/png', payload: 'AAAA' });
  assert.deepEqual(splitBase64DataUrl('DATA:image/webp;BASE64,QUJD'), { mimeType: 'image/webp', payload: 'QUJD' });
  assert.equal(splitBase64DataUrl('data:image/png;base64,'), null);
  assert.equal(splitBase64DataUrl('data:image/png,AAAA'), null);
  assert.equal(splitBase64DataUrl('data:image/png;charset=x;base64,AAAA'), null);
  assert.equal(splitBase64DataUrl('data:;base64,AAAA'), null);
  assert.equal(splitBase64DataUrl('http://example.invalid/a.png'), null);
  assert.equal(splitBase64DataUrl(''), null);
});

test('a generated image past 4,194,304 base64 characters goes through every image path', () => {
  const fromApi = normalizeOpenAIImageApiGeneratedImages({ data: [{ b64_json: BIG_BASE64 }] });
  assert.equal(fromApi.length, 1);
  assert.equal(fromApi[0].data.length, BIG_BASE64.length);

  const fromWorker = normalizeGeneratedImageResponses([{ mimeType: 'image/png', dataUrl: `data:image/png;base64,${BIG_BASE64}` }]);
  assert.equal(fromWorker.length, 1);
  assert.equal(fromWorker[0].dataBase64.length, BIG_BASE64.length);

  const edit = resolveOpenAIImageEditAttachment([{ type: 'image/png', name: 'ref.png', dataUrl: `data:image/png;base64,${BIG_BASE64}` }]);
  assert.equal(edit.bytes.length, 3_375_000);
  assert.equal(edit.mimeType, 'image/png');
});

test('invalid base64 is still refused on every image path', () => {
  assert.throws(() => normalizeOpenAIImageApiGeneratedImages({ data: [{ b64_json: 'AB-_' }] }), /invalid base64/);
  assert.throws(() => normalizeGeneratedImageResponses([{ mimeType: 'image/png', data: 'AB-_' }]), /not valid base64/);
  assert.throws(() => normalizeGeneratedImageResponses([{ dataUrl: 'data:image/png,AAAA' }]), /Invalid generated image data URL/);
  assert.throws(() => resolveOpenAIImageEditAttachment([{ type: 'image/png', dataUrl: 'data:image/png;base64,' }]), /Invalid image attachment data URL/);
});

test('with V8 regexp optimisation off, the state of a relay with uptime, the big reply still goes through', (t) => {
  // A file URL, not a path: the ESM loader takes a Windows path such as
  // d:\... for a URL with the scheme "d:" and refuses it.
  const moduleUrl = new URL('./messages-routes.mjs', import.meta.url).href;
  const script = `
    import {
      normalizeOpenAIImageApiGeneratedImages,
      normalizeGeneratedImageResponses,
      resolveOpenAIImageEditAttachment,
    } from ${JSON.stringify(moduleUrl)};
    const big = 'A'.repeat(4_500_000);
    // The old check, for contrast: it threw here on V8 13.6.
    let oldCheck = 'passed';
    try { /^[a-z0-9+/=\\s]+$/i.test(big); } catch (error) { oldCheck = String(error?.message || error); }
    const a = normalizeOpenAIImageApiGeneratedImages({ data: [{ b64_json: big }] })[0].data.length;
    const b = normalizeGeneratedImageResponses([{ dataUrl: 'data:image/png;base64,' + big }])[0].dataBase64.length;
    const c = resolveOpenAIImageEditAttachment([{ type: 'image/png', name: 'ref.png', dataUrl: 'data:image/png;base64,' + big }]).bytes.length;
    console.log('RESULT ' + JSON.stringify({ oldCheck, a, b, c }));
  `;
  const result = spawnSync(process.execPath, ['--no-regexp-optimization', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  // A child that could not start, timed out, or failed its import must fail
  // this test with its own output, never pass without running the code.
  assert.equal(result.error, undefined, `child did not run: ${result.error?.message}`);
  assert.equal(result.status, 0, `child exited ${result.status} (signal ${result.signal})\n${result.stderr}`);
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith('RESULT '));
  assert.ok(line, `child printed no result\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const parsed = JSON.parse(line.slice('RESULT '.length));
  // The engine's own message is V8's wording, not a contract: logged, not asserted.
  t.diagnostic(`old regexp check without optimisation: ${parsed.oldCheck}`);
  assert.equal(parsed.a, 4_500_000);
  assert.equal(parsed.b, 4_500_000);
  assert.equal(parsed.c, 3_375_000);
});
