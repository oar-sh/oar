import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('./server-runtime.mjs', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');

function mappingBlock(name) {
  const match = new RegExp(`const ${name} = Object\\.freeze\\(\\{([\\s\\S]*?)\\n\\}\\);`).exec(source);
  assert.ok(match, `${name} mapping must exist`);
  return match[1];
}

function assertMappingEntries(name, expectedEntries) {
  const block = mappingBlock(name);
  for (const [key, value] of Object.entries(expectedEntries)) {
    assert.match(block, new RegExp(`['"]${key}['"]:\\s*['"]${value}['"]`), `${name} must map ${key}`);
  }
}

test('workspace previews recognize added text and code extensions', () => {
  assertMappingEntries('WORKSPACE_CONTENT_TYPES', {
    '.cs': 'text/plain; charset=utf-8',
    '.kt': 'text/plain; charset=utf-8',
    '.vue': 'text/plain; charset=utf-8',
    '.graphql': 'text/plain; charset=utf-8',
    '.jsonl': 'text/plain; charset=utf-8',
    '.rst': 'text/plain; charset=utf-8',
  });
  assertMappingEntries('WORKSPACE_PREVIEW_LANGUAGE_BY_EXTENSION', {
    '.cs': 'csharp',
    '.kt': 'kotlin',
    '.vue': 'xml',
    '.graphql': 'graphql',
    '.jsonl': 'plaintext',
    '.rst': 'plaintext',
  });
});

test('workspace previews recognize extensionless build and config files', () => {
  assertMappingEntries('WORKSPACE_CONTENT_TYPES_BY_FILENAME', {
    dockerfile: 'text/plain; charset=utf-8',
    makefile: 'text/plain; charset=utf-8',
    '.gitignore': 'text/plain; charset=utf-8',
    '.env': 'text/plain; charset=utf-8',
  });
  assertMappingEntries('WORKSPACE_PREVIEW_LANGUAGE_BY_FILENAME', {
    dockerfile: 'plaintext',
    makefile: 'plaintext',
    '.gitignore': 'plaintext',
    '.env': 'plaintext',
  });
});

test('audio files are served with a real audio type and previewed as audio', () => {
  // Without these, audio went out as application/octet-stream, an attachment
  // the viewer could only offer for download.
  assertMappingEntries('WORKSPACE_CONTENT_TYPES', {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.flac': 'audio/flac',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
  });
  assert.match(source, /const WORKSPACE_AUDIO_EXTENSIONS = new Set\(\[[^\]]*'\.mp3'[^\]]*'\.flac'/);
  assert.match(
    source,
    /if \(WORKSPACE_AUDIO_EXTENSIONS\.has\(normalizedExt\) \|\| normalizedType\.startsWith\('audio\/'\)\) return 'audio';/,
  );
});

test('a PDF is its own preview kind, neither text nor opaque binary', () => {
  assert.match(
    source,
    /if \(normalizedExt === '\.pdf' \|\| normalizedType === 'application\/pdf'\) return 'pdf';/,
  );
});

test('preview classification consults both extension and filename mappings', () => {
  assert.match(
    source,
    /WORKSPACE_CODE_EXTENSIONS\.has\(normalizedExt\)\s*\|\|\s*WORKSPACE_PREVIEW_LANGUAGE_BY_FILENAME\[filename\]/,
    'extensionless supported files must be classified as code previews',
  );
});
