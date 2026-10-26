// Questions that don't block: relay_tool's `ask` puts a question for the
// owner into a session (a card there and in the Inbox) and returns at once;
// the asking session keeps working and is told the answer later, as a relay
// event (question_answered).
//
// One ask is `{ id, kind: 'ask', session, question, options, recommendation,
// detail, urgency, status, answer, choice, createdBy, creator, ... }`. Its
// `status` is pending until the owner answers or dismisses it, or the agent
// that asked withdraws it.
//
// Every text of an ask is written by an agent, possibly on another relay:
// whoever shows it shows it as plain text.
//
// SDK-free and side-effect free: imported by the server, the relay_tool
// contract and the browser.

// The kind a question card carries in /api/relay-questions and the Inbox:
// `ask` (this feature), `approval` (a relay's Allow / Deny card on its own
// agent's call, context.source REMOTE_RELAY_APPROVAL_SOURCE), `ask_user`
// (every other card a turn waits on).
export const RELAY_QUESTION_KINDS = Object.freeze(['ask', 'ask_user', 'approval']);

// The approval card's `context.source`, re-exported by the contract, which
// imports this module (defined here so neither import goes in a circle).
// Stored and sent between relays, so it kept the tool's name from before
// 0.9.18.
export const REMOTE_RELAY_APPROVAL_SOURCE = 'remote_relay';
export const RELAY_ASK_KIND = 'ask';

export const RELAY_ASK_URGENCIES = Object.freeze(['normal', 'now']);
export const RELAY_ASK_STATUSES = Object.freeze(['pending', 'answered', 'dismissed', 'withdrawn', 'cancelled']);
// What the Inbox lists under its divider (for answeredKeepMs).
export const RELAY_ASK_CLOSED_STATUSES = Object.freeze(['answered', 'dismissed']);

// Socket event the relay sends on every change of an ask (`{ ask }`) and
// of the Inbox's count (`{ pending }`).
export const RELAY_ASK_SOCKET_EVENT = 'relay_ask_updated';

export const RELAY_ASK_LIMITS = Object.freeze({
  questionMax: 500,
  optionsMax: 8,
  optionMax: 120,
  recommendationMax: 300,
  detailMax: 2000,
  // Pending asks one conversation may have asked (for itself and others), and
  // pending asks one session may have open.
  pendingPerConversation: 20,
  // How long an answered or dismissed ask stays in the Inbox, under its divider.
  answeredKeepMs: 24 * 60 * 60_000,
  // Closed asks are kept this long, then pruned.
  closedKeepMs: 7 * 24 * 60 * 60_000,
  // The asking relay looks for answers to its asks on a paired relay this often.
  remotePollMs: 5_000,
  remotePollFailingMs: 30_000,
  listMax: 200,
});

// Ask ids carry this prefix: the question routes tell them from cards by it.
export const RELAY_ASK_ID_PREFIX = 'ask_';

export function isRelayAskId(value) {
  return /^ask_[a-z0-9]{6,40}$/.test(String(value ?? '').trim());
}

function toText(value) {
  return String(value ?? '').trim();
}

// Control characters of agent text go; line breaks stay in the detail only.
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]+/g;

function oneLine(value) {
  return String(value ?? '').replace(CONTROLS, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function multiLine(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(CONTROLS, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

function invalid(error) {
  return { ok: false, error };
}

/**
 * An ask as an agent writes it, checked: `{ ok, value: { question, options,
 * recommendation, detail, urgency } }` or `{ ok:false, error }`. Too long is
 * refused, never cut: the owner decides on the words the agent chose. The
 * recommendation may name an option (matched case-insensitively, then given
 * the option's spelling) or be free text.
 */
export function normalizeRelayAskInput(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const question = oneLine(source.question);
  if (!question) return invalid('ask needs question (the question for the owner, at most 500 characters)');
  if (question.length > RELAY_ASK_LIMITS.questionMax) {
    return invalid(`question is longer than ${RELAY_ASK_LIMITS.questionMax} characters; put the background in detail`);
  }
  let rawOptions = source.options;
  if (rawOptions === undefined || rawOptions === null || rawOptions === '') rawOptions = [];
  if (typeof rawOptions === 'string') rawOptions = rawOptions.split(/\r?\n/);
  if (!Array.isArray(rawOptions)) return invalid('options must be a list of short labels');
  const options = [];
  for (const raw of rawOptions) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return invalid('options must be a list of short labels');
    const label = oneLine(raw);
    if (!label) continue;
    if (label.length > RELAY_ASK_LIMITS.optionMax) return invalid(`an option is longer than ${RELAY_ASK_LIMITS.optionMax} characters: "${label.slice(0, 40)}…"`);
    if (options.some((option) => option.toLowerCase() === label.toLowerCase())) continue;
    options.push(label);
  }
  if (options.length > RELAY_ASK_LIMITS.optionsMax) return invalid(`options takes at most ${RELAY_ASK_LIMITS.optionsMax} labels`);
  let recommendation = oneLine(source.recommendation);
  if (recommendation.length > RELAY_ASK_LIMITS.recommendationMax) {
    return invalid(`recommendation is longer than ${RELAY_ASK_LIMITS.recommendationMax} characters`);
  }
  const named = options.find((option) => option.toLowerCase() === recommendation.toLowerCase());
  if (named) recommendation = named;
  const detail = multiLine(source.detail);
  if (detail.length > RELAY_ASK_LIMITS.detailMax) return invalid(`detail is longer than ${RELAY_ASK_LIMITS.detailMax} characters`);
  const urgency = toText(source.urgency).toLowerCase() || 'normal';
  if (!RELAY_ASK_URGENCIES.includes(urgency)) return invalid(`urgency must be one of: ${RELAY_ASK_URGENCIES.join(', ')}`);
  return { ok: true, value: { question, options, recommendation, detail, urgency } };
}

/**
 * The owner's answer to an ask: `{ ok, value: { answer, choice } }` or
 * `{ ok:false, error }`. `choice` is the option picked (its own spelling),
 * `answer` the text the asker reads: the typed text, else the choice.
 */
export function normalizeRelayAskAnswer(ask, { answer = '', choice = '' } = {}) {
  const options = Array.isArray(ask?.options) ? ask.options : [];
  const wanted = oneLine(choice);
  let picked = '';
  if (wanted) {
    picked = options.find((option) => option.toLowerCase() === wanted.toLowerCase()) || '';
    if (!picked) return invalid(`"${wanted.slice(0, 80)}" is not an option of this question`);
  }
  const text = multiLine(answer).slice(0, RELAY_ASK_LIMITS.detailMax);
  if (!picked && !text) return invalid('An answer needs a choice or some text');
  // A typed text that is an option counts as that choice.
  if (!picked) picked = options.find((option) => option.toLowerCase() === oneLine(text).toLowerCase()) || '';
  return { ok: true, value: { answer: text || picked, choice: picked } };
}

/** The kind of a formatted question card (a row of /api/relay-questions). */
export function relayQuestionKind(question) {
  const kind = toText(question?.kind);
  if (RELAY_QUESTION_KINDS.includes(kind)) return kind;
  const context = question && typeof question.context === 'object' && question.context ? question.context : {};
  return toText(context.source) === REMOTE_RELAY_APPROVAL_SOURCE ? 'approval' : 'ask_user';
}
