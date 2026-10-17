import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHARE_PATH_PLACEHOLDER as HIDDEN,
  SHARE_PREVIEW_MARKS,
  createSharePathRedactor,
  normalizeKnownRoots,
  pathBaseName,
} from './share-path-redaction.mjs';

// platform-agnostic: the redactor reads Windows and Unix paths as plain strings,
// never through the host's `path`, so both shapes are tested on every OS.
// Fixtures: a Unix and a Windows host, both with a user `dev`, and a Windows
// home with a space in it.
const ROOTS = [
  '/home/dev',
  '/home/dev/work/demo',
  '/srv/relay/data',
  'C:\\Users\\dev',
  'C:\\Users\\dev\\work\\demo',
  'C:\\Users\\Jane Doe',
];
const USERS = ['dev'];

const redactor = (mode, extra = {}) => createSharePathRedactor({
  mode,
  roots: ROOTS,
  userNames: USERS,
  relayPathPrefix: '/relay',
  ...extra,
});

// Marks written out, so an expectation reads.
const show = (text) => String(text)
  .replaceAll(SHARE_PREVIEW_MARKS.redactedStart, '[[')
  .replaceAll(SHARE_PREVIEW_MARKS.redactedEnd, ']]')
  .replaceAll(SHARE_PREVIEW_MARKS.suspectStart, '{{')
  .replaceAll(SHARE_PREVIEW_MARKS.suspectEnd, '}}');

test('an unknown or missing mode means the default, the file name', () => {
  assert.equal(createSharePathRedactor().mode, 'filename');
  assert.equal(createSharePathRedactor({ mode: 'everything' }).mode, 'filename');
  assert.equal(createSharePathRedactor({ mode: 'HIDE' }).mode, 'hide');
});

test('known roots: absolute, without trailing separators, longest first, one per Windows spelling', () => {
  assert.deepEqual(
    normalizeKnownRoots(['/home/dev/', 'relative/dir', '/', 'C:\\', 'c:\\users\\dev', 'C:\\Users\\dev\\', '', null, '/home/dev/work']),
    ['/home/dev/work', 'c:\\users\\dev', '/home/dev'],
  );
});

test('the base name of a path, and none for a root', () => {
  assert.equal(pathBaseName('/home/dev/work/demo/src/app.js'), 'app.js');
  assert.equal(pathBaseName('C:\\Users\\dev\\work\\demo\\'), 'demo');
  assert.equal(pathBaseName('C:\\'), '');
  assert.equal(pathBaseName('~/'), '');
});

test('show mode leaves every string as it is', () => {
  const r = redactor('show');
  const text = 'Read /home/dev/work/demo/src/app.js and C:\\Users\\dev\\notes.txt';
  assert.equal(r.text(text), text);
  const payload = { cwd: '/home/dev/work/demo', text };
  assert.equal(r.payload(payload), payload, 'nothing to walk');
});

test('Unix paths: the file name, or the placeholder', () => {
  const cases = [
    ['Read /home/dev/work/demo/src/app.js.', 'Read app.js.', `Read ${HIDDEN}.`],
    ['Edited /opt/tools/bin/run.sh and /var/log/app/today.log', 'Edited run.sh and today.log', `Edited ${HIDDEN} and ${HIDDEN}`],
    ['cd ~/projects/demo && ls', 'cd demo && ls', `cd ${HIDDEN} && ls`],
    ['see ~dev/notes/todo.md', 'see todo.md', `see ${HIDDEN}`],
    ['the folder /home/dev/work/demo/', 'the folder demo', `the folder ${HIDDEN}`],
  ];
  for (const [input, filename, hide] of cases) {
    assert.equal(redactor('filename').text(input), filename, input);
    assert.equal(redactor('hide').text(input), hide, input);
  }
});

