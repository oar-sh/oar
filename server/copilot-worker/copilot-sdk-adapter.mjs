// The only module in the Copilot SDK worker that touches the installed Copilot
// SDK. Everything else takes an injected client, which is what keeps the unit
// suite spawn-free (DEVELOPING.md): no test in this directory imports the real
// SDK or starts a runtime process.
//
// Two paths matter and they are NOT interchangeable. `COPILOT_SDK_PATH` points
// at the `copilot-sdk` directory bundled inside one CLI version directory:
//
//   ~/.cache/copilot/pkg/<platform>/<version>/copilot-sdk   ← the SDK we import
//   ~/.cache/copilot/pkg/<platform>/<version>/app.js        ← the runtime we spawn
//
// The phase-0 spike observed the npm-loader `copilot` binary running an OLDER
// runtime (1.0.78) than the SDK resolved from the cache (1.0.82). Both spoke
// protocol 3, so nothing broke visibly, but the event shapes this worker
// normalizes are per-version — so the runtime is derived from the SDK's own
// version directory rather than from PATH, and a disagreement between the
// directory version and the runtime's self-reported version is logged.
import path from 'path';
import { pathToFileURL } from 'url';

import {
  buildTerminalFailureText,
  isStructuredQuotaError,
  normalizeTerminalSendAndWaitError,
  toKebabToken,
} from '../../shared/worker-runtime/send-and-wait-errors.mjs';
import {
  MODEL_SWITCH_UNCONFIRMED_CODE,
  MODEL_SWITCH_UNCONFIRMED_STABLE_CODE,
  isModelSwitchUnconfirmedError,
  isRuntimeTransportError,
} from './copilot-model-switch.mjs';
import { copilotRuntimeEntry } from '../copilot-sdk-runtime.mjs';
import { describeTurnStall, isTurnStalledError } from '../../shared/worker-runtime/turn-liveness.mjs';

const VERSION_DIR_RE = /^\d+\.\d+\.\d+$/;

/**
 * The answer handed back to the runtime when the model calls `ask_user` before
 * phase 2 wires the relay question round-trip. Deliberately an *answer* rather
 * than a hang or a thrown handler: the runtime blocks the turn until the
 * handler settles, so refusing in-band lets the model carry on (or say it is
 * blocked) instead of wedging the queue row until the delivery watchdog fires.
 */
export const USER_INPUT_UNSUPPORTED_ANSWER =
  'Interactive questions are not yet supported by the SDK worker, so this question could not be '
  + 'shown to the user. Continue with your best judgement and state the assumption you made, or '
  + 'end the turn explaining what you need.';

export const ELICITATION_UNSUPPORTED_MESSAGE =
  'Structured elicitation is not yet supported by the SDK worker.';

/**
 * Resolve the SDK entry point and its sibling runtime from `COPILOT_SDK_PATH`.
 * Tolerates a path to the SDK's `index.js` as well as to its directory, since
 * the relay currently exports the directory and a hand-run worker
 * (DEVELOPING.md) is easy to point at the file.
 */
export function resolveCopilotSdkPaths({ env = process.env } = {}) {
  const raw = String(env.COPILOT_SDK_PATH || '').trim();
  if (!raw) {
    throw new Error(
      'COPILOT_SDK_PATH is not set — install the GitHub Copilot CLI (so '
      + '~/.cache/copilot/pkg/<platform>/<version>/copilot-sdk exists) or set sdkPath in the relay config.',
    );
  }
  const sdkDir = /[\\/]index\.m?js$/i.test(raw) ? path.dirname(raw) : raw;
  const versionDir = path.dirname(sdkDir);
  const version = path.basename(versionDir);
  return {
    sdkDir,
    sdkEntry: path.join(sdkDir, 'index.js'),
    versionDir,
    // Same version directory as the SDK, and `app.js` rather than the sibling
    // `index.js` launcher — see `copilotRuntimeEntry` and the header.
    runtimeEntry: copilotRuntimeEntry(versionDir),
    version: VERSION_DIR_RE.test(version) ? version : '',
  };
}

/**
 * Compare the version directory the SDK came from with whatever the running
 * runtime reports. Returns a warning string, or null when they agree (or when
 * either side could not be read — an unknown version is not evidence of skew).
 */
