/**
 * Publish-time guard for the npm tarball (there is deliberately no CI — this
 * runs inside `npm test`, which the release script requires to pass before
 * `npm publish`). Fails closed: anything secret-shaped or test-shaped in the
 * pack list is a failure, as is silent bloat past the recorded ceilings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Raise deliberately (with a changelog entry) — never because a run went red.
const MAX_ENTRIES = 450;
const MAX_UNPACKED_BYTES = 6 * 1024 * 1024;

const FORBIDDEN = [
  { name: 'config file', pattern: /(^|\/)config\.json$/ },
  { name: 'database', pattern: /\.db(-wal|-shm)?$/ },
  { name: 'env file', pattern: /(^|\/)\.env/ },
  { name: 'test file', pattern: /\.(test|spec)\.mjs$/ },
  { name: 'server data', pattern: /^server\/(data|logs)\// },
  { name: 'upload payload', pattern: /^server\/uploads\/(?!README\.md$|image_input\.md$)./ },
  { name: 'repo test tree', pattern: /^tests\// },
  { name: 'docs/screenshots', pattern: /^docs\// },
  { name: 'playground', pattern: /^playground\// },
  { name: 'secret-shaped file', pattern: /(token|secret|credential|apikey|api-key)[^/]*\.(json|txt|pem|key)$/i },
];

function readPackList() {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // npm pack --json still writes human noise to stderr; stdout is the JSON.
  });
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed) && parsed[0]?.files?.length, 'npm pack returned no file list');
  return parsed[0];
}

test('npm tarball contains no secrets, state, or tests, and stays lean', () => {
  const pack = readPackList();
  const paths = pack.files.map((f) => String(f.path));

  const violations = [];
  for (const file of paths) {
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(file)) violations.push(`${file} (${rule.name})`);
    }
  }
  assert.deepEqual(violations, [], `forbidden entries in the npm tarball:\n${violations.join('\n')}`);

  for (const required of ['bin/oar.js', 'server/server.js', 'README.md', 'CHANGELOG.md', 'LICENSE', 'package.json']) {
    assert.ok(paths.includes(required), `tarball is missing ${required}`);
  }
  assert.ok(
    paths.some((p) => p.startsWith('.github/extensions/web-relay/')),
    'tarball is missing the Copilot CLI extension',
  );

  assert.ok(
    pack.entryCount <= MAX_ENTRIES,
    `tarball grew to ${pack.entryCount} entries (ceiling ${MAX_ENTRIES}) — raise deliberately or trim 'files'`,
  );
  assert.ok(
    pack.unpackedSize <= MAX_UNPACKED_BYTES,
    `tarball grew to ${pack.unpackedSize} bytes unpacked (ceiling ${MAX_UNPACKED_BYTES})`,
  );
});
