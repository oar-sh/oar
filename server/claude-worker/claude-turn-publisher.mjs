import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  CLAUDE_LIVE_FLAG_SETTINGS_CODE,
  CLAUDE_LIVE_FLAG_SETTINGS_GUIDANCE,
  classifyClaudeResultFailure,
  claudeFailureGuidance,
} from './claude-turn-failure.mjs';
import { countPlanLikeLines } from '../../shared/plan-lines.mjs';
import { PLAN_BOARD_ACTIONS } from '../../shared/plan-board-actions.mjs';
import { EMPTY_TURN_COMPLETION_NOTE } from '../../shared/empty-turn-completion.mjs';
import { buildSteerSettleFailure, steerSettleFailureText } from '../../shared/steer-settle-failure.mjs';
import { buildUsageLimitFailure } from '../../shared/claude-usage-limit.mjs';
import { WORKING_DIRECTORY_MISSING_CODE, isWorkingDirectoryMissingError } from '../../shared/worker-runtime/working-directory.mjs';
import { claudeBillingTotals, claudeSearchTotals, claudeTokenTotals, claudeToolRequests, claudeUsageTotals } from './claude-usage-totals.mjs';

/**
 * The attempt-fencing echo for a row's write bodies. Every publish that names
 * a `messageId` also names the attempt it belongs to, so the relay can refuse
 * writes from a superseded attempt (a requeued row re-delivered elsewhere).
 * Omitted entirely when the row carries no attempt id (a pre-fencing relay).
 */
export function attemptFields(message) {
  return message?.attemptId ? { attemptId: message.attemptId } : {};
}

/** A 409 whose detail names `stale_attempt`: this attempt was superseded. */
export function isStaleAttemptError(error) {
  if (Number(error?.status) !== 409) return false;
  const detail = typeof error?.detail === 'string' ? error.detail : JSON.stringify(error?.detail || '');
  return detail.includes('stale_attempt');
}

export { buildSteerSettleFailure, steerSettleFailureText };
export const STEER_SETTLE_FAILED_TEXT = steerSettleFailureText('folded');

export function buildClaudePlanReadyBoardPayload({ message, planText = '' } = {}) {
  const summary = String(planText || '').trim();
  if (!summary) return null;
  return {
    queueId: message?.id,
    messageId: message?.id,
    conversationId: message?.conversationId,
    mode: message?.relayMode || 'agent',
    boardType: 'plan_ready',
    title: 'Plan ready for review',
    body: summary,
    actions: PLAN_BOARD_ACTIONS,
    recommendedAction: null,
    context: {
      source: 'exit_plan_mode',
      queueMessageId: message?.id || null,
      conversationId: message?.conversationId || null,
      relayMode: message?.relayMode || 'agent',
    },
  };
}

/**
 * The relay-facing half of a Claude turn: normalized actions in, HTTP calls to
 * the relay's activity/stream/response channels out. Owns no turn or process
 * state — every function takes the turn's relay message and the caller's
 * mutable turn state, so the session process can run any number of turns
 * (delivered or background-continuation) through one publisher.
 */