export function describeVersionSkew({ bundleVersion = '', runtimeVersion = '' } = {}) {
  const bundle = String(bundleVersion || '').trim();
  const runtime = String(runtimeVersion || '').trim();
  if (!bundle || !runtime || bundle === runtime) return null;
  return `Copilot SDK/runtime version skew: SDK bundle ${bundle}, runtime reports ${runtime}. `
    + 'Event shapes are per-version; reinstall the Copilot CLI if turns behave oddly.';
}

/**
 * Read the runtime's self-reported version without assuming the RPC exists —
 * `getStatus` is not in every CLI build, and a missing status must degrade to
 * "unknown version" rather than failing the worker's first turn.
 */
export async function readRuntimeVersion(client, dbg = () => {}) {
  if (typeof client?.getStatus !== 'function') return '';
  try {
    const status = await client.getStatus();
    return String(status?.version || '').trim();
  } catch (error) {
    dbg('copilot runtime getStatus failed', error?.message || String(error));
    return '';
  }
}

/**
 * Build the stdio connection descriptor for the runtime. `RuntimeConnection`
 * is the documented constructor; the plain object literal is the shape it
 * produces and is accepted directly by older bundles, so it stands in when the
 * export is missing rather than hard-failing on a version difference.
 */
export function buildRuntimeConnection(sdk, runtimeEntry) {
  if (typeof sdk?.RuntimeConnection?.forStdio === 'function') {
    return sdk.RuntimeConnection.forStdio({ path: runtimeEntry });
  }
  return { kind: 'stdio', path: runtimeEntry };
}

/**
 * Watch for the runtime process dying under a live session.
 *
 * The SDK exposes no public hook for this (verified against 1.0.82: no
 * `on`/`addEventListener`, no `onExit`/`onClose` client option, and the
 * JSON-RPC `onClose`/`onError` handlers set a private `state` field and
 * discard the error). What it does have is `processExitPromise` — a
 * TS-private, runtime-visible promise that rejects with the exit code and
 * captured stderr when the spawned CLI exits. It is already `.catch()`-ed
 * internally, so attaching another handler is safe.
 *
 * Reaching past the public API is deliberate and bounded: without it a dead
 * runtime wedges the queue row until the relay's delivery watchdog gives up
 * ~an hour later, because the worker's 10s heartbeat keeps renewing the
 * processing lease. If a future bundle drops the field this degrades to no
 * detection (the session-process's `session.shutdown` handling is the second,
 * public-API line of defence), never to a crash.
 */
export function observeRuntimeExit(client, onExit) {
  if (!client || typeof onExit !== 'function') return () => {};
  let live = true;
  const fire = (detail) => {
    if (!live) return;
    live = false;
    onExit(String(detail || '').trim() || 'the runtime process exited');
  };

  const exitPromise = client.processExitPromise;
  if (exitPromise && typeof exitPromise.then === 'function') {
    exitPromise.then(
      () => fire('the runtime process exited'),
      (error) => fire(error?.message || String(error)),
    );
  } else if (typeof client.on === 'function') {
    // Forward-compatibility only: no shipped bundle exposes this.
    try {
      client.on('exit', (code) => fire(`the runtime process exited with code ${code}`));
    } catch {
      // An `on` that is not an emitter is not worth failing the worker over.
    }
  }
  return () => { live = false; };
}

/**
 * The pid of the runtime process, or 0.
 *
 * Like `processExitPromise` this reaches past the public API: the SDK starts
 * the runtime itself (`spawn` without `detached`, no option for a spawn
 * function of our own, verified against 1.0.89 and the npm package 1.0.14) and
 * keeps the child in `cliProcess`, a TS-private, runtime-visible field that
 * `stop()` and `forceStop()` clear. It is read once, right after the start. A
 * bundle without the field reads as "not known", and the runtime's commands
 * are then not watched.
 */
export function readRuntimePid(client) {
  const pid = Number(client?.cliProcess?.pid);
  return Number.isInteger(pid) && pid > 1 ? pid : 0;
}

