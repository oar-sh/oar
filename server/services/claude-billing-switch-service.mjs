'use strict';

/**
 * The Claude billing switch: a Claude chat moves between the host's Claude
 * subscription (`claude`) and the API key saved in Settings → Providers →
 * Claude API (`claude-api`), and keeps its Claude Code session: both run the
 * same CLI on the same `~/.claude`.
 *
 * The chat's billing is `runtime_sessions.provider_type`. A switch, in one
 * transaction:
 * - checks the target: the provider usable (a key for the API, the Claude
 *   provider on for the subscription), the monthly cap, the chat's model in
 *   the target's list, and the history rule of decision 23;
 * - writes the billing, when and by whom;
 * - re-stamps the chat's rows that have not started (`queue.provider`), so
 *   they run on the new billing; a row already running finishes on its own;
 * - to the API key, releases a turn held at the subscription's usage limit;
 * - leaves one note in the transcript (a second switch before the next turn
 *   rewrites it);
 * - and, for an agent's `send`, enqueues its message (`enqueue`).
 *
 * The worker swap itself is the delivery's (claude-billing-swap-service.mjs):
 * the next row of the new billing is not handed to a worker of the old kind,
 * which is replaced once it is idle.
 */

import { randomUUID } from 'node:crypto';

import { claudeBaseModelId, isClaudeLongContextModelId } from '../../shared/model-id.mjs';

export const CLAUDE_BILLING_PROVIDERS = Object.freeze(['claude', 'claude-api']);
export const CLAUDE_BILLING_NOTE_KIND = 'billing-switch';
export const CLAUDE_BILLING_SWITCHED_BY = Object.freeze(['user', 'agent', 'usage-limit']);

// Decision 23: whether a chat with turns on the other billing may move to
// this one. Set from the WP3 live check (a subscription session's history on
// the key, and back); 'blocked' disables the switch for such chats.
export const CLAUDE_BILLING_HISTORY_RULE = Object.freeze({
  'claude-api': 'allowed',
  claude: 'allowed',
});

export const CLAUDE_BILLING_LABELS = Object.freeze({
  claude: 'Subscription',
  'claude-api': 'API key',
});

export function normalizeClaudeBilling(value) {
  const billing = String(value || '').trim().toLowerCase();
  return CLAUDE_BILLING_PROVIDERS.includes(billing) ? billing : '';
}

export function otherClaudeBilling(billing) {
  return normalizeClaudeBilling(billing) === 'claude' ? 'claude-api' : 'claude';
}

/** The transcript note for a switch. */
export function buildClaudeBillingNoteText({ to, by = 'user' } = {}) {
  const who = by === 'agent' ? ' (switched by an agent)' : (by === 'usage-limit' ? ' (switched at the usage limit)' : '');
  if (normalizeClaudeBilling(to) === 'claude-api') {
    return `💳 Billing: this chat runs on the Claude API key from the next turn${who}. `
      + 'The first turn on the key has no prompt cache and costs more.';
  }
  return `💳 Billing: this chat runs on the Claude subscription from the next turn${who}.`;
}

function refusal(status, code, error, extra = {}) {
  return { ok: false, status, code, error, ...extra };
}

