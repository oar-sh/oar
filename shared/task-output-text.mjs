// The text pipeline of a background task's console output: what the relay
// does to a shell or Monitor task's log before anyone sees it, and the
// pieces a viewer needs to show it.
//
//  - stripControlKeepSgr: terminal control codes out, colours (SGR) kept.
//  - createLineFolder: a stream fed in arbitrary pieces becomes lines; a `\r`
//    redraw (progress bars) collapses to its final state, adjacent identical
//    lines fold into one with a count, and a line is cut at 4,000 characters.
//  - ansiToSegments: one line as styled segments, 16 colours.
//  - scrubTaskOutput / scrubSecrets: credentials out before output leaves the
//    relay (the page, a paired relay's agent).
//  - parseRunnerSummary: pass/fail counts of the common test runners.
//  - stallMinutes and the stall setting's bounds.
//
// Pure ESM with no Node imports: the relay uses it for the REST tail, the
// health poller and the remote action. The browser cannot import shared/
// (only server/public is served); server/public/app/task-output-text.mjs keeps
// a copy of the folder, the segments and the stall minutes, and its test pins
// it to this module.

// ─── Limits ──────────────────────────────────────────────────────────────────

export const TASK_OUTPUT_LIMITS = Object.freeze({
  // Initial tail: this many lines or this many bytes, whichever comes first.
  tailLinesDefault: 2000,
  tailLinesMax: 5000,
  requestBytesMax: 256 * 1024,
  // What a modal loads in total, paging back.
  modalBytesMax: 5 * 1024 * 1024,
  // One live emit, and the window the health poller parses.
  chunkBytes: 64 * 1024,
  healthBytes: 64 * 1024,
  lineCharsMax: 4000,
  outputPathMax: 1024,
  // A shell task's command line on its row.
  commandCharsMax: 2000,
  // Ended rows: kept this long, at most this many per conversation.
  endedKeepMs: 60 * 60 * 1000,
  endedMax: 20,
  // The worker's spool stops appending here.
  spoolBytesMax: 50 * 1024 * 1024,
  // The remote action's tail.
  remoteLinesDefault: 200,
  remoteLinesMax: 500,
  remoteBytesMax: 32 * 1024,
});

export const TASK_OUTPUT_KINDS = Object.freeze(['file', 'spool', 'snapshot', 'none']);

/** The kind a task row's output has: what it names, else `file` with a path and `none` without. */
export function normalizeTaskOutputKind(kind, outputPath) {
  const text = String(kind ?? '').trim().toLowerCase();
  if (TASK_OUTPUT_KINDS.includes(text)) return text;
  return outputPath ? 'file' : 'none';
}

/**
 * The path a worker names for a task's output, or '' when it is not one the
 * relay reads: absolute (POSIX or a Windows drive / UNC path), at most 1,024
 * characters, no NUL. Pure string checks; the relay's reader also refuses
 * symlinks and anything that is not a regular file.
 */
export function normalizeTaskOutputPath(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > TASK_OUTPUT_LIMITS.outputPathMax || text.includes('\0')) return '';
  const absolute = text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\');
  return absolute ? text : '';
}

// ─── The stall setting ───────────────────────────────────────────────────────

// "Mark a background task as quiet after N minutes" (app_settings key
// task_stall_minutes).
export const TASK_STALL_MINUTES_MIN = 1;
export const TASK_STALL_MINUTES_MAX = 120;
export const DEFAULT_TASK_STALL_MINUTES = 10;
export const TASK_STALL_MINUTES_SETTING_KEY = 'task_stall_minutes';

export function normalizeTaskStallMinutes(value, fallback = DEFAULT_TASK_STALL_MINUTES) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(TASK_STALL_MINUTES_MAX, Math.max(TASK_STALL_MINUTES_MIN, Math.round(number)));
}

/** An unset or unreadable setting is the default. */
export function readTaskStallMinutesSetting(storedValue) {
  return normalizeTaskStallMinutes(storedValue);
}

export function parseTaskStallMinutesUpdate(value) {
  const minutes = normalizeTaskStallMinutes(value, null);
  if (minutes === null) return { ok: false, error: 'minutes must be a number' };
  return { ok: true, minutes };
}

function toMillis(value) {
  if (value == null || value === '') return NaN;
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  return Date.parse(String(value));
}

/** Whole minutes since the last output, or null when unknown. */
export function stallMinutes(lastOutputAt, now = Date.now()) {
  const last = toMillis(lastOutputAt);
  const current = toMillis(now);
  if (!Number.isFinite(last) || !Number.isFinite(current) || last <= 0) return null;
  return Math.max(0, Math.floor((current - last) / 60_000));
}

