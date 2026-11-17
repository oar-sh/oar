'use strict';

// Compacting a conversation: a new one starts from a carry-over summary of the
// old one, which is archived into it. The new chat keeps the old one's
// provider, model and effort. A provider that cannot take a new chat now
// (switched off, not set up, at its cap) refuses the compact before anything
// is written, with the way out in its text; nothing is ever bound to another
// provider instead. The checks are New Chat's (conversation-bootstrap-routes.mjs).

import { randomUUID } from 'node:crypto';

import { buildCloudSourceRecord, CLAUDE_CLOUD_PROVIDER_TYPE, parseCloudSourceJson } from './claude-cloud-session-service.mjs';
import { carryPlanOnlyToCompacted } from './conversation-preferences-service.mjs';
import { isCopilotProviderType } from './copilot-settings-service.mjs';

export const COMPACT_NOT_SUPPORTED_CODE = 'COMPACT_NOT_SUPPORTED';

const NOT_COMPACTED = 'so this chat was not compacted. Nothing was changed.';

/** The routes' 409 answer to a refused compact; the source stays open. */
export function compactRefusalBody(refused, sourceConversationId) {
  return {
    ok: false,
    code: refused.code,
    error: refused.error,
    provider: refused.provider,
    conversationId: sourceConversationId,
    compacted: false,
  };
}

export function normalizeMessageLine(text, maxLength = 240) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

// `pushedBranches`: the branch names a Claude Cloud session pushed, named in
// one line so the new session can check them out.
export function buildCompactSummary(conversation, recentMessagesDesc, { pushedBranches = [] } = {}) {
  const title = normalizeMessageLine(conversation?.title || 'Untitled', 80) || 'Untitled';
  const sourceLines = Array.isArray(recentMessagesDesc) ? [...recentMessagesDesc].reverse() : [];
  const lines = [`Conversation title: ${title}`];
  const branches = (Array.isArray(pushedBranches) ? pushedBranches : []).filter(Boolean);
  if (branches.length) lines.push(`Branches the earlier cloud session pushed: ${branches.join(', ')}`);
  lines.push('Carry-over summary (latest turns first in source, normalized below):');
  const headerLines = lines.length;

  for (const row of sourceLines.slice(0, 16)) {
    const role = row?.role === 'assistant' ? 'Assistant' : 'User';
    const line = normalizeMessageLine(row?.text || '', 260);
    if (!line) continue;
    lines.push(`- ${role}: ${line}`);
  }

  if (lines.length <= headerLines) {
    lines.push('- No prior text messages were available.');
  }

  return lines.join('\n').slice(0, 3500);
}

