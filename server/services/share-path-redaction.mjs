'use strict';

// Path privacy for shared conversations: what a share link serves of the relay
// host's paths and file names. Pure functions; the share routes build one
// redactor per response and run it over the whole payload, so raw paths never
// leave the relay. The owner's own view never passes through here.
//
// Modes (shared/share-path-privacy.mjs): `show` leaves everything, `filename`
// drops the directories and keeps the file name, `hide` puts a placeholder in
// place of path and name.
//
// Two tiers:
// - Reliable: fields that are a path by their key (`path`, `cwd`, `file_path`,
//   `…Path`, `…Root`…), attachment names, `@file:`/`@folder:` mentions (also
//   relative ones), diff and patch file headers, and the input of a tool call
//   stored as JSON. The whole value is a path, whatever it looks like.
// - Best effort: every other string (replies, thoughts, tool lines, code
//   blocks, quoted tool output). In one pass, leftmost match first:
//   1. http(s)/ws(s) URLs and the relay's own `/api/…` and `/shared/…` URLs
//      are kept as they are (the query of an `/api/` URL is filtered);
//   2. file:// URLs;
//   3. the known roots (conversation cwd, workspace roots, home, the relay's
//      data and upload dirs) with whatever path follows them: these also
//      match with spaces in the root, any case and either separator on
//      Windows;
//   4. absolute Windows paths (C:\…, C:/…, \\server\share\…), `~/…` and
//      multi-segment Unix paths (/a/b…);
//   5. the OS user name as a segment between separators.
//   Relative paths are left alone, and so are single-segment ones (/tmp).
//   Markdown and code fences keep their structure: a path never swallows
//   brackets, parentheses, backticks, quotes, `*` or `|`.
//
// Preview (`annotate: true`): every replacement is wrapped in
// SHARE_PREVIEW_MARKS.redactedStart/End, and whatever still looks like a path
// afterwards (a relative path with a file extension, a `home/x` or
// `Users/x` segment, the user name as a word, and in `show` mode every
// absolute path) in suspectStart/End. The original is never sent. The marks
// are private-use characters; the browser turns them into highlights
// (public/app/share-preview-marks.mjs). Mark characters already in the input
// are dropped first, so they only ever mean what this module put there.

import {
  DEFAULT_SHARE_PATH_PRIVACY_MODE,
  SHARE_PATH_PRIVACY_MODES,
} from '../../shared/share-path-privacy.mjs';

export const SHARE_PATH_PLACEHOLDER = '‹hidden›';

export const SHARE_PREVIEW_MARKS = Object.freeze({
  redactedStart: '\uE000',
  redactedEnd: '\uE001',
  suspectStart: '\uE002',
  suspectEnd: '\uE003',
});

const MARK_CHARS_RE = /[\uE000-\uE003]/g;
const MARKED_REGION_SPLIT_RE = /(\uE000[^\uE001]*\uE001)/;

// What ends a path in free text: whitespace, separators, quotes, brackets and
// the markdown characters that may stand right after one.
const STOP_COMMON = '\\s\\\\/<>"\'`()\\[\\]{}|*,;\\uE000-\\uE003';
// A Unix segment may hold `:` (a line number, a route parameter).
const SEG_U = `[^${STOP_COMMON}]`;
// A Windows segment never holds `:` or `?`.
const SEG_W = `[^${STOP_COMMON}:?]`;
const NOT_AFTER = '(?<![\\w.\\-~/\\\\$%])';
const URL_TAIL = '[^\\s<>"\'`]+';
const RELAY_URL_TAIL = '[^\\s<>"\'`()\\[\\]{}|]*';

// Paths that name nothing of the host.
const NEUTRAL_PATHS = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr']);
const TRAILING_PUNCTUATION_RE = /[.:!?]+$/;
const MIN_USER_NAME_LENGTH = 2;
const MIN_SUSPECT_USER_NAME_LENGTH = 3;
const MAX_WALK_DEPTH = 64;
const MAX_JSON_TEXT_CHARS = 256 * 1024;