test('Windows paths: drive with either separator, escaped in JSON, UNC shares', () => {
  const cases = [
    ['Opened C:\\Users\\dev\\work\\demo\\main.py', 'Opened main.py', `Opened ${HIDDEN}`],
    ['Opened c:/users/dev/work/demo/main.py', 'Opened main.py', `Opened ${HIDDEN}`],
    ['{"file_path":"C:\\\\Users\\\\dev\\\\work\\\\demo\\\\a.js"}', '{"file_path":"a.js"}', `{"file_path":"${HIDDEN}"}`],
    ['copied to \\\\fileserver\\team\\reports\\q3.xlsx', 'copied to q3.xlsx', `copied to ${HIDDEN}`],
    ['D:\\data\\export.csv', 'export.csv', HIDDEN],
  ];
  for (const [input, filename, hide] of cases) {
    assert.equal(redactor('filename').text(input), filename, input);
    assert.equal(redactor('hide').text(input), hide, input);
  }
});

test('a known root is found with a space in it, in any case and with either separator', () => {
  const r = redactor('filename');
  assert.equal(r.text('wrote C:\\Users\\Jane Doe\\report.docx'), 'wrote report.docx');
  assert.equal(r.text('wrote c:/USERS/jane doe/report.docx'), 'wrote report.docx');
  // Without the known root the space ends the path.
  assert.equal(createSharePathRedactor({ mode: 'filename' }).text('wrote C:\\Users\\Jane Doe\\report.docx'), 'wrote Jane Doe\\report.docx');
});

test('a known root does not swallow a longer name it is the start of', () => {
  assert.equal(redactor('filename').text('/home/devops/tool/run.sh'), 'run.sh');
  assert.equal(redactor('filename').text('/srv/relay/database/x.db'), 'x.db');
});

test('a path whose last segment is the user name, or the home itself, is hidden in filename mode too', () => {
  const r = redactor('filename');
  assert.equal(r.text('home is /home/dev'), `home is ${HIDDEN}`);
  assert.equal(r.text('home is C:\\Users\\dev\\'), `home is ${HIDDEN}`);
});

test('the user name between separators of a relative path is hidden', () => {
  assert.equal(redactor('filename').text('under Users/dev/notes.txt'), `under Users/${HIDDEN}/notes.txt`);
  assert.equal(redactor('filename').text('a developer named dev'), 'a developer named dev', 'a word is no path');
});

test('relative paths are left alone in free text (a documented limit)', () => {
  assert.equal(redactor('filename').text('changed src/app.js and lib/util.mjs'), 'changed src/app.js and lib/util.mjs');
  assert.equal(redactor('hide').text('changed src/app.js'), 'changed src/app.js');
});

test('http(s) URLs, relay URLs and markdown structure are untouched', () => {
  const r = redactor('hide');
  const kept = [
    'see https://example.com/home/dev/work/x.js and http://localhost:3000/a/b/c',
    'wss://relay-b.example.test/socket/io',
    '![shot](/relay/api/shared/0123abcd/upload/feedface/content)',
    '[the image](/api/shared/0123abcd/generated-image/m1/i1/content)',
    'open /shared/0123abcd to read along',
    'GET /api/conversation/:id/subagent/:subagentRunId',
    '<https://example.com/a/b>',
  ];
  for (const text of kept) assert.equal(r.text(text), text, text);
  assert.equal(redactor('filename').text('[notes](/home/dev/work/demo/docs/notes.md)'), '[notes](notes.md)');
  assert.equal(redactor('filename').text('**/opt/app/config.yml**'), '**config.yml**');
  assert.equal(redactor('filename').text('| /opt/app/a.txt | ok |'), '| a.txt | ok |');
  assert.equal(redactor('filename').text('(see /opt/app/a.txt)'), '(see a.txt)');
});

test('the query of a relay URL is filtered, its path is not', () => {
  assert.equal(
    redactor('filename').text('/relay/api/drive/file?path=/home/dev/work/demo/a.js'),
    '/relay/api/drive/file?path=a.js',
  );
});

test('code fences keep their structure; paths inside them are filtered', () => {
  const input = '```js\nconst root = "/home/dev/work/demo";\nimport x from "./local/x.js";\n```';
  assert.equal(redactor('filename').text(input), '```js\nconst root = "demo";\nimport x from "./local/x.js";\n```');
  assert.equal(redactor('hide').text('`/home/dev/work/demo/a.js`'), `\`${HIDDEN}\``);
});