// ─── Control codes ───────────────────────────────────────────────────────────

// SGR (colours and text style) is the only escape kept. Its parameters are
// digits and semicolons; the colon form is rare and goes with the rest.
const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
// OSC (titles, hyperlinks, clipboard): ESC ] … BEL | ST, stripped whole. An
// unterminated one at the end is stripped to the end.
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g;
// Every CSI (cursor moves, erases, modes) that is not SGR.
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// Character-set designations (ESC ( B) and the remaining two-byte escapes.
const CHARSET_PATTERN = /\x1b[()*+\-./][0-~]/g;
// The remaining two-byte escapes (ESC 7, ESC =, ESC M, a CSI cut short) and
// a lone ESC; never the start of a kept SGR.
const OTHER_ESCAPE_PATTERN = /\x1b(?!\[[0-9;]*m)[0-~]?/g;
// C0 except \t \n \r, DEL, C1, and a lone ESC left over.
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f]/g;

/**
 * Drops OSC, every CSI but SGR, the other escapes, C1 and C0 controls except
 * `\n`, `\r` and `\t`; keeps `ESC [ … m`.
 */
export function stripControlKeepSgr(text) {
  const value = String(text ?? '');
  if (!/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) return value;
  return value
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, (match) => (/^\x1b\[[0-9;]*m$/.test(match) ? match : ''))
    .replace(CHARSET_PATTERN, '')
    .replace(OTHER_ESCAPE_PATTERN, '')
    .replace(CONTROL_PATTERN, '');
}

/** The text without its SGR codes: what a reader without colours sees. */
export function stripSgr(text) {
  return String(text ?? '').replace(SGR_PATTERN, '');
}

// ─── Lines ───────────────────────────────────────────────────────────────────

function cutLine(text) {
  return text.length > TASK_OUTPUT_LIMITS.lineCharsMax ? text.slice(0, TASK_OUTPUT_LIMITS.lineCharsMax) : text;
}

// A line's final state: a `\r` not followed by `\n` discards what came before
// it (a trailing one still waits for what follows).
function finalLineState(raw) {
  const body = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  const at = body.lastIndexOf('\r');
  return at === -1 ? body : body.slice(at + 1);
}

/**
 * Lines from a stream fed in arbitrary pieces. `feed(text)` returns
 * `{ lines, partial, changedFrom }`: every completed line so far as
 * `{ text, count }` (adjacent identical lines folded, `count` unbounded), the
 * open partial line in its current state ('' when there is none), and the
 * index of the first line this feed added or changed (a folded repeat bumps
 * the count of the line before). `end()` closes the partial line and returns
 * the same shape. `lines` is the folder's own array: copy it to keep it.
 */
export function createLineFolder() {
  const lines = [];
  let partial = '';
  let changedFrom = 0;

  function push(text) {
    const line = cutLine(text);
    const last = lines[lines.length - 1];
    if (last && last.text === line) {
      last.count += 1;
      changedFrom = Math.min(changedFrom, lines.length - 1);
    } else {
      changedFrom = Math.min(changedFrom, lines.length);
      lines.push({ text: line, count: 1 });
    }
  }

  function result() {
    const out = { lines, partial: finalLineState(partial), changedFrom };
    changedFrom = lines.length;
    return out;
  }

  return {
    feed(text) {
      const chunk = String(text ?? '');
      if (chunk) {
        const parts = (partial + chunk).split('\n');
        partial = parts.pop();
        for (const raw of parts) push(finalLineState(raw));
        // The open line stays small: a progress bar redraws itself
        // thousands of times on one line.
        const keepCr = partial.endsWith('\r');
        partial = cutLine(finalLineState(partial)) + (keepCr ? '\r' : '');
      }
      return result();
    },
    end() {
      const last = finalLineState(partial);
      partial = '';
      if (last) push(last);
      return result();
    },
    get lines() {
      return lines;
    },
  };
}

/**
 * A whole text as the line model the console shows: `{ text, count, ansi }`
 * per line (`ansi` when it carries colour codes), the last one marked
 * `partial` when the text does not end with a newline.
 */
export function foldTaskOutput(text) {
  const folder = createLineFolder();
  const { lines, partial } = folder.feed(text);
  const model = lines.map((line) => ({ text: line.text, count: line.count, ansi: line.text.includes('\x1b') }));
  if (partial) model.push({ text: partial, count: 1, ansi: partial.includes('\x1b'), partial: true });
  return model;
}

// ─── Colours ─────────────────────────────────────────────────────────────────

// The 16-colour palette (xterm defaults), for mapping 256 and truecolor.
const PALETTE_16 = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