/**
 * Import the installed SDK and start a client against the matching runtime.
 *
 * The version-skew probe is deliberately NOT awaited: `getStatus` is a round
 * trip to a process that has just started, and blocking the first turn's
 * readiness on a diagnostic is the wrong trade. `versionReady` resolves with
 * the answer for callers that want to log it.
 */
export async function startCopilotClient({
  paths,
  cwd,
  logLevel = 'error',
  clientName = 'copilot-web-relay',
  importImpl = (href) => import(href),
  dbg = () => {},
} = {}) {
  const sdk = await importImpl(pathToFileURL(paths.sdkEntry).href);
  if (typeof sdk?.CopilotClient !== 'function') {
    throw new Error(`CopilotClient not found in the installed Copilot SDK (${paths.sdkEntry})`);
  }
  const client = new sdk.CopilotClient({
    connection: buildRuntimeConnection(sdk, paths.runtimeEntry),
    workingDirectory: cwd,
    clientName,
    logLevel,
  });
  await client.start();
  const versionReady = readRuntimeVersion(client, dbg).then((runtimeVersion) => ({
    runtimeVersion,
    versionSkewWarning: describeVersionSkew({ bundleVersion: paths.version, runtimeVersion }),
  }));
  // The caller logs it; this only guarantees the promise is never unhandled.
  versionReady.catch(() => {});
  return { sdk, client, paths, versionReady };
}

// ------------------------------------------------------------- permissions --

/**
 * Permission request kinds that only READ. `read` is the runtime's own
 * read-only variant; `mcp` and `custom-tool` carry an explicit `readOnly`
 * flag; a `shell` request is read-only when every parsed command segment says
 * so. Everything else (write, url, memory, hook, extension management) mutates
 * something and is treated as an action.
 */
export function isReadOnlyPermissionRequest(request) {
  const kind = String(request?.kind || '').trim().toLowerCase();
  if (kind === 'read') return true;
  if (kind === 'mcp' || kind === 'custom-tool') return request?.readOnly === true;
  if (kind === 'shell') {
    const commands = Array.isArray(request?.commands) ? request.commands : [];
    return commands.length > 0 && commands.every((command) => command?.readOnly === true);
  }
  return false;
}

/** A short, user-readable name for what a permission request wanted to do. */
export function describePermissionRequest(request) {
  const kind = String(request?.kind || 'tool').trim() || 'tool';
  const detail = String(
    request?.fullCommandText
    || request?.fileName
    || request?.path
    || request?.url
    || request?.toolName
    || request?.intention
    || '',
  ).trim();
  return detail ? `${kind}: ${detail}` : kind;
}

/**
 * Map the relay's conversation mode onto a permission decision, mirroring the
 * policy the Claude worker enforces through `permissionModeForRelayMode`:
 * plan-shaped modes must not mutate the workspace, and everything else runs.
 *
 * `plan` and `ask` deny anything that is not read-only. `agent`, `autopilot`
 * and anything unrecognised auto-approve, which is phase 1's contract — there
 * is no relay question round-trip yet, so a prompt would only be a hang.
 *
 * The decision `kind`s here are the runtime's own vocabulary. `approve-once`
 * and `reject` are verified against the runtime; the typed-looking
 * `{kind:"allow"}` is REJECTED ("unknown variant `allow`") and silently fails
 * the tool call, so it must never be emitted.
 */
export function copilotPermissionDecision(relayMode, request) {
  const mode = String(relayMode || 'agent').trim().toLowerCase();
  if (mode !== 'plan' && mode !== 'ask') return { kind: 'approve-once' };
  if (isReadOnlyPermissionRequest(request)) return { kind: 'approve-once' };
  return {
    kind: 'reject',
    feedback: `This conversation is in ${mode} mode, so the relay declined "${describePermissionRequest(request)}". `
      + 'Read-only work is allowed; describe the change you would make instead of making it, or ask the user to '
      + 'switch the conversation to agent mode.',
  };
}

/**
 * Does this relay mode ask the human before a mutating tool runs, rather than
 * deciding locally? Only `ask` does: `plan` is a "describe, do not act" mode
 * where a prompt on every tool would be noise, and agent/autopilot run
 * unattended by definition.
 */
export function relayModeAsksBeforeActing(relayMode) {
  return String(relayMode || '').trim().toLowerCase() === 'ask';
}

