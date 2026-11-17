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
  // OAR's own credentials (shared/relay-credentials.mjs): owner token,
  // browser session, sign-in code, agent token, peer key, proof key.
  [/\b(oar[oascpk]1_)[A-Za-z0-9_\-.]+/g, '$1[redacted]'],
  // An OAR file capability (`fc1.<session>.<expiry>.<mac>`), also URL-encoded.
  [/\bfc1(?:\.|%2E)[A-Za-z0-9_-]+(?:\.|%2E)[0-9a-z]+(?:\.|%2E)[A-Za-z0-9_-]+/gi, 'fc1.[redacted]'],
  // Anthropic, OpenAI and other `sk-` keys.
  [/\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]'],
  // xAI keys.
  [/\b(xai-)[A-Za-z0-9]{20,}/g, '$1[redacted]'],
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
  // Credentials in a query string or form body: ?key=…, &sig=…, &token=…,
  // an OAuth ?code=… or &refresh_token=…
  [/([?&](?:key|api_?key|sig|signature|token|access_token|refresh_token|id_token|client_secret|code|auth|password|secret)=)(?!\[redacted\])[^&\s#"'`]+/gi, '$1[redacted]'],
  // OAuth fields elsewhere: JSON `"access_token": "…"`, `refresh_token: …`,
  // `client_secret=…` (the `_` before `token` keeps the generic key: value
  // rule below from seeing them).
  [/\b((?:access|refresh|id)_token|client_secret)(["']?\s*[:=]\s*["']?)(?!\[redacted\]|(?:true|false|null|none|undefined)\b|\*+|\$)([^\s"',;&}]{4,})/gi, '$1$2[redacted]'],
  // Set-Cookie as an array (util.inspect `'set-cookie': [ 'sid=…', … ]`,
  // JSON `"set-cookie":["sid=…"]`), up to its closing bracket, across lines;
  // one not closed within the text, to the end of its line.
  [/\b((?:set-)?cookie["']?\s*:\s*)\[(?=[^\]]{0,4096}=)[^\]]{0,4096}\]/gi, '$1[redacted]'],
  [/\b((?:set-)?cookie["']?\s*:\s*)\[(?=[^\]\r\n]*=)[^\]\r\n]*/gi, '$1[redacted]'],
  // A Cookie or Set-Cookie header's value (name=value pairs), whole.
  [/\b((?:set-)?cookie["']?\s*:\s*["']?)(?!\[redacted\])(?=[^\s;=]+=)[^\r\n"']+/gi, '$1[redacted]'],
  // An `Authorization:` header, any case (`AUTHORIZATION: basic …` in a git
  // http.extraheader), any scheme word (`token <hex>`, `Bot …`): the word
  // stays, the value goes. Bearer/Basic outside a header stay case-exact
  // above, so prose ("basic functionality") is left alone.
  [/\b(authorization["']?\s*[:=]\s*["']?(?:token|bot|digest|apikey|bearer|basic)\s+)(?!\[redacted\])[^\s"',;]+/gi, '$1[redacted]'],
  // A JSON Web Token anywhere else (an OAuth access or id token).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, 'eyJ[redacted]'],
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

// `observe`, when given, is called after each rule that matched with its
// matches, `{ at, text, output }` (`at` in the text that rule saw), and
// whether the rule is one of a credential shape (KNOWN_TOKEN_RULES).
function scrubPlain(text, observe = null) {
  const replace = (input, pattern, replacement, shape = false) => {
    const replaced = input.replace(pattern, replacement);
    // A replace with a callback is slow even without a match: only a rule
    // that changed the text is run again to see its matches.
    if (!observe || replaced === input) return replaced;
    const matches = [];
    const output = input.replace(pattern, (...args) => {
      const groups = args.length - 3;
      let value = replacement;
      if (typeof replacement === 'function') value = replacement(...args);
      else if (replacement.includes('$')) {
        value = replacement.replace(/\$([1-9])/g, (dollar, digit) => (Number(digit) <= groups ? args[digit] ?? '' : dollar));
      }
      matches.push({ at: args[groups + 1], text: args[0], output: value });
      return value;
    });
    if (matches.length) observe(matches, shape);
    return output;
  };
  let output = replace(text, PEM_PATTERN, '[redacted private key]');
  for (const [pattern, replacement] of KNOWN_TOKEN_RULES) output = replace(output, pattern, replacement, true);
  output = replace(output, ENV_ASSIGNMENT_PATTERN, (_match, name, quote) => `${name}=${quote}${REDACTED}`);
  output = replace(output, KEY_VALUE_PATTERN, (_match, key, separator) => `${key}${separator}${REDACTED}`);
  return replace(output, GENERIC_TOKEN_PATTERN, REDACTED);
}

// The scrub of `text` and what became of each of its characters, for
// scrubTaskOutput: `source[k]` is the index in `text` of the output's
// character k, -1 for one a replacement put in; `shown[i]` when character i
// is in the output as itself; `known[i]` when a credential shape's rule
// kept it beside its `[redacted]` as the credential's public part (`ghp_`,
// `?token=`) and no later rule took it out as a value of its own; `found`,
// the replacements whose text holds no `[redacted…]` marker, `{ from, to,
// output, hidden }`: what they put in for the characters they took out
// (`hidden`), which lie between `from` and `to`. With no match, `source`, `shown` and `known`
// are null (and `found` is left empty when `collect` is false). Each rule
// that matched costs one copy of the text's map.
function traceScrub(text, collect = true) {
  let source = null;
  let known = null;
  const found = [];
  const output = scrubPlain(text, (matches, shape) => {
    if (!source) {
      source = new Int32Array(text.length);
      for (let index = 0; index < text.length; index += 1) source[index] = index;
      known = new Uint8Array(text.length);
    }
    let length = source.length;
    for (const { text: match, output: value } of matches) length += value.length - match.length;
    const next = new Int32Array(length);
    let to = 0;
    let cursor = 0;
    const keep = (from, end) => {
      next.set(source.subarray(from, end), to);
      to += end - from;
    };
    const keepKnown = (from, end) => {
      for (let index = from; index < end; index += 1) {
        next[to] = source[index];
        to += 1;
        if (source[index] >= 0) known[source[index]] = 1;
      }
    };
    for (const { at, text: match, output: value } of matches) {
      let head = 0;
      while (head < value.length && head < match.length && value[head] === match[head]) head += 1;
      let tail = 0;
      while (tail < value.length - head && tail < match.length - head
        && value[value.length - 1 - tail] === match[match.length - 1 - tail]) tail += 1;
      // A part kept as public stays so when a later rule only wraps the
      // credential it is part of; one that takes it out as a fresh value
      // makes it secret.
      const fresh = !match.includes('[redacted');
      if (fresh) {
        for (let index = at + head; index < at + match.length - tail; index += 1) {
          if (source[index] >= 0) known[source[index]] = 0;
        }
      }
      if (collect && fresh) {
        const hidden = [];
        for (let index = at + head; index < at + match.length - tail; index += 1) {
          if (source[index] >= 0) hidden.push(source[index]);
        }
        if (hidden.length) {
          found.push({ from: hidden[0], to: hidden[hidden.length - 1] + 1, output: value.slice(head, value.length - tail), hidden });
        }
      }
      const kept = shape ? keepKnown : keep;
      keep(cursor, at);
      kept(at, at + head);
      next.fill(-1, to, to + value.length - head - tail);
      to += value.length - head - tail;
      kept(at + match.length - tail, at + match.length);
      cursor = at + match.length;
    }
    keep(cursor, source.length);
    source = next;
  });
  let shown = null;
  if (source) {
    shown = new Uint8Array(text.length);
    for (const index of source) if (index >= 0) shown[index] = 1;
  }
  return { output, source, shown, known, found };
}

/**
 * Credentials out of a task's output or a worker's log: the known token
 * shapes (OAR's own among them), secret-named `KEY=value` and `key: value`
 * pairs, OAuth fields and JWTs, Bearer/Basic values, cookies, URL passwords,
 * private keys, and long random-looking tokens. Escape codes (SGR colours,
 * every other CSI, OSC hyperlinks) are left in place and the text between
 * them is scrubbed, so colours survive; an OSC's own text is scrubbed too. A
 * credential a code breaks in two is found in the text without the codes: a
 * line that would show a character of it becomes that text's scrub, with
 * the line's codes moved to its end. Linear in the text's length.
 */
export function scrubTaskOutput(text) {
  const value = String(text ?? '');
  if (!value) return value;
  if (!value.includes('\x1b')) return scrubPlain(value);
  const parts = value.split(ESCAPE_SPLIT_PATTERN);
  const plain = parts.filter((_part, index) => index % 2 === 0).join('');
  const whole = traceScrub(plain, false);
  // How many of the first i characters without codes the whole scrub does
  // not show; a piece in which it shows all needs no trace.
  let hiddenBefore = null;
  if (whole.shown) {
    hiddenBefore = new Int32Array(plain.length + 1);
    for (let at = 0; at < plain.length; at += 1) hiddenBefore[at + 1] = hiddenBefore[at] + 1 - whole.shown[at];
  }
  // Coloured output repeats its pieces (a check mark, a status word).
  const scrubs = new Map();
  const traces = new Map();
  const pieces = [];
  let offset = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const part = parts[index];
    const traced = hiddenBefore && hiddenBefore[offset + part.length] > hiddenBefore[offset];
    const cache = traced ? traces : scrubs;
    if (!cache.has(part)) cache.set(part, traced ? traceScrub(part) : { output: scrubPlain(part) });
    const { output, shown, found } = cache.get(part);
    pieces.push({ part, offset, output, shown, found, traced });
    offset += part.length;
  }
  const coloured = parts.map((part, index) => (index % 2 === 1 ? scrubEscape(part) : pieces[index / 2].output)).join('');
  if (whole.output === plain || whole.output === pieces.map((piece) => piece.output).join('')) return coloured;
  return withCodesAtLineEnds(parts, pieces, whole, coloured);
}

// What scrubTaskOutput matches across and puts back: a CSI (colours, cursor
// moves, erases), an OSC or another string control ended by BEL or ST (a
// hyperlink), and any other escape (`ESC ( B`, `ESC 7`). None holds a line
// break, and none can backtrack further than to the next ESC or line break.
const ESCAPE_SPLIT_PATTERN = /(\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]PX^_][^\x07\x1b\n]*(?:\x07|\x1b\\)|\x1b[ -/]*[0-~])/;
const STRING_CONTROL_PATTERN = /^\x1b[\]PX^_]/;

// An OSC's (or other string control's) text is scrubbed like output: a
// hyperlink's address can hold a credential. Other codes stay as they are.
function scrubEscape(code) {
  if (code.length <= 2 || !STRING_CONTROL_PATTERN.test(code)) return code;
  const end = code.endsWith('\x07') ? code.length - 1 : code.length - 2;
  return `${code.slice(0, 2)}${scrubPlain(code.slice(2, end))}${code.slice(end)}`;
}

// ESCAPE_SPLIT_PATTERN everywhere, and at one place for a scan from ESC to
// ESC; both find the same codes.
const ESCAPE_CODES = new RegExp(ESCAPE_SPLIT_PATTERN.source, 'g');
const ESCAPE_CODE_AT = new RegExp(ESCAPE_SPLIT_PATTERN.source, 'y');

// The last of the ascending `values` that is at most `target`, -1 for none.
function lastAtMost(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/**
 * `text` with the ranges of values `findRanges(value)` names (`[start, end)`
 * pairs in `value`) replaced by `marker`, for a redaction by exact value
 * (the worker log's, the worker posts'). The ranges are looked for in the
 * text without the codes scrubTaskOutput matches across, so a code that cuts
 * a value in two does not hide it, and in the text as it is, so a value
 * inside a code (a hyperlink's address) or one a stray ESC runs into is found
 * as before. Ranges that overlap become one; with `mergeTouching`, so do
 * ranges that touch or have only codes between them. Each becomes `marker`
 * followed by the codes that lay inside it, in their order, so the text
 * after it keeps its colour; every other code stays where it is. A range in
 * a string control's body (a hyperlink's address) is replaced there and the
 * code stays whole; a code that a range of the text as it is runs into
 * otherwise is dropped with it. Every code written is whole. What a terminal
 * shows is then the text without codes with its ranges replaced. Linear in
 * the text's length, besides the two calls of `findRanges`.
 */
export function replaceRangesAcrossEscapes(text, findRanges, { marker = '[redacted]', mergeTouching = false } = {}) {
  const value = String(text ?? '');
  const plain = value.replace(ESCAPE_CODES, '');
  const plainRanges = plain.length < value.length ? findRanges(plain) : [];
  const rawRanges = findRanges(value);
  if (!plainRanges.length && !rawRanges.length) return value;
  // Code k is `value.slice(codeStart[k], codeEnd[k])` and stands before
  // character `codePlain[k]` of `plain`.
  const codeStart = [];
  const codeEnd = [];
  const codePlain = [];
  let removed = 0;
  for (let at = value.indexOf('\x1b'); at !== -1; at = value.indexOf('\x1b', at + 1)) {
    ESCAPE_CODE_AT.lastIndex = at;
    if (!ESCAPE_CODE_AT.test(value)) continue;
    const end = ESCAPE_CODE_AT.lastIndex;
    codeStart.push(at);
    codePlain.push(at - removed);
    codeEnd.push(end);
    removed += end - at;
    at = end - 1;
  }
  // Where character `index` of `plain` is in `value`.
  const rawAt = (index) => {
    const code = lastAtMost(codePlain, index);
    return code < 0 ? index : index + codeEnd[code] - codePlain[code];
  };
  // How many characters of `plain` lie before `value[at]`.
  const plainBefore = (at) => {
    const code = lastAtMost(codeStart, at - 1);
    if (code < 0) return at;
    return at < codeEnd[code] ? codePlain[code] : at - codeEnd[code] + codePlain[code];
  };
  // The body of string control `code` (an OSC's text) as `[from, to)`
  // between its introducer and its BEL or ST; null for any other code.
  const bodyOf = (code) => {
    if (!'\x5dPX^_'.includes(value[codeStart[code] + 1])) return null;
    const end = codeEnd[code];
    return [codeStart[code] + 2, value.charCodeAt(end - 1) === 7 ? end - 1 : end - 2];
  };
  const spans = [];
  for (const [start, end] of plainRanges) {
    if (end > start) spans.push([rawAt(start), rawAt(end - 1) + 1]);
  }
  // A range of the text as it is that lies in a string control's body is
  // replaced there, the code kept whole; one in the text between codes is a
  // span like the others; one that runs into a code otherwise takes the
  // codes it touches whole, and they are dropped. No span starts or ends
  // inside a code.
  const inBody = new Map();
  let dropped = null;
  for (const [start, end] of rawRanges) {
    if (end <= start) continue;
    const first = lastAtMost(codeStart, start);
    const last = lastAtMost(codeStart, end - 1);
    const startsIn = first >= 0 && start < codeEnd[first];
    if (!startsIn && first === last) {
      spans.push([start, end]);
      continue;
    }
    if (startsIn && first === last) {
      const body = bodyOf(first);
      if (body && start >= body[0] && end <= body[1]) {
        if (!inBody.has(first)) inBody.set(first, []);
        inBody.get(first).push([start, end]);
        continue;
      }
    }
    dropped ||= new Uint8Array(codeStart.length);
    for (let code = startsIn ? first : first + 1; code <= last; code += 1) dropped[code] = 1;
    spans.push([startsIn ? codeStart[first] : start, Math.max(end, codeEnd[last])]);
  }
  const joins = (ranges, start) => start < ranges[ranges.length - 1][1]
    || (mergeTouching && plainBefore(start) === plainBefore(ranges[ranges.length - 1][1]));
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const [start, end] of spans) {
    if (merged.length && joins(merged, start)) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], end);
      continue;
    }
    merged.push([start, end]);
  }
  // Code `code` as it is written: whole, its body's ranges replaced.
  const codeText = (code) => {
    const ranges = inBody.get(code);
    if (!ranges) return value.slice(codeStart[code], codeEnd[code]);
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const parts = [];
    let at = codeStart[code];
    let open = null;
    for (const [start, end] of ranges) {
      if (open && (start < open[1] || (mergeTouching && start === open[1]))) {
        open[1] = Math.max(open[1], end);
        continue;
      }
      if (open) {
        parts.push(value.slice(at, open[0]), marker);
        at = open[1];
      }
      open = [start, end];
    }
    parts.push(value.slice(at, open[0]), marker, value.slice(open[1], codeEnd[code]));
    return parts.join('');
  };
  const output = [];
  const bodyCodes = [...inBody.keys()].sort((a, b) => a - b);
  let nextBody = 0;
  let emitted = 0;
  // `value` up to `end`, a code with a replaced body as codeText has it.
  const emitTo = (end) => {
    for (; nextBody < bodyCodes.length && codeStart[bodyCodes[nextBody]] < end; nextBody += 1) {
      const code = bodyCodes[nextBody];
      if (codeStart[code] < emitted) continue;
      output.push(value.slice(emitted, codeStart[code]), codeText(code));
      emitted = codeEnd[code];
    }
    output.push(value.slice(emitted, end));
    emitted = end;
  };
  for (const [start, end] of merged) {
    emitTo(start);
    output.push(marker);
    for (let code = lastAtMost(codeStart, start - 1) + 1; code < codeStart.length && codeStart[code] < end; code += 1) {
      if (!dropped?.[code]) output.push(codeText(code));
    }
    emitted = end;
  }
  emitTo(value.length);
  return output.join('');
}

// A line whose coloured scrub shows a character that the scrub of the whole
// text without codes hides (other than a credential's public part, `ghp_`)
// becomes that scrub's line, with what the coloured pieces' own scrubs hid
// hidden as well, and the line's codes, in their order, at its end: its
// text keeps the colour it starts in, and the lines after it start as they
// did before. Every other line stays coloured. When a scrub joined lines (a
// private key, a cookie list), the whole text goes that way.
function withCodesAtLineEnds(parts, pieces, whole, coloured) {
  const leaks = [false];
  const codes = [''];
  // The pieces' replacements that took out a character the whole scrub
  // shows, at their place in the text without codes.
  const extra = [];
  parts.forEach((code, index) => {
    if (index % 2 === 1) {
      codes[codes.length - 1] += scrubEscape(code);
      return;
    }
    const { part, offset, output, traced, shown, found } = pieces[index / 2];
    if (!traced) {
      // The whole scrub shows all of the piece: the piece shows nothing it
      // hides, and what the piece's own scrub took out is extra.
      if (output !== part) extra.push({ from: offset, to: offset + part.length, output });
      for (let at = part.indexOf('\n'); at !== -1; at = part.indexOf('\n', at + 1)) {
        leaks.push(false);
        codes.push('');
      }
      return;
    }
    for (let at = 0; at < part.length; at += 1) {
      if (part.charCodeAt(at) === 10) {
        leaks.push(false);
        codes.push('');
      } else if ((!shown || shown[at]) && !whole.shown[offset + at] && !whole.known[offset + at]) {
        leaks[leaks.length - 1] = true;
      }
    }
    for (const { from, to, output: value, hidden } of found) {
      if (hidden.some((at) => whole.shown[offset + at])) extra.push({ from: offset + from, to: offset + to, output: value });
    }
  });
  if (!leaks.includes(true)) return coloured;
  const hidden = withExtraHidden(whole, extra, whole.shown.length);
  // Before a closing `\r`, which would make the line's visible text empty.
  const append = (line, lineCodes) => (line.endsWith('\r') ? `${line.slice(0, -1)}${lineCodes}\r` : `${line}${lineCodes}`);
  const hiddenLines = hidden.split('\n');
  const colouredLines = coloured.split('\n');
  if (hiddenLines.length !== leaks.length || colouredLines.length !== leaks.length) return append(hidden, codes.join(''));
  return colouredLines.map((line, index) => (leaks[index] ? append(hiddenLines[index], codes[index]) : line)).join('\n');
}

// The whole scrub's output with each extra replacement made over its span
// (the first of two that overlap wins). A `[redacted…]` the whole scrub put
// inside such a span goes with it; every other marker stays as it is.
function withExtraHidden(whole, extra, length) {
  const owner = new Int32Array(length).fill(-1);
  const kept = [];
  for (const span of extra.sort((a, b) => a.from - b.from)) {
    if (kept.length && span.from < kept[kept.length - 1].to) continue;
    owner.fill(kept.length, span.from, span.to);
    kept.push(span);
  }
  const { output, source } = whole;
  const pieces = [];
  let last = -1;
  for (let at = 0; at < output.length; at += 1) {
    const from = source[at];
    if (from >= 0 && owner[from] >= 0) {
      if (owner[from] !== last) pieces.push(kept[owner[from]].output);
      last = owner[from];
      continue;
    }
    if (from >= 0) {
      last = -1;
      pieces.push(output[at]);
      continue;
    }
    let end = at;
    while (end < output.length && source[end] < 0) end += 1;
    if (last < 0 || end >= output.length || owner[source[end]] !== last) pieces.push(output.slice(at, end));
    at = end - 1;
  }
  return pieces.join('');
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