// Keys whose value is a path, whatever it looks like.
const PATH_KEY_RE = /^(?:path|paths|cwd|dir|directory|folder|reference|file_path|notebook_path|filepath|filename)$|(?:Path|Paths|Root|Roots|Cwd|Dir|Directory)$/;
// Keys that never hold a path: ids, hashes, times.
const SKIP_KEY_RE = /^(?:id|sha256|token|timestamp|seq)$|(?:Id|Ids|At)$/;
// An attachment's own name.
const ATTACHMENT_NAME_KEY_RE = /^(?:name|fileName|file_name|originalName)$/;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function caseless(value) {
  return [...String(value)]
    .map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : escapeRegExp(ch)))
    .join('');
}

function isWindowsStyle(value) {
  return /^[A-Za-z]:/.test(value) || value.includes('\\');
}

/** The roots as they can be matched: absolute, without trailing separators, longest first. */
export function normalizeKnownRoots(roots = []) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(roots) ? roots : [roots]) {
    let value = String(raw ?? '').trim();
    if (!value) continue;
    const windows = isWindowsStyle(value);
    value = value.replace(/[\\/]+$/, '');
    const absolute = windows ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(`${value}\\`) : value.startsWith('/');
    if (!absolute) continue;
    // A drive or the file system root alone says nothing and would match everywhere.
    const segments = value.split(/[\\/]+/).filter((part) => part && !/^[A-Za-z]:$/.test(part));
    if (!segments.length) continue;
    const key = windows ? value.replace(/\//g, '\\').toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.sort((a, b) => b.length - a.length);
}

// A separator is one character, or two for a backslash escaped in JSON: an
// unbounded run would make every position of a run of slashes a new attempt
// over the whole run.
function rootSource(root) {
  const windows = isWindowsStyle(root);
  const parts = root.split(/[\\/]+/);
  const sep = windows ? '(?:\\\\{1,2}|/)' : '/';
  return parts.map((part) => (windows ? caseless(part) : escapeRegExp(part))).join(sep);
}

function normalizeUserNames(userNames = []) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(userNames) ? userNames : [userNames]) {
    const value = String(raw ?? '').trim();
    if (value.length < MIN_USER_NAME_LENGTH || /[\s\\/]/.test(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.sort((a, b) => b.length - a.length);
}

function normalizeRelayPathPrefix(value) {
  const prefix = String(value || '').trim().replace(/\/+$/, '');
  if (!prefix || prefix === '/') return '';
  return prefix.startsWith('/') ? prefix : `/${prefix}`;
}

function normalizeMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  return SHARE_PATH_PRIVACY_MODES.includes(value) ? value : DEFAULT_SHARE_PATH_PRIVACY_MODE;
}

/** The last segment of a path; '' for a root, a drive or a bare `~`. */
export function pathBaseName(value) {
  const trimmed = String(value || '').replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]+/);
  const last = parts[parts.length - 1] || '';
  if (/^[A-Za-z]:$/.test(last) || last === '~') return '';
  return last;
}

/**
 * A redactor for one response. `roots` are the known absolute roots, `userNames`
 * the OS user name(s), `relayPathPrefix` the relay's mount path (its URLs are
 * kept). Returns `{ mode, text, path, name, payload }`.
 */