export function createConversationCompactionService({
  db,
  stmts,
  conversationGroups,
  // The runtime's binding, called with an explicit provider and
  // `assignConfiguredProvider: true`, so its Copilot backstop applies.
  ensureRuntimeSessionBinding,
  isCopilotEnabled = () => false,
  getOpenAIProviderSettings = () => null,
  getClaudeProviderSettings = () => null,
  getClaudeApiProviderSettings = () => null,
  // `{ reached, error? }`; a cap that cannot be read counts as reached.
  getClaudeApiCapState = () => ({ reached: false }),
  getClaudeCloudProviderSettings = () => null,
  getCursorProviderSettings = () => null,
  getGrokProviderSettings = () => null,
  getDeepSeekProviderSettings = () => null,
  // Getters: these services are built after this one.
  getRelayScheduleService = () => null,
  getRelayAskService = () => null,
  getRemoteRelayRegistry = () => null,
  now = () => new Date().toISOString(),
  newId = randomUUID,
} = {}) {
  function refusal(provider, code, error) {
    return { ok: false, status: 409, code, error, provider };
  }

  function copilotOffRefusal() {
    return refusal('github', 'COPILOT_SWITCHED_OFF',
      `Copilot is switched off on this relay, ${NOT_COMPACTED} Switch it on in Settings → Providers → Copilot.`);
  }

  // Null when `providerType` can take the compacted chat now, else the refusal.
  function readinessRefusal(providerType, source) {
    if (isCopilotProviderType(providerType)) {
      return isCopilotEnabled() === true ? null : copilotOffRefusal();
    }
    if (providerType === 'openai') {
      return getOpenAIProviderSettings()?.configured === true ? null : refusal(providerType, 'OPENAI_NOT_CONFIGURED',
        `OpenAI has no API key on this relay, ${NOT_COMPACTED} Add it in Settings → Providers → OpenAI.`);
    }
    if (providerType === 'claude') {
      return getClaudeProviderSettings()?.enabled === true ? null : refusal(providerType, 'CLAUDE_NOT_CONFIGURED',
        `Claude is not switched on on this relay, ${NOT_COMPACTED} Switch it on in Settings → Providers → Claude.`);
    }
    if (providerType === 'claude-api') {
      const settings = getClaudeApiProviderSettings();
      if (settings?.enabled !== true) {
        return refusal(providerType, 'CLAUDE_API_NOT_CONFIGURED', settings?.configured === true
          ? `Claude API is switched off on this relay, ${NOT_COMPACTED} Switch it on in Settings → Providers → Claude API.`
          : `Claude API has no key on this relay, ${NOT_COMPACTED} Add it in Settings → Providers → Claude API.`);
      }
      let cap = null;
      try { cap = getClaudeApiCapState() || null; } catch { cap = { reached: true }; }
      if (cap?.reached === true) {
        const reason = String(cap.reason || cap.error || '').trim() || 'This month\'s Claude API spend has reached its cap.';
        return refusal(providerType, 'CLAUDE_API_CAP_REACHED',
          `${reason} This chat was not compacted. Nothing was changed. Switch the chat to the Claude subscription first, or raise the cap in Settings → Providers → Claude API.`);
      }
      return null;
    }
    if (providerType === CLAUDE_CLOUD_PROVIDER_TYPE) {
      if (getClaudeCloudProviderSettings()?.enabled !== true) {
        return refusal(providerType, 'claude_cloud_disabled',
          `Claude Cloud is not enabled on this relay, ${NOT_COMPACTED} Switch it on in Settings → Providers → Claude Cloud.`);
      }
      if (!parseCloudSourceJson(source?.cloud_source_json) || typeof stmts.updateConvCloudSource?.run !== 'function') {
        return refusal(providerType, COMPACT_NOT_SUPPORTED_CODE,
          'This Claude Cloud chat names no repository, so it cannot be compacted. Nothing was changed.');
      }
      return null;
    }
    if (providerType === 'cursor') {
      return getCursorProviderSettings()?.configured === true ? null : refusal(providerType, 'CURSOR_NOT_CONFIGURED',
        `Cursor has no API key on this relay, ${NOT_COMPACTED} Add it in Settings → Providers → Cursor.`);
    }
    if (providerType === 'grok') {
      return getGrokProviderSettings()?.enabled === true ? null : refusal(providerType, 'GROK_NOT_CONFIGURED',
        `Grok is not switched on on this relay, ${NOT_COMPACTED} Switch it on in Settings → Providers → Grok.`);
    }
    if (providerType === 'deepseek') {
      const settings = getDeepSeekProviderSettings();
      if (settings?.enabled === true) return null;
      return refusal(providerType, 'DEEPSEEK_NOT_CONFIGURED', settings?.configured === true
        ? `DeepSeek is switched off on this relay, ${NOT_COMPACTED} Switch it on in Settings → Providers → DeepSeek.`
        : `DeepSeek has no API key on this relay, ${NOT_COMPACTED} Add it in Settings → Providers → DeepSeek.`);
    }
    return refusal(providerType, COMPACT_NOT_SUPPORTED_CODE,
      `This chat's provider (${providerType.slice(0, 40)}) cannot start a new chat on this relay, so it cannot be compacted. Nothing was changed.`);
  }

  // Null when there is no such conversation; `{ ok: false, status: 409, code,
  // error, provider }` when its provider refuses; else the compacted pair.
  function createCompactedConversation(sourceConversationId) {
    // Compaction stays scoped to sourceConversationId; it never consults a
    // global/latest session file that could belong to another conversation.
    const source = stmts.getConv.get(sourceConversationId);
    if (!source) return null;

    // No runtime row, or one without a provider: the chat is Copilot's.
    const sourceRuntime = stmts.getRuntimeSessionByConversation.get(sourceConversationId) || null;
    const rawProviderType = String(sourceRuntime?.provider_type || '').trim().toLowerCase();
    const providerType = isCopilotProviderType(rawProviderType) ? 'github' : rawProviderType;
    const refused = readinessRefusal(providerType, source);
    if (refused) return refused;
    // A cloud chat starts a new cloud session on the same repository and
    // branch: none of the old session's binding, link or cost goes along.
    const cloudSource = providerType === CLAUDE_CLOUD_PROVIDER_TYPE ? parseCloudSourceJson(source.cloud_source_json) : null;

    const createdAt = now();
    const targetConversationId = newId();
    const recent = stmts.getRecentMessagesDesc.all(sourceConversationId, 24);
    const summarySeed = buildCompactSummary(source, recent, {
      pushedBranches: (cloudSource?.pushedBranches || []).map((entry) => entry.branch),
    });
    const nextTitleBase = normalizeMessageLine(source.title || 'Conversation', 64) || 'Conversation';
    const nextTitle = `${nextTitleBase} (compacted)`.slice(0, 80);

    let targetRuntimeSession = null;
    const tx = db.transaction(() => {
      stmts.insertConv.run(targetConversationId, nextTitle, createdAt, createdAt);
      stmts.updateConvSeed.run(summarySeed, 1, sourceConversationId, createdAt, targetConversationId);
      stmts.markConvCompacted.run(targetConversationId, createdAt, sourceConversationId);
      // The new conversation stays in the old one's session group, and heads
      // it if the old one did; the archived source stays a member.
      conversationGroups.carryToCompacted(sourceConversationId, targetConversationId, createdAt);
      // A plan-only conversation's lock goes along, with its saved mode.
      carryPlanOnlyToCompacted({ db, stmts, source, targetConversationId, updatedAt: createdAt });
      // The model and effort the composer shows, as they are; the relay mode
      // is left to the plan-only carry above.
      db.prepare('UPDATE conversations SET preferred_model = ?, preferred_reasoning_effort = ? WHERE id = ?')
        .run(source.preferred_model ?? null, source.preferred_reasoning_effort ?? null, targetConversationId);
      if (cloudSource) {
        const record = buildCloudSourceRecord({
          repoUrl: cloudSource.repoUrl,
          branch: cloudSource.branch,
          environmentId: cloudSource.environmentId,
        });
        stmts.updateConvCloudSource.run(JSON.stringify(record), targetConversationId);
      }
      // A fresh runtime row on the source's provider and model (a Claude
      // chat's billing included, a pending swap's too), with no session ids.
      targetRuntimeSession = ensureRuntimeSessionBinding(
        targetConversationId,
        String(sourceRuntime?.model || '').trim() || null,
        createdAt,
        null,
        {
          assignConfiguredProvider: true,
          providerType,
          providerModel: String(sourceRuntime?.provider_model || '').trim() || null,
        },
      );
    });
    try {
      tx();
    } catch (error) {
      // The binding's backstop threw: the transaction is rolled back, so
      // nothing was created or archived.
      if (String(error?.code || '') === 'COPILOT_NOT_ENABLED') {
        return copilotOffRefusal();
      }
      throw error;
    }
    // Its schedules go on in the new conversation, both the ones that fire
    // into it and the ones it set: the archived source would end them.
    try { getRelayScheduleService()?.carryToCompacted(sourceConversationId, targetConversationId); } catch {}
    // And so do its questions that don't block, asked in it or by it.
    try { getRelayAskService()?.carryToCompacted(sourceConversationId, targetConversationId); } catch {}
    // And an "Allow for this session" on the loop guard.
    try { getRemoteRelayRegistry()?.carryLoopGuardOff(sourceConversationId, targetConversationId, { title: nextTitle }); } catch {}

    return {
      sourceConversationId,
      targetConversationId,
      runtimeSessionId: targetRuntimeSession?.id || null,
      summarySeed,
      createdAt,
      targetTitle: nextTitle,
    };
  }

  return { createCompactedConversation, readinessRefusal };
}
