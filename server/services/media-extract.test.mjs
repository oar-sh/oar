import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractMediaFromMessage,
  findDataImage,
  findMarkdownImages,
  localPathIdentityKey,
  normalizeLocalMediaPath,
} from './media-extract.mjs';

const SHA = 'a'.repeat(64);
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('uploads, references, legacy data URLs and generated images come from the attachment list', () => {
  const items = extractMediaFromMessage({
    role: 'user',
    platform: 'linux',
    attachments: JSON.stringify([
      { name: 'cat.png', type: 'image/png', size: 12, sha256: SHA.toUpperCase() },
      { name: 'notes.pdf', type: 'application/pdf', size: 99, sha256: 'b'.repeat(64) },
      { name: 'ref.jpg', type: 'image/jpeg', size: 5, path: '/home/demo/pics/../pics/ref.jpg', source: 'reference' },
      { name: 'image', type: 'image/png', dataUrl: `data:image/png;base64,${PNG_1PX}` },
      { name: 'img-01.png', type: 'image/png', size: 7, contentUrl: '/api/generated-image/c1/m1/i1/content',
        generatedImage: { imageId: 'i1', messageId: 'm1', conversationId: 'c1', sessionId: 's1', relativePath: 'c1/m1/img-01.png' } },
      { name: 'broken' },
    ]),
  });
  assert.deepEqual(items.map((item) => [item.ordinal, item.origin, item.locatorKind, item.category, item.mediaKind]), [
    [0, 'upload', 'upload_sha', 'media', 'image'],
    [1, 'upload', 'upload_sha', 'file', 'pdf'],
    [2, 'reference', 'local_path', 'media', 'image'],
    [3, 'upload', 'legacy_data_url', 'media', 'image'],
    [4, 'generated', 'generated', 'media', 'image'],
  ]);
  assert.equal(items[0].identityKey, `sha:${SHA}`);
  assert.equal(items[2].locator, '/home/demo/pics/ref.jpg');
  assert.match(items[3].identityKey, /^data:[a-f0-9]{64}$/);
  assert.equal(items[3].locator, '', 'no image bytes are stored in the index');
  assert.equal(items[4].identityKey, 'gen:c1/m1/i1');
  assert.equal(JSON.parse(items[4].locator).relativePath, 'c1/m1/img-01.png');
});

test('generated images are recognized by their shape, whatever their route', () => {
  const [item] = extractMediaFromMessage({
    platform: 'linux',
    attachments: [{ name: 'x.webp', type: 'image/webp', contentUrl: '/api/some-future-image/9/content', generatedImage: { imageId: 'z9' } }],
    conversationId: 'conv',
    messageId: 'msg',
  });
  assert.equal(item.origin, 'generated');
  assert.equal(item.identityKey, 'gen:conv/msg/z9');
  assert.equal(JSON.parse(item.locator).contentUrl, '/api/some-future-image/9/content');
});

test('markdown images: titles, angle brackets, balanced parentheses and escapes', () => {
  assert.deepEqual(findMarkdownImages([
    '![one](/tmp/a.png "title")',
    '![two](</tmp/with space.png>)',
    '![three](/tmp/f(1).png)',
    '![fo\\_ur](C:\\Users\\demo\\b\\_c.png)',
    '\\![not](/tmp/escaped.png)',
    '![x][ref]',
  ].join('\n')), [
    { alt: 'one', target: '/tmp/a.png' },
    { alt: 'two', target: '/tmp/with space.png' },
    { alt: 'three', target: '/tmp/f(1).png' },
    { alt: 'fo_ur', target: 'C:\\Users\\demo\\b_c.png' },
  ]);
});

test('images inside code spans and fenced code are not media', () => {
  const text = [
    'see `![a](/tmp/in-code.png)` here',
    '```md',
    '![b](/tmp/in-fence.png)',
    '```',
    '~~~',
    '![c](/tmp/in-tilde.png)',
    '~~~',
    '![d](/tmp/real.png)',
  ].join('\n');
  assert.deepEqual(findMarkdownImages(text).map((image) => image.target), ['/tmp/real.png']);
});