/**
 * Build the runtime's `onPermissionRequest` handler.
 *
 * Modes split three ways:
 *
 *  - agent / autopilot / anything unrecognised — auto-approve, unchanged.
 *  - plan — deny non-read tools with feedback, unchanged from phase 1. A card
 *    per tool call would be noise in a mode whose whole point is not acting.
 *  - ask — route the decision to the human through a relay question card.
 *
 * Read-only requests short-circuit to `approve-once` in every mode: prompting
 * to read a file the model is already allowed to read is pure friction.
 *
 * The returned decision `kind`s stay inside the runtime's verified vocabulary
 * (`approve-once` / `reject` / `user-not-available`). `{kind:"allow"}` does not
 * exist and is rejected with "unknown variant `allow`".
 */
export function createCopilotPermissionHandler({
  bridge = null,
  getRelayMode = () => 'agent',
  getSignal = () => null,
  dbg = () => {},
} = {}) {
  return async function onPermissionRequest(request) {
    const relayMode = getRelayMode();
    if (!relayModeAsksBeforeActing(relayMode) || !bridge) {
      return copilotPermissionDecision(relayMode, request);
    }
    if (isReadOnlyPermissionRequest(request)) return { kind: 'approve-once' };
    try {
      const { approved, feedback, timedOut, description } = await bridge.askToolApproval(request, {
        signal: getSignal(),
      });
      if (timedOut) {
        // The runtime's own "nobody answered" verdict. Deliberately not a
        // `reject`: a rejection reads to the model as a considered refusal it
        // should work around, while this reads as an absent human.
        dbg('permission question timed out', description);
        return { kind: 'user-not-available' };
      }
      if (approved) return { kind: 'approve-once' };
      // The bridge composes the note (a freeform denial carries the human's own
      // reason; a plain "Deny" click gets a generic one), so the choice labels
      // stay in one module.
      return { kind: 'reject', feedback: feedback || 'The user declined this action.' };
    } catch (error) {
      // The relay is unreachable or the card could not be created. Falling
      // back to the local policy keeps the turn moving; throwing would be
      // auto-answered `user-not-available` by the SDK with no explanation.
      dbg('permission question failed, falling back to the local policy', error?.message || String(error));
      return copilotPermissionDecision(relayMode, request);
    }
  };
}

/**
 * The relay mode expressed in the runtime's own `MessageOptions.agentMode`
 * vocabulary, so the runtime's built-in mode behaviour lines up with the
 * permission policy above instead of fighting it. Unknown relay modes fall
 * back to `interactive` (the runtime's normal agent mode).
 */
export function copilotAgentModeForRelayMode(relayMode) {
  const mode = String(relayMode || '').trim().toLowerCase();
  if (mode === 'plan') return 'plan';
  if (mode === 'autopilot') return 'autopilot';
  return 'interactive';
}

// ---------------------------------------------------------- classification --

/**
 * Quota exhaustion is the one Copilot failure that must never be retried: the
 * billing window has to reset first. The runtime signals it three redundant
 * ways (`errorCode`, `errorType`, HTTP 402) and the spike saw all three on the
 * same event, so any one of them is enough — the prose is only the last resort
 * because GitHub has reworded it before ("premium requests" → "AI credits").
 */
export function isCopilotQuotaError(data) {
  if (isStructuredQuotaError(data)) return true;
  const message = String(data?.message || '');
  if (/quota/i.test(message) && /(exceed|exhaust)/i.test(message)) return true;
  // GitHub's CURRENT wording ("You have reached your monthly quota …",
  // "reached your usage limit/allowance") says "reached", not "exceeded" — and
  // the SDK's `sendAndWait` rebuilds a plain Error from the session error's
  // MESSAGE alone (session.js ~467-495), so a `session.error` can arrive with
  // no structured field to save it from the prose branch. The possessive
  // ("your") keeps this off impersonal transient limits ("context length
  // limit reached"), and rate limits are excluded outright: they reset in
  // seconds, quota resets with the billing window.
  if (/rate.?limit/i.test(message)) return false;
  return /\b(?:reached|hit|used up|exhausted)\b[^.!\n]{0,60}\byour\b[^.!\n]{0,40}\b(?:quota|limit|allowance)\b/i
    .test(message);
}