function nearest16([r, g, b]) {
  let best = 0;
  let bestDistance = Infinity;
  PALETTE_16.forEach(([pr, pg, pb], index) => {
    const distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

function rgbOf256(n) {
  if (n < 16) return PALETTE_16[n];
  if (n >= 232) {
    const level = 8 + (n - 232) * 10;
    return [level, level, level];
  }
  const index = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return [steps[Math.floor(index / 36)], steps[Math.floor(index / 6) % 6], steps[index % 6]];
}

function clampByte(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(255, Math.max(0, number)) : 0;
}

function plainStyle() {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false };
}

function applySgr(state, params) {
  const codes = params === '' ? [0] : params.split(';').map((part) => (part === '' ? 0 : Number(part)));
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === 0) Object.assign(state, plainStyle());
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code >= 30 && code <= 37) state.fg = code - 30;
    else if (code === 39) state.fg = null;
    else if (code >= 40 && code <= 47) state.bg = code - 40;
    else if (code === 49) state.bg = null;
    else if (code >= 90 && code <= 97) state.fg = code - 90 + 8;
    else if (code >= 100 && code <= 107) state.bg = code - 100 + 8;
    else if (code === 38 || code === 48) {
      const key = code === 38 ? 'fg' : 'bg';
      if (codes[i + 1] === 5 && i + 2 < codes.length) {
        state[key] = nearest16(rgbOf256(Math.min(255, Math.max(0, codes[i + 2] || 0))));
        i += 2;
      } else if (codes[i + 1] === 2 && i + 4 < codes.length) {
        state[key] = nearest16([clampByte(codes[i + 2]), clampByte(codes[i + 3]), clampByte(codes[i + 4])]);
        i += 4;
      } else {
        break;
      }
    }
  }
}

/**
 * One line as styled segments `{ text, fg, bg, bold, dim, italic, underline }`,
 * colours 0–15 or null (256 and truecolor mapped to the nearest of the 16).
 * Inverse text (SGR 7, until 27 or 0) comes with its colours already swapped
 * and `inverse: true`: a null `fg` then means the default background as the
 * text colour, a null `bg` the default text colour as the background (the
 * filled RUN / PASS / FAIL badges of vitest). Adjacent segments never share a
 * style. Any escape that is not SGR is dropped from the text.
 */
export function ansiToSegments(lineText) {
  const text = String(lineText ?? '');
  const state = plainStyle();
  const segments = [];
  const pushText = (value) => {
    const clean = stripControlKeepSgr(value).replace(/\x1b/g, '');
    if (!clean) return;
    const fg = state.inverse ? state.bg : state.fg;
    const bg = state.inverse ? state.fg : state.bg;
    const last = segments[segments.length - 1];
    if (last && last.fg === fg && last.bg === bg && last.bold === state.bold && last.dim === state.dim
      && last.italic === state.italic && last.underline === state.underline && !!last.inverse === state.inverse) {
      last.text += clean;
      return;
    }
    const segment = { text: clean, fg, bg, bold: state.bold, dim: state.dim, italic: state.italic, underline: state.underline };
    if (state.inverse) segment.inverse = true;
    segments.push(segment);
  };
  let at = 0;
  const pattern = new RegExp(SGR_PATTERN.source, 'g');
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    pushText(text.slice(at, match.index));
    applySgr(state, match[1]);
    at = match.index + match[0].length;
  }
  pushText(text.slice(at));
  return segments;
}

// ─── Secrets ─────────────────────────────────────────────────────────────────

const REDACTED = '[redacted]';

// The generic rule of the CLI helpers (services/cli-process-runner.mjs):
// anything token-shaped. Right for a login's error tail, too eager for a
// test log (long snake_case test names, 40-character commit ids).
const CLI_TOKEN_PATTERNS = Object.freeze([
  /sk-ant-[A-Za-z0-9_-]+/g,
  /[A-Za-z0-9_-]{32,}/g,
]);

/**
 * Redacts anything token-shaped plus an exact secret the caller knows it
 * handed over (the pasted Claude login code), so an error tail can be
 * surfaced to the UI without leaking a credential. Long PKCE segments in an
 * authorize URL get caught by the generic rule too, which is fine: the URL is
 * already carried in the login payload. (Moved here from
 * services/cli-process-runner.mjs, which re-exports it.)
 */
export function scrubSecrets(text, submittedCode = '') {
  let output = String(text == null ? '' : text);
  const code = String(submittedCode == null ? '' : submittedCode).trim();
  if (code.length >= 4) {
    output = output.split(code).join(REDACTED);
  }
  for (const pattern of CLI_TOKEN_PATTERNS) output = output.replace(pattern, REDACTED);
  return output;
}