test('file:// URLs', () => {
  assert.equal(redactor('filename').text('open file:///home/dev/work/demo/index.html.'), 'open index.html.');
  assert.equal(redactor('filename').text('open file:///C:/Users/dev/My%20Report.pdf'), 'open My Report.pdf');
  assert.equal(redactor('hide').text('open file:///C:/Users/dev/a.pdf'), `open ${HIDDEN}`);
});

test('@file: and @folder: mentions are structured: relative ones are cut too', () => {
  assert.equal(redactor('filename').text('look at @file:src/app.js and @folder:/home/dev/work/demo'), 'look at @file:app.js and @folder:demo');
  assert.equal(redactor('hide').text('look at @file:src/app.js'), `look at @file:${HIDDEN}`);
});

test('diff and patch headers name their files in every form', () => {
  const diff = [
    'diff --git a/src/app.js b/src/app.js',
    '--- a/src/app.js',
    '+++ b/src/app.js',
    '--- /dev/null',
    '*** Update File: lib/util.mjs',
    '*** Add File: /home/dev/work/demo/new.txt',
    '@@ -1 +1 @@',
  ].join('\n');
  assert.equal(redactor('filename').text(diff), [
    'diff --git a/app.js b/app.js',
    '--- a/app.js',
    '+++ b/app.js',
    '--- /dev/null',
    '*** Update File: util.mjs',
    '*** Add File: new.txt',
    '@@ -1 +1 @@',
  ].join('\n'));
  assert.ok(!redactor('hide').text(diff).includes('app.js'));
});

test('structured fields: the whole value is a path, whatever it looks like', () => {
  const r = redactor('filename');
  const out = r.payload({
    cwd: 'C:\\Users\\dev\\work\\demo',
    sessionRootPath: '/home/dev/.sessions/abc',
    paths: ['/home/dev/a.txt', 'rel/b.txt'],
    reference: '@/srv/relay/data/uploads/feed.png',
    generatedImage: { relativePath: 'images/2026/one.png', imageId: 'img-1' },
    text: 'Read /home/dev/work/demo/a.js',
    id: 'conv/with/slashes',
  });
  assert.deepEqual(out, {
    cwd: 'demo',
    sessionRootPath: 'abc',
    paths: ['a.txt', 'b.txt'],
    reference: '@feed.png',
    generatedImage: { relativePath: 'one.png', imageId: 'img-1' },
    text: 'Read a.js',
    id: 'conv/with/slashes',
  });
  assert.equal(redactor('hide').payload({ cwd: 'demo' }).cwd, HIDDEN, 'hide: even a bare name in a path field');
});

test('attachments: names stay unless names are hidden; content URLs stay', () => {
  const attachment = { name: 'screen shot.png', type: 'image/png', sha256: 'ab'.repeat(32), contentUrl: '/relay/api/shared/0123abcd/upload/abab/content' };
  assert.deepEqual(redactor('filename').payload({ attachments: [attachment] }), { attachments: [attachment] });
  assert.deepEqual(redactor('hide').payload({ attachments: [attachment] }), { attachments: [{ ...attachment, name: HIDDEN }] });
  // `name` elsewhere is not a file name.
  assert.deepEqual(redactor('hide').payload({ origin: { name: 'relay b' } }), { origin: { name: 'relay b' } });
});

test('a tool call stored as JSON: its path fields are cut whole, spaces and all', () => {
  const input = JSON.stringify({ file_path: '/mnt/shared drive/plans/q3 plan.md', command: 'ls /opt/app/conf', limit: 5 });
  const out = JSON.parse(redactor('filename').payload({ text: input }).text);
  assert.deepEqual(out, { file_path: 'q3 plan.md', command: 'ls conf', limit: 5 });
  const untouched = JSON.stringify({ query: 'no paths here' }, null, 2);
  assert.equal(redactor('filename').payload({ text: untouched }).text, untouched, 'unchanged JSON keeps its formatting');
});

