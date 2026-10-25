/**
 * Publish-time guard for the npm tarball (there is deliberately no CI — this
 * runs inside `npm test`, which the release script requires to pass before
 * `npm publish`). Fails closed: anything secret-shaped or test-shaped in the
 * pack list is a failure, as is silent bloat past the recorded ceilings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Raise deliberately (with a changelog entry) — never because a run went red.
// 450 until 2026-10-13; four changes of that day added small modules:
// keeping background tasks across a relay restart (the task store, the view
// of unreported background work, the task digest, the kept posts), previews
// that survive a restart (the preview store and its migration), session
// groups (migration 0014, the group repository, the group routes, the
// list-order, group-state and turn-state modules) and the transcript that
// stays where the reader is (the viewport anchor): 462 entries. 470 until
// 2026-10-16; share management (migration 0016, the share repository, the
// access log, the share list and the Sharing tab) took it to 473. 480 until
// 2026-10-16; path privacy in shared views and About OAR (its service, route,
// view and modal) took it to 482. 490 until 2026-10-17; the task console (the
// text pipeline, the output service and rooms, the spool, the console modules,
// the Claude, Copilot and Grok task-output pieces) took it to 501, and the
// transcript island module to 502. 510 until 2026-10-19; the task rows kept
// over a restart and the note to interrupted sessions (migration 0018, the
// row store, the resume service and its note view) and the queued restart's
// banner (the restart queue, its picture of what runs, its routes and its
// banner module) took it to 513. 520 until 2026-10-20; the take-over of the
// database earlier autostart launchers used and the install-time copy of the
// one inside the package (three modules) took it to 522. The two developer
// READMEs left the package for GitHub on 2026-10-21: 519. 530 until
// 2026-10-23; questions that don't block and the Inbox (migration 0023, the
// ask service, its link and routes, the shared module, the Inbox view and
// its page module) took it to 535. 540 until 2026-10-24; the DeepSeek
// provider (settings service, API client, model table, its worker entry and
// Claude-runner backend, and the Claude worker's shared main) took it to 541.
const MAX_ENTRIES = 560;
// 6.25 MiB until 2026-10-07; the pinned messages and the fullscreen file
// viewer (seven small modules) took the unpacked size to 6.27 MiB. 6.5 MiB
// until 2026-10-11; the sub-agent records, the event subscriptions and
// their reach across paired relays took it to 6.54 MiB. 6.75 MiB until
// 2026-10-13; the same four changes together took it to about 6.9 MiB. 7 MiB
// until 2026-10-16; share management took it to 7.02 MiB. 7.25 MiB until
// 2026-10-17; the task console took it to 7.31 MiB. 7.5 MiB until
// 2026-10-19; the same two changes took it to 7.48 MiB, too close to keep.
// 7.75 MiB until 2026-10-21; the take-over of earlier databases, the
// install-time copy, the lock checks and the 0.9.14 changelog took it just
// over 7.75 MiB (8,126,967 bytes). 8 MiB until 2026-10-24; the DeepSeek
// provider's settings, discovery and catalogue took it to 8,401,377 bytes.
const MAX_UNPACKED_BYTES = 9 * 1024 * 1024;

const FORBIDDEN = [
  { name: 'config file', pattern: /(^|\/)config\.json$/ },
  { name: 'database', pattern: /\.db(-wal|-shm)?$/ },
  { name: 'env file', pattern: /(^|\/)\.env/ },
  { name: 'test file', pattern: /\.(test|spec)\.mjs$/ },
  { name: 'test harness', pattern: /-test-harness\.mjs$/ },
  { name: 'test fixture', pattern: /(^|\/)fixtures\// },
  { name: 'server data', pattern: /^server\/(data|logs)\// },
  { name: 'upload payload', pattern: /^server\/uploads\/(?!README\.md$)./ },
  { name: 'repo test tree', pattern: /^tests\// },
  { name: 'docs/screenshots', pattern: /^docs\// },
  { name: 'playground', pattern: /^playground\// },
  { name: 'secret-shaped file', pattern: /(token|secret|credential|apikey|api-key)[^/]*\.(json|txt|pem|key)$/i },
];

// A module and the modules its static and dynamic relative imports reach,
// repo-relative with forward slashes, as the pack list names them.
function importClosure(entry) {
  const seen = new Set();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let text = '';
    try { text = fs.readFileSync(path.join(repoRoot, file), 'utf8'); } catch { continue; }
    for (const match of text.matchAll(/(?:^import\s[^'"]*|\bimport\()['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
    }
  }
  return [...seen];
}

function readPackList() {
  // On win32 npm is npm.cmd, which execFileSync only resolves through a shell;
  // the arguments are static strings, so shell interpolation has nothing to bite.
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === 'win32', // host-platform: npm.cmd needs a shell; this test really invokes the host npm
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
  // Developer documentation lives on GitHub, not in the package.
  for (const absent of ['server/README.md', '.github/extensions/web-relay/README.md']) {
    assert.ok(!paths.includes(absent), `tarball ships ${absent}, which belongs on GitHub only`);
  }
  // An install script must run a packed file, and every module that file
  // reaches (static or dynamic relative imports) must be packed too.
  const { scripts = {} } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  for (const hook of ['preinstall', 'install', 'postinstall']) {
    if (!scripts[hook]) continue;
    const file = String(scripts[hook]).match(/^node (\S+)$/)?.[1];
    assert.ok(file, `the ${hook} script (${scripts[hook]}) must be \`node <file>\``);
    const unpacked = importClosure(file).filter((module) => !paths.includes(module));
    assert.deepEqual(unpacked, [], `the ${hook} script reaches modules the tarball lacks`);
  }

  assert.ok(
    pack.entryCount <= MAX_ENTRIES,
    `tarball grew to ${pack.entryCount} entries (ceiling ${MAX_ENTRIES}) — raise deliberately or trim 'files'`,
  );
  assert.ok(
    pack.unpackedSize <= MAX_UNPACKED_BYTES,
    `tarball grew to ${pack.unpackedSize} bytes unpacked (ceiling ${MAX_UNPACKED_BYTES})`,
  );
});