export function createClaudeTurnPublisher({
  api,
  dbg = () => {},
  takeWorkflowRuns = null,
  // A backend's own reading of a failed request (`{ code, guidance }` or
  // null) and its name in the notes; null for Claude. It gets the error a
  // turn ended with, when there is one, beside its text and status.
  describeFailure = null,
  runtimeLabel = 'Claude',
  // The namespace of a backend's failure codes (DeepSeek: `deepseek`): its
  // failures print as `relay.deepseek-<code>`, which the browser's buttons
  // key on (relay-error-ctas.mjs), not as Claude's `relay.claude-<code>`.
  failureCodePrefix = null,
  // False for a backend that is not Claude's: no Claude plan windows or cost.
  reportsPlanUsage = true,
  // A backend's own usage route (DeepSeek: /api/deepseek-plan-usage), which
  // takes the CLI's token totals per model in place of the Claude plan
  // usage, and the relay's id of a model the CLI names.
  usageRoute = null,
  usageModelKey = null,
  // The relay's id of a model the backend's CLI names ("deepseek-flash[1m]"
  // → "deepseek-flash"); identity for Claude, whose `[1m]` is a real tier.
  relayModel = (value) => value,
  // The Claude API booking (POST /api/claude-api-usage), which both Claude
  // workers report to after every turn, whatever else they report: a chat
  // moves between the subscription and the key and keeps its session.
  // `billingKind` is the worker's kind.
  billingUsageRoute = null,
  billingKind = null,
  // The token booking (POST /api/turn-token-usage): the provider a
  // turn's tokens are reported under (the worker's kind: 'claude',
  // 'claude-api', 'deepseek'), null for none. `turnTokenCost(entry, at)`
  // prices a model's share of a turn where Claude Code's own estimate does
  // not fit (DeepSeek: `{ costUsd, costSource }`, costUsd null when unknown).
  turnTokenProvider = null,
  turnTokenCost = null,
} = {}) {
  /** `{ code, stableCode }` of a failure code, in the backend's namespace. */
  function failureCodes(code) {
    if (!failureCodePrefix) return { code, stableCode: `claude.${code}` };
    const prefixed = String(code).startsWith(`${failureCodePrefix}-`) ? code : `${failureCodePrefix}-${String(code).replace(/_/g, '-')}`;
    return { code: prefixed, stableCode: prefixed };
  }

  /**
   * The Claude reading of a failed result, in the backend's namespace. A
   * backend gets no Claude account or sign-in advice: the relay's default
   * fits where the backend has none of its own.
   */
  function classifyResultFailure(result) {
    const classified = classifyClaudeResultFailure(result);
    if (!failureCodePrefix) return classified;
    return { ...failureCodes(classified.code), guidance: classified.code === 'model_not_found' ? classified.guidance : null };
  }

  function backendFailure(errorText, status = null, error = null) {
    if (typeof describeFailure !== 'function') return null;
    const described = describeFailure(errorText, { status, ...(error ? { error } : {}) });
    return described?.code ? described : null;
  }

  function drainWorkflowRuns({ terminal = false } = {}) {
    if (terminal || typeof takeWorkflowRuns !== 'function') return null;
    return takeWorkflowRuns();
  }

  async function postActivity(message, text, subagentRunId = null, metadata = null) {
    if (!text) return;
    await api('POST', '/api/activity', {
      messageId: message.id,
      conversationId: message.conversationId,
      mode: message.relayMode || 'agent',
      text,
      ...(subagentRunId ? { subagentRunId } : {}),
      ...(metadata && typeof metadata === 'object' ? { metadata } : {}),
      ...attemptFields(message),
    }).catch(() => {});
  }

  async function dispatchAction(message, action, state) {
    const { channel, payload } = action;
    if (channel === 'init') {
      state.responseModel = payload.model || state.responseModel;
      return;
    }
    if (channel === 'stream') {
      // Only the main thread's text can stand in for the answer. Subagent text
      // is forwarded too (forwardSubagentText), and letting it land here would
      // publish a subagent's prose as the reply on the abort / error / no-result
      // fallback paths below.
      if (!payload.subagentRunId) state.lastStreamedText = payload.text;
      await api('POST', '/api/stream', {
        messageId: message.id,
        conversationId: message.conversationId,
        mode: message.relayMode || 'agent',
        text: payload.text,
        done: payload.done === true,
        ...(payload.subagentRunId ? { subagentRunId: payload.subagentRunId } : {}),
        ...attemptFields(message),
      }).catch(() => {});
      return;
    }
    if (channel === 'thought') {
      await api('POST', '/api/thought', {
        messageId: message.id,
        conversationId: message.conversationId,
        mode: message.relayMode || 'agent',
        reasoningId: payload.reasoningId,
        text: payload.text,
        done: payload.done === true,
        ...(payload.subagentRunId ? { subagentRunId: payload.subagentRunId } : {}),
        ...attemptFields(message),
      }).catch(() => {});
      return;
    }
    if (channel === 'activity') {
      await postActivity(message, payload.text, payload.subagentRunId, payload.metadata || null);
      return;
    }
    if (channel === 'subagent') {
      await api('POST', '/api/subagent-run', {
        messageId: message.id,
        conversationId: message.conversationId,
        subagentRunId: payload.subagentRunId,
        parentSubagentId: payload.parentSubagentId || undefined,
        displayName: payload.displayName || undefined,
        status: payload.status,
        ...(payload.subagentType ? { subagentType: payload.subagentType } : {}),
        ...(payload.background ? { background: true } : {}),
        ...(payload.timelineOwner ? { timelineOwner: payload.timelineOwner } : {}),
        ...attemptFields(message),
      }).catch(() => {});
      return;
    }
    if (channel === 'result') {
      state.result = payload;
      state.modelUsage = payload.modelUsage || null;
      const text = String(payload.text || '').trim();
      if (text) state.resultTexts.push(text);
    }
  }

  /**
   * Ship the turn's context-window breakdown to the relay, which serves it back
   * to the UI as the composer indicator and the context-usage modal. Advisory
   * data: a failure here must not disturb the turn's response.
   */
  async function publishContextUsage({ message, state, model, sdkSessionId }) {
    if (!state.contextUsage && !state.modelUsage) return;
    const contextUsage = state.contextUsage && typeof state.contextUsage === 'object' && state.contextUsage.model
      ? { ...state.contextUsage, model: relayModel(state.contextUsage.model) }
      : state.contextUsage;
    await api('POST', '/api/claude-context-usage', {
      conversationId: message.conversationId,
      sdkSessionId,
      model: relayModel(state.responseModel || model || null),
      contextUsage,
      modelUsage: state.modelUsage,
    }).catch((error) => {
      dbg('context usage publish failed', error?.message || String(error));
    });
  }

  /**
   * Ship the session's plan usage (rate-limit windows + cost totals) to the
   * relay. Falls back to the stable result fields when the experimental usage
   * control request is unavailable, so the card still gets session cost.
   * Advisory: a failure here must not disturb the turn's response.
   */
  async function publishPlanUsage({ message, state, sdkSessionId, runId = '', resumedSessionId = '' }) {
    // Fire-and-forget: the token post never holds the reply (the counting
    // itself runs at once, before the next result can arrive).
    if (turnTokenProvider) void publishTurnTokens({ message, state, runId, resumedSessionId });
    if (billingUsageRoute) await publishBillingUsage({ message, state, sdkSessionId, runId, resumedSessionId });
    if (usageRoute) {
      await publishBackendUsage({ message, state, sdkSessionId, runId, resumedSessionId });
      return;
    }
    if (!reportsPlanUsage) return;
    const totalCostUsd = state.result?.totalCostUsd ?? null;
    // A cost with no per-model breakdown is still a usable fallback payload, so
    // it has to count as a reason to publish or the card loses session cost on
    // any turn the SDK reports without `modelUsage`.
    if (!state.planUsage && !state.modelUsage && totalCostUsd === null) return;
    await api('POST', '/api/claude-plan-usage', {
      conversationId: message.conversationId,
      sdkSessionId,
      usage: state.planUsage,
      modelUsage: state.modelUsage,
      totalCostUsd,
    }).catch((error) => {
      dbg('plan usage publish failed', error?.message || String(error));
    });
  }

  // Three trackers below measure a turn from the CLI's results, one per
  // booking, and mirror each other's rules: `run` / runningCounts (DeepSeek's
  // card), `billingRun` / billingCounts (the Claude API booking) and
  // `tokenRun` / turnCounts (the token booking). Each keys on the
  // process (`runId`) and the CLI session id, so a `/clear` starts over;
  // takes a fresh process's `modelUsage` growth over the last result's, but
  // a resumed process's first result (and a result without `modelUsage`) as
  // its turn `usage` alone, the main loop, and a result without `modelUsage`
  // raises the baseline by that `usage`, so the next result's growth does
  // not count it again; lets the baseline only rise, so a late result of an
  // older turn books nothing twice; and counts a turn state once. They differ only in what they keep: hits and misses (cache
  // writes inside) for the first two, the four token kinds apart for the
  // third. A change to one rule belongs in all three.

  // The CLI process's own token totals and web search and fetch counts per
  // model, counted from zero for each process (`runId`) and CLI session id
  // (a `/clear` changes it and starts the CLI's totals over). `lastSession`
  // is the CLI's running totals per model at the last result they were taken
  // from, `lastSearches` its running search counts the same way, `results`
  // how many results the process has reported, and
  // `countedStates` the turn states already added: a turn published twice
  // (a stopped turn's chain and the stream's end) counts once.
  const run = { key: '', runId: '', results: 0, totals: new Map(), requests: new Map(), lastSession: new Map(), lastSearches: new Map() };
  const countedStates = new WeakSet();

  const addTotals = (into, entries) => {
    for (const entry of entries) {
      const current = into.get(entry.model) || { model: entry.model, hitTokens: 0, missTokens: 0, outputTokens: 0 };
      current.hitTokens += entry.hitTokens;
      current.missTokens += entry.missTokens;
      current.outputTokens += entry.outputTokens;
      into.set(entry.model, current);
    }
  };

  /**
   * The process's running totals and request counts after this turn, as
   * `{ totals: [{ model, hitTokens, missTokens, outputTokens }], requests:
   * [{ model, searchRequests, fetchRequests }] }` without the all-zero
   * models. Without a run id (a caller that has none) the CLI's own totals
   * and the turn's counts, as before.
   *
   * A result's `modelUsage` is the CLI session's running total per model
   * (sub-agents included), so the turn's share is what it grew by since the
   * process's last result. The first result of a process spawned to resume
   * a session carries that session's earlier turns too, which the relay has
   * already booked: that turn's share is the result's `usage`, the turn's
   * own count, under the turn's model (it leaves out what sub-agents spent
   * in that one turn). A process spawned fresh, or a session the CLI
   * started over, reports from zero: its first result is all its own. A
   * result without `modelUsage` adds its `usage`. The baseline the growth
   * is measured from only rises, field by field per model: a result's
   * totals below it belong to an older turn published late.
   *
   * Web searches come from the same place as the tokens: the CLI counts
   * them per model in `modelUsage`, the WebSearch tool's own API request
   * included, which the message stream (`serverToolUse`) never shows. They
   * grow, rise and resume like the tokens; the stream's count stands in
   * where the tokens fall back to `usage` (no `modelUsage`, the resumed
   * first result) and for a CLI that reports no search count. Fetches only
   * the stream counts.
   */
  function runningCounts(state, result, { runId, sessionId, resumedSessionId, modelKey }) {
    const model = result.model || state.responseModel;
    const turnRequests = claudeToolRequests(result.serverToolUse, modelKey);
    if (!runId) return { totals: claudeUsageTotals(result.modelUsage, { usage: result.usage, model, ...modelKey }), requests: turnRequests };
    if (run.runId !== runId) {
      run.runId = runId;
      run.results = 0;
    }
    const key = `${runId}\n${sessionId}`;
    if (run.key !== key) {
      run.key = key;
      run.totals = new Map();
      run.requests = new Map();
      run.lastSession = new Map();
      run.lastSearches = new Map();
    }
    if (!countedStates.has(state)) {
      countedStates.add(state);
      const hasModelUsage = Boolean(result.modelUsage) && typeof result.modelUsage === 'object' && !Array.isArray(result.modelUsage);
      const turnUsage = claudeUsageTotals(null, { usage: result.usage, model, ...modelKey });
      const sessionSearches = hasModelUsage ? claudeSearchTotals(result.modelUsage, modelKey) : [];
      // The searches this turn adds, per model: the stream's unless the
      // CLI's running count below says more reliably.
      let turnSearches = turnRequests.map((entry) => ({ model: entry.model, searchRequests: entry.searchRequests }));
      if (!hasModelUsage) {
        // The CLI's running totals grew by the turn, as far as this goes.
        addTotals(run.totals, turnUsage);
        addTotals(run.lastSession, turnUsage);
        for (const entry of turnSearches) {
          run.lastSearches.set(entry.model, (run.lastSearches.get(entry.model) || 0) + entry.searchRequests);
        }
      } else {
        const session = claudeUsageTotals(result.modelUsage, modelKey);
        const resumed = run.results === 0 && Boolean(resumedSessionId) && sessionId === resumedSessionId;
        if (resumed) {
          addTotals(run.totals, turnUsage);
        } else {
          const grown = session.map((entry) => {
            const last = run.lastSession.get(entry.model) || { hitTokens: 0, missTokens: 0, outputTokens: 0 };
            return {
              model: entry.model,
              hitTokens: Math.max(0, entry.hitTokens - last.hitTokens),
              missTokens: Math.max(0, entry.missTokens - last.missTokens),
              outputTokens: Math.max(0, entry.outputTokens - last.outputTokens),
            };
          });
          addTotals(run.totals, grown);
          if (sessionSearches.length) {
            turnSearches = sessionSearches.map((entry) => ({
              model: entry.model,
              searchRequests: Math.max(0, entry.searchRequests - (run.lastSearches.get(entry.model) || 0)),
            }));
          }
        }
        // The baseline only ever rises: the CLI's totals are cumulative, so a
        // snapshot below the last one is an older result arriving late (a
        // stopped turn's publish chain behind a newer turn's), and taking it
        // as the baseline would book the newer turn's growth a second time.
        for (const entry of session) {
          const last = run.lastSession.get(entry.model) || { model: entry.model, hitTokens: 0, missTokens: 0, outputTokens: 0 };
          run.lastSession.set(entry.model, {
            model: entry.model,
            hitTokens: Math.max(last.hitTokens, entry.hitTokens),
            missTokens: Math.max(last.missTokens, entry.missTokens),
            outputTokens: Math.max(last.outputTokens, entry.outputTokens),
          });
        }
        for (const entry of sessionSearches) {
          run.lastSearches.set(entry.model, Math.max(run.lastSearches.get(entry.model) || 0, entry.searchRequests));
        }
      }
      const addRequests = (entryModel, searchRequests, fetchRequests) => {
        const current = run.requests.get(entryModel) || { model: entryModel, searchRequests: 0, fetchRequests: 0 };
        current.searchRequests += searchRequests;
        current.fetchRequests += fetchRequests;
        run.requests.set(entryModel, current);
      };
      for (const entry of turnSearches) addRequests(entry.model, entry.searchRequests, 0);
      for (const entry of turnRequests) addRequests(entry.model, 0, entry.fetchRequests);
      run.results += 1;
    }
    // Copies: the running entries go on changing after the post.
    return {
      totals: [...run.totals.values()].filter((entry) => entry.hitTokens + entry.missTokens + entry.outputTokens > 0).map((entry) => ({ ...entry })),
      requests: [...run.requests.values()].filter((entry) => entry.searchRequests + entry.fetchRequests > 0).map((entry) => ({ ...entry })),
    };
  }

  /**
   * Ship the CLI process's token totals per model after a turn, with the
   * CLI's session id, the id of the process (`runId`) and the time. They are
   * the process's own running totals, counted from zero (runningCounts): the
   * relay books what each report adds under the run id, a report below the
   * last one under it is stale, and a new run id is booked in full. The
   * process's running counts of web searches and fetches ride along as
   * `requests`, per model, booked the same way. A caller without a run id
   * sends the CLI's session totals and the turn's counts, which the relay
   * books as an older worker's. `resumedSessionId` is the session the process
   * was spawned to resume, if any. Advisory, like the plan usage.
   */
  async function publishBackendUsage({ message, state, sdkSessionId, runId = '', resumedSessionId = '' }) {
    const result = state.result;
    const claudeNativeSessionId = String(result?.sessionId || '').trim();
    if (!usageRoute || !claudeNativeSessionId) return;
    const modelKey = typeof usageModelKey === 'function' ? { modelKey: usageModelKey } : {};
    const { totals, requests } = runningCounts(state, result, {
      runId: String(runId || ''),
      sessionId: claudeNativeSessionId,
      resumedSessionId: String(resumedSessionId || '').trim(),
      modelKey,
    });
    if (!totals.length && !requests.length) return;
    await api('POST', usageRoute, {
      conversationId: message.conversationId,
      sdkSessionId,
      claudeNativeSessionId,
      ...(runId ? { runId } : {}),
      at: new Date().toISOString(),
      totals,
      ...(requests.length ? { requests } : {}),
    }).catch((error) => {
      dbg('backend usage publish failed', error?.message || String(error));
    });
  }

  // The process's own totals per model with their cost, for the Claude API
  // booking: counted like `run` above, per process and CLI session, with the
  // CLI's cost estimate beside the tokens. A resumed process's first result
  // adds the turn's `usage` (its main agent loop, no cost); the relay books
  // that turn from the session totals the report carries as well.
  const billingRun = { key: '', results: 0, totals: new Map(), lastSession: new Map() };
  const billedStates = new WeakSet();

  function billingCounts(state, result, { runId, sessionId, resumedSessionId }) {
    const model = result.model || state.responseModel;
    const key = `${runId}\n${sessionId}`;
    if (billingRun.key !== key) {
      billingRun.key = key;
      billingRun.results = 0;
      billingRun.totals = new Map();
      billingRun.lastSession = new Map();
    }
    const firstResultOfRun = billingRun.results === 0;
    const session = claudeBillingTotals(result.modelUsage, { usage: result.usage, model });
    const add = (entries) => {
      for (const entry of entries) {
        const current = billingRun.totals.get(entry.model) || { model: entry.model, hitTokens: 0, missTokens: 0, outputTokens: 0, costUsd: 0, costUnknown: false };
        current.hitTokens += entry.hitTokens;
        current.missTokens += entry.missTokens;
        current.outputTokens += entry.outputTokens;
        current.costUsd += entry.costUsd;
        current.costUnknown = current.costUnknown || entry.costUnknown;
        billingRun.totals.set(entry.model, current);
      }
    };
    if (!billedStates.has(state)) {
      billedStates.add(state);
      const hasModelUsage = Boolean(result.modelUsage) && typeof result.modelUsage === 'object' && !Array.isArray(result.modelUsage);
      const resumed = firstResultOfRun && Boolean(resumedSessionId) && sessionId === resumedSessionId;
      if (!hasModelUsage || resumed) {
        add(claudeBillingTotals(null, { usage: result.usage, model }));
      } else {
        add(session.map((entry) => {
          const last = billingRun.lastSession.get(entry.model) || { hitTokens: 0, missTokens: 0, outputTokens: 0, costUsd: 0 };
          return {
            model: entry.model,
            hitTokens: Math.max(0, entry.hitTokens - last.hitTokens),
            missTokens: Math.max(0, entry.missTokens - last.missTokens),
            outputTokens: Math.max(0, entry.outputTokens - last.outputTokens),
            costUsd: Math.max(0, entry.costUsd - last.costUsd),
            costUnknown: entry.costUnknown,
          };
        }));
      }
      // The baseline only rises: a late result of an older turn below it
      // must not make the next one count twice. A result without
      // `modelUsage` grew the CLI's running totals by its `usage`, as `run`
      // has it: the baseline grows by it too, so the next result's growth
      // does not book that turn again.
      if (hasModelUsage) {
        for (const entry of session) {
          const last = billingRun.lastSession.get(entry.model) || { hitTokens: 0, missTokens: 0, outputTokens: 0, costUsd: 0 };
          billingRun.lastSession.set(entry.model, {
            hitTokens: Math.max(last.hitTokens, entry.hitTokens),
            missTokens: Math.max(last.missTokens, entry.missTokens),
            outputTokens: Math.max(last.outputTokens, entry.outputTokens),
            costUsd: Math.max(last.costUsd, entry.costUsd),
          });
        }
      } else {
        for (const entry of claudeBillingTotals(null, { usage: result.usage, model })) {
          const last = billingRun.lastSession.get(entry.model) || { hitTokens: 0, missTokens: 0, outputTokens: 0, costUsd: 0 };
          billingRun.lastSession.set(entry.model, {
            hitTokens: last.hitTokens + entry.hitTokens,
            missTokens: last.missTokens + entry.missTokens,
            outputTokens: last.outputTokens + entry.outputTokens,
            costUsd: last.costUsd,
          });
        }
      }
      billingRun.results += 1;
    }
    return {
      firstResultOfRun,
      runCounts: [...billingRun.totals.values()].map((entry) => ({ ...entry })),
      sessionTotals: session,
    };
  }

  // The token booking's counts, measured like billingRun above,
  // with the four token kinds apart, then summed per turn: a turn's results
  // (a stopped turn's, the steered rows it folded in) post the turn's total
  // so far under its id, which the relay keeps the larger of. A worker
  // without a process id names one for its own life, so a requeued turn on
  // a restarted worker is a second run, not the same row.
  const tokenRun = { key: '', results: 0, lastSession: new Map() };
  const tokenStates = new WeakSet();
  const turnTokens = new Map();
  const ownRunId = randomUUID();
  const TOKEN_FIELDS = ['inputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'outputTokens'];
  const TURN_TOKENS_KEPT = 20;

  function turnCounts(state, result, { turnId, runId, sessionId, resumedSessionId, modelKey }) {
    const model = result.model || state.responseModel;
    const key = `${runId}\n${sessionId}`;
    if (tokenRun.key !== key) {
      tokenRun.key = key;
      tokenRun.results = 0;
      tokenRun.lastSession = new Map();
    }
    // Per run and turn: a turn re-run by a new CLI process (after a crash)
    // is a second row at the relay, holding that run's tokens only.
    const turnKey = `${runId}\n${turnId}`;
    let turn = turnTokens.get(turnKey);
    if (!turn) {
      turn = new Map();
      turnTokens.set(turnKey, turn);
      while (turnTokens.size > TURN_TOKENS_KEPT) turnTokens.delete(turnTokens.keys().next().value);
    }
    if (!tokenStates.has(state)) {
      tokenStates.add(state);
      const at = new Date().toISOString();
      const hasModelUsage = Boolean(result.modelUsage) && typeof result.modelUsage === 'object' && !Array.isArray(result.modelUsage);
      const resumed = tokenRun.results === 0 && Boolean(resumedSessionId) && sessionId === resumedSessionId;
      const session = hasModelUsage ? claudeTokenTotals(result.modelUsage, modelKey) : [];
      const grown = !hasModelUsage || resumed
        ? claudeTokenTotals(null, { usage: result.usage, model, ...modelKey })
        : session.map((entry) => {
          const last = tokenRun.lastSession.get(entry.model);
          const delta = { model: entry.model, costUnknown: entry.costUnknown };
          for (const field of TOKEN_FIELDS) delta[field] = Math.max(0, entry[field] - (last?.[field] || 0));
          delta.costUsd = entry.costUsd === null ? null : Math.max(0, entry.costUsd - (last?.costUsd || 0));
          return delta;
        });
      for (const entry of grown) {
        const priced = typeof turnTokenCost === 'function' ? turnTokenCost(entry, at) : null;
        const costUsd = priced ? priced.costUsd : entry.costUsd;
        const costSource = priced ? priced.costSource : (entry.costUsd === null ? null : 'claude-code');
        const current = turn.get(entry.model) || {
          model: entry.model, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: null, costSource: null, costUnknown: false,
        };
        for (const field of TOKEN_FIELDS) current[field] += entry[field];
        if (costUsd !== null && costUsd !== undefined) current.costUsd = (current.costUsd ?? 0) + costUsd;
        current.costSource = current.costSource || costSource;
        // A backend's own price wins over Claude Code's word on it (DeepSeek's
        // models are unknown to Claude Code's table, yet OAR prices them).
        const unknown = priced ? priced.costUsd === null || priced.costUsd === undefined : (entry.costUnknown || costUsd === null || costUsd === undefined);
        current.costUnknown = current.costUnknown || unknown;
        turn.set(entry.model, current);
      }
      // The baseline only rises: a late result of an older turn below it
      // must not make the next one count twice. A result without
      // `modelUsage` grew the CLI's running totals by its `usage`, as `run`
      // has it: the baseline grows by it too.
      for (const entry of session) {
        const last = tokenRun.lastSession.get(entry.model) || {};
        const next = { costUsd: Math.max(last.costUsd || 0, entry.costUsd || 0) };
        for (const field of TOKEN_FIELDS) next[field] = Math.max(last[field] || 0, entry[field]);
        tokenRun.lastSession.set(entry.model, next);
      }
      if (!hasModelUsage) {
        for (const entry of grown) {
          const last = tokenRun.lastSession.get(entry.model) || {};
          const next = { costUsd: last.costUsd || 0 };
          for (const field of TOKEN_FIELDS) next[field] = (last[field] || 0) + entry[field];
          tokenRun.lastSession.set(entry.model, next);
        }
      }
      tokenRun.results += 1;
    }
    return [...turn.values()]
      .filter((entry) => TOKEN_FIELDS.some((field) => entry[field] > 0) || entry.costUsd > 0)
      .map((entry) => ({ ...entry }));
  }

  /**
   * Ship the turn's tokens per model to the token booking: the
   * turn's total so far, under the turn's id and the process's run id.
   * Reasoning is not reported apart by Claude, so it is left out (NULL).
   * Advisory and fire-and-forget: it never throws and nothing waits on it.
   */
  async function publishTurnTokens({ message, state, runId = '', resumedSessionId = '' }) {
    try {
      const result = state.result;
      const turnId = String(message?.id || '').trim();
      if (!turnId || !result) return;
      const sessionId = String(result.sessionId || '').trim();
      const modelKey = typeof usageModelKey === 'function' ? { modelKey: usageModelKey } : {};
      const run = String(runId || '') || ownRunId;
      const models = turnCounts(state, result, {
        turnId,
        runId: run,
        sessionId,
        resumedSessionId: String(resumedSessionId || '').trim(),
        modelKey,
      });
      if (!models.length) return;
      await api('POST', '/api/turn-token-usage', {
        conversationId: message.conversationId,
        turnId,
        runId: run,
        provider: turnTokenProvider,
        ...(sessionId ? { nativeSessionId: sessionId } : {}),
        at: new Date().toISOString(),
        models,
      });
    } catch (error) {
      dbg('turn token publish failed', error?.message || String(error));
    }
  }

  /**
   * Ship the turn's counts to the Claude API booking: the process's own
   * running totals (`runCounts`) and the CLI's session totals
   * (`sessionTotals`), with the worker's kind, the process (`runId`), the
   * session it resumed, and the turn (`turnId`). Advisory, like the plan usage.
   */
  async function publishBillingUsage({ message, state, sdkSessionId, runId = '', resumedSessionId = '' }) {
    const result = state.result;
    const claudeNativeSessionId = String(result?.sessionId || '').trim();
    if (!billingUsageRoute || !claudeNativeSessionId || !runId) return;
    const { firstResultOfRun, runCounts, sessionTotals } = billingCounts(state, result, {
      runId: String(runId),
      sessionId: claudeNativeSessionId,
      resumedSessionId: String(resumedSessionId || '').trim(),
    });
    if (!runCounts.length && !sessionTotals.length) return;
    await api('POST', billingUsageRoute, {
      conversationId: message.conversationId,
      sdkSessionId,
      claudeNativeSessionId,
      runId: String(runId),
      billing: billingKind || null,
      turnId: String(message.id || '') || null,
      at: new Date().toISOString(),
      firstResultOfRun,
      ...(resumedSessionId ? { resumedSessionId: String(resumedSessionId) } : {}),
      runCounts,
      sessionTotals,
    }).catch((error) => {
      dbg('billing usage publish failed', error?.message || String(error));
    });
  }

  /**
   * Ship what the CLI reported about the subscription's usage limit: the
   * relay warns before the limit and shows the reset once it is reached.
   * Advisory, and fired without waiting: it must not hold up the stream.
   */
  function publishUsageLimitReport({ conversationId, sdkSessionId, report }) {
    if (!report) return;
    api('POST', '/api/claude-usage-limit', { conversationId, sdkSessionId, report }).catch((error) => {
      dbg('usage limit report publish failed', error?.message || String(error));
    });
  }

  async function publishFinalStream(message, text) {
    await api('POST', '/api/stream', {
      messageId: message.id,
      conversationId: message.conversationId,
      mode: message.relayMode || 'agent',
      text: String(text || ''),
      done: true,
      ...attemptFields(message),
    }).catch(() => {});
  }

  /**
   * Returns the outcome: 'published' (the relay took it), 'stale' (another
   * attempt owns the row), 'failed' (not taken and NOT requeued), or
   * 'requeued'. A `kind` marks a row whose prompt the CLI already consumed —
   * 'absorbed' (the reply continues through the next, steered message),
   * 'folded' (answered by the turn it was steered into) or 'stopped' (steered
   * into a turn the user stopped) — and such a row is never
   * requeued, since re-delivery would run the prompt a second time; the
   * caller owns retrying it. `requeueOnFailure: false` opts any other publish
   * into the same contract.
   */
  async function publishResponse(message, {
    text,
    model,
    terminalError = null,
    // What the turn had written before it failed; the relay keeps it above
    // the failure or pause note.
    partialText = '',
    modelOrigin,
    absorbed = false,
    kind = null,
    requeueOnFailure = true,
    // Ids of steered queue rows pushed into the turn this response finishes
    // and still unsettled: the relay marks them consumed in the same
    // transaction, so no recovery path ever re-runs them (at-most-once even
    // if this worker dies before settling them).
    consumedSteerIds = null,
    // A caller retrying one publish drains the settled workflow digests ONCE
    // and passes them to every attempt, so a failed attempt cannot lose them.
    workflowRuns: presetWorkflowRuns,
  }) {
    const responseKind = kind || (absorbed ? 'absorbed' : null);
    // Final digests of workflows that settled since the last response ride the
    // next successful response publish — the summarizing turn is the natural
    // transcript anchor for the "Finished background task" card. Terminal
    // failures skip the drain so the digests stay buffered for a later turn;
    // if this POST fails (→ requeue) or the process dies before any response
    // publishes, the drained digests are lost — acceptable v1.
    const workflowRuns = presetWorkflowRuns !== undefined
      ? presetWorkflowRuns
      : drainWorkflowRuns({ terminal: Boolean(terminalError) });
    // Entries are { id, attemptId } (the relay fences each mark on its
    // attempt) or bare ids.
    const consumed = (Array.isArray(consumedSteerIds) ? consumedSteerIds : [])
      .map((entry) => (entry && typeof entry === 'object'
        ? { id: String(entry.id || '').trim(), attemptId: entry.attemptId || null }
        : { id: String(entry || '').trim(), attemptId: null }))
      .filter((entry) => entry.id);
    try {
      await api('POST', '/api/response', {
        messageId: message.id,
        conversationId: message.conversationId,
        text: String(text || ''),
        model: model || null,
        modelOrigin: modelOrigin
          || (String(message?.model || '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual'),
        ...(Array.isArray(workflowRuns) && workflowRuns.length ? { workflowRuns } : {}),
        ...(terminalError ? { terminalError } : {}),
        ...(terminalError && String(partialText || '').trim() ? { partialText: String(partialText).trim() } : {}),
        // The relay stamps the assistant message's kind from these: 'absorbed'
        // renders as merged into the next (steered) user message, 'folded' as
        // a compact marker on its own message, 'stopped' as a steer the
        // user's Stop cut off unanswered.
        ...(responseKind === 'absorbed' ? { absorbed: true } : {}),
        ...(responseKind && responseKind !== 'absorbed' ? { kind: responseKind } : {}),
        ...(consumed.length ? { consumedSteerIds: consumed } : {}),
        ...attemptFields(message),
      });
      return 'published';
    } catch (error) {
      // A stale_attempt 409 means the row already moved on to another attempt
      // (requeued and re-delivered); the requeue would 409 the same way, and
      // the newer attempt owes the row its answer — drop this one.
      if (isStaleAttemptError(error)) {
        dbg('response refused as stale_attempt; dropping', message.id);
        return 'stale';
      }
      if (responseKind || !requeueOnFailure) {
        dbg('response publish failed; not requeuing a consumed prompt', message.id, error?.message || String(error));
        return 'failed';
      }
      await api('POST', '/api/requeue', { messageId: message.id, ...attemptFields(message) }).catch(() => {});
      return 'requeued';
    }
  }

  /**
   * Post the plan-ready review board for an ExitPlanMode interception. The CLI
   * sends both `plan` and `planFilePath`; the inline plan is authoritative, the
   * plan file covers CLI versions that stop inlining it. Returns false when no
   * plan text could be recovered so the caller's plan-shaped-final-text
   * fallback still gets a chance to post the board.
   */
  async function publishPlanBoard(message, input) {
    let planText = String(input?.plan || input?.summary || '').trim();
    if (!planText) {
      const planFilePath = String(input?.planFilePath || '').trim();
      if (planFilePath) {
        try {
          planText = String(fs.readFileSync(planFilePath, 'utf8') || '').trim();
        } catch (error) {
          dbg('plan file read failed', planFilePath, error?.message || String(error));
        }
      }
    }
    const boardPayload = buildClaudePlanReadyBoardPayload({ message, planText });
    if (!boardPayload) return false;
    await api('POST', '/api/relay-board', boardPayload).catch((error) => {
      dbg('plan board publish failed', error?.message || String(error));
    });
    return true;
  }

  /**
   * Publish a completed (non-error, non-aborted) turn: final stream snapshot,
   * plan-mode fallback board, response row. Mirrors the pre-session-process
   * turn runner's tail exactly.
   */
  async function publishCompletedTurn({ message, state, responseModel, planBoardPosted, consumedSteerIds = null }) {
    const result = state.result;
    const finalText = String(
      state.resultTexts.join('\n\n') || result?.text || state.lastStreamedText || '',
    ).trim();
    if (
      !planBoardPosted
      && String(message.relayMode || '').trim().toLowerCase() === 'plan'
      && countPlanLikeLines(finalText) >= 2
    ) {
      const boardPayload = buildClaudePlanReadyBoardPayload({ message, planText: finalText });
      if (boardPayload) {
        boardPayload.context.source = 'plan-mode-fallback';
        await api('POST', '/api/relay-board', boardPayload).catch(() => {});
      }
    }
    // Same reasoning as the Cursor worker: a terminal, non-error result with no
    // prose is a completed turn (the model can end on tool activity alone), and
    // requeuing it re-runs deterministically empty work until the retry cap
    // fails the message with a misleading "Relay timeout".
    const publishedText = finalText || EMPTY_TURN_COMPLETION_NOTE;
    await publishFinalStream(message, publishedText);
    await publishResponse(message, { text: publishedText, model: responseModel, consumedSteerIds });
  }

  async function publishErrorResult({ message, state, responseModel, consumedSteerIds = null }) {
    const result = state.result;
    const errorText = result.text
      || `${runtimeLabel} turn failed (${result.subtype || 'unknown error'}).`;
    const described = backendFailure(errorText, result.apiErrorStatus);
    await publishFinalStream(message, state.lastStreamedText);
    // Refused at the usage limit: a relay that knows the kind pauses the turn
    // until the reset instead of failing it.
    if (result.usageLimit) {
      // What the turn had written before it was refused, without the CLI's
      // own line about the limit, which is the last thing in the stream. The
      // relay keeps it above its note: a turn cut off in the middle has
      // usually said what it was doing.
      const refusalText = String(result.usageLimit.text || '').trim();
      let written = String(state.lastStreamedText || '').trim();
      if (refusalText && written.endsWith(refusalText)) written = written.slice(0, -refusalText.length).trim();
      await publishResponse(message, {
        text: errorText,
        model: responseModel,
        terminalError: buildUsageLimitFailure(message, result.usageLimit),
        partialText: written,
        consumedSteerIds,
      });
      return;
    }
    await publishResponse(message, {
      text: errorText,
      model: responseModel,
      terminalError: {
        kind: 'claude-turn-failed',
        // Never built from the subtype alone: a refused turn ends with
        // subtype 'success'. An account failure brings its own advice, since
        // sending the message again cannot help before the account is fixed.
        ...classifyResultFailure(result),
        ...(described ? { ...failureCodes(described.code), guidance: described.guidance } : {}),
        message: errorText,
        failedAt: new Date().toISOString(),
        queueMessageId: String(message.id || '') || null,
      },
      consumedSteerIds,
    });
  }

  async function publishTurnException({ message, errorText, usageLimit = null, error = null }) {
    if (usageLimit) {
      await publishResponse(message, {
        text: usageLimit.text || errorText,
        model: null,
        terminalError: buildUsageLimitFailure(message, usageLimit),
      });
      return;
    }
    // Claude Code did not take a backend's connection settings (its key and
    // endpoint pins): nothing was sent, and no sign-in changes that.
    if (error?.code === CLAUDE_LIVE_FLAG_SETTINGS_CODE) {
      await publishResponse(message, {
        text: `System note: ${error.message} ${CLAUDE_LIVE_FLAG_SETTINGS_GUIDANCE}`,
        model: null,
        terminalError: {
          kind: 'claude-turn-failed',
          code: CLAUDE_LIVE_FLAG_SETTINGS_CODE,
          stableCode: `claude.${CLAUDE_LIVE_FLAG_SETTINGS_CODE}`,
          message: error.message,
          guidance: CLAUDE_LIVE_FLAG_SETTINGS_GUIDANCE,
          failedAt: new Date().toISOString(),
          queueMessageId: String(message.id || '') || null,
        },
      });
      return;
    }
    // The conversation's folder is gone: the error names it and says what to
    // do, which neither a retry nor a sign-in changes.
    if (isWorkingDirectoryMissingError(error)) {
      await publishResponse(message, {
        text: `System note: ${error.message} ${error.guidance}`,
        model: null,
        terminalError: {
          kind: 'claude-turn-failed',
          ...failureCodes(WORKING_DIRECTORY_MISSING_CODE),
          message: error.message,
          guidance: error.guidance,
          failedAt: new Date().toISOString(),
          queueMessageId: String(message.id || '') || null,
        },
      });
      return;
    }
    const described = backendFailure(errorText, null, error);
    if (described) {
      await publishResponse(message, {
        text: `System note: the ${runtimeLabel} turn failed (${errorText}). ${described.guidance}`,
        model: null,
        terminalError: {
          kind: 'claude-turn-failed',
          ...failureCodes(described.code),
          message: errorText,
          guidance: described.guidance,
          failedAt: new Date().toISOString(),
          queueMessageId: String(message.id || '') || null,
        },
      });
      return;
    }
    // A backend's sign-in failures are its describeFailure's; Claude's sign-in
    // advice is never a backend's.
    const isAuthError = !failureCodePrefix && /authentication|logged in|login|credential|api key/i.test(errorText);
    await publishResponse(message, {
      text: isAuthError
        ? `System note: the Claude runtime could not authenticate (${errorText}). Log in again from Settings → Providers → Claude → Relogin (or run \`claude\` on the relay host), then retry.`
        : `System note: the ${runtimeLabel} turn failed (${errorText}). Retry or send a new message.`,
      model: null,
      terminalError: {
        kind: 'claude-turn-failed',
        ...failureCodes(isAuthError ? 'authentication_failed' : 'turn-error'),
        message: errorText,
        ...(isAuthError ? { guidance: claudeFailureGuidance('authentication_failed') } : {}),
        failedAt: new Date().toISOString(),
        queueMessageId: String(message.id || '') || null,
      },
    });
  }

  return {
    postActivity,
    drainWorkflowRuns,
    dispatchAction,
    publishContextUsage,
    publishPlanUsage,
    publishUsageLimitReport,
    publishFinalStream,
    publishResponse,
    publishPlanBoard,
    publishCompletedTurn,
    publishErrorResult,
    publishTurnException,
  };
}
