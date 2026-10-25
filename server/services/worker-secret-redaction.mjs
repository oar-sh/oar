// A provider's saved key out of what session workers post.
//
// A provider whose key the relay keeps in its settings (DeepSeek) hands that
// key to its own workers, and their agent can see it: in its shell's
// environment, in a file it reads, in an error the API quotes. Whatever the
// agent prints can come back to the relay as a reply, a stream update, a
// thought, tool activity, a sub-agent's text, a question or task output. So
// every occurrence of a saved key is replaced with `[redacted]` in the body of
// every request a session worker sends, before any route stores, broadcasts
// or logs it. This keeps the key out of what the relay stores and shows; it
// is no boundary against the agent, which can change the text, call the
// relay's API without the worker header or read the relay's database.
//
// - One choke point: a middleware after the JSON body parser. A worker
//   request is one that carries the `X-Relay-Session-Id` header every
//   worker's API client sends, even empty (the Copilot extension sends it
//   empty until its session is up); browsers never send it.
// - Every worker's posts lose every saved key, not only those of the
//   provider the key belongs to: a chat that changes provider between turns,
//   or an agent that reads the relay's own files, would otherwise slip past.
// - A key changed or removed in Settings is still redacted: a worker started
//   before the change still holds the old one. The middleware keeps the keys
//   saved since the relay started (MAX_REMEMBERED_SECRETS, in memory only,
//   never logged): those it reads when it is created, each one the settings
//   save path notes (noteSavedSetting) and those it reads on each post.
// - The first part of a key that was cut goes too (redactString): at the
//   end of a text, since stream and thought updates carry the text so far and
//   go out before the key is complete, and before an ellipsis anywhere in a
//   text, since a worker clips a long text and may go on after the clip (the
//   remote-relay activity line ends in `…”`). The last part of a key at the
//   very start of a text goes as well: a task-output snapshot is the output's
//   last 8 KiB and can begin halfway through a key.
// - Property names are rewritten like values (`{ "<key>": 1 }` becomes
//   `{ "[redacted]": 1 }`), so a key cannot ride along as one.
// - A key shorter than MIN_REDACTED_SECRET_LENGTH is left alone, so a
//   mistyped setting cannot mangle ordinary text.
// - The settings routes are never rewritten: a key saved there must arrive
//   as it was typed.
// - Task output the relay reads from a task's file does not pass here; it
//   goes through cleanTaskOutput (shared/task-output-text.mjs), whose rules
//   take out `sk-` keys (DeepSeek's and Anthropic's shape) and any other long
//   random-looking token, though not by the exact saved text. The snapshots
//   a worker posts for a task without a file do pass here.
//
// A provider registers its key by one entry in SAVED_PROVIDER_KEY_SETTINGS.

import { DEEPSEEK_PROVIDER_TYPE } from '../../shared/deepseek-models.mjs';
import { DEEPSEEK_API_KEY_SETTING_KEY } from './deepseek-settings-service.mjs';

export const REDACTED_SECRET_TEXT = '[redacted]';
export const MIN_REDACTED_SECRET_LENGTH = 8;
// The shortest part of a key that is taken out where a text was cut (its
// first part) or at a text's start (its last part). A shorter part stays. It
// holds at most 7 characters of the key, for DeepSeek's shape (`sk-` and 32
// hex digits) the public `sk-` and four digits, too few to help anyone guess
// it. And a shorter run of ordinary text, the bare `sk-` or a word a key
// happens to start with, is no key and must not turn into `[redacted]`.
export const MIN_REDACTED_KEY_PREFIX_LENGTH = 8;
// How many keys the middleware remembers; the oldest goes first. A saved key
// is changed by hand, so this many covers every worker still running.
export const MAX_REMEMBERED_SECRETS = 16;
export const WORKER_SESSION_HEADER = 'x-relay-session-id';

/** The providers whose workers get a key saved in the relay's settings. */
export const SAVED_PROVIDER_KEY_SETTINGS = Object.freeze([
  Object.freeze({ provider: DEEPSEEK_PROVIDER_TYPE, settingKey: DEEPSEEK_API_KEY_SETTING_KEY }),
]);

// JSON bodies are shallow in practice; a deeper one is left as it is below
// this depth rather than walked without end.
const MAX_DEPTH = 64;
// What a worker puts after a text it cut short (a tool line at 140
// characters, the remote-relay line's quoted text at 60), with the space
// some put before it. Matched where a key's first part stops: the text may go
// on after it (`…”`, `…” (now)`, `…)`).
const ELLIPSIS_AT = /\s*(?:…|⋯|\.{2,}|\[truncated\])/y;
// The same marks at the start of a text that begins inside something.
const LEADING_ELLIPSIS = /^(?:(?:…|⋯|\.{2,}|\[truncated\])\s*)?/;

