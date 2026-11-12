// Addresses on another relay's web UI that this page opens in a new window
// (agent auth §13.2): a question to answer there (`?answer=<id>&option=<n>`),
// a Settings tab there (`?settings=<tab>[&add-relay=1]`), its start page.
// Every one is built with `new URL` from the paired relay's stored address,
// http(s) only, and checked to stay on that relay's origin. None carries a
// token, a code or a return address.
//
// The checks the other relay makes on the same parameters (answer-there.js,
// settings-deep-link.mjs) use the same patterns from here.

// A question id as the relays make them (cards: UUIDs, asks: `ask_…`).
export const ANSWER_THERE_QID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
// The highest option index a link may carry (a card has a handful).
export const ANSWER_THERE_OPTION_MAX = 99;

function toText(value) {
  return String(value ?? '').trim();
}

/**
 * The relay's base address as a URL ending in '/', or null: http(s) only,
 * no user name or password, no query or fragment kept.
 */
export function relayBaseUrl(raw) {
  const text = toText(raw);
  if (!/^https?:\/\//i.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url;
}

/**
 * `<relay>/?<params>` on that relay's own origin, or '' when the stored
 * address is no usable one. `origin`: the origin the result must have (the
 * stored entry's), when the caller holds it apart from `raw`.
 */
export function relayPageUrl(raw, params = {}, { origin = '' } = {}) {
  const base = relayBaseUrl(raw);
  if (!base) return '';
  if (origin && base.origin !== origin) return '';
  const url = new URL(base.href);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.origin === base.origin ? url.href : '';
}

/** Whether `value` is an option index a link may carry. */
export function isAnswerThereOption(value) {
  return Number.isInteger(value) && value >= 0 && value <= ANSWER_THERE_OPTION_MAX;
}

/**
 * The popup's address for one question on a paired relay: `<B>/?answer=<qid>`
 * and, given one, `&option=<n>` (the option to preselect there; nothing is
 * answered by the address). '' for a bad address, id or option.
 */
export function answerThereUrl(relayUrl, qid, option = null, { origin = '' } = {}) {
  const id = toText(qid);
  if (!ANSWER_THERE_QID_PATTERN.test(id)) return '';
  if (option !== null && option !== undefined && !isAnswerThereOption(option)) return '';
  return relayPageUrl(relayUrl, { answer: id, option: option ?? null }, { origin });
}

/** `<B>/?settings=<tab>` (and `&add-relay=1`): Settings there, nothing more. */
export function relaySettingsUrl(relayUrl, tab, { addRelay = false } = {}) {
  return relayPageUrl(relayUrl, { settings: toText(tab), 'add-relay': addRelay ? '1' : null });
}

/**
 * Whether two addresses are on the same host but another port: cookies are
 * scoped by host, not port, so two relays there share one sign-in cookie and
 * sign each other out (agent auth §13.10).
 */
export function sameHostOtherPort(a, b) {
  const left = relayBaseUrl(a);
  const right = relayBaseUrl(b);
  if (!left || !right) return false;
  const port = (url) => url.port || (url.protocol === 'https:' ? '443' : '80');
  return left.hostname.toLowerCase() === right.hostname.toLowerCase() && port(left) !== port(right);
}