function modelListFor(settings) {
  return new Set([
    String(settings?.model || '').trim(),
    ...(Array.isArray(settings?.availableModels) ? settings.availableModels : []),
    ...(Array.isArray(settings?.models) ? settings.models : []),
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
}

export function createClaudeBillingSwitchService({
  db,
  stmts,
  emit = () => {},
  getClaudeProviderSettings = () => null,
  getClaudeApiProviderSettings = () => null,
  // The monthly cap: `{ reached, error? }`, from the runtime's
  // getClaudeApiCapState seam (the claim check asks the same one; WP5 fills
  // it in). Not reached by default.
  getClaudeApiCapState = () => ({ reached: false }),
  historyRule = CLAUDE_BILLING_HISTORY_RULE,
  // Releases a turn held at the subscription's usage limit
  // (usage-limit-pause-service.mjs); runs inside the switch's transaction.
  releaseUsageLimitPause = null,
  // The runtime row → what the worker swap waits for (claude-billing-swap-
  // service.mjs, pendingFor), or null.
  getPending = () => null,
  onQueueChanged = () => {},
  now = () => Date.now(),
  logger = console,
} = {}) {
  if (!db || !stmts) throw new Error('createClaudeBillingSwitchService requires db and stmts');

  const runtimeColumns = new Set(db.prepare(`PRAGMA table_info(runtime_sessions)`).all().map((column) => column.name));
  const queueColumns = new Set(db.prepare(`PRAGMA table_info(queue)`).all().map((column) => column.name));
  const messageColumns = new Set(db.prepare(`PRAGMA table_info(messages)`).all().map((column) => column.name));
  const recordsSwitch = runtimeColumns.has('billing_switched_at') && runtimeColumns.has('billing_switched_by');

  const getRuntime = db.prepare(`SELECT * FROM runtime_sessions WHERE conversation_id = ? LIMIT 1`);
  const setBilling = recordsSwitch
    ? db.prepare(`
        UPDATE runtime_sessions
        SET provider_type = ?, billing_switched_at = ?, billing_switched_by = ?, last_used_at = ?
        WHERE id = ?
      `)
    : db.prepare(`UPDATE runtime_sessions SET provider_type = ?, last_used_at = ? WHERE id = ?`);
  const setModel = db.prepare(`UPDATE runtime_sessions SET provider_model = ?, model = ? WHERE id = ?`);
  const restampRows = queueColumns.has('provider')
    ? db.prepare(`UPDATE queue SET provider = ? WHERE conversation_id = ? AND status IN ('pending', 'parked')`)
    : null;
  const countUnstartedRows = db.prepare(`
    SELECT COUNT(*) AS n FROM queue WHERE conversation_id = ? AND status IN ('pending', 'parked')
  `);
  // The turns that ran on a billing other than `?`: replies with a recorded
  // provider. A reply from before it was recorded (or a relay note) names
  // none and does not count: an old chat is judged by the turns it has run
  // since, and a history the API still refuses meets the turn's own refusal.
  const countOtherBillingTurns = messageColumns.has('executed_provider')
    ? db.prepare(`
        SELECT COUNT(*) AS n FROM messages
        WHERE conversation_id = ? AND role = 'assistant'
          AND executed_provider IS NOT NULL AND LOWER(executed_provider) != ?
      `)
    : null;
  const latestMessage = messageColumns.has('kind')
    ? db.prepare(`SELECT id, role, kind, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT 1`)
    : null;
  const rewriteNote = db.prepare(`UPDATE messages SET text = ?, timestamp = ? WHERE id = ?`);

  function readSettings(read) {
    try {
      const settings = read();
      return settings && typeof settings === 'object' ? settings : {};
    } catch {
      return {};
    }
  }

  function chatModel(runtime) {
    return String(runtime?.provider_model || runtime?.model || '').trim();
  }

  /**
   * Whether the chat may move to `to` now: `{ ok: true, runtime, from, to,
   * model }`, or a refusal `{ ok: false, status, code, error }`. `model` is a
   * model asked for with the switch, checked in place of the chat's own.
   */
  function checkSwitch({ conversationId, to, model = '' } = {}) {
    const convId = String(conversationId || '').trim();
    const target = normalizeClaudeBilling(to);
    if (!target) return refusal(400, 'CLAUDE_BILLING_INVALID', 'Billing must be "claude" (subscription) or "claude-api" (API key)');
    const runtime = convId ? (getRuntime.get(convId) || null) : null;
    if (!runtime) return refusal(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    const from = normalizeClaudeBilling(runtime.provider_type);
    if (!from) {
      return refusal(409, 'CLAUDE_BILLING_NOT_CLAUDE', 'Only a Claude chat can switch between the subscription and the API key', {
        provider: String(runtime.provider_type || '').trim().toLowerCase() || 'github',
      });
    }
    if (from === target) return { ok: true, runtime, from, to: target, model: chatModel(runtime), changed: false };
    const settings = target === 'claude-api'
      ? readSettings(getClaudeApiProviderSettings)
      : readSettings(getClaudeProviderSettings);
    if (target === 'claude-api' && settings.enabled !== true) {
      return refusal(409, 'CLAUDE_API_NOT_CONFIGURED', settings.configured === true
        ? 'Claude API is switched off. Switch it on in Settings → Providers → Claude API.'
        : 'Claude API has no key. Save one in Settings → Providers → Claude API.');
    }
    if (target === 'claude' && settings.enabled !== true) {
      return refusal(409, 'CLAUDE_NOT_CONFIGURED', 'The Claude provider is switched off. Switch it on in Settings → Providers → Claude.');
    }
    if (target === 'claude-api') {
      let cap = null;
      // A cap that cannot be read is taken as reached: the key's bill is at stake.
      try { cap = getClaudeApiCapState() || null; } catch { cap = { reached: true }; }
      if (cap?.reached === true) {
        return refusal(409, 'CLAUDE_API_CAP_REACHED', String(cap.error || '').trim()
          || "This month's Claude API spend has reached the cap set in Settings → Providers → Claude API.");
      }
    }
    const wanted = String(model || '').trim() || chatModel(runtime);
    if (wanted) {
      const list = modelListFor(settings);
      const exact = list.has(wanted.toLowerCase());
      // A `[1m]` model needs its long-context variant listed; a plain id is
      // also taken by its base.
      const listed = exact || (!isClaudeLongContextModelId(wanted) && list.has(claudeBaseModelId(wanted).toLowerCase()));
      if (!listed) {
        return refusal(409, 'CLAUDE_BILLING_MODEL_UNAVAILABLE',
          `${wanted} is not in the ${target === 'claude-api' ? 'Claude API' : 'Claude'} model list. Pick a model it has, then switch.`,
          { model: wanted });
      }
    }
    if (String(historyRule?.[target] || 'allowed') === 'blocked' && countOtherBillingTurns) {
      const turns = Number(countOtherBillingTurns.get(runtime.conversation_id, target)?.n || 0);
      if (turns > 0) {
        return refusal(409, 'CLAUDE_BILLING_HISTORY', target === 'claude-api'
          ? 'This chat already has subscription turns, and the API refuses that history. Start a new Claude API chat.'
          : 'This chat already has API key turns, and the subscription refuses that history. Start a new Claude chat.');
      }
    }
    return { ok: true, runtime, from, to: target, model: wanted, changed: true };
  }

  /** What the composer's toggle and the usage-limit note read about a chat's billing. */
  function billingState(conversationId) {
    const runtime = getRuntime.get(String(conversationId || '').trim()) || null;
    const provider = normalizeClaudeBilling(runtime?.provider_type);
    if (!provider) return null;
    const to = otherClaudeBilling(provider);
    const check = checkSwitch({ conversationId, to });
    let pending = null;
    try { pending = getPending(runtime) || null; } catch { pending = null; }
    return {
      provider,
      pending,
      switchedAt: runtime?.billing_switched_at || null,
      switchedBy: runtime?.billing_switched_by || null,
      switchable: {
        to,
        allowed: check.ok === true,
        code: check.ok ? null : check.code,
        reason: check.ok ? null : check.error,
      },
    };
  }

  /**
   * Switch the chat's billing. `enqueue({ runtime, billing })` runs inside
   * the transaction after the switch (an agent's message), also when the
   * chat already has that billing; a throw undoes the switch. A switch to
   * the key releases a turn held at the subscription's usage limit.
   */
  function switchBilling({ conversationId, to, by = 'user', model = '', enqueue = null, deferAnnounce = false } = {}) {
    const who = CLAUDE_BILLING_SWITCHED_BY.includes(by) ? by : 'user';
    let outcome = null;
    let note = null;
    let released = null;
    let enqueued = null;
    const run = db.transaction(() => {
      const check = checkSwitch({ conversationId, to, model });
      if (!check.ok) {
        outcome = check;
        return;
      }
      const at = new Date(now()).toISOString();
      const { runtime } = check;
      if (check.changed) {
        if (recordsSwitch) setBilling.run(check.to, at, who, at, runtime.id);
        else setBilling.run(check.to, at, runtime.id);
        if (String(model || '').trim() && check.model !== chatModel(runtime)) setModel.run(check.model, check.model, runtime.id);
        restampRows?.run(check.to, runtime.conversation_id);
        note = writeNote(runtime.conversation_id, check.to, who, at);
        if (check.to === 'claude-api' && typeof releaseUsageLimitPause === 'function') {
          released = releaseUsageLimitPause({ conversationId: runtime.conversation_id, by: 'billing-switch' }) || null;
        }
      }
      if (typeof enqueue === 'function') enqueued = enqueue({ runtime, billing: check.to }) ?? null;
      outcome = {
        ok: true,
        changed: check.changed,
        conversationId: runtime.conversation_id,
        provider: check.to,
        from: check.from,
        at,
        queuedRows: Number(countUnstartedRows.get(runtime.conversation_id)?.n || 0),
      };
    });
    run();
    if (!outcome?.ok) return outcome;
    const result = {
      ...outcome,
      noteMessageId: note?.messageId || null,
      released: released ? { messageId: released.messageId || null } : null,
      enqueued,
    };
    // Called inside a caller's transaction (the send route's persist step),
    // the switch is not committed yet: the caller announces it once it is.
    if (deferAnnounce) return { ...result, announce: () => announce(outcome, note, released, who) };
    announce(outcome, note, released, who);
    return result;
  }

  // What the clients and the queue hear of a committed switch.
  function announce(outcome, note, released, who) {
    try { released?.announce?.(); } catch {}
    if (note) {
      try {
        emit(note.created ? 'assistant_message' : 'message_updated', {
          conversationId: outcome.conversationId,
          messageId: note.messageId,
          message: {
            id: note.messageId,
            role: 'assistant',
            text: note.text,
            kind: CLAUDE_BILLING_NOTE_KIND,
            model: null,
            mode: null,
            attachments: [],
            timestamp: note.timestamp,
          },
        });
      } catch {}
    }
    if (outcome.changed) {
      try {
        logger.log?.(`[claude-billing] conv=${outcome.conversationId.slice(0, 8)} ${outcome.from} → ${outcome.provider} by ${who}; ${outcome.queuedRows} queued row(s) re-stamped`);
      } catch {}
      try { emit('conversation_billing', { conversationId: outcome.conversationId, billing: billingState(outcome.conversationId) }); } catch {}
      try { onQueueChanged('claude-billing-switch'); } catch {}
    }
  }

  // One note per run of switches: one written since the chat's last message
  // is rewritten in place, so a switch there and back leaves one line.
  function writeNote(conversationId, to, by, at) {
    const text = buildClaudeBillingNoteText({ to, by });
    const latest = latestMessage?.get(conversationId) || null;
    if (latest && latest.role === 'assistant' && latest.kind === CLAUDE_BILLING_NOTE_KIND) {
      rewriteNote.run(text, at, latest.id);
      return { messageId: latest.id, text, timestamp: at, created: false };
    }
    const messageId = randomUUID();
    stmts.insertMsg.run(messageId, conversationId, 'assistant', text, null, null, null, at, null, null, null);
    stmts.setMessageKind?.run?.(CLAUDE_BILLING_NOTE_KIND, messageId);
    stmts.updateConvTime?.run?.(at, conversationId);
    return { messageId, text, timestamp: at, created: true };
  }

  return {
    checkSwitch,
    billingState,
    switchBilling,
  };
}