/**
 * Classify a `session.error` payload into a terminal failure record.
 *
 * The wording, `stableCode` and guidance come from the extension's own
 * classifier (`send-and-wait-errors.mjs`) rather than being re-typed here, so
 * a conversation that fails on the SDK engine reads identically to one that
 * failed on the extension engine — including `relay.quota-exhausted` and the
 * "Open Check Usage" pointer shipped in 37d2899. The structured quota verdict
 * is passed to that classifier as a hint rather than smuggled in as forged
 * prose, so a quota error is non-retryable however GitHub worded it.
 */
export function classifyCopilotSessionError(data) {
  const detail = String(data?.message || '').trim() || 'the Copilot runtime reported a session error';
  const quota = isCopilotQuotaError(data);
  const probe = new Error(detail);
  const hint = { quota };
  const normalized = normalizeTerminalSendAndWaitError(probe, hint);
  if (normalized) {
    return {
      code: normalized.code,
      stableCode: normalized.stableCode,
      text: buildTerminalFailureText(probe, hint),
      detail,
      quota,
    };
  }
  // The SAME auth branch the thrown-exception path takes (audit #15): a
  // `session.error` tagged `errorType: "authentication"`/`"authorization"`, an
  // auth `errorCode`, or HTTP 401 is a relay-host sign-in problem, and generic
  // "retry" guidance sends the user in circles. `isCopilotAuthError` reads the
  // structured `ErrorData` fields first and falls back to prose.
  if (isCopilotAuthError(data)) {
    return { ...copilotAuthClassification(detail), quota: false };
  }
  const code = toKebabToken(data?.errorType) || toKebabToken(data?.errorCode) || 'session-error';
  return {
    code,
    stableCode: `copilot.${code}`,
    text: `System note: the Copilot turn failed (${detail}). Retry or send a new message.`,
    // Without one the relay adds its default, which advises a retry.
    guidance: COPILOT_TURN_FAILURE_GUIDANCE,
    detail,
    quota: false,
  };
}

// Phrases that only ever appear in a real auth failure. Deliberately narrow:
// the loose predecessor matched an unanchored `401` (so `ECONNREFUSED
// 127.0.0.1:40123` read as an auth failure) and a bare `log in` (so `backlog
// in progress` did), and a misfiled auth error tells the user to go re-run
// `copilot` on the relay host for a problem that a retry would have fixed.
const AUTH_ERROR_RE = new RegExp([
  'authentication (?:failed|error|required)',
  'authorization (?:failed|error|required)',
  'unauthenti(?:cated|cation)',
  '\\bunauthorized\\b',
  '\\b401\\b',
  'not (?:logged|signed) in',
  '(?:logged|signed) out',
  'please (?:log|sign) in',
  '(?:log|sign) in to',
  '(?:invalid|missing|expired) (?:credential|token|api key)',
  'credentials? (?:are )?(?:invalid|missing|expired)',
  'token (?:is )?(?:invalid|expired)',
].join('|'), 'i');

// The runtime's own `ErrorData.errorType` category for auth, plus the codes a
// thrown transport error carries.
const AUTH_ERROR_CODES = new Set([
  'authentication',
  'authorization',
  'unauthorized',
  'unauthenticated',
  'authentication_failed',
  'not_logged_in',
  'credentials_invalid',
]);

/**
 * The one auth failure record, shared verbatim by the session-event and
 * thrown-exception classifiers so the remediation cannot drift between them:
 * the fix is a user action on the relay host, never a retry.
 */
function copilotAuthClassification(detail) {
  return {
    code: 'authentication_failed',
    stableCode: 'copilot.authentication_failed',
    text: `System note: the Copilot runtime could not authenticate (${detail}). `
      + 'Run `copilot` on the relay host and sign in, then retry.',
    detail,
  };
}

/**
 * Structured auth signals first (the runtime tags `errorType: "authentication"`
 * and HTTP 401), prose only as the fallback.
 */