test('embedded targets: local paths, relay routes, remote and data images', () => {
  const text = [
    '![local](/home/demo/shot.png)',
    '![drive](/api/drives/file?path=%2Fhome%2Fdemo%2Fother.jpg)',
    '![ws](/api/files/docs/pic%201.webp)',
    '![rel](./img/rel.gif)',
    '![up](/api/upload/' + SHA + '/content)',
    '![gen](/api/generated-image/c1/m1/i1/content)',
    '![remote](https://example.test/p/photo.jpeg?x=1)',
    `![data](data:image/png;base64,${PNG_1PX})`,
    '![clip](/home/demo/clip.mp4)',
  ].join('\n');
  const items = extractMediaFromMessage({ role: 'assistant', text, platform: 'linux', workspaceRoot: '/home/demo/ws' });
  assert.deepEqual(items.map((item) => [item.locatorKind, item.locator.startsWith('{') ? 'json' : item.locator, item.mediaKind]), [
    ['local_path', '/home/demo/shot.png', 'image'],
    ['local_path', '/home/demo/other.jpg', 'image'],
    ['local_path', '/home/demo/ws/docs/pic 1.webp', 'image'],
    ['local_path', '/home/demo/ws/img/rel.gif', 'image'],
    ['upload_sha', SHA, 'image'],
    ['generated', 'json', 'image'],
    ['remote_url', 'https://example.test/p/photo.jpeg?x=1', 'image'],
    ['data_uri', '', 'image'],
    ['local_path', '/home/demo/clip.mp4', 'video'],
  ]);
  assert.ok(items.every((item) => item.origin === 'embedded'));
  assert.equal(items[0].alt, 'local');
  assert.equal(items[5].identityKey, 'gen:c1/m1/i1', 'an embedded generated image dedupes with its attachment');
});

test('targets the chat would not show as media are skipped', () => {
  const text = [
    '![svg](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)',
    '![html](data:text/html;base64,PGI+eDwvYj4=)',
    '![bad](data:image/png;base64,***)',
    '![file](file:///home/demo/a.png)',
    '![js](javascript:alert(1))',
    '![blob](blob:https://x/1)',
    '![doc](/home/demo/readme.txt)',
    '![noext](/home/demo/picture)',
    '![escape](../../etc/passwd.png)',
    '![other-route](/api/drives/list?path=%2F)',
    '![win](C:\\Users\\demo\\a.png)',
  ].join('\n');
  assert.deepEqual(extractMediaFromMessage({ text, platform: 'linux', workspaceRoot: '/home/demo/ws' }), []);
});

test('paths are decoded at most once: a file may really be named with a percent sign', () => {
  const items = extractMediaFromMessage({
    platform: 'linux',
    workspaceRoot: '/srv/ws',
    text: [
      '![a](</home/demo/old 100%_x.png>)',
      '![b](/home/demo/with%20space.png)',
      '![c](/api/drives/file?path=%2Fhome%2Fdemo%2F100%2525.png)',
      '![d](/api/files/sub/50%25off.png)',
    ].join('\n'),
    attachments: [{ name: '100%.png', type: 'image/png', path: '/home/demo/100%41.png', source: 'reference' }],
  });
  assert.deepEqual(items.map((item) => item.locator), [
    '/home/demo/100%41.png',
    '/home/demo/old 100%_x.png',
    '/home/demo/with space.png',
    '/home/demo/100%25.png',
    '/srv/ws/sub/50%off.png',
  ]);
});

test('relative targets need a workspace root and must stay inside it', () => {
  assert.deepEqual(extractMediaFromMessage({ text: '![a](img/a.png)', platform: 'linux' }), []);
  assert.deepEqual(extractMediaFromMessage({ text: '![a](/api/files/..%2F..%2Fsecret.png)', platform: 'linux', workspaceRoot: '/srv/ws' }), []);
});

test('Windows paths normalize and compare without case', () => {
  const items = extractMediaFromMessage({
    platform: 'win32',
    workspaceRoot: 'D:\\Work\\Repo',
    text: [
      '![a](C:/Users/Demo/Pics/../Pics/Shot.PNG)',
      // Markdown unescapes `\.`, as the chat renderer does, so this is not `..`.
      '![a2](C:\\Users\\Demo\\Pics\\..\\Pics\\Shot.PNG)',
      '![b](c:/users/demo/pics/shot.png)',
      '![c](docs/x.jpg)',
      '![posix](/home/demo/a.png)',
    ].join('\n'),
  });
  assert.equal(items.length, 4);
  assert.equal(items[0].locator, 'C:\\Users\\Demo\\Pics\\Shot.PNG');
  assert.equal(items[1].locator, 'C:\\Users\\Demo\\Pics..\\Pics\\Shot.PNG');
  assert.equal(items[0].identityKey, items[2].identityKey);
  assert.equal(items[3].locator, 'D:\\Work\\Repo\\docs\\x.jpg');
  assert.equal(localPathIdentityKey('C:\\A.png', 'win32'), 'path:c:\\a.png');
  assert.equal(normalizeLocalMediaPath('/home/a.png', 'win32'), '');
  assert.equal(normalizeLocalMediaPath('C:\\a.png', 'linux'), '');
});