// Known credential shapes. Each keeps its prefix so a reader still sees what
// kind of value was there.
const KNOWN_TOKEN_RULES = Object.freeze([
  // Anthropic, OpenAI and other `sk-` keys.
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]'],
  // GitHub tokens (classic and fine-grained).
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, '$1[redacted]'],
  [/\b(github_pat_)[A-Za-z0-9_]{20,}/g, '$1[redacted]'],
  // Slack.
  [/\b(xox[abposr]-)[A-Za-z0-9-]{10,}/g, '$1[redacted]'],
  // npm.
  [/\b(npm_)[A-Za-z0-9]{30,}/g, '$1[redacted]'],
  // AWS access key ids.
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '$1[redacted]'],
  // Google API keys.
  [/\b(AIza)[0-9A-Za-z_-]{30,}/g, '$1[redacted]'],
  // Bearer / Basic credentials in a header or a curl line.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [redacted]'],
  // A password in a URL: scheme://user:password@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[redacted]@'],
  // A Slack incoming webhook: the path is the credential.
  [/\b(hooks\.slack\.com\/services\/)[A-Za-z0-9_/-]+/g, '$1[redacted]'],
  // Credentials in a query string: ?key=…, &sig=…, &token=…
  [/([?&](?:key|api_?key|sig|signature|token|access_token|auth|password|secret)=)(?!\[redacted\])[^&\s#"'`]+/gi, '$1[redacted]'],
  // An `Authorization:` header, any case (`AUTHORIZATION: basic …` in a git
  // http.extraheader), any scheme word (`token <hex>`, `Bot …`): the word
  // stays, the value goes. Bearer/Basic outside a header stay case-exact
  // above, so prose ("basic functionality") is left alone.
  [/\b(authorization["']?\s*[:=]\s*["']?(?:token|bot|digest|apikey|bearer|basic)\s+)(?!\[redacted\])[^\s"',;]+/gi, '$1[redacted]'],
  // curl -u / --user name:password, also attached (-ualice:pw). Only on a
  // curl line: `docker run -u node:node`, `ps -u alice:staff` are no secret.
  [/\b(curl\b[^\n|;&]*?\s(?:-u|--user)(?:\s+|=)?["']?[^\s:"']+:)(?!\[redacted\]|\$)[^\s"']+/g, '$1[redacted]'],
  // A secret flag's value: --password x, --token=x, --secret x, --api-key x.
  [/((?:^|\s)--(?:password|passwd|token|secret|api-key|access-token|client-secret)(?:\s+|=)["']?)(?!\[redacted\]|\$|-)[^\s"']+/gi, '$1[redacted]'],
  // mysql -p<password> (attached), docker login -p <password>.
  [/\b(mysql\w*\b[^\n|;&]*?\s-p)(?!\[redacted\])([^\s"']+)/g, '$1[redacted]'],
  [/\b(docker\s+login\b[^\n|;&]*?\s-p\s+)(?!\[redacted\]|\$)[^\s"']+/g, '$1[redacted]'],
  // sshpass -p <password> (or attached), redis-cli -a <password>.
  [/\b(sshpass\b[^\n|;&]*?\s-p\s*)(?!\[redacted\]|\$)[^\s"']+/g, '$1[redacted]'],
  [/\b(redis-cli\b[^\n|;&]*?\s-a\s+)(?!\[redacted\]|\$)[^\s"']+/g, '$1[redacted]'],
  // An AWS credentials file or ini line (aws_secret_access_key = …), or
  // `aws configure set aws_secret_access_key <value>`.
  [/\b(aws_secret_access_key|aws_session_token)(\s*[:=]\s*["']?|\s+)(?!\[redacted\]|\$)[^\s"',;]{4,}/gi, '$1$2[redacted]'],
]);

// NAME=value with a secret-sounding environment name (API_TOKEN=…,
// DB_PASSWORD="…"); the name stays. A value without a letter (a count, a
// port) or a placeholder (true, null, ***) is no secret.
const ENV_ASSIGNMENT_PATTERN = /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH(?!OR))[A-Za-z0-9_]*)=(["']?)(?!\[redacted\]|(?:true|false|null|none|undefined)\b|\*+|\$)(?=[^\s"'`]*[A-Za-z])([^\s"'`]{4,})/gi;
// `token: value`, `"password": "value"`, `api_key = value`, Authorization: …
// A Bearer/Basic value was handled above and keeps its scheme word.
const KEY_VALUE_PATTERN = /\b(token|secret|password|passwd|passphrase|api[_-]?key|access[_-]?key|client[_-]?secret|authorization)(["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic|token|bot|digest|apikey)\s|(?:Bearer|Basic)\b|\[redacted\]|(?:true|false|null|none|undefined)\b|\*+|\$)(?=[^\s"',;]*[A-Za-z])([^\s"',;]{4,})/gi;
// Anything else token-shaped: 32 or more of [A-Za-z0-9_-] with an upper-case
// letter, a lower-case letter and a digit. Random keys have all three; test
// names, paths and hex commit ids rarely do.
const GENERIC_TOKEN_PATTERN = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g;
// A PEM private key block, whole.
const PEM_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

function scrubPlain(text) {
  let output = text.replace(PEM_PATTERN, '[redacted private key]');
  for (const [pattern, replacement] of KNOWN_TOKEN_RULES) output = output.replace(pattern, replacement);
  output = output
    .replace(ENV_ASSIGNMENT_PATTERN, (_match, name, quote) => `${name}=${quote}${REDACTED}`)
    .replace(KEY_VALUE_PATTERN, (_match, key, separator) => `${key}${separator}${REDACTED}`)
    .replace(GENERIC_TOKEN_PATTERN, REDACTED);
  return output;
}

/**
 * Credentials out of a task's output: the known token shapes, secret-named
 * `KEY=value` and `key: value` pairs, Bearer/Basic values, URL passwords,
 * private keys, and long random-looking tokens. SGR codes are left alone
 * (the text between them is scrubbed), so colours survive.
 */
export function scrubTaskOutput(text) {
  const value = String(text ?? '');
  if (!value) return value;
  if (!value.includes('\x1b')) return scrubPlain(value);
  return value.split(/(\x1b\[[0-9;]*m)/).map((part, index) => (index % 2 === 1 ? part : scrubPlain(part))).join('');
}

/** What leaves the relay: control codes out (SGR kept), then credentials out. */
export function cleanTaskOutput(text) {
  return scrubTaskOutput(stripControlKeepSgr(text));
}

/**
 * A worker's text about a task as the relay keeps it on the row (its
 * description, summary, last tool call, command line): no colour or control
 * codes, credentials scrubbed as in the output (before the cut, so a cut
 * never leaves half a secret unrecognised), at most `max` characters. ''
 * when there is none. A description can be the command line itself (Grok's
 * terminals, a Copilot shell without one).
 */
export function cleanTaskText(value, max) {
  if (typeof value !== 'string' || !value) return '';
  const plain = stripSgr(stripControlKeepSgr(value.slice(0, Math.max(1, max) * 4)));
  return scrubTaskOutput(plain).trim().slice(0, max);
}

/** A shell task's command line as the relay keeps it: cleanTaskText at 2,000 characters. */
export function normalizeTaskCommand(value) {
  return cleanTaskText(value, TASK_OUTPUT_LIMITS.commandCharsMax);
}

// ─── Test runners ────────────────────────────────────────────────────────────

const PASS_MARK = /^\s*(?:[✓✔√]|\[PASS\])\s+/;
const FAIL_MARK = /^\s*(?:[✗✘×✕✖]|\[FAIL\])\s+/;

function lineTextOf(line) {
  const raw = line && typeof line === 'object' ? line.text : line;
  return stripSgr(String(raw ?? '')).replace(/\r/g, '');
}

function countOf(line) {
  const count = line && typeof line === 'object' ? Number(line.count) : 1;
  return Number.isInteger(count) && count > 0 ? count : 1;
}

function countsFrom(text) {
  const counts = {};
  for (const match of text.matchAll(/(\d+)\s+(passed|failed|skipped|todo|pending|flaky|errors?|xfailed|xpassed|deselected|warnings?|interrupted|did not run)\b/gi)) {
    counts[match[2].toLowerCase()] = (counts[match[2].toLowerCase()] || 0) + Number(match[1]);
  }
  return counts;
}

function summary(runner, { passed = 0, failed = 0, skipped = 0, flaky = 0 } = {}, extra = {}) {
  return {
    runner,
    passed,
    failed,
    skipped,
    ...(flaky ? { flaky } : {}),
    ...extra,
  };
}

// Final summaries, checked from the end of the log back. Each returns the
// counts or null.
const FINAL_SUMMARIES = [
  // vitest: " Tests  2 failed | 412 passed | 3 skipped (417)"
  {
    runner: 'vitest',
    match(texts, index) {
      const text = texts[index];
      if (!/^\s*Tests\s{2,}.*\(\d+\)\s*$/.test(text) || /^\s*Tests:/.test(text)) return null;
      const counts = countsFrom(text);
      return summary('vitest', {
        passed: counts.passed || 0,
        failed: counts.failed || 0,
        skipped: (counts.skipped || 0) + (counts.todo || 0),
      });
    },
  },
  // jest: "Tests:       2 failed, 3 skipped, 412 passed, 417 total"
  {
    runner: 'jest',
    match(texts, index) {
      const text = texts[index];
      if (!/^\s*Tests:\s+.*\b\d+\s+total\s*$/.test(text)) return null;
      const counts = countsFrom(text);
      return summary('jest', {
        passed: counts.passed || 0,
        failed: counts.failed || 0,
        skipped: (counts.skipped || 0) + (counts.todo || 0) + (counts.pending || 0),
      });
    },
  },
  // pytest: "======= 2 failed, 412 passed, 3 skipped in 3.21s ======="
  {
    runner: 'pytest',
    match(texts, index) {
      const text = texts[index];
      if (!/^=+ .*\bin [\d.]+s(?: \([^)]*\))? =+\s*$/.test(text)) return null;
      const counts = countsFrom(text);
      if (!Object.keys(counts).length && !/no tests ran/.test(text)) return null;
      return summary('pytest', {
        passed: (counts.passed || 0) + (counts.xpassed || 0),
        failed: (counts.failed || 0) + (counts.error || 0) + (counts.errors || 0),
        skipped: (counts.skipped || 0) + (counts.xfailed || 0) + (counts.deselected || 0),
      });
    },
  },
  // node:test, spec reporter ("ℹ pass 1") and TAP ("# pass 1"): the block
  // ends with duration_ms.
  {
    runner: 'node:test',
    match(texts, index) {
      if (!/^\s*(?:ℹ|#)\s+duration_ms\s+[\d.]+\s*$/.test(texts[index])) return null;
      const counts = {};
      for (let i = index - 1; i >= 0 && i >= index - 12; i -= 1) {
        const field = /^\s*(?:ℹ|#)\s+(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/.exec(texts[i]);
        if (!field) break;
        counts[field[1]] = Number(field[2]);
      }
      if (counts.pass === undefined && counts.fail === undefined) return null;
      return summary('node:test', {
        passed: counts.pass || 0,
        failed: (counts.fail || 0) + (counts.cancelled || 0),
        skipped: (counts.skipped || 0) + (counts.todo || 0),
      });
    },
  },
  // Playwright: "  1 failed" … "  3 skipped" … "  412 passed (1.4m)": the
  // block's lines sit together at the end, the passed line carries the time.
  {
    runner: 'playwright',
    match(texts, index) {
      const text = texts[index];
      const own = /^\s{2}(\d+) (passed|failed|flaky|skipped|interrupted|did not run)(?: \(([\dhms.\s]+)\))?\s*$/.exec(text);
      if (!own) return null;
      // Walk up over the block: count lines, and the indented test titles
      // listed under "failed" / "flaky".
      const counts = {};
      let timed = !!own[3];
      let i = index;
      for (; i >= 0; i -= 1) {
        const line = texts[i];
        const head = /^\s{2}(\d+) (passed|failed|flaky|skipped|interrupted|did not run)(?: \(([\dhms.\s]+)\))?\s*$/.exec(line);
        if (head) {
          counts[head[2]] = Number(head[1]);
          if (head[3]) timed = true;
          continue;
        }
        if (/^\s{4}\S/.test(line)) continue;
        break;
      }
      if (!timed) return null;
      return summary('playwright', {
        passed: counts.passed || 0,
        failed: (counts.failed || 0) + (counts.interrupted || 0),
        skipped: (counts.skipped || 0) + (counts['did not run'] || 0),
        flaky: counts.flaky || 0,
      });
    },
  },
  // turbo (also run through pnpm): " Tasks:    3 successful, 4 total", with a
  // " Failed:    pkg#task" line when one failed.
  {
    runner: 'turbo',
    match(texts, index) {
      const text = texts[index];
      const head = /^\s*Tasks:\s+(\d+) successful(?:, (\d+) failed)?, (\d+) total\s*$/.exec(text);
      if (!head) return null;
      const successful = Number(head[1]);
      const total = Number(head[3]);
      const failed = head[2] !== undefined ? Number(head[2]) : Math.max(0, total - successful);
      return summary('turbo', { passed: successful, failed });
    },
  },
];

// What a log looks like while a run is still going: the runner's own header
// lines. Markers alone (✓ …) say nothing, a build log has them too.
const RUNNER_HEADERS = [
  ['playwright', /^Running \d+ tests? using \d+ workers?/],
  ['vitest', /^\s*(?:RUN|DEV)\s+v\d+\.\d+/],
  ['jest', /^\s*(?:PASS|FAIL)\s+\S+\.(?:[cm]?[jt]sx?)\b/],
  ['pytest', /^=+ test session starts =+$/],
  ['node:test', /^(?:TAP version \d+|[✔✖] .+ \([\d.]+ms\)\s*$)/],
  ['tap', /^(?:not )?ok \d+ - /],
  ['turbo', /^\s*•\s+Running \S+ in \d+ packages?/],
];

function newTally() {
  return { passed: 0, failed: 0, skipped: 0, firstFailureLine: null };
}

// One log line of a run of `runner` into `tally`; `at` names the line for
// `firstFailureLine` (an index into the lines, or a byte offset).
function countRunnerLine(runner, text, repeat, tally, at) {
  const markFirst = () => {
    if (tally.firstFailureLine === null) tally.firstFailureLine = at;
  };
  const fail = (amount = 1) => {
    tally.failed += amount;
    markFirst();
  };
  if (runner === 'pytest') {
    const verbose = /\s(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:\s+\[\s*\d+%\])?\s*$/.exec(text);
    if (verbose) {
      if (verbose[1] === 'PASSED' || verbose[1] === 'XPASS') tally.passed += repeat;
      else if (verbose[1] === 'FAILED' || verbose[1] === 'ERROR') fail(repeat);
      else tally.skipped += repeat;
      return;
    }
    // Progress lines: "tests/test_a.py ..F.s   [ 40%]"
    // and their wrapped continuations ("........  [ 56%]").
    const dots = /^\S+\.py\s+([.FEsxX]+)(?:\s+\[\s*\d+%\])?\s*$/.exec(text)
      || /^([.FEsxX]+)\s*\[\s*\d+%\]\s*$/.exec(text);
    if (dots) {
      for (const mark of dots[1]) {
        if (mark === '.' || mark === 'X') tally.passed += 1;
        else if (mark === 'F' || mark === 'E') fail();
        else tally.skipped += 1;
      }
    }
    return;
  }
  if (runner === 'tap' || (runner === 'node:test' && /^\s*(?:not )?ok \d+ /.test(text))) {
    const tap = /^\s*(not )?ok \d+\b(.*)$/.exec(text);
    if (!tap) return;
    // A subtest line is indented; only top-level results count.
    if (/^\s/.test(text)) return;
    if (/#\s*(?:SKIP|TODO)\b/i.test(tap[2])) tally.skipped += repeat;
    else if (tap[1]) fail(repeat);
    else tally.passed += repeat;
    return;
  }
  if (runner === 'vitest') {
    // File lines: " ✓ src/a.test.ts (12 tests) 34ms", " ❯ src/b.test.ts (5 tests | 2 failed) 20ms".
    // The × lines under a failed file repeat its failures.
    const file = /^\s*[✓❯×]\s+\S+\s+\((\d+) tests?(?: \| (\d+) failed)?(?: \| (\d+) skipped)?\)/.exec(text);
    if (file) {
      const total = Number(file[1]);
      const failedHere = Number(file[2] || 0);
      const skippedHere = Number(file[3] || 0);
      tally.passed += Math.max(0, total - failedHere - skippedHere);
      tally.skipped += skippedHere;
      if (failedHere) fail(failedHere);
      return;
    }
    if (FAIL_MARK.test(text)) markFirst();
    return;
  }
  if (runner === 'jest') {
    // Without --verbose jest marks files only; each failed test gets a
    // "● suite › test" block (but "● Console" is a log block).
    if (/^\s*FAIL\s/.test(text)) {
      markFirst();
      return;
    }
    if (/^\s*●\s(?!Console\b)/.test(text)) {
      fail(repeat);
      return;
    }
    if (PASS_MARK.test(text)) tally.passed += repeat;
    else if (FAIL_MARK.test(text)) markFirst();
    return;
  }
  if (runner === 'playwright' && /^\s*-\s+\d+\s/.test(text)) {
    tally.skipped += repeat;
    return;
  }
  if (PASS_MARK.test(text)) tally.passed += repeat;
  else if (FAIL_MARK.test(text)) {
    // node:test's "✖ failing tests:" heads the repeat of the failures.
    if (/failing tests:\s*$/.test(text)) return;
    fail(repeat);
  }
}

function liveCounts(runner, texts) {
  const tally = newTally();
  texts.forEach((text, index) => countRunnerLine(runner, text, texts.counts[index], tally, index));
  return tally;
}

// Where the first failure is told in detail, for a run that has its final
// summary (the per-test marks may sit far above).
function firstFailureIndex(runner, texts) {
  const patterns = {
    playwright: [/^\s{2}\d+\) /, /^\s*[✘×]\s+\d+\s/],
    vitest: [/^\s*FAIL\s/, /^\s*[×✗]\s/],
    jest: [/^\s*●\s/, /^\s*[✕×]\s/],
    pytest: [/^_{3,} .+ _{3,}$/, /\s(?:FAILED|ERROR)(?:\s+\[\s*\d+%\])?\s*$/, /^\S+\.py\s+[.sxX]*[FE]/],
    'node:test': [/^\s*✖\s(?!failing tests:)/, /^not ok \d+ /],
    tap: [/^not ok \d+ /],
    turbo: [/ERR!|ERROR|command finished with error/i],
  }[runner] || [FAIL_MARK];
  // In order of preference: the detailed report first, the mark second.
  for (const pattern of patterns) {
    const index = texts.findIndex((text) => pattern.test(text));
    if (index !== -1) return index;
  }
  return null;
}

/**
 * Pass/fail counts of a test run from its log lines (strings or the line
 * model's `{ text, count }`; colours are ignored), or null when the log is
 * not a known runner's. Returns `{ runner, passed, failed, skipped, flaky?,
 * firstFailureLine, final }`: `final` when the counts come from the runner's
 * closing summary, otherwise they are counted from the per-test marks while
 * the run is still going. `firstFailureLine` is the index (into `lines`) of
 * the first failure, or null. Runners: vitest, Playwright, node:test (spec
 * and TAP), jest, pytest, turbo (and pnpm running it).
 */
export function parseRunnerSummary(lines) {
  const list = Array.isArray(lines) ? lines : String(lines ?? '').split('\n');
  const texts = list.map(lineTextOf);
  texts.counts = list.map(countOf);
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    if (!texts[index].trim()) continue;
    for (const candidate of FINAL_SUMMARIES) {
      const found = candidate.match(texts, index);
      if (!found) continue;
      const failure = found.failed > 0 ? firstFailureIndex(found.runner, texts.slice(0, index)) : null;
      return { ...found, firstFailureLine: failure, final: true };
    }
  }
  let runner = null;
  for (const text of texts) {
    const header = RUNNER_HEADERS.find(([, pattern]) => pattern.test(text));
    if (header) {
      runner = header[0];
      break;
    }
  }
  if (!runner) return null;
  return { runner, ...liveCounts(runner, texts), final: false };
}

// One-line closing summaries (jest, vitest, pytest, turbo, node:test's
// last line, Playwright's timed count).
const CLOSING_LINES = [
  /^\s*Tests:\s+.*\b\d+\s+total\s*$/,
  /^\s*Tests\s{2,}.*\(\d+\)\s*$/,
  /^=+ .*\bin [\d.]+s(?: \([^)]*\))? =+\s*$/,
  /^\s*Tasks:\s+\d+ successful/,
  /^\s*(?:ℹ|#)\s+duration_ms\s+[\d.]+\s*$/,
  /^\s{2}\d+ passed \([\dhms.\s]+\)\s*$/,
];

// Headers that open a new run: a second run in the same log (a watch rerun,
// `npm test` twice) counts from its own start. A jest or node:test file line
// is a header too, but every file of a run prints one.
function opensRun(runner, text) {
  if (runner === 'node:test') return /^TAP version \d+/.test(text);
  return runner === 'playwright' || runner === 'vitest' || runner === 'pytest' || runner === 'turbo';
}

/**
 * The live counts of a whole log fed one line at a time, for a log too long
 * to parse at once (the health poller keeps one per task as the file grows).
 * `push(line, at)` takes a completed line (a string or `{ text, count }`) and
 * what names it (a byte offset); `result()` is what parseRunnerSummary says
 * of a run still going, `{ runner, passed, failed, skipped, firstFailureLine,
 * final: false }` with `firstFailureLine` the `at` of the first failure, or
 * null while no runner's header has been seen. Counting starts at the
 * header: marks before it (a build's ✓ lines) are not a test run's.
 */
export function createRunnerTally() {
  let runner = null;
  let tally = newTally();
  // A closing summary was seen: the next header (a jest file line too)
  // starts the next run.
  let closed = false;
  return {
    push(line, at) {
      const text = lineTextOf(line);
      const header = RUNNER_HEADERS.find(([, pattern]) => pattern.test(text));
      if (header && (!runner || closed || opensRun(header[0], text))) {
        runner = header[0];
        tally = newTally();
        closed = false;
      }
      if (runner) countRunnerLine(runner, text, countOf(line), tally, at);
      if (runner && CLOSING_LINES.some((pattern) => pattern.test(text))) closed = true;
    },
    result() {
      return runner ? { runner, ...tally, final: false } : null;
    },
  };
}
