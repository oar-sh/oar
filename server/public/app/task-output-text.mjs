// Browser copy of the parts of shared/task-output-text.mjs the task console
// needs: the incremental line folder, the SGR colour segments (with the
// control stripping they use) and the stall minutes. The browser cannot
// import shared/ (only server/public is served), so these are hand-kept
// copies; task-output-text.test.mjs pins them to the original. Scrubbing and
// runner parsing stay on the relay: what reaches the page is already clean.

export const TASK_OUTPUT_LINE_CHARS_MAX = 4000;

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

// ─── Lines ───────────────────────────────────────────────────────────────────

function cutLine(text) {
  return text.length > TASK_OUTPUT_LINE_CHARS_MAX ? text.slice(0, TASK_OUTPUT_LINE_CHARS_MAX) : text;
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
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
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
    else if (code === 22) {
      state.bold = false;
      state.dim = false;
    } else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
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
 * Adjacent segments never share a style. Any escape that is not SGR is
 * dropped from the text.
 */
export function ansiToSegments(lineText) {
  const text = String(lineText ?? '');
  const state = plainStyle();
  const segments = [];
  const pushText = (value) => {
    const clean = stripControlKeepSgr(value).replace(/\x1b/g, '');
    if (!clean) return;
    const last = segments[segments.length - 1];
    if (last && last.fg === state.fg && last.bg === state.bg && last.bold === state.bold
      && last.dim === state.dim && last.italic === state.italic && last.underline === state.underline) {
      last.text += clean;
      return;
    }
    segments.push({ text: clean, ...state });
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