test('the same data image gets the same identity in text and attachments', () => {
  const [fromAttachment, fromText] = extractMediaFromMessage({
    platform: 'linux',
    attachments: [{ dataUrl: `data:image/png;base64,${PNG_1PX}` }],
    text: `![x](data:image/png;base64,${PNG_1PX})`,
  });
  assert.equal(fromAttachment.identityKey, fromText.identityKey);
  assert.ok(fromText.sizeBytes > 0);
});

test('malformed attachment JSON and empty messages give no items', () => {
  assert.deepEqual(extractMediaFromMessage({ attachments: '{not json', text: '' }), []);
  assert.deepEqual(extractMediaFromMessage({ attachments: '{"a":1}', text: 'no images here ![' }), []);
  assert.deepEqual(extractMediaFromMessage(), []);
});

test('hostile text stays linear: unclosed openers, backtick runs, endless targets', () => {
  const inputs = [
    '![a'.repeat(90_000),
    '![a](x'.repeat(50_000),
    '`a``b'.repeat(60_000),
    '[!['.repeat(90_000),
    `${'!['.repeat(250)}]`.repeat(520),
    `![a](data:image/png;base64,${'A'.repeat(300_000)}`,
    `![a](${'x'.repeat(300_000)}`,
  ];
  for (const text of inputs) {
    const started = process.hrtime.bigint();
    extractMediaFromMessage({ text, platform: 'linux' });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1500, `${text.slice(0, 12)}… took ${ms.toFixed(0)} ms`);
  }
});

test('a data image must start with the bytes of the type it declares', () => {
  const notPng = Buffer.from('not a png at all, just text').toString('base64');
  const jpegAsPng = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1]).toString('base64');
  assert.deepEqual(extractMediaFromMessage({ platform: 'linux', text: `![a](data:image/png;base64,${notPng})\n![b](data:image/png;base64,${jpegAsPng})` }), []);
  assert.equal(extractMediaFromMessage({ platform: 'linux', text: `![c](data:image/jpeg;base64,${jpegAsPng})` }).length, 1);
  assert.deepEqual(extractMediaFromMessage({ platform: 'linux', attachments: [{ dataUrl: `data:image/gif;base64,${notPng}` }] }), []);
});

test('base64 is checked strictly and data images are found again by identity', () => {
  const bad = extractMediaFromMessage({ platform: 'linux', text: '![a](data:image/png;base64,abc)\n![b](data:image/png;base64,ab=c)' });
  assert.deepEqual(bad, []);
  const message = { text: `x ![a](data:image/png;base64,${PNG_1PX})`, attachments: null };
  const [item] = extractMediaFromMessage({ ...message, platform: 'linux' });
  assert.deepEqual(findDataImage(message, item.identityKey), { mime: 'image/png', payload: PNG_1PX });
  assert.equal(findDataImage({ text: 'changed' }, item.identityKey), null);
  assert.equal(findDataImage(message, 'sha:x'), null);
});

test('upload shas must be 64 hex characters, and Linux pseudo files are never media', () => {
  const items = extractMediaFromMessage({
    platform: 'linux',
    attachments: [{ name: 'x.png', type: 'image/png', sha256: '../../etc/passwd' }],
    text: '![a](/api/upload/..%2F..%2Fx/content)\n![p](/proc/self/environ.png)\n![d](/dev/fd/0.png)',
  });
  assert.deepEqual(items, []);
});

test('a message with very many images is capped', () => {
  const text = Array.from({ length: 500 }, (_, i) => `![i](/tmp/${i}.png)`).join(' ');
  assert.equal(extractMediaFromMessage({ text, platform: 'linux' }).length, 200);
});

test('after a data URI too long to be a target, the scan goes on where the old scanner did', () => {
  // 28 MiB of base64 with no separator, then straight into the next image.
  const long = `![a](data:image/png;base64,${'A'.repeat(28 * 1024 * 1024 + 8)}![b c](/srv/demo/next.png)`;
  const items = extractMediaFromMessage({ text: long, platform: 'linux' });
  assert.deepEqual(items.map((item) => item.locator), ['/srv/demo/next.png']);
});