export function isCopilotAuthError(error) {
  if (error && typeof error === 'object') {
    for (const field of ['code', 'errorCode', 'errorType']) {
      const token = String(error[field] || '').trim().toLowerCase();
      if (token && AUTH_ERROR_CODES.has(token)) return true;
    }
    if (Number(error.statusCode ?? error.status) === 401) return true;
  }
  return AUTH_ERROR_RE.test(String(error?.message || error || ''));
}

/**
 * What the relay appends to a failed Copilot turn in place of its own default
 * (which advises a retry). The worker deals with its runtime itself: a delivered
 * turn that failed tore it down and the next message starts a fresh one, so a
 * relay restart repairs nothing here and costs every other running session.
 * That holds for a failure the runtime reports as a session error too.
 * Sign-in and quota failures keep the wording of their own.
 */
export const COPILOT_TURN_FAILURE_GUIDANCE =
  'If this keeps failing, include the error code when you report it; the relay does not need a restart.';
export const COPILOT_TURN_RETRY_GUIDANCE = 'Send the message again to retry.';
export const COPILOT_TURN_CONTINUE_GUIDANCE =
  'Send a message to continue: the session keeps the work so far, so the agent carries on from there.';

/**
 * Classify a thrown error (client start, session create/resume, `send`) rather
 * than a `session.error` event. Auth gets its own branch because the fix is a
 * user action on the relay host, not a retry.
 */
export function classifyCopilotTurnException(error) {
  const detail = String(error?.message || error || '').trim() || 'unknown error';
  // An unconfirmed explicit model selection (audit #13). The error's own
  // message already names requested vs actual model, so it IS the user-facing
  // text; the stable code is what lets the UI (and tests) key on it.
  if (isModelSwitchUnconfirmedError(error)) {
    return {
      code: MODEL_SWITCH_UNCONFIRMED_CODE,
      stableCode: MODEL_SWITCH_UNCONFIRMED_STABLE_CODE,
      text: detail,
      detail,
    };
  }
  // The quota hint mirrors the session-event path: sendAndWait-shaped errors
  // carry only the prose, and "reached your monthly quota" must be terminal
  // however the error arrived.
  const hint = { quota: isCopilotQuotaError(error) };
  const terminal = normalizeTerminalSendAndWaitError(error, hint);
  if (terminal) {
    return {
      code: terminal.code,
      stableCode: terminal.stableCode,
      text: buildTerminalFailureText(error, hint),
      detail,
    };
  }
  if (isCopilotAuthError(error)) {
    return copilotAuthClassification(detail);
  }
  // The stall watchdog's failure: the turn is not known to be broken, only
  // silent, and the user is told that — and what the runtime was doing —
  // rather than "the turn failed".
  if (isTurnStalledError(error)) {
    return {
      code: 'turn-stalled',
      stableCode: 'copilot.turn-stalled',
      text: describeTurnStall(error),
      guidance: COPILOT_TURN_RETRY_GUIDANCE,
      detail,
    };
  }
  return {
    code: 'turn-error',
    stableCode: 'copilot.turn-error',
    text: `System note: the Copilot turn failed (${detail}). Retry or send a new message.`,
    guidance: COPILOT_TURN_FAILURE_GUIDANCE,
    detail,
  };
}

/**
 * Did `resumeSession` fail because the session does not exist, or because the
 * call itself failed?
 *
 * This distinction decides whether the worker may start a fresh session over
 * an existing conversation. The runtime throws a plain
 * `Error("Session not found: <id>")` which JSON-RPC wraps as a generic
 * InternalError (-32603), so the code cannot carry the answer and the message
 * has to. Anything that is not recognisably "no such session" — a dropped
 * connection, a transport error, an unrecognised failure — is treated as
 * transient, because guessing wrong there silently discards the whole
 * conversation history.
 */
export function isSessionNotFoundError(error) {
  if (isRuntimeTransportError(error)) return false;
  const detail = String(error?.message || error || '').toLowerCase();
  if (!detail) return false;
  if (/\b(?:session|conversation)\b[^.]{0,40}\bnot found\b/.test(detail)) return true;
  if (/\bno (?:such|saved) (?:session|conversation)\b/.test(detail)) return true;
  if (/\bunknown session\b/.test(detail)) return true;
  return /\bsession\b[^.]{0,40}\bdoes not exist\b/.test(detail);
}