test('nested payloads: every string is walked', () => {
  const out = redactor('filename').payload({
    messages: [{
      text: 'Done in /home/dev/work/demo.',
      activities: [{ text: '📖 Read /home/dev/work/demo/README.md' }],
      thoughts: [{ text: 'Check C:\\Users\\dev\\work\\demo\\x.ts first' }],
      subagentRuns: [{ displayName: 'Look at /opt/app/main.go' }],
    }],
    inFlight: { streamEvents: [{ text: 'Writing /home/dev/work/demo/out' }] },
  });
  assert.equal(JSON.stringify(out).includes('/home/dev'), false);
  assert.equal(out.messages[0].text, 'Done in demo.');
  assert.equal(out.messages[0].activities[0].text, '📖 Read README.md');
  assert.equal(out.messages[0].thoughts[0].text, 'Check x.ts first');
  assert.equal(out.messages[0].subagentRuns[0].displayName, 'Look at main.go');
  assert.equal(out.inFlight.streamEvents[0].text, 'Writing out');
});

test('preview: every redaction is marked, the original is never sent', () => {
  const r = redactor('filename', { annotate: true });
  assert.equal(show(r.text('Read /home/dev/work/demo/src/app.js.')), 'Read [[app.js]].');
  assert.equal(show(r.payload({ cwd: '/home/dev/work/demo' }).cwd), '[[demo]]');
  const hidden = redactor('hide', { annotate: true }).text('Read /home/dev/work/demo/src/app.js');
  assert.equal(show(hidden), `Read [[${HIDDEN}]]`);
  assert.ok(!hidden.includes('/home/dev'));
});

test('preview: leftovers that still look like paths are flagged', () => {
  const r = redactor('filename', { annotate: true });
  assert.equal(show(r.text('changed src/app.js and see https://example.com/a/b.js')), 'changed {{src/app.js}} and see https://example.com/a/b.js');
  assert.equal(show(r.text('under home/dev and and/or')), 'under {{home/dev}} and and/or');
  assert.equal(show(r.text('ask dev about it')), 'ask {{dev}} about it');
  // A path that is cut at a space leaves its tail: flagged.
  assert.equal(show(createSharePathRedactor({ mode: 'filename', annotate: true }).text('C:\\Work Files\\plan.md')), '[[Work]] {{Files\\plan.md}}');
});

test('preview in show mode flags every absolute path that would be shown', () => {
  const r = redactor('show', { annotate: true });
  assert.equal(show(r.text('Read /home/dev/work/demo/a.js.')), 'Read {{/home/dev/work/demo/a.js}}.');
  assert.equal(show(r.text('C:\\Users\\Jane Doe\\x.txt')), '{{C:\\Users\\Jane Doe\\x.txt}}');
  assert.equal(show(r.text('/dev/null is fine')), '/dev/null is fine');
});

test('preview: mark characters in the input are dropped first', () => {
  const r = redactor('filename', { annotate: true });
  const injected = `${SHARE_PREVIEW_MARKS.redactedStart}fake${SHARE_PREVIEW_MARKS.redactedEnd}`;
  assert.equal(r.text(injected), 'fake');
  assert.equal(redactor('filename').text(injected), injected, 'outside a preview the text is not touched for them');
});

test('long and hostile inputs stay fast', () => {
  const r = redactor('filename', { annotate: true });
  const inputs = [
    '/'.repeat(50_000),
    `/${'a/'.repeat(25_000)}`,
    `C:${'\\'.repeat(50_000)}`,
    `${'x/'.repeat(25_000)}.js`,
    ' '.repeat(50_000),
    `@file:${'a'.repeat(50_000)}`,
    `https://${'a/'.repeat(25_000)}`,
    '~'.repeat(50_000),
    `${'~/'.repeat(25_000)}`,
    '\\'.repeat(25_000),
    `file://${'/'.repeat(50_000)}`,
    `${'c:/'.repeat(20_000)}`,
    `${'--- a/x\n'.repeat(5_000)}`,
    `${'/home/dev'.repeat(5_000)}`,
    `${'Users/dev/'.repeat(5_000)}`,
  ];
  for (const input of inputs) {
    const started = Date.now();
    r.text(input);
    assert.ok(Date.now() - started < 1500, `slow on ${input.slice(0, 12)}…`);
  }
});