function normalizeSecrets(secrets) {
  const unique = new Set();
  for (const entry of Array.isArray(secrets) ? secrets : []) {
    const value = String(entry ?? '').trim();
    if (value.length >= MIN_REDACTED_SECRET_LENGTH) unique.add(value);
  }
  // Longest first; where secrets overlap in a text, redactString joins what
  // each of them covers.
  return [...unique].sort((a, b) => b.length - a.length);
}

/** Whether a key's first part that stops at `at` was cut there: the text ends, or an ellipsis follows. */
function isCutAt(text, at) {
  if (at === text.length) return true;
  ELLIPSIS_AT.lastIndex = at;
  return ELLIPSIS_AT.test(text);
}

/**
 * Pushes `[start, end)` for each run in `text` that is the first
 * MIN_REDACTED_KEY_PREFIX_LENGTH or more characters of `secret` (not all of
 * it) and is cut: at the end of the text or before an ellipsis, wherever that
 * is. Of the runs at one place, the longest that is cut counts.
 */
function pushKeyPrefixRanges(text, secret, ranges) {
  if (secret.length <= MIN_REDACTED_KEY_PREFIX_LENGTH) return;
  const head = secret.slice(0, MIN_REDACTED_KEY_PREFIX_LENGTH);
  for (let index = text.indexOf(head); index !== -1; index = text.indexOf(head, index + 1)) {
    // How far the text goes on as the key does (short of the whole key, a
    // range of its own).
    const most = Math.min(secret.length - 1, text.length - index);
    let matched = MIN_REDACTED_KEY_PREFIX_LENGTH;
    while (matched < most && text.charCodeAt(index + matched) === secret.charCodeAt(matched)) matched += 1;
    for (let length = matched; length >= MIN_REDACTED_KEY_PREFIX_LENGTH; length -= 1) {
      if (isCutAt(text, index + length)) {
        ranges.push([index, index + length]);
        break;
      }
    }
  }
}

/**
 * Pushes `[start, end)` when `text`, from `start` on, begins with the last
 * MIN_REDACTED_KEY_PREFIX_LENGTH or more characters of `secret` (not all of
 * it): the longest such end of the key.
 */
function pushKeySuffixRange(text, start, secret, ranges) {
  if (secret.length <= MIN_REDACTED_KEY_PREFIX_LENGTH) return;
  const lead = text.slice(start, start + MIN_REDACTED_KEY_PREFIX_LENGTH);
  if (lead.length < MIN_REDACTED_KEY_PREFIX_LENGTH) return;
  // Where in the key the text may start, from 1 (not the whole key) on: the
  // first place that fits leaves the longest end.
  for (let at = secret.indexOf(lead, 1); at !== -1; at = secret.indexOf(lead, at + 1)) {
    if (text.startsWith(secret.slice(at), start)) {
      ranges.push([start, start + secret.length - at]);
      return;
    }
  }
}

/** `text` with each range replaced; ranges that overlap or touch become one, so the longest part wins. */
function replaceRanges(text, ranges) {
  if (!ranges.length) return text;
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let output = '';
  let emitted = 0;
  let [start, end] = ranges[0];
  for (let index = 1; index < ranges.length; index += 1) {
    const [nextStart, nextEnd] = ranges[index];
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
      continue;
    }
    output += `${text.slice(emitted, start)}${REDACTED_SECRET_TEXT}`;
    emitted = end;
    [start, end] = [nextStart, nextEnd];
  }
  return `${output}${text.slice(emitted, start)}${REDACTED_SECRET_TEXT}${text.slice(end)}`;
}

/**
 * `text` with every secret and the parts of one a cut left in it replaced:
 * each whole occurrence, its first part where the text was cut
 * (pushKeyPrefixRanges) and its last part at the very start of the text,
 * after an ellipsis it may begin with (pushKeySuffixRange). All are found in
 * the text as it came, of every secret, and replaced together, so where they
 * overlap the longest wins: a key that holds another saved key goes whole,
 * also when only a part of it is there.
 */
function redactString(text, secrets) {
  const ranges = [];
  const start = LEADING_ELLIPSIS.exec(text)[0].length;
  for (const secret of secrets) {
    for (let index = text.indexOf(secret); index !== -1; index = text.indexOf(secret, index + 1)) {
      ranges.push([index, index + secret.length]);
    }
    pushKeyPrefixRanges(text, secret, ranges);
    pushKeySuffixRange(text, start, secret, ranges);
  }
  return replaceRanges(text, ranges);
}

/**
 * `text` with every occurrence of each secret replaced, a first part of one
 * cut at the text's end or before an ellipsis and a last part of one the text
 * starts with; anything that is not a string as it is.
 */
