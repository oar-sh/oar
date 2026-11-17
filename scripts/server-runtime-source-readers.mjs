#!/usr/bin/env node
/**
 * The tests that read server/server-runtime.mjs as text, and what each of
 * their assertions pins: file and line, presence or absence, the pattern, the
 * runtime section it lands in, and, for an absence, whether a positive anchor
 * proves the text it looks at is still in the file it reads. Written for
 * changes that move code out of the runtime: a moved function makes an absence
 * assertion pass for no reason and a presence assertion fail for no reason.
 *
 *   node scripts/server-runtime-source-readers.mjs           print the report
 *   node scripts/server-runtime-source-readers.mjs --write   write docs/server-runtime-source-readers.md
 *   node scripts/server-runtime-source-readers.mjs --check   exit 1 when that file is out of date
 *
 * Read-only, static and heuristic (scripts/js-scan.mjs, no parser), so the
 * report says what it could not tell rather than guess:
 * - a reader is a test file with a variable assigned from a readFileSync (or
 *   readFile) that names server-runtime.mjs, directly or through a path
 *   variable; a variable assigned from an expression that uses one (a slice,
 *   an index), or a function that uses one, reads the runtime too. Names
 *   are resolved by scope (module, function, test), so a `source` of another
 *   file in another test is not taken for the runtime's;
 * - an assertion pins the runtime when its first or second argument uses
 *   such a name; `match`, `includes(…)`, `indexOf(…) !== -1` and the like are
 *   presence, `doesNotMatch`, `!…includes(…)`, `…, false` and `…, -1` are
 *   absence, the rest (order, counts, values) is "other";
 * - the section is the runtime's `// ─── … ───` marker above the line where
 *   the pattern (a presence) or the slice's first marker string is found;
 * - an absence is anchored by its "slice" when it reads a slice made by a
 *   helper that asserts its start marker exists, by "same test" when a
 *   presence assertion on the same variable sits in the same test, else not.
 *   "same test" is a hint for the change that moves code to check by reading, not proof.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { blankComments, callArgumentsAt, closingBracket, statementEnd } from './js-scan.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const READERS_DOC = path.join(repoRoot, 'docs', 'server-runtime-source-readers.md');
const RUNTIME = 'server-runtime.mjs';

/** Offset → 1-based line. */
function lineAt(source, offset) {
  let line = 1;
  for (let i = source.indexOf('\n'); i !== -1 && i < offset; i = source.indexOf('\n', i + 1)) line += 1;
  return line;
}

/** `{ name, offset }` for each identifier in `text` that is not a property name. */
function identifierUses(text, base = 0) {
  const out = [];
  for (const match of String(text).matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
    out.push({ name: match[1], offset: base + match.index });
  }
  return out;
}

