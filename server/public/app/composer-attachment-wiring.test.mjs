import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The composer wiring spans several browser-only modules that no unit test can
// import directly (they touch document/window at call time). These checks verify
// that every symbol imported across those modules is actually exported, which is
// the failure mode that would silently break the whole app shell at load.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function read(file) {
  return fs.readFileSync(path.join(__dirname, file), 'utf8');
}

function exportedNames(source) {
  const names = new Set();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g,
    /export\s+class\s+([A-Za-z0-9_$]+)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) names.add(match[1]);
  }
  let braced;
  const bracedPattern = /export\s*\{([^}]*)\}(?!\s*from)/g;
  while ((braced = bracedPattern.exec(source))) {
    for (const part of braced[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}

function importsFrom(source, specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'${escaped}'`, 'g');
  const names = [];
  let match;
  while ((match = pattern.exec(source))) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

const MODULES = {
  'attachments-view.js': read('attachments-view.js'),
  'bootstrap.js': read('bootstrap.js'),
  'conversation-view.js': read('conversation-view.js'),
  'api-client.js': read('api-client.js'),
  'journal-view.js': read('journal-view.js'),
  'store.js': read('store.js'),
  'composer-paste.mjs': read('composer-paste.mjs'),
  'image-downscale.mjs': read('image-downscale.mjs'),
  'composer-attachment-cache.mjs': read('composer-attachment-cache.mjs'),
  'composer-control-state.mjs': read('composer-control-state.mjs'),
  'model-vision-support.mjs': read('model-vision-support.mjs'),
};

const EDGES = [
  ['attachments-view.js', './composer-paste.mjs', 'composer-paste.mjs'],
  ['attachments-view.js', './image-downscale.mjs', 'image-downscale.mjs'],
  ['attachments-view.js', './model-vision-support.mjs', 'model-vision-support.mjs'],
  ['attachments-view.js', './api-client.js', 'api-client.js'],
  ['attachments-view.js', './store.js', 'store.js'],
  ['bootstrap.js', './composer-paste.mjs', 'composer-paste.mjs'],
  ['bootstrap.js', './attachments-view.js', 'attachments-view.js'],
  ['bootstrap.js', './conversation-view.js', 'conversation-view.js'],
  ['conversation-view.js', './composer-attachment-cache.mjs', 'composer-attachment-cache.mjs'],
  ['conversation-view.js', './composer-control-state.mjs', 'composer-control-state.mjs'],
  ['conversation-view.js', './attachments-view.js', 'attachments-view.js'],
];

for (const [consumer, specifier, provider] of EDGES) {
  test(`${consumer} only imports symbols ${provider} exports`, () => {
    const wanted = importsFrom(MODULES[consumer], specifier);
    assert.ok(wanted.length > 0, `expected ${consumer} to import from ${specifier}`);
    const available = exportedNames(MODULES[provider]);
    const missing = wanted.filter((name) => !available.has(name));
    assert.deepEqual(missing, [], `${provider} is missing: ${missing.join(', ')}`);
  });
}

test('composer paste and drop handlers are wired to the composer', () => {
  const bootstrap = MODULES['bootstrap.js'];
  assert.match(bootstrap, /addEventListener\('paste'/, 'paste must be bound');
  assert.match(bootstrap, /addEventListener\('drop'/, 'drop must be bound');
  assert.match(bootstrap, /initComposerAttachmentInput\(\);/, 'the initializer must be called');
  assert.match(bootstrap, /dragover/, 'dragover must be handled so the drop is accepted');
});

test('paste and drop are blocked for shared read-only viewers', () => {
  const bootstrap = MODULES['bootstrap.js'];
  assert.match(bootstrap, /function composerAttachmentsAllowed\(\)[\s\S]*?IS_SHARED_VIEW/);
  const initBlock = /function initComposerAttachmentInput\(\)[\s\S]*?\n\}/.exec(bootstrap);
  assert.ok(initBlock);
  const guardCount = (initBlock[0].match(/composerAttachmentsAllowed\(\)/g) || []).length;
  assert.ok(guardCount >= 4, `expected every handler to be guarded, found ${guardCount}`);
});

test('handlers exposed to inline HTML attributes are published on window', () => {
  const bootstrap = MODULES['bootstrap.js'];
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  for (const handler of ['removeAttachment', 'retryAttachmentUpload', 'handleAttachmentInput']) {
    assert.match(bootstrap, new RegExp(`window\\.${handler} = ${handler};`), `${handler} must be on window`);
  }
  assert.match(indexHtml, /id="composer-attachment-warning"/, 'the warning element must exist');
});

test('the composer send gate reads the attachment upload state', () => {
  assert.match(
    MODULES['conversation-view.js'],
    /attachmentsUploading: hasUploadingAttachments\(selectedAttachments\)/,
  );
});