export function redactSecretsInText(text, secrets = []) {
  if (typeof text !== 'string' || !text) return text;
  return redactString(text, normalizeSecrets(secrets));
}

function redactValue(value, secrets, depth) {
  if (typeof value === 'string') return value ? redactString(value, secrets) : value;
  if (!value || typeof value !== 'object' || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let copy = null;
    for (let index = 0; index < value.length; index += 1) {
      const next = redactValue(value[index], secrets, depth + 1);
      if (next !== value[index]) {
        copy ||= value.slice();
        copy[index] = next;
      }
    }
    return copy || value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  // Property names too: a key can be one (`{ "<key>": 1 }`). Once a name or a
  // value changes, the entries are copied in their order; two names that come
  // out the same keep the later value.
  const entries = Object.entries(value);
  let copied = null;
  for (let index = 0; index < entries.length; index += 1) {
    const [key, entry] = entries[index];
    const nextKey = key ? redactString(key, secrets) : key;
    const next = redactValue(entry, secrets, depth + 1);
    if (!copied) {
      if (nextKey === key && next === entry) continue;
      copied = entries.slice(0, index);
    }
    copied.push([nextKey, next]);
  }
  // fromEntries defines each property, so a `__proto__` name stays a name.
  return copied ? Object.fromEntries(copied) : value;
}

/**
 * Every string in a JSON value (plain objects and arrays, at any depth),
 * property names included, with the secrets replaced. The value itself comes
 * back when nothing changed; otherwise only the changed branches are copies.
 */
export function redactSecretsDeep(value, secrets = []) {
  const normalized = normalizeSecrets(secrets);
  if (!normalized.length) return value;
  return redactValue(value, normalized, 0);
}

/** The saved keys of the registered providers, as `readSetting(settingKey)` has them. */
export function readSavedProviderKeys({ readSetting = () => '', entries = SAVED_PROVIDER_KEY_SETTINGS } = {}) {
  return normalizeSecrets(entries.map((entry) => readSetting(entry.settingKey)));
}

/** Whether a request is a session worker's post with a body to scrub: the header present, even empty. */
export function isWorkerPostRequest(req) {
  const method = String(req?.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  if (req?.headers?.[WORKER_SESSION_HEADER] === undefined) return false;
  return !/^\/api\/settings(?:\/|$)/.test(String(req?.path || ''));
}

/**
 * The middleware: mounted after `express.json()`, before every route. It
 * reads the saved keys once when it is created (the relay's start) and per
 * request (one settings read per provider), so a key saved applies to the
 * next post, and redacts them with every key read or noted before (see the
 * note on key changes above). `noteSavedSetting(settingKey, value)`, on the
 * function returned, is for the settings save path: a registered key saved
 * there is remembered at once, so it stays redacted even when it is changed
 * again before any worker posts.
 */
export function createWorkerPostRedaction({
  readSetting = () => '',
  entries = SAVED_PROVIDER_KEY_SETTINGS,
  log = (line) => console.warn(line),
} = {}) {
  let warned = false;
  // Oldest first; a key read again moves to the end.
  const remembered = new Set();
  let secrets = [];
  const settingKeys = new Set(entries.map((entry) => entry.settingKey));

  function remember(current) {
    let changed = false;
    for (const key of current) {
      if (remembered.delete(key)) {
        remembered.add(key);
        continue;
      }
      remembered.add(key);
      changed = true;
    }
    while (remembered.size > MAX_REMEMBERED_SECRETS) {
      remembered.delete(remembered.values().next().value);
      changed = true;
    }
    if (changed) secrets = normalizeSecrets([...remembered]);
  }

  function readAndRemember() {
    try {
      remember(readSavedProviderKeys({ readSetting, entries }));
    } catch (error) {
      // The settings could not be read: the post loses the keys read before,
      // and the relay says so once rather than refusing every worker post.
      if (!warned) {
        warned = true;
        try { log(`worker post redaction: the saved provider keys could not be read, only those read before are redacted (${error?.message || error})`); } catch {}
      }
    }
  }

  function workerPostRedaction(req, _res, next) {
    if (!isWorkerPostRequest(req) || !req.body || typeof req.body !== 'object') return next();
    readAndRemember();
    if (secrets.length) req.body = redactValue(req.body, secrets, 0);
    return next();
  }

  /** Remembers `value` when `settingKey` is a registered provider key; any other setting is ignored. */
  workerPostRedaction.noteSavedSetting = function noteSavedSetting(settingKey, value) {
    if (!settingKeys.has(settingKey)) return;
    remember(normalizeSecrets([value]));
  };

  readAndRemember();
  return workerPostRedaction;
}