/** The scopes of `code`: function bodies and test callbacks, as `[start, end]`. */
function scopesOf(code) {
  const scopes = [];
  for (const match of code.matchAll(/\bfunction\b[^(]*\(|=>\s*\{/g)) {
    let open;
    if (match[0].startsWith('function')) {
      const params = callArgumentsAt(code, match.index + match[0].length - 1);
      if (!params) continue;
      open = code.indexOf('{', params.end);
    } else {
      open = match.index + match[0].length - 1;
    }
    if (open < 0) continue;
    const end = closingBracket(code, open);
    if (end > 0) scopes.push([open, end]);
  }
  return scopes;
}

/** The analysis of one test file: its declarations and which of them read the runtime. */
export function analyseReader(source) {
  // `code` keeps the literals (patterns, markers, paths); `shape` blanks
  // them, so a `const …` or `function …(` inside a test's regex is no code.
  // Offsets are the same in both.
  const text = source.replace(/\r\n/g, '\n');
  const code = blankComments(text);
  const shape = blankComments(text, { literals: true });
  const scopes = scopesOf(shape);
  const scopeOf = (offset) => {
    let best = null;
    for (const scope of scopes) {
      if (offset > scope[0] && offset < scope[1] && (!best || scope[1] - scope[0] < best[1] - best[0])) best = scope;
    }
    return best;
  };
  const contains = (scope, offset) => !scope || (offset > scope[0] && offset < scope[1]);

  // A function's body asserts: a slice it returns is anchored by that check.
  const asserts = (body) => /\bassert(?:\.(?:notEqual|ok|notStrictEqual))?\s*\(/.test(body);
  const decls = [];
  for (const match of shape.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    const start = match.index + match[0].length;
    const end = statementEnd(shape, start);
    decls.push({ name: match[1], offset: match.index, rhsStart: start, rhs: code.slice(start, end), shape: shape.slice(start, end), scope: scopeOf(match.index), role: null });
  }
  for (const match of shape.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const params = callArgumentsAt(shape, match.index + match[0].length - 1);
    const open = params ? shape.indexOf('{', params.end) : -1;
    const end = open < 0 ? -1 : closingBracket(shape, open);
    if (end < 0) continue;
    decls.push({
      name: match[1], offset: match.index, rhsStart: open, rhs: code.slice(open, end + 1), shape: shape.slice(open, end + 1),
      scope: scopeOf(match.index), role: null, isFunction: true, end, asserts: asserts(shape.slice(open, end + 1)),
    });
  }

  // The declaration a name means at `offset`: the innermost scope that holds
  // both, the latest one before it (a function declaration is hoisted).
  const byName = new Map();
  for (const decl of decls) byName.set(decl.name, [...(byName.get(decl.name) || []), decl]);
  const resolve = (name, offset) => {
    let best = null;
    for (const decl of byName.get(name) || []) {
      if (!contains(decl.scope, offset)) continue;
      if (!decl.isFunction && decl.offset > offset && !(decl.scope === null)) continue;
      const size = decl.scope ? decl.scope[1] - decl.scope[0] : Infinity;
      const bestSize = best ? (best.scope ? best.scope[1] - best.scope[0] : Infinity) : Infinity;
      if (!best || size < bestSize || (size === bestSize && decl.offset > best.offset && decl.offset < offset)) best = decl;
    }
    return best;
  };
  // What each name in a declaration means, worked out once.
  const meanings = new Map();
  const meaningsOf = (decl) => {
    if (!meanings.has(decl)) {
      meanings.set(decl, identifierUses(decl.shape, decl.rhsStart).map((use) => resolve(use.name, use.offset)).filter(Boolean));
    }
    return meanings.get(decl);
  };
  const usesRole = (decl, roles) => meaningsOf(decl).some((other) => roles.includes(other.role));

  for (const decl of decls) {
    if (!decl.isFunction && /['"`][^'"`\n]*server-runtime\.mjs/.test(decl.rhs) && !/readFile/.test(decl.rhs)) decl.role = 'path';
  }
  for (const decl of decls) {
    if (decl.isFunction || decl.role) continue;
    // The call is code (`shape`); the file's name is in a string (`rhs`).
    if (/\breadFile(?:Sync)?\s*\(/.test(decl.shape) && (decl.rhs.includes(RUNTIME) || usesRole(decl, ['path']))) decl.role = 'file';
  }
  if (!decls.some((decl) => decl.role === 'file')) return null;
  for (let changed = true; changed;) {
    changed = false;
    for (const decl of decls) {
      if (decl.role) continue;
      if (usesRole(decl, ['file', 'slice', 'helper'])) {
        decl.role = decl.isFunction ? 'helper' : 'slice';
        changed = true;
      }
    }
  }
  return { text, code, shape, decls, resolve };
}

const ABSENT_VALUE = /^(false|null|undefined|-1)$/;

/**
 * presence | absence | other, from the assertion's method and arguments;
 * `targetRhs` is what the variable it reads was assigned (an `indexOf` there
 * makes `notEqual(x, -1)` a presence).
 */
export function classifyAssertion(method, args, targetRhs = '') {
  const [first = '', second = ''] = args;
  if (method === 'doesNotMatch') return 'absence';
  if (method === 'match') return 'presence';
  const isIndex = /\.(indexOf|search|lastIndexOf)\s*\(/.test(first) || (/^[\w$]+$/.test(first.trim()) && /\.(indexOf|search|lastIndexOf)\s*\(/.test(targetRhs));
  if (isIndex && second.trim() === '-1') {
    if (['notEqual', 'notStrictEqual'].includes(method)) return 'presence';
    if (['equal', 'strictEqual'].includes(method)) return 'absence';
  }
  const probe = /\.(includes|test|startsWith|endsWith|indexOf|match|search)\s*\(/;
  if (method === 'ok' || method === '') {
    if (/^!/.test(first)) return 'absence';
    if (/indexOf\s*\([^)]*\)\s*(===|==)\s*-1|indexOf\s*\([^)]*\)\s*<\s*0/.test(first)) return 'absence';
    // An order (`a < b`) is neither.
    if (/(?<![=<>!])[<>]=?(?![=>])/.test(first.replace(/=>/g, ''))) return 'other';
    if (probe.test(first)) return 'presence';
    return 'other';
  }
  if (['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual'].includes(method)) {
    if (probe.test(first) && ABSENT_VALUE.test(second.trim())) return 'absence';
    if (probe.test(first) && second.trim() === 'true') return 'presence';
    return 'other';
  }
  if (['notEqual', 'notStrictEqual'].includes(method)) {
    if (probe.test(first) && /^(false|null)$/.test(second.trim())) return 'presence';
    return 'other';
  }
  return 'other';
}

const unquote = (text) => text.replace(/\\(['"\\`])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');

/** The literal an assertion looks for: a regex literal or the first string literal. */
export function patternOf(args) {
  for (const arg of args.slice(0, 2)) {
    const regex = /^\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+)\/([a-z]*)$/.exec(arg.trim());
    if (regex) return { kind: 'regex', text: regex[1], flags: regex[2] };
  }
  for (const arg of args.slice(0, 2)) {
    const string = /(['"])((?:\\.|(?!\1)[^\\])*)\1/.exec(arg);
    if (string) return { kind: 'string', text: unquote(string[2]) };
  }
  return null;
}

/** The runtime's sections: `{ line, name }` per `// ─── name ───` marker. */
export function runtimeSections(runtimeSource) {
  const sections = [{ line: 1, name: '(imports and paths)' }];
  runtimeSource.split('\n').forEach((text, index) => {
    const match = /^\/\/ ─── (.+?) ─+\s*$/.exec(text);
    if (match) sections.push({ line: index + 1, name: match[1] });
  });
  return sections;
}

function sectionAt(sections, line) {
  let found = sections[0];
  for (const section of sections) if (section.line <= line) found = section;
  return found.name;
}

function locate(runtimeSource, pattern) {
  if (!pattern) return -1;
  if (pattern.kind === 'string') return runtimeSource.indexOf(pattern.text);
  try {
    const match = new RegExp(pattern.text, pattern.flags.replace(/[gy]/g, '')).exec(runtimeSource);
    return match ? match.index : -1;
  } catch {
    return -1;
  }
}

/** Every assertion of `source` (a test file) that reads the runtime, or null when it reads none. */
export function readerAssertions(source, runtimeSource, sections = runtimeSections(runtimeSource)) {
  const analysis = analyseReader(source);
  if (!analysis) return null;
  const { text, code, shape, decls, resolve } = analysis;
  const tests = [];
  for (const match of shape.matchAll(/(?<![.\w$])(?:test|it)\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const call = callArgumentsAt(shape, open);
    if (call) tests.push([open, call.end]);
  }
  const testOf = (offset) => tests.findIndex(([start, end]) => offset > start && offset < end);
  const helpers = decls.filter((decl) => decl.role === 'helper');

  // Where a slice starts in the runtime: the longest of its literal markers
  // found there (strings, and template literals without a substitution).
  const literalLine = (snippet) => {
    let best = null;
    for (const match of String(snippet).matchAll(/(['"`])((?:\\.|(?!\1)[^\\])+)\1/g)) {
      if (match[1] === '`' && match[2].includes('${')) continue;
      const marker = unquote(match[2]);
      // A marker with no word in it (`'\n  }\n'`) places nothing.
      if (!/[A-Za-z_]{3,}/.test(marker)) continue;
      const at = runtimeSource.indexOf(marker);
      if (at >= 0 && (!best || marker.length > best.length)) best = { length: marker.length, line: lineAt(runtimeSource, at) };
    }
    return best ? best.line : null;
  };
  const anchorLine = (decl, seen = new Set()) => {
    if (!decl || seen.has(decl)) return null;
    seen.add(decl);
    const own = literalLine(decl.rhs);
    if (own) return own;
    for (const use of identifierUses(decl.shape, decl.rhsStart)) {
      const other = resolve(use.name, use.offset);
      if (other?.role === 'slice') {
        const line = anchorLine(other, seen);
        if (line) return line;
      }
    }
    return null;
  };
  // Cut by a function that asserts its markers, directly: a slice of a slice
  // cut with an unchecked indexOf can be empty, whatever its parent is.
  const sliceAsserted = (decl) => decl?.role === 'slice' && identifierUses(decl.shape, decl.rhsStart)
    .some((use) => {
      const other = resolve(use.name, use.offset);
      return other?.isFunction && other.asserts;
    });
  // The variable an assertion reads and those its slice is built from.
  const builtFrom = (decl) => new Set([decl, ...identifierUses(decl.shape, decl.rhsStart)
    .map((use) => resolve(use.name, use.offset)).filter(Boolean)]);

  const found = [];
  for (const match of shape.matchAll(/(?<![.\w$])assert(?:\.(\w+))?\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const call = callArgumentsAt(shape, open);
    if (!call) continue;
    // A helper's own marker check is what anchors its slices, not a pin.
    if (helpers.some((helper) => match.index > helper.rhsStart && match.index < helper.end)) continue;
    let target = null;
    for (const [start, end] of call.spans.slice(0, 2)) {
      for (const use of identifierUses(shape.slice(start, end), start)) {
        const decl = resolve(use.name, use.offset);
        if (decl && ['file', 'slice', 'helper'].includes(decl.role)) { target = decl; break; }
      }
      if (target) break;
    }
    if (!target) continue;
    const method = match[1] || '';
    const argTexts = call.spans.map(([start, end]) => code.slice(start, end).trim());
    const kind = classifyAssertion(method, argTexts, target.rhs);
    const pattern = patternOf(argTexts);
    const at = kind === 'absence' ? -1 : locate(runtimeSource, pattern);
    let line = at >= 0 ? lineAt(runtimeSource, at) : null;
    if (!line && target.role === 'slice') line = anchorLine(target);
    // An inline helper call (`sliceBetween('function x(', …)`): its own markers.
    if (!line && target.role === 'helper') line = literalLine(argTexts.slice(0, 2).join('\n'));
    found.push({
      line: lineAt(text, match.index),
      method: method || 'assert',
      kind,
      target: target.name,
      targetDecl: target,
      targetKind: target.role === 'file' ? 'file' : 'slice',
      pattern: pattern ? pattern.text : null,
      section: line ? sectionAt(sections, line) : '(whole file)',
      test: testOf(match.index),
    });
  }
  for (const entry of found) {
    if (entry.kind !== 'absence') continue;
    if (sliceAsserted(entry.targetDecl)) { entry.anchor = 'slice'; continue; }
    const related = builtFrom(entry.targetDecl);
    const partner = found.find((other) => other.kind === 'presence' && related.has(other.targetDecl) && other.test === entry.test && entry.test !== -1);
    entry.anchor = partner ? `same test (line ${partner.line})` : 'none';
  }
  return found.map((entry) => {
    const copy = { ...entry };
    delete copy.targetDecl;
    return copy;
  });
}

function trackedTestFiles() {
  const out = execFileSync('git', ['ls-files', '--', '*.test.mjs', '*.spec.mjs', 'tests/**/*.mjs'], { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).sort();
}

const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, '\\n').replace(/`/g, "'");
const short = (text, max = 70) => {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/** The report, as Markdown. */
export function buildReport({ files = trackedTestFiles(), read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8') } = {}) {
  const runtimeSource = read(`server/${RUNTIME}`).replace(/\r\n/g, '\n');
  const sections = runtimeSections(runtimeSource);
  const readers = [];
  const mentions = [];
  for (const file of files) {
    const source = read(file).replace(/\r\n/g, '\n');
    if (!source.includes(RUNTIME)) continue;
    const assertions = readerAssertions(source, runtimeSource, sections);
    if (assertions) readers.push({ file, assertions });
    else mentions.push(file);
  }
  const all = readers.flatMap((reader) => reader.assertions);
  const count = (kind) => all.filter((entry) => entry.kind === kind).length;
  const unanchored = readers.flatMap((reader) => reader.assertions
    .filter((entry) => entry.kind === 'absence' && entry.anchor === 'none')
    .map((entry) => ({ file: reader.file, ...entry })));
  const sectionNames = [...new Set(sections.map((section) => section.name)), '(whole file)'];

  const lines = [
    '# Tests that read `server/server-runtime.mjs` as text',
    '',
    '<!-- Generated by scripts/server-runtime-source-readers.mjs; regenerate with',
    '     `node scripts/server-runtime-source-readers.mjs --write`. Do not edit by hand. -->',
    '',
    'For changes that move code out of the runtime. When a function moves out, an absence assertion',
    'on the runtime\'s text passes for no reason and a presence assertion fails for no reason. So',
    'every change that moves code:',
    '',
    '- lists, in its description, the tests below whose section its move touches;',
    '- re-points each of them to the new module in the move commit;',
    '- gives every absence assertion it re-points a positive anchor (a presence assertion proving the',
    '  text it looks at is in the file it now reads), or it is vacuous;',
    '- and its review mutates one re-pointed test to show it still bites.',
    '',
    'The script is heuristic (no parser): read "section" as where the pattern or the slice\'s first',
    'marker is found today, "(whole file)" where neither could be placed, and an anchor of',
    '"same test" as a hint to check by reading. "slice" means the absence reads a slice whose',
    'start marker a helper asserts. "other" is an assertion on the text that is neither (an order,',
    'a count, a value read out of it). Sections are the runtime\'s own `// ─── … ───` markers, each',
    'running to the next one, so they are coarse ("Web Push" also holds the worker launch code).',
    '',
    `Readers: ${readers.length} files, ${all.length} assertions: ${count('presence')} presence, ${count('absence')} absence ` +
      `(${unanchored.length} without an anchor), ${count('other')} other.`,
    '',
    '## Absence assertions without a positive anchor',
    '',
    '| File | Line | Pattern | Section |',
    '| --- | ---: | --- | --- |',
    ...unanchored.map((entry) => `| ${cell(entry.file)} | ${entry.line} | ${entry.pattern ? `\`${cell(short(entry.pattern))}\`` : ''} | ${cell(entry.section)} |`),
    '',
    '## Assertions by section',
    '',
    '| Section | Files | Presence | Absence | Other |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...sectionNames.map((name) => {
      const inSection = readers.flatMap((reader) => reader.assertions.filter((entry) => entry.section === name).map((entry) => ({ file: reader.file, ...entry })));
      if (!inSection.length) return null;
      const files = new Set(inSection.map((entry) => entry.file)).size;
      const of = (kind) => inSection.filter((entry) => entry.kind === kind).length;
      return `| ${cell(name)} | ${files} | ${of('presence')} | ${of('absence')} | ${of('other')} |`;
    }).filter(Boolean),
    '',
    '## Every assertion, by file',
    '',
  ];
  for (const reader of readers) {
    lines.push(`### ${reader.file}`, '');
    if (!reader.assertions.length) {
      lines.push('Reads the file; no assertion on its text was recognised.', '');
      continue;
    }
    lines.push('| Line | Kind | Reads | Pattern | Section | Anchor |', '| ---: | --- | --- | --- | --- | --- |');
    for (const entry of reader.assertions) {
      lines.push(`| ${entry.line} | ${entry.kind} | ${cell(`${entry.target} (${entry.targetKind})`)} | ${entry.pattern ? `\`${cell(short(entry.pattern))}\`` : ''} | ${cell(entry.section)} | ${entry.kind === 'absence' ? cell(entry.anchor) : ''} |`);
    }
    lines.push('');
  }
  lines.push('## Files that name the runtime but do not read its text', '');
  for (const file of mentions) lines.push(`- ${file}`);
  lines.push('');
  return lines.join('\n');
}

async function main(argv) {
  const report = buildReport();
  if (argv.includes('--write')) {
    fs.writeFileSync(READERS_DOC, report);
    process.stdout.write(`wrote ${path.relative(repoRoot, READERS_DOC)}\n`);
    return 0;
  }
  if (argv.includes('--check')) {
    const current = fs.existsSync(READERS_DOC) ? fs.readFileSync(READERS_DOC, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current === report) return 0;
    process.stdout.write(`${path.relative(repoRoot, READERS_DOC)} is out of date: run node scripts/server-runtime-source-readers.mjs --write\n`);
    return 1;
  }
  process.stdout.write(report);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