export function createSharePathRedactor({
  mode = DEFAULT_SHARE_PATH_PRIVACY_MODE,
  roots = [],
  userNames = [],
  relayPathPrefix = '',
  annotate = false,
} = {}) {
  const resolvedMode = normalizeMode(mode);
  const knownRoots = normalizeKnownRoots(roots);
  const names = normalizeUserNames(userNames);
  const namesLower = new Set(names.map((name) => name.toLowerCase()));
  const prefix = normalizeRelayPathPrefix(relayPathPrefix);
  const prefixSource = prefix ? `(?:${escapeRegExp(prefix)})?` : '';
  const marks = SHARE_PREVIEW_MARKS;

  const httpUrl = `\\b(?:https?|wss?):\\/\\/${URL_TAIL}`;
  const relayUrl = `${NOT_AFTER}${prefixSource}\\/(?:api|shared)\\/${RELAY_URL_TAIL}`;
  const mention = `@(?:file|folder):[^\\s\`<>()\\[\\]"']+`;
  const fileUrl = `\\bfile:\\/\\/[^\\s<>"'\`()\\[\\]{}|]+`;
  const known = knownRoots.length
    ? `(?<![\\w.\\-~])(?:${knownRoots.map(rootSource).join('|')})(?!${SEG_U})(?:[\\\\/]+${SEG_U}+)*[\\\\/]*`
    : null;
  const win = `(?<![\\w.\\-])[A-Za-z]:[\\\\/]+(?:${SEG_W}+[\\\\/]+)*${SEG_W}*`;
  const unc = `(?<![\\w\\\\/])\\\\\\\\${SEG_W}+(?:\\\\+${SEG_W}+)+`;
  const tilde = `(?<![\\w.\\-~/\\\\])~[\\w.\\-]*[\\\\/]+(?:${SEG_U}+[\\\\/]+)*${SEG_U}*`;
  const unix = `${NOT_AFTER}\\/(?:${SEG_U}+\\/+)+${SEG_U}*`;
  const userSegment = names.length
    ? `(?<=[\\\\/])(?:${names.map(caseless).join('|')})(?=[\\\\/])`
    : null;

  const alternatives = [
    ['http', httpUrl],
    ['relay', relayUrl],
    ['mention', mention],
    ['fileUrl', fileUrl],
    ...(known ? [['known', known]] : []),
    ['win', win],
    ['unc', unc],
    ['tilde', tilde],
    ['unix', unix],
    ...(userSegment ? [['user', userSegment]] : []),
  ];
  const groupNames = alternatives.map(([name]) => name);
  const freeTextSource = alternatives.map(([, source]) => `(${source})`).join('|');

  // Diff and patch headers name a file whatever the path looks like.
  const DIFF_GIT_RE = /^(diff --git )a\/(\S+) b\/(\S+)$/gm;
  const DIFF_SIDE_RE = /^((?:---|\+\+\+) )((?:a\/|b\/)?)(\S*[\\/.]\S*)$/gm;
  const PATCH_FILE_RE = /^(\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: |Index: )(\S.*)$/gm;

  const suspectNames = names.filter((entry) => entry.length >= MIN_SUSPECT_USER_NAME_LENGTH);
  const suspectAlternatives = [
    ['http', httpUrl],
    ['relay', relayUrl],
    ['absolute', [fileUrl, ...(known ? [known] : []), win, unc, tilde, unix].join('|')],
    ['relative', '(?<![\\w.\\-/\\\\])[\\w.\\-]+(?:[\\\\/][\\w.\\-]+)+'],
    ...(suspectNames.length ? [['user', `(?<![\\w.\\-])(?:${suspectNames.map(caseless).join('|')})(?![\\w\\-])`]] : []),
  ];
  const suspectKinds = suspectAlternatives.map(([kind]) => kind);
  const suspectSource = suspectAlternatives.map(([, source]) => `(${source})`).join('|');

  const markRedacted = (original, replacement) => {
    if (!annotate || replacement === original) return replacement;
    return `${marks.redactedStart}${replacement}${marks.redactedEnd}`;
  };

  const isUserName = (value) => namesLower.has(String(value || '').toLowerCase());

  // One path as the mode shows it, marked in a preview when it changed.
  // `strict` (a structured field): even a bare name is hidden in `hide` mode.
  function renderPath(raw, { strict = false } = {}) {
    const value = String(raw ?? '');
    if (!value || resolvedMode === 'show') return value;
    if (NEUTRAL_PATHS.has(value)) return value;
    const base = pathBaseName(value);
    if (!base) return strict && resolvedMode === 'hide' ? markRedacted(value, SHARE_PATH_PLACEHOLDER) : value;
    if (resolvedMode === 'hide' || isUserName(base)) return markRedacted(value, SHARE_PATH_PLACEHOLDER);
    return markRedacted(value, base);
  }

  // Trailing sentence punctuation stays outside the path.
  function renderTrimmed(match, options) {
    const tail = match.match(TRAILING_PUNCTUATION_RE)?.[0] || '';
    const core = tail ? match.slice(0, -tail.length) : match;
    if (!core) return match;
    return `${renderPath(core, options)}${tail}`;
  }

  function renderFileUrl(match) {
    const tail = match.match(TRAILING_PUNCTUATION_RE)?.[0] || '';
    const core = tail ? match.slice(0, -tail.length) : match;
    let target = core.replace(/^file:\/\//i, '');
    try { target = decodeURIComponent(target); } catch {}
    const base = pathBaseName(target);
    let replacement;
    if (resolvedMode === 'hide' || !base || isUserName(base)) replacement = SHARE_PATH_PLACEHOLDER;
    else replacement = base;
    return `${markRedacted(core, replacement)}${tail}`;
  }

  function renderMention(match) {
    const colon = match.indexOf(':');
    const head = match.slice(0, colon + 1);
    const rest = match.slice(colon + 1);
    const tail = rest.match(TRAILING_PUNCTUATION_RE)?.[0] || '';
    const core = tail ? rest.slice(0, -tail.length) : rest;
    if (!core) return match;
    return `${head}${renderPath(core, { strict: true })}${tail}`;
  }

  // The path of a relay URL is the relay's; its query can carry a host path.
  function renderRelayUrl(match) {
    const query = match.indexOf('?');
    if (query === -1) return match;
    return `${match.slice(0, query + 1)}${redactFreeText(match.slice(query + 1))}`;
  }

  function redactFreeText(text) {
    const re = new RegExp(freeTextSource, 'g');
    return text.replace(re, (match, ...groups) => {
      const index = groups.findIndex((group, position) => position < groupNames.length && group !== undefined);
      const kind = groupNames[index];
      switch (kind) {
        case 'http': return match;
        case 'relay': return renderRelayUrl(match);
        case 'mention': return renderMention(match);
        case 'fileUrl': return renderFileUrl(match);
        case 'user': return markRedacted(match, SHARE_PATH_PLACEHOLDER);
        default: return renderTrimmed(match);
      }
    });
  }

  function redactHeaders(text) {
    if (!/^(?:diff --git |--- |\+\+\+ |\*\*\* |Index: )/m.test(text)) return text;
    return text
      .replace(DIFF_GIT_RE, (_match, head, left, right) => `${head}a/${renderPath(left, { strict: true })} b/${renderPath(right, { strict: true })}`)
      .replace(DIFF_SIDE_RE, (_match, head, side, target) => `${head}${side}${renderPath(target, { strict: true })}`)
      .replace(PATCH_FILE_RE, (_match, head, target) => `${head}${renderPath(target.trim(), { strict: true })}`);
  }

  function flagSuspects(text) {
    const re = new RegExp(suspectSource, 'g');
    const flag = (match) => {
      const core = match.replace(TRAILING_PUNCTUATION_RE, '');
      if (!core) return match;
      return `${marks.suspectStart}${core}${marks.suspectEnd}${match.slice(core.length)}`;
    };
    const flagPart = (part) => part.replace(re, (match, ...groups) => {
      const index = groups.findIndex((group, position) => position < suspectKinds.length && group !== undefined);
      switch (suspectKinds[index]) {
        case 'relay': {
          const query = match.indexOf('?');
          return query === -1 ? match : `${match.slice(0, query + 1)}${flagPart(match.slice(query + 1))}`;
        }
        case 'absolute':
          return NEUTRAL_PATHS.has(match.replace(TRAILING_PUNCTUATION_RE, '')) ? match : flag(match);
        case 'relative': {
          const core = match.replace(TRAILING_PUNCTUATION_RE, '');
          return /\.[A-Za-z0-9]{1,10}$/.test(core) || /(?:^|[\\/])(?:home|users)[\\/]/i.test(core) ? flag(match) : match;
        }
        case 'user': return flag(match);
        default: return match;
      }
    });
    return text
      .split(MARKED_REGION_SPLIT_RE)
      .map((part, index) => (index % 2 === 1 || !part ? part : flagPart(part)))
      .join('');
  }

  /** Free text: replies, thoughts, tool lines, code blocks. */
  function text(value) {
    if (typeof value !== 'string' || !value) return value;
    let out = annotate ? value.replace(MARK_CHARS_RE, '') : value;
    if (resolvedMode !== 'show') out = redactFreeText(redactHeaders(out));
    if (annotate) out = flagSuspects(out);
    return out;
  }

  /** A field that is a path by its key: the whole value is one. */
  function path(value) {
    if (typeof value !== 'string' || !value) return value;
    const clean = annotate ? value.replace(MARK_CHARS_RE, '') : value;
    const trimmed = clean.trim();
    if (!trimmed) return clean;
    if (/^(?:https?|wss?):\/\//i.test(trimmed)) return text(clean);
    if (/^file:\/\//i.test(trimmed)) return resolvedMode === 'show' ? text(clean) : renderFileUrl(trimmed);
    if (trimmed.startsWith('@') && !/^@(?:file|folder):/i.test(trimmed)) {
      const rendered = `@${renderPath(trimmed.slice(1), { strict: true })}`;
      return resolvedMode === 'show' ? text(clean) : rendered;
    }
    if (/^@(?:file|folder):/i.test(trimmed)) return resolvedMode === 'show' ? text(clean) : renderMention(trimmed);
    if (resolvedMode === 'show') return text(clean);
    return renderPath(trimmed, { strict: true });
  }

  /** An attachment's file name: hidden only in `hide` mode. */
  function name(value) {
    if (typeof value !== 'string' || !value) return value;
    const clean = annotate ? value.replace(MARK_CHARS_RE, '') : value;
    if (resolvedMode === 'hide') return markRedacted(clean, SHARE_PATH_PLACEHOLDER);
    return text(clean);
  }

  // A tool call's input stored as JSON: its path fields are known by key.
  // Unchanged input keeps its own formatting.
  function jsonText(value, depth) {
    if (resolvedMode === 'show') return null;
    const trimmed = value.trim();
    if (trimmed.length > MAX_JSON_TEXT_CHARS || !trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const walked = walk(parsed, depth + 1, {});
    if (JSON.stringify(walked) === JSON.stringify(parsed)) return annotate ? value.replace(MARK_CHARS_RE, '') : value;
    return JSON.stringify(walked, null, trimmed.includes('\n') ? 2 : undefined);
  }

  function walk(node, depth, { key = '', inAttachments = false } = {}) {
    if (depth > MAX_WALK_DEPTH) return node;
    if (typeof node === 'string') {
      if (!node) return node;
      if (key && SKIP_KEY_RE.test(key)) return node;
      if (key && PATH_KEY_RE.test(key)) return path(node);
      if (inAttachments && ATTACHMENT_NAME_KEY_RE.test(key)) return name(node);
      return jsonText(node, depth) ?? text(node);
    }
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
      const pathList = key && PATH_KEY_RE.test(key);
      return node.map((item) => (pathList && typeof item === 'string'
        ? path(item)
        : walk(item, depth + 1, { key: pathList ? '' : key, inAttachments })));
    }
    if (typeof node.toJSON === 'function') return walk(node.toJSON(), depth + 1, { key, inAttachments });
    const out = {};
    for (const [childKey, item] of Object.entries(node)) {
      const attachmentList = childKey === 'attachments' || childKey === 'draftAttachments';
      out[childKey] = walk(item, depth + 1, {
        key: childKey,
        inAttachments: attachmentList || (inAttachments && !Array.isArray(item) && typeof item !== 'object'),
      });
    }
    return out;
  }

  /** Every string of a JSON-like value, by the rules above. Returns a copy. */
  function payload(value) {
    if (resolvedMode === 'show' && !annotate) return value;
    return walk(value, 0, {});
  }

  return { mode: resolvedMode, text, path, name, payload };
}
