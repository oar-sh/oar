import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The guard behind "every place that builds the database path goes through
// the one resolver": the legacy file name is spelt only in
// database-file.mjs. A path built by hand would open, and so create, an
// empty database under that name, which the next start then compares.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEGACY = /copilot\.db/;
// A path built by hand with the current name: the file name as a whole
// string ('oar.db', '…/oar.db'), outside usage text and comments.
const CURRENT_LITERAL = /(['"`])(?:[^'"`\s]*[/\\])?oar\.db(?:-wal|-shm)?\1/;
// Either name glued together.
const GLUED = /['"`](copilot|oar)['"`]\s*\+\s*['"`]\.db/;
const SCANNED = ['server', 'bin', 'shared', 'scripts', path.join('.github', 'extensions')];
const SKIPPED_DIRS = new Set(['node_modules', 'fixtures', 'test-results']);
const OWNER = path.join('server', 'services', 'database-file.mjs');

function codeFiles(dir, found = []) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) codeFiles(relative, found);
    } else if (/\.(mjs|cjs|js)$/.test(entry.name) && !/\.(test|spec)\.mjs$/.test(entry.name)) {
      found.push(relative);
    }
  }
  return found;
}

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
const migrations = codeFiles(path.join('server', 'migrations'));

test('no code outside database-file.mjs names copilot.db, or builds a path with oar.db (a migration\'s comment may, for history)', () => {
  const files = SCANNED.flatMap((dir) => codeFiles(dir));
  assert.ok(files.length > 100, 'the scan sees the code');
  const offenders = [];
  for (const file of files) {
    if (file === OWNER) continue;
    const inMigrations = file.startsWith(path.join('server', 'migrations') + path.sep);
    fs.readFileSync(path.join(repoRoot, file), 'utf8').split(/\r?\n/).forEach((line, index) => {
      const legacy = LEGACY.test(line) && !(inMigrations && isComment(line));
      const current = !isComment(line) && (CURRENT_LITERAL.test(line) || GLUED.test(line));
      if (legacy || current) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'build the path with resolveDatabaseFile / cliDbPath (server/services/database-file.mjs)');
});

test('every migration run by hand finds its database through cliDbPath, never a path of its own', () => {
  assert.ok(migrations.length >= 35, 'every migration');
  for (const file of migrations) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    assert.match(source, /^import \{ cliDbPath \} from (['"])\.\.\/services\/database-file\.mjs\1;?$/m, file);
    assert.match(source, /const dbPath = cliDbPath\(process\.argv\[2\], new URL\('\.\.', import\.meta\.url\)\);/, file);
    assert.doesNotMatch(source, /defaultDbPath|'data', '[^']*\.db'/, file);
  }
  const importer = fs.readFileSync(path.join(repoRoot, 'server', 'services', 'deepseek-usage-import.mjs'), 'utf8');
  assert.match(importer, /const dbPath = cliDbPath\(dbArg, new URL\('\.\.', import\.meta\.url\)\);/);
  assert.match(importer, /dbPath = cliDbPath\(null, new URL\('\.\.', import\.meta\.url\)\)/);
});

test('the scan catches a hand-built path under either name, glued or whole', () => {
  const line = "const dbPath = path.join(DATA_DIR, 'copilot.db');";
  assert.ok(LEGACY.test(line) && !isComment(line));
  for (const each of ["path.join(dir, 'oar.db')", 'path.join(dir, "data/oar.db")', "`oar.db-wal`", "'copilot' + '.db'", '"oar" + ".db"']) {
    assert.ok(CURRENT_LITERAL.test(each) || GLUED.test(each), each);
  }
  assert.ok(!CURRENT_LITERAL.test("console.error('Usage: x [path/to/oar.db]')"), 'usage text is no path');
  assert.ok(isComment(' * Usage: node server/migrations/0001-x.mjs [path/to/copilot.db]'));
});